import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { t } from '../i18n.js';

/** undo 选择器的单条候选项（由 App 从 history 装配：只列 origin==='user' 的轮起点，逆序，最近在上）。 */
export interface UndoPickerItem {
  /** 选中该项要撤销的轮数（1 = 撤销最近一轮，含本轮之后所有轮）。 */
  count: number;
  /** 左列：该轮用户 prompt 摘要（已压单行截断）。 */
  label: string;
  /** 右列：该轮时间（灰色显示）。 */
  detail: string;
}

/**
 * 交互式 undo 选择器（/undo 无参唤起，替换输入区，照抄 ThinkPicker 的弹层模式）：
 * 每项 = 一轮，指针 › + 用户 prompt 摘要（左列）+ 时间（右列灰色）；↑↓ 移动（越界 clamp 不循环），
 * Enter 确认撤销到该轮，Esc 取消。无搜索/分页（对齐 ThinkPicker：轮数少时最直接）。
 */
export function UndoPicker({
  items,
  onSelect,
}: {
  items: UndoPickerItem[];
  onSelect: (count: number | null) => void;
}): React.ReactElement {
  const [sel, setSel] = useState(0);

  // 越界钳制（列表静态，仅为防御）；无分页
  const clampedSel = Math.min(sel, Math.max(items.length - 1, 0));
  // 左列宽 = 最长摘要（不做终端宽截断，摘要装配时已压单行）
  const colWidth = Math.max(...items.map((m) => m.label.length), 0);

  useInput((_input, key) => {
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = items[clampedSel];
      onSelect(chosen !== undefined ? chosen.count : null);
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(items.length - 1, 0)));
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('app.undo.title')}
      </Text>
      {items.length === 0 ? (
        <Text color="gray">{t('app.undo.empty')}</Text>
      ) : (
        items.map((m, i) => {
          const active = i === clampedSel;
          return (
            <Text key={m.count} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {m.label.padEnd(colWidth)}
              {'  '}
              <Text color="gray">{m.detail}</Text>
            </Text>
          );
        })
      )}
      <Text color="gray">{t('app.undo.hint')}</Text>
    </Box>
  );
}
