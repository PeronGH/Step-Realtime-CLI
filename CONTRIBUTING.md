# 贡献指南

欢迎为 Step Code 贡献代码、文档或反馈。

## 开发环境

- Node.js ≥ 22（`glob` 工具依赖 `node:fs.globSync`）
- pnpm

```bash
pnpm install
pnpm dev          # tsx 直接跑，交互式开发
```

构建产物默认走 `pnpm build`（tsc → `dist/`）。如需单文件分发，用 `pnpm build:bundle`（esbuild 打包）或 `pnpm build:sea`（Node SEA 单可执行文件，需先 `pnpm approve-builds` 放行 esbuild）。

## 提交 PR 前

本地跑通以下三项（CI 在 Ubuntu / Windows / macOS 三平台同样会跑）：

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

开发时可用 `pnpm test:watch` 起 watch 模式。测试用 [vitest](https://vitest.dev/)。平台相关代码（如剪贴板、Git Bash 探测）用 `vi.skipIf` / `describe.runIf` 做条件跳过，不要硬编码 `process.platform` 判断整段 skip——这样每个测试文件在三平台都能加载。

## 调试

日志写到 `~/.step-code/logs/step-code.log`（进程内还留一份环形缓冲）。交互模式（`step`）日志只进文件，绝不污染 TUI；非交互（`-p`）与 `--reflect` 走 headless 模式。

排查问题时用 `/export-debug-zip`（TUI 内）或 `step export-debug-zip [sessionId]`（命令行）导出脱敏的调试包（会话历史、config、mcp.json、错误日志、环境清单，密钥自动 redact），附在 issue 里最省沟通。

## 对外文档撰写规范

面向用户的文档（`CHANGELOG.md`、`README.md`、`docs/` 下的使用文档）描述功能时，**只讲 Step Code 自己做了什么、解决了什么问题、怎么用**，不写「参考 X 实现」「对齐 X 的惯例」「移植自 X」这类横向对标或来源归因的措辞。

- **禁止**：`CHANGELOG` / 用户文档正文里出现「与 某竞品CLI 一致」「对齐 Codex」「借鉴 Claude Code」「移植自某某」等表述。功能就按它本身的价值来描述，说清行为、动机、用法即可。
- **允许且应当**：
  - 致谢集中放在 `README.md` 的致谢段，统一声明设计阶段参考过哪些优秀项目，并关联 `licenses/NOTICE.md`。这是正当致谢与许可义务，不算功能描述里的来源归因。
  - `licenses/` 下按开源许可要求收录第三方项目的 LICENSE 与 NOTICE。
- **不受本规范约束**：源码注释、`docs/design/` 设计稿等面向开发者的内部材料，可以写「对齐/参考某某方案」这类技术说明，便于维护者理解取舍。规范只约束面向用户的对外文档。

判定口诀：这句话是写给**用户**看的功能说明，还是写给**开发者**看的技术备注？前者去掉一切横向对标，后者可保留。

## PR 规范（硬性要求）

- **PR 描述必须关联一个 issue**，用 `Closes #N`、`Fixes #N` 或 `Refs #N`。这条由 `pr-lint` 工作流强制校验，不满足会失败。若确无对应 issue，仓库 owner 可加 `skip-issue-link` label 放行。
- 新功能或 bug 修复请配套加测试。
- 提交信息用简洁的祈使句，标注类型前缀（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）。
- 平台相关代码不要硬编码 platform 判断，跨平台路径用 `node:path`。
- 不要提交构建产物（`dist/`）或密钥（`.env`）。

## 报告问题

用仓库的 issue 模板（bug / feature / docs / chore / question）。安全漏洞请走 [SECURITY.md](./SECURITY.md) 的私密披露渠道，不要开公开 issue。

## 架构与约定

开发前请先读 [`AGENTS.md`](./AGENTS.md)，其中包含多协议模型接入、分层结构与协作规范。
