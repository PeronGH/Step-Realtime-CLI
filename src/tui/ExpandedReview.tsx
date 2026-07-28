import { Box, Text } from 'ink';
import { t } from '../i18n.js';
import { LiveViewport } from './LiveViewport.js';
import { MessageItem } from './MessageList.js';
import { hasCollapsedBody } from './ToolCall.js';
import type { DisplayItem } from './types.js';

/** 展开预览层最多回看的可展开工具条数（再多视口也装不下，尾部锚定保最新）。 */
const MAX_ITEMS = 10;

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;

/** 从已定稿条目里收集最近的可展开工具条目（时间正序，最多 max 条）。 */
export function collectExpandable(items: readonly DisplayItem[], max: number = MAX_ITEMS): ToolItem[] {
  const out: ToolItem[] = [];
  for (let i = items.length - 1; i >= 0 && out.length < max; i--) {
    const it = items[i]!;
    if (it.kind === 'tool' && hasCollapsedBody(it)) out.unshift(it);
  }
  return out;
}

/**
 * Ctrl+O 展开预览层（仅空闲时挂载）：把最近的可展开工具输出以展开态重渲在动态区。
 * 定稿历史走 <Static> append-only、恒折叠（展开态冻进历史收不回）；本层是动态区临时视图，
 * 再按 Ctrl+O 即消失，不触碰 scrollback——这是「历史展开回看」在不重印、不清屏前提下的实现。
 * 高度由 LiveViewport 尾部锚定窗口化：空闲时 liveItems 为空，整条视口预算让给预览层，
 * 超出台屏的部分折叠为「已隐藏 N 行」，帧高不变量（≤ 终端行数 − 1）不受影响。
 */
export function ExpandedReview({
  items,
  maxRows,
}: {
  items: readonly DisplayItem[];
  /** 动态区视口预算行数；undefined = 不窗口化（非 TTY / 测试环境）。 */
  maxRows?: number;
}): React.ReactElement | null {
  const tools = collectExpandable(items);
  if (tools.length === 0) return null;
  const body = tools.map((it, i) => <MessageItem key={i} item={it} expanded={true} />);
  return (
    <Box flexDirection="column">
      {/* 标题行在视口外：窗口化只裁条目，标题恒可见 */}
      <Text color="gray" wrap="truncate">
        {t('expandReview.header', { count: tools.length })}
      </Text>
      {maxRows === undefined ? (
        body
      ) : (
        <LiveViewport maxRows={Math.max(maxRows - 1, 1)}>{body}</LiveViewport>
      )}
    </Box>
  );
}
