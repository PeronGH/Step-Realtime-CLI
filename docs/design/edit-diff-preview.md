# Edit 工具 Diff 预览 — 产品设计文档

状态：设计稿
作者：Step Code
关联：`src/tools/edit.ts`、`src/tui/ToolCall.tsx`

## 一、要解决的问题

当前 `edit_file` 执行成功后，工具卡片只显示一句「已编辑 X（替换 N 处）」。用户看不到**具体改了哪几行、改成了什么**，只能事后自己去读文件或翻 git diff 才能确认改动是否符合预期。

目标：**编辑完成后，工具卡片直接展示这次改动的 diff 预览**——带行号的绿色 `+` 新增行、红色 `-` 删除行，保留少量上下文行，改动多时折叠成「… N more changes hidden（Ctrl+O 展开）」。用户不离开终端就能核对这次编辑改了什么。

## 二、设计原则

1. **改动即所见**：编辑结果卡片就是这次改动的可视化，不需要用户再去别处核对。
2. **默认紧凑，按需展开**：折叠态只显示改动行 + 少量上下文，改动多时省略中段并给展开提示（复用现有 Ctrl+O 全局展开机制）。
3. **与实时/回放一致**：diff 预览走现有 `ToolCall` → `ResultBody` 渲染链，历史回放时同样能看到（因为回放复用同一组件）。
4. **不破坏工具契约**：`ToolResult` 仍是 `{ content: string, isError }`，diff 作为文本进入 content，既能渲染也能让模型理解改动。

## 三、技术方案

### 3.1 路线选择

采用**路线 A：工具内生成 diff 文本**，而非扩展 ToolResult 结构。

| 维度 | 路线 A（选中） | 路线 B（结构化 meta） |
|------|---------------|----------------------|
| 改动面 | edit.ts + diff 算法 + ToolCall 上色 | ToolResult / AgentEvent / loop / DisplayItem / ToolCall 全链 |
| 风险 | 低，不动核心数据流 | 高，牵一发动全身 |
| 参数生成期预览 | 不支持（执行完成后一次性出 diff） | 可支持（模型逐 token 吐参数时先出预览版） |
| 发给模型的内容 | diff 文本（略占 token，但有助模型理解改动） | 纯文本，UI 单独拿结构化数据 |

工具执行本身是原子的：模型吐出完整的 tool_use 参数后本地一次性执行，拿到完整的新旧内容才能算 diff。因此第一版只做「执行完成后显示最终 diff」，不做「模型还在逐 token 生成 edit 参数时就显示预览版」那种参数生成期预览——后者是锦上添花，第一版不需要，路线 A 足够。

### 3.2 模块划分

**新建 `src/tui/diffView.ts`**：
- `computeDiffLines(oldText, newText)`：LCS 逐行 diff，产出 `DiffLine[]`（kind: context/add/delete + 行号 + 内容）
- `renderDiffClustered(oldText, newText, opts)`：聚类相邻改动、省略中段无关行（`… N unchanged lines …`）、按 maxLines 截断（`… N more changes hidden`），返回文本行数组

**改 `src/tools/edit.ts`**：
- 替换前已持有 `text`（旧全文），替换后得到 `next`（新全文）
- 调 `renderDiffClustered(text, next, { path, contextLines: 3, maxLines: 折叠上限 })`
- diff 文本拼进 `ok()` 的 content，放在「已编辑 X」摘要之后

**改 `src/tui/ToolCall.tsx`**：
- `ResultBody` 渲染时，对以 `+`/`-` 开头的行分别上绿/红色，行号 gutter 上暗色
- 折叠/展开沿用现有 `expanded`（Ctrl+O）与 `EXPANDED_MAX_LINES` 机制，无需新建交互

### 3.3 diff 算法要点

- **LCS 动态规划**：`oldLines` × `newLines` 求最长公共子序列，回溯生成 context/add/delete 序列
- **聚类**：相邻改动（间隔 ≤ 2×contextLines）合并为一簇，簇间用「… N unchanged lines …」占位
- **上下文行**：每簇前后各保留 contextLines（默认 3）行未改动内容，便于阅读
- **截断**：超过 maxLines 时在簇边界截断，附「… N more changes hidden (Ctrl+O to expand)」

### 3.4 折叠态与展开态

| 态 | 显示内容 |
|----|---------|
| 折叠（默认） | 摘要行 `+N -M path` + 改动簇（含少量上下文），超 maxLines 截断并提示 |
| 展开（Ctrl+O） | 完整 diff（受 `EXPANDED_MAX_LINES` 上限保护，超长再截断） |

## 四、影响范围与兼容性

- **不影响**：ToolResult 契约、AgentEvent、agent loop、会话持久化、其它工具
- **write_file**：整体覆盖类工具本次不做 diff（新建/全覆盖场景 diff 意义不大），仅 `edit_file` 接入。后续可评估给 write_file 覆盖已有文件时也出 diff
- **非 TTY / 管道模式**：diff 文本照常进 content，只是不上色（chalk 在非 TTY 自动降级）
- **token 成本**：diff 文本会随 tool_result 回灌模型，长改动时增加少量 token。可设 maxLines 上限控制；必要时后续用路线 B 把「给模型的文本」与「给 UI 的 diff」分离

## 五、验收标准

1. 编辑一个文件后，工具卡片显示 `+N -M path` 摘要 + 带行号的 +/- diff
2. 改动行绿/红上色，上下文行常色，行号 gutter 暗色
3. 改动超过折叠上限时显示「… N more changes hidden」，Ctrl+O 可展开
4. 多处分散改动时，簇间显示「… N unchanged lines …」
5. 历史回放（`step -r`）时，编辑卡片同样显示 diff
6. 非 TTY 环境不报错、diff 文本正常（无 ANSI 污染）

## 六、后续可选增强

- write_file 覆盖已有文件时也出 diff
- 路线 B：结构化 diff 数据流，给模型发纯文本摘要、给 UI 发结构化 diff，降低 token 占用
- 语法高亮：diff 行内按语言上色（复用 cli-highlight）
