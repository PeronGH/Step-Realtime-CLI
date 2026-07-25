import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { createProvider } from '../../src/provider/factory.js';
import { AnthropicMessagesProvider } from '../../src/provider/anthropicMessages.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';

function baseConfig(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 1_000_000,
    maxTokens: 8192,
    subagent: { maxPerSession: 10, maxDepth: 1, maxSteps: 100, maxConcurrent: 4 },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    ...overrides,
  };
}

describe('createProvider', () => {
  it('stepfun → AnthropicMessagesProvider 实例', () => {
    const p = createProvider(baseConfig({ provider: 'stepfun' }));
    expect(p).toBeInstanceOf(AnthropicMessagesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('anthropic → AnthropicMessagesProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' }),
    );
    expect(p).toBeInstanceOf(AnthropicMessagesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai → OpenAiChatProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    expect(p).toBeInstanceOf(OpenAiChatProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('openai_responses → OpenAiResponsesProvider 实例', () => {
    const p = createProvider(
      baseConfig({ provider: 'openai_responses', baseUrl: 'https://api.stepfun.com/v1' }),
    );
    expect(p).toBeInstanceOf(OpenAiResponsesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('未知 provider → 抛清晰错误', () => {
    expect(() => createProvider(baseConfig({ provider: 'not-a-real-provider' }))).toThrow(/未知服务商/);
  });

  it('stepfun + [thinking] enabled=true → sendThinking 覆盖为 true 并注入 budget', () => {
    const p = createProvider(baseConfig({ thinking: { enabled: true, budgetTokens: 4096 } }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: { budgetTokens?: number } };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking).toEqual({ budgetTokens: 4096 });
  });

  it('stepfun + [thinking] enabled=true 未配 budget → thinking 参数存在但无 budgetTokens', () => {
    const p = createProvider(baseConfig({ thinking: { enabled: true } }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: { budgetTokens?: number } };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking).toEqual({ budgetTokens: undefined });
  });

  it('stepfun 未配 [thinking] → sendThinking 保持 false，无 thinking 参数（既有行为不变）', () => {
    const p = createProvider(baseConfig());
    const internals = p as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(internals.sendThinking).toBe(false);
    expect(internals.thinking).toBeUndefined();
  });

  it('anthropic 预设 sendThinking=true，但未配 [thinking] 时不注入 thinking 参数', () => {
    const p = createProvider(baseConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }));
    const internals = p as unknown as { sendThinking: boolean; thinking?: unknown };
    expect(internals.sendThinking).toBe(true);
    expect(internals.thinking).toBeUndefined();
  });
});
