import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import { resolveShell, winPathToWsl, rewriteNulRedirect, type ResolvedShell } from './shellResolve.js';

const schema = z.object({
  command: z.string().describe('要执行的 shell 命令。'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('超时秒数，默认 60，上限 300。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('true 则后台执行并立即返回 task_id（用 task_list/task_output/task_stop 管理），不阻塞当前回合。'),
});

const DEFAULT_TIMEOUT = 60;
const MAX_TIMEOUT = 300;
const MAX_OUTPUT = 30_000;
/** 前台运行期间收集的部分输出上限（对齐原 spawnSync maxBuffer）。 */
const MAX_COLLECT = 10 * 1024 * 1024;

/**
 * 按 shell family 预处理命令与工作目录。
 * - WSL：wsl.exe 是 Windows 程序，cwd 传原生 Windows 路径给 spawn；bash 内部工作目录
 *   通过命令前加 `cd /mnt/...` 显式切换。同时把 NUL 重定向改写成 /dev/null。
 * - posix/busybox：cwd 直接用原生路径（Git Bash 的 bash.exe 认 Windows 路径，转 /c/ 反而报错）；
 *   NUL 重定向改写成 /dev/null。
 * - powershell/cmd：命令与 cwd 原样透传。
 * 返回处理后的 command 与传给 spawn 的 cwd。
 */
function prepareCommand(
  command: string,
  shell: ResolvedShell,
  cwd: string,
): { command: string; cwd: string } {
  if (shell.family === 'wsl') {
    const wslCwd = winPathToWsl(cwd);
    const withCd = wslCwd ? `cd '${wslCwd.replace(/'/g, "'\\''")}' && ${command}` : command;
    return { command: rewriteNulRedirect(withCd), cwd };
  }
  if (shell.family === 'posix' || shell.family === 'busybox') {
    return { command: rewriteNulRedirect(command), cwd };
  }
  return { command, cwd };
}

/** 截断超长输出（保留头部，与原 spawnSync 路径一致）。 */
function truncateOutput(out: string): string {
  if (out.length > MAX_OUTPUT) {
    return `${out.slice(0, MAX_OUTPUT)}\n\n[输出已截断，共 ${out.length} 字符]`;
  }
  return out;
}

/**
 * 前台执行命令：async spawn + 自行计时（不再用 spawnSync 的超时即杀）。
 * 三种结局：正常退出（按退出码返回）、用户 Esc 中断（杀进程报错）、前台超时。
 * 前台超时默认不杀：把进程收养进 BackgroundManager 重武装后台超时，tool_result 正常返回；
 * ctx.bashAutoBackgroundOnTimeout === false 或不支持后台任务时保持旧行为（超时即杀报错）。
 */
function runForeground(
  command: string,
  shell: ResolvedShell,
  spawnCwd: string,
  ctx: ToolContext,
  timeoutSec: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    if (ctx.signal?.aborted) {
      resolve(fail('用户中断，命令已终止。'));
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(shell.cmd, shell.args(command), { cwd: spawnCwd });
    } catch (e) {
      resolve(fail(`命令执行异常：${(e as Error).message}`));
      return;
    }

    let out = '';
    let settled = false;
    const append = (chunk: Buffer): void => {
      if (out.length < MAX_COLLECT) out += chunk.toString('utf8');
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);

    /** 清理前台计时与全部监听（转后台后输出收集由 manager 接管，故一并摘除）。 */
    const cleanup = (): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      proc.removeAllListeners('close');
      proc.removeAllListeners('error');
      proc.stdout?.removeAllListeners('data');
      proc.stderr?.removeAllListeners('data');
    };
    const finish = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    const onAbort = (): void => {
      proc.kill();
      finish(fail('用户中断，命令已终止。'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (e) => {
      finish(fail(`命令执行失败：${e.message}`));
    });
    proc.on('close', (code) => {
      // Esc 中断后进程被杀也会触发 close：中断语义优先（与旧行为一致）
      if (ctx.signal?.aborted) {
        finish(fail('用户中断，命令已终止。'));
        return;
      }
      const text = truncateOutput(out);
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        finish(fail(`${text}\n\n[退出码：${exitCode}]`));
      } else {
        finish(ok(text === '' ? '[命令执行完毕，无输出]' : text));
      }
    });

    const timer = setTimeout(() => {
      if (settled) return;
      const autoBackground = ctx.bashAutoBackgroundOnTimeout !== false && ctx.background !== undefined;
      if (!autoBackground) {
        // 配置关闭或上下文不支持后台：保持旧行为，超时即杀返回错误
        proc.kill();
        finish(fail(`命令超时（${timeoutSec}s）后被终止。`));
        return;
      }
      settled = true;
      cleanup();
      try {
        const id = ctx.background!.adopt(command, proc, out);
        const partial = out === '' ? '（暂无输出）' : truncateOutput(out);
        resolve(
          ok(
            `命令超过前台超时（${timeoutSec}s），已转为后台任务 ${id} 继续运行，不再阻塞当前回合。任务到达终态时你会收到完成通知；也可用 task_list 查看状态、task_output 看输出、task_stop 终止。\n\n已收集的部分输出：\n${partial}`,
          ),
        );
      } catch (e) {
        // 收养失败（如并发上限）：回退为超时即杀
        proc.kill();
        resolve(fail(`命令超时（${timeoutSec}s）后被终止。（转后台失败：${(e as Error).message}）`));
      }
    }, timeoutSec * 1000);
  });
}

export const bashTool: ToolDef<z.infer<typeof schema>> = {
  name: 'bash',
  description:
    '执行一条 shell 命令并返回合并后的 stdout+stderr。Windows 上优先用 Git Bash（Unix 语法），无则回退 WSL/busybox/PowerShell。避免交互式或永不结束的命令。run_in_background=true 时后台执行并立即返回 task_id。前台超时后命令自动转为后台任务继续运行。',
  schema,
  async execute(input, ctx) {
    const shell = resolveShell();
    if (shell.family === 'none') {
      return fail(
        'Windows 上未找到可用的 shell 解释器（Git Bash / WSL / busybox / PowerShell 都没有），无法执行命令。请安装 Git for Windows（提供 Git Bash），或把 bash.exe 绝对路径设到环境变量 STEP_SHELL_PATH。',
      );
    }
    const prepared = prepareCommand(input.command, shell, ctx.cwd);

    // 后台执行：起进程、注册、立即返回 task_id
    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      try {
        const id = ctx.background.start(
          input.command,
          shell.cmd,
          shell.args(prepared.command),
          prepared.cwd,
        );
        return ok(
          `已在后台启动任务 ${id}。任务到达终态时你会自动收到完成通知，不要起了就立刻等待或反复轮询；确需查看时用 task_list 看状态、task_output 看输出、task_stop 终止。`,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const timeoutSec = Math.min(input.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);
    return await runForeground(prepared.command, shell, prepared.cwd, ctx, timeoutSec);
  },
};
