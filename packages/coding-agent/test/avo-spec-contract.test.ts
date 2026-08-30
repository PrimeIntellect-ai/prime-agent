import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
	AVO_SPEC_GATES,
	type AvoSpecRequirementDefinition,
	applyAvoSpecContractStopGate,
	assertAvoSpecReceiptTrustConfiguration,
	captureAvoSpecContractBaseline,
	deriveAvoSpecRequirementImpacts,
	deriveAvoSpecSemanticCoverage,
	digestAvoSpecRequirement,
	digestAvoSpecSources,
	loadAndValidateAvoSpecContract,
	loadAvoSpecReceiptOverlay,
	signAvoSpecReceipt,
	validateAvoSpecContract,
} from "../src/core/avo/spec-contract.js";
import { AvoStore } from "../src/core/avo/store.js";
import { captureAvoCodingVerificationBaseline, captureAvoWorkspaceSnapshot } from "../src/core/avo/workspace.js";
import { parseAvoSpecRunnerArgs } from "../src/evals/spec-contract/runner.js";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECEIPT_KEY_PAIR = generateKeyPairSync("ed25519");
const WRONG_RECEIPT_KEY_PAIR = generateKeyPairSync("ed25519");
const RECEIPT_PUBLIC_KEY = RECEIPT_KEY_PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();
const WRONG_RECEIPT_PUBLIC_KEY = WRONG_RECEIPT_KEY_PAIR.publicKey.export({ type: "spki", format: "pem" }).toString();
const RECEIPT_BINDING = {
	runId: "spec-test-run",
	workspaceDigest: "a".repeat(64),
	contractDigest: "b".repeat(64),
};

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
			schemaVersion: 2,
			receiptId: `receipt-${index + 1}`,
			...RECEIPT_BINDING,
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
		receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY_PAIR.privateKey);
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
		receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY_PAIR.privateKey);
		writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
	}
	return contract;
}

function refreshFixtureReceipts(root: string, requirement: AvoSpecRequirementDefinition): Record<string, unknown> {
	const receipts: Record<string, unknown> = {};
	const sourceDigest = digestAvoSpecRequirement(root, requirement);
	for (let index = 0; index < requirement.evidence.length; index += 1) {
		const evidence = requirement.evidence[index]!;
		const receiptPath = join(root, `evidence/receipts/receipt-${index + 1}.json`);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
		receipt.sourceDigest = sourceDigest;
		receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY_PAIR.privateKey);
		writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
		receipts[evidence.evidenceId] = receipt;
	}
	return receipts;
}

describe("AVO executable behavioral contract", () => {
	test("[AUTH-001] accepts only public-key verification and rejects the retired shared-secret trust root", () => {
		const receipt: Record<string, unknown> = { evidenceId: "AUTH-001:test", status: "pass" };
		expect(signAvoSpecReceipt(receipt, RECEIPT_KEY_PAIR.privateKey)).toMatch(/^ed25519:[A-Za-z0-9_-]{86}$/);
		expect(() =>
			assertAvoSpecReceiptTrustConfiguration({ PRIME_AGENT_AVO_SPEC_RECEIPT_KEY: "same-user-secret" }),
		).toThrow(/insecure with model-controlled same-user tools/);
		expect(() =>
			assertAvoSpecReceiptTrustConfiguration({
				PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY: "public material is not a signing secret",
			}),
		).not.toThrow();
	});

	test("keeps the repository contract honest about currently unobserved gates", () => {
		const report = loadAndValidateAvoSpecContract("packages/coding-agent/spec/requirements.json", REPOSITORY_ROOT);
		expect(report.valid).toBe(true);
		expect(report.summary).toMatchObject({ total: 10, verified: 0, partial: 10, unproven: 0 });
		expect(report.requirements.every((requirement) => requirement.missingObservedGates.length === 6)).toBe(true);
	});

	test("[SPEC-001] captures an immutable task-start contract before candidate edits", () => {
		const root = fixtureRoot();
		mkdirSync(join(root, "spec"), { recursive: true });
		const contract = completeObservedContract(root);
		for (const requirement of contract.requirements as AvoSpecRequirementDefinition[]) {
			requirement.declaredStatus = "partial";
			for (const evidence of requirement.evidence) {
				evidence.state = "linked";
				delete evidence.receiptPath;
			}
		}
		const contractPath = join(root, "spec/requirements.json");
		const originalContent = `${JSON.stringify(contract, null, 2)}\n`;
		writeFileSync(contractPath, originalContent, "utf8");

		const baseline = captureAvoSpecContractBaseline(root, "2026-08-30T00:00:00.000Z");
		expect(baseline).toMatchObject({
			contractPath: "spec/requirements.json",
			contractContent: originalContent,
			capturedAt: "2026-08-30T00:00:00.000Z",
		});
		expect(baseline?.contractDigest).toMatch(/^[a-f0-9]{64}$/);

		writeFileSync(contractPath, `${JSON.stringify({ ...contract, contractId: "candidate-weakened" })}\n`, "utf8");
		expect(baseline?.contractContent).toBe(originalContent);
	});

	test("[SPEC-001] passes the live gate only for the exact signed task, workspace, and contract", () => {
		const root = fixtureRoot();
		mkdirSync(join(root, "spec"), { recursive: true });
		const contract = completeObservedContract(root);
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		requirement.declaredStatus = "partial";
		for (const evidence of requirement.evidence) {
			evidence.state = "linked";
			delete evidence.receiptPath;
		}
		writeFileSync(join(root, "spec/requirements.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");
		const baseline = captureAvoCodingVerificationBaseline(root, "Improve source behavior");
		baseline.specContract = captureAvoSpecContractBaseline(root, baseline.capturedAt, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
		});
		expect(baseline.specContract).toBeDefined();
		expect(baseline.specContract?.receiptPublicKeyDigest).toMatch(/^[a-f0-9]{64}$/);

		const store = new AvoStore(undefined, "live-spec-session", () => "2026-08-30T00:00:00.000Z", root);
		store.initialize("Improve source behavior");
		store.setEnvironment("coding");
		store.setVerificationBaseline(baseline);
		writeFileSync(join(root, "source.ts"), "export const behavior = 'improved';\n", "utf8");
		const workspace = captureAvoWorkspaceSnapshot(root);
		const binding = {
			runId: store.getState().runId,
			workspaceDigest: workspace.digest,
			contractDigest: baseline.specContract!.contractDigest,
		};
		const overlayDir = fixtureRoot();
		const sourceDigest = digestAvoSpecRequirement(root, requirement);
		for (let index = 0; index < requirement.evidence.length; index += 1) {
			const original = JSON.parse(
				readFileSync(join(root, `evidence/receipts/receipt-${index + 1}.json`), "utf8"),
			) as Record<string, unknown>;
			const receipt: Record<string, unknown> = { ...original, ...binding, sourceDigest };
			receipt.signature = signAvoSpecReceipt(receipt, RECEIPT_KEY_PAIR.privateKey);
			writeFileSync(join(overlayDir, `receipt-${index + 1}.json`), `${JSON.stringify(receipt)}\n`, "utf8");
		}

		const gate = applyAvoSpecContractStopGate(
			store.getState(),
			{ passed: true, checks: [], reasons: [] },
			{
				cwd: root,
				receiptDirectory: overlayDir,
				receiptPublicKey: RECEIPT_PUBLIC_KEY,
			},
		);
		expect(gate).toMatchObject({
			passed: true,
			checks: expect.arrayContaining([
				expect.objectContaining({ id: "spec_trust_root", passed: true }),
				expect.objectContaining({ id: "spec_requirement:TEST-001", passed: true }),
				expect.objectContaining({ id: "spec_workspace_stability", passed: true }),
			]),
		});

		const substitutedVerifierGate = applyAvoSpecContractStopGate(
			store.getState(),
			{ passed: true, checks: [], reasons: [] },
			{
				cwd: root,
				receiptDirectory: overlayDir,
				receiptPublicKey: WRONG_RECEIPT_PUBLIC_KEY,
			},
		);
		expect(substitutedVerifierGate.passed).toBe(false);
		expect(substitutedVerifierGate.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "spec_trust_root",
					passed: false,
					reason: expect.stringContaining("changed after task start"),
				}),
			]),
		);
	});

	test("[SPEC-001] accepts verified only with six current receipts, a host trace, and independent review", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const report = validateAvoSpecContract(contract, root, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
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
		forged.signature = signAvoSpecReceipt(forged, RECEIPT_KEY_PAIR.privateKey);
		writeFileSync(selfReviewReceipt, `${JSON.stringify(forged, null, 2)}\n`, "utf8");
		const selfReviewReport = validateAvoSpecContract(selfReviewed, selfReviewRoot, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(selfReviewReport.valid).toBe(false);
		expect(selfReviewReport.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("cannot issue independent_review evidence"),
				expect.stringContaining("overstates verified but current evidence derives partial"),
			]),
		);

		const staleRoot = fixtureRoot();
		const stale = completeObservedContract(staleRoot);
		writeFileSync(join(staleRoot, "source.ts"), "export const behavior = false;\n", "utf8");
		const staleReport = validateAvoSpecContract(stale, staleRoot, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(staleReport.valid).toBe(false);
		expect(staleReport.errors).toEqual(expect.arrayContaining([expect.stringContaining("receipt is stale")]));

		const weakenedRoot = fixtureRoot();
		const weakened = completeObservedContract(weakenedRoot);
		(weakened.requirements as Array<Record<string, unknown>>)[0]!.statement = "Any result is acceptable.";
		const weakenedReport = validateAvoSpecContract(weakened, weakenedRoot, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(weakenedReport.valid).toBe(false);
		expect(weakenedReport.errors).toEqual(expect.arrayContaining([expect.stringContaining("receipt is stale")]));

		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const withoutHostKey = validateAvoSpecContract(contract, root, { receiptBinding: RECEIPT_BINDING });
		expect(withoutHostKey.valid).toBe(false);
		expect(withoutHostKey.summary.verified).toBe(0);
		expect(withoutHostKey.errors).toEqual(
			expect.arrayContaining([
				expect.stringContaining("cannot be trusted without the independent spec-receipt public key"),
			]),
		);

		const wrongHostKey = validateAvoSpecContract(contract, root, {
			receiptPublicKey: WRONG_RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(wrongHostKey.valid).toBe(false);
		expect(wrongHostKey.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("invalid independent signature")]),
		);

		const replayRoot = fixtureRoot();
		const replayed = completeObservedContract(replayRoot);
		const replayReport = validateAvoSpecContract(replayed, replayRoot, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: { ...RECEIPT_BINDING, runId: "different-task-run" },
		});
		expect(replayReport.valid).toBe(false);
		expect(replayReport.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("bound to a different task or workspace")]),
		);

		const symlinkRoot = fixtureRoot();
		const symlinkContract = completeObservedContract(symlinkRoot);
		const outsideRoot = fixtureRoot();
		const outside = join(outsideRoot, "forged-unit.test.ts");
		writeFileSync(outside, "[TEST-001] unit\n", "utf8");
		const unitPath = join(symlinkRoot, "evidence/unit.test.ts");
		unlinkSync(unitPath);
		symlinkSync(outside, unitPath);

		const symlinkReport = validateAvoSpecContract(symlinkContract, symlinkRoot, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
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
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receipts,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(report.valid).toBe(true);
		expect(report.summary.verified).toBe(1);
		const loaded = loadAvoSpecReceiptOverlay(join(root, "evidence/receipts"));
		expect(loaded.errors).toEqual([]);
		expect(Object.keys(loaded.receipts)).toHaveLength(6);
		expect(
			parseAvoSpecRunnerArgs(["--changed", "a.ts,b.ts", "--changed", "c.ts", "--run-id", "task-7", "--enforce"]),
		).toMatchObject({
			changedPaths: ["a.ts", "b.ts", "c.ts"],
			runId: "task-7",
			enforce: true,
		});
		expect(() => parseAvoSpecRunnerArgs(["--enforce"])).toThrow(/requires at least one --changed path/);
	});

	test("[SPEC-001] invalidates signed receipts when linked evidence content changes but its anchor remains", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		writeFileSync(
			join(root, "evidence/unit.test.ts"),
			"[TEST-001] unit\nexport const weakenedAssertion = true;\n",
			"utf8",
		);

		const report = validateAvoSpecContract(contract, root, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(report.valid).toBe(false);
		expect(report.summary.verified).toBe(0);
		expect(report.errors).toEqual(expect.arrayContaining([expect.stringContaining("receipt is stale")]));
	});

	test("[SPEC-001] does not promote a prose-only planned declaration through an external receipt", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		requirement.declaredStatus = "partial";
		for (const evidence of requirement.evidence) {
			evidence.state = "linked";
			delete evidence.receiptPath;
		}
		const planned = requirement.evidence.find((evidence) => evidence.gate === "integration")!;
		planned.state = "planned";
		planned.plan = "A future independent integration verifier must exercise this boundary.";
		delete planned.path;
		delete planned.anchor;
		const receipts = refreshFixtureReceipts(root, requirement);

		const report = validateAvoSpecContract(contract, root, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receipts,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(report.valid).toBe(false);
		expect(report.errors).toEqual(
			expect.arrayContaining([expect.stringContaining("cannot be promoted by a receipt")]),
		);
		expect(report.summary).toEqual({ total: 1, unproven: 0, partial: 1, verified: 0 });
		expect(report.requirements[0]).toMatchObject({
			observedGates: expect.not.arrayContaining(["integration"]),
			missingObservedGates: expect.arrayContaining(["integration"]),
		});
	});

	test("[SPEC-001] permits heterogeneous six-gate proof colocated in three content-bound files", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		const proofPaths = ["evidence/proof-a.txt", "evidence/proof-b.txt", "evidence/proof-c.txt"];
		const proofContents = new Map(proofPaths.map((path) => [path, [] as string[]]));
		for (let index = 0; index < requirement.evidence.length; index += 1) {
			const evidence = requirement.evidence[index]!;
			const path = proofPaths[Math.floor(index / 2)]!;
			const anchor = `[TEST-001] ${evidence.gate} proof`;
			evidence.path = path;
			evidence.anchor = anchor;
			proofContents.get(path)!.push(anchor);
		}
		for (const [path, anchors] of proofContents) {
			writeFileSync(join(root, path), `${anchors.join("\n")}\n`, "utf8");
		}
		refreshFixtureReceipts(root, requirement);

		const report = validateAvoSpecContract(contract, root, {
			receiptPublicKey: RECEIPT_PUBLIC_KEY,
			receiptBinding: RECEIPT_BINDING,
		});
		expect(new Set(requirement.evidence.map((evidence) => evidence.mechanism)).size).toBeGreaterThanOrEqual(5);
		expect(new Set(requirement.evidence.map((evidence) => evidence.path)).size).toBe(3);
		expect(report.errors).toEqual([]);
		expect(report.summary).toEqual({ total: 1, unproven: 0, partial: 0, verified: 1 });
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

	test("[SPEC-001] covers Python semantics only when every path is protected and exactly mapped", () => {
		const root = fixtureRoot();
		const contract = completeObservedContract(root);
		contract.protectedRoots = ["src"];
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		requirement.sourcePaths = ["src/mapped.py"];

		expect(deriveAvoSpecSemanticCoverage(contract, ["outside.py"])).toMatchObject({
			affectedRequirementIds: [],
			coveredPaths: [],
			uncoveredPaths: ["outside.py"],
			errors: [],
		});
		expect(deriveAvoSpecSemanticCoverage(contract, ["src/unmapped.py"])).toMatchObject({
			affectedRequirementIds: [],
			coveredPaths: [],
			uncoveredPaths: ["src/unmapped.py"],
			errors: [],
		});
		expect(deriveAvoSpecSemanticCoverage(contract, ["src/mapped.py"])).toMatchObject({
			affectedRequirementIds: ["TEST-001"],
			coveredPaths: ["src/mapped.py"],
			uncoveredPaths: [],
			errors: [],
		});
		expect(deriveAvoSpecSemanticCoverage(contract, ["outside.py", "src/mapped.py"])).toMatchObject({
			affectedRequirementIds: ["TEST-001"],
			coveredPaths: ["src/mapped.py"],
			uncoveredPaths: ["outside.py"],
			errors: [],
		});
	});

	test("[SPEC-001] fails the live gate for the exact uncovered Python path in a mixed change", () => {
		const root = fixtureRoot();
		mkdirSync(join(root, "spec"), { recursive: true });
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(join(root, "src/mapped.py"), "VALUE = 1\n", "utf8");
		writeFileSync(join(root, "outside.py"), "VALUE = 1\n", "utf8");
		const contract = completeObservedContract(root);
		contract.protectedRoots = ["src"];
		const requirement = (contract.requirements as AvoSpecRequirementDefinition[])[0]!;
		requirement.sourcePaths = ["src/mapped.py"];
		requirement.declaredStatus = "partial";
		for (const evidence of requirement.evidence) {
			evidence.state = "linked";
			delete evidence.receiptPath;
		}
		writeFileSync(join(root, "spec/requirements.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");

		const baseline = captureAvoCodingVerificationBaseline(root, "Improve the mapped Python behavior");
		baseline.specContract = captureAvoSpecContractBaseline(root, baseline.capturedAt);
		const store = new AvoStore(undefined, "mixed-python-spec-session", () => "2026-08-30T00:00:00.000Z", root);
		store.initialize("Improve the mapped Python behavior");
		store.setEnvironment("coding");
		store.setVerificationBaseline(baseline);
		writeFileSync(join(root, "src/mapped.py"), "VALUE = 2\n", "utf8");
		writeFileSync(join(root, "outside.py"), "VALUE = 2\n", "utf8");

		const gate = applyAvoSpecContractStopGate(
			store.getState(),
			{ passed: true, checks: [], reasons: [] },
			{ cwd: root },
		);
		expect(gate.passed).toBe(false);
		expect(gate.checks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: expect.stringMatching(/^spec_uncovered_python:/),
					passed: false,
					reason:
						"changed Python path is outside the protected contract or is not mapped to an executable invariant: outside.py",
				}),
			]),
		);
		expect(gate.checks).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: expect.stringMatching(/^spec_uncovered_python:/),
					reason: expect.stringContaining("src/mapped.py"),
				}),
			]),
		);
	});
});
