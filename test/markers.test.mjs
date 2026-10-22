import assert from "node:assert/strict";
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
