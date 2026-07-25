import type Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider } from '../../provider/types.js';
import { isStepref, STEPREF_PREFIX } from '../../session/attachments.js';
import { stored, type StoredMessage } from '../message.js';

const CLEARED_PLACEHOLDER = '[旧工具结果已清理以节省上下文]';

/**
 * 每张图片按固定 token 常数估算。
 * 图片的 base64/stepref 字符数与其真实视觉 token 成本无关，按字符数算会严重高估（一张 1MB 图 ≈ 46 万"token"）。
 * 取一个贴近视觉 token 量级的常数，避免有图时 /compact 展示与兜底判断失真。
 */
const PER_IMAGE_TOKENS = 1500;

/**
 * 粗略估算消息占用的 token 数。用于压缩阈值判断，不追求精确。
 * 启发式：文本按序列化后的字符数 / 3（CJK 约 1-2 字符/token、ASCII 约 4，取折中）；
 * 图片块不按 base64/stepref 字符数算，改按 PER_IMAGE_TOKENS 常数（见上）。
 * 优先用 provider 返回的真实 usage（见 usageTotalTokens），本地估算只作尾部补充/兜底。
 */
export function estimateTokens(messages: readonly StoredMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    const c = m.message.content;
    if (typeof c === 'string') {
      chars += c.length;
      continue;
    }
    for (const block of c) {
      if (block.type === 'image') {
        images++;
      } else {
        chars += JSON.stringify(block).length;
      }
    }
  }
  return Math.ceil(chars / 3) + images * PER_IMAGE_TOKENS;
}

/**
 * 从 provider 返回的真实 usage 求上下文总占用 token：输入（含缓存读/写）+ 输出。
 * 这是压缩判断的主依据，比字符估算准得多。
 */
export function usageTotalTokens(usage: Anthropic.Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/** 压缩触发阈值。 */
export interface CompactionThresholds {
  /** 模型上下文上限（token）。 */
  maxContextSize: number;
  /** 触发比例：占用达到 maxContextSize × 此值即压缩。 */
  triggerRatio: number;
  /** 预留量：剩余窗口不足此值即压缩（给下一次生成留安全垫）。 */
  reservedTokens: number;
}

/** 是否该压缩：占用超过比例阈值，或剩余窗口不足预留量（两条件取或）。 */
export function shouldCompact(usedTokens: number, t: CompactionThresholds): boolean {
  if (t.maxContextSize <= 0) return false;
  return (
    usedTokens >= t.maxContextSize * t.triggerRatio ||
    usedTokens + t.reservedTokens >= t.maxContextSize
  );
}

export interface MicroCompactResult {
  messages: StoredMessage[];
  /** 被清理正文的 tool_result 块数量。 */
  clearedCount: number;
}

/** 缓存冷阈值：距上次活动超过此时长（默认 1 小时），才认定 prompt cache 前缀已过期。 */
export const CACHE_COLD_MS = 60 * 60 * 1000;

/**
 * micro 压缩的缓存 gate：仅当缓存已冷时才允许原地改写历史。
 * lastActivityMs = 上次向 provider 发请求（约等于最后一条 assistant 消息）的时间戳。
 */
export interface MicroCompactCacheGate {
  lastActivityMs: number;
  /** 当前时间 ms，默认 Date.now()。 */
  nowMs?: number;
  /** 缓存冷阈值 ms，默认 CACHE_COLD_MS。 */
  cacheColdMs?: number;
}

/**
 * 微压缩：清空「较旧」的 tool_result 块正文（保留结构与最近 keepRecent 条消息完整）。
 * 只改内层 message 的正文、不删消息、不动信封元数据，tool_use↔tool_result 配对结构不变。
 * 返回新数组，不改动入参。
 *
 * prompt cache 注意：原地改写历史内容会使该位置之后的缓存前缀全部失效——这不是「对缓存友好」的操作。
 * 故传入 cacheGate 时，仅当缓存已冷（距上次活动 ≥ cacheColdMs）才执行改写；缓存仍热时跳过（返回
 * clearedCount:0），把压缩让给 fullCompact（它替换头部并重建同构前缀，不额外击穿热缓存）。
 * 不传 cacheGate 时无条件改写——用于溢出保命场景（此时腾空间优先于保缓存）。
 */
export function microCompact(
  messages: StoredMessage[],
  keepRecent = 6,
  cacheGate?: MicroCompactCacheGate,
): MicroCompactResult {
  // 缓存仍热：跳过原地改写，避免击穿热前缀（交给 fullCompact 重建）
  if (cacheGate !== undefined) {
    const now = cacheGate.nowMs ?? Date.now();
    const coldMs = cacheGate.cacheColdMs ?? CACHE_COLD_MS;
    if (now - cacheGate.lastActivityMs < coldMs) {
      return { messages, clearedCount: 0 };
    }
  }
  const cutoff = Math.max(0, messages.length - keepRecent);
  let clearedCount = 0;
  const out = messages.map((sm, idx) => {
    if (idx >= cutoff) return sm;
    const msg = sm.message;
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return sm;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type === 'tool_result' && block.content !== CLEARED_PLACEHOLDER) {
        clearedCount++;
        changed = true;
        return { ...block, content: CLEARED_PLACEHOLDER };
      }
      return block;
    });
    return changed ? { ...sm, message: { ...msg, content } } : sm;
  });
  return { messages: out, clearedCount };
}

/** 是否为「工具结果回灌」消息（内层 user 角色且含 tool_result 块）。 */
function isToolResultMsg(m: StoredMessage): boolean {
  const msg = m.message;
  return msg.role === 'user' && Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result');
}

/**
 * 从期望 cutoff 往后挪到安全切点：保证 recent 段首条不是孤儿 tool_result。
 * 若 recent 首条是 tool_result 消息，它配对的 tool_use（assistant）会落进被摘要吞掉的 older 段，
 * 压缩后就成了孤儿 → Anthropic 协议下会 400。往后挪把这条 tool_result 一并归入 older，
 * 使 older 末尾保持「assistant(tool_use) + user(tool_result)」成对完整。
 */
function safeCutoff(messages: StoredMessage[], desired: number): number {
  let c = Math.max(0, Math.min(desired, messages.length));
  while (c < messages.length && isToolResultMsg(messages[c]!)) c++;
  return c;
}

/**
 * 全量压缩：把除最近 keepRecent 条外的较旧对话交给模型总结成一段 handoff 摘要，
 * 用摘要替换被压缩部分，保留最近消息。需要一次模型调用。
 * 切点经 safeCutoff 校正，绝不拆散 tool_use↔tool_result。
 * 若无可压缩内容、无安全切点或摘要失败，原样返回（返回同引用，供调用方判断未压缩）。
 * model 为压缩摘要专用模型覆盖（大小模型协同），省略时用 provider 构造模型（行为与之前一致）。
 */
export async function fullCompact(
  provider: ChatProvider,
  messages: StoredMessage[],
  keepRecent = 6,
  todos?: readonly { title: string; status: string }[],
  model?: string,
): Promise<StoredMessage[]> {
  const desired = messages.length - keepRecent;
  if (desired <= 1) return messages; // 太短，不值得压缩
  const cutoff = safeCutoff(messages, desired);
  // 没有安全切点，或安全切点会把最近消息压光 → 放弃（宁可不压，也不产生孤儿 tool_result）
  if (cutoff <= 1 || cutoff >= messages.length) return messages;
  const older = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  const summaryPrompt =
    '以下是一段较早的对话历史。请为接手的另一个 AI 助手写一段简洁的中文交接摘要，覆盖：' +
    '当前进度与关键决策、重要约束与用户偏好、尚未完成的工作（明确的下一步）、' +
    '以及需要的关键数据 / 文件路径 / 引用。只输出摘要正文：\n\n' +
    older.map((m) => `${m.message.role}: ${serializeContent(m.message.content)}`).join('\n');

  let summary = '';
  try {
    const stream = provider.stream({
      system: '你是一个对话摘要器，输出紧凑、信息完整的中文交接摘要。',
      tools: [],
      messages: [{ role: 'user', content: summaryPrompt }],
      model,
    });
    const final: Anthropic.Message = await stream.finalMessage();
    summary = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  } catch {
    return messages; // 摘要失败则不压缩，保证安全
  }
  if (summary.trim() === '') return messages;

  // TODO 本体存独立 store（不占 messages），压缩不丢；把当前清单拼进摘要尾部，让压缩后模型立刻看到进度
  const todoBlock = todos !== undefined ? renderTodoList(todos) : '';
  const finalSummary = todoBlock === '' ? summary : `${summary.trim()}\n\n${todoBlock}`;

  return [
    stored({ role: 'user', content: `[早期对话摘要]\n${finalSummary}` }, 'compaction_summary'),
    stored({ role: 'assistant', content: '已了解上述摘要，继续。' }, 'assistant'),
    ...recent,
  ];
}

/** 把 TODO 清单渲染成 markdown，供压缩摘要尾部拼接（TODO 本体存 store，压缩不丢）。 */
export function renderTodoList(todos: readonly { title: string; status: string }[], heading = '## TODO List'): string {
  if (todos.length === 0) return '';
  const lines = todos.map((t) => `- [${t.status}] ${t.title}`);
  return `${heading}\n${lines.join('\n')}`;
}

function serializeContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: Anthropic.ContentBlockParam) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[调用工具 ${b.name}]`;
      if (b.type === 'tool_result') return `[工具结果]`;
      if (b.type === 'image') return serializeImage(b);
      return `[${b.type}]`;
    })
    .join(' ');
}

/**
 * 图片降级成 marker 文本：至少保留"这里有张图"的定位信息，而非字面 `[image]`。
 * 落盘引用式存储（stepref）时带 hash 前 8 位，如 `[image image/png a1b2c3d4]`；内联小图无 hash 只标 mediaType。
 */
function serializeImage(b: Anthropic.ImageBlockParam): string {
  if (b.source.type !== 'base64') return `[image ${b.source.type}]`;
  const mediaType = b.source.media_type;
  const data = b.source.data;
  if (isStepref(data)) {
    const hash = data.slice(STEPREF_PREFIX.length, STEPREF_PREFIX.length + 8);
    return `[image ${mediaType} ${hash}]`;
  }
  return `[image ${mediaType}]`;
}
