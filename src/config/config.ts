import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { Locale } from '../i18n.js';

/**
 * 子 agent 限制。设计三件套：可配 + 硬编码默认 + clamp 上限。
 * 深度用 clamp[1,2] 封顶防 fork-bomb；并发维度不设——step-code 顺序执行，无并发概念。
 */
export interface SubagentLimits {
  /** 单个会话累计最多派生的子 agent 数（会话级计数器，超限拒绝）。 */
  maxPerSession: number;
  /** 嵌套深度上限（父=0）。硬顶封 2。 */
  maxDepth: number;
  /** 每个子 agent 内部最大 模型↔工具 往返轮数的全局默认；agent 定义的 maxSteps 可覆盖。 */
  maxSteps: number;
  /** 并行子 agent 的并发上限（一轮里并行执行的 explore 数量）。 */
  maxConcurrent: number;
}

/**
 * 上下文压缩配置。压缩判定下沉进 agent 循环，靠真实 usage 判断，
 * 超阈值先微压缩（清旧 tool_result 正文）、仍超再全量 LLM 摘要。
 */
export interface CompactionConfig {
  /** 触发比例：占用达到 maxContextSize × 此值即压缩。clamp [0.5, 0.99]。 */
  triggerRatio: number;
  /** 预留量：剩余窗口不足此值即压缩（给下一次生成留安全垫）。clamp [0, 500000]。 */
  reservedTokens: number;
  /** 压缩摘要专用模型（大小模型协同）。缺省用主会话模型，行为与之前完全一致。 */
  model?: string;
  /**
   * 用户原话保真预算（token）：压缩时在摘要之外单独保留的用户原始消息总量。
   * 缺省 20000（见 COMPACT_USER_MESSAGE_MAX_TOKENS）。0 = 关闭保真块，回到纯摘要行为。
   * clamp [0, 200000]。
   */
  userMessageMaxTokens?: number;
  /**
   * 保真预算中划给「最早消息」的份额（token）。缺省 2000。clamp [0, userMessageMaxTokens]。
   * 预算不足时最早消息留开头、最近消息留结尾，中段丢弃并插省略说明。
   */
  userMessageHeadTokens?: number;
}

/**
 * 后台执行配置（[background] 段）。四个字段全部可选，缺省不进结果对象，
 * 消费方用 ?? 落默认（notifyOnComplete / bashAutoBackgroundOnTimeout 默认 true，
 * bashTaskTimeoutS 默认 600、0 = 不限；notifyTerminal 默认 true）。
 */
export interface BackgroundConfig {
  /** bash 前台超时后自动转后台（默认 true；false 保持超时即杀）。 */
  bashAutoBackgroundOnTimeout?: boolean;
  /** 后台任务超时秒数（默认 600，clamp [0, 86400]，0 = 不限）。 */
  bashTaskTimeoutS?: number;
  /** 后台任务终态时主动注入完成通知（默认 true；false 回到模型经 task_list 查询）。 */
  notifyOnComplete?: boolean;
  /** 后台任务终态时发终端铃响/桌面通知（默认 true；false 静默）。 */
  notifyTerminal?: boolean;
}

/**
 * thinking（推理过程）请求配置（[thinking] 段）。
 * enabled 默认 false：不主动发 thinking 字段，保持既有请求行为（部分服务端对该字段 400）；
 * budget_tokens 可选，Anthropic 协议要求 ≥1024 且 < max_tokens。
 * 思考深度档位（levels + default_level）是数据不是代码：档位名 → budget 的映射放 config，
 * 会话级 /think 切换在此表内选档；未配置 [thinking.levels] 时用 {@link DEFAULT_THINKING_LEVELS}。
 */
export interface ThinkingConfig {
  /** 是否主动发送 thinking 请求字段（budget 控制手段；思考本身是服务端固有行为，渲染不受影响）。 */
  enabled: boolean;
  /** 思考预算 token 数（clamp ≥1024）；未配置时请求只带 {type:'enabled'}。 */
  budgetTokens?: number;
  /** 思考深度档位表（档位名 → budget token 数，单个档位 clamp ≥1024）。恒非空（缺省落内置默认表）。 */
  levels: Record<string, number>;
  /** 默认档位名（[thinking] default_level）；必须命中 levels 内的档位，否则 loadConfig 报配置错误。 */
  defaultLevel?: string;
}

/**
 * [models.<别名>] 表的单条模型配置（渠道与模型分离）：字段全部可选，
 * 缺省项在 {@link resolveModelEntry} 合并时继承渠道与顶层配置。
 */
export interface ModelEntry {
  /** 渠道 id（[providers.<id>] 自定义渠道）或内置预设名（stepfun/anthropic）；缺省继承顶层 provider。 */
  provider?: string;
  /** 真实模型 id；缺省 = 别名本身。 */
  model?: string;
  /** 缺省：entry.provider 指向的渠道/预设 baseUrl，再缺省继承顶层。 */
  baseUrl?: string;
  apiKey?: string;
  maxContextSize?: number;
  maxTokens?: number;
  /** 展示名（选择器与状态栏显示用）；缺省用别名/真实 id。 */
  displayName?: string;
  /** 能力标记（如 thinking / image_in），原样透传，消费方自己解释。 */
  capabilities?: string[];
}

/** 用户可配置 hooks 的合法事件名集合（其余事件名视为非法，整条跳过）。 */
export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart'] as const;

/** hook 事件名（合法集见 {@link HOOK_EVENTS}）。 */
export type HookEventName = (typeof HOOK_EVENTS)[number];

/**
 * 单条用户 hook（config.toml 扁平 `[[hooks]]` 数组的一项）。
 * 执行语义：shell 命令 + stdin JSON 输入；exit 0 放行（UserPromptSubmit/SessionStart 时
 * stdout 注入上下文）、exit 2 阻断（stderr 为原因）、其余非零/超时/崩溃 fail-open。
 */
export interface HookConfigEntry {
  /** 生命周期事件名。 */
  event: HookEventName;
  /** 可选正则（匹配工具名/事件相关标识），已编译；非法正则整条跳过。 */
  matcher?: RegExp;
  /** 要执行的 shell 命令（spawn with shell）。 */
  command: string;
  /** 超时秒数：默认 30，clamp [1,600]；超时杀进程树并按 fail-open 放行。 */
  timeout: number;
}

/**
 * [providers.<id>] 渠道表的单条渠道配置：type 必填（映射 {@link PROVIDER_PRESETS}
 * 的协议 key，非法 type 该项无效），baseUrl/apiKey 可选（缺省在
 * {@link resolveModelEntry} 合并时回落 entry → 顶层）。
 */
export interface ProviderEntry {
  /** 协议类型，对应 PROVIDER_PRESETS 的 key（决定 provider 工厂分发与 sendThinking）。 */
  type: string;
  baseUrl?: string;
  apiKey?: string;
}

/**
 * step-code 运行时配置。
 *
 * StepFun 服务端走 Anthropic Messages 协议，有几条硬约束（见 provider 层）：
 * base_url 不带 /v1（SDK 自动拼），仅支持 base64 图片。
 */
export interface StepCodeConfig {
  /** 服务商标识（如 'stepfun' | 'anthropic'）。决定预设默认与 provider 工厂分发。 */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 模型上下文上限（token）。默认对齐内置默认模型的窗口（256K）；更大窗口的模型需经 config.toml max_context_size 显式声明。 */
  maxContextSize: number;
  /** 单次响应最大输出 token。默认 32768（对未知模型的 fallback 量级），避免长输出/大段代码中途截断。可经 config.toml max_tokens 覆盖。 */
  maxTokens: number;
  /** 子 agent 限制。 */
  subagent: SubagentLimits;
  /** 上下文压缩配置。 */
  compaction: CompactionConfig;
  /** 后台执行配置（[background] 段）。字段全部可选，缺省键不进对象。 */
  background?: BackgroundConfig;
  /** thinking（推理过程）请求配置（[thinking] 段）。loadConfig 恒赋值（默认 { enabled: false }），消费方仍按可选处理。 */
  thinking?: ThinkingConfig;
  /** 界面语言（TUI/CLI 给人看的文案）。缺省 'zh'；给模型看的文案恒中文，不受其影响。 */
  language?: Locale;
  /** AGENTS.md 自定义加载路径（config.toml agents_paths）。配置后完全覆盖默认的用户级+项目级收集；文件直读、目录取 AGENTS.md / agents.md。支持 `~` 与相对 cwd 的路径。 */
  agentsPaths?: string[];
  /** AGENTS.md 总字节预算（config.toml agents_md_max_bytes，UTF-8 字节计）。缺省 32KB；0 或负数 = 禁用 AGENTS.md 加载。非法值（非数字）时键不进结果对象。 */
  agentsMdMaxBytes?: number;
  /** skills 追加扫描目录（config.toml extra_skill_dirs）。追加在默认路径之后、plugin 之前扫描，同名 skill 追加目录胜出。支持 `~` 与相对 cwd 的路径。 */
  extraSkillDirs?: string[];
  /** 按名排除的 skill 清单（config.toml disabled_skills）。合并完成后统一过滤，任何来源的同名 skill 都不加载；用于屏蔽不归你管的目录（团队共享 .agents/skills 等）里的个别 skill。 */
  disabledSkills?: string[];
  /** [models.<别名>] 模型别名表（渠道与模型分离）。未配置或全部无效时键不进结果对象。 */
  models?: Record<string, ModelEntry>;
  /** [providers.<id>] 渠道表（自定义服务商端点/密钥）。未配置或全部无效时键不进结果对象。 */
  providers?: Record<string, ProviderEntry>;
  /** 用户可配置 hooks（[[hooks]] 扁平数组）。未配置或全部无效时键不进结果对象。 */
  hooks?: HookConfigEntry[];
}

const DEFAULT_BASE_URL = 'https://api.stepfun.com';
const DEFAULT_MODEL = 'step-3.7-flash';
const DEFAULT_MAX_CONTEXT = 262_144;
const DEFAULT_MAX_TOKENS = 32768;

/**
 * provider 协议维度：决定 provider 工厂分发到哪个适配器实现。
 * - anthropic：Anthropic Messages 协议（/v1/messages，base_url 不带 /v1，SDK 自拼）。
 * - openai：OpenAI Chat Completions 协议（/v1/chat/completions，base_url 带 /v1）。
 * - openai_responses：OpenAI Responses 协议（/v1/responses，纯对话，不支持工具调用）。
 */
export type ProviderProtocol = 'anthropic' | 'openai' | 'openai_responses';

/** 服务商预设：仅在用户未显式配置 baseUrl/model 时提供默认；protocol/sendThinking 供 provider 工厂读取。 */
export interface ProviderPreset {
  /** 协议维度：provider 工厂据此分发到对应适配器。 */
  protocol: ProviderProtocol;
  /** 默认 base_url（用户未配时使用）。 */
  baseUrl?: string;
  /** 默认 model（用户未配时使用）；anthropic 不预设，需用户自配。 */
  model?: string;
  /** 是否允许发送 thinking 字段（仅 anthropic 协议有意义；openai 协议下工厂忽略）。stepfun 必须为 false。 */
  sendThinking: boolean;
}

/** 默认服务商。保持 stepfun 以维持历史默认路径行为字节级不变。 */
export const DEFAULT_PROVIDER = 'stepfun';

/**
 * 服务商预设表。未知 provider 不在此表内，由 provider 工厂负责报错。
 * stepfun/anthropic 走 Anthropic Messages 协议（历史默认，行为字节级不变）；
 * openai/openai_responses 走 OpenAI 协议，base_url 默认带 /v1（拼 /chat/completions 或 /responses）。
 */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  stepfun: { protocol: 'anthropic', baseUrl: DEFAULT_BASE_URL, model: DEFAULT_MODEL, sendThinking: false },
  anthropic: { protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', sendThinking: true },
  openai: { protocol: 'openai', baseUrl: `${DEFAULT_BASE_URL}/v1`, model: DEFAULT_MODEL, sendThinking: false },
  openai_responses: { protocol: 'openai_responses', baseUrl: `${DEFAULT_BASE_URL}/v1`, model: DEFAULT_MODEL, sendThinking: false },
};

// 子 agent 限制的默认值与 clamp 边界（默认克制、上限封顶）。
const SUBAGENT_MAX_PER_SESSION_DEFAULT = 10;
const SUBAGENT_MAX_PER_SESSION_MIN = 1;
const SUBAGENT_MAX_PER_SESSION_MAX = 50;
const SUBAGENT_MAX_DEPTH_DEFAULT = 1;
const SUBAGENT_MAX_DEPTH_MIN = 1;
const SUBAGENT_MAX_DEPTH_MAX = 3; // 硬顶封 3：防 fork-bomb，配置无法突破；默认 1，显式配置才放宽嵌套
const SUBAGENT_MAX_STEPS_DEFAULT = 100;
const SUBAGENT_MAX_STEPS_MIN = 1;
const SUBAGENT_MAX_STEPS_MAX = 1000;
const SUBAGENT_MAX_CONCURRENT_DEFAULT = 4;
const SUBAGENT_MAX_CONCURRENT_MIN = 1;
const SUBAGENT_MAX_CONCURRENT_MAX = 16;

// 压缩配置默认值与 clamp 边界（0.85 触发 + 预留安全垫）。
const COMPACTION_TRIGGER_RATIO_DEFAULT = 0.85;
const COMPACTION_TRIGGER_RATIO_MIN = 0.5;
const COMPACTION_TRIGGER_RATIO_MAX = 0.99;
const COMPACTION_RESERVED_TOKENS_DEFAULT = 32_000;
const COMPACTION_RESERVED_TOKENS_MIN = 0;
const COMPACTION_RESERVED_TOKENS_MAX = 500_000;

// 后台任务超时 clamp 边界（默认 600 在消费方落，0 = 不限）。
const BACKGROUND_TASK_TIMEOUT_MIN = 0;
const BACKGROUND_TASK_TIMEOUT_MAX = 86_400;

// hook 超时 clamp 边界与默认（秒）：默认 30，硬顶 600，下限 1。
const HOOK_TIMEOUT_DEFAULT = 30;
const HOOK_TIMEOUT_MIN = 1;
const HOOK_TIMEOUT_MAX = 600;

// thinking 配置边界：Anthropic 协议要求 budget ≥1024；正文最小余量 2048
// （实测教训：思考会吃满 max_tokens，余量不足时正文零输出）。
const THINKING_BUDGET_MIN = 1024;
export const THINKING_TEXT_MARGIN = 2048;

/**
 * 内置默认思考深度档位表（[thinking.levels] 未配置或全部无效时使用）。
 * 取实战验证过的档位值；用户可在 config.toml 用 [thinking.levels] 整体覆盖（档位是数据不是代码）。
 */
export const DEFAULT_THINKING_LEVELS: Record<string, number> = { low: 1024, medium: 4096, high: 32000 };

/**
 * 从 cwd 下的 .env 文件读取键值（若存在），只填充尚未在 process.env 中的键。
 * 不引入 dotenv 依赖，保持极简；只解析 `KEY=VALUE` 形式，忽略注释与空行。
 */
function loadDotEnv(cwd: string): void {
  const envPath = join(cwd, '.env');
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // 去掉包裹的引号
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

interface TomlConfigShape {
  provider?: unknown;
  api_key?: unknown;
  base_url?: unknown;
  model?: unknown;
  max_context_size?: unknown;
  max_tokens?: unknown;
  subagent?: unknown;
  compaction?: unknown;
  background?: unknown;
  thinking?: unknown;
  language?: unknown;
  agents_paths?: unknown;
  agents_md_max_bytes?: unknown;
  extra_skill_dirs?: unknown;
  disabled_skills?: unknown;
  models?: unknown;
  providers?: unknown;
  hooks?: unknown;
}

/** 从 ~/.step-code/config.toml 读取配置（若存在）。 */
function loadTomlConfig(): TomlConfigShape {
  const tomlPath = join(homedir(), '.step-code', 'config.toml');
  if (!existsSync(tomlPath)) return {};
  try {
    return parseToml(readFileSync(tomlPath, 'utf8')) as TomlConfigShape;
  } catch {
    return {};
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 取整并夹到 [min,max]；value 缺失或非法时用 dflt。 */
function clampInt(value: unknown, min: number, max: number, dflt: number): number {
  const n = asNumber(value);
  if (n === undefined) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 夹到 [min,max]（不取整）；value 缺失或非法时用 dflt。 */
function clampFloat(value: unknown, min: number, max: number, dflt: number): number {
  const n = asNumber(value);
  if (n === undefined) return dflt;
  return Math.min(max, Math.max(min, n));
}

/**
 * 从 [subagent] 段解析限制，缺失落到默认、越界被 clamp。纯函数，便于单测。
 * @param raw config.toml 里 [subagent] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveSubagentLimits(raw: unknown): SubagentLimits {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    maxPerSession: clampInt(
      t['max_per_session'],
      SUBAGENT_MAX_PER_SESSION_MIN,
      SUBAGENT_MAX_PER_SESSION_MAX,
      SUBAGENT_MAX_PER_SESSION_DEFAULT,
    ),
    maxDepth: clampInt(
      t['max_depth'],
      SUBAGENT_MAX_DEPTH_MIN,
      SUBAGENT_MAX_DEPTH_MAX,
      SUBAGENT_MAX_DEPTH_DEFAULT,
    ),
    maxSteps: clampInt(
      t['max_steps'],
      SUBAGENT_MAX_STEPS_MIN,
      SUBAGENT_MAX_STEPS_MAX,
      SUBAGENT_MAX_STEPS_DEFAULT,
    ),
    maxConcurrent: clampInt(
      t['max_concurrent'],
      SUBAGENT_MAX_CONCURRENT_MIN,
      SUBAGENT_MAX_CONCURRENT_MAX,
      SUBAGENT_MAX_CONCURRENT_DEFAULT,
    ),
  };
}

/**
 * 从 [compaction] 段解析配置，缺失落到默认、越界被 clamp。纯函数，便于单测。
 * @param raw config.toml 里 [compaction] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveCompactionConfig(raw: unknown): CompactionConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cfg: CompactionConfig = {
    triggerRatio: clampFloat(
      t['trigger_ratio'],
      COMPACTION_TRIGGER_RATIO_MIN,
      COMPACTION_TRIGGER_RATIO_MAX,
      COMPACTION_TRIGGER_RATIO_DEFAULT,
    ),
    reservedTokens: clampInt(
      t['reserved_tokens'],
      COMPACTION_RESERVED_TOKENS_MIN,
      COMPACTION_RESERVED_TOKENS_MAX,
      COMPACTION_RESERVED_TOKENS_DEFAULT,
    ),
  };
  // 压缩专用模型：未配置时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const model = asString(t['model']);
  if (model !== undefined) cfg.model = model;
  return cfg;
}

/**
 * 从 config.toml 顶层字符串数组字段解析路径列表（agents_paths / extra_skill_dirs）。纯函数，便于单测。
 * 全部元素是非空字符串才返回数组；未配置、非数组、空数组或含非法元素时返回 undefined（键不进结果对象）。
 */
export function resolveStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.every((x) => typeof x === 'string' && x.length > 0) ? (raw as string[]) : undefined;
}

/**
 * 从 [background] 段解析后台执行配置。三个字段全部可选：
 * 未配置或类型非法时键不进结果对象（下游 toEqual 精确断言依赖此形态），消费方用 ?? 落默认。
 * @param raw config.toml 里 [background] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveBackgroundConfig(raw: unknown): BackgroundConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const cfg: BackgroundConfig = {};
  const autoBg = t['bash_auto_background_on_timeout'];
  if (typeof autoBg === 'boolean') cfg.bashAutoBackgroundOnTimeout = autoBg;
  const timeout = asNumber(t['bash_task_timeout_s']);
  if (timeout !== undefined) {
    cfg.bashTaskTimeoutS = Math.min(
      BACKGROUND_TASK_TIMEOUT_MAX,
      Math.max(BACKGROUND_TASK_TIMEOUT_MIN, Math.round(timeout)),
    );
  }
  const notify = t['notify_on_complete'];
  if (typeof notify === 'boolean') cfg.notifyOnComplete = notify;
  const notifyTerm = t['notify_terminal'];
  if (typeof notifyTerm === 'boolean') cfg.notifyTerminal = notifyTerm;
  return cfg;
}

/**
 * 解析 [thinking.levels] 档位表。纯函数。
 * raw 非对象 → undefined；档位名空串或值非有限数字 → 跳过该档；合法值取整并 clamp ≥1024。
 * 没有任何有效档位时返回 undefined（调用方回落 {@link DEFAULT_THINKING_LEVELS}）。
 */
function parseThinkingLevels(raw: unknown): Record<string, number> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name === '') continue;
    const budget = asNumber(value);
    if (budget === undefined) continue;
    out[name] = Math.max(THINKING_BUDGET_MIN, Math.round(budget));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [thinking] 段解析 thinking 请求配置。纯函数，便于单测。
 * enabled 缺省 false（非布尔按 false）；budget_tokens 非法时键不进结果对象，
 * 合法时取整并 clamp 到 ≥1024。levels 未配置或全部无效时回落内置默认表
 * （{@link DEFAULT_THINKING_LEVELS}）；default_level 必须命中最终档位表，否则抛配置错误。
 * 启用且配了 budget 时校验正文最小余量 maxTokens - budget ≥ 2048，不满足抛配置错误
 * 并给出调整方向；用户自定义 levels 在启用时逐档套用同一余量校验（内置默认表不校验——
 * 它是兜底数据，运行时档位由用户经 /think 显式选择）。
 * @param raw config.toml 里 [thinking] 段的原始值（可能为 undefined / 非对象）。
 * @param maxTokens 最终生效的 max_tokens（余量校验基准）。
 * @throws 启用时 budget/自定义档位未给正文留出最小余量；default_level 引用不存在的档位。
 */
export function resolveThinkingConfig(raw: unknown, maxTokens: number): ThinkingConfig {
  const t = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const userLevels = parseThinkingLevels(t['levels']);
  const cfg: ThinkingConfig = {
    enabled: t['enabled'] === true,
    levels: userLevels ?? { ...DEFAULT_THINKING_LEVELS },
  };
  const budget = asNumber(t['budget_tokens']);
  if (budget !== undefined) {
    cfg.budgetTokens = Math.max(THINKING_BUDGET_MIN, Math.round(budget));
  }
  if (cfg.enabled && cfg.budgetTokens !== undefined && maxTokens - cfg.budgetTokens < THINKING_TEXT_MARGIN) {
    throw new Error(
      `[thinking] budget_tokens=${cfg.budgetTokens} 未给正文留出最小余量：max_tokens(${maxTokens}) - budget_tokens(${cfg.budgetTokens}) < ${THINKING_TEXT_MARGIN}。` +
        `请调大 max_tokens 或调小 budget_tokens（思考会消耗 max_tokens，余量不足时正文可能零输出）。`,
    );
  }
  // 用户自定义档位沿用同一余量校验（仅启用时；未启用就不发字段，与 budget_tokens 的既有口径一致）
  if (cfg.enabled && userLevels !== undefined) {
    for (const [name, levelBudget] of Object.entries(userLevels)) {
      if (maxTokens - levelBudget < THINKING_TEXT_MARGIN) {
        throw new Error(
          `[thinking.levels] 档位 ${name}=${levelBudget} 未给正文留出最小余量：max_tokens(${maxTokens}) - ${name}(${levelBudget}) < ${THINKING_TEXT_MARGIN}。` +
            `请调大 max_tokens 或调小该档位的 budget（思考会消耗 max_tokens，余量不足时正文可能零输出）。`,
        );
      }
    }
  }
  const defaultLevel = asString(t['default_level']);
  if (defaultLevel !== undefined) {
    if (cfg.levels[defaultLevel] === undefined) {
      throw new Error(
        `[thinking] default_level="${defaultLevel}" 未命中任何档位（可用：${Object.keys(cfg.levels).join(' | ')}）。`,
      );
    }
    cfg.defaultLevel = defaultLevel;
  }
  return cfg;
}

/**
 * 从 [models.<别名>] 段解析模型别名表（渠道与模型分离）。纯函数，便于单测。
 * raw 非对象 → undefined；别名空串或别名值非对象 → 跳过该别名；只读已知字段，
 * 未知字段忽略；没有任何有效别名时返回 undefined（键不进结果对象，
 * 下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 [models] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveModels(raw: unknown): Record<string, ModelEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, ModelEntry> = {};
  for (const [alias, value] of Object.entries(raw as Record<string, unknown>)) {
    if (alias === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const t = value as Record<string, unknown>;
    const entry: ModelEntry = {};
    const provider = asString(t['provider']);
    if (provider !== undefined) entry.provider = provider;
    const model = asString(t['model']);
    if (model !== undefined) entry.model = model;
    const baseUrl = asString(t['base_url']);
    if (baseUrl !== undefined) entry.baseUrl = baseUrl;
    const apiKey = asString(t['api_key']);
    if (apiKey !== undefined) entry.apiKey = apiKey;
    const maxContextSize = asNumber(t['max_context_size']);
    if (maxContextSize !== undefined) entry.maxContextSize = maxContextSize;
    const maxTokens = asNumber(t['max_tokens']);
    if (maxTokens !== undefined) entry.maxTokens = maxTokens;
    const displayName = asString(t['display_name']);
    if (displayName !== undefined) entry.displayName = displayName;
    // capabilities 原样透传：仅接受纯字符串数组，消费方自己解释语义
    const capabilities = t['capabilities'];
    if (
      Array.isArray(capabilities) &&
      capabilities.length > 0 &&
      capabilities.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      entry.capabilities = capabilities as string[];
    }
    out[alias] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [providers.<id>] 段解析渠道表。纯函数，便于单测。
 * raw 非对象 → undefined；id 空串或渠道值非对象 → 跳过该渠道；type 必填且必须是
 * {@link PROVIDER_PRESETS} 的协议 key，缺失或非法 → 该渠道无效跳过；base_url/api_key 可选。
 * 没有任何有效渠道时返回 undefined（键不进结果对象，下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 [providers] 段的原始值（可能为 undefined / 非对象）。
 */
export function resolveProviders(raw: unknown): Record<string, ProviderEntry> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, ProviderEntry> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (id === '' || typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const t = value as Record<string, unknown>;
    const type = asString(t['type']);
    if (type === undefined || PROVIDER_PRESETS[type] === undefined) continue;
    const entry: ProviderEntry = { type };
    const baseUrl = asString(t['base_url']);
    if (baseUrl !== undefined) entry.baseUrl = baseUrl;
    const apiKey = asString(t['api_key']);
    if (apiKey !== undefined) entry.apiKey = apiKey;
    out[id] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 从 [[hooks]] 扁平数组解析用户 hooks。纯函数，便于单测。
 * raw 非数组 → undefined；逐条校验：event 必须在合法事件集（{@link HOOK_EVENTS}）内、
 * command 必须是非空字符串，否则该条跳过；matcher 可选但必须是合法正则（非法整条跳过）；
 * timeout 可选，默认 30 秒，clamp [1,600]。全部无效时返回 undefined（键不进结果对象，
 * 下游 toEqual 精确断言依赖此形态）。
 * @param raw config.toml 里 hooks 的原始值（smol-toml 把 [[hooks]] 解析成对象数组）。
 */
export function resolveHooks(raw: unknown): HookConfigEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HookConfigEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const t = item as Record<string, unknown>;
    const event = asString(t['event']);
    if (event === undefined || !(HOOK_EVENTS as readonly string[]).includes(event)) continue;
    const command = asString(t['command']);
    if (command === undefined) continue;
    const entry: HookConfigEntry = {
      event: event as HookEventName,
      command,
      timeout: clampInt(t['timeout'], HOOK_TIMEOUT_MIN, HOOK_TIMEOUT_MAX, HOOK_TIMEOUT_DEFAULT),
    };
    const matcher = asString(t['matcher']);
    if (matcher !== undefined) {
      try {
        entry.matcher = new RegExp(matcher);
      } catch {
        continue; // 非法正则：整条 hook 跳过
      }
    }
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * 按别名展开模型配置：name 命中 config.models 时返回合并后的新配置，未命中返回 null。
 *
 * entry.provider 的三种指向（优先级从高到低）：
 * 1. 自定义渠道 id（config.providers）：结果 provider = 渠道 type（协议 key），
 *    baseUrl/apiKey 取自渠道，渠道缺省回落 entry → 顶层；渠道与 entry 都没给 baseUrl
 *    且 type 与顶层 provider 不同时，回落 type 预设的 baseUrl。
 * 2. 内置预设名（stepfun/anthropic，作为隐式渠道保留）：走原有预设回落逻辑，旧配置零迁移。
 * 3. 都未命中 → 无效别名，返回 null。
 * entry.provider 缺省时继承顶层 provider（原有行为）。entry 其余字段覆盖顶层；
 * model 缺省 = 别名本身。纯函数，不改原对象。
 */
export function resolveModelEntry(config: StepCodeConfig, name: string): StepCodeConfig | null {
  const entry = config.models?.[name];
  if (entry === undefined) return null;

  let provider: string;
  let baseUrl: string;
  let apiKey: string;
  const channel = entry.provider !== undefined ? config.providers?.[entry.provider] : undefined;
  if (channel !== undefined) {
    // 自定义渠道：协议实现由渠道 type 决定，端点/密钥渠道优先、回落 entry → 顶层
    provider = channel.type;
    apiKey = channel.apiKey ?? entry.apiKey ?? config.apiKey;
    baseUrl = channel.baseUrl ?? entry.baseUrl ?? config.baseUrl;
    if (channel.baseUrl === undefined && entry.baseUrl === undefined && provider !== config.provider) {
      baseUrl = PROVIDER_PRESETS[provider]?.baseUrl ?? config.baseUrl;
    }
  } else {
    if (entry.provider !== undefined && PROVIDER_PRESETS[entry.provider] === undefined) {
      // 显式指向了既不存在的渠道也不是内置预设的 provider：无效别名
      return null;
    }
    provider = entry.provider ?? config.provider;
    apiKey = entry.apiKey ?? config.apiKey;
    baseUrl = entry.baseUrl ?? config.baseUrl;
    if (entry.baseUrl === undefined && provider !== config.provider) {
      baseUrl = PROVIDER_PRESETS[provider]?.baseUrl ?? config.baseUrl;
    }
  }
  return {
    ...config,
    provider,
    apiKey,
    baseUrl,
    model: entry.model ?? name,
    maxContextSize: entry.maxContextSize ?? config.maxContextSize,
    maxTokens: entry.maxTokens ?? config.maxTokens,
  };
}

/** 命令行覆盖项：优先级最高，在预设填充前应用。 */
export interface ConfigOverrides {
  provider?: string;
  model?: string;
}

/**
 * 解析配置，优先级：命令行覆盖 > 环境变量 > config.toml > provider 预设 > 内置默认。
 *
 * provider：`STEP_CODE_PROVIDER` > TOML `provider` > 默认 'stepfun'（overrides.provider 最高优先）。
 * apiKey：`STEP_CODE_API_KEY` > `STEPFUN_API_KEY`（向后兼容）> TOML `api_key`。
 * baseUrl / model：用户显式配置（env/toml/override）永远优先；未配时用所选 provider 预设默认。
 * @throws 若最终没有 API key。
 */
export function loadConfig(cwd: string = process.cwd(), overrides: ConfigOverrides = {}): StepCodeConfig {
  loadDotEnv(cwd);
  const toml = loadTomlConfig();

  const apiKey =
    process.env['STEP_CODE_API_KEY'] ??
    process.env['STEPFUN_API_KEY'] ??
    asString(toml.api_key);
  if (apiKey === undefined || apiKey === '') {
    throw new Error(
      '缺少 API key。请设置环境变量 STEP_CODE_API_KEY（或向后兼容的 STEPFUN_API_KEY），或在 ~/.step-code/config.toml 写入 api_key。',
    );
  }

  const provider =
    overrides.provider ??
    process.env['STEP_CODE_PROVIDER'] ??
    asString(toml.provider) ??
    DEFAULT_PROVIDER;
  const preset: ProviderPreset = PROVIDER_PRESETS[provider] ?? { protocol: 'anthropic', sendThinking: false };

  // 用户显式配置（override > env > toml）永远优先；未配才落 provider 预设默认。
  const model =
    overrides.model ??
    process.env['STEP_CODE_MODEL'] ??
    asString(toml.model) ??
    preset.model ??
    '';
  const baseUrl =
    process.env['STEP_CODE_BASE_URL'] ??
    asString(toml.base_url) ??
    preset.baseUrl ??
    DEFAULT_BASE_URL;

  const cfg: StepCodeConfig = {
    provider,
    apiKey,
    baseUrl,
    model,
    maxContextSize: asNumber(toml.max_context_size) ?? DEFAULT_MAX_CONTEXT,
    maxTokens: asNumber(toml.max_tokens) ?? DEFAULT_MAX_TOKENS,
    subagent: resolveSubagentLimits(toml.subagent),
    compaction: resolveCompactionConfig(toml.compaction),
    background: resolveBackgroundConfig(toml.background),
    language: resolveLanguage(toml.language),
  };
  // thinking 请求配置：余量校验以最终生效的 maxTokens 为基准（启用且余量不足时抛配置错误）
  cfg.thinking = resolveThinkingConfig(toml.thinking, cfg.maxTokens);
  // 自定义加载路径：未配置或非法时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const agentsPaths = resolveStringArray(toml.agents_paths);
  if (agentsPaths !== undefined) cfg.agentsPaths = agentsPaths;
  const agentsMdMaxBytes = asNumber(toml.agents_md_max_bytes);
  if (agentsMdMaxBytes !== undefined) cfg.agentsMdMaxBytes = agentsMdMaxBytes;
  const extraSkillDirs = resolveStringArray(toml.extra_skill_dirs);
  if (extraSkillDirs !== undefined) cfg.extraSkillDirs = extraSkillDirs;
  const disabledSkills = resolveStringArray(toml.disabled_skills);
  if (disabledSkills !== undefined) cfg.disabledSkills = disabledSkills;
  // 模型别名表：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const models = resolveModels(toml.models);
  if (models !== undefined) cfg.models = models;
  // 渠道表：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const providers = resolveProviders(toml.providers);
  if (providers !== undefined) cfg.providers = providers;
  // 用户可配置 hooks：未配置或全部无效时键不进结果对象（下游 toEqual 精确断言依赖此形态）
  const hooks = resolveHooks(toml.hooks);
  if (hooks !== undefined) cfg.hooks = hooks;
  // 最终 model 命中别名时展开一次（--model 别名 / env / toml 顶层 model 写别名均可工作）
  return resolveModelEntry(cfg, cfg.model) ?? cfg;
}

/**
 * 从 config.toml 顶层 language 字段解析界面语言，缺失或非法落到 'zh'。纯函数，便于单测。
 * @param raw config.toml 里 language 的原始值（可能为 undefined / 非字符串）。
 */
export function resolveLanguage(raw: unknown): Locale {
  return raw === 'en' || raw === 'zh' ? raw : 'zh';
}

/**
 * 把界面语言写回 ~/.step-code/config.toml：只改/追加顶层 `language = "..."` 一行，
 * 其余内容（注释、其他字段、[section]）原样保留，不做整文件重序列化。
 * 文件不存在时创建最小内容。保留原文件的换行风格（CRLF/LF）。
 */
export function saveLanguage(l: Locale): void {
  const dir = join(homedir(), '.step-code');
  const tomlPath = join(dir, 'config.toml');
  const line = `language = "${l}"`;
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);

  // 只在顶层区间（第一个 [section] 头之前）改/插 language 行；重复行只留第一条（防御）。
  const out: string[] = [];
  let inTopLevel = true;
  let written = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (inTopLevel && trimmed.startsWith('[')) inTopLevel = false;
    if (inTopLevel && /^language\s*=/.test(trimmed)) {
      if (!written) {
        out.push(line);
        written = true;
      }
      continue;
    }
    out.push(rawLine);
  }
  if (!written) {
    // 有 section 时必须插到第一个 section 之前，否则落进 section 里成了段内字段
    const sectionIdx = out.findIndex((l) => l.trim().startsWith('['));
    if (sectionIdx === -1) {
      while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
      out.push(line, '');
    } else {
      out.splice(sectionIdx, 0, line);
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(tomlPath, out.join(newline), 'utf8');
}
