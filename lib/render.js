/**
 * Render the injected `<kb-context>` block from one scan model.
 *
 * The block is deliberately an index, not the KB itself: counts, recency, and
 * one pointer per workflow. Progressive detail (`detail` → no subdirectories →
 * no git line → truncate) keeps it inside the byte budget without ever
 * exceeding it.
 */
import { createHash } from "node:crypto";

/** SHA-1 of the rendered text; the injection dedupe key. */
export function digestOf(text) {
	return createHash("sha1").update(text, "utf8").digest("hex");
}

/** UTF-8 byte length of one string. */
export function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

function deviceLines(model) {
	if (model.devices.length === 0) return ["- （无设备档案）"];
	return model.devices.map((device) => `- ${device.name}（更新 ${device.updated}）`);
}

function domainLines(model, detail) {
	if (model.domains.length === 0) return ["- （无知识域）"];
	return model.domains.map((domain) => {
		const subdirs = detail && domain.subdirs.length > 0 ? `：${domain.subdirs.map((sub) => `${sub.path}（${sub.count}篇）`).join("、")}` : "";
		return `- ${domain.name}（${domain.count} 篇${subdirs}；最近 ${domain.latest}）`;
	});
}

function tailLines(model, includeGit) {
	const lines = [
		`- 经验 ${model.experience.count} 篇（最近 ${model.experience.latest}）`,
		`- 模块 ${model.modules.count} 篇（最近 ${model.modules.latest}）`,
		`- 笔记/ 待整理 ${model.drafts.count} 篇${model.drafts.names.length > 0 ? `：${model.drafts.names.slice(0, 8).join("、")}${model.drafts.names.length > 8 ? " …" : ""}` : ""}`
	];
	if (includeGit && model.git !== null) {
		const dirty = model.git.dirtyCount > 0 ? `；未提交 ${model.git.dirtyCount} 个文件` : "";
		lines.push(`- 最近提交 ${model.git.hash} · ${model.git.date} · ${model.git.subject}${dirty}`);
	}
	return lines;
}

/**
 * Build one full render at a given detail level.
 * @param {object} model - scan model.
 * @param {object} options - render options.
 * @param {boolean} options.detail - include subdirectory distribution.
 * @param {boolean} options.git - include the git summary line.
 * @returns {string} rendered block.
 */
export function buildContext(model, { detail = true, git = true } = {}) {
	const lines = [
		"<kb-context>",
		`知识库索引（dsh-kb 自动生成；仅当内容变化时重发）。库根 ${model.vaultRoot}（唯一事实源，以 .md 为准）。`,
		"",
		"## 设备档案",
		...deviceLines(model),
		"",
		"## 知识域",
		...domainLines(model, detail),
		"",
		"## 经验 / 模块 / 待整理",
		...tailLines(model, git),
		"",
		"## 用法",
		"- 查库：按 知识库规则/检索协议.md，优先 basic-memory MCP（mcp__basic-memory__*）；不可用时降级 Grep / Glob / Read",
		"- 写库：先读库根 CLAUDE.md 契约（本插件会拦截未读契约的写入）；结构校验 知识库规则/check.py；随手记落 笔记/（免读契约）",
		"</kb-context>"
	];
	if (model.errors.length > 0) lines.splice(lines.length - 2, 0, `- 索引告警：${model.errors.join("；")}`);
	return lines.join("\n");
}

const TRUNCATION_FOOTER = "\n…（已截断）";

/** Longest prefix that fits a UTF-8 byte budget, trimmed back to a line boundary. */
function sliceToBytes(text, maxBytes) {
	let used = 0;
	let kept = "";
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (used + size > maxBytes) break;
		used += size;
		kept += char;
	}
	const newline = kept.lastIndexOf("\n");
	return newline > 0 ? kept.slice(0, newline) : kept;
}

/** Cut a text to a UTF-8 byte budget, preferring a line boundary. */
export function truncateToBytes(text, maxBytes) {
	if (byteLength(text) <= maxBytes) return text;
	const footerBytes = byteLength(TRUNCATION_FOOTER);
	const room = maxBytes - footerBytes;
	if (room <= 0) return sliceToBytes(text, Math.max(0, maxBytes));
	return `${sliceToBytes(text, room)}${TRUNCATION_FOOTER}`;
}

/**
 * Render within a byte budget by shedding detail, then truncating.
 * @param {object} model - scan model.
 * @param {object} options - render options.
 * @param {number} options.maxBytes - hard cap.
 * @returns {{text: string, digest: string, bytes: number, truncated: boolean}} rendered block.
 */
export function renderContext(model, { maxBytes = 6144 } = {}) {
	const levels = [
		{ detail: true, git: true },
		{ detail: false, git: true },
		{ detail: false, git: false }
	];
	for (const level of levels) {
		const text = buildContext(model, level);
		if (byteLength(text) <= maxBytes) return { text, digest: digestOf(text), bytes: byteLength(text), truncated: false };
	}
	const text = truncateToBytes(buildContext(model, levels.at(-1)), maxBytes);
	return { text, digest: digestOf(text), bytes: byteLength(text), truncated: true };
}
