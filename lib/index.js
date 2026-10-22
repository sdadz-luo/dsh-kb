/**
 * dsh-kb: personal knowledge-base integration for DeepSeek Harness.
 *
 * One host-plane Cordis plugin covering four surfaces that previously needed
 * out-of-band glue (a Python generator plus git hooks, with no write guard):
 *
 *  - `agent/pre-step` injects a live `<kb-context>` index (devices, domains,
 *    counts, drafts, last commit), replacing `refresh-kb-index.py` and the KB
 *    repository's `post-commit` hook;
 *  - `ctx.tools.guard()` refuses vault writes (write/edit, and shell
 *    redirections) until the session has read the vault contract, replacing
 *    the Claude Code `kb-contract-guard.py` hook with a hard, monotonic gate;
 *  - `tools/result` records that contract read per session;
 *  - `ctx.commands.register()` / `ctx.tools.register()` expose `/kb`
 *    (status | check | refresh | contract) and the `kb_status` / `kb_check`
 *    tools.
 *
 * @module dsh-kb
 */
import { boundContextSummary, createUserMessage } from "@deepseek-ai/dsh-llm";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import z from "@deepseek-ai/schemastery";
import { join, resolve } from "node:path";

import { formatCheckResult, runCheck } from "./check.js";
import { cleanVaultRelative } from "./config.js";
import { decideGuard } from "./guard.js";
import { ContractMarkers } from "./markers.js";
import { isInside, samePath } from "./paths.js";
import { renderContext } from "./render.js";
import { scanVault } from "./scan.js";

/** Stable Cordis provider name. */
const name = "dsh-kb";
/** Services this plugin cannot run without. */
const inject = ["tools"];
/** Producer-owned source kind required by Session format V4. */
const SOURCE_KIND = `plugin:${name}`;

const DEFAULT_DRAFT_DIR = "笔记";
const DEFAULT_CONTRACT_FILE = "CLAUDE.md";
const DEFAULT_PROTOCOL_FILE = "知识库规则/检索协议.md";
const DEFAULT_MAINTENANCE_FILE = "知识库规则/维护细则.md";
const DEFAULT_CHECK_SCRIPT = "知识库规则/check.py";
const DEFAULT_MAX_BYTES = 6144;
const DEFAULT_REFRESH_INTERVAL_MS = 15000;
const DEFAULT_CHECK_TIMEOUT_MS = 60000;
/** Bounded retries for the per-agent MCP write-tool restriction. */
const HIDDEN_TOOL_RESTRICT_ATTEMPTS = 3;
/** MCP tool-name suffixes that write (or move) knowledge-base notes. */
const MCP_WRITE_SUFFIX_RE = /(write|edit|delete|move|create|append|replace|update)/i;

const Config = z.object({
	vaultRoot: z.string().default(""),
	injectContext: z.boolean().default(true),
	guardWrites: z.boolean().default(true),
	guardShell: z.boolean().default(true),
	hideMcpWriteTools: z.boolean().default(false),
	includeSubagents: z.boolean().default(false),
	includeGitInfo: z.boolean().default(true),
	dshHome: z.string(),
	contractFile: z.string().default(DEFAULT_CONTRACT_FILE),
	draftDir: z.string().default(DEFAULT_DRAFT_DIR),
	protocolFile: z.string().default(DEFAULT_PROTOCOL_FILE),
	maintenanceFile: z.string().default(DEFAULT_MAINTENANCE_FILE),
	checkScript: z.string().default(DEFAULT_CHECK_SCRIPT),
	pythonPath: z.string().default("python"),
	mcpServerName: z.string().default("basic-memory"),
	maxBytes: z.number().default(DEFAULT_MAX_BYTES),
	refreshIntervalMs: z.number().default(DEFAULT_REFRESH_INTERVAL_MS),
	checkTimeoutMs: z.number().default(DEFAULT_CHECK_TIMEOUT_MS)
});

/**
 * Register every surface. The plugin stays inert (one warning) until
 * `vaultRoot` points at a vault.
 * @param {object} ctx - Cordis context (host plane).
 * @param {object} [config] - plugin configuration.
 */
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	if (resolved.vaultRoot.length === 0) {
		ctx.logger.warn("dsh-kb: config.vaultRoot is empty — the plugin stays inert until it points at a vault");
		return;
	}
	const state = new KbState(ctx, resolved);
	// Each surface registers independently: one failing registration must not
	// silently take the remaining ones down with it (a half-alive plugin is
	// harder to diagnose than a loud one), so every step is isolated and the
	// capability flags surface the result through `/kb status`.
	const surfaces = [
		["contract-read observer", () => registerResultObserver(ctx, state)],
		["write guard", () => registerGuard(ctx, state)],
		["index injection", () => registerPreStep(ctx, state)],
		["/kb command", () => registerCommands(ctx, state)],
		["kb_status / kb_check tools", () => registerTools(ctx, state)]
	];
	for (const [label, register] of surfaces) {
		try {
			register();
		} catch (error) {
			ctx.logger.error(`dsh-kb: failed to register ${label}: ${errorMessage(error)}`);
		}
	}
}

/** Normalize plugin configuration. */
function resolveConfig(config) {
	const vaultRoot = typeof config.vaultRoot === "string" && config.vaultRoot.trim().length > 0 ? resolve(config.vaultRoot.trim()) : "";
	return {
		vaultRoot,
		dshHome: resolveDshHome(config.dshHome),
		injectContext: config.injectContext ?? true,
		guardWrites: config.guardWrites ?? true,
		guardShell: config.guardShell ?? true,
		hideMcpWriteTools: config.hideMcpWriteTools ?? false,
		includeSubagents: config.includeSubagents ?? false,
		includeGitInfo: config.includeGitInfo ?? true,
		contractFile: cleanVaultRelative(config.contractFile ?? DEFAULT_CONTRACT_FILE, "contractFile"),
		draftDir: cleanVaultRelative(config.draftDir ?? DEFAULT_DRAFT_DIR, "draftDir"),
		protocolFile: cleanVaultRelative(config.protocolFile ?? DEFAULT_PROTOCOL_FILE, "protocolFile"),
		maintenanceFile: cleanVaultRelative(config.maintenanceFile ?? DEFAULT_MAINTENANCE_FILE, "maintenanceFile"),
		checkScript: cleanVaultRelative(config.checkScript ?? DEFAULT_CHECK_SCRIPT, "checkScript"),
		pythonPath: typeof config.pythonPath === "string" && config.pythonPath.trim().length > 0 ? config.pythonPath.trim() : "python",
		mcpServerName: typeof config.mcpServerName === "string" && config.mcpServerName.trim().length > 0 ? config.mcpServerName.trim() : "basic-memory",
		maxBytes: Number.isFinite(config.maxBytes) && config.maxBytes > 0 ? config.maxBytes : DEFAULT_MAX_BYTES,
		refreshIntervalMs: Number.isFinite(config.refreshIntervalMs) && config.refreshIntervalMs > 0 ? config.refreshIntervalMs : DEFAULT_REFRESH_INTERVAL_MS,
		checkTimeoutMs: Number.isFinite(config.checkTimeoutMs) && config.checkTimeoutMs > 0 ? config.checkTimeoutMs : DEFAULT_CHECK_TIMEOUT_MS
	};
}

/** Per-process state: scan cache, per-session index text, markers, hidden tools. */
class KbState {
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
		this.markers = new ContractMarkers({ dir: join(config.dshHome, "kb-contract") });
		this.cachedModel = undefined;
		this.cachedAt = 0;
		this.dirty = true;
		/** sessionId -> last injected text (`null` = nothing injected yet). */
		this.lastText = new Map();
		/** sessionId -> `true` once the MCP write-tool restriction was applied. */
		this.hiddenApplied = new Set();
		/** sessionId -> failed restriction attempts (bounded retry instead of a warn per step). */
		this.hiddenFailures = new Map();
		/** Which optional surfaces actually registered; reported by `/kb status`. */
		this.capabilities = { commands: false, tools: false };
	}

	contractPath() {
		return join(this.config.vaultRoot, this.config.contractFile);
	}

	maintenancePath() {
		return join(this.config.vaultRoot, this.config.maintenanceFile);
	}

	checkScriptPath() {
		return join(this.config.vaultRoot, this.config.checkScript);
	}

	/** Resolved guard configuration handed to the pure decision function. */
	guardConfig() {
		return {
			enabled: this.config.guardWrites,
			guardShell: this.config.guardShell,
			vaultRoot: this.config.vaultRoot,
			draftDir: this.config.draftDir,
			contractPath: this.contractPath(),
			maintenancePath: this.maintenancePath()
		};
	}

	/** Mark the cached scan stale (filesystem activity inside the vault). */
	markDirty(displayPath) {
		if (isInside(this.config.vaultRoot, displayPath)) this.dirty = true;
	}

	/** Force the next step to re-inject the index and rescan. */
	invalidate(sessionId) {
		this.dirty = true;
		if (typeof sessionId === "string") this.lastText.set(sessionId, null);
	}

	/**
	 * Scan through a short cache window so per-step checks stay cheap.
	 * @param {AbortSignal} [signal] - turn cancellation.
	 * @returns {Promise<object>} scan model.
	 */
	async modelFor(signal) {
		signal?.throwIfAborted();
		const now = Date.now();
		if (!this.dirty && this.cachedModel !== undefined && now - this.cachedAt < this.config.refreshIntervalMs) return this.cachedModel;
		const model = await scanVault({ vaultRoot: this.config.vaultRoot, draftDir: this.config.draftDir, includeGitInfo: this.config.includeGitInfo });
		signal?.throwIfAborted();
		this.cachedModel = model;
		this.cachedAt = now;
		this.dirty = false;
		return model;
	}

	/**
	 * Compose the index message for one agent's next step.
	 * @param {object} agent - agent about to step.
	 * @param {AbortSignal} [signal] - turn cancellation.
	 * @returns {Promise<object | undefined>} message to inject, or undefined when unchanged.
	 */
	async compose(agent, signal) {
		const session = agent.session;
		const sessionId = session.id;
		if (!this.lastText.has(sessionId)) this.seedFromSession(session);
		const model = await this.modelFor(signal);
		const rendered = renderContext(model, { maxBytes: this.config.maxBytes });
		const previous = this.lastText.get(sessionId);
		if (previous === rendered.text) return undefined;
		this.lastText.set(sessionId, rendered.text);
		return kbMessage(rendered.text, summaryOf(model));
	}

	/** Restore the last injected index text from a resumed session log. */
	seedFromSession(session) {
		let events = [];
		try {
			events = session.snapshotEvents();
		} catch {
			events = [];
		}
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== "user/message") continue;
			if (event.data?.source?.kind !== SOURCE_KIND) continue;
			const content = Array.isArray(event.data.content) ? event.data.content : [];
			const [block] = content;
			if (content.length === 1 && block?.type === "text" && typeof block.text === "string") {
				this.lastText.set(session.id, block.text);
				return;
			}
			break;
		}
		this.lastText.set(session.id, null);
	}

	/** Drop per-session state when the agent goes away. */
	disposeSession(session) {
		const sessionId = session?.id;
		if (typeof sessionId !== "string") return;
		this.lastText.delete(sessionId);
		this.hiddenApplied.delete(sessionId);
		this.hiddenFailures.delete(sessionId);
	}

	/**
	 * Hide MCP write tools from one agent (contract rule: writes go through md
	 * files, never through basic-memory write tools). Applied lazily at a step
	 * boundary so the MCP server has finished registering its tools.
	 *
	 * Failures are retried a bounded number of times: the usual cause is MCP
	 * tool discovery racing the first step, which fixes itself, but a permanent
	 * failure must not log once per step for the rest of the session.
	 * @param {object} agent - live agent.
	 */
	applyHiddenTools(agent) {
		const sessionId = agent.session?.id;
		if (typeof sessionId !== "string" || this.hiddenApplied.has(sessionId)) return;
		if ((this.hiddenFailures.get(sessionId) ?? 0) >= HIDDEN_TOOL_RESTRICT_ATTEMPTS) return;
		let known;
		try {
			known = this.ctx.tools.schemas(agent).map((schema) => schema.name);
		} catch {
			return;
		}
		const prefix = `mcp__${this.config.mcpServerName}__`;
		const deny = known.filter((toolName) => toolName.startsWith(prefix) && MCP_WRITE_SUFFIX_RE.test(toolName.slice(prefix.length)));
		if (deny.length === 0) return;
		try {
			agent.ctx.tools.restrict({ deny });
			this.hiddenApplied.add(sessionId);
			this.ctx.logger.info(`dsh-kb: hid MCP write tools for this agent: ${deny.join(", ")}`);
		} catch (error) {
			const attempts = (this.hiddenFailures.get(sessionId) ?? 0) + 1;
			this.hiddenFailures.set(sessionId, attempts);
			if (attempts === 1 || attempts === HIDDEN_TOOL_RESTRICT_ATTEMPTS) {
				this.ctx.logger.warn(`dsh-kb: could not hide MCP write tools (attempt ${attempts}/${HIDDEN_TOOL_RESTRICT_ATTEMPTS}): ${errorMessage(error)}`);
			}
		}
	}

	/**
	 * Human/model-facing status text.
	 * @param {string} [sessionId] - session for the contract-read flag.
	 * @returns {Promise<string>} status text.
	 */
	async statusText(sessionId) {
		const model = await this.modelFor();
		const domainTotal = model.domains.reduce((sum, domain) => sum + domain.count, 0);
		const lines = [
			`知识库状态（库根 ${model.vaultRoot}）`,
			`- 设备 ${model.devices.length} 个：${model.devices.map((device) => `${device.name}(${device.updated})`).join("、") || "无"}`,
			`- 知识域 ${model.domains.length} 个 / 共 ${domainTotal} 篇：${model.domains.map((domain) => `${domain.name} ${domain.count}`).join("、") || "无"}`,
			`- 经验 ${model.experience.count} 篇（最近 ${model.experience.latest}）/ 模块 ${model.modules.count} 篇（最近 ${model.modules.latest}）`,
			`- 待整理 ${model.drafts.count} 篇${model.drafts.names.length > 0 ? `：${model.drafts.names.join("、")}` : ""}`
		];
		if (model.git !== null) {
			lines.push(`- 最近提交 ${model.git.hash} · ${model.git.date} · ${model.git.subject}${model.git.dirtyCount > 0 ? `（未提交 ${model.git.dirtyCount} 个文件）` : ""}`);
		}
		lines.push(`- 本会话已读契约：${typeof sessionId === "string" && this.markers.has(sessionId) ? "是" : "否"}`);
		const hiddenState = this.config.hideMcpWriteTools ? (this.hiddenApplied.size > 0 ? "已应用" : "待应用") : "未启用";
		lines.push(
			`- 能力自检：/kb 命令 ${this.capabilities.commands ? "已注册" : "未注册"}｜kb_status/kb_check ${this.capabilities.tools ? "已注册" : "未注册"}｜MCP 写工具隐藏 ${hiddenState}`
		);
		lines.push(`- 扫描时间 ${new Date(model.scannedAt).toLocaleTimeString("zh-CN", { hour12: false })}（缓存 ${Math.round(this.config.refreshIntervalMs / 1000)}s）`);
		if (model.errors.length > 0) lines.push(`- 扫描告警：${model.errors.join("；")}`);
		return lines.join("\n");
	}

	/**
	 * Run the vault's own checker and format the result.
	 * @param {boolean} [strict] - treat warnings as failures.
	 * @returns {Promise<string>} report text.
	 */
	async checkText(strict = false) {
		const result = await runCheck({
			pythonPath: this.config.pythonPath,
			scriptPath: this.checkScriptPath(),
			cwd: this.config.vaultRoot,
			strict,
			timeoutMs: this.config.checkTimeoutMs
		});
		return formatCheckResult(result);
	}
}

/** Whether one session belongs to a subagent (those skip index injection). */
function isSubagent(session) {
	const header = session?.header ?? {};
	return header.origin === "subagent" || (header.delegationDepth ?? 0) > 0;
}

/** Session working directory for shell-call defaults. */
function sessionCwd(session) {
	const recorded = session?.header?.cwd;
	return typeof recorded === "string" && recorded.length > 0 ? recorded : process.cwd();
}

/** Build the user-role message carrying one index snapshot. */
function kbMessage(text, summary) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: {
			kind: SOURCE_KIND,
			form: "notice",
			summary: boundContextSummary(summary)
		}
	});
}

/** One-line account of the index contents. */
function summaryOf(model) {
	const domainTotal = model.domains.reduce((sum, domain) => sum + domain.count, 0);
	return `KB index: ${model.devices.length} 设备 / ${model.domains.length} 域 ${domainTotal} 篇 / 待整理 ${model.drafts.count}`;
}

/** Whether an entering message already is our snapshot with the same text. */
function sameKbMessage(message, desired) {
	if (message?.source?.kind !== SOURCE_KIND) return false;
	const [block] = message.content ?? [];
	const [desiredBlock] = desired.content;
	return block?.type === "text" && desiredBlock?.type === "text" && block.text === desiredBlock.text;
}

/** Record a successful contract read as this session's marker. */
function registerResultObserver(ctx, state) {
	ctx.on("tools/result", (exec, result) => {
		try {
			if (result?.isError === true) return;
			if (exec?.name !== "read") return;
			const filePath = exec.arguments?.file_path;
			if (typeof filePath !== "string" || !samePath(filePath, state.contractPath())) return;
			const sessionId = exec.agent?.session?.id;
			if (typeof sessionId !== "string") return;
			state.markers.mark(sessionId, state.contractPath());
		} catch (error) {
			ctx.logger.warn(`dsh-kb: contract-read marker failed: ${errorMessage(error)}`);
		}
	});
}

/** Install the monotonic write guard. */
function registerGuard(ctx, state) {
	ctx.effect(() =>
		ctx.tools.guard((exec) => {
			try {
				const session = exec.agent?.session;
				const sessionId = session?.id;
				if (typeof sessionId !== "string") return undefined;
				const decision = decideGuard({
					toolName: exec.name,
					args: exec.arguments,
					guard: state.guardConfig(),
					hasMarker: state.markers.has(sessionId),
					markerUsable: state.markers.usable(),
					defaultDirectory: sessionCwd(session)
				});
				return decision.action === "deny" ? decision.reason : undefined;
			} catch (error) {
				// Fail open: a broken guard must never block ordinary work.
				ctx.logger.warn(`dsh-kb: write guard failed open: ${errorMessage(error)}`);
				return undefined;
			}
		})
	);
}

/** Install the pre-step index injection and per-agent tool restrictions. */
function registerPreStep(ctx, state) {
	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const decision = await next();
		if (decision.kind !== "enter" || agent === undefined) return decision;
		try {
			if (state.config.hideMcpWriteTools) state.applyHiddenTools(agent);
			if (!state.config.injectContext) return decision;
			if (!state.config.includeSubagents && isSubagent(agent.session)) return decision;
			const desired = await state.compose(agent, signal);
			if (desired === undefined) return decision;
			if (decision.messages.some((message) => sameKbMessage(message, desired))) return decision;
			const lastClaimed = decision.messages.findLastIndex((message) => messages.includes(message));
			return { kind: "enter", messages: decision.messages.toSpliced(lastClaimed + 1, 0, desired) };
		} catch (error) {
			if (signal?.aborted === true) throw error;
			ctx.logger.warn(`dsh-kb: index injection failed: ${errorMessage(error)}`);
			return decision;
		}
	});
	ctx.on("agent/disposed", ({ agent }) => {
		state.disposeSession(agent?.session);
	});
	ctx.on("fs/observed", (target, observation) => {
		if (observation === undefined || observation.kind === "absent") return;
		const displayPath = target?.displayPath;
		if (typeof displayPath === "string") state.markDirty(displayPath);
	});
}

/** Register the `/kb` command when the host provides a command surface. */
function registerCommands(ctx, state) {
	const commands = ctx.get("commands");
	if (commands === undefined) return;
	ctx.effect(function* () {
		const disposer = commands.register({
			name: "kb",
			description: "知识库：状态 / 结构校验 / 刷新索引上下文",
			input: { hint: "status | check | refresh | contract | forget" },
			handler: (invocation) => handleKbCommand(ctx, state, invocation)
		});
		state.capabilities.commands = true;
		yield disposer;
	});
}

/** Dispatch one `/kb <sub>` invocation. */
async function handleKbCommand(ctx, state, invocation) {
	const sub = String(invocation?.rawInput ?? "").trim().toLowerCase();
	const sessionId = invocation?.agent?.session?.id;
	try {
		if (sub === "" || sub === "status") return { kind: "success", text: await state.statusText(sessionId) };
		if (sub === "check") return { kind: "success", text: await state.checkText(false) };
		if (sub === "refresh") {
			state.invalidate(sessionId);
			return { kind: "success", text: "已清空索引缓存，下一步会重新扫描并注入当前知识库索引。" };
		}
		if (sub === "contract") {
			const read = typeof sessionId === "string" && state.markers.has(sessionId);
			return {
				kind: "success",
				text: [`契约路径：${state.contractPath()}`, `本会话已读：${read ? "是" : "否"}`, `草稿区（免读）：${join(state.config.vaultRoot, state.config.draftDir)}`].join("\n")
			};
		}
		if (sub === "forget") {
			if (typeof sessionId === "string") state.markers.forget(sessionId);
			return { kind: "success", text: "已清除本会话的\"已读契约\"标记，下次写库会重新要求先读契约。" };
		}
		return { kind: "error", text: `未知子命令 "${sub}"；可用：status | check | refresh | contract | forget` };
	} catch (error) {
		ctx.logger.warn(`dsh-kb: /kb ${sub} failed: ${errorMessage(error)}`);
		return { kind: "error", text: `执行 /kb ${sub} 失败：${errorMessage(error)}` };
	}
}

/** Register the model-facing tools. */
function registerTools(ctx, state) {
	ctx.effect(function* () {
		const statusDisposer = ctx.tools.register({
			name: "kb_status",
			description:
				"读取个人知识库（唯一事实源）的实时状态：设备档案、知识域篇数与最近更新、经验/模块计数、笔记待整理草稿、最近提交。查库或写库前先调它，避免多次 Read/Glob。",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
			async execute(_args, exec) {
				return await state.statusText(exec?.agent?.session?.id);
			}
		});
		const checkDisposer = ctx.tools.register({
			name: "kb_check",
			description: "运行知识库自带的结构校验（知识库规则/check.py），返回扫描数、失败/警告/提示计数与前几条明细。写库提交前用它确认没有阻断项。",
			parameters: {
				type: "object",
				properties: {
					strict: { type: "boolean", description: "true 时警告也视为失败（与 pre-commit 一致）" }
				},
				additionalProperties: false
			},
			output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
			async execute(args) {
				return await state.checkText(args?.strict === true);
			}
		});
		state.capabilities.tools = true;
		yield statusDisposer;
		yield checkDisposer;
	});
}

function errorMessage(error) {
	try {
		return String(error);
	} catch {
		return "[unrenderable thrown value]";
	}
}

export { Config, apply, inject, name };
