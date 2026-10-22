/**
 * Run and parse the vault's own structure checker (`知识库规则/check.py`).
 *
 * The plugin never re-implements the rules: it runs the checker the vault
 * already owns and turns its emoji-sectioned report into counts plus the first
 * few issue lines, so the model gets a short, structured answer instead of a
 * 100-line console dump.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Section headers emitted by check.py, e.g. `❌ 失败 (2):`. */
const SECTION_RE = /^(❌|⚠️|📋|ℹ️)\s*(失败|警告|提示|跳过)\s*\((\d+)\)/;
const SCANNED_RE = /扫描文件:\s*(\d+)/;
const MAX_DETAIL_LINES = 12;

/**
 * Parse one check.py report.
 * @param {string} stdout - captured stdout.
 * @param {string} [stderr] - captured stderr.
 * @returns {object} parsed counts and details.
 */
export function parseCheckOutput(stdout, stderr = "") {
	const lines = `${stdout ?? ""}\n${stderr ?? ""}`.split(/\r?\n/);
	const counts = { errors: 0, warnings: 0, notices: 0, skipped: 0 };
	const details = { errorLines: [], warningLines: [], noticeLines: [] };
	let scanned = 0;
	let section = "";

	for (const raw of lines) {
		const line = raw.replace(/\u001b\[[0-9;]*m/g, "");
		const scannedMatch = SCANNED_RE.exec(line);
		if (scannedMatch !== null) scanned = Number(scannedMatch[1]);
		const sectionMatch = SECTION_RE.exec(line.trim());
		if (sectionMatch !== null) {
			section = sectionMatch[2];
			const count = Number(sectionMatch[3]);
			if (section === "失败") counts.errors = count;
			else if (section === "警告") counts.warnings = count;
			else if (section === "提示") counts.notices = count;
			else if (section === "跳过") counts.skipped = count;
			continue;
		}
		if (section.length === 0 || !/^\s{2,}\S/.test(line) || line.includes("====")) continue;
		const bucket =
			section === "失败" ? details.errorLines : section === "警告" ? details.warningLines : section === "提示" ? details.noticeLines : undefined;
		if (bucket !== undefined && bucket.length < MAX_DETAIL_LINES) bucket.push(line.trim());
	}

	return { scanned, ...counts, ...details, passed: /✅ 全部通过/.test(stdout ?? "") };
}

/**
 * Run the checker.
 * @param {object} options - run options.
 * @param {string} options.pythonPath - Python interpreter.
 * @param {string} options.scriptPath - absolute `check.py` path.
 * @param {string} [options.cwd] - working directory (the vault root).
 * @param {boolean} [options.strict] - pass `--strict` (warnings block too).
 * @param {number} [options.timeoutMs] - hard timeout.
 * @returns {Promise<object>} structured result, always with `ok`.
 */
export async function runCheck({ pythonPath, scriptPath, cwd, strict = false, timeoutMs = 60000 }) {
	const args = strict ? [scriptPath, "--strict"] : [scriptPath];
	let stdout = "";
	let stderr = "";
	let exitCode = 0;
	try {
		const out = await execFileAsync(pythonPath, args, {
			cwd,
			timeout: timeoutMs,
			maxBuffer: 8 * 1024 * 1024,
			windowsHide: true
		});
		stdout = out.stdout ?? "";
		stderr = out.stderr ?? "";
	} catch (error) {
		if (error === null || typeof error !== "object" || typeof error.code !== "number") {
			return {
				ok: false,
				failure: `无法运行 check.py（${pythonPath}）：${error instanceof Error ? error.message : String(error)}`,
				exitCode: undefined
			};
		}
		exitCode = error.code;
		stdout = typeof error.stdout === "string" ? error.stdout : "";
		stderr = typeof error.stderr === "string" ? error.stderr : "";
	}

	const parsed = parseCheckOutput(stdout, stderr);
	const ok = exitCode === 0 && parsed.errors === 0 && (!strict || parsed.warnings === 0);
	return { ok, exitCode, ...parsed };
}

/**
 * Render one check result as short model-facing text.
 * @param {object} result - `runCheck` result.
 * @returns {string} report text.
 */
export function formatCheckResult(result) {
	if (typeof result.failure === "string") return result.failure;
	const head = `check.py：扫描 ${result.scanned} 个 md，❌ ${result.errors} / ⚠️ ${result.warnings} / 📋 ${result.notices}（跳过草稿 ${result.skipped}）`;
	const verdict = result.ok ? "结论：通过" : "结论：未通过（❌ 必修；⚠️ 凭据类必修；📋 不阻断）";
	const blocks = [head, verdict];
	if (result.errorLines.length > 0) blocks.push("失败项：", ...result.errorLines.map((line) => `  ${line}`));
	if (result.warningLines.length > 0) blocks.push("警告项：", ...result.warningLines.map((line) => `  ${line}`));
	if (result.noticeLines.length > 0) blocks.push("提示项：", ...result.noticeLines.slice(0, 6).map((line) => `  ${line}`));
	return blocks.join("\n");
}
