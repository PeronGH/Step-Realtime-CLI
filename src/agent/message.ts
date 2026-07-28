import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * storage 层 message 的来源标记：决定 undo 边界、压缩处理、以及投影到 wire 时的取舍。
 * - user/assistant/tool：正常对话轮
 * - user_verbatim：压缩时保真保留的用户原话（wire 里就是普通 user 消息，storage 层可识别）
 * - compaction_summary：full 压缩产出的摘要（wire 里是普通文本，storage 层可识别）
 * - injection：注入的 system-reminder（append-only，压缩后可重注入）
 *
 * `user_verbatim` 与 `user` 的分工：前者是压缩产物、不是真人这一轮的输入。
 * 因此它**不**参与轮次计数（turns.ts）与回退编辑（backtrack.ts）——那两处按 `=== 'user'`
 * 全等判断，新类型天然被排除，这是有意的：否则 Ctrl+回退会把压缩保真块当成
 * 「上一条用户输入」取回输入框，轮数也会随压缩虚增。
 * 但它**要**参与下一轮压缩的保真选择（compact.ts 的 isCompactableUserOrigin），
 * 这正是原话能跨多轮压缩存活的机制。
 */
export type MessageOrigin =
  | 'user'
  | 'user_verbatim'
  | 'assistant'
  | 'tool'
  | 'compaction_summary'
  | 'injection';

/**
 * 存储层 message（信封结构）。内层 `message` 就是干净的 Anthropic wire 格式，
 * 元数据（origin/id/ts）一律在外层，绝不进 wire——发 provider 时用 toWire 取内层。
 * 这样元数据物理隔离，不可能泄漏进 Anthropic 请求（严格 schema，多余字段会 400）。
 *
 * 图片落盘形态：内存态 `message` 里图片 `source.data` 是原始 base64；落盘时（store.save/appendFull）
 * 会把大图卸载成附件文件、`source.data` 换成 `stepref:<sha256>` 指针（见 session/attachments.ts）。
 * 故从盘上读回的 StoredMessage 其图片可能是 stepref，发 provider 前由 toWire rehydrate 回 base64。
 */
export interface StoredMessage {
  /** 内层 = 干净 wire 格式。 */
  message: Anthropic.MessageParam;
  /** 来源标记。 */
  origin: MessageOrigin;
  /** 稳定 id，供将来 append-only 持久化与 UI 时间线。 */
  id: string;
  /** ISO 时间戳，审计/展示用，不进 wire。 */
  ts: string;
}

/** 包一条 storage 消息（生成 id/ts）。 */
export function stored(message: Anthropic.MessageParam, origin: MessageOrigin): StoredMessage {
  return { message, origin, id: randomUUID(), ts: new Date().toISOString() };
}
