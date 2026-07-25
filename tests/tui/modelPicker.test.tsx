import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker, type ModelPickerItem } from '../../src/tui/ModelPicker.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc Backspace（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);

function item(alias: string, label?: string, channel = 'stepfun', current = false): ModelPickerItem {
  return { alias, label: label ?? alias, channel, current };
}

const three = (): ModelPickerItem[] => [
  item('alpha', 'Alpha Model', 'stepfun'),
  item('beta', 'Beta Model', 'gw', true),
  item('gamma', 'Gamma Model', 'anthropic'),
];

function renderPicker(items: ModelPickerItem[], onSelect = () => {}, hasHistory = false) {
  return render(React.createElement(ModelPicker, { items, hasHistory, onSelect }));
}

describe('ModelPicker', () => {
  it('渲染显示各模型显示名与渠道名、标题与键位提示', () => {
    const { lastFrame } = renderPicker(three());
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
    expect(out).toContain('Gamma Model');
    expect(out).toContain('gw');
    expect(out).toContain('anthropic');
    expect(out).toContain('选择模型');
    expect(out).toContain('Enter 切换');
  });

  it('当前项显示 ← 当前 后缀，且整个列表只出现一次', () => {
    const { lastFrame } = renderPicker(three());
    const out = lastFrame() ?? '';
    expect(out.match(/← 当前/g)).toHaveLength(1);
    expect(out).toMatch(/Beta Model\s+gw ← 当前/);
  });

  it('会话已有历史时顶部显示 prompt cache 警告，无历史不显示', () => {
    const withHistory = renderPicker(three(), () => {}, true);
    expect(withHistory.lastFrame() ?? '').toContain('prompt cache');
    withHistory.unmount();
    const noHistory = renderPicker(three(), () => {}, false);
    expect(noHistory.lastFrame() ?? '').not.toContain('prompt cache');
  });

  it('↓ 移动 + Enter 选中第二项，onSelect 带正确别名', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('beta');
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍选中第一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('alpha');
  });

  it('↓ 在底部 clamp 不循环：连按多次后 Enter 仍选中最后一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    for (let i = 0; i < 5; i++) stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('gamma');
  });

  it('输入过滤：匹配别名 / 显示名 / 渠道名', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    // 按渠道名过滤
    stdin.write('gw');
    await delay();
    let out = lastFrame() ?? '';
    expect(out).toContain('Beta Model');
    expect(out).not.toContain('Alpha Model');
    // 清空后按显示名过滤
    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    await delay();
    stdin.write('Gamma');
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Gamma Model');
    expect(out).not.toContain('Beta Model');
  });

  it('Backspace 删除过滤字，恢复全量列表', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write('beta');
    await delay();
    expect(lastFrame() ?? '').not.toContain('Alpha Model');
    for (let i = 0; i < 4; i++) stdin.write(BACKSPACE);
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
  });

  it('过滤后 Enter 选中匹配项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('gamma');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('gamma');
  });

  it('Esc 有过滤词时先清词（不取消），再按 Esc 才 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('beta');
    await delay();
    stdin.write(ESC); // 第一次 Esc：清过滤词
    await delay();
    expect(onSelect).not.toHaveBeenCalled();
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Gamma Model');
    stdin.write(ESC); // 第二次 Esc：取消
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('无匹配时显示空态提示', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write('zzz');
    await delay();
    expect(lastFrame() ?? '').toContain('无匹配的模型');
  });

  it('label 缺省时用别名做左列显示名', () => {
    const { lastFrame } = renderPicker([item('step-3.7-flash')]);
    expect(lastFrame() ?? '').toContain('step-3.7-flash');
  });
});
