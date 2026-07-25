import React from 'react';
import chalk from 'chalk';
import { Box, Static, Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MessageItem, MessageList, ThinkingPreview, countSettledItems } from '../../src/tui/MessageList.js';
import type { DisplayItem } from '../../src/tui/types.js';
import type { WorkflowPanelState } from '../../src/tui/WorkflowPanel.js';

const user = (text: string): DisplayItem => ({ kind: 'user', text });
const assistant = (text: string): DisplayItem => ({ kind: 'assistant', text });
const note = (text: string): DisplayItem => ({ kind: 'note', text });
const thinking = (text: string): DisplayItem => ({ kind: 'thinking', text });
const tool = (id: string, status: 'running' | 'ok' | 'error', workflow?: WorkflowPanelState): DisplayItem => ({
  kind: 'tool',
  id,
  name: 'bash',
  input: {},
  status,
  startedAt: Date.now(),
  ...(workflow !== undefined ? { workflow } : {}),
});
const wfState = (stepStatus: 'pending' | 'running' | 'done'): WorkflowPanelState => ({
  name: 'wf',
  steps: [{ kind: 'agent', label: 's1', status: stepStatus, members: [] }],
});

describe('countSettledItems 定稿判定', () => {
  it('非 busy 时全部定稿（含 abort 残留的 running 工具，此后不会再有更新）', () => {
    const items = [user('u1'), assistant('a1'), tool('t1', 'running'), note('n1')];
    expect(countSettledItems(items, false)).toBe(items.length);
  });

  it('busy 时最后一条 streaming 中的 assistant 留动态区', () => {
    const items = [user('u1'), assistant('流式中')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时最后一条 assistant 后面即使跟了工具也仍留动态区（transient 高亮态未完成）', () => {
    const items = [user('u1'), assistant('a1'), tool('t1', 'ok')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 running 工具及其后的条目全部留动态区', () => {
    const items = [user('u1'), tool('t1', 'running'), note('n1')];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时 workflow 面板运行中的工具条目留动态区', () => {
    const items = [user('u1'), tool('t1', 'running', wfState('running'))];
    expect(countSettledItems(items, true)).toBe(1);
  });

  it('busy 时终态工具（含 workflow 已完成）可以定稿', () => {
    const items = [user('u1'), tool('t1', 'ok', wfState('done')), tool('t2', 'error')];
    expect(countSettledItems(items, true)).toBe(items.length);
  });

  it('busy 时无 assistant 且无 running 工具：全部定稿', () => {
    const items = [user('u1'), note('n1'), tool('t1', 'ok')];
    expect(countSettledItems(items, true)).toBe(items.length);
  });

  it('busy 时 thinking 定稿条目可定稿（落成条目即完整，不再有更新）', () => {
    const items = [user('u1'), thinking('想完了'), assistant('流式中')];
    // 最后一条 streaming assistant 留动态区，thinking 随前缀定稿
    expect(countSettledItems(items, true)).toBe(2);
  });

  it('busy 时取 streaming assistant 与 running 工具中更靠前的下标', () => {
    const items = [user('u1'), tool('t1', 'running'), assistant('a1')];
    expect(countSettledItems(items, true)).toBe(1);
  });
});

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('user 条目配色', () => {
  // vitest worker 非 TTY，chalk 默认 level 0 不输出 ANSI；这里临时开启 16 色再断言
  let prevLevel: number;
  beforeEach(() => {
    prevLevel = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = prevLevel;
  });

  it('user 条目正文带黄色 ANSI 码，› 前缀保持蓝色加粗', () => {
    const { lastFrame } = render(<MessageList items={[user('用户问题')]} expanded={false} />);
    const out = lastFrame() ?? '';
    // 正文黄色（ANSI 33m），直接包在正文外
    expect(out).toContain('\x1b[33m用户问题');
    // 前缀仍是蓝色（34m）加粗（1m），作为视觉锚点不变
    expect(out).toContain('› ');
    expect(out).toMatch(/\x1b\[(?:1m\x1b\[34m|34m\x1b\[1m)›/);
    // 去掉 ANSI 后内容本身完整
    expect(stripAnsi(out)).toContain('› 用户问题');
  });

  it('assistant 等其他条目不带黄色 ANSI 码', () => {
    const { lastFrame } = render(<MessageList items={[assistant('AI 回答')]} expanded={false} />);
    expect(lastFrame() ?? '').not.toContain('\x1b[33m');
  });
});

/** 模拟 App 根布局：单 <Static>（welcome 首条 + 定稿前缀）+ 动态区 MessageList。 */
function Harness({
  items,
  busy,
  epoch = 0,
}: {
  items: DisplayItem[];
  busy: boolean;
  epoch?: number;
}): React.ReactElement {
  const settledCount = countSettledItems(items, busy);
  const staticEntries: Array<{ kind: 'welcome' } | DisplayItem> = [
    { kind: 'welcome' },
    ...items.slice(0, settledCount),
  ];
  return (
    <Box flexDirection="column">
      <Static key={epoch} items={staticEntries}>
        {(entry, i) =>
          entry.kind === 'welcome' ? (
            <Text key="welcome">WELCOME-BANNER</Text>
          ) : (
            <MessageItem key={i} item={entry} expanded={false} />
          )
        }
      </Static>
      <MessageList items={items.slice(settledCount)} expanded={false} busy={busy} />
    </Box>
  );
}

/** 断言 out 中 keys 全部出现且按给定顺序。 */
function expectInOrder(out: string, keys: string[]): void {
  let prev = -1;
  for (const k of keys) {
    const idx = out.indexOf(k);
    expect(idx, `帧输出缺少 ${k}`).toBeGreaterThan(-1);
    expect(idx, `${k} 顺序错误`).toBeGreaterThan(prev);
    prev = idx;
  }
}

describe('Static 挂载后的帧输出', () => {
  it('全部定稿时：welcome + 全部历史按序出现在帧中，动态区为空', () => {
    const items = [user('问题一'), assistant('回答一'), note('提示一')];
    const { lastFrame } = render(<Harness items={items} busy={false} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '回答一', '提示一']);
  });

  it('busy 流式中：定稿前缀与在途尾部都可见且顺序正确', () => {
    const items = [user('问题一'), assistant('回答一'), user('问题二'), assistant('流式中')];
    const { lastFrame } = render(<Harness items={items} busy={true} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '回答一', '问题二', '流式中']);
  });

  it('流式结束（busy 转 false）后：全文按序保留在帧中', () => {
    const streaming = [user('问题一'), assistant('流式中')];
    const done = [user('问题一'), assistant('流式完毕'), note('回合结束')];
    const { lastFrame, rerender } = render(<Harness items={streaming} busy={true} />);
    rerender(<Harness items={done} busy={false} />);
    const out = lastFrame() ?? '';
    expectInOrder(out, ['WELCOME-BANNER', '问题一', '流式完毕', '回合结束']);
  });

  it('条目定稿前后的关键文案与顺序，和纯 MessageList 渲染一致', () => {
    const items = [user('问题一'), assistant('回答一'), note('提示一')];
    const plain = render(<MessageList items={items} expanded={false} busy={false} />).lastFrame() ?? '';
    const mounted = render(<Harness items={items} busy={false} />).lastFrame() ?? '';
    for (const k of ['问题一', '回答一', '提示一']) {
      expect(plain).toContain(k);
      expect(mounted).toContain(k);
    }
    expectInOrder(mounted, ['问题一', '回答一', '提示一']);
  });

  it('会话重置（epoch 重挂载）后：旧静态内容被丢弃，新条目正常进 Static', () => {
    const old = [note('旧会话提示')];
    const fresh = [note('新会话已开始')];
    const { lastFrame, rerender } = render(<Harness items={old} busy={false} epoch={0} />);
    rerender(<Harness items={fresh} busy={false} epoch={1} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('新会话已开始');
    expect(out).not.toContain('旧会话提示');
  });
});

describe('thinking 条目渲染', () => {
  it('≤5 行全部展示，不折叠', () => {
    const text = ['第一行', '第二行', '第三行', '第四行', '第五行'].join('\n');
    const { lastFrame } = render(<MessageList items={[thinking(text)]} expanded={false} />);
    const out = stripAnsi(lastFrame() ?? '');
    for (const l of ['第一行', '第二行', '第三行', '第四行', '第五行']) {
      expect(out).toContain(l);
    }
    expect(out).not.toContain('共');
  });

  it('>5 行折叠：只显示前 5 行 + 「…（共 N 行）」', () => {
    const text = Array.from({ length: 8 }, (_, i) => `第${i + 1}行`).join('\n');
    const { lastFrame } = render(<MessageList items={[thinking(text)]} expanded={false} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('第5行');
    expect(out).not.toContain('第6行');
    expect(out).toContain('…（共 8 行）');
  });
});

describe('thinking 条目配色（暗色斜体）', () => {
  // vitest worker 非 TTY，chalk 默认 level 0 不输出 ANSI；这里临时开启 16 色再断言
  let prevLevel: number;
  beforeEach(() => {
    prevLevel = chalk.level;
    chalk.level = 1;
  });
  afterEach(() => {
    chalk.level = prevLevel;
  });

  it('定稿块带灰色（90m）与斜体（3m）ANSI 码', () => {
    const { lastFrame } = render(<MessageList items={[thinking('想了一下')]} expanded={false} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('\x1b[90m');
    expect(out).toContain('\x1b[3m');
    expect(stripAnsi(out)).toContain('想了一下');
  });
});

describe('ThinkingPreview 流式预览', () => {
  it('显示「思考中…」+ 思考文本（短文本全显）', () => {
    const { lastFrame } = render(<ThinkingPreview text={'推理中'} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('思考中…');
    expect(out).toContain('推理中');
  });

  it('长文本只保留尾部 3 行（滚动预览）', () => {
    const text = ['AA', 'BB', 'CC', 'DD', 'EE', 'FF', 'GG', 'HH', 'II', 'JJ'].join('\n');
    const { lastFrame } = render(<ThinkingPreview text={text} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('思考中…');
    for (const l of ['HH', 'II', 'JJ']) expect(out).toContain(l);
    expect(out).not.toContain('GG');
    expect(out).not.toContain('AA');
  });
});
