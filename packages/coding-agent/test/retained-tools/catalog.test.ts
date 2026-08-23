import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.js";
import { buildToolsCatalog, formatToolsCatalogTable, loadToolsCatalog } from "../../src/core/retained-tools/catalog.js";
import {
	emptyToolIndex,
	saveToolIndex,
	type ToolIndex,
	type ToolIndexEntry,
	type ToolScope,
	type ToolStatus,
	type ToolUsage,
} from "../../src/core/retained-tools/index.js";

const EXPECTED_COLUMNS = ["name", "scope", "path", "status", "used", "explicit_ok", "explicit_fail", "last_used"];

function entry(
	scope: ToolScope,
	path: string,
	status: ToolStatus = "active",
	usage: Partial<ToolUsage> = {},
): ToolIndexEntry {
	return {
		scope,
		path,
		version: 1,
		status,
		usage: {
			used: usage.used ?? 0,
			explicit_ok: usage.explicit_ok ?? 0,
			explicit_fail: usage.explicit_fail ?? 0,
			last_used: usage.last_used ?? null,
			last_status: usage.last_status ?? null,
			recent_failures: [],
		},
		description_hash: "sha256:0",
		embedding: [],
	};
}

function index(skills: Record<string, ToolIndexEntry>): ToolIndex {
	const base = emptyToolIndex();
	base.skills = skills;
	return base;
}

describe("retained tools catalog (T04)", () => {
	it("header row lists the exact columns in order", () => {
		const catalog = buildToolsCatalog(
			index({}),
			index({
				"demo-tool": entry("project", ".prime/agent/skills/demo-tool", "active", {
					used: 1,
					explicit_ok: 1,
					last_used: "2026-08-21T10:00:00.000Z",
				}),
			}),
		);
		const firstLine = formatToolsCatalogTable(catalog).split("\n")[0];
		expect(firstLine.split(/\s{2,}/)).toEqual(EXPECTED_COLUMNS);
	});

	it("renders one row per visible entry with all eight fields", () => {
		const catalog = buildToolsCatalog(
			index({
				gtool: entry("global", "skills/gtool", "flagged", {
					used: 2,
					explicit_ok: 1,
					explicit_fail: 1,
					last_used: "2026-08-20T09:30:00.000Z",
				}),
			}),
			index({
				"demo-tool": entry("project", ".prime/agent/skills/demo-tool", "active", {
					used: 1,
					explicit_ok: 0,
					explicit_fail: 0,
					last_used: "2026-08-21T10:00:00.000Z",
				}),
			}),
		);
		const lines = formatToolsCatalogTable(catalog).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1].split(/\s{2,}/)).toEqual([
			"demo-tool",
			"project",
			".prime/agent/skills/demo-tool",
			"active",
			"1",
			"0",
			"0",
			"2026-08-21T10:00:00.000Z",
		]);
		expect(lines[2].split(/\s{2,}/)).toEqual([
			"gtool",
			"global",
			"skills/gtool",
			"flagged",
			"2",
			"1",
			"1",
			"2026-08-20T09:30:00.000Z",
		]);
	});

	it("shadows a same-named global entry with the project entry", () => {
		const catalog = buildToolsCatalog(
			index({
				"dup-tool": entry("global", "skills/dup-tool", "active", {
					used: 9,
					last_used: "2026-08-01T00:00:00.000Z",
				}),
			}),
			index({
				"dup-tool": entry("project", ".prime/agent/skills/dup-tool", "flagged", {
					used: 1,
					last_used: "2026-08-21T10:00:00.000Z",
				}),
			}),
		);
		expect(catalog).toHaveLength(1);
		const cells = formatToolsCatalogTable(catalog)
			.split("\n")[1]
			.split(/\s{2,}/);
		// Exactly one row for the name, with project scope, path, and counters.
		expect(cells).toEqual([
			"dup-tool",
			"project",
			".prime/agent/skills/dup-tool",
			"flagged",
			"1",
			"0",
			"0",
			"2026-08-21T10:00:00.000Z",
		]);
	});

	it("renders null last_used as a dash", () => {
		const catalog = buildToolsCatalog(index({ never: entry("global", "skills/never") }), index({}));
		const line = formatToolsCatalogTable(catalog).split("\n")[1];
		expect(line.split(/\s{2,}/)[7]).toBe("-");
	});

	it("sorts rows by name ascending regardless of index insertion order", () => {
		const catalog = buildToolsCatalog(
			index({
				zzz: entry("global", "skills/zzz"),
				mmm: entry("global", "skills/mmm"),
			}),
			index({
				aaa: entry("project", ".prime/agent/skills/aaa"),
			}),
		);
		expect(catalog.map((r) => r.name)).toEqual(["aaa", "mmm", "zzz"]);
		const names = formatToolsCatalogTable(catalog)
			.split("\n")
			.slice(1)
			.map((line) => line.split(/\s{2,}/)[0]);
		expect(names).toEqual(["aaa", "mmm", "zzz"]);
	});

	it("returns the empty-catalog text when neither scope has entries", () => {
		expect(formatToolsCatalogTable(buildToolsCatalog(emptyToolIndex(), emptyToolIndex()))).toBe(
			"No retained tools found.",
		);
	});

	describe("loadToolsCatalog", () => {
		let base: string;
		let cwd: string;
		let agentDir: string;

		beforeEach(() => {
			base = mkdtempSync(join(tmpdir(), "pi-catalog-"));
			cwd = join(base, "project");
			agentDir = join(base, "agent");
		});

		afterEach(() => {
			rmSync(base, { recursive: true, force: true });
		});

		it("merges both scope index files using the agentDir override", () => {
			saveToolIndex(join(cwd, CONFIG_DIR_NAME, "tools"), {
				...emptyToolIndex(),
				skills: {
					"demo-tool": entry("project", ".prime/agent/skills/demo-tool", "active", {
						used: 3,
						explicit_ok: 2,
						last_used: "2026-08-21T10:00:00.000Z",
					}),
				},
			});
			saveToolIndex(join(agentDir, "tools"), {
				...emptyToolIndex(),
				skills: {
					gtool: entry("global", "skills/gtool", "disabled"),
				},
			});
			const catalog = loadToolsCatalog({ cwd, agentDir });
			expect(catalog.map((r) => r.name)).toEqual(["demo-tool", "gtool"]);
			expect(catalog[0]).toMatchObject({
				name: "demo-tool",
				scope: "project",
				path: ".prime/agent/skills/demo-tool",
				used: 3,
				explicit_ok: 2,
				explicit_fail: 0,
				last_used: "2026-08-21T10:00:00.000Z",
			});
			expect(catalog[1]).toMatchObject({
				name: "gtool",
				scope: "global",
				path: "skills/gtool",
				status: "disabled",
				used: 0,
				last_used: null,
			});
		});

		it("degrades to the empty catalog when no index files exist", () => {
			const catalog = loadToolsCatalog({ cwd, agentDir });
			expect(catalog).toEqual([]);
			expect(formatToolsCatalogTable(catalog)).toBe("No retained tools found.");
		});
	});
});
