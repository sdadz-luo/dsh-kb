import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanVaultRelative } from "../lib/config.js";

test("accepts ordinary vault-relative paths", () => {
	assert.equal(cleanVaultRelative("CLAUDE.md", "contractFile"), "CLAUDE.md");
	assert.equal(cleanVaultRelative("知识库规则/check.py", "checkScript"), "知识库规则/check.py");
	assert.equal(cleanVaultRelative("笔记", "draftDir"), "笔记");
	assert.equal(cleanVaultRelative("  CLAUDE.md  ", "contractFile"), "CLAUDE.md", "surrounding whitespace is trimmed");
});

test("rejects a bare dot, which would turn the whole vault into the draft area", () => {
	assert.throws(() => cleanVaultRelative(".", "draftDir"), /normalized vault-relative path/);
	assert.throws(() => cleanVaultRelative("./笔记", "draftDir"), /normalized vault-relative path/);
});

test("rejects parent segments and empty segments", () => {
	assert.throws(() => cleanVaultRelative("../CLAUDE.md", "contractFile"), /normalized|inside the vault/);
	assert.throws(() => cleanVaultRelative("知识库规则/../CLAUDE.md", "contractFile"), /normalized vault-relative path/);
	assert.throws(() => cleanVaultRelative("笔记/", "draftDir"), /normalized vault-relative path/);
	assert.throws(() => cleanVaultRelative("知识库规则//check.py", "checkScript"), /normalized vault-relative path/);
});

test("rejects absolute paths and drive-relative spellings", () => {
	assert.throws(() => cleanVaultRelative("D:\\kb\\vault\\CLAUDE.md", "contractFile"), /inside the vault/);
	assert.throws(() => cleanVaultRelative("/etc/passwd", "contractFile"), /inside the vault/);
	assert.throws(() => cleanVaultRelative("\\知识库规则\\check.py", "checkScript"), /inside the vault/);
});

test("rejects empty and non-string values", () => {
	assert.throws(() => cleanVaultRelative("", "draftDir"), /non-empty/);
	assert.throws(() => cleanVaultRelative("   ", "draftDir"), /non-empty/);
	assert.throws(() => cleanVaultRelative(undefined, "draftDir"), /non-empty/);
	assert.throws(() => cleanVaultRelative(42, "draftDir"), /non-empty/);
});

test("normalizes backslashes so downstream path joins stay consistent", () => {
	assert.equal(cleanVaultRelative("知识库规则\\check.py", "checkScript"), "知识库规则/check.py");
});
