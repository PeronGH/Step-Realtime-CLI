import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { SubagentProgressEvent } from '../../src/agent/events.js';
import { buildAgentRegistry, parseAgentMarkdown } from '../../src/agent/subagent/registry.js';
import { createSubagentRunner, type SubagentRunnerDeps } from '../../src/agent/subagent/runner.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { parseSkillMd, type SkillRegistry } from '../../src/skill/registry.js';
import { spawnAgentTool } from '../../src/tools/spawnAgent.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';
import { runAgent } from '../../src/agent/loop.js';

const LONG = 'x'.repeat(220); // >200，跳过摘要补写

describe('parseAgentMarkdown', () => {
  it('解析合法 frontmatter + 正文', () => {
    const md = `---\nname: reviewer\ndescription: 代码审查\ntools: [read_file, grep]\nmaxSteps: 12\n---\n你是一个只读代码审查子 agent，仔细检查改动。`;
    const def = parseAgentMarkdown(md, 'fallback');
    expect(def).not.toBeNull();
    expect(def!.name).toBe('reviewer');
    expect(def!.tools).toEqual(['read_file', 'grep']);
    expect(def!.maxSteps).toBe(12);
    expect(def!.systemPrompt).toContain('只读代码审查');
  });

  it('未配 maxSteps → undefined（交给 config 全局默认）', () => {
    const md = `---\nname: r\ndescription: d\n---\n这是一段足够长的子 agent 系统提示词内容。`;
    const def = parseAgentMarkdown(md, 'f');
    expect(def).not.toBeNull();
    expect(def!.maxSteps).toBeUndefined();
  });

  it('正文过短 / 缺字段 → null', () => {
    expect(parseAgentMarkdown(`---\nname: x\ndescription: d\n---\n短`, 'f')).toBeNull();
    expect(parseAgentMarkdown('没有 frontmatter 的普通文档内容', 'f')).toBeNull();
  });
});

describe('buildAgentRegistry', () => {
  it('内置 general / explore 存在', () => {
    const reg = buildAgentRegistry(process.cwd());
    expect(reg.has('general')).toBe(true);
    expect(reg.has('explore')).toBe(true);
    expect(reg.get('explore')!.tools).toContain('read_file');
  });
});

const deps = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  onEvent?: (id: string | undefined, e: SubagentProgressEvent) => void,
  over: Partial<SubagentRunnerDeps> = {},
): SubagentRunnerDeps => ({
  provider,
  cwd: process.cwd(),
  hooks: {},
  maxDepth: 1,
  maxPerSession: 10,
  maxStepsDefault: 30,
  compaction: { maxContextSize: 1_000_000, triggerRatio: 0.85, reservedTokens: 32000 },
  sessionCounter: { spawned: 0 },
  onEvent,
  ...over,
});

describe('createSubagentRunner', () => {
  it('深度已达上限 → 拒绝且不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 1 });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('深度上限');
    expect(streamCalls()).toBe(0);
  });

  it('maxDepth 可配为 2 时允许再下探一层', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const run = createSubagentRunner(deps(provider, undefined, { maxDepth: 2 }));
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 1 });
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBe(1);
  });

  it('未知子 agent 类型 → 错误', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'nope', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('未知子 agent 类型');
    expect(streamCalls()).toBe(0);
  });

  it('会话数量已达上限 → 拒绝且不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const counter = { spawned: 3 };
    const run = createSubagentRunner(
      deps(provider, undefined, { maxPerSession: 3, sessionCounter: counter }),
    );
    const r = await run({ subagentType: 'general', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(true);
    expect(r.summary).toContain('数量上限');
    expect(streamCalls()).toBe(0);
  });

  it('每次成功派生递增会话计数器', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const counter = { spawned: 0 };
    const run = createSubagentRunner(deps(provider, undefined, { sessionCounter: counter }));
    await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(counter.spawned).toBe(1);
  });

  it('未知类型 / 深度超限不占用配额', async () => {
    const { provider } = makeFakeProvider([]);
    const counter = { spawned: 0 };
    const run = createSubagentRunner(deps(provider, undefined, { sessionCounter: counter }));
    await run({ subagentType: 'nope', prompt: 'x', depth: 0 });
    await run({ subagentType: 'general', prompt: 'x', depth: 1 }); // 深度超限
    expect(counter.spawned).toBe(0);
  });

  it('maxDepth=2 时子 agent 可再派生（嵌套），工具集保留 spawn_agent', async () => {
    // 主 agent → 子 agent(depth1) 内模型再调 spawn_agent → 孙 agent(depth2)
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: '孙任务', description: 'd', subagent_type: 'explore' })] },
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 孙 agent 返回
      { textChunks: [], finalContent: [textBlock(LONG)] }, // 子 agent 返回
    ]);
    const run = createSubagentRunner(deps(provider, undefined, { maxDepth: 2 }));
    const r = await run({ subagentType: 'general', prompt: '主任务', depth: 0 });
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBeGreaterThanOrEqual(2); // 子 agent 和孙 agent 都跑了
  });

  it('正常跑完 → 最后一条 assistant 文本作为摘要回灌', async () => {
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.summary).toBe(LONG);
  });

  it('子 agent 共享 skill：system 拼清单、工具表含 skill 工具', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const reg: SkillRegistry = { skills: new Map() };
    reg.skills.set('demo', parseSkillMd('---\nname: demo\ndescription: 演示技能\n---\n技能正文', '/d', 'user')!);
    const run = createSubagentRunner(deps(provider, undefined, { skills: reg }));
    const r = await run({ subagentType: 'explore', prompt: 'x', depth: 0 });
    expect(r.isError).toBe(false);
    const p = streamParams()[0]!;
    // system 含技能清单（子 agent 也能感知可用技能）
    expect(String(p.system)).toContain('可用技能');
    expect(String(p.system)).toContain('demo');
    // 工具表含 skill（explore 白名单已纳入，read-only 激活安全）
    const toolNames = (p.tools as { name: string }[]).map((tt) => tt.name);
    expect(toolNames).toContain('skill');
  });

  it('子 agent 无法派生：spawn_agent 被工具白名单拦下', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'spawn_agent', { prompt: 'y', description: 'd' })] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
    ]);
    const run = createSubagentRunner(deps(provider));
    const r = await run({ subagentType: 'general', prompt: '试图再派生', depth: 0 });
    // spawn_agent 被子 agent 的工具白名单拦下（allowedTools 守卫），子 agent 仍正常跑完
    expect(r.isError).toBe(false);
    expect(streamCalls()).toBe(2); // 子 agent 尝试 spawn + 总结两轮
  });
});

describe('runner 消费 usage 事件（计费口径累计上抛）', () => {
  it('连续两轮带 billedDelta → 累计值递增的 usage progress（缓存命中不计成本）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})],
        usage: { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 10 } as Anthropic.Usage,
      },
      {
        textChunks: [],
        finalContent: [textBlock(LONG)],
        usage: { input_tokens: 200, output_tokens: 20 } as Anthropic.Usage,
      },
    ]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    // 第 1 轮 100−40+10=70；第 2 轮 200+20=220 → 累计 290
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 70 },
      { kind: 'usage', tokens: 290 },
    ]);
  });

  it('摘要过短追加轮的消耗连续累计（同一闭包 tokensUsed）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [textBlock('短')], // <200 字，触发追加轮
        usage: { input_tokens: 50, output_tokens: 5 } as Anthropic.Usage,
      },
      {
        textChunks: [],
        finalContent: [textBlock(LONG)],
        usage: { input_tokens: 80, output_tokens: 30 } as Anthropic.Usage,
      },
    ]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(r.summary).toBe(LONG);
    // 追加轮（55 + 110 = 165）接着首轮累计，不重置
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 55 },
      { kind: 'usage', tokens: 165 },
    ]);
  });

  it('压缩后的估算 usage（无 billedDelta）不计入累计', async () => {
    const events: SubagentProgressEvent[] = [];
    const usage = { input_tokens: 1000, output_tokens: 10 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})], usage },
      { textChunks: [], finalContent: [toolUseBlock('c2', 'nonexistent_tool', {})], usage },
      { textChunks: [], finalContent: [toolUseBlock('c3', 'nonexistent_tool', {})], usage },
      { textChunks: [], finalContent: [toolUseBlock('c4', 'nonexistent_tool', {})], usage },
      // fullCompact 摘要调用：质检门要求摘要相对被压缩量有最低信息量，给足长度避免触发重试
      { textChunks: [], finalContent: [textBlock('x'.repeat(100))] },
      { textChunks: [], finalContent: [textBlock(LONG)], usage }, // 压缩后下一轮 end_turn
    ]);
    // 极小阈值 + 长 prompt：第 4 轮 tool_use 后触发循环内压缩（消息 9 条，超过 KEEP_RECENT+1），
    // 压缩后 loop 产出一条无 billedDelta 的估算 usage——runner 必须跳过它
    const run = createSubagentRunner(
      deps(provider, (_id, e) => events.push(e), {
        compaction: { maxContextSize: 200, triggerRatio: 0.85, reservedTokens: 10 },
      }),
    );
    const r = await run({ subagentType: 'general', prompt: 'x'.repeat(1200), depth: 0 });
    expect(r.isError).toBe(false);
    // 每轮真实 usage 计费 1000+10=1010；5 个真实回合 → 5 条递增的 usage progress。
    // 若估算事件被计入，会多出一条且数值跳变（估算是全量快照不是增量）。
    expect(events.filter((e) => e.kind === 'usage')).toEqual([
      { kind: 'usage', tokens: 1010 },
      { kind: 'usage', tokens: 2020 },
      { kind: 'usage', tokens: 3030 },
      { kind: 'usage', tokens: 4040 },
      { kind: 'usage', tokens: 5050 },
    ]);
  });

  it('provider 未回 usage → 不产生 usage progress（billedDelta 缺省时旧行为不变）', async () => {
    const events: SubagentProgressEvent[] = [];
    const { provider } = makeFakeProvider([{ textChunks: [], finalContent: [textBlock(LONG)] }]);
    const run = createSubagentRunner(deps(provider, (_id, e) => events.push(e)));
    const r = await run({ subagentType: 'general', prompt: '干活', depth: 0 });
    expect(r.isError).toBe(false);
    expect(events.filter((e) => e.kind === 'usage')).toHaveLength(0);
  });
});

describe('runAgent allowedTools 守卫', () => {
  it('白名单外的工具调用被拒、不执行', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'write_file', { path: 'x', content: 'y' })] },
      { textChunks: ['ok'], finalContent: [textBlock('ok')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: 'go' }, 'user')];
    const events = await collect(
      runAgent({
        provider,
        system: 's',
        ctx: { cwd: process.cwd() },
        messages,
        allowedTools: ['read_file'],
      }),
    );
    const toolEnd = events.find((e) => e.type === 'tool_end') as
      | { type: 'tool_end'; isError: boolean; result: string }
      | undefined;
    expect(toolEnd?.isError).toBe(true);
    expect(toolEnd?.result).toContain('不可用');
  });
});

describe('spawn_agent 工具', () => {
  it('一轮多个 explore spawn_agent → 并行执行，全部回 tool_result', async () => {
    const { provider } = makeFakeProvider([
      // 第 1 轮：模型同时发两个 explore spawn_agent
      {
        textChunks: [],
        finalContent: [
          toolUseBlock('s1', 'spawn_agent', { description: 'd1', prompt: 'p1', subagent_type: 'explore' }),
          toolUseBlock('s2', 'spawn_agent', { description: 'd2', prompt: 'p2', subagent_type: 'explore' }),
        ],
      },
      // 两个子 agent 各自的 runAgent（并行，各取一条）
      { textChunks: [], finalContent: [textBlock(LONG)] },
      { textChunks: [], finalContent: [textBlock(LONG)] },
      // 主 agent 下一轮：结束
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const messages: StoredMessage[] = [stored({ role: 'user', content: '并行调查' }, 'user')];
    const events = await collect(
      runAgent({
        provider,
        system: 's',
        ctx: { cwd: process.cwd(), depth: 0, runSubagent: async (req) => ({ summary: `done:${req.subagentType}`, isError: false }) },
        messages,
      }),
    );
    const toolEnds = events.filter((e) => e.type === 'tool_end');
    expect(toolEnds).toHaveLength(2);
    // tool_result 消息包含两个结果
    const toolResultMsg = messages.find(
      (m) => m.message.role === 'user' && Array.isArray(m.message.content) && m.message.content.some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeDefined();
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('ctx 无 runSubagent → 报错（子 agent 内不能派生）', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p' },
      { cwd: process.cwd() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持派生');
  });

  it('run_in_background=true → 立即返回 task_id，后台执行', async () => {
    const { BackgroundManager } = await import('../../src/agent/background/manager.js');
    const mgr = new BackgroundManager();
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore', run_in_background: true },
      {
        cwd: process.cwd(),
        depth: 0,
        background: mgr,
        runSubagent: async () => ({ summary: '后台完成', isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('task_id=');
    // 等待后台任务完成
    await new Promise((res) => setTimeout(res, 50));
    const tasks = mgr.list();
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('有 runSubagent → 透传结果', async () => {
    const r = await spawnAgentTool.execute(
      { description: 'd', prompt: 'p', subagent_type: 'explore' },
      {
        cwd: process.cwd(),
        depth: 0,
        runSubagent: async (req) => ({ summary: `done:${req.subagentType}`, isError: false }),
      },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toBe('done:explore');
  });
});
