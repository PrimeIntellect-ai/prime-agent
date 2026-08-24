import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { expect, it } from "vitest";
import { emptyGoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	WORKFLOW_EVIDENCE_LIMITS,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactResolver,
	type WorkflowAttemptHandoff,
	type WorkflowBlockerClaim,
	type WorkflowBlockerRecord,
	type WorkflowDecisionRef,
	type WorkflowEvidenceEnvelope,
	type WorkflowEvidenceEnvelopeRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowProgressEntry,
	type WorkflowProgressLedger,
	type WorkflowRevisionTuple,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowEvidenceEnvelopeRefValidationInput,
	WorkflowEvidenceValidationCode,
	WorkflowEvidenceValidationInput,
	WorkflowProgressAuditArtifactPayload,
	WorkflowProgressAuditArtifactRef,
	WorkflowProgressAuditInput,
	WorkflowProgressAuditResult,
	WorkflowProgressHostAuthorizer,
	WorkflowProgressHostCommitInput,
	WorkflowProgressHostReceiptCommitPort,
	WorkflowProgressRuntimeSnapshot,
} from "../src/core/workflow/evidence.js";
import {
	acceptRequirementProgress,
	acceptRequirementProgressAtHost,
	computeWorkflowProgressAuditReceiptBinding,
	createWorkflowEvidenceValidator,
	createWorkflowProgressHostAuthorizer,
	issueWorkflowBlockerRecord,
	projectRequirementEvidence,
	resolveVerifiedWorkflowArtifact,
	validateWorkflowEvidenceEnvelopeRef,
} from "../src/core/workflow/evidence.js";
import { createPersistedSessionWorkflowHost } from "../src/core/workflow/session-host-factory.js";

const revisions: WorkflowRevisionTuple = {
	contractRevision: 1,
	scorecardRevision: 1,
	planRevision: 1,
	configRevision: 1,
	evidenceRevision: 1,
};

const artifactRef = {
	artifactId: "artifact-1",
	relativePath: "evidence/a",
	digest: sha256Hex(new Uint8Array([111, 107])),
	sizeBytes: 2,
	sourceEventSequence: 1,
};

function createEvidence(overrides: Partial<WorkflowEvidenceEnvelope> = {}): WorkflowEvidenceEnvelope {
	return {
		evidenceId: "evidence-1",
		evidenceRevision: 1,
		requirementId: "requirement-1",
		claim: "The bounded host check passed.",
		result: "exit-zero",
		method: "independent-integration-test",
		command: {
			commandDigest: "command",
			exitState: "exited",
			exitCode: 0,
			signal: null,
			stdout: "ok",
			stderr: "",
			stdoutBytes: 2,
			stderrBytes: 0,
			outputDigest: digestObject({ stdout: "ok", stderr: "" }),
			outputTruncated: false,
		},
		artifactObservations: [{ artifactRef, exists: true, verifiedDigest: artifactRef.digest, verifiedSizeBytes: 2 }],
		scanner: {
			scannerDigest: "scanner",
			scanStatus: "passed",
			redactionStatus: "not_required",
			findingCodes: [],
			findingDigest: "findings",
		},
		confidence: "high",
		limitations: [],
		workspaceDigest: "workspace",
		configDigest: "config",
		revisions,
		evaluatorDigest: "evaluator",
		parserDigest: "parser",
		guardDigest: "guard",
		updatedDigest: "updated",
		invalidatedByDecisionRef: null,
		regressed: false,
		auditorDecisionRef: null,
		observedAt: "2026-08-13T00:00:00.000Z",
		freshUntil: "2026-08-13T00:05:00.000Z",
		freshnessWindowMilliseconds: 300_000,
		...overrides,
	};
}

function createArtifactResolver(): WorkflowArtifactResolver {
	return {
		resolve: async (ref): Promise<WorkflowArtifactReadResult> => ({
			envelope: { ref, payloadKind: "evidence", codec: "utf8", immutable: true },
			exists: true,
			bytes: new Uint8Array([111, 107]),
			verifiedDigest: ref.digest,
			verifiedSizeBytes: 2,
		}),
	};
}

function receiptContextForOwners(d_ownerByKeyId: Readonly<Record<string, string>>): WorkflowHostReceiptConsumerContext {
	const base = createFixtureHostReceiptConsumerContext();
	return {
		...base,
		keyResolver: {
			resolve: async (keyId) => ({
				...(await base.keyResolver.resolve(keyId)),
				ownerPrincipal: d_ownerByKeyId[keyId] ?? "fixture-host",
			}),
		},
	};
}

function validationInput(
	evidence: WorkflowEvidenceEnvelope,
	overrides: Partial<WorkflowEvidenceValidationInput> = {},
): WorkflowEvidenceValidationInput {
	const trustedClockReceipt: WorkflowVerifiedHostReceipt = createFixtureHostReceipt({
		receiptKind: "clock",
		receiptId: "evidence-clock",
		issuerId: "host-clock",
		workflowId: "wf-1",
		bindingDigest: digestObject({
			evidenceId: evidence.evidenceId,
			workspaceDigest: "workspace",
			configDigest: "config",
			revisions,
		}),
		payloadDigest: digestObject({ now: "2026-08-13T00:01:00.000Z" }),
		artifactRef: {
			artifactId: "evidence-clock",
			relativePath: "receipts/evidence-clock",
			digest: "clock",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: "2026-08-13T00:01:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "clock-key",
		stateDigest: "state",
		signature: "clock-signature",
	});
	return {
		workflowId: "wf-1",
		evidence,
		trustedClockReceipt,
		currentWorkspaceDigest: "workspace",
		currentConfigDigest: "config",
		currentParserDigest: "parser",
		currentEvaluatorDigest: "evaluator",
		currentGuardDigest: "guard",
		currentRevisions: revisions,
		requiredFreshnessMilliseconds: 300_000,
		artifactResolver: createArtifactResolver(),
		receiptContext: receiptContextForOwners({
			"clock-key": "host-clock",
			"evidence-key": "evidence-host",
			"red-team-key": "red-team-host",
			"audit-key": "audit-host",
		}),
		currentStateDigest: "state",
		currentRevision: revisions.evidenceRevision,
		...overrides,
	};
}

it("RED: rejects a missing artifact rather than trusting the envelope claim", async () => {
	const validator = createWorkflowEvidenceValidator();
	const missing: WorkflowArtifactResolver = {
		resolve: async () => {
			throw new Error("artifact_missing");
		},
	};
	await expect(
		validator.validate(validationInput(createEvidence(), { artifactResolver: missing })),
	).resolves.toMatchObject({
		accepted: false,
		code: "artifact_missing",
	});
});

it("GREEN: accepts bounded current command, artifact, scanner, and revision evidence", async () => {
	const validator = createWorkflowEvidenceValidator();
	await expect(validator.validate(validationInput(createEvidence()))).resolves.toMatchObject({
		accepted: true,
		code: "accepted",
	});
});

it("projects a validated envelope into the approved compact handoff evidence shape", () => {
	const projected = projectRequirementEvidence(createEvidence());
	expect(projected).toEqual({
		evidenceId: "evidence-1",
		requirementId: "requirement-1",
		claim: "The bounded host check passed.",
		result: "exit-zero",
		method: "independent-integration-test",
		artifactRefs: [artifactRef],
		confidence: "high",
		limitations: [],
		workspaceDigest: "workspace",
		observedAt: "2026-08-13T00:00:00.000Z",
	});
});

it("GREEN: resolver validation binds a consumer reference to the exact envelope and artifact scope", async () => {
	const evidence = createEvidence();
	const input = validationInput(evidence);
	const validation = await createWorkflowEvidenceValidator().validate(input);
	const reference: WorkflowEvidenceEnvelopeRef = {
		workflowId: "wf-1",
		envelopeId: evidence.evidenceId,
		envelopeDigest: validation.evidenceDigest,
		evidenceRevision: evidence.evidenceRevision,
		artifactRefs: evidence.artifactObservations.map((observation) => observation.artifactRef),
		validationReceipt: createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: "validation-receipt",
			issuerId: "evidence-host",
			workflowId: "wf-1",
			bindingDigest: validation.evidenceDigest,
			payloadDigest: validation.evidenceDigest,
			artifactRef,
			issuedAt: "2026-08-13T00:01:00.000Z",
			validUntil: "2026-08-13T00:05:00.000Z",
			keyId: "evidence-key",
			stateDigest: "state",
			signature: "evidence-signature",
		}),
	};
	const refInput: WorkflowEvidenceEnvelopeRefValidationInput = { ...input, workflowId: "wf-1", reference };
	await expect(validateWorkflowEvidenceEnvelopeRef(refInput)).resolves.toEqual(reference);
	await expect(
		validateWorkflowEvidenceEnvelopeRef({ ...refInput, reference: { ...reference, artifactRefs: [] } }),
	).rejects.toThrow(/artifact scope|bound/i);
});

it("replays the exact validated envelope without changing its digest", async () => {
	const validator = createWorkflowEvidenceValidator();
	const evidence = createEvidence();
	const first = await validator.validate(validationInput(evidence));
	const replayed = parseCanonicalJsonBytes(canonicalJsonBytes(evidence)) as unknown as WorkflowEvidenceEnvelope;
	const second = await validator.validate(validationInput(replayed));
	expect(second).toEqual(first);
});

it("RED: rejects an artifact whose immutable envelope has the wrong payload kind", async () => {
	const evidence = createEvidence();
	const result = await createWorkflowEvidenceValidator().validate(
		validationInput(evidence, {
			artifactResolver: {
				resolve: async (ref): Promise<WorkflowArtifactReadResult> => ({
					envelope: { ref, payloadKind: "handoff", codec: "utf8", immutable: true },
					exists: true,
					bytes: new Uint8Array([111, 107]),
					verifiedDigest: ref.digest,
					verifiedSizeBytes: 2,
				}),
			},
		}),
	);
	expect(result.accepted).toBe(false);
	expect(result.findings.map((finding) => finding.code)).toContain("artifact_digest_mismatch");
});

const antiCheatingCases: readonly [WorkflowEvidenceValidationCode, Partial<WorkflowEvidenceEnvelope>][] = [
	["stale_workspace", { workspaceDigest: "old" }],
	["stale_config", { configDigest: "old" }],
	["stale_revision", { revisions: { ...revisions, evidenceRevision: 0 } }],
	["stale_evaluator", { evaluatorDigest: "changed" }],
	["stale_observation", { freshUntil: "2026-08-12T23:59:00.000Z" }],
	["hardcoded_success", { result: "hardcoded-success" }],
	["mock_only", { method: "mock-only" }],
	[
		"proxy_only",
		{
			scanner: {
				scannerDigest: "scanner",
				scanStatus: "passed",
				redactionStatus: "not_required",
				findingCodes: ["proxy"],
				findingDigest: "proxy",
			},
		},
	],
	[
		"scanner_blocked",
		{
			scanner: {
				scannerDigest: "scanner",
				scanStatus: "blocked",
				redactionStatus: "blocked",
				findingCodes: ["secret"],
				findingDigest: "secret",
			},
		},
	],
	[
		"redaction_invalid",
		{
			scanner: {
				scannerDigest: "scanner",
				scanStatus: "redacted",
				redactionStatus: "not_required",
				findingCodes: ["secret"],
				findingDigest: "secret",
			},
		},
	],
	["command_output_unbounded", { command: { ...createEvidence().command!, outputTruncated: true } }],
	["command_exit_invalid", { command: { ...createEvidence().command!, exitCode: 0, signal: "SIGTERM" } }],
	[
		"artifact_digest_mismatch",
		{ artifactObservations: [{ artifactRef, exists: true, verifiedDigest: "wrong", verifiedSizeBytes: 2 }] },
	],
	[
		"artifact_size_mismatch",
		{
			artifactObservations: [
				{ artifactRef, exists: true, verifiedDigest: artifactRef.digest, verifiedSizeBytes: 1 },
			],
		},
	],
];

it.each(antiCheatingCases)("anti-cheating rejects %s evidence", async (code, override) => {
	const validator = createWorkflowEvidenceValidator();
	await expect(validator.validate(validationInput(createEvidence(override)))).resolves.toMatchObject({
		accepted: false,
		code,
	});
});

function createWorkerOnlyHandoff(): WorkflowAttemptHandoff {
	return {
		taskId: "task-1",
		attemptId: "attempt-1",
		outcome: "completed",
		planRevision: 1,
		goalContractRevision: 1,
		ownedPaths: [],
		ownedContracts: [],
		upstreamDecisionRefs: [],
		interfaceAndDependencyRefs: [],
		recommendation: "done",
		rationale: "self-report",
		preservedInvariants: [],
		pitfalls: [],
		requirementEvidence: [],
		verificationEvidenceRefs: [],
		unresolvedIssues: [],
		failedApproaches: [],
		escalation: null,
		preWorkspaceDigest: "before",
		postWorkspaceDigest: "current",
	};
}

it("rejects worker self-report without independently validated evidence", async () => {
	const validator = createWorkflowEvidenceValidator();
	const trustedNow = "2026-08-13T00:01:00.000Z";
	const trustedClockReceipt: WorkflowVerifiedHostReceipt = createFixtureHostReceipt({
		receiptKind: "clock",
		receiptId: "progress-clock",
		issuerId: "host-clock",
		workflowId: "wf-1",
		bindingDigest: "clock-binding",
		payloadDigest: "clock-payload",
		artifactRef: {
			artifactId: "progress-clock",
			relativePath: "receipts/progress-clock",
			digest: "clock",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: trustedNow,
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "clock-key",
		signature: "clock-signature",
	});
	const freshRedTeamReceipt: WorkflowVerifiedHostReceipt = createFixtureHostReceipt({
		receiptKind: "decision",
		receiptId: "progress-red-team",
		issuerId: "host-red-team",
		workflowId: "wf-1",
		bindingDigest: "red-team-binding",
		payloadDigest: "red-team-payload",
		artifactRef: {
			artifactId: "progress-red-team",
			relativePath: "receipts/progress-red-team",
			digest: "red-team",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: trustedNow,
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "red-team-key",
		signature: "red-team-signature",
	});
	const input: WorkflowProgressAuditInput = {
		workflowId: "wf-1",
		handoff: createWorkerOnlyHandoff(),
		independentEvidence: [],
		currentWorkspaceDigest: "workspace",
		currentConfigDigest: "config",
		currentParserDigest: "parser",
		currentEvaluatorDigest: "evaluator",
		currentGuardDigest: "guard",
		currentRevisions: revisions,
		currentBlocker: null,
		goalTurnIds: ["turn-1"],
		blockerRegistry: { resolve: async () => null },
		freshRedTeamReceipt,
		trustedClockReceipt,
		requiredFreshnessMilliseconds: 300_000,
		artifactResolver: createArtifactResolver(),
		receiptContext: receiptContextForOwners({
			"clock-key": "host-clock",
			"red-team-key": "host-red-team",
		}),
		currentStateDigest: "state",
		currentRevision: revisions.evidenceRevision,
	};
	const result: WorkflowProgressAuditResult = await validator.auditProgress(input);
	expect(result.acceptedRequirementIds).toEqual([]);
	expect(result.findings.map((finding) => finding.code)).toContain("independent_evidence_required");
});

function createDecisionRef(decisionId: string): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: "wf-1", rootSessionId: "session-1" },
		decisionId,
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		decisionDigest: `decision-${decisionId}`,
	};
}

function createLedger(requirementIds: readonly string[] = ["requirement-1"]): WorkflowProgressLedger {
	const entries: WorkflowProgressEntry[] = requirementIds.map((requirementId) => ({
		requirementId,
		status: "unproven",
		evidenceRefs: [],
		evidenceRevisions: [],
		regressionReason: null,
		workspaceDigest: "workspace",
		auditorDecisionRef: createDecisionRef(`entry-${requirementId}`),
		observedAt: "2026-08-13T00:00:00.000Z",
		invalidatedByDecisionId: null,
	}));
	return {
		workflowId: "wf-1",
		...revisions,
		revisions,
		entries,
		progressDigest: digestObject({ workflowId: "wf-1", revisions, entries }),
	};
}

function createNextLedger(
	ledger: WorkflowProgressLedger,
	evidence: readonly WorkflowEvidenceEnvelope[],
	audit: WorkflowProgressAuditResult,
): WorkflowProgressLedger {
	const acceptedRequirementIds = [...new Set(evidence.map((item) => item.requirementId))].sort();
	const accepted = new Set(acceptedRequirementIds);
	const entries = ledger.entries.map((entry) => {
		if (!accepted.has(entry.requirementId)) return entry;
		const currentEvidence = evidence.filter((item) => item.requirementId === entry.requirementId);
		return {
			...entry,
			status: "proven" as const,
			evidenceRefs: currentEvidence.flatMap((item) =>
				item.artifactObservations.map((observation) => observation.artifactRef),
			),
			evidenceRevisions: currentEvidence.map((item) => item.evidenceRevision),
			invalidatedByDecisionId: null,
			regressionReason: null,
			workspaceDigest: audit.currentWorkspaceDigest,
			observedAt: currentEvidence.at(-1)?.observedAt ?? entry.observedAt,
		};
	});
	const nextRevisions = { ...revisions, evidenceRevision: 2 };
	return {
		...ledger,
		...nextRevisions,
		revisions: nextRevisions,
		entries,
		progressDigest: digestObject({
			workflowId: ledger.workflowId,
			revisions: nextRevisions,
			entries,
			evidenceDigest: digestObject(evidence),
		}),
	};
}

function createProgressAuditInput(overrides: Partial<WorkflowProgressAuditInput> = {}): WorkflowProgressAuditInput {
	const evidence = createEvidence();
	const validation = validationInput(evidence);
	const handoff: WorkflowAttemptHandoff = {
		...createWorkerOnlyHandoff(),
		requirementEvidence: [projectRequirementEvidence(evidence)],
		verificationEvidenceRefs: evidence.artifactObservations.map((observation) => observation.artifactRef),
		postWorkspaceDigest: "workspace",
	};
	const base: WorkflowProgressAuditInput = {
		workflowId: "wf-1",
		handoff,
		independentEvidence: [evidence],
		currentWorkspaceDigest: "workspace",
		currentConfigDigest: "config",
		currentParserDigest: "parser",
		currentEvaluatorDigest: "evaluator",
		currentGuardDigest: "guard",
		currentRevisions: revisions,
		currentBlocker: null,
		goalTurnIds: ["turn-1"],
		blockerRegistry: { resolve: async () => null },
		freshRedTeamReceipt: createFixtureHostReceipt({
			receiptKind: "decision",
			receiptId: "progress-red-team",
			issuerId: "red-team-host",
			workflowId: "wf-1",
			bindingDigest: digestObject({
				kind: "progress_red_team",
				workflowId: "wf-1",
				currentStateDigest: "state",
				currentRevision: 1,
				workspaceDigest: "workspace",
				configDigest: "config",
				revisions,
				goalTurnIds: ["turn-1"],
				evidenceDigest: digestObject([evidence]),
				blockerDigest: null,
			}),
			payloadDigest: "red-team-payload",
			artifactRef: {
				artifactId: "progress-red-team",
				relativePath: "receipts/progress-red-team",
				digest: "red-team",
				sizeBytes: 1,
				sourceEventSequence: 0,
			},
			issuedAt: "2026-08-13T00:01:00.000Z",
			validUntil: "2026-08-13T00:05:00.000Z",
			keyId: "red-team-key",
			stateDigest: "state",
			signature: "red-team-signature",
		}),
		trustedClockReceipt: validation.trustedClockReceipt,
		requiredFreshnessMilliseconds: 300_000,
		artifactResolver: validation.artifactResolver,
		receiptContext: validation.receiptContext,
		currentStateDigest: "state",
		currentRevision: 1,
	};
	return { ...base, ...overrides };
}

function createIndependentAuditRef(
	input: WorkflowProgressAuditInput,
	overrides: Partial<WorkflowVerifiedHostReceipt> = {},
): { receipt: WorkflowVerifiedHostReceipt; requirementIds: readonly string[]; evidenceDigest: string } {
	const requirementIds = [...new Set(input.independentEvidence.map((evidence) => evidence.requirementId))].sort();
	const evidenceDigest = digestObject(input.independentEvidence);
	const receipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		receiptId: "independent-audit",
		issuerId: "audit-host",
		workflowId: input.workflowId,
		bindingDigest: digestObject({
			kind: "progress_audit",
			workflowId: input.workflowId,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			requirementIds,
			evidenceDigest,
		}),
		payloadDigest: "audit-payload",
		artifactRef: {
			artifactId: "independent-audit",
			relativePath: "receipts/independent-audit",
			digest: "audit",
			sizeBytes: 1,
			sourceEventSequence: 0,
		},
		issuedAt: "2026-08-13T00:01:00.000Z",
		validUntil: "2026-08-13T00:05:00.000Z",
		keyId: "audit-key",
		stateDigest: input.currentStateDigest,
		signature: "audit-signature",
		...overrides,
	});
	return { receipt, requirementIds, evidenceDigest };
}

function createDiagnosticProgressAuthorizer(input: {
	snapshot: WorkflowProgressRuntimeSnapshot;
	commit?: (
		commit: WorkflowProgressHostCommitInput,
		receiptCommit: WorkflowProgressHostReceiptCommitPort,
	) => Promise<WorkflowProgressLedger>;
}): WorkflowProgressHostAuthorizer {
	// Unit probes use a tiny authenticated-shape adapter; persistence and race claims use the real store below.
	let current = structuredClone(input.snapshot);
	const runtimeStore = {
		identity: {
			storeKind: "workflow",
			namespace: "diagnostic",
			rootDir: "diagnostic",
			storeId: `diagnostic:${input.snapshot.workflowId}`,
			workflowId: input.snapshot.workflowId,
			identityDigest: digestObject({ workflowId: input.snapshot.workflowId, storeId: input.snapshot.workflowId }),
		},
		durableContext: { epochRef: input.snapshot.journalHead.epochRef },
		replay: async () => ({
			workflowId: current.workflowId,
			executionKey: null,
			events: [],
			head: current.journalHead,
			quarantined: false,
			quarantineReason: null,
		}),
	} as unknown as WorkflowRuntimeStore;
	return createWorkflowProgressHostAuthorizer({
		runtimeStore,
		trustedNow: () => "2026-08-13T00:02:00.000Z",
		readCurrent: async (_runtimeStore, _journalHead) => ({
			workflowId: current.workflowId,
			stateDigest: current.stateDigest,
			currentWorkspaceDigest: current.currentWorkspaceDigest,
			currentRevision: current.currentRevision,
			ledger: current.ledger,
		}),
		commit: async (_runtimeStore, commitInput, receiptCommit) => {
			if (receiptCommit === undefined) throw new Error("workflow progress test requires receipt consumption");
			await receiptCommit.verifyAndConsume({ current, commitInput });
			const committed =
				input.commit === undefined ? commitInput.nextLedger : await input.commit(commitInput, receiptCommit);
			current = { ...current, ledger: committed };
			return committed;
		},
	});
}

function createProgressAuditHostFixture(
	ledger: WorkflowProgressLedger,
	evidence: readonly WorkflowEvidenceEnvelope[],
	audit: WorkflowProgressAuditResult,
	journalHeadOverride?: WorkflowJournalHead,
	receiptTimeOverride?: { issuedAt: string; validUntil: string },
): {
	auditArtifact: WorkflowProgressAuditArtifactRef;
	receiptContext: WorkflowHostReceiptConsumerContext;
	authorizer: WorkflowProgressHostAuthorizer;
	journalHead: WorkflowJournalHead;
	createAuthorizer: (
		commit?: (
			commit: WorkflowProgressHostCommitInput,
			receiptCommit: WorkflowProgressHostReceiptCommitPort,
		) => Promise<WorkflowProgressLedger>,
	) => WorkflowProgressHostAuthorizer;
} {
	const storeEpoch = 1;
	const coordinatorEpoch = 1;
	const currentRevision = 1;
	const journalHead: WorkflowJournalHead = journalHeadOverride ?? {
		workflowId: ledger.workflowId,
		sequence: 10,
		eventDigest: "progress-head",
		epochRef: { storeEpoch, coordinatorEpoch },
	};
	const evidenceDigest = digestObject(evidence);
	const payload: WorkflowProgressAuditArtifactPayload = {
		kind: "workflow_progress_audit",
		workflowId: ledger.workflowId,
		headDigest: audit.currentStateDigest,
		journalHead,
		progressDigest: ledger.progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
		auditDigest: digestObject(audit),
		audit,
	};
	const bytes = canonicalJsonBytes(payload);
	const auditArtifactRef = {
		artifactId: "progress-audit-1",
		relativePath: "audits/progress-audit-1",
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: journalHead.sequence,
	};
	const bindingDigest = computeWorkflowProgressAuditReceiptBinding({
		workflowId: ledger.workflowId,
		headDigest: audit.currentStateDigest,
		journalHead,
		progressDigest: ledger.progressDigest,
		storeEpoch,
		coordinatorEpoch,
		currentRevision,
		evidenceDigest,
		auditArtifactRef,
		expectedLedger: ledger,
		nextLedger: createNextLedger(ledger, evidence, audit),
		evidenceRefs: evidence.flatMap((item) => item.artifactObservations.map((observation) => observation.artifactRef)),
	});
	const receipt = createFixtureHostReceipt({
		receiptKind: "adjudication",
		oneUse: true,
		receiptId: "progress-audit-receipt-1",
		issuerId: "progress-auditor",
		workflowId: ledger.workflowId,
		bindingDigest,
		payloadDigest: auditArtifactRef.digest,
		artifactRef: {
			artifactId: "progress-audit-receipt-artifact-1",
			relativePath: "receipts/progress-audit-receipt-1",
			digest: "fixture-receipt",
			sizeBytes: 1,
			sourceEventSequence: journalHead.sequence + 1,
		},
		issuedAt: receiptTimeOverride?.issuedAt ?? "2026-08-13T00:01:00.000Z",
		validUntil: receiptTimeOverride?.validUntil ?? "2026-08-13T00:05:00.000Z",
		keyId: "progress-audit-key",
		stateDigest: audit.currentStateDigest,
		revision: currentRevision,
		signature: "fixture-signature",
	});
	const fixtureContext = createFixtureHostReceiptConsumerContext();
	const evidenceArtifactResolver = createArtifactResolver();
	const evidenceArtifactDigests = new Set(
		evidence.flatMap((item) => item.artifactObservations.map((observation) => digestObject(observation.artifactRef))),
	);
	const receiptContext: WorkflowHostReceiptConsumerContext = {
		...fixtureContext,
		keyResolver: {
			resolve: async (keyId) => ({
				...(await fixtureContext.keyResolver.resolve(keyId)),
				ownerPrincipal: keyId === "progress-audit-key" ? "progress-auditor" : "fixture-host",
			}),
		},
		artifactResolver: {
			resolve: async (ref) => {
				if (digestObject(ref) === digestObject(auditArtifactRef)) {
					return {
						envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
						exists: true,
						bytes,
						verifiedDigest: sha256Hex(bytes),
						verifiedSizeBytes: bytes.byteLength,
					};
				}
				if (evidenceArtifactDigests.has(digestObject(ref))) return evidenceArtifactResolver.resolve(ref);
				return fixtureContext.artifactResolver.resolve(ref);
			},
		},
	};
	const createAuthorizer = (
		commit?: (
			commit: WorkflowProgressHostCommitInput,
			receiptCommit: WorkflowProgressHostReceiptCommitPort,
		) => Promise<WorkflowProgressLedger>,
	): WorkflowProgressHostAuthorizer =>
		createDiagnosticProgressAuthorizer({
			snapshot: {
				workflowId: ledger.workflowId,
				journalHead,
				stateDigest: audit.currentStateDigest,
				currentWorkspaceDigest: audit.currentWorkspaceDigest,
				currentRevision,
				ledger,
			},
			commit,
		});
	return {
		auditArtifact: { artifactRef: auditArtifactRef, receipt },
		receiptContext,
		authorizer: createAuthorizer(),
		journalHead,
		createAuthorizer,
	};
}

function createCorruptAuditArtifactContext(
	fixture: {
		auditArtifact: WorkflowProgressAuditArtifactRef;
		receiptContext: WorkflowHostReceiptConsumerContext;
	},
	mode: "missing" | "foreign" | "unverified",
): WorkflowHostReceiptConsumerContext {
	const baseContext = fixture.receiptContext;
	return {
		...baseContext,
		artifactResolver: {
			resolve: async (ref) => {
				if (digestObject(ref) !== digestObject(fixture.auditArtifact.artifactRef)) {
					return baseContext.artifactResolver.resolve(ref);
				}
				if (mode === "missing") throw new Error("audit artifact missing");
				const resolved = await baseContext.artifactResolver.resolve(ref);
				if (mode === "foreign") {
					return {
						...resolved,
						envelope: { ...resolved.envelope, ref: { ...ref, artifactId: "foreign-audit-artifact" } },
					};
				}
				return { ...resolved, bytes: new Uint8Array([0]), verifiedDigest: ref.digest };
			},
		},
	};
}

it("RED: rejects artifact bytes whose hash, path, or envelope reference is not bound", async () => {
	const validator = createWorkflowEvidenceValidator();
	const cases: WorkflowArtifactResolver[] = [
		{
			resolve: async (ref) => ({
				envelope: { ref, payloadKind: "evidence", codec: "utf8", immutable: true },
				exists: true,
				bytes: new Uint8Array([111, 108]),
				verifiedDigest: ref.digest,
				verifiedSizeBytes: 2,
			}),
		},
		{
			resolve: async (ref) => ({
				envelope: {
					ref: { ...ref, relativePath: "evidence/other" },
					payloadKind: "evidence",
					codec: "utf8",
					immutable: true,
				},
				exists: true,
				bytes: new Uint8Array([111, 107]),
				verifiedDigest: ref.digest,
				verifiedSizeBytes: 2,
			}),
		},
	];
	for (const artifactResolver of cases) {
		await expect(validator.validate(validationInput(createEvidence(), { artifactResolver }))).resolves.toMatchObject({
			accepted: false,
			code: "artifact_digest_mismatch",
		});
	}
	await expect(
		validator.validate(
			validationInput(
				createEvidence({
					artifactObservations: [
						{
							artifactRef: { ...artifactRef, relativePath: "../evidence/a" },
							exists: true,
							verifiedDigest: artifactRef.digest,
							verifiedSizeBytes: 2,
						},
					],
				}),
			),
		),
	).resolves.toMatchObject({ accepted: false, code: "artifact_missing" });
});

it("rejects noncanonical artifact references before resolver access and revalidates the immutable envelope", async () => {
	let resolverCalls = 0;
	const resolver: WorkflowArtifactResolver = {
		resolve: async (ref) => {
			resolverCalls += 1;
			const bytes = new Uint8Array([111, 107]);
			return {
				envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
				exists: true,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
	await expect(
		resolveVerifiedWorkflowArtifact({
			resolver,
			ref: { ...artifactRef, relativePath: "evidence/../escape" },
		}),
	).rejects.toThrow(/canonical|unsafe|path/i);
	await expect(
		resolveVerifiedWorkflowArtifact({
			resolver,
			ref: { ...artifactRef, digest: "abc" },
		}),
	).rejects.toThrow(/canonical|content-addressed/i);
	expect(resolverCalls).toBe(0);

	const resolved = await resolveVerifiedWorkflowArtifact({
		resolver,
		ref: artifactRef,
		expectedPayloadKind: "evidence",
		expectedCodec: "canonical_json",
		expectedSourceEventSequence: artifactRef.sourceEventSequence,
	});
	expect(resolved.envelope.ref).toEqual(artifactRef);
	(resolved.bytes as Uint8Array)[0] = 0;
	await expect(
		resolveVerifiedWorkflowArtifact({
			resolver: {
				resolve: async (ref) => ({
					envelope: { ref, payloadKind: "effect_result", codec: "binary", immutable: true },
					exists: true,
					bytes: new Uint8Array([111, 107]),
					verifiedDigest: ref.digest,
					verifiedSizeBytes: ref.sizeBytes,
				}),
			},
			ref: artifactRef,
			expectedPayloadKind: "effect_result",
			expectedCodec: "binary",
		}),
	).resolves.toMatchObject({ envelope: { payloadKind: "effect_result", codec: "binary" } });
	await expect(
		resolveVerifiedWorkflowArtifact({
			resolver: {
				resolve: async (ref) => ({
					envelope: {
						ref: { ...ref, sourceEventSequence: ref.sourceEventSequence + 1 },
						payloadKind: "evidence",
						codec: "canonical_json",
						immutable: true,
					},
					exists: true,
					bytes: new Uint8Array([111, 107]),
					verifiedDigest: ref.digest,
					verifiedSizeBytes: ref.sizeBytes,
				}),
			},
			ref: artifactRef,
		}),
	).rejects.toThrow(/missing|envelope|reference/i);
});

it("RED: recomputes command output and result semantics", async () => {
	const validator = createWorkflowEvidenceValidator();
	await expect(
		validator.validate(
			validationInput(createEvidence({ command: { ...createEvidence().command!, outputDigest: "wrong" } })),
		),
	).resolves.toMatchObject({ accepted: false, code: "command_output_unbounded" });
	await expect(
		validator.validate(validationInput(createEvidence({ command: { ...createEvidence().command!, exitCode: 1 } }))),
	).resolves.toMatchObject({ accepted: false, code: "command_exit_invalid" });
	await expect(validator.validate(validationInput(createEvidence({ result: "failed" })))).resolves.toMatchObject({
		accepted: false,
		code: "command_exit_invalid",
	});
});

it("RED: binds handoff claims and artifact references to independently validated envelopes", async () => {
	const evidence = createEvidence();
	const handoff = {
		...createWorkerOnlyHandoff(),
		requirementEvidence: [{ ...projectRequirementEvidence(evidence), claim: "forged" }],
		verificationEvidenceRefs: evidence.artifactObservations.map((observation) => observation.artifactRef),
		postWorkspaceDigest: "workspace",
	};
	const result = await createWorkflowEvidenceValidator().auditProgress(
		createProgressAuditInput({ handoff, independentEvidence: [evidence] }),
	);
	expect(result.findings.map((finding) => finding.code)).toContain("independent_evidence_required");
	const noArtifacts = await createWorkflowEvidenceValidator().auditProgress(
		createProgressAuditInput({
			handoff: {
				...handoff,
				requirementEvidence: [projectRequirementEvidence({ ...evidence, artifactObservations: [] })],
			},
			independentEvidence: [{ ...evidence, artifactObservations: [] }],
		}),
	);
	expect(noArtifacts.findings.map((finding) => finding.code)).toContain("independent_evidence_required");
});

it("RED: requires handoff verification references to exactly equal validated artifact references", async () => {
	const first = createEvidence();
	const secondArtifactRef = { ...artifactRef, artifactId: "artifact-2", relativePath: "evidence/b" };
	const second = createEvidence({
		evidenceId: "evidence-2",
		requirementId: "requirement-2",
		artifactObservations: [
			{
				artifactRef: secondArtifactRef,
				exists: true,
				verifiedDigest: secondArtifactRef.digest,
				verifiedSizeBytes: 2,
			},
		],
	});
	const base = createProgressAuditInput({ independentEvidence: [first, second] });
	const exactHandoff: WorkflowAttemptHandoff = {
		...base.handoff,
		requirementEvidence: [projectRequirementEvidence(first), projectRequirementEvidence(second)],
		verificationEvidenceRefs: [artifactRef],
	};
	const omitted = await createWorkflowEvidenceValidator().auditProgress({ ...base, handoff: exactHandoff });
	expect(omitted.findings.map((finding) => finding.code)).toContain("independent_evidence_required");
	const substituted = await createWorkflowEvidenceValidator().auditProgress({
		...base,
		handoff: { ...exactHandoff, verificationEvidenceRefs: [{ ...artifactRef, artifactId: "substituted" }] },
	});
	expect(substituted.findings.map((finding) => finding.code)).toContain("independent_evidence_required");
});

it("RED: derives ledger acceptance from validated envelopes and rejects unrelated or empty evidence", async () => {
	const evidence = createEvidence();
	const validator = createWorkflowEvidenceValidator();
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await validator.auditProgress({ ...auditInput, independentAuditRefs: [auditReference] });
	expect(audit.independent).toBe(true);
	const forgedAudit = {
		...audit,
		acceptedRequirementIds: [],
		evidenceDigest: digestObject([]),
	};
	expect(() => acceptRequirementProgress(createLedger(), [evidence], forgedAudit)).toThrow(/digest|requirement/i);
	const unrelatedAudit = { ...audit, acceptedRequirementIds: ["unknown"] };
	expect(() => acceptRequirementProgress(createLedger(), [evidence], unrelatedAudit)).toThrow(/digest|requirement/i);
	const noRefEvidence = { ...evidence, artifactObservations: [] };
	const noRefAudit = {
		...audit,
		evidenceDigest: digestObject([noRefEvidence]),
		validatedEvidenceDigests: [digestObject(noRefEvidence)],
		evidenceValidationDigest: digestObject([digestObject(noRefEvidence)]),
	};
	expect(() => acceptRequirementProgress(createLedger(), [noRefEvidence], noRefAudit)).toThrow(/evidence|artifact/i);
});

it("RED: rejects evidence acceptance that bypasses anti-cheating validation", async () => {
	const validator = createWorkflowEvidenceValidator();
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await validator.auditProgress({ ...auditInput, independentAuditRefs: [auditReference] });
	const assertRejected = (evidence: WorkflowEvidenceEnvelope): void => {
		const forgedAudit: WorkflowProgressAuditResult = {
			...audit,
			evidenceDigest: digestObject([evidence]),
			validatedEvidenceDigests: [digestObject(evidence)],
			evidenceValidationDigest: digestObject([digestObject(evidence)]),
		};
		expect(() => acceptRequirementProgress(createLedger(), [evidence], forgedAudit)).toThrow(
			/self-asserted|unbound/i,
		);
	};

	assertRejected(createEvidence({ result: "hardcoded-success" }));
	assertRejected(createEvidence({ method: "self-report" }));
	assertRejected(createEvidence({ command: { ...createEvidence().command!, commandDigest: "" } }));
	assertRejected(createEvidence({ command: null, result: "passed" }));
});

it("RED: bounds total artifact observations accepted in one progress update", async () => {
	const evidence = Array.from({ length: WORKFLOW_EVIDENCE_LIMITS.maxArtifactObservations + 1 }, (_, index) =>
		createEvidence({ evidenceId: `evidence-${index}` }),
	);
	const evidenceDigests = evidence.map((item) => digestObject(item)).sort();
	const audit: WorkflowProgressAuditResult = {
		independent: true,
		workspaceDigest: "workspace",
		currentWorkspaceDigest: "workspace",
		currentContractRevision: 1,
		currentScorecardRevision: 1,
		currentPlanRevision: 1,
		revisions,
		acceptedRequirementIds: ["requirement-1"],
		regressedRequirementIds: [],
		evidenceDigest: digestObject(evidence),
		validatedEvidenceDigests: evidenceDigests,
		evidenceValidationDigest: digestObject(evidenceDigests),
		currentStateDigest: "state",
		blockerProof: null,
		findings: [],
	};
	expect(() => acceptRequirementProgress(createLedger(), evidence, audit)).toThrow(/artifact|evidence/i);
});

it("RED: rejects a progress ledger decision from another workflow", async () => {
	const validator = createWorkflowEvidenceValidator();
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await validator.auditProgress({ ...auditInput, independentAuditRefs: [auditReference] });
	const ledger = createLedger();
	ledger.entries[0]!.auditorDecisionRef.decisionScope = {
		kind: "workflow",
		workflowId: "foreign-workflow",
		rootSessionId: "session-1",
	};
	expect(() => acceptRequirementProgress(ledger, [createEvidence()], audit)).toThrow(/decision|workflow|scope/i);
});

it("RED: rejects caller-recomputed audit revisions, workspace metadata, and non-positive ledger epochs", async () => {
	const validator = createWorkflowEvidenceValidator();
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await validator.auditProgress({ ...auditInput, independentAuditRefs: [auditReference] });
	const evidence = [createEvidence()];
	expect(() =>
		acceptRequirementProgress(createLedger(), evidence, {
			...audit,
			currentPlanRevision: audit.currentPlanRevision + 1,
		}),
	).toThrow(/revision|metadata|current/i);
	expect(() =>
		acceptRequirementProgress(
			{ ...createLedger(), planRevision: 99, revisions: { ...revisions, planRevision: 99 } },
			evidence,
			audit,
		),
	).toThrow(/revision|plan|current/i);
	const invalidEpochLedger = createLedger();
	invalidEpochLedger.entries[0]!.auditorDecisionRef.storeEpoch = 0;
	expect(() => acceptRequirementProgress(invalidEpochLedger, evidence, audit)).toThrow(/epoch|decision/i);
});

it("RED: freezes projected, validation, and ledger data", async () => {
	const projected = projectRequirementEvidence(createEvidence());
	const validator = createWorkflowEvidenceValidator();
	const validation = await validator.validate(validationInput(createEvidence()));
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await validator.auditProgress({ ...auditInput, independentAuditRefs: [auditReference] });
	expect(audit.independent).toBe(true);
	const sourceLedger = createLedger();
	const evidence = [createEvidence()];
	const hostFixture = createProgressAuditHostFixture(sourceLedger, evidence, audit);
	const ledger = await acceptRequirementProgressAtHost({
		evidence,
		audit,
		...hostFixture,
	});
	expect(Object.isFrozen(projected)).toBe(true);
	expect(Object.isFrozen(projected.artifactRefs)).toBe(true);
	expect(Object.isFrozen(validation)).toBe(true);
	expect(Object.isFrozen(validation.findings)).toBe(true);
	expect(Object.isFrozen(ledger)).toBe(true);
	expect(Object.isFrozen(ledger.entries)).toBe(true);
	expect(Object.isFrozen(ledger.entries[0])).toBe(true);
});

function createBlockerClaim(overrides: Partial<WorkflowBlockerClaim> = {}): WorkflowBlockerClaim {
	return {
		dependencyId: "dependency-1",
		conditionDigest: "condition-1",
		requiredChange: "host change",
		registeredAlternativeSetDigest: "alternatives-1",
		alternativeResults: [
			{
				alternativeId: "alternative-1",
				strategyDigest: "strategy-1",
				disposition: "failed_with_evidence",
				attemptedStateDigest: "state",
				evidenceRefs: [artifactRef],
			},
		],
		evidenceRefs: [artifactRef],
		...overrides,
	};
}

it("RED: blocker proof requires concrete evidence and distinct decision refs across consecutive turns", () => {
	const emptyEvidenceClaim = createBlockerClaim({ evidenceRefs: [] });
	expect(() =>
		issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: "turn-1",
			goalTurnSequence: 1,
			claim: emptyEvidenceClaim,
			prior: null,
			auditDecisionRef: createDecisionRef("decision-1"),
		}),
	).toThrow(/evidence/i);
	const first = issueWorkflowBlockerRecord({
		workflowId: "wf-1",
		goalTurnId: "turn-1",
		goalTurnSequence: 1,
		claim: createBlockerClaim(),
		prior: null,
		auditDecisionRef: createDecisionRef("same-decision"),
	});
	expect(() =>
		issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: "turn-2",
			goalTurnSequence: 2,
			claim: createBlockerClaim(),
			prior: first,
			auditDecisionRef: createDecisionRef("same-decision"),
		}),
	).toThrow(/decision/i);
});

it("RED: blocker continuation recomputes identity and rejects forged prior workflow, blocker, or epoch", () => {
	const claim = createBlockerClaim();
	const first = issueWorkflowBlockerRecord({
		workflowId: "wf-1",
		goalTurnId: "turn-1",
		goalTurnSequence: 1,
		claim,
		prior: null,
		auditDecisionRef: createDecisionRef("decision-1"),
	});
	expect(() =>
		issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: "turn-2",
			goalTurnSequence: 2,
			claim,
			prior: { ...first, blockerId: "forged" },
			auditDecisionRef: createDecisionRef("decision-2"),
		}),
	).toThrow(/blocker|identity/i);
	expect(() =>
		issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: "turn-2",
			goalTurnSequence: 2,
			claim,
			prior: { ...first, workflowId: "other-workflow" },
			auditDecisionRef: createDecisionRef("decision-2"),
		}),
	).toThrow(/workflow|blocker|identity/i);
	const invalidEpochDecision = { ...createDecisionRef("decision-2"), storeEpoch: 0 };
	expect(() =>
		issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: "turn-2",
			goalTurnSequence: 2,
			claim,
			prior: first,
			auditDecisionRef: invalidEpochDecision,
		}),
	).toThrow(/epoch|decision/i);
});

it("RED: blocker audit requires recomputed identity and confirmed disposition", async () => {
	let blocker: WorkflowBlockerRecord | null = null;
	for (const turn of [1, 2, 3]) {
		blocker = issueWorkflowBlockerRecord({
			workflowId: "wf-1",
			goalTurnId: `turn-${turn}`,
			goalTurnSequence: turn,
			claim: createBlockerClaim(),
			prior: blocker,
			auditDecisionRef: createDecisionRef(`decision-${turn}`),
		});
	}
	const forgedBlocker = { ...blocker!, blockerId: "forged", disposition: "claimed" as const };
	const input = createProgressAuditInput({
		currentBlocker: forgedBlocker,
		goalTurnIds: ["turn-1", "turn-2", "turn-3"],
		blockerRegistry: { resolve: async () => forgedBlocker },
	});
	const result = await createWorkflowEvidenceValidator().auditProgress(input);
	expect(result.findings.map((finding) => finding.code)).toContain("blocker_identity_not_repeated");
});

it("RED: consumes one-use trusted clock receipts through the host context", async () => {
	const input = validationInput(createEvidence());
	const oneUseClock = createFixtureHostReceipt({
		...input.trustedClockReceipt,
		oneUse: true,
	});
	const reusableInput = { ...input, trustedClockReceipt: oneUseClock };
	const validator = createWorkflowEvidenceValidator();
	await expect(validator.validate(reusableInput)).resolves.toMatchObject({ accepted: true });
	await expect(validator.validate(reusableInput)).resolves.toMatchObject({
		accepted: false,
		code: "receipt_unavailable",
	});
});

it("RED: constrains independent audit receipt kind, identity, and freshness", async () => {
	const input = createProgressAuditInput();
	const baseRef = createIndependentAuditRef(input);
	const wrongKind = createIndependentAuditRef(input, { receiptKind: "artifact" });
	const samePrincipal = createIndependentAuditRef(input, { issuerId: input.freshRedTeamReceipt.issuerId });
	const stale = createIndependentAuditRef(input, {
		issuedAt: "2026-08-12T00:00:00.000Z",
		validUntil: "2026-08-14T00:00:00.000Z",
	});
	for (const reference of [wrongKind, samePrincipal, stale]) {
		const result = await createWorkflowEvidenceValidator().auditProgress({
			...input,
			independentAuditRefs: [reference],
		});
		expect(result.findings.map((finding) => finding.code)).toContain("audit_reference_invalid");
	}
	expect(baseRef.requirementIds).toEqual(["requirement-1"]);
});

it("RED: rejects a self-consistent independent audit before the public CAS boundary", async () => {
	const evidence = createEvidence();
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	expect(audit.independent).toBe(true);
	const ledger = createLedger();
	const ledgerBefore = structuredClone(ledger);
	let compareAndSwapCalls = 0;
	let journalFrames = 0;
	const fixture = createProgressAuditHostFixture(ledger, [evidence], audit);
	await expect(
		acceptRequirementProgressAtHost({
			evidence: [evidence],
			audit,
			auditArtifact: {
				artifactRef: {
					artifactId: "missing-progress-audit",
					relativePath: "audits/missing-progress-audit",
					digest: "missing",
					sizeBytes: 1,
					sourceEventSequence: 1,
				},
				receipt: auditReference.receipt,
			},
			receiptContext: auditInput.receiptContext,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				journalFrames += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/artifact|receipt|host/i);
	expect(compareAndSwapCalls).toBe(0);
	expect(journalFrames).toBe(0);
	expect(ledger).toEqual(ledgerBefore);
});

it("RED: rejects a caller-shaped authorizer before reading or committing progress", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	let readCalls = 0;
	let commitCalls = 0;
	const fakeAuthorizer = {
		workflowId: "wf-1",
		readCurrent: async () => {
			readCalls += 1;
			throw new Error("caller-shaped read must not run");
		},
		commit: async () => {
			commitCalls += 1;
			throw new Error("caller-shaped commit must not run");
		},
	} as unknown as WorkflowProgressHostAuthorizer;
	await expect(
		acceptRequirementProgressAtHost({
			evidence: [createEvidence()],
			audit,
			auditArtifact: { artifactRef, receipt: auditReference.receipt },
			receiptContext: auditInput.receiptContext,
			authorizer: fakeAuthorizer,
		}),
	).rejects.toThrow(/opaque|authorizer/i);
	expect(readCalls).toBe(0);
	expect(commitCalls).toBe(0);
});

it("RED: rejects deleted evidence during the final host artifact revalidation", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	const evidenceRef = evidence[0]!.artifactObservations[0]!.artifactRef;
	const baseResolver = fixture.receiptContext.artifactResolver;
	const deletedEvidenceContext: WorkflowHostReceiptConsumerContext = {
		...fixture.receiptContext,
		artifactResolver: {
			resolve: async (ref) => {
				if (digestObject(ref) === digestObject(evidenceRef)) throw new Error("evidence artifact deleted");
				return baseResolver.resolve(ref);
			},
		},
	};
	let compareAndSwapCalls = 0;
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			...fixture,
			receiptContext: deletedEvidenceContext,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/artifact|deleted/i);
	expect(compareAndSwapCalls).toBe(0);
});

it.each(["missing", "foreign", "mutated"] as const)(
	"rejects %s evidence during the final host artifact revalidation",
	async (mode) => {
		const auditInput = createProgressAuditInput();
		const auditReference = createIndependentAuditRef(auditInput);
		const audit = await createWorkflowEvidenceValidator().auditProgress({
			...auditInput,
			independentAuditRefs: [auditReference],
		});
		const ledger = createLedger();
		const evidence = [createEvidence()];
		const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
		const evidenceRef = evidence[0]!.artifactObservations[0]!.artifactRef;
		const baseResolver = fixture.receiptContext.artifactResolver;
		let evidenceReads = 0;
		const mutatingEvidenceContext: WorkflowHostReceiptConsumerContext = {
			...fixture.receiptContext,
			artifactResolver: {
				resolve: async (ref) => {
					if (digestObject(ref) !== digestObject(evidenceRef)) return baseResolver.resolve(ref);
					evidenceReads += 1;
					const resolved = await baseResolver.resolve(ref);
					if (evidenceReads !== 2) return resolved;
					if (mode === "missing") throw new Error("evidence artifact deleted");
					if (mode === "foreign") {
						return {
							...resolved,
							envelope: { ...resolved.envelope, ref: { ...ref, sourceEventSequence: 99 } },
						};
					}
					return { ...resolved, bytes: new Uint8Array([0]), verifiedDigest: ref.digest };
				},
			},
		};
		let compareAndSwapCalls = 0;
		await expect(
			acceptRequirementProgressAtHost({
				evidence,
				audit,
				...fixture,
				receiptContext: mutatingEvidenceContext,
				authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
					compareAndSwapCalls += 1;
					return nextLedger;
				}),
			}),
		).rejects.toThrow(/artifact|foreign|content|changed|deleted/i);
		expect(evidenceReads).toBe(2);
		expect(compareAndSwapCalls).toBe(0);
	},
);

it("RED: rejects evidence mutated during the opaque authorizer's final CAS revalidation", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	const evidenceRef = evidence[0]!.artifactObservations[0]!.artifactRef;
	const baseResolver = fixture.receiptContext.artifactResolver;
	let evidenceReads = 0;
	const mutatingContext: WorkflowHostReceiptConsumerContext = {
		...fixture.receiptContext,
		artifactResolver: {
			resolve: async (ref) => {
				if (digestObject(ref) !== digestObject(evidenceRef)) return baseResolver.resolve(ref);
				evidenceReads += 1;
				const resolved = await baseResolver.resolve(ref);
				if (evidenceReads !== 3) return resolved;
				return { ...resolved, bytes: new Uint8Array([0]), verifiedDigest: ref.digest };
			},
		},
	};
	let compareAndSwapCalls = 0;
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			...fixture,
			receiptContext: mutatingContext,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/artifact|content|changed/i);
	expect(evidenceReads).toBe(3);
	expect(compareAndSwapCalls).toBe(0);
});

it.each(["missing", "foreign", "unverified"] as const)(
	"rejects a %s host audit artifact without changing the ledger or journal",
	async (mode) => {
		const auditInput = createProgressAuditInput();
		const auditReference = createIndependentAuditRef(auditInput);
		const audit = await createWorkflowEvidenceValidator().auditProgress({
			...auditInput,
			independentAuditRefs: [auditReference],
		});
		const ledger = createLedger();
		const ledgerBefore = structuredClone(ledger);
		const evidence = [createEvidence()];
		const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
		let compareAndSwapCalls = 0;
		let journalFrames = 0;
		await expect(
			acceptRequirementProgressAtHost({
				evidence,
				audit,
				...fixture,
				receiptContext: createCorruptAuditArtifactContext(fixture, mode),
				authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
					compareAndSwapCalls += 1;
					journalFrames += 1;
					return nextLedger;
				}),
			}),
		).rejects.toThrow(/artifact|host|content/i);
		expect(compareAndSwapCalls).toBe(0);
		expect(journalFrames).toBe(0);
		expect(ledger).toEqual(ledgerBefore);
	},
);

it("rejects a receipt whose resolved envelope changes its source event before CAS", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	const receiptRef = fixture.auditArtifact.receipt.artifactRef;
	const baseResolver = fixture.receiptContext.artifactResolver;
	const foreignReceiptContext: WorkflowHostReceiptConsumerContext = {
		...fixture.receiptContext,
		artifactResolver: {
			resolve: async (ref) => {
				const resolved = await baseResolver.resolve(ref);
				if (digestObject(ref) !== digestObject(receiptRef)) return resolved;
				return {
					...resolved,
					envelope: { ...resolved.envelope, ref: { ...ref, sourceEventSequence: ref.sourceEventSequence + 1 } },
				};
			},
		},
	};
	let compareAndSwapCalls = 0;
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			...fixture,
			receiptContext: foreignReceiptContext,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/artifact|envelope|foreign/i);
	expect(compareAndSwapCalls).toBe(0);
});

it("accepts a genuine host audit artifact through the receipt-aware atomic seam", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	let compareAndSwapCalls = 0;
	const input = {
		evidence,
		audit: { ...audit, independent: false },
		...fixture,
		authorizer: fixture.createAuthorizer(async ({ nextLedger }: WorkflowProgressHostCommitInput) => {
			compareAndSwapCalls += 1;
			return nextLedger;
		}),
	};
	await expect(acceptRequirementProgressAtHost(input)).resolves.toMatchObject({
		entries: [{ requirementId: "requirement-1", status: "proven" }],
	});
	expect(compareAndSwapCalls).toBe(1);
});

it("rejects replay of a consumed one-use receipt", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	const input = {
		evidence,
		audit,
		...fixture,
		authorizer: fixture.createAuthorizer(async ({ nextLedger }) => nextLedger),
	};
	await expect(acceptRequirementProgressAtHost(input)).resolves.toMatchObject({
		entries: [{ requirementId: "requirement-1", status: "proven" }],
	});
	const replayFixture = createProgressAuditHostFixture(ledger, evidence, audit, fixture.journalHead);
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			auditArtifact: replayFixture.auditArtifact,
			receiptContext: fixture.receiptContext,
			authorizer: replayFixture.createAuthorizer(async ({ nextLedger }) => nextLedger),
		}),
	).rejects.toThrow(/consum|receipt|replay/i);
});

it("rejects a genuinely signed receipt after the host validity window expires", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit, undefined, {
		issuedAt: "2026-08-13T00:00:00.000Z",
		validUntil: "2026-08-13T00:01:00.000Z",
	});
	let compareAndSwapCalls = 0;
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			...fixture,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/stale|expired|receipt|current/i);
	expect(compareAndSwapCalls).toBe(0);
});

it("persists receipt consumption with the ledger CAS across competition and restart", async () => {
	const artifactRoot = await mkdtemp(`${tmpdir()}/workflow-progress-atomic-`);
	const workflowId = "wf-1";
	const rootSessionId = "progress-atomic-session";
	const acceptanceRecordName = "workflow-progress-test-acceptance";
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	type PersistedAcceptanceRecord = {
		ledger: WorkflowProgressLedger;
		consumedReceiptIds: readonly string[];
		stateDigest: string;
		currentWorkspaceDigest: string;
		currentRevision: number;
	};
	const initialRecord: PersistedAcceptanceRecord = {
		ledger,
		consumedReceiptIds: [],
		stateDigest: "state",
		currentWorkspaceDigest: "workspace",
		currentRevision: 1,
	};
	let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity: "progress-atomic-writer",
			goalProjection: {
				read: () => emptyGoalState(),
				compareAndSwap: () => true,
			},
			genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		});
		const durable = host.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("workflow progress test requires a durable runtime store");
		const initialReplay = await host.runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		const fixture = createProgressAuditHostFixture(ledger, evidence, audit, initialReplay.head);
		const readRecord = async (runtimeStore: WorkflowRuntimeStore): Promise<PersistedAcceptanceRecord> => {
			const context = runtimeStore.durableContext;
			if (context === undefined) throw new Error("workflow progress test requires a durable runtime store");
			const bytes = await context.auxiliaryStore.read(acceptanceRecordName);
			if (bytes === null) return structuredClone(initialRecord);
			return parseCanonicalJsonBytes(bytes) as unknown as PersistedAcceptanceRecord;
		};
		const writeRecord = async (
			runtimeStore: WorkflowRuntimeStore,
			record: PersistedAcceptanceRecord,
		): Promise<void> => {
			const context = runtimeStore.durableContext;
			if (context === undefined) throw new Error("workflow progress test requires a durable runtime store");
			await context.auxiliaryStore.write(acceptanceRecordName, canonicalJsonBytes(record));
		};
		const persistedReceiptContext = (runtimeStore: WorkflowRuntimeStore): WorkflowHostReceiptConsumerContext => {
			const baseResolver = fixture.receiptContext.receiptResolver;
			const receiptResolver: WorkflowHostReceiptConsumerContext["receiptResolver"] = {
				resolve: (input) => baseResolver.resolve(input),
				consumeIfOneUse: async (input) => {
					if (!input.receipt.oneUse) return;
					const current = await readRecord(runtimeStore);
					if (current.consumedReceiptIds.includes(input.receipt.receiptId))
						throw new Error("workflow progress receipt was already consumed");
				},
				resolveConsumptionWitness: async (input): Promise<WorkflowHostReceiptConsumptionWitness> => {
					const current = await readRecord(runtimeStore);
					if (!current.consumedReceiptIds.includes(input.receiptId))
						throw new Error("workflow progress receipt has no durable witness");
					return {
						receiptId: input.receiptId,
						workflowId,
						bindingDigest: input.expectedBindingDigest,
						capability: fixture.auditArtifact.receipt.capabilityBinding?.capability ?? null,
						resourceDigest: fixture.auditArtifact.receipt.capabilityBinding?.resourceDigest ?? null,
						operationDigest: fixture.auditArtifact.receipt.capabilityBinding?.operationDigest ?? null,
						receiptDigest: fixture.auditArtifact.receipt.verificationDigest,
						consumedAt: "2026-08-13T00:02:00.000Z",
						consumptionSequence: 1,
					};
				},
			};
			return { ...fixture.receiptContext, receiptResolver };
		};
		const createPersistedAuthorizer = (runtimeStore: WorkflowRuntimeStore): WorkflowProgressHostAuthorizer =>
			createWorkflowProgressHostAuthorizer({
				runtimeStore,
				trustedNow: () => "2026-08-13T00:02:00.000Z",
				readCurrent: async (store) => {
					const current = await readRecord(store);
					return {
						workflowId,
						stateDigest: current.stateDigest,
						currentWorkspaceDigest: current.currentWorkspaceDigest,
						currentRevision: current.currentRevision,
						ledger: current.ledger,
					};
				},
				commit: async (store, commitInput, receiptCommit) => {
					const storeDurable = store.durableContext;
					if (storeDurable === undefined)
						throw new Error("workflow progress test requires a durable runtime store");
					if (receiptCommit === undefined) throw new Error("workflow progress test requires receipt consumption");
					return storeDurable.withExclusiveLease("workflow-progress-test-accept", async () => {
						const current = await readRecord(store);
						if (current.consumedReceiptIds.includes(commitInput.auditReceipt.receiptId)) {
							throw new Error("workflow progress receipt was already consumed");
						}
						if (
							digestObject(current.ledger) !== digestObject(commitInput.expected.ledger) ||
							commitInput.expectedLedgerDigest !== digestObject(commitInput.expected.ledger) ||
							commitInput.nextLedgerDigest !== digestObject(commitInput.nextLedger) ||
							current.stateDigest !== commitInput.expected.stateDigest ||
							current.currentWorkspaceDigest !== commitInput.expected.currentWorkspaceDigest ||
							current.currentRevision !== commitInput.expected.currentRevision
						) {
							throw new Error("workflow progress ledger compare-and-swap was stale");
						}
						const replay = await store.replay({
							workflowId,
							fromSequence: 0,
							expectedStoreEpoch: storeDurable.epochRef.storeEpoch,
						});
						if (digestObject(replay.head) !== digestObject(commitInput.expected.journalHead)) {
							throw new Error("workflow progress journal head compare-and-swap was stale");
						}
						await receiptCommit.verifyAndConsume({
							current: {
								workflowId,
								journalHead: replay.head,
								stateDigest: current.stateDigest,
								currentWorkspaceDigest: current.currentWorkspaceDigest,
								currentRevision: current.currentRevision,
								ledger: current.ledger,
							},
							commitInput,
						});
						const nextRecord: PersistedAcceptanceRecord = {
							...current,
							ledger: commitInput.nextLedger,
							consumedReceiptIds: [...current.consumedReceiptIds, commitInput.auditReceipt.receiptId],
							currentRevision: current.currentRevision + 1,
						};
						await writeRecord(store, nextRecord);
						return nextRecord.ledger;
					});
				},
			});
		const makeInput = (authorizer: WorkflowProgressHostAuthorizer, runtimeStore: WorkflowRuntimeStore) => ({
			evidence,
			audit,
			auditArtifact: fixture.auditArtifact,
			receiptContext: persistedReceiptContext(runtimeStore),
			authorizer,
		});
		const firstAuthorizer = createPersistedAuthorizer(host.runtimeStore);
		const competingAuthorizer = createPersistedAuthorizer(host.runtimeStore);
		const competing = await Promise.allSettled([
			acceptRequirementProgressAtHost(makeInput(firstAuthorizer, host.runtimeStore)),
			acceptRequirementProgressAtHost(makeInput(competingAuthorizer, host.runtimeStore)),
		]);
		expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(competing.find((result) => result.status === "rejected")).toMatchObject({
			status: "rejected",
		});
		await expect(
			persistedReceiptContext(host.runtimeStore).receiptResolver.resolveConsumptionWitness({
				receiptId: fixture.auditArtifact.receipt.receiptId,
				workflowId,
				expectedBindingDigest: fixture.auditArtifact.receipt.bindingDigest,
			}),
		).resolves.toMatchObject({
			receiptId: fixture.auditArtifact.receipt.receiptId,
			workflowId,
		});
		await host.dispose?.();
		host = undefined;
		reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity: "progress-atomic-writer",
			goalProjection: {
				read: () => emptyGoalState(),
				compareAndSwap: () => true,
			},
			genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		});
		await expect(
			persistedReceiptContext(reopened.runtimeStore).receiptResolver.resolveConsumptionWitness({
				receiptId: fixture.auditArtifact.receipt.receiptId,
				workflowId,
				expectedBindingDigest: fixture.auditArtifact.receipt.bindingDigest,
			}),
		).resolves.toMatchObject({
			receiptId: fixture.auditArtifact.receipt.receiptId,
			workflowId,
		});
		const replayAuthorizer = createPersistedAuthorizer(reopened.runtimeStore);
		await expect(acceptRequirementProgressAtHost(makeInput(replayAuthorizer, reopened.runtimeStore))).rejects.toThrow(
			/stale|receipt|replay|consum|revision/i,
		);
	} finally {
		await reopened?.dispose?.().catch(() => undefined);
		await host?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("rejects an audit artifact mutated during host revalidation before CAS", async () => {
	const auditInput = createProgressAuditInput();
	const auditReference = createIndependentAuditRef(auditInput);
	const audit = await createWorkflowEvidenceValidator().auditProgress({
		...auditInput,
		independentAuditRefs: [auditReference],
	});
	const ledger = createLedger();
	const evidence = [createEvidence()];
	const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
	const baseResolver = fixture.receiptContext.artifactResolver;
	let auditArtifactReads = 0;
	const mutatingContext: WorkflowHostReceiptConsumerContext = {
		...fixture.receiptContext,
		artifactResolver: {
			resolve: async (ref) => {
				const resolved = await baseResolver.resolve(ref);
				if (digestObject(ref) !== digestObject(fixture.auditArtifact.artifactRef)) return resolved;
				auditArtifactReads += 1;
				if (auditArtifactReads !== 2) return resolved;
				return {
					...resolved,
					bytes: new Uint8Array([0]),
					verifiedDigest: ref.digest,
					verifiedSizeBytes: ref.sizeBytes,
				};
			},
		},
	};
	let compareAndSwapCalls = 0;
	await expect(
		acceptRequirementProgressAtHost({
			evidence,
			audit,
			...fixture,
			receiptContext: mutatingContext,
			authorizer: fixture.createAuthorizer(async ({ nextLedger }) => {
				compareAndSwapCalls += 1;
				return nextLedger;
			}),
		}),
	).rejects.toThrow(/artifact|changed|content/i);
	expect(auditArtifactReads).toBe(2);
	expect(compareAndSwapCalls).toBe(0);
});

it.each(["head", "epoch", "evidence"] as const)(
	"rejects a host audit detached from the current %s binding before CAS",
	async (binding) => {
		const auditInput = createProgressAuditInput();
		const auditReference = createIndependentAuditRef(auditInput);
		const audit = await createWorkflowEvidenceValidator().auditProgress({
			...auditInput,
			independentAuditRefs: [auditReference],
		});
		const ledger = createLedger();
		const evidence = [createEvidence()];
		const fixture = createProgressAuditHostFixture(ledger, evidence, audit);
		const changedEvidence = [createEvidence({ claim: "changed after audit" })];
		const compareAndSwapCalls = 0;
		const authorizer =
			binding === "head"
				? createDiagnosticProgressAuthorizer({
						snapshot: {
							workflowId: ledger.workflowId,
							journalHead: fixture.journalHead,
							stateDigest: "foreign-state",
							currentWorkspaceDigest: "workspace",
							currentRevision: 1,
							ledger,
						},
					})
				: fixture.authorizer;
		await expect(
			acceptRequirementProgressAtHost({
				evidence: binding === "evidence" ? changedEvidence : evidence,
				audit,
				auditArtifact: fixture.auditArtifact,
				receiptContext: fixture.receiptContext,
				authorizer:
					binding === "epoch"
						? createDiagnosticProgressAuthorizer({
								snapshot: {
									workflowId: ledger.workflowId,
									journalHead: {
										workflowId: ledger.workflowId,
										sequence: 10,
										eventDigest: "progress-head",
										epochRef: { storeEpoch: 2, coordinatorEpoch: 1 },
									},
									stateDigest: "state",
									currentWorkspaceDigest: "workspace",
									currentRevision: 1,
									ledger,
								},
							})
						: authorizer,
			}),
		).rejects.toThrow(/stale|foreign|bound|state|epoch|evidence/i);
		expect(compareAndSwapCalls).toBe(0);
	},
);
