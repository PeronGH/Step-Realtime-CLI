import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  description: z.string().optional().describe('子任务简述（3-5 词）。'),
  prompt: z.string().optional().describe('完整任务描述（背景写全，子 agent 看不到父上下文）。'),
  subagent_type: z
    .string()
    .optional()
    .describe('子 agent 类型：general（全能）或 explore（只读调查），省略默认 general。'),
  run_in_background: z.boolean().optional().describe('后台异步执行，立即返回 task_id。'),
});

export const spawnAgentTool: ToolDef<z.infer<typeof schema>> = {
  name: 'spawn_agent',
  description:
    '派生一个子 agent 处理子任务（全新上下文、受限工具、只回摘要）。subagent_type 选 general（全能）或 explore（只读调查）。run_in_background=true 后台异步。一次要并行几个独立子任务，可在同一轮里发多个 spawn_agent（全为只读 explore 时并行执行）；带依赖的多阶段编排或大批量同构 fan-out 请改用 workflow 工具。',
  schema,
  // 只读 explore 无本地副作用（可并行）；general 可写必须独占（自然串行）
  access: (input) => ((input.subagent_type ?? 'general') === 'explore' ? { kind: 'none' } : { kind: 'all' }),
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持派生子 agent（子 agent 内不能再派生）。请自己完成该任务。');
    }

    const subagentType = input.subagent_type ?? 'general';
    const prompt = input.prompt ?? '';

    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      const run = ctx
        .runSubagent({
          subagentType,
          prompt,
          depth: ctx.depth ?? 0,
          signal: ctx.signal,
        })
        .then((r) => ({ output: r.summary, ok: !r.isError }));
      try {
        const id = ctx.background.startTask(`子agent·${input.description ?? '任务'}`, run);
        return ok(`已在后台派生子 agent（task_id=${id}）。用 task_output 查询结果。`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const result = await ctx.runSubagent({
      subagentType,
      prompt,
      depth: ctx.depth ?? 0,
      signal: ctx.signal,
    });
    // cause 透传给调度层：429 限流失败时父侧据此重排队尾（第二道防线）
    return result.isError ? { ...fail(result.summary), cause: result.cause } : ok(result.summary);
  },
};
