import { describe, expect, it } from 'vitest';
import {
  resolveShell,
  resetShellCache,
  winPathToWsl,
  rewriteNulRedirect,
  shellPromptHint,
  type ShellFamily,
} from '../../src/tools/shellResolve.js';

describe('winPathToWsl', () => {
  it('C 盘路径转 /mnt/c', () => {
    expect(winPathToWsl('C:\\foo\\bar')).toBe('/mnt/c/foo/bar');
  });

  it('正斜杠输入也能转', () => {
    expect(winPathToWsl('D:/a/b')).toBe('/mnt/d/a/b');
  });

  it('盘符根目录', () => {
    expect(winPathToWsl('C:\\')).toBe('/mnt/c');
  });

  it('小写盘符归一化为小写', () => {
    expect(winPathToWsl('e:\\x')).toBe('/mnt/e/x');
  });

  it('非 Windows 绝对路径返回 undefined', () => {
    expect(winPathToWsl('/home/user')).toBeUndefined();
    expect(winPathToWsl('relative/path')).toBeUndefined();
  });
});

describe('rewriteNulRedirect', () => {
  it('>NUL 2>&1 改写为 /dev/null', () => {
    expect(rewriteNulRedirect('echo x >NUL 2>&1')).toBe('echo x >/dev/null 2>&1');
  });

  it('2>NUL 改写', () => {
    expect(rewriteNulRedirect('cmd 2>NUL')).toBe('cmd 2>/dev/null');
  });

  it('大小写不敏感', () => {
    expect(rewriteNulRedirect('cmd >nul')).toBe('cmd >/dev/null');
    expect(rewriteNulRedirect('cmd >Nul')).toBe('cmd >/dev/null');
  });

  it('不误伤普通单词 NULL/nullable', () => {
    expect(rewriteNulRedirect('echo NULL')).toBe('echo NULL');
    expect(rewriteNulRedirect('grep nullable file')).toBe('grep nullable file');
  });

  it('保留重定向前缀空白与操作符', () => {
    expect(rewriteNulRedirect('cmd > NUL')).toBe('cmd > /dev/null');
  });
});

describe('shellPromptHint', () => {
  const families: ShellFamily[] = ['posix', 'wsl', 'busybox', 'powershell', 'none'];

  it('每个 family 都返回非空提示且以 - 开头', () => {
    for (const f of families) {
      const hint = shellPromptHint(f);
      expect(hint.length).toBeGreaterThan(0);
      expect(hint.startsWith('- ')).toBe(true);
    }
  });

  it('powershell 提示明确不要写 Unix 语法', () => {
    expect(shellPromptHint('powershell')).toContain('Unix 语法');
  });

  it('none 提示引导安装 Git for Windows', () => {
    expect(shellPromptHint('none')).toContain('Git for Windows');
  });

  it('wsl 提示提到 /mnt 挂载', () => {
    expect(shellPromptHint('wsl')).toContain('/mnt/');
  });
});

describe('resolveShell', () => {
  it('返回可用的解释器与合法 family（不含 cmd 兜底）', () => {
    resetShellCache();
    const shell = resolveShell();
    expect(['posix', 'wsl', 'busybox', 'powershell', 'none']).toContain(shell.family);
    // args 是纯函数，能把命令拼进参数数组
    const argv = shell.args('echo hi');
    expect(argv[argv.length - 1]).toBe('echo hi');
  });

  it('缓存：连续两次返回同一对象', () => {
    resetShellCache();
    const a = resolveShell();
    const b = resolveShell();
    expect(a).toBe(b);
  });

  it('非 Windows 平台走 posix 分支', () => {
    if (process.platform === 'win32') return; // 该断言只在 POSIX 有意义
    resetShellCache();
    const shell = resolveShell();
    expect(shell.family).toBe('posix');
    expect(shell.args('ls')).toEqual(['-c', 'ls']);
  });
});
