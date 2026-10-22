/**
 * Vault scanner: the live replacement for `refresh-kb-index.py`.
 *
 * Reads only `.md` frontmatter heads and directory structure (never note
 * bodies), so a scan stays cheap enough to run on a short cache window. The
 * counting rules intentionally mirror the retired Python generator: skip
 * `MOC.md`, `_`-prefixed helpers, hidden directories, and the draft inbox's
 * own rule file.
 */
import { execFile } from "node:child_process";
import { open, readdir, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { promisify } from "node:util";
import { toPosix } from "./paths.js";

const execFileAsync = promisify(execFile);
const UPDATED_RE = /^updated:\s*(\S+)/m;
const HEAD_BYTES = 2048;
const INBOX_RULE_FILE = "整理规则.md";

/**
 * Read the head of one note and pull its `updated:` date.
 * @param {string} file - absolute note path.
 * @returns {Promise<string>} date, or "?" when absent.
 */
async function noteUpdated(file) {
	let handle;
	try {
		handle = await open(file, "r");
		const buffer = Buffer.alloc(HEAD_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
		const match = UPDATED_RE.exec(buffer.toString("utf8", 0, bytesRead));
		return match === null ? "?" : match[1].slice(0, 10);
	} catch {
		return "?";
	} finally {
		await handle?.close().catch(() => {});
	}
}

/** Latest of several `updated` dates, or "?". */
function latestOf(dates) {
	const known = dates.filter((date) => date !== "?");
	return known.length === 0 ? "?" : known.reduce((left, right) => (left > right ? left : right));
}

/**
 * List note files under a directory: recursive, `.md` only, skipping `MOC.md`,
 * `_`-prefixed helpers, and hidden directories.
 * @param {string} dir - absolute directory.
 * @returns {Promise<string[]>} note paths.
 */
export async function listNotes(dir) {
	const found = [];
	const walk = async (current) => {
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
			if (entry.name === "MOC.md" || entry.name.startsWith("_")) continue;
			found.push(full);
		}
	};
	await walk(dir);
	return found;
}

/** Summarize one flat section (经验 / 模块). */
async function flatSection(dir) {
	const notes = await listNotes(dir);
	return { count: notes.length, latest: latestOf(await Promise.all(notes.map(noteUpdated))) };
}

/** Device entries: `<vault>/设备/*.md`. */
async function deviceSection(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "MOC.md" && !entry.name.startsWith("_"))
		.map((entry) => join(dir, entry.name))
		.sort();
	return Promise.all(
		files.map(async (file) => ({
			name: basename(file, ".md"),
			updated: await noteUpdated(file)
		}))
	);
}

/** Knowledge domains: every `知识/<domain>/` that owns a `MOC.md`. */
async function domainSection(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const domains = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const domainDir = join(dir, entry.name);
		const mocPresent = await stat(join(domainDir, "MOC.md")).then(() => true, () => false);
		if (!mocPresent) continue;
		const notes = await listNotes(domainDir);
		const buckets = new Map();
		for (const note of notes) {
			const rel = toPosix(relative(domainDir, note));
			const slash = rel.lastIndexOf("/");
			if (slash <= 0) continue;
			const folder = rel.slice(0, slash + 1);
			buckets.set(folder, (buckets.get(folder) ?? 0) + 1);
		}
		domains.push({
			name: entry.name,
			count: notes.length,
			latest: latestOf(await Promise.all(notes.map(noteUpdated))),
			subdirs: [...buckets.entries()].sort(([left], [right]) => (left < right ? -1 : 1)).map(([path, count]) => ({ path, count }))
		});
	}
	return domains.sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** Drafts waiting in `<vault>/笔记/`. */
async function draftSection(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return { count: 0, names: [] };
	}
	const names = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== INBOX_RULE_FILE && !entry.name.startsWith("_"))
		.map((entry) => entry.name.slice(0, -3))
		.sort();
	return { count: names.length, names };
}

/**
 * Read `git log -1` plus the number of uncommitted files.
 * @param {string} vaultRoot - absolute vault root.
 * @returns {Promise<{hash: string, subject: string, date: string, dirtyCount: number} | null>} git summary.
 */
async function gitSection(vaultRoot) {
	try {
		const { stdout } = await execFileAsync(
			"git",
			["-C", vaultRoot, "log", "-1", "--format=%h%x1f%s%x1f%ad", "--date=short"],
			{ timeout: 5000, windowsHide: true }
		);
		const [hash, subject, date] = stdout.trim().split("\x1f");
		if (hash === undefined || hash.length === 0) return null;
		let dirtyCount = 0;
		try {
			const status = await execFileAsync("git", ["-C", vaultRoot, "status", "--porcelain"], { timeout: 5000, windowsHide: true });
			dirtyCount = status.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
		} catch {
			dirtyCount = 0;
		}
		return { hash, subject: subject ?? "", date: date ?? "?", dirtyCount };
	} catch {
		return null;
	}
}

/**
 * Scan the vault into the index model the renderer consumes.
 * @param {object} options - scan options.
 * @param {string} options.vaultRoot - absolute vault root.
 * @param {string} [options.draftDir] - draft directory name.
 * @param {boolean} [options.includeGitInfo] - read git summary.
 * @returns {Promise<object>} index model.
 */
export async function scanVault({ vaultRoot, draftDir = "笔记", includeGitInfo = true }) {
	const errors = [];
	const guard = async (label, run) => {
		try {
			return await run();
		} catch (error) {
			errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};

	const devices = (await guard("设备", () => deviceSection(join(vaultRoot, "设备")))) ?? [];
	const domains = (await guard("知识", () => domainSection(join(vaultRoot, "知识")))) ?? [];
	const experience = (await guard("经验", () => flatSection(join(vaultRoot, "经验")))) ?? { count: 0, latest: "?" };
	const modules = (await guard("模块", () => flatSection(join(vaultRoot, "模块")))) ?? { count: 0, latest: "?" };
	const drafts = (await guard("笔记", () => draftSection(join(vaultRoot, draftDir)))) ?? { count: 0, names: [] };
	const git = includeGitInfo ? await guard("git", () => gitSection(vaultRoot)) : null;

	return {
		vaultRoot,
		scannedAt: Date.now(),
		devices,
		domains,
		experience,
		modules,
		drafts,
		git: git ?? null,
		errors
	};
}
