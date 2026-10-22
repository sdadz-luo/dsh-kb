/**
 * Per-session "contract already read" markers.
 *
 * Same semantics as the Claude Code guard's marker files: one file per session,
 * a 7-day TTL, best-effort writes, and a writability probe. When the store is
 * unusable the caller must degrade to "allow" — losing the marker must never
 * turn every vault write into a denial.
 */
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PROBE_FILE = ".writability-probe";

export class ContractMarkers {
	/**
	 * @param {object} options - store options.
	 * @param {string} options.dir - directory holding one marker file per session.
	 * @param {number} [options.ttlMs] - marker lifetime.
	 */
	constructor({ dir, ttlMs = DEFAULT_TTL_MS }) {
		this.dir = dir;
		this.ttlMs = ttlMs;
		this.memory = new Set();
		this.usableCache = undefined;
	}

	/** Marker file path for one session id. */
	fileFor(sessionId) {
		const safe = String(sessionId ?? "unknown").replace(/[^A-Za-z0-9_-]/g, "");
		return join(this.dir, `${safe.length > 0 ? safe : "unknown"}.read`);
	}

	/**
	 * Whether the session already read the contract. Sync on purpose: the tool
	 * guard runs synchronously inside the execution pipeline.
	 *
	 * The TTL is enforced on **read**, not only while sweeping: a marker left by
	 * a resumed session must stop authorizing writes once it is older than the
	 * configured lifetime, otherwise "7 days" would only hold until the next
	 * mark() happened to run.
	 * @param {string} sessionId - session identity.
	 * @returns {boolean} true when a live marker exists.
	 */
	has(sessionId) {
		if (typeof sessionId !== "string" || sessionId.length === 0) return false;
		const file = this.fileFor(sessionId);
		let stats;
		try {
			stats = statSync(file);
		} catch {
			this.memory.delete(sessionId);
			return false;
		}
		if (Date.now() - stats.mtimeMs > this.ttlMs) {
			this.memory.delete(sessionId);
			try {
				rmSync(file, { force: true });
			} catch {
				/* best-effort */
			}
			return false;
		}
		this.memory.add(sessionId);
		return true;
	}

	/**
	 * Record that the session read the contract.
	 * @param {string} sessionId - session identity.
	 * @param {string} contractPath - contract file that was read.
	 */
	mark(sessionId, contractPath) {
		if (typeof sessionId !== "string" || sessionId.length === 0) return;
		this.memory.add(sessionId);
		try {
			mkdirSync(this.dir, { recursive: true });
			writeFileSync(this.fileFor(sessionId), contractPath, "utf8");
			this.sweep();
		} catch {
			/* marker persistence is best-effort; the in-memory hit still covers this run */
		}
	}

	/** Drop one session's marker (used by `/kb forget`). */
	forget(sessionId) {
		this.memory.delete(sessionId);
		try {
			rmSync(this.fileFor(sessionId), { force: true });
		} catch {
			/* best-effort */
		}
	}

	/**
	 * Whether markers can be written at all. Probed once per process and cached:
	 * a broken store means "degrade to allow", never "block forever".
	 * @returns {boolean} true when the marker directory is writable.
	 */
	usable() {
		if (this.usableCache !== undefined) return this.usableCache;
		try {
			mkdirSync(this.dir, { recursive: true });
			const probe = join(this.dir, PROBE_FILE);
			writeFileSync(probe, "x", "utf8");
			rmSync(probe, { force: true });
			this.usableCache = true;
		} catch {
			this.usableCache = false;
		}
		return this.usableCache;
	}

	/** Remove expired markers. Best-effort. */
	sweep() {
		let names;
		try {
			names = readdirSync(this.dir);
		} catch {
			return;
		}
		const now = Date.now();
		for (const name of names) {
			const file = join(this.dir, name);
			try {
				if (now - statSync(file).mtimeMs > this.ttlMs) rmSync(file, { force: true });
			} catch {
				/* ignore one unreadable entry */
			}
		}
	}
}
