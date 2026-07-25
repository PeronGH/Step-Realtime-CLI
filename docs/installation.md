# 安装

## 环境要求

- **Node.js >= 22**（`glob` 工具用到 `node:fs.globSync`，该 API 自 Node 22 起可用）
- **pnpm**（包管理）
- Windows 用户：`bash` 工具会自动探测 Git Bash，建议安装 [Git for Windows](https://git-scm.com/download/win)

## 从源码安装

```bash
git clone <仓库地址>
cd step-code
pnpm install
pnpm build        # tsc 编译到 dist/
pnpm test         # vitest 单元测试（可选，验证环境正常）
```

构建后用 `node dist/main.js` 即可运行。想把 `step` 注册成全局命令：

```bash
pnpm link --global
step
```

## 升级

源码安装即软链接安装，拉取最新代码后重新构建即可，无需重新 link：

```bash
git pull
pnpm install    # 依赖有变化时
pnpm build
```

## 卸载

```bash
pnpm unlink --global   # 移除全局 step 命令
```

配置、会话记录等数据在 `~/.step-code/`，卸载命令不会动它；要彻底清理手动删除该目录。

## 常见问题

**`step` 命令找不到**：`pnpm link --global` 的目标目录不在 PATH 里。执行 `pnpm bin --global` 查看目录，把它加入 PATH。

**Windows 下 `bash` 工具报错**：确认 Git Bash 已安装且在 PATH 中（`bash --version` 能跑通）。

**构建报类型错误**：先 `pnpm install` 确保依赖完整，再 `pnpm build`；仍失败跑 `pnpm typecheck` 看具体位置。
