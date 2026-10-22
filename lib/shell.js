/**
 * Shell write detection: does one `bash` / `pwsh` command line write into the
 * vault? Ported from the Claude Code `kb-contract-guard` hook, with the vault
 * root parameterized instead of hard-coded.
 *
 * Design rule inherited from that hook: prefer missing a write over blocking a
 * read. Anything ambiguous is reported as "no write", because a false denial
 * breaks ordinary read commands while a false allow only means the model was
 * asked to read the contract and skipped it.
 *
 * Known residual gap: writes performed *inside* an interpreter process
 * (`python -c "open(...).write()"`, `node -e ...`) cannot be recognized by
 * command-line inspection. The guard is a speed bump, not a sandbox.
 */
import { isInside } from "./paths.js";

/** Quoted spans never act as shell operators; strip them before matching verbs. */
const QUOTED_RE = /'[^']*'|"[^"]*"/g;

/** Shell verbs that write to disk (bash + PowerShell). Deliberately conservative. */
const WRITE_VERB_RE = new RegExp(
	"\\btee\\b|\\bcp\\b|\\bmv\\b|\\brm\\b|\\bsed\\s+-i|\\btruncate\\b|\\bdd\\b|\\btouch\\b|" +
		"\\bmkdir\\b|\\bln\\s+-s|\\bchmod\\b|\\bchown\\b|" +
		"\\bset-content\\b|\\badd-content\\b|\\bout-file\\b|\\bnew-item\\b|\\bremove-item\\b|" +
		"\\bmove-item\\b|\\bcopy-item\\b|\\bset-item\\b|\\bclear-content\\b|\\brename-item\\b|" +
		"\\bdel\\b|\\berase\\b|\\brd\\b|\\brmdir\\b|" +
		"\\brobocopy\\b|\\bxcopy\\b",
	"i"
);

/** Redirections are judged one `>` at a time so descriptors and sinks can be excluded. */
const REDIRECT_RE = />>?/g;
const NULL_TARGET_RE = /(?:\/dev\/null|\$null|\bnul\b)/i;
const ABSOLUTE_PATH_RE = /(^|[\s><"'=|&;])([A-Za-z]:[\\/]|\/)\S/;

/** `git` subcommands that rewrite the working tree (the notes themselves). */
const GIT_WRITE_SUBCOMMANDS = new Set([
	"checkout",
	"restore",
	"reset",
	"clean",
	"rm",
	"mv",
	"revert",
	"cherry-pick",
	"am",
	"switch",
	"apply",
	"stash"
]);
/** Variants that only inspect state, per write subcommand. */
const GIT_READ_ONLY_VARIANTS = new Map([
	["apply", new Set(["--check", "--stat", "--numstat", "--summary"])],
	["stash", new Set(["list", "show"])]
]);
const GIT_TOKEN_RE = /(^|[\\/])git(\.exe|\.cmd)?$/i;

/**
 * Remove quoted spans (with their quotes) so only shell syntax remains.
 * @param {string} command - raw command line.
 * @returns {string} command with quoted spans blanked.
 */
export function stripQuoted(command) {
	return command.replace(QUOTED_RE, " ");
}

/**
 * Whether a command line contains a redirection that really creates a file.
 * Excluded forms: `>&n` / `>&-` (descriptor copy or close), sinks such as
 * `/dev/null`, `$null`, `NUL`, and `=>` / `->` arrows.
 * @param {string} command - raw command line.
 * @returns {boolean} true when some redirection writes a file.
 */
export function hasFileRedirect(command) {
	const stripped = stripQuoted(command);
	for (const match of stripped.matchAll(REDIRECT_RE)) {
		const index = match.index ?? 0;
		if (index > 0 && (stripped[index - 1] === "=" || stripped[index - 1] === "-")) continue;
		const rest = stripped.slice(index + match[0].length).trimStart();
		if (rest.startsWith("&")) continue;
		if (rest.length > 0 && NULL_TARGET_RE.test(rest)) continue;
		return true;
	}
	return false;
}

/**
 * Whether a command line runs a `git` subcommand that rewrites tracked files.
 * Read-only variants (`git apply --check`, `git stash list|show`) are exempt;
 * `git add` only touches the index and is not in the write set at all.
 * @param {string} command - raw command line.
 * @returns {boolean} true when git would rewrite the working tree.
 */
export function gitWritesWorkingTree(command) {
	for (const segment of command.split(/[;&|]/)) {
		const tokens = tokenize(segment);
		const gitIndex = tokens.findIndex((token) => GIT_TOKEN_RE.test(token));
		if (gitIndex < 0) continue;
		let cursor = gitIndex + 1;
		let subcommand;
		while (cursor < tokens.length) {
			const token = tokens[cursor];
			if (token === "-C" || token === "-c" || token === "--git-dir" || token === "--work-tree") {
				cursor += 2;
				continue;
			}
			if (token.startsWith("-")) {
				cursor += 1;
				continue;
			}
			subcommand = token.toLowerCase();
			break;
		}
		if (subcommand === undefined || !GIT_WRITE_SUBCOMMANDS.has(subcommand)) continue;
		const tail = tokens.slice(cursor + 1).map((token) => token.toLowerCase());
		const readOnly = GIT_READ_ONLY_VARIANTS.get(subcommand);
		if (readOnly !== undefined && tail.length > 0 && readOnly.has(tail[0])) continue;
		return true;
	}
	return false;
}

/** One quoted or bare shell token; quotes are stripped, their contents kept. */
const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;

/**
 * Split one command segment into tokens, keeping quoted paths intact.
 *
 * Plain `split(/\s+/)` after {@link stripQuoted} would erase the value of
 * `-C '<path>'` and leave `-C` swallowing the subcommand that follows it — the
 * exact shape that let `git -C 'D:\kb\vault' clean -fdn` slip through.
 * @param {string} segment - command segment without shell operators.
 * @returns {string[]} tokens.
 */
function tokenize(segment) {
	const tokens = [];
	for (const match of segment.matchAll(TOKEN_RE)) {
		const value = match[1] ?? match[2] ?? match[3] ?? "";
		if (value.length > 0) tokens.push(value);
	}
	return tokens;
}

/** Normalize a path spelling for substring matching inside a command line. */
function commandKey(value) {
	return value.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Analyze whether one shell command writes into the vault.
 *
 * Two shapes count as "writing the vault":
 *  1. the command text names the vault root (absolute, either separator);
 *  2. the working directory is inside the vault and the command uses no
 *     absolute path (so its relative targets land in the vault).
 *
 * @param {object} input - analysis input.
 * @param {string} input.command - raw command line.
 * @param {string} [input.workdir] - shell working directory, when known.
 * @param {string} input.vaultRoot - absolute vault root.
 * @param {string} [input.draftDir] - vault-relative draft directory.
 * @returns {{writesVault: boolean, onlyDraft: boolean, targets: string[]}} analysis.
 */
export function analyzeShellWrite({ command, workdir, vaultRoot, draftDir }) {
	const none = { writesVault: false, onlyDraft: false, targets: [] };
	if (typeof command !== "string" || command.length === 0) return none;
	if (typeof vaultRoot !== "string" || vaultRoot.length === 0) return none;

	const stripped = stripQuoted(command);
	if (!WRITE_VERB_RE.test(stripped) && !hasFileRedirect(command) && !gitWritesWorkingTree(command)) return none;

	const vaultKey = commandKey(vaultRoot);
	if (vaultKey.length === 0) return none;
	const commandText = command.replaceAll("\\", "/").toLowerCase();

	let targets = [];
	let writesVault = false;

	if (commandText.includes(vaultKey)) {
		writesVault = true;
		const remainderRe = new RegExp(`${escapeRegExp(vaultKey)}/+([^\\s"'<>=|&;)]*)`, "g");
		for (const match of commandText.matchAll(remainderRe)) {
			const remainder = match[1].replace(/\/+$/, "");
			if (remainder.length > 0) targets.push(remainder);
		}
	} else if (typeof workdir === "string" && workdir.length > 0 && isInside(vaultRoot, workdir) && !ABSOLUTE_PATH_RE.test(command)) {
		writesVault = true;
	}

	if (!writesVault) return none;

	let onlyDraft = false;
	if (typeof draftDir === "string" && draftDir.length > 0 && targets.length > 0) {
		const draftKey = commandKey(draftDir);
		onlyDraft = targets.every((target) => target === draftKey || target.startsWith(`${draftKey}/`));
	}

	return { writesVault, onlyDraft, targets };
}
