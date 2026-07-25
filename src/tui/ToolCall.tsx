import { Box, Text } from 'ink';
import type { DisplayItem } from './types.js';
import { useSpinnerFrame, BRAILLE_FRAMES } from './useSpinnerFrame.js';
import { WorkflowPanel } from './WorkflowPanel.js';
import { t } from '../i18n.js';

function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // 优先展示最能代表操作对象的字段
  for (const key of ['path', 'pattern', 'command']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  return '';
}

function statusMark(status: 'running' | 'ok' | 'error'): { symbol: string; color: string } {
  switch (status) {
    case 'running':
      return { symbol: '⏳', color: 'yellow' };
    case 'ok':
      return { symbol: '✓', color: 'green' };
    case 'error':
      return { symbol: '✗', color: 'red' };
  }
}

const COLLAPSED_ERROR_LINES = 4;
const EXPANDED_MAX_LINES = 200;

/**
 * 渲染一次工具调用：名称 + 入参摘要 + 状态。
 * 结果体默认折叠——出错时显示前几行预览，成功时只显示「N 行输出 · Ctrl+O 展开」提示；
 * expanded=true（全局 Ctrl+O 切换）时展开完整输出。
 */
export function ToolCall({
  item,
  expanded,
}: {
  item: Extract<DisplayItem, { kind: 'tool' }>;
  expanded: boolean;
}): React.ReactElement {
  const running = item.status === 'running';
  // running 时转圈（80ms），非 running 时不起定时器；同一 re-render 也顺带刷新已运行秒数。
  const spinner = useSpinnerFrame(running, BRAILLE_FRAMES);
  const mark = running ? { symbol: spinner, color: 'yellow' } : statusMark(item.status);
  const arg = summarizeInput(item.input);
  const elapsedSec =
    running && item.startedAt !== undefined ? Math.floor((Date.now() - item.startedAt) / 1000) : null;
  const result = item.result;
  const lines = result !== undefined && result !== '' ? result.split('\n') : [];
  const hasBody = lines.length > 0 && item.status !== 'running';

  // workflow 工具：运行中升级为步骤面板（编排结构 + 当前步高亮 + 组内子 agent 归属），
  // 完成后坍缩回一行摘要，结果体仍走原有折叠/Ctrl+O 机制。
  const wf = item.workflow;
  if (wf !== undefined) {
    const agents = wf.steps.reduce((n, s) => n + s.members.length, 0);
    return (
      <Box flexDirection="column">
        <Text>
          <Text color={mark.color}>{mark.symbol} </Text>
          <Text color="cyan">{running ? t('workflow.title', { name: wf.name }) : t('workflow.summary', { name: wf.name, steps: wf.steps.length, agents })}</Text>
          {elapsedSec !== null ? <Text color="gray">{t('toolCall.elapsed', { s: elapsedSec })}</Text> : null}
        </Text>
        {running ? <WorkflowPanel state={wf} /> : null}
        {hasBody ? <ResultBody lines={lines} isError={item.status === 'error'} expanded={expanded} /> : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={mark.color}>{mark.symbol} </Text>
        <Text color="cyan">{item.name}</Text>
        {arg !== '' ? <Text color="gray">{`  ${arg}`}</Text> : null}
        {elapsedSec !== null ? <Text color="gray">{t('toolCall.elapsed', { s: elapsedSec })}</Text> : null}
      </Text>
      {hasBody ? <ResultBody lines={lines} isError={item.status === 'error'} expanded={expanded} /> : null}
    </Box>
  );
}

function ResultBody({
  lines,
  isError,
  expanded,
}: {
  lines: string[];
  isError: boolean;
  expanded: boolean;
}): React.ReactElement {
  if (expanded) {
    const shown = lines.slice(0, EXPANDED_MAX_LINES);
    const truncated = lines.length > EXPANDED_MAX_LINES;
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color={isError ? 'red' : 'gray'}>{shown.join('\n')}</Text>
        {truncated ? (
          <Text color="gray">{t('toolCall.tooLong', { shown: EXPANDED_MAX_LINES, total: lines.length })}</Text>
        ) : null}
      </Box>
    );
  }

  // 折叠态
  if (isError) {
    const preview = lines.slice(0, COLLAPSED_ERROR_LINES).join('\n');
    const more = lines.length - COLLAPSED_ERROR_LINES;
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text color="red">{preview}</Text>
        {more > 0 ? <Text color="gray">{t('toolCall.moreLines', { count: more })}</Text> : null}
      </Box>
    );
  }
  // 成功且有输出：只给一行折叠提示
  return (
    <Box marginLeft={2}>
      <Text color="gray">{t('toolCall.collapsed', { count: lines.length })}</Text>
    </Box>
  );
}
