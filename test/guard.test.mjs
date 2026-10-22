import assert from "node:assert/strict";
import { test } from "node:test";

import { decideGuard } from "../lib/guard.js";

const guard = {
	enabled: true,
	guardShell: true,
	vaultRoot: "D:\\kb\\vault",
	draftDir: "笔记",
	contractPath: "D:\\kb\\vault\\CLAUDE.md",
	maintenancePath: "D:\\kb\\vault\\知识库规则\\维护细则.md"
};

const base = { guard, markerUsable: true, defaultDirectory: "D:\\project\\demo" };

test("write/edit inside the formal vault without a marker is denied", () => {
	const decision = decideGuard({ ...base, toolName: "write", args: { file_path: "D:\\kb\\vault\\知识\\mcu\\a.md" }, hasMarker: false });
	assert.equal(decision.action, "deny");
	assert.match(decision.reason, /CLAUDE\.md/);
	assert.match(decision.reason, /知识库规则\\维护细则\.md/);
});

test("audit: the deny reason names the exact follow-up read", () => {
	const decision = decideGuard({ ...base, toolName: "edit", args: { file_path: "D:\\kb\\vault\\经验\\a.md" }, hasMarker: false });
	assert.match(decision.reason, /read "D:\\kb\\vault\\CLAUDE\.md"/);
});

test("draft directory and paths outside the vault are allowed", () => {
	assert.equal(decideGuard({ ...base, toolName: "write", args: { file_path: "D:\\kb\\vault\\笔记\\draft.md" }, hasMarker: false }).action, "allow");
	assert.equal(decideGuard({ ...base, toolName: "write", args: { file_path: "D:\\project\\demo\\a.md" }, hasMarker: false }).action, "allow");
	assert.equal(decideGuard({ ...base, toolName: "read", args: { file_path: "D:\\kb\\vault\\知识\\a.md" }, hasMarker: false }).action, "allow");
});

test("a read contract marker allows everything", () => {
	assert.equal(decideGuard({ ...base, toolName: "write", args: { file_path: "D:\\kb\\vault\\知识\\a.md" }, hasMarker: true }).action, "allow");
});

test("an unusable marker store degrades to allow instead of deadlocking", () => {
	const decision = decideGuard({ ...base, toolName: "write", args: { file_path: "D:\\kb\\vault\\知识\\a.md" }, hasMarker: false, markerUsable: false });
	assert.equal(decision.action, "allow");
});

test("shell writes are guarded, draft-only shell writes are exempt", () => {
	const denied = decideGuard({ ...base, toolName: "pwsh", args: { command: "echo x > D:\\kb\\vault\\知识\\a.md" }, hasMarker: false });
	assert.equal(denied.action, "deny");
	assert.equal(denied.viaShell, true);

	const exempt = decideGuard({ ...base, toolName: "pwsh", args: { command: "echo x > D:\\kb\\vault\\笔记\\a.md" }, hasMarker: false });
	assert.equal(exempt.action, "allow");

	const outside = decideGuard({ ...base, toolName: "pwsh", args: { command: "echo x > C:\\work\\a.md" }, hasMarker: false });
	assert.equal(outside.action, "allow");
});

test("guardShell=false disables the shell half only", () => {
	const relaxed = { ...guard, guardShell: false };
	const decision = decideGuard({ ...base, guard: relaxed, toolName: "pwsh", args: { command: "rm D:\\kb\\vault\\知识\\a.md" }, hasMarker: false });
	assert.equal(decision.action, "allow");
});

test("a disabled guard allows every write", () => {
	const decision = decideGuard({ ...base, guard: { ...guard, enabled: false }, toolName: "write", args: { file_path: "D:\\kb\\vault\\知识\\a.md" }, hasMarker: false });
	assert.equal(decision.action, "allow");
});

test("shell call without an explicit workdir uses the session directory", () => {
	const denied = decideGuard({
		...base,
		toolName: "pwsh",
		args: { command: "echo x > a.md" },
		hasMarker: false,
		defaultDirectory: "D:\\kb\\vault\\模块"
	});
	assert.equal(denied.action, "deny");
});

test("relative file paths are resolved against the session directory", () => {
	const inVault = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "知识\\a.md" },
		hasMarker: false,
		defaultDirectory: "D:\\kb\\vault"
	});
	assert.equal(inVault.action, "deny", "a relative path from a session inside the vault writes the vault");

	const outside = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "知识\\a.md" },
		hasMarker: false,
		defaultDirectory: "C:\\project"
	});
	assert.equal(outside.action, "allow", "the same relative path from outside the vault is not a vault write");

	const draft = decideGuard({
		...base,
		toolName: "edit",
		args: { file_path: "笔记\\draft.md" },
		hasMarker: false,
		defaultDirectory: "D:\\kb\\vault"
	});
	assert.equal(draft.action, "allow", "the draft exemption also applies to relative paths");
});

test("absolute file paths still ignore the session directory", () => {
	const denied = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "D:\\kb\\vault\\经验\\a.md" },
		hasMarker: false,
		defaultDirectory: "C:\\project"
	});
	assert.equal(denied.action, "deny");
});

test("relative shell workdirs are resolved against the session directory", () => {
	const denied = decideGuard({
		...base,
		toolName: "pwsh",
		args: { command: "echo x > a.md", workdir: "模块" },
		hasMarker: false,
		defaultDirectory: "D:\\kb\\vault"
	});
	assert.equal(denied.action, "deny");
});

test("every candidate session directory is checked (stale header cwd after a working-directory change)", () => {
	const denied = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "知识\\a.md" },
		hasMarker: false,
		directories: ["D:\\project\\demo", "D:\\kb\\vault"]
	});
	assert.equal(denied.action, "deny", "the newer working-directory projection must also be considered");

	const allowed = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "知识\\a.md" },
		hasMarker: false,
		directories: ["D:\\project\\demo", "C:\\work"]
	});
	assert.equal(allowed.action, "allow");

	const draftOnly = decideGuard({
		...base,
		toolName: "write",
		args: { file_path: "笔记\\a.md" },
		hasMarker: false,
		directories: ["D:\\project\\demo", "D:\\kb\\vault"]
	});
	assert.equal(draftOnly.action, "allow", "a draft target stays exempt under every candidate");
});

test("shell calls check every candidate session directory", () => {
	const denied = decideGuard({
		...base,
		toolName: "pwsh",
		args: { command: "echo x > a.md" },
		hasMarker: false,
		directories: ["D:\\project\\demo", "D:\\kb\\vault"]
	});
	assert.equal(denied.action, "deny");
});
