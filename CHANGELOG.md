# Changelog

## 0.1.2 — 2026-10-22

0.1.1 重启后的**活体测试**发现并修复了两个残留缺口（都是"单测没覆盖到的真实运行形态"）。

### 修复

- **相对路径在"切过目录"的会话里仍可绕过**：`session.header.cwd` 只在会话创建时写入，`working_directory` 切换后仍是旧值，守卫按旧值解析相对路径就会判成"库外"。现在取「头字段 cwd + `workingDirectory` 投影 + 进程目录」三个候选，对每个候选解析，**任一**落入正式目录即拒绝（判不准时偏向拦截，读一次契约即可恢复）。
- **`git -C '<路径>'` 写法漏判**：旧解析先 `stripQuoted` 再按空白切词，引号里的路径被抹掉后 `-C` 会把后面的子命令当成路径值吞掉，导致 `git -C 'D:\kb\vault' clean -fdn` 被放行（活体实验实测）。改为**先按引号切词**再去引号，`-C <路径> <子命令>` 正确识别；`git stash list` 等只读变体仍放行。

### 验证

- 单测 55 → 58（新增多候选目录、带引号 `-C` 两组回归）
- 活体：0.1.1 下 `git -C '…' clean -fdn` 放行、库内相对写入放行；修复后探针全部按预期拒绝/放行

## 0.1.1 — 2026-10-22

代码审查后的修复版。修掉三个真实缺陷，并把守卫的覆盖率与可观测性补上。

### 修复

- **相对路径绕过**：守卫对 `write` / `edit` 只用原值做包含判断，而 DSH 会把相对 `file_path` 解析到会话工作目录——会话在库内时写 `知识/a.md` 可绕过拦截。现在先按 `session.header.cwd` 解析再判定（shell 的相对 `workdir` 同理）。
- **`draftDir: "."` 静默失效**：配置校验只拦 `..` 与绝对路径，`.` 会让 `join(vault, ".")` 等于库根，整库变成豁免区。现在 `.` / 空段 / 结尾斜杠 / 绝对路径一律拒绝（新增 `lib/config.js`）。
- **标记 TTL 不生效**：TTL 只在写标记时清扫，读取不校验，30 天前的标记照样放行。现在 `has()` 读取时 stat 判过期并删除，7 天 TTL 名副其实。

### 改进

- **shell 覆盖**：新增会改写工作树的 `git` 子命令（`checkout/restore/reset/clean/rm/mv/revert/cherry-pick/am/switch/apply/stash`，`apply --check` 与 `stash list|show` 除外）与 `robocopy` / `xcopy`；解释器内写盘（`python -c`、`node -e`）确认为不可覆盖边界，写入文档。
- **注册隔离**：五个接缝逐个 try/catch + `logger.error`，一个失败不连坐其余；注册结果通过 `/kb status` 的能力自检可见。
- **MCP 隐藏重试有上限**：失败最多重试 3 次并只记两条日志，不再每步刷屏。
- **截断块闭合**：超字节预算截断时补 `</kb-context>`，注入块始终闭合。
- **扫描告警位置**：从「用法」段内挪到独立段落；扫描器文件读取改为 8 并发上限。
- **`markDirty` 解耦**：不再依赖 `injectContext`，只用工具/守卫模式时索引缓存也能被库内活动刷新。
- **`/kb forget`**：清除本会话已读标记，`markers.forget()` 不再是死代码。
- 测试从 39 个增至 55 个，覆盖上述全部回归。

## 0.1.0 — 2026-10-22

首个版本。

- **索引注入**：`agent/pre-step` 注入 `<kb-context>`（设备档案、知识域篇数与子目录分布、经验/模块计数、待整理草稿名、最近提交与未提交数），实时扫描、sha1 去重、按字节预算逐级降级；恢复会话时按快照去重。
- **写库守卫**：`ctx.tools.guard()` 同步单调拦截——未读库根契约时拒绝 `write` / `edit` / shell 写正式目录；`笔记/` 草稿区与库外路径豁免；异常与标记系统不可用时 fail-open。
- **已读标记**：`tools/result` 观察成功 `read` 契约 → 落 `$DSH_HOME/kb-contract/<session>.read`（7 天 TTL，重启仍有效）。
- **`/kb` 命令**：`status` / `check` / `refresh` / `contract`。
- **模型工具**：`kb_status`（库现状）、`kb_check`（运行知识库自带 `check.py` 并结构化输出）。
- **MCP 写工具隐藏**：可选按 agent `tools.restrict` 隐藏 `mcp__basic-memory__write_*` 等写工具。
- **配套退役**：接管原 `refresh-kb-index.py` + 知识库仓库 `post-commit` + `~/.agents/AGENTS.md` 的静态索引通道（该通道已归档/停用，脚本保留作回滚）。
