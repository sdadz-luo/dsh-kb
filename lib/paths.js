/**
 * Path helpers shared by the guard, the scanner, and the marker store.
 *
 * Everything here is plain Node: no DSH imports, so the module stays unit
 * testable without a host. Comparison is case-insensitive on Windows (the
 * filesystem is), and produces stable keys instead of touching the disk, so
 * non-existent paths still compare correctly.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

const WINDOWS = process.platform === "win32";

/**
 * Canonical comparison key for one path: absolute, trailing separator removed,
 * case-folded on Windows. Returns "" for unusable input.
 * @param {unknown} value - candidate path.
 * @returns {string} comparison key.
 */
export function pathKey(value) {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (trimmed.length === 0) return "";
	let absolute;
	try {
		absolute = resolve(trimmed);
	} catch {
		return "";
	}
	const folded = WINDOWS ? absolute.toLowerCase() : absolute;
	return folded.length > 1 && folded.endsWith(sep) ? folded.slice(0, -1) : folded;
}

/**
 * Whether two paths name the same location.
 * @param {unknown} left - first path.
 * @param {unknown} right - second path.
 * @returns {boolean} true when equal after normalization.
 */
export function samePath(left, right) {
	const a = pathKey(left);
	const b = pathKey(right);
	return a.length > 0 && a === b;
}

/**
 * Whether `child` is `parent` or lives under it.
 * @param {unknown} parent - candidate ancestor.
 * @param {unknown} child - candidate descendant.
 * @returns {boolean} true when contained.
 */
export function isInside(parent, child) {
	const p = pathKey(parent);
	const c = pathKey(child);
	if (p.length === 0 || c.length === 0) return false;
	if (c === p) return true;
	return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Render a Windows path with forward slashes, matching command spellings. */
export function toPosix(value) {
	return typeof value === "string" ? value.replaceAll("\\", "/") : "";
}

/**
 * POSIX-style relative path from `parent` to `child`, or undefined when the
 * child escapes the parent. An empty string means "the parent itself".
 * @param {unknown} parent - ancestor directory.
 * @param {unknown} child - descendant path.
 * @returns {string | undefined} relative path.
 */
export function posixRelative(parent, child) {
	const p = pathKey(parent);
	const c = pathKey(child);
	if (p.length === 0 || c.length === 0) return undefined;
	const rel = relative(p, c);
	if (rel === "") return "";
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return toPosix(rel);
}
