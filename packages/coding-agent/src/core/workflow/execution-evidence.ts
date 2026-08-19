import { randomUUID } from "node:crypto";
import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEpochRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowJournalHead,
	WorkflowRuntimeStore,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
} from "./contracts.js";

const EXECUTION_EVIDENCE_RECORD = "workflow-execution-evidence-v1";
const EXECUTION_EVIDENCE_SOURCES = new WeakSet<object>();
const EXECUTION_EVIDENCE_SOURCE_HOSTS = new WeakMap<object, object>();
const REVOKED_EXECUTION_EVIDENCE_SOURCES = new WeakSet<object>();
const EXECUTION_TURN_HANDLES = new WeakMap<object, ExecutionTurnHandleBinding>();

export interface WorkflowExecutionToolCallFact {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly argumentsDigest: string;
}

export interface WorkflowExecutionToolResultFact {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly isError: boolean;
	readonly resultDigest: string;
}

export interface WorkflowExecutionTurnFacts {
	readonly assistantMessageDigest: string;
	readonly assistantStopReason: string;
	readonly modelProvider: string;
	readonly modelId: string;
	readonly usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cacheReadTokens: number;
		readonly cacheWriteTokens: number;
		readonly totalTokens: number;
		readonly costMicrounits: number;
	};
	readonly toolCalls: readonly WorkflowExecutionToolCallFact[];
	readonly toolStarts: readonly WorkflowExecutionToolCallFact[];
	readonly toolResults: readonly WorkflowExecutionToolResultFact[];
	readonly toolEnds: readonly WorkflowExecutionToolResultFact[];
}

export interface WorkflowExecutionTurnHandle {}

export interface WorkflowExecutionObservation {
	readonly schemaVersion: 1;
	readonly kind: "workflow_execution_observation";
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly attemptId: string;
	readonly turnIndex: number;
	readonly preTurnHead: WorkflowJournalHead;
	readonly postTurnHead: WorkflowJournalHead;
	readonly startedAt: string;
	readonly completedAt: string;
	readonly workflowStateDigest: string;
	readonly workflowRevision: number;
	readonly facts: WorkflowExecutionTurnFacts;
	readonly observationDigest: string;
}

export interface WorkflowExecutionEvidenceState {
	readonly observationCount: number;
	readonly latestObservationDigest: string | null;
	readonly observationRefs: readonly WorkflowArtifactRef[];
	readonly stateDigest: string;
}

export interface WorkflowExecutionEvidenceSource {
	beginTurn(turnIndex: number): Promise<WorkflowExecutionTurnHandle | null>;
	completeTurn(
		handle: WorkflowExecutionTurnHandle,
		facts: WorkflowExecutionTurnFacts,
	): Promise<WorkflowExecutionEvidenceState>;
}

export interface WorkflowExecutionEvidenceRuntime {
	read(): Promise<WorkflowExecutionEvidenceState>;
	resolveObservation(ref: WorkflowArtifactRef): Promise<WorkflowExecutionObservation>;
	consumeObservation(ref: WorkflowArtifactRef): Promise<WorkflowExecutionObservation>;
}

export interface WorkflowExecutionEvidenceAuthority {
	readonly source: WorkflowExecutionEvidenceSource;
	readonly runtime: WorkflowExecutionEvidenceRuntime;
}

interface ExecutionTurnHandleBinding {
	readonly source: WorkflowExecutionEvidenceSource;
	readonly attemptId: string;
	readonly turnIndex: number;
	readonly preTurnHead: WorkflowJournalHead;
	readonly startedAt: string;
	completedAt?: string;
}

interface WorkflowExecutionEvidenceLedgerEntry {
	readonly sequence: number;
	readonly attemptId: string;
	readonly observationDigest: string;
	readonly observationRef: WorkflowArtifactRef;
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly receiptBindingDigest: string;
	readonly workflowStateDigest: string;
	readonly workflowRevision: number;
	readonly issuedAt: string;
}

interface WorkflowExecutionEvidenceLedger {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly entries: readonly WorkflowExecutionEvidenceLedgerEntry[];
	readonly stateDigest: string;
}

interface WorkflowExecutionEvidenceAuthorityInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly now: () => string;
	readonly withHostLeaseOperation: <T>(operation: () => Promise<T>) => Promise<T>;
	readonly readWorkflowState: () => {
		readonly status: string;
		readonly stateDigest: string | null;
		readonly decisionRefs: readonly { readonly revision: number }[];
	};
	readonly issueReceipt: (input: {
		readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		readonly workflowId: string;
		readonly bindingDigest: string;
		readonly receiptId?: string;
		readonly oneUse?: boolean;
		readonly issuedAt?: string;
		readonly stateDigest?: string;
		readonly revision?: number;
		readonly payloadKind?: "workflow-learning";
		readonly payloadDigest?: string;
	}) => Promise<WorkflowVerifiedHostReceipt>;
}

function emptyLedger(input: WorkflowExecutionEvidenceAuthorityInput): WorkflowExecutionEvidenceLedger {
	const unsigned = {
		schemaVersion: 1 as const,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		epochRef: structuredClone(input.epochRef),
		entries: [] as const,
	};
	return { ...unsigned, stateDigest: digestObject(unsigned) };
}

function projectState(entries: readonly WorkflowExecutionEvidenceLedgerEntry[]): WorkflowExecutionEvidenceState {
	const unsigned = {
		observationCount: entries.length,
		latestObservationDigest: entries.at(-1)?.observationDigest ?? null,
		observationRefs: entries.map((entry) => structuredClone(entry.observationRef)),
	};
	return Object.freeze({ ...unsigned, stateDigest: digestObject(unsigned) });
}

function assertDigest(value: string, label: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label}_invalid`);
}

function assertBoundedText(value: string, maximum: number, label: string): void {
	if (value.length === 0 || value.length > maximum) throw new Error(`${label}_invalid`);
}

function assertTurnFacts(facts: WorkflowExecutionTurnFacts): void {
	assertDigest(facts.assistantMessageDigest, "workflow_execution_assistant_digest");
	assertBoundedText(facts.assistantStopReason, 32, "workflow_execution_stop_reason");
	assertBoundedText(facts.modelProvider, 256, "workflow_execution_model_provider");
	assertBoundedText(facts.modelId, 512, "workflow_execution_model_id");
	if (
		facts.toolCalls.length > 128 ||
		facts.toolStarts.length > 128 ||
		facts.toolResults.length > 128 ||
		facts.toolEnds.length > 128 ||
		Object.values(facts.usage).some((value) => !Number.isSafeInteger(value) || value < 0)
	)
		throw new Error("workflow_execution_turn_bounds_invalid");
	const assertCalls = (calls: readonly WorkflowExecutionToolCallFact[], label: string): void => {
		const ids = new Set<string>();
		for (const call of calls) {
			assertBoundedText(call.toolCallId, 512, `${label}_id`);
			assertBoundedText(call.toolName, 256, `${label}_name`);
			assertDigest(call.argumentsDigest, `${label}_arguments_digest`);
			if (ids.has(call.toolCallId)) throw new Error(`${label}_duplicate`);
			ids.add(call.toolCallId);
		}
	};
	const assertResults = (results: readonly WorkflowExecutionToolResultFact[], label: string): void => {
		const ids = new Set<string>();
		for (const result of results) {
			assertBoundedText(result.toolCallId, 512, `${label}_id`);
			assertBoundedText(result.toolName, 256, `${label}_name`);
			assertDigest(result.resultDigest, `${label}_result_digest`);
			if (ids.has(result.toolCallId)) throw new Error(`${label}_duplicate`);
			ids.add(result.toolCallId);
		}
	};
	assertCalls(facts.toolCalls, "workflow_execution_tool_call");
	assertCalls(facts.toolStarts, "workflow_execution_tool_start");
	assertResults(facts.toolResults, "workflow_execution_tool_result");
	assertResults(facts.toolEnds, "workflow_execution_tool_end");
	const byToolCallId = <T extends { readonly toolCallId: string }>(items: readonly T[]): T[] =>
		[...items].sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
	const toolIdentities = (items: readonly WorkflowExecutionToolCallFact[]) =>
		byToolCallId(items).map((item) => ({ toolCallId: item.toolCallId, toolName: item.toolName }));
	const resultIdentities = (items: readonly WorkflowExecutionToolResultFact[]) =>
		byToolCallId(items).map((item) => ({ toolCallId: item.toolCallId, toolName: item.toolName }));
	if (
		digestObject(toolIdentities(facts.toolCalls)) !== digestObject(toolIdentities(facts.toolStarts)) ||
		digestObject(toolIdentities(facts.toolCalls)) !== digestObject(resultIdentities(facts.toolResults)) ||
		digestObject(byToolCallId(facts.toolResults)) !== digestObject(byToolCallId(facts.toolEnds))
	)
		throw new Error("workflow_execution_tool_lifecycle_mismatch");
}

function decodeLedger(value: unknown, input: WorkflowExecutionEvidenceAuthorityInput): WorkflowExecutionEvidenceLedger {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("workflow_execution_evidence_ledger_invalid");
	const ledger = value as WorkflowExecutionEvidenceLedger;
	if (
		ledger.schemaVersion !== 1 ||
		ledger.workflowId !== input.workflowId ||
		ledger.rootSessionId !== input.rootSessionId ||
		digestObject(ledger.epochRef) !== digestObject(input.epochRef) ||
		!Array.isArray(ledger.entries) ||
		ledger.stateDigest !==
			digestObject({
				schemaVersion: 1,
				workflowId: ledger.workflowId,
				rootSessionId: ledger.rootSessionId,
				epochRef: ledger.epochRef,
				entries: ledger.entries,
			})
	)
		throw new Error("workflow_execution_evidence_ledger_invalid");
	return ledger;
}

function parseObservation(value: unknown): WorkflowExecutionObservation {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("workflow_execution_observation_invalid");
	const observation = value as WorkflowExecutionObservation;
	if (
		observation.schemaVersion !== 1 ||
		observation.kind !== "workflow_execution_observation" ||
		observation.observationDigest !== digestObject({ ...observation, observationDigest: "" })
	)
		throw new Error("workflow_execution_observation_invalid");
	assertTurnFacts(observation.facts);
	return observation;
}

export async function createWorkflowExecutionEvidenceAuthority(
	input: WorkflowExecutionEvidenceAuthorityInput,
): Promise<WorkflowExecutionEvidenceAuthority> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_execution_evidence_requires_durable_runtime");
	const readLedger = async (): Promise<WorkflowExecutionEvidenceLedger> => {
		const bytes = await durable.auxiliaryStore.read(EXECUTION_EVIDENCE_RECORD);
		return bytes === null ? emptyLedger(input) : decodeLedger(parseCanonicalJsonBytes(bytes), input);
	};
	const resolveObservationArtifact = async (ref: WorkflowArtifactRef): Promise<WorkflowExecutionObservation> => {
		const resolved = await input.artifactResolver.resolve(ref);
		if (
			!resolved.exists ||
			resolved.verifiedDigest !== ref.digest ||
			resolved.verifiedSizeBytes !== ref.sizeBytes ||
			resolved.envelope.ref.sourceEventSequence !== ref.sourceEventSequence
		)
			throw new Error("workflow_execution_observation_not_host_verified");
		const observation = parseObservation(parseCanonicalJsonBytes(resolved.bytes));
		if (
			observation.workflowId !== input.workflowId ||
			observation.rootSessionId !== input.rootSessionId ||
			digestObject(observation.epochRef) !== digestObject(input.epochRef)
		)
			throw new Error("workflow_execution_observation_binding_invalid");
		return observation;
	};
	const read = async (): Promise<WorkflowExecutionEvidenceState> => {
		const ledger = await readLedger();
		for (let index = 0; index < ledger.entries.length; index++) {
			const entry = ledger.entries[index];
			if (entry === undefined || entry.sequence !== index + 1)
				throw new Error("workflow_execution_sequence_invalid");
			const observation = await resolveObservationArtifact(entry.observationRef);
			if (
				entry.attemptId !== observation.attemptId ||
				entry.observationDigest !== observation.observationDigest ||
				entry.receipt.bindingDigest !== entry.receiptBindingDigest
			)
				throw new Error("workflow_execution_ledger_binding_invalid");
			await resolveAndVerifyWorkflowHostReceipt({
				context: input.receiptContext,
				workflowId: input.workflowId,
				expectedBindingDigest: entry.receiptBindingDigest,
				receipt: entry.receipt,
				currentStateDigest: entry.workflowStateDigest,
				currentRevision: entry.workflowRevision,
				trustedNow: entry.issuedAt,
			});
		}
		return projectState(ledger.entries);
	};
	const ledgerEntryFor = async (ref: WorkflowArtifactRef): Promise<WorkflowExecutionEvidenceLedgerEntry> => {
		await read();
		const ledger = await readLedger();
		const matches = ledger.entries.filter((entry) => digestObject(entry.observationRef) === digestObject(ref));
		if (matches.length !== 1) throw new Error("workflow_execution_observation_not_in_authenticated_ledger");
		return matches[0]!;
	};
	const resolveObservation = async (ref: WorkflowArtifactRef): Promise<WorkflowExecutionObservation> => {
		await ledgerEntryFor(ref);
		return resolveObservationArtifact(ref);
	};
	const consumeObservation = async (ref: WorkflowArtifactRef): Promise<WorkflowExecutionObservation> => {
		const entry = await ledgerEntryFor(ref);
		try {
			await input.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: entry.receipt,
				workflowId: input.workflowId,
				expectedBindingDigest: entry.receiptBindingDigest,
				currentRevision: entry.workflowRevision,
			});
		} catch (error) {
			try {
				await input.receiptContext.receiptResolver.resolveConsumptionWitness({
					receiptId: entry.receipt.receiptId,
					workflowId: input.workflowId,
					expectedBindingDigest: entry.receiptBindingDigest,
				});
			} catch {
				throw error;
			}
		}
		return resolveObservationArtifact(ref);
	};
	let openHandle: object | undefined;
	const assertSourceUsable = (): void => {
		if (REVOKED_EXECUTION_EVIDENCE_SOURCES.has(source) || !EXECUTION_EVIDENCE_SOURCE_HOSTS.has(source))
			throw new Error("workflow_execution_source_not_bound");
	};
	let source: WorkflowExecutionEvidenceSource;
	const beginTurn = async (turnIndex: number): Promise<WorkflowExecutionTurnHandle | null> => {
		assertSourceUsable();
		if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) throw new Error("workflow_execution_turn_index_invalid");
		if (openHandle !== undefined) throw new Error("workflow_execution_turn_already_open");
		const handle = Object.freeze({});
		openHandle = handle;
		try {
			const status = input.readWorkflowState();
			if (status.status !== "active") {
				openHandle = undefined;
				return null;
			}
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("workflow_execution_pre_turn_head_unavailable");
			EXECUTION_TURN_HANDLES.set(handle, {
				source,
				attemptId: `root-turn-${randomUUID()}`,
				turnIndex,
				preTurnHead: structuredClone(replay.head),
				startedAt: input.now(),
			});
			return handle;
		} catch (error) {
			EXECUTION_TURN_HANDLES.delete(handle);
			if (openHandle === handle) openHandle = undefined;
			throw error;
		}
	};
	const completeTurn = async (
		handle: WorkflowExecutionTurnHandle,
		facts: WorkflowExecutionTurnFacts,
	): Promise<WorkflowExecutionEvidenceState> => {
		assertSourceUsable();
		const binding = EXECUTION_TURN_HANDLES.get(handle as object);
		if (binding === undefined || binding.source !== source || openHandle !== handle)
			throw new Error("workflow_execution_turn_handle_invalid");
		assertTurnFacts(facts);
		const status = input.readWorkflowState();
		if (status.status !== "active" || status.stateDigest === null)
			throw new Error("workflow_execution_requires_active_workflow");
		const workflowStateDigest = status.stateDigest;
		const workflowRevision = status.decisionRefs.at(-1)?.revision;
		if (workflowRevision === undefined) throw new Error("workflow_execution_revision_unavailable");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("workflow_execution_post_turn_head_unavailable");
		if (
			replay.head.sequence < binding.preTurnHead.sequence ||
			binding.preTurnHead.workflowId !== input.workflowId ||
			digestObject(binding.preTurnHead.epochRef) !== digestObject(input.epochRef)
		)
			throw new Error("workflow_execution_turn_head_invalid");
		const completedAt = binding.completedAt ?? input.now();
		binding.completedAt = completedAt;
		const unsignedObservation = {
			schemaVersion: 1 as const,
			kind: "workflow_execution_observation" as const,
			workflowId: input.workflowId,
			rootSessionId: input.rootSessionId,
			epochRef: structuredClone(input.epochRef),
			attemptId: binding.attemptId,
			turnIndex: binding.turnIndex,
			preTurnHead: binding.preTurnHead,
			postTurnHead: structuredClone(replay.head),
			startedAt: binding.startedAt,
			completedAt,
			workflowStateDigest,
			workflowRevision,
			facts: structuredClone(facts),
		};
		const observation: WorkflowExecutionObservation = {
			...unsignedObservation,
			observationDigest: digestObject({ ...unsignedObservation, observationDigest: "" }),
		};
		const observationRef = (
			await input.runtimeStore.publishArtifact({
				workflowId: input.workflowId,
				payloadKind: "evidence",
				bytes: canonicalJsonBytes(observation),
				codec: "canonical_json",
				sourceEventSequence: replay.head.sequence,
				idempotencyKey: `workflow-execution-observation:${binding.attemptId}`,
			})
		).envelope.ref;
		const receiptBindingDigest = digestObject({
			kind: "workflow-execution-observation",
			workflowId: input.workflowId,
			attemptId: binding.attemptId,
			observationDigest: observation.observationDigest,
			observationRef,
			preTurnHead: binding.preTurnHead,
			postTurnHead: replay.head,
		});
		const receiptPayloadDigest = digestObject({
			kind: "workflow-execution-observation",
			observationDigest: observation.observationDigest,
			observationRef,
		});
		const receipt = await input.issueReceipt({
			receiptKind: "artifact",
			workflowId: input.workflowId,
			bindingDigest: receiptBindingDigest,
			receiptId: `workflow-execution-${binding.attemptId}`,
			oneUse: true,
			issuedAt: completedAt,
			stateDigest: workflowStateDigest,
			revision: workflowRevision,
			payloadKind: "workflow-learning",
			payloadDigest: receiptPayloadDigest,
		});
		const state = await durable.withExclusiveLease("workflow-execution-evidence-ledger", async () => {
			const ledger = await readLedger();
			const existing = ledger.entries.find((entry) => entry.attemptId === binding.attemptId);
			if (existing !== undefined) {
				if (existing.observationDigest !== observation.observationDigest)
					throw new Error("workflow_execution_attempt_identity_conflict");
				return projectState(ledger.entries);
			}
			const entry: WorkflowExecutionEvidenceLedgerEntry = {
				sequence: ledger.entries.length + 1,
				attemptId: binding.attemptId,
				observationDigest: observation.observationDigest,
				observationRef,
				receipt,
				receiptBindingDigest,
				workflowStateDigest,
				workflowRevision,
				issuedAt: completedAt,
			};
			const unsigned = {
				schemaVersion: 1 as const,
				workflowId: input.workflowId,
				rootSessionId: input.rootSessionId,
				epochRef: structuredClone(input.epochRef),
				entries: [...ledger.entries, entry],
			};
			const next = { ...unsigned, stateDigest: digestObject(unsigned) };
			await durable.auxiliaryStore.write(EXECUTION_EVIDENCE_RECORD, canonicalJsonBytes(next));
			return projectState(next.entries);
		});
		return state;
	};
	source = {
		beginTurn: (turnIndex) => input.withHostLeaseOperation(() => beginTurn(turnIndex)),
		completeTurn: async (handle, facts) => {
			try {
				return await input.withHostLeaseOperation(() => completeTurn(handle, facts));
			} finally {
				EXECUTION_TURN_HANDLES.delete(handle as object);
				if (openHandle === handle) openHandle = undefined;
			}
		},
	};
	EXECUTION_EVIDENCE_SOURCES.add(source);
	return Object.freeze({
		source: Object.freeze(source),
		runtime: Object.freeze({ read, resolveObservation, consumeObservation }),
	});
}

export function isWorkflowExecutionEvidenceSource(value: unknown): value is WorkflowExecutionEvidenceSource {
	return typeof value === "object" && value !== null && EXECUTION_EVIDENCE_SOURCES.has(value);
}

/** Bind one opaque execution source to the exact persisted host that issued it. */
export function bindWorkflowExecutionEvidenceSourceToHost(source: WorkflowExecutionEvidenceSource, host: object): void {
	if (!isWorkflowExecutionEvidenceSource(source) || REVOKED_EXECUTION_EVIDENCE_SOURCES.has(source))
		throw new Error("workflow_execution_source_not_issued");
	const existing = EXECUTION_EVIDENCE_SOURCE_HOSTS.get(source);
	if (existing !== undefined && existing !== host) throw new Error("workflow_execution_source_already_bound");
	EXECUTION_EVIDENCE_SOURCE_HOSTS.set(source, host);
}

/** Verify that an opaque execution source belongs to one exact persisted host. */
export function isWorkflowExecutionEvidenceSourceForHost(
	source: unknown,
	host: object,
): source is WorkflowExecutionEvidenceSource {
	return (
		isWorkflowExecutionEvidenceSource(source) &&
		!REVOKED_EXECUTION_EVIDENCE_SOURCES.has(source) &&
		EXECUTION_EVIDENCE_SOURCE_HOSTS.get(source) === host
	);
}

/** Revoke a host-issued execution source when its persisted host is disposed. */
export function revokeWorkflowExecutionEvidenceSource(source: WorkflowExecutionEvidenceSource): void {
	if (!isWorkflowExecutionEvidenceSource(source)) throw new Error("workflow_execution_source_not_issued");
	REVOKED_EXECUTION_EVIDENCE_SOURCES.add(source);
	EXECUTION_EVIDENCE_SOURCE_HOSTS.delete(source);
}
