import assert from "node:assert/strict";
import { existsSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { ContractMarkers } from "../lib/markers.js";

let root;
let markers;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "dsh-kb-markers-"));
	markers = new ContractMarkers({ dir: join(root, "kb-contract") });
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("the marker store is writable on a fresh directory", () => {
	assert.equal(markers.usable(), true);
});

test("marking one session does not mark another", () => {
	markers.mark("session-a", "D:\\kb\\CLAUDE.md");
	assert.equal(markers.has("session-a"), true);
	assert.equal(markers.has("session-b"), false);
	assert.equal(markers.has(""), false);
});

test("a marker survives a new store instance (app restart)", () => {
	const reopened = new ContractMarkers({ dir: join(root, "kb-contract") });
	assert.equal(reopened.has("session-a"), true);
});

test("forget drops the marker", () => {
	markers.forget("session-a");
	assert.equal(markers.has("session-a"), false);
});

test("an expired marker stops authorizing writes", () => {
	markers.mark("session-old", "D:\\kb\\CLAUDE.md");
	const file = markers.fileFor("session-old");
	const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
	utimesSync(file, monthAgo, monthAgo);

	assert.equal(markers.has("session-old"), false, "TTL is enforced on read, not only on sweep");
	assert.equal(existsSync(file), false, "the expired marker file is removed");
});

test("a marker inside the TTL keeps authorizing writes", () => {
	markers.mark("session-fresh", "D:\\kb\\CLAUDE.md");
	const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
	utimesSync(markers.fileFor("session-fresh"), anHourAgo, anHourAgo);
	assert.equal(markers.has("session-fresh"), true);
});
