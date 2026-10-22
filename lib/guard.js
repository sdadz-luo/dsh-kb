/**
 * Pure write-guard decision shared by the tool guard and its unit tests.
 *
 * The guard mirrors the Claude Code `kb-contract-guard` contract: writing the
 * vault requires that the current session already read the vault contract, the
 * draft directory is exempt, and an unusable marker store degrades to "allow"
 * so a broken marker system can never deadlock every write.
 */
import { isAbsolute, join } from "node:path";
import { isInside } from "./paths.js";
import { analyzeShellWrite } from "./shell.js";

/** Tools that write one file by path. */
export const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
/** Tools that run a shell command line. */
export const SHELL_TOOLS = new Set(["bash", "pwsh", "shell", "terminal", "exec", "run_command"]);

const ALLOW = Object.freeze({ action: "allow" });

/**
 * Extract the target file path from a write-like tool call.
 * @param {unknown} args - tool arguments.
 * @returns {string | undefined} path when present.
 */
export function filePathArgument(args) {
	if (args === null || typeof args !== "object") return undefined;
	for (const key of ["file_path", "filePath", "path"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}

/**
 * Extract the command line and working directory from a shell tool call.
 * @param {unknown} args - tool arguments.
 * @returns {{command?: string, workdir?: string}} shell call parts.
 */
export function shellArguments(args) {
	if (args === null || typeof args !== "object") return {};
	const command = typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
	const workdir = ["workdir", "cwd", "working_directory", "workingDirectory"]
		.map((key) => args[key])
		.find((value) => typeof value === "string" && value.trim().length > 0);
	return { command, workdir: typeof workdir === "string" ? workdir.trim() : undefined };
}

/**
 * Resolve a tool-supplied path against the session directory.
 *
 * DSH resolves relative tool paths against the session working directory, so a
 * guard that only calls `isInside` would miss `write {"file_path":"知识/a.md"}`
 * whenever the session lives inside the vault. Non-string input stays
 * undefined; an absent base falls back to the process directory (the previous
 * behaviour, kept so the guard never throws on odd input).
 * @param {unknown} value - path from tool arguments.
 * @param {unknown} baseDirectory - session working directory.
 * @returns {string | undefined} absolute path for containment checks.
 */
export function resolveForCheck(value, baseDirectory) {
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	const trimmed = value.trim();
	if (isAbsolute(trimmed)) return trimmed;
	const base = typeof baseDirectory === "string" && baseDirectory.length > 0 ? baseDirectory : process.cwd();
	return join(base, trimmed);
}

/**
 * Build the denial text handed back to the model as the tool error.
 * @param {object} input - denial context.
 * @param {string} input.target - what the call tried to write.
 * @param {boolean} input.viaShell - whether the call was a shell command.
 * @param {object} input.guard - resolved guard configuration.
 * @returns {string} actionable denial reason.
 */
export function denyReason({ target, viaShell, guard }) {
	const via = viaShell ? "（经 shell 写入）" : "";
	return [
		`写知识库前必须先读库根契约，本次写入已被拒绝${via}。目标：${target}`,
		`请先执行：read "${guard.contractPath}"`,
		`完整写库还须读 ${guard.maintenancePath}；新建笔记时读对应类型模板。读完这篇契约后重试本次写入。`,
		`草稿区 ${guard.draftDir}/ 免读契约；库外路径不受影响。`
	].join("\n");
}

/**
 * Decide one tool call.
 *
 * @param {object} input - decision input.
 * @param {string} input.toolName - tool name being executed.
 * @param {unknown} input.args - frozen tool arguments.
 * @param {object} input.guard - resolved guard configuration.
 * @param {boolean} input.hasMarker - whether this session already read the contract.
 * @param {boolean} input.markerUsable - whether the marker store is writable.
 * @param {string} [input.defaultDirectory] - session working directory used to
 *   resolve relative tool paths and the shell workdir.
 * @returns {{action: "allow"} | {action: "deny", reason: string, target: string, viaShell: boolean}} decision.
 */
export function decideGuard({ toolName, args, guard, hasMarker, markerUsable, defaultDirectory }) {
	if (guard.enabled !== true) return ALLOW;
	if (hasMarker === true) return ALLOW;
	if (markerUsable === false) return ALLOW;

	if (FILE_WRITE_TOOLS.has(toolName)) {
		const target = resolveForCheck(filePathArgument(args), defaultDirectory);
		if (target === undefined) return ALLOW;
		if (!isInside(guard.vaultRoot, target)) return ALLOW;
		if (guard.draftDir.length > 0 && isInside(join(guard.vaultRoot, guard.draftDir), target)) return ALLOW;
		return {
			action: "deny",
			target,
			viaShell: false,
			reason: denyReason({ target, viaShell: false, guard })
		};
	}

	if (guard.guardShell !== true || !SHELL_TOOLS.has(toolName)) return ALLOW;
	const { command, workdir } = shellArguments(args);
	if (command === undefined) return ALLOW;
	const analysis = analyzeShellWrite({
		command,
		workdir: resolveForCheck(workdir ?? defaultDirectory, defaultDirectory),
		vaultRoot: guard.vaultRoot,
		draftDir: guard.draftDir
	});
	if (!analysis.writesVault || analysis.onlyDraft) return ALLOW;
	const target = analysis.targets.length > 0 ? analysis.targets.join(", ") : "(shell 写入)";
	return {
		action: "deny",
		target,
		viaShell: true,
		reason: denyReason({ target, viaShell: true, guard })
	};
}
