import { describe, expect, it } from "vitest";
import type {
	CandidatePathBoundary,
	ChangedPathAllowlist,
	DurableDecisionRef,
	WorkflowEpochRef,
	WorkflowKnowledgeCommitRef,
	WorkflowMetricRunRecord,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	workflowMetricRunBindingDigest,
} from "../src/core/workflow/contracts.js";

describe("workflow canonical contracts", () => {
	it("canonicalizes object keys independently of insertion order", () => {
		const left = canonicalJsonBytes({ z: 1, a: { d: true, c: false } });
		const right = canonicalJsonBytes({ a: { c: false, d: true }, z: 1 });

		expect(Array.from(left)).toEqual(Array.from(right));
		expect(digestObject({ z: 1, a: { d: true, c: false } })).toBe(digestObject({ a: { c: false, d: true }, z: 1 }));
	});

	it("normalizes line endings and preserves explicit empty fields", () => {
		expect(new TextDecoder().decode(canonicalJsonBytes({ text: "a\r\nb\rc", empty: "" }))).toBe(
			'{"empty":"","text":"a\\nb\\nc"}',
		);
	});

	it("rejects duplicate keys before object creation", () => {
		expect(() => parseCanonicalJsonBytes(new TextEncoder().encode('{"duplicate":1,"duplicate":2}'))).toThrow(
			/duplicate/i,
		);
	});

	it("rejects duplicate keys nested inside an object", () => {
		expect(() =>
			parseCanonicalJsonBytes(new TextEncoder().encode('{"outer":{"duplicate":1,"duplicate":2}}')),
		).toThrow(/duplicate/i);
	});

	it("rejects malformed UTF-8 bytes", () => {
		expect(() => parseCanonicalJsonBytes(new Uint8Array([0x22, 0xc3, 0x28, 0x22]))).toThrow(/UTF-8/i);
	});

	it("rejects a valid value followed by a trailing token", () => {
		expect(() => parseCanonicalJsonBytes(new TextEncoder().encode("true false"))).toThrow(/trailing/i);
	});

	it("rejects non-canonical whitespace", () => {
		expect(() => parseCanonicalJsonBytes(new TextEncoder().encode('{"value": 1}'))).toThrow(/canonical/i);
	});

	it("preserves a canonical __proto__ data property without mutating Object.prototype", () => {
		const bytes = new TextEncoder().encode('{"__proto__":{"safe":true}}');
		const parsed = parseCanonicalJsonBytes(bytes);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new Error("Expected a canonical object.");

		expect(Object.getPrototypeOf(parsed)).toBeNull();
		expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
		expect(Reflect.get(parsed, "__proto__")).toEqual({ safe: true });
		expect(Object.hasOwn(Object.prototype, "safe")).toBe(false);
		expect(Array.from(canonicalJsonBytes(parsed))).toEqual(Array.from(bytes));
	});

	it("rejects unsupported numeric forms and values", () => {
		expect(() => parseCanonicalJsonBytes(new TextEncoder().encode("01"))).toThrow();
		expect(() => canonicalJsonBytes({ value: Number.NaN })).toThrow();
		expect(() => canonicalJsonBytes({ value: undefined })).toThrow();
		expect(() => canonicalJsonBytes({ value: 1n })).toThrow();
		const sparse: string[] = [];
		sparse.length = 1;
		expect(() => canonicalJsonBytes(sparse)).toThrow(/sparse/i);
	});

	it("round-trips canonical JSON and hashes UTF-8 bytes", () => {
		const bytes = canonicalJsonBytes({ empty: [], nested: { value: "ok" } });
		const parsed = parseCanonicalJsonBytes(bytes);

		expect(new TextDecoder().decode(canonicalJsonBytes(parsed))).toBe(new TextDecoder().decode(bytes));
		expect(sha256Hex(bytes)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("binds every metric input and measurement field into the host receipt digest", () => {
		const evidenceRef = {
			artifactId: "evidence-1",
			relativePath: "evidence/evidence-1",
			digest: "evidence-digest",
			sizeBytes: 1,
			sourceEventSequence: 1,
		};
		const run: Omit<WorkflowMetricRunRecord, "hostReceipt" | "trustedClockReceipt"> = {
			workflowId: "workflow-1",
			evaluationId: "evaluation-1",
			hostExecutionId: "execution-1",
			metricId: "metric-1",
			runIndex: 1,
			inputPartition: "declared",
			inputDigest: "input-digest",
			approvedClosureDigest: "closure-digest",
			scorecardDigest: "scorecard-digest",
			baselineDigest: "baseline-digest",
			observedValue: 1,
			measurementCommandDigest: "command-digest",
			parserDigest: "parser-digest",
			evaluatorDigest: "evaluator-digest",
			evidenceRef,
			determinismEvidenceRefs: [evidenceRef],
			falsificationEvidenceRefs: [evidenceRef],
			attackEvidenceRefs: [evidenceRef],
			guardEvidenceRefs: [evidenceRef],
		};
		const metric = { requirementId: "requirement-1" };
		const bindingDigest = workflowMetricRunBindingDigest(run, metric);

		expect(workflowMetricRunBindingDigest({ ...run, inputPartition: "held_out" }, metric)).not.toBe(bindingDigest);
		expect(workflowMetricRunBindingDigest({ ...run, inputDigest: "other-input" }, metric)).not.toBe(bindingDigest);
		expect(workflowMetricRunBindingDigest({ ...run, observedValue: 2 }, metric)).not.toBe(bindingDigest);
		expect(workflowMetricRunBindingDigest(run, { requirementId: "other-requirement" })).not.toBe(bindingDigest);
		expect(workflowMetricRunBindingDigest({ ...run, measurementCommandDigest: "other-command" }, metric)).not.toBe(
			bindingDigest,
		);
		expect(workflowMetricRunBindingDigest({ ...run, parserDigest: "other-parser" }, metric)).not.toBe(bindingDigest);
		expect(workflowMetricRunBindingDigest({ ...run, evaluatorDigest: "other-evaluator" }, metric)).not.toBe(
			bindingDigest,
		);
	});

	it("exposes the exact cross-store knowledge commit reference fields", () => {
		const epochRef: WorkflowEpochRef = { storeEpoch: 4, coordinatorEpoch: 7 };
		const decisionRef: DurableDecisionRef = {
			decisionScope: { kind: "knowledge", namespace: "knowledge-store" },
			decisionId: "decision-1",
			revision: 2,
			storeEpoch: 4,
			decisionDigest: "decision-digest",
		};
		const commitRef: WorkflowKnowledgeCommitRef = {
			knowledgeStoreId: "knowledge-store",
			workflowEpochRef: epochRef,
			knowledgeStoreEpoch: 9,
			proposalId: "proposal-1",
			decisionRef,
			knowledgeJournalSequence: 12,
			knowledgeJournalDigest: "journal-digest",
			transactionDigest: "transaction-digest",
		};

		expect(commitRef.workflowEpochRef).toEqual(epochRef);
		expect(digestObject(commitRef)).not.toBe(digestObject({ ...commitRef, transactionDigest: "changed" }));
		expect(digestObject(commitRef)).not.toBe(
			digestObject({ ...commitRef, decisionRef: { ...decisionRef, decisionDigest: "changed" } }),
		);
	});

	it("keeps candidate path and changed-path boundaries as closed typed records", () => {
		const boundary: CandidatePathBoundary = {
			repositoryRoot: "/repo",
			primaryCheckoutRealPath: "/repo",
			primaryGitRealPath: "/repo/.git",
			externalWorktreeRoot: "/tmp/worktrees",
			allowedRepoRelativePrefixes: ["src/"],
			excludedRealPaths: ["/repo/.git", "/repo/evaluator"],
			excludedKinds: ["evaluator", "out_of_scope"],
			preSnapshotDigest: "before",
			postSnapshotDigest: null,
		};
		const allowlist: ChangedPathAllowlist = {
			worktreeRealPath: "/tmp/worktrees/candidate-1",
			allowedRepoRelativePrefixes: ["src/"],
			changedPaths: ["src/index.ts"],
			excludedPaths: [".git"],
			symlinkEscapes: [],
			hardlinkEscapes: [],
			violation: null,
		};

		expect(boundary.postSnapshotDigest).toBeNull();
		expect(allowlist.violation).toBeNull();
		expect(digestObject(boundary)).not.toBe(digestObject({ ...boundary, postSnapshotDigest: "after" }));
		expect(digestObject(allowlist)).not.toBe(digestObject({ ...allowlist, changedPaths: ["src/other.ts"] }));
	});
});
