import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeShellWrite, hasFileRedirect, stripQuoted } from "../lib/shell.js";

const vaultRoot = "D:\\kb\\vault";
const draftDir = "笔记";

function analyze(command, workdir) {
	return analyzeShellWrite({ command, workdir, vaultRoot, draftDir });
}

test("stripQuoted blanks quoted spans", () => {
	assert.equal(stripQuoted('grep "a > b" f').includes(">"), false);
});

test("hasFileRedirect ignores descriptor copies and sinks", () => {
	assert.equal(hasFileRedirect("ls f 2>&1"), false);
	assert.equal(hasFileRedirect("ls f 2>/dev/null"), false);
	assert.equal(hasFileRedirect("ls f 2>$null"), false);
	assert.equal(hasFileRedirect("echo x > out.txt"), true);
	assert.equal(hasFileRedirect("echo x >> out.txt"), true);
});

test("redirect into the vault is a vault write", () => {
	const result = analyze("echo x > D:\\kb\\vault\\知识\\a.md");
	assert.equal(result.writesVault, true);
	assert.equal(result.onlyDraft, false);
	assert.deepEqual(result.targets, ["知识/a.md"]);
});

test("redirect into the draft directory is exempt", () => {
	const result = analyze("echo x > D:\\kb\\vault\\笔记\\a.md");
	assert.equal(result.writesVault, true);
	assert.equal(result.onlyDraft, true);
});

test("read-only commands are not writes", () => {
	assert.equal(analyze("Get-Content D:\\kb\\vault\\知识\\a.md").writesVault, false);
	assert.equal(analyze('grep "a > b" D:\\kb\\vault\\a.md').writesVault, false);
	assert.equal(analyze("ls D:\\kb\\vault\\知识\\a.md 2>&1").writesVault, false);
	assert.equal(analyze("cd D:\\kb\\vault").writesVault, false);
});

test("write verbs into the vault are detected", () => {
	assert.equal(analyze("Copy-Item a.md D:\\kb\\vault\\经验\\b.md").writesVault, true);
	assert.equal(analyze("rm D:\\kb\\vault\\模块\\c.md").writesVault, true);
	// Set-Content writes by itself; no redirection is required.
	assert.equal(analyze("Set-Content D:\\kb\\vault\\设备\\PC.md -Value x").writesVault, true);
});

test("relative write from inside the vault counts, absolute writes elsewhere do not", () => {
	const result = analyze("echo x > a.md", "D:\\kb\\vault\\知识");
	assert.equal(result.writesVault, true);

	const elsewhere = analyze("echo x > a.md", "C:\\work");
	assert.equal(elsewhere.writesVault, false);

	const absolute = analyze("echo x > C:\\work\\a.md", "D:\\kb\\vault\\知识");
	assert.equal(absolute.writesVault, false);
});
