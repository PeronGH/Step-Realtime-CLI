import { describe, expect, it } from 'vitest';
import { BackgroundManager, type BackgroundTask } from '../../src/agent/background/manager.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SH = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const shArgs = (cmd: string): string[] => (process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd]);
const LONG_CMD = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 25';

describe('BackgroundManager onSettle', () => {
  it('任务完成时触发 onSettle（completed），带输出尾部', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await sleep(500);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('completed');
    expect(settled[0]!.output).toContain('hi');
  });

  it('任务失败时触发 onSettle（failed），带退出码', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('exit 3', SH, shArgs('exit 3'), process.cwd());
    await sleep(500);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('failed');
    expect(settled[0]!.exitCode).toBe(3);
  });

  it('stop 终止时触发 onSettle（killed）', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    expect(mgr.stop(id)).toBe(true);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('killed');
  });

  it('去重：同一任务终态后 stop 不再触发，onSettle 只发一次', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await sleep(500);
    expect(mgr.stop(id)).toBe(false); // 已终态，无法再停
    await sleep(200);
    expect(settled).toHaveLength(1);
  });

  it('后台超时到期自动终止：先置 killed 并触发 onSettle', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { taskTimeoutS: 1, onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    expect(mgr.get(id)?.status).toBe('running');
    await sleep(2500);
    expect(mgr.get(id)?.status).toBe('killed');
    expect(mgr.get(id)?.output).toContain('后台任务超时（1s）');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('killed');
  });

  it('taskTimeoutS=0 时不武装超时', async () => {
    const mgr = new BackgroundManager(10, { taskTimeoutS: 0 });
    const id = mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await sleep(500);
    expect(mgr.get(id)?.status).toBe('completed');
  });

  it('startTask 的 async 任务终态同样触发 onSettle', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.startTask('async', Promise.resolve({ output: 'done', ok: true }));
    await sleep(100);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('completed');
  });
});

describe('BackgroundManager drainSettled', () => {
  it('终态任务进入待投递队列，drain 一次取空', async () => {
    const mgr = new BackgroundManager(10);
    mgr.startTask('a', Promise.resolve({ output: 'A', ok: true }));
    mgr.startTask('b', Promise.resolve({ output: 'B', ok: true }));
    await sleep(100);
    const drained = mgr.drainSettled();
    expect(drained.map((t) => t.command)).toEqual(['a', 'b']);
    expect(mgr.drainSettled()).toEqual([]); // 已取空，不重复投递
  });

  it('suppressNotification 后 stop：不触发 onSettle，也不入待投递队列', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    mgr.suppressNotification(id);
    expect(mgr.stop(id)).toBe(true);
    await sleep(200);
    expect(settled).toHaveLength(0);
    expect(mgr.drainSettled()).toEqual([]);
  });

  it('自然终态的任务不受 suppress 影响：照发通知并入队', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await sleep(500);
    expect(settled).toHaveLength(1);
    expect(mgr.drainSettled()).toHaveLength(1);
  });
});
