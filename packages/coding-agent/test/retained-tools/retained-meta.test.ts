import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRetainedMeta } from "../../src/core/retained-tools/meta.js";
import { readRetainedMeta } from "../../src/core/retained-tools/rebuild.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(): string {
	const dir = fs.mkdtempSync(join(tmpdir(), "prime-agent-retained-meta-test-"));
	tempDirs.push(dir);
	return dir;
}

describe("parseRetainedMeta", () => {
	it("returns null when metadata is absent", () => {
		expect(parseRetainedMeta({ name: "x", description: "D." })).toBeNull();
	});

	it("returns null when metadata is null or non-object", () => {
		expect(parseRetainedMeta({ metadata: null })).toBeNull();
		expect(parseRetainedMeta({ metadata: "nope" })).toBeNull();
		expect(parseRetainedMeta(undefined)).toBeNull();
		expect(parseRetainedMeta(null)).toBeNull();
	});

	it("returns null when prime-agent is absent, null, or non-object", () => {
		expect(parseRetainedMeta({ metadata: {} })).toBeNull();
		expect(parseRetainedMeta({ metadata: { "prime-agent": null } })).toBeNull();
		expect(parseRetainedMeta({ metadata: { "prime-agent": "nope" } })).toBeNull();
	});

	it("returns null when retained is absent, null, or non-object", () => {
		expect(parseRetainedMeta({ metadata: { "prime-agent": {} } })).toBeNull();
		expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: null } } })).toBeNull();
		expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: "nope" } } })).toBeNull();
		expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: [] } } })).toBeNull();
	});

	it("returns defaults for an empty retained block", () => {
		expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: {} } } })).toEqual({
			version: 1,
			status: "active",
		});
	});

	it("parses a valid version and status", () => {
		expect(
			parseRetainedMeta({
				metadata: { "prime-agent": { retained: { version: 3, status: "disabled" } } },
			}),
		).toEqual({ version: 3, status: "disabled" });
	});

	it("accepts every known status value", () => {
		for (const status of ["active", "flagged", "disabled", "archived"] as const) {
			expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: { status } } } })?.status).toBe(status);
		}
	});

	it("falls back version to 1 for non-integer, non-positive, and wrong-typed values", () => {
		for (const version of [0, -1, 1.5, "3", null, true, [3]]) {
			expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: { version } } } })?.version).toBe(1);
		}
	});

	it("falls back status to active for unknown values and wrong types", () => {
		for (const status of ["bogus", "ACTIVE", 1, null, true]) {
			expect(parseRetainedMeta({ metadata: { "prime-agent": { retained: { status } } } })?.status).toBe("active");
		}
	});

	it("validates fields independently (bad version keeps a good status and vice versa)", () => {
		expect(
			parseRetainedMeta({
				metadata: { "prime-agent": { retained: { version: "x", status: "flagged" } } },
			}),
		).toEqual({ version: 1, status: "flagged" });
		expect(
			parseRetainedMeta({
				metadata: { "prime-agent": { retained: { version: 4, status: "bogus" } } },
			}),
		).toEqual({ version: 4, status: "active" });
	});

	it("tolerates and ignores extra keys under retained and sibling prime-agent keys", () => {
		const result = parseRetainedMeta({
			metadata: {
				"prime-agent": {
					retained: {
						version: 2,
						status: "archived",
						provenance: {
							created_by: "refine",
							source_sessions: ["01a0205d-0b6f-74f8-94f4-ad4cde6226c8"],
							first_seen: "2026-08-20T18:00:00Z",
							summary: "Retained from 2 sessions.",
						},
						tags: ["ops"],
					},
					smoke: ["import x; assert x.ping()"],
					always_in_prompt: true,
					unknownSibling: 1,
				},
			},
		});
		expect(result).toEqual({ version: 2, status: "archived" });
	});
});

describe("readRetainedMeta (thin wrapper over parseRetainedMeta)", () => {
	it("returns defaults for a skill file without retained frontmatter", () => {
		const dir = makeTempDir();
		const p = join(dir, "SKILL.md");
		fs.writeFileSync(p, "---\nname: x\ndescription: D.\n---\nBody.");
		expect(readRetainedMeta(p)).toEqual({ version: 1, status: "active" });
	});

	it("returns defaults for an unreadable or frontmatter-less file", () => {
		const dir = makeTempDir();
		expect(readRetainedMeta(join(dir, "missing.md"))).toEqual({ version: 1, status: "active" });
		const noFm = join(dir, "no-fm.md");
		fs.writeFileSync(noFm, "Just a body, no frontmatter.");
		expect(readRetainedMeta(noFm)).toEqual({ version: 1, status: "active" });
	});

	it("parses valid retained frontmatter from disk", () => {
		const dir = makeTempDir();
		const p = join(dir, "SKILL.md");
		fs.writeFileSync(
			p,
			"---\nname: x\ndescription: D.\nmetadata:\n  prime-agent:\n    retained:\n      version: 7\n      status: disabled\n---\nBody.",
		);
		expect(readRetainedMeta(p)).toEqual({ version: 7, status: "disabled" });
	});
});
