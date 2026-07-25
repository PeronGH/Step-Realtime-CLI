import { spawn } from 'node:child_process';

export interface ClipboardImage {
  mediaType: string;
  base64: string;
}

const WIN_PS = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing;',
  '$img=[System.Windows.Forms.Clipboard]::GetImage();',
  'if($img){',
  '$ms=New-Object System.IO.MemoryStream;',
  '$img.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);',
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
      const b64 = out.replace(/\s+/g, '');
      resolve(b64.length > 0 ? { mediaType: 'image/png', base64: b64 } : null);
    });
  });
}
