import assert from "node:assert/strict";
import { test } from "node:test";

import { buildContext, byteLength, digestOf, renderContext, truncateToBytes } from "../lib/render.js";

function model(overrides = {}) {
	return {
		vaultRoot: "D:\\kb\\vault",
		scannedAt: Date.parse("2026-10-22T02:00:00Z"),
		devices: [{ name: "PC主机", updated: "2026-10-14" }],
		domains: [
			{ name: "mcu", count: 43, latest: "2026-10-16", subdirs: [{ path: "stm32/", count: 12 }] },
			{ name: "linux", count: 10, latest: "2026-09-28", subdirs: [] }
		],
		experience: { count: 20, latest: "2026-10-20" },
		modules: { count: 8, latest: "2026-09-27" },
		drafts: { count: 3, names: ["a", "b", "c"] },
		git: { hash: "b318952", subject: "chore: hook", date: "2026-10-21", dirtyCount: 3 },
		errors: [],
		...overrides
	};
}

test("full render carries every section and both pointers", () => {
	const text = buildContext(model());
	assert.match(text, /<kb-context>/);
	assert.match(text, /PC主机/);
	assert.match(text, /mcu（43 篇：stm32\/（12篇）；最近 2026-10-16）/);
	assert.match(text, /最近提交 b318952/);
	assert.match(text, /知识库规则\/检索协议\.md/);
	assert.match(text, /知识库规则\/check\.py/);
	assert.match(text, /<\/kb-context>/);
});

test("every rendered variant respects the byte budget", () => {
	for (const maxBytes of [6144, 1200, 700, 400]) {
		const rendered = renderContext(model(), { maxBytes });
		assert.ok(byteLength(rendered.text) <= maxBytes, `budget ${maxBytes} exceeded by ${byteLength(rendered.text)}`);
	}
});

test("small budgets shed detail before truncating", () => {
	const lean = renderContext(model(), { maxBytes: 800 });
	assert.equal(lean.truncated, false);
	assert.equal(lean.text.includes("stm32/"), false);

	const tiny = renderContext(model(), { maxBytes: 320 });
	assert.equal(tiny.truncated, true);
	assert.match(tiny.text, /已截断/);
});

test("digest is stable for identical content and changes with content", () => {
	const first = renderContext(model(), { maxBytes: 6144 });
	const second = renderContext(model(), { maxBytes: 6144 });
	assert.equal(first.digest, second.digest);

	const changed = renderContext(model({ drafts: { count: 4, names: ["a"] } }), { maxBytes: 6144 });
	assert.notEqual(first.digest, changed.digest);
	assert.equal(digestOf(first.text), first.digest);
});

test("scan errors surface inside the block", () => {
	const text = buildContext(model({ errors: ["git: boom"] }));
	assert.match(text, /索引告警：git: boom/);
});

test("truncateToBytes never exceeds the budget", () => {
	const long = "aaaa\n".repeat(20);
	const tight = truncateToBytes(long, 14);
	assert.ok(byteLength(tight) <= 14);
	assert.equal(tight.includes("已截断"), false, "no footer when it cannot fit");

	const roomy = truncateToBytes(long, 60);
	assert.match(roomy, /已截断/);
	assert.ok(byteLength(roomy) <= 60);
});
