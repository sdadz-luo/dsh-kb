import assert from "node:assert/strict";
import { test } from "node:test";

import { formatCheckResult, parseCheckOutput } from "../lib/check.js";

const PASSING = `
============================================================
知识库结构校验报告
扫描文件: 158 个 md  |  日期: 2026-10-22
============================================================

ℹ️  跳过 (1):
   笔记/ 暂存区有 3 篇草稿：仅校验 frontmatter，内容形态校验跳过（见契约铁律第 7 条）

✅ 全部通过，无警告。

============================================================
`;

const FAILING = `
============================================================
知识库结构校验报告
扫描文件: 158 个 md  |  日期: 2026-10-22
============================================================

❌ 失败 (2):
   知识/mcu/a.md: 缺少 frontmatter 字段 updated
   设备/PC.md: 段序不符（速查应在首位）
⚠️  警告 (1):
   笔记/draft.md: 疑似凭据值 sk-xxxx
📋 提示 (3)——不阻断提交，按需处理:
   经验/e.md: IP 地址形如内网地址

✅ 全部通过（1 个警告，另有 3 条提示，不阻断提交）。
`;

test("a passing report yields zero counts and passed=true", () => {
	const parsed = parseCheckOutput(PASSING);
	assert.equal(parsed.scanned, 158);
	assert.equal(parsed.errors, 0);
	assert.equal(parsed.warnings, 0);
	assert.equal(parsed.skipped, 1);
	assert.equal(parsed.passed, true);
});

test("a failing report keeps counts and detail lines per section", () => {
	const parsed = parseCheckOutput(FAILING);
	assert.equal(parsed.scanned, 158);
	assert.equal(parsed.errors, 2);
	assert.equal(parsed.warnings, 1);
	assert.equal(parsed.notices, 3);
	assert.equal(parsed.errorLines.length, 2);
	assert.match(parsed.errorLines[0], /缺少 frontmatter/);
	assert.match(parsed.warningLines[0], /疑似凭据值/);
	assert.match(parsed.noticeLines[0], /IP 地址/);
});

test("formatCheckResult leads with counts and a verdict", () => {
	const text = formatCheckResult({ ok: false, exitCode: 1, ...parseCheckOutput(FAILING) });
	assert.match(text, /扫描 158 个 md/);
	assert.match(text, /❌ 2 \/ ⚠️ 1 \/ 📋 3/);
	assert.match(text, /结论：未通过/);
	assert.match(text, /失败项：/);
});

test("a run failure is surfaced verbatim", () => {
	assert.match(formatCheckResult({ ok: false, failure: "无法运行 check.py（python）：boom" }), /无法运行 check\.py/);
});

test("ANSI colors never leak into counts", () => {
	const parsed = parseCheckOutput("\u001b[31m❌ 失败 (1):\u001b[0m\n    x: y\n");
	assert.equal(parsed.errors, 1);
});
