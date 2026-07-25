import type { StepCodeConfig } from '../config/config.js';
import { AnthropicMessagesProvider } from './anthropicMessages.js';

/**
 * StepFun 的接入。现为 {@link AnthropicMessagesProvider} 的薄封装：
 * 固定 sendThinking:false，保持 StepFun 侧的硬约束（绝不传 thinking 字段），
 * stream 行为与历史版本字节级一致。保留此类是为兼容任何遗留的直接引用。
 *
 * 硬约束（实测确认）：
 * - 走 Anthropic Messages 协议，base_url 不带 /v1（SDK 自动拼 /v1/messages）。
 * - 鉴权走 x-api-key（SDK 的 apiKey 即映射到此）。
 * - 绝不传 thinking 字段（保持既有默认行为，避免不兼容时 400）。
 * - system 走顶层 system 参数。
 */
export class StepProvider extends AnthropicMessagesProvider {
  constructor(config: StepCodeConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      sendThinking: false,
    });
  }
}
