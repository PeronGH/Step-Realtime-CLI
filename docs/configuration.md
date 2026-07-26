# 配置参考

本页是配置项的完整参考。按字段查阅；按场景的用法见各主题页。

## API key

三种方式，优先级：环境变量 > 项目根 `.env` > `~/.step-code/config.toml`。

```bash
# 环境变量（STEP_CODE_API_KEY 首选，STEPFUN_API_KEY 为向后兼容别名）
export STEP_CODE_API_KEY=<your-key>

# 可选覆盖
export STEP_CODE_BASE_URL=https://api.stepfun.com
export STEP_CODE_MODEL=step-3.7-flash
export STEP_CODE_PROVIDER=stepfun    # 预设：stepfun / anthropic / openai / openai_responses
```

```toml
# ~/.step-code/config.toml
api_key = "<your-key>"
model = "step-3.7-flash"
base_url = "https://api.stepfun.com"
provider = "stepfun"                 # 默认 stepfun（anthropic 协议）
```

命令行参数 `--provider` / `--model` 优先级最高。

## config.toml 全字段

文件位置：`~/.step-code/config.toml`。

### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | string | 服务商预设：`stepfun`（默认，anthropic 协议）/ `anthropic` / `openai` / `openai_responses`。预设决定协议与默认端点，见下方[协议与 provider](#协议与-provider) |
| `api_key` | string | API key |
| `base_url` | string | API 地址；**是否带 `/v1` 取决于协议**——anthropic 不带（SDK 自拼 `/v1/messages`），openai / openai_responses 要带（拼 `/chat/completions`、`/responses`），见下方[协议与 provider](#协议与-provider) |
| `model` | string | 模型名，缺省用 provider 预设；可填 `[models]` 里的别名（启动时展开）；可用环境变量或命令行 `--model` 覆盖 |
| `max_context_size` | int | 上下文上限 token 数，默认 262144 |
| `max_tokens` | int | 单次响应最大输出 token，默认 32768 |
| `language` | string | 界面语言：`zh`（默认）/ `en` |
| `agents_paths` | string[] | 覆盖 AGENTS.md 收集，见 [AGENTS.md 机制](./agents-md.md) |
| `extra_skill_dirs` | string[] | 追加 skill 扫描目录，见[技能、插件与 MCP](./skills-and-mcp.md) |

顶层 `provider` / `api_key` / `base_url` / `model` 是「单模型」的最简写法。要登记多个模型、多个渠道并在运行时切换，用下面的 `[providers]` + `[models]` 两张表。

### 协议与 provider

provider 层支持三种协议，由预设名或 `[providers.<id>]` 的 `type` 选定：

| 协议 | 端点后缀 | `base_url` 是否带 `/v1` | 工具调用 | 适用 |
|------|----------|------------------------|----------|------|
| `anthropic` | `/v1/messages` | **不带**（SDK 自拼） | 支持 | coding（默认，`stepfun` / `anthropic` 预设走它） |
| `openai` | `/v1/chat/completions` | **带** | 支持 | coding |
| `openai_responses` | `/v1/responses` | **带** | 不支持 | 仅纯对话，不适合 agent 主循环 |

阶跃 Step 系列（如 `step-3.7-flash`）三协议均可接入。默认 `stepfun` 预设走 anthropic 协议，行为与既有版本一致。

> **最常见的坑：`base_url` 的 `/v1` 差异。** anthropic 协议的 `base_url` 写到域名即可（`https://api.stepfun.com`），SDK 自动拼 `/v1/messages`；openai 与 openai_responses 协议的 `base_url` 必须带 `/v1`（`https://api.stepfun.com/v1`），否则端点拼错、请求 404。四个内置预设已按各自协议设好默认，只有自定义 `base_url` 时才要注意这条。

### `[providers.<id>]` 渠道表

一个渠道就是「一套接入端点 + 凭据」。声明后可被多个模型别名引用，同一服务商的多个端点或多把 key 也能分开表达。

```toml
[providers.step-anthropic]
type = "anthropic"                    # 协议类型：anthropic / openai / openai_responses
base_url = "https://api.stepfun.com"  # anthropic 协议不带 /v1

[providers.step-openai]
type = "openai"                       # OpenAI Chat Completions，适合 coding
base_url = "https://api.stepfun.com/v1"  # openai 协议带 /v1
api_key = "<your-key>"                # 可选，缺省回落顶层 api_key / 环境变量
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 协议类型：`anthropic` / `openai` / `openai_responses`（也接受 `stepfun` 预设名）；非法值该渠道无效被跳过 |
| `base_url` | 否 | 渠道专属 API 地址，缺省回落顶层与预设；带不带 `/v1` 按协议区分（见上表） |
| `api_key` | 否 | 渠道专属 key，缺省回落顶层与环境变量 |

内置预设 `stepfun` / `anthropic` 作为隐式渠道始终存在，`[models]` 里的 `provider` 字段既可指自定义渠道 id，也可直接写内置预设名，旧配置零迁移。

### `[models.<别名>]` 别名表

一个别名把「渠道 + 模型 id + 窗口 + 展示信息」打包成一个可切换单元。字段全部可选，缺省项合并时继承顶层配置；`model` 缺省时等于别名本身。

```toml
[models."step-3.7-flash"]
provider = "stepfun"                    # 引用渠道 id 或内置预设名
model = "step-3.7-flash"
max_context_size = 262144
display_name = "Step 3.7 Flash"         # 可选，选择器与状态栏显示用
capabilities = ["thinking", "image_in"] # 可选，字符串数组，原样透传
```

| 字段 | 说明 |
|------|------|
| `provider` | 渠道 id 或内置预设名，缺省用顶层 provider |
| `model` | 真实模型 id，缺省等于别名本身 |
| `base_url` / `api_key` | 覆盖渠道/顶层的端点与凭据 |
| `max_context_size` | 该模型的上下文窗口，缺省回落顶层默认 |
| `max_tokens` | 单次响应最大输出 token，缺省回落顶层 |
| `display_name` | 选择器与状态栏显示名，缺省用别名 |
| `capabilities` | 能力标签数组（如 `thinking` / `image_in`），供选择器与后续特性识别 |

- 启动时对最终 model 展开一次别名，因此 `--model 别名`、`STEP_CODE_MODEL=别名`、toml 顶层 `model = "别名"` 三条路径同效。
- 运行时用 `/model` 打开交互式选择器或 `/model <别名>` 直切，切换会按合并配置重建 provider，上下文窗口随之跟随，见[交互使用](./interactive.md)。

### `[thinking]` 推理过程

Step 3.x 系列是恒思考模型，无论是否发送 thinking 字段，响应都可能带思考块——TUI 会无条件渲染（见[交互使用](./interactive.md)）。本段只控制**请求侧是否主动发送 thinking 字段及其预算**。

```toml
[thinking]
enabled = true         # 默认 false：不主动发 thinking 字段，保持既有请求行为
budget_tokens = 8192   # 可选；思考预算，会 clamp 到 ≥1024
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `enabled` | false | 是否主动发送 `thinking` 请求字段。默认关，兼容对该字段报错的模型 |
| `budget_tokens` | — | 思考 token 预算，clamp 到 ≥1024 |

启用时要求 `max_tokens - budget_tokens ≥ 2048`（给正文留最小余量，否则思考会吃满配额、正文零输出），不满足会在加载时报配置错误。

> `[thinking]` 段只对 **anthropic 协议**有效（`budget_tokens` 是 Anthropic 字段）。openai / openai_responses 协议下阶跃恒思考、无需也不发送该字段，此段配置被忽略；思考过程仍会正常渲染。

### `[subagent]` 子 agent 限制

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `max_per_session` | 10 | 1–50 | 单会话累计派生上限 |
| `max_depth` | 1 | 1–3 | 嵌套深度上限 |
| `max_steps` | 100 | 1–1000 | 子 agent 内部最大往返轮数 |
| `max_concurrent` | 4 | 1–16 | 并行子 agent 并发上限 |

### `[compaction]` 上下文压缩

| 字段 | 默认 | 范围 | 说明 |
|------|------|------|------|
| `trigger_ratio` | 0.85 | 0.5–0.99 | 占用达到上下文上限 × 此值即触发压缩 |
| `reserved_tokens` | 32000 | 0–500000 | 剩余窗口不足此值即触发压缩 |
| `model` | — | — | 压缩摘要专用模型，缺省用主模型 |

### `[background]` 后台任务

| 字段 | 默认 | 说明 |
|------|------|------|
| `bash_auto_background_on_timeout` | true | 前台 bash 超时后自动转后台；false 为超时即杀 |
| `bash_task_timeout_s` | 600 | 后台任务超时秒数，0 为不限（上限 86400） |
| `notify_on_complete` | true | 后台任务终态时主动注入完成通知 |

## `[[hooks]]` 生命周期钩子

在生命周期事件点执行你的 shell 命令，可观察、可阻断。用 `[[hooks]]` 数组声明，每条四字段：

```toml
[[hooks]]
event = "PreToolUse"                        # 事件名
matcher = "^bash$"                           # 可选正则，匹配工具名/事件标识
command = "python ~/.step-code/hooks/guard.py"
timeout = 30                                 # 秒，可选，默认 30，硬顶 600
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `event` | 是 | 事件名：`PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart` |
| `matcher` | 否 | 正则，匹配工具名或事件相关标识；缺省匹配全部 |
| `command` | 是 | 要执行的 shell 命令 |
| `timeout` | 否 | 超时秒数，默认 30，硬顶 600 |

只支持用户级全局配置（`~/.step-code/config.toml`），不做项目级——配置文件位置即信任边界。事件语义、阻断规则、stdin/exit 约定见 [hooks 机制](./hooks.md)。

## 环境变量一览

| 变量 | 说明 |
|------|------|
| `STEP_CODE_API_KEY` | API key（首选） |
| `STEPFUN_API_KEY` | API key（向后兼容别名） |
| `STEP_CODE_PROVIDER` | 服务商 |
| `STEP_CODE_BASE_URL` | API 地址 |
| `STEP_CODE_MODEL` | 模型名 |
| `STEP_DEBUG_RENDER` | 设为 `1` 开启动态帧渲染预算诊断：触发降级（`DEGRADED`）或帧高触线（`DANGER`）时追加写 `%TEMP%/step-code-render-debug.log`，用于排查渲染/滚动问题 |

## 数据目录

`~/.step-code/` 下的内容：

| 路径 | 内容 |
|------|------|
| `config.toml` | 主配置 |
| `mcp.json` | 外部 MCP server 声明，见[技能、插件与 MCP](./skills-and-mcp.md) |
| `AGENTS.md` | 用户级规范，见 [AGENTS.md 机制](./agents-md.md) |
| `skills/` | 用户级技能 |
| `agents/` | 用户级自定义子 agent（`*.md`） |
| `plugins/` | 插件目录，见[技能、插件与 MCP](./skills-and-mcp.md) |
| `plugins.json` | 插件启停状态（记录 disabled 集合） |
| `cron/` | 定时任务持久化，按工作目录分桶、每任务一 JSON，见[子 agent 与自动化](./agents.md) |
| `hooks/` | 惯例上存放 `[[hooks]]` 引用的脚本（非强制） |
| `sessions/` | 会话快照，按工作目录分桶 |
| `input-history/` | 输入历史，按工作目录隔离 |
