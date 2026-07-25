import { z } from 'zod';
import { runWorkflow, type WorkflowDef } from '../agent/workflow.js';
import { fail, ok, type ToolDef } from './types.js';

const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('parallel'),
    tasks: z.array(z.object({ prompt: z.string(), label: z.string().optional(), subagentType: z.string().optional() })),
    as: z.string(),
  }),
  z.object({
    kind: z.literal('fanout'),
    items: z.array(z.string()),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('synthesize'),
    from: z.array(z.string()),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
  }),
]);

const schema = z.object({
  name: z.string().describe('workflow 名称。'),
  description: z.string().optional(),
  steps: z.array(stepSchema).describe('编排步骤：agent（单个子任务）/ parallel（并行多个）/ fanout（对列表每项并行）/ synthesize（汇总）。步骤结果用 as 命名，后续步骤用 {{名}} 引用。'),
  max_agents: z.number().int().positive().optional().describe('agent 总数上限（护栏），默认 50。'),
});

/**
 * 运行动态工作流：用声明式步骤模板编排多个子 agent。
 * 中间结果存运行时状态（不占主上下文），主会话只收最终报告。
 * 用于复杂多步任务：fan-out 并行调查→synthesize 综合、分阶段处理、loop-until-done 等。
 */
export const workflowTool: ToolDef<z.infer<typeof schema>> = {
  name: 'workflow',
  description:
    '运行动态工作流：声明式编排多个子 agent（agent/parallel/fanout/synthesize 步骤）。中间结果不占上下文，只回最终报告。适合复杂多步任务：并行调查后综合、分阶段处理、批量分析。比逐个 spawn_agent 更高效。',
  schema,
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持 workflow（需要子 agent 能力）。');
    }
    const def: WorkflowDef = {
      name: input.name,
      description: input.description,
      steps: input.steps,
      maxAgents: input.max_agents,
    };
    try {
      const r = await runWorkflow(def, {
        runSubagent: ctx.runSubagent,
        maxConcurrent: ctx.subagentMaxConcurrent ?? 4,
        args: {},
        onStep: ctx.onWorkflowStep,
      });
      return ok(
        `workflow「${input.name}」完成（${r.steps} 步，用 ${r.agentsUsed} 个子 agent）：\n\n${r.report}`,
      );
    } catch (e) {
      return fail(`workflow 执行失败：${(e as Error).message}`);
    }
  },
};
