import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	AUTO_RESEARCH_PROVENANCE,
	type AutoResearchProvenanceRecord,
	type CleanRoomScanArtifact,
	validateCleanRoomManifest,
} from "../src/core/autoresearch/provenance.js";
import { V2_RUN_KEYS } from "../src/core/autoresearch/types.js";

type JsonRecord = Record<string, unknown>;

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/autoresearch");
const v2FixtureRoot = join(fixtureRoot, "v2");
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const expectedRunKeys = [
	"schema_version",
	"run_id",
	"created_at",
	"repo",
	"branch",
	"goal",
	"scope",
	"metric",
	"guard",
	"target",
	"max_candidates",
	"timeout_seconds",
	"docs",
	"parallel",
] as const;

const expectedProvenance: readonly AutoResearchProvenanceRecord[] = [
	{
		source: "autoresearch-behavior",
		commit: "95e2fa1189f08ce694eb1a2b3e85d4bf58d3cfbf",
		treeDigest: null,
		locatorDigest: null,
		approvalDigest: "1152a9410008de681627290161e3ebcae327108317d43b665e141d76b46195d0",
		noGrantScanDigest: null,
		license: "MIT",
		copyright: "Copyright (c) 2026 LLLLLe",
		reuse: "behavioral-notes-and-fixtures-only",
	},
	{
		source: "linked-workflow-design",
		commit: "e6c899ffd82d7d32aa9f93f0986a402add47c32d",
		treeDigest: "516333967c2a0042922ce3e5b80f725debc138cb",
		locatorDigest: "58ed3d5cb0d47dcae80abb128cef1c5cdd27097738180b9c5ffa5d612e34f676",
		approvalDigest: null,
		noGrantScanDigest: "d26b07b0903fa71a792e9bfdd5b7b51678e3214a055e0f2d7bcb15fae6449572",
		license: "no license or notice found",
		copyright: null,
		reuse: "no-source-reuse",
	},
];

const expectedScan = {
	sourceCommit: "95e2fa1189f08ce694eb1a2b3e85d4bf58d3cfbf",
	linkedTreeDigest: "516333967c2a0042922ce3e5b80f725debc138cb",
	linkedLocatorDigest: "58ed3d5cb0d47dcae80abb128cef1c5cdd27097738180b9c5ffa5d612e34f676",
	approvalDigest: "1152a9410008de681627290161e3ebcae327108317d43b665e141d76b46195d0",
	noGrantScanDigest: "d26b07b0903fa71a792e9bfdd5b7b51678e3214a055e0f2d7bcb15fae6449572",
	trackedForbiddenPaths: [],
	forbiddenTextMatches: [],
	result: "clean",
} as const;

function readFixtureJson(relativePath: string): JsonRecord {
	return JSON.parse(readFileSync(join(fixtureRoot, relativePath), "utf8")) as JsonRecord;
}

function readRun(status: string): JsonRecord {
	return readFixtureJson(`v2/${status}/run.json`);
}

function readEvents(status: string): JsonRecord[] {
	return readFileSync(join(v2FixtureRoot, status, "events.jsonl"), "utf8")
		.trimEnd()
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as JsonRecord);
}

function assertExactRunKeys(run: JsonRecord): void {
	const actualKeys = Object.keys(run).sort();
	const keys = [...V2_RUN_KEYS].sort();
	if (JSON.stringify(actualKeys) !== JSON.stringify(keys)) {
		throw new Error(`run.json keys drifted: ${actualKeys.join(",")}`);
	}
}

function assertContiguousSequences(events: readonly JsonRecord[]): void {
	events.forEach((event, index) => {
		if (event.seq !== index) {
			throw new Error(`events.jsonl seq ${String(event.seq)} is not ${index}`);
		}
	});
}

function listFixtureText(relativeRoot: string): string[] {
	const root = join(fixtureRoot, relativeRoot);
	const entries = readdirSync(root, { withFileTypes: true });
	return entries.flatMap((entry) => {
		const relativePath = join(relativeRoot, entry.name);
		if (entry.isDirectory()) return listFixtureText(relativePath);
		return [readFileSync(join(fixtureRoot, relativePath), "utf8")];
	});
}

function listSourceText(relativeRoot: string = ""): string[] {
	const root = join(sourceRoot, relativeRoot);
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relativePath = join(relativeRoot, entry.name);
		if (entry.isDirectory()) return listSourceText(relativePath);
		if (relativePath === join("core", "autoresearch", "provenance.ts")) return [];
		return [readFileSync(join(sourceRoot, relativePath), "utf8")];
	});
}

function listTrackedPackageText(): string[] {
	const ignoredPaths = new Set([
		"packages/coding-agent/src/core/autoresearch/provenance.ts",
		"packages/coding-agent/test/autoresearch-provenance.test.ts",
		"packages/coding-agent/test/fixtures/autoresearch/clean-room-scan.json",
		"packages/coding-agent/THIRD_PARTY_NOTICE.md",
	]);
	const binaryExtensions = new Set([".png", ".wasm", ".zip"]);
	const trackedPaths = execFileSync("git", ["ls-files", "packages/coding-agent"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.filter((path) => path.length > 0 && !ignoredPaths.has(path));
	return trackedPaths.flatMap((path) => {
		const extension = path.slice(path.lastIndexOf("."));
		if (binaryExtensions.has(extension)) return [];
		return [readFileSync(resolve(repositoryRoot, path), "utf8")];
	});
}

describe("AutoResearch clean-room provenance and v2 fixtures", () => {
	it("testRecordsApprovedSourceLicenses", () => {
		expect(AUTO_RESEARCH_PROVENANCE).toEqual(expectedProvenance);
		expect(Object.isFrozen(AUTO_RESEARCH_PROVENANCE)).toBe(true);
		expect(Object.isFrozen(AUTO_RESEARCH_PROVENANCE[0])).toBe(true);
		expect(AUTO_RESEARCH_PROVENANCE[0]?.license).toBe("MIT");
		expect(AUTO_RESEARCH_PROVENANCE[0]?.copyright).toBe("Copyright (c) 2026 LLLLLe");
		expect(() => validateCleanRoomManifest()).not.toThrow();
	});

	it("testRecordsApprovalLocatorAndNoGrantDigests", () => {
		expect(AUTO_RESEARCH_PROVENANCE[0]?.approvalDigest).toBe(
			"1152a9410008de681627290161e3ebcae327108317d43b665e141d76b46195d0",
		);
		expect(AUTO_RESEARCH_PROVENANCE[1]?.treeDigest).toBe("516333967c2a0042922ce3e5b80f725debc138cb");
		expect(AUTO_RESEARCH_PROVENANCE[1]?.locatorDigest).toBe(
			"58ed3d5cb0d47dcae80abb128cef1c5cdd27097738180b9c5ffa5d612e34f676",
		);
		expect(AUTO_RESEARCH_PROVENANCE[1]?.noGrantScanDigest).toBe(
			"d26b07b0903fa71a792e9bfdd5b7b51678e3214a055e0f2d7bcb15fae6449572",
		);
	});

	it("testReadsCleanRoomScanArtifact", () => {
		const scan = readFixtureJson("clean-room-scan.json") as unknown as CleanRoomScanArtifact;
		expect(scan).toEqual(expectedScan);
		expect(() => validateCleanRoomManifest(AUTO_RESEARCH_PROVENANCE, scan)).not.toThrow();
	});

	it("testRejectsLinkedSourceTreeMaterial", () => {
		const generatedFixtureText = listFixtureText("v2").join("\n");
		const packageSourceText = [...listTrackedPackageText(), ...listSourceText()].join("\n");
		const cleanRoomText = `${packageSourceText}\n${generatedFixtureText}`;
		expect(cleanRoomText).not.toContain(expectedProvenance[1]!.commit);
		expect(cleanRoomText).not.toContain(expectedProvenance[1]!.treeDigest!);
		expect(cleanRoomText).not.toContain(expectedProvenance[1]!.locatorDigest!);
		expect(cleanRoomText).not.toContain("automatic prompt routing");
		expect(cleanRoomText).not.toContain("project diary/status churn");
		expect(listFixtureText("v2")).toHaveLength(16);
	});

	it("testActiveFixtureHasValidatedBaselinePrefix", () => {
		const run = readRun("active");
		const events = readEvents("active");
		assertExactRunKeys(run);
		assertContiguousSequences(events);
		expect(run.schema_version).toBe(2);
		expect(typeof run.run_id).toBe("string");
		expect(String(run.run_id)).not.toHaveLength(0);
		expect(events[0]).toMatchObject({ schema_version: 2, run_id: run.run_id, seq: 0, event: "baseline" });
		expect(events.some((event) => event.event === "candidate_started")).toBe(true);
		expect(events.some((event) => event.event === "candidate_resolved")).toBe(true);
	});

	it("testBudgetLimitedFixtureUsesNullCandidateCeiling", () => {
		const run = readRun("native-budget-limited");
		const events = readEvents("native-budget-limited");
		assertExactRunKeys(run);
		assertContiguousSequences(events);
		expect(run.max_candidates).toBeNull();
		expect(events.at(-1)).toMatchObject({ event: "stopped", reason: "budget_limited" });
	});

	it("testBaselineTargetFixtureHasRequiredCompleteLine", () => {
		const run = readRun("baseline-target");
		const events = readEvents("baseline-target");
		assertExactRunKeys(run);
		assertContiguousSequences(events);
		expect(events).toHaveLength(2);
		expect(events[0]).toMatchObject({ event: "baseline", seq: 0 });
		expect(events[1]).toMatchObject({ event: "complete", seq: 1, reason: "target reached" });
	});

	it("testCompleteFixtureHasOnlyOneTerminalEvent", () => {
		const events = readEvents("complete");
		assertContiguousSequences(events);
		const terminalEvents = events.filter((event) =>
			["blocked", "complete", "error", "stopped"].includes(String(event.event)),
		);
		expect(terminalEvents).toHaveLength(1);
		expect(terminalEvents[0]?.event).toBe("complete");
	});

	it("testRejectsTopLevelRunKeySetDrift", () => {
		expect(V2_RUN_KEYS).toHaveLength(14);
		expect([...V2_RUN_KEYS]).toEqual(expectedRunKeys);
		const run = readRun("active");
		expect(() => assertExactRunKeys({ ...run, unexpected: true })).toThrow(/keys drifted/);
	});

	it("testDuplicateSequenceFixtureIsRejected", () => {
		const events = readEvents("invalid-duplicate");
		expect(() => assertContiguousSequences(events)).toThrow(/seq 1 is not 2/);
	});

	it("testGapFixtureIsRejected", () => {
		const events = readEvents("invalid-gap");
		expect(() => assertContiguousSequences(events)).toThrow(/seq 4 is not 3/);
	});
});
