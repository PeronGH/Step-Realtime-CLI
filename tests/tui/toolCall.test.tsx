import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { ToolCall } from '../../src/tui/ToolCall.js';
import type { DisplayItem } from '../../src/tui/types.js';

function toolItem(over: Partial<Extract<DisplayItem, { kind: 'tool' }>>): Extract<
  DisplayItem,
  { kind: 'tool' }
> {
  return { kind: 'tool', id: 't1', name: 'list_dir', input: {}, status: 'ok', ...over };
}

const bigResult = Array.from({ length: 12 }, (_, i) => `line${i + 1}`).join('\n');

describe('ToolCall 折叠/展开', () => {
  it('skill 工具标题带上技能名（否则多次激活的卡片长得一模一样）', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({ name: 'skill', input: { skill: 'pkm-vault-ops' } }),
        expanded: false,
      }),
    );
    expect(lastFrame() ?? '').toContain('pkm-vault-ops');
    unmount();
  });

  it('常规工具仍按 path/command 取摘要', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ToolCall, {
        item: toolItem({ name: 'read', input: { path: 'src/tui/ToolCall.tsx' } }),
        expanded: false,
      }),
    );
    expect(lastFrame() ?? '').toContain('src/tui/ToolCall.tsx');
    unmount();
  });

  it('成功且有输出，折叠态只显示「N 行输出 · Ctrl+O 展开」提示，不显示正文', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: bigResult }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('12 行输出');
    expect(frame).toContain('Ctrl+O 展开');
    expect(frame).not.toContain('line7'); // 正文未展开
  });

  it('展开态显示完整正文', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: bigResult }), expanded: true }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('line12');
  });

  it('出错时折叠态显示前几行预览 + 剩余行提示', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: toolItem({ status: 'error', result: bigResult }),
        expanded: false,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('line1');
    expect(frame).toContain('还有'); // 「… 还有 N 行 · Ctrl+O 展开」
    expect(frame).toContain('Ctrl+O 展开');
  });

  it('无输出的工具不显示结果体', () => {
    const { lastFrame } = render(
      React.createElement(ToolCall, { item: toolItem({ result: '' }), expanded: false }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('list_dir');
    expect(frame).not.toContain('行输出');
  });
});
