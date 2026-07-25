# 会话管理

本页讲会话的保存、恢复、分叉、压缩与回顾，以及非交互输出格式。

## 持久化

每次对话自动保存为快照，存在 `~/.step-code/sessions/` 下、按工作目录分桶——在 A 项目目录启动时只会看到 A 项目的会话。会话标题从首条消息自动派生。

## 续接与恢复

```bash
step --continue        # 续接当前目录最近一次会话
step -c -p "继续"      # 非交互模式下续接
step --resume          # 打开交互式会话选择器（↑↓ 浏览元信息，Enter 恢复）
step --resume <id>     # 直接恢复指定会话
step --session <id>    # 同 --resume <id>
```

无头管理：

```bash
step sessions list          # 列出当前目录的会话
step sessions show <id>     # 查看会话内容
step sessions delete <id>   # 删除
```

交互界面内 `/sessions`（或 `/resume`）热切换会话，`/new` 开新会话。

## 分叉（fork）

`/fork` 从当前最新点复制整个会话为新会话，源会话不动。适合"从这里开始想试另一个方向，但不想丢掉现在的进度"。

## 上下文压缩

对话变长接近上下文上限时自动压缩：先微压缩（清旧工具结果正文），仍超再做全量 LLM 摘要。触发条件可在 `[compaction]` 段配置。手动压缩用 `/compact`。

完整的原始历史不受压缩影响：每个会话另存一份 append-only 全量日志（`<id>.full.jsonl`），供 `/reflect` 使用。

## 回顾（/reflect）

`/reflect` 分段遍历完整对话历史，提炼可复用的方法论经验打印出来。长会话收尾时跑一次，把"这次是怎么做成的"沉淀下来。非交互等价物：`step --reflect -c`。

## 导出

`/export-debug-zip` 或 `step export-debug-zip [sessionId]` 导出会话调试包（zip），排查问题时使用。

## 非交互输出

`-p` 模式下：assistant 文本走 stdout，工具调用和错误走 stderr，可以直接进管道。加 `--output-format stream-json` 则每个事件输出一行 JSON，供程序消费（比如接进自己的脚本或 CI）。
