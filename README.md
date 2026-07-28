# Step Code

[![CI](https://github.com/li-xiu-qi/Step-Realtime-CLI/actions/workflows/test.yml/badge.svg?branch=step-code-explore)](https://github.com/li-xiu-qi/Step-Realtime-CLI/actions/workflows/test.yml)

终端里的编码 agent CLI，由阶跃星辰 **Step 系列模型**驱动，UI 层用 **Ink**。

> 本仓库是 [stepfun-ai/Step-Realtime-CLI](https://github.com/stepfun-ai/Step-Realtime-CLI) 的 `step-code-explore` 探索分支。

核心是一个 agent 主循环：模型通过工具直接读写真实文件、执行真实命令，结果回灌给模型继续推进，直到任务完成。在此之上提供计划模式、技能懒加载、自主目标等交互能力。

## 特性

- 交互式 Ink 终端界面 + 单条指令的非交互模式（`-p`）
- **多协议模型接入**：provider 层支持三种协议——`anthropic`（Anthropic Messages，适合 coding）、`openai`（OpenAI Chat Completions，适合 coding）、`openai_responses`（OpenAI Responses，纯对话、不支持工具调用）；阶跃 Step 系列（如 step-3.7-flash）三协议均可接入，默认走 stepfun 预设（anthropic 协议、流式输出、注入 prompt cache）
- **多渠道模型体系**：config.toml 用 `[providers.<id>]` 声明渠道（`type` 选协议 + `base_url` + `api_key`）、`[models.<别名>]` 登记模型别名（挂渠道、带显示名/能力/上下文窗口）；`/model` 无参打开交互式选择器（模糊过滤、渠道列、当前项标记、切换有历史时提示 cache 失效），`/model <别名>` 直切，`--model 别名` 启动指定
- **thinking 推理过程**：Step 恒思考模型的思考过程在 TUI 无条件呈现——流式期暗色滚动预览、完成后暗色斜体折叠块；`[thinking]` 段可配是否发送思考请求字段及 budget，`/think` 会话级选择思考深度档位（`[thinking.levels]` 档位表可配），状态栏显示当前档位；`-p` 模式思考不进 stdout
- **计划模式（Plan Mode）**：`/plan` 进入后权限层硬拦所有写/执行工具，只放行只读调查与 `exit_plan_mode`；模型先调查、产出计划，经用户确认后才落地执行。它是独立维度，叠加在权限模式之上
- **权限系统**：manual / auto / yolo 三档梯度——manual 写与执行都要确认，auto 写放行、`bash` 仍需确认，yolo 全放行；本会话批准过的工具可记住
- **子 agent**：`spawn_agent` 派生子 agent（内置 `general` 全能 / `explore` 只读，支持 `.step-code/agents/*.md` 自定义）；全新上下文、角色化工具白名单、摘要回灌，可后台异步、可并行多个只读 explore
- **并行工具执行**：一轮多个工具调用按资源冲突（无副作用 / 读 / 写 / 独占）自动并行或串行，结果按序回灌；子 agent 并行受 `max_concurrent` 并发上限约束
- **工作流编排**：`workflow` 声明式编排多个子 agent（`agent` / `parallel` / `fanout` / `synthesize`），中间结果不占主上下文，只回最终报告
- **自主目标（Goal）**：`create_goal` / `update_goal` / `set_goal_budget` / `get_goal` + `/goal`，设定目标后每轮自动续跑直至达成或阻塞，支持轮次 + token 双预算，状态随会话持久化（resume 时 active 降级 paused）
- **任务清单与后台任务**：`todo_list` 维护 TODO；`bash` 可 `run_in_background`，配 `task_list` / `task_output` / `task_stop` 管理后台任务；终态通知在回合边界及时注入、精简为一行 + 指引自取输出
- **定时/循环任务（Cron）**：`cron_create` / `cron_list` / `cron_delete` + `/loop`，到点把 prompt 注入会话执行，支持一次性与周期；按工作目录持久化，重启/恢复不丢、离线漏跑合并补投
- **技能系统（Skill）**：纯客户端懒加载，system prompt 只列「名称+描述」清单（8000 字符预算防膨胀），经 `skill` 工具或 `/skill` 激活才注入正文；扫描项目级 `.step-code/skills`、`.agents/skills`、用户级 `~/.step-code/skills` 与 plugin 提供的 skill
- **插件（Plugin）**：`~/.step-code/plugins/` 下带 `.step-code-plugin/plugin.json` 的声明式资源包，可提供 skills + mcpServers + hooks + 斜杠命令（后两类带命名空间/前缀隔离）；`/plugin install / list / enable / disable / remove / info` 管理
- **用户可配置 hooks**：config.toml `[[hooks]]` 在生命周期事件（PreToolUse / PostToolUse / UserPromptSubmit / Stop / SessionStart）执行 shell 命令，可观察、可阻断（exit 2 阻断、其余 fail-open）
- **MCP**：连接外部 MCP server（stdio transport），配置 `~/.step-code/mcp.json`；MCP 工具经 `tool_search` 懒加载后按需注册，`/mcp` 查看连接状态
- **内置联网搜索**：`web_search`（网页）+ `web_image_search`（文搜图）接阶跃官方搜索，走 Step Plan 通道消耗 Credit
- **基础工具**：`read_file` / `write_file` / `edit_file` / `list_dir` / `glob` / `grep` / `bash`，入参用 zod 校验并自动生成 Anthropic tool schema；结果强制配对回灌，工具报错模型可自纠
- **可中断**：交互中按 Esc 中止当前生成，保留会话历史
- **折叠/展开工具输出**：工具结果默认折叠为摘要，Ctrl+O 全局展开/折叠完整输出
- **输入框编辑**：自研单行输入组件，支持 Home/End、Ctrl+A/E、Ctrl+←/→ 与 Alt+B/F 词移动、Ctrl+W/U/K 删除键集
- **图片粘贴**：Alt+V 从剪贴板粘贴图片随消息发送（走模型的 base64 图片理解；剪贴板读取目前 Windows 支持）
- **可重试**：对网络 / 5xx / 限流 / 空流·空响应错误指数退避重试（未输出内容才重试），优先采用响应的 `Retry-After` 头；并行子 agent 遇 429 阶梯重排队
- **会话持久化**：自动保存，`--continue` 续接、`--session` / `--resume` 指定、`/fork` 分叉、`/reflect` 沉淀方法论；`/resume` 无参（或 `step -r`）打开交互式会话选择器（↑↓ 分页浏览、打字搜索、Enter 恢复、Delete/Ctrl+D 删除带二次确认），恢复时把历史对话重新渲染到终端（长会话按最近若干轮重放，恢复提示给出「轮次 · 条消息」双口径）；权限模式与模型随会话持久化，恢复会话时读回
- **上下文压缩**：接近上限时自动微压缩旧工具结果，`/compact` 触发全量摘要
- **国际化**：`/lang` 在中英文界面间切换（写回 config.toml 持久化；也可直接配置 `language = "en"`）
- 跨平台：文件操作走 Node 原生 API，`bash` 工具在 Windows 下优先 Git Bash，无则回退 WSL/busybox/PowerShell
- 单元测试用 vitest（`pnpm test`），CI 在 Ubuntu / Windows / macOS 三平台跑 typecheck + build + test

## 文档

完整使用指南在 [`docs/`](./docs/)：

- [快速开始](./docs/quickstart.md) — 安装、配 key、第一次对话
- [安装](./docs/installation.md) — 环境要求、源码构建、全局命令、升级卸载
- [配置参考](./docs/configuration.md) — API key、config.toml 全字段、多协议渠道、mcp.json
- [交互使用](./docs/interactive.md) — TUI 界面、斜杠命令、快捷键、权限三档、计划模式
- [子 agent 与自动化](./docs/agents.md) — spawn_agent、workflow、goal、cron、后台任务
- [会话管理](./docs/sessions.md) — 持久化、续接与恢复、分叉、压缩、回顾、非交互输出
- [技能、插件与 MCP](./docs/skills-and-mcp.md) — SKILL.md 格式、加载层级、plugin、MCP
- [hooks 机制](./docs/hooks.md) — 生命周期事件点执行 shell 命令
- [AGENTS.md 机制](./docs/agents-md.md) — 项目规范怎么加载、覆盖、自定义来源

## 快速上手

需要 Node.js >= 22 和 pnpm。

```bash
pnpm install && pnpm build && pnpm link --global
export STEP_CODE_API_KEY=<your-key>
step
```

安装细节、全部配置项、命令行参数与斜杠命令见 [`docs/`](./docs/)。

## 目录结构

```
src/
├── main.tsx              # CLI 入口：commander 参数/子命令，交互 render(<App/>) + -p 非交互
├── i18n.ts               # 中英文案表
├── config/config.ts      # 读 env / .env / ~/.step-code/config.toml
├── provider/
│   ├── stepfun.ts            # stepfun provider（流式 messages.stream）
│   ├── anthropicMessages.ts  # anthropic 协议 provider
│   ├── openaiChat.ts         # openai 协议 provider（/v1/chat/completions，翻译成 Anthropic 事件流）
│   ├── openaiResponses.ts    # openai_responses 协议 provider（/v1/responses，纯对话）
│   ├── openaiCommon.ts       # OpenAI 两协议共用：请求/响应与 Anthropic 形状互译
│   ├── factory.ts / types.ts # provider 按协议分发装配与抽象
│   ├── prepare.ts            # cache_control 注入 + 合并 tool_result-only 消息
│   └── retry.ts              # 指数退避重试 + isRetryableError
├── agent/
│   ├── loop.ts / runTurn.ts  # 多回合编排 + 单回合核心（流式 → tool_use → 授权执行 → 回灌）
│   ├── toolScheduler.ts      # 并行工具调度：资源冲突判定 + 乱序执行 + 按序回收
│   ├── hooks.ts / events.ts / message.ts / wire.ts
│   ├── hooks/engine.ts       # 用户可配置 hooks 引擎（PreToolUse 等 5 事件）
│   ├── systemPrompt.ts       # 系统提示词
│   ├── agentsMd.ts           # AGENTS.md 加载
│   ├── reflect.ts            # /reflect 方法论回顾
│   ├── toolSearch.ts         # 外部工具（MCP）懒加载检索
│   ├── workflow.ts           # 工作流编排
│   ├── permission/mode.ts    # 权限判定 manual/auto/yolo + plan 模式硬拦守卫
│   ├── subagent/             # 子 agent：types / registry(内置+md) / runner(嵌套)
│   ├── goal/mode.ts          # 自主目标模式（轮次 + token 双预算、随会话持久化）
│   ├── cron/                 # 定时/循环任务：cronexpr + scheduler + store(按 cwd 持久化)
│   ├── background/           # 后台任务：manager + notify
│   └── compaction/compact.ts # token 估算 + 微压缩 + 全量摘要压缩
├── session/store.ts      # 会话持久化：JSON 快照，按 workdir 分桶（+ fork/resume/debug）
├── skill/registry.ts     # 技能懒加载：扫描 + frontmatter 解析 + 激活注入
├── plugin/
│   ├── manager.ts            # 插件发现与能力合流（skills + mcpServers + hooks + commands）
│   └── manage.ts             # 插件安装/启停管理（install/list/enable/disable/remove）
├── mcp/                  # MCP：manager（stdio 连接/发现/调用）+ status
├── tools/                # 各工具（zod schema + execute）+ index.ts 注册表
│                         #   read_file/write_file/edit_file/list_dir/glob/grep/bash
│                         #   spawn_agent/workflow/task_*/todo_list/*_goal/exit_plan_mode/ask_user
│                         #   skill/tool_search/cron_*/web_search/web_image_search
├── tui/                  # Ink 组件：App / StatusBar / MessageList / ToolCall /
│                         #   ApprovalPrompt / QuestionPrompt / GoalPanel / TodoPanel /
│                         #   CronCard / WorkflowPanel / SessionPicker / ModelPicker /
│                         #   LiveViewport(动态区视口化) / commands.ts / pluginCommand.ts /
│                         #   promptEdit.ts(输入框编辑纯函数) / PromptInput.tsx
└── utils/                # logger / redact
tests/                    # vitest 单元 + 集成测试
```

## 致谢

Step Code 在设计阶段参考了 **OpenAI Codex CLI**、**Claude Code**、**OpenCode** 等优秀项目的架构思路与交互设计（计划模式、技能懒加载、自主目标等尤其受 Codex 与 Claude Code 启发）。本项目源码自行编写，与上述项目无隶属、赞助或背书关系；相关开源许可证收录于 [`licenses/`](./licenses/) 目录，详见 [`licenses/NOTICE.md`](./licenses/NOTICE.md)。

## 开发约定

见 [`AGENTS.md`](./AGENTS.md)，其中包含模型接入铁律与协作规范。

## 状态

已具备：工具循环、三档权限系统、**计划模式**、可中断、重试（含 `Retry-After` 优先）、prompt cache、会话持久化（续接 / 分叉 / 回顾 / 恢复重放历史）、上下文压缩、斜杠命令、stream-json 输出、内置联网搜索（网页 + 文搜图）、图片粘贴输入（Alt+V）、thinking 推理过程呈现、子 agent 与工作流编排、并行工具执行、自主目标（Goal，轮次 + token 双预算、随会话持久化）、后台任务与定时任务（Cron，按 cwd 持久化）、技能系统（Skill）、插件（skills + mcpServers + hooks + 命令）、用户可配置 hooks、MCP（stdio）、多渠道模型体系与交互式模型选择器、多协议接入（anthropic / openai / openai_responses）、国际化（中/英）。

CI 在 Ubuntu / Windows / macOS 三平台运行 typecheck + build + test。

## 许可证

MIT，详见 [`LICENSE`](./LICENSE)。第三方致谢与许可证见 [`licenses/`](./licenses/)。
