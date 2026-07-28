import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { PromptInput } from '../../src/tui/PromptInput.js';
import { SLASH_COMMANDS } from '../../src/tui/commands.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 命令总数与位置一律从 SLASH_COMMANDS 派生——新增命令（如 /think）不再顶爆硬编码序号
const TOTAL = SLASH_COMMANDS.length;
const CMD = (i: number): string => `/${SLASH_COMMANDS[i]!.name}`;
const IND = (n: number): string => `(${n}/${TOTAL})`;

describe('PromptInput 斜杠命令补全', () => {
  it('输入 / 显示命令下拉', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain(CMD(0)); // /help
    expect(out).toContain(CMD(2)); // 第 3 条在初始窗口内
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

  it('busy 时输入框内不再显示 tip 行（tip 已移到独立的 WorkingStatus 状态块）', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: true }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('提示：');
  });

  it('空闲时不显示提示行', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('提示：');
  });

  it('空输入时 placeholder 完整可读（光标反色独立空格，不吃掉 CJK 首字）', () => {
    const idle = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    // 首字「输」不能被反色块吞掉（旧实现反色 placeholder[0]，全宽字符被吃后显示成花屏）
    expect(idle.lastFrame() ?? '').toContain('输入指令，回车发送');
    idle.unmount();

    const busyFrame = render(
      React.createElement(PromptInput, { value: '', onChange: () => {}, onSubmit: () => {}, busy: true }),
    );
    expect(busyFrame.lastFrame() ?? '').toContain('思考中…输入将加入发送队列');
    busyFrame.unmount();
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
  // SLASH_COMMANDS 窗口 6 条：初始窗口为前 6 条（help..第 6 条）
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
    // 初始：首条选中，窗口显示前 6 条
    let out = lastFrame() ?? '';
    expect(out).toContain(CMD(0));
    expect(out).not.toContain(CMD(6)); // 第 7 条未进窗口
    expect(out).toContain(IND(1));

    await pressDown(stdin, 4); // → 第 5 条
    out = lastFrame() ?? '';
    expect(out).toContain(IND(5));
    expect(out).not.toContain(CMD(0)); // 首条滚出窗口
    expect(out).toContain(CMD(6)); // 第 7 条滚入窗口

    await pressDown(stdin, 1); // → 第 6 条
    out = lastFrame() ?? '';
    expect(out).toContain(IND(6));
    expect(out).toContain(CMD(7)); // 第 8 条滚入窗口

    await pressDown(stdin, 1); // → 第 7 条
    out = lastFrame() ?? '';
    expect(out).toContain(IND(7));
    expect(out).toContain(CMD(6));
    expect(out).not.toContain(CMD(1)); // 第 2 条也滚出窗口
  });

  it('↓ 到底再 ↓ 回卷首条，窗口甩回顶部', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    await pressDown(stdin, TOTAL - 1); // → 末条
    let out = lastFrame() ?? '';
    expect(out).toContain(IND(TOTAL));
    expect(out).toContain(CMD(TOTAL - 1));
    expect(out).not.toContain(CMD(0));

    await pressDown(stdin, 1); // 回卷到首条
    out = lastFrame() ?? '';
    expect(out).toContain(IND(1));
    expect(out).toContain(CMD(0));
    expect(out).not.toContain(CMD(TOTAL - 1));
    // 按键次数 × 20ms 延迟在套件高负载下会逼近默认 5s 超时，放宽到 15s
  }, 15_000);

  it('↑ 到顶再 ↑ 回卷末条，窗口甩到底部', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(PromptInput, { value: '/', onChange: () => {}, onSubmit: () => {}, busy: false }),
    );
    await delay(20);
    stdin.write('\x1B[A'); // ↑ → 回卷到末条
    await delay(20);
    const out = lastFrame() ?? '';
    expect(out).toContain(IND(TOTAL));
    expect(out).toContain(CMD(TOTAL - 1));
    expect(out).not.toContain(CMD(0));
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
    expect(lastFrame() ?? '').toContain(IND(3));
    await type(stdin, '\x1b[H'); // Home：归输入框光标，不动菜单
    await type(stdin, '\x1b[8~'); // End：同样不动菜单
    expect(lastFrame() ?? '').toContain(IND(3));
    stdin.write('\x1B[B'); // ↓ 继续从第 3 条往后走
    await delay(30);
    expect(lastFrame() ?? '').toContain(IND(4));
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

  it('回归：↑ 回溯到斜杠命令不弹菜单，可继续向上翻历史', async () => {
    const { stdin, state, lastFrame } = setup('', ['older msg', CMD(0)]);
    await delay(20);
    stdin.write('\x1B[A'); // ↑ → 最新一条历史是 /help 命令
    await delay(30);
    expect(state.value).toBe(CMD(0));
    // 菜单被抑制：不出现菜单的描述行
    expect(lastFrame() ?? '').not.toContain('显示可用命令');
    stdin.write('\x1B[A'); // ↑ 继续向上 → 更早的历史，不被菜单选择卡死
    await delay(30);
    expect(state.value).toBe('older msg');
  });

  it('回溯出命令后改字重新武装菜单', async () => {
    const { stdin, state, lastFrame } = setup('', [CMD(0)]);
    await delay(20);
    stdin.write('\x1B[A'); // ↑ 回溯出 /help（菜单抑制）
    await delay(30);
    expect(state.value).toBe(CMD(0));
    expect(lastFrame() ?? '').not.toContain('显示可用命令');
    stdin.write('\x7f'); // Backspace 删一个字符 → 改字解除抑制，菜单重新弹出
    await delay(30);
    expect(state.value).toBe(CMD(0).slice(0, -1));
    expect(lastFrame() ?? '').toContain('显示可用命令');
  });
});


describe('PromptInput 粘贴换行归一（\r\n / \r → \n）', () => {
  function PasteHarness({
    initial = '',
    spy,
  }: {
    initial?: string;
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
    });
  }

  const setup = (initial = '') => {
    const state = { value: initial };
    const inst = render(React.createElement(PasteHarness, { initial, spy: (v: string) => (state.value = v) }));
    return { ...inst, state };
  };

  it('粘贴 CRLF 文本：\r 被剥掉，换行保留为多行，不触发提交', async () => {
    const { stdin, state, lastFrame } = setup();
    await delay(20);
    stdin.write('abc\r\ndef');
    await delay(50);
    expect(state.value).toBe('abc\ndef');
    const out = lastFrame() ?? '';
    expect(out).not.toContain('\r');
    expect(out).toContain('abc');
    expect(out).toContain('def');
  });

  it('粘贴裸 CR 文本同样归一为换行', async () => {
    const { stdin, state } = setup();
    await delay(20);
    stdin.write('x\ry');
    await delay(50);
    expect(state.value).toBe('x\ny');
  });

  it('多行值光标落在换行符上时渲染不吞行', async () => {
    const { stdin, lastFrame } = setup('ab\ncd');
    await delay(20);
    // 字符序列 a b \n c d，光标初始在末尾（5）；←×3 落到 \n（索引 2）上
    for (let i = 0; i < 3; i += 1) {
      stdin.write('\x1B[D');
      await delay(20);
    }
    const out = lastFrame() ?? '';
    expect(out).toContain('ab');
    expect(out).toContain('cd');
    // 换行仍在：两行分列渲染（边框行内 ab 与 cd 不同行）
    const lines = out.split('\n').filter((l) => l.includes('ab') || l.includes('cd'));
    expect(lines.length).toBe(2);
  });
});


describe('PromptInput 多行值排版（防 squash 回归）', () => {
  it('多行内容：「› 」空格保留，续行缩进与首行文本对齐', () => {
    const { lastFrame } = render(
      React.createElement(PromptInput, {
        value: '第一行\n第二行',
        onChange: () => {},
        onSubmit: () => {},
        busy: false,
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('› 第一行');
    // 续行：边框 1 + 内边距 1 + 2 列悬挂（对齐首行文本起点）
    expect(out).toContain('│   第二行');
  });
});


describe('PromptInput 候选队列取回（busy + 空输入时 ↑）', () => {
  function RecallHarness({
    busy,
    history = [],
    recall,
    spy,
  }: {
    busy: boolean;
    history?: string[];
    recall: () => string | undefined;
    spy: (v: string) => void;
  }): React.ReactElement {
    const [v, setV] = React.useState('');
    return React.createElement(PromptInput, {
      value: v,
      onChange: (nv: string) => {
        spy(nv);
        setV(nv);
      },
      onSubmit: () => {},
      busy,
      history,
      onRecallQueued: recall,
    });
  }

  const setupRecall = (opts: { busy: boolean; history?: string[]; recall: () => string | undefined }) => {
    const state = { value: '' };
    const inst = render(
      React.createElement(RecallHarness, { ...opts, spy: (v: string) => (state.value = v) }),
    );
    return { ...inst, state };
  };

  const type = async (stdin: { write: (s: string) => void }, s: string): Promise<void> => {
    stdin.write(s);
    await delay(30);
  };

  it('busy + 空输入：↑ 把取回的队尾文本填进输入框', async () => {
    const { stdin, state } = setupRecall({ busy: true, recall: () => '排队的那条' });
    await delay(20);
    await type(stdin, '\x1B[A'); // ↑
    expect(state.value).toBe('排队的那条');
  });

  it('busy + 队列空（recall 返回 undefined）：↑ 落回历史导航', async () => {
    const { stdin, state } = setupRecall({ busy: true, history: ['上一次输入'], recall: () => undefined });
    await delay(20);
    await type(stdin, '\x1B[A'); // ↑
    expect(state.value).toBe('上一次输入');
  });

  it('busy + 输入框非空：↑ 走历史导航，不调 recall', async () => {
    const recall = vi.fn(() => '排队的那条');
    const { stdin, state } = setupRecall({ busy: true, history: ['上一次输入'], recall });
    await delay(20);
    await type(stdin, 'a'); // 输入框非空
    await type(stdin, '\x1B[A'); // ↑
    expect(recall).not.toHaveBeenCalled();
    expect(state.value).toBe('上一次输入');
  });

  it('空闲 + 空输入：↑ 不调 recall，走历史导航', async () => {
    const recall = vi.fn(() => '排队的那条');
    const { stdin, state } = setupRecall({ busy: false, history: ['上一次输入'], recall });
    await delay(20);
    await type(stdin, '\x1B[A'); // ↑
    expect(recall).not.toHaveBeenCalled();
    expect(state.value).toBe('上一次输入');
  });
});
