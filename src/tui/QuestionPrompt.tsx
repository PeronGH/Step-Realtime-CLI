import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRef, useState } from 'react';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { t } from '../i18n.js';
import { wrappedRows } from './liveBudget.js';

/**
 * 估算提问框渲染行数（供 App 计算动态区高度预算，滚动跳顶修复）。
 * 结构：marginTop 1 + 边框 2 + 题干（折行）+ 选项（逐条折行）+ Other 1 + 提示（折行）。
 * 多题时取各题行数最大值——qIdx 是组件内部状态，换题时 App 不会重算预算，预算必须覆盖最高的一题。
 * termCols 用于精确计算长题干/长选项描述的折行（内宽 = 列数 − 边框 2 − paddingX 2）；
 * 缺省时退化为每逻辑行 1 行的结构估算（测试/非 TTY 场景）。
 */
export function estimateChromeRows(req: AskUserRequest, termCols?: number): number {
  const innerWidth = termCols === undefined ? undefined : termCols - 4;
  let maxBody = 0;
  for (const q of req.questions) {
    const counter = req.questions.length > 1 ? t('question.counter', { index: 1, total: req.questions.length }) : '';
    const header = q.header !== undefined && q.header !== '' ? `[${q.header}] ` : '';
    const multi = q.multi_select === true ? t('question.multiHint') : '';
    let rows = wrappedRows(counter + header + q.question + multi, innerWidth);
    q.options.forEach((opt, i) => {
      const box = q.multi_select === true ? '[✓] ' : '';
      const desc = opt.description !== undefined && opt.description !== '' ? `  — ${opt.description}` : '';
      // 前缀宽 = 光标列 2 + 勾选列 + [n] 列；取选中态前缀（与未选中同宽，✓/空格同宽）
      rows += wrappedRows(`→ ${box}[${i + 1}] ${opt.label}${desc}`, innerWidth);
    });
    rows += 1; // Other 行（otherMode 下 TextInput 短输入仍 1 行）
    rows += wrappedRows(t('question.hint'), innerWidth);
    if (rows > maxBody) maxBody = rows;
  }
  return 1 + 2 + maxBody;
}

/**
 * 询问用户组件（ask_user 工具的前台交互）。多题时逐题顺序问，答完自动进下一题，
 * 全答完把 { 问题原文: 答案 } 字典一次性回传（多选值为数组）。取消（Esc）回传空字典。
 *
 * 键盘：↑↓ 移动光标（环绕）、数字键 1–9 直选实选项、单选 Enter 选中当前项、
 * 多选空格切换勾选 + Enter 提交本题、光标移到 Other 项 Enter 进入内联自由文本输入、Esc 取消。
 * 组件自持 useInput；宿主（App）在提问态让出全部按键给本组件。
 */
export function QuestionPrompt({
  req,
  onSubmit,
  onCancel,
}: {
  req: AskUserRequest;
  onSubmit: (answers: QuestionAnswers) => void;
  onCancel: () => void;
}): React.ReactElement {
  const [qIdx, setQIdx] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState('');
  // 已答问题累积（key 为问题原文）；用 ref 避免逐题推进时读到陈旧闭包。
  const answers = useRef<QuestionAnswers>({});

  const q = req.questions[qIdx]!;
  const optionCount = q.options.length;
  const otherIdx = optionCount; // Other 项排在真实选项之后
  const rowCount = optionCount + 1; // 含 Other

  // 记录本题答案并推进：还有下一题则重置本题态，否则汇总回传。
  const advance = (answer: string | string[]): void => {
    answers.current[q.question] = answer;
    if (qIdx + 1 < req.questions.length) {
      setQIdx(qIdx + 1);
      setCursor(0);
      setChecked(new Set());
      setOtherMode(false);
      setOtherText('');
    } else {
      onSubmit(answers.current);
    }
  };

  const submitOther = (): void => {
    // 自由输入项：直接以用户输入文本作为答案（多选也退化为单值）。
    advance(otherText.trim());
  };

  // otherMode 下按键交给 TextInput，本处仅在非 otherMode 时处理导航/选择。
  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow) {
        setCursor((c) => (c - 1 + rowCount) % rowCount);
        return;
      }
      if (key.downArrow) {
        setCursor((c) => (c + 1) % rowCount);
        return;
      }
      // 数字键 1–9 直选「实选项」（不含 Other，Other 只能靠光标移到再 Enter）
      if (/^[1-9]$/.test(input)) {
        const n = Number(input) - 1;
        if (n < optionCount) {
          if (q.multi_select === true) {
            setChecked((prev) => {
              const next = new Set(prev);
              if (next.has(n)) next.delete(n);
              else next.add(n);
              return next;
            });
            setCursor(n);
          } else {
            advance(q.options[n]!.label);
          }
        }
        return;
      }
      // 多选：空格切换当前光标项（Other 项不参与勾选）
      if (input === ' ' && q.multi_select === true && cursor < optionCount) {
        setChecked((prev) => {
          const next = new Set(prev);
          if (next.has(cursor)) next.delete(cursor);
          else next.add(cursor);
          return next;
        });
        return;
      }
      if (key.return) {
        if (cursor === otherIdx) {
          setOtherMode(true);
          return;
        }
        if (q.multi_select === true) {
          const labels = q.options.filter((_, i) => checked.has(i)).map((o) => o.label);
          advance(labels);
        } else {
          advance(q.options[cursor]!.label);
        }
      }
    },
    { isActive: !otherMode },
  );

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        {req.questions.length > 1 ? (
          <Text color="gray">{t('question.counter', { index: qIdx + 1, total: req.questions.length })}</Text>
        ) : null}
        {q.header !== undefined && q.header !== '' ? <Text color="magenta">{`[${q.header}] `}</Text> : null}
        <Text color="cyan" bold>
          {q.question}
        </Text>
        {q.multi_select === true ? <Text color="gray">{t('question.multiHint')}</Text> : null}
      </Text>
      {q.options.map((opt, i) => {
        const selected = i === cursor && !otherMode;
        const box = q.multi_select === true ? (checked.has(i) ? '[✓] ' : '[ ] ') : '';
        return (
          <Text key={i} color={selected ? 'cyan' : 'white'} bold={selected}>
            {selected ? '→ ' : '  '}
            {box}
            {`[${i + 1}] ${opt.label}`}
            {opt.description !== undefined && opt.description !== '' ? (
              <Text color="gray">{`  — ${opt.description}`}</Text>
            ) : null}
          </Text>
        );
      })}
      {otherMode ? (
        <Box>
          <Text color={cursor === otherIdx ? 'cyan' : 'white'} bold>
            {'→ '}
            {`[${otherIdx + 1}] `}
          </Text>
          <TextInput value={otherText} onChange={setOtherText} onSubmit={submitOther} placeholder={t('question.otherPlaceholder')} />
        </Box>
      ) : (
        <Text color={cursor === otherIdx ? 'cyan' : 'white'} bold={cursor === otherIdx}>
          {cursor === otherIdx ? '→ ' : '  '}
          {`[${otherIdx + 1}] ${t('question.other')}`}
        </Text>
      )}
      <Text color="gray">{t('question.hint')}</Text>
    </Box>
  );
}
