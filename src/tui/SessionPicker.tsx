import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { SessionMeta } from '../session/store.js';
import { t } from '../i18n.js';

/**
 * 相对时间小工具：<60s 刚刚、<60min N 分钟前、<24h N 小时前、<30d N 天前，
 * 否则显示 YYYY-MM-DD。非法时间原样返回。
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const sec = Math.floor((Date.now() - then) / 1000);
  if (sec < 60) return t('time.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('time.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('time.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 30) return t('time.daysAgo', { count: day });
  const d = new Date(then);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** 每页展示的会话条数。 */
const PAGE_SIZE = 10;

/** 搜索键：标题 + 首条消息预览，小写后做子串匹配。 */
function searchKey(m: SessionMeta): string {
  return `${m.title ?? ''} ${m.preview ?? ''}`.toLowerCase();
}

/**
 * 交互式会话选择器：
 * 输入即增量过滤（标题+预览，空格分词 AND），↑↓ 移动高亮（分页滚动），
 * 回车恢复选中会话，Esc 放弃开新会话。
 * Delete / Ctrl+D 对高亮会话发起删除，进入 [y/N] 二次确认（不可逆本地文件操作）。
 * 只读元信息（标题/预览/相对时间/条数），不预载 message 正文——规避读大快照卡死。
 * 注：可打印字符一律进入搜索词（含 d），故删除走 Delete / Ctrl+D 而非裸 d；不支持 k/j 导航。
 */
export function SessionPicker({
  sessions,
  currentId,
  onSelect,
  onDelete,
}: {
  sessions: SessionMeta[];
  /** 当前正在使用的会话 id（禁止删除，删除时给拒绝提示）。 */
  currentId?: string;
  onSelect: (id: string | null) => void;
  /** 删除某会话（落盘删除由上层执行），返回是否删成功。省略时不提供删除能力。 */
  onDelete?: (id: string) => boolean;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  // 删除二次确认态：null = 无待确认；否则为待删会话 id。
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // 无法删除当前会话时的一次性提示（下次任意键操作清除）。
  const [notice, setNotice] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return sessions;
    return sessions.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [sessions, query]);

  // query 变化后 sel 可能越界，渲染期钳制；页窗口跟随高亮项
  const clampedSel = Math.min(sel, Math.max(filtered.length - 1, 0));
  const pageStart = Math.floor(clampedSel / PAGE_SIZE) * PAGE_SIZE;
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  const confirmTarget = confirmId !== null ? sessions.find((m) => m.id === confirmId) : undefined;

  useInput((input, key) => {
    // 删除二次确认态：只认 y / n / Esc，其余按键忽略（防误删）
    if (confirmId !== null) {
      if (input === 'y' || input === 'Y') {
        if (onDelete !== undefined) onDelete(confirmId);
        setConfirmId(null);
        setSel(0);
        return;
      }
      if (input === 'n' || input === 'N' || key.escape) {
        setConfirmId(null);
        return;
      }
      return;
    }
    if (notice !== null) setNotice(null);
    if (key.escape) {
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = filtered[clampedSel];
      onSelect(chosen !== undefined ? chosen.id : null);
      return;
    }
    const n = Math.max(filtered.length, 1);
    if (key.upArrow) {
      setSel((i) => (i - 1 + n) % n);
      return;
    }
    if (key.downArrow) {
      setSel((i) => (i + 1) % n);
      return;
    }
    // Delete / Ctrl+D：对高亮会话发起删除确认（Backspace 仍删搜索词）
    if ((key.delete && !key.backspace) || (key.ctrl && input === 'd')) {
      if (onDelete === undefined) return;
      const target = filtered[clampedSel];
      if (target === undefined) return;
      if (target.id === currentId) {
        setNotice(t('sessionPicker.cannotDeleteCurrent'));
        return;
      }
      setConfirmId(target.id);
      return;
    }
    if (key.backspace) {
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      setQuery((q) => q + input);
      setSel(0);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('sessionPicker.title')}
      </Text>
      <Text>
        {t('sessionPicker.searchPrefix')}
        {query === '' ? (
          <Text dimColor>{t('sessionPicker.searchPlaceholder')}</Text>
        ) : (
          <Text color="yellow">{query}</Text>
        )}
      </Text>
      {filtered.length === 0 ? (
        <Text color="gray">{t('sessionPicker.empty')}</Text>
      ) : (
        page.map((m, i) => {
          const active = pageStart + i === clampedSel;
          const label = m.title !== undefined && m.title !== '' ? m.title : m.id;
          const isCurrent = m.id === currentId;
          return (
            <Text key={m.id} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {label}
              {isCurrent ? <Text color="green">{` ${t('sessionPicker.current')}`}</Text> : null}
              {'  '}
              <Text color="gray">
                {relativeTime(m.updatedAt)} · {t('sessionPicker.count', { count: m.messageCount })}
              </Text>
            </Text>
          );
        })
      )}
      {filtered.length > PAGE_SIZE && (
        <Text color="gray">
          {t('sessionPicker.pageInfo', {
            start: pageStart + 1,
            end: Math.min(pageStart + PAGE_SIZE, filtered.length),
            total: filtered.length,
          })}
        </Text>
      )}
      {confirmId !== null ? (
        <Text color="red">
          {t('sessionPicker.deleteConfirm', {
            title:
              confirmTarget !== undefined && confirmTarget.title !== undefined && confirmTarget.title !== ''
                ? confirmTarget.title
                : confirmId,
          })}
        </Text>
      ) : notice !== null ? (
        <Text color="yellow">{notice}</Text>
      ) : onDelete !== undefined ? (
        <Text color="gray">{t('sessionPicker.deleteHint')}</Text>
      ) : null}
    </Box>
  );
}
