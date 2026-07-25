import { PROVIDER_PRESETS, type StepCodeConfig } from '../config/config.js';
import { t } from '../i18n.js';
import { AnthropicMessagesProvider } from './anthropicMessages.js';
import { OpenAiChatProvider } from './openaiChat.js';
import { OpenAiResponsesProvider } from './openaiResponses.js';
import type { ChatProvider } from './types.js';

/**
 * 按 config.provider 构造对应的 ChatProvider。
 *
 * 按预设的 protocol 分发到三个协议适配器：
 * - anthropic（stepfun/anthropic 预设）→ {@link AnthropicMessagesProvider}
 * - openai → {@link OpenAiChatProvider}（/v1/chat/completions）
 * - openai_responses → {@link OpenAiResponsesProvider}（/v1/responses，纯对话）
 * 未知 provider（不在 PROVIDER_PRESETS 内）抛错。
 */
export function createProvider(config: StepCodeConfig): ChatProvider {
  const preset = PROVIDER_PRESETS[config.provider];
  if (preset === undefined) {
    throw new Error(
      t('factory.unknownProvider', { provider: config.provider, list: Object.keys(PROVIDER_PRESETS).join(' | ') }),
    );
  }

  if (preset.protocol === 'openai') {
    return new OpenAiChatProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  }
  if (preset.protocol === 'openai_responses') {
    return new OpenAiResponsesProvider({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
    });
  }

  // anthropic 协议（默认）：thinking 请求字段仅当用户显式配置 [thinking] enabled=true 时发。
  // stepfun 预设 sendThinking 为 false（历史实测部分模型 400），此处由用户配置覆盖为 true；
  // anthropic 预设虽为 true，未配 [thinking] 时 thinking 参数为空，照样不发。
  // [thinking] 的 budget 语义只对 anthropic 有效；openai 协议下上面已分发、不走到这里，故忽略。
  const thinkingEnabled = config.thinking?.enabled === true;
  return new AnthropicMessagesProvider({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: config.maxTokens,
    sendThinking: preset.sendThinking || thinkingEnabled,
    thinking: thinkingEnabled ? { budgetTokens: config.thinking?.budgetTokens } : undefined,
  });
}
