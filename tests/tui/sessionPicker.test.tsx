import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SessionPicker } from '../../src/tui/SessionPicker.js';
import type { SessionMeta } from '../../src/session/store.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function meta(id: string, title: string, preview?: string): SessionMeta {
  const now = new Date().toISOString();
  return { id, cwd: 'C:/x', model: 'm', createdAt: now, updatedAt: now, messageCount: 3, title, preview };
}

describe('SessionPicker', () => {
  it('渲染显示各会话标题', () => {
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '第一个会话'), meta('id2', '第二个会话')],
        onSelect: () => {},
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('第一个会话');
    expect(out).toContain('第二个会话');
    expect(out).toContain('选择要恢复的会话');
  });

  it('下箭头 + 回车选中第二条，onSelect 带正确 id', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\u001B[B'); // 下箭头
    await delay();
    stdin.write('\r'); // 回车
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id2');
  });

  it('回车（不移动）选中第一条', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id1');
  });

  it('Esc 触发 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\u001B'); // Esc
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('输入过滤标题：只显示匹配项', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '第一个会话'), meta('id2', '第二个会话')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('第二');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('第二个会话');
    expect(out).not.toContain('第一个会话');
  });

  it('preview 参与搜索匹配', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'aaa', '讨论 prompt cache 的会话'), meta('id2', 'bbb', '无关内容')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('cache');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('aaa');
    expect(out).not.toContain('bbb');
  });

  it('多词空格 AND：两个词都命中才保留', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [
          meta('id1', 'foo 项目', '讲了 bar 方案'),
          meta('id2', 'foo 其他', '没有第二个词'),
          meta('id3', 'bar 开头', '缺少目标词'),
        ],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('foo bar');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('foo 项目');
    expect(out).not.toContain('foo 其他');
    expect(out).not.toContain('bar 开头');
  });

  it('无匹配时显示空态提示', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('zzz');
    await delay();
    expect(lastFrame() ?? '').toContain('无匹配的会话');
  });

  it('过滤后回车选中匹配项', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'alpha'), meta('id2', 'beta')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('beta');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id2');
  });

  it('Backspace 删除搜索词字符，恢复全量列表', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'alpha'), meta('id2', 'beta')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('beta');
    await delay();
    expect(lastFrame() ?? '').not.toContain('alpha');
    for (let i = 0; i < 4; i++) stdin.write('\x7f'); // Backspace ×4 清空 query
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });
});
