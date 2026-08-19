export interface AutoResearchProvenanceRecord {
	source: "autoresearch-behavior" | "linked-workflow-design";
	commit: string;
	treeDigest: string | null;
	locatorDigest: string | null;
	approvalDigest: string | null;
	noGrantScanDigest: string | null;
	license: string;
	copyright: string | null;
	reuse: "behavioral-notes-and-fixtures-only" | "no-source-reuse";
}

export interface CleanRoomScanArtifact {
	sourceCommit: string;
	linkedTreeDigest: string;
	linkedLocatorDigest: string;
	approvalDigest: string;
	noGrantScanDigest: string;
	trackedForbiddenPaths: readonly string[];
	forbiddenTextMatches: readonly string[];
	result: "clean" | "violation";
}

const EXPECTED_PROVENANCE_KEYS = [
	"source",
	"commit",
	"treeDigest",
	"locatorDigest",
	"approvalDigest",
	"noGrantScanDigest",
	"license",
	"copyright",
	"reuse",
] as const;

const EXPECTED_SCAN_KEYS = [
	"sourceCommit",
	"linkedTreeDigest",
	"linkedLocatorDigest",
	"approvalDigest",
	"noGrantScanDigest",
	"trackedForbiddenPaths",
	"forbiddenTextMatches",
	"result",
] as const;

const EXPECTED_PROVENANCE: readonly AutoResearchProvenanceRecord[] = Object.freeze(
	(
		[
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
		] as const
	).map((record) => Object.freeze(record)),
);

export const AUTO_RESEARCH_PROVENANCE: readonly AutoResearchProvenanceRecord[] = Object.freeze(
	EXPECTED_PROVENANCE.map((record) => Object.freeze({ ...record })),
);

export const AUTO_RESEARCH_THIRD_PARTY_NOTICE_BLOCK = `Native AutoResearch behavioral compatibility
Copyright (c) 2026 LLLLLe
Source commit: 95e2fa1189f08ce694eb1a2b3e85d4bf58d3cfbf
License: MIT
Use: independently authored implementation with compatibility fixtures only.

Linked workflow design evidence
Source commit: e6c899ffd82d7d32aa9f93f0986a402add47c32d
Tree digest: 516333967c2a0042922ce3e5b80f725debc138cb
Locator digest: 58ed3d5cb0d47dcae80abb128cef1c5cdd27097738180b9c5ffa5d612e34f676
No-grant scan digest: d26b07b0903fa71a792e9bfdd5b7b51678e3214a055e0f2d7bcb15fae6449572
License: no license or notice found
Use: no source, prompt, template, generated configuration, distinctive text, or path reuse.`;

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
	return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}

function validateProvenanceRecord(record: AutoResearchProvenanceRecord, index: number): void {
	if (!sameKeys(Object.keys(record), EXPECTED_PROVENANCE_KEYS)) {
		throw new Error(`provenance record ${index} has unexpected fields`);
	}

	const expected = EXPECTED_PROVENANCE[index];
	if (
		expected === undefined ||
		record.source !== expected.source ||
		record.commit !== expected.commit ||
		record.treeDigest !== expected.treeDigest ||
		record.locatorDigest !== expected.locatorDigest ||
		record.approvalDigest !== expected.approvalDigest ||
		record.noGrantScanDigest !== expected.noGrantScanDigest ||
		record.license !== expected.license ||
		record.copyright !== expected.copyright ||
		record.reuse !== expected.reuse
	) {
		throw new Error(`provenance record ${index} does not match the approved manifest`);
	}
}

function validateScanArtifact(scan: CleanRoomScanArtifact): void {
	if (!sameKeys(Object.keys(scan), EXPECTED_SCAN_KEYS)) {
		throw new Error("clean-room scan has unexpected fields");
	}
	if (scan.sourceCommit !== EXPECTED_PROVENANCE[0]!.commit) {
		throw new Error("clean-room scan source commit does not match the approved manifest");
	}
	if (
		scan.linkedTreeDigest !== EXPECTED_PROVENANCE[1]!.treeDigest ||
		scan.linkedLocatorDigest !== EXPECTED_PROVENANCE[1]!.locatorDigest ||
		scan.noGrantScanDigest !== EXPECTED_PROVENANCE[1]!.noGrantScanDigest ||
		scan.approvalDigest !== EXPECTED_PROVENANCE[0]!.approvalDigest
	) {
		throw new Error("clean-room scan digests do not match the approved manifest");
	}
	if (scan.trackedForbiddenPaths.length !== 0 || scan.forbiddenTextMatches.length !== 0 || scan.result !== "clean") {
		throw new Error("clean-room scan reports forbidden material");
	}
}

export function validateCleanRoomManifest(
	manifest: readonly AutoResearchProvenanceRecord[] = AUTO_RESEARCH_PROVENANCE,
	scan?: CleanRoomScanArtifact,
): void {
	if (manifest.length !== EXPECTED_PROVENANCE.length) {
		throw new Error("clean-room provenance manifest must contain exactly two records");
	}
	manifest.forEach(validateProvenanceRecord);
	if (scan !== undefined) validateScanArtifact(scan);
}
