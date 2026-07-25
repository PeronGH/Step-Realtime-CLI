import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * skill 懒加载（纯客户端方案）：
 * 扫描 `.step-code/skills/`、`.agents/skills/`、`~/.step-code/skills/`、plugin skill 目录，
 * 解析 SKILL.md（YAML frontmatter + 正文）。system prompt 只放「名称+描述+路径」清单，
 * 正文不进 system prompt——模型经 skill 工具激活后才把正文注入上下文。
 * config.toml 的 extra_skill_dirs 可在默认路径之上追加扫描目录（plugin 目录仍最后、优先级最高）。
 */

export interface SkillDefinition {
  name: string;
  description: string;
  /** 何时使用（可选，供模型判断）。 */
  whenToUse?: string;
  /** SKILL.md 正文（懒加载，激活时才注入）。 */
  content: string;
  /** skill 目录绝对路径（供 ${STEP_SKILL_DIR} 占位引用同目录资源）。 */
  dir: string;
  /** 来源标记。 */
  source: 'project' | 'user' | 'plugin';
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** 解析一份 SKILL.md（frontmatter + 正文）。非法返回 null。 */
export function parseSkillMd(content: string, dir: string, source: SkillDefinition['source']): SkillDefinition | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (m === null) return null;
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
  } catch {
    return null;
  }
  const name = typeof fm['name'] === 'string' && NAME_RE.test(fm['name']) ? fm['name'] : null;
  const description = typeof fm['description'] === 'string' ? fm['description'] : '';
  const body = (m[2] ?? '').trim();
  if (name === null || description === '' || body === '') return null;
  return {
    name,
    description,
    whenToUse: typeof fm['when_to_use'] === 'string' ? fm['when_to_use'] : undefined,
    content: body,
    dir,
    source,
  };
}

/** 从一个 skill 根目录发现 skill（每个含 SKILL.md 的子目录）。 */
function discoverInDir(root: string, source: SkillDefinition['source']): SkillDefinition[] {
  if (!existsSync(root)) return [];
  const out: SkillDefinition[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const skillMd = join(root, entry.name, 'SKILL.md');
    if (!existsSync(skillMd)) continue;
    try {
      const def = parseSkillMd(readFileSync(skillMd, 'utf8'), join(root, entry.name), source);
      if (def !== null) out.push(def);
    } catch {
      // 跳过损坏 skill
    }
  }
  return out;
}

export interface SkillRegistry {
  skills: Map<string, SkillDefinition>;
}

/** 解析配置里的路径条目：`~` 展开为 homedir，相对路径按 cwd 解析为绝对路径。 */
function resolveConfigPath(p: string, cwd: string): string {
  const home = homedir();
  const expanded =
    p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : p;
  return resolve(cwd, expanded);
}

/**
 * 构建 skill 注册表：项目级 < 用户级 < 追加目录 < plugin，同名后者覆盖。
 * extraDirs（config.toml extra_skill_dirs）追加在默认三路径之后扫描，
 * 个人追加目录可 shadow 同名项目/用户级 skill；plugin skills 始终最后、优先级最高。
 * @param cwd 工作目录（项目级 .step-code/skills 与 .agents/skills）
 * @param pluginSkillDirs plugin 提供的 skill 目录（绝对路径数组）
 * @param extraDirs 追加的 skill 目录（支持 `~` 与相对 cwd 的路径）
 */
export function buildSkillRegistry(
  cwd: string,
  pluginSkillDirs: string[] = [],
  extraDirs?: string[],
): SkillRegistry {
  const skills = new Map<string, SkillDefinition>();
  const addAll = (defs: SkillDefinition[]): void => {
    for (const d of defs) skills.set(d.name, d);
  };
  addAll(discoverInDir(join(cwd, '.step-code', 'skills'), 'project'));
  addAll(discoverInDir(join(cwd, '.agents', 'skills'), 'project'));
  addAll(discoverInDir(join(homedir(), '.step-code', 'skills'), 'user'));
  for (const p of extraDirs ?? []) {
    addAll(discoverInDir(resolveConfigPath(p, cwd), 'user'));
  }
  for (const dir of pluginSkillDirs) {
    addAll(discoverInDir(dir, 'plugin'));
  }
  return { skills };
}

/** skill 清单总量预算（字符）。8000 字符软上限，防技能膨胀撑爆 system prompt。 */
export const SKILL_LISTING_BUDGET = 8000;
/** 压缩模式下单条描述截断长度。 */
const COMPACT_DESC_MAX = 80;
/** 省略提示行预留的预算，避免尾注本身把清单顶出预算。 */
const OMIT_NOTE_RESERVE = 120;

const LISTING_HEADER =
  '\n\n# 可用技能（懒加载）\n以下技能按需激活：用 skill 工具传入名称加载完整指令后再使用。\n';

/** 渲染一条清单行。compact=true 时截断描述并省略 whenToUse。 */
function renderSkillLine(s: SkillDefinition, compact: boolean): string {
  const desc =
    compact && s.description.length > COMPACT_DESC_MAX ? `${s.description.slice(0, COMPACT_DESC_MAX)}…` : s.description;
  const when = !compact && s.whenToUse !== undefined && s.whenToUse !== '' ? ` | 何时用：${s.whenToUse}` : '';
  return `- ${s.name}：${desc}${when}（路径：${s.dir}）`;
}

/**
 * 生成给 system prompt 的 skill 清单（懒加载：只放名称+描述+路径，不含正文）。
 * 加总量预算（默认 SKILL_LISTING_BUDGET）：超预算先逐条压缩描述（截断 + 去 whenToUse），
 * 仍超则逐条累加直到预算，省略靠后条目并在末尾注明省略数。
 */
export function skillListing(registry: SkillRegistry, budget: number = SKILL_LISTING_BUDGET): string {
  if (registry.skills.size === 0) return '';
  const defs = [...registry.skills.values()];

  // 全量：预算内直接返回
  const fullBody = defs.map((s) => renderSkillLine(s, false)).join('\n');
  if (LISTING_HEADER.length + fullBody.length <= budget) return LISTING_HEADER + fullBody;

  // 逐条压缩描述后仍在预算内 → 返回压缩版
  const compactLines = defs.map((s) => renderSkillLine(s, true));
  const compactBody = compactLines.join('\n');
  if (LISTING_HEADER.length + compactBody.length <= budget) return LISTING_HEADER + compactBody;

  // 仍超预算：逐条累加至预算（预留省略尾注空间），省略靠后条目
  const kept: string[] = [];
  let used = LISTING_HEADER.length;
  let omitted = 0;
  for (let i = 0; i < compactLines.length; i++) {
    const lineLen = compactLines[i]!.length + 1; // +1 为换行
    if (used + lineLen > budget - OMIT_NOTE_RESERVE) {
      omitted = compactLines.length - i;
      break;
    }
    kept.push(compactLines[i]!);
    used += lineLen;
  }
  let out = LISTING_HEADER + kept.join('\n');
  if (omitted > 0) {
    out += `\n（另有 ${omitted} 个技能因篇幅省略，可用 /skill <名称> 或直接说明需求后激活）`;
  }
  return out;
}

/** XML 转义：防用户 args 破坏 <step-skill-loaded> 包裹结构或注入伪标签。 */
export function escapeSkillXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 占位符展开：把 skill 正文里的占位符替换为实际值。
 * - `$ARGUMENTS`：整个 args 串（已 XML 转义）
 * - `$0`..`$9`：args 按空白分词后的第 n 个（越界为空串，已 XML 转义）
 * - `${STEP_SKILL_DIR}`：该 skill 目录绝对路径（非用户输入，不转义）
 * 用户输入的 args 先做 XML 转义再插入，防注入破坏包裹结构。均用函数式替换，避免 `$` 特殊序列。
 */
export function expandSkillContent(def: SkillDefinition, args: string): string {
  const escaped = escapeSkillXml(args);
  const tokens = escaped.split(/\s+/).filter((tok) => tok !== '');
  let body = def.content;
  body = body.replace(/\$\{STEP_SKILL_DIR\}/g, () => def.dir);
  body = body.replace(/\$ARGUMENTS/g, () => escaped);
  body = body.replace(/\$([0-9])/g, (_m, d: string) => tokens[Number(d)] ?? '');
  return body;
}

/**
 * 渲染一次 skill 激活的注入文本（header + 展开正文 + footer）。
 * 供 skill 工具与 /skill 命令共用，保证两条激活路径注入格式一致。
 */
export function renderSkillActivation(def: SkillDefinition, args: string): string {
  const header = `<step-skill-loaded name="${def.name}" source="${def.source}">\n`;
  return `${header}${expandSkillContent(def, args)}\n</step-skill-loaded>\n\n以上为技能「${def.name}」的完整指令，请遵循执行。`;
}
