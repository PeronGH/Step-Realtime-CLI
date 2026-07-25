#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { render } from 'ink';
import { runAgent } from './agent/loop.js';
import { estimateTokens, microCompact } from './agent/compaction/compact.js';
import { runReflect } from './agent/reflect.js';
import type { AgentEvent } from './agent/events.js';
import type { LoopHooks } from './agent/hooks.js';
import { composeLoopHooks, HookEngine } from './agent/hooks/engine.js';
import { decide, type PermissionMode } from './agent/permission/mode.js';
import { createSubagentRunner } from './agent/subagent/runner.js';
import { stored } from './agent/message.js';
import { BackgroundManager } from './agent/background/manager.js';
import { formatSettleNotification } from './agent/background/notify.js';
import { buildSystemPrompt } from './agent/systemPrompt.js';
import { loadAgentsMd } from './agent/agentsMd.js';
import { loadConfig, type StepCodeConfig } from './config/config.js';
import { setLocale, t } from './i18n.js';
import { discoverPlugins, defaultPluginsDir } from './plugin/manager.js';
import { pluginsStatePath, readPluginsState } from './plugin/manage.js';
import { buildSkillRegistry, skillListing } from './skill/registry.js';
import { McpManager, mcpInputSchemaToZod, type McpServerConfig } from './mcp/manager.js';
import { registerDynamicTool } from './tools/index.js';
import { createProvider } from './provider/factory.js';
import type { ChatProvider } from './provider/types.js';
import { SessionStore, deriveTitle, type SessionData } from './session/store.js';
import { resumeHintMeta, resumeHintText } from './session/resumeHint.js';
import { runExportDebugZip } from './session/debugCli.js';
import { App } from './tui/App.js';
import { SessionPicker, relativeTime } from './tui/SessionPicker.js';
import type { ToolContext } from './tools/types.js';
import { configureLogger, logError } from './utils/logger.js';
import { VERSION } from './version.js';

const program = new Command();
program
  .name('step')
  .description('Step Code — 终端编码 agent，由阶跃 Step 系列模型驱动')
  .version(VERSION)
  // 允许位置参数（用于 `step sessions [list|show|delete] <id>` 子命令检测）
  .allowExcessArguments(true)
  .option('-p, --print <prompt>', '非交互模式：执行单条指令，流式打印结果后退出')
  .option('--reflect', '非交互模式：回顾指定/最近会话的完整历史，提炼可复用方法论经验后打印退出')
  .option('-C, --cwd <dir>', '指定工作目录，默认当前目录')
  .option('-y, --yolo', '权限模式 yolo：全部工具放行，从不确认')
  .option('--auto', '权限模式 auto：写文件放行，bash 需确认')
  .option('-c, --continue', '恢复本工作目录下最近的一个会话')
  .option('--session <id>', '恢复指定 id 的会话')
  .option('-r, --resume [id]', '恢复会话：带 id 直接恢复；不带 id 打开交互选择器')
  .option('--output-format <fmt>', '非交互输出格式：text（默认）或 stream-json', 'text')
  .option('--model <name>', '覆盖模型（config.model）')
  .option('--provider <name>', '覆盖服务商（stepfun|anthropic|openai|openai_responses），未同时指定 model/base_url 时按其预设补默认')
  .parse();

const opts = program.opts<{
  print?: string;
  reflect?: boolean;
  cwd?: string;
  yolo?: boolean;
  auto?: boolean;
  continue?: boolean;
  session?: string;
  resume?: string | boolean;
  outputFormat?: string;
  model?: string;
  provider?: string;
}>();
const cwd = opts.cwd !== undefined ? resolve(opts.cwd) : process.cwd();
const mode: PermissionMode = opts.yolo === true ? 'yolo' : opts.auto === true ? 'auto' : 'manual';

// 顶层 `export-debug-zip [sessionId]` 子命令：完全脱离 Ink/TTY 的无头导出路径，供 CI/脚本断言 zip 产出。
// 与 TUI 斜杠命令共用 exportDebugBundle。放在 config/provider 加载之前，避免坏配置阻塞调试包导出。
if (program.args[0] === 'export-debug-zip') {
  configureLogger({ mode: 'headless' });
  const res = await runExportDebugZip({ store: new SessionStore(), cwd, sessionId: program.args[1] });
  if (res.stdout !== undefined) process.stdout.write(res.stdout);
  if (res.stderr !== undefined) process.stderr.write(res.stderr);
  process.exit(res.code);
}

let config: StepCodeConfig;
try {
  config = loadConfig(cwd, { provider: opts.provider, model: opts.model });
} catch (e) {
  logError((e as Error).message);
  process.exit(1);
}

// 界面语言：loadConfig 之后立即生效（此后所有给人看的输出走 t() 查表）。
// commander 帮助定义在模块顶层、早于本行，v1 固定中文（已知限制）。
setLocale(config.language ?? 'zh');

// 顶层 `sessions` 子命令（命令行管理，不进 TUI）：list / show <id> / delete <id>。用位置参数检测。
if (program.args[0] === 'sessions') {
  const sub = program.args[1];
  const sessStore = new SessionStore();
  if (sub === undefined || sub === 'list') {
    const metas = sessStore.list(cwd);
    if (metas.length === 0) {
      console.log(t('app.sessions.none'));
    } else {
      for (const m of metas) {
        console.log(
          t('cli.sessions.line', {
            id: m.id,
            title: m.title ?? t('app.sessions.untitled'),
            updated: relativeTime(m.updatedAt),
            count: m.messageCount,
          }),
        );
      }
    }
  } else if (sub === 'show') {
    const id = program.args[2];
    if (id === undefined) {
      console.error(t('cli.sessions.showUsage'));
      process.exit(1);
    }
    const data = sessStore.load(cwd, id);
    if (data === null) {
      console.error(t('app.resume.notFound', { id }));
      process.exit(1);
    }
    console.log(`id:   ${data.id}`);
    console.log(`${t('cli.sessions.label.title')}${data.title ?? deriveTitle(data.messages) ?? t('app.sessions.untitled')}`);
    console.log(`${t('cli.sessions.label.model')}${data.model}`);
    console.log(`${t('cli.sessions.label.created')}${data.createdAt}`);
    console.log(`${t('cli.sessions.label.updated')}${data.updatedAt}`);
    console.log(`${t('cli.sessions.label.count')}${data.messageCount ?? data.messages.length}`);
  } else if (sub === 'delete') {
    const id = program.args[2];
    if (id === undefined) {
      console.error(t('cli.sessions.deleteUsage'));
      process.exit(1);
    }
    const ok = sessStore.delete(cwd, id);
    console.log(ok ? t('cli.sessions.deleted', { id }) : t('cli.sessions.deleteFailed', { id }));
  } else {
    console.error(t('cli.sessions.unknownSub', { sub }));
    process.exit(1);
  }
  process.exit(0);
}

let provider: ChatProvider;
try {
  provider = createProvider(config);
} catch (e) {
  logError((e as Error).message);
  process.exit(1);
}

// plugin 发现：启动时重解析清单物化（不缓存快照），plugins.json 里 disabled 的不合流。
// 能力面：skills 进注册表；MCP 并入 mcpServerConfigs（名已带 <pluginId>: 前缀）；
// hooks 并入 HookEngine；commands 作为命名空间斜杠命令注入 TUI。
const pluginsState = readPluginsState(pluginsStatePath());
const plugins = discoverPlugins(defaultPluginsDir(), new Set(pluginsState.disabled));
const pluginSkillDirs = plugins.flatMap((p) => p.skillDirs);
// skill 懒加载：发现 plugin skill + 项目/用户 skill，构建注册表；清单拼进 system prompt（正文不进）。
const skillRegistry = buildSkillRegistry(cwd, pluginSkillDirs, config.extraSkillDirs);
// AGENTS.md 自动加载：用户级 + 项目级逐层收集，非空时拼到 system prompt 尾部
// config.toml 的 agents_paths 配置后覆盖默认收集
const agentsMd = loadAgentsMd(cwd, undefined, config.agentsPaths);
const system =
  buildSystemPrompt(cwd) + skillListing(skillRegistry) + (agentsMd !== '' ? `\n\n${agentsMd}` : '');
const ctx: ToolContext = { cwd, apiKey: config.apiKey, baseUrl: config.baseUrl, skills: skillRegistry };
// bash 前台超时自动转后台开关（[background].bash_auto_background_on_timeout，默认 true）
ctx.bashAutoBackgroundOnTimeout = config.background?.bashAutoBackgroundOnTimeout ?? true;

// MCP 接入：读 ~/.step-code/mcp.json 拿到 server 配置（仅解析，连接不阻塞启动）。
const mcpManager = new McpManager();
let mcpServerConfigs: Record<string, McpServerConfig> = {};
try {
  const mcpPath = join(homedir(), '.step-code', 'mcp.json');
  if (existsSync(mcpPath)) {
    const mcpCfg = JSON.parse(readFileSync(mcpPath, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> };
    mcpServerConfigs = mcpCfg.mcpServers ?? {};
  }
} catch {
  // mcp.json 读取失败不阻塞启动
}
// plugin 贡献的 MCP server 并入加载（键已带 <pluginId>:<serverName> 前缀隔离，与全局配置不冲突）。
for (const p of plugins) {
  Object.assign(mcpServerConfigs, p.mcpServers);
}

// tool_search：deferred = MCP 工具；命中后动态注册为可调用工具。
// deferred 起始为空：各 server 后台并行连接，每连上一个即把它的工具增量补登进来。
ctx.toolSearch = {
  deferred: [],
  load: (names) => {
    for (const n of names) {
      const found = mcpManager.find(n);
      if (found === undefined) continue;
      registerDynamicTool({
        name: found.info.qualifiedName,
        description: found.info.description,
        schema: mcpInputSchemaToZod(found.info.inputSchema),
        execute: async (input) => mcpManager.callTool(n, input as Record<string, unknown>),
      });
    }
  },
};

// 并行连接（单点失败隔离，每 server 30s 启动超时，状态记入 manager，/mcp 可查）；
// onConnected 回调把该 server 的工具补登进 deferred（tool_search 懒加载发现）。
const mcpReady = mcpManager.connectAll(mcpServerConfigs, (serverName) => {
  for (const tool of mcpManager.toolsOf(serverName)) {
    ctx.toolSearch?.deferred.push({
      name: tool.qualifiedName,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
});

// --- 解析会话：--resume > --session > --continue > 新建 ---
const store = new SessionStore();
// 引用式附件：发 provider 前 toWire 用它把 resume 读盘消息里的 stepref 图片还原成 base64
ctx.attachments = store.attachments;

/** 渲染交互选择器拿到选中 id（null=放弃开新会话）。列表为空则直接返回 null，不弹选择器。 */
async function pickSession(): Promise<string | null> {
  const sessions = store.list(cwd);
  if (sessions.length === 0) return null;
  return await new Promise<string | null>((resolve) => {
    // Ink 同一时刻只能有一个 render：选择器 unmount 后再 render App。
    let instance: ReturnType<typeof render> | undefined;
    instance = render(
      <SessionPicker
        sessions={sessions.slice(0, 200)}
        onSelect={(id) => {
          instance?.unmount();
          resolve(id);
        }}
      />,
    );
  });
}

let session: SessionData;
if (opts.resume !== undefined) {
  if (typeof opts.resume === 'string') {
    // 带 id：直接恢复；找不到则新建
    session = store.load(cwd, opts.resume) ?? store.create(cwd, config.model);
  } else if (process.stdin.isTTY) {
    // 无 id + TTY：弹交互选择器
    const picked = await pickSession();
    session =
      picked !== null ? (store.load(cwd, picked) ?? store.create(cwd, config.model)) : store.create(cwd, config.model);
  } else {
    // 无 id + 非 TTY（管道/CI）：退回最近一个（等同 -c）
    session = store.latest(cwd) ?? store.create(cwd, config.model);
  }
} else if (opts.session !== undefined) {
  session = store.load(cwd, opts.session) ?? store.create(cwd, config.model);
} else if (opts.continue === true) {
  session = store.latest(cwd) ?? store.create(cwd, config.model);
} else {
  session = store.create(cwd, config.model);
}
session.model = config.model;

// 用户可配置 hooks（~/.step-code/config.toml [[hooks]]）+ plugin 声明的 hooks：全局唯一引擎，
// PreToolUse/PostToolUse/Stop 叠加在 LoopHooks 之上（接口不动），UserPromptSubmit/SessionStart 在提交/启动点触发。
// plugin hook 的 cwd 已固定为插件根并注入 STEP_CODE_PLUGIN_ROOT（加载时在 manifest 解析层完成）。
const hookEntries = [...(config.hooks ?? []), ...plugins.flatMap((p) => p.hooks)];
const hookEngine = hookEntries.length > 0 ? new HookEngine(hookEntries, { sessionId: session.id, cwd }) : undefined;

/**
 * 非交互模式的权限钩子：能自动放行则放行；需确认（'ask'）时因无 TTY 可交互而拒绝，
 * 并提示用 --yolo / --auto 放行。避免脚本里静默执行危险操作。
 */
function nonInteractiveHooks(): LoopHooks {
  const base: LoopHooks = {
    authorizeToolCall: (req) => {
      const d = decide(req.name, mode, new Set());
      if (d === 'allow') return { decision: 'allow' };
      return {
        decision: 'deny',
        reason: `非交互模式无法确认「${req.name}」。加 --yolo 或 --auto 放行。`,
      };
    },
  };
  // 用户 hooks 叠加在权限判定之上：PreToolUse 链首 deny-only、PostToolUse fire-and-forget、Stop 一次性续行
  if (hookEngine === undefined) return base;
  return composeLoopHooks(hookEngine, base, {
    onStopContinue: (reason) => {
      session.messages.push(stored({ role: 'user', content: reason }, 'user'));
    },
  });
}

/** 非交互模式：跑一轮 agent。text 格式下 assistant 走 stdout、其余走 stderr；stream-json 下每个事件一行 JSON 到 stdout。 */
async function runPrint(prompt: string): Promise<void> {
  const streamJson = opts.outputFormat === 'stream-json';

  // 用户 hooks：notice 走 stderr（与 agent 循环 notice 同一出口）
  let hookContext = '';
  if (hookEngine !== undefined) {
    hookEngine.setNoticeSink((m) => process.stderr.write(`\n[notice] ${m}\n`));
    // SessionStart：会话创建/恢复后触发一次，stdout 注入会话上下文（拼进本轮 system 尾部）
    const ss = await hookEngine.run('SessionStart', {});
    if (ss.stdout !== '') hookContext = ss.stdout;
    // UserPromptSubmit：stdout 非空作为上下文注入本轮；exit 2 阻断本轮不发模型
    const up = await hookEngine.run('UserPromptSubmit', { prompt });
    if (up.blocked) {
      process.stderr.write(`\n[hook] UserPromptSubmit 阻断：${up.reason ?? ''}\n`);
      process.exitCode = 1;
      return;
    }
    if (up.stdout !== '') {
      session.messages.push(stored({ role: 'user', content: up.stdout }, 'user'));
    }
  }

  session.messages.push(stored({ role: 'user', content: prompt }, 'user'));

  // 软阈值自动微压缩，避免续接的长会话在首次请求前就超限（循环内压缩与溢出兜底为后续保障）
  if (estimateTokens(session.messages) > config.maxContextSize * 0.6) {
    session.messages = microCompact(session.messages).messages;
  }
  const emit = (ev: AgentEvent): void => {
    if (streamJson) {
      process.stdout.write(`${JSON.stringify(ev)}\n`);
      if (ev.type === 'error') process.exitCode = 1;
      return;
    }
    switch (ev.type) {
      case 'text':
        process.stdout.write(ev.text);
        break;
      case 'thinking_delta':
        // 思考过程不进 stdout：保持 -p 输出可管道（只出正文）
        break;
      case 'tool_start':
        process.stderr.write(`\n[tool] ${ev.name} ${JSON.stringify(ev.input)}\n`);
        break;
      case 'tool_end':
        process.stderr.write(`[tool:${ev.isError ? 'error' : 'ok'}] ${ev.name}\n`);
        break;
      case 'retry':
        process.stderr.write(`\n[retry] ${ev.message}\n`);
        break;
      case 'notice':
        process.stderr.write(`\n[notice] ${ev.message}\n`);
        break;
      case 'aborted':
        process.stderr.write(`\n[aborted] ${t('cli.print.aborted')}\n`);
        break;
      case 'error':
        process.stderr.write(`\n[error] ${ev.message}\n`);
        process.exitCode = 1;
        break;
      case 'turn_done':
        break;
    }
  };

  const hooks = nonInteractiveHooks();
  // TODO store：非交互单次运行，从 session 读入、结束时写回（独立 store，不占 messages）
  const todosStore = { items: session.todos !== undefined ? [...session.todos] : [] };
  // 后台任务终态通知：非交互模式没有队列通道，先收集，进程退出前 drain 到 stderr（不阻塞）
  const settledNotes: string[] = [];
  const background = new BackgroundManager(10, {
    taskTimeoutS: config.background?.bashTaskTimeoutS ?? 600,
    onSettle: (task) => {
      if (config.background?.notifyOnComplete === false) return;
      settledNotes.push(formatSettleNotification(task));
    },
  });
  const subCtx: ToolContext = {
    ...ctx,
    depth: 0,
    todos: todosStore,
    background,
    // 单次 runAgent 内 skill 激活计数器（递归防护，随本次运行新建）
    skillActivations: { count: 0 },
    subagentMaxConcurrent: config.subagent.maxConcurrent,
    runSubagent: createSubagentRunner({
      provider,
      cwd,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      hooks,
      maxDepth: config.subagent.maxDepth,
      maxPerSession: config.subagent.maxPerSession,
      maxStepsDefault: config.subagent.maxSteps,
      compaction: {
        maxContextSize: config.maxContextSize,
        triggerRatio: config.compaction.triggerRatio,
        reservedTokens: config.compaction.reservedTokens,
      },
      compactionModel: config.compaction.model,
      sessionCounter: { spawned: 0 }, // 非交互单次运行，计数器随进程即可
      skills: ctx.skills, // 子 agent 共享 skill
      onEvent: (_id, ev) => {
        if (ev.kind === 'tool') process.stderr.write(`  [subagent] ${ev.name}\n`);
        else if (ev.kind === 'error') process.stderr.write(`  [subagent:error] ${ev.message}\n`);
      },
    }),
  };

  for await (const ev of runAgent({
    provider,
    // SessionStart hook 注入的上下文拼在 system 尾部（仅本轮生效）
    system: hookContext !== '' ? `${system}\n\n${hookContext}` : system,
    ctx: subCtx,
    messages: session.messages,
    hooks,
    compaction: {
      maxContextSize: config.maxContextSize,
      triggerRatio: config.compaction.triggerRatio,
      reservedTokens: config.compaction.reservedTokens,
    },
    compactionModel: config.compaction.model,
    todos: todosStore.items,
  })) {
    emit(ev);
  }
  if (!streamJson) process.stdout.write('\n');
  // drain：把运行期间已终态的后台任务通知打到 stderr（未送达的注入通道降级；仍在运行的任务不等待）
  for (const note of settledNotes) {
    process.stderr.write(`\n${note}\n`);
  }
  session.todos = [...todosStore.items];
  try {
    store.save(session);
    // 与 TUI 一致：非交互会话也写全量历史日志（append-only，按 id 去重）
    store.appendFull(cwd, session.id, session.messages);
  } catch {
    // 持久化失败不影响输出
  }
  // 退出恢复提示：text 走 stderr 保持 stdout 干净；stream-json 发 meta 事件
  if (streamJson) {
    process.stdout.write(`${JSON.stringify(resumeHintMeta(session.id))}\n`);
  } else {
    process.stderr.write(`${resumeHintText(session.id)}\n`);
  }
}

/**
 * 非交互 reflect 模式：读取当前已解析会话的完整历史（优先全量日志，回退快照 messages），
 * 用真实模型跑 runReflect，把方法论经验清单打到 stdout 后退出。
 * 通常配合 -c（最近会话）或 --session <id> 用；单独 --reflect 会解析成空的新会话 → 走友好提示。
 */
async function runReflectPrint(): Promise<void> {
  const full = store.loadFull(cwd, session.id);
  const source = full.length > 0 ? full : session.messages;
  if (source.length === 0) {
    process.stderr.write(`${t('cli.reflect.noHistory')}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`${t('cli.reflect.running', { count: source.length })}\n`);
  try {
    const text = await runReflect(provider, source, {});
    process.stdout.write(`${text}\n`);
  } catch (e) {
    process.stderr.write(`[reflect:error] ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

// 非交互模式保持旧行为：开跑前等全部 MCP server 连接就绪（本轮即可用其工具），失败逐条打 stderr。
// 交互 TUI 不等待：render 立即进行，连接在后台完成，结果可用 /mcp 查看。
if (opts.reflect === true || opts.print !== undefined) {
  await mcpReady;
  for (const s of mcpManager.statuses()) {
    if (s.status === 'failed' && s.error !== undefined) {
      process.stderr.write(`${t('cli.mcp.connectFailed', { name: s.name, message: s.error })}\n`);
    }
  }
}

if (opts.reflect === true) {
  configureLogger({ mode: 'headless' });
  await runReflectPrint();
  // 非交互模式跑完关闭 MCP 连接：stdio 子进程不 kill 会让进程永不退出
  await mcpManager.closeAll();
} else if (opts.print !== undefined) {
  configureLogger({ mode: 'headless' });
  await runPrint(opts.print);
  await mcpManager.closeAll();
} else {
  // 交互 TUI：Ink 独占终端，日志只进文件 + 环形缓冲，绝不写 stderr/stdout。
  configureLogger({ mode: 'tui' });
  // 退出后打印 resume 提示：App unmount 时上抛当前会话信息
  let exitInfo: { id: string; hasContent: boolean } | undefined;
  const tui = render(
    <App
      provider={provider}
      system={system}
      ctx={ctx}
      model={config.model}
      config={config}
      initialMode={mode}
      store={store}
      session={session}
      maxContextSize={config.maxContextSize}
      subagent={config.subagent}
      compaction={config.compaction}
      mcp={mcpManager}
      hookEngine={hookEngine}
      pluginCommands={plugins.flatMap((p) => p.commands)}
      onExitInfo={(id, hasContent) => {
        exitInfo = { id, hasContent };
      }}
    />,
    // 关掉 Ink 默认的 Ctrl+C 即退：Ctrl+C 语义由 App 接管（busy 中断 / 空闲清输入 + 双击退出）
    { exitOnCtrlC: false },
  );
  await tui.waitUntilExit();
  if (exitInfo?.hasContent === true) {
    process.stderr.write(`\n${resumeHintText(exitInfo.id)}\n`);
  }
}
