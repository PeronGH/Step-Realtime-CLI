import { Box, Text } from 'ink';
import { t } from '../i18n.js';

/** 并行子 agent 的单个进度。 */
export interface SubagentProgress {
  /** 子 agent 标识（并行时区分，来自 runner 的 sid）。 */
  id: string;
  /** 类型（explore/general 或自定义）。 */
  type: string;
  /** 任务描述。 */
  description: string;
  /** 状态。 */
  status: 'queued' | 'running' | 'done' | 'error';
  /** 已用工具数。 */
  toolCount: number;
  /** 最新活动（运行中的当前工具/动作）。 */
  activity?: string;
}

/**
 * 全部终态后冻结进历史的纯文本摘要。
 * 运行进度由动态面板承担，完成结果由历史承担：面板撤下后，scrollback 里留有可回看的定稿记录。
 */
export function formatAgentGroupSummary(agents: readonly SubagentProgress[]): string {
  const errored = agents.filter((a) => a.status === 'error').length;
  const many = agents.length > 1;
  const header = many
    ? t('agentGroup.header.manyDone', {
        total: agents.length,
        failed: errored > 0 ? t('agentGroup.failedSuffix', { count: errored }) : '',
      })
    : t('agentGroup.header.singleDone', { failed: errored > 0 ? t('agentGroup.failedTag') : '' });
  const lines = agents.map((a, i) => {
    const branch = i === agents.length - 1 ? '└─' : '├─';
    const mark = a.status === 'done' ? '✓' : '✗';
    const statusText = a.status === 'done' ? t('agentGroup.status.done') : t('agentGroup.status.error');
    return `${branch} ${a.type} · ${a.description} · ${a.toolCount} tools · ${mark} ${statusText}`;
  });
  return [`✓ ${header}`, ...lines].join('\n');
}

/**
 * 并行子 agent（一轮多调用并行）的树形分组面板。
 * 头部计数 + 每个子 agent 一行（类型·描述·tools·状态）+ 运行中的最新活动。
 */
export function AgentGroup({ agents }: { agents: SubagentProgress[] }): React.ReactElement | null {
  if (agents.length === 0) return null;
  const done = agents.filter((a) => a.status === 'done').length;
  const running = agents.filter((a) => a.status === 'running').length;
  const errored = agents.filter((a) => a.status === 'error').length;
  const allDone = done + errored === agents.length;
  // 单个子 agent 与「一轮多调用并行」的多个子 agent，用同一面板渲染，仅头部措辞不同。
  const many = agents.length > 1;

  const header = allDone
    ? many
      ? t('agentGroup.header.manyDone', {
          total: agents.length,
          failed: errored > 0 ? t('agentGroup.failedSuffix', { count: errored }) : '',
        })
      : t('agentGroup.header.singleDone', { failed: errored > 0 ? t('agentGroup.failedTag') : '' })
    : many
      ? t('agentGroup.header.manyRunning', {
          total: agents.length,
          done,
          running,
          failed: errored > 0 ? t('agentGroup.failedSuffixInline', { count: errored }) : '',
        })
      : t('agentGroup.header.singleRunning');

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold wrap="truncate">
        {allDone ? '✓' : '⠶'} {header}
      </Text>
      {agents.map((a, i) => {
        const last = i === agents.length - 1;
        const branch = last ? '└─' : '├─';
        const statusMark =
          a.status === 'done' ? '✓' : a.status === 'error' ? '✗' : a.status === 'running' ? '⠶' : '○';
        const statusColor =
          a.status === 'done' ? 'green' : a.status === 'error' ? 'red' : a.status === 'running' ? 'cyan' : 'gray';
        const statusText =
          a.status === 'done'
            ? t('agentGroup.status.done')
            : a.status === 'error'
              ? t('agentGroup.status.error')
              : a.status === 'running'
                ? t('agentGroup.status.running')
                : t('agentGroup.status.queued');
        return (
          <Box key={i} flexDirection="column">
            {/* 长 description / activity 截断到一行，动态区高度预算按 1 行/条精确成立 */}
            <Text wrap="truncate">
              {branch} <Text color="white">{a.type}</Text>
              <Text color="gray"> · {a.description} · {a.toolCount} tools · </Text>
              <Text color={statusColor}>{statusMark} {statusText}</Text>
            </Text>
            {a.status === 'running' && a.activity !== undefined && a.activity !== '' ? (
              <Text color="gray" wrap="truncate">    {a.activity}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}
