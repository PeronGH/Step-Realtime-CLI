import type { BackgroundTask } from './manager.js';

/** 通知里给模型看的输出尾部兜底预览上限（3KB 量级，防止长输出无谓占上下文）。 */
const PREVIEW_CHARS = 2000;

/**
 * 把后台任务终态装配为一条给模型看的通知文本（合成 user 消息的正文）。
 * 本体压到一行（来源标记 + 任务描述 + 终态 + 退出码），输出只给小尾部兜底预览，
 * 指引模型用 task_output 自取完整输出，模型无需轮询。
 * 给模型看的文案恒中文，不进 i18n。
 */
export function formatSettleNotification(task: BackgroundTask): string {
  const statusText =
    task.status === 'completed' ? '已完成' : task.status === 'failed' ? '失败' : '已被终止';
  const exitText = task.exitCode !== undefined ? `，退出码 ${task.exitCode}` : '';
  const tail =
    task.output.length > PREVIEW_CHARS ? task.output.slice(task.output.length - PREVIEW_CHARS) : task.output;
  return [
    `[background_task ${task.id}] 后台任务完成通知：${task.command} ${statusText}${exitText}。`,
    tail === '' ? '（无输出）' : `输出尾部预览：\n${tail}`,
    '（这是系统主动注入的后台任务终态通知，无需用 task_list 轮询；完整输出请用 task_output 自取。）',
  ].join('\n');
}

/** 通知注入路由：busy 时留在管理器待投递队列（runAgent 回合边界 flush），空闲时直接提交触发新回合。 */
export type NotifyRoute = 'enqueue' | 'submit';

export function decideNotifyRoute(busy: boolean): NotifyRoute {
  return busy ? 'enqueue' : 'submit';
}
