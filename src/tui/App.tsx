import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runAgent, type AgentEvent } from '../agent/loop.js';
import type { AgentsMdTruncation } from '../agent/agentsMd.js';
import { estimateTokens, fullCompact } from '../agent/compaction/compact.js';
import { runReflect } from '../agent/reflect.js';
import type { LoopHooks } from '../agent/hooks.js';
import { composeLoopHooks, type HookEngine } from '../agent/hooks/engine.js';
import { stored, type StoredMessage } from '../agent/message.js';
import { historyToDisplayItems } from './historyReplay.js';
import { decide, planModeDenyReason, type PermissionMode } from '../agent/permission/mode.js';
import { BackgroundManager, type BackgroundTask } from '../agent/background/manager.js';
import { decideNotifyRoute, formatSettleNotification } from '../agent/background/notify.js';
import { emitTerminalNotification } from '../agent/background/terminal-notify.js';
import { GoalMode, type GoalState } from '../agent/goal/mode.js';
import { CronScheduler } from '../agent/cron/scheduler.js';
import { CronJobStore } from '../agent/cron/store.js';
import { createSubagentRunner } from '../agent/subagent/runner.js';
import { renderSkillActivation, skillListing, type SkillRegistry, type SkillRegistryDiff } from '../skill/registry.js';
import type { CompactionConfig, StepCodeConfig, SubagentLimits } from '../config/config.js';
import { PROVIDER_PRESETS, resolveModelEntry, saveLanguage } from '../config/config.js';
import { getLocale, setLocale, t, type Locale } from '../i18n.js';
import { createProvider } from '../provider/factory.js';
import type { ChatProvider } from '../provider/types.js';
import type { ToolContext } from '../tools/types.js';
import type { TodoItem } from '../tools/types.js';
import { clearDynamicTools } from '../tools/index.js';
import { AgentGroup, formatAgentGroupSummary } from './AgentGroup.js';
import { ExpandedReview } from './ExpandedReview.js';
import { ApprovalPrompt, denyReason, estimateChromeRows as estimateApprovalRows, type ApprovalRequest } from './ApprovalPrompt.js';
import { QuestionPrompt, estimateChromeRows as estimateQuestionRows } from './QuestionPrompt.js';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { readClipboardImage, clipboardToolHint } from './clipboardImage.js';
import { ImageAttachmentStore, extractImageContent } from './imageAttachment.js';
import { busyRoute, helpText, parseSlash } from './commands.js';
import { runPluginCommand } from './pluginCommand.js';
import { expandPluginCommand, type PluginCommand } from '../plugin/manager.js';
import { formatMcpStatus } from '../mcp/status.js';
import type { McpManager } from '../mcp/manager.js';
import { formatElapsed } from './elapsed.js';
import { STATUS_BAR_ROWS } from './LiveViewport.js';
import { computeLiveBudget, logRenderBudget, displayWidth, wrappedRows } from './liveBudget.js';
import { MessageItem, MessageList, ThinkingPreview, THINKING_PREVIEW_LINES, appendStreamText, countSettledItems } from './MessageList.js';
import { ModelPicker, type ModelPickerItem } from './ModelPicker.js';
import { SessionPicker, relativeTime } from './SessionPicker.js';
import { ThinkPicker, type ThinkPickerItem } from './ThinkPicker.js';
import {
  parseThinkArgs,
  thinkBudgetSafety,
  thinkLevelsOf,
  thinkStatusLabel,
  thinkStreamParam,
  thinkingAvailable,
  type ThinkOverride,
} from './thinkCommand.js';
import { PromptInput, computePromptRows } from './PromptInput.js';
import { QueuePreview } from './QueuePreview.js';
import { computeBacktrack, truncateItemsAtLastUser } from './backtrack.js';
import { StatusBar } from './StatusBar.js';
import { TodoPanel, allTodosDone } from './TodoPanel.js';
import { WorkingStatus } from './WorkingStatus.js';
import { applyStepEvent, applySubagentEvent, parseWorkflowInput, parseWfSid } from './WorkflowPanel.js';
import { WelcomeBox } from './WelcomeBox.js';
import type { SessionData, SessionMeta, SessionStore } from '../session/store.js';
import { exportDebugBundle } from '../session/debugBundle.js';
import { InputHistoryStore } from '../session/inputHistory.js';
import type { DisplayItem } from './types.js';
import { VERSION } from '../version.js';

/** 待确认的计划（exit_plan_mode 提交）。 */
interface PendingPlan {
  plan: string;
}

export interface AppProps {
  provider: ChatProvider;
  /** system prompt 静态前缀（buildSystemPrompt 产出）；skill 清单与 AGENTS.md 由 App 按当前注册表逐轮组合。 */
  systemPrefix: string;
  /** AGENTS.md 汇总内容（空串 = 无，组合时省略）。 */
  agentsMd: string;
  /** AGENTS.md 预算裁减明细（空数组 = 未发生）；启动时一次性提示用户。 */
  agentsMdTruncated: AgentsMdTruncation[];
  /** 当前生效的 AGENTS.md 总字节预算（提示文案展示用）。 */
  agentsMdMaxBytes: number;
  /** 当前 skill 注册表持有者：/skill reload 或 turn 边界指纹检测后整体换引用。 */
  skillsRef: { current: SkillRegistry };
  /** 重扫 skill 目录：force=false 且指纹未变时返回 null（零成本），否则全量重建并返回 diff。 */
  reloadSkills: (force?: boolean) => SkillRegistryDiff | null;
  ctx: ToolContext;
  model: string;
  /** 完整配置快照，供运行时 /provider 重建 provider 实例。 */
  config: StepCodeConfig;
  initialMode: PermissionMode;
  store: SessionStore;
  session: SessionData;
  maxContextSize: number;
  subagent: SubagentLimits;
  compaction: CompactionConfig;
  /** MCP 连接管理器（组合根注入，供 /mcp 状态面板查询）。缺失表示未配置 MCP。 */
  mcp?: McpManager;
  /** 用户可配置 hooks 引擎（组合根注入）。缺失表示未配置 [[hooks]]。 */
  hookEngine?: HookEngine;
  /** plugin 贡献的命令模板（组合根注入，name 已带 <pluginId>: 命名空间前缀）。 */
  pluginCommands?: PluginCommand[];
  /** 退出（/exit、Ctrl+C 等触发 unmount）时上抛当前会话信息，供 main 打印 resume 提示。 */
  onExitInfo?: (sessionId: string, hasContent: boolean) => void;
}

export function App({
  provider,
  systemPrefix,
  agentsMd,
  agentsMdTruncated,
  agentsMdMaxBytes,
  skillsRef,
  reloadSkills,
  ctx,
  model: initialModel,
  config,
  initialMode,
  store,
  session,
  maxContextSize: initialMaxContextSize,
  subagent,
  compaction,
  mcp,
  hookEngine,
  pluginCommands,
  onExitInfo,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const resumed = session.messages.length > 0;
  const [items, setItems] = useState<DisplayItem[]>(() => {
    if (!resumed) return [];
    const replay = historyToDisplayItems(session.messages);
    const tail: DisplayItem[] = [];
    if (replay.foldedTurns > 0) {
      tail.push({
        kind: 'note',
        text: t('app.replay.folded', { folded: replay.foldedTurns, total: replay.totalTurns }),
      });
    }
    tail.push({
      kind: 'note',
      text: t('app.resumed', {
        id: session.id,
        turns: replay.totalTurns,
        count: session.messages.length,
      }),
    });
    // 折叠提示放在历史内容之前（顶部），恢复 note 放在最末（贴近输入框）。
    return replay.foldedTurns > 0
      ? [tail[0]!, ...replay.items, tail[1]!]
      : [...replay.items, tail[0]!];
  });
  const [input, setInput] = useState('');
  const [model, setModel] = useState(initialModel);
  // 状态栏模型显示名：当前模型命中带 displayName 的别名时用 displayName，否则用真实 id。
  const [modelLabel, setModelLabel] = useState(() => {
    for (const [alias, entry] of Object.entries(config.models ?? {})) {
      if ((entry.model ?? alias) === initialModel && entry.displayName !== undefined) {
        return entry.displayName;
      }
    }
    return initialModel;
  });
  // /model 无参唤起的交互式模型选择器（替换输入区，对齐提问/审批弹层的挂载模式）。
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // /resume 无参唤起的交互式会话选择器（同 ModelPicker 弹层挂载模式）。
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  // 会话选择器的候选快照：打开时从 store.list 快照一次（避免每帧读盘），删除后本地移除。
  const [sessionPickerItems, setSessionPickerItems] = useState<SessionMeta[]>([]);
  // /think 无参唤起的交互式思考深度选择器（同 ModelPicker 弹层挂载模式）。
  const [thinkPickerOpen, setThinkPickerOpen] = useState(false);
  // 会话级思考深度覆盖：undefined = 跟随 config 默认；'off' = 本会话不发 thinking 字段；
  // 其余 = 档位名（budget 取 config.thinking.levels）。与模型覆盖解耦：/model 切换不重置它。
  const [thinkOverride, setThinkOverride] = useState<ThinkOverride | undefined>(undefined);
  // 上下文窗口大小做成 state：/model 切别名时跟随别名的 maxContextSize（压缩判定与状态栏共用）。
  const [maxContextSize, setMaxContextSize] = useState(initialMaxContextSize);
  const [busy, setBusy] = useState(false);
  // 本回合忙碌起始时间戳（busy 上升沿设，供 WorkingStatus 显示 elapsed）。0 = 未忙碌。
  const [turnStartAt, setTurnStartAt] = useState(0);
  // 本回合流式产出的字符数（text 事件累加，busy 上升沿清零）：/4 估 output token 供 WorkingStatus 显示。
  const turnOutputCharsRef = useRef(0);
  const [turnOutputChars, setTurnOutputChars] = useState(0);
  const [mode, setMode] = useState<PermissionMode>(initialMode);
  // 界面语言：值本身不进渲染（t() 读模块级 locale），setState 只为触发整树重渲。初始取配置。
  const [, setLang] = useState<Locale>(config.language ?? 'zh');
  const [planMode, setPlanMode] = useState(false);
  const [pending, setPending] = useState<ApprovalRequest | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<AskUserRequest | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [, setTodoTick] = useState(0);
  // <Static> 重挂载计数：/new、/resume 整体重置 items 时递增，key 驱动 Static 重建
  // （Static 内部只按数组长度追加渲染，数组变短不重挂会丢条目；重挂后 ink 丢弃旧静态输出重放新实例）。
  const [sessionEpoch, setSessionEpoch] = useState(0);

  const busyRef = useRef(false);
  // 运行时 provider 实例：/provider 切换时用 createProvider 重建并替换 current。
  const providerRef = useRef<ChatProvider>(provider);
  // 当前生效渠道名（预设名或自定义渠道的 type）：/provider、/model 别名切换时同步，/think 门控据此判定。
  const providerNameRef = useRef(config.provider);
  const modeRef = useRef(initialMode);
  // 当前模型 id 的 ref（persist 落盘用，避免闭包读陈旧 state；applyModelAlias 切换时同步）
  const modelRef = useRef(initialModel);
  const planModeRef = useRef(false);
  const history = useRef<StoredMessage[]>(session.messages.slice());
  const sessionRef = useRef<SessionData>(session);

  // 退出（/exit、Ctrl+C 等触发 unmount）时上抛当前会话信息，供 main 打印 resume 提示。
  // sessionRef 在 /new、/fork、/resume 时已切换为当前会话，cleanup 读到的是终态值。
  useEffect(() => {
    return () => {
      onExitInfo?.(sessionRef.current.id, sessionRef.current.messages.length > 0);
    };
  }, [onExitInfo]);

  // SessionStart hook 注入的会话上下文暂存（stdout 拼进后续 runAgent 的 system 尾部）。
  // 触发点放在 pushItem 定义之后的 effect 里（notice 出口依赖它）。
  const sessionContextRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const sessionApprovals = useRef<Set<string>>(new Set());
  const pendingRef = useRef<ApprovalRequest | null>(null);
  const approvalResolver = useRef<((r: { allow: boolean; feedback?: string }) => void) | null>(null);
  const imageStore = useRef<ImageAttachmentStore>(new ImageAttachmentStore());
  // 输入框里当前有效图片占位符数（从 input 派生，占位符增删自动跟随）。必须在 imageStore 定义之后声明。
  const imageCount = useMemo(() => imageStore.current.activeIds(input).length, [input]);
  const pendingPlanRef = useRef<PendingPlan | null>(null);
  const planResolver = useRef<((approved: boolean) => void) | null>(null);
  // 询问用户：双 ref 模式（照抄审批/计划）。发起时存 resolve + setPending 触发渲染，答完/取消 resolve 恢复 generator。
  const pendingQuestionRef = useRef<AskUserRequest | null>(null);
  const questionResolver = useRef<((answers: QuestionAnswers) => void) | null>(null);
  // 发送缓冲队列：busy 时输入入队（FIFO），回合结束自动逐条发送。
  const queue = useRef<string[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  // backtrack（双击 Esc 回退编辑上一条）primed 态：ref 供 useInput 闭包读即时值，state 驱动输入框提示渲染。
  const backtrackPrimedRef = useRef(false);
  const [backtrackPrimed, setBacktrackPrimed] = useState(false);
  // primed 态 5 秒自动取消的定时器句柄（进入时起，取消/触发/卸载时清）。
  const backtrackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 退出确认（双击 Ctrl+C 退出）primed 态：结构同 backtrack primed（pendingExit）。
  const exitPrimedRef = useRef(false);
  const [exitPrimed, setExitPrimed] = useState(false);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 并行/批量子 agent 的进度（spawn_agent 调用时建条目，tool_end 标完成，onEvent 更新活动）。
  const [subagents, setSubagents] = useState<import('./AgentGroup.js').SubagentProgress[]>([]);
  // 运行中的 workflow 工具调用 id 栈：onWorkflowStep 与 wf- 前缀子 agent 事件据此定位步骤面板。
  const activeWorkflowRef = useRef<string[]>([]);
  // 上下文占用 token（状态栏 context 进度条）：平时由 provider 真实 usage 事件驱动，
  // 压缩（循环内自动 / 手动 /compact）后无真实 usage 可用，先用字符估算立即回落，下一条真实 usage 再校正。
  const [usedTokens, setUsedTokens] = useState(0);
  // usedTokens 已测量/覆盖的 history 前缀长度。真实 usage 覆盖当轮完整 messages；
  // 此后新 append、尚未经历 API 往返的尾部消息用字符估算叠加到显示值上（见 refreshContextUsage），
  // 使状态栏在两次往返之间也能反映新增内容（贴长文本、脚本输出等）。下一条真实 usage 到达时校正、不叠加。
  const measuredLenRef = useRef(0);
  // 已测量前缀的 token 基准值：最近一条真实 usage（或压缩后全量估算）覆盖 [0, measuredLenRef) 的 token 数。
  // 显示值 = baseTokensRef + 未测量尾部估算，二者由 refreshContextUsage 组装写入 usedTokens。
  const baseTokensRef = useRef(0);
  // 流式期思考缓冲：ref 供 applyEvent 即时读写，state 驱动状态行预览重渲；
  // 思考完成后落成 kind:'thinking' 定稿条目并清空（参考 Codex：流式只进状态行，完成才落历史）。
  const thinkingRef = useRef('');
  const [thinkingPreview, setThinkingPreview] = useState('');
  // 输入框命令历史：按工作目录隔离，启动全量载入内存，提交时 append 落盘。
  const inputHistoryStore = useRef<InputHistoryStore>(new InputHistoryStore(ctx.cwd));
  const [inputHistory, setInputHistory] = useState<string[]>(() => inputHistoryStore.current.load());
  // TODO 任务清单（独立 store，不占 messages；与 session 同步持久化）。
  const todos = useRef<TodoItem[]>(session.todos !== undefined ? [...session.todos] : []);
  // 进入 plan 前的权限档，供批准计划后恢复（或策略性切换）。
  const prePlanModeRef = useRef<PermissionMode | null>(null);
  // 会话级子 agent 派生计数器：跨轮累计，/new 时清零。
  const subagentCounter = useRef<{ spawned: number }>({ spawned: 0 });
  // 会话级后台任务管理器：跨轮共享，保留后台任务；终态经 onSettle 上报（经 ref 中转避免创建时序环）。
  const settleHandlerRef = useRef<((task: BackgroundTask) => void) | null>(null);
  const background = useRef(
    new BackgroundManager(10, {
      taskTimeoutS: config.background?.bashTaskTimeoutS ?? 600,
      onSettle: (task) => settleHandlerRef.current?.(task),
    }),
  );
  // 后台任务计数变化时触发重渲（StatusBar bg:N 徽章读 background.activeCount()）。
  const [, setBgTick] = useState(0);
  // 发送缓冲队列中的后台通知文本集合（多条各自独立入队）：shift 发出时据此带 recordHistory:false。
  const notifyTextRef = useRef<Set<string>>(new Set());
  // 会话级 goal 管理器：自主目标，跨轮持有；挂载时从 session 快照恢复（active 降级 paused，防重启自动续跑）
  const goal = useRef(new GoalMode());
  const goalRestored = useRef(false);
  if (!goalRestored.current) {
    goalRestored.current = true;
    goal.current.restore(session.goal);
  }
  // cron 触发时注入的回调（把 prompt 当作一条用户消息跑一轮）。App 挂载时注入。
  const cronFireRef = useRef<((prompt: string) => void) | null>(null);
  // /skill 命令激活：把技能正文静默注入会话跑一轮（经 submit，避免 handleSlash↔submit 循环依赖）。
  const skillInjectRef = useRef<((text: string) => void) | null>(null);
  // plugin 命令注册表：<pluginId>:<commandName> → 模板（启动时由组合根注入，运行期不变）。
  const pluginCommandMap = useMemo(() => new Map((pluginCommands ?? []).map((c) => [c.name, c])), [pluginCommands]);
  const pluginCommandNames = useMemo(() => new Set(pluginCommandMap.keys()), [pluginCommandMap]);
  // cron 任务持久层：按 cwd 分桶落盘（不属于单个会话），变更即异步写、失败只 warn
  const cronStore = useRef(new CronJobStore(store));
  // cron 调度器：fire 时经 cronFireRef 注入会话；isIdle = 当前不忙。
  // 调度器保持纯内存引擎，持久化叠加在此装配层：create/delete 走 onJobChange，触发推进 nextFireAt 后补写
  const cron = useRef<CronScheduler | null>(null);
  if (cron.current === null) {
    cron.current = new CronScheduler(
      (job, coalesced) => {
        // 触发打专用卡片（标题 + cron 表达式/job/合并详情 + prompt 正文），替代原来的单行 note
        pushItem({
          kind: 'cron',
          data: { id: job.id, cron: job.cron, prompt: job.prompt, recurring: job.recurring, coalesced },
        });
        cronFireRef.current?.(job.prompt);
        // 触发推进了 nextFireAt（tick 内同步推进，microtask 时已是新游标）：recurring 补写游标，一次性触发即删清盘
        if (job.recurring) queueMicrotask(() => void cronStore.current.save(ctx.cwd, job));
        else void cronStore.current.remove(ctx.cwd, job.id);
      },
      () => !busyRef.current,
    );
    cron.current.onJobChange = (kind, job) => {
      if (kind === 'create') void cronStore.current.save(ctx.cwd, job);
      else void cronStore.current.remove(ctx.cwd, job.id);
    };
    // 恢复本 cwd 的任务表（坏文件已在 load 静默丢弃）；stale 由 restore 剔除并清盘，
    // 离线漏跑由 tick 的 coalesce 逻辑补投（一次性任务过期补投一次）
    const staleIds = cron.current.restore(cronStore.current.load(ctx.cwd));
    for (const id of staleIds) void cronStore.current.remove(ctx.cwd, id);
  }

  const persist = useCallback(() => {
    sessionRef.current.messages = history.current;
    sessionRef.current.todos = [...todos.current];
    // goal 快照随会话落盘（无 goal 时清掉旧字段）
    sessionRef.current.goal = goal.current.snapshot() ?? undefined;
    // 权限模式与模型随会话落盘（会话级状态，恢复时读回）：从 ref 取当前值，
    // 避免闭包读到陈旧 state；切换点只需保证调用 persist 即生效。
    sessionRef.current.mode = modeRef.current;
    sessionRef.current.model = modelRef.current;
    try {
      store.save(sessionRef.current);
      // 全量历史日志：按 id 去重追加 history.current 中尚未写过的消息。
      // 压缩后 history.current 变短，但已落盘的 JSONL 保留被压缩掉的行，不受影响。
      store.appendFull(sessionRef.current.cwd, sessionRef.current.id, history.current);
    } catch {
      // 持久化失败不应打断会话
    }
  }, [store]);

  const changeMode = useCallback((m: PermissionMode) => {
    modeRef.current = m;
    setMode(m);
    // 权限模式是会话级状态：切换即落盘，恢复会话时读回（否则重开退回默认，实测问题）
    persist();
  }, [persist]);

  const setPlanModeBoth = useCallback((on: boolean) => {
    planModeRef.current = on;
    setPlanMode(on);
  }, []);

  const pushItem = useCallback((item: DisplayItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  // busy 上升沿：记本回合起始时间 + 清零本轮产出字符数（供 WorkingStatus 显示 elapsed/token）。
  useEffect(() => {
    if (busy) {
      setTurnStartAt(Date.now());
      turnOutputCharsRef.current = 0;
      setTurnOutputChars(0);
    }
  }, [busy]);

  // 候选队列取回：busy + 输入框为空时 ↑ pop 队尾一条进输入框编辑
  //（发送从头部 shift 消费，编辑从尾部 pop 取回，两个方向不冲突）。
  // 通知条目被取回即摘除系统标记——编辑后就是用户草稿，提交时记输入历史。
  const recallQueued = useCallback((): string | undefined => {
    const recalled = queue.current.pop();
    if (recalled === undefined) return undefined;
    notifyTextRef.current.delete(recalled);
    setQueueLen(queue.current.length);
    return recalled;
  }, []);

  // 同名 skill 冲突提示文本：哪个来源被采用、覆盖了谁（无冲突返回 null）
  const skillConflictNote = useCallback((): string | null => {
    const conflicts = skillsRef.current.conflicts ?? [];
    if (conflicts.length === 0) return null;
    const lines = conflicts.map((c) =>
      t('app.skill.conflict.line', {
        name: c.name,
        winner: c.winner.dir,
        losers: c.overridden.map((o) => o.dir).join('、'),
      }),
    );
    return `${t('app.skill.conflict.header', { count: conflicts.length })}\n${lines.join('\n')}`;
  }, [skillsRef]);

  // 启动时报告一次同名 skill 冲突（之后由 reload 路径在冲突变化时再报）
  useEffect(() => {
    const note = skillConflictNote();
    if (note !== null) pushItem({ kind: 'note', text: note });
  }, [skillConflictNote, pushItem]);

  // 子 agent 全部终态：摘要冻结进历史（scrollback 留痕可回看），动态面板随即撤下，
  // 不在动态区驻留到回合末——运行进度由面板承担，完成结果由历史承担。
  // 下一波子 agent 启动时会重建面板，每波各留一条摘要。
  useEffect(() => {
    if (subagents.length === 0) return;
    if (subagents.some((a) => a.status === 'running' || a.status === 'queued')) return;
    pushItem({ kind: 'note', text: formatAgentGroupSummary(subagents) });
    setSubagents([]);
  }, [subagents, pushItem]);

  // 启动时一次性提示 AGENTS.md 预算裁减：哪些文件被截断/整篇丢弃、原始多大。
  // AGENTS.md 会话内不变（启动加载一次，无 watcher），逐轮提示是噪音，故只在挂载时报一次。
  useEffect(() => {
    if (agentsMdTruncated.length === 0) return;
    const kb = (n: number): string => (n / 1024).toFixed(1);
    const lines = agentsMdTruncated.map((tr) =>
      tr.keptBytes > 0
        ? t('app.agentsMd.truncated.line', {
            path: tr.path,
            original: kb(tr.originalBytes),
            kept: kb(tr.keptBytes),
          })
        : t('app.agentsMd.dropped.line', { path: tr.path, original: kb(tr.originalBytes) }),
    );
    pushItem({
      kind: 'note',
      text: `${t('app.agentsMd.truncated.header', { budget: kb(agentsMdMaxBytes) })}\n${lines.join('\n')}`,
    });
  }, [agentsMdTruncated, agentsMdMaxBytes, pushItem]);

  // SessionStart hook：会话创建/恢复后触发一次，stdout 注入会话上下文（拼进后续 runAgent 的 system 尾部）；
  // hook 执行可见性 notice 挂到转录区 note 条目
  useEffect(() => {
    if (hookEngine === undefined) return;
    hookEngine.setNoticeSink((m) => pushItem({ kind: 'note', text: m }));
    void hookEngine.run('SessionStart', {}).then((r) => {
      if (r.stdout !== '') sessionContextRef.current = r.stdout;
    });
  }, [hookEngine, pushItem]);

  // goal 视图快照（状态栏徽标数据源）与墙钟：onChange 同步快照并打生命周期 marker；active 时每 15s 跳一次用时
  const [goalView, setGoalView] = useState<GoalState | null>(goal.current.get());
  const [goalNow, setGoalNow] = useState(() => Date.now());
  useEffect(() => {
    goal.current.setOnChange((ev) => {
      setGoalNow(Date.now());
      const g = ev.goal;
      if (ev.type === 'completed') {
        // 完成瞬态：徽标消失，打确定性统计消息（数字来自快照，不依赖模型文采）
        setGoalView(null);
        pushItem({
          kind: 'note',
          text: t('goal.complete', {
            reason: g.terminalReason !== undefined ? t('goal.completeReason', { reason: g.terminalReason }) : '',
            turns: g.turnsUsed,
            elapsed: formatElapsed(Date.now() - g.createdAt),
          }),
        });
        persist(); // goal 变更随会话落盘
        return;
      }
      setGoalView({ ...g });
      if (ev.type === 'created') {
        pushItem({ kind: 'note', text: t('goal.marker.created', { objective: g.objective }) });
      } else {
        pushItem({
          kind: 'note',
          text: t(`goal.marker.${g.status}`, {
            reason: g.terminalReason !== undefined ? t('goal.reasonSuffix', { reason: g.terminalReason }) : '',
          }),
        });
      }
      persist(); // goal 变更随会话落盘
    });
    return () => goal.current.setOnChange(null);
  }, [persist, pushItem]);
  useEffect(() => {
    if (goalView === null || goalView.status !== 'active') return;
    const timer = setInterval(() => setGoalNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [goalView]);

  const resolveApproval = useCallback((allow: boolean, forSession: boolean, feedback?: string) => {
    const req = pendingRef.current;
    if (req !== null && allow && forSession) {
      sessionApprovals.current.add(req.name);
    }
    pendingRef.current = null;
    setPending(null);
    const resolve = approvalResolver.current;
    approvalResolver.current = null;
    resolve?.(feedback === undefined ? { allow } : { allow, feedback });
  }, []);

  const askApproval = useCallback((req: ApprovalRequest): Promise<{ allow: boolean; feedback?: string }> => {
    return new Promise<{ allow: boolean; feedback?: string }>((resolve) => {
      approvalResolver.current = resolve;
      pendingRef.current = req;
      setPending(req);
    });
  }, []);

  const askPlanApproval = useCallback((plan: string): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      planResolver.current = resolve;
      pendingPlanRef.current = { plan };
      setPendingPlan({ plan });
    });
  }, []);

  const resolvePlan = useCallback(
    (approved: boolean) => {
      const pp = pendingPlanRef.current;
      pendingPlanRef.current = null;
      setPendingPlan(null);
      const resolve = planResolver.current;
      planResolver.current = null;
      if (approved && pp !== null) {
        pushItem({ kind: 'assistant', text: t('app.plan.approved', { plan: pp.plan }) });
      }
      resolve?.(approved);
    },
    [pushItem],
  );

  const askUserQuestion = useCallback((req: AskUserRequest): Promise<QuestionAnswers> => {
    return new Promise<QuestionAnswers>((resolve) => {
      questionResolver.current = resolve;
      pendingQuestionRef.current = req;
      setPendingQuestion(req);
    });
  }, []);

  const resolveQuestion = useCallback((answers: QuestionAnswers) => {
    pendingQuestionRef.current = null;
    setPendingQuestion(null);
    const resolve = questionResolver.current;
    questionResolver.current = null;
    resolve?.(answers);
  }, []);

  const attachClipboardImage = useCallback(() => {
    pushItem({ kind: 'note', text: t('app.image.reading') });
    void readClipboardImage().then((img) => {
      if (img === null) {
        // 区分「缺平台工具」与「剪贴板没图片」，给不同提示
        const hint = clipboardToolHint();
        pushItem({ kind: 'note', text: hint ?? t('app.image.none') });
        return;
      }
      const att = imageStore.current.add(img.base64, img.mediaType, img.width, img.height);
      // 把占位符追加到输入框末尾（前面有内容则补一个空格分隔）。
      // 用户可直接编辑删除该占位符文本来移除这张图。imageCount 从 input 派生，自动跟随。
      setInput((prev) => (prev === '' || prev.endsWith(' ') ? prev : `${prev} `) + att.placeholder);
    });
  }, [pushItem]);

  // === backtrack primed 状态机（E1）===
  // primed 进入/取消/回退三个动作集中在此，供 useInput 的 Esc 分支调用。
  const cancelBacktrackPrimed = useCallback(() => {
    backtrackPrimedRef.current = false;
    setBacktrackPrimed(false);
    if (backtrackTimerRef.current !== null) {
      clearTimeout(backtrackTimerRef.current);
      backtrackTimerRef.current = null;
    }
  }, []);

  const enterBacktrackPrimed = useCallback(() => {
    backtrackPrimedRef.current = true;
    setBacktrackPrimed(true);
    if (backtrackTimerRef.current !== null) clearTimeout(backtrackTimerRef.current);
    // 5 秒无第二次 Esc 自动取消 primed（对齐设计文档 E3）。
    backtrackTimerRef.current = setTimeout(() => {
      backtrackPrimedRef.current = false;
      setBacktrackPrimed(false);
      backtrackTimerRef.current = null;
    }, 5000);
  }, []);

  // 第二次 Esc：回滚最后一条 user 消息及其之后的全部历史，转录区同步截断，
  // sessionEpoch 递增触发 <Static> 重挂重放，消息文本 prefill 回输入框。
  const performBacktrack = useCallback(() => {
    cancelBacktrackPrimed();
    const result = computeBacktrack(history.current);
    if (result === null) return;
    history.current = result.history;
    setItems((prev) => truncateItemsAtLastUser(prev));
    persist();
    setSessionEpoch((e) => e + 1);
    setInput(result.prefill);
  }, [cancelBacktrackPrimed, persist]);

  // 重算状态栏 context 用量：已测量前缀基准（baseTokensRef）+ 未测量尾部字符估算。
  // 真实 usage 到达后 measuredLenRef=全长、尾部为空 → 显示纯真实值（校正、不叠加）；
  // resume / 新 append 未往返时前缀不覆盖尾部，用估算叠加，使状态栏立即反映新增内容。
  const refreshContextUsage = useCallback(() => {
    const tail = history.current.slice(measuredLenRef.current);
    setUsedTokens(baseTokensRef.current + (tail.length > 0 ? estimateTokens(tail) : 0));
  }, []);

  // 卸载时清掉 primed 定时器，避免泄漏。
  useEffect(() => () => {
    if (backtrackTimerRef.current !== null) clearTimeout(backtrackTimerRef.current);
    if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
  }, []);

  // === Ctrl+C 退出确认状态机（pendingExit）===
  const cancelExitPrimed = useCallback(() => {
    exitPrimedRef.current = false;
    setExitPrimed(false);
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const enterExitPrimed = useCallback(() => {
    exitPrimedRef.current = true;
    setExitPrimed(true);
    if (exitTimerRef.current !== null) clearTimeout(exitTimerRef.current);
    // 5 秒无第二次 Ctrl+C 自动取消（与 backtrack primed 同一节奏）
    exitTimerRef.current = setTimeout(() => {
      exitPrimedRef.current = false;
      setExitPrimed(false);
      exitTimerRef.current = null;
    }, 5000);
  }, []);

  // 键盘：Ctrl+O 折叠；Alt+V 贴图；输入为空时退格删最后一张图；计划确认 y/n；审批中按键交给 ApprovalPrompt；忙碌时 Esc 中断。
  useInput((key, meta) => {
    if (meta.ctrl && key === 'o') {
      setExpanded((v) => !v);
      return;
    }
    // backtrack primed 态：除 Esc 外的任意按键都取消 primed。
    // 放在各弹窗早退分支之前，保证即便有按键触发弹窗，primed 也不会被遗留。
    // 不 return——这次按键仍按下面的正常逻辑继续处理。
    if (backtrackPrimedRef.current && !meta.escape) {
      cancelBacktrackPrimed();
    }
    // 退出 primed 态同理：除 Ctrl+C 外的任意按键取消（clearPendingExit）。
    if (exitPrimedRef.current && !(meta.ctrl && key === 'c')) {
      cancelExitPrimed();
    }
    // 提问态最高优先：全部按键交给 QuestionPrompt 自身的 useInput 处理，App 不插手
    if (pendingQuestionRef.current !== null) {
      return;
    }
    // 模型选择器打开时：全部按键交给 ModelPicker 自身的 useInput 处理（↑↓/过滤/Enter/Esc），App 不插手
    if (modelPickerOpen) {
      return;
    }
    // 思考深度选择器打开时：全部按键交给 ThinkPicker 自身的 useInput 处理（↑↓/Enter/Esc），App 不插手
    if (thinkPickerOpen) {
      return;
    }
    // 会话选择器打开时：全部按键交给 SessionPicker 自身的 useInput 处理（↑↓/过滤/Enter/删除/Esc），App 不插手
    if (sessionPickerOpen) {
      return;
    }
    // 计划确认框优先（Ready to code?）
    if (pendingPlanRef.current !== null) {
      if (key === 'y') resolvePlan(true);
      else if (key === 'n' || meta.escape) resolvePlan(false);
      return;
    }
    // 审批态：全部按键交给 ApprovalPrompt 自身的 useInput 处理（↑↓/数字/y/a/n/Enter/Esc），App 不插手
    if (pendingRef.current !== null) {
      return;
    }
    // === Ctrl+C 三态（render 已关 exitOnCtrlC）===
    //   (1) busy → 中断当前回合（与 Esc 同一语义），不进 primed；
    //   (2) 空闲 + 已 primed → 退出；
    //   (3) 空闲 → 清空输入框 + 进 primed（提示「再按一次 Ctrl+C 退出」，5 秒自动取消）。
    if (meta.ctrl && key === 'c') {
      if (busyRef.current) {
        cancelExitPrimed();
        abortRef.current?.abort();
        return;
      }
      if (exitPrimedRef.current) {
        exit();
        return;
      }
      if (input !== '') setInput('');
      enterExitPrimed();
      return;
    }
    // 图片以占位符文本形式在输入框内，用户可直接用退格/删除键编辑移除，无需特殊分支。
    if (meta.meta && key === 'v' && !busyRef.current) {
      attachClipboardImage();
      return;
    }
    // === Esc 三态语义（E3）===
    // 三态串行，弹窗永远优先：
    //   (1) 弹窗优先——提问/计划/审批弹窗激活时 Esc = 取消/拒绝，已在上面各分支拦截，走不到这里；
    //   (2) busy 中断——运行中 Esc = abort 当前回合，队列非空则回合末自动续发（见 submit 的 finally）；
    //   (3) 空闲——队列非空则取回队列合并回输入框（优先级高于 backtrack）；
    //       否则输入框为空 + 存在可回退 user 消息时，第一次 Esc 进 primed、第二次 Esc 回退上一条。
    if (meta.escape && busyRef.current) {
      // 弹层优先：输入框是斜杠命令（菜单可见）时 Esc 归 PromptInput 关菜单，不中断回合；
      // 菜单关掉后下一次 Esc 才中断（与空闲态「弹窗优先于中断」的 E3 语义一致）
      if (input.startsWith('/')) return;
      abortRef.current?.abort();
      return;
    }
    if (meta.escape && !busyRef.current) {
      // 3-1. 队列非空：合并回输入框草稿（restore composer），给用户编辑权
      if (queue.current.length > 0) {
        const restored = queue.current.join('\n');
        queue.current = [];
        notifyTextRef.current.clear();
        setQueueLen(0);
        setInput(restored);
        pushItem({ kind: 'note', text: t('app.queue.restored') });
        return;
      }
      // 3-2. 队列空 + 输入框空 + 有可回退 user 消息：双击 Esc 回退编辑
      if (input === '' && computeBacktrack(history.current) !== null) {
        if (backtrackPrimedRef.current) performBacktrack();
        else enterBacktrackPrimed();
        return;
      }
      return;
    }
  });

  const applyEvent = useCallback((ev: AgentEvent) => {
    // thinking 流式：只累积进状态行预览，不进历史区
    if (ev.type === 'thinking_delta') {
      thinkingRef.current += ev.text;
      setThinkingPreview(thinkingRef.current);
      // 思考也消耗 output 预算，计入本轮产出估算（WorkingStatus 的「↓ N tokens」）
      turnOutputCharsRef.current += ev.text.length;
      setTurnOutputChars(turnOutputCharsRef.current);
      return;
    }
    // 任何非 thinking 事件到来 = 思考块已结束：落成定稿条目（暗色斜体块）
    if (thinkingRef.current !== '') {
      const thinkingText = thinkingRef.current;
      thinkingRef.current = '';
      setThinkingPreview('');
      setItems((prev) => [...prev, { kind: 'thinking', text: thinkingText }]);
    }
    // workflow 工具调用跟踪：start 入栈 / end 出栈，供 onWorkflowStep 与 wf- 子 agent 事件定位面板
    if (ev.type === 'tool_start' && ev.name === 'workflow') activeWorkflowRef.current.push(ev.id);
    if (ev.type === 'tool_end' && ev.name === 'workflow') {
      activeWorkflowRef.current = activeWorkflowRef.current.filter((id) => id !== ev.id);
    }
    // 本轮流式正文字符累加（WorkingStatus 用来估 output token）。thinking 在上方分支单独累加；
    // tool_use 参数在下方 tool_start 分支累加——三类 output（正文/思考/工具调用）都计入，与服务端 output_tokens 口径趋同。
    if (ev.type === 'text') {
      turnOutputCharsRef.current += ev.text.length;
      setTurnOutputChars(turnOutputCharsRef.current);
    }
    setItems((prev) => {
      const next = [...prev];
      switch (ev.type) {
        case 'text':
          // 流式正文追加（越过 UI 侧提示续接，不把一条消息劈成两截）
          return appendStreamText(prev, ev.text);
        case 'tool_start': {
          const item: Extract<DisplayItem, { kind: 'tool' }> = {
            kind: 'tool',
            id: ev.id,
            name: ev.name,
            input: ev.input,
            status: 'running',
            startedAt: Date.now(),
          };
          // workflow 工具：从 input.steps 装配步骤面板初始状态（全部 pending）
          if (ev.name === 'workflow') {
            const wf = parseWorkflowInput(ev.input);
            if (wf !== null) item.workflow = wf;
          }
          next.push(item);
          // 工具调用的 JSON 参数也是模型 output 的一部分（服务端计入 output_tokens），
          // 计入本轮产出估算，避免「调工具为主的回合」spinner token 数接近 0。
          turnOutputCharsRef.current += JSON.stringify(ev.input ?? {}).length;
          setTurnOutputChars(turnOutputCharsRef.current);
          break;
        }
        case 'tool_end':
          for (let i = next.length - 1; i >= 0; i--) {
            const it = next[i]!;
            if (it.kind === 'tool' && it.id === ev.id) {
              next[i] = { ...it, status: ev.isError ? 'error' : 'ok', result: ev.result };
              break;
            }
          }
          // todo_list 改了 todos.current（ref），触发 TodoPanel 重渲
          if (ev.name === 'todo_list') setTodoTick((t) => t + 1);
          break;
        case 'retry':
          // agent 流事件：构成消息边界（重试后正文另开条目，不得续接到失败尝试上）
          next.push({ kind: 'note', text: ev.message, boundary: true });
          break;
        case 'notice':
          // agent 流事件：构成消息边界（压缩/溢出等通知后的正文属于新一轮消息）
          next.push({ kind: 'note', text: ev.message, boundary: true });
          break;
        case 'usage':
          // 记录此真实/估算值覆盖的 history 前缀长度与基准 token：真实 usage 带 messages.length，
          // 压缩估算带压缩后全长；省略时退化为当前长度（尾部为空）。随后重算显示值 = 基准 + 尾部估算。
          baseTokensRef.current = ev.totalTokens;
          measuredLenRef.current = ev.measuredLength ?? history.current.length;
          refreshContextUsage();
          break;
        case 'aborted':
          // 中止终结当前消息尝试：构成边界，后续回合正文不得续接到残文上
          next.push({
            kind: 'note',
            text:
              queue.current.length > 0
                ? t('app.aborted.resumeQueue', { count: queue.current.length })
                : t('app.aborted.plain'),
            boundary: true,
          });
          break;
        case 'error':
          next.push({ kind: 'error', text: ev.message });
          // 错误后另起一行提示可导出调试包，仅当有活动 session 时追加。
          if (sessionRef.current !== undefined) {
            next.push({ kind: 'note', text: t('app.error.exportHint') });
          }
          break;
        case 'turn_done':
          break;
      }
      return next;
    });
  }, []);

  const buildHooks = useCallback(
    (): LoopHooks & { resetStopContinuation?: () => void } => {
      const base: LoopHooks = {
      authorizeToolCall: async (req) => {
        // plan 模式守卫：写/执行一律拒（exit_plan_mode 例外，走下方确认）
        if (planModeRef.current && req.name !== 'exit_plan_mode') {
          const deny = planModeDenyReason(req.name);
          if (deny !== null) return { decision: 'deny', reason: deny };
        }
        // exit_plan_mode：展示计划请用户确认，批准后退出 plan
        if (req.name === 'exit_plan_mode') {
          const plan =
            typeof (req.input as { plan?: unknown })?.plan === 'string'
              ? ((req.input as { plan: string }).plan)
              : '';
          const approved = await askPlanApproval(plan);
          if (approved) {
            const restore = prePlanModeRef.current ?? modeRef.current;
            prePlanModeRef.current = null;
            setPlanModeBoth(false);
            changeMode(restore);
            return { decision: 'allow' };
          }
          return {
            decision: 'deny',
            reason: '用户拒绝了该计划。请根据反馈修订计划后再次用 exit_plan_mode 提交，或向用户询问如何调整。',
          };
        }
        const d = decide(req.name, modeRef.current, sessionApprovals.current);
        if (d === 'allow') return { decision: 'allow' };
        const r = await askApproval({ name: req.name, input: req.input });
        return r.allow ? { decision: 'allow' } : { decision: 'deny', reason: denyReason(r.feedback) };
      },
      // goal 续跑：active goal 且未超预算时，end_turn 后自动继续下一轮（模型自报停机则停）
      shouldContinueAfterStop: () => {
        const g = goal.current.get();
        if (g === null || g.status !== 'active') return false;
        // 硬停：轮次或 token 任一预算超限 → markBlocked（文案区分哪种预算耗尽）
        const hit = goal.current.exceededBudget();
        if (hit !== null) {
          goal.current.update('blocked', t(hit === 'turns' ? 'goal.blocked.turns' : 'goal.blocked.tokens'));
          pushItem({ kind: 'note', text: t(hit === 'turns' ? 'app.goal.overBudgetTurns' : 'app.goal.overBudgetTokens') });
          return false;
        }
        goal.current.incrementTurn();
        return true;
      },
      };
      // 用户 hooks 叠加在既有 LoopHooks 之上（接口不动）：PreToolUse 链首 deny-only、
      // PostToolUse fire-and-forget、Stop exit 2 时 reason 注入让模型继续（一次性防循环标志）
      if (hookEngine === undefined) return base;
      return composeLoopHooks(hookEngine, base, {
        onStopContinue: (reason) => {
          history.current.push(stored({ role: 'user', content: reason }, 'user'));
        },
      });
    },
    [askApproval, askPlanApproval, changeMode, hookEngine, setPlanModeBoth],
  );

  /**
   * 按别名/模型 id 切换模型：先查 [models.<别名>]，命中则按合并配置重建 provider
   * （同 /provider 的写法）；未命中按原始模型 id 处理（只改 model 覆盖参数，不动 provider）。
   * /model <别名> 文本直切与模型选择器 Enter 确认共用此路径。
   */
  const applyModelAlias = useCallback(
    (arg: string): void => {
      const resolved = resolveModelEntry(config, arg);
      if (resolved === null) {
        setModel(arg);
        modelRef.current = arg;
        setModelLabel(arg);
        sessionRef.current.model = arg;
        persist();
        pushItem({ kind: 'note', text: t('app.model.switched', { model: arg }) });
        return;
      }
      try {
        providerRef.current = createProvider(resolved);
      } catch (e) {
        pushItem({ kind: 'error', text: t('app.model.switchFailed', { message: (e as Error).message }) });
        return;
      }
      providerNameRef.current = resolved.provider;
      setModel(resolved.model);
      modelRef.current = resolved.model;
      setModelLabel(config.models?.[arg]?.displayName ?? resolved.model);
      setMaxContextSize(resolved.maxContextSize);
      // 模型是会话级状态：切换即落盘（写会话 model 字段），恢复会话时读回并重建 provider
      sessionRef.current.model = resolved.model;
      persist();
      pushItem({ kind: 'note', text: t('app.model.aliasSwitched', { name: arg, model: resolved.model }) });
    },
    [config, persist, pushItem],
  );

  /**
   * 按 id 恢复会话（/resume <id> 文本直切与 SessionPicker Enter 确认共用此路径）：
   * 先落盘当前会话防丢数据，再独立拷贝目标会话的 messages/todos，读回 goal/mode/model 快照并重建 provider，
   * 清动态工具与计划态，重放历史进 items 并递增 sessionEpoch 重挂 Static。
   * 找到并恢复返回 true；快照不存在返回 false（供命令路径打印 notFound 提示）。
   */
  const resumeSessionById = useCallback(
    (id: string): boolean => {
      const data = store.load(ctx.cwd, id);
      if (data === null) return false;
      // 先保存当前会话，避免切走丢数据
      persist();
      // 独立拷贝，别和 store 里的数组共享
      history.current = data.messages.map((m) => ({ ...m }));
      todos.current = data.todos !== undefined ? [...data.todos] : [];
      imageStore.current.clear();
      sessionRef.current = data;
      // 恢复该会话的 goal 快照（active 降级 paused，防 resume 后自动续跑）
      goal.current.restore(data.goal);
      setGoalView(goal.current.get() !== null ? { ...goal.current.get()! } : null);
      subagentCounter.current.spawned = 0;
      sessionApprovals.current.clear();
      // 恢复会话级 permission mode（旧快照无 mode 时保持当前，不强制回退）
      if (data.mode !== undefined) changeMode(data.mode);
      // 恢复会话级模型：按存储的 model 重建 provider（applyModelAlias 内含 setModel + createProvider + 落盘）。
      // model 存的是解析后的真实 id，用它反查别名；找不到别名则按 id 直切。
      if (data.model !== '' && data.model !== modelRef.current) {
        const alias = Object.keys(config.models ?? {}).find(
          (a) => (config.models?.[a]?.model ?? a) === data.model,
        );
        applyModelAlias(alias ?? data.model);
      }
      // 清空动态工具，避免上个会话 tool_search 加载的工具泄漏到恢复的会话
      clearDynamicTools();
      setPlanModeBoth(false);
      prePlanModeRef.current = null;
      // 思考深度覆盖是会话级状态：恢复到别的会话时回落 config 默认
      setThinkOverride(undefined);
      // resume 无真实 usage：前缀基准归零、游标归零，对恢复的全部历史做字符估算填充状态栏
      // （否则会误显 0，直到用户发出第一条消息拿到真实 usage 才刷新）。下一条真实 usage 再校正。
      baseTokensRef.current = 0;
      measuredLenRef.current = 0;
      refreshContextUsage();
      {
        const replay = historyToDisplayItems(data.messages);
        const switchedNote: DisplayItem = {
          kind: 'note',
          text: t('app.resume.switched', {
            id: data.id,
            turns: replay.totalTurns,
            count: history.current.length,
          }),
        };
        const nextItems: DisplayItem[] = [];
        if (replay.foldedTurns > 0) {
          nextItems.push({
            kind: 'note',
            text: t('app.replay.folded', { folded: replay.foldedTurns, total: replay.totalTurns }),
          });
        }
        nextItems.push(...replay.items, switchedNote);
        setItems(nextItems);
      }
      setSessionEpoch((e) => e + 1);
      return true;
    },
    [applyModelAlias, changeMode, config, ctx.cwd, persist, pushItem, setPlanModeBoth],
  );

  /**
   * 会话级思考深度切换（/think <档位|off> 文本直切与 ThinkPicker Enter 确认共用此路径）：
   * 即时生效（下一轮请求经 runAgent 的 thinking 参数透传），不重建会话、不动 provider；
   * 会话已有历史时追加 prompt cache 失效提示（对齐 /model 的措辞意图）。
   * name 必为合法档位名或 'off'（文本路径已经 parseThinkArgs 校验，弹层由 items 装配保证）。
   */
  const applyThinkLevel = useCallback(
    (name: string): void => {
      setThinkOverride(name);
      const levels = thinkLevelsOf(config.thinking);
      pushItem({
        kind: 'note',
        text: t('app.think.switched', {
          level: name,
          detail: name === 'off' ? t('thinkPicker.offDetail') : t('thinkPicker.budget', { budget: levels[name] ?? 0 }),
        }),
      });
      // 余量防线：切到的档位在当前 max_tokens 下正文余量不足时给 warning（不硬拦，尊重用户）。
      // 运行时切档不走 config 解析期校验，这里是唯一拦截点；不提示的话会静默发出→空响应。
      const safety = thinkBudgetSafety(name, levels, config.maxTokens);
      if (!safety.safe) {
        pushItem({
          kind: 'note',
          text: t('app.think.budgetWarning', { budget: safety.budget, maxTokens: config.maxTokens }),
        });
      }
      if (history.current.length > 0) {
        pushItem({ kind: 'note', text: t('app.think.cacheWarning') });
      }
    },
    [config, pushItem],
  );

  /** 处理斜杠命令。返回 true 表示已作为命令消费。 */
  const handleSlash = useCallback(
    (raw: string): boolean => {
      const parsed = parseSlash(raw, pluginCommandNames);
      if (parsed === null) return false;
      const { name, args } = parsed;
      switch (name) {
        case 'help':
          pushItem({ kind: 'note', text: helpText() });
          break;
        case 'model': {
          const arg = args.trim();
          if (arg === '') {
            const aliases = Object.keys(config.models ?? {});
            if (aliases.length === 0) {
              pushItem({ kind: 'note', text: t('app.model.current', { model }) });
              break;
            }
            // busy/streaming 中拒绝切换（选择器只有在空闲时才允许打开）
            if (busyRef.current) {
              pushItem({ kind: 'note', text: t('app.model.busy') });
              break;
            }
            // 无参唤起交互式模型选择器（替换输入区）；确认走 onSelect → applyModelAlias，取消仅关闭
            setModelPickerOpen(true);
            break;
          }
          applyModelAlias(arg);
          break;
        }
        case 'think': {
          const levels = thinkLevelsOf(config.thinking);
          // 门控：非 anthropic 协议或未允许发送 thinking 字段时不可用（只提示，不切换）
          if (!thinkingAvailable(providerNameRef.current, config.thinking)) {
            pushItem({ kind: 'note', text: t('app.think.unavailable') });
            break;
          }
          const result = parseThinkArgs(args, levels);
          if (result.kind === 'invalid') {
            pushItem({
              kind: 'note',
              text: t('app.think.invalid', { name: result.name, list: [...Object.keys(levels), 'off'].join(' / ') }),
            });
            break;
          }
          if (result.kind === 'set') {
            applyThinkLevel(result.override);
            break;
          }
          // 无参：busy 中退化为文本展示（只读，busy 时经 busyRoute 即时分发到此处）；空闲唤起选择器
          if (busyRef.current) {
            const current =
              thinkOverride === 'off'
                ? 'off'
                : thinkOverride !== undefined
                  ? `${thinkOverride} (${t('thinkPicker.budget', { budget: levels[thinkOverride] ?? 0 })})`
                  : t('app.think.followDefault');
            const lines = Object.entries(levels)
              .map(([n, b]) => t('app.think.levelLine', { name: n, budget: b }))
              .join('\n');
            pushItem({
              kind: 'note',
              text: t('app.think.status', {
                current,
                defaultLevel: config.thinking?.defaultLevel ?? t('app.think.noDefault'),
                lines,
              }),
            });
            break;
          }
          setThinkPickerOpen(true);
          break;
        }
        case 'lang': {
          const arg = args.trim().toLowerCase();
          if (arg === '') {
            pushItem({ kind: 'note', text: t('lang.current', { lang: getLocale() }) });
            break;
          }
          if (arg === 'zh' || arg === 'en') {
            const next: Locale = arg;
            setLocale(next);
            setLang(next); // 触发整树重渲，各组件重新取文案
            try {
              saveLanguage(next);
            } catch {
              // 持久化失败只影响下次启动的默认语言，本次切换仍生效
            }
            pushItem({ kind: 'note', text: t('lang.switched', { lang: next }) });
          } else {
            pushItem({ kind: 'note', text: t('lang.usage') });
          }
          break;
        }
        case 'mcp': {
          // 只读状态面板：manager 未注入（理论上不会发生）时按无配置处理
          pushItem({ kind: 'note', text: mcp !== undefined ? formatMcpStatus(mcp) : t('app.mcp.none', { path: '~/.step-code/mcp.json' }) });
          break;
        }
        case 'provider': {
          const arg = args.trim().toLowerCase();
          const available = Object.keys(PROVIDER_PRESETS).join(' / ');
          if (arg === '') {
            pushItem({ kind: 'note', text: t('app.provider.current', { provider: config.provider, list: available }) });
            break;
          }
          const preset = PROVIDER_PRESETS[arg];
          if (preset === undefined) {
            pushItem({ kind: 'note', text: t('app.provider.unknown', { provider: arg, list: available }) });
            break;
          }
          const nextModel = preset.model ?? model;
          try {
            providerRef.current = createProvider({
              ...config,
              provider: arg,
              baseUrl: preset.baseUrl ?? config.baseUrl,
              model: nextModel,
            });
          } catch (e) {
            pushItem({ kind: 'error', text: t('app.provider.switchFailed', { message: (e as Error).message }) });
            break;
          }
          providerNameRef.current = arg;
          setModel(nextModel);
          const modelNote =
            preset.model !== undefined
              ? t('app.provider.presetModel', { model: nextModel })
              : t('app.provider.noPresetModel');
          pushItem({ kind: 'note', text: t('app.provider.switched', { provider: arg, modelNote }) });
          break;
        }
        case 'permission': {
          const arg = args.trim();
          if (arg === 'manual' || arg === 'auto' || arg === 'yolo') {
            changeMode(arg);
            pushItem({ kind: 'note', text: t('app.permission.switched', { mode: arg }) });
          } else {
            pushItem({ kind: 'note', text: t('app.permission.current', { mode: modeRef.current }) });
          }
          break;
        }
        case 'yolo':
          changeMode('yolo');
          pushItem({ kind: 'note', text: t('app.permission.yolo') });
          break;
        case 'auto':
          changeMode('auto');
          pushItem({ kind: 'note', text: t('app.permission.auto') });
          break;
        case 'plan': {
          if (planModeRef.current) {
            setPlanModeBoth(false);
            pushItem({ kind: 'note', text: t('app.plan.off') });
          } else {
            prePlanModeRef.current = modeRef.current;
            setPlanModeBoth(true);
            pushItem({ kind: 'note', text: t('app.plan.on') });
          }
          break;
        }
        case 'goal': {
          const sub = args.trim().toLowerCase();
          const g = goal.current.get();
          // 查看：无参或 status，出圆角面板（快照数据随条目冻结，不回查 GoalMode）
          if (sub === '' || sub === 'status') {
            if (g === null) {
              pushItem({ kind: 'note', text: t('app.goal.none') });
            } else {
              pushItem({
                kind: 'goalPanel',
                data: {
                  objective: g.objective,
                  completionCriterion: g.completionCriterion,
                  status: g.status,
                  turnsUsed: g.turnsUsed,
                  turnBudget: g.turnBudget,
                  tokensUsed: g.tokensUsed,
                  tokenBudget: g.tokenBudget,
                  terminalReason: g.terminalReason,
                  elapsedMs: Date.now() - g.createdAt,
                },
              });
            }
            break;
          }
          // 用户侧状态控制（/goal pause|resume|cancel）；生命周期 marker 由 onChange 统一打
          if (sub === 'pause' || sub === 'resume' || sub === 'cancel') {
            if (g === null) {
              pushItem({ kind: 'note', text: t('app.goal.none') });
              break;
            }
            try {
              if (sub === 'pause') goal.current.update('paused');
              else if (sub === 'resume') goal.current.update('active');
              else goal.current.update('complete', t('goal.cancelReason'));
            } catch (e) {
              pushItem({ kind: 'error', text: (e as Error).message });
            }
            break;
          }
          pushItem({ kind: 'note', text: t('app.goal.usage') });
          break;
        }
        case 'loop': {
          const jobs = cron.current?.list() ?? [];
          if (jobs.length === 0) {
            pushItem({ kind: 'note', text: t('app.loop.none') });
          } else {
            const lines = jobs
              .map((j) =>
                t('app.loop.jobLine', {
                  id: j.id,
                  cron: j.cron,
                  oneShot: j.recurring ? '' : t('app.loop.oneShot'),
                  next: j.nextFireAt.toLocaleString(),
                }),
              )
              .join('\n');
            pushItem({ kind: 'note', text: t('app.loop.list', { lines }) });
          }
          break;
        }
        case 'fork': {
          if (busyRef.current) {
            pushItem({ kind: 'note', text: t('app.fork.busy') });
            break;
          }
          // 从当前最新点整会话复制：新 id + forkedFrom 记谱系，源会话不动
          const src = sessionRef.current;
          const forked = store.create(ctx.cwd, model);
          forked.forkedFrom = src.id;
          // 断开引用：新会话的 history/todos 用独立拷贝，避免与源会话共享同一数组
          history.current = history.current.map((m) => ({ ...m }));
          todos.current = [...todos.current];
          forked.messages = history.current;
          forked.todos = todos.current;
          sessionRef.current = forked;
          // fork 不继承 goal：清掉内存态与徽标（源会话的 goal 字段已在盘上，不受影响）
          goal.current.restore(null);
          setGoalView(null);
          pushItem({
            kind: 'note',
            text: t('app.fork.done', {
              from: src.id,
              to: forked.id,
              messages: history.current.length,
              todos: todos.current.length,
            }),
          });
          persist();
          break;
        }
        case 'new': {
          history.current = [];
          subagentCounter.current.spawned = 0;
          todos.current = [];
          imageStore.current.clear();
          sessionRef.current = store.create(ctx.cwd, model);
          sessionApprovals.current.clear();
          // 新会话不继承上一会话的 goal（goal 随会话持久化，新会话从头开始）
          goal.current.restore(null);
          setGoalView(null);
          // 清空动态工具，避免上个会话 tool_search 加载的工具泄漏到新会话
          clearDynamicTools();
          setPlanModeBoth(false);
          prePlanModeRef.current = null;
          // 思考深度覆盖是会话级状态：新会话回落 config 默认（/fork 复制会话，保留覆盖）
          setThinkOverride(undefined);
          setItems([{ kind: 'note', text: t('app.new.started', { id: sessionRef.current.id }) }]);
          setSessionEpoch((e) => e + 1);
          break;
        }
        case 'compact': {
          if (busyRef.current) break;
          const before = estimateTokens(history.current);
          busyRef.current = true;
          setBusy(true);
          pushItem({ kind: 'note', text: t('app.compact.running') });
          void (async () => {
            try {
              history.current = await fullCompact(
                providerRef.current,
                history.current,
                6,
                todos.current,
                compaction.model,
                {
                  maxTokens: compaction.userMessageMaxTokens,
                  headTokens: compaction.userMessageHeadTokens,
                },
              );
              const after = estimateTokens(history.current);
              // 状态栏 context 用量立即回落（否则要等下一条消息的 usage 事件才刷新，看起来像没压）。
              // after 是压缩后全量估算，覆盖当前所有消息：基准设为 after、游标设为全长，
              // 尾部为空、不再叠加估算（基准必须一起更新，否则后续重算会用回压缩前的旧真实 usage）。
              baseTokensRef.current = after;
              measuredLenRef.current = history.current.length;
              refreshContextUsage();
              pushItem({ kind: 'note', text: t('app.compact.done', { before, after }) });
              persist();
            } catch (e) {
              pushItem({ kind: 'error', text: t('app.compact.failed', { message: (e as Error).message }) });
            } finally {
              setBusy(false);
              busyRef.current = false;
            }
          })();
          break;
        }
        case 'reflect': {
          if (busyRef.current) break;
          busyRef.current = true;
          setBusy(true);
          pushItem({ kind: 'note', text: t('app.reflect.running') });
          void (async () => {
            try {
              // 优先读不受压缩触碰的全量日志；旧会话/未落盘时回退到内存历史
              const full = store.loadFull(sessionRef.current.cwd, sessionRef.current.id);
              const source = full.length > 0 ? full : history.current;
              const text = await runReflect(providerRef.current, source, {});
              pushItem({ kind: 'note', text: t('app.reflect.done', { count: source.length, text }) });
            } catch (e) {
              pushItem({ kind: 'error', text: t('app.reflect.failed', { message: (e as Error).message }) });
            } finally {
              setBusy(false);
              busyRef.current = false;
            }
          })();
          break;
        }
        case 'export-debug-zip': {
          if (busyRef.current) {
            pushItem({ kind: 'note', text: t('app.export.busy') });
            break;
          }
          busyRef.current = true;
          setBusy(true);
          pushItem({ kind: 'note', text: t('app.export.running') });
          void (async () => {
            try {
              const { zipPath, files } = await exportDebugBundle({
                store,
                cwd: sessionRef.current.cwd,
                sessionId: sessionRef.current.id,
                model,
              });
              pushItem({
                kind: 'note',
                text: t('app.export.done', {
                  path: zipPath,
                  files: files.join('、'),
                  warning: t('app.export.warning'),
                }),
              });
            } catch (e) {
              pushItem({ kind: 'error', text: t('app.export.failed', { message: (e as Error).message }) });
            } finally {
              setBusy(false);
              busyRef.current = false;
            }
          })();
          break;
        }
        case 'resume': {
          const metas = store.list(ctx.cwd);
          if (metas.length === 0) {
            pushItem({ kind: 'note', text: t('app.sessions.none') });
          } else {
            setSessionPickerItems(metas);
            setSessionPickerOpen(true);
          }
          break;
        }
        case 'skill': {
          const skills = skillsRef.current;
          const trimmed = args.trim();
          const names = skills !== undefined ? [...skills.skills.keys()] : [];
          // 无参：列出可用技能（只读，busy 时即时）
          if (trimmed === '') {
            pushItem({
              kind: 'note',
              text: names.length > 0 ? t('app.skill.list', { names: names.join('、') }) : t('app.skill.none'),
            });
            break;
          }
          // 保留子命令：reload 强制全量重扫 skill 目录（优先于同名 skill 激活）
          if (trimmed === 'reload' || trimmed.startsWith('reload ') || trimmed.startsWith('reload\t')) {
            const diff = reloadSkills(true);
            if (diff === null || (diff.added.length + diff.removed.length + diff.changed.length) === 0) {
              pushItem({ kind: 'note', text: t('app.skill.reload.none') });
            } else {
              pushItem({
                kind: 'note',
                text: t('app.skill.reload.done', {
                  added: diff.added.length > 0 ? diff.added.join('、') : '—',
                  removed: diff.removed.length > 0 ? diff.removed.join('、') : '—',
                  changed: diff.changed.length > 0 ? diff.changed.join('、') : '—',
                }),
              });
            }
            const conflictNote = skillConflictNote();
            if (conflictNote !== null) pushItem({ kind: 'note', text: conflictNote });
            break;
          }
          // 带参：<name> [args]，命中则像模型激活一样把正文注入会话跑一轮
          const spaceIdx = trimmed.search(/\s/);
          const skillName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
          const skillArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
          const def = skills?.skills.get(skillName);
          if (def === undefined) {
            pushItem({
              kind: 'note',
              text: t('app.skill.unknown', {
                name: skillName,
                names: names.length > 0 ? names.join('、') : t('app.skill.noneShort'),
              }),
            });
            break;
          }
          pushItem({ kind: 'note', text: t('app.skill.activated', { name: def.name }) });
          // 静默注入展开后的技能正文（不显示 user 条目、不记输入历史），触发模型理解执行
          skillInjectRef.current?.(renderSkillActivation(def, skillArgs));
          break;
        }
        case 'exit':
          exit();
          break;
        case 'plugin':
          // 管理命令：子命令分发在 pluginCommand.ts，返回展示文本（变更提示 /new 或重启生效）
          pushItem({ kind: 'note', text: runPluginCommand(args) });
          break;
        case '':
          pushItem({ kind: 'note', text: t('app.unknownCommand', { command: raw.trim() }) });
          break;
        default: {
          // plugin 命令（<pluginId>:<commandName>）：模板展开 $ARGUMENTS 后作为 user 消息静默提交（同 /skill 激活路径）
          const cmd = pluginCommandMap.get(name);
          if (cmd === undefined) {
            pushItem({ kind: 'note', text: t('app.unknownCommand', { command: raw.trim() }) });
            break;
          }
          pushItem({ kind: 'note', text: t('app.plugin.command.invoked', { name: cmd.name }) });
          skillInjectRef.current?.(expandPluginCommand(cmd.content, args));
          break;
        }
      }
      return true;
    },
    [applyModelAlias, applyThinkLevel, changeMode, compaction, config, ctx.cwd, exit, mcp, model, persist, pluginCommandMap, pluginCommandNames, pushItem, reloadSkills, setPlanModeBoth, skillConflictNote, skillsRef, store, thinkOverride],
  );

  const submit = useCallback(
    async (raw: string, opts?: { recordHistory?: boolean; silent?: boolean }) => {
      const text = raw.trim();
      const extracted = extractImageContent(text, imageStore.current);
      const imgCount = extracted.imageCount;
      // 有图片时允许空文本发送；纯空且无图才忽略
      if (extracted.displayText === '' && imgCount === 0) return;
      // 记录输入历史（非空 text，含斜杠命令与 busy 入队消息，在分发前记录；相邻去重）
      // 后台通知等合成消息不记（recordHistory === false），避免污染输入历史
      if (opts?.recordHistory !== false && text !== '' && inputHistoryStore.current.record(text)) {
        setInputHistory(inputHistoryStore.current.entries.slice());
      }
      // 发送缓冲队列：busy 时入队（FIFO），回合结束自动逐条发送
      if (busyRef.current) {
        if (text === '') return; // 图片输入 busy 时暂不入队（简化）
        // busy 时斜杠命令先解析分流：只读/纯 UI 命令（/help /goal /loop /sessions /lang 及无参查询）即时执行，
        // 改动 turn 前提的命令（/model /compact /new 等）与普通消息一样入队
        if (imgCount === 0) {
          const parsed = parseSlash(text, pluginCommandNames);
          if (parsed !== null && busyRoute(parsed.name, parsed.args) === 'instant') {
            setInput('');
            handleSlash(text);
            return;
          }
        }
        queue.current.push(text);
        setQueueLen(queue.current.length);
        setInput('');
        pushItem({ kind: 'note', text: t('app.queue.added', { index: queue.current.length, text }) });
        return;
      }
      if (pendingRef.current !== null || pendingPlanRef.current !== null || pendingQuestionRef.current !== null) return;
      setInput('');
      // 斜杠命令仅在无图片、纯命令时走命令分支；静默注入（cron/后台通知）不解析斜杠，防定时 prompt 被当成命令截获
      if (!opts?.silent && imgCount === 0 && handleSlash(text)) return;

      // UserPromptSubmit hook：stdout 非空作为上下文注入本轮；exit 2 阻断本轮不发模型（输入退回输入框）
      if (hookEngine !== undefined && !opts?.silent) {
        const up = await hookEngine.run('UserPromptSubmit', { prompt: text });
        if (up.blocked) {
          setInput(text);
          return;
        }
        if (up.stdout !== '') {
          history.current.push(stored({ role: 'user', content: up.stdout }, 'user'));
        }
      }

      const imgNote = imgCount > 0 ? t('app.user.withImages', { count: imgCount }) : '';
      // 静默注入（cron 触发等合成消息）不在转录区显示 user 条目——cron 场景由触发卡片承载展示
      if (!opts?.silent) setItems((prev) => [...prev, { kind: 'user', text: `${extracted.displayText}${imgNote}` }]);
      history.current.push(stored({ role: 'user', content: extracted.content }, 'user'));
      imageStore.current.clear();
      // 新 append 的这条还没经历 API 往返：立刻把它计入未测量尾部估算，
      // 让状态栏在发出请求前就反映新增内容（贴长文本时数字随之变化，不再纹丝不动）。
      refreshContextUsage();

      // turn 边界 skill 指纹检测：目录有变更时静默全量重扫并提示（零成本：指纹未变直接跳过）
      const skillDiff = reloadSkills(false);
      if (skillDiff !== null && (skillDiff.added.length + skillDiff.removed.length + skillDiff.changed.length) > 0) {
        pushItem({
          kind: 'note',
          text: t('app.skill.autoReload', {
            added: skillDiff.added.length > 0 ? skillDiff.added.join('、') : '—',
            removed: skillDiff.removed.length > 0 ? skillDiff.removed.join('、') : '—',
            changed: skillDiff.changed.length > 0 ? skillDiff.changed.join('、') : '—',
          }),
        });
        const conflictNote = skillConflictNote();
        if (conflictNote !== null) pushItem({ kind: 'note', text: conflictNote });
      }

      setBusy(true);
      busyRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      const hooks = buildHooks();
      // Stop hook 的一次性续行标志按轮复位（每轮提交只给一次续行机会，防死循环）
      hooks.resetStopContinuation?.();
      const runSubagent = createSubagentRunner({
        provider: providerRef.current,
        cwd: ctx.cwd,
        apiKey: ctx.apiKey,
        baseUrl: ctx.baseUrl,
        hooks,
        maxDepth: subagent.maxDepth,
        maxPerSession: subagent.maxPerSession,
        maxStepsDefault: subagent.maxSteps,
        compaction: {
          maxContextSize,
          triggerRatio: compaction.triggerRatio,
          reservedTokens: compaction.reservedTokens,
        },
        compactionModel: compaction.model,
        userMessageBudget: {
          maxTokens: compaction.userMessageMaxTokens,
          headTokens: compaction.userMessageHeadTokens,
        },
        sessionCounter: subagentCounter.current,
        skills: skillsRef.current, // 子 agent 共享 skill（取当前注册表，支持 reload 后即时生效）
        onEvent: (id, ev) => {
          // 按 id 路由子 agent 进度事件（start 建条目 / tool 计数 / end 标完成）
          const sid = id ?? 'main';
          // wf- 前缀 = workflow 步骤派生的子 agent：归进步骤面板对应步骤，不进 AgentGroup
          const wfRef = parseWfSid(sid);
          if (wfRef !== null) {
            const toolId = activeWorkflowRef.current[activeWorkflowRef.current.length - 1];
            if (toolId === undefined) return;
            setItems((prev) =>
              prev.map((it) =>
                it.kind === 'tool' && it.id === toolId && it.workflow !== undefined
                  ? { ...it, workflow: applySubagentEvent(it.workflow, wfRef, sid, ev) }
                  : it,
              ),
            );
            return;
          }
          setSubagents((prev) => {
            const updated = [...prev];
            if (ev.kind === 'start') {
              updated.push({ id: sid, type: ev.subagentType, description: ev.description, status: 'running', toolCount: 0 });
              return updated;
            }
            const idx = updated.findIndex((a) => a.id === sid);
            if (idx === -1) return prev;
            const a = updated[idx]!;
            if (ev.kind === 'tool') {
              updated[idx] = { ...a, toolCount: a.toolCount + 1, activity: ev.name };
            } else if (ev.kind === 'error') {
              updated[idx] = { ...a, activity: t('app.agent.activityError', { message: ev.message }) };
            } else if (ev.kind === 'end') {
              updated[idx] = { ...a, status: ev.isError ? 'error' : 'done' };
            }
            return updated;
          });
        },
      });
      // system 按当前 skill 注册表逐轮组合：systemPrefix + skill 清单 + AGENTS.md 尾部（reload 后下一轮即生效）
      const systemNow = systemPrefix + skillListing(skillsRef.current) + (agentsMd !== '' ? `\n\n${agentsMd}` : '');
      try {
        for await (const ev of runAgent({
          provider: providerRef.current,
          // SessionStart hook 注入的上下文拼在 system 尾部（注入前为空串则原样）
          system: sessionContextRef.current !== '' ? `${systemNow}\n\n${sessionContextRef.current}` : systemNow,
          ctx: {
            ...ctx,
            skills: skillsRef.current, // 覆盖启动快照，取当前注册表
            signal: controller.signal,
            depth: 0,
            runSubagent,
            // 单轮 skill 激活计数器（递归防护，每次提交新建 → 单次 runAgent 内累计）
            skillActivations: { count: 0 },
            todos: { items: todos.current },
            background: background.current,
            goal: goal.current,
            cron: cron.current ?? undefined,
            askUser: askUserQuestion,
            subagentMaxConcurrent: subagent.maxConcurrent,
            // workflow 步骤进度：推进最近一个运行中的 workflow 工具条目的步骤面板
            onWorkflowStep: (info) => {
              const toolId = activeWorkflowRef.current[activeWorkflowRef.current.length - 1];
              if (toolId === undefined) return;
              setItems((prev) =>
                prev.map((it) =>
                  it.kind === 'tool' && it.id === toolId && it.workflow !== undefined
                    ? { ...it, workflow: applyStepEvent(it.workflow, info) }
                    : it,
                ),
              );
            },
          },
          messages: history.current,
          signal: controller.signal,
          hooks,
          model,
          // 会话级思考深度覆盖（/think）：undefined 跟随构造默认，'off' → null 抑制，档位 → budget 覆盖
          thinking: thinkStreamParam(thinkOverride, thinkLevelsOf(config.thinking)),
          compaction: {
            maxContextSize,
            triggerRatio: compaction.triggerRatio,
            reservedTokens: compaction.reservedTokens,
          },
          compactionModel: compaction.model,
          userMessageBudget: {
            maxTokens: compaction.userMessageMaxTokens,
            headTokens: compaction.userMessageHeadTokens,
          },
          todos: todos.current,
          // 后台任务终态通知：busy 中在 runAgent 每个回合边界 flush 进 messages（不等循环结束）
          injectBackgroundNotifications: true,
        })) {
          applyEvent(ev);
        }
      } catch (e) {
        applyEvent({ type: 'error', message: (e as Error).message });
      } finally {
        abortRef.current = null;
        setBusy(false);
        busyRef.current = false;
        // 任务清单全部完成：回合收尾即清空（面板不常驻）；有未完成项则跨回合保留
        if (allTodosDone(todos.current)) {
          todos.current = [];
        }
        persist();
        // 循环内未来得及边界 flush 的残余终态通知（最后一回合内才终态）：补进发送队列随队列自动发
        for (const t of background.current.drainSettled()) {
          const note = formatSettleNotification(t);
          notifyTextRef.current.add(note);
          queue.current.push(note);
        }
        // 发送缓冲队列：回合结束后自动按序发送下一条
        const next = queue.current.shift();
        setQueueLen(queue.current.length);
        if (next !== undefined) {
          // 通知条目不记输入历史（notifyTextRef 标记，发出即摘除）
          const isNotify = notifyTextRef.current.delete(next);
          void submit(next, isNotify ? { recordHistory: false } : undefined);
        } else {
          // 兜底：全终态的面板已由上方 effect 冻结摘要后撤下；这里清的是中断等非常规收尾的残留
          setSubagents([]);
        }
      }
    },
    [agentsMd, applyEvent, askUserQuestion, buildHooks, compaction, ctx, handleSlash, hookEngine, maxContextSize, model, persist, pluginCommandNames, pushItem, reloadSkills, skillConflictNote, skillsRef, subagent, systemPrefix, thinkOverride],
  );

  // cron 触发时把 prompt 静默注入跑一轮（不记输入历史、不显示 user 条目，转录区只留触发卡片）
  cronFireRef.current = (prompt: string) => {
    void submit(prompt, { recordHistory: false, silent: true });
  };

  // /skill 激活：把展开后的技能正文静默注入跑一轮（同 cron，经 submit 复用回合机制，避免循环依赖）
  skillInjectRef.current = (text: string) => {
    void submit(text, { recordHistory: false, silent: true });
  };

  // 后台任务终态：busy 时通知留在管理器待投递队列，由 runAgent 在回合边界 flush 进 messages
  // （模型下一回合即可见，不等整个循环结束）；空闲时直接取出提交触发新回合。
  // notifyOnComplete === false 时只提示不注入（丢弃待投递队列，防回合边界 flush 又注入）。
  settleHandlerRef.current = (task: BackgroundTask) => {
    setBgTick((x) => x + 1);
    pushItem({
      kind: 'note',
      text: t('background.settled', {
        id: task.id,
        status: t(`background.status.${task.status}`),
        command: task.command,
      }),
    });
    // 终端通知（铃响/桌面通知）：独立于 notifyOnComplete，用户切走终端也能感知。
    if (config.background?.notifyTerminal !== false) {
      const statusLabel = t(`background.status.${task.status}`);
      emitTerminalNotification(`后台任务 ${task.id} ${statusLabel}：${task.command}`);
    }
    if (config.background?.notifyOnComplete === false) {
      background.current.drainSettled();
      return;
    }
    if (decideNotifyRoute(busyRef.current) === 'submit') {
      // 空闲：取出全部待投递通知，各自独立提交（多条不合并）
      for (const t of background.current.drainSettled()) {
        void submit(formatSettleNotification(t), { recordHistory: false });
      }
    }
    // busy：什么都不做——通知已在管理器待投递队列，等 runAgent 回合边界 flush
  };

  // 定稿前缀进 <Static>（append-only，写入终端 scrollback，不再参与每帧擦写）；
  // 动态区只留在途尾部 + 交互元素，高度被压住，避免终端超高时走整屏清屏重写路径（闪烁/残行/无法回滚）。
  // ink 只认一个 static 节点，因此全树仅此处一个 <Static>，WelcomeBox 作为首条挂进去。
  const settledCount = countSettledItems(items, busy);
  // 模型选择器候选清单：左列 displayName ?? 别名，右列渠道名（entry.provider ?? 顶层 provider），
  // 当前项按「别名解析出的真实 id === 当前 model」判定（与 /model 切换后的 model state 对齐）。
  const modelPickerItems: ModelPickerItem[] = Object.entries(config.models ?? {}).map(([alias, entry]) => ({
    alias,
    label: entry.displayName ?? alias,
    channel: entry.provider ?? config.provider,
    current: (entry.model ?? alias) === model,
  }));
  // 思考深度选择器候选清单：档位表各档（右列 budget）+ 尾部 off 项；
  // 当前项按会话覆盖判定（无覆盖时命中 config 默认档位算当前）。
  const thinkLevels = thinkLevelsOf(config.thinking);
  const thinkPickerItems: ThinkPickerItem[] = [
    ...Object.entries(thinkLevels).map(([name, budget]) => ({
      name,
      detail: t('thinkPicker.budget', { budget }),
      current: thinkOverride === undefined ? name === config.thinking?.defaultLevel : name === thinkOverride,
    })),
    { name: 'off', detail: t('thinkPicker.offDetail'), current: thinkOverride === 'off' },
  ];
  const staticEntries: Array<{ kind: 'welcome' } | DisplayItem> = [
    { kind: 'welcome' },
    ...items.slice(0, settledCount),
  ];
  const liveItems = items.slice(settledCount);

  // 动态区高度预算（滚动跳顶修复：Ink 在动态帧 ≥ 终端行数时全量清屏、\x1b[3J 清 scrollback，
  // 用户向上滚动被拽回顶部；预算保证动态帧恒 ≤ 终端行数 − 1，详见 liveBudget.ts）。
  // 固定部分 = 状态栏 + 输入区/弹层 + AgentGroup + 图片横幅；可选面板（QueuePreview/TodoPanel/
  // 思考预览）由 computeLiveBudget 在 chrome 逼近一屏时按优先级降级。
  // 输入区/弹层行数：弹层替换输入区时按各组件实测结构估算；常态用 computePromptRows 按输入内容
  // 实测——斜杠菜单、长输入折行都计入，不再是恒定 4 行（busy 期间敲 / 必超屏的洞即出于此）。
  let promptRows: number;
  // 弹层内宽（边框 2 + paddingX 2）；列数未知时按结构估算（每逻辑行 1 行）
  const overlayInner = stdout?.columns === undefined ? undefined : stdout.columns - 4;
  if (pendingQuestion !== null) {
    promptRows = estimateQuestionRows(pendingQuestion, stdout?.columns);
  } else if (pendingPlan !== null) {
    // 计划确认框：margin 1 + 边框 2 + 标题（折行）+ 计划正文逐行折行 + 提示（折行）
    const planHint = `y${t('app.plan.readyHintMiddle')}n${t('app.plan.readyHintEnd')}`;
    promptRows =
      1 +
      2 +
      wrappedRows(t('app.plan.readyTitle'), overlayInner) +
      pendingPlan.plan.split('\n').reduce((n, line) => n + wrappedRows(line, overlayInner), 0) +
      wrappedRows(planHint, overlayInner);
  } else if (pending !== null) {
    promptRows = estimateApprovalRows(pending, stdout?.columns);
  } else if (modelPickerOpen) {
    // 模型选择器（上界估算，宁多勿少）：margin 1 + 边框 2 + 标题/缓存警告/搜索/页码/提示（折行）
    // + 条目行——每条宽 = 指针 2 + 左列（截断至终端宽一半）+ 间隔 2 + 渠道列 + 当前标记，折行后取最宽的 ≤10 条。
    // 搜索行的过滤词是组件内部状态、App 不可知，按 1 行计（长过滤词折行为已知小风险）。
    const cap = Math.max(Math.floor((stdout?.columns ?? 80) / 2), 8);
    const colW = Math.min(Math.max(0, ...modelPickerItems.map((m) => m.label.length)), cap);
    const itemRows = modelPickerItems
      .map((m) => {
        const width =
          2 + colW + 2 + displayWidth(m.channel) + (m.current ? 1 + displayWidth(t('modelPicker.current')) : 0);
        return overlayInner === undefined ? 1 : Math.max(1, Math.ceil(width / overlayInner));
      })
      .sort((a, b) => b - a)
      .slice(0, 10)
      .reduce((n, r) => n + r, 0);
    promptRows =
      1 +
      2 +
      wrappedRows(t('modelPicker.title'), overlayInner) +
      (history.current.length > 0 ? wrappedRows(t('modelPicker.cacheWarning'), overlayInner) : 0) +
      1 + // 搜索行
      Math.max(itemRows, modelPickerItems.length > 0 ? 1 : wrappedRows(t('modelPicker.empty'), overlayInner)) +
      (modelPickerItems.length > 10
        ? wrappedRows(t('sessionPicker.pageInfo', { start: 1, end: 10, total: modelPickerItems.length }), overlayInner)
        : 0) +
      wrappedRows(t('modelPicker.hint'), overlayInner);
  } else if (thinkPickerOpen) {
    // 思考深度选择器（上界估算）：margin 1 + 边框 2 + 标题/缓存警告/提示（折行）+ 全部档位条目（折行）
    const colW = Math.max(0, ...thinkPickerItems.map((m) => m.name.length));
    const itemRows = thinkPickerItems.reduce((n, m) => {
      const width =
        2 + colW + 2 + displayWidth(m.detail) + (m.current ? 1 + displayWidth(t('modelPicker.current')) : 0);
      return n + (overlayInner === undefined ? 1 : Math.max(1, Math.ceil(width / overlayInner)));
    }, 0);
    promptRows =
      1 +
      2 +
      wrappedRows(t('thinkPicker.title'), overlayInner) +
      (history.current.length > 0 ? wrappedRows(t('app.think.cacheWarning'), overlayInner) : 0) +
      Math.max(itemRows, thinkPickerItems.length > 0 ? 1 : wrappedRows(t('thinkPicker.empty'), overlayInner)) +
      wrappedRows(t('thinkPicker.hint'), overlayInner);
  } else if (sessionPickerOpen) {
    // 会话选择器（上界估算，宁多勿少）：margin 1 + 边框 2 + 标题（折行）+ 搜索行 1
    // + 条目行（每条 = 指针 2 + 标题 + 当前标记 + 间隔 2 + 相对时间/条数，折行后取最宽的 ≤PAGE_SIZE 条）
    // + 分页行（>PAGE_SIZE 时）+ 底部单行（删除提示/确认/notice，取最长的 deleteConfirm 估上界）。
    const meta = t('sessionPicker.count', { count: 0 });
    const itemRows = sessionPickerItems
      .map((m) => {
        const label = m.title !== undefined && m.title !== '' ? m.title : m.id;
        const width =
          2 +
          displayWidth(label) +
          (m.id === sessionRef.current.id ? 1 + displayWidth(t('sessionPicker.current')) : 0) +
          2 +
          displayWidth(`${relativeTime(m.updatedAt)} · ${meta}`);
        return overlayInner === undefined ? 1 : Math.max(1, Math.ceil(width / overlayInner));
      })
      .sort((a, b) => b - a)
      .slice(0, 10)
      .reduce((n, r) => n + r, 0);
    const bottomRow = wrappedRows(
      t('sessionPicker.deleteConfirm', { title: 'x'.repeat(20) }),
      overlayInner,
    );
    promptRows =
      1 +
      2 +
      wrappedRows(t('sessionPicker.title'), overlayInner) +
      1 +
      Math.max(itemRows, sessionPickerItems.length > 0 ? 1 : wrappedRows(t('sessionPicker.empty'), overlayInner)) +
      (sessionPickerItems.length > 10
        ? wrappedRows(
            t('sessionPicker.pageInfo', { start: 1, end: 10, total: sessionPickerItems.length }),
            overlayInner,
          )
        : 0) +
      bottomRow;
  } else {
    promptRows = computePromptRows(input, {
      busy,
      primed: backtrackPrimed,
      exitPrimed,
      columns: stdout?.columns ?? 80,
    });
  }
  const budget = computeLiveBudget(stdout?.rows, {
    statusRows: STATUS_BAR_ROWS,
    promptRows,
    // TodoPanel：margin 1 + 边框 2 + 标题 1 + 最多 5 条 + 「+N more」1（条目已 wrap=truncate 单行）
    todoRows:
      todos.current.length > 0 ? 5 + Math.min(todos.current.length, 5) + (todos.current.length > 5 ? 1 : 0) : 0,
    // AgentGroup：margin 1 + 边框 2 + 头部 1 + 每个子 agent 1 行（running 带活动描述再 +1）
    agentRows:
      subagents.length > 0
        ? 4 +
          subagents.reduce(
            (n, a) => n + 1 + (a.status === 'running' && a.activity !== undefined && a.activity !== '' ? 1 : 0),
            0,
          )
        : 0,
    // QueuePreview：标题 1 + 前 3 条每条 ≤ 2 行 + 「还有 N 条」1 + ↑ 取回提示 1
    queueRows:
      queueLen > 0
        ? 2 +
          queue.current.slice(0, 3).reduce((n, q) => n + Math.min(2, q.split('\n').length), 0) +
          (queueLen > 3 ? 1 : 0)
        : 0,
    // 图片横幅：单行
    imageRows: imageCount > 0 ? 1 : 0,
    // 思考流式预览：标题 1 + 尾部 ≤THINKING_PREVIEW_LINES 行（各行 wrap=truncate）
    thinkingRows:
      thinkingPreview !== '' ? 1 + Math.min(thinkingPreview.split('\n').length, THINKING_PREVIEW_LINES) : 0,
    // WorkingStatus 忙碌态状态行：margin 1 + spinner 行 1 + tip 行 1（busy 且已记起始时间才显示）
    workingRows: busy && turnStartAt > 0 ? 3 : 0,
  });
  logRenderBudget(stdout?.rows, budget);
  // stdout.rows 随 resize 自动更新，预算随之重算；非 TTY / 测试环境无 rows → undefined 不窗口化
  const liveMaxRows = budget.liveMaxRows;

  return (
    <Box flexDirection="column">
      <Static key={sessionEpoch} items={staticEntries}>
        {(entry, i) =>
          entry.kind === 'welcome' ? (
            <WelcomeBox key="welcome" cwd={ctx.cwd} sessionId={sessionRef.current.id} model={model} version={VERSION} />
          ) : (
            // Static 恒折叠渲染：ink <Static> append-only，条目进 scrollback 时渲染结果即冻结。
            // 若带上 Ctrl+O 的 expanded 真值，展开态会被永久冻进历史，事后 Ctrl+O 无法收回。
            // 展开只是动态区的临时视图（在途尾部走 MessageList；空闲回看走下方 ExpandedReview），
            // 历史恒紧凑。
            <MessageItem key={i} item={entry} expanded={false} />
          )
        }
      </Static>
      {/* 空闲 + 展开模式：最近的可展开工具输出在动态区以展开态重渲（临时视图，不碰 scrollback） */}
      {!busy && expanded ? <ExpandedReview items={items} maxRows={liveMaxRows} /> : null}
      <MessageList items={liveItems} expanded={expanded} busy={busy} maxRows={liveMaxRows} />
      {budget.thinkingRows > 0 ? <ThinkingPreview text={thinkingPreview} maxLines={budget.thinkingRows - 1} /> : null}
      <AgentGroup agents={subagents} />
      {budget.showTodos ? <TodoPanel todos={todos.current} /> : null}
      {budget.showQueue ? <QueuePreview queue={queue.current} /> : null}
      {/* 忙碌态状态行：spinner + 状态词 + elapsed + 本轮 output token，独占块放输入框正上方（下含 tip）。
          弹层（提问/审批/选择器）态不显示——那些态本就不 busy。 */}
      {busy && turnStartAt > 0 ? (
        <WorkingStatus startedAt={turnStartAt} outputTokens={Math.floor(turnOutputChars / 3)} />
      ) : null}
      {imageCount > 0 ? (
        <Box>
          <Text color="cyan">{t('app.image.banner', { count: imageCount })}</Text>
          <Text color="gray">{t('app.image.bannerHint')}</Text>
        </Box>
      ) : null}
      {pendingQuestion !== null ? (
        <QuestionPrompt req={pendingQuestion} onSubmit={resolveQuestion} onCancel={() => resolveQuestion({})} />
      ) : pendingPlan !== null ? (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={1}>
          <Text color="green" bold>
            {t('app.plan.readyTitle')}
          </Text>
          <Text>{pendingPlan.plan}</Text>
          <Text>
            <Text color="green">y</Text>
            {t('app.plan.readyHintMiddle')}
            <Text color="red">n</Text>
            {t('app.plan.readyHintEnd')}
          </Text>
        </Box>
      ) : pending !== null ? (
        <ApprovalPrompt req={pending} onResolve={resolveApproval} />
      ) : modelPickerOpen ? (
        <ModelPicker
          items={modelPickerItems}
          hasHistory={history.current.length > 0}
          onSelect={(alias) => {
            setModelPickerOpen(false);
            if (alias !== null) applyModelAlias(alias);
          }}
        />
      ) : thinkPickerOpen ? (
        <ThinkPicker
          items={thinkPickerItems}
          hasHistory={history.current.length > 0}
          onSelect={(name) => {
            setThinkPickerOpen(false);
            if (name !== null) applyThinkLevel(name);
          }}
        />
      ) : sessionPickerOpen ? (
        <SessionPicker
          sessions={sessionPickerItems}
          currentId={sessionRef.current.id}
          onSelect={(id) => {
            setSessionPickerOpen(false);
            if (id !== null && !resumeSessionById(id)) {
              pushItem({ kind: 'note', text: t('app.resume.notFound', { id }) });
            }
          }}
          onDelete={(id) => {
            // 删除落盘（不可逆），成功则从快照移除该项让选择器刷新
            const ok = store.delete(ctx.cwd, id);
            if (ok) setSessionPickerItems((prev) => prev.filter((m) => m.id !== id));
            return ok;
          }}
        />
      ) : (
        <PromptInput value={input} onChange={setInput} onSubmit={submit} busy={busy} history={inputHistory} primed={backtrackPrimed} exitPrimed={exitPrimed} onRecallQueued={recallQueued} />
      )}
      <StatusBar
        mode={mode}
        planMode={planMode}
        model={modelLabel}
        thinking={
          thinkingAvailable(providerNameRef.current, config.thinking)
            ? thinkStatusLabel(thinkOverride, config.thinking)
            : undefined
        }
        busy={busy}
        cwd={ctx.cwd}
        usedTokens={usedTokens}
        maxContextSize={maxContextSize}
        backgroundCount={background.current.activeCount()}
        goal={
          goalView !== null
            ? {
                status: goalView.status,
                turnsUsed: goalView.turnsUsed,
                turnBudget: goalView.turnBudget,
                elapsedMs: goalNow - goalView.createdAt,
              }
            : undefined
        }
        hints={t('status.hints', {
          imageCount: imageCount > 0 ? t('status.imageCount', { count: imageCount }) : '',
          planMode: planMode ? t('status.planOn') : '',
        })}
      />
    </Box>
  );
}
