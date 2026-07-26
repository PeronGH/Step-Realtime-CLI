# 交互使用

本页讲交互界面的日常使用：斜杠命令、快捷键、权限模式与计划模式。

## 界面结构

Ink 终端界面：顶部欢迎框，中间是会话流（你的输入、模型回复、工具调用卡片），底部两行状态栏——第一行是模式/模型/状态/路径，第二行是快捷键提示和 context 用量（真实 token 百分比）。

模型正在工作时输入文字不会丢：进入发送队列，回合结束自动逐条发出，输入框上方有队列预览。

### 会话流与滚动

历史直接翻终端原生 scrollback（滚轮/滚动条），随时可翻、不会被刷新打断。已定稿的内容只写一次、永久落在历史里；正在生成的长内容只显示尾部，顶部压一行「↑ 已隐藏 N 行」，输出完整后全文自然落入历史——这是刻意的取舍：流式期你的注意力在最新几行，而翻历史永远完整、不丢不跳。

工具输出默认折叠为一行摘要（「N 行输出 · Ctrl+O 展开」），Ctrl+O 在生成期间临时展开看全文；定稿入历史后恒为折叠摘要，保证历史紧凑。

恢复会话（`step -r` / `/resume`）时，历史对话会重新渲染到终端，和实时看起来一致；长会话默认只重放最近若干轮，更早的在顶部提示已折叠。详见[会话管理](./sessions.md#恢复时重放历史内容)。

## 斜杠命令

敲 `/` 弹出命令菜单，↑↓ 选择、Tab 补全、Enter 执行。

| 命令 | 作用 |
|------|------|
| `/help`（`/?`） | 查看全部命令 |
| `/model` | 切换模型：无参打开交互式选择器，`/model <别名>` 直切 |
| `/think` | 思考深度：无参打开档位选择器，`/think <档位>` 直切，`/think off` 本会话停发 thinking 字段 |
| `/provider` | 切换服务商预设（stepfun / anthropic / openai / openai_responses） |
| `/permission` | 查看/切换权限模式 |
| `/yolo` `/auto` | 快捷切到对应权限档 |
| `/plan` | 开关计划模式 |
| `/goal` | 自主目标：状态面板、pause/resume/cancel |
| `/loop`（别名 `/cron`） | 查看定时任务 |
| `/fork` | 从当前点分叉会话 |
| `/new` | 开新会话 |
| `/compact` | 手动压缩上下文 |
| `/reflect` | 回顾本次对话，沉淀方法论经验 |
| `/sessions` `/resume` | 浏览并恢复历史会话 |
| `/skill <名称> [参数]` | 手动激活技能 |
| `/skill reload` | 强制重扫技能目录（会话中改动 SKILL.md 后即时生效；回合边界也会自动检测） |
| `/plugin` | 管理插件：`install / list / enable / disable / remove / info` |
| `/mcp` | 查看 MCP server 连接状态 |
| `/lang` | 切换中英文界面 |
| `/export-debug-zip` | 导出会话调试包 |
| `/exit`（`/quit`） | 退出 |

## 快捷键

| 按键 | 作用 |
|------|------|
| Esc | 中断当前生成（保留历史）；空闲且输入框空时双击 Esc 回退编辑上一条消息 |
| Ctrl+C | 第一次按进入"再按一次退出"预备态，第二次按退出；生成中按则中断 |
| Ctrl+O | 展开/折叠工具输出（对当前动态区生效；已定稿入历史的输出恒为折叠摘要） |
| Alt+V | 从剪贴板粘贴图片（Windows）：在输入框光标处插入占位符 `[image #1 (宽×高)]`，可像普通文字一样编辑删除，提交时展开为图片 |
| ↑ / ↓ | 输入框空时回溯发送历史（bash 式草稿暂存）；菜单可见时归菜单 |

### 输入框编辑键

输入框支持 readline 风格的光标移动与删除键（单行输入）：

| 按键 | 作用 |
|------|------|
| Home / Ctrl+A | 光标到行首 |
| End / Ctrl+E | 光标到行尾 |
| Ctrl+← / Alt+B | 按词左移 |
| Ctrl+→ / Alt+F | 按词右移 |
| Ctrl+W | 删除前一个词 |
| Ctrl+U | 删到行首 |
| Ctrl+K | 删到行尾 |

## 权限模式

三档梯度，启动默认 manual：

- **manual**：写文件、执行命令都要逐项确认。确认面板支持 ↑↓ 选择 + Enter、y/a/n/f 快捷回答、数字直选，选"本会话允许"后同类操作不再问，还可以选"拒绝并写评论"把原因反馈给模型。
- **auto**：写文件放行，`bash` 仍需确认。
- **yolo**：全部放行，适合沙箱或你完全信任的任务。

非交互模式（`-p`）下写操作需要 `--auto` 或 `--yolo`，否则会被拒绝。

## 计划模式

`/plan` 开启后，权限层硬拦所有写/执行工具，模型只能做只读调查，产出计划后由你确认才恢复执行。它是独立维度，叠加在权限模式之上：比如 manual + plan 表示"先出计划，批准后逐步确认执行"。适合改动范围大、想先看方案再动手的任务。再按 `/plan` 关闭。

## 切换模型

`/model` 无参会打开交互式选择器（前提是你在 config.toml 里用 `[models]` 登记了别名，见[配置参考](./configuration.md)）：

- 单层扁平列表，每行显示模型显示名（左列）+ 所属渠道名（右列灰色），当前生效项标 `← 当前`。
- ↑↓ 移动；直接敲字符做模糊过滤（匹配别名/显示名/渠道名），Backspace 删过滤字；Enter 确认、Esc 取消（有过滤词时先清词）。
- 模型正在工作（busy/streaming）时拒绝切换并提示。
- 当前会话已有历史时，选择器顶部会警告「切换模型会使已有 prompt cache 失效，`/new` 开新会话可避免额外 token 消耗」。

`/model <别名>` 是文本直切，跳过选择器。两种方式确认后都会按别名的合并配置重建 provider，上下文窗口随之跟随，状态栏显示新模型的显示名。切换只影响当前进程，不写回 config.toml。

`/think` 控制思考深度（仅 anthropic 协议且已启用 `[thinking]` 的渠道可用）：无参打开档位选择器（会话忙时退化为文本列表），`/think <档位>` 直切，`/think off` 本会话不再发送 thinking 字段。档位表来自 `[thinking.levels]`（缺省 low/medium/high = 1024/4096/32000），状态栏模型名旁显示当前档位。切换只影响当前会话，不写回 config.toml（持久化用 `default_level`）；会话已有历史时切换会提示 prompt cache 失效。

## 推理过程显示

Step 3.x 系列是恒思考模型，响应会带思考过程。TUI 无条件渲染它：

- **流式期**：状态行显示「思考中…」加尾部数行滚动预览，暗色，不进正式会话流。
- **完成后**：落一个暗色斜体折叠块，最多显示前 5 行，超出折叠为「…（共 N 行）」。

是否让模型**主动发送**思考请求字段、以及思考预算，由 config.toml 的 `[thinking]` 段控制（见[配置参考](./configuration.md)）；但无论是否发送，恒思考模型的响应都可能带思考块，渲染始终生效。非交互 `-p` 模式下思考内容不进 stdout，保持输出可管道。

## 插件管理

`/plugin` 管理 `~/.step-code/plugins/` 下的插件：

| 子命令 | 作用 |
|--------|------|
| `/plugin install <目录>` | 从本地目录安装（复制到插件目录，重装即覆盖更新） |
| `/plugin list` | 列出已安装插件及启停/错误状态 |
| `/plugin enable <id>` / `disable <id>` | 启用 / 停用插件 |
| `/plugin remove <id>` | 移除插件 |
| `/plugin info <id>` | 查看插件详情 |

启停变更后按提示 `/new` 或重启生效。插件能提供什么、清单格式见[技能、插件与 MCP](./skills-and-mcp.md)。

## 命令行参数

```bash
step                          # 交互式（进 Ink 界面，默认 manual 权限）
step -p "在 src 下找出所有 TODO"          # 非交互：执行单条指令后退出
step --yolo -p "重命名 a.txt 为 b.txt"    # --yolo 全放行 / --auto 写放行（非交互写操作需要其一）
step --continue -p "继续上次的任务"       # 会话续接（-c）
step --session <id>                     # 恢复指定会话
step --resume                           # 打开交互式会话选择器（-r [id]）
step --provider anthropic -p "..."      # 切换服务商预设
step --model step-3.7-flash -p "..."   # 指定模型
step -C /path/to/project -p "..."       # 指定工作目录
step --output-format stream-json -p "..."   # 每事件一行 JSON
step sessions list                      # 无头子命令：会话管理
step export-debug-zip [sessionId]       # 导出调试包
```

| 参数 | 说明 |
|------|------|
| `-p, --print <prompt>` | 非交互执行单条指令 |
| `-y, --yolo` / `--auto` | 权限模式：全放行 / 写放行 |
| `-c, --continue` | 续接当前目录最近会话 |
| `-r, --resume [id]` | 恢复会话（无 id 时开选择器） |
| `--session <id>` | 恢复指定会话 |
| `--provider <name>` | 服务商预设（stepfun / anthropic / openai / openai_responses） |
| `--model <name>` | 模型名 |
| `-C, --cwd <dir>` | 工作目录（所有相对路径的基准） |
| `--output-format <fmt>` | 输出格式（`stream-json`） |
| `--reflect` | 非交互跑 /reflect（配合 `-c` / `--session`） |

## 非交互模式

```bash
step -p "指令"                        # 执行完退出，结果走 stdout，工具/错误走 stderr
step --yolo -p "重命名 a.txt 为 b.txt"
step -p --output-format stream-json "..."   # 每事件一行 JSON，供程序消费
```

非交互模式可进管道：`step -p "总结这个文件" < README.md`，assistant 输出在 stdout，可直接接下游命令。
