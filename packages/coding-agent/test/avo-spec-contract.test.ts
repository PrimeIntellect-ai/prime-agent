import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	AVO_SPEC_GATES,
	type AvoSpecRequirementDefinition,
	deriveAvoSpecRequirementImpacts,
	digestAvoSpecRequirement,
	digestAvoSpecSources,
	loadAndValidateAvoSpecContract,
	signAvoSpecReceipt,
	validateAvoSpecContract,
} from "../src/core/avo/spec-contract.js";
import { loadAvoSpecReceiptOverlay, parseAvoSpecRunnerArgs } from "../src/evals/spec-contract/runner.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECEIPT_KEY = "host-only-test-key-material-that-is-longer-than-thirty-two-bytes";

function fixtureRoot(): string {
	return mkdtempSync(join(tmpdir(), "prime-avo-spec-contract-"));
}

function completeObservedContract(root: string): Record<string, unknown> {
	const requirementId = "TEST-001";
	writeFileSync(join(root, "source.ts"), "export const behavior = true;\n", "utf8");
	const declarations = [
		["static", "compiler", "evidence/static.txt", `[${requirementId}] static`],
		["unit", "deterministic_unit_test", "evidence/unit.test.ts", `[${requirementId}] unit`],
		[
			"integration",
			"deterministic_integration_test",
			"evidence/integration.test.ts",
			`[${requirementId}] integration`,
		],
		["behavioral", "runtime_trace", "evidence/runtime-trace.json", `[${requirementId}] trace`],
		["adversarial", "fault_injection", "evidence/adversarial.test.ts", `[${requirementId}] fault`],
		["independent_review", "independent_review", "evidence/independent-review.md", `[${requirementId}] review`],
	] as const;
	mkdirSync(join(root, "evidence", "receipts"), { recursive: true });
	const sourceDigest = digestAvoSpecSources(root, ["source.ts"]);
	const evidence = declarations.map(([gate, mechanism, path, anchor], index) => {
		writeFileSync(join(root, path), `${anchor}\n`, "utf8");
		const evidenceId = `${requirementId}:evidence-${index + 1}`;
		const receiptPath = `evidence/receipts/receipt-${index + 1}.json`;
		const runtime = mechanism === "runtime_trace";
		const review = mechanism === "independent_review";
		const receipt: Record<string, unknown> = {
			schemaVersion: 1,
			receiptId: `receipt-${index + 1}`,
			requirementId,
			evidenceId,
			gate,
			mechanism,
			status: "pass",
			sourceDigest,
			command: `verify gate ${gate}`,
			startedAt: "2026-08-30T00:00:00.000Z",
			completedAt: "2026-08-30T00:00:01.000Z",
			satisfies: [requirementId],
			producer: {
				role: review
					? "independent_reviewer"
					: runtime
						? "runtime_host"
						: mechanism === "compiler"
							? "compiler"
							: "deterministic_test_runner",
				identity: review ? "reviewer-b" : `host-${gate}`,
				independentFromCandidateGenerator: review,
			},
			...(runtime ? { events: [{ event: "behavior_observed", satisfies: [requirementId] }] } : {}),
		};
		receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY);
		writeFileSync(join(root, receiptPath), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
		return { evidenceId, gate, state: "observed", mechanism, path, anchor, receiptPath };
	});
	const requirement = {
		id: requirementId,
		domain: "test",
		title: "Complete observed behavior",
		statement: "The host proves a behavior through heterogeneous evidence.",
		critical: true,
		behaviors: {
			normal: "The behavior succeeds.",
			failure: "The behavior fails closed.",
			ordering: "Verification precedes acceptance.",
			authority: "The host owns the verdict.",
			persistence: "The receipt binds to current sources.",
		},
		sourcePaths: ["source.ts"],
		requiredGates: [...AVO_SPEC_GATES],
		requiresRuntimeTrace: true,
		declaredStatus: "verified",
		evidence,
	} as AvoSpecRequirementDefinition;
	const contract = {
		schemaVersion: 1,
		contractId: "test-contract",
		protectedRoots: ["source.ts"],
		gateOrder: [...AVO_SPEC_GATES],
		requirements: [requirement],
	};
	const requirementDigest = digestAvoSpecRequirement(root, requirement);
	for (let index = 0; index < declarations.length; index += 1) {
		const receiptPath = join(root, `evidence/receipts/receipt-${index + 1}.json`);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		receipt.sourceDigest = requirementDigest;
		receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY);
		writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	}
	return contract;
}

describe("AVO executable behavioral contract", () => {
	test("keeps the repository contract honest about currently unobserved gates", () => {
		const report = loadAndValidateAvoSpecContract("packages/coding-agent/spec/requirements.json", REPOSITORY_ROOT);
		expect(report.valid).toBe(true);
		expect(report.summary).toMatchObject({ total: 10, verified: 0, partial: 10, unproven: 0 });
		expect(report.requirements.every((requirement) => requirement.missingObservedGates.length === 6)).toBe(true);
	});

	test("[SPEC-001] accepts verified only with six current receipts, a host trace, and independent review", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const report = validateAvoSpecContract(contract, root, { receiptHmacKey: RECEIPT_KEY });
		expect(report.errors).toEqual([]);
		expect(report.summary).toEqual({ total: 1, unproven: 0, partial: 0, verified: 1 });
		expect(report.requirements[0]).toMatchObject({
			id: "TEST-001",
			derivedStatus: "verified",
			runtimeTraceObserved: true,
			independentReviewObserved: true,
		});
	});

	test("[SPEC-001] rejects self-review, stale semantics, forged receipts, and path escapes", () => {
		const selfReviewRoot = fixtureRoot();
		const selfReviewed = completeObservedContract(selfReviewRoot);
		const selfReviewReceipt = join(selfReviewRoot, "evidence/receipts/receipt-6.json");
		const forged = JSON.parse(readFileSync(selfReviewReceipt, "utf8")) as Record<string, unknown>;
		forged.producer = {
			role: "deterministic_test_runner",
			identity: "candidate-generator",
			independentFromCandidateGenerator: false,
		};
		forged.signature = signAvoSpecReceipt(forged, RECEIPT_KEY);
		writeFileSync(selfReviewReceipt, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
		const selfReviewReport = validateAvoSpecContract(selfReviewed, selfReviewRoot, {
			receiptHmacKey: RECEIPT_KEY,
		});
		expect(selfReviewReport.valid).toBe(false);
		expect(selfReviewReport.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("review is not independent"),
				expect.stringContaining("overstates verified but current evidence derives partial"),
			]),
		);

		const staleRoot = fixtureRoot();
		const stale = completeObservedContract(staleRoot);
		writeFileSync(join(staleRoot, "source.ts"), "export const behavior = false;\n", "utf8");
		const staleReport = validateAvoSpecContract(stale, staleRoot, { receiptHmacKey: RECEIPT_KEY });
		expect(staleReport.valid).toBe(false);
		expect(staleReport.errors).toEqual(expect.arrayContaining([expect.stringContaining("receipt is stale")]));

		const weakenedRoot = fixtureRoot();
		const weakened = completeObservedContract(weakenedRoot);
		(weakened.requirements as Array<Record<string, unknown>>)[0]!.statement = "Any result is acceptable.";
		const weakenedReport = validateAvoSpecContract(weakened, weakenedRoot, { receiptHmacKey: RECEIPT_KEY });
		expect(weakenedReport.valid).toBe(false);
		expect(weakenedReport.errors).toEqual(expect.arrayContaining([expect.stringContaining("receipt is stale")]));

		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const withoutHostKey = validateAvoSpecContract(contract, root);
		expect(withoutHostKey.valid).toBe(false);
		expect(withoutHostKey.summary.verified).toBe(0);
		expect(withoutHostKey.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("cannot be trusted without the host spec-receipt HMAC key")]),
		);

		const wrongHostKey = validateAvoSpecContract(contract, root, { receiptHmacKey: "x".repeat(64) });
		expect(wrongHostKey.valid).toBe(false);
		expect(wrongHostKey.errors).toEqual(expect.arrayContaining([expect.stringContaining("invalid host signature")]));

		const symlinkRoot = fixtureRoot();
		const symlinkContract = completeObservedContract(symlinkRoot);
		const outsideRoot = fixtureRoot();
		const outside = join(outsideRoot, "forged-unit.test.ts");
		writeFileSync(outside, "[TEST-001] unit\n", "utf8");
		const unitPath = join(symlinkRoot, "evidence/unit.test.ts");
		unlinkSync(unitPath);
		symlinkSync(outside, unitPath);

		const symlinkReport = validateAvoSpecContract(symlinkContract, symlinkRoot, { receiptHmacKey: RECEIPT_KEY });
		expect(symlinkReport.valid).toBe(false);
		expect(symlinkReport.summary.verified).toBe(0);
		expect(symlinkReport.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("references missing or unsafe file evidence/unit.test.ts")]),
		);
	});

	test("[SPEC-001] promotes linked evidence only through a trusted external receipt overlay", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const receipts: Record<string, unknown> = {};
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		for (const evidence of requirement.evidence) {
			receipts[evidence.evidenceId] = JSON.parse(readFileSync(join(root, evidence.receiptPath!), "utf8"));
			evidence.state = "linked";
			delete evidence.receiptPath;
		}

		const report = validateAvoSpecContract(contract, root, {
			receiptHmacKey: RECEIPT_KEY,
			receipts,
		});
		expect(report.valid).toBe(true);
		expect(report.summary.verified).toBe(1);
		const loaded = loadAvoSpecReceiptOverlay(join(root, "evidence/receipts"));
		expect(loaded.errors).toEqual([]);
		expect(Object.keys(loaded.receipts)).toHaveLength(6);
		expect(parseAvoSpecRunnerArgs(["--changed", "a.ts,b.ts", "--changed", "c.ts", "--enforce"])).toMatchObject({
			changedPaths: ["a.ts", "b.ts", "c.ts"],
			enforce: true,
		});
		expect(() => parseAvoSpecRunnerArgs(["--enforce"])).toThrow(/requires at least one --changed path/);
	});

	test("maps changed protected files to requirements and exposes unmapped implementation paths", () => {
		const contract = JSON.parse(
			readFileSync(join(REPOSITORY_ROOT, "packages/coding-agent/spec/requirements.json"), "utf8"),
		) as unknown;
		const impact = deriveAvoSpecRequirementImpacts(contract, [
			"packages/coding-agent/src/core/avo/store.ts",
			"packages/coding-agent/src/core/avo/spec-contract.ts",
			"packages/coding-agent/src/core/avo/obligations.ts",
			"README.md",
		]);
		expect(impact.errors).toEqual([]);
		expect(impact.affectedRequirementIds).toEqual(
			expect.arrayContaining(["AUTH-001", "MEM-001", "MEM-002", "LIFE-001", "SPEC-001"]),
		);
		expect(impact.unmappedProtectedPaths).toEqual(["packages/coding-agent/src/core/avo/obligations.ts"]);
		expect(deriveAvoSpecRequirementImpacts(contract, ["../escaped.ts"]).errors).toEqual([
			"unsafe changed path: ../escaped.ts",
		]);
	});
});
