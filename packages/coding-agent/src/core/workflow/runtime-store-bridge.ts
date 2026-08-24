import { createHmac } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	consumeWorkflowKnowledgePayload,
	registerWorkflowKnowledgeRuntimeAuthority,
} from "../knowledge/knowledge-runtime-authority.js";
import type {
	DurableStoreCrashBoundaryHook,
	WorkflowArtifactPublisher,
	WorkflowArtifactPublishInput,
	WorkflowArtifactPublishResult,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowJournalCommit,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowKnowledgeEventPayload,
	WorkflowLearningPromotionAuxiliaryStore,
	WorkflowLearningPromotionDurableContext,
	WorkflowOutboxAppender,
	WorkflowOutboxAppendInput,
	WorkflowOutboxAppendResult,
	WorkflowProjectionAdapter,
	WorkflowProjectionCasInput,
	WorkflowProjectionCasResult,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreDurableContext,
	WorkflowRuntimeStoreIdentity,
	WorkflowSnapshotPublisher,
	WorkflowSnapshotPublishInput,
	WorkflowSnapshotPublishResult,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
	WorkflowStoreReplayInput,
	WorkflowStoreReplayResult,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "./contracts.js";
import type { WorkflowJournal } from "./journal.js";
import { WorkflowJournalImpl } from "./journal.js";
import type { WorkflowQuarantineReason } from "./recovery.js";
import {
	reduceWorkflowEvent,
	validateWorkflowDeferredEventOwner,
	type WorkflowState,
	type WorkflowStore,
} from "./reducer.js";

type WorkflowLogicalHistoryJournal = WorkflowJournal & {
	replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]>;
};

type WorkflowDurableJournal = WorkflowJournalImpl & {
	replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]>;
};

export interface WorkflowRuntimeStoreBridgeDependencies {
	store: WorkflowStore;
	journal: WorkflowLogicalHistoryJournal;
	artifactPublisher: WorkflowArtifactPublisher;
	snapshotPublisher: WorkflowSnapshotPublisher;
	outboxAppender: WorkflowOutboxAppender;
	projectionAdapter: WorkflowProjectionAdapter;
	readHead: () => Promise<WorkflowJournalHead>;
}

interface ReadCommittedEventResult {
	event: WorkflowJournalEvent;
	events: readonly WorkflowJournalEvent[];
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function workflowHeadFromEvents(
	workflowId: string,
	fallbackEpoch: WorkflowEpochRef,
	events: readonly WorkflowJournalEvent[],
): WorkflowJournalHead {
	const tail = events.at(-1);
	if (tail !== undefined) toWorkflowJournalCommit(tail, tail.payload);
	return tail === undefined
		? { workflowId, sequence: 0, eventDigest: null, epochRef: fallbackEpoch }
		: {
				workflowId: tail.workflowId,
				sequence: tail.sequence,
				eventDigest: tail.eventDigest,
				epochRef:
					tail.payload.kind === "store_generation_fenced" || tail.payload.kind === "coordinator_epoch_fenced"
						? tail.payload.nextEpoch
						: tail.epochRef,
			};
}

function assertReplayHeadMatchesJournalTail(
	head: WorkflowJournalHead,
	workflowId: string,
	events: readonly WorkflowJournalEvent[],
): void {
	const journalHead = workflowHeadFromEvents(workflowId, head.epochRef, events);
	if (
		head.workflowId !== workflowId ||
		head.workflowId !== journalHead.workflowId ||
		head.sequence !== journalHead.sequence ||
		head.eventDigest !== journalHead.eventDigest ||
		digestObject(head.epochRef) !== digestObject(journalHead.epochRef)
	)
		throw new Error("The injected workflow head does not match the authenticated journal replay tail.");
}

function toWorkflowJournalCommit<TPayload extends WorkflowEventPayload>(
	event: WorkflowJournalEvent,
	payload: TPayload,
): WorkflowJournalCommit<TPayload> {
	const payloadBytes = canonicalJsonBytes(payload);
	const committedPayloadBytes = canonicalJsonBytes(event.payload);
	if (
		event.kind !== payload.kind ||
		event.payloadDigest !== digestObject(event.payload) ||
		!bytesEqual(event.payloadBytes, committedPayloadBytes) ||
		event.payloadDigest !== digestObject(payload) ||
		!bytesEqual(event.payloadBytes, payloadBytes)
	)
		throw new Error("The bridge received an unauthenticated or mismatched committed payload.");
	return {
		workflowId: event.workflowId,
		sequence: event.sequence,
		payload,
		payloadBytes: event.payloadBytes,
		payloadDigest: event.payloadDigest,
		priorEventDigest: event.priorEventDigest,
		eventDigest: event.eventDigest,
		recordVersion: event.recordVersion,
		generationId: event.generationId,
		recordMac: event.recordMac,
		recordChecksum: event.recordChecksum,
		expectedHead: event.expectedHead,
		epochRef: event.epochRef,
		leaseRef: event.leaseRef,
		idempotencyKey: event.idempotencyKey,
		returnProofId: event.returnProofId,
		commitReturnProof: event.commitReturnProof,
		preparedFrameDigest: event.preparedFrameDigest,
		committedFrameDigest: event.committedFrameDigest,
		keyId: event.keyId,
		preparedFrameMac: event.preparedFrameMac,
		committedFrameMac: event.committedFrameMac,
		preparedFrameChecksum: event.preparedFrameChecksum,
		committedFrameChecksum: event.committedFrameChecksum,
		semanticBinding: event.semanticBinding,
		executionKey: event.executionKey,
		writerIdentity: event.writerIdentity,
	};
}

function assertCommitReturnProof(event: WorkflowJournalEvent): void {
	const proof = event.commitReturnProof;
	const { proofDigest: _proofDigest, ...proofWithoutDigest } = proof;
	const legacyProofDigest = digestObject({ ...proof, proofDigest: "" });
	if (
		proof.recordVersion !== event.recordVersion ||
		proof.generationId !== event.generationId ||
		proof.workflowId !== event.workflowId ||
		proof.mutationId !== event.returnProofId ||
		proof.sequence !== event.sequence ||
		proof.eventDigest !== event.eventDigest ||
		proof.committedFrameDigest !== event.committedFrameDigest ||
		digestObject(proof.expectedHead) !== digestObject(event.expectedHead) ||
		digestObject(proof.epochRef) !== digestObject(event.epochRef) ||
		digestObject(proof.leaseRef) !== digestObject(event.leaseRef) ||
		proof.writerIdentity !== event.writerIdentity ||
		proof.idempotencyKey !== event.idempotencyKey ||
		proof.keyId !== event.keyId ||
		proof.frameMac !== event.committedFrameMac ||
		proof.frameChecksum !== event.committedFrameChecksum ||
		proof.recordMac !== event.recordMac ||
		proof.recordChecksum !== event.recordChecksum ||
		proof.priorRecordDigest !== event.priorEventDigest ||
		(proof.proofDigest !== digestObject(proofWithoutDigest) && proof.proofDigest !== legacyProofDigest)
	)
		throw new Error("The reducer state is not backed by the authenticated journal event.");
}

interface WorkflowAuxiliaryEnvelope {
	version: 1;
	name: string;
	workflowId: string;
	generationId: string;
	epochRef: WorkflowEpochRef;
	payload: readonly number[];
	payloadDigest: string;
	keyId: string;
	mac: string;
}

const AUXILIARY_FILE_VERSION = 1 as const;
const MAX_AUXILIARY_BYTES = 1_000_000;

function assertAuxiliaryName(name: string): void {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error("Workflow auxiliary record name is invalid.");
}

function auxiliaryMac(value: Omit<WorkflowAuxiliaryEnvelope, "mac">, secret: Uint8Array): string {
	return createHmac("sha256", secret).update(canonicalJsonBytes(value)).digest("hex");
}

function isAuxiliaryEnvelope(value: unknown): value is WorkflowAuxiliaryEnvelope {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		Object.keys(candidate).every((key) =>
			[
				"version",
				"name",
				"workflowId",
				"generationId",
				"epochRef",
				"payload",
				"payloadDigest",
				"keyId",
				"mac",
			].includes(key),
		) &&
		candidate.version === AUXILIARY_FILE_VERSION &&
		typeof candidate.name === "string" &&
		typeof candidate.workflowId === "string" &&
		typeof candidate.generationId === "string" &&
		candidate.epochRef !== null &&
		typeof candidate.epochRef === "object" &&
		!Array.isArray(candidate.epochRef) &&
		typeof (candidate.epochRef as { storeEpoch?: unknown }).storeEpoch === "number" &&
		typeof (candidate.epochRef as { coordinatorEpoch?: unknown }).coordinatorEpoch === "number" &&
		Array.isArray(candidate.payload) &&
		(candidate.payload as unknown[]).every(
			(byte) => Number.isSafeInteger(byte) && (byte as number) >= 0 && (byte as number) <= 255,
		) &&
		typeof candidate.payloadDigest === "string" &&
		typeof candidate.keyId === "string" &&
		/^[0-9a-f]{64}$/.test(String(candidate.mac))
	);
}

function isWorkflowDurableJournal(journal: WorkflowJournal): journal is WorkflowDurableJournal {
	return journal instanceof WorkflowJournalImpl;
}

interface WorkflowRuntimeDurableContextBundle {
	context: WorkflowLearningPromotionDurableContext;
	writeAuxiliary: (name: string, bytes: Readonly<Uint8Array>) => Promise<void>;
}

function createWorkflowRuntimeStoreDurableContext(
	journal: WorkflowDurableJournal,
	outbox: WorkflowOutboxAppender,
): WorkflowRuntimeDurableContextBundle {
	const writeAuxiliary = async (name: string, bytes: Readonly<Uint8Array>): Promise<void> => {
		assertAuxiliaryName(name);
		if (bytes.byteLength > MAX_AUXILIARY_BYTES) throw new Error("Workflow auxiliary record is too large.");
		const epochRef = { ...journal.options.epoch };
		const key = await journal.options.keyProvider.current(journal.options.workflowId, epochRef);
		const unsigned: Omit<WorkflowAuxiliaryEnvelope, "mac"> = {
			version: AUXILIARY_FILE_VERSION,
			name,
			workflowId: journal.options.workflowId,
			generationId: journal.descriptorContext.generationId,
			epochRef,
			payload: [...bytes],
			payloadDigest: sha256Hex(bytes),
			keyId: key.keyId,
		};
		const encoded = canonicalJsonBytes({ ...unsigned, mac: auxiliaryMac(unsigned, key.secret) });
		const handle = await journal.descriptorContext.descriptorFs.openAt(
			journal.descriptorContext.workflow,
			name,
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
		try {
			await handle.write(encoded);
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	const auxiliaryStore: WorkflowLearningPromotionAuxiliaryStore = {
		read: async (name) => {
			assertAuxiliaryName(name);
			let handle: Awaited<ReturnType<typeof journal.descriptorContext.descriptorFs.openAt>>;
			try {
				handle = await journal.descriptorContext.descriptorFs.openAt(
					journal.descriptorContext.workflow,
					name,
					fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw error;
			}
			try {
				const bytes = await handle.read();
				if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUXILIARY_BYTES) {
					throw new Error("Workflow auxiliary record is empty or too large.");
				}
				const parsed = parseCanonicalJsonBytes(bytes);
				if (
					!isAuxiliaryEnvelope(parsed) ||
					parsed.name !== name ||
					parsed.workflowId !== journal.options.workflowId
				)
					throw new Error("Workflow auxiliary record is malformed.");
				if (parsed.generationId !== journal.descriptorContext.generationId)
					throw new Error("Workflow auxiliary record belongs to a different generation.");
				if (digestObject(parsed.epochRef) !== digestObject(journal.options.epoch))
					throw new Error("Workflow auxiliary record belongs to a different epoch.");
				const payload = Uint8Array.from(parsed.payload);
				if (payload.byteLength > MAX_AUXILIARY_BYTES || sha256Hex(payload) !== parsed.payloadDigest)
					throw new Error("Workflow auxiliary record payload digest is invalid.");
				const key = await journal.options.keyProvider.resolve(
					journal.options.workflowId,
					parsed.keyId,
					parsed.epochRef,
				);
				const unsigned: Omit<WorkflowAuxiliaryEnvelope, "mac"> = {
					version: parsed.version,
					name: parsed.name,
					workflowId: parsed.workflowId,
					generationId: parsed.generationId,
					epochRef: parsed.epochRef,
					payload: parsed.payload,
					payloadDigest: parsed.payloadDigest,
					keyId: parsed.keyId,
				};
				if (parsed.mac !== auxiliaryMac(unsigned, key.secret))
					throw new Error("Workflow auxiliary record authentication failed.");
				return payload;
			} finally {
				await handle.close();
			}
		},
		write: async (name, bytes) => {
			if (name === "knowledge-mempalace-acks.json")
				throw new Error("Knowledge MemPalace acknowledgements require the canonical knowledge outbox authority.");
			await writeAuxiliary(name, bytes);
		},
		remove: async (name, expectedBytesDigest) => {
			assertAuxiliaryName(name);
			if (!/^[0-9a-f]{64}$/.test(expectedBytesDigest))
				throw new Error("Workflow auxiliary delete CAS digest is invalid.");
			if (name === "knowledge-mempalace-acks.json")
				throw new Error("Knowledge MemPalace acknowledgements require the canonical knowledge outbox authority.");
			const current = await auxiliaryStore.read(name);
			if (current === null) throw new Error("Workflow auxiliary delete target is absent.");
			if (sha256Hex(current) !== expectedBytesDigest)
				throw new Error("Workflow auxiliary delete target failed its authenticated CAS check.");
			await journal.descriptorContext.descriptorFs.unlinkAt(journal.descriptorContext.workflow, name);
			await journal.descriptorContext.descriptorFs.syncDirectoryChain(
				journal.descriptorContext.workflow,
				journal.descriptorContext.root,
			);
		},
	};
	return {
		writeAuxiliary,
		context: {
			generationId: journal.descriptorContext.generationId,
			epochRef: { ...journal.options.epoch },
			currentLeaseRef: () => journal.currentLeaseRef(),
			outbox,
			auxiliaryStore,
			withExclusiveLease: (boundary, operation) =>
				journal.options.appendLease.withExclusiveGuard(
					{
						workflowId: journal.options.workflowId,
						writerIdentity: journal.options.writerIdentity,
						leaseRef: journal.currentLeaseRef(),
						epochRef: journal.options.epoch,
						rootDigest: journal.descriptorContext.rootDigest,
						boundary,
					},
					operation,
				),
			recoverJournal: () => journal.recover(),
		},
	};
}

async function readCommittedEvent<TPayload extends WorkflowEventPayload>(
	dependencies: WorkflowRuntimeStoreBridgeDependencies,
	input: WorkflowStoreCommitInput<TPayload>,
	state: WorkflowState | null,
): Promise<ReadCommittedEventResult> {
	const events = await dependencies.journal.replayLogicalHistory();
	const event =
		events.find(
			(candidate) => candidate.workflowId === input.workflowId && candidate.idempotencyKey === input.idempotencyKey,
		) ??
		(state === null
			? undefined
			: events.find(
					(candidate) =>
						candidate.workflowId === input.workflowId && candidate.sequence === state.sourceJournalSequence,
				));
	const expectedHead = input.expectedHead;
	const eventHeadMatches =
		event !== undefined &&
		event.expectedHead.workflowId === expectedHead.workflowId &&
		event.expectedHead.sequence === expectedHead.sequence &&
		event.expectedHead.eventDigest === expectedHead.eventDigest &&
		digestObject(event.expectedHead.epochRef) === digestObject(expectedHead.epochRef);
	const historicalRetry =
		event !== undefined &&
		event.idempotencyKey === input.idempotencyKey &&
		(state === null || event.sequence !== state.sourceJournalSequence);
	if (
		!event ||
		(!historicalRetry &&
			state !== null &&
			(event.eventDigest !== state.sourceJournalDigest || event.sequence !== state.sourceJournalSequence)) ||
		(!historicalRetry && event.sequence !== expectedHead.sequence + 1) ||
		event.workflowId !== input.workflowId ||
		!eventHeadMatches ||
		event.priorEventDigest !== expectedHead.eventDigest ||
		event.idempotencyKey !== input.idempotencyKey ||
		event.returnProofId !== `return-proof:${input.idempotencyKey}` ||
		event.writerIdentity !== input.writerIdentity ||
		event.executionKey !== input.executionKey ||
		digestObject(event.epochRef) !== digestObject(input.epochRef) ||
		digestObject(event.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(event.semanticBinding) !== digestObject(input.semanticBinding) ||
		event.recordVersion !== 1 ||
		event.generationId.length === 0 ||
		event.keyId.length === 0 ||
		event.preparedFrameDigest.length === 0 ||
		event.committedFrameDigest.length === 0 ||
		event.preparedFrameMac.length === 0 ||
		event.committedFrameMac.length === 0 ||
		event.preparedFrameChecksum.length === 0 ||
		event.committedFrameChecksum.length === 0 ||
		event.recordMac.length === 0 ||
		event.recordChecksum.length === 0
	)
		throw new Error("The reducer state is not backed by the authenticated journal event.");
	assertCommitReturnProof(event);
	return { event, events };
}

export class WorkflowRuntimeStoreBridge implements WorkflowRuntimeStore {
	readonly identity: WorkflowRuntimeStoreIdentity;
	readonly durableContext: WorkflowRuntimeStoreDurableContext | undefined;

	private constructor(private readonly dependencies: WorkflowRuntimeStoreBridgeDependencies) {
		const storeIdentity = dependencies.store.identity;
		const identity = {
			storeKind: storeIdentity.storeKind,
			namespace: storeIdentity.namespace,
			rootDir: storeIdentity.rootDir,
			storeId: storeIdentity.storeId,
			workflowId: storeIdentity.workflowId,
		} satisfies Omit<WorkflowRuntimeStoreIdentity, "identityDigest">;
		if (
			dependencies.store.journal !== dependencies.journal ||
			digestObject(identity) !== storeIdentity.identityDigest
		)
			throw new Error(
				"Runtime store bridge dependencies are not the same authenticated kind, namespace, root, store, and workflow identity.",
			);
		this.identity = { ...identity, identityDigest: digestObject(identity) };
		const durableBundle = isWorkflowDurableJournal(dependencies.journal)
			? createWorkflowRuntimeStoreDurableContext(dependencies.journal, dependencies.outboxAppender)
			: undefined;
		this.durableContext = durableBundle?.context;
		if (durableBundle !== undefined)
			registerWorkflowKnowledgeRuntimeAuthority(this, durableBundle.context, durableBundle.writeAuxiliary);
	}

	static compose(dependencies: WorkflowRuntimeStoreBridgeDependencies): WorkflowRuntimeStoreBridge {
		return new WorkflowRuntimeStoreBridge(dependencies);
	}

	async commit<TPayload extends WorkflowEventPayload>(
		input: WorkflowStoreCommitInput<TPayload>,
	): Promise<WorkflowStoreCommitResult<TPayload>> {
		if (input.payload.kind === "knowledge_record_committed") {
			if (!consumeWorkflowKnowledgePayload(this, input.payload))
				throw new Error("Knowledge records require the canonical KnowledgeStore authority.");
			return this.#commitKnowledge(
				input as unknown as WorkflowStoreCommitInput<WorkflowKnowledgeEventPayload>,
			) as Promise<WorkflowStoreCommitResult<TPayload>>;
		}
		const before = this.dependencies.store.snapshot();
		const state = await this.dependencies.store.commit(input.payload, {
			expectedSourceJournalDigest: input.expectedHead.sequence === 0 ? null : input.expectedHead.eventDigest,
			expectedHead: input.expectedHead,
			expectedEpoch: input.epochRef,
			leaseRef: input.leaseRef,
			idempotencyKey: input.idempotencyKey,
			writerIdentity: input.writerIdentity,
			executionKey: input.executionKey,
			semanticBinding: input.semanticBinding,
			crashHook: input.crashHook,
		});
		const { event, events } = await readCommittedEvent(this.dependencies, input, state);
		const commit = toWorkflowJournalCommit(event, input.payload);
		const head = workflowHeadFromEvents(input.workflowId, input.expectedHead.epochRef, events);
		return {
			status:
				before?.sourceJournalSequence === state.sourceJournalSequence &&
				before?.sourceJournalDigest === state.sourceJournalDigest
					? "already_committed"
					: "committed",
			payload: input.payload,
			commit,
			state,
			head,
		};
	}

	async #commitKnowledge(
		input: WorkflowStoreCommitInput<WorkflowKnowledgeEventPayload>,
	): Promise<WorkflowStoreCommitResult<WorkflowKnowledgeEventPayload>> {
		const durableContext = this.durableContext;
		if (
			durableContext === undefined ||
			input.workflowId !== this.identity.workflowId ||
			input.expectedHead.workflowId !== this.identity.workflowId ||
			input.payload.kind !== "knowledge_record_committed"
		)
			throw new Error("Knowledge authority accepts only knowledge record events.");
		const currentLease = durableContext.currentLeaseRef();
		if (
			digestObject(input.epochRef) !== digestObject(durableContext.epochRef) ||
			digestObject(input.leaseRef) !== digestObject(currentLease) ||
			input.leaseRef.writerIdentity !== input.writerIdentity ||
			input.semanticBinding.ownerId !== "knowledge" ||
			input.semanticBinding.phase !== "planning" ||
			input.semanticBinding.reducerDigest !== digestObject("knowledge-reducer-v1") ||
			input.semanticBinding.idempotencyKey !== input.idempotencyKey ||
			digestObject(input.semanticBinding.expectedHead) !== digestObject(input.expectedHead) ||
			digestObject(input.semanticBinding.epochRef) !== digestObject(input.epochRef) ||
			digestObject(input.semanticBinding.leaseRef) !== digestObject(input.leaseRef) ||
			input.semanticBinding.writerIdentity !== input.writerIdentity ||
			input.semanticBinding.executionKey !== input.executionKey ||
			input.semanticBinding.semanticHead.workflowId !== input.workflowId ||
			input.semanticBinding.semanticHead.sequence !== input.expectedHead.sequence ||
			input.semanticBinding.semanticHead.eventDigest !== input.expectedHead.eventDigest ||
			digestObject(input.semanticBinding.semanticHead.epochRef) !== digestObject(input.epochRef) ||
			input.semanticBinding.semanticHead.stateDigest !== input.semanticBinding.baselineDigest
		)
			throw new Error("Knowledge authority semantic binding is not owned by the canonical host.");
		const before = this.dependencies.store.snapshot();
		const priorEvents = await this.dependencies.journal.replayLogicalHistory();
		const currentHead = await this.dependencies.readHead();
		if (digestObject(currentHead) !== digestObject(input.expectedHead))
			throw new Error("Knowledge authority expected head is stale.");
		const alreadyCommitted = priorEvents.some(
			(event) => event.workflowId === input.workflowId && event.idempotencyKey === input.idempotencyKey,
		);
		const event = await this.dependencies.journal.append({
			...input,
			returnProofId: `return-proof:${input.idempotencyKey}`,
		});
		const state =
			before === null || alreadyCommitted
				? before
				: reduceWorkflowEvent(before, event.payload, event, this.dependencies.store.deferredValidators);
		if (state !== null) this.dependencies.store.state = state;
		const { event: committedEvent, events } = await readCommittedEvent(this.dependencies, input, state);
		const commit = toWorkflowJournalCommit(committedEvent, input.payload);
		const head = workflowHeadFromEvents(input.workflowId, input.expectedHead.epochRef, events);
		return {
			status: alreadyCommitted ? "already_committed" : "committed",
			payload: input.payload,
			commit,
			state,
			head,
		};
	}

	async replay(input: WorkflowStoreReplayInput): Promise<WorkflowStoreReplayResult> {
		let replayed: readonly WorkflowJournalEvent[] = [];
		let head: WorkflowJournalHead | undefined;
		let lastReplayError: unknown;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			replayed = await this.dependencies.journal.replayLogicalHistory();
			head = await this.dependencies.readHead();
			try {
				assertReplayHeadMatchesJournalTail(head, input.workflowId, replayed);
				lastReplayError = undefined;
				break;
			} catch (error) {
				lastReplayError = error;
			}
		}
		if (lastReplayError !== undefined) throw lastReplayError;
		if (head === undefined) throw new Error("Workflow runtime replay did not produce an authenticated head.");
		const scoped = replayed.filter((event) => event.workflowId === input.workflowId);
		for (const event of scoped)
			validateWorkflowDeferredEventOwner(event.payload, event, this.dependencies.store.deferredValidators);
		const hasFutureStoreEpoch = scoped.some(
			(event) =>
				event.epochRef.storeEpoch > head.epochRef.storeEpoch ||
				((event.payload.kind === "store_generation_fenced" || event.payload.kind === "coordinator_epoch_fenced") &&
					event.payload.nextEpoch.storeEpoch > head.epochRef.storeEpoch),
		);
		if (head.epochRef.storeEpoch !== input.expectedStoreEpoch || hasFutureStoreEpoch) {
			return {
				workflowId: input.workflowId,
				executionKey: null,
				events: [],
				head,
				quarantined: true,
				quarantineReason: "stale_epoch" satisfies WorkflowQuarantineReason,
			};
		}
		const events = scoped
			.filter((event) => event.sequence >= input.fromSequence)
			.map((event) => toWorkflowJournalCommit(event, event.payload));
		return {
			workflowId: input.workflowId,
			executionKey: scoped.at(-1)?.executionKey ?? null,
			events,
			head,
			quarantined: false,
			quarantineReason: null,
		};
	}

	publishArtifact(
		input: WorkflowArtifactPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowArtifactPublishResult> {
		return this.dependencies.artifactPublisher.publish(input, hook);
	}

	publishSnapshot(
		input: WorkflowSnapshotPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowSnapshotPublishResult> {
		return this.dependencies.snapshotPublisher.publish(input, hook);
	}

	compareAndSwapProjection(
		input: WorkflowProjectionCasInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowProjectionCasResult> {
		return this.dependencies.projectionAdapter.compareAndSwap(input, hook);
	}

	appendOutbox(
		input: WorkflowOutboxAppendInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowOutboxAppendResult> {
		return this.dependencies.outboxAppender.append(input, hook);
	}

	replaceCoordinatorEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> {
		return this.dependencies.store.replaceCoordinatorEpoch(nextEpoch, generationBinding);
	}

	replaceStoreEpoch(
		nextEpoch: WorkflowEpochRef,
		generationBinding: WorkflowGenerationBinding,
	): Promise<WorkflowGenerationRotation> {
		return this.dependencies.store.replaceStoreEpoch(nextEpoch, generationBinding);
	}
}
