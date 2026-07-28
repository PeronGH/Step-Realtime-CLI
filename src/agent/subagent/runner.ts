import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../../provider/types.js';
import { allToolNames } from '../../tools/index.js';
import type { ToolContext } from '../../tools/types.js';
import type { CompactionThresholds } from '../compaction/compact.js';
import type { SubagentProgressEvent } from '../events.js';
import type { LoopHooks } from '../hooks.js';
import { runAgent } from '../loop.js';
import { stored, type StoredMessage } from '../message.js';
import { skillListing, type SkillRegistry } from '../../skill/registry.js';
import { buildAgentRegistry } from './registry.js';
import type { RunSubagentFn, SpawnSubagentRequest, SubagentResult } from './types.js';

const SUMMARY_MIN_LEN = 200;
const SPAWN_TOOL = 'spawn_agent';

/** 会话级共享计数器：跨轮（跨 runner 实例）累计单会话的子 agent 派生数。 */
export interface SubagentSessionCounter {
  spawned: number;
}

export interface SubagentRunnerDeps {
  provider: ChatProvider;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  /** 父 agent 的 hooks（子 agent 沿用，使其写操作走父的审批对话）。 */
  hooks: LoopHooks;
  /** 嵌套深度上限（来自 config.subagent.maxDepth，父=0）。 */
  maxDepth: number;
  /** 单会话累计派生上限（来自 config.subagent.maxPerSession）。 */
  maxPerSession: number;
  /** 每个子 agent 内部步数的全局默认（来自 config.subagent.maxSteps）；agent 定义可覆盖。 */
  maxStepsDefault: number;
  /** 压缩阈值：子 agent 也需要循环内压缩兜底（否则放宽步数后会撑爆上下文）。 */
  compaction: CompactionThresholds;
  /** 压缩摘要专用模型覆盖（来自 config.compaction.model）；省略 = 用 provider 默认模型。 */
  compactionModel?: string;
  /** 用户原话保真预算覆盖（来自 config.compaction.userMessage*）；省略 = 用 compact.ts 默认。 */
  userMessageBudget?: { maxTokens?: number; headTokens?: number };
  /** 会话级共享计数器（外置于 runner 实例，跨轮累计）。 */
  sessionCounter: SubagentSessionCounter;
  /** skill 注册表（组合根注入）：子 agent 共享，system 拼清单 + ctx 带 skills，使其 skill 工具可用。 */
  skills?: SkillRegistry;
  /** 子 agent 进度事件回调（带子 agent 标识 + 生命周期，供 UI 区分各并行子 agent）。 */
  onEvent?: (id: string | undefined, ev: SubagentProgressEvent) => void;
}

/** 组合根用它造 runSubagent 闭包。注册表按 cwd 构建一次。 */
export function createSubagentRunner(deps: SubagentRunnerDeps): RunSubagentFn {
  const registry = buildAgentRegistry(deps.cwd);

  const runImpl: RunSubagentFn = async (req: SpawnSubagentRequest): Promise<SubagentResult> => {
    // 深度硬上限（结构性剔除 spawn_agent 之外的第二道防护）
    if (req.depth + 1 > deps.maxDepth) {
      return {
        summary: `已达子 agent 深度上限（${deps.maxDepth}）。请自己完成该任务，不要再派生子 agent。`,
        isError: true,
      };
    }
    const def = registry.get(req.subagentType);
    if (def === undefined) {
      return {
        summary: `未知子 agent 类型「${req.subagentType}」。可用类型：${[...registry.keys()].join(', ')}。`,
        isError: true,
      };
    }

    // 会话级数量上限：合法请求才计入配额（深度超限 / 未知类型不占额）
    if (deps.sessionCounter.spawned >= deps.maxPerSession) {
      return {
        summary: `已达单会话子 agent 数量上限（${deps.maxPerSession}）。请自己完成剩余任务，不要再派生子 agent。`,
        isError: true,
      };
    }
    deps.sessionCounter.spawned += 1;

    // 工具集 = 角色白名单（或全部）∩ 已注册。仅当子 agent 还可再下探（depth+1 未达 maxDepth）时保留 spawn_agent，
    // 否则剔除（达深度上限后子 agent 不能再派生，防 fork-bomb）。
    const canSpawnDeeper = req.depth + 1 < deps.maxDepth;
    const registered = new Set(allToolNames());
    const allowed = (def.tools ?? allToolNames()).filter(
      (t) => (canSpawnDeeper || t !== SPAWN_TOOL) && registered.has(t),
    );

    // system 拼上 skill 清单：子 agent 也能按需激活技能（与主 agent 一致的懒加载呈现）
    const skillPart = deps.skills !== undefined ? skillListing(deps.skills) : '';
    const system = `${def.systemPrompt}\n\n当前工作目录：${deps.cwd}${skillPart}`;
    const messages: StoredMessage[] = [stored({ role: 'user', content: req.prompt }, 'user')];
    // 深度未达上限时给子 agent 注入 runSubagent（同一 runner，可再派生）；达上限则不注入（拿不到派生能力）
    const selfRunner = canSpawnDeeper
      ? (subReq: SpawnSubagentRequest): ReturnType<RunSubagentFn> => runImpl(subReq)
      : undefined;
    const ctx: ToolContext = {
      cwd: deps.cwd,
      apiKey: deps.apiKey,
      baseUrl: deps.baseUrl,
      signal: req.signal,
      depth: req.depth + 1,
      runSubagent: selfRunner,
      // 子 agent 共享 skill：注册表 + 每个子 agent 独立的单轮激活计数器（递归防护）
      skills: deps.skills,
      skillActivations: { count: 0 },
    };

    const sid = req.id ?? String(deps.sessionCounter.spawned);
    const progress = (ev: SubagentProgressEvent): void => deps.onEvent?.(sid, ev);
    progress({ kind: 'start', subagentType: def.name, description: req.prompt.slice(0, 60) });

    let hadError = false;
    let aborted = false;
    let lastCause: unknown;
    // 子 agent 剥离 goal 续接：复用主 hooks 会让子 agent 的 end_turn 触发主 goal 的 incrementTurn 污染计量；
    // Stop hook 续接对子 agent 也不适用（一次性语义在主会话层）
    const subHooks: LoopHooks = { ...deps.hooks };
    delete subHooks.shouldContinueAfterStop;
    const run = async (): Promise<void> => {
      for await (const ev of runAgent({
        provider: deps.provider,
        system,
        ctx,
        messages,
        signal: req.signal,
        hooks: subHooks,
        maxIterations: def.maxSteps ?? deps.maxStepsDefault,
        allowedTools: allowed,
        model: def.model,
        compaction: deps.compaction, // 子 agent 同样享循环内压缩兜底
        compactionModel: deps.compactionModel,
        userMessageBudget: deps.userMessageBudget,
      })) {
        if (ev.type === 'tool_start') progress({ kind: 'tool', name: ev.name });
        else if (ev.type === 'error') progress({ kind: 'error', message: ev.message });
        if (ev.type === 'error') {
          hadError = true;
          // 保留原始错误对象：父侧调度层据此识别 429 做重排队（status 只存在于 error 对象上）
          if (ev.cause !== undefined) lastCause = ev.cause;
        }
        if (ev.type === 'aborted') aborted = true;
      }
    };

    await run();
    let summary = lastAssistantText(messages);

    // 摘要过短则追加一轮让子 agent 展开（最多 1 次）
    if (!aborted && !hadError && summary.length < SUMMARY_MIN_LEN) {
      messages.push(
        stored(
          {
            role: 'user',
            content: '请把上面的工作展开成更完整的中文说明：做了什么、结论、关键文件/路径。',
          },
          'user',
        ),
      );
      await run();
      summary = lastAssistantText(messages);
    }

    if (aborted) {
      progress({ kind: 'end', isError: true });
      return { summary: '子 agent 已被中断。', isError: true };
    }
    if (summary === '') {
      progress({ kind: 'end', isError: true });
      return { summary: hadError ? '子 agent 执行出错，未产出结果。' : '子 agent 未产出可用结果。', isError: true, cause: lastCause };
    }
    progress({ kind: 'end', isError: hadError });
    return { summary, isError: hadError, cause: hadError ? lastCause : undefined };
  };

  return runImpl;
}

/** 取消息历史里最后一条有文本的 assistant 消息的文本（读内层 message）。 */
function lastAssistantText(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!.message;
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      if (m.content.trim() !== '') return m.content.trim();
      continue;
    }
    const text = m.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text !== '') return text;
  }
  return '';
}
