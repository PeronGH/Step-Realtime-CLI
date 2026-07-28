import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { StoredMessage } from '../agent/message.js';
import type { GoalState } from '../agent/goal/mode.js';
import type { PermissionMode } from '../agent/permission/mode.js';
import { AttachmentStore, isStepref } from './attachments.js';

export interface SessionMeta {
  id: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数，便于列表展示。 */
  messageCount: number;
  /** 会话标题（从首条 user 消息派生），供选择器/列表辨认，旧快照可能缺失。 */
  title?: string;
  /** 首条 user 消息预览（截 200 字符），供选择器搜索匹配，旧快照可能缺失。 */
  preview?: string;
  /** 谱系：本会话由哪个会话 fork 而来（单层 parent）。 */
  forkedFrom?: string;
}

export interface SessionData extends SessionMeta {
  messages: StoredMessage[];
  /** TODO 任务清单（独立存储，不占对话历史）。 */
  todos?: { title: string; status: 'pending' | 'in_progress' | 'done' }[];
  /** goal 状态快照（随会话持久化；恢复时 active 降级 paused，fork 不继承）。 */
  goal?: GoalState;
  /** 权限模式快照（会话级，随会话持久化；恢复时读回，旧快照缺失回退启动默认）。 */
  mode?: PermissionMode;
}

/** 把工作目录映射为稳定、文件系统安全的短键（避免超长路径与非法字符）。 */
export function workdirKey(cwd: string): string {
  const norm = cwd.replace(/\\/g, '/').toLowerCase();
  return createHash('sha1').update(norm).digest('hex').slice(0, 16);
}

/** 标题最大字符数，超出截断加省略号。 */
const TITLE_MAX = 50;
/** 预览最大字符数（供搜索匹配，比标题长以覆盖首条消息更多内容）。 */
const PREVIEW_MAX = 200;

/**
 * 抽取首条 user 消息的纯文本（string 直接用；数组拼接所有 text 块），折叠空白/换行为单空格并 trim。
 * 无 user 消息或纯空返回 undefined。deriveTitle / derivePreview 共用。
 *
 * 也接受 `user_verbatim`（压缩保真下来的用户原话）：长会话被压缩后，最早的真人输入已不在
 * 历史里，此时保真下来的第一条恰好就是它——正是最好的标题来源。若只认 `user`，
 * 压缩过的会话标题会退化成 undefined 或取到很晚的一条消息。
 */
function firstUserText(messages: StoredMessage[]): string | undefined {
  const first = messages.find((m) => m.origin === 'user' || m.origin === 'user_verbatim');
  if (first === undefined) return undefined;
  const content = first.message.content;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === 'text') parts.push(block.text);
    }
    text = parts.join(' ');
  }
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? undefined : collapsed;
}

/** 从首条 user 消息派生会话标题，截断到 TITLE_MAX。无内容返回 undefined。 */
export function deriveTitle(messages: StoredMessage[]): string | undefined {
  const t = firstUserText(messages);
  if (t === undefined) return undefined;
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

/** 从首条 user 消息派生搜索预览，截断到 PREVIEW_MAX。无内容返回 undefined。 */
export function derivePreview(messages: StoredMessage[]): string | undefined {
  const t = firstUserText(messages);
  if (t === undefined) return undefined;
  return t.length > PREVIEW_MAX ? `${t.slice(0, PREVIEW_MAX)}…` : t;
}

/**
 * 会话持久化：每个会话一份 JSON 快照，按工作目录分桶存放。
 * 布局：<baseDir>/<workdirKey>/<sessionId>.json
 * 每回合结束后 save 一次；--continue 载入该工作目录下最新会话。
 */
export class SessionStore {
  private readonly baseDir: string;
  /** 引用式附件存储（与本 store 共享 baseDir）：落盘前把图片 base64 卸载成内容寻址文件。 */
  readonly attachments: AttachmentStore;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.step-code', 'sessions');
    this.attachments = new AttachmentStore(this.baseDir);
  }

  private dirFor(cwd: string): string {
    return join(this.baseDir, workdirKey(cwd));
  }

  /** cron 任务持久化目录：<baseDir>/cron/<workdirKey>（按 cwd 分桶，不属于任何单个会话）。 */
  cronDirFor(cwd: string): string {
    return join(this.baseDir, 'cron', workdirKey(cwd));
  }

  private fileFor(cwd: string, id: string): string {
    return join(this.dirFor(cwd), `${id}.json`);
  }

  /** 全量历史日志（append-only JSONL）路径：与 JSON 快照并列。 */
  private fullFileFor(cwd: string, id: string): string {
    return join(this.dirFor(cwd), `${id}.full.jsonl`);
  }

  /**
   * 调试导出用：返回某会话的落盘文件路径（会话桶目录 + JSON 快照 + 全量历史 JSONL）。
   * 复用内部路径规则，供 debugBundle 收集，避免在外部重算 workdirKey。
   */
  sessionPaths(cwd: string, id: string): { dir: string; json: string; full: string } {
    return {
      dir: this.dirFor(cwd),
      json: this.fileFor(cwd, id),
      full: this.fullFileFor(cwd, id),
    };
  }

  /** 新建一个空会话（尚未落盘）。 */
  create(cwd: string, model: string, mode?: PermissionMode): SessionData {
    const now = new Date().toISOString();
    return {
      id: randomId(),
      cwd,
      model,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      mode,
    };
  }

  /**
   * 落盘前投影：返回一条 StoredMessage 的浅拷贝，其中每个 base64 图片块的 `source.data`
   * 换成 `stepref:<sha256>`（同步把字节 offload 到 attachments/）。小图（<阈值）与已是 stepref 的原样保留。
   * 只作用于写盘副本，绝不改动入参——内存里的 history.current 保持原始 base64。无图消息原样返回同引用。
   */
  private offloadForStorage(cwd: string, m: StoredMessage): StoredMessage {
    const content = m.message.content;
    if (typeof content === 'string') return m;
    let changed = false;
    const nextContent = content.map((block) => {
      if (block.type !== 'image' || block.source.type !== 'base64') return block;
      const data = block.source.data;
      if (isStepref(data)) return block;
      const ref = this.attachments.offload(cwd, data, block.source.media_type);
      if (ref === data) return block;
      changed = true;
      return { ...block, source: { ...block.source, data: ref } };
    });
    if (!changed) return m;
    return { ...m, message: { ...m.message, content: nextContent } };
  }

  /** 保存会话快照（覆盖写）。会更新 updatedAt 与 messageCount，并在缺 title 时派生。 */
  save(session: SessionData): void {
    const dir = this.dirFor(session.cwd);
    mkdirSync(dir, { recursive: true });
    session.updatedAt = new Date().toISOString();
    session.messageCount = session.messages.length;
    if (session.title === undefined || session.title === '') {
      const derived = deriveTitle(session.messages);
      if (derived !== undefined) session.title = derived;
    }
    if (session.preview === undefined || session.preview === '') {
      const preview = derivePreview(session.messages);
      if (preview !== undefined) session.preview = preview;
    }
    // 落盘前把图片 base64 卸载成 stepref 指针（作用于副本，不污染内存 session.messages）
    const toWrite: SessionData = {
      ...session,
      messages: session.messages.map((m) => this.offloadForStorage(session.cwd, m)),
    };
    writeFileSync(this.fileFor(session.cwd, session.id), JSON.stringify(toWrite, null, 2), 'utf8');
  }

  /** 按 id 载入。找不到返回 null。 */
  load(cwd: string, id: string): SessionData | null {
    const file = this.fileFor(cwd, id);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SessionData;
    } catch {
      return null;
    }
  }

  /**
   * 向全量历史日志（append-only JSONL）追加消息，按 `id` 去重、只追加、永不重写。
   * 压缩链路（loop.replaceMessages / /compact）只动 history.current 与 JSON 快照，
   * 绝不触碰这份 JSONL——它是 /reflect 能遍历完整历史的唯一保证。
   * 内部先读回已写过的 id 做去重，故重复调用幂等；返回本次实际追加的条数。
   */
  appendFull(cwd: string, id: string, messages: readonly StoredMessage[]): number {
    if (messages.length === 0) return 0;
    const seen = new Set(this.loadFull(cwd, id).map((m) => m.id));
    const fresh: StoredMessage[] = [];
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      seen.add(m.id); // 同批次内也去重
      fresh.push(m);
    }
    if (fresh.length === 0) return 0;
    const dir = this.dirFor(cwd);
    mkdirSync(dir, { recursive: true });
    // 落盘前把图片 base64 卸载成 stepref 指针（作用于副本，不污染入参/内存 history）
    const payload = fresh.map((m) => JSON.stringify(this.offloadForStorage(cwd, m))).join('\n') + '\n';
    appendFileSync(this.fullFileFor(cwd, id), payload, 'utf8');
    return fresh.length;
  }

  /** 读回全量历史日志的所有条目（按写入顺序）。文件不存在或损坏行跳过，均返回已解析部分。 */
  loadFull(cwd: string, id: string): StoredMessage[] {
    const file = this.fullFileFor(cwd, id);
    if (!existsSync(file)) return [];
    const out: StoredMessage[] = [];
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return out;
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as StoredMessage);
      } catch {
        // 跳过损坏行，尽量返回可用部分
      }
    }
    return out;
  }

  /** 列出该工作目录下的会话元信息，按 updatedAt 倒序。 */
  list(cwd: string): SessionMeta[] {
    const dir = this.dirFor(cwd);
    if (!existsSync(dir)) return [];
    const metas: SessionMeta[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionData;
        metas.push({
          id: data.id,
          cwd: data.cwd,
          model: data.model,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          messageCount: data.messageCount ?? data.messages?.length ?? 0,
          // 有 title 用 title；旧快照无 title 时现场从 messages 派生兜底
          title: data.title ?? deriveTitle(data.messages ?? []),
          // preview 供选择器搜索；旧快照无 preview 时现场派生兜底
          preview: data.preview ?? derivePreview(data.messages ?? []),
        });
      } catch {
        // 跳过损坏文件
      }
    }
    metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return metas;
  }

  /** 该工作目录下最近更新的会话，供 --continue 使用。 */
  latest(cwd: string): SessionData | null {
    const metas = this.list(cwd);
    const newest = metas[0];
    return newest === undefined ? null : this.load(cwd, newest.id);
  }

  /** 删除指定会话的快照文件。存在并删成功返回 true，否则 false。 */
  delete(cwd: string, id: string): boolean {
    const file = this.fileFor(cwd, id);
    try {
      if (!existsSync(file)) return false;
      unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}

function randomId(): string {
  // 时间前缀 + 随机，便于人读且不冲突
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 6);
  return `${ts}-${rand}`;
}
