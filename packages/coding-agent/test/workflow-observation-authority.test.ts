import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { emptyGoalState } from "../src/core/goals.js";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowLeaseRef,
	type WorkflowObservationDatasetCoverage,
	type WorkflowObservationDatasetLifecycle,
	type WorkflowObservationDatasetMetadata,
	type WorkflowReconciliationOutcome,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStore,
	type WorkflowStoreCommitResult,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	createWorkflowObservationAuthority,
	type WorkflowCompletionCutInput,
	type WorkflowObservationAuthority,
	type WorkflowObservationInput,
	workflowObservationDigest,
} from "../src/core/workflow/observation-authority.js";
import { createPersistedSessionWorkflowHost } from "../src/core/workflow/session-host-factory.js";

const GENESIS_EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const TEST_WRITER = "workflow-observation-test-writer";
const TEST_PROCESS = "workflow-observation-test-process";
const NOW = "2026-08-17T12:00:00.000Z";
const LATER = "2026-08-17T12:01:00.000Z";
const digest = (character: string): string => sha256Hex(character);

type ObservationHost = Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>>;
type Replay = Awaited<ReturnType<ObservationHost["runtimeStore"]["replay"]>>;
type ObservationOverrides = Partial<Omit<WorkflowObservationInput, "observationDigest">>;
type ObservationWithoutProcessReceipt = Omit<WorkflowObservationInput, "processReceipt">;

function createGoalProjection(): {
	read(): ReturnType<typeof emptyGoalState>;
	compareAndSwap(expected: ReturnType<typeof emptyGoalState>, next: ReturnType<typeof emptyGoalState>): boolean;
} {
	let goal = emptyGoalState();
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

async function openHost(artifactRoot: string, rootSessionId: string, workflowId: string): Promise<ObservationHost> {
	return createPersistedSessionWorkflowHost({
		artifactRoot,
		rootSessionId,
		workflowId,
		goalProjection: createGoalProjection(),
		genesisEpoch: GENESIS_EPOCH,
		writerIdentity: TEST_WRITER,
		processIdentity: TEST_PROCESS,
		now: () => NOW,
	});
}

async function replayFor(host: ObservationHost, workflowId: string): Promise<Replay> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("durable workflow runtime unavailable");
	return host.runtimeStore.replay({
		workflowId,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
}

function leaseFor(host: ObservationHost): WorkflowLeaseRef {
	const lease = host.runtimeStore.durableContext?.currentLeaseRef();
	if (lease === undefined) throw new Error("workflow lease unavailable");
	return lease;
}

function processResourceDigest(observation: ObservationWithoutProcessReceipt): string {
	return digestObject({
		workflowId: observation.workflowId,
		taskId: observation.taskId,
		attemptId: observation.attemptId,
		effectIdempotencyKey: observation.effectIdempotencyKey,
	});
}

function processOperationDigest(observation: ObservationWithoutProcessReceipt): string {
	return digestObject({
		observationId: observation.observationId,
		observationDigest: observation.observationDigest,
		baseRevisionDigest: observation.baseRevisionDigest,
		processGeneration: observation.processGeneration,
		coordinatorTerm: observation.coordinatorTerm,
		kind: observation.kind,
		evidenceRefs: observation.evidenceRefs,
		expectedHead: observation.expectedHead,
		epochRef: observation.epochRef,
		leaseRef: observation.leaseRef,
		decisionRef: observation.decisionRef ?? null,
		datasetMetadata: observation.datasetMetadata ?? null,
	});
}

function processBindingDigest(observation: ObservationWithoutProcessReceipt, sessionId: string): string {
	return digestObject({
		capability: "workflow_observation_process",
		workflowId: observation.workflowId,
		resourceDigest: processResourceDigest(observation),
		operationDigest: processOperationDigest(observation),
		stateDigest: observation.expectedHead.eventDigest,
		revision: observation.expectedHead.sequence,
		epochRef: observation.epochRef,
		executionIdentity: observation.processGeneration,
		sessionId,
	});
}

function processReceiptFor(
	observation: ObservationWithoutProcessReceipt,
	sessionId: string,
	options: { resourceDigest?: string; executionIdentity?: string } = {},
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: `${observation.observationId}-process-receipt`,
		issuerId: "fixture-host",
		workflowId: observation.workflowId,
		bindingDigest: processBindingDigest(observation, sessionId),
		payloadDigest: digestObject({
			observationDigest: observation.observationDigest,
			processGeneration: observation.processGeneration,
		}),
		artifactRef: artifactRef(`${observation.observationId}-process-receipt`, observation.expectedHead.sequence),
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "fixture-receipt-key",
		stateDigest: observation.expectedHead.eventDigest ?? digest("missing"),
		revision: observation.expectedHead.sequence,
		oneUse: true,
		capabilityBinding: {
			capability: "workflow_observation_process",
			resourceDigest: options.resourceDigest ?? processResourceDigest(observation),
			operationDigest: processOperationDigest(observation),
			executionIdentity: options.executionIdentity ?? observation.processGeneration,
			sessionId,
		},
	});
}

function requestFor(
	workflowId: string,
	replay: Replay,
	lease: WorkflowLeaseRef,
	observationId: string,
	overrides: ObservationOverrides = {},
): WorkflowObservationInput {
	if (replay.head.eventDigest === null) throw new Error("workflow observation requires a non-genesis head");
	const base: Omit<WorkflowObservationInput, "observationDigest" | "processReceipt"> = {
		observationId,
		baseRevisionDigest: replay.head.eventDigest,
		processGeneration: lease.processIdentity,
		coordinatorTerm: replay.head.epochRef.coordinatorEpoch,
		effectIdempotencyKey: `effect-${observationId}`,
		workflowId,
		taskId: `task-${observationId}`,
		attemptId: `attempt-${observationId}`,
		kind: "task_result",
		evidenceRefs: [],
		expectedHead: replay.head,
		epochRef: replay.head.epochRef,
		leaseRef: lease,
	};
	const requestWithoutReceipt = { ...base, ...overrides };
	const observationDigest = workflowObservationDigest(requestWithoutReceipt);
	const request = {
		...requestWithoutReceipt,
		processReceipt:
			requestWithoutReceipt.processReceipt ??
			processReceiptFor({ ...requestWithoutReceipt, observationDigest }, `${workflowId}-session`),
		observationDigest,
	};
	return request;
}

function createAuthority(
	host: ObservationHost,
	workflowId: string,
	options: {
		receiptContext?: WorkflowHostReceiptConsumerContext;
		crash?: Parameters<typeof createWorkflowObservationAuthority>[0]["crash"];
		latePolicy?: Parameters<typeof createWorkflowObservationAuthority>[0]["latePolicy"];
	} = {},
): WorkflowObservationAuthority {
	const lease = leaseFor(host);
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("durable workflow runtime unavailable");
	const receiptContext = options.receiptContext ?? createFixtureHostReceiptConsumerContext();
	return createWorkflowObservationAuthority({
		runtimeStore: host.runtimeStore,
		workflowId,
		sessionId: `${workflowId}-session`,
		writerIdentity: lease.writerIdentity,
		epochRef: durable.epochRef,
		leaseRef: lease,
		processGeneration: lease.processIdentity,
		coordinatorTerm: durable.epochRef.coordinatorEpoch,
		receiptContext,
		now: () => NOW,
		crash: options.crash,
		latePolicy: options.latePolicy,
	});
}

async function appendRuntimePayload<TPayload extends WorkflowRuntimeEventPayload>(
	store: WorkflowRuntimeStore,
	payload: TPayload,
	idempotencyKey: string,
): Promise<WorkflowStoreCommitResult<TPayload>> {
	const durable = store.durableContext;
	if (durable === undefined) throw new Error("durable workflow runtime unavailable");
	const replay = await store.replay({
		workflowId: store.identity.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	const lease = durable.currentLeaseRef();
	const baselineDigest = digestObject(replay.head);
	return store.commit({
		workflowId: store.identity.workflowId,
		payload,
		expectedHead: replay.head,
		epochRef: replay.head.epochRef,
		leaseRef: lease,
		idempotencyKey,
		writerIdentity: lease.writerIdentity,
		executionKey: null,
		semanticBinding: {
			mutationId: idempotencyKey,
			baselineDigest,
			expectedGenerations: { workflow: replay.head.epochRef.storeEpoch },
			ownerId: lease.writerIdentity,
			phase: "recovering",
			reducerDigest: digestObject(payload),
			semanticHead: {
				workflowId: store.identity.workflowId,
				sequence: replay.head.sequence,
				eventDigest: replay.head.eventDigest,
				stateDigest: baselineDigest,
				epochRef: replay.head.epochRef,
				generation: replay.head.epochRef.storeEpoch,
			},
			expectedHead: replay.head,
			idempotencyKey,
			executionKey: null,
			writerIdentity: lease.writerIdentity,
			leaseRef: lease,
			epochRef: replay.head.epochRef,
		},
	});
}

async function appendRecoveryReconciliation(store: WorkflowRuntimeStore): Promise<void> {
	const replay = await store.replay({
		workflowId: store.identity.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: store.durableContext?.epochRef.storeEpoch ?? 1,
	});
	const lease = store.durableContext?.currentLeaseRef();
	if (lease === undefined || replay.head.eventDigest === null) throw new Error("recovery event requires a live head");
	const outcome: WorkflowReconciliationOutcome = {
		workflowId: store.identity.workflowId,
		reconciliationAttemptId: "real-recovery-attempt",
		taskId: "recovery-task",
		attemptId: "recovery-attempt",
		disposition: "proven_not_executed",
		persistedChildIdentity: null,
		observedChildIdentity: null,
		observedProcessGroupId: null,
		observedTranscriptDigest: null,
		observedWorkspaceDigest: digest("r"),
		epochRef: replay.head.epochRef,
		evidenceRefs: [],
		stateDigest: digest("s"),
	};
	await appendRuntimePayload(
		store,
		{
			kind: "workflow_reconciliation_recorded",
			workflowId: store.identity.workflowId,
			attemptId: outcome.attemptId,
			epochRef: replay.head.epochRef,
			outcome,
			outcomeDigest: digestObject(outcome),
		},
		"real-recovery-reconciliation",
	);
}

function artifactRef(artifactId: string, sourceEventSequence = 0): WorkflowArtifactRef {
	const bytes = new TextEncoder().encode(`artifact:${artifactId}`);
	return {
		artifactId,
		relativePath: `evidence/${artifactId}.json`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence,
	};
}

function datasetBindingDigest(
	workflowId: string,
	observationId: string,
	metadata: WorkflowObservationDatasetMetadata,
): string {
	return digestObject({
		workflowId,
		observationId,
		split: metadata.split,
		modality: metadata.modality,
		instrumentSet: metadata.instrumentSet,
		sourceTimeStart: metadata.sourceTimeStart,
		sourceTimeEnd: metadata.sourceTimeEnd,
		objectUri: metadata.objectUri,
		generation: metadata.generation,
		sha256: metadata.sha256,
		bytes: metadata.bytes,
		schemaVersion: metadata.schemaVersion,
		validationResult: metadata.validationResult,
		coverage: metadata.coverage,
		gapClassification: metadata.gapClassification,
		gapEvidenceRefs: metadata.gapEvidenceRefs,
		sourceEmptyEvidenceRefs: metadata.sourceEmptyEvidenceRefs,
		lifecycle: metadata.lifecycle,
		lifecycleTargetObservationId: metadata.lifecycleTargetObservationId,
		restoreVerification: metadata.restoreVerification,
		provenance: metadata.provenance,
		closureRootDigest: metadata.closureRootDigest,
		accessAuthority: metadata.accessAuthority,
		holdoutAggregate: metadata.holdoutAggregate
			? {
					aggregateDigest: metadata.holdoutAggregate.aggregateDigest,
					artifactRef: metadata.holdoutAggregate.artifactRef,
				}
			: null,
	});
}

function aggregateBindingDigest(
	workflowId: string,
	observationId: string,
	aggregate: { aggregateDigest: string; artifactRef: WorkflowArtifactRef },
): string {
	return digestObject({
		workflowId,
		observationId,
		aggregateDigest: aggregate.aggregateDigest,
		artifactRef: aggregate.artifactRef,
	});
}

function datasetResourceDigest(metadata: WorkflowObservationDatasetMetadata): string {
	return digestObject({
		split: metadata.split,
		modality: metadata.modality,
		instrumentSet: metadata.instrumentSet,
		objectUri: metadata.objectUri,
		generation: metadata.generation,
		sha256: metadata.sha256,
		bytes: metadata.bytes,
		schemaVersion: metadata.schemaVersion,
	});
}

function datasetOperationDigest(
	workflowId: string,
	observationId: string,
	metadata: WorkflowObservationDatasetMetadata,
): string {
	return digestObject({
		workflowId,
		observationId,
		closureRootDigest: metadata.closureRootDigest,
		coverage: metadata.coverage,
		lifecycle: metadata.lifecycle,
	});
}

function aggregateResourceDigest(aggregateDigest: string): string {
	return aggregateDigest;
}

function aggregateOperationDigest(
	workflowId: string,
	observationId: string,
	aggregate: { aggregateDigest: string; artifactRef: WorkflowArtifactRef },
): string {
	return digestObject({
		workflowId,
		observationId,
		aggregateDigest: aggregate.aggregateDigest,
		artifactRef: aggregate.artifactRef,
	});
}

function datasetMetadata(
	workflowId: string,
	observationId: string,
	replay: Replay,
	options: {
		split?: "training" | "validation" | "holdout";
		coverage?: WorkflowObservationDatasetCoverage;
		lifecycle?: WorkflowObservationDatasetLifecycle;
		lifecycleTargetObservationId?: string | null;
		closureRootDigest?: string;
		modality?: "time_series" | "order_book" | "position_book" | "pricing_stream";
		bookGrid?: boolean;
	} = {},
): WorkflowObservationDatasetMetadata {
	if (replay.head.eventDigest === null) throw new Error("dataset receipt requires a non-genesis head");
	const split = options.split ?? "training";
	const coverage = options.coverage ?? "complete";
	const lifecycle = options.lifecycle ?? "sealed";
	const sourceRef = artifactRef(`${observationId}-receipt`, replay.head.sequence);
	const aggregateRef = artifactRef(`${observationId}-aggregate`, replay.head.sequence);
	const provenanceReceiptDigest = digest("p");
	const aggregateDigest = digest("g");
	const sourceTimeStart = options.bookGrid === false ? "2026-08-17T00:01:00.000Z" : "2026-08-17T00:00:00.000Z";
	const sourceTimeEnd = options.bookGrid === false ? "2026-08-17T00:21:00.000Z" : "2026-08-17T00:20:00.000Z";
	const gapClassification = coverage === "complete" ? "none" : coverage;
	const metadataWithoutReceipt: WorkflowObservationDatasetMetadata = {
		split,
		modality: options.modality ?? "time_series",
		instrumentSet: ["instrument-a", "instrument-b"],
		sourceTimeStart,
		sourceTimeEnd,
		schemaVersion: "dataset-v1",
		objectUri: `object://dataset/${observationId}`,
		generation: 1,
		sha256: digest("d"),
		bytes: 128,
		validationResult: coverage === "unknown" || coverage === "missing" ? "unknown" : "passed",
		coverage,
		gapClassification,
		gapEvidenceRefs: coverage === "partial_coverage" ? [sourceRef] : [],
		sourceEmptyEvidenceRefs: coverage === "provider_empty" ? [sourceRef] : [],
		lifecycle,
		lifecycleTargetObservationId: options.lifecycleTargetObservationId ?? null,
		restoreVerification: {
			locked: true,
			independentlyRestored: lifecycle === "sealed",
			independentlyRehashed: lifecycle === "sealed",
			verificationEvidenceDigest: lifecycle === "sealed" ? digest("v") : null,
		},
		provenance: {
			sourceSystem: "test-source",
			sourceDataset: "test-dataset",
			ingestDigest: digest("i"),
			lineageDigest: digest("l"),
			provenanceReceiptDigest,
		},
		closureRootDigest:
			options.closureRootDigest ?? digest(split === "training" ? "t" : split === "validation" ? "v" : "h"),
		accessAuthority:
			split === "training"
				? "training_workers_training_only"
				: split === "validation"
					? "validation_evaluator_host_only"
					: "holdout_host_aggregate_only",
		hostReceipt: createFixtureHostReceipt({
			receiptKind: "capability",
			receiptId: `${observationId}-provenance-receipt`,
			issuerId: "fixture-host",
			workflowId,
			bindingDigest: digest("0"),
			payloadDigest: provenanceReceiptDigest,
			artifactRef: sourceRef,
			issuedAt: NOW,
			validUntil: LATER,
			keyId: "fixture-receipt-key",
			stateDigest: replay.head.eventDigest,
			revision: replay.head.sequence,
			oneUse: true,
			capabilityBinding: {
				capability: "workflow_observation_dataset_receipt",
				resourceDigest: digest("dataset-resource"),
				operationDigest: digest("dataset-operation"),
				executionIdentity: TEST_PROCESS,
				sessionId: `${workflowId}-session`,
			},
		}),
		holdoutAggregate: null,
	};
	let metadata: WorkflowObservationDatasetMetadata = metadataWithoutReceipt;
	metadata = {
		...metadata,
		gapEvidenceRefs: coverage === "partial_coverage" ? [metadata.hostReceipt.artifactRef] : [],
		sourceEmptyEvidenceRefs: coverage === "provider_empty" ? [metadata.hostReceipt.artifactRef] : [],
	};
	if (split === "holdout") {
		const aggregateReceipt = createFixtureHostReceipt({
			receiptKind: "capability",
			receiptId: `${observationId}-aggregate-receipt`,
			issuerId: "fixture-host",
			workflowId,
			bindingDigest: digest("0"),
			payloadDigest: aggregateDigest,
			artifactRef: aggregateRef,
			issuedAt: NOW,
			validUntil: LATER,
			keyId: "fixture-receipt-key",
			stateDigest: replay.head.eventDigest,
			revision: replay.head.sequence,
			oneUse: true,
			capabilityBinding: {
				capability: "workflow_observation_dataset_receipt",
				resourceDigest: aggregateDigest,
				operationDigest: digest("aggregate-operation"),
				executionIdentity: TEST_PROCESS,
				sessionId: `${workflowId}-session`,
			},
		});
		const aggregateWithoutReceipt = {
			aggregateDigest,
			artifactRef: aggregateReceipt.artifactRef,
			receipt: aggregateReceipt,
		};
		metadata = {
			...metadata,
			holdoutAggregate: {
				...aggregateWithoutReceipt,
				receipt: createFixtureHostReceipt({
					...aggregateReceipt,
					bindingDigest: aggregateBindingDigest(workflowId, observationId, aggregateWithoutReceipt),
					capabilityBinding: {
						capability: "workflow_observation_dataset_receipt",
						resourceDigest: aggregateResourceDigest(aggregateWithoutReceipt.aggregateDigest),
						operationDigest: aggregateOperationDigest(workflowId, observationId, aggregateWithoutReceipt),
						executionIdentity: TEST_PROCESS,
						sessionId: `${workflowId}-session`,
					},
				}),
			},
		};
	}
	const boundReceipt = createFixtureHostReceipt({
		...metadata.hostReceipt,
		bindingDigest: datasetBindingDigest(workflowId, observationId, metadata),
		capabilityBinding: {
			capability: "workflow_observation_dataset_receipt",
			resourceDigest: datasetResourceDigest(metadata),
			operationDigest: datasetOperationDigest(workflowId, observationId, metadata),
			executionIdentity: TEST_PROCESS,
			sessionId: `${workflowId}-session`,
		},
	});
	return {
		...metadata,
		hostReceipt: boundReceipt,
	};
}

function requestWithDataset(
	workflowId: string,
	replay: Replay,
	lease: WorkflowLeaseRef,
	observationId: string,
	metadata: WorkflowObservationDatasetMetadata,
): WorkflowObservationInput {
	return requestFor(workflowId, replay, lease, observationId, { kind: "dataset", datasetMetadata: metadata });
}

function completionCutInput(
	replay: Replay,
	lease: WorkflowLeaseRef,
	finalClosureObservationId: string,
	roots: { training: string; validation: string; holdout: string },
	cutId = "completion-cut-1",
): WorkflowCompletionCutInput {
	const inputWithoutReceipt = {
		cutId,
		finalClosureObservationId,
		trainingClosureRootDigest: roots.training,
		validationClosureRootDigest: roots.validation,
		holdoutClosureRootDigest: roots.holdout,
		expectedHead: replay.head,
		epochRef: replay.head.epochRef,
		leaseRef: lease,
		processGeneration: lease.processIdentity,
		coordinatorTerm: replay.head.epochRef.coordinatorEpoch,
	};
	const resourceDigest = digestObject({
		workflowId: replay.head.workflowId,
		trainingClosureRootDigest: roots.training,
		validationClosureRootDigest: roots.validation,
		holdoutClosureRootDigest: roots.holdout,
	});
	const operationDigest = digestObject({
		cutId,
		finalClosureObservationId,
		trainingClosureRootDigest: roots.training,
		validationClosureRootDigest: roots.validation,
		holdoutClosureRootDigest: roots.holdout,
	});
	const bindingDigest = digestObject({
		capability: "workflow_observation_dataset_receipt",
		workflowId: replay.head.workflowId,
		resourceDigest,
		operationDigest,
		stateDigest: replay.head.eventDigest,
		revision: replay.head.sequence,
		epochRef: replay.head.epochRef,
		executionIdentity: lease.processIdentity,
		sessionId: `${replay.head.workflowId}-session`,
	});
	return {
		...inputWithoutReceipt,
		closureReceipt: createFixtureHostReceipt({
			receiptKind: "capability",
			receiptId: `${cutId}-closure-receipt`,
			issuerId: "fixture-host",
			workflowId: replay.head.workflowId,
			bindingDigest,
			payloadDigest: digestObject({ finalClosureObservationId, roots }),
			artifactRef: artifactRef(`${cutId}-closure-receipt`, replay.head.sequence),
			issuedAt: NOW,
			validUntil: LATER,
			keyId: "fixture-receipt-key",
			stateDigest: replay.head.eventDigest ?? digest("missing"),
			revision: replay.head.sequence,
			oneUse: true,
			capabilityBinding: {
				capability: "workflow_observation_dataset_receipt",
				resourceDigest,
				operationDigest,
				executionIdentity: lease.processIdentity,
				sessionId: `${replay.head.workflowId}-session`,
			},
		}),
	};
}

it("uses dedicated observation events, coexists with recovery, and repairs across durable reopen", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-observation-authority-events-"));
	const workflowId = "observation-authority-events";
	const rootSessionId = "observation-authority-events-session";
	let first: ObservationHost | undefined;
	let second: ObservationHost | undefined;
	try {
		first = await openHost(artifactRoot, rootSessionId, workflowId);
		await first.execute({ kind: "start", request: { workflowId, objective: "record observations" } });
		await appendRecoveryReconciliation(first.runtimeStore);
		const replay = await replayFor(first, workflowId);
		const lease = leaseFor(first);
		const request = requestFor(workflowId, replay, lease, "crash-before-outcome");
		const crashing = createAuthority(first, workflowId, {
			crash: (checkpoint) => {
				if (checkpoint === "before_outcome_commit") throw new Error("simulated-before-outcome-crash");
			},
		});
		await expect(crashing.processObservation(request)).rejects.toThrow("simulated-before-outcome-crash");
		const beforeReopen = await replayFor(first, workflowId);
		expect(beforeReopen.events.some((event) => event.payload.kind === "workflow_observation_outcome_recorded")).toBe(
			false,
		);
		if (first === undefined) throw new Error("first host unavailable");
		await first.dispose?.();
		first = undefined;
		second = await openHost(artifactRoot, rootSessionId, workflowId);
		const repaired = createAuthority(second, workflowId);
		const result = await repaired.processObservation(request);
		expect(result.status).toBe("applied");
		expect(result.causalWatermark.sequence).toBe(result.journalSequence);
		expect(result.causalWatermark.eventDigest).toMatch(/^[0-9a-f]{64}$/u);
		const retry = await repaired.processObservation(request);
		expect(retry.outcomeDigest).toBe(result.outcomeDigest);
		await expect(repaired.processObservation({ ...request, kind: "evidence" })).rejects.toThrow(
			"workflow_observation_idempotency_conflict",
		);

		const afterApplied = await replayFor(second, workflowId);
		const postCommitRequest = requestFor(workflowId, afterApplied, leaseFor(second), "crash-after-outcome");
		const crashAfterCommit = createAuthority(second, workflowId, {
			crash: (checkpoint) => {
				if (checkpoint === "after_outcome_commit_before_return") throw new Error("simulated-after-outcome-crash");
			},
		});
		await expect(crashAfterCommit.processObservation(postCommitRequest)).rejects.toThrow(
			"simulated-after-outcome-crash",
		);
		if (second === undefined) throw new Error("second host unavailable");
		await second.dispose?.();
		second = undefined;
		second = await openHost(artifactRoot, rootSessionId, workflowId);
		const repairedAfterCommit = createAuthority(second, workflowId);
		expect((await repairedAfterCommit.processObservation(postCommitRequest)).status).toBe("applied");
		const finalReplay = await replayFor(second, workflowId);
		expect(
			finalReplay.events.filter((event) => event.payload.kind === "workflow_reconciliation_recorded"),
		).toHaveLength(1);
		expect(
			finalReplay.events.filter((event) => event.payload.kind === "workflow_observation_outcome_recorded"),
		).toHaveLength(2);
		expect(finalReplay.events.some((event) => event.idempotencyKey === "real-recovery-reconciliation")).toBe(true);
		expect(
			finalReplay.events.some(
				(event) => event.idempotencyKey === "workflow-observation-outcome:crash-before-outcome",
			),
		).toBe(true);
	} finally {
		await second?.dispose?.().catch(() => undefined);
		await first?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("records stale, forged, base-bound, digest-conflicting, and duplicate-key inputs without authority effects", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-observation-authority-fences-"));
	const workflowId = "observation-authority-fences";
	const rootSessionId = "observation-authority-fences-session";
	let host: ObservationHost | undefined;
	try {
		host = await openHost(artifactRoot, rootSessionId, workflowId);
		await host.execute({ kind: "start", request: { workflowId, objective: "fence observations" } });
		const initialReplay = await replayFor(host, workflowId);
		const initialLease = leaseFor(host);
		const authority = createAuthority(host, workflowId);
		const stale = requestFor(workflowId, initialReplay, initialLease, "stale-process", {
			processGeneration: "old-process-generation",
		});
		expect((await authority.processObservation(stale)).status).toBe("stale");
		const currentReplay = await replayFor(host, workflowId);
		const currentLease = leaseFor(host);
		const forged = requestFor("forged-workflow", currentReplay, currentLease, "forged-workflow-observation");
		expect((await authority.processObservation(forged)).status).toBe("rejected");
		const staleHead = requestFor(workflowId, initialReplay, currentLease, "stale-head");
		expect((await authority.processObservation(staleHead)).status).toBe("stale");
		const invalidBase = requestFor(workflowId, await replayFor(host, workflowId), currentLease, "invalid-base", {
			baseRevisionDigest: digest("b"),
		});
		expect((await authority.processObservation(invalidBase)).status).toBe("rejected");
		const appliedRequest = requestFor(
			workflowId,
			await replayFor(host, workflowId),
			currentLease,
			"applied-observation",
		);
		expect((await authority.processObservation(appliedRequest)).status).toBe("applied");
		const changedDigest = { ...appliedRequest, evidenceRefs: [artifactRef("changed-evidence")] };
		const changedDigestRequest = { ...changedDigest, observationDigest: workflowObservationDigest(changedDigest) };
		await expect(authority.processObservation(changedDigestRequest)).rejects.toThrow(
			"workflow_observation_idempotency_conflict",
		);
		const duplicateKey = requestFor(workflowId, await replayFor(host, workflowId), currentLease, "duplicate-effect", {
			effectIdempotencyKey: appliedRequest.effectIdempotencyKey,
		});
		expect((await authority.processObservation(duplicateKey)).status).toBe("rejected");
		expect(await authority.readWatermark()).toBeNull();
	} finally {
		await host?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("requires verified receipts and closed dataset metadata, including every gap class and holdout aggregate safety", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-observation-authority-metadata-"));
	const workflowId = "observation-authority-metadata";
	const rootSessionId = "observation-authority-metadata-session";
	let host: ObservationHost | undefined;
	try {
		host = await openHost(artifactRoot, rootSessionId, workflowId);
		await host.execute({ kind: "start", request: { workflowId, objective: "validate dataset observations" } });
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const authority = createAuthority(host, workflowId, { receiptContext });
		for (const [index, coverage] of (
			["complete", "provider_empty", "partial_coverage", "unknown", "missing"] as const
		).entries()) {
			const replay = await replayFor(host, workflowId);
			const lease = leaseFor(host);
			const observationId = `coverage-${coverage}`;
			const metadata = datasetMetadata(workflowId, observationId, replay, {
				coverage,
				lifecycle: "in_progress",
				modality: index === 0 ? "order_book" : "time_series",
			});
			const coverageResult = await authority.processObservation(
				requestWithDataset(workflowId, replay, lease, observationId, metadata),
			);
			expect(coverageResult.status).toBe("applied");
		}
		expect(await authority.readWatermark()).toBeNull();
		const providerEmptySealedReplay = await replayFor(host, workflowId);
		const providerEmptySealedLease = leaseFor(host);
		const providerEmptySealedId = "provider-empty-sealed";
		const providerEmptySealedMetadata = datasetMetadata(
			workflowId,
			providerEmptySealedId,
			providerEmptySealedReplay,
			{
				split: "training",
				coverage: "provider_empty",
				lifecycle: "sealed",
			},
		);
		expect(
			(
				await authority.processObservation(
					requestWithDataset(
						workflowId,
						providerEmptySealedReplay,
						providerEmptySealedLease,
						providerEmptySealedId,
						providerEmptySealedMetadata,
					),
				)
			).status,
		).toBe("applied");
		const incompleteCutReplay = await replayFor(host, workflowId);
		const incompleteCut = await authority.sealCompletionCut(
			completionCutInput(incompleteCutReplay, leaseFor(host), providerEmptySealedId, {
				training: providerEmptySealedMetadata.closureRootDigest,
				validation: digest("v"),
				holdout: digest("h"),
			}),
		);
		expect(incompleteCut.status).toBe("rejected");
		const invalidGridReplay = await replayFor(host, workflowId);
		const invalidGridLease = leaseFor(host);
		const invalidGridId = "invalid-book-grid";
		const invalidGridMetadata = datasetMetadata(workflowId, invalidGridId, invalidGridReplay, {
			modality: "order_book",
			bookGrid: false,
		});
		expect(
			(
				await authority.processObservation(
					requestWithDataset(workflowId, invalidGridReplay, invalidGridLease, invalidGridId, invalidGridMetadata),
				)
			).status,
		).toBe("rejected");

		const forgedReceiptReplay = await replayFor(host, workflowId);
		const forgedReceiptLease = leaseFor(host);
		const forgedReceiptId = "forged-receipt";
		const validMetadata = datasetMetadata(workflowId, forgedReceiptId, forgedReceiptReplay, {
			lifecycle: "in_progress",
		});
		const forgedMetadata: WorkflowObservationDatasetMetadata = {
			...validMetadata,
			hostReceipt: { ...validMetadata.hostReceipt, bindingDigest: digest("f") },
		};
		expect(
			(
				await authority.processObservation(
					requestWithDataset(workflowId, forgedReceiptReplay, forgedReceiptLease, forgedReceiptId, forgedMetadata),
				)
			).status,
		).toBe("rejected");

		const hiddenHoldoutReplay = await replayFor(host, workflowId);
		const hiddenHoldoutLease = leaseFor(host);
		const hiddenHoldoutId = "hidden-holdout-rows";
		const holdoutMetadata = datasetMetadata(workflowId, hiddenHoldoutId, hiddenHoldoutReplay, {
			split: "holdout",
			lifecycle: "in_progress",
		});
		const hiddenRows = {
			...holdoutMetadata,
			rows: [{ caseId: "secret" }],
		} as unknown as WorkflowObservationDatasetMetadata;
		expect(
			(
				await authority.processObservation(
					requestWithDataset(workflowId, hiddenHoldoutReplay, hiddenHoldoutLease, hiddenHoldoutId, hiddenRows),
				)
			).status,
		).toBe("rejected");
	} finally {
		await host?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);

it("seals a split-root completion cut, records lifecycle targets, and persists late policy after reopen", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-observation-authority-cut-"));
	const workflowId = "observation-authority-cut";
	const rootSessionId = "observation-authority-cut-session";
	let first: ObservationHost | undefined;
	let second: ObservationHost | undefined;
	try {
		first = await openHost(artifactRoot, rootSessionId, workflowId);
		await first.execute({ kind: "start", request: { workflowId, objective: "seal verified closure" } });
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const authority = createAuthority(first, workflowId, {
			receiptContext,
			latePolicy: ({ observationId }) => (observationId === "late-reopen" ? "reopen" : "compensate"),
		});
		const initialIds: Record<"training" | "validation" | "holdout", string> = {
			training: "training-initial",
			validation: "validation-initial",
			holdout: "holdout-initial",
		};
		for (const split of ["training", "validation", "holdout"] as const) {
			const replay = await replayFor(first, workflowId);
			const lease = leaseFor(first);
			const metadata = datasetMetadata(workflowId, initialIds[split], replay, { split, lifecycle: "sealed" });
			const initialResult = await authority.processObservation(
				requestWithDataset(workflowId, replay, lease, initialIds[split], metadata),
			);
			expect(initialResult.status).toBe("applied");
		}
		const supersededReplay = await replayFor(first, workflowId);
		const supersededLease = leaseFor(first);
		const supersededId = "training-superseded";
		const supersededMetadata = datasetMetadata(workflowId, supersededId, supersededReplay, {
			split: "training",
			lifecycle: "superseded",
			lifecycleTargetObservationId: initialIds.training,
			closureRootDigest: digest("s"),
		});
		expect(
			(
				await authority.processObservation(
					requestWithDataset(workflowId, supersededReplay, supersededLease, supersededId, supersededMetadata),
				)
			).status,
		).toBe("applied");
		const quarantinedReplay = await replayFor(first, workflowId);
		const quarantinedLease = leaseFor(first);
		const quarantinedId = "validation-quarantined";
		const quarantinedMetadata = datasetMetadata(workflowId, quarantinedId, quarantinedReplay, {
			split: "validation",
			lifecycle: "quarantined",
			lifecycleTargetObservationId: initialIds.validation,
			closureRootDigest: digest("q"),
		});
		expect(
			(
				await authority.processObservation(
					requestWithDataset(workflowId, quarantinedReplay, quarantinedLease, quarantinedId, quarantinedMetadata),
				)
			).status,
		).toBe("applied");
		const replacementIds: Record<"training" | "validation" | "holdout", string> = {
			training: "training-final",
			validation: "validation-final",
			holdout: "holdout-final",
		};
		const roots = { training: digest("x"), validation: digest("y"), holdout: digest("z") };
		for (const split of ["training", "validation", "holdout"] as const) {
			const replay = await replayFor(first, workflowId);
			const lease = leaseFor(first);
			const metadata = datasetMetadata(workflowId, replacementIds[split], replay, {
				split,
				lifecycle: "sealed",
				closureRootDigest: roots[split],
			});
			expect(
				(
					await authority.processObservation(
						requestWithDataset(workflowId, replay, lease, replacementIds[split], metadata),
					)
				).status,
			).toBe("applied");
		}
		const cutReplay = await replayFor(first, workflowId);
		const cutLease = leaseFor(first);
		const cut = completionCutInput(cutReplay, cutLease, replacementIds.holdout, roots);
		const wrongRoots = await authority.sealCompletionCut({ ...cut, trainingClosureRootDigest: digest("w") });
		expect(wrongRoots.status).toBe("rejected");
		const sealed = await authority.sealCompletionCut(cut);
		expect(sealed.status).toBe("sealed");
		if (sealed.watermark === null) throw new Error("completion watermark missing");
		const sealedRetry = await authority.sealCompletionCut(cut);
		expect(sealedRetry.status).toBe("sealed");
		expect(sealedRetry.watermark?.cutId).toBe(sealed.watermark.cutId);
		expect(sealed.watermark.trainingClosureRootDigest).toBe(roots.training);
		expect(sealed.watermark.validationClosureRootDigest).toBe(roots.validation);
		expect(sealed.watermark.holdoutClosureRootDigest).toBe(roots.holdout);
		expect(sealed.watermark.finalClosureObservationId).toBe(replacementIds.holdout);
		expect(sealed.watermark.finalClosureObservationDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(sealed.watermark.supersededObservationIds).toEqual([supersededId]);
		expect(sealed.watermark.quarantinedObservationIds).toEqual([quarantinedId]);
		if (first === undefined) throw new Error("first host unavailable");
		await first.dispose?.();
		first = undefined;
		second = await openHost(artifactRoot, rootSessionId, workflowId);
		const reopenedAuthority = createAuthority(second, workflowId, {
			latePolicy: ({ observationId }) => (observationId === "late-reopen" ? "reopen" : "compensate"),
		});
		const reopenedWatermark = await reopenedAuthority.readWatermark();
		expect(reopenedWatermark?.cutId).toBe("completion-cut-1");
		if (reopenedWatermark === null) throw new Error("reopened completion watermark missing");
		const noOp = await reopenedAuthority.evaluateLateObservation({
			observationId: "late-no-op",
			observationDigest: digest("n"),
			baseRevisionDigest: reopenedWatermark.expectedHead.eventDigest ?? digest("missing"),
		});
		expect(noOp.status).toBe("no_op");
		const reopen = await reopenedAuthority.evaluateLateObservation({
			observationId: "late-reopen",
			observationDigest: digest("o"),
			baseRevisionDigest: digest("l"),
		});
		expect(reopen.status).toBe("reopen");
		const compensate = await reopenedAuthority.evaluateLateObservation({
			observationId: "late-compensate",
			observationDigest: digest("c"),
			baseRevisionDigest: digest("l"),
		});
		expect(compensate.status).toBe("compensate");
		expect(
			(
				await reopenedAuthority.evaluateLateObservation({
					observationId: "late-reopen",
					observationDigest: digest("o"),
					baseRevisionDigest: digest("l"),
				})
			).status,
		).toBe("reopen");
		const persistedLatePolicies = (await replayFor(second, workflowId)).events.filter(
			(event) => event.payload.kind === "workflow_late_observation_policy_recorded",
		);
		expect(persistedLatePolicies).toHaveLength(3);
		for (const event of persistedLatePolicies) {
			if (event.payload.kind === "workflow_late_observation_policy_recorded")
				expect(event.payload.record.cutId).toBe(reopenedWatermark.cutId);
		}
	} finally {
		await second?.dispose?.().catch(() => undefined);
		await first?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 180_000);

it("rejects a signed capability substituted from a foreign worker without applying the observation", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-observation-authority-capability-substitution-"));
	const workflowId = "observation-authority-capability-substitution";
	const rootSessionId = "observation-authority-capability-substitution-session";
	let host: ObservationHost | undefined;
	try {
		host = await openHost(artifactRoot, rootSessionId, workflowId);
		await host.execute({ kind: "start", request: { workflowId, objective: "reject foreign capability" } });
		const replay = await replayFor(host, workflowId);
		const lease = leaseFor(host);
		const valid = requestFor(workflowId, replay, lease, "foreign-capability-observation");
		const substituted = {
			...valid,
			processReceipt: processReceiptFor(valid, rootSessionId, {
				resourceDigest: digest("foreign-worker-resource"),
				executionIdentity: "foreign-worker-process",
			}),
		};
		const authority = createAuthority(host, workflowId);
		const result = await authority.processObservation(substituted);
		expect(result.status).toBe("rejected");
		expect(result.reason).toMatch(/authorization|capability|receipt/u);
		const after = await replayFor(host, workflowId);
		const outcomes = after.events.filter((event) => event.payload.kind === "workflow_observation_outcome_recorded");
		expect(outcomes).toHaveLength(1);
		if (outcomes[0]?.payload.kind === "workflow_observation_outcome_recorded")
			expect(outcomes[0].payload.record.outcome).toBe("rejected");
	} finally {
		await host?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
}, 60_000);
