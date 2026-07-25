import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PromptInput } from '../../src/tui/PromptInput.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PromptInput 斜杠命令补全', () => {
  it('输入 / 显示命令下拉', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('/help');
    expect(out).toContain('/plan');
  });

  it('输入 /pl 过滤出相关命令', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/pl', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('/plan');
    expect(out).not.toContain('/yolo');
  });

  it('输入带空格不显示下拉（进入参数模式）', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/plan now', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    // 下拉框的选中标记 + 描述文本不出现（命令下拉的 describe）
    expect(out).not.toContain('切换计划模式');
  });

  it('非斜杠输入不显示下拉', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: 'hello', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('/help —');
  });

  it('busy 时也显示下拉（只读命令可即时执行，菜单不锁）', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: true }),
    );
    const out = lastFrame() ?? '';
    // busy 时命令下拉照常显示（B 方案后 busy 可执行只读命令，菜单锁定是旧遗留）
    expect(out).toContain('› /help');
    expect(out).toContain('显示可用命令');
  });

  it('busy 时输入框下方显示随机提示行', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: true }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('提示：');
  });

  it('空闲时不显示提示行', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('提示：');
  });

  it('exitPrimed 时显示「再按一次 Ctrl+C 退出」', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: false, exitPrimed: true }),
    );
    expect(lastFrame() ?? '').toContain('再按一次 Ctrl+C 退出');
  });

  it('busy 时 exitPrimed 提示不显示', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: true, exitPrimed: true }),
    );
    expect(lastFrame() ?? '').not.toContain('再按一次 Ctrl+C 退出');
  });
});

describe('PromptInput 斜杠菜单窗口滚动', () => {
  // SLASH_COMMANDS 共 21 条，窗口 6 条：初始窗口为 help..plan（前 6 条）
  const pressDown = async (stdin: { write: (s: string) => void }, n: number): Promise<void> => {
    for (let i = 0; i < n; i += 1) {
      stdin.write('\x1B[B'); // ↓
      await delay(20);
    }
  };

  it('↓ 选中第 5/6/7 条时窗口跟滚，滚动指示序号正确', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    // 初始：首条选中，窗口显示前 6 条，指示 (1/21)
    let out = lastFrame() ?? '';
    expect(out).toContain('/help');
    expect(out).not.toContain('/provider'); // 第 7 条未进窗口
    expect(out).toContain('(1/21)');

    await pressDown(stdin, 4); // → 第 5 条 /auto
    out = lastFrame() ?? '';
    expect(out).toContain('(5/21)');
    expect(out).not.toContain('/help'); // 首条滚出窗口
    expect(out).toContain('/provider'); // 第 7 条滚入窗口

    await pressDown(stdin, 1); // → 第 6 条 /plan
    out = lastFrame() ?? '';
    expect(out).toContain('(6/21)');
    expect(out).toContain('/goal'); // 第 8 条滚入窗口

    await pressDown(stdin, 1); // → 第 7 条 /provider
    out = lastFrame() ?? '';
    expect(out).toContain('(7/21)');
    expect(out).toContain('/provider');
    expect(out).not.toContain('/model'); // 第 2 条也滚出窗口
  });

  it('↓ 到底再 ↓ 回卷首条，窗口甩回顶部', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    await pressDown(stdin, 20); // → 末条 /exit
    let out = lastFrame() ?? '';
    expect(out).toContain('(21/21)');
    expect(out).toContain('/exit');
    expect(out).not.toContain('/help');

    await pressDown(stdin, 1); // 回卷到首条
    out = lastFrame() ?? '';
    expect(out).toContain('(1/21)');
    expect(out).toContain('/help');
    expect(out).not.toContain('/exit');
    // 21 次按键 × 20ms 延迟在套件高负载下会逼近默认 5s 超时，放宽到 15s
  }, 15_000);

  it('↑ 到顶再 ↑ 回卷末条，窗口甩到底部', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    stdin.write('\x1B[A'); // ↑ → 回卷到末条
    await delay(20);
    const out = lastFrame() ?? '';
    expect(out).toContain('(21/21)');
    expect(out).toContain('/exit');
    expect(out).not.toContain('/help');
  });

  it('匹配总数 ≤ 窗口时不显示滚动指示', async () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/pl', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('/plan');
    expect(out).not.toMatch(/\(\d+\/\d+\)/);
  });
});

describe('PromptInput 按键导航与编辑（自研输入组件）', () => {
  // 受控 harness：value 由 useState 持有，spy 记录每次 onChange 后的最新文本
  function Harness({
    initial = '',
    history = [],
    spy,
  }: {
    initial?: string;
    history?: string[];
    spy: (v: string) => void;
  }): React.ReactElement {
    const [v, setV] = React.useState(initial);
    return React.createElement(PromptInput, {
      value: v,
      onChange: (nv: string) => {
        spy(nv);
        setV(nv);
      },
      onSubmit: () => {},
      busy: false,
      history,
    });
  }

  const setup = (initial = '', history: string[] = []) => {
    const state = { value: initial };
    const inst = render(React.createElement(Harness, { initial, history, spy: (v: string) => (state.value = v) }));
    return { ...inst, state };
  };

  const type = async (stdin: { write: (s: string) => void }, s: string): Promise<void> => {
    stdin.write(s);
    await delay(30);
  };

  it('Home 的四种兼容序列都把光标移到行首', async () => {
    for (const seq of ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']) {
      const { stdin, state, unmount } = setup('abc');
      await delay(20);
      await type(stdin, seq); // Home → 行首
      await type(stdin, 'X'); // 行首插入
      expect(state.value).toBe('Xabc');
      unmount();
    }
  });

  it('End 的四种兼容序列都把光标移到行尾', async () => {
    for (const seq of ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']) {
      const { stdin, state, unmount } = setup('abc');
      await delay(20);
      await type(stdin, '\x1b[H'); // 先到行首
      await type(stdin, seq); // End → 回行尾
      await type(stdin, 'Y');
      expect(state.value).toBe('abcY');
      unmount();
    }
  });

  it('Ctrl+A / Ctrl+E 移到行首 / 行尾', async () => {
    const { stdin, state } = setup('abc');
    await delay(20);
    await type(stdin, '\x01'); // Ctrl+A
    await type(stdin, 'X');
    expect(state.value).toBe('Xabc');
    await type(stdin, '\x05'); // Ctrl+E
    await type(stdin, 'Y');
    expect(state.value).toBe('XabcY');
  });

  it('Ctrl+← / Alt+B 按词左移，Ctrl+→ / Alt+F 按词右移', async () => {
    const { stdin, state } = setup('foo bar');
    await delay(20);
    await type(stdin, '\x1b[1;5D'); // Ctrl+← → 词首
    await type(stdin, 'X');
    expect(state.value).toBe('foo Xbar');
    await type(stdin, '\x1bb'); // Alt+B → 前一词首
    await type(stdin, 'Y');
    expect(state.value).toBe('foo YXbar');
    await type(stdin, '\x01'); // 回行首
    await type(stdin, '\x1b[1;5C'); // Ctrl+→ → 词尾
    await type(stdin, 'Z');
    expect(state.value).toBe('fooZ YXbar');
    await type(stdin, '\x1bf'); // Alt+F → 下一词尾
    await type(stdin, 'W');
    expect(state.value).toBe('fooZ YXbarW');
  });

  it('Ctrl+W 删前词、Ctrl+U 删到行首、Ctrl+K 删到行尾', async () => {
    const { stdin, state } = setup('foo bar');
    await delay(20);
    await type(stdin, '\x17'); // Ctrl+W
    expect(state.value).toBe('foo ');
    await type(stdin, '\x15'); // Ctrl+U
    expect(state.value).toBe('');
    await type(stdin, 'foo bar');
    await type(stdin, '\x01'); // Home
    await type(stdin, '\x0b'); // Ctrl+K
    expect(state.value).toBe('');
  });

  it('裸 ←/→ 单步移动，Backspace/Delete 在光标处删除', async () => {
    const { stdin, state } = setup('abc');
    await delay(20);
    await type(stdin, '\x1b[D'); // ←
    await type(stdin, '\x7f'); // Backspace 删 b
    expect(state.value).toBe('ac');
    await type(stdin, '\x1b[D'); // ← 到行首（原光标 1 → 0）
    await type(stdin, '\x1b[3~'); // Delete 删 a
    expect(state.value).toBe('c');
  });

  it('斜杠菜单可见时 Home/编辑键不干扰菜单选择（仲裁回归）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    stdin.write('\x1B[B'); // ↓ ×2 → 第 3 条
    await delay(30);
    stdin.write('\x1B[B');
    await delay(30);
    expect(lastFrame() ?? '').toContain('(3/21)');
    await type(stdin, '\x1b[H'); // Home：归输入框光标，不动菜单
    await type(stdin, '\x1b[8~'); // End：同样不动菜单
    expect(lastFrame() ?? '').toContain('(3/21)');
    stdin.write('\x1B[B'); // ↓ 继续从第 3 条往后走
    await delay(30);
    expect(lastFrame() ?? '').toContain('(4/21)');
  });

  it('历史回溯后编辑键生效：Up 取历史 → Home → 行首插入', async () => {
    const { stdin, state } = setup('draft', ['oldcmd']);
    await delay(20);
    stdin.write('\x1B[A'); // ↑ 回溯历史
    await delay(30);
    expect(state.value).toBe('oldcmd');
    await type(stdin, '\x1b[H'); // Home → 行首
    await type(stdin, 'X');
    expect(state.value).toBe('Xoldcmd');
  });

  it('历史回溯后光标在行尾（外部变更光标归尾）', async () => {
    const { stdin, state } = setup('', ['oldcmd']);
    await delay(20);
    stdin.write('\x1B[A'); // ↑ 回溯历史
    await delay(30);
    await type(stdin, 'X'); // 直接追加，证明光标在行尾
    expect(state.value).toBe('oldcmdX');
  });
});
