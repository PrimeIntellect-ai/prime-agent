import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type {
	DurableStoreCrashBoundaryHook,
	WorkflowArtifactPublishInput,
	WorkflowArtifactRef,
	WorkflowAuthenticatedMutationTuple,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowJournalCommit,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOpaquePostCommitExtension,
	WorkflowOutboxAppendInput,
	WorkflowPhaseId,
	WorkflowProjectionCasInput,
	WorkflowRuntimeStore,
	WorkflowSemanticHead,
	WorkflowSnapshotPublishInput,
	WorkflowStoreCommitInput,
	WorkflowStoreReplayResult,
} from "./contracts.js";
import { DurableStoreCrashBoundary, digestObject, sha256Hex } from "./contracts.js";
import type { WorkflowJournalRecoveryResult } from "./journal.js";
import type { WorkflowQuarantineReason, WorkflowReconciliationOutcome, WorkflowRecoverySource } from "./recovery.js";

export const DURABLE_KERNEL_API_VERSION = 1 as const;

export interface DurableStoreQuarantineMetadata {
	reason: WorkflowQuarantineReason;
	source: WorkflowRecoverySource;
	epochRef: WorkflowEpochRef;
	eventSequence: number | null;
}

export interface DurableStoreRecoveryMetadata {
	source: WorkflowRecoverySource;
	epochRef: WorkflowEpochRef;
	reconciliation: WorkflowReconciliationOutcome | null;
	quarantine: DurableStoreQuarantineMetadata | null;
}

export interface DurableStoreRecoveryResult {
	status: "healthy" | "recovered" | "quarantined" | "blocked";
	metadata: DurableStoreRecoveryMetadata;
}

export interface DurableStoreMutationRequest<TSemantic> {
	mutationId: string;
	semantic: TSemantic;
	idempotencyKey: string;
	expectedHead: WorkflowJournalHead;
	baselineDigest: string;
	expectedGenerations: Readonly<Record<string, number>>;
	writerIdentity: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
	executionKey: string | null;
	crashHook?: DurableStoreCrashBoundaryHook;
}

export type DurableStorePostCommitExtension = WorkflowOpaquePostCommitExtension;

export interface DurableStoreMutationFrame<TEvent> {
	binding: DurableStoreSemanticBinding;
	preparedEvent: TEvent;
	committedEvent: TEvent;
	artifactPublishes: readonly WorkflowArtifactPublishInput[];
	snapshot: WorkflowSnapshotPublishInput | null;
	projection: WorkflowProjectionCasInput | null;
	outbox: WorkflowOutboxAppendInput | null;
	postCommitExtension: DurableStorePostCommitExtension | null;
}

export interface DurableStoreSemanticBinding {
	mutationId: string;
	baselineDigest: string;
	expectedGenerations: Readonly<Record<string, number>>;
	ownerId: string;
	phase: WorkflowPhaseId;
	reducerDigest: string;
	semanticHead: WorkflowSemanticHead;
	expectedHead: WorkflowJournalHead;
	idempotencyKey: string;
	executionKey: string | null;
	writerIdentity: string;
	leaseRef: WorkflowLeaseRef;
	epochRef: WorkflowEpochRef;
}

export interface DurableStoreTransitionPreview<TEvent> {
	nextState: TEvent;
	previewDigest: string;
	semanticHead: WorkflowSemanticHead;
}

export type WorkflowTransitionPreview<TEvent> = DurableStoreTransitionPreview<TEvent>;

export interface DurableStoreEventCodec<TEvent> {
	encode(event: TEvent): Uint8Array;
	decode(bytes: Uint8Array): TEvent;
	validate(event: TEvent): void;
	toWorkflowEvent(event: TEvent): WorkflowEventPayload;
	fromWorkflowEvent(event: WorkflowEventPayload): TEvent;
}

export interface DurableStoreCommitPhaseAdapter<TEvent> {
	readonly eventType?: TEvent;
	validatePostCommitExtension(
		extension: DurableStorePostCommitExtension,
		authenticatedCommit: WorkflowJournalCommit<WorkflowEventPayload>,
	): void;
	classify(extension: DurableStorePostCommitExtension | null): "precommit" | "postcommit";
}

export function createDurableStoreCommitPhaseAdapter<TEvent>(): DurableStoreCommitPhaseAdapter<TEvent> {
	return {
		validatePostCommitExtension: (extension, authenticatedCommit) => {
			if (
				extension.namespace.length === 0 ||
				extension.digest.length === 0 ||
				extension.opaqueBytes.byteLength === 0 ||
				authenticatedCommit.eventDigest.length === 0
			)
				throw new Error("Opaque post-commit extension is not authenticated by the workflow commit.");
		},
		classify: (extension) => (extension === null ? "precommit" : "postcommit"),
	};
}

export interface DurableStoreMutationBuilder<TSemantic, TEvent> {
	preview(
		input: DurableStoreMutationRequest<TSemantic>,
		current: { head: WorkflowSemanticHead; state: unknown },
	): DurableStoreTransitionPreview<TEvent>;
	build(input: DurableStoreMutationRequest<TSemantic>): DurableStoreMutationFrame<TEvent>;
}

export interface DurableStoreOwnerValidator<TSemantic, TEvent> {
	validateSemanticPreflight(
		input: DurableStoreMutationRequest<TSemantic>,
		current: { head: WorkflowSemanticHead; state: unknown },
	): void;
	validateFrame(frame: DurableStoreMutationFrame<TEvent>): void;
	validateReplay(event: WorkflowJournalCommit<WorkflowEventPayload>): void;
}

export interface DurableStoreAuthenticatedKernel<TEvent> {
	rootDir: string;
	namespace: string;
	storeId: string;
	workflowId: string;
	storeKind: "workflow" | "knowledge";
	runtimeStore: WorkflowRuntimeStore;
	readHead(): Promise<WorkflowJournalHead>;
	readSemanticHead(): Promise<WorkflowSemanticHead>;
	readGenerations(): Promise<Readonly<Record<string, number>>>;
	eventCodec: DurableStoreEventCodec<TEvent>;
	phaseAdapter: DurableStoreCommitPhaseAdapter<TEvent>;
	prepareDependentPublications(input: {
		mutation: DurableStoreMutationRequest<unknown>;
		frame: DurableStoreMutationFrame<TEvent>;
		expectedHead: WorkflowJournalHead;
		eventDigest: string;
	}): Promise<void>;
	finalizeDependentPublications(input: {
		mutation: DurableStoreMutationRequest<unknown>;
		frame: DurableStoreMutationFrame<TEvent>;
		commit: WorkflowJournalCommit<WorkflowEventPayload>;
		tuple: WorkflowAuthenticatedMutationTuple;
		crashHook?: DurableStoreCrashBoundaryHook;
	}): Promise<void>;
	commitSemanticMutation<TSemantic>(input: {
		mutation: DurableStoreMutationRequest<TSemantic>;
		frame: DurableStoreMutationFrame<TEvent>;
		authenticatedBinding: DurableStoreSemanticBinding;
		crashHook?: DurableStoreCrashBoundaryHook;
	}): Promise<{
		commit: WorkflowJournalCommit<WorkflowEventPayload>;
		head: WorkflowJournalHead;
		postCommitExtension: DurableStorePostCommitExtension | null;
	}>;
	replay(): Promise<readonly WorkflowJournalCommit<WorkflowEventPayload>[]>;
	recover(): Promise<DurableStoreRecoveryResult>;
}

export interface DurableStoreDependentPublicationPort<TEvent> {
	prepare(input: {
		mutation: DurableStoreMutationRequest<unknown>;
		frame: DurableStoreMutationFrame<TEvent>;
		expectedHead: WorkflowJournalHead;
		eventDigest: string;
	}): Promise<void>;
	finalize(input: {
		mutation: DurableStoreMutationRequest<unknown>;
		frame: DurableStoreMutationFrame<TEvent>;
		commit: WorkflowJournalCommit<WorkflowEventPayload>;
		tuple: WorkflowAuthenticatedMutationTuple;
		crashHook?: DurableStoreCrashBoundaryHook;
	}): Promise<void>;
}

export interface DurableStoreFactoryOptions<TEvent, TProjection, TSemantic = TEvent> {
	storeId: string;
	storeKind: "workflow" | "knowledge";
	namespace: string;
	rootDir: string;
	initialState: TProjection;
	reduce: (state: TProjection, event: TEvent) => TProjection;
	mutationBuilder: DurableStoreMutationBuilder<TSemantic, TEvent>;
	ownerValidator: DurableStoreOwnerValidator<TSemantic, TEvent>;
	authenticatedKernel: DurableStoreAuthenticatedKernel<TEvent>;
	eventCodec: DurableStoreEventCodec<TEvent>;
	phaseAdapter: DurableStoreCommitPhaseAdapter<TEvent>;
	publicationPort: DurableStoreDependentPublicationPort<TEvent>;
}

export type DurableStoreCommitResult<TProjection = unknown, TEvent = unknown> = {
	sequence: number;
	digest: string;
	replayed: boolean;
	idempotencyConflict: boolean;
	authenticatedEventDigest: string;
	postCommitExtension: DurableStorePostCommitExtension | null;
	state: TProjection;
	event: TEvent;
	head: WorkflowJournalHead;
};

export interface DurableStoreInstance<TEvent, TProjection, TSemantic = TEvent> {
	readonly storeId: string;
	readonly namespace: string;
	readonly kernelVersion: number;
	readonly journalInstanceId: string;
	readonly leaseInstanceId: string;
	readonly snapshotInstanceId: string;
	readonly reducerInstanceId: string;
	read(): Promise<{ state: TProjection; sequence: number; digest: string | null }>;
	commit(input: DurableStoreMutationRequest<TSemantic>): Promise<DurableStoreCommitResult<TProjection, TEvent>>;
	replay(): Promise<readonly TEvent[]>;
	recover(): Promise<DurableStoreRecoveryResult>;
}

export interface DurableStoreFactory {
	create<TEvent, TProjection, TSemantic = TEvent>(
		options: DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>,
	): DurableStoreInstance<TEvent, TProjection, TSemantic>;
	createWorkflow<TEvent, TProjection, TSemantic = TEvent>(
		options: Omit<DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>, "storeKind">,
	): DurableStoreInstance<TEvent, TProjection, TSemantic>;
	createKnowledge<TEvent, TProjection, TSemantic = TEvent>(
		options: Omit<DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>, "storeKind">,
	): DurableStoreInstance<TEvent, TProjection, TSemantic>;
}

export function createDurableStoreFactory(): DurableStoreFactory {
	return {
		create: (options) => createDurableStoreInstance(options),
		createWorkflow: (options) => createDurableStoreInstance({ ...options, storeKind: "workflow" }),
		createKnowledge: (options) => createDurableStoreInstance({ ...options, storeKind: "knowledge" }),
	};
}

export function createDurableStoreInstance<TEvent, TProjection, TSemantic = TEvent>(
	options: DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>,
): DurableStoreInstance<TEvent, TProjection, TSemantic> {
	const kernel = options.authenticatedKernel;
	assertFactoryIdentity(options, kernel);
	if (options.phaseAdapter !== kernel.phaseAdapter || options.eventCodec !== kernel.eventCodec)
		throw new Error(
			"Durable store factory codec and phase adapter must be the authenticated kernel's exact instances.",
		);

	let serial: Promise<void> = Promise.resolve();
	const runLocked = async <TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
		const previous = serial;
		let release!: () => void;
		serial = new Promise<void>((resolvePromise) => {
			release = resolvePromise;
		});
		await previous;
		try {
			return await operation();
		} finally {
			release();
		}
	};

	const read = async (): Promise<{ state: TProjection; sequence: number; digest: string | null }> => {
		const events = await kernel.replay();
		const state = reduceEvents(events, options);
		const last = events.at(-1);
		return { state, sequence: last?.sequence ?? 0, digest: last?.eventDigest ?? null };
	};

	const commit = async (
		input: DurableStoreMutationRequest<TSemantic>,
	): Promise<DurableStoreCommitResult<TProjection, TEvent>> =>
		runLocked(async () => {
			assertMutationIdentity(input, kernel.workflowId);
			const events = await kernel.replay();
			const replayState = reduceEvents(events, options);
			const currentHead = await kernel.readHead();
			const semanticHead = await kernel.readSemanticHead();
			assertSemanticHead(currentHead, semanticHead, kernel.workflowId);
			const currentGenerations = normalizeGenerations(await kernel.readGenerations());
			assertCanonicalGenerations(input.expectedGenerations);

			const existing = events.find((event) => event.idempotencyKey === input.idempotencyKey);
			if (existing !== undefined) {
				assertHistoricalIdempotency(existing, input, kernel.workflowId);
				const event = options.eventCodec.fromWorkflowEvent(existing.payload);
				options.eventCodec.validate(event);
				return {
					sequence: currentHead.sequence,
					digest: currentHead.eventDigest ?? "",
					replayed: true,
					idempotencyConflict: false,
					authenticatedEventDigest: existing.eventDigest,
					postCommitExtension: null,
					state: replayState,
					event,
					head: currentHead,
				};
			}

			options.ownerValidator.validateSemanticPreflight(input, { head: semanticHead, state: replayState });
			if (
				digestObject(input.expectedHead) !== digestObject(currentHead) ||
				input.baselineDigest !== semanticHead.stateDigest ||
				digestObject(normalizeGenerations(input.expectedGenerations)) !== digestObject(currentGenerations)
			)
				throw new Error("Durable semantic preflight head, baseline, or generation CAS is stale.");

			const preview = options.mutationBuilder.preview(input, { head: semanticHead, state: replayState });
			assertPreview(preview, semanticHead, kernel.workflowId);
			const frame = options.mutationBuilder.build(input);
			assertMutationFrame(frame, input);
			options.ownerValidator.validateFrame(frame);
			const preparedBytes = encodeCanonicalEvent(options.eventCodec, frame.preparedEvent);
			const committedBytes = encodeCanonicalEvent(options.eventCodec, frame.committedEvent);
			if (sha256Hex(preparedBytes) !== sha256Hex(committedBytes))
				throw new Error("Durable mutation frames do not describe one canonical logical event.");
			const committedPayload = options.eventCodec.toWorkflowEvent(frame.committedEvent);
			if (committedPayload.kind.length === 0)
				throw new Error("Durable mutation codec produced an empty workflow event kind.");
			const predictedEventDigest = digestObject({
				workflowId: kernel.workflowId,
				sequence: currentHead.sequence + 1,
				payloadDigest: digestObject(committedPayload),
				priorEventDigest: currentHead.eventDigest,
				idempotencyKey: input.idempotencyKey,
				semanticBinding: frame.binding,
			});
			await kernel.prepareDependentPublications({
				mutation: input,
				frame,
				expectedHead: currentHead,
				eventDigest: predictedEventDigest,
			});
			const result = await kernel.commitSemanticMutation({
				mutation: input,
				frame,
				authenticatedBinding: frame.binding,
				crashHook: input.crashHook,
			});
			assertCommitBinding(result.commit, input, currentHead, kernel.workflowId);
			const tuple = authenticatedTuple(result.commit, input.mutationId);
			await kernel.finalizeDependentPublications({
				mutation: input,
				frame,
				commit: result.commit,
				tuple,
				crashHook: input.crashHook,
			});
			const committedEvent = options.eventCodec.fromWorkflowEvent(result.commit.payload);
			options.eventCodec.validate(committedEvent);
			return {
				sequence: result.commit.sequence,
				digest: result.commit.eventDigest,
				replayed: false,
				idempotencyConflict: false,
				authenticatedEventDigest: result.commit.eventDigest,
				postCommitExtension: result.postCommitExtension,
				state: options.reduce(replayState, committedEvent),
				event: committedEvent,
				head: result.head,
			};
		});

	const replay = async (): Promise<readonly TEvent[]> => {
		const events = await kernel.replay();
		return events.map((event) => {
			const typed = options.eventCodec.fromWorkflowEvent(event.payload);
			options.eventCodec.validate(typed);
			return typed;
		});
	};

	return {
		storeId: options.storeId,
		namespace: options.namespace,
		kernelVersion: DURABLE_KERNEL_API_VERSION,
		journalInstanceId: randomUUID(),
		leaseInstanceId: randomUUID(),
		snapshotInstanceId: randomUUID(),
		reducerInstanceId: randomUUID(),
		read,
		commit,
		replay,
		recover: () => kernel.recover(),
	};
}

export interface DurableStoreAuthenticatedKernelOptions<TEvent> {
	storeId: string;
	storeKind: "workflow" | "knowledge";
	namespace: string;
	rootDir: string;
	workflowId: string;
	runtimeStore: WorkflowRuntimeStore;
	readHead: () => Promise<WorkflowJournalHead>;
	readSemanticHead: () => Promise<WorkflowSemanticHead>;
	readGenerations: () => Promise<Readonly<Record<string, number>>>;
	eventCodec: DurableStoreEventCodec<TEvent>;
	phaseAdapter: DurableStoreCommitPhaseAdapter<TEvent>;
	publicationPort: DurableStoreDependentPublicationPort<TEvent>;
	recovery?: () => Promise<WorkflowJournalRecoveryResult>;
	postCommitAdapter?: {
		validate(
			extension: DurableStorePostCommitExtension,
			authenticatedCommit: WorkflowJournalCommit<WorkflowEventPayload>,
		): Promise<DurableStorePostCommitExtension>;
	};
}

export function createDurableStoreAuthenticatedKernel<TEvent>(
	input: DurableStoreAuthenticatedKernelOptions<TEvent>,
): DurableStoreAuthenticatedKernel<TEvent> {
	assertRuntimeIdentity(input);

	const readRuntimeReplay = async (): Promise<WorkflowStoreReplayResult> => {
		const head = await input.readHead();
		return input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 1,
			expectedStoreEpoch: head.epochRef.storeEpoch,
		});
	};

	const replay = async (): Promise<readonly WorkflowJournalCommit<WorkflowEventPayload>[]> => {
		const result = await readRuntimeReplay();
		if (result.quarantined)
			throw new Error(`Durable runtime store replay is quarantined: ${result.quarantineReason ?? "unknown"}.`);
		if (result.workflowId !== input.workflowId || result.head.workflowId !== input.workflowId)
			throw new Error("Durable runtime store replay crossed the authenticated workflow boundary.");
		return result.events;
	};

	const recover = async (): Promise<DurableStoreRecoveryResult> => {
		if (input.recovery !== undefined) return mapJournalRecovery(await input.recovery());
		const head = await input.readHead();
		const result = await readRuntimeReplay();
		if (result.quarantined)
			throw new Error(
				"Durable runtime store reported quarantine without its authenticated journal recovery metadata.",
			);
		const source: WorkflowRecoverySource = {
			artifactRef: null,
			relativePath: "runtime-store",
			digest: result.head.eventDigest,
			sizeBytes: result.events.reduce((size, event) => size + event.payloadBytes.byteLength, 0),
		};
		return {
			status: "healthy",
			metadata: { source, epochRef: head.epochRef, reconciliation: null, quarantine: null },
		};
	};

	return {
		rootDir: input.rootDir,
		namespace: input.namespace,
		storeId: input.storeId,
		workflowId: input.workflowId,
		storeKind: input.storeKind,
		runtimeStore: input.runtimeStore,
		readHead: input.readHead,
		readSemanticHead: input.readSemanticHead,
		readGenerations: input.readGenerations,
		eventCodec: input.eventCodec,
		phaseAdapter: input.phaseAdapter,
		prepareDependentPublications: (publication) => input.publicationPort.prepare(publication),
		finalizeDependentPublications: (publication) => input.publicationPort.finalize(publication),
		commitSemanticMutation: async <TSemantic>(mutationInput: {
			mutation: DurableStoreMutationRequest<TSemantic>;
			frame: DurableStoreMutationFrame<TEvent>;
			authenticatedBinding: DurableStoreSemanticBinding;
			crashHook?: DurableStoreCrashBoundaryHook;
		}) => {
			input.eventCodec.validate(mutationInput.frame.preparedEvent);
			input.eventCodec.validate(mutationInput.frame.committedEvent);
			const preparedBytes = encodeCanonicalEvent(input.eventCodec, mutationInput.frame.preparedEvent);
			const committedBytes = encodeCanonicalEvent(input.eventCodec, mutationInput.frame.committedEvent);
			if (sha256Hex(preparedBytes) !== sha256Hex(committedBytes))
				throw new Error("Prepared and committed semantic payloads differ.");
			const expectedHead = await input.readHead();
			if (digestObject(expectedHead) !== digestObject(mutationInput.mutation.expectedHead))
				throw new Error("Authenticated kernel head changed during semantic commit preflight.");
			if (mutationInput.crashHook?.checkpoint === DurableStoreCrashBoundary.beforePrepare) {
				await mutationInput.crashHook.before({
					storeId: input.workflowId,
					mutationId: mutationInput.mutation.mutationId,
					checkpoint: DurableStoreCrashBoundary.beforePrepare,
				});
				await mutationInput.crashHook.after({
					storeId: input.workflowId,
					mutationId: mutationInput.mutation.mutationId,
					checkpoint: DurableStoreCrashBoundary.beforePrepare,
					digest: sha256Hex(committedBytes),
				});
			}
			const payload = input.eventCodec.toWorkflowEvent(mutationInput.frame.committedEvent);
			const commitInput: WorkflowStoreCommitInput<WorkflowEventPayload> = {
				workflowId: input.workflowId,
				payload,
				expectedHead: mutationInput.mutation.expectedHead,
				semanticBinding: {
					...mutationInput.authenticatedBinding,
					expectedHead: mutationInput.mutation.expectedHead,
					idempotencyKey: mutationInput.mutation.idempotencyKey,
					executionKey: mutationInput.mutation.executionKey,
					writerIdentity: mutationInput.mutation.writerIdentity,
					leaseRef: mutationInput.mutation.leaseRef,
					epochRef: mutationInput.mutation.epochRef,
				},
				epochRef: mutationInput.mutation.epochRef,
				leaseRef: mutationInput.mutation.leaseRef,
				idempotencyKey: mutationInput.mutation.idempotencyKey,
				writerIdentity: mutationInput.mutation.writerIdentity,
				executionKey: mutationInput.mutation.executionKey,
				crashHook: mutationInput.crashHook,
			};
			const committed = await input.runtimeStore.commit(commitInput);
			const postCommitExtension =
				mutationInput.frame.postCommitExtension === null
					? null
					: input.postCommitAdapter === undefined
						? (() => {
								throw new Error("Opaque post-commit extension requires its owner adapter.");
							})()
						: await input.postCommitAdapter.validate(mutationInput.frame.postCommitExtension, committed.commit);
			if (postCommitExtension !== null)
				input.phaseAdapter.validatePostCommitExtension(postCommitExtension, committed.commit);
			return { commit: committed.commit, head: committed.head, postCommitExtension };
		},
		replay,
		recover,
	};
}

export type WorkflowDurableStoreEvent = WorkflowEventPayload;
export type WorkflowDurableArtifactRef = WorkflowArtifactRef;

function assertFactoryIdentity<TEvent, TProjection, TSemantic>(
	options: DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>,
	kernel: DurableStoreAuthenticatedKernel<TEvent>,
): void {
	if (
		!isAbsolute(options.rootDir) ||
		options.namespace.length === 0 ||
		options.namespace.includes("/") ||
		options.namespace.includes("\\") ||
		kernel.storeId !== options.storeId ||
		kernel.storeKind !== options.storeKind ||
		kernel.namespace !== options.namespace ||
		resolve(kernel.rootDir) !== resolve(options.rootDir)
	)
		throw new Error("Durable store factory identity is not bound to its authenticated kernel.");
	const identity = kernel.runtimeStore.identity;
	const expected = {
		storeKind: options.storeKind,
		namespace: options.namespace,
		rootDir: options.rootDir,
		storeId: options.storeId,
		workflowId: kernel.workflowId,
	};
	if (
		identity.storeKind !== expected.storeKind ||
		identity.namespace !== expected.namespace ||
		identity.storeId !== expected.storeId ||
		identity.workflowId !== expected.workflowId ||
		resolve(identity.rootDir) !== resolve(expected.rootDir) ||
		identity.identityDigest !== digestObject(expected)
	)
		throw new Error("Durable store kernel identity is not bound to the canonical runtime store.");
}

function assertRuntimeIdentity<TEvent>(input: DurableStoreAuthenticatedKernelOptions<TEvent>): void {
	const expected = {
		storeKind: input.storeKind,
		namespace: input.namespace,
		rootDir: input.rootDir,
		storeId: input.storeId,
		workflowId: input.workflowId,
	};
	const identity = input.runtimeStore.identity;
	if (
		!isAbsolute(input.rootDir) ||
		input.namespace.length === 0 ||
		input.namespace.includes("/") ||
		input.namespace.includes("\\") ||
		identity.storeKind !== expected.storeKind ||
		identity.namespace !== expected.namespace ||
		identity.storeId !== expected.storeId ||
		identity.workflowId !== expected.workflowId ||
		resolve(identity.rootDir) !== resolve(expected.rootDir) ||
		identity.identityDigest !== digestObject(expected)
	)
		throw new Error("Durable authenticated kernel identity does not match its runtime store.");
}

function assertMutationIdentity<TSemantic>(input: DurableStoreMutationRequest<TSemantic>, workflowId: string): void {
	if (
		input.mutationId.length === 0 ||
		input.idempotencyKey.length === 0 ||
		input.writerIdentity.length === 0 ||
		input.expectedHead.workflowId !== workflowId ||
		input.leaseRef.writerIdentity !== input.writerIdentity ||
		input.leaseRef.storeEpoch !== input.epochRef.storeEpoch ||
		input.leaseRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		!Number.isSafeInteger(input.epochRef.storeEpoch) ||
		!Number.isSafeInteger(input.epochRef.coordinatorEpoch)
	)
		throw new Error("Durable store mutation identity is invalid.");
}

function normalizeGenerations(generations: Readonly<Record<string, number>>): Readonly<Record<string, number>> {
	return Object.fromEntries(Object.entries(generations).sort(([left], [right]) => left.localeCompare(right)));
}

function assertCanonicalGenerations(generations: Readonly<Record<string, number>>): void {
	for (const [name, generation] of Object.entries(generations)) {
		if (name.length === 0 || !Number.isSafeInteger(generation) || generation < 0)
			throw new Error("Durable semantic mutation generations are invalid.");
	}
	if (digestObject(generations) !== digestObject(normalizeGenerations(generations)))
		throw new Error("Durable semantic mutation generations are not canonical.");
}

function assertSemanticHead(head: WorkflowJournalHead, semanticHead: WorkflowSemanticHead, workflowId: string): void {
	if (
		head.workflowId !== workflowId ||
		semanticHead.workflowId !== workflowId ||
		semanticHead.sequence !== head.sequence ||
		semanticHead.eventDigest !== head.eventDigest ||
		digestObject(semanticHead.epochRef) !== digestObject(head.epochRef)
	)
		throw new Error("Durable semantic head is not bound to the authenticated journal head.");
}

function assertPreview<TEvent>(
	preview: DurableStoreTransitionPreview<TEvent>,
	current: WorkflowSemanticHead,
	workflowId: string,
): void {
	if (
		preview.previewDigest.length === 0 ||
		preview.semanticHead.workflowId !== workflowId ||
		preview.semanticHead.sequence !== current.sequence ||
		preview.semanticHead.eventDigest !== current.eventDigest ||
		digestObject(preview.semanticHead.epochRef) !== digestObject(current.epochRef)
	)
		throw new Error("Durable transition preview is not bound to the current semantic head.");
}

function assertMutationFrame<TSemantic, TEvent>(
	frame: DurableStoreMutationFrame<TEvent>,
	input: DurableStoreMutationRequest<TSemantic>,
): void {
	const binding = frame.binding;
	if (
		binding.mutationId !== input.mutationId ||
		binding.baselineDigest !== input.baselineDigest ||
		digestObject(normalizeGenerations(binding.expectedGenerations)) !==
			digestObject(normalizeGenerations(input.expectedGenerations)) ||
		binding.ownerId.length === 0 ||
		binding.phase.length === 0 ||
		binding.reducerDigest.length === 0 ||
		digestObject(binding.expectedHead) !== digestObject(input.expectedHead) ||
		binding.idempotencyKey !== input.idempotencyKey ||
		binding.executionKey !== input.executionKey ||
		binding.writerIdentity !== input.writerIdentity ||
		digestObject(binding.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(binding.epochRef) !== digestObject(input.epochRef) ||
		binding.semanticHead.workflowId !== input.expectedHead.workflowId ||
		binding.semanticHead.sequence !== input.expectedHead.sequence ||
		binding.semanticHead.eventDigest !== input.expectedHead.eventDigest
	)
		throw new Error("Durable mutation frame is not bound to its owner, phase, reducer, and preflight tuple.");
}

function encodeCanonicalEvent<TEvent>(codec: DurableStoreEventCodec<TEvent>, event: TEvent): Uint8Array {
	codec.validate(event);
	const bytes = codec.encode(event);
	const decoded = codec.decode(bytes);
	codec.validate(decoded);
	const roundTrip = codec.encode(decoded);
	if (sha256Hex(bytes) !== sha256Hex(roundTrip))
		throw new Error("Durable event codec did not produce canonical bytes.");
	return bytes;
}

function reduceEvents<TEvent, TProjection, TSemantic>(
	events: readonly WorkflowJournalCommit<WorkflowEventPayload>[],
	options: DurableStoreFactoryOptions<TEvent, TProjection, TSemantic>,
): TProjection {
	let state = options.initialState;
	for (const event of events) {
		options.ownerValidator.validateReplay(event);
		const typed = options.eventCodec.fromWorkflowEvent(event.payload);
		options.eventCodec.validate(typed);
		state = options.reduce(state, typed);
	}
	return state;
}

function assertHistoricalIdempotency<TSemantic>(
	event: WorkflowJournalCommit<WorkflowEventPayload>,
	input: DurableStoreMutationRequest<TSemantic>,
	workflowId: string,
): void {
	const proof = event.commitReturnProof;
	if (
		event.workflowId !== workflowId ||
		event.writerIdentity !== input.writerIdentity ||
		event.executionKey !== input.executionKey ||
		event.idempotencyKey !== input.idempotencyKey ||
		digestObject(event.expectedHead) !== digestObject(input.expectedHead) ||
		digestObject(event.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(event.epochRef) !== digestObject(input.epochRef) ||
		event.semanticBinding.mutationId !== input.mutationId ||
		event.semanticBinding.baselineDigest !== input.baselineDigest ||
		digestObject(normalizeGenerations(event.semanticBinding.expectedGenerations)) !==
			digestObject(normalizeGenerations(input.expectedGenerations)) ||
		!isAuthenticatedCommit(event) ||
		proof.mutationId !== event.returnProofId
	)
		throw new Error("Durable historical idempotency tuple conflicts with the authenticated mutation.");
}

function isAuthenticatedCommit(event: WorkflowJournalCommit<WorkflowEventPayload>): boolean {
	const proof = event.commitReturnProof;
	return (
		event.recordVersion === 1 &&
		event.generationId.length > 0 &&
		event.keyId.length > 0 &&
		event.preparedFrameDigest.length > 0 &&
		event.committedFrameDigest.length > 0 &&
		event.preparedFrameMac.length > 0 &&
		event.committedFrameMac.length > 0 &&
		event.preparedFrameChecksum.length > 0 &&
		event.committedFrameChecksum.length > 0 &&
		event.recordMac.length > 0 &&
		event.recordChecksum.length > 0 &&
		proof.recordVersion === event.recordVersion &&
		proof.generationId === event.generationId &&
		proof.workflowId === event.workflowId &&
		proof.sequence === event.sequence &&
		proof.eventDigest === event.eventDigest &&
		proof.committedFrameDigest === event.committedFrameDigest &&
		digestObject(proof.expectedHead) === digestObject(event.expectedHead) &&
		digestObject(proof.epochRef) === digestObject(event.epochRef) &&
		digestObject(proof.leaseRef) === digestObject(event.leaseRef) &&
		proof.writerIdentity === event.writerIdentity &&
		proof.idempotencyKey === event.idempotencyKey &&
		proof.keyId === event.keyId &&
		proof.frameMac === event.committedFrameMac &&
		proof.frameChecksum === event.committedFrameChecksum &&
		proof.recordMac === event.recordMac &&
		proof.recordChecksum === event.recordChecksum &&
		proof.priorRecordDigest === event.priorEventDigest &&
		proof.proofDigest === proofDigest(proof)
	);
}

function proofDigest(proof: WorkflowJournalCommit<WorkflowEventPayload>["commitReturnProof"]): string {
	const { proofDigest: _proofDigest, ...unsigned } = proof;
	return digestObject(unsigned);
}

function assertCommitBinding<TSemantic>(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	input: DurableStoreMutationRequest<TSemantic>,
	currentHead: WorkflowJournalHead,
	workflowId: string,
): void {
	if (
		commit.workflowId !== workflowId ||
		commit.idempotencyKey !== input.idempotencyKey ||
		commit.writerIdentity !== input.writerIdentity ||
		commit.executionKey !== input.executionKey ||
		digestObject(commit.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(commit.epochRef) !== digestObject(input.epochRef) ||
		digestObject(commit.expectedHead) !== digestObject(currentHead) ||
		commit.sequence !== currentHead.sequence + 1 ||
		!isAuthenticatedCommit(commit)
	)
		throw new Error("Authenticated durable store returned an event with a mismatched commit tuple.");
}

function authenticatedTuple(
	commit: WorkflowJournalCommit<WorkflowEventPayload>,
	mutationId: string,
): WorkflowAuthenticatedMutationTuple {
	return {
		recordVersion: commit.recordVersion,
		generationId: commit.generationId,
		workflowId: commit.workflowId,
		mutationId,
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
}

function mapJournalRecovery(result: WorkflowJournalRecoveryResult): DurableStoreRecoveryResult {
	const { metadata } = result;
	if (metadata.epochRef === null)
		throw new Error("Authenticated journal recovery did not provide the epoch for its durable source.");
	const source: WorkflowRecoverySource = {
		artifactRef: null,
		relativePath: metadata.sourcePath,
		digest: metadata.sourceDigest,
		sizeBytes: metadata.sourceSizeBytes,
	};
	if (!result.quarantined) {
		if ((metadata.status === "complete") !== (metadata.reason === "none"))
			throw new Error("Authenticated journal recovery returned inconsistent complete-tail metadata.");
		return {
			status: metadata.status === "complete" ? "healthy" : "recovered",
			metadata: { source, epochRef: metadata.epochRef, reconciliation: null, quarantine: null },
		};
	}
	if (metadata.reason === "none" || metadata.reason === "tail_truncated" || metadata.reason === "interior_corruption")
		throw new Error(
			"Authenticated journal recovery returned a quarantine reason outside the durable-store reason union.",
		);
	const reason: WorkflowQuarantineReason = metadata.reason;
	const quarantine: DurableStoreQuarantineMetadata = {
		reason,
		source,
		epochRef: metadata.epochRef,
		eventSequence: metadata.sequence,
	};
	return {
		status: "quarantined",
		metadata: { source, epochRef: metadata.epochRef, reconciliation: null, quarantine },
	};
}
