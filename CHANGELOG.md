# Changelog

## 0.1.0 — 2026-10-22

首个版本。

- **索引注入**：`agent/pre-step` 注入 `<kb-context>`（设备档案、知识域篇数与子目录分布、经验/模块计数、待整理草稿名、最近提交与未提交数），实时扫描、sha1 去重、按字节预算逐级降级；恢复会话时按快照去重。
- **写库守卫**：`ctx.tools.guard()` 同步单调拦截——未读库根契约时拒绝 `write` / `edit` / shell 写正式目录；`笔记/` 草稿区与库外路径豁免；异常与标记系统不可用时 fail-open。
- **已读标记**：`tools/result` 观察成功 `read` 契约 → 落 `$DSH_HOME/kb-contract/<session>.read`（7 天 TTL，重启仍有效）。
- **`/kb` 命令**：`status` / `check` / `refresh` / `contract`。
- **模型工具**：`kb_status`（库现状）、`kb_check`（运行知识库自带 `check.py` 并结构化输出）。
- **MCP 写工具隐藏**：可选按 agent `tools.restrict` 隐藏 `mcp__basic-memory__write_*` 等写工具。
- **配套退役**：接管原 `refresh-kb-index.py` + 知识库仓库 `post-commit` + `~/.agents/AGENTS.md` 的静态索引通道（该通道已归档/停用，脚本保留作回滚）。
