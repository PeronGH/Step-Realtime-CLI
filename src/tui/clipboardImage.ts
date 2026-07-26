import { spawn } from 'node:child_process';

export interface ClipboardImage {
  mediaType: string;
  base64: string;
  width: number;
  height: number;
}

const WIN_PS = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
  '$img=[System.Windows.Forms.Clipboard]::GetImage();',
  'if($img){',
  '$ms=New-Object System.IO.MemoryStream;',
  '$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);',
  // 首行输出 宽x高，第二行起输出 base64——便于 Node 侧按行拆分
  'Write-Output ("{0}x{1}" -f $img.Width,$img.Height);',
  '[Convert]::ToBase64String($ms.ToArray())',
  '}',
].join('');

/**
 * 从系统剪贴板异步读取图片，返回 base64 PNG。无图片或不支持的平台返回 null。
 * 异步（不用 spawnSync）以免阻塞 Ink 渲染循环。
 * - Windows：PowerShell + System.Windows.Forms.Clipboard.GetImage()（需 STA 线程）。
 * - 其他平台：暂返回 null（后续可接 macOS pngpaste / Linux xclip）。
 */
export function readClipboardImage(): Promise<ClipboardImage | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', WIN_PS], {
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 10_000);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      // 首行是 "宽x高"，其余行拼成 base64
      const lines = out.split(/\r?\n/).filter((l) => l.trim() !== '');
      if (lines.length < 2) {
        resolve(null);
        return;
      }
      const dim = /^(\d+)x(\d+)$/.exec(lines[0]!.trim());
      const b64 = lines.slice(1).join('').replace(/\s+/g, '');
      if (dim === null || b64.length === 0) {
        resolve(null);
        return;
      }
      resolve({
        mediaType: 'image/png',
        base64: b64,
        width: Number.parseInt(dim[1]!, 10),
        height: Number.parseInt(dim[2]!, 10),
      });
    });
  });
}
