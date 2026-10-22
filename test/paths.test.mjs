import assert from "node:assert/strict";
import { test } from "node:test";

import { isInside, pathKey, posixRelative, samePath, toPosix } from "../lib/paths.js";

const WINDOWS = process.platform === "win32";
const vault = WINDOWS ? "D:\\kb\\vault" : "/kb/vault";
const inside = WINDOWS ? "D:\\kb\\vault\\知识\\a.md" : "/kb/vault/知识/a.md";
const outside = WINDOWS ? "D:\\kb\\other\\a.md" : "/kb/other/a.md";

test("pathKey folds case on Windows and trims trailing separators", () => {
	const key = pathKey(vault);
	assert.equal(key, pathKey(`${vault}\\`));
	if (WINDOWS) assert.equal(key, key.toUpperCase().toLowerCase());
});

test("samePath matches one location under different spellings", () => {
	assert.equal(samePath(inside, inside.replaceAll("\\", "/")), true);
	assert.equal(samePath(inside, outside), false);
	assert.equal(samePath("", inside), false);
});

test("isInside accepts the root itself and descendants only", () => {
	assert.equal(isInside(vault, vault), true);
	assert.equal(isInside(vault, inside), true);
	assert.equal(isInside(vault, outside), false);
	// A sibling sharing the prefix is not a child.
	assert.equal(isInside(WINDOWS ? "D:\\kb\\vaul" : "/kb/vaul", vault), false);
});

test("posixRelative returns slash-separated relative paths", () => {
	assert.equal(posixRelative(vault, inside), "知识/a.md");
	assert.equal(posixRelative(vault, vault), "");
	assert.equal(posixRelative(vault, outside), undefined);
});

test("toPosix only rewrites separators", () => {
	assert.equal(toPosix("a\\b\\c"), "a/b/c");
	assert.equal(toPosix(undefined), "");
});
