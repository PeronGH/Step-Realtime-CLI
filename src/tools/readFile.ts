import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  path: z.string().describe('要读取的文件路径，相对当前工作目录或绝对路径。'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('起始行号（1 起）。省略则从头读。'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('读取的行数。省略则读到文件末尾（受内部上限约束）。'),
});

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'read_file',
  description:
    '读取文本文件内容。支持用 offset/limit 按行分页。每行以「行号<TAB>内容」返回，末尾附 <system> 状态块（读取行数、总行数、是否截断）。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return fail(`文件不存在：${input.path}`);
    }
    if (st.isDirectory()) {
      return fail(`这是一个目录，不是文件：${input.path}。请用 list_dir。`);
    }
    if (st.size > MAX_BYTES && input.offset === undefined && input.limit === undefined) {
      return fail(
        `文件过大（${st.size} 字节，超过 ${MAX_BYTES}）。请用 offset/limit 分页读取。`,
      );
    }

    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      return fail(`读取失败：${(e as Error).message}`);
    }

    if (text === '') {
      return ok('<system>文件为空（0 字节）。</system>');
    }

    const lines = text.split('\n');
    const totalLines = lines.length;
    const start = input.offset !== undefined ? input.offset - 1 : 0;
    const count = Math.min(input.limit ?? MAX_LINES, MAX_LINES);
    const slice = lines.slice(start, start + count);
    const endLine = start + slice.length;
    const truncated = endLine < totalLines || start > 0;

    // 每行加「行号<TAB>内容」，行号从 start+1 起
    const numbered = slice
      .map((line, i) => `${start + i + 1}\t${line}`)
      .join('\n');

    const status = `<system>已读取第 ${start + 1}-${endLine} 行，共 ${totalLines} 行${
      truncated ? '（已截断，用 offset/limit 继续翻页）' : '（完整）'
    }。</system>`;

    return ok(`${numbered}\n${status}`);
  },
};
