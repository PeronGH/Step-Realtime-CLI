import type Anthropic from '@anthropic-ai/sdk';
import {
  httpErrorToApiError,
  mapUsage,
  type OpenAiUsage,
} from './openaiCommon.js';
import type { ChatProvider } from './types.js';

/** {@link OpenAiResponsesProvider} 构造参数。 */
export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  /** 带 /v1 的 base_url（拼 /responses）。 */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** 注入的 fetch 实现（测试用 mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** Responses API 的一条 input 项（role + 纯文本内容）。 */
interface ResponsesInputItem {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把 Anthropic content block 拼成纯文本（忽略非文本块，Responses 纯对话场景够用）。 */
function blocksToText(content: string | Anthropic.ContentBlockParam[]): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}

/**
 * OpenAI Responses 协议 provider（/v1/responses），非流式，仅纯对话。
 *
 * 设计定位（实测）：Responses 工具调用会报错，故只注册为可选、纯对话场景，不作为 coding 默认。
 * tools 非空时直接抛明确错误（不静默吞工具，避免模型以为工具生效）。
 * output 数组的 reasoning 段翻译成 thinking 块、message 段翻译成 text 块，一次性给（非流式）。
 * finalMessage() 返回 Anthropic.Message 形状，消费方零改动；for await 一次性吐完 text/thinking 事件。
 */
export class OpenAiResponsesProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    model?: string;
    /** thinking 覆盖：openai_responses 协议无 thinking 请求字段，忽略此参数（仅为对齐 ChatProvider 签名）。 */
    thinking?: { budgetTokens?: number } | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    if (params.tools.length > 0) {
      throw new Error(
        'OpenAI Responses 协议（openai_responses）不支持工具调用，不适合 agent 主循环；' +
          '请改用 openai（Chat Completions）或 anthropic 协议。',
      );
    }
    const model = params.model ?? this.model;
    const input: ResponsesInputItem[] = [];
    if (params.system.length > 0) input.push({ role: 'system', content: params.system });
    for (const msg of params.messages) {
      // 纯对话：只保留 user/assistant 文本；工具相关块此路径不应出现（tools 已拦截）
      const text = blocksToText(msg.content);
      input.push({ role: msg.role, content: text });
    }
    const body: Record<string, unknown> = {
      model,
      input,
      max_output_tokens: this.maxTokens,
    };
    const fetchImpl = this.fetchImpl;
    const url = `${this.baseUrl}/responses`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
    const maxTokens = this.maxTokens;

    // 非流式：一次请求拿完整 JSON，解析 output → text/thinking，组装 Anthropic.Message。
    const run = async (): Promise<Anthropic.Message> => {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw httpErrorToApiError(res.status, errText, res.headers);
      }
      const json = (await res.json()) as ResponsesResponse;
      return buildResponsesMessage(json, model, maxTokens);
    };

    // 缓存 promise：for await 与 finalMessage() 复用同一次请求
    let cached: Promise<Anthropic.Message> | undefined;
    const once = (): Promise<Anthropic.Message> => (cached ??= run());

    const streamLike = {
      [Symbol.asyncIterator](): AsyncGenerator<Anthropic.MessageStreamEvent> {
        return (async function* () {
          const msg = await once();
          for (const block of msg.content) {
            if (block.type === 'thinking') {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: block.thinking },
              } as unknown as Anthropic.MessageStreamEvent;
            } else if (block.type === 'text') {
              yield {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: block.text },
              } as unknown as Anthropic.MessageStreamEvent;
            }
          }
        })();
      },
      async finalMessage(): Promise<Anthropic.Message> {
        return once();
      },
    };
    return streamLike as unknown as ReturnType<Anthropic['messages']['stream']>;
  }
}

/** Responses API 响应形状（宽松：容忍缺字段）。 */
interface ResponsesResponse {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: OpenAiResponsesUsage | null;
}

interface OpenAiResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** 把 Responses 的 output 数组组装成 Anthropic.Message（reasoning→thinking、message→text）。 */
export function buildResponsesMessage(
  json: { output?: ResponsesResponse['output']; usage?: OpenAiResponsesUsage | null },
  model: string,
  _maxTokens: number,
): Anthropic.Message {
  let thinking = '';
  let text = '';
  for (const item of json.output ?? []) {
    if (item.type === 'reasoning') {
      for (const c of item.content ?? []) {
        if (c.type === 'reasoning_text' && typeof c.text === 'string') thinking += c.text;
      }
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    }
  }
  const content: Anthropic.ContentBlock[] = [];
  if (thinking.length > 0) {
    content.push({ type: 'thinking', thinking, signature: '' } as unknown as Anthropic.ContentBlock);
  }
  if (text.length > 0) {
    content.push({ type: 'text', text, citations: null } as unknown as Anthropic.ContentBlock);
  }
  return {
    id: '',
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: json.usage != null ? mapResponsesUsage(json.usage) : emptyUsage(),
  } as unknown as Anthropic.Message;
}

/** Responses usage（input_tokens/output_tokens）→ Anthropic.Usage，复用 Chat 的 mapUsage 语义。 */
function mapResponsesUsage(usage: OpenAiResponsesUsage): Anthropic.Usage {
  const shim: OpenAiUsage = {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
  };
  const cached = usage.input_tokens_details?.cached_tokens;
  if (typeof cached === 'number') shim.prompt_tokens_details = { cached_tokens: cached };
  return mapUsage(shim);
}

function emptyUsage(): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  } as unknown as Anthropic.Usage;
}
