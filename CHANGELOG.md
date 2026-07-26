# Changelog

本项目的所有重要变更记录于此。格式沿用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 0.1.0 尚未正式发布，首个版本的完整能力见 [README](./README.md) 与 [docs/](./docs/)。

### Added

- **`edit_file` 结果 diff 预览**：编辑成功后工具卡片直接展示带行号的改动预览——绿色 `+` 新增行、红色 `-` 删除行，保留少量上下文，分散改动之间以「… N unchanged lines …」省略，超过 40 行折叠为「… N more changes hidden（Ctrl+O 展开）」。diff 用 LCS 逐行比对生成，非 TTY / 管道场景不带 ANSI。
- **图片输入改为输入框内联占位符**：Alt+V 粘贴图片后在输入框插入可见占位符 `[image #1 (宽×高)]`，可像普通文字一样用光标编辑、删除（删占位符即移除该图），提交时扫描文本把仍存在的占位符展开为图片、发给模型。剪贴板读取同时取图片宽高。替代原先「存数组 + 空输入退格删最后一张」的不可见交互。
- **`/think` 思考深度选择**：`[thinking.levels]` 配置档位表（档位名→budget，缺省 low/medium/high = 1024/4096/32000）与 `default_level` 默认档；`/think` 无参打开选择器、`/think <档位>` 直切、`/think off` 本会话停发 thinking 字段；状态栏显示当前档位；会话有历史时切换提示 prompt cache 失效。仅 anthropic 协议且已启用 thinking 字段的渠道可用，切换为会话级（持久化用 `default_level`）。
- **会话恢复重放历史内容**（`step -r` / `/resume`）：恢复会话时不再只显示一行「已恢复 N 条消息」，而是把历史对话（用户输入、助手回复、思考块、工具调用与结果）重新渲染到终端，与实时对话逐像素一致。工具调用按 `tool_use_id` 配对回填结果与状态；`injection` 类内部注入消息不展示；图片块以 `[图片]` 占位。
- **轮次（turn）口径**：新增按「真人输入」切分的轮次概念（`src/agent/turns.ts` 的 `countTurns` / `sliceRecentTurns`），与底层消息条数解耦。恢复提示改为双口径「N 轮 · M 条消息」。历史重放按最近 `REPLAY_TURN_LIMIT`（默认 15）轮截断，超出的在顶部提示「更早的 X 轮已折叠」，避免长会话一次性刷屏。
- **skill 热加载（`/skill reload`）**：会话中新增/修改/删除 SKILL.md 无需重启——每个回合边界自动比对扫描指纹（各 SKILL.md 的路径+mtime），有变更即全量重建注册表并提示新增/移除/变更清单；`/skill reload` 可随时手动强制重扫。重建后下一回合的 system prompt、skill 工具与子 agent 立即使用新清单。
- **同名 skill 冲突提示**：多个来源出现同名 skill 时（如用户级与项目级、`.agents/skills/` 与 `.step-code/skills/`），启动时与重载后明确告知冲突清单——哪个来源被采用、覆盖了谁（按优先级 plugin > 追加目录 > 项目 `.step-code/skills/` > 项目 `.agents/skills/` > 用户级）。
- **`disabled_skills` 配置**：config.toml 按名排除 skill，合并完成后统一过滤，任何来源（含插件）的同名 skill 都不加载；用于屏蔽共享/团队目录（如团队仓库提交的 `.agents/skills/`）里不归你管的个别 skill。

### Changed

- **skill 加载优先级修正**（行为变更）：同名覆盖顺序由「项目 < 用户」改为「用户级 < 项目 `.agents/skills/` < 项目 `.step-code/skills/` < `extra_skill_dirs` < 插件」——项目级现在覆盖用户级，原生目录覆盖兼容目录，符合就近覆盖的通行约定。

### Fixed

- **正文流完后「已隐藏 N 行」挂到整轮结束才释放**：定稿判定从「最后一条 assistant 一律留动态区」修正为「仅末尾 assistant 留动态区」——text 事件只往末尾 assistant 追加，其后一旦出现任何条目（工具、提示、思考定稿），旧条目物理上不可能再增长，即时定稿进历史。长正文流完进入工具执行期后，全文立即落入 scrollback，不再被窗口化压整轮。
- **`web_search` / `web_image_search` 的 HTTP 451 误报为 key/额度问题**：搜索接口错误按状态码分流并透传服务端 message——451（平台内容安全审核拦截）明确提示调整检索词、与 key/额度无关；401/403 指向 key 配置、429 指向限流/额度、5xx 提示稍后重试。之前所有非 2xx 统一报「请检查 API key 与额度」且丢弃响应体。
- **`edit_file` 在 CRLF 文件上报「未找到 old_string」**：模型生成的 `old_string` 通常是 LF 换行，而 Windows 文件多为 CRLF，逐字符精确匹配会因 `\r` 失配。现在先按原样精确匹配，失败时归一化换行符（三方统一为 LF）重试匹配，写回时按文件原有换行风格恢复——CRLF 文件保持 CRLF、纯 LF 文件保持 LF，且不产生 `\r\r\n` 双重换行。唯一性检查同步在归一化后的文本上计算。
- **空流/空响应导致回合直接失败（`stream ended without producing a Message...`）**：服务端在产出任何内容前结束响应（网关/服务端瞬时故障）时，现在自动按指数退避重试，沿用「未输出内容才重试」的安全守卫；判定设在消费端，Anthropic 与 OpenAI 双协议通道同构覆盖。重试仍失败时给出明确的中文提示与处理建议，不再原样显示 SDK 英文报错。
- **工具执行期间滚动终端历史被瞬间拽回**：动态帧高度预算补完——新增 `liveBudget` 预算层保证动态帧总高恒 ≤ 终端行数 − 1；斜杠菜单与长输入折行精确计入预算；各面板长行截断；可选面板超限时按优先级降级；`LiveViewport` 测量时序竞态修复。新增 `STEP_DEBUG_RENDER=1` 渲染诊断日志（`%TEMP%/step-code-render-debug.log`）。
- **流式期间 TUI 整进程闪退（Maximum update depth exceeded）**：`LiveViewport` 在 commit 阶段的测量 dispatch 与流式 token 更新可形成自持级联，触顶 React 嵌套更新上限。新增同拍级联保险：连续同步测量 dispatch 超限即退到下一拍更新，级联被打断，正常路径行为不变。
- **API 错误信息不可读（如 `⚠ {"type":"error"}`）**：HTTP 错误包装层把可读摘要归一化到错误对象顶层 `message`（SDK 会忽略传入的 message 参数），展示层新增统一摘要：剥状态码前缀、提取服务端 type/message，输出 `HTTP 400 · invalid_request_error: <服务端消息>` 格式。
- **工具输出展开态被冻结进历史**：定稿条目恒以折叠态进入终端历史，Ctrl+O 展开仅为生成期间的临时视图，历史始终保持紧凑。
- **ask-user 提问 / 审批弹层出现时向上滚动被拽回顶部**：弹层的行数估算把每条逻辑行当 1 行，长题干、长选项描述、长命令预览在终端内折行后实际行数被低估，动态帧超高触发终端全清。改为按终端列宽逐行精确计算折行（宽字符按 2 列），多题时取最高一题。计划确认框、模型选择器、思考深度选择器的行数估算同轮一并校准。

### Docs

- **会话恢复行为写入使用文档**：`docs/sessions.md` 新增「恢复时重放历史内容」小节（历史重新渲染、轮次/条消息双口径、最近 N 轮重放与折叠），`docs/interactive.md` 会话流章节与 `README.md` 会话持久化条目同步补充。
- **对外文档撰写规范**：`CONTRIBUTING.md` 新增「对外文档撰写规范」——面向用户的文档描述功能只讲自身价值，不做横向对标或来源归因；致谢集中在 README 致谢段与 `licenses/`；源码注释与设计稿不受此约束。
- **edit diff 预览设计稿**：`docs/design/edit-diff-preview.md` 记录编辑结果内联 diff 预览的问题背景、技术路线取舍与验收标准（设计阶段，尚未实现）。
