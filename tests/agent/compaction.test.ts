import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  fullCompact,
  microCompact,
  shouldCompact,
  usageTotalTokens,
} from '../../src/agent/compaction/compact.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

function toolResultMsg(id: string, content: string): StoredMessage {
  return stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, 'tool');
}

/** 构造一条「文本 + 图片」的用户消息，图片 source.data 取传入值（base64 或 stepref）。 */
function imageMsg(data: string): StoredMessage {
  return stored(
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      ],
    },
    'user',
  );
}

describe('estimateTokens', () => {
  it('随内容增大而增大，空历史为 0', () => {
    expect(estimateTokens([])).toBe(0);
    const small = estimateTokens([stored({ role: 'user', content: 'hi' }, 'user')]);
    const big = estimateTokens([stored({ role: 'user', content: 'x'.repeat(3000) }, 'user')]);
    expect(big).toBeGreaterThan(small);
  });

  it('图片块按固定常数（1500）估算，与 base64/stepref 字符数无关', () => {
    const textOnly = estimateTokens([
      stored({ role: 'user', content: [{ type: 'text', text: '看图' }] }, 'user'),
    ]);
    const expected = textOnly + 1500; // PER_IMAGE_TOKENS（compact.ts 内部常数）
    const big = imageMsg(Buffer.alloc(4000, 7).toString('base64'));
    const small = imageMsg(Buffer.alloc(10, 7).toString('base64'));
    const ref = imageMsg(`stepref:${'a'.repeat(64)}`);
    expect(estimateTokens([big])).toBe(expected);
    expect(estimateTokens([small])).toBe(expected);
    expect(estimateTokens([ref])).toBe(expected);
    // 反向锚定：若退回按 base64 字符数估算，4000 字节图会被估到 1700+ 字符/3 ≈ 数倍于此
    expect(estimateTokens([big])).toBeLessThan(2000);
  });
});

describe('usageTotalTokens', () => {
  it('累加输入 / 输出 / 缓存读写 token', () => {
    expect(
      usageTotalTokens({
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 3,
      } as Anthropic.Usage),
    ).toBe(128);
  });

  it('缺失字段按 0 处理', () => {
    expect(usageTotalTokens({ input_tokens: 10, output_tokens: 5 } as Anthropic.Usage)).toBe(15);
  });
});

describe('shouldCompact', () => {
  const t = { maxContextSize: 1000, triggerRatio: 0.85, reservedTokens: 100 };
  it('低于比例阈值且剩余充足 → 不压', () => {
    expect(shouldCompact(800, t)).toBe(false);
  });
  it('超过比例阈值 → 压', () => {
    expect(shouldCompact(860, t)).toBe(true);
  });
  it('剩余窗口不足预留量 → 压', () => {
    expect(shouldCompact(905, t)).toBe(true); // 905 + 100 >= 1000
  });
  it('maxContextSize <= 0 → 从不压（避免误判）', () => {
    expect(shouldCompact(999, { ...t, maxContextSize: 0 })).toBe(false);
  });
});

describe('microCompact', () => {
  it('清空较旧 tool_result 正文，保留最近 keepRecent 条', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'OLD-A'.repeat(50)),
      toolResultMsg('b', 'OLD-B'.repeat(50)),
      stored({ role: 'assistant', content: [textBlock('中间')] }, 'assistant'),
      toolResultMsg('c', 'RECENT-C'),
    ];
    const { messages, clearedCount } = microCompact(msgs, 2);
    expect(clearedCount).toBe(2);
    const first = messages[0]!.message.content as Anthropic.ToolResultBlockParam[];
    expect(first[0]!.content).toContain('已清理');
    const last = messages[3]!.message.content as Anthropic.ToolResultBlockParam[];
    expect(last[0]!.content).toBe('RECENT-C');
  });

  it('不改动入参，且重复压缩不重复计数', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'DATA'),
      toolResultMsg('b', 'DATA'),
      toolResultMsg('c', 'DATA'),
    ];
    const before = JSON.stringify(msgs);
    const first = microCompact(msgs, 1);
    expect(JSON.stringify(msgs)).toBe(before);
    const second = microCompact(first.messages, 1);
    expect(second.clearedCount).toBe(0);
  });

  it('缓存冷 gate：缓存仍热时跳过改写（clearedCount 0，原样返回）', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'OLD-A'.repeat(50)),
      toolResultMsg('b', 'OLD-B'.repeat(50)),
      toolResultMsg('c', 'RECENT'),
    ];
    const now = 1_000_000_000_000;
    // 上次活动就在 1 分钟前 → 缓存热 → 跳过
    const hot = microCompact(msgs, 1, { lastActivityMs: now - 60_000, nowMs: now });
    expect(hot.clearedCount).toBe(0);
    expect(hot.messages).toBe(msgs); // 原样返回同引用
  });

  it('缓存冷 gate：距上次活动超阈值时照常改写', () => {
    const msgs: StoredMessage[] = [
      toolResultMsg('a', 'OLD-A'.repeat(50)),
      toolResultMsg('b', 'OLD-B'.repeat(50)),
      toolResultMsg('c', 'RECENT'),
    ];
    const now = 1_000_000_000_000;
    // 上次活动在 2 小时前 → 缓存冷 → 照常清理旧 tool_result
    const cold = microCompact(msgs, 1, { lastActivityMs: now - 2 * 60 * 60 * 1000, nowMs: now });
    expect(cold.clearedCount).toBe(2);
  });

  it('不传 cacheGate 时无条件改写（溢出保命路径）', () => {
    const msgs: StoredMessage[] = [toolResultMsg('a', 'DATA'), toolResultMsg('b', 'DATA'), toolResultMsg('c', 'X')];
    const r = microCompact(msgs, 1);
    expect(r.clearedCount).toBe(2);
  });
});

describe('fullCompact', () => {
  it('把较旧对话替换为模型摘要 + 保留最近消息', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('摘要：用户建了文件 X，代号 ORION。')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '建文件' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('好的')] }, 'assistant'),
      stored({ role: 'user', content: '代号 ORION' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('记住了')] }, 'assistant'),
      stored({ role: 'user', content: '最近1' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, 'assistant'),
      stored({ role: 'user', content: '最近3' }, 'user'),
    ];
    const out = await fullCompact(provider, msgs, 2);
    expect(out[0]!.origin).toBe('compaction_summary');
    expect(out[0]!.message.content).toContain('早期对话摘要');
    expect(out[0]!.message.content).toContain('ORION');
    expect(out.at(-1)!.message.content).toBe('最近3');
  });

  it('切点安全：遇 tool_result 边界往后挪，不产生孤儿 tool_result', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要正文')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始任务' }, 'user'),
      stored({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] }, 'assistant'),
      stored({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] }, 'tool'),
      stored({ role: 'assistant', content: [textBlock('读完了')] }, 'assistant'),
      stored({ role: 'user', content: '继续' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('好')] }, 'assistant'),
    ];
    // keepRecent=4 → desired cutoff = 2，正落在 tool_result 上 → safeCutoff 挪到 3
    const out = await fullCompact(provider, msgs, 4);
    const orphan = out.some(
      (sm) =>
        sm.message.role === 'user' &&
        Array.isArray(sm.message.content) &&
        sm.message.content.some((b) => b.type === 'tool_result'),
    );
    expect(orphan).toBe(false); // tool_result 已随其 tool_use 一起被摘要吞掉
    expect(out[0]!.message.content).toContain('早期对话摘要');
  });

  it('历史过短时原样返回', async () => {
    const { provider } = makeFakeProvider([]);
    const msgs: StoredMessage[] = [stored({ role: 'user', content: 'hi' }, 'user')];
    const out = await fullCompact(provider, msgs, 6);
    expect(out).toEqual(msgs);
  });

  it('摘要失败时原样返回（不丢历史）', async () => {
    const { provider } = makeFakeProvider([{ throw: new Error('boom') }]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: 'a' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('b')] }, 'assistant'),
      stored({ role: 'user', content: 'c' }, 'user'),
      stored({ role: 'user', content: 'd' }, 'user'),
    ];
    const out = await fullCompact(provider, msgs, 1);
    expect(out).toEqual(msgs);
  });

  it('提供 todos 时把清单拼进摘要尾部', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('好')] }, 'assistant'),
      stored({ role: 'user', content: '最近1' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, 'assistant'),
      stored({ role: 'user', content: '最近3' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近4')] }, 'assistant'),
      stored({ role: 'user', content: '最近5' }, 'user'),
    ];
    const todos = [{ title: '实现登录', status: 'in_progress' }];
    const out = await fullCompact(provider, msgs, 2, todos);
    expect(out[0]!.message.content).toContain('## TODO List');
    expect(out[0]!.message.content).toContain('实现登录');
  });

  it('摘要 prompt 里图片渲染为带 hash 的 marker（不降级成字面 [image]、不内联 base64）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const hash = 'a'.repeat(64);
    const inlineB64 = Buffer.alloc(100, 1).toString('base64'); // 内联小图（无 hash）
    const msgs: StoredMessage[] = [
      imageMsg(`stepref:${hash}`),
      stored({ role: 'assistant', content: [textBlock('收到')] }, 'assistant'),
      imageMsg(inlineB64),
      stored({ role: 'assistant', content: [textBlock('好')] }, 'assistant'),
      stored({ role: 'user', content: '最近1' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, 'assistant'),
    ];
    await fullCompact(provider, msgs, 2);
    const prompt = (streamParams()[0]!['messages'] as { content: string }[])[0]!.content;
    // stepref 图带 hash 前 8 位定位信息；内联小图只标 mediaType
    expect(prompt).toContain(`[image image/png ${hash.slice(0, 8)}]`);
    expect(prompt).toContain('[image image/png]');
    expect(prompt).not.toContain(inlineB64);
  });

  it('传入 model 时摘要调用带 model 覆盖（大小模型协同）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('好')] }, 'assistant'),
      stored({ role: 'user', content: '最近1' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, 'assistant'),
      stored({ role: 'user', content: '最近3' }, 'user'),
    ];
    const out = await fullCompact(provider, msgs, 2, undefined, 'step-flash');
    expect(out[0]!.origin).toBe('compaction_summary');
    expect(streamParams()[0]!['model']).toBe('step-flash');
  });

  it('不传 model 时摘要调用不带 model（行为与之前一致）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('早期摘要')] },
    ]);
    const msgs: StoredMessage[] = [
      stored({ role: 'user', content: '开始' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('好')] }, 'assistant'),
      stored({ role: 'user', content: '最近1' }, 'user'),
      stored({ role: 'assistant', content: [textBlock('最近2')] }, 'assistant'),
      stored({ role: 'user', content: '最近3' }, 'user'),
    ];
    await fullCompact(provider, msgs, 2);
    expect(streamParams()[0]!['model']).toBeUndefined();
  });
});
