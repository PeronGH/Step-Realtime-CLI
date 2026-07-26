import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 跨平台 shell 解析：为 bash 工具与 system prompt 提供统一的解释器选择。
 *
 * Windows 探测链（对齐健壮实现，末端保留 cmd.exe 兜底）：
 *   环境变量覆盖 → PATH 中的 bash（排除 WSL 启动器）→ 从 git 推断 Git Bash
 *   → 注册表推断 Git Bash → WSL → busybox-w32 → PowerShell → cmd.exe。
 *
 * family 语义：
 *   - posix：Git Bash / MSYS bash / 原生 bash，标准 POSIX 语法
 *   - wsl：通过 wsl.exe 调用 Linux bash，需 /mnt 路径转换
 *   - busybox：busybox-w32 的 ash，仅基础 POSIX
 *   - powershell：cmdlet / PS 语法
 *   - none：未找到任何可用 shell（对齐业界，不回退 cmd.exe）；bash 工具据此报错引导装 Git Bash
 */
export type ShellFamily = 'posix' | 'wsl' | 'busybox' | 'powershell' | 'none';

export interface ResolvedShell {
  /** 解释器可执行文件路径或命令名。 */
  cmd: string;
  /** 由命令字符串构造 spawn 参数数组。 */
  args: (command: string) => string[];
  /** shell 家族，供路径转换与语法提示使用。 */
  family: ShellFamily;
}

/** 判断一个 bash 路径是否为 Windows 内置的 WSL 启动器（System32\bash.exe）。 */
function isWslLauncherPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.includes('windows\\system32\\bash') || lower.includes('windows\\syswow64\\bash');
}

/** 在 PATH 中查找可执行文件，返回绝对路径或 undefined。 */
function which(name: string): string | undefined {
  try {
    // where 在 Windows、command -v 在 POSIX；统一用 Node 的 execFileSync + 平台命令
    if (process.platform === 'win32') {
      const out = execFileSync('where', [name], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString();
      const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
      return first && existsSync(first) ? first : undefined;
    }
    const out = execFileSync('command', ['-v', name], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      shell: '/bin/sh',
    }).toString();
    const first = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    return first || undefined;
  } catch {
    return undefined;
  }
}

/** 从 Windows 注册表读取 Git for Windows 安装路径，拼出 bash.exe。 */
function gitBashFromRegistry(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const keys = [
    'HKLM\\SOFTWARE\\GitForWindows',
    'HKCU\\SOFTWARE\\GitForWindows',
  ];
  for (const key of keys) {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'InstallPath'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      }).toString();
      // 形如：    InstallPath    REG_SZ    C:\Program Files\Git
      const m = out.match(/InstallPath\s+REG_\w+\s+(.+)/);
      const installPath = m?.[1]?.trim();
      if (installPath) {
        for (const sub of ['bin', join('usr', 'bin')]) {
          const cand = join(installPath, sub, 'bash.exe');
          if (existsSync(cand)) return cand;
        }
      }
    } catch {
      // 该键不存在或 reg 不可用，继续下一个
    }
  }
  return undefined;
}

/** 从 git.exe 位置与 `git --exec-path` 推断同装的 Git Bash。 */
function gitBashFromGitExe(): string | undefined {
  const gitExe = which('git');
  if (!gitExe) return undefined;

  // git.exe 通常在 <root>\cmd\git.exe 或 <root>\bin\git.exe
  const parent = join(gitExe, '..', '..');
  for (const sub of ['bin', join('usr', 'bin')]) {
    const cand = join(parent, sub, 'bash.exe');
    if (existsSync(cand)) return cand;
  }

  // 通过 git --exec-path 推断：形如 C:\Program Files\Git\mingw64\libexec\git-core
  try {
    const execPath = execFileSync(gitExe, ['--exec-path'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
    const parts = execPath.split(/[/\\]/);
    const idx = parts.findIndex((p) => p.toLowerCase() === 'mingw32' || p.toLowerCase() === 'mingw64');
    if (idx > 0) {
      const root = parts.slice(0, idx).join('\\');
      for (const sub of ['bin', join('usr', 'bin')]) {
        const cand = join(root, sub, 'bash.exe');
        if (existsSync(cand)) return cand;
      }
    }
  } catch {
    // git --exec-path 失败，忽略
  }
  return undefined;
}

/** 在 Windows 上定位非 WSL 的 bash（Git Bash / MSYS2），逐级探测。 */
function findGitBash(): string | undefined {
  // 1. 环境变量覆盖（显式指定，最高优先）
  const override = (process.env['STEP_SHELL_PATH'] ?? '').trim();
  if (override && existsSync(override)) return override;

  // 2. PATH 中的 bash（排除 WSL 启动器）
  const inPath = which('bash');
  if (inPath && !isWslLauncherPath(inPath)) return inPath;

  // 3. 从 git.exe / git --exec-path 推断
  const fromGit = gitBashFromGitExe();
  if (fromGit) return fromGit;

  // 4. 注册表推断
  const fromReg = gitBashFromRegistry();
  if (fromReg) return fromReg;

  // 5. 固定候选路径
  const localAppData = process.env['LOCALAPPDATA'] ?? '';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    localAppData ? join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe') : '',
    localAppData ? join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe') : '',
  ].filter((p) => p.length > 0);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

/** 定位可用的 WSL：找到 wsl.exe 并能列出发行版才算可用。 */
function findWslBash(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const wslExe = which('wsl');
  if (!wslExe) return undefined;
  try {
    // 快速验证 WSL 可用（有已安装发行版），不启动完整发行版
    const out = execFileSync(wslExe, ['--list', '--quiet'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).toString();
    // wsl --list 输出常为 UTF-16LE，含大量 \x00；有非空可见内容即视为有发行版
    const cleaned = out.replace(/\u0000/g, '').trim();
    return cleaned.length > 0 ? wslExe : undefined;
  } catch {
    return undefined;
  }
}

/** 定位 busybox-w32（PATH 中）。 */
function findBusybox(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return which('busybox');
}

/** 定位 PowerShell：优先 pwsh（7+），回退 powershell.exe（5.1）。 */
function findPowerShell(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  return which('pwsh') ?? which('powershell');
}

/**
 * 解析当前平台应使用的 shell 解释器。
 *
 * Windows：Git Bash → WSL → busybox → PowerShell。对齐主流 coding CLI，
 *   不回退 cmd.exe（cmd 不认 Unix 语法，"能跑"反而让模型命令全崩、更难排查）；
 *   四者皆无时返回 family='none'，由 bash 工具报错引导用户装 Git Bash。
 * POSIX：$SHELL 或 /bin/bash。
 */
function detectShell(): ResolvedShell {
  if (process.platform !== 'win32') {
    return {
      cmd: process.env['SHELL'] ?? '/bin/bash',
      args: (command) => ['-c', command],
      family: 'posix',
    };
  }

  const gitBash = findGitBash();
  if (gitBash) {
    return { cmd: gitBash, args: (command) => ['-c', command], family: 'posix' };
  }

  const wsl = findWslBash();
  if (wsl) {
    // wsl.exe bash -c <command>
    return { cmd: wsl, args: (command) => ['bash', '-c', command], family: 'wsl' };
  }

  const busybox = findBusybox();
  if (busybox) {
    return { cmd: busybox, args: (command) => ['sh', '-c', command], family: 'busybox' };
  }

  const ps = findPowerShell();
  if (ps) {
    return { cmd: ps, args: (command) => ['-NoProfile', '-Command', command], family: 'powershell' };
  }

  // 未找到任何可用 shell。不回退 cmd.exe（对齐主流工具）。
  // 保留占位 cmd 便于类型统一，但 family='none' 会让 bash 工具直接报错。
  return { cmd: '', args: (command) => [command], family: 'none' };
}

let cached: ResolvedShell | undefined;

/** 解析 shell（模块级缓存，进程内只探测一次）。 */
export function resolveShell(): ResolvedShell {
  if (cached === undefined) {
    cached = detectShell();
  }
  return cached;
}

/** 测试用：清空探测缓存。 */
export function resetShellCache(): void {
  cached = undefined;
}

/**
 * 把 Windows 绝对路径转成 WSL 挂载路径。
 * C:\foo\bar -> /mnt/c/foo/bar；无法识别时返回 undefined。
 */
export function winPathToWsl(path: string): string | undefined {
  const m = /^([A-Za-z]):[/\\](.*)$/.exec(path);
  if (!m) return undefined;
  const drive = m[1]!.toLowerCase();
  const rest = m[2]!.replace(/\\/g, '/');
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

/**
 * 把 Windows 风格的 NUL 重定向改写成 POSIX 的 /dev/null。
 * `echo x >NUL 2>&1` -> `echo x > /dev/null 2>&1`。
 * Git Bash / WSL / busybox 都认 /dev/null，不认 Windows 的 NUL。
 */
export function rewriteNulRedirect(command: string): string {
  return command.replace(/(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g, '$1/dev/null');
}

/**
 * 生成 system prompt 里 bash 工具的 shell 语法提示行，按实际生效的 family 定制。
 * 这样即便回退到 PowerShell/cmd，也不会误导模型写 Unix 命令。
 */
export function shellPromptHint(family: ShellFamily): string {
  switch (family) {
    case 'posix':
      return process.platform === 'win32'
        ? '- bash 工具在 Windows 上通过 Git Bash 运行，用 Unix 语法与正斜杠路径（`ls`、`2>/dev/null`、`&&`）。'
        : '- bash 工具用 Unix 语法（bash/sh），正斜杠路径。';
    case 'wsl':
      return '- bash 工具通过 WSL（Linux bash）运行，用 Unix 语法；访问 Windows 文件走 `/mnt/c/` 挂载路径。';
    case 'busybox':
      return '- bash 工具通过 busybox-w32（ash）运行，仅支持基础 POSIX 命令，避免 GNU bash 扩展（数组、`[[ ]]` 等）。';
    case 'powershell':
      return '- 未检测到 POSIX shell，bash 工具回退到 PowerShell：用 cmdlet/PS 语法（`Get-ChildItem`、`2>$null`、反斜杠路径），不要写 Unix 语法（`ls`、`2>/dev/null` 会失败）。';
    case 'none':
      return '- 未检测到任何可用 shell（Git Bash / WSL / busybox / PowerShell 都没有），bash 工具将无法执行命令。请先安装 Git for Windows（提供 Git Bash）。';
  }
}

