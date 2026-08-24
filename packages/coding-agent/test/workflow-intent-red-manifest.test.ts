import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	authorizeWorkflowIntentRedProductionMutation,
	createWorkflowIntentRedIntentSlice,
	createWorkflowIntentRedManifest,
	createWorkflowIntentRedTestResult,
	parseWorkflowIntentRedManifest,
	parseWorkflowIntentRedTestResult,
	replayWorkflowIntentRedTestResult,
	verifyWorkflowIntentRedManifest,
	verifyWorkflowIntentRedTestResult,
	type WorkflowIntentRedAssertion,
	type WorkflowIntentRedHostBinding,
	type WorkflowIntentRedManifestBindingInput,
	type WorkflowIntentRedMutationScope,
	type WorkflowIntentRedProcessEvidence,
	type WorkflowIntentRedResultBindingInput,
	type WorkflowIntentRedTestCaseDraft,
	workflowIntentRedArtifactEvidenceDigest,
	workflowIntentRedAuthorityPayloadDigest,
	workflowIntentRedHostBindingDigest,
	workflowIntentRedManifestBindingDigest,
	workflowIntentRedManifestEventPayload,
	workflowIntentRedMutationEffectDigest,
	workflowIntentRedMutationOperationDigest,
	workflowIntentRedMutationResourceDigest,
	workflowIntentRedMutationScopeDigest,
	workflowIntentRedResultBindingDigest,
	workflowIntentRedResultEventPayload,
	workflowIntentRedResultIdempotencyKey,
	workflowIntentRedScopeExceededEventPayload,
} from "../src/core/workflow/intent-red-manifest.js";

const WORKFLOW_ID = "workflow-red";
const TASK_ID = "task-red";
const ATTEMPT_ID = "attempt-red-1";
const SCOPE_DIGEST = "b".repeat(64);
const RECIPE_DIGEST = "c".repeat(64);
const EVENT_DIGEST = "d".repeat(64);
const CURRENT_STATE_DIGEST = "e".repeat(64);
const GOAL_DIGEST = "f".repeat(64);
const SCORECARD_DIGEST = "1".repeat(64);
const EXECUTION_IDENTITY = "workflow-red-execution";
const SESSION_ID = "workflow-red-session";
const NOW = "2026-08-17T12:00:00.000Z";
const CURRENT_REVISION = 1;
const execFile = promisify(execFileCallback);

const epochRef: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const journalHead: WorkflowJournalHead = {
	workflowId: WORKFLOW_ID,
	sequence: 12,
	eventDigest: EVENT_DIGEST,
	epochRef,
};

function hostContext(): WorkflowHostReceiptConsumerContext {
	return createFixtureHostReceiptConsumerContext();
}

const hostBinding: WorkflowIntentRedHostBinding = {
	goalDigest: GOAL_DIGEST,
	scorecardDigest: SCORECARD_DIGEST,
	publicBoundaryRegistryDigest: digestObject([
		{ publicBoundary: "public:workflow-submit", target: "forbidden_outcome", outcomeIds: ["mock-success-accepted"] },
		{ publicBoundary: "public:workflow-submit", target: "user_outcome", outcomeIds: ["real-user-visible-success"] },
	]),
	publicBoundaryRegistry: [
		{ publicBoundary: "public:workflow-submit", target: "forbidden_outcome", outcomeIds: ["mock-success-accepted"] },
		{ publicBoundary: "public:workflow-submit", target: "user_outcome", outcomeIds: ["real-user-visible-success"] },
	],
	effectDigest: workflowIntentRedMutationEffectDigest({
		resourceDigest: workflowIntentRedMutationResourceDigest({
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
		}),
		affectedProductionSurface: ["packages/coding-agent/src/core/workflow/intent-red-manifest.ts"],
		writeSet: ["packages/coding-agent/src/core/workflow/intent-red-manifest.ts"],
		closureRationale: "The RED authority is limited to the declared public workflow submission invariant.",
	}),
	affectedProductionSurface: ["packages/coding-agent/src/core/workflow/intent-red-manifest.ts"],
	writeSet: ["packages/coding-agent/src/core/workflow/intent-red-manifest.ts"],
	closureRationale: "The RED authority is limited to the declared public workflow submission invariant.",
};

const FRESH_FROM = "2026-08-17T11:00:00.000Z";
const FRESH_UNTIL = "2026-08-17T13:00:00.000Z";

function durabilityEvidence(kind: "integration" | "restart" | "process" | "store", artifactId: string) {
	const artifact = artifactRef(artifactId);
	const source = `host-${kind}`;
	const provenanceDigest = digestObject({
		kind,
		artifactRef: artifact,
		observedAt: FRESH_FROM,
		freshUntil: FRESH_UNTIL,
		source,
	});
	return {
		kind,
		artifactRef: artifact,
		provenanceDigest,
		observedAt: FRESH_FROM,
		freshUntil: FRESH_UNTIL,
		source,
	} as const;
}

function artifactRef(artifactId: string, sourceEventSequence = 20): WorkflowArtifactRef {
	const relativePath = `red/${artifactId}`;
	const bytes = canonicalJsonBytes({ artifactId, relativePath, sourceEventSequence, payloadDigest: "fixture" });
	return {
		artifactId,
		relativePath,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence,
	};
}

function assertion(assertionId: string, target: WorkflowIntentRedAssertion["target"]): WorkflowIntentRedAssertion {
	return {
		assertionId,
		target,
		outcomeId: target === "user_outcome" ? "real-user-visible-success" : "mock-success-accepted",
		publicBoundary: "public:workflow-submit",
		description: `${assertionId} is linked to a declared outcome`,
	};
}

function makeTestCase(overrides: Partial<WorkflowIntentRedTestCaseDraft> = {}): WorkflowIntentRedTestCaseDraft {
	return {
		testId: "red-scope-substitution",
		attackId: "scope_substitution",
		commandArtifactRef: artifactRef("command"),
		commandDigest: artifactRef("command").digest,
		sourceArtifactRef: artifactRef("source"),
		sourceDigest: artifactRef("source").digest,
		inputArtifactRefs: [artifactRef("input")],
		inputDigest: digestObject([artifactRef("input")]),
		publicBoundary: "public:workflow-submit",
		hostScanEvidenceRefs: [artifactRef("public-boundary-scan")],
		evidenceClassification: "acceptance",
		assertions: [
			assertion("assert-user-outcome", "user_outcome"),
			assertion("assert-forbidden", "forbidden_outcome"),
		],
		expectedExitCode: 1,
		timeoutMilliseconds: 500,
		requiredEvidenceKinds: ["process", "artifact", "integration", "restart", "store"],
		owner: "host",
		hidden: true,
		requiresRealRuntime: true,
		mockOnly: false,
		...overrides,
	};
}

function makeManifestDraft(
	overrides: Partial<WorkflowIntentRedManifestBindingInput> = {},
	testOverrides: Partial<WorkflowIntentRedTestCaseDraft> = {},
): WorkflowIntentRedManifestBindingInput {
	const test = makeTestCase(testOverrides);
	return {
		schemaId: "workflow-red-test-manifest-v1",
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		expectedHead: journalHead,
		expectedHeadDigest: digestObject(journalHead),
		epochRef,
		scopeDigest: SCOPE_DIGEST,
		recipeDigest: RECIPE_DIGEST,
		planRevision: 2,
		tests: [test],
		maxTests: 1,
		maxRuntimeMilliseconds: 500,
		evidenceRefs: [
			test.commandArtifactRef,
			test.sourceArtifactRef,
			...test.inputArtifactRefs,
			...test.hostScanEvidenceRefs,
			artifactRef("integration-evidence"),
			artifactRef("restart-evidence"),
			artifactRef("process-evidence"),
			artifactRef("store-evidence"),
		],
		durabilityEvidence: [
			durabilityEvidence("integration", "integration-evidence"),
			durabilityEvidence("restart", "restart-evidence"),
			durabilityEvidence("process", "process-evidence"),
			durabilityEvidence("store", "store-evidence"),
		],
		executable: true,
		owner: "host",
		...overrides,
	};
}

function makeManifest(
	overrides: Partial<WorkflowIntentRedManifestBindingInput> = {},
	testOverrides: Partial<WorkflowIntentRedTestCaseDraft> = {},
): {
	manifest: ReturnType<typeof createWorkflowIntentRedManifest>;
	hostReceipt: WorkflowVerifiedHostReceipt;
	authorityReceipt: WorkflowVerifiedHostReceipt;
	hostBinding: WorkflowIntentRedHostBinding;
} {
	const binding = makeManifestDraft(overrides, testOverrides);
	const bindingDigest = workflowIntentRedManifestBindingDigest(binding);
	const hostReceipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "red-manifest-receipt",
		issuerId: "host",
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest: digestObject(binding),
		artifactRef: artifactRef("manifest-receipt"),
		issuedAt: "2026-08-17T11:59:00.000Z",
		validUntil: "2026-08-17T13:00:00.000Z",
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: CURRENT_STATE_DIGEST,
		revision: CURRENT_REVISION,
	});
	const manifest = createWorkflowIntentRedManifest({ ...binding, hostReceipt });
	const authorityReceipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: "red-authority-receipt",
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: workflowIntentRedHostBindingDigest({
			manifestDigest: manifest.manifestDigest,
			hostBinding,
			artifactEvidenceDigest: workflowIntentRedArtifactEvidenceDigest(manifest),
			resourceDigest: workflowIntentRedMutationResourceDigest({
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			}),
			operationDigest: workflowIntentRedMutationOperationDigest({
				manifestDigest: manifest.manifestDigest,
				recipeDigest: manifest.recipeDigest,
				planRevision: manifest.planRevision,
				resourceDigest: workflowIntentRedMutationResourceDigest({
					workflowId: WORKFLOW_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
				}),
			}),
			executionIdentity: EXECUTION_IDENTITY,
			sessionId: SESSION_ID,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		}),
		payloadDigest: workflowIntentRedAuthorityPayloadDigest({
			hostBinding,
			artifactEvidenceDigest: workflowIntentRedArtifactEvidenceDigest(manifest),
			resourceDigest: workflowIntentRedMutationResourceDigest({
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			}),
			operationDigest: workflowIntentRedMutationOperationDigest({
				manifestDigest: manifest.manifestDigest,
				recipeDigest: manifest.recipeDigest,
				planRevision: manifest.planRevision,
				resourceDigest: workflowIntentRedMutationResourceDigest({
					workflowId: WORKFLOW_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
				}),
			}),
			executionIdentity: EXECUTION_IDENTITY,
			sessionId: SESSION_ID,
		}),
		artifactRef: artifactRef("authority-receipt"),
		issuedAt: "2026-08-17T11:59:00.000Z",
		validUntil: "2026-08-17T13:00:00.000Z",
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: CURRENT_STATE_DIGEST,
		revision: CURRENT_REVISION,
		capabilityBinding: {
			capability: "workflow_intent_red_mutation",
			resourceDigest: workflowIntentRedMutationResourceDigest({
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			}),
			operationDigest: workflowIntentRedMutationOperationDigest({
				manifestDigest: manifest.manifestDigest,
				recipeDigest: manifest.recipeDigest,
				planRevision: manifest.planRevision,
				resourceDigest: workflowIntentRedMutationResourceDigest({
					workflowId: WORKFLOW_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
				}),
			}),
			executionIdentity: EXECUTION_IDENTITY,
			sessionId: SESSION_ID,
		},
	});
	return { manifest, hostReceipt, authorityReceipt, hostBinding };
}

function makeResultDraft(
	manifest: ReturnType<typeof createWorkflowIntentRedManifest>,
	overrides: Partial<WorkflowIntentRedResultBindingInput> = {},
): WorkflowIntentRedResultBindingInput {
	const test = manifest.tests[0];
	const processEvidence: Omit<WorkflowIntentRedProcessEvidence, "provenanceDigest"> = {
		artifactRef: artifactRef("process"),
		testId: test.testId,
		commandDigest: test.commandDigest,
		sourceDigest: test.sourceDigest,
		publicBoundary: test.publicBoundary,
		executionIdentity: "host-process-1",
		processId: 321,
		startedAt: FRESH_FROM,
		completedAt: "2026-08-17T11:30:00.000Z",
		mode: "real_process",
		fakeOnly: false,
	};
	return {
		schemaId: "workflow-red-test-result-v1",
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		manifestDigest: manifest.manifestDigest,
		recipeDigest: manifest.recipeDigest,
		planRevision: manifest.planRevision,
		testId: test.testId,
		testDigest: test.testDigest,
		invocationId: "invocation-red-1",
		idempotencyKey: workflowIntentRedResultIdempotencyKey({
			manifestDigest: manifest.manifestDigest,
			testId: test.testId,
			invocationId: "invocation-red-1",
			testDigest: test.testDigest,
			recipeDigest: manifest.recipeDigest,
			planRevision: manifest.planRevision,
		}),
		expectedHeadDigest: manifest.expectedHeadDigest,
		epochRef,
		runtimeMode: "true_runtime",
		startBoundaryRef: artifactRef("start-boundary"),
		endBoundaryRef: artifactRef("end-boundary"),
		processEvidenceRefs: [artifactRef("process")],
		processEvidence: {
			...processEvidence,
			provenanceDigest: digestObject({ kind: "process", ...processEvidence }),
		},
		exitCode: 1,
		timedOut: false,
		stdoutArtifactRef: artifactRef("stdout"),
		stderrArtifactRef: artifactRef("stderr"),
		evidenceRefs: [artifactRef("result-evidence")],
		classification: "assertion_failure",
		passed: false,
		failedAssertions: [
			{
				assertionId: test.assertions[0].assertionId,
				target: test.assertions[0].target,
				outcomeId: test.assertions[0].outcomeId,
				publicBoundary: test.assertions[0].publicBoundary,
				assertionDigest: digestObject(test.assertions[0]),
				artifactRef: artifactRef("result-evidence"),
				message: "the user-visible outcome is absent",
			},
		],
		...overrides,
	};
}

function makeResult(
	manifest: ReturnType<typeof createWorkflowIntentRedManifest>,
	overrides: Partial<WorkflowIntentRedResultBindingInput> = {},
): ReturnType<typeof createWorkflowIntentRedTestResult> {
	const binding = makeResultDraft(manifest, overrides);
	const hostReceipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `red-result-${binding.invocationId}`,
		issuerId: "host",
		workflowId: WORKFLOW_ID,
		bindingDigest: workflowIntentRedResultBindingDigest(binding),
		payloadDigest: digestObject(binding),
		artifactRef: artifactRef(`result-receipt-${binding.invocationId}`),
		issuedAt: "2026-08-17T11:59:00.000Z",
		validUntil: "2026-08-17T13:00:00.000Z",
		keyId: "fixture-receipt-key",
		oneUse: true,
		stateDigest: CURRENT_STATE_DIGEST,
		revision: CURRENT_REVISION,
	});
	return createWorkflowIntentRedTestResult({ ...binding, hostReceipt });
}

function mutationScope(manifest: ReturnType<typeof createWorkflowIntentRedManifest>): WorkflowIntentRedMutationScope {
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: manifest.workflowId,
		taskId: manifest.taskId,
		attemptId: manifest.attemptId,
	});
	return {
		resourceDigest,
		effectDigest: manifestTokenDataEffectDigest(manifest),
		operationDigest: workflowIntentRedMutationOperationDigest({
			manifestDigest: manifest.manifestDigest,
			recipeDigest: manifest.recipeDigest,
			planRevision: manifest.planRevision,
			resourceDigest,
		}),
		affectedProductionSurface: hostBinding.affectedProductionSurface,
		writeSet: hostBinding.writeSet,
		closureRationale: hostBinding.closureRationale,
	};
}

function manifestTokenDataEffectDigest(manifest: ReturnType<typeof createWorkflowIntentRedManifest>): string {
	return workflowIntentRedMutationEffectDigest({
		resourceDigest: workflowIntentRedMutationResourceDigest({
			workflowId: manifest.workflowId,
			taskId: manifest.taskId,
			attemptId: manifest.attemptId,
		}),
		affectedProductionSurface: hostBinding.affectedProductionSurface,
		writeSet: hostBinding.writeSet,
		closureRationale: hostBinding.closureRationale,
	});
}

function realArtifactRef(artifactId: string, bytes: Uint8Array, sourceEventSequence = 40): WorkflowArtifactRef {
	const relativePath = `red/real/${artifactId}`;
	return {
		artifactId,
		relativePath,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence,
	};
}

function contextWithArtifacts(artifacts: ReadonlyMap<string, Uint8Array>) {
	const fixtureContext = hostContext();
	return {
		...fixtureContext,
		artifactResolver: {
			resolve: async (ref: WorkflowArtifactRef) => {
				const bytes = artifacts.get(ref.digest);
				if (bytes === undefined) return fixtureContext.artifactResolver.resolve(ref);
				return {
					envelope: {
						ref,
						payloadKind: "evidence" as const,
						codec: "canonical_json" as const,
						immutable: true as const,
					},
					exists: true as const,
					bytes,
					verifiedDigest: ref.digest,
					verifiedSizeBytes: ref.sizeBytes,
				};
			},
		},
	};
}

describe("workflow intent-TDD RED manifest", () => {
	it("RED: batches serial schema-field probes into one outcome-coherent mutation matrix", () => {
		const { manifest } = makeManifest();
		const slice = createWorkflowIntentRedIntentSlice({
			manifest,
			userOutcomeId: "real-user-visible-success",
			publicBoundary: "public:workflow-submit",
			forbiddenOutcomeId: "mock-success-accepted",
			allowedProductionClosure: hostBinding,
			hostBinding,
			baseRedTestId: manifest.tests[0].testId,
			proposals: [
				{
					proposalId: "field-task",
					schemaField: "taskId",
					evidenceRefs: [artifactRef("matrix-task")],
					falsifiableOutcomeIds: ["mock-success-accepted", "real-user-visible-success"],
					wallTimeMilliseconds: 10,
				},
				{
					proposalId: "field-attempt",
					schemaField: "attemptId",
					evidenceRefs: [artifactRef("matrix-attempt")],
					falsifiableOutcomeIds: ["mock-success-accepted", "real-user-visible-success"],
					wallTimeMilliseconds: 10,
				},
			],
			mutationCases: [
				{
					caseId: "restart",
					kind: "restart_identical_reconstruction",
					evidenceRefs: [artifactRef("matrix-restart")],
				},
				{ caseId: "stale", kind: "stale_approval", evidenceRefs: [artifactRef("matrix-stale")] },
				{ caseId: "broad", kind: "overbroad_approval", evidenceRefs: [artifactRef("matrix-broad")] },
				{
					caseId: "duplicate",
					kind: "concurrent_duplicate_exactly_once",
					evidenceRefs: [artifactRef("matrix-duplicate")],
				},
				{ caseId: "status", kind: "read_only_status", evidenceRefs: [artifactRef("matrix-status")] },
			],
			metrics: { falsifiableOutcomeCount: 2, evidenceCount: 7, wallTimeMilliseconds: 50 },
		});

		expect(slice.classification).toBe("coherent_intent_slice");
		expect(slice.requiresFreshRed).toBe(false);
		expect(slice.authorityUnitCount).toBe(1);
		expect(slice.progressUnitCount).toBe(1);
		expect(slice.mutationCases.map((item) => item.kind)).toEqual([
			"concurrent_duplicate_exactly_once",
			"overbroad_approval",
			"read_only_status",
			"restart_identical_reconstruction",
			"stale_approval",
		]);
		expect(slice.allowedProductionClosure.writeSet).toEqual(hostBinding.writeSet);
		expect(slice.metrics.outcomesPerWallTime).toBe(0.04);
		expect(slice.metrics.evidencePerWallTime).toBe(0.14);
		expect(slice.sliceDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(createWorkflowIntentRedIntentSlice(JSON.parse(JSON.stringify(slice)))).toEqual(slice);
	});

	it("RED: requires fresh RED for a new outcome or production closure and rejects easy-field farming", () => {
		const { manifest } = makeManifest();
		const base = {
			manifest,
			userOutcomeId: "real-user-visible-success",
			publicBoundary: "public:workflow-submit",
			forbiddenOutcomeId: "mock-success-accepted",
			allowedProductionClosure: hostBinding,
			hostBinding,
			baseRedTestId: manifest.tests[0].testId,
			proposals: [
				{
					proposalId: "field-task",
					schemaField: "taskId",
					evidenceRefs: [artifactRef("matrix-task")],
					falsifiableOutcomeIds: ["mock-success-accepted", "real-user-visible-success"],
					wallTimeMilliseconds: 10,
				},
			],
			mutationCases: [
				{
					caseId: "restart",
					kind: "restart_identical_reconstruction" as const,
					evidenceRefs: [artifactRef("matrix-restart")],
				},
				{ caseId: "stale", kind: "stale_approval" as const, evidenceRefs: [artifactRef("matrix-stale")] },
				{ caseId: "broad", kind: "overbroad_approval" as const, evidenceRefs: [artifactRef("matrix-broad")] },
				{
					caseId: "duplicate",
					kind: "concurrent_duplicate_exactly_once" as const,
					evidenceRefs: [artifactRef("matrix-duplicate")],
				},
				{ caseId: "status", kind: "read_only_status" as const, evidenceRefs: [artifactRef("matrix-status")] },
			],
			metrics: { falsifiableOutcomeCount: 2, evidenceCount: 6, wallTimeMilliseconds: 40 },
		};

		expect(() =>
			createWorkflowIntentRedIntentSlice({
				...base,
				userOutcomeId: "another-user-outcome",
			}),
		).toThrow(/fresh RED|new user-visible outcome/i);
		expect(() =>
			createWorkflowIntentRedIntentSlice({
				...base,
				allowedProductionClosure: {
					...hostBinding,
					writeSet: [...hostBinding.writeSet, "packages/coding-agent/src/core/workflow/contracts.ts"],
					effectDigest: workflowIntentRedMutationEffectDigest({
						resourceDigest: workflowIntentRedMutationResourceDigest({
							workflowId: WORKFLOW_ID,
							taskId: TASK_ID,
							attemptId: ATTEMPT_ID,
						}),
						affectedProductionSurface: hostBinding.affectedProductionSurface,
						writeSet: [...hostBinding.writeSet, "packages/coding-agent/src/core/workflow/contracts.ts"],
						closureRationale: hostBinding.closureRationale,
					}),
				},
			}),
		).toThrow(/fresh RED|production closure/i);
		expect(() =>
			createWorkflowIntentRedIntentSlice({
				...base,
				proposals: Array.from({ length: 20 }, (_, index) => ({
					proposalId: `field-${index}`,
					schemaField: `field-${index}`,
					evidenceRefs: [artifactRef(`matrix-field-${index}`)],
					falsifiableOutcomeIds: ["real-user-visible-success"],
					wallTimeMilliseconds: 1,
				})),
				metrics: { falsifiableOutcomeCount: 1, evidenceCount: 1, wallTimeMilliseconds: 20 },
			}),
		).toThrow(/field|falsifiable|evidence|farming/i);
	});

	it("RED: creates and canonically replays a closed manifest bound to task, attempt, head, epoch, command, source, and input digests", () => {
		const { manifest } = makeManifest();

		expect(manifest.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.expectedHeadDigest).toBe(digestObject(journalHead));
		expect(manifest.tests[0].testDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(makeManifest({ recipeDigest: "4".repeat(64) }).manifest.idempotencyKey).not.toBe(manifest.idempotencyKey);
		expect(makeManifest({ planRevision: 3 }).manifest.idempotencyKey).not.toBe(manifest.idempotencyKey);
		expect(makeManifest({}, { attackId: "different-attack" }).manifest.idempotencyKey).not.toBe(
			manifest.idempotencyKey,
		);

		const replayed = parseWorkflowIntentRedManifest(canonicalJsonBytes(manifest));
		expect(replayed).toEqual(manifest);
		for (const key of ["extra", "manifestDigest", "idempotencyKey"] as const) {
			const forged = { ...manifest, [key]: key === "extra" ? true : "forged" };
			expect(() => parseWorkflowIntentRedManifest(canonicalJsonBytes(forged))).toThrow(
				/closed|unknown|canonical|digest/i,
			);
		}
	});

	it("RED: refuses one-field task, attempt, head, epoch, command, source, or input mutations", () => {
		const { manifest } = makeManifest();
		const mutations = [
			{ ...manifest, taskId: "other-task" },
			{ ...manifest, attemptId: "other-attempt" },
			{ ...manifest, expectedHead: { ...manifest.expectedHead, sequence: 13 } },
			{ ...manifest, epochRef: { ...manifest.epochRef, coordinatorEpoch: 5 } },
			{
				...manifest,
				tests: [{ ...manifest.tests[0], commandDigest: "4".repeat(64) }],
			},
			{
				...manifest,
				tests: [{ ...manifest.tests[0], sourceDigest: "5".repeat(64) }],
			},
			{
				...manifest,
				tests: [{ ...manifest.tests[0], inputDigest: "6".repeat(64) }],
			},
		];
		for (const mutation of mutations)
			expect(() => parseWorkflowIntentRedManifest(canonicalJsonBytes(mutation))).toThrow(
				/digest|binding|head|epoch|closed/i,
			);
	});

	it("RED: classifies setup, test, and infrastructure failures as nonauthorizing", async () => {
		for (const classification of ["setup_error", "test_error", "infrastructure_error"] as const) {
			const candidate = makeManifest();
			const candidateContext = hostContext();
			const candidateToken = await verifyWorkflowIntentRedManifest({
				manifest: candidate.manifest,
				context: candidateContext,
				hostBinding: candidate.hostBinding,
				authorityReceipt: candidate.authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			});
			const candidateResult = makeResult(candidate.manifest, { classification, failedAssertions: [] });
			const candidateResultToken = await verifyWorkflowIntentRedTestResult({
				manifestToken: candidateToken,
				result: candidateResult,
				context: candidateContext,
				hostBinding: candidate.hostBinding,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			});
			expect(
				(
					await authorizeWorkflowIntentRedProductionMutation({
						manifestToken: candidateToken,
						resultTokens: [candidateResultToken],
						scope: mutationScope(candidate.manifest),
						currentHead: journalHead,
						currentEpoch: epochRef,
						currentStateDigest: CURRENT_STATE_DIGEST,
						currentRevision: CURRENT_REVISION,
						trustedNow: NOW,
					})
				).authorized,
			).toBe(false);
		}
	});

	it("RED: classifies temporary debug probes as nonauthorizing even with a genuine assertion failure", async () => {
		const candidate = makeManifest({}, { evidenceClassification: "debug_probe" });
		const context = hostContext();
		const manifestToken = await verifyWorkflowIntentRedManifest({
			manifest: candidate.manifest,
			context,
			hostBinding: candidate.hostBinding,
			authorityReceipt: candidate.authorityReceipt,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const resultToken = await verifyWorkflowIntentRedTestResult({
			manifestToken,
			result: makeResult(candidate.manifest),
			context,
			hostBinding: candidate.hostBinding,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const authorization = await authorizeWorkflowIntentRedProductionMutation({
			manifestToken,
			resultTokens: [resultToken],
			scope: mutationScope(candidate.manifest),
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		expect(authorization.authorized).toBe(false);
		expect(authorization.reason).toBe("no_outcome_linked_assertion_failure");
	});

	it("RED: rejects caller-created manifest and result records without opaque host verification", async () => {
		const { manifest } = makeManifest();
		const result = makeResult(manifest);

		await expect(
			Promise.resolve().then(() =>
				authorizeWorkflowIntentRedProductionMutation({ manifest, results: [result] } as never),
			),
		).rejects.toThrow(/verified|opaque|token/i);
	});

	it("RED: reports CONTRACT_CHANGE when the generic host principal-authorizer seam is absent", async () => {
		const { manifest, authorityReceipt } = makeManifest();
		const fixtureContext = createFixtureHostReceiptConsumerContext();
		await expect(
			verifyWorkflowIntentRedManifest({
				manifest,
				context: { ...fixtureContext, principalAuthorizer: undefined as never },
				hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/CONTRACT_CHANGE|principalAuthorizer/i);
	});

	it("RED: sends a typed capability request bound to operation, resource, head, epoch, execution, and session", async () => {
		const { manifest, authorityReceipt } = makeManifest();
		const fixtureContext = hostContext();
		const calls: WorkflowHostPrincipalCapabilityAuthorizationInput[] = [];
		const context = {
			...fixtureContext,
			principalAuthorizer: {
				authorize: async (input: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
					calls.push(input);
					return fixtureContext.principalAuthorizer.authorize(input);
				},
			},
		};

		await verifyWorkflowIntentRedManifest({
			manifest,
			context,
			hostBinding,
			authorityReceipt,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual(
			expect.objectContaining({
				receipt: authorityReceipt,
				workflowId: WORKFLOW_ID,
				capability: "workflow_intent_red_mutation",
				bindingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
				resourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
				operationDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
				stateDigest: CURRENT_STATE_DIGEST,
				revision: CURRENT_REVISION,
				epochRef,
				executionIdentity: expect.any(String),
				sessionId: expect.any(String),
			}),
		);
		expect(calls[0]).not.toHaveProperty("principalId");
		expect(calls[0]).not.toHaveProperty("issuerId");
		expect(calls[0]).not.toHaveProperty("receiptId");
		expect(calls[0]).not.toHaveProperty("receiptKind");
	});

	it("RED: rejects capability, owner, and key substitutions at the public host authority boundary", async () => {
		const candidate = makeManifest();
		const verify = (authorityReceipt: WorkflowVerifiedHostReceipt) =>
			verifyWorkflowIntentRedManifest({
				manifest: candidate.manifest,
				context: hostContext(),
				hostBinding: candidate.hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			});

		await expect(
			verify({
				...candidate.authorityReceipt,
				capabilityBinding: {
					...candidate.authorityReceipt.capabilityBinding!,
					capability: "child_output_delivery_ack",
				},
			}),
		).rejects.toThrow(/capability|binding|signature|receipt/i);
		await expect(verify({ ...candidate.authorityReceipt, issuerId: "caller-forged-owner" })).rejects.toThrow(
			/authorized|signature|receipt|owner/i,
		);
		await expect(verify({ ...candidate.authorityReceipt, keyId: "caller-forged-key" })).rejects.toThrow(
			/authorized|signature|receipt|key/i,
		);
	});

	it("RED: rejects a broad production rewrite outside the declared invariant closure", async () => {
		const candidate = makeManifest();
		const context = hostContext();
		const manifestToken = await verifyWorkflowIntentRedManifest({
			manifest: candidate.manifest,
			context,
			hostBinding: candidate.hostBinding,
			authorityReceipt: candidate.authorityReceipt,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const resultToken = await verifyWorkflowIntentRedTestResult({
			manifestToken,
			result: makeResult(candidate.manifest),
			context,
			hostBinding: candidate.hostBinding,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const scope = mutationScope(candidate.manifest);
		await expect(
			authorizeWorkflowIntentRedProductionMutation({
				manifestToken,
				resultTokens: [resultToken],
				scope: {
					...scope,
					affectedProductionSurface: [
						...scope.affectedProductionSurface,
						"packages/coding-agent/src/core/workflow/contracts.ts",
					],
					writeSet: [...scope.writeSet, "packages/coding-agent/src/core/workflow/contracts.ts"],
				},
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/scope|broader|invariant|closure/i);
	});

	it("RED: binds host receipts and immutable evidence, and rejects stale heads and forged receipts", async () => {
		const { manifest, authorityReceipt } = makeManifest();
		const context = hostContext();
		await expect(
			verifyWorkflowIntentRedManifest({
				manifest,
				context,
				hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).resolves.toMatchObject({});

		await expect(
			verifyWorkflowIntentRedManifest({
				manifest,
				context,
				hostBinding,
				authorityReceipt,
				currentHead: { ...journalHead, sequence: journalHead.sequence + 1 },
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/stale|head/i);

		const forged = { ...manifest, hostReceipt: { ...manifest.hostReceipt, bindingDigest: "e".repeat(64) } };
		await expect(
			verifyWorkflowIntentRedManifest({
				manifest: forged,
				context,
				hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/digest|receipt|binding/i);
	});

	it("RED: result idempotency survives restart replay but rejects a same-key forged result", () => {
		const { manifest } = makeManifest();
		const result = makeResult(manifest);
		const restarted = parseWorkflowIntentRedTestResult(canonicalJsonBytes(result));
		expect(replayWorkflowIntentRedTestResult({ persisted: null, incoming: result }).status).toBe("new");
		expect(replayWorkflowIntentRedTestResult({ persisted: result, incoming: restarted })).toEqual({
			status: "already_committed",
			result,
		});
		expect(() =>
			replayWorkflowIntentRedTestResult({
				persisted: result,
				incoming: { ...result, exitCode: 0 },
			}),
		).toThrow(/idempotent|replay|digest|conflict/i);
	});

	it("RED: rejects post-effect replay after the production head advances and exposes the admissible base head", async () => {
		const candidate = makeManifest();
		const context = hostContext();
		const manifestToken = await verifyWorkflowIntentRedManifest({
			manifest: candidate.manifest,
			context,
			hostBinding: candidate.hostBinding,
			authorityReceipt: candidate.authorityReceipt,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const resultToken = await verifyWorkflowIntentRedTestResult({
			manifestToken,
			result: makeResult(candidate.manifest),
			context,
			hostBinding: candidate.hostBinding,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		const postEffectAuthorization = await authorizeWorkflowIntentRedProductionMutation({
			manifestToken,
			resultTokens: [resultToken],
			scope: mutationScope(candidate.manifest),
			currentHead: { ...journalHead, sequence: journalHead.sequence + 1 },
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		expect(postEffectAuthorization.authorized).toBe(false);
		expect(postEffectAuthorization.reason).toBe("post_effect");
		expect(postEffectAuthorization.quarantine).toEqual({
			reason: "post_effect",
			lastAdmissibleProductionHeadDigest: digestObject(journalHead),
		});
		expect(postEffectAuthorization.productionBaseHead).toEqual(journalHead);
		expect(postEffectAuthorization.productionBaseHeadDigest).toBe(digestObject(journalHead));
		await expect(
			authorizeWorkflowIntentRedProductionMutation({
				manifestToken,
				resultTokens: [resultToken],
				scope: mutationScope(candidate.manifest),
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/consumed|one-use|token/i);
	});

	it("RED: rejects result assertion substitution, shell/mock evidence, and stale result heads", async () => {
		const { manifest, authorityReceipt } = makeManifest();
		const result = makeResult(manifest);
		const context = hostContext();
		const manifestToken = await verifyWorkflowIntentRedManifest({
			manifest,
			context,
			hostBinding,
			authorityReceipt,
			currentHead: journalHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION,
			trustedNow: NOW,
		});
		await expect(
			verifyWorkflowIntentRedTestResult({
				manifestToken,
				result,
				context,
				hostBinding,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).resolves.toMatchObject({});

		const substituted = makeResult(manifest, {
			failedAssertions: [{ ...result.failedAssertions[0], outcomeId: "unbound-outcome" }],
		});
		await expect(
			verifyWorkflowIntentRedTestResult({
				manifestToken,
				result: substituted,
				context,
				hostBinding,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/assertion|outcome|binding/i);

		const shell = makeResult(manifest, { runtimeMode: "worker_free_shell" });
		await expect(
			verifyWorkflowIntentRedTestResult({
				manifestToken,
				result: shell,
				context,
				hostBinding,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/runtime|mock|shell/i);

		await expect(
			verifyWorkflowIntentRedTestResult({
				manifestToken,
				result,
				context,
				hostBinding,
				currentHead: { ...journalHead, eventDigest: "f".repeat(64) },
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/stale|head/i);
	});

	it("RED: rejects worker-added private _for_test seams despite an acceptance label and caller booleans", async () => {
		expect(() => makeManifest({}, { publicBoundary: "private:workflow_submit_for_test" })).toThrow(
			/private|boundary|seam/i,
		);
		expect(() => makeManifest({}, { hostScanEvidenceRefs: [artifactRef("worker_for_test_scan")] })).toThrow(
			/private|source|seam|scan/i,
		);
		const candidate = makeManifest();
		const processEvidence = makeResultDraft(candidate.manifest).processEvidence;
		expect(() =>
			makeResult(candidate.manifest, {
				processEvidence: {
					...processEvidence,
					executionIdentity: "node-process_for_test",
					provenanceDigest: digestObject({
						kind: "process",
						artifactRef: processEvidence.artifactRef,
						testId: processEvidence.testId,
						commandDigest: processEvidence.commandDigest,
						sourceDigest: processEvidence.sourceDigest,
						publicBoundary: processEvidence.publicBoundary,
						executionIdentity: "node-process_for_test",
						processId: processEvidence.processId,
						startedAt: processEvidence.startedAt,
						completedAt: processEvidence.completedAt,
						mode: processEvidence.mode,
						fakeOnly: processEvidence.fakeOnly,
					}),
				},
			}),
		).toThrow(/private|test|process|seam/i);
	});

	it("RED: rejects a private-hook source even when the caller's public scan is clean", async () => {
		const privateSourceBytes = canonicalJsonBytes({
			publicBoundary: "public:workflow-submit",
			implementation: "submit_for_test",
		});
		const privateSourceRef = realArtifactRef("public-source", privateSourceBytes);
		const { manifest, authorityReceipt } = makeManifest(
			{},
			{
				sourceArtifactRef: privateSourceRef,
				sourceDigest: privateSourceRef.digest,
			},
		);
		const context = contextWithArtifacts(new Map([[privateSourceRef.digest, privateSourceBytes]]));
		await expect(
			verifyWorkflowIntentRedManifest({
				manifest,
				context,
				hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/private|source|seam|test/i);

		const sourceInspectionBytes = canonicalJsonBytes({
			command: "node -e fs.readFileSync(__filename, 'utf8')",
		});
		const sourceInspectionRef = realArtifactRef("public-command", sourceInspectionBytes);
		const inspectionCandidate = makeManifest(
			{},
			{
				commandArtifactRef: sourceInspectionRef,
				commandDigest: sourceInspectionRef.digest,
			},
		);
		const inspectionContext = contextWithArtifacts(new Map([[sourceInspectionRef.digest, sourceInspectionBytes]]));
		await expect(
			verifyWorkflowIntentRedManifest({
				manifest: inspectionCandidate.manifest,
				context: inspectionContext,
				hostBinding,
				authorityReceipt: inspectionCandidate.authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			}),
		).rejects.toThrow(/private|source|inspection|seam/i);
	});

	it("RED: requires real process, restart, integration, and store evidence before mutation authority", async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), "workflow-red-real-"));
		try {
			const publicCommand =
				"process.stdout.write(JSON.stringify({pid: process.pid, boundary: 'public:workflow-submit'}))";
			const storePath = join(tempDirectory, "public-store.json");
			const firstRun = await execFile(process.execPath, ["-e", publicCommand]);
			const firstObservation = JSON.parse(String(firstRun.stdout)) as { pid: number; boundary: string };
			await writeFile(
				storePath,
				JSON.stringify({ boundary: "public:workflow-submit", value: firstObservation.pid }),
				"utf8",
			);
			const restartCommand = `const fs = require("node:fs"); const state = JSON.parse(fs.readFileSync(${JSON.stringify(storePath)}, "utf8")); process.stdout.write(JSON.stringify({pid: process.pid, boundary: state.boundary, restored: state.value}));`;
			const restartedRun = await execFile(process.execPath, ["-e", restartCommand]);
			const restartedObservation = JSON.parse(String(restartedRun.stdout)) as {
				pid: number;
				boundary: string;
				restored: number;
			};
			expect(firstObservation.boundary).toBe("public:workflow-submit");
			expect(restartedObservation.boundary).toBe("public:workflow-submit");
			expect(restartedObservation.restored).toBe(firstObservation.pid);
			expect(restartedObservation.pid).not.toBe(firstObservation.pid);

			const storedValue = await readFile(storePath, "utf8");
			expect(storedValue).toContain("public:workflow-submit");

			const commandBytes = canonicalJsonBytes({
				argv: [process.execPath, "-e", restartCommand],
				publicBoundary: "public:workflow-submit",
			});
			const sourceBytes = canonicalJsonBytes({
				entrypoint: "public:workflow-submit",
				behavior: "public process boundary",
			});
			const inputBytes = canonicalJsonBytes({ input: "public outcome" });
			const scanBytes = canonicalJsonBytes({
				publicBoundary: "public:workflow-submit",
				scan: "public API inventory",
			});
			const integrationBytes = canonicalJsonBytes({
				kind: "integration",
				first: firstObservation,
				restarted: restartedObservation,
			});
			const restartBytes = canonicalJsonBytes({
				kind: "restart",
				firstPid: firstObservation.pid,
				restartedPid: restartedObservation.pid,
			});
			const processBytes = canonicalJsonBytes({ kind: "process", output: String(firstRun.stdout) });
			const storeBytes = canonicalJsonBytes({ kind: "store", value: storedValue });
			const refs = {
				command: realArtifactRef("real-command", commandBytes),
				source: realArtifactRef("real-source", sourceBytes),
				input: realArtifactRef("real-input", inputBytes),
				scan: realArtifactRef("real-scan", scanBytes),
				integration: realArtifactRef("real-integration", integrationBytes),
				restart: realArtifactRef("real-restart", restartBytes),
				process: realArtifactRef("real-process", processBytes),
				store: realArtifactRef("real-store", storeBytes),
			};
			const evidenceRefs = [
				refs.command,
				refs.source,
				refs.input,
				refs.scan,
				refs.integration,
				refs.restart,
				refs.process,
				refs.store,
			];
			const realDurability = (
				[
					["integration", refs.integration],
					["restart", refs.restart],
					["process", refs.process],
					["store", refs.store],
				] as const
			).map(([kind, artifactRef]) => {
				const source = `host-${kind}`;
				return {
					kind,
					artifactRef,
					provenanceDigest: digestObject({
						kind,
						artifactRef,
						observedAt: FRESH_FROM,
						freshUntil: FRESH_UNTIL,
						source,
					}),
					observedAt: FRESH_FROM,
					freshUntil: FRESH_UNTIL,
					source,
				};
			});
			const { manifest, authorityReceipt } = makeManifest(
				{ evidenceRefs, durabilityEvidence: realDurability },
				{
					commandArtifactRef: refs.command,
					commandDigest: refs.command.digest,
					sourceArtifactRef: refs.source,
					sourceDigest: refs.source.digest,
					inputArtifactRefs: [refs.input],
					inputDigest: digestObject([refs.input]),
					hostScanEvidenceRefs: [refs.scan],
				},
			);
			const resultProcessBytes = canonicalJsonBytes({
				kind: "process",
				pid: firstObservation.pid,
				boundary: "public:workflow-submit",
			});
			const resultStartBytes = canonicalJsonBytes({ kind: "start", pid: firstObservation.pid });
			const resultEndBytes = canonicalJsonBytes({ kind: "end", pid: firstObservation.pid });
			const stdoutBytes = Uint8Array.from(Buffer.from(String(firstRun.stdout), "utf8"));
			const stderrBytes = Uint8Array.from(Buffer.from(String(firstRun.stderr), "utf8"));
			const resultEvidenceBytes = canonicalJsonBytes({ kind: "result", boundary: "public:workflow-submit" });
			const resultRefs = {
				process: realArtifactRef("real-result-process", resultProcessBytes, 60),
				start: realArtifactRef("real-result-start", resultStartBytes, 61),
				end: realArtifactRef("real-result-end", resultEndBytes, 62),
				stdout: realArtifactRef("real-result-stdout", stdoutBytes, 63),
				stderr: realArtifactRef("real-result-stderr", stderrBytes, 64),
				evidence: realArtifactRef("real-result-evidence", resultEvidenceBytes, 65),
			};
			const result = makeResult(manifest, {
				startBoundaryRef: resultRefs.start,
				endBoundaryRef: resultRefs.end,
				processEvidenceRefs: [resultRefs.process],
				processEvidence: {
					artifactRef: resultRefs.process,
					testId: manifest.tests[0].testId,
					commandDigest: manifest.tests[0].commandDigest,
					sourceDigest: manifest.tests[0].sourceDigest,
					publicBoundary: manifest.tests[0].publicBoundary,
					executionIdentity: `node-process-${firstObservation.pid}`,
					processId: firstObservation.pid,
					startedAt: FRESH_FROM,
					completedAt: "2026-08-17T11:30:00.000Z",
					mode: "real_process",
					fakeOnly: false,
					provenanceDigest: digestObject({
						kind: "process",
						artifactRef: resultRefs.process,
						testId: manifest.tests[0].testId,
						commandDigest: manifest.tests[0].commandDigest,
						sourceDigest: manifest.tests[0].sourceDigest,
						publicBoundary: manifest.tests[0].publicBoundary,
						executionIdentity: `node-process-${firstObservation.pid}`,
						processId: firstObservation.pid,
						startedAt: FRESH_FROM,
						completedAt: "2026-08-17T11:30:00.000Z",
						mode: "real_process",
						fakeOnly: false,
					}),
				},
				stdoutArtifactRef: resultRefs.stdout,
				stderrArtifactRef: resultRefs.stderr,
				evidenceRefs: [resultRefs.evidence],
				failedAssertions: [
					{
						...makeResultDraft(manifest).failedAssertions[0]!,
						artifactRef: resultRefs.evidence,
					},
				],
			});
			const artifactBytes = new Map<string, Uint8Array>([
				[refs.command.digest, commandBytes],
				[refs.source.digest, sourceBytes],
				[refs.input.digest, inputBytes],
				[refs.scan.digest, scanBytes],
				[refs.integration.digest, integrationBytes],
				[refs.restart.digest, restartBytes],
				[refs.process.digest, processBytes],
				[refs.store.digest, storeBytes],
				[resultRefs.process.digest, resultProcessBytes],
				[resultRefs.start.digest, resultStartBytes],
				[resultRefs.end.digest, resultEndBytes],
				[resultRefs.stdout.digest, stdoutBytes],
				[resultRefs.stderr.digest, stderrBytes],
				[resultRefs.evidence.digest, resultEvidenceBytes],
			]);
			const context = contextWithArtifacts(artifactBytes);
			const manifestToken = await verifyWorkflowIntentRedManifest({
				manifest,
				context,
				hostBinding,
				authorityReceipt,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			});
			const resultToken = await verifyWorkflowIntentRedTestResult({
				manifestToken,
				result,
				context,
				hostBinding,
				currentHead: journalHead,
				currentEpoch: epochRef,
				currentStateDigest: CURRENT_STATE_DIGEST,
				currentRevision: CURRENT_REVISION,
				trustedNow: NOW,
			});
			expect(
				(
					await authorizeWorkflowIntentRedProductionMutation({
						manifestToken,
						resultTokens: [resultToken],
						scope: mutationScope(manifest),
						currentHead: journalHead,
						currentEpoch: epochRef,
						currentStateDigest: CURRENT_STATE_DIGEST,
						currentRevision: CURRENT_REVISION,
						trustedNow: NOW,
					})
				).authorized,
			).toBe(true);
			await expect(
				authorizeWorkflowIntentRedProductionMutation({
					manifestToken,
					resultTokens: [resultToken],
					scope: mutationScope(manifest),
					currentHead: journalHead,
					currentEpoch: epochRef,
					currentStateDigest: CURRENT_STATE_DIGEST,
					currentRevision: CURRENT_REVISION,
					trustedNow: NOW,
				}),
			).rejects.toThrow(/consumed|one-use|token/i);
		} finally {
			await rm(tempDirectory, { recursive: true, force: true });
		}
	});

	it("RED: emits exact existing-journal seam payloads without creating a second journal", async () => {
		const { manifest } = makeManifest();
		const result = makeResult(manifest);
		const manifestBytes = canonicalJsonBytes(manifest);
		const resultBytes = canonicalJsonBytes(result);
		const manifestRef = {
			...artifactRef("manifest"),
			digest: sha256Hex(manifestBytes),
			sizeBytes: manifestBytes.byteLength,
		};
		const resultRef = { ...artifactRef("result"), digest: sha256Hex(resultBytes), sizeBytes: resultBytes.byteLength };
		const fixtureContext = hostContext();
		const artifactResolver = {
			resolve: async (ref: WorkflowArtifactRef) => {
				if (ref.digest === manifestRef.digest)
					return {
						envelope: {
							ref,
							payloadKind: "evidence" as const,
							codec: "canonical_json" as const,
							immutable: true as const,
						},
						exists: true as const,
						bytes: manifestBytes,
						verifiedDigest: ref.digest,
						verifiedSizeBytes: ref.sizeBytes,
					};
				if (ref.digest === resultRef.digest)
					return {
						envelope: {
							ref,
							payloadKind: "evidence" as const,
							codec: "canonical_json" as const,
							immutable: true as const,
						},
						exists: true as const,
						bytes: resultBytes,
						verifiedDigest: ref.digest,
						verifiedSizeBytes: ref.sizeBytes,
					};
				return fixtureContext.artifactResolver.resolve(ref);
			},
		};
		expect(
			await workflowIntentRedManifestEventPayload({ manifest, manifestArtifactRef: manifestRef, artifactResolver }),
		).toEqual({
			kind: "workflow_red_test_manifest_published",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			expectedHead: journalHead,
			epochRef,
			manifestDigest: manifest.manifestDigest,
			manifestArtifactRef: manifestRef,
			idempotencyKey: manifest.idempotencyKey,
			hostReceipt: manifest.hostReceipt,
		});
		expect(
			await workflowIntentRedResultEventPayload({ result, resultArtifactRef: resultRef, artifactResolver }),
		).toMatchObject({
			kind: "workflow_red_test_result_recorded",
			workflowId: WORKFLOW_ID,
			manifestDigest: manifest.manifestDigest,
			testId: result.testId,
			resultDigest: result.resultDigest,
			resultArtifactRef: resultRef,
		});
	});

	it("RED: emits a closed durable scope-denial payload with the last admissible head", () => {
		const { manifest } = makeManifest();
		const authorizedScope = mutationScope(manifest);
		const attemptedScope = {
			...authorizedScope,
			affectedProductionSurface: [
				...authorizedScope.affectedProductionSurface,
				"packages/coding-agent/src/core/workflow/contracts.ts",
			],
			writeSet: [...authorizedScope.writeSet, "packages/coding-agent/src/core/workflow/contracts.ts"],
		};
		attemptedScope.effectDigest = workflowIntentRedMutationEffectDigest({
			resourceDigest: attemptedScope.resourceDigest,
			affectedProductionSurface: attemptedScope.affectedProductionSurface,
			writeSet: attemptedScope.writeSet,
			closureRationale: attemptedScope.closureRationale,
		});
		const currentHead = { ...journalHead, sequence: journalHead.sequence + 1 };
		const payload = workflowIntentRedScopeExceededEventPayload({
			manifest,
			authorizedScope,
			attemptedScope,
			currentHead,
			currentEpoch: epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION + 1,
			trustedNow: NOW,
			executionIdentity: EXECUTION_IDENTITY,
			sessionId: SESSION_ID,
			reason: "surface",
		});

		expect(payload).toEqual({
			kind: "intent_scope_exceeded",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			manifestDigest: manifest.manifestDigest,
			expectedHead: manifest.expectedHead,
			expectedHeadDigest: manifest.expectedHeadDigest,
			currentHead,
			currentHeadDigest: digestObject(currentHead),
			epochRef,
			currentStateDigest: CURRENT_STATE_DIGEST,
			currentRevision: CURRENT_REVISION + 1,
			trustedNow: NOW,
			authorizedScopeDigest: workflowIntentRedMutationScopeDigest(authorizedScope),
			attemptedScopeDigest: workflowIntentRedMutationScopeDigest(attemptedScope),
			effectDigest: attemptedScope.effectDigest,
			executionIdentity: EXECUTION_IDENTITY,
			sessionId: SESSION_ID,
			reason: "surface",
			quarantine: {
				reason: "intent_scope_exceeded",
				lastAdmissibleProductionHeadDigest: manifest.expectedHeadDigest,
			},
		});
		expect(Object.keys(payload).sort()).toEqual([
			"attemptId",
			"attemptedScopeDigest",
			"authorizedScopeDigest",
			"currentHead",
			"currentHeadDigest",
			"currentRevision",
			"currentStateDigest",
			"effectDigest",
			"epochRef",
			"executionIdentity",
			"expectedHead",
			"expectedHeadDigest",
			"kind",
			"manifestDigest",
			"quarantine",
			"reason",
			"sessionId",
			"taskId",
			"trustedNow",
			"workflowId",
		]);
		expect(Object.isFrozen(payload)).toBe(true);
	});
});
