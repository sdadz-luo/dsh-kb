# AGENTS.md — dsh-kb 开发约束

给接手本仓库的 AI agent / 贡献者。**运行时行为、配置字段、安装步骤在 [README.md](README.md)，本文件只写「改这个插件时必须知道的事」**。

## 不变量（破坏即回归）

1. **消息 source kind 必须是 `plugin:dsh-kb`**。Session format V4 拒绝 `kind:"plugin"`（报 `format v4 message requires a producer-owned source kind`），第三方 producer 一律 `plugin:<name>`。改 `name` 常量时必须同步改 `SOURCE_KIND`。
2. **守卫必须同步且 fail-open**。`ctx.tools.guard()` 的检查函数是同步的，不许在里面 `await`；任何异常都要吞掉返回 `undefined`（放行），否则一次内部错误会锁死该会话的所有写操作。
3. **标记系统不可用时降级放行**。`ContractMarkers.usable()` 探测失败 → `decideGuard` 直接 allow。反过来（拦死）会造成「读契约记不上标记 → 永远拒绝」的死锁。
4. **草稿区豁免**。`draftDir`（默认 `笔记/`）免读契约，这是知识库契约铁律的一部分，插件不得私自收紧。
5. **插件只读知识库**。除 `$DSH_HOME/kb-contract/` 下的标记文件外不写任何磁盘位置；除运行用户配置的 `check.py` 外不启子进程；不改 git。
6. **零运行时依赖**。`lib/` 只 import `node:*` 与 `@deepseek-ai/{dsh-llm,dsh-home-paths,schemastery}`；纯逻辑模块（paths/shell/guard/render/scan/check/markers）**不许** import DSH 包，保证 `node --test` 不需要宿主即可跑。
7. **工具注册不用 `defineTool`**。`ctx.tools.register()` 接受裸定义（`{name, description, parameters, output:{schema,render}, execute}`），省掉对 `@deepseek-ai/dsh-tools` 的模块解析依赖；`output.schema` 保持 `{type:"string"}` 最简单，避免 JSON Schema 子集校验。
8. **索引必须做变更去重**。渲染结果 sha1 比对，内容没变不重发；注入位置排在已认领消息之后（`findLastIndex` + `toSpliced`），别插进会话前缀。
9. **相对路径必须先按会话 cwd 解析**。DSH 的文件工具把相对 `file_path` 解析到会话工作目录，守卫若直接 `isInside(vaultRoot, 原始值)` 会漏判「会话在库内时写 `知识/a.md`」。统一走 `resolveForCheck(value, session.header.cwd)`。
10. **配置里的库内路径必须走 `cleanVaultRelative`**。`.`、`..`、空段、结尾斜杠、绝对路径都要拒绝——`draftDir: "."` 会把整个库变成豁免区，让守卫静默失效。
11. **每个注册面单独隔离**。`apply()` 里五个接缝逐个 try/catch + `logger.error`，一个失败不能连坐其余；能力是否注册成功要能通过 `/kb status` 看到（`state.capabilities`）。
12. **标记 TTL 在读取时校验**。只在 `mark()`/`sweep()` 时清过期文件会让 7 天 TTL 形同虚设；`has()` 必须 stat 判过期并删除。

## 仓库结构

| 路径 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：Config schema、apply、四个接缝（pre-step / guard / tools-result / commands+tools） |
| `lib/config.js` | 库内相对路径校验（`.` / `..` / 绝对路径 / 空段全部拒绝） |
| `lib/paths.js` | 路径归一与包含判断（Windows 大小写不敏感） |
| `lib/shell.js` | shell 写盘启发式（含 git 破坏性子命令、robocopy/xcopy；移植自 Claude Code 的 kb-contract-guard） |
| `lib/guard.js` | 纯守卫决策 + 拒绝文案 |
| `lib/scan.js` | 库扫描（设备 / 知识域 / 经验 / 模块 / 草稿 / git） |
| `lib/render.js` | `<kb-context>` 渲染、字节预算降级、sha1 摘要 |
| `lib/check.js` | 跑 `check.py` 并解析 ❌/⚠️/📋 计数 |
| `lib/markers.js` | per-session 已读契约标记（磁盘 + 内存，7 天 TTL） |
| `test/*.test.mjs` | 纯逻辑与临时目录集成测试；**不触碰真实知识库** |
| `cordis.patch.yml` | bundle 层：只登记插件行，不带机器相关配置 |

## 改完必跑

```bash
node --test
```

再对真实知识库做一次冒烟（不需要启动 DSH）：

```bash
node -e "import('./lib/scan.js').then(async m => { const x = await m.scanVault({ vaultRoot: process.argv[1], draftDir: '笔记', includeGitInfo: true }); console.log(x.devices.length, x.domains.length, x.experience, x.modules, x.drafts.count, x.git); })" "<vault>"
```

数字要与库里实际目录一致；不一致先怀疑扫描规则，别改断言迁就。

## 安装与验收流程

1. `npm pack` → `dsh plugin --profile <profile> add file:<tgz>`（Desktop 构建只加载**真实目录**，不加载 junction / `link:`）。
2. DSH Desktop 的 profile 由应用托管，应用运行时 CLI 会拒绝；要么关掉应用从外部执行，要么按 README 的手工步骤登记（`dependencies` + `dsh.profile.bundles` + 解包到 `node_modules`）。
3. 重启应用后验收：
   - 会话上下文出现 `<kb-context>`，数字与库一致；
   - 未读契约时 `write` 正式目录被拒，错误里有 `read "…CLAUDE.md"`；
   - 读契约后同一写入放行；写 `笔记/` 始终放行；
   - `/kb status`（含能力自检）、`/kb check`、`/kb refresh`、`/kb forget` 可用；`kb_status` / `kb_check` 工具可被模型调用。
4. 卸载：`dsh plugin --profile <profile> remove dsh-kb`。注意失败的 `add` 会把 `dsh.profile.bundles` 里的条目删掉，重装后要确认它回来了。

## 常见坑

- **没有独立 `dsh` CLI 时**：可用 Electron 应用跑内置 CLI ——
  `DeepSeek Harness.exe --expose-internals <resources>/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js plugin ...`，并设 `ELECTRON_RUN_AS_NODE=1`。
- **插件 JS 不保证热加载**：改 `lib/` 后可能需重启 DSH；`cordis.patch.yml` 的 config 是热生效的。
- `agent/pre-step` 注入必须排在已认领消息之后，否则破坏会话前缀与 KV cache。
- 恢复会话靠 `session.snapshotEvents()` 找自己以前注入的快照做去重；该 API 上游已标记弃用，DSH 0.3 前必须复查。
- `tools/result` 是**观察**事件（无 `next`），只用来记标记，不要试图改结果。
- `agent.ctx.tools.restrict()` 只接受**全局**工具名，名字不存在会抛错；先 `ctx.tools.schemas(agent)` 过滤再 deny，失败按上限重试（`HIDDEN_TOOL_RESTRICT_ATTEMPTS`），别每步刷日志。
- 守卫的 `defaultDirectory` 取 `session.header.cwd`；拿不到退 `process.cwd()`，此时相对路径会按宿主进程目录解析——已知降级边界。
- 解释器内写盘（`python -c`、`node -e`）无法从命令行识别，必然放行；这是设计边界，不要试图用正则补全，写进文档即可。
- 测试必须覆盖「相对路径 + 会话在库内」「过期标记」「`.` 配置」这三类回归，它们都是已发生过的真实缺陷。
- `check.py` 的解释器别写死 `python`：部分 Windows 机器的 `python3` 是 App Execution Alias 空壳，要在配置里显式给 `pythonPath`。

## 提交规范

- 提交信息用中文，类型前缀 `feat` / `fix` / `refactor` / `docs` / `style` / `chore`。
- **禁止任何 AI 助手署名**（Claude / Anthropic / DeepSeek / DSH 等）。
- 改行为必须同时补测试；只改文档/注释可不加。
