import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  path: z.string().describe('要编辑的文件路径。'),
  old_string: z.string().describe('要被替换的原文，必须与文件中的内容逐字符匹配。'),
  new_string: z.string().describe('替换后的新内容。'),
  replace_all: z
    .boolean()
    .optional()
    .describe('是否替换全部匹配。默认 false，此时 old_string 必须唯一。'),
});

export const editFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'edit_file',
  description:
    '对已有文件做精确字符串替换。old_string 必须与文件内容逐字符匹配。默认要求唯一匹配，replace_all=true 时替换所有匹配。',
  schema,
  access: (input, ctx) => ({ kind: 'write', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return fail(`文件不存在或无法读取：${input.path}`);
    }

    if (input.old_string === input.new_string) {
      return fail('old_string 与 new_string 相同，无需编辑。');
    }

    const occurrences = text.split(input.old_string).length - 1;
    if (occurrences === 0) {
      return fail('未找到 old_string。请先 read_file 确认原文（含缩进与换行）后再试。');
    }
    if (occurrences > 1 && input.replace_all !== true) {
      return fail(
        `old_string 在文件中出现 ${occurrences} 次，不唯一。请补充上下文使其唯一，或设 replace_all=true。`,
      );
    }

    const next =
      input.replace_all === true
        ? text.split(input.old_string).join(input.new_string)
        : text.replace(input.old_string, input.new_string);

    try {
      writeFileSync(abs, next, 'utf8');
    } catch (e) {
      return fail(`写入失败：${(e as Error).message}`);
    }
    return ok(`已编辑 ${input.path}（替换 ${occurrences} 处）。`);
  },
};
