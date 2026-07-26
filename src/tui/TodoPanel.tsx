import { Box, Text } from 'ink';
import type { TodoItem } from '../tools/types.js';
import { t } from '../i18n.js';

const MAX_VISIBLE = 5;

/** 精简常驻 TODO 面板：显示当前任务清单，最多 5 条 + +N more。 */
export function TodoPanel({ todos }: { todos: readonly TodoItem[] }): React.ReactElement | null {
  if (todos.length === 0) return null;
  const visible = todos.slice(0, MAX_VISIBLE);
  const rest = todos.length - visible.length;
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan" bold wrap="truncate">
        {t('todo.title')}
      </Text>
      {visible.map((t, i) => {
        const mark = t.status === 'done' ? '✓' : t.status === 'in_progress' ? '●' : '○';
        const color = t.status === 'done' ? 'green' : t.status === 'in_progress' ? 'cyan' : 'gray';
        const strike = t.status === 'done';
        return (
          // 长 title 截断到一行（wrap=truncate），保证动态区高度预算按 1 行/条精确成立
          <Text key={i} color={color} strikethrough={strike} wrap="truncate">
            {`${mark} ${t.title}`}
          </Text>
        );
      })}
      {rest > 0 ? <Text color="gray" wrap="truncate">{t('todo.more', { count: rest })}</Text> : null}
    </Box>
  );
}
