/** 子 agent 角色定义。来源：内置代码 + 用户/项目的 markdown（YAML frontmatter）。 */
export interface AgentDefinition {
  name: string;
  /** 供主 agent 自动选型的说明。 */
  description: string;
  /** 工具名白名单；undefined = 该角色可用全部工具（运行时会再强制剔除 spawn_agent）。 */
  tools?: string[];
  /** 模型覆盖；undefined = 继承父 agent 的模型。 */
  model?: string;
  /** 权限模式覆盖；undefined = 继承父。 */
  mode?: string;
  /** 单次子 agent 最大 模型↔工具 往返轮数；undefined = 用 config 的全局默认（subagent.maxSteps）。 */
  maxSteps?: number;
  /** system prompt（markdown 定义时取正文）。 */
  systemPrompt: string;
}

/** 子 agent 派生请求。 */
export interface SpawnSubagentRequest {
  subagentType: string;
  prompt: string;
  /** 父 agent 的当前深度（父 = 0）。 */
  depth: number;
  signal?: AbortSignal;
  /** 该子 agent 的标识（并行时区分各子 agent 的进度事件）。 */
  id?: string;
}

/** 子 agent 执行结果（回灌给父的摘要）。 */
export interface SubagentResult {
  summary: string;
  isError: boolean;
  /** 导致失败的原始错误对象（内部元数据，不进 wire）：父侧调度层据此识别 429 做重排队。 */
  cause?: unknown;
}

/** 由组合根（App / main）注入的子 agent 运行器类型。 */
export type RunSubagentFn = (req: SpawnSubagentRequest) => Promise<SubagentResult>;
