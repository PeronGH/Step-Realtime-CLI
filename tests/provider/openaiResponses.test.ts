import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildResponsesMessage } from '../../src/provider/openaiResponses.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';

function makeProvider(response: Response, capture?: { body?: unknown; url?: string }): OpenAiResponsesProvider {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (capture !== undefined) {
      capture.url = url;
      capture.body = JSON.parse(init.body as string);
    }
    return response;
  }) as unknown as typeof fetch;
  return new OpenAiResponsesProvider({
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com/v1',
    model: 'step-3.7-flash',
    maxTokens: 32768,
    fetchImpl,
  });
}

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

describe('buildResponsesMessage', () => {
  it('output 的 reasoning→thinking、message→text（thinking 在前）', () => {
    const msg = buildResponsesMessage(
      {
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '思考中' }] },
          { type: 'message', content: [{ type: 'output_text', text: '最终答复' }] },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      },
      'step-3.7-flash',
      32768,
    );
    expect(msg.content[0]).toMatchObject({ type: 'thinking', thinking: '思考中' });
    expect(msg.content[1]).toMatchObject({ type: 'text', text: '最终答复' });
    expect(msg.stop_reason).toBe('end_turn');
    expect(msg.usage.input_tokens).toBe(20);
    expect(msg.usage.output_tokens).toBe(8);
  });

  it('只有 message 段 → 仅 text 块', () => {
    const msg = buildResponsesMessage(
      { output: [{ type: 'message', content: [{ type: 'output_text', text: '纯对话' }] }] },
      'm',
      100,
    );
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]).toMatchObject({ type: 'text', text: '纯对话' });
  });

  it('缺 usage → usage 全 0', () => {
    const msg = buildResponsesMessage({ output: [] }, 'm', 100);
    expect(msg.usage.input_tokens).toBe(0);
    expect(msg.usage.output_tokens).toBe(0);
  });
});

describe('OpenAiResponsesProvider', () => {
  it('tools 非空 → 抛明确错误（不支持工具调用）', () => {
    const provider = makeProvider(jsonResponse({ output: [] }));
    expect(() =>
      provider.stream({
        system: '',
        tools: [{ name: 't', input_schema: {} } as unknown as Anthropic.Tool],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toThrow(/不支持工具调用/);
  });

  it('纯对话：finalMessage 含 thinking + text，for await 吐对应事件', async () => {
    const provider = makeProvider(
      jsonResponse({
        output: [
          { type: 'reasoning', content: [{ type: 'reasoning_text', text: '想' }] },
          { type: 'message', content: [{ type: 'output_text', text: '答' }] },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
    const stream = provider.stream({ system: '你是助手', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    const events: Anthropic.MessageStreamEvent[] = [];
    for await (const ev of stream) events.push(ev);
    const final = await stream.finalMessage();
    const kinds = events.map((e) => (e.type === 'content_block_delta' ? (e.delta as { type: string }).type : e.type));
    expect(kinds).toEqual(['thinking_delta', 'text_delta']);
    expect(final.content[1]).toMatchObject({ type: 'text', text: '答' });
  });

  it('请求体：input 含 system + user，URL 拼 /responses，只请求一次（for await + finalMessage 复用）', async () => {
    const capture: { body?: unknown; url?: string } = {};
    let calls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls++;
      capture.url = url;
      capture.body = JSON.parse(init.body as string);
      return jsonResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] });
    }) as unknown as typeof fetch;
    const provider = new OpenAiResponsesProvider({
      apiKey: 'k',
      baseUrl: 'https://api.stepfun.com/v1',
      model: 'step-3.7-flash',
      maxTokens: 100,
      fetchImpl,
    });
    const stream = provider.stream({ system: 'sys', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    for await (const _ of stream) { /* consume */ }
    await stream.finalMessage();
    expect(calls).toBe(1);
    expect(capture.url).toBe('https://api.stepfun.com/v1/responses');
    const body = capture.body as Record<string, unknown>;
    expect(body['input']).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]);
    expect(body['max_output_tokens']).toBe(100);
  });

  it('HTTP 错误 → 抛带 status 的 Anthropic APIError', async () => {
    const provider = makeProvider(jsonResponse({ error: { message: 'boom' } }, 500));
    const stream = provider.stream({ system: '', tools: [], messages: [{ role: 'user', content: 'hi' }] });
    await expect(stream.finalMessage()).rejects.toMatchObject({ status: 500 });
  });
});
