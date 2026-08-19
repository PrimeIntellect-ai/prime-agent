import { expect, it, vi } from "vitest";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	type DurableDecisionRecord,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowDecisionRef,
	type WorkflowEvidenceEnvelope,
	type WorkflowRevisionTuple,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type { WorkflowDecisionGate, WorkflowOperation } from "../src/core/workflow/decision-gate.js";
import type { WorkflowEvidenceValidator } from "../src/core/workflow/evidence.js";
import {
	createWorkflowLearningController,
	createWorkflowLearningControllerFromDurableState,
	type WorkflowLearningCanaryResult,
	type WorkflowLearningCandidate,
	type WorkflowLearningCandidateClassification,
	type WorkflowLearningExperienceInput,
	type WorkflowLearningHost,
	type WorkflowLearningHostSnapshot,
	type WorkflowLearningHostWitness,
	type WorkflowLearningPorts,
	type WorkflowLearningRedTeamResult,
	type WorkflowLearningRollbackApplication,
	type WorkflowLearningShadowResult,
	type WorkflowLearningStageMetrics,
	type WorkflowLearningTrigger,
} from "../src/core/workflow/learning-controller.js";

const NOW = "2026-08-13T00:00:00.000Z";
const LATER = "2026-08-13T00:05:00.000Z";
const WORKFLOW_ID = "workflow-learning-1";
const REVISIONS: WorkflowRevisionTuple = {
	contractRevision: 1,
	scorecardRevision: 1,
	planRevision: 1,
	configRevision: 1,
	evidenceRevision: 1,
};

const STAGE_ARTIFACT_BYTES = new Map<string, Uint8Array>();
const HOLDOUT_MANIFEST_BYTES = new Map<string, Uint8Array>();

function ref(id: string, sequence = 1): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes({ id });
	return {
		artifactId: id,
		relativePath: `learning/${id}`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: sequence,
	};
}

function registerStageArtifact(
	stage: "shadow" | "canary" | "red_team",
	result: WorkflowLearningShadowResult | WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult,
): WorkflowArtifactRef {
	const payload: Record<string, unknown> = {
		schemaVersion: 1,
		kind: "workflow_learning_stage_result",
		workflowId: WORKFLOW_ID,
		candidateId: result.candidateId,
		stage,
		evidenceRefs: result.evidenceRefs,
		metrics: result.metrics ?? null,
	};
	if (stage === "shadow") {
		const shadow = result as WorkflowLearningShadowResult;
		Object.assign(payload, {
			sameCaseInputDigest: shadow.sameCaseInputDigest,
			heldOutInputDigest: shadow.heldOutInputDigest,
			heldOutSampleCount: shadow.heldOutSampleCount,
			heldOutPassed: shadow.heldOutPassed,
			overfittingDetected: shadow.overfittingDetected,
			nonRegressionPassed: shadow.nonRegressionPassed,
			safetyPassed: shadow.safetyPassed,
		});
	} else {
		Object.assign(payload, {
			passed: (result as WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult).passed,
		});
	}
	let bytes: Uint8Array;
	try {
		bytes = canonicalJsonBytes(payload);
	} catch (_error: unknown) {
		return result.resultRef;
	}
	const artifactRef: WorkflowArtifactRef = {
		artifactId: result.resultRef.artifactId,
		relativePath: result.resultRef.relativePath,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: result.resultRef.sourceEventSequence,
	};
	STAGE_ARTIFACT_BYTES.set(artifactRef.digest, bytes);
	return artifactRef;
}

function metrics(stage: string): WorkflowLearningStageMetrics {
	return {
		sampleCount: 1,
		effectSize: 0.5,
		variance: 0.01,
		costMicrounits: 1,
		latencyMilliseconds: 1,
		evaluatorDigest: `evaluator-${stage}`,
		metricDigest: `metric-${stage}`,
		evidenceDigest: digestObject([ref(`${stage}-evidence`)]),
	};
}

function witness(
	stage: string,
	candidateId: string | null,
	evidenceRef: WorkflowArtifactRef,
	current: WorkflowLearningHostSnapshot,
	payloadDigest: string,
	witnessKind: WorkflowLearningHostWitness["witnessKind"] = "evidence",
): WorkflowLearningHostWitness {
	return {
		witnessId: `${stage}-${evidenceRef.artifactId}`,
		witnessKind,
		workflowId: current.workflowId,
		stage,
		candidateId,
		evidenceRef,
		payloadDigest,
		bytesDigest: evidenceRef.digest,
		bytesSize: evidenceRef.sizeBytes,
		revision: current.currentRevision,
		storeEpoch: current.storeEpoch ?? 1,
		coordinatorEpoch: current.coordinatorEpoch ?? 1,
		stateHeadDigest: current.stateHeadDigest ?? "head-1",
		trustedNow: current.trustedNow,
		oneUse: true,
	};
}

function receipt(
	id: string,
	kind: WorkflowVerifiedHostReceipt["receiptKind"] = "artifact",
	overrides: Partial<Pick<WorkflowVerifiedHostReceipt, "oneUse" | "revision" | "stateDigest" | "bindingDigest">> = {},
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: kind,
		receiptId: id,
		issuerId: `host-${id}`,
		workflowId: WORKFLOW_ID,
		bindingDigest: overrides.bindingDigest ?? `${id}-binding`,
		payloadDigest: `${id}-payload`,
		artifactRef: ref(`receipt-${id}`),
		issuedAt: NOW,
		validUntil: LATER,
		keyId: `key-${id}`,
		oneUse: overrides.oneUse ?? true,
		revision: overrides.revision ?? 1,
		stateDigest: overrides.stateDigest ?? "state-1",
	});
}

function stripReceiptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripReceiptPayload(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
			.map(([key, item]) => [key, stripReceiptPayload(item)]),
	);
}

function receiptBindingDigest(kind: string, payload: unknown, hostReceipt: WorkflowVerifiedHostReceipt): string {
	const serialized = JSON.stringify(stripReceiptPayload(payload));
	if (serialized === undefined) throw new Error("Fixture receipt payload cannot be serialized.");
	return digestObject({
		kind,
		payloadDigest: digestObject(JSON.parse(serialized) as unknown),
		receiptId: hostReceipt.receiptId,
		receiptPayloadDigest: hostReceipt.payloadDigest,
	});
}

function boundReceipt(
	id: string,
	kind: WorkflowVerifiedHostReceipt["receiptKind"],
	payloadKind: string,
	payload: unknown,
	overrides: Partial<Pick<WorkflowVerifiedHostReceipt, "oneUse" | "revision" | "stateDigest">> = {},
): WorkflowVerifiedHostReceipt {
	const unsignedBinding = receipt(id, kind, overrides);
	return receipt(id, kind, {
		...overrides,
		bindingDigest: receiptBindingDigest(payloadKind, payload, unsignedBinding),
	});
}

function rebindReceipt(
	hostReceipt: WorkflowVerifiedHostReceipt,
	payloadKind: string,
	payload: unknown,
): WorkflowVerifiedHostReceipt {
	return boundReceipt(hostReceipt.receiptId, hostReceipt.receiptKind, payloadKind, payload, {
		oneUse: hostReceipt.oneUse,
		revision: hostReceipt.revision,
		stateDigest: hostReceipt.stateDigest,
	});
}

function rebindFixtureDefaultReceipt(
	hostReceipt: WorkflowVerifiedHostReceipt,
	payloadKind: string,
	payload: unknown,
): WorkflowVerifiedHostReceipt {
	return hostReceipt.workflowId === WORKFLOW_ID && hostReceipt.bindingDigest.endsWith("-binding")
		? rebindReceipt(hostReceipt, payloadKind, payload)
		: hostReceipt;
}

function triggerIdentityValue(trigger: WorkflowLearningTrigger): string {
	return digestObject({
		kind: trigger.kind,
		candidateId: trigger.candidateId,
		sourceEventRef: trigger.sourceEventRef,
		workflowId: trigger.workflowId,
		storeEpoch: trigger.storeEpoch,
		coordinatorEpoch: trigger.coordinatorEpoch,
		stateHeadDigest: trigger.stateHeadDigest,
		evidenceDigest: trigger.evidenceDigest,
		evidenceRefs: trigger.evidenceRefs,
		hostReceipt: trigger.hostReceipt,
	});
}

function evidence(id: string, outcome: "exit-zero" | "failed" = "exit-zero"): WorkflowEvidenceEnvelope {
	const artifact = ref(`evidence-artifact-${id}`);
	return {
		evidenceId: id,
		evidenceRevision: REVISIONS.evidenceRevision,
		requirementId: "requirement-1",
		claim: "The host observed a bounded outcome.",
		result: outcome,
		method: "host-integration-check",
		command: null,
		artifactObservations: [
			{
				artifactRef: artifact,
				exists: true,
				verifiedDigest: artifact.digest,
				verifiedSizeBytes: artifact.sizeBytes,
			},
		],
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
		revisions: REVISIONS,
		evaluatorDigest: "evaluator",
		parserDigest: "parser",
		guardDigest: "guard",
		updatedDigest: "updated",
		invalidatedByDecisionRef: null,
		regressed: false,
		auditorDecisionRef: null,
		observedAt: NOW,
		freshUntil: LATER,
		freshnessWindowMilliseconds: 300_000,
	};
}

function createSnapshot(overrides: Partial<WorkflowLearningHostSnapshot> = {}): WorkflowLearningHostSnapshot {
	const clockReceipt = receipt("clock", "artifact");
	const artifactResolver = {
		resolve: async (artifactRef: WorkflowArtifactRef) => {
			const bytes =
				STAGE_ARTIFACT_BYTES.get(artifactRef.digest) ??
				HOLDOUT_MANIFEST_BYTES.get(artifactRef.digest) ??
				canonicalJsonBytes({ id: artifactRef.artifactId });
			return {
				envelope: {
					ref: artifactRef,
					payloadKind: "evidence" as const,
					codec: "canonical_json" as const,
					immutable: true as const,
				},
				exists: true as const,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
	return {
		workflowId: WORKFLOW_ID,
		stateDigest: "state-1",
		workspaceDigest: "workspace",
		configDigest: "config",
		parserDigest: "parser",
		evaluatorDigest: "evaluator",
		guardDigest: "guard",
		revisions: REVISIONS,
		currentRevision: 1,
		trustedNow: NOW,
		trustedClockReceipt: clockReceipt,
		requiredFreshnessMilliseconds: 1,
		baselineRevision: 1,
		baselineDigest: "baseline-1",
		evaluatorBaselineDigest: "evaluator-baseline-1",
		metricBaselineDigest: "metric-baseline-1",
		revisionRegistryDigest: "registry-1",
		storeEpoch: 1,
		coordinatorEpoch: 1,
		stateHeadDigest: "head-1",
		artifactResolver,
		receiptContext: createFixtureHostReceiptConsumerContext(),
		...overrides,
	};
}

function createExperience(overrides: Partial<WorkflowLearningExperienceInput> = {}): WorkflowLearningExperienceInput {
	const experience: WorkflowLearningExperienceInput = {
		experienceId: "experience-1",
		workflowId: WORKFLOW_ID,
		source: "host",
		outcome: "positive",
		progressKind: "verified",
		progressEvidenceRefs: [ref("progress-1")],
		evidence: [evidence("evidence-1")],
		committedAt: NOW,
		sourceEventRef: ref("source-event-1"),
		hostReceipt: receipt("experience"),
		...overrides,
	};
	experience.hostReceipt = rebindFixtureDefaultReceipt(experience.hostReceipt, "committed_experience", {
		experienceId: experience.experienceId,
		workflowId: experience.workflowId,
		outcome: experience.outcome,
		progressKind: experience.progressKind,
		progressEvidenceRefs: experience.progressEvidenceRefs,
		evidenceDigest: digestObject(experience.evidence),
		sourceEventRef: experience.sourceEventRef,
	});
	return experience;
}

function createCandidate(overrides: Partial<WorkflowLearningCandidate> = {}): WorkflowLearningCandidate {
	const sameCase = ref("same-case");
	const hidden = ref("held-out-manifest");
	const manifest = {
		manifestId: "manifest-1",
		kind: "held_out" as const,
		sourceArtifactRefs: [sameCase],
		inputDigest: "same-input",
		hidden: true as const,
		requiredSampleSize: 1,
		effectThreshold: 0.01,
		tolerance: 0,
		nonRegressionPredicateRefs: [ref("predicate-1")],
		maxCostMicrounits: 100,
		maxLatencyMilliseconds: 100,
		manifestDigest: "",
		heldOutInputDigest: "hidden-input-digest",
	};
	const defaultCandidate: WorkflowLearningCandidate = {
		candidateId: "candidate-1",
		experienceId: "experience-1",
		workflowId: WORKFLOW_ID,
		owner: "autoresearch",
		producer: "autoresearch",
		kind: "methodology",
		mutationClass: "workflow",
		proposalRef: ref("proposal-1"),
		candidateRef: ref("candidate-1"),
		candidateDigest: ref("candidate-1").digest,
		baselineRevision: 1,
		baselineDigest: "baseline-1",
		baselineArtifactRef: ref("baseline-1"),
		scorecardRef: ref("scorecard-1"),
		scorecardDigest: ref("scorecard-1").digest,
		evaluatorRef: ref("evaluator-1"),
		evaluatorDigest: ref("evaluator-1").digest,
		parserRef: ref("parser-1"),
		caseManifest: { ...manifest, manifestDigest: digestObject(manifest) },
		proposal: null,
		hostReceipt: receipt("candidate"),
		hiddenHoldoutManifestRef: hidden,
		...overrides,
	};
	const normalizedManifest = {
		...defaultCandidate.caseManifest,
		manifestDigest: digestObject({ ...defaultCandidate.caseManifest, manifestDigest: "" }),
	};
	const candidate: WorkflowLearningCandidate = { ...defaultCandidate, caseManifest: normalizedManifest };
	const manifestBytes = canonicalJsonBytes({
		schemaVersion: 1,
		kind: "workflow_learning_holdout_manifest",
		workflowId: candidate.workflowId,
		candidateId: candidate.candidateId,
		manifestDigest: candidate.caseManifest.manifestDigest,
		manifest: candidate.caseManifest,
	});
	const manifestRef = {
		...hidden,
		digest: sha256Hex(manifestBytes),
		sizeBytes: manifestBytes.byteLength,
	};
	if (overrides.hiddenHoldoutManifestRef === undefined) {
		HOLDOUT_MANIFEST_BYTES.set(manifestRef.digest, manifestBytes);
	}
	return {
		...candidate,
		hiddenHoldoutManifestRef: overrides.hiddenHoldoutManifestRef ?? manifestRef,
	};
}

function createShadow(overrides: Partial<WorkflowLearningShadowResult> = {}): WorkflowLearningShadowResult {
	const result = {
		candidateId: "candidate-1",
		sameCaseInputDigest: "same-input",
		heldOutInputDigest: "hidden-input-digest",
		heldOutSampleCount: 1,
		heldOutPassed: true,
		overfittingDetected: false,
		nonRegressionPassed: true,
		safetyPassed: true,
		evidenceRefs: [ref("shadow-evidence")],
		receipts: [receipt("shadow")],
		resultRef: ref("shadow-result"),
		metrics: metrics("shadow"),
		...overrides,
	};
	return { ...result, resultRef: registerStageArtifact("shadow", result) };
}

function createCanary(overrides: Partial<WorkflowLearningCanaryResult> = {}): WorkflowLearningCanaryResult {
	const result = {
		candidateId: "candidate-1",
		inputDigest: "canary-input",
		passed: true,
		sessionId: "canary-session",
		executionIdentity: "canary-execution",
		evidenceRefs: [ref("canary-evidence")],
		receipts: [receipt("canary")],
		resultRef: ref("canary-result"),
		metrics: metrics("canary"),
		...overrides,
	};
	return { ...result, resultRef: registerStageArtifact("canary", result) };
}

function createRedTeam(overrides: Partial<WorkflowLearningRedTeamResult> = {}): WorkflowLearningRedTeamResult {
	const result = {
		candidateId: "candidate-1",
		independent: true,
		passed: true,
		sessionId: "red-team-session",
		executionIdentity: "red-team-execution",
		evidenceRefs: [ref("red-team-evidence")],
		receipts: [receipt("red-team", "adjudication")],
		resultRef: ref("red-team-result"),
		metrics: metrics("red-team"),
		...overrides,
	};
	return { ...result, resultRef: registerStageArtifact("red_team", result) };
}

function createDecision(
	current = createSnapshot(),
	candidateId = "candidate-1",
): {
	decision: DurableDecisionRecord;
	operation: WorkflowOperation;
	decisionRef: WorkflowDecisionRef;
	decisionWitness: WorkflowLearningHostWitness;
} {
	const decision = {
		decisionId: "decision-1",
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "root-1" },
	} as unknown as DurableDecisionRecord;
	return {
		decision,
		operation: { kind: "refinement", preimageRef: ref("operation-1"), preimageDigest: "operation-digest" },
		decisionRef: decisionRef(),
		decisionWitness: witness(
			"decision",
			candidateId,
			ref("decision-witness"),
			current,
			digestObject(decision),
			"decision",
		),
	};
}

function decisionRef(id = "decision-ref-1", overrides: Partial<WorkflowDecisionRef> = {}): WorkflowDecisionRef {
	return {
		decisionId: id,
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "root-1" },
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		decisionDigest: `decision-digest-${id}`,
		...overrides,
	};
}

interface Fixture {
	controller: ReturnType<typeof createWorkflowLearningController>;
	host: WorkflowLearningHost;
	ports: WorkflowLearningPorts;
	state: ReturnType<typeof createSnapshot>;
	decisionGate: Pick<WorkflowDecisionGate, "validateVerdicts" | "authorize">;
	canary: WorkflowLearningCanaryResult;
	redTeam: WorkflowLearningRedTeamResult;
}

function createFixture(overrides: Partial<WorkflowLearningHost> = {}): Fixture {
	const state = createSnapshot();
	const canary = createCanary();
	const redTeam = createRedTeam();
	const host: WorkflowLearningHost = {
		current: async () => state,
		createCandidate: async ({ trigger }) => {
			const candidate = createCandidate();
			return {
				...candidate,
				hostReceipt: rebindReceipt(candidate.hostReceipt, "typed_candidate", { candidate, trigger }),
			};
		},
		runShadow: async ({ candidate }) => {
			const shadow = createShadow();
			return {
				...shadow,
				receipts: shadow.receipts.map((hostReceipt) =>
					rebindReceipt(hostReceipt, "shadow_review", { candidate, shadow }),
				),
			};
		},
		runCanary: async ({ candidate, shadow }) => ({
			...canary,
			receipts: canary.receipts.map((hostReceipt) =>
				rebindReceipt(hostReceipt, "canary_review", { candidate, shadow, canary }),
			),
		}),
		runIndependentRedTeam: async ({ candidate, shadow, canary: canaryResult }) => ({
			...redTeam,
			receipts: redTeam.receipts.map((hostReceipt) =>
				rebindReceipt(hostReceipt, "independent_red_team", {
					candidate,
					shadow,
					canary: canaryResult,
					redTeam,
				}),
			),
		}),
		classifyCandidate: async ({ candidate }): Promise<WorkflowLearningCandidateClassification> => ({
			mutationClass: candidate.mutationClass,
			payloadDigest: candidate.candidateDigest,
			classifierDigest: "classifier-1",
			protectedPaths: [],
			proposalDigest: candidate.proposal === null ? null : digestObject(candidate.proposal),
		}),
		resolveEvidence: async ({ stage, candidateId, evidenceRefs, payloadDigest, current }) =>
			evidenceRefs.map((evidenceRef) =>
				witness(
					stage,
					candidateId,
					evidenceRef,
					current,
					payloadDigest,
					stage === "decision" ? "decision" : "evidence",
				),
			),
		resolveDecision: async ({ candidate }) => createDecision(state, candidate.candidateId),
		promote: async ({ candidate, shadow, canary: canaryResult, redTeam: redTeamResult, decision, expected }) => {
			if (
				expected.stateHeadDigest !== state.stateHeadDigest ||
				expected.storeEpoch !== state.storeEpoch ||
				expected.coordinatorEpoch !== state.coordinatorEpoch
			) {
				throw new Error("durable CAS lost");
			}
			const nextRevision = state.currentRevision + 1;
			const nextHead = `head-${nextRevision}`;
			state.currentRevision = nextRevision;
			state.stateHeadDigest = nextHead;
			state.trustedClockReceipt = receipt("clock", "artifact", { revision: nextRevision });
			const promotion = {
				promotionId: `promotion-${candidate.candidateId}`,
				candidateId: candidate.candidateId,
				revisionId: `revision-${nextRevision - 1}`,
				revision: nextRevision,
				policyDigest: `policy-${nextRevision}`,
				stateHeadDigest: nextHead,
				storeEpoch: state.storeEpoch,
				coordinatorEpoch: state.coordinatorEpoch,
				casExecutionKey: `cas-${nextRevision}`,
				receipt: receipt("promotion", "decision"),
			};
			return {
				...promotion,
				receipt: rebindReceipt(promotion.receipt, "host_fenced_promotion", {
					candidate,
					shadow,
					canary: canaryResult,
					redTeam: redTeamResult,
					decision,
					promotion,
				}),
			};
		},
		reconcilePromotion: async () => null,
		proposeRollback: async ({ candidate, trigger, decisionRef, expected }) => {
			const proposal = {
				proposalId: `rollback-${candidate.candidateId}`,
				candidateId: candidate.candidateId,
				rollbackOf: "revision-1",
				proposalRef: ref("rollback-proposal"),
				proposalDigest: ref("rollback-proposal").digest,
				stateHeadDigest: expected.stateHeadDigest,
				storeEpoch: expected.storeEpoch,
				coordinatorEpoch: expected.coordinatorEpoch,
				casExecutionKey: `rollback-cas-${candidate.candidateId}`,
				receipt: receipt("rollback", "artifact", { revision: state.currentRevision }),
			};
			return {
				...proposal,
				receipt: rebindReceipt(proposal.receipt, "rollback_proposal", {
					candidate,
					trigger,
					proposal,
					decisionRef,
				}),
			};
		},
		applyRollback: async ({ operationId, candidate, trigger, proposal, decisionRef, expected }) => {
			const applicationWithoutReceipt: Omit<WorkflowLearningRollbackApplication, "receipt"> = {
				operationId,
				workflowId: candidate.workflowId,
				candidateId: candidate.candidateId,
				rollbackOf: proposal.rollbackOf,
				proposalId: proposal.proposalId,
				proposalRef: proposal.proposalRef,
				proposalDigest: proposal.proposalDigest,
				triggerIdentity: triggerIdentityValue(trigger),
				decisionRef,
				expected,
				registryCasDigest: digestObject({
					kind: "workflow_learning_rollback_registry_cas",
					workflowId: candidate.workflowId,
					candidateId: candidate.candidateId,
					rollbackOf: proposal.rollbackOf,
					proposalId: proposal.proposalId,
					proposalDigest: proposal.proposalDigest,
					triggerIdentity: triggerIdentityValue(trigger),
					decisionRef,
					expected,
				}),
				appliedRegistryDigest: "0".repeat(64),
				reloadedRegistryDigest: "0".repeat(64),
				futureLoadDigest: "0".repeat(64),
				appliedRevision: 1,
				reloadedRevision: 1,
				futureLoadRevision: 1,
				stateHeadDigest: expected.stateHeadDigest,
				storeEpoch: expected.storeEpoch,
				coordinatorEpoch: expected.coordinatorEpoch,
				casExecutionKey: `rollback-apply-${candidate.candidateId}`,
			};
			const appliedRegistryDigest = digestObject({
				kind: "workflow_learning_rollback_registry_applied",
				registryCasDigest: applicationWithoutReceipt.registryCasDigest,
				proposalDigest: applicationWithoutReceipt.proposalDigest,
				revision: applicationWithoutReceipt.appliedRevision,
			});
			const reloadedRegistryDigest = digestObject({
				kind: "workflow_learning_rollback_registry_reloaded",
				appliedRegistryDigest,
				revision: applicationWithoutReceipt.reloadedRevision,
			});
			const futureLoadDigest = digestObject({
				kind: "workflow_learning_rollback_future_load",
				reloadedRegistryDigest,
				revision: applicationWithoutReceipt.futureLoadRevision,
			});
			const application = {
				...applicationWithoutReceipt,
				appliedRegistryDigest,
				reloadedRegistryDigest,
				futureLoadDigest,
			};
			return {
				...application,
				receipt: rebindReceipt(
					receipt("rollback-application", "artifact", { revision: state.currentRevision }),
					"rollback_applied",
					{
						candidate,
						trigger,
						proposal,
						application,
					},
				),
			};
		},
		...overrides,
	};
	if (overrides.createCandidate !== undefined) {
		const suppliedCreateCandidate = overrides.createCandidate;
		host.createCandidate = async (input) => {
			const candidate = await suppliedCreateCandidate(input);
			return {
				...candidate,
				hostReceipt: rebindFixtureDefaultReceipt(candidate.hostReceipt, "typed_candidate", {
					candidate,
					trigger: input.trigger,
				}),
			};
		};
	}
	if (overrides.runShadow !== undefined) {
		const suppliedRunShadow = overrides.runShadow;
		host.runShadow = async (input) => {
			const shadow = await suppliedRunShadow(input);
			return {
				...shadow,
				receipts: shadow.receipts.map((hostReceipt) =>
					rebindFixtureDefaultReceipt(hostReceipt, "shadow_review", {
						candidate: input.candidate,
						shadow,
					}),
				),
			};
		};
	}
	if (overrides.runCanary !== undefined) {
		const suppliedRunCanary = overrides.runCanary;
		host.runCanary = async (input) => {
			const canaryResult = await suppliedRunCanary(input);
			return {
				...canaryResult,
				receipts: canaryResult.receipts.map((hostReceipt) =>
					rebindFixtureDefaultReceipt(hostReceipt, "canary_review", {
						candidate: input.candidate,
						shadow: input.shadow,
						canary: canaryResult,
					}),
				),
			};
		};
	}
	if (overrides.runIndependentRedTeam !== undefined) {
		const suppliedRunRedTeam = overrides.runIndependentRedTeam;
		host.runIndependentRedTeam = async (input) => {
			const redTeamResult = await suppliedRunRedTeam(input);
			return {
				...redTeamResult,
				receipts: redTeamResult.receipts.map((hostReceipt) =>
					rebindFixtureDefaultReceipt(hostReceipt, "independent_red_team", {
						candidate: input.candidate,
						shadow: input.shadow,
						canary: input.canary,
						redTeam: redTeamResult,
					}),
				),
			};
		};
	}
	if (overrides.proposeRollback !== undefined) {
		const suppliedProposeRollback = overrides.proposeRollback;
		host.proposeRollback = async (input) => {
			const proposal = await suppliedProposeRollback(input);
			return {
				...proposal,
				receipt: rebindFixtureDefaultReceipt(proposal.receipt, "rollback_proposal", {
					candidate: input.candidate,
					trigger: input.trigger,
					proposal,
					decisionRef: input.decisionRef,
				}),
			};
		};
	}
	if (overrides.promote !== undefined) {
		const suppliedPromote = overrides.promote;
		host.promote = async (input) => {
			const rawPromotion = await suppliedPromote(input);
			const promotion = {
				...rawPromotion,
				receipt: rebindFixtureDefaultReceipt(rawPromotion.receipt, "host_fenced_promotion", {
					candidate: input.candidate,
					shadow: input.shadow,
					canary: input.canary,
					redTeam: input.redTeam,
					decision: input.decision,
					promotion: rawPromotion,
				}),
			};
			if (promotion.stateHeadDigest !== undefined) {
				state.currentRevision = promotion.revision;
				state.stateHeadDigest = promotion.stateHeadDigest;
				state.trustedClockReceipt = receipt("clock", "artifact", { revision: promotion.revision });
			}
			return promotion;
		};
	}
	if (overrides.reconcilePromotion !== undefined) {
		const suppliedReconcilePromotion = overrides.reconcilePromotion;
		host.reconcilePromotion = async (input) => {
			const reconciliation = await suppliedReconcilePromotion(input);
			if (reconciliation === null) return null;
			return {
				...reconciliation,
				promotion: {
					...reconciliation.promotion,
					receipt: rebindFixtureDefaultReceipt(reconciliation.promotion.receipt, "host_fenced_promotion", {
						candidate: input.candidate,
						shadow: input.shadow,
						canary: input.canary,
						redTeam: input.redTeam,
						decision: input.decision,
						promotion: reconciliation.promotion,
					}),
				},
			};
		};
	}
	if (overrides.applyRollback !== undefined) {
		const suppliedApplyRollback = overrides.applyRollback;
		host.applyRollback = async (input) => {
			const application = await suppliedApplyRollback(input);
			return {
				...application,
				receipt: rebindFixtureDefaultReceipt(application.receipt, "rollback_applied", {
					candidate: input.candidate,
					trigger: input.trigger,
					proposal: input.proposal,
					application,
				}),
			};
		};
	}
	const evidenceValidator: WorkflowEvidenceValidator = {
		validate: async () => ({ accepted: true, code: "accepted", evidenceDigest: "evidence-digest", findings: [] }),
		auditProgress: async () => {
			throw new Error("not used");
		},
	};
	const receiptPort = {
		verify: async ({
			receipt: hostReceipt,
			bindingDigest,
			stage,
			candidateId,
			current,
		}: {
			receipt: WorkflowVerifiedHostReceipt;
			bindingDigest: string;
			stage: string;
			candidateId: string | null;
			current: WorkflowLearningHostSnapshot;
		}) => witness(stage, candidateId, hostReceipt.artifactRef, current, bindingDigest, "receipt"),
		consume: async ({
			receipt: hostReceipt,
			bindingDigest,
			stage,
			candidateId,
			current,
		}: {
			receipt: WorkflowVerifiedHostReceipt;
			bindingDigest: string;
			stage: string;
			candidateId: string | null;
			current: WorkflowLearningHostSnapshot;
		}) => witness(stage, candidateId, hostReceipt.artifactRef, current, bindingDigest, "receipt"),
	};
	const decisionGate: Pick<WorkflowDecisionGate, "validateVerdicts" | "authorize"> = {
		validateVerdicts: async () => undefined,
		authorize: async () => "authorized",
	};
	const ports: WorkflowLearningPorts = { evidenceValidator, decisionGate, receiptPort, host };
	return {
		controller: createWorkflowLearningController({ ports }),
		host,
		ports,
		state,
		decisionGate,
		canary,
		redTeam,
	};
}

async function commitAndType(fixture: Fixture, experience = createExperience()): Promise<WorkflowLearningCandidate> {
	const committed = await fixture.controller.commitExperience(experience);
	return fixture.controller.typeCandidate({ experienceId: committed.experienceId, trigger: trigger("milestone") });
}

function trigger(
	kind: WorkflowLearningTrigger["kind"],
	candidateId?: string,
	snapshot: Pick<
		WorkflowLearningHostSnapshot,
		"workflowId" | "storeEpoch" | "coordinatorEpoch" | "stateHeadDigest"
	> = {
		workflowId: WORKFLOW_ID,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		stateHeadDigest: "head-1",
	},
	receiptId = `trigger-${kind}-receipt`,
): WorkflowLearningTrigger {
	const evidenceRefs = [ref(`trigger-evidence-${kind}`)];
	const triggerValue: WorkflowLearningTrigger = {
		kind,
		candidateId: candidateId ?? null,
		sourceEventRef: ref(`trigger-${kind}`),
		evidenceRefs,
		workflowId: snapshot.workflowId,
		storeEpoch: snapshot.storeEpoch,
		coordinatorEpoch: snapshot.coordinatorEpoch,
		stateHeadDigest: snapshot.stateHeadDigest,
		evidenceDigest: digestObject(evidenceRefs),
		hostReceipt: receipt(receiptId, "artifact", {
			revision: snapshot.stateHeadDigest === "head-1" ? 1 : 2,
		}),
	};
	triggerValue.hostReceipt = boundReceipt(receiptId, "artifact", "trigger", triggerValue, {
		revision: snapshot.stateHeadDigest === "head-1" ? 1 : 2,
	});
	return triggerValue;
}

it("rejects worker and model self-reports before they can create validated experience", async () => {
	const fixture = createFixture();
	for (const source of ["worker", "model"] as const) {
		await expect(fixture.controller.commitExperience(createExperience({ source }))).rejects.toThrow(/host/i);
	}
});

it("does not treat utilization or tokens as progress", async () => {
	const fixture = createFixture();
	for (const progressKind of ["utilization", "tokens"] as const) {
		await expect(fixture.controller.commitExperience(createExperience({ progressKind }))).rejects.toThrow(
			/progress/i,
		);
	}
});

it("retains rejected outcomes without letting rejected work create a candidate", async () => {
	const createCandidateCall = vi.fn(async () => createCandidate());
	const fixture = createFixture({ createCandidate: createCandidateCall });
	const negative = await fixture.controller.commitExperience(createExperience({ outcome: "negative" }));
	const rejected = await fixture.controller.commitExperience(
		createExperience({
			experienceId: "experience-rejected",
			outcome: "rejected",
			progressKind: "none",
			hostReceipt: receipt("experience-rejected"),
		}),
	);
	const state = fixture.controller.getState();
	expect(state.experiences.map((item) => [item.experienceId, item.outcome])).toEqual([
		[negative.experienceId, "negative"],
		[rejected.experienceId, "rejected"],
	]);
	const candidate = await fixture.controller.typeCandidate({
		experienceId: negative.experienceId,
		trigger: trigger("failure"),
	});
	expect(candidate.experienceId).toBe(negative.experienceId);
	expect(createCandidateCall).toHaveBeenCalledTimes(1);
	await expect(
		fixture.controller.typeCandidate({
			experienceId: rejected.experienceId,
			trigger: trigger("milestone"),
		}),
	).rejects.toThrow(/rejected/i);
	expect(createCandidateCall).toHaveBeenCalledTimes(1);
});

it("requires an opaque held-out input and rejects same-case evidence substituted for holdout", async () => {
	const sameCaseFixture = createFixture({
		runShadow: async () => createShadow({ heldOutInputDigest: "same-input" }),
	});
	const sameCaseCandidate = await commitAndType(sameCaseFixture);
	await expect(sameCaseFixture.controller.reviewCandidate(sameCaseCandidate.candidateId)).resolves.toMatchObject({
		status: "rejected",
		reasons: expect.arrayContaining(["held_out_mismatch"]),
	});

	const exposedFixture = createFixture({
		runShadow: async () =>
			({ ...createShadow(), heldOutInput: "secret-test-input" }) as unknown as WorkflowLearningShadowResult,
	});
	const exposedCandidate = await commitAndType(exposedFixture);
	await expect(exposedFixture.controller.reviewCandidate(exposedCandidate.candidateId)).rejects.toThrow(/opaque/i);
});

it("requires a fresh baseline and decision for evaluator and metric mutations", async () => {
	for (const mutationClass of ["evaluator", "metric"] as const) {
		const fixture = createFixture({
			createCandidate: async () => createCandidate({ mutationClass }),
		});
		const candidate = await commitAndType(fixture);
		await expect(fixture.controller.reviewCandidate(candidate.candidateId)).resolves.toMatchObject({
			status: "rejected",
			reasons: expect.arrayContaining(["fresh_baseline_required"]),
		});
	}
});

it("never auto-promotes kernel, authority, scheduler, recipe, or skill revisions", async () => {
	for (const mutationClass of ["kernel", "authority", "scheduler", "recipe", "skill"] as const) {
		const promote = vi.fn(async ({ candidate }: { candidate: WorkflowLearningCandidate }) => ({
			promotionId: `promotion-${candidate.candidateId}`,
			candidateId: candidate.candidateId,
			revisionId: "revision-2",
			revision: 2,
			policyDigest: "policy-2",
			receipt: receipt(`promotion-${mutationClass}`, "decision"),
		}));
		const fixture = createFixture({
			createCandidate: async () => createCandidate({ mutationClass }),
			promote,
		});
		const candidate = await commitAndType(fixture);
		await expect(fixture.controller.reviewCandidate(candidate.candidateId)).resolves.toMatchObject({
			status: "proposed",
		});
		expect(promote).not.toHaveBeenCalled();
	}
});

it("rejects duplicate or replayed receipts across stages and controller runs", async () => {
	const duplicateFixture = createFixture({
		runShadow: async () => createShadow({ receipts: [receipt("same-receipt"), receipt("same-receipt")] }),
	});
	const duplicateCandidate = await commitAndType(duplicateFixture);
	await expect(duplicateFixture.controller.reviewCandidate(duplicateCandidate.candidateId)).rejects.toThrow(
		/receipt/i,
	);

	const first = createFixture();
	const candidate = await commitAndType(first);
	await first.controller.reviewCandidate(candidate.candidateId);
	const replay = createWorkflowLearningControllerFromDurableState({
		ports: first.ports,
		state: first.controller.getState(),
	});
	await expect(
		replay.commitExperience(
			createExperience({ experienceId: "experience-replay", hostReceipt: receipt("experience") }),
		),
	).rejects.toThrow(/replay|receipt/i);
});

it("uses a host fence for promotion and emits only existing learning event kinds", async () => {
	const events: string[] = [];
	const fixture = createFixture();
	const controller = createWorkflowLearningController({
		ports: {
			...fixture.ports,
			eventSink: {
				append: async (event) => {
					events.push(event.kind);
				},
			},
		},
	});
	const committed = await controller.commitExperience(createExperience());
	const candidate = await controller.typeCandidate({
		experienceId: committed.experienceId,
		trigger: trigger("milestone"),
	});
	const result = await controller.reviewCandidate(candidate.candidateId);
	expect(result.status).toBe("promoted");
	expect(events).toEqual(["improvement_proposed", "improvement_reviewed", "policy_revision_recorded"]);
});

it("requires a durable rollback application before recording a regression proposal", async () => {
	const proposeRollback = vi.fn(
		async ({
			candidate,
			expected,
		}: {
			candidate: WorkflowLearningCandidate;
			expected: { stateHeadDigest: string; storeEpoch: number; coordinatorEpoch: number };
		}) => ({
			proposalId: "rollback-1",
			candidateId: candidate.candidateId,
			rollbackOf: "revision-2",
			proposalRef: ref("rollback-proposal"),
			proposalDigest: ref("rollback-proposal").digest,
			stateHeadDigest: expected.stateHeadDigest,
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "rollback-cas-1",
			receipt: receipt("rollback", "artifact", { revision: 2 }),
		}),
	);
	const promote = vi.fn(
		async ({
			candidate,
			expected,
		}: {
			candidate: WorkflowLearningCandidate;
			expected: { storeEpoch: number; coordinatorEpoch: number };
		}) => ({
			promotionId: `promotion-${candidate.candidateId}`,
			candidateId: candidate.candidateId,
			revisionId: "revision-2",
			revision: 2,
			policyDigest: "policy-2",
			stateHeadDigest: "head-2",
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "cas-regression",
			receipt: receipt("promotion-regression", "decision"),
		}),
	);
	const fixture = createFixture({ proposeRollback, promote });
	const candidate = await commitAndType(fixture);
	await fixture.controller.reviewCandidate(candidate.candidateId);
	const result = await fixture.controller.handleTrigger(trigger("regression", candidate.candidateId, fixture.state));
	expect(result.status).toBe("rollback_proposed");
	expect(proposeRollback).toHaveBeenCalledOnce();
	expect(promote).toHaveBeenCalledOnce();
	const repeatedTrigger = trigger("regression", candidate.candidateId, fixture.state, "regression-repeat-receipt");
	repeatedTrigger.sourceEventRef = ref("regression-repeat");
	repeatedTrigger.evidenceRefs = [ref("regression-repeat-evidence")];
	repeatedTrigger.evidenceDigest = digestObject(repeatedTrigger.evidenceRefs);
	repeatedTrigger.hostReceipt = boundReceipt("regression-repeat-receipt", "artifact", "trigger", repeatedTrigger, {
		revision: fixture.state.currentRevision,
	});
	const repeated = await fixture.controller.handleTrigger(repeatedTrigger);
	expect(repeated.status).toBe("rollback_proposed");
	expect(proposeRollback).toHaveBeenCalledOnce();
	expect(fixture.controller.getState().consumedReceiptIds).toContain("regression-repeat-receipt");
});

it("accepts milestone, failure, regression, and efficiency-review triggers but no timer activity", async () => {
	const fixture = createFixture();
	for (const kind of ["milestone", "failure", "regression", "efficiency_review"] as const) {
		await expect(fixture.controller.handleTrigger(trigger(kind))).resolves.toMatchObject({ status: "queued" });
	}
	await expect(
		fixture.controller.handleTrigger({
			kind: "timer",
			candidateId: null,
			sourceEventRef: ref("timer"),
			evidenceRefs: [],
		} as unknown as WorkflowLearningTrigger),
	).rejects.toThrow(/trigger/i);
	await expect(fixture.controller.handleTrigger({ ...trigger("milestone"), evidenceRefs: [] })).rejects.toThrow(
		/evidence/i,
	);
});

it("carries the host-owned projection across controller runs without exposing hidden inputs", async () => {
	const first = createFixture();
	const candidate = await commitAndType(first, createExperience({ outcome: "failed" }));
	const reviewed = await first.controller.reviewCandidate(candidate.candidateId);
	const second = createWorkflowLearningControllerFromDurableState({
		ports: first.ports,
		state: first.controller.getState(),
	});
	expect(second.getState().reviews[0]?.status).toBe(reviewed.status);
	expect(JSON.stringify(second.getState())).not.toContain("hidden-test-input");
});

it("rejects holdout aliases and binds the shadow same-case digest to the manifest", async () => {
	const exposedFixture = createFixture({
		runShadow: async () =>
			({ ...createShadow(), HoLdOuT_Input: "secret-test-input" }) as unknown as WorkflowLearningShadowResult,
	});
	const exposedCandidate = await commitAndType(exposedFixture);
	await expect(exposedFixture.controller.reviewCandidate(exposedCandidate.candidateId)).rejects.toThrow(/opaque/i);

	const mismatchedFixture = createFixture({
		createCandidate: async () =>
			createCandidate({ caseManifest: { ...createCandidate().caseManifest, inputDigest: "other-input" } }),
	});
	const mismatchedCandidate = await commitAndType(mismatchedFixture);
	await expect(mismatchedFixture.controller.reviewCandidate(mismatchedCandidate.candidateId)).resolves.toMatchObject({
		status: "rejected",
		reasons: expect.arrayContaining(["same_case_mismatch"]),
	});
});

it("requires evaluator and metric freshness to use the matching baseline and decision reference", async () => {
	for (const mutationClass of ["evaluator", "metric"] as const) {
		const freshDecisionRef = decisionRef(`${mutationClass}-fresh`);
		const fixture = createFixture({
			createCandidate: async () => createCandidate({ mutationClass }),
			runShadow: async () =>
				createShadow({
					freshBaseline: {
						baselineRevision: 1,
						baselineDigest: mutationClass === "evaluator" ? "evaluator-baseline-1" : "metric-baseline-1",
						decisionRef: freshDecisionRef,
					},
				}),
			resolveDecision: async () => ({ ...createDecision(), decisionRef: freshDecisionRef }),
		});
		const candidate = await commitAndType(fixture);
		await expect(fixture.controller.reviewCandidate(candidate.candidateId)).resolves.toMatchObject({
			status: "promoted",
		});

		const staleFixture = createFixture({
			createCandidate: async () => createCandidate({ mutationClass }),
			runShadow: async () =>
				createShadow({
					freshBaseline: {
						baselineRevision: 1,
						baselineDigest: mutationClass === "evaluator" ? "evaluator-baseline-1" : "metric-baseline-1",
						decisionRef: freshDecisionRef,
					},
				}),
			resolveDecision: async () => ({ ...createDecision(), decisionRef: decisionRef(`${mutationClass}-stale`) }),
		});
		const staleCandidate = await commitAndType(staleFixture);
		await expect(staleFixture.controller.reviewCandidate(staleCandidate.candidateId)).resolves.toMatchObject({
			status: "rejected",
			reasons: expect.arrayContaining(["fresh_decision_required"]),
		});
	}
});

it("rejects mutation classes outside the closed host vocabulary", async () => {
	const fixture = createFixture({
		createCandidate: async () =>
			createCandidate({ mutationClass: "untrusted" as WorkflowLearningCandidate["mutationClass"] }),
	});
	await expect(commitAndType(fixture)).rejects.toThrow(/mutation class/i);
});

it("coalesces concurrent reviews so one candidate cannot be promoted twice", async () => {
	let run = 0;
	const promote = vi.fn(
		async ({
			candidate,
			expected,
		}: {
			candidate: WorkflowLearningCandidate;
			expected: { storeEpoch: number; coordinatorEpoch: number };
		}) => ({
			promotionId: `promotion-${candidate.candidateId}-${run}`,
			candidateId: candidate.candidateId,
			revisionId: `revision-${run + 1}`,
			revision: 2,
			policyDigest: `policy-${run + 1}`,
			stateHeadDigest: "head-2",
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: `cas-concurrent-${run + 1}`,
			receipt: receipt(`promotion-concurrent-${++run}`, "decision"),
		}),
	);
	const fixture = createFixture({
		runShadow: async () => createShadow({ receipts: [receipt(`shadow-concurrent-${++run}`)] }),
		runCanary: async () => createCanary({ receipts: [receipt(`canary-concurrent-${++run}`)] }),
		runIndependentRedTeam: async ({ canary }) =>
			createRedTeam({
				sessionId: `${canary.sessionId}-red-team`,
				executionIdentity: `${canary.executionIdentity}-red-team`,
				receipts: [receipt(`red-team-concurrent-${++run}`, "adjudication")],
			}),
		promote,
	});
	const candidate = await commitAndType(fixture);
	const results = await Promise.all([
		fixture.controller.reviewCandidate(candidate.candidateId),
		fixture.controller.reviewCandidate(candidate.candidateId),
	]);
	expect(promote).toHaveBeenCalledOnce();
	expect(results[0]).toEqual(results[1]);
});

it("uses the durable host CAS to serialize reviews across controller instances", async () => {
	const first = createFixture();
	const candidate = await commitAndType(first);
	const second = createWorkflowLearningControllerFromDurableState({
		ports: first.ports,
		state: first.controller.getState(),
	});
	const results = await Promise.allSettled([
		first.controller.reviewCandidate(candidate.candidateId),
		second.reviewCandidate(candidate.candidateId),
	]);
	const promoted = results.filter((result) => result.status === "fulfilled" && result.value.status === "promoted");
	expect(promoted).toHaveLength(1);
	expect(first.state.currentRevision).toBe(2);
	expect(first.state.stateHeadDigest).toBe("head-2");
});

it("binds host receipts to the current workflow and rejects duplicate progress evidence references", async () => {
	const badReceiptFixture = createFixture();
	await expect(
		badReceiptFixture.controller.commitExperience(
			createExperience({ hostReceipt: { ...receipt("wrong-workflow"), workflowId: "other-workflow" } }),
		),
	).rejects.toThrow(/receipt|workflow/i);

	const duplicateEvidenceFixture = createFixture();
	await expect(
		duplicateEvidenceFixture.controller.commitExperience(
			createExperience({ progressEvidenceRefs: [ref("progress-1"), ref("progress-1")] }),
		),
	).rejects.toThrow(/evidence/i);
});

it("validates promotion identity and monotonic revision, and binds rollback to the promoted revision", async () => {
	const badPromotionFixture = createFixture({
		promote: async ({ expected }) => ({
			promotionId: "promotion-bad",
			candidateId: "different-candidate",
			revisionId: "revision-2",
			revision: 1,
			policyDigest: "policy-2",
			stateHeadDigest: `${expected.stateHeadDigest}-next`,
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "cas-bad",
			receipt: receipt("promotion-bad", "decision"),
		}),
	});
	const badCandidate = await commitAndType(badPromotionFixture);
	await expect(badPromotionFixture.controller.reviewCandidate(badCandidate.candidateId)).rejects.toThrow(
		/promotion|revision|candidate/i,
	);

	const badRollbackFixture = createFixture({
		proposeRollback: async ({ candidate, expected }) => ({
			proposalId: "rollback-bad",
			candidateId: candidate.candidateId,
			rollbackOf: "wrong-revision",
			proposalRef: ref("rollback-bad"),
			proposalDigest: ref("rollback-bad").digest,
			stateHeadDigest: expected.stateHeadDigest,
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "rollback-cas-bad",
			receipt: receipt("rollback-bad"),
		}),
	});
	const candidate = await commitAndType(badRollbackFixture);
	await badRollbackFixture.controller.reviewCandidate(candidate.candidateId);
	await expect(
		badRollbackFixture.controller.handleTrigger(
			trigger("regression", candidate.candidateId, badRollbackFixture.state),
		),
	).rejects.toThrow(/rollback|revision/i);
});

it("deduplicates trigger identities and bounds trigger evidence", async () => {
	const fixture = createFixture();
	const first = trigger("milestone");
	await expect(fixture.controller.handleTrigger(first)).resolves.toMatchObject({ status: "queued" });
	await expect(fixture.controller.handleTrigger({ ...first })).resolves.toMatchObject({ status: "queued" });
	expect(fixture.controller.getState().triggers).toHaveLength(1);

	await expect(
		fixture.controller.handleTrigger({
			...trigger("failure"),
			evidenceRefs: Array.from({ length: 33 }, (_, index) => ref(`trigger-evidence-${index}`)),
		}),
	).rejects.toThrow(/trigger|evidence/i);
});

it("gives stage callbacks a frozen capability-free host projection", async () => {
	let seenCurrent: unknown;
	const fixture = createFixture({
		runShadow: async ({ current }) => {
			seenCurrent = current;
			return createShadow();
		},
	});
	const candidate = await commitAndType(fixture);
	await fixture.controller.reviewCandidate(candidate.candidateId);
	expect(seenCurrent).toBeDefined();
	expect(seenCurrent).not.toHaveProperty("artifactResolver");
	expect(seenCurrent).not.toHaveProperty("receiptContext");
	expect(Object.isFrozen(seenCurrent)).toBe(true);
});

it("rejects stage booleans without positive bounded host-derived metrics", async () => {
	const fixture = createFixture({ runShadow: async () => createShadow({ metrics: undefined }) });
	const candidate = await commitAndType(fixture);
	await expect(fixture.controller.reviewCandidate(candidate.candidateId)).resolves.toMatchObject({
		status: "rejected",
		reasons: expect.arrayContaining(["metrics_required"]),
	});
});

it("requires resolver witnesses for host experience evidence", async () => {
	const fixture = createFixture({ resolveEvidence: undefined });
	await expect(fixture.controller.commitExperience(createExperience())).rejects.toThrow(/witness|resolver/i);
});

it("does not let a passing stage bypass host evidence resolution", async () => {
	const fixture = createFixture({
		resolveEvidence: async ({ stage, candidateId, evidenceRefs, payloadDigest, current }) => {
			if (stage === "shadow") return [];
			return evidenceRefs.map((evidenceRef) => witness(stage, candidateId, evidenceRef, current, payloadDigest));
		},
	});
	const candidate = await commitAndType(fixture);
	await expect(fixture.controller.reviewCandidate(candidate.candidateId)).rejects.toThrow(/witness|evidence/i);
});

it("rejects zero or non-finite holdout samples before any promotion decision", async () => {
	for (const heldOutSampleCount of [0, Number.NaN]) {
		const fixture = createFixture({ runShadow: async () => createShadow({ heldOutSampleCount }) });
		const candidate = await commitAndType(fixture);
		await expect(fixture.controller.reviewCandidate(candidate.candidateId)).rejects.toThrow(/sample/i);
	}
});

it("binds receipts and triggers to the current trusted revision and epoch", async () => {
	const staleReceiptFixture = createFixture();
	await expect(
		staleReceiptFixture.controller.commitExperience(
			createExperience({ hostReceipt: receipt("stale-experience", "artifact", { revision: 2 }) }),
		),
	).rejects.toThrow(/stale|receipt|revision/i);

	const staleTriggerFixture = createFixture();
	await expect(
		staleTriggerFixture.controller.handleTrigger({ ...trigger("milestone"), storeEpoch: 2 }),
	).rejects.toThrow(/epoch|head|workflow/i);
});

it("rejects non-canonical artifact paths and mismatched receipt bytes", async () => {
	const pathFixture = createFixture({
		createCandidate: async () =>
			createCandidate({ candidateRef: { ...ref("candidate-1"), relativePath: "../escape" } }),
	});
	await expect(commitAndType(pathFixture)).rejects.toThrow(/canonical|artifact|path/i);

	const receiptFixture = createFixture();
	receiptFixture.ports.receiptPort = {
		verify: async ({ receipt: hostReceipt, bindingDigest, stage, candidateId, current }) => ({
			...witness(stage, candidateId, hostReceipt.artifactRef, current, bindingDigest, "receipt"),
			bytesDigest: "tampered-bytes",
		}),
		consume: async () => undefined,
	};
	await expect(receiptFixture.controller.commitExperience(createExperience())).rejects.toThrow(/bytes|witness/i);
});

it("rejects an invalid signed receipt even when the receipt port claims it is valid", async () => {
	const fixture = createFixture();
	const experience = createExperience();
	await expect(
		fixture.controller.commitExperience({
			...experience,
			hostReceipt: { ...experience.hostReceipt, signature: "invalid-signature" },
		}),
	).rejects.toThrow(/cryptographic|receipt|signature/i);
});

it("fails closed when replayed state digest or semantic records are tampered", async () => {
	const fixture = createFixture();
	const committed = await fixture.controller.commitExperience(
		createExperience({ hostReceipt: receipt("state-replay-experience") }),
	);
	const state = fixture.controller.getState();
	expect(() =>
		createWorkflowLearningController({ ports: fixture.ports, state: { ...state, stateDigest: "tampered" } }),
	).toThrow(/hydration|authenticated/i);
	expect(() =>
		createWorkflowLearningController({
			ports: fixture.ports,
			state: {
				...state,
				experiences: [{ ...committed, workflowId: "other-workflow" }],
			},
		}),
	).toThrow(/hydration|authenticated/i);
});

it("requires host CAS identity and validates the post-promotion snapshot", async () => {
	const fixture = createFixture({
		promote: async ({ candidate }) => ({
			promotionId: `promotion-${candidate.candidateId}`,
			candidateId: candidate.candidateId,
			revisionId: "revision-1",
			revision: 2,
			policyDigest: "policy-2",
			receipt: receipt("promotion-no-cas", "decision"),
		}),
	});
	const candidate = await commitAndType(fixture);
	await expect(fixture.controller.reviewCandidate(candidate.candidateId)).rejects.toThrow(/CAS|head|epoch|snapshot/i);
});

it("requires the host classifier to agree with immutable candidate mutation identity", async () => {
	const fixture = createFixture({
		...({
			classifyCandidate: async () => ({ mutationClass: "skill" }),
		} as unknown as Partial<WorkflowLearningHost>),
	});
	await expect(commitAndType(fixture)).rejects.toThrow(/class|classifier|skill/i);
});

it("rejects protected skill paths mislabeled as workflow mutations", async () => {
	const fixture = createFixture({
		classifyCandidate: async ({ candidate }) => ({
			mutationClass: candidate.mutationClass,
			payloadDigest: candidate.candidateDigest,
			classifierDigest: "classifier-protected",
			protectedPaths: ["skills/hidden/SKILL.md"],
		}),
	});
	await expect(commitAndType(fixture)).rejects.toThrow(/protected|skill|workflow/i);
});

it("requires trigger workflow, epoch, head, and authenticated evidence identity", async () => {
	const fixture = createFixture();
	await expect(
		fixture.controller.handleTrigger({ ...trigger("milestone"), stateHeadDigest: undefined }),
	).rejects.toThrow(/workflow|epoch|head|evidence/i);
});

it("bounds persisted candidate identifiers and receipt history", async () => {
	const fixture = createFixture({
		createCandidate: async () => createCandidate({ candidateDigest: "x".repeat(20_000) }),
	});
	await expect(commitAndType(fixture)).rejects.toThrow(/bound|size|digest|candidate/i);
});
