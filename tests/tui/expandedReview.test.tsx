import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ExpandedReview, collectExpandable } from '../../src/tui/ExpandedReview.js';
import { hasCollapsedBody } from '../../src/tui/ToolCall.js';
import type { DisplayItem } from '../../src/tui/types.js';

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: 'tool',
  id: 't1',
  name: 'bash',
  input: { command: 'ls' },
  status: 'ok',
  ...over,
});

describe('hasCollapsedBody（折叠态是否藏了内容）', () => {
  it('成功 + 普通输出：整段折叠成一行提示 → true', () => {
    expect(hasCollapsedBody(tool({ result: 'line1\nline2' }))).toBe(true);
  });

  it('成功 + diff 结果（首行 +N/-M 摘要）：折叠态已显示主体 → false', () => {
    expect(hasCollapsedBody(tool({ result: '+3 -1 src/a.ts\n  10 +added' }))).toBe(false);
  });

  it('错误 + 输出 ≤ 4 行：折叠态已完整显示 → false', () => {
    expect(hasCollapsedBody(tool({ status: 'error', result: 'e1\ne2\ne3\ne4' }))).toBe(false);
  });

  it('错误 + 输出 > 4 行：预览被截断 → true', () => {
    expect(hasCollapsedBody(tool({ status: 'error', result: 'e1\ne2\ne3\ne4\ne5' }))).toBe(true);
  });

  it('running / 无结果体 → false', () => {
    expect(hasCollapsedBody(tool({ status: 'running' }))).toBe(false);
    expect(hasCollapsedBody(tool({ result: '' }))).toBe(false);
    expect(hasCollapsedBody(tool({}))).toBe(false);
  });
});

describe('collectExpandable（最近可展开条目收集）', () => {
  it('只收工具条目，按时间正序返回', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u' },
      tool({ id: 'a', result: 'ra' }),
      { kind: 'assistant', text: 'a' },
      tool({ id: 'b', result: 'rb' }),
    ];
    const got = collectExpandable(items);
    expect(got.map((g) => g.id)).toEqual(['a', 'b']);
  });

  it('从最新往回最多收 max 条', () => {
    const items: DisplayItem[] = Array.from({ length: 15 }, (_, i) =>
      tool({ id: `t${i}`, result: `r${i}` }),
    );
    const got = collectExpandable(items, 3);
    expect(got.map((g) => g.id)).toEqual(['t12', 't13', 't14']);
  });
});

describe('ExpandedReview 展开预览层', () => {
  it('无可展开条目不渲染', () => {
    const { lastFrame } = render(
      React.createElement(ExpandedReview, { items: [{ kind: 'user', text: 'u' }] }),
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('渲染标题 + 展开态完整输出（折叠提示消失）', () => {
    const items: DisplayItem[] = [tool({ result: '第一行输出\n第二行输出\n第三行输出' })];
    const { lastFrame } = render(React.createElement(ExpandedReview, { items }));
    const out = lastFrame() ?? '';
    expect(out).toContain('展开预览');
    expect(out).toContain('第一行输出');
    expect(out).toContain('第三行输出');
    expect(out).not.toContain('行输出 · Ctrl+O 展开');
  });
});
