import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";
import { createNativeExperimentEngine } from "../src/core/autoresearch/engine.js";
import type {
	AutoResearchCandidatePlan,
	AutoResearchDurableRecipe,
	AutoResearchProductionRunRequest,
} from "../src/core/autoresearch/runner.js";
import {
	autoResearchCandidateHypothesisDigest,
	createAutoResearchProductionRunner,
} from "../src/core/autoresearch/runner.js";
import {
	createAutoResearchRunHostHandler,
	createAutoResearchWorkflowRuntimeAdapter,
	validateAutoResearchProjectionIntent,
} from "../src/core/autoresearch/runtime-adapter.js";
import type {
	AutoResearchCandidateRequest,
	AutoResearchCommittedEvent,
	AutoResearchDecisionResolution,
	AutoResearchEvidenceProof,
	AutoResearchEvidenceSubmission,
	AutoResearchExperimentRegistration,
	AutoResearchHoldoutEvidence,
	AutoResearchHostMeasurement,
	AutoResearchHostPorts,
	AutoResearchProposalCandidateInput,
	AutoResearchRawObservation,
	AutoResearchTaskSubmission,
} from "../src/core/autoresearch/types.js";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceiptConsumerContext,
	type DurableApprovalSecretProof,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowArtifactEnvelope,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowDecisionRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowImprovementProposal,
	type WorkflowLeaseRef,
	type WorkflowResourceVector,
	type WorkflowRevisionResolution,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type { WorkflowDeferredEventOwnerValidators } from "../src/core/workflow/reducer.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
} from "../src/core/workflow/session-host-factory.js";

const GENESIS_EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

function goalProjection(
	artifactRoot: string,
	workflowId: string,
): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	const projectionPath = join(artifactRoot, `goal-projection-${workflowId}.json`);
	let value = existsSync(projectionPath)
		? (JSON.parse(readFileSync(projectionPath, "utf8")) as GoalState)
		: emptyGoalState();
	return {
		read: () => structuredClone(value),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(value) !== JSON.stringify(expected)) return false;
			value = structuredClone(next);
			writeFileSync(projectionPath, JSON.stringify(value));
			return true;
		},
	};
}

function deferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: validateAutoResearchProjectionIntent,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

async function readLease(artifactRoot: string, workflowId: string): Promise<WorkflowLeaseRef> {
	const bytes = await readFile(join(artifactRoot, "workflows", workflowId, "append-lease.json"));
	const value = parseCanonicalJsonBytes(bytes);
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("lease record missing");
	const leaseRef = (value as Record<string, unknown>).leaseRef;
	if (typeof leaseRef !== "object" || leaseRef === null || Array.isArray(leaseRef))
		throw new Error("lease ref missing");
	return leaseRef as WorkflowLeaseRef;
}

function artifactResolver(artifactRoot: string, workflowId: string): WorkflowArtifactResolver {
	return {
		resolve: async (ref) => {
			const artifactPath = join(artifactRoot, "workflows", workflowId, ref.relativePath);
			const bytes = await readFile(artifactPath);
			const metadataBytes = await readFile(`${artifactPath}.metadata.json`);
			const metadata = parseCanonicalJsonBytes(metadataBytes) as unknown as WorkflowArtifactEnvelope;
			return {
				envelope: metadata,
				exists: true,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
}

function receiptContextForResolver(resolver: WorkflowArtifactResolver): WorkflowHostReceiptConsumerContext {
	const fixtureContext = createFixtureHostReceiptConsumerContext();
	return {
		...fixtureContext,
		artifactResolver: resolver,
	};
}

function nativeEvent(): AutoResearchCommittedEvent {
	return {
		kind: "proposal_emitted",
		registrationDigest: "registration-digest",
		observationId: "observation-1",
		proposal: {
			workflowId: "autoresearch-runtime-workflow",
		} as Extract<AutoResearchCommittedEvent, { kind: "proposal_emitted" }>["proposal"],
		proposalDigest: "proposal-digest",
		observationDigest: "observation-digest",
	};
}

async function openHost(artifactRoot: string): Promise<PersistedSessionWorkflowHost> {
	let approvalProof: DurableApprovalSecretProof | undefined;
	const host = await createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId: "autoresearch-runtime-session",
		workflowId: "autoresearch-runtime-workflow",
		goalProjection: goalProjection(artifactRoot, "autoresearch-runtime-workflow"),
		genesisEpoch: GENESIS_EPOCH,
		deferredOwnerValidators: deferredOwnerValidators(),
		approvalSecretDelivery: ({ proof }) => {
			approvalProof = structuredClone(proof);
		},
	});
	if ((await host.execute({ kind: "status" })).stateDigest === null) {
		const started = await host.execute({
			kind: "start",
			request: {
				workflowId: "autoresearch-runtime-workflow",
				objective: "persist native runtime events",
				acceptanceChecks: ["durable"],
				protectedInvariants: ["host-authoritative"],
			},
		});
		if (started.approvalRequest !== null) {
			if (approvalProof === undefined) throw new Error("approval_proof_not_delivered");
			await host.execute({
				kind: "respond",
				approvalRequestId: started.approvalRequest.approvalRequestId,
				optionId: "approve",
				proof: approvalProof,
			});
		}
	}
	return host;
}

const PRODUCTION_WORKFLOW_ID = "autoresearch-runtime-workflow";
const PRODUCTION_RUN_ID = "autoresearch-production-run";
const PRODUCTION_EXECUTION_KEY = "autoresearch-production-execution";
const PRODUCTION_WRITER = "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow";

function productionResource(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
		...overrides,
	};
}

function productionDigest(label: string): string {
	return digestObject({ label, suite: "autoresearch-production" });
}

function productionIndependentPlan(
	observationId: string,
	candidate: AutoResearchCandidateRequest,
): AutoResearchCandidatePlan {
	const solutionFamily = `structural solution family ${candidate.candidateId}`;
	const mechanism = `replace the failing control flow with an independently testable mechanism ${candidate.candidateId}`;
	const falsificationCondition = `the structural mechanism does not improve public outcomes ${candidate.candidateId}`;
	const structuralChanges = [`replace control flow ${candidate.candidateId}`];
	const hypothesisWithoutDigest = {
		kind: "independent_solution" as const,
		solutionFamily,
		mechanism,
		falsificationCondition,
		expectedGeneralization: `the structural mechanism applies beyond one fixture ${candidate.candidateId}`,
		structuralChanges,
		parameterChanges: [],
		solutionFamilyDigest: digestObject({ solutionFamily }),
		mechanismDigest: digestObject({ mechanism, structuralChanges }),
		falsificationDigest: digestObject({ falsificationCondition }),
		parameterOnly: false,
	};
	return {
		observationId,
		candidate,
		hypothesis: {
			...hypothesisWithoutDigest,
			hypothesisDigest: autoResearchCandidateHypothesisDigest(hypothesisWithoutDigest),
		},
	};
}

function productionArtifactRef(label: string): WorkflowArtifactRef {
	const digest = productionDigest(`artifact:${label}`);
	return {
		artifactId: `artifact:${label}`,
		relativePath: `artifacts/${label}`,
		digest,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function productionBinding(): {
	commandDigest: string;
	inputDigests: readonly string[];
	bindingDigest: string;
} {
	const inputDigests = [productionDigest("eval-input"), productionDigest("train-input")];
	const commandDigest = productionDigest("command");
	return {
		commandDigest,
		inputDigests,
		bindingDigest: digestObject({ commandDigest, inputDigests }),
	};
}

function productionRegistration(): AutoResearchExperimentRegistration {
	const decisionRef = productionDecisionRef();
	const revisionPreimage = {
		registryEntryRef: productionArtifactRef("registry-entry"),
		registryEntryId: "production-registry-entry",
		registryEpoch: 1,
		revisionKind: "workflow" as const,
		scope: "workflow" as const,
		scopeBinding: { scope: "workflow" as const, workflowId: PRODUCTION_WORKFLOW_ID },
		registryStatus: "approved" as const,
		compatibilityClosureDigest: productionDigest("compatibility-closure"),
		expectedRegistryEpoch: 1,
		observedRegistryEpoch: 1,
		revocationEpoch: null,
		revocationEventSequence: null,
		rollbackOfRevisionId: null,
		rollbackEventSequence: null,
		casExecutionKey: "production-revision-cas",
		hostReceipt: productionReceipt(decisionRef, productionDigest("revision-state"), productionDigest("revision")),
	};
	const revision = {
		...revisionPreimage,
		resolutionDigest: digestObject(revisionPreimage),
	} satisfies WorkflowRevisionResolution;
	const commandDigest = productionDigest("command");
	const inputDigests = productionBinding().inputDigests;
	return {
		runId: PRODUCTION_RUN_ID,
		workflowId: PRODUCTION_WORKFLOW_ID,
		revisionResolution: revision,
		metric: { metricId: "score", name: "score", direction: "lower", target: 1, tolerance: 0 },
		evaluator: {
			evaluatorDigest: productionDigest("evaluator"),
			parserDigest: productionDigest("parser"),
			commandDigest,
		},
		commandInputBinding: productionBinding(),
		seed: { seedId: "seed", seedDigest: productionDigest("seed") },
		fixtures: [
			{
				fixtureId: "train",
				partition: "train",
				inputDigest: inputDigests[1]!,
				manifestDigest: productionDigest("train-manifest"),
				hidden: false,
			},
			{
				fixtureId: "eval",
				partition: "eval",
				inputDigest: inputDigests[0]!,
				manifestDigest: productionDigest("eval-manifest"),
				hidden: false,
			},
			{
				fixtureId: "holdout",
				partition: "holdout",
				inputDigest: productionDigest("holdout-input"),
				manifestDigest: productionDigest("holdout-manifest"),
				hidden: true,
			},
			{
				fixtureId: "adversarial",
				partition: "adversarial",
				inputDigest: productionDigest("adversarial-input"),
				manifestDigest: productionDigest("adversarial-manifest"),
				hidden: true,
			},
		],
		guard: { guardDigest: productionDigest("guard") },
		requiredSampleSize: 2,
		maxCandidates: 2,
		maxVariance: 1,
		maxCostMicrounits: 10,
		maxLatencyMilliseconds: 10,
		resourceCeiling: productionResource({ cpuMilliCores: 2, monetaryMicrounits: 10, wallMilliseconds: 10 }),
		hiddenHoldout: {
			handleId: "production-holdout",
			manifestDigest: productionDigest("holdout-manifest"),
			caseCount: 2,
			owner: "host",
			hidden: true,
			opaque: true,
			hostResolverOnly: true,
			bytesAccessibleToProposer: false,
			bytesAccessibleToWorker: false,
		},
	};
}

function productionRefFromEnvelope(envelope: WorkflowArtifactEnvelope): WorkflowArtifactRef {
	return envelope.ref;
}

function productionProposal(
	input: AutoResearchProposalCandidateInput,
	anticipatedEvidenceRef: WorkflowArtifactRef,
): WorkflowImprovementProposal {
	return {
		proposalId: `proposal:${input.observation.observationId}`,
		workflowId: input.registration.workflowId,
		owner: "autoresearch",
		producer: "autoresearch",
		status: "proposed",
		attemptId: input.candidateRequest.attemptId,
		candidateDigest: input.candidateRequest.changeDigest,
		baselineDigest: input.candidateRequest.baseRevisionDigest,
		revisionResolution: input.registration.revisionResolution,
		hostAcceptedEvidenceRefs: [anticipatedEvidenceRef],
	} as unknown as WorkflowImprovementProposal;
}

function productionDecisionRef(): WorkflowDecisionRef {
	return {
		decisionScope: {
			kind: "workflow",
			workflowId: PRODUCTION_WORKFLOW_ID,
			rootSessionId: "autoresearch-runtime-session",
		},
		decisionId: "production-decision",
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		decisionDigest: productionDigest("production-decision"),
	};
}

function productionReceipt(
	ref: WorkflowDecisionRef,
	stateDigest: string,
	registrationDigest: string,
): WorkflowVerifiedHostReceipt {
	const bindingDigest = digestObject({
		workflowId: PRODUCTION_WORKFLOW_ID,
		registrationDigest,
		decisionRef: ref,
		stateDigest,
		headDigest: "production-head",
		epochRef: GENESIS_EPOCH,
	});
	const receipt = {
		receiptKind: "decision" as const,
		workflowId: PRODUCTION_WORKFLOW_ID,
		oneUse: false,
		receiptId: "production-decision-receipt",
		issuerId: "production-host",
		bindingDigest,
		payloadDigest: ref.decisionDigest,
		artifactRef: {
			...productionArtifactRef("decision-artifact"),
		},
		issuedAt: "2026-08-16T00:00:00.000Z",
		validUntil: "2099-08-16T00:00:00.000Z",
		keyId: "production-key",
		signatureAlgorithm: "ed25519" as const,
		artifactBytesDigest: productionDigest("decision-bytes"),
		stateDigest,
		revision: 1,
		signature: "production-signature",
		verificationDigest: "",
	};
	return { ...receipt, verificationDigest: digestObject({ ...receipt, verificationDigest: "" }) };
}

function productionProof(
	ref: WorkflowArtifactRef,
	registrationDigest: string,
	kind: "holdout" | "adversarial" | "observation",
): AutoResearchEvidenceProof {
	const proof = {
		ref,
		workflowId: PRODUCTION_WORKFLOW_ID,
		registrationDigest,
		kind,
		authenticated: true as const,
		fresh: true as const,
		revoked: false as const,
		proofDigest: "",
	};
	const { proofDigest: _ignored, ...preimage } = proof;
	return { ...proof, proofDigest: digestObject(preimage) };
}

async function productionHostPorts(
	host: PersistedSessionWorkflowHost,
	artifactRoot: string,
	badRawRef = false,
): Promise<{
	hostPorts: AutoResearchHostPorts;
	authority: Parameters<typeof createAutoResearchProductionRunner>[0]["authority"];
	resolver: WorkflowArtifactResolver;
	executionCalls: { count: number; sawHiddenInput: boolean };
	measurementCalls: {
		count: number;
		metricValue: number | null;
		baselineMetricValue: number | null;
		hiddenMetricValue: number | null;
		adversarialMetricValue: number | null;
	};
	publish: (bytes: Uint8Array, idempotencyKey: string, sourceEventSequence?: number) => Promise<WorkflowArtifactRef>;
}> {
	const resolver = artifactResolver(artifactRoot, PRODUCTION_WORKFLOW_ID);
	const executionCalls = { count: 0, sawHiddenInput: false };
	const measurementCalls = {
		count: 0,
		metricValue: null as number | null,
		baselineMetricValue: null as number | null,
		hiddenMetricValue: null as number | null,
		adversarialMetricValue: null as number | null,
	};
	const anticipatedEvidenceSources = new Map<string, number>();
	const runtime = createAutoResearchWorkflowRuntimeAdapter({
		runtimeStore: host.runtimeStore,
		artifactResolver: resolver,
		workflowId: PRODUCTION_WORKFLOW_ID,
		runId: PRODUCTION_RUN_ID,
		executionKey: PRODUCTION_EXECUTION_KEY,
		writerIdentity: PRODUCTION_WRITER,
		resolveLeaseRef: () => readLease(artifactRoot, PRODUCTION_WORKFLOW_ID),
	});
	const currentHead = async () =>
		(
			await host.runtimeStore.replay({
				workflowId: PRODUCTION_WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: 1,
			})
		).head;
	const publish = async (
		bytes: Uint8Array,
		idempotencyKey: string,
		sourceEventSequence?: number,
	): Promise<WorkflowArtifactRef> => {
		const head = sourceEventSequence === undefined ? await currentHead() : null;
		const published = await host.runtimeStore.publishArtifact({
			workflowId: PRODUCTION_WORKFLOW_ID,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: sourceEventSequence ?? Math.max(1, head?.sequence ?? 1),
			idempotencyKey,
		});
		return productionRefFromEnvelope(published.envelope);
	};
	const submitDecision = async (): Promise<WorkflowDecisionRef> => productionDecisionRef();
	const resolveDecision = async (input: {
		workflowId: string;
		registrationDigest: string;
		registration: AutoResearchExperimentRegistration;
		ref: WorkflowDecisionRef;
	}): Promise<AutoResearchDecisionResolution> => {
		const value = {
			ref: input.ref,
			workflowId: input.workflowId,
			registrationDigest: input.registrationDigest,
			stateDigest: "production-state",
			headDigest: "production-head",
			epochRef: GENESIS_EPOCH,
			disposition: "authorized" as const,
			authority: ["observe_workflow"],
			fresh: true as const,
			revoked: false as const,
			receipt: productionReceipt(input.ref, "production-state", input.registrationDigest),
			resolutionDigest: "",
		};
		const { resolutionDigest: _ignored, ...preimage } = value;
		return { ...value, resolutionDigest: digestObject(preimage) };
	};
	const hostPorts = {
		submitTask: async (input: AutoResearchTaskSubmission) => {
			return {
				taskId: input.candidateId,
				candidateId: input.candidateId,
				attemptId: input.attemptId,
				changeDigest: input.changeDigest,
				taskDigest: digestObject(input),
			};
		},
		submitEvidence: async (input: AutoResearchEvidenceSubmission) =>
			publish(
				canonicalJsonBytes({ kind: "autoresearch-evidence", ...input }),
				`production:evidence:${input.observationId}`,
			),
		submitDecision,
		resolveDecision,
		submitProposal: async (input: AutoResearchProposalCandidateInput) => {
			const head = await currentHead();
			const evidenceBytes = canonicalJsonBytes({
				kind: "autoresearch-accepted-evidence",
				observationId: input.observation.observationId,
			});
			const anticipated = {
				artifactId: `evidence:${sha256Hex(evidenceBytes)}`,
				relativePath: `artifacts/evidence/${sha256Hex(evidenceBytes)}`,
				digest: sha256Hex(evidenceBytes),
				sizeBytes: evidenceBytes.byteLength,
				sourceEventSequence: head.sequence + 1,
			};
			anticipatedEvidenceSources.set(input.observation.observationId, anticipated.sourceEventSequence);
			return productionProposal(input, anticipated);
		},
		submitAcceptedProposal: async (input: {
			transactionDigest: string;
			evidence: AutoResearchEvidenceSubmission;
			proposal: AutoResearchProposalCandidateInput;
		}) => {
			const evidenceBytes = canonicalJsonBytes({
				kind: "autoresearch-accepted-evidence",
				observationId: input.evidence.observation.observationId,
			});
			const anticipatedSourceSequence = anticipatedEvidenceSources.get(input.evidence.observation.observationId);
			if (anticipatedSourceSequence === undefined) throw new Error("accepted_evidence_source_missing");
			const evidenceRef = await publish(
				evidenceBytes,
				`production:accepted:${input.transactionDigest}`,
				anticipatedSourceSequence,
			);
			const evidenceProof = productionProof(evidenceRef, digestObject(input.proposal.registration), "observation");
			return {
				transactionDigest: input.transactionDigest,
				evidenceRef,
				evidenceProof,
				proposal: productionProposal(input.proposal, evidenceRef),
			};
		},
		submitHoldout: async (input: {
			runId: string;
			registrationDigest: string;
			handle: NonNullable<AutoResearchExperimentRegistration["hiddenHoldout"]>;
		}): Promise<AutoResearchHoldoutEvidence> => {
			const holdoutRef = await publish(canonicalJsonBytes({ kind: "holdout-evidence" }), "production:holdout");
			const adversarialRef = await publish(
				canonicalJsonBytes({ kind: "adversarial-evidence" }),
				"production:adversarial",
			);
			return {
				handleId: input.handle.handleId,
				manifestDigest: input.handle.manifestDigest,
				resolverContext: {
					contextId: "production-holdout-context",
					workflowId: PRODUCTION_WORKFLOW_ID,
					registrationDigest: input.registrationDigest,
					handleId: input.handle.handleId,
					manifestDigest: input.handle.manifestDigest,
					stateDigest: "production-state",
					epochRef: GENESIS_EPOCH,
					authenticated: true,
					returnsEvidenceOnly: true,
					returnsBytes: false,
					resolverDigest: "production-resolver",
				},
				evidenceRefs: [holdoutRef],
				adversarialEvidenceRefs: [adversarialRef],
				evidenceProofs: [productionProof(holdoutRef, input.registrationDigest, "holdout")],
				adversarialEvidenceProofs: [productionProof(adversarialRef, input.registrationDigest, "adversarial")],
				bytesReturned: false,
			};
		},
		measureObservation: async (input: AutoResearchRawObservation): Promise<AutoResearchHostMeasurement> => {
			if (badRawRef) throw new Error("host_measurement_must_not_run_for_forged_ref");
			measurementCalls.count += 1;
			const resolved = await resolver.resolve(input.rawResultRefs[0]!);
			const parsed = parseCanonicalJsonBytes(resolved.bytes) as Record<string, unknown>;
			if (parsed.kind !== "approved-candidate-result") throw new Error("host_parser_rejected_result");
			const registration = productionRegistration();
			const measurement = {
				source: "host" as const,
				measurementDigest: "",
				rawResultRefsDigest: digestObject(input.rawResultRefs),
				phase: "promotion" as const,
				status: "complete" as const,
				commandInputBinding: registration.commandInputBinding,
				metricDirection: registration.metric.direction,
				metricTarget: registration.metric.target,
				metricTolerance: registration.metric.tolerance,
				sampleCount: 2,
				metricValue: 1,
				baselineMetricValue: 2,
				variance: 0,
				fixtureManifestDigest: registration.fixtures
					.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
					.map((fixture) => fixture.manifestDigest)
					.sort()
					.join("|"),
				trainInputDigest: registration.fixtures.find((fixture) => fixture.partition === "train")!.inputDigest,
				evalInputDigest: registration.fixtures.find((fixture) => fixture.partition === "eval")!.inputDigest,
				heldOutInputDigest: null,
				evaluatorDigest: registration.evaluator.evaluatorDigest,
				parserDigest: registration.evaluator.parserDigest,
				guardDigest: registration.guard?.guardDigest ?? null,
				seedDigest: registration.seed.seedDigest,
				proxySignals: [],
				costMicrounits: 1,
				latencyMilliseconds: 1,
				resourceUsage: productionResource(),
				hiddenMetricValue: 1,
				adversarialMetricValue: 1,
				candidateClaimedCompletion: false as const,
				candidateClaimedPromotion: false as const,
			};
			const { measurementDigest: _ignored, ...preimage } = measurement;
			measurementCalls.metricValue = measurement.metricValue;
			measurementCalls.baselineMetricValue = measurement.baselineMetricValue;
			measurementCalls.hiddenMetricValue = measurement.hiddenMetricValue;
			measurementCalls.adversarialMetricValue = measurement.adversarialMetricValue;
			return { ...measurement, measurementDigest: digestObject(preimage) };
		},
		runtime,
	} satisfies AutoResearchHostPorts;
	const authority = {
		runtimeStore: host.runtimeStore,
		artifactResolver: resolver,
		workflowId: PRODUCTION_WORKFLOW_ID,
		executionKey: PRODUCTION_EXECUTION_KEY,
		writerIdentity: PRODUCTION_WRITER,
		resolveLeaseRef: () => readLease(artifactRoot, PRODUCTION_WORKFLOW_ID),
		receiptContext: receiptContextForResolver(resolver),
	};
	return { hostPorts, authority, resolver, executionCalls, measurementCalls, publish };
}

// Spawns two separate persisted runtime hosts and replays between them; same starvation profile as
// the persisted-admission test above - timed out at 30003ms under a 20-file parallel run, passes alone.
it("replays and retries one native event through separate persisted runtime hosts", { timeout: 180_000 }, async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-runtime-adapter-"));
	const workflowId = "autoresearch-runtime-workflow";
	let first: PersistedSessionWorkflowHost | undefined;
	let second: PersistedSessionWorkflowHost | undefined;
	try {
		first = await openHost(artifactRoot);
		const firstAdapter = createAutoResearchWorkflowRuntimeAdapter({
			runtimeStore: first.runtimeStore,
			artifactResolver: artifactResolver(artifactRoot, workflowId),
			workflowId,
			runId: "run-1",
			executionKey: "execution-1",
			writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
			resolveLeaseRef: () => readLease(artifactRoot, workflowId),
		});
		const committed = await firstAdapter.commit({ event: nativeEvent() });
		expect(committed.commit.payload.kind).toBe("projection_intent");
		expect(committed.commit.recordMac.length).toBeGreaterThan(0);
		await first.dispose?.();
		first = undefined;

		second = await openHost(artifactRoot);
		const secondAdapter = createAutoResearchWorkflowRuntimeAdapter({
			runtimeStore: second.runtimeStore,
			artifactResolver: artifactResolver(artifactRoot, workflowId),
			workflowId,
			runId: "run-1",
			executionKey: "execution-1",
			writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
			resolveLeaseRef: () => readLease(artifactRoot, workflowId),
		});
		const retried = await secondAdapter.commit({ event: nativeEvent() });
		const replayed = await secondAdapter.replay();
		expect(retried.commit.sequence).toBe(committed.commit.sequence);
		expect(retried.commit.eventDigest).toBe(committed.commit.eventDigest);
		expect(replayed).toHaveLength(1);
		expect(replayed[0]?.eventDigest).toBe(committed.eventDigest);
	} finally {
		await first?.dispose?.();
		await second?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("resolves a split adapter race through durable idempotency", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-runtime-race-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const input = {
			runtimeStore: host.runtimeStore,
			artifactResolver: artifactResolver(artifactRoot, "autoresearch-runtime-workflow"),
			workflowId: "autoresearch-runtime-workflow",
			runId: "run-1",
			executionKey: "execution-1",
			writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
			resolveLeaseRef: () => readLease(artifactRoot, "autoresearch-runtime-workflow"),
		} as const;
		const first = createAutoResearchWorkflowRuntimeAdapter(input);
		const second = createAutoResearchWorkflowRuntimeAdapter(input);
		const [left, right] = await Promise.all([
			first.commit({ event: nativeEvent() }),
			second.commit({ event: nativeEvent() }),
		]);
		expect(left.eventDigest).toBe(right.eventDigest);
		expect((await first.replay()).map((record) => record.eventDigest)).toEqual([left.eventDigest]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("resolves evidence through the persisted host before invoking the bounded Python contract", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-runtime-gateway-"));
	let host: PersistedSessionWorkflowHost | undefined;
	let executorCalls = 0;
	try {
		host = await openHost(artifactRoot);
		const workflowId = "autoresearch-runtime-workflow";
		const resolver = artifactResolver(artifactRoot, workflowId);
		const current = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: 1 });
		const evidence = await host.runtimeStore.publishArtifact({
			workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes(nativeEvent()),
			codec: "canonical_json",
			sourceEventSequence: current.head.sequence,
			idempotencyKey: "autoresearch:gateway:evidence",
		});
		const authority = {
			runtimeStore: host.runtimeStore,
			artifactResolver: resolver,
			workflowId,
			executionKey: "execution-1",
			writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
			resolveLeaseRef: () => readLease(artifactRoot, workflowId),
			receiptContext: receiptContextForResolver(resolver),
		} as const;
		const evidenceRef = {
			artifact_id: evidence.envelope.ref.artifactId,
			relative_path: evidence.envelope.ref.relativePath,
			digest: evidence.envelope.ref.digest,
			size_bytes: evidence.envelope.ref.sizeBytes,
			source_event_sequence: evidence.envelope.ref.sourceEventSequence,
		};
		const handler = createAutoResearchRunHostHandler(async (request) => {
			executorCalls++;
			expect(Object.isFrozen(request)).toBe(true);
			expect(Object.isFrozen(request.evidenceRefs)).toBe(true);
			const evidenceRefs = request.evidenceRefs.map((ref) => ({
				artifact_id: ref.artifactId,
				relative_path: ref.relativePath,
				digest: ref.digest,
				size_bytes: ref.sizeBytes,
				source_event_sequence: ref.sourceEventSequence,
			}));
			const unsigned = {
				skill_id: "autoresearch",
				output_kind: "evidence",
				evidence_refs: evidenceRefs,
				durable_knowledge_boundary_digest: null,
				transient_state_refs: [],
				can_authorize: false,
			};
			return { ...unsigned, output_digest: digestObject(unsigned) };
		}, authority);
		const validPayload = {
			type: "workflow.v1.autoresearch.run",
			recipe_digest: "c".repeat(64),
			evidence_refs: [evidenceRef],
		};
		const result = await handler(validPayload);
		expect(result).toMatchObject({ skill_id: "autoresearch", can_authorize: false, output_kind: "evidence" });
		const unboundHandler = createAutoResearchRunHostHandler(async () => {
			executorCalls++;
			return {};
		});
		await expect(unboundHandler(validPayload)).rejects.toThrow(/handler_authority_missing/);
		const tamperedResolver: WorkflowArtifactResolver = {
			resolve: async (ref) => {
				const resolved = await resolver.resolve(ref);
				return { ...resolved, bytes: canonicalJsonBytes({ tampered: true }) };
			},
		};
		const tamperedHandler = createAutoResearchRunHostHandler(
			async () => {
				executorCalls++;
				return {};
			},
			{
				...authority,
				artifactResolver: tamperedResolver,
				receiptContext: receiptContextForResolver(tamperedResolver),
			},
		);
		await expect(tamperedHandler(validPayload)).rejects.toThrow();
		const future = await host.runtimeStore.publishArtifact({
			workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes({ ...nativeEvent(), observationId: "future" }),
			codec: "canonical_json",
			sourceEventSequence: current.head.sequence + 1,
			idempotencyKey: "autoresearch:gateway:future",
		});
		await expect(
			handler({
				type: "workflow.v1.autoresearch.run",
				recipe_digest: "c".repeat(64),
				evidence_refs: [
					{
						artifact_id: future.envelope.ref.artifactId,
						relative_path: future.envelope.ref.relativePath,
						digest: future.envelope.ref.digest,
						size_bytes: future.envelope.ref.sizeBytes,
						source_event_sequence: future.envelope.ref.sourceEventSequence,
					},
				],
			}),
		).rejects.toThrow();
		await expect(
			handler({
				type: "workflow.v1.autoresearch.run",
				recipe_digest: "c".repeat(64),
				evidence_refs: [
					{
						artifact_id: "secret",
						relative_path: "../secret",
						digest: "x",
						size_bytes: 1,
						source_event_sequence: current.head.sequence,
					},
				],
			}),
		).rejects.toThrow(/artifact_ref_invalid/);
		expect(executorCalls).toBe(1);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("replays a native intent after process A exits and host B reopens the store", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-runtime-process-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		const childScript = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAutoResearchWorkflowRuntimeAdapter, validateAutoResearchProjectionIntent } from "./src/core/autoresearch/runtime-adapter.js";
import { parseCanonicalJsonBytes } from "./src/core/workflow/contracts.js";
import { emptyGoalState } from "./src/core/goals.js";
import { createPersistedSessionWorkflowHost } from "./src/core/workflow/session-host-factory.js";

const artifactRoot = ${JSON.stringify(artifactRoot)};
const workflowId = "autoresearch-runtime-workflow";
const goalProjectionPath = join(artifactRoot, \`goal-projection-\${workflowId}.json\`);
let goalState = existsSync(goalProjectionPath)
  ? JSON.parse(readFileSync(goalProjectionPath, "utf8"))
  : emptyGoalState();
let approvalProof;
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId: "autoresearch-runtime-session",
  workflowId,
  goalProjection: {
    read: () => structuredClone(goalState),
    compareAndSwap: (expected, next) => {
      if (JSON.stringify(goalState) !== JSON.stringify(expected)) return false;
      goalState = structuredClone(next);
      writeFileSync(goalProjectionPath, JSON.stringify(goalState));
      return true;
    },
  },
  approvalSecretDelivery: ({ proof }) => { approvalProof = structuredClone(proof); },
  genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
  deferredOwnerValidators: {
    autoresearch: validateAutoResearchProjectionIntent,
    runtime: () => undefined,
    effect: () => undefined,
    recovery: () => undefined,
  },
});

if ((await host.execute({ kind: "status" })).stateDigest === null) {
  const started = await host.execute({
    kind: "start",
    request: {
      workflowId,
      objective: "persist native runtime events",
      acceptanceChecks: ["durable"],
      protectedInvariants: ["host-authoritative"],
    },
  });
  if (started.approvalRequest !== null) {
    if (approvalProof === undefined) throw new Error("approval_proof_not_delivered");
    await host.execute({
      kind: "respond",
      approvalRequestId: started.approvalRequest.approvalRequestId,
      optionId: "approve",
      proof: approvalProof,
    });
  }
}
const leaseBytes = await readFile(join(artifactRoot, "workflows", workflowId, "append-lease.json"));
const leaseRecord = parseCanonicalJsonBytes(leaseBytes);
const leaseRef = leaseRecord.leaseRef;
const adapter = createAutoResearchWorkflowRuntimeAdapter({
  runtimeStore: host.runtimeStore,
  artifactResolver: { resolve: async () => { throw new Error("child does not replay artifacts"); } },
  workflowId,
  runId: "run-1",
  executionKey: "execution-1",
  writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
  resolveLeaseRef: async () => leaseRef,
});

await adapter.commit({ event: ${JSON.stringify(nativeEvent())} });
await host.execute({ kind: "pause", reason: "pause around native runtime restart" });
await host.dispose?.();
`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
			cwd: join(process.cwd()),
		});
		const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		if (code !== 0) throw new Error(`process A failed with code ${String(code)} and signal ${String(signal)}`);

		host = await openHost(artifactRoot);
		const adapter = createAutoResearchWorkflowRuntimeAdapter({
			runtimeStore: host.runtimeStore,
			artifactResolver: artifactResolver(artifactRoot, "autoresearch-runtime-workflow"),
			workflowId: "autoresearch-runtime-workflow",
			runId: "run-1",
			executionKey: "execution-1",
			writerIdentity: "workflow-coordinator:autoresearch-runtime-session:autoresearch-runtime-workflow",
			resolveLeaseRef: () => readLease(artifactRoot, "autoresearch-runtime-workflow"),
		});
		const retried = await adapter.commit({ event: nativeEvent() });
		expect((await adapter.replay()).map((record) => record.commit.sequence)).toEqual([retried.commit.sequence]);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("runs a host-approved experiment through the persisted public boundary and resumes its evaluation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-runner-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "a".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				productionIndependentPlan("observation-1", {
					candidateId: "candidate-1",
					attemptId: "attempt-1",
					changeDigest: productionDigest("candidate-change"),
					baseRevisionDigest: productionDigest("baseline"),
					resourceRequest: productionResource(),
					claimedCompletion: false,
					claimedPromotion: false,
				}),
			],
		} satisfies AutoResearchDurableRecipe;
		const firstHostPorts = await productionHostPorts(host, artifactRoot);
		const runner = createAutoResearchProductionRunner({
			host: firstHostPorts.hostPorts,
			authority: firstHostPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async (input) => {
				firstHostPorts.executionCalls.count += 1;
				firstHostPorts.executionCalls.sawHiddenInput = input.visibleInputDigests.some((digest) =>
					["holdout-input", "adversarial-input"].includes(digest),
				);
				const resultRef = await firstHostPorts.publish(
					canonicalJsonBytes({ kind: "approved-candidate-result", metricValue: -999, hiddenMetricValue: -999 }),
					`production:candidate:${input.task.taskId}`,
				);
				return { rawResultRefs: [resultRef] };
			},
		});
		const result = await runner.run(request);
		expect(result).toMatchObject({
			skill_id: "autoresearch",
			output_kind: "knowledge_proposal",
			can_authorize: false,
			transient_state_refs: [],
		});
		expect(result.evidence_refs.length).toBeGreaterThanOrEqual(3);
		expect(firstHostPorts.executionCalls).toEqual({ count: 1, sawHiddenInput: false });
		expect(firstHostPorts.measurementCalls).toEqual({
			count: 1,
			metricValue: 1,
			baselineMetricValue: 2,
			hiddenMetricValue: 1,
			adversarialMetricValue: 1,
		});
		await host.dispose?.();
		host = undefined;

		host = await openHost(artifactRoot);
		const secondHostPorts = await productionHostPorts(host, artifactRoot);
		const resumed = createAutoResearchProductionRunner({
			host: secondHostPorts.hostPorts,
			authority: secondHostPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				secondHostPorts.executionCalls.count += 1;
				throw new Error("replayed evaluation must not execute the candidate again");
			},
		});
		expect(await resumed.run(request)).toEqual(result);
		expect(secondHostPorts.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("rejects a forged worker artifact before host measurement or observation commit", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-forgery-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "b".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				productionIndependentPlan("observation-forged", {
					candidateId: "candidate-forged",
					attemptId: "attempt-forged",
					changeDigest: productionDigest("candidate-change-forged"),
					baseRevisionDigest: productionDigest("baseline"),
					resourceRequest: productionResource(),
					claimedCompletion: false,
					claimedPromotion: false,
				}),
			],
		} satisfies AutoResearchDurableRecipe;
		const ports = await productionHostPorts(host, artifactRoot, true);
		const forgedDigest = "f".repeat(64);
		const runner = createAutoResearchProductionRunner({
			host: ports.hostPorts,
			authority: ports.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				ports.executionCalls.count += 1;
				return {
					rawResultRefs: [
						{
							artifactId: `evidence:${forgedDigest}`,
							relativePath: `artifacts/evidence/${forgedDigest}`,
							digest: forgedDigest,
							sizeBytes: 1,
							sourceEventSequence: 1,
						},
					],
				};
			},
		});
		await expect(runner.run(request)).rejects.toThrow(/artifact|missing|measurement/i);
		expect(ports.executionCalls.count).toBe(1);
		expect(ports.measurementCalls.count).toBe(0);

		const adapter = createAutoResearchWorkflowRuntimeAdapter({
			runtimeStore: host.runtimeStore,
			artifactResolver: ports.resolver,
			workflowId: PRODUCTION_WORKFLOW_ID,
			runId: PRODUCTION_RUN_ID,
			executionKey: PRODUCTION_EXECUTION_KEY,
			writerIdentity: PRODUCTION_WRITER,
			resolveLeaseRef: () => readLease(artifactRoot, PRODUCTION_WORKFLOW_ID),
		});
		const eventKinds = (await adapter.replay()).map((record) => record.event.kind);
		expect(eventKinds).toContain("candidate_submitted");
		expect(eventKinds).not.toContain("observation_recorded");
		expect(eventKinds).not.toContain("accepted_proposal_committed");
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("rejects extra candidate plan authority before invoking the executor", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-plan-schema-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "d".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const candidatePlan = productionIndependentPlan("observation-extra-field", {
			candidateId: "candidate-extra-field",
			attemptId: "attempt-extra-field",
			changeDigest: productionDigest("candidate-change-extra-field"),
			baseRevisionDigest: productionDigest("baseline"),
			resourceRequest: productionResource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				{
					...candidatePlan,
					workerCommand: "arbitrary-code",
				},
			],
		} as unknown as AutoResearchDurableRecipe;
		const ports = await productionHostPorts(host, artifactRoot);
		const runner = createAutoResearchProductionRunner({
			host: ports.hostPorts,
			authority: ports.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				ports.executionCalls.count += 1;
				throw new Error("extra plan field must be rejected before execution");
			},
		});
		await expect(runner.run(request)).rejects.toThrow(/candidate_plan_invalid|recipe_invalid/);
		expect(ports.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("rejects parameter-hunting candidates even when relabeled and self-approved", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-parameter-hunting-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const request = {
			recipeDigest: "9".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const candidate = {
			candidateId: "candidate-retry-count-six",
			attemptId: "attempt-retry-count-six",
			changeDigest: productionDigest("retry-count-five-to-six"),
			baseRevisionDigest: productionDigest("retry-count-five"),
			resourceRequest: productionResource(),
			claimedCompletion: false,
			claimedPromotion: false,
		};
		const solutionFamily = "increase retry count";
		const mechanism = "increase retry count from five to six";
		const falsificationCondition = "a sixth retry does not improve the evaluator metric";
		const structuralChanges = ["change retry count from five to six"];
		const hypothesisWithoutDigest = {
			kind: "independent_solution" as const,
			solutionFamily,
			mechanism,
			falsificationCondition,
			expectedGeneralization: "more attempts may recover additional transient failures",
			structuralChanges,
			parameterChanges: [],
			solutionFamilyDigest: digestObject({ solutionFamily }),
			mechanismDigest: digestObject({ mechanism, structuralChanges }),
			falsificationDigest: digestObject({ falsificationCondition }),
			parameterOnly: false,
		};
		const hypothesis = {
			...hypothesisWithoutDigest,
			hypothesisDigest: autoResearchCandidateHypothesisDigest(hypothesisWithoutDigest),
		};
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration: productionRegistration(),
			candidates: [
				{
					observationId: "observation-retry-count-six",
					candidate,
					hypothesis,
				},
			],
		} as unknown as AutoResearchDurableRecipe;
		const ports = await productionHostPorts(host, artifactRoot);
		const runner = createAutoResearchProductionRunner({
			host: ports.hostPorts,
			authority: ports.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				ports.executionCalls.count += 1;
				throw new Error("parameter-only candidates must never reach execution");
			},
		});
		await expect(runner.run(request)).rejects.toThrow(/parameter_hunting_forbidden/);
		expect(ports.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("rejects repeated solution families before invoking the executor", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-repeated-family-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const request = {
			recipeDigest: "8".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const first = productionIndependentPlan("observation-retry-six", {
			candidateId: "candidate-retry-six",
			attemptId: "attempt-retry-six",
			changeDigest: productionDigest("retry-six"),
			baseRevisionDigest: productionDigest("retry-baseline"),
			resourceRequest: productionResource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		const secondBase = productionIndependentPlan("observation-retry-seven", {
			candidateId: "candidate-retry-seven",
			attemptId: "attempt-retry-seven",
			changeDigest: productionDigest("retry-seven"),
			baseRevisionDigest: productionDigest("retry-baseline"),
			resourceRequest: productionResource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		const secondHypothesisWithoutDigest = {
			kind: secondBase.hypothesis.kind,
			solutionFamily: first.hypothesis.solutionFamily,
			mechanism: secondBase.hypothesis.mechanism,
			falsificationCondition: secondBase.hypothesis.falsificationCondition,
			expectedGeneralization: secondBase.hypothesis.expectedGeneralization,
			structuralChanges: secondBase.hypothesis.structuralChanges,
			parameterChanges: secondBase.hypothesis.parameterChanges,
			solutionFamilyDigest: first.hypothesis.solutionFamilyDigest,
			mechanismDigest: secondBase.hypothesis.mechanismDigest,
			falsificationDigest: secondBase.hypothesis.falsificationDigest,
			parameterOnly: secondBase.hypothesis.parameterOnly,
		};
		const second = {
			...secondBase,
			hypothesis: {
				...secondHypothesisWithoutDigest,
				hypothesisDigest: autoResearchCandidateHypothesisDigest(secondHypothesisWithoutDigest),
			},
		};
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration: productionRegistration(),
			candidates: [first, second],
		} satisfies AutoResearchDurableRecipe;
		const ports = await productionHostPorts(host, artifactRoot);
		const runner = createAutoResearchProductionRunner({
			host: ports.hostPorts,
			authority: ports.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				ports.executionCalls.count += 1;
				throw new Error("same-family candidates must never reach execution");
			},
		});
		await expect(runner.run(request)).rejects.toThrow(/parameter_hunting_forbidden/);
		expect(ports.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("does not rerun a candidate after a persisted execution crash", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-execution-crash-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "e".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				productionIndependentPlan("observation-execution-crash", {
					candidateId: "candidate-execution-crash",
					attemptId: "attempt-execution-crash",
					changeDigest: productionDigest("candidate-change-execution-crash"),
					baseRevisionDigest: productionDigest("baseline"),
					resourceRequest: productionResource(),
					claimedCompletion: false,
					claimedPromotion: false,
				}),
			],
		} satisfies AutoResearchDurableRecipe;
		const firstPorts = await productionHostPorts(host, artifactRoot);
		const first = createAutoResearchProductionRunner({
			host: firstPorts.hostPorts,
			authority: firstPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async (input) => {
				firstPorts.executionCalls.count += 1;
				await firstPorts.publish(
					canonicalJsonBytes({ kind: "approved-candidate-result", crash: true }),
					`production:crashed-candidate:${input.task.taskId}`,
				);
				throw new Error("simulated_process_crash_before_observation");
			},
		});
		await expect(first.run(request)).rejects.toThrow(/simulated_process_crash/);
		await host.dispose?.();
		host = undefined;

		host = await openHost(artifactRoot);
		const secondPorts = await productionHostPorts(host, artifactRoot);
		const second = createAutoResearchProductionRunner({
			host: secondPorts.hostPorts,
			authority: secondPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				secondPorts.executionCalls.count += 1;
				throw new Error("replayed execution must fail closed");
			},
		});
		await expect(second.run(request)).rejects.toThrow(/execution_pending/);
		expect(firstPorts.executionCalls.count).toBe(1);
		expect(secondPorts.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("fails closed after a runner process dies with a committed execution intent", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-process-crash-"));
	const childCountPath = join(artifactRoot, "child-executor-count.txt");
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "7".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				productionIndependentPlan("observation-process-crash", {
					candidateId: "candidate-process-crash",
					attemptId: "attempt-process-crash",
					changeDigest: productionDigest("candidate-process-crash"),
					baseRevisionDigest: productionDigest("baseline"),
					resourceRequest: productionResource(),
					claimedCompletion: false,
					claimedPromotion: false,
				}),
			],
		} satisfies AutoResearchDurableRecipe;
		const setupPorts = await productionHostPorts(host, artifactRoot);
		const setupEngine = await createNativeExperimentEngine(setupPorts.hostPorts);
		await setupEngine.preRegister(recipe.registration);
		await setupEngine.lock();
		await setupEngine.submitCandidate(recipe.candidates[0]!.candidate);
		await host.execute({ kind: "pause", reason: "pause around process crash injection" });
		await host.dispose?.();
		host = undefined;

		const childScript = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPersistedSessionWorkflowHost } from "./src/core/workflow/session-host-factory.js";
import { emptyGoalState } from "./src/core/goals.js";
import { validateAutoResearchProjectionIntent, createAutoResearchWorkflowRuntimeAdapter } from "./src/core/autoresearch/runtime-adapter.js";
import { createAutoResearchProductionRunner } from "./src/core/autoresearch/runner.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./src/core/workflow/contracts.js";

const artifactRoot = ${JSON.stringify(artifactRoot)};
const workflowId = ${JSON.stringify(PRODUCTION_WORKFLOW_ID)};
const recipe = ${JSON.stringify(recipe)};
const request = ${JSON.stringify(request)};
const countPath = ${JSON.stringify(childCountPath)};
const projectionPath = join(artifactRoot, "goal-projection-" + workflowId + ".json");
const leasePath = join(artifactRoot, "workflows", workflowId, "append-lease.json");
const previousLeaseRecord = parseCanonicalJsonBytes(readFileSync(leasePath));
const previousLeaseRef = previousLeaseRecord.leaseRef;
let projection = existsSync(projectionPath) ? JSON.parse(readFileSync(projectionPath, "utf8")) : emptyGoalState();
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId: "autoresearch-runtime-session",
  workflowId,
  goalProjection: {
    read: () => structuredClone(projection),
    compareAndSwap: (expected, next) => {
      if (JSON.stringify(projection) !== JSON.stringify(expected)) return false;
      projection = structuredClone(next);
      writeFileSync(projectionPath, JSON.stringify(projection));
      return true;
    },
  },
  genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
  writerIdentity: previousLeaseRef.writerIdentity,
  processIdentity: previousLeaseRef.processIdentity,
  deferredOwnerValidators: {
    autoresearch: validateAutoResearchProjectionIntent,
    runtime: () => undefined,
    effect: () => undefined,
    recovery: () => undefined,
  },
  approvalSecretDelivery: () => undefined,
});
const leaseRecord = parseCanonicalJsonBytes(readFileSync(leasePath));
const leaseRef = leaseRecord.leaseRef;
const artifactResolver = {
  resolve: async (ref) => {
    const artifactPath = join(artifactRoot, "workflows", workflowId, ref.relativePath);
    const bytes = readFileSync(artifactPath);
    const metadata = parseCanonicalJsonBytes(readFileSync(artifactPath + ".metadata.json"));
    return {
      envelope: metadata,
      exists: true,
      bytes,
      verifiedDigest: sha256Hex(bytes),
      verifiedSizeBytes: bytes.byteLength,
    };
  },
};
const runtime = createAutoResearchWorkflowRuntimeAdapter({
  runtimeStore: host.runtimeStore,
  artifactResolver,
  workflowId,
  runId: ${JSON.stringify(PRODUCTION_RUN_ID)},
  executionKey: ${JSON.stringify(PRODUCTION_EXECUTION_KEY)},
  writerIdentity: ${JSON.stringify(PRODUCTION_WRITER)},
  resolveLeaseRef: async () => leaseRef,
});
const hostPorts = {
  submitTask: async (input) => ({
    taskId: input.candidateId,
    candidateId: input.candidateId,
    attemptId: input.attemptId,
    changeDigest: input.changeDigest,
    taskDigest: digestObject(input),
  }),
  submitEvidence: async () => { throw new Error("child evidence port must not run"); },
  submitDecision: async () => { throw new Error("child decision port must not run"); },
  resolveDecision: async () => { throw new Error("child resolver port must not run"); },
  submitProposal: async () => { throw new Error("child proposal port must not run"); },
  submitAcceptedProposal: async () => { throw new Error("child proposal port must not run"); },
  submitHoldout: async () => { throw new Error("child holdout port must not run"); },
  measureObservation: async () => { throw new Error("child measurement port must not run"); },
  runtime,
};
const authority = {
  runtimeStore: host.runtimeStore,
  artifactResolver,
  workflowId,
  executionKey: ${JSON.stringify(PRODUCTION_EXECUTION_KEY)},
  writerIdentity: ${JSON.stringify(PRODUCTION_WRITER)},
  resolveLeaseRef: async () => leaseRef,
  receiptContext: { receiptResolver: {}, keyResolver: {}, revokedReceiptIds: new Set(), artifactResolver },
};
const runner = createAutoResearchProductionRunner({
  host: hostPorts,
  authority,
  resolveRecipe: async () => recipe,
  executeCandidate: async (input) => {
    writeFileSync(countPath, "1");
    const replayed = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: 1 });
    await host.runtimeStore.publishArtifact({
      workflowId,
      payloadKind: "evidence",
      bytes: canonicalJsonBytes({ kind: "approved-candidate-result", process: true }),
      codec: "canonical_json",
      sourceEventSequence: Math.max(1, replayed.head.sequence),
      idempotencyKey: "production:process-crash:" + input.task.taskId,
    });
    throw new Error("simulated_process_crash");
  },
});
try {
  await runner.run(request);
  process.exit(98);
} catch (error) {
  if (!String(error).includes("simulated_process_crash")) process.exit(99);
  process.exit(17);
}
`;
		const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childScript], {
			cwd: process.cwd(),
		});
		const [code, signal] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
		if (code !== 17) throw new Error(`runner child exited with ${String(code)}`);
		expect(signal).toBeNull();
		expect(readFileSync(childCountPath, "utf8")).toBe("1");

		host = await openHost(artifactRoot);
		const resumedPorts = await productionHostPorts(host, artifactRoot);
		const resumed = createAutoResearchProductionRunner({
			host: resumedPorts.hostPorts,
			authority: resumedPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				resumedPorts.executionCalls.count += 1;
				throw new Error("replayed process execution must fail closed");
			},
		});
		await expect(resumed.run(request)).rejects.toThrow(/execution_pending/);
		expect(resumedPorts.executionCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);

it("rejects forged persisted raw results without invoking the executor", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "autoresearch-production-forged-pending-"));
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await openHost(artifactRoot);
		const registration = productionRegistration();
		const request = {
			recipeDigest: "f".repeat(64),
			evidenceRefs: [],
		} satisfies AutoResearchProductionRunRequest;
		const recipe = {
			recipeDigest: request.recipeDigest,
			registration,
			candidates: [
				productionIndependentPlan("observation-forged-pending", {
					candidateId: "candidate-forged-pending",
					attemptId: "attempt-forged-pending",
					changeDigest: productionDigest("candidate-change-forged-pending"),
					baseRevisionDigest: productionDigest("baseline"),
					resourceRequest: productionResource(),
					claimedCompletion: false,
					claimedPromotion: false,
				}),
			],
		} satisfies AutoResearchDurableRecipe;
		const firstPorts = await productionHostPorts(host, artifactRoot);
		const first = createAutoResearchProductionRunner({
			host: firstPorts.hostPorts,
			authority: firstPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				firstPorts.executionCalls.count += 1;
				throw new Error("simulated_crash_before_result_handoff");
			},
		});
		await expect(first.run(request)).rejects.toThrow(/simulated_crash_before_result_handoff/);
		const intentRecord = (await firstPorts.hostPorts.runtime.replay()).find(
			(record) => record.event.kind === "candidate_execution_intent",
		);
		if (intentRecord === undefined || intentRecord.event.kind !== "candidate_execution_intent")
			throw new Error("execution_intent_not_persisted");
		const forgedDigest = "0".repeat(64);
		const forgedRef: WorkflowArtifactRef = {
			artifactId: `evidence:${forgedDigest}`,
			relativePath: `artifacts/evidence/${forgedDigest}`,
			digest: forgedDigest,
			sizeBytes: 1,
			sourceEventSequence: 1,
		};
		await firstPorts.hostPorts.runtime.commit({
			event: {
				kind: "candidate_execution_completed",
				registrationDigest: intentRecord.event.registrationDigest,
				observationId: intentRecord.event.observationId,
				candidateRequest: intentRecord.event.candidateRequest,
				task: intentRecord.event.task,
				candidateBindingDigest: intentRecord.event.candidateBindingDigest,
				executionDigest: intentRecord.event.executionDigest,
				rawResultRefs: [forgedRef],
				rawResultRefsDigest: digestObject([forgedRef]),
			},
		});
		await host.dispose?.();
		host = undefined;

		host = await openHost(artifactRoot);
		const secondPorts = await productionHostPorts(host, artifactRoot);
		const second = createAutoResearchProductionRunner({
			host: secondPorts.hostPorts,
			authority: secondPorts.authority,
			resolveRecipe: async () => recipe,
			executeCandidate: async () => {
				secondPorts.executionCalls.count += 1;
				throw new Error("forged completion must fail before execution");
			},
		});
		await expect(second.run(request)).rejects.toThrow(/artifact|missing/);
		expect(firstPorts.executionCalls.count).toBe(1);
		expect(secondPorts.executionCalls.count).toBe(0);
		expect(secondPorts.measurementCalls.count).toBe(0);
	} finally {
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 120_000);
