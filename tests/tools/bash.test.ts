import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';
import { bashTool, prepareCommand } from '../../src/tools/bash.js';
import type { ResolvedShell, ShellFamily } from '../../src/tools/shellResolve.js';

/** 构造指定 family 的 ResolvedShell 桩（args/cmd 不影响 prepareCommand 逻辑）。 */
function shellOf(family: ShellFamily): ResolvedShell {
  return { cmd: 'x', args: (c) => [c], family };
}

describe('prepareCommand 按 family 预处理', () => {
  it('posix：NUL 重定向改写，cwd 原样', () => {
    const r = prepareCommand('echo x >NUL 2>&1', shellOf('posix'), 'C:\\proj');
    expect(r.command).toBe('echo x >/dev/null 2>&1');
    expect(r.cwd).toBe('C:\\proj');
  });

  it('busybox：同样改写 NUL', () => {
    const r = prepareCommand('cmd 2>NUL', shellOf('busybox'), 'C:\\p');
    expect(r.command).toBe('cmd 2>/dev/null');
  });

  it('wsl：命令前拼 cd /mnt 挂载路径 + 改写 NUL，spawn cwd 保持原生 Windows 路径', () => {
    const r = prepareCommand('ls >NUL', shellOf('wsl'), 'C:\\proj\\sub');
    expect(r.command).toBe("cd '/mnt/c/proj/sub' && ls >/dev/null");
    expect(r.cwd).toBe('C:\\proj\\sub'); // wsl.exe 是 Windows 程序，spawn 用原生路径
  });

  it('wsl：winPathToWsl 无法识别的 cwd 时不加 cd 前缀', () => {
    const r = prepareCommand('ls', shellOf('wsl'), 'relative/path');
    expect(r.command).toBe('ls'); // 无 cd 前缀
  });

  it('powershell：命令与 cwd 原样透传，不改 NUL', () => {
    const r = prepareCommand('Get-ChildItem 2>$null', shellOf('powershell'), 'C:\\p');
    expect(r.command).toBe('Get-ChildItem 2>$null');
    expect(r.cwd).toBe('C:\\p');
  });
});

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
