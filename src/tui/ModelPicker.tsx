import { Box, Text, useInput, useStdout } from 'ink';
import { useMemo, useState } from 'react';
import { t } from '../i18n.js';

/** 模型选择器的单条候选项（由 App 从 [models.<别名>] 表装配）。 */
export interface ModelPickerItem {
  /** 别名（Enter 确认后回传给切换逻辑）。 */
  alias: string;
  /** 左列显示名（displayName ?? 别名）。 */
  label: string;
  /** 右列渠道名（entry.provider ?? 顶层 provider，灰色显示）。 */
  channel: string;
  /** 是否当前生效模型（后缀 ← 当前 标记）。 */
  current: boolean;
}

/** 每页展示的模型条数（对齐 SessionPicker）。 */
const PAGE_SIZE = 10;

/** 搜索键：别名 + 显示名 + 渠道名，小写后做子串匹配。 */
function searchKey(m: ModelPickerItem): string {
  return `${m.alias} ${m.label} ${m.channel}`.toLowerCase();
}

/**
 * 交互式模型选择器（/model 无参唤起，替换输入区）：
 * 单层扁平列表，指针 › + 显示名（左列）+ 渠道名（右列灰色）+ 当前项 ← 当前 后缀；
 * 输入即增量过滤（别名/显示名/渠道，空格分词 AND），↑↓ 移动（越界 clamp 不循环），
 * Backspace 删过滤字，Enter 确认，Esc 取消（有过滤词时先清词）。
 * 会话已有历史时顶部显示 prompt cache 失效警告。
 */
export function ModelPicker({
  items,
  hasHistory,
  onSelect,
}: {
  items: ModelPickerItem[];
  /** 会话已有历史时为 true，顶部显示 cache 失效警告。 */
  hasHistory: boolean;
  onSelect: (alias: string | null) => void;
}): React.ReactElement {
  const [query, setQuery] = useState('');
  const [sel, setSel] = useState(0);
  const { stdout } = useStdout();

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items;
    return items.filter((m) => terms.every((term) => searchKey(m).includes(term)));
  }, [items, query]);

  // query 变化后 sel 可能越界，渲染期钳制；页窗口跟随高亮项
  const clampedSel = Math.min(sel, Math.max(filtered.length - 1, 0));
  const pageStart = Math.floor(clampedSel / PAGE_SIZE) * PAGE_SIZE;
  const page = filtered.slice(pageStart, pageStart + PAGE_SIZE);
  // 左列宽 = 当页最长显示名，上限终端宽一半（防长名把渠道列挤出屏幕）
  const colWidth = Math.min(
    Math.max(...page.map((m) => m.label.length), 0),
    Math.max(Math.floor((stdout?.columns ?? 80) / 2), 8),
  );

  useInput((input, key) => {
    if (key.escape) {
      // 有过滤词先清词，再按一次才取消
      if (query !== '') {
        setQuery('');
        setSel(0);
        return;
      }
      onSelect(null);
      return;
    }
    if (key.return) {
      const chosen = filtered[clampedSel];
      onSelect(chosen !== undefined ? chosen.alias : null);
      return;
    }
    // ↑↓ clamp 移动：越界停住不循环
    if (key.upArrow) {
      setSel((i) => Math.max(i - 1, 0));
      return;
    }
    if (key.downArrow) {
      setSel((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
      return;
    }
    if (key.backspace || key.delete) {
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
        {t('modelPicker.title')}
      </Text>
      {hasHistory && <Text color="yellow">{t('modelPicker.cacheWarning')}</Text>}
      <Text>
        {t('modelPicker.searchPrefix')}
        {query === '' ? (
          <Text dimColor>{t('modelPicker.searchPlaceholder')}</Text>
        ) : (
          <Text color="yellow">{query}</Text>
        )}
      </Text>
      {filtered.length === 0 ? (
        <Text color="gray">{t('modelPicker.empty')}</Text>
      ) : (
        page.map((m, i) => {
          const active = pageStart + i === clampedSel;
          const label = m.label.length > colWidth ? m.label.slice(0, colWidth) : m.label.padEnd(colWidth);
          return (
            <Text key={m.alias} color={active ? 'cyan' : 'white'} inverse={active}>
              {active ? '› ' : '  '}
              {label}
              {'  '}
              <Text color="gray">{m.channel}</Text>
              {m.current ? <Text color="green">{` ${t('modelPicker.current')}`}</Text> : null}
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
      <Text color="gray">{t('modelPicker.hint')}</Text>
    </Box>
  );
}
