import { spawn, type ChildProcess } from 'node:child_process';

/** 后台任务状态。 */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';

export interface BackgroundTask {
  id: string;
  command: string;
  status: TaskStatus;
  /** 退出码（完成后）。 */
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  /** 合并输出（stdout+stderr，尾部，内存只留一部分）。 */
  output: string;
}

interface Internal extends BackgroundTask {
  proc?: ChildProcess;
  /** 后台超时定时器（armed 时存在，终态时清除）。 */
  timer?: NodeJS.Timeout;
  /** onSettle 是否已触发（同一任务只通知一次）。 */
  settled?: boolean;
  /** 进程是否已退出（区分 SIGTERM 宽限期内是否需补 SIGKILL）。 */
  exited?: boolean;
  /** 抑制终态通知（task_stop 亲手杀的任务不再发通知，防噪音）。 */
  suppressNotify?: boolean;
}

/** 后台任务管理器选项。 */
export interface BackgroundManagerOptions {
  /** 后台任务超时秒数：>0 时启动即武装，到期先 SIGTERM 后 SIGKILL；0/缺省 = 不限。 */
  taskTimeoutS?: number;
  /** 终态回调（完成/失败/被停），每个任务只触发一次。 */
  onSettle?: (t: BackgroundTask) => void;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // 内存只留 64KB 尾部
/** SIGTERM 后的宽限期（ms），未退出再 SIGKILL 强杀。 */
const KILL_GRACE_MS = 2000;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}-${counter}`;
}

/**
 * 后台任务管理器（最小面设计）：
 * 启动即返回 task_id 不阻塞；记录状态与输出尾部；终态后可供 task_list/task_output/task_stop 查询。
 * 终态一方面经 onSettle 回调上报（TUI 提示 / -p 收集），一方面入待投递队列，
 * 由 runAgent 在回合边界 drain 注入会话（或组合根兜底投递），模型无需轮询。
 */
export class BackgroundManager {
  private readonly tasks = new Map<string, Internal>();
  private readonly options: BackgroundManagerOptions;
  /** 已终态、待投递给会话的任务（runAgent 回合边界 drain 注入；抑制通知的任务不入队）。 */
  private readonly pendingSettled: BackgroundTask[] = [];

  constructor(private readonly maxRunning: number = 10, options: BackgroundManagerOptions = {}) {
    this.options = options;
  }

  activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === 'running') n++;
    return n;
  }

  /** 起一个后台 async 任务（如后台子 agent）。立即返回 task id，完成/失败自动置终态。 */
  startTask(label: string, run: Promise<{ output: string; ok: boolean }>, onDone?: (t: BackgroundTask) => void): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const id = nextId();
    const task: Internal = {
      id,
      command: label,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
    };
    this.tasks.set(id, task);
    this.armTimeout(task);
    void run
      .then((r) => {
        // 已被超时/停止置终态时，迟到的 promise 结果不再覆盖
        if (task.status !== 'running') return;
        task.output = r.output;
        task.status = r.ok ? 'completed' : 'failed';
      })
      .catch((e) => {
        if (task.status !== 'running') return;
        task.output = `任务异常：${(e as Error).message}`;
        task.status = 'failed';
      })
      .finally(() => {
        if (task.endedAt === undefined) task.endedAt = new Date().toISOString();
        if (task.output.length > MAX_OUTPUT_BYTES) {
          task.output = task.output.slice(task.output.length - MAX_OUTPUT_BYTES);
        }
        this.settle(task);
        onDone?.(task);
      });
    return id;
  }

  /** 起一个后台进程。超并发上限抛错。返回 task id。 */
  start(command: string, shellCmd: string, shellArgs: string[], cwd: string): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const proc = spawn(shellCmd, shellArgs, { cwd });
    return this.adopt(command, proc, '');
  }

  /**
   * 收养一个已在运行的进程为后台任务（前台超时转后台用）。
   * initialOutput 为收养前已收集的部分输出；收养后输出继续追加、后台超时重新武装。
   */
  adopt(command: string, proc: ChildProcess, initialOutput: string): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const id = nextId();
    const task: Internal = {
      id,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      output:
        initialOutput.length > MAX_OUTPUT_BYTES
          ? initialOutput.slice(initialOutput.length - MAX_OUTPUT_BYTES)
          : initialOutput,
      proc,
    };
    this.tasks.set(id, task);

    const append = (chunk: Buffer): void => {
      task.output += chunk.toString('utf8');
      if (task.output.length > MAX_OUTPUT_BYTES) {
        task.output = task.output.slice(task.output.length - MAX_OUTPUT_BYTES);
      }
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('error', (err) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.endedAt = new Date().toISOString();
        task.output += `\n[进程错误：${err.message}]`;
      }
      this.settle(task);
    });
    proc.on('close', (code) => {
      task.exited = true;
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
        task.exitCode = code ?? undefined;
        task.endedAt = new Date().toISOString();
      }
      this.settle(task);
    });
    this.armTimeout(task);
    return id;
  }

  /** 武装后台超时：到期终止（先 SIGTERM，宽限期后未退出补 SIGKILL）。taskTimeoutS<=0 时不武装。 */
  private armTimeout(task: Internal): void {
    const s = this.options.taskTimeoutS ?? 0;
    if (s <= 0) return;
    task.timer = setTimeout(() => {
      this.terminate(task, `后台任务超时（${s}s），已终止`);
    }, s * 1000);
    // 不阻止进程退出（非交互模式下遗留定时器不应挂住进程）
    task.timer.unref?.();
  }

  /** 终止运行中任务（超时路径）：附注原因，先温和后强杀，置终态并触发 onSettle。 */
  private terminate(task: Internal, note: string): void {
    if (task.status !== 'running') return;
    task.output += `${task.output === '' ? '' : '\n'}[${note}]`;
    task.proc?.kill('SIGTERM');
    const force = setTimeout(() => {
      if (task.exited !== true) task.proc?.kill('SIGKILL');
    }, KILL_GRACE_MS);
    force.unref?.();
    task.status = 'killed';
    task.endedAt = new Date().toISOString();
    this.settle(task);
  }

  /** 终态回调：每个任务只触发一次，顺带清理超时定时器。被抑制（task_stop）的任务跳过通知与入队。 */
  private settle(task: Internal): void {
    if (task.settled === true || task.status === 'running') return;
    task.settled = true;
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    if (task.suppressNotify === true) return;
    this.pendingSettled.push(task);
    this.options.onSettle?.(task);
  }

  /** 标记任务抑制终态通知（task_stop 调用时设置；对未终态任务生效，已终态任务无操作必要）。 */
  suppressNotification(id: string): void {
    const t = this.tasks.get(id);
    if (t !== undefined) t.suppressNotify = true;
  }

  /** 取走全部待投递的终态任务（清空队列），供 runAgent 回合边界注入或组合根兜底投递。 */
  drainSettled(): BackgroundTask[] {
    return this.pendingSettled.splice(0);
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map(({ proc: _p, timer: _t, settled: _s, exited: _e, suppressNotify: _n, ...rest }) => rest);
  }

  /** 终止任务。返回是否成功终止。 */
  stop(id: string): boolean {
    const t = this.tasks.get(id);
    if (t === undefined || t.status !== 'running') return false;
    t.proc?.kill('SIGTERM');
    t.status = 'killed';
    t.endedAt = new Date().toISOString();
    this.settle(t);
    return true;
  }
}
