import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { SLASH_COMMANDS, type SlashCommand } from './commands.js';
import { displayWidth } from './liveBudget.js';
import { initialNavState, navigateHistory } from '../session/inputHistory.js';
import { insertText, resolveEditAction } from './promptEdit.js';
import { useSpinnerFrame, BRAILLE_FRAMES } from './useSpinnerFrame.js';
import { pickRandomTip } from './workingTips.js';
import { t } from '../i18n.js';

/** 斜杠菜单可视窗口条数（固定，不随终端高度变）。 */
const MENU_WINDOW = 6;

/**
 * 底部输入框：带边框常驻。敲 `/` 弹出斜杠命令补全下拉。
 * 方向键上/下回溯输入历史（shell 式命令回溯）：斜杠菜单可见时归菜单选择，
 * 否则做历史导航——单行输入框无多行移动冲突，配 bash 风格草稿暂存
 * （Up 翻历史、Down 翻回底部恢复半截草稿）。
 *
 * 文本编辑为自研单行组件（text + cursorOffset，光标处字符反色渲染），
 * 不用 ink-text-input：实测（见 promptEdit.ts 注释）Ink 已把 Home/End 的
 * 全部兼容序列解析为 key.home/key.end，但 ink-text-input 只处理左右方向键，
 * 导致 Home/End 无效；自研后补齐 readline 风格编辑键集
 * （Home/Ctrl+A、End/Ctrl+E、Ctrl+←/Alt+B、Ctrl+→/Alt+F、Ctrl+W/U/K）。
 * 按键分发保持线性次序：斜杠菜单 → 历史导航 → 编辑动作 → 可打印字符。
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  busy,
  history,
  primed = false,
  exitPrimed = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  busy: boolean;
  /** 输入历史（时间正序，末尾最新）。 */
  history: string[];
  /** backtrack primed 态：显示「再按 Esc 取回上一条消息编辑」提示（仅空闲时有意义）。 */
  primed?: boolean;
  /** 退出确认 primed 态：显示「再按一次 Ctrl+C 退出」提示（仅空闲时有意义）。 */
  exitPrimed?: boolean;
}): React.ReactElement {
  const [selIdx, setSelIdx] = useState(0);
  // busy 时输入框前缀转圈；空闲时 useSpinnerFrame 不起定时器。
  const spinner = useSpinnerFrame(busy, BRAILLE_FRAMES);
  // 历史导航游标（不参与渲染，用 ref 避免 useInput 闭包读到陈旧值）。
  const navState = useRef(initialNavState());
  // 光标位置（code point 索引）。本组件内发起的文本变更在按键处理器里同步设好光标，
  // 并用 ref 记下新文本；外部变更（历史回溯、Tab 补全、提交清空）光标归尾（shell 行为）。
  const [cursor, setCursor] = useState(() => Array.from(value).length);
  const selfChangeRef = useRef<string | null>(null);
  // 光标归尾不用 useEffect：effect 要等 commit 后才跑，期间到达的下一次按键
  // 会读到旧光标（实测全量跑测试时 Up 回溯后立刻敲字符插到了行首）。
  // 改用渲染期间派生状态（React 官方 adjusting-state-when-props-change 模式），
  // setState 在同一次渲染内立即重渲染，光标复位与文本变更同步生效。
  const lastValueRef = useRef(value);
  if (lastValueRef.current !== value) {
    lastValueRef.current = value;
    if (selfChangeRef.current !== value) {
      setCursor(Array.from(value).length);
    }
    selfChangeRef.current = null;
  }

  // busy 上升沿时随机抽一条 tip，busy 期间保持不变；用 ref 记住上一条避免连抽重复。
  // 惰性初始化让「首帧即 busy」也能立刻显示 tip（useEffect 的 setState 要等挂载后才 flush）。
  const [tip, setTip] = useState(() => (busy ? pickRandomTip() : ''));
  const lastTip = useRef<string | undefined>(tip || undefined);
  useEffect(() => {
    if (busy) {
      const next = pickRandomTip(lastTip.current);
      lastTip.current = next;
      setTip(next);
    } else {
      setTip('');
    }
    // 依赖只放 busy：tip 值变化不应重触发（否则会连抽）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  // 斜杠命令补全：输入以 / 开头且无空格时，过滤匹配命令
  const matches = matchSlashCommands(value);
  const menuVisible = matches.length > 0;

  // 弹层不可见时，↑↓ 做 shell 式输入历史回溯（配 bash 风格草稿暂存）。
  useInput(
    (_input, key) => {
      if (menuVisible) return;
      if (key.upArrow || key.downArrow) {
        const res = navigateHistory(history, navState.current, key.upArrow ? -1 : 1, value);
        navState.current = res.state;
        if (res.text !== undefined) onChange(res.text);
      }
    },
    { isActive: !menuVisible },
  );

  // 弹层可见时按键优先给弹层：↑↓ 选择、Tab 补全、Enter 执行、Esc 关闭
  useInput(
    (_input, key) => {
      if (!menuVisible) return;
      if (key.upArrow) {
        // 到顶/到底回卷（循环选择行为）
        setSelIdx((i) => (i - 1 + matches.length) % matches.length);
      } else if (key.downArrow) {
        setSelIdx((i) => (i + 1) % matches.length);
      } else if (key.tab) {
        const c = matches[Math.min(selIdx, matches.length - 1)];
        if (c !== undefined) onChange(`/${c.name} `);
      } else if (key.escape) {
        onChange('');
      }
    },
    { isActive: menuVisible },
  );

  // 弹层可见时 Enter 直接执行选中命令（不透传给输入框）
  const handleSubmit = (v: string): void => {
    if (menuVisible) {
      const c = matches[Math.min(selIdx, matches.length - 1)];
      if (c !== undefined) {
        onSubmit(`/${c.name}`);
        return;
      }
    }
    onSubmit(v);
  };

  // 文本编辑与字符输入（线性 if 链尾部：编辑动作 → 可打印字符）。
  // 菜单可见时也保持激活：敲键过滤菜单、Ctrl+W 等编辑键照常可用；
  // ↑↓/Tab/Esc 归上方菜单处理器，这里不接。实际改字即退出历史浏览态并复位菜单选中。
  useInput((input, key) => {
    if (key.return) {
      handleSubmit(value);
      return;
    }
    const action = resolveEditAction(input, key);
    if (action) {
      const next = action({ text: value, cursor });
      if (next.text !== value) {
        setSelIdx(0);
        navState.current = initialNavState();
        selfChangeRef.current = next.text;
        onChange(next.text);
      }
      setCursor(next.cursor);
      return;
    }
    // 可打印字符：无 ctrl/meta 修饰时插入光标处（粘贴的多字符整体插入）
    if (input !== '' && !key.ctrl && !key.meta) {
      const next = insertText({ text: value, cursor }, input);
      setSelIdx(0);
      navState.current = initialNavState();
      selfChangeRef.current = next.text;
      onChange(next.text);
      setCursor(next.cursor);
    }
  });

  // 菜单窗口化滚动（居中窗口）：选中项尽量停在窗口中间，
  // 靠近两端时钳制，保证选中项永不滚出可视窗口。
  const menuStart = Math.max(0, Math.min(selIdx - Math.floor(MENU_WINDOW / 2), matches.length - MENU_WINDOW));

  return (
    <Box flexDirection="column">
      {menuVisible ? (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          {matches.slice(menuStart, menuStart + MENU_WINDOW).map((c, i) => {
            const selected = menuStart + i === selIdx;
            return (
              <Text key={c.name} color={selected ? 'cyan' : 'gray'} bold={selected} wrap="truncate">
                {selected ? '› ' : '  '}
                <Text color={selected ? 'cyan' : 'white'}>/{c.name}</Text>
                {'  '}
                <Text color="gray">{t(c.describe)}</Text>
              </Text>
            );
          })}
          {matches.length > MENU_WINDOW ? (
            <Text color="gray">
              {'  '}({selIdx + 1}/{matches.length})
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Text color={busy ? 'yellow' : 'gray'} bold>
          {busy ? `${spinner} ` : '› '}
        </Text>
        <Text>{renderEditableText(value, cursor, busy ? t('input.placeholder.busy') : t('input.placeholder.idle'))}</Text>
      </Box>
      {busy && tip ? <Text color="gray" wrap="truncate">{t('input.tipPrefix', { tip })}</Text> : null}
      {!busy && primed ? <Text color="yellow" wrap="truncate">{t('input.backtrackPrimed')}</Text> : null}
      {!busy && exitPrimed ? <Text color="yellow" wrap="truncate">{t('input.exitPrimed')}</Text> : null}
    </Box>
  );
}

/** 斜杠命令补全匹配：输入以 / 开头且无空格时，按前缀过滤命令名与别名。 */
export function matchSlashCommands(value: string): SlashCommand[] {
  const query = value.startsWith('/') && !/\s/.test(value) ? value.slice(1).toLowerCase() : null;
  if (query === null) return [];
  return SLASH_COMMANDS.filter(
    (c) =>
      c.name.toLowerCase().startsWith(query) ||
      (c.aliases ?? []).some((a) => a.toLowerCase().startsWith(query)),
  );
}

export interface PromptRowOptions {
  busy: boolean;
  /** backtrack primed 提示行（仅空闲时显示）。 */
  primed?: boolean;
  /** 退出确认 primed 提示行（仅空闲时显示）。 */
  exitPrimed?: boolean;
  /** 终端列数（未知时调用方给保守默认 80）。 */
  columns: number;
}

/**
 * 输入区实际占用行数（动态区高度预算用，与上方渲染结构一一对应）：
 * 斜杠菜单（边框 2 + 窗口 ≤MENU_WINDOW 条 + 页码行 ≤1）
 * + 输入框（边框 2 + 内容按终端宽度折行，长粘贴/窄终端不再漏算）
 * + busy tip / primed 提示各 ≤1。菜单条目与提示行均 wrap=truncate 单行截断。
 */
export function computePromptRows(value: string, opts: PromptRowOptions): number {
  const matches = matchSlashCommands(value);
  const menuRows =
    matches.length > 0 ? 2 + Math.min(matches.length, MENU_WINDOW) + (matches.length > MENU_WINDOW ? 1 : 0) : 0;
  // 输入框内容区可用宽度：边框 2 + 内边距 2 + 前缀（spinner/› + 空格）2
  const contentWidth = Math.max(opts.columns - 6, 1);
  const inputLines = Math.max(1, Math.ceil(displayWidth(value) / contentWidth));
  const tipRows =
    (opts.busy ? 1 : 0) +
    (!opts.busy && (opts.primed ?? false) ? 1 : 0) +
    (!opts.busy && (opts.exitPrimed ?? false) ? 1 : 0);
  return menuRows + inputLines + 2 + tipRows;
}

/**
 * 单行文本 + 光标渲染：光标处字符反色（沿用 ink-text-input 的做法），
 * 光标在末尾时反色一个占位空格；空文本时显示 placeholder 并反色首字符。
 */
function renderEditableText(value: string, cursor: number, placeholder: string): React.ReactNode {
  if (value === '') {
    const ph = Array.from(placeholder);
    return (
      <>
        <Text inverse>{ph[0] ?? ' '}</Text>
        <Text dimColor>{ph.slice(1).join('')}</Text>
      </>
    );
  }
  const chars = Array.from(value);
  const at = Math.max(0, Math.min(cursor, chars.length));
  const cursorChar = at < chars.length ? (chars[at] as string) : ' ';
  return (
    <>
      {chars.slice(0, at).join('')}
      <Text inverse>{cursorChar}</Text>
      {at < chars.length ? chars.slice(at + 1).join('') : ''}
    </>
  );
}
