# dsh-kb

> 给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的知识库插件：**实时索引注入 + 写库契约守卫 + `/kb` 命令与工具**。

把个人知识库（Obsidian vault / 纯 Markdown 目录）接进 AI 编程助手里，通常要自己拼三样东西：一个扫目录生成索引的脚本、一条 git 钩子、一句「写库前先读契约」的自觉。**dsh-kb 把它们收进一个插件**：会话里始终有一份最新的库索引，写库前不读契约会被硬拦，库的现状与结构校验都是一条命令/工具。

## 特性

| 能力 | 说明 |
|---|---|
| **索引注入** | 每个 step 注入 `<kb-context>`：设备档案、知识域篇数与子目录分布、经验/模块计数、待整理草稿、最近提交与未提交数。实时扫描、**内容变化才重发**，不会每步刷屏 |
| **写库守卫** | `ctx.tools.guard()` 同步硬拦截：本会话没读过库根契约时，`write` / `edit` / shell 写正式目录一律拒绝，错误里给出可照抄的 `read` 指令 |
| **已读标记** | 成功 `read` 契约后本会话放行；标记落 `$DSH_HOME/kb-contract/`，7 天 TTL（**读取时强制校验过期**），DSH 重启仍有效；`/kb forget` 可手动清除 |
| **草稿豁免** | `笔记/` 等草稿区免读契约（随手记不该先付一遍规则成本） |
| **`/kb` 命令** | `status` / `check` / `refresh` / `contract`，UI 直出、不进模型消息 |
| **模型工具** | `kb_status`（库现状，省多次 Read/Glob）、`kb_check`（跑知识库自己的 `check.py` 并结构化输出） |
| **MCP 写工具隐藏** | 可选：按 agent 隐藏 `mcp__basic-memory__write_*` 等写工具，落实「只直接写 md」的契约 |

## 它怎么工作

全部通过 DSH 公开插件接缝实现，没有补丁、没有外部脚本、没有后台进程：

```
                 ┌──────────────── DSH 会话 ────────────────┐
 agent/pre-step ─┤ 注入 <kb-context>（扫描 → 渲染 → 变更比对）
 tools/result   ─┤ 观察到 read 库根契约 → 写本会话标记
 ctx.tools.guard┤ 未读契约时拒绝 write/edit/shell 写正式目录
 commands       ─┤ /kb status | check | refresh | contract
 tools          ─┘ kb_status / kb_check
                 └───────────────────┬──────────────────────┘
                                     │ 只读（+ 标记文件）
                                     ▼
                    知识库 vault：设备/ 知识/ 经验/ 模块/ 笔记/ 知识库规则/
```

- **注入**是 user-role 消息，`source.kind = plugin:dsh-kb`、`form: notice`，与 DSH 自己的上下文行同款折叠展示；恢复会话时按快照去重，不会重复注入。
- **扫描**只读文件头（frontmatter `updated:`）与目录结构，不读笔记正文。
- **守卫**是单调的：登记后任何后续监听器都无法把拒绝改回允许；同时**fail-open**——守卫自身异常或标记目录不可写时放行，避免把正常写入永久锁死。
- **只读原则**：除 `$DSH_HOME/kb-contract/` 下的标记文件外，插件不写任何磁盘位置，不改 git，不动知识库内容。

## 安装

要求 DSH 0.2.x（在 0.2.1-rc.2 上开发），Node.js ≥ 22.19。

### 用户级安装（CLI 可用时）

```bash
dsh plugin --profile <你的 profile> add dsh-kb
```

从源码安装（本包未发布 npm 时）：

```bash
npm pack
dsh plugin --profile <profile> add file:/absolute/path/dsh-kb-0.1.0.tgz
```

### DSH Desktop（应用运行中会拒绝 CLI）

Desktop 的 profile 由 Electron 应用托管，应用运行时 `dsh plugin` 会报
`profile "desktop" is managed exclusively by the Electron application`。两种做法：

1. 关掉应用后从外部终端执行 `dsh plugin ... add`（或在应用内插件管理界面安装）；
2. 或按插件等价的手工步骤安装（真实目录，不能用 junction / `link:`）：
   - 把包解包到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-kb`
   - `<profile>/package.json` 的 `dependencies` 加 `"dsh-kb": "file:<tgz 绝对路径>"`
   - 同一文件的 `dsh.profile.bundles` 数组加 `"dsh-kb"`
   - 重启应用

> Desktop 构建**不加载** `link:` / junction 形式的插件依赖，必须是真实目录。

## 配置

写在目标 profile 的 `cordis.patch.yml`（bundle 层只登记插件行，库路径是机器相关的，放这里）：

```yaml
- id: dsh-kb
  config:
    vaultRoot: 'D:\knowledge_base\knowledge_base'
    pythonPath: 'D:\Anaconda\python.exe'   # 跑 check.py 的解释器
    hideMcpWriteTools: true
```

`vaultRoot` 为空时插件**保持惰性**（只打一条 warn），不会报错、不会影响 DSH 启动。

| 字段 | 默认 | 说明 |
|---|---|---|
| `vaultRoot` | `""` | 库根绝对路径；空 = 插件不生效 |
| `injectContext` | `true` | 是否注入 `<kb-context>` |
| `guardWrites` | `true` | 写入守卫总开关 |
| `guardShell` | `true` | 是否连 shell 通道一起守 |
| `hideMcpWriteTools` | `false` | 是否按 agent 隐藏 MCP 写工具 |
| `includeSubagents` | `false` | 子 agent 会话是否也注入索引（守卫始终生效） |
| `includeGitInfo` | `true` | 索引是否带最近提交 / 未提交数 |
| `contractFile` | `CLAUDE.md` | 库根契约（库内相对路径） |
| `draftDir` | `笔记` | 免读契约的草稿区 |
| `maintenanceFile` | `知识库规则/维护细则.md` | 拒绝文案里点名的第二份必读 |
| `protocolFile` | `知识库规则/检索协议.md` | 查库协议（索引里的指针） |
| `checkScript` | `知识库规则/check.py` | 结构校验脚本 |
| `pythonPath` | `python` | 跑 `check.py` 的解释器 |
| `mcpServerName` | `basic-memory` | 隐藏写工具时匹配的 MCP server 名 |
| `maxBytes` | `6144` | 单次索引注入的字节上限（超了逐级降级：去子目录 → 去 git 行 → 截断） |
| `refreshIntervalMs` | `15000` | 扫描缓存窗口；库内文件读写事件会提前失效 |
| `checkTimeoutMs` | `60000` | `check.py` 超时 |

所有 `*File` / `draftDir` 都是**库内相对路径**，校验规则：绝对路径、`..`、`.` 段、空段（含结尾斜杠）一律拒绝——`draftDir: "."` 这类写法会让整个库变成豁免区，属于必须挡住的配置陷阱。

## 命令与工具

| 入口 | 用途 |
|---|---|
| `/kb status` | 库现状（设备、域、篇数、草稿、最近提交、本会话是否已读契约、**能力自检**：命令/工具/MCP 隐藏是否生效） |
| `/kb check` | 跑 `check.py`，给 ❌/⚠️/📋 计数与明细 |
| `/kb refresh` | 清空索引缓存，下一步重扫重发 |
| `/kb contract` | 契约路径、草稿区、本会话已读状态 |
| `/kb forget` | 清除本会话的已读标记，下次写库重新要求读契约 |
| 工具 `kb_status` | 同 `/kb status` 的结构化文本，模型可直接调用 |
| 工具 `kb_check` | 同 `/kb check`；`strict: true` 时警告也算失败（与 pre-commit 一致） |

## 设计原则

1. **宁可漏，不误伤**：守卫任何内部异常都放行；标记系统不可用也放行。守卫失效的代价是少一次提醒，错误拦截的代价是正常干活被卡住。
2. **草稿优先**：随手记必须随手就能写，所以草稿区免读契约；规则成本推迟到「归位」时付。
3. **只读知识库**：插件不替用户写库；写库路径、模板、MOC 登记仍由知识库自己的契约与流程约束。
4. **零运行时依赖**：`lib/` 只用 Node 内置模块 + DSH 的 `dsh-llm` / `dsh-home-paths` / `schemastery`，不引入第三方包。
5. **内容不变不重复注入**：索引按渲染结果做 sha1 去重，只增不改前缀，不破坏 KV cache 复用。
6. **相对路径按全部候选会话目录检查**：会话的头字段 `cwd` 在 `working_directory` 切换后不会更新，所以相对路径会分别对「头字段 cwd / `workingDirectory` 投影 / 进程目录」解析，**任一**落入正式目录即拒绝；判不准时偏向拦截（读一次契约即可恢复）。

## 已知限制

- **shell 识别是启发式**：认明确的写盘动词（`Set-Content`、`Copy-Item`、`rm`、`robocopy`、`xcopy` 等）、真正写文件的重定向，以及会改写工作树的 `git` 子命令（`checkout/restore/reset/clean/rm/mv/revert/cherry-pick/am/switch/apply/stash`，`git apply --check` 与 `stash list|show` 除外；`git -C '<路径>'` 这种带引号写法也能识别）。引号内字面量、`2>&1`、`/dev/null`、`NUL` 不算写；先 `cd` 进库再写相对路径这类无法可靠抽取落点的形态会**漏判**。
- **守卫是减速带，不是沙箱**：解释器内写盘（`python -c "open(...).write()"`、`node -e ...`）原理上无法通过命令行识别，必被放行。真正的边界是知识库自己的契约与提交质检。
- **只认 `read` 工具读契约**：`pwsh cat CLAUDE.md` 不触发标记（避免做 shell 语法分析）。
- **索引是概览**：不含笔记正文；查库仍应走知识库自己的检索协议（本插件只给指针）。
- **子 agent 不注入索引**，但守卫对子 agent 同样生效。
- 依赖 `session.snapshotEvents()` 做恢复去重；该 API 上游已标记弃用，DSH 0.3 前需要复查。

## 开发

```bash
node --test          # 58 个单测：路径 / shell 启发式（含 git、robocopy）/ 守卫决策（相对路径 + 多候选目录）/ 配置校验 / 渲染预算 / 扫描 / check.py 解析 / 标记 TTL
```

`lib/` 里除 `index.js` 外都是纯逻辑模块（只依赖 `node:*`），可以不启动 DSH 直接单测。对真实 vault 冒烟：

```bash
node -e "import('./lib/scan.js').then(async m => { const x = await m.scanVault({ vaultRoot: process.argv[1], draftDir: '笔记', includeGitInfo: true }); console.log(x.devices.length, x.domains.length, x.experience, x.modules, x.drafts.count, x.git); })" "D:\\knowledge_base\\knowledge_base"
```

结构与不变量见 [AGENTS.md](AGENTS.md)。

## 许可

[MIT](LICENSE)
