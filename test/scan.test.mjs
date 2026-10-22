import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { listNotes, scanVault } from "../lib/scan.js";

let root;
let vault;

before(async () => {
	root = await mkdtemp(join(tmpdir(), "dsh-kb-scan-"));
	vault = join(root, "vault");
	const put = async (relative, body) => {
		const file = join(vault, relative);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, body, "utf8");
	};
	await put(join("设备", "PC.md"), "---\nupdated: 2026-10-14\n---\n# PC\n");
	await put(join("设备", "MOC.md"), "---\nupdated: 2026-10-01\n---\n");
	await put(join("设备", "_helper.md"), "---\nupdated: 2026-10-01\n---\n");
	await put(join("知识", "mcu", "MOC.md"), "---\nupdated: 2026-09-01\n---\n");
	await put(join("知识", "mcu", "stm32", "a.md"), "---\nupdated: 2026-10-16\n---\n");
	await put(join("知识", "mcu", "b.md"), "---\nupdated: 2026-10-02\n---\n");
	await put(join("知识", "other", "c.md"), "---\nupdated: 2026-10-03\n---\n");
	await put(join("经验", "e.md"), "---\nupdated: 2026-10-20T12:00:00\n---\n");
	await put(join("模块", "m.md"), "---\nupdated: 2026-09-27\n---\n");
	await put(join("笔记", "draft-one.md"), "---\nupdated: 2026-10-17\n---\n");
	await put(join("笔记", "整理规则.md"), "---\nupdated: 2026-09-29\n---\n");
	await put(join("笔记", "_scratch.md"), "---\nupdated: 2026-09-29\n---\n");
});

after(async () => {
	await rm(root, { recursive: true, force: true });
});

test("listNotes skips MOC, _-prefixed helpers, and hidden directories", async () => {
	const notes = await listNotes(join(vault, "设备"));
	assert.deepEqual(
		notes.map((note) => note.split(/[\\/]/).at(-1)),
		["PC.md"]
	);
});

test("devices, domains, flat counts, and drafts follow the vault rules", async () => {
	const model = await scanVault({ vaultRoot: vault, draftDir: "笔记", includeGitInfo: false });

	assert.deepEqual(model.devices, [{ name: "PC", updated: "2026-10-14" }]);
	assert.equal(model.domains.length, 1, "only domains owning a MOC.md are listed");
	const [mcu] = model.domains;
	assert.equal(mcu.name, "mcu");
	assert.equal(mcu.count, 2);
	assert.equal(mcu.latest, "2026-10-16");
	assert.deepEqual(mcu.subdirs, [{ path: "stm32/", count: 1 }]);
	assert.equal(model.experience.count, 1);
	assert.equal(model.experience.latest, "2026-10-20", "frontmatter timestamps are cut to a date");
	assert.equal(model.modules.count, 1);
	assert.deepEqual(model.drafts, { count: 1, names: ["draft-one"] });
	assert.equal(model.git, null);
	assert.deepEqual(model.errors, []);
});

test("a missing vault degrades to empty sections instead of throwing", async () => {
	const model = await scanVault({ vaultRoot: join(root, "absent"), draftDir: "笔记", includeGitInfo: false });
	assert.deepEqual(model.devices, []);
	assert.deepEqual(model.domains, []);
	assert.equal(model.experience.count, 0);
	assert.equal(model.drafts.count, 0);
});
