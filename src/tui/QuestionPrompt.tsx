import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useRef, useState } from 'react';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { t } from '../i18n.js';

/**
 * 估算提问框渲染行数（供 App 计算动态区高度预算，滚动跳顶修复）。
 * 结构实测：marginTop 1 + 边框 2 + 题干 1 + 选项 N（取各题最多选项数）+ Other 1 + 提示 1。
 */
export function estimateChromeRows(req: AskUserRequest): number {
  const maxOptions = Math.max(0, ...req.questions.map((q) => q.options.length));
  return 1 + 2 + 1 + maxOptions + 1 + 1;
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
