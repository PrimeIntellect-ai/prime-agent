import type {
	WorkflowAuthenticatedMutationTuple,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowOutboxHead,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
	WorkflowSemanticMutationBinding,
} from "../workflow/contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "../workflow/contracts.js";
import type {
	DurableStoreCommitResult,
	DurableStoreInstance,
	DurableStoreMutationRequest,
	DurableStoreRecoveryResult,
} from "../workflow/durable-store.js";
import { bindKnowledgeDurableAuthority, type KnowledgeAuthorityHandle } from "./knowledge-runtime-authority.js";
import type {
	KnowledgeMempalaceFence,
	KnowledgeMempalaceOutbox,
	KnowledgeMempalaceOutboxEntry,
} from "./mempalace-boundary.js";
import {
	freezeKnowledgeValue,
	type KnowledgeEvent,
	type KnowledgeProjection,
	knowledgeProposalFromRecord,
	redactKnowledgeRecordForHistory,
	redactKnowledgeRecordForReplay,
	reduceKnowledgeEvent,
	validateKnowledgeEvent,
	validateKnowledgeProjection,
} from "./records.js";

const MAX_KNOWLEDGE_DURABLE_REPLAY_EVENTS = 100_000;
const MAX_KNOWLEDGE_NAMESPACE_BYTES = 256;

export interface KnowledgeAuthenticatedCommitEvidence {
	eventDigest: string;
	sequence: number;
	epochRef: WorkflowEpochRef;
	generationId: string;
	keyId: string;
	recordMac: string;
	recordChecksum: string;
	committedFrameDigest: string;
	committedFrameMac: string;
	committedFrameChecksum: string;
}

function toWorkflowPayload(
	event: KnowledgeEvent,
): Extract<WorkflowEventPayload, { kind: "knowledge_record_committed" }> {
	const payload: Extract<WorkflowEventPayload, { kind: "knowledge_record_committed" }> = {
		kind: "knowledge_record_committed",
		idempotencyKey: event.idempotencyKey,
		record: event.record as unknown as Extract<
			WorkflowEventPayload,
			{ kind: "knowledge_record_committed" }
		>["record"],
		previous:
			event.previous === null
				? null
				: (event.previous as unknown as Extract<
						WorkflowEventPayload,
						{ kind: "knowledge_record_committed" }
					>["record"]),
		previousDigest: event.previousDigest,
		proposalDigest: event.proposalDigest,
	};
	return Object.freeze(payload);
}

function fromWorkflowPayload(
	payload: Extract<WorkflowEventPayload, { kind: "knowledge_record_committed" }>,
): KnowledgeEvent {
	return {
		kind: "knowledge_record_committed",
		idempotencyKey: payload.idempotencyKey,
		record: payload.record as unknown as KnowledgeEvent["record"],
		previous: payload.previous as KnowledgeEvent["previous"],
		previousDigest: payload.previousDigest,
		proposalDigest: payload.proposalDigest,
	};
}

interface KnowledgeMempalaceAckFile {
	version: 1;
	workflowId: string;
	generationId: string;
	epochRef: WorkflowEpochRef;
	acknowledged: readonly string[];
	mac: string;
}

const MEMPALACE_ACK_FILE = "knowledge-mempalace-acks.json";
const MAX_MEMPALACE_ACKS = 100_000;
const MAX_MEMPALACE_IDENTIFIER_BYTES = 512;

function assertMempalaceIdentifier(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`MemPalace ${label} must be non-empty.`);
	if (new TextEncoder().encode(value).byteLength > MAX_MEMPALACE_IDENTIFIER_BYTES)
		throw new Error(`MemPalace ${label} exceeds the bounded size.`);
}

function assertMempalaceEntry(value: unknown): asserts value is KnowledgeMempalaceOutboxEntry {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("MemPalace outbox entry is not a bounded object.");
	const entry = value as KnowledgeMempalaceOutboxEntry;
	if (
		Object.keys(entry).some(
			(key) =>
				![
					"idempotencyKey",
					"operation",
					"recordId",
					"revision",
					"canonicalDigest",
					"sourceDigest",
					"tombstoneFingerprint",
					"fence",
					"record",
				].includes(key),
		)
	)
		throw new Error("MemPalace outbox entry contains unknown fields.");
	assertMempalaceIdentifier(entry.idempotencyKey, "idempotency key");
	assertMempalaceIdentifier(entry.recordId, "record ID");
	if (
		!Number.isSafeInteger(entry.revision) ||
		entry.revision < 1 ||
		(entry.operation !== "upsert" && entry.operation !== "delete") ||
		typeof entry.canonicalDigest !== "string" ||
		typeof entry.fence !== "object" ||
		entry.fence === null ||
		Array.isArray(entry.fence) ||
		Object.keys(entry.fence).some(
			(key) =>
				!["knowledgeStoreEpoch", "coordinatorEpoch", "knowledgeJournalSequence", "knowledgeJournalDigest"].includes(
					key,
				),
		) ||
		!Number.isSafeInteger(entry.fence.knowledgeStoreEpoch) ||
		entry.fence.knowledgeStoreEpoch < 0 ||
		!Number.isSafeInteger(entry.fence.coordinatorEpoch) ||
		entry.fence.coordinatorEpoch < 0 ||
		!Number.isSafeInteger(entry.fence.knowledgeJournalSequence) ||
		entry.fence.knowledgeJournalSequence < 1 ||
		!/^[0-9a-f]{64}$/.test(entry.fence.knowledgeJournalDigest) ||
		entry.record !== null
	)
		throw new Error("MemPalace outbox entry is not bounded and authenticated.");
	if (entry.operation === "upsert") {
		if (
			!/^[0-9a-f]{64}$/.test(entry.canonicalDigest) ||
			typeof entry.sourceDigest !== "string" ||
			!/^[0-9a-f]{64}$/.test(entry.sourceDigest) ||
			entry.tombstoneFingerprint !== null
		)
			throw new Error("MemPalace upsert fence is malformed.");
	} else if (
		entry.canonicalDigest !== "" ||
		entry.sourceDigest !== null ||
		typeof entry.tombstoneFingerprint !== "string" ||
		!/^[0-9a-f]{64}$/.test(entry.tombstoneFingerprint)
	)
		throw new Error("MemPalace delete fence is malformed.");
	const bytes = canonicalJsonBytes(entry);
	if (bytes.byteLength > 1_000_000) throw new Error("MemPalace outbox entry exceeds the bounded payload size.");
}

function assertAckFile(
	value: unknown,
	workflowId: string,
	generationId: string,
	epochRef: WorkflowEpochRef,
): asserts value is KnowledgeMempalaceAckFile {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).some(
			(key) => !["version", "workflowId", "generationId", "epochRef", "acknowledged", "mac"].includes(key),
		)
	)
		throw new Error("MemPalace acknowledgement file is not a closed durable map.");
	const candidate = value as Record<string, unknown>;
	if (
		candidate.version !== 1 ||
		candidate.workflowId !== workflowId ||
		candidate.generationId !== generationId ||
		digestObject(candidate.epochRef) !== digestObject(epochRef) ||
		!Array.isArray(candidate.acknowledged) ||
		candidate.acknowledged.length > MAX_MEMPALACE_ACKS ||
		candidate.acknowledged.some(
			(id) =>
				typeof id !== "string" ||
				id.length === 0 ||
				new TextEncoder().encode(id).byteLength > MAX_MEMPALACE_IDENTIFIER_BYTES,
		) ||
		typeof candidate.mac !== "string" ||
		!/^[0-9a-f]{64}$/.test(candidate.mac)
	)
		throw new Error("MemPalace acknowledgement file is invalid.");
}

function acknowledgedMac(value: Omit<KnowledgeMempalaceAckFile, "mac">): string {
	return digestObject(value);
}

function canonicalMempalaceEntry(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
): KnowledgeMempalaceOutboxEntry | null {
	if (commit.payload.kind !== "knowledge_record_committed") return null;
	const event = validateKnowledgeEvent(fromWorkflowPayload(commit.payload));
	const operation = event.record.status === "retracted" ? "delete" : "upsert";
	return {
		idempotencyKey: `mempalace:${event.record.recordId}:${event.record.revision}:${operation}:${
			event.record.tombstone?.deletionFingerprint ?? event.record.contentDigest
		}`,
		operation,
		recordId: event.record.recordId,
		revision: event.record.revision,
		canonicalDigest: operation === "delete" ? "" : digestObject(event.record),
		sourceDigest: operation === "delete" ? null : event.record.sourceDigest,
		tombstoneFingerprint: event.record.tombstone?.deletionFingerprint ?? null,
		fence: {
			knowledgeStoreEpoch: event.record.commitRef.knowledgeStoreEpoch,
			coordinatorEpoch: event.record.commitRef.workflowEpochRef.coordinatorEpoch,
			knowledgeJournalSequence: commit.sequence,
			knowledgeJournalDigest: commit.eventDigest,
		},
		record: null,
	};
}

function mempalaceSemanticKey(entry: KnowledgeMempalaceOutboxEntry): string {
	return digestObject({
		operation: entry.operation,
		recordId: entry.recordId,
		revision: entry.revision,
		fence: entry.fence,
	});
}

class KnowledgeDurableMempalaceOutbox implements KnowledgeMempalaceOutbox {
	readonly #context: WorkflowRuntimeStoreDurableContext;
	readonly #runtimeStore: WorkflowRuntimeStore;
	readonly #writeAuxiliary: (name: string, bytes: Readonly<Uint8Array>) => Promise<void>;

	constructor(
		context: WorkflowRuntimeStoreDurableContext,
		runtimeStore: WorkflowRuntimeStore,
		writeAuxiliary: (name: string, bytes: Readonly<Uint8Array>) => Promise<void>,
	) {
		this.#context = context;
		this.#runtimeStore = runtimeStore;
		this.#writeAuxiliary = writeAuxiliary;
		Object.freeze(this);
	}

	private async withLease<T>(operation: () => Promise<T>): Promise<T> {
		return this.#context.withExclusiveLease("knowledge-mempalace-ack-file", operation);
	}

	private async readAcks(): Promise<Set<string>> {
		try {
			const bytes = await this.#context.auxiliaryStore.read(MEMPALACE_ACK_FILE);
			if (bytes === null) return new Set();
			const parsed = parseCanonicalJsonBytes(bytes);
			assertAckFile(
				parsed,
				this.#runtimeStore.identity.workflowId,
				this.#context.generationId,
				this.#context.epochRef,
			);
			const withoutMac: Omit<KnowledgeMempalaceAckFile, "mac"> = {
				version: parsed.version,
				workflowId: parsed.workflowId,
				generationId: parsed.generationId,
				epochRef: parsed.epochRef,
				acknowledged: parsed.acknowledged,
			};
			if (parsed.mac !== acknowledgedMac(withoutMac))
				throw new Error("MemPalace acknowledgement file authentication failed.");
			return new Set(parsed.acknowledged);
		} catch {
			return new Set();
		}
	}

	private async writeAcks(acknowledged: ReadonlySet<string>): Promise<void> {
		if (acknowledged.size > MAX_MEMPALACE_ACKS) throw new Error("MemPalace acknowledgement history is bounded.");
		const withoutMac = {
			version: 1 as const,
			workflowId: this.#runtimeStore.identity.workflowId,
			generationId: this.#context.generationId,
			epochRef: this.#context.epochRef,
			acknowledged: [...acknowledged].sort(),
		};
		await this.#writeAuxiliary(
			MEMPALACE_ACK_FILE,
			canonicalJsonBytes({ ...withoutMac, mac: acknowledgedMac(withoutMac) }),
		);
	}

	async append(entry: KnowledgeMempalaceOutboxEntry): Promise<void> {
		assertMempalaceEntry(entry);
		const acknowledged = await this.readAcks();
		if (acknowledged.has(entry.idempotencyKey)) {
			const recovery = await this.#context.outbox.recover(this.#context.epochRef);
			if (recovery.quarantined) throw new Error("MemPalace durable outbox is quarantined.");
			const existing = recovery.entries.find((candidate) => candidate.idempotencyKey === entry.idempotencyKey);
			if (existing === undefined) throw new Error("MemPalace idempotency key was already acknowledged.");
			const existingValue = parseCanonicalJsonBytes(existing.bytes);
			assertMempalaceEntry(existingValue);
			if (digestObject(existingValue) !== digestObject(entry))
				throw new Error("MemPalace outbox idempotency key conflicts with an acknowledged entry.");
			return;
		}
		const pending = await this.pending();
		const existingPending = pending.find((candidate) => candidate.idempotencyKey === entry.idempotencyKey);
		if (existingPending !== undefined) {
			if (digestObject(existingPending) !== digestObject(entry))
				throw new Error("MemPalace outbox idempotency key conflicts with a different fenced entry.");
			return;
		}
		const recovery = await this.#context.outbox.recover(this.#context.epochRef);
		if (recovery.quarantined) throw new Error("MemPalace durable outbox is quarantined.");
		const commits = await this.#runtimeStore.replay({
			workflowId: this.#runtimeStore.identity.workflowId,
			fromSequence: entry.fence.knowledgeJournalSequence,
			expectedStoreEpoch: this.#context.epochRef.storeEpoch,
		});
		if (commits.quarantined) throw new Error("MemPalace fence source journal is quarantined.");
		const commit = commits.events.find((candidate) => candidate.sequence === entry.fence.knowledgeJournalSequence);
		if (commit === undefined || commit.eventDigest !== entry.fence.knowledgeJournalDigest)
			throw new Error("MemPalace outbox fence is not bound to an authenticated journal event.");
		if (commit.payload.kind !== "knowledge_record_committed")
			throw new Error("MemPalace outbox fence is not bound to a knowledge journal event.");
		const sourceEvent = validateKnowledgeEvent(fromWorkflowPayload(commit.payload));
		const sensitiveText = [sourceEvent.record.title, sourceEvent.record.statement];
		if (sourceEvent.record.procedure !== undefined)
			sensitiveText.push(
				...Object.values(sourceEvent.record.procedure.inputs),
				...sourceEvent.record.procedure.steps,
				...sourceEvent.record.procedure.successChecks,
				...sourceEvent.record.procedure.failureChecks,
			);
		if (sensitiveText.some((value) => value.length > 0 && entry.idempotencyKey.includes(value)))
			throw new Error("MemPalace idempotency key cannot expose canonical knowledge text.");
		if (
			sourceEvent.record.recordId !== entry.recordId ||
			sourceEvent.record.revision !== entry.revision ||
			digestObject(commit.epochRef) !== digestObject(this.#context.epochRef) ||
			commit.epochRef.storeEpoch !== entry.fence.knowledgeStoreEpoch ||
			commit.epochRef.coordinatorEpoch !== entry.fence.coordinatorEpoch ||
			sourceEvent.record.commitRef.knowledgeStoreEpoch !== entry.fence.knowledgeStoreEpoch ||
			sourceEvent.record.commitRef.workflowEpochRef.coordinatorEpoch !== entry.fence.coordinatorEpoch ||
			sourceEvent.record.commitRef.workflowEpochRef.storeEpoch !== entry.fence.knowledgeStoreEpoch ||
			sourceEvent.record.commitRef.knowledgeStoreId !== this.#runtimeStore.identity.storeId ||
			sourceEvent.record.commitRef.knowledgeJournalSequence !== commit.sequence ||
			sourceEvent.record.commitRef.knowledgeJournalDigest !==
				digestObject({
					sequence: commit.sequence,
					storeId: this.#runtimeStore.identity.storeId,
					transactionDigest: sourceEvent.record.commitRef.transactionDigest,
				}) ||
			commit.semanticBinding.ownerId !== "knowledge" ||
			commit.semanticBinding.phase !== "planning" ||
			commit.semanticBinding.idempotencyKey !== commit.idempotencyKey ||
			digestObject(commit.semanticBinding.epochRef) !== digestObject(commit.epochRef) ||
			digestObject(commit.semanticBinding.expectedHead) !== digestObject(commit.expectedHead) ||
			commit.semanticBinding.expectedHead.workflowId !== commit.workflowId ||
			commit.semanticBinding.expectedHead.sequence + 1 !== commit.sequence ||
			commit.semanticBinding.semanticHead.workflowId !== commit.workflowId ||
			commit.semanticBinding.semanticHead.sequence !== commit.expectedHead.sequence ||
			commit.semanticBinding.semanticHead.eventDigest !== commit.expectedHead.eventDigest ||
			commit.semanticBinding.semanticHead.stateDigest !== commit.semanticBinding.baselineDigest ||
			(entry.operation === "upsert" &&
				(sourceEvent.record.status !== "active" ||
					sourceEvent.record.sourceDigest !== entry.sourceDigest ||
					digestObject(sourceEvent.record) !== entry.canonicalDigest)) ||
			(entry.operation === "delete" &&
				(sourceEvent.record.status !== "retracted" ||
					sourceEvent.record.tombstone?.deletionFingerprint !== entry.tombstoneFingerprint))
		)
			throw new Error("MemPalace outbox fence does not match the authenticated knowledge record.");
		const expectedHead: WorkflowOutboxHead = recovery.head;
		const outboxSequence = expectedHead.sequence + 1;
		const bytes = canonicalJsonBytes(entry);
		const authenticatedTuple: WorkflowAuthenticatedMutationTuple = {
			recordVersion: 1,
			generationId: commit.generationId,
			workflowId: commit.workflowId,
			mutationId: commit.returnProofId,
			expectedHead: commit.expectedHead,
			sequence: commit.sequence,
			eventDigest: commit.eventDigest,
			epochRef: commit.epochRef,
			leaseRef: commit.leaseRef,
			writerIdentity: commit.writerIdentity,
			idempotencyKey: commit.idempotencyKey,
			keyId: commit.keyId,
			frameMac: commit.committedFrameMac,
			frameChecksum: commit.committedFrameChecksum,
			recordMac: commit.recordMac,
			recordChecksum: commit.recordChecksum,
			priorRecordDigest: commit.priorEventDigest,
		};
		await this.#context.outbox.append({
			workflowId: commit.workflowId,
			sequence: outboxSequence,
			eventDigest: commit.eventDigest,
			sourceEventSequence: commit.sequence,
			sourceEventDigest: commit.eventDigest,
			epochRef: commit.epochRef,
			expectedHead,
			leaseRef: commit.leaseRef,
			writerIdentity: commit.writerIdentity,
			idempotencyKey: commit.idempotencyKey,
			bytes,
			entryDigest: sha256Hex(bytes),
			authenticatedTuple,
		});
	}

	private async pendingUnlocked(): Promise<readonly KnowledgeMempalaceOutboxEntry[]> {
		const recovery = await this.#context.outbox.recover(this.#context.epochRef);
		if (recovery.quarantined) throw new Error("MemPalace durable outbox is quarantined.");
		const acknowledged = await this.readAcks();
		const explicitEntries: KnowledgeMempalaceOutboxEntry[] = [];
		for (const durable of recovery.entries) {
			const value = parseCanonicalJsonBytes(durable.bytes) as unknown;
			assertMempalaceEntry(value);
			if (!acknowledged.has(value.idempotencyKey)) explicitEntries.push(freezeKnowledgeValue(value));
		}
		const replay = await this.#runtimeStore.replay({
			workflowId: this.#runtimeStore.identity.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: this.#context.epochRef.storeEpoch,
		});
		if (replay.quarantined) throw new Error("MemPalace source journal is quarantined.");
		const canonicalEntries = replay.events
			.map((commit) => canonicalMempalaceEntry(commit))
			.filter((entry): entry is KnowledgeMempalaceOutboxEntry => entry !== null);
		const explicitBySemantic = new Map(explicitEntries.map((entry) => [mempalaceSemanticKey(entry), entry]));
		const entries: KnowledgeMempalaceOutboxEntry[] = [];
		for (const canonical of canonicalEntries) {
			if (acknowledged.has(canonical.idempotencyKey)) continue;
			const explicit = explicitBySemantic.get(mempalaceSemanticKey(canonical));
			if (explicit !== undefined) {
				entries.push(explicit);
				explicitBySemantic.delete(mempalaceSemanticKey(canonical));
			} else {
				entries.push(freezeKnowledgeValue(canonical));
			}
		}
		for (const entry of explicitBySemantic.values()) entries.push(entry);
		return freezeKnowledgeValue(entries);
	}

	async pending(): Promise<readonly KnowledgeMempalaceOutboxEntry[]> {
		return this.withLease(() => this.pendingUnlocked());
	}

	async acknowledge(idempotencyKey: string, fence: KnowledgeMempalaceFence): Promise<void> {
		assertMempalaceIdentifier(idempotencyKey, "acknowledgement idempotency key");
		await this.withLease(async () => {
			const entries = await this.pendingUnlocked();
			const match = entries.find(
				(entry) => entry.idempotencyKey === idempotencyKey && digestObject(entry.fence) === digestObject(fence),
			);
			if (match === undefined) throw new Error("MemPalace acknowledgement is not bound to a pending fence.");
			const acknowledged = await this.readAcks();
			acknowledged.add(idempotencyKey);
			const replay = await this.#runtimeStore.replay({
				workflowId: this.#runtimeStore.identity.workflowId,
				fromSequence: fence.knowledgeJournalSequence,
				expectedStoreEpoch: this.#context.epochRef.storeEpoch,
			});
			if (replay.quarantined) throw new Error("MemPalace source journal is quarantined.");
			for (const commit of replay.events) {
				const canonical = canonicalMempalaceEntry(commit);
				if (canonical !== null && digestObject(canonical.fence) === digestObject(fence)) {
					acknowledged.add(canonical.idempotencyKey);
					break;
				}
			}
			await this.writeAcks(acknowledged);
		});
	}
}

export interface KnowledgeDurableStore
	extends Omit<DurableStoreInstance<KnowledgeEvent, KnowledgeProjection, KnowledgeEvent>, "read" | "commit"> {
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly generationId: string;
	currentLeaseRef(): ReturnType<WorkflowRuntimeStoreDurableContext["currentLeaseRef"]>;
	readonly mempalaceOutbox?: KnowledgeMempalaceOutbox;
	read(): Promise<{
		state: KnowledgeProjection;
		sequence: number;
		digest: string | null;
		projectionDigest: string | null;
		journalSequence?: number;
		journalDigest?: string | null;
	}>;
	commit(input: DurableStoreMutationRequest<KnowledgeEvent>): Promise<
		DurableStoreCommitResult<KnowledgeProjection, KnowledgeEvent> & {
			projectionDigest: string;
			authenticatedCommit: KnowledgeAuthenticatedCommitEvidence;
		}
	>;
	readAuthenticatedCommit(sequence: number): Promise<KnowledgeAuthenticatedCommitEvidence | null>;
}

function authenticatedCommitEvidence(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
): KnowledgeAuthenticatedCommitEvidence {
	return {
		eventDigest: commit.eventDigest,
		sequence: commit.sequence,
		epochRef: commit.epochRef,
		generationId: commit.generationId,
		keyId: commit.keyId,
		recordMac: commit.recordMac,
		recordChecksum: commit.recordChecksum,
		committedFrameDigest: commit.committedFrameDigest,
		committedFrameMac: commit.committedFrameMac,
		committedFrameChecksum: commit.committedFrameChecksum,
	};
}

function knowledgeProjection(namespace: string): KnowledgeProjection {
	return { namespace, records: {}, history: [], sequence: 0, digest: null };
}

function workflowKnowledgeBinding(
	mutation: DurableStoreMutationRequest<KnowledgeEvent>,
	workflowId: string,
): WorkflowSemanticMutationBinding {
	return {
		mutationId: mutation.mutationId,
		baselineDigest: mutation.baselineDigest,
		expectedGenerations: mutation.expectedGenerations,
		ownerId: "knowledge",
		phase: "planning",
		reducerDigest: digestObject("knowledge-reducer-v1"),
		semanticHead: {
			workflowId,
			sequence: mutation.expectedHead.sequence,
			eventDigest: mutation.expectedHead.eventDigest,
			stateDigest: mutation.baselineDigest,
			epochRef: mutation.epochRef,
			generation: Object.values(mutation.expectedGenerations)[0] ?? 0,
		},
		expectedHead: mutation.expectedHead,
		idempotencyKey: mutation.idempotencyKey,
		executionKey: mutation.executionKey,
		writerIdentity: mutation.writerIdentity,
		leaseRef: mutation.leaseRef,
		epochRef: mutation.epochRef,
	};
}

/**
 * Create a knowledge projection adapter over the existing authenticated workflow runtime.
 *
 * Args:
 * input: Workflow runtime authority, knowledge namespace, and current workflow epoch.
 * Return: Knowledge durable-store surface backed by the workflow journal; no knowledge journal is opened.
 */
export function createKnowledgeDurableStore(input: {
	runtimeStore: WorkflowRuntimeStore;
	namespace: string;
	epochRef: WorkflowEpochRef;
	mempalaceOutbox?: KnowledgeMempalaceOutbox;
}): KnowledgeDurableStore {
	if (input.namespace.length === 0 || input.namespace.includes("/") || input.namespace.includes("\\"))
		throw new Error("Knowledge namespace is invalid.");
	if (new TextEncoder().encode(input.namespace).byteLength > MAX_KNOWLEDGE_NAMESPACE_BYTES)
		throw new Error("Knowledge namespace exceeds the bounded identifier size.");
	const workflowId = input.runtimeStore.identity.workflowId;
	if (input.runtimeStore.identity.storeKind !== "workflow")
		throw new Error("Knowledge projection requires the existing workflow runtime authority.");

	const replayWorkflow = async () => {
		const result = await input.runtimeStore.replay({
			workflowId,
			fromSequence: 1,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (result.workflowId !== workflowId || result.head.workflowId !== workflowId)
			throw new Error("Knowledge projection crossed its workflow boundary.");
		if (result.quarantined)
			throw new Error(`Knowledge workflow journal is quarantined: ${result.quarantineReason ?? "unknown"}.`);
		if (result.events.length > MAX_KNOWLEDGE_DURABLE_REPLAY_EVENTS)
			throw new Error("Knowledge workflow replay exceeds the bounded event history.");
		return result;
	};
	const replayCanonical = async (): Promise<readonly KnowledgeEvent[]> => {
		const result = await replayWorkflow();
		return result.events.flatMap((event) =>
			event.payload.kind === "knowledge_record_committed" ? [fromWorkflowPayload(event.payload)] : [],
		);
	};
	const context = input.runtimeStore.durableContext;
	if (context === undefined)
		throw new Error("Knowledge projection requires the authenticated workflow durable context.");
	let mempalaceOutbox: KnowledgeMempalaceOutbox | undefined = input.mempalaceOutbox;
	const ensureMempalaceObligation = async (commit: WorkflowJournalCommit<WorkflowEventPayload>): Promise<void> => {
		const entry = canonicalMempalaceEntry(commit);
		if (entry !== null && mempalaceOutbox !== undefined) await mempalaceOutbox.append(entry);
	};
	let authority: KnowledgeAuthorityHandle;
	const readState = async (): Promise<KnowledgeProjection> => {
		let state = knowledgeProjection(input.namespace);
		const replay = await replayWorkflow();
		for (const committed of replay.events) {
			if (committed.payload.kind !== "knowledge_record_committed") continue;
			const event = fromWorkflowPayload(committed.payload);
			validateKnowledgeEvent(event);
			if (
				committed.idempotencyKey !== event.idempotencyKey ||
				committed.payloadDigest !== digestObject(committed.payload) ||
				committed.semanticBinding.ownerId !== "knowledge" ||
				committed.semanticBinding.phase !== "planning" ||
				committed.semanticBinding.idempotencyKey !== committed.idempotencyKey ||
				digestObject(committed.semanticBinding.expectedHead) !== digestObject(committed.expectedHead) ||
				committed.semanticBinding.semanticHead.stateDigest !== committed.semanticBinding.baselineDigest ||
				digestObject(committed.semanticBinding.epochRef) !== digestObject(committed.epochRef) ||
				event.record.commitRef.knowledgeStoreId !== input.runtimeStore.identity.storeId ||
				event.record.commitRef.knowledgeJournalDigest !==
					digestObject({
						sequence: committed.sequence,
						storeId: event.record.commitRef.knowledgeStoreId,
						transactionDigest: event.record.commitRef.transactionDigest,
					}) ||
				event.record.commitRef.knowledgeJournalSequence !== committed.sequence ||
				digestObject(event.record.commitRef.workflowEpochRef) !== digestObject(committed.epochRef) ||
				event.record.commitRef.knowledgeStoreEpoch !== committed.epochRef.storeEpoch
			)
				throw new Error("Knowledge record commit sequence is not bound to its authenticated workflow event.");
			state = reduceKnowledgeEvent(state, event);
		}
		return validateKnowledgeProjection(state);
	};
	const readAuthenticatedCommit = async (sequence: number): Promise<KnowledgeAuthenticatedCommitEvidence | null> => {
		if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Knowledge commit sequence is invalid.");
		if (sequence === 0) return null;
		const replay = await replayWorkflow();
		const committed = replay.events.find(
			(candidate) => candidate.sequence === sequence && candidate.payload.kind === "knowledge_record_committed",
		);
		return committed === undefined ? null : authenticatedCommitEvidence(committed);
	};
	const read = async (): Promise<{
		state: KnowledgeProjection;
		sequence: number;
		digest: string | null;
		projectionDigest: string | null;
		journalSequence: number;
		journalDigest: string | null;
	}> => {
		const state = await readState();
		const replay = await replayWorkflow();
		return {
			state,
			sequence: state.sequence,
			digest: replay.head.eventDigest,
			projectionDigest: state.digest,
			journalSequence: replay.head.sequence,
			journalDigest: replay.head.eventDigest,
		};
	};
	const commit = async (
		mutation: DurableStoreMutationRequest<KnowledgeEvent>,
	): Promise<
		DurableStoreCommitResult<KnowledgeProjection, KnowledgeEvent> & {
			projectionDigest: string;
			authenticatedCommit: KnowledgeAuthenticatedCommitEvidence;
		}
	> => {
		if (!authority.isSealed(mutation.semantic))
			throw new Error("Knowledge durable commits require the canonical KnowledgeStore authority.");
		validateKnowledgeEvent(mutation.semantic);
		if (
			mutation.semantic.idempotencyKey !== mutation.idempotencyKey ||
			mutation.expectedHead.workflowId !== workflowId ||
			digestObject(mutation.expectedHead.epochRef) !== digestObject(mutation.epochRef) ||
			mutation.semantic.record.commitRef.knowledgeJournalSequence !== mutation.expectedHead.sequence + 1 ||
			mutation.semantic.record.commitRef.knowledgeStoreId !== input.runtimeStore.identity.storeId ||
			mutation.semantic.record.commitRef.knowledgeJournalDigest !==
				digestObject({
					sequence: mutation.semantic.record.commitRef.knowledgeJournalSequence,
					storeId: mutation.semantic.record.commitRef.knowledgeStoreId,
					transactionDigest: mutation.semantic.record.commitRef.transactionDigest,
				})
		)
			throw new Error("Knowledge mutation idempotency and journal sequence bindings are invalid.");
		if (
			digestObject(mutation.semantic.record.commitRef.workflowEpochRef) !== digestObject(mutation.epochRef) ||
			mutation.semantic.record.commitRef.knowledgeStoreEpoch !== mutation.epochRef.storeEpoch ||
			digestObject(mutation.expectedHead.epochRef) !== digestObject(input.epochRef) ||
			digestObject(mutation.epochRef) !== digestObject(input.epochRef)
		)
			throw new Error("Knowledge mutation epoch is stale.");
		const priorReplay = await replayWorkflow();
		const historical = priorReplay.events.find((event) => event.idempotencyKey === mutation.idempotencyKey);
		if (historical !== undefined) {
			if (historical.payload.kind !== "knowledge_record_committed")
				throw new Error("Knowledge idempotency key is owned by a foreign workflow event.");
			if (
				digestObject(historical.expectedHead) !== digestObject(mutation.expectedHead) ||
				digestObject(historical.epochRef) !== digestObject(mutation.epochRef) ||
				digestObject(historical.leaseRef) !== digestObject(mutation.leaseRef) ||
				historical.writerIdentity !== mutation.writerIdentity ||
				historical.executionKey !== mutation.executionKey ||
				digestObject(historical.semanticBinding) !== digestObject(workflowKnowledgeBinding(mutation, workflowId))
			)
				throw new Error("Knowledge idempotency replay is not bound to the original authenticated tuple.");
			if (digestObject(historical.payload) !== digestObject(toWorkflowPayload(mutation.semantic)))
				throw new Error("Knowledge idempotency key conflicts with a different semantic event.");
			const event = fromWorkflowPayload(historical.payload);
			const state = await readState();
			const authenticatedCommit = authenticatedCommitEvidence(historical);
			await ensureMempalaceObligation(historical);
			return {
				sequence: historical.sequence,
				digest: historical.eventDigest,
				replayed: true,
				idempotencyConflict: false,
				authenticatedEventDigest: historical.eventDigest,
				postCommitExtension: null,
				state,
				event,
				head: priorReplay.head,
				projectionDigest: state.digest ?? digestObject(state),
				authenticatedCommit,
			};
		}
		if (digestObject(priorReplay.head) !== digestObject(mutation.expectedHead))
			throw new Error("Knowledge mutation expected head is stale.");
		const stateBefore = await readState();
		const expectedStateDigest = stateBefore.digest ?? digestObject(stateBefore);
		if (mutation.baselineDigest !== expectedStateDigest)
			throw new Error("Knowledge mutation baseline is not bound to the workflow projection.");
		if (!authority.isSealed(mutation.semantic))
			throw new Error("Knowledge durable commits require the canonical KnowledgeStore authority.");
		const payload = toWorkflowPayload(mutation.semantic);
		authority.authorizePayload(payload);
		const result = await input.runtimeStore.commit({
			workflowId,
			payload,
			expectedHead: mutation.expectedHead,
			semanticBinding: workflowKnowledgeBinding(mutation, workflowId),
			epochRef: mutation.epochRef,
			leaseRef: mutation.leaseRef,
			idempotencyKey: mutation.idempotencyKey,
			writerIdentity: mutation.writerIdentity,
			executionKey: mutation.executionKey,
			crashHook: mutation.crashHook,
		});
		if (
			result.commit.idempotencyKey !== mutation.idempotencyKey ||
			result.commit.semanticBinding.ownerId !== "knowledge" ||
			result.commit.semanticBinding.phase !== "planning" ||
			result.commit.semanticBinding.idempotencyKey !== mutation.idempotencyKey ||
			digestObject(result.commit.semanticBinding.expectedHead) !== digestObject(mutation.expectedHead) ||
			digestObject(result.commit.payload) !== digestObject(payload)
		)
			throw new Error("Workflow authority returned a mismatched knowledge payload.");
		const event = fromWorkflowPayload(result.commit.payload);
		validateKnowledgeEvent(event);
		if (event.record.commitRef.knowledgeJournalSequence !== result.commit.sequence)
			throw new Error("Workflow authority returned an unbound knowledge sequence.");
		await ensureMempalaceObligation(result.commit);
		const state = await readState();
		const authenticatedCommit = authenticatedCommitEvidence(result.commit);
		return {
			sequence: result.commit.sequence,
			digest: result.commit.eventDigest,
			replayed: result.status === "already_committed",
			idempotencyConflict: false,
			authenticatedEventDigest: result.commit.eventDigest,
			postCommitExtension: null,
			state,
			event,
			head: result.head,
			projectionDigest: state.digest ?? digestObject(state),
			authenticatedCommit,
		};
	};
	const recover = async (): Promise<DurableStoreRecoveryResult> => {
		const result = await input.runtimeStore.replay({
			workflowId,
			fromSequence: 1,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		const source = {
			artifactRef: null,
			relativePath: "workflow-runtime",
			digest: result.head.eventDigest,
			sizeBytes: result.events.reduce((size, event) => size + event.payloadBytes.byteLength, 0),
		};
		return {
			status: result.quarantined ? "quarantined" : "healthy",
			metadata: {
				source,
				epochRef: result.head.epochRef,
				reconciliation: null,
				quarantine: result.quarantined
					? {
							reason: result.quarantineReason ?? "invalid_frame",
							source,
							epochRef: result.head.epochRef,
							eventSequence: null,
						}
					: null,
			},
		};
	};
	const replaySafe = async (): Promise<readonly KnowledgeEvent[]> => {
		const rawEvents = await replayCanonical();
		let state = knowledgeProjection(input.namespace);
		for (const event of rawEvents) state = reduceKnowledgeEvent(state, event);
		const retracted = new Map(
			Object.values(state.records)
				.filter((record) => record.status === "retracted")
				.map((record) => [record.recordId, record] as const),
		);
		return freezeKnowledgeValue(
			rawEvents.map((event) => {
				const tombstoneRecord = retracted.get(event.record.recordId);
				if (tombstoneRecord === undefined) return event;
				const record = redactKnowledgeRecordForReplay(event.record, tombstoneRecord);
				const previous =
					event.previous === null ? null : redactKnowledgeRecordForHistory(event.previous, tombstoneRecord);
				return freezeKnowledgeValue({
					...event,
					record,
					previous,
					previousDigest: previous === null ? null : digestObject(previous),
					proposalDigest:
						record.tombstone === undefined
							? digestObject(knowledgeProposalFromRecord(record))
							: record.tombstone.proposalDigest,
				});
			}),
		);
	};
	const baseIdentity = input.runtimeStore.identity;
	const durable = {
		storeId: baseIdentity.storeId,
		namespace: input.namespace,
		workflowId,
		epochRef: Object.freeze({ ...input.epochRef }),
		generationId: context.generationId,
		currentLeaseRef: () => context.currentLeaseRef(),
		kernelVersion: 1,
		journalInstanceId: baseIdentity.identityDigest,
		leaseInstanceId: baseIdentity.identityDigest,
		snapshotInstanceId: baseIdentity.identityDigest,
		reducerInstanceId: digestObject("knowledge-reducer-v1"),
		mempalaceOutbox,
		read,
		commit,
		replay: replaySafe,
		recover,
		readAuthenticatedCommit,
	};
	authority = bindKnowledgeDurableAuthority({
		durableStore: durable,
		runtimeStore: input.runtimeStore,
		context,
		workflowId,
		epochRef: input.epochRef,
		generationId: context.generationId,
		replayCanonical,
	});
	if (mempalaceOutbox === undefined) {
		mempalaceOutbox = new KnowledgeDurableMempalaceOutbox(context, input.runtimeStore, authority.writeAuxiliary);
		durable.mempalaceOutbox = mempalaceOutbox;
	}
	return Object.freeze(durable) as KnowledgeDurableStore;
}
