import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { UndoPicker, type UndoPickerItem } from '../../src/tui/UndoPicker.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);

const three = (): UndoPickerItem[] => [
  { count: 1, label: '最近的问题', detail: '5 分钟前' },
  { count: 2, label: '倒数第二轮', detail: '10 分钟前' },
  { count: 3, label: '最早的一轮', detail: '1 小时前' },
];

function renderPicker(items: UndoPickerItem[], onSelect: (count: number | null) => void = () => {}) {
  return render(React.createElement(UndoPicker, { items, onSelect }));
}

describe('UndoPicker', () => {
  it('渲染显示各轮摘要与时间、标题与键位提示', () => {
    const { lastFrame } = renderPicker(three());
    const out = lastFrame() ?? '';
    expect(out).toContain('最近的问题');
    expect(out).toContain('倒数第二轮');
    expect(out).toContain('最早的一轮');
    expect(out).toContain('5 分钟前');
    expect(out).toContain('1 小时前');
    expect(out).toContain('撤销到哪一轮');
    expect(out).toContain('Enter 撤销到该轮');
  });

  it('空列表显示空态提示', () => {
    const { lastFrame } = renderPicker([]);
    expect(lastFrame() ?? '').toContain('没有可撤销的轮');
  });

  it('默认选中第一项（最近一轮），Enter 回传 count=1', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('↓ 移动 + Enter 选中第二项，回传其 count', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍选中第一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it('↓ 在底部 clamp 不循环：连按多次后 Enter 仍选中最后一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    for (let i = 0; i < 5; i++) stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith(3);
  });

  it('Esc 取消，回传 null', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(ESC);
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
