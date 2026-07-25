import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '../../src/agent/background/manager.js';
import { decideNotifyRoute, formatSettleNotification } from '../../src/agent/background/notify.js';

function makeTask(over: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: 't123',
    command: 'npm test',
    status: 'completed',
    startedAt: '2026-07-23T00:00:00.000Z',
    output: '',
    ...over,
  };
}

describe('formatSettleNotification', () => {
  it('完成：一行本体带来源标记（background_task + task id）、命令与终态', () => {
    const text = formatSettleNotification(makeTask({ output: 'all passed' }));
    const head = text.split('\n')[0]!;
    expect(head).toContain('[background_task t123]');
    expect(head).toContain('npm test');
    expect(head).toContain('已完成');
  });

  it('指引模型用 task_output 自取完整输出，无需轮询', () => {
    const text = formatSettleNotification(makeTask({ output: 'all passed' }));
    expect(text).toContain('task_output');
    expect(text).toContain('无需用 task_list 轮询');
  });

  it('失败：带退出码', () => {
    const text = formatSettleNotification(makeTask({ status: 'failed', exitCode: 2, output: 'boom' }));
    expect(text).toContain('失败');
    expect(text).toContain('退出码 2');
    expect(text).toContain('boom');
  });

  it('被终止：终态文案为已被终止', () => {
    const text = formatSettleNotification(makeTask({ status: 'killed' }));
    expect(text).toContain('已被终止');
  });

  it('无输出时标注（无输出）', () => {
    const text = formatSettleNotification(makeTask({ output: '' }));
    expect(text).toContain('（无输出）');
  });

  it('输出超兜底预览上限时只保留尾部', () => {
    const out = `head-${'x'.repeat(3000)}-tail`;
    const text = formatSettleNotification(makeTask({ output: out }));
    expect(text).toContain('-tail');
    expect(text).not.toContain('head-');
  });
});

describe('decideNotifyRoute', () => {
  it('busy 时入队（留给回合边界 flush），空闲时直接提交', () => {
    expect(decideNotifyRoute(true)).toBe('enqueue');
    expect(decideNotifyRoute(false)).toBe('submit');
  });
});
