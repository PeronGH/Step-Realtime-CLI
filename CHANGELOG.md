# Changelog

本项目的所有重要变更记录于此。格式沿用 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

> 0.1.0 尚未正式发布，首个版本的完整能力见 [README](./README.md) 与 [docs/](./docs/)。

### Fixed

- **工具执行期间滚动终端历史被瞬间拽回**：动态帧高度预算补完——新增 `liveBudget` 预算层保证动态帧总高恒 ≤ 终端行数 − 1；斜杠菜单与长输入折行精确计入预算；各面板长行截断；可选面板超限时按优先级降级；`LiveViewport` 测量时序竞态修复。新增 `STEP_DEBUG_RENDER=1` 渲染诊断日志（`%TEMP%/step-code-render-debug.log`）。
- **工具输出展开态被冻结进历史**：定稿条目恒以折叠态进入终端历史，Ctrl+O 展开仅为生成期间的临时视图，历史始终保持紧凑。
