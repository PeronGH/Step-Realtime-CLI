/** agent 循环向外发出的事件，供 UI（Ink 或非交互打印）消费。 */
export type AgentEvent =
  | { type: 'text'; text: string }
  /** 思考（推理过程）文本增量。渲染无条件消费：恒思考模型即使请求未发 thinking 字段也会返回 thinking 块。 */
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; result: string; isError: boolean }
  | { type: 'retry'; attempt: number; delayMs: number; message: string }
  | { type: 'aborted' }
  | { type: 'turn_done' }
  | { type: 'notice'; message: string }
  | { type: 'usage'; totalTokens: number }
  /** cause：原始错误对象（内部元数据，UI 不消费），供子 agent 运行器识别 429 做重排队判定。 */
  | { type: 'error'; message: string; cause?: unknown };

/** 子 agent 进度事件（独立通道，经 runner 的 onEvent 上抛，带 id 区分并行子 agent）。 */
export type SubagentProgressEvent =
  | { kind: 'start'; subagentType: string; description: string }
  | { kind: 'tool'; name: string }
  | { kind: 'error'; message: string }
  | { kind: 'end'; isError: boolean };
