import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { bashTool } from '../../src/tools/bash.js';

describe('bash 前台执行', () => {
  it('正常命令返回输出（非 error）', async () => {
    const r = await bashTool.execute({ command: 'echo hello' }, { cwd: process.cwd() });
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hello');
  });

  it('非零退出码返回 error 并带退出码', async () => {
    const r = await bashTool.execute({ command: 'exit 3' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('退出码：3');
  });

  it('Esc 中断（abort）：杀进程返回中断错误', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const r = await bashTool.execute(
      { command: 'sleep 5', timeout: 60 },
      { cwd: process.cwd(), signal: controller.signal, background: new BackgroundManager() },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('用户中断');
  });
});

describe('bash 前台超时自动转后台', () => {
  it('超时后转后台：tool_result 非 error、任务入册、带部分输出', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'echo before; sleep 5', timeout: 1 },
      { cwd: process.cwd(), background: mgr },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('已转为后台任务');
    expect(r.content).toContain('before'); // 已收集的部分输出
    const tasks = mgr.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('running');
    expect(r.content).toContain(tasks[0]!.id);
    mgr.stop(tasks[0]!.id);
  });

  it('配置关闭（bashAutoBackgroundOnTimeout=false）时维持超时即杀', async () => {
    const mgr = new BackgroundManager();
    const r = await bashTool.execute(
      { command: 'sleep 5', timeout: 1 },
      { cwd: process.cwd(), background: mgr, bashAutoBackgroundOnTimeout: false },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('命令超时（1s）后被终止');
    expect(mgr.list()).toHaveLength(0);
  });

  it('上下文不支持后台任务时也维持超时即杀', async () => {
    const r = await bashTool.execute({ command: 'sleep 5', timeout: 1 }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('命令超时（1s）后被终止');
  });

  it('转后台的任务由 manager 的后台超时接管', async () => {
    const mgr = new BackgroundManager(10, { taskTimeoutS: 2 });
    const r = await bashTool.execute({ command: 'sleep 30', timeout: 1 }, { cwd: process.cwd(), background: mgr });
    expect(r.isError).toBe(false);
    const id = mgr.list()[0]!.id;
    // 后台超时 2s 到期后应被终止（从收养时点起算）
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(mgr.get(id)?.status).toBe('killed');
  }, 10_000);
});
