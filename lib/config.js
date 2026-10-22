/**
 * Vault-relative config path validation, shared by the plugin entry and its
 * tests.
 *
 * Every `*File` / `draftDir` field is joined under the vault root, so a value
 * that escapes or degenerates the root would silently disable the guard rather
 * than fail loudly. Two traps are rejected explicitly:
 *   - `.` (or any `.`/empty segment) makes `join(vault, ".")` equal the vault
 *     itself, turning the whole vault into an exempt area;
 *   - absolute paths and `..` segments leave the vault entirely.
 */
const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

/**
 * Validate one vault-relative path field.
 * @param {unknown} value - configured value.
 * @param {string} field - config field name, used in the error message.
 * @returns {string} the trimmed relative path.
 */
export function cleanVaultRelative(value, field) {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`dsh-kb: config.${field} must be a non-empty vault-relative path`);
	}
	const trimmed = value.trim();
	if (WINDOWS_DRIVE_RE.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\")) {
		throw new Error(`dsh-kb: config.${field} must stay inside the vault (got ${JSON.stringify(value)})`);
	}
	const segments = trimmed.split(/[\\/]/);
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new Error(`dsh-kb: config.${field} must be a normalized vault-relative path without "." or ".." segments (got ${JSON.stringify(value)})`);
	}
	return segments.join("/");
}
