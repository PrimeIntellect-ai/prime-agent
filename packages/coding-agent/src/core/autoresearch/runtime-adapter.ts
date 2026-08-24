import type { HostRequestHandler } from "../kernel/index.js";
import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowAutoResearchEventPayload,
	WorkflowEpochRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowJournalCommit,
	WorkflowJournalEvent,
	WorkflowLeaseRef,
	WorkflowRuntimeStore,
	WorkflowSemanticMutationBinding,
} from "../workflow/contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes, sha256Hex } from "../workflow/contracts.js";
import type { AutoResearchCommittedEvent, AutoResearchRuntimePort, AutoResearchRuntimeRecord } from "./types.js";

const MAX_NATIVE_EVENT_BYTES = 4_000_000;
const MAX_ARTIFACT_REF_BYTES = 8_388_608;
const MAX_ARTIFACT_ID_BYTES = 256;
const MAX_ARTIFACT_PATH_BYTES = 512;
const SHA256_DIGEST = /^[0-9a-f]{64}$/;

interface NativeEventBinding {
	artifactRef: WorkflowArtifactRef;
	eventDigest: string;
	idempotencyKey: string;
	logicalKey: string;
}

const NATIVE_BINDING_KEYS = ["artifactRef", "eventDigest", "idempotencyKey", "logicalKey"] as const;
const HOST_ARTIFACT_REF_KEYS = [
	"artifact_id",
	"digest",
	"relative_path",
	"size_bytes",
	"source_event_sequence",
] as const;
const FORBIDDEN_HANDLER_RESULT_KEYS = new Set([
	"authorized",
	"canAuthorize",
	"complete",
	"completed",
	"completion",
	"promote",
	"promoted",
	"promotion",
]);
const FORBIDDEN_HANDLER_RESULT_STATUSES = new Set([
	"authorized",
	"complete",
	"completed",
	"completion",
	"promoted",
	"promotion",
]);

export interface AutoResearchWorkflowRuntimeAdapterInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly workflowId: string;
	readonly runId: string;
	readonly executionKey: string;
	readonly writerIdentity: string;
	readonly resolveLeaseRef: () => Promise<WorkflowLeaseRef>;
}

/** Kernel request shape for a host-owned native experiment execution. */
export interface AutoResearchRunHostRequest {
	readonly recipeDigest: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	/** Optional native source; built-in proposal-only hosts must reject it explicitly. */
	readonly cellSourceCode?: string;
}

/** Host execution callback; it must use the supplied persisted runtime authority. */
export type AutoResearchRunHostExecutor = (request: AutoResearchRunHostRequest) => Promise<Record<string, unknown>>;

/** The single persisted authority used to resolve evidence before native execution. */
export interface AutoResearchRunHostAuthority {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly workflowId: string;
	readonly executionKey: string;
	readonly writerIdentity: string;
	readonly resolveLeaseRef: () => Promise<WorkflowLeaseRef>;
	/** Receipt authority opened with the same persisted runtime and artifact resolver. */
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
}

function fail(message: string): never {
	throw new Error(`autoresearch_runtime_${message}`);
}

function assertNonEmpty(value: string, label: string): void {
	if (value.length === 0 || value.trim().length === 0) fail(`${label}_missing`);
}

function assertUtf8Text(value: string, maximumBytes: number, label: string): void {
	assertNonEmpty(value, label);
	if (new TextEncoder().encode(value).byteLength > maximumBytes) fail(`${label}_invalid`);
}

function assertDigest(value: string, label: string): void {
	if (!SHA256_DIGEST.test(value)) fail(`${label}_invalid`);
}

function assertEpoch(epoch: WorkflowEpochRef): void {
	if (
		!Number.isSafeInteger(epoch.storeEpoch) ||
		epoch.storeEpoch < 1 ||
		!Number.isSafeInteger(epoch.coordinatorEpoch) ||
		epoch.coordinatorEpoch < 1
	)
		fail("epoch_invalid");
}

function epochOf(leaseRef: WorkflowLeaseRef): WorkflowEpochRef {
	return { storeEpoch: leaseRef.storeEpoch, coordinatorEpoch: leaseRef.coordinatorEpoch };
}

function assertArtifactRef(ref: WorkflowArtifactRef): void {
	const expectedKeys = ["artifactId", "digest", "relativePath", "sizeBytes", "sourceEventSequence"];
	const pathParts =
		typeof ref === "object" && ref !== null && !Array.isArray(ref) && typeof ref.relativePath === "string"
			? ref.relativePath.split("/")
			: [];
	if (
		typeof ref !== "object" ||
		ref === null ||
		Array.isArray(ref) ||
		JSON.stringify(Object.keys(ref).sort()) !== JSON.stringify(expectedKeys) ||
		typeof ref.artifactId !== "string" ||
		typeof ref.relativePath !== "string" ||
		typeof ref.digest !== "string" ||
		!/^([A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(ref.relativePath) ||
		pathParts.some((part) => part === "." || part === "..") ||
		new TextEncoder().encode(ref.artifactId).byteLength > MAX_ARTIFACT_ID_BYTES ||
		new TextEncoder().encode(ref.relativePath).byteLength > MAX_ARTIFACT_PATH_BYTES ||
		!SHA256_DIGEST.test(ref.digest) ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		ref.sizeBytes > MAX_ARTIFACT_REF_BYTES ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	)
		fail("artifact_ref_invalid");
}

function assertVerifiedArtifact(
	ref: WorkflowArtifactRef,
	artifact: Awaited<ReturnType<WorkflowArtifactResolver["resolve"]>>,
	maximumSourceSequence?: number,
): void {
	assertArtifactRef(ref);
	assertArtifactRef(artifact.envelope.ref);
	if (
		!artifact.exists ||
		digestObject(artifact.envelope.ref) !== digestObject(ref) ||
		artifact.envelope.immutable !== true ||
		artifact.envelope.payloadKind !== "evidence" ||
		artifact.envelope.codec !== "canonical_json" ||
		!Number.isSafeInteger(artifact.verifiedSizeBytes) ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(new Uint8Array(artifact.bytes)) !== ref.digest ||
		artifact.verifiedDigest !== ref.digest ||
		(maximumSourceSequence !== undefined &&
			(ref.sourceEventSequence < 1 || ref.sourceEventSequence > maximumSourceSequence))
	)
		fail("artifact_unresolved");
	try {
		parseCanonicalJsonBytes(new Uint8Array(artifact.bytes));
	} catch {
		fail("artifact_unresolved");
	}
}

function parseHostArtifactRef(value: unknown): WorkflowArtifactRef {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...HOST_ARTIFACT_REF_KEYS].sort())
	)
		fail("handler_artifact_ref_invalid");
	const record = value as Record<string, unknown>;
	const ref = {
		artifactId: record.artifact_id,
		relativePath: record.relative_path,
		digest: record.digest,
		sizeBytes: record.size_bytes,
		sourceEventSequence: record.source_event_sequence,
	} as unknown as WorkflowArtifactRef;
	assertArtifactRef(ref);
	return ref;
}

const NATIVE_EVENT_KINDS: ReadonlySet<AutoResearchCommittedEvent["kind"]> = new Set([
	"registration_locked",
	"holdout_submitted",
	"candidate_submitted",
	"candidate_execution_intent",
	"candidate_execution_completed",
	"observation_recorded",
	"accepted_proposal_intent",
	"accepted_proposal_committed",
	"proposal_emitted",
]);

function nativeEventKind(value: unknown): value is AutoResearchCommittedEvent["kind"] {
	return typeof value === "string" && NATIVE_EVENT_KINDS.has(value as AutoResearchCommittedEvent["kind"]);
}

function parseNativeEvent(bytes: Readonly<Uint8Array>): AutoResearchCommittedEvent {
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_EVENT_BYTES) fail("event_size_invalid");
	const value = parseCanonicalJsonBytes(bytes);
	if (typeof value !== "object" || value === null || Array.isArray(value) || !nativeEventKind(value.kind))
		fail("event_unknown");
	return value as unknown as AutoResearchCommittedEvent;
}

function runIdForEvent(event: AutoResearchCommittedEvent, fallback: string): string {
	if (event.kind === "registration_locked") return event.registration.runId;
	return fallback;
}

function assertEventWorkflow(event: AutoResearchCommittedEvent, workflowId: string): void {
	const requiredWorkflow =
		event.kind === "registration_locked"
			? event.registration.workflowId
			: event.kind === "accepted_proposal_intent" ||
					event.kind === "accepted_proposal_committed" ||
					event.kind === "proposal_emitted"
				? event.proposal.workflowId
				: undefined;
	const requiresWorkflow =
		event.kind === "registration_locked" ||
		event.kind === "accepted_proposal_intent" ||
		event.kind === "accepted_proposal_committed" ||
		event.kind === "proposal_emitted";
	if (requiresWorkflow && (typeof requiredWorkflow !== "string" || requiredWorkflow !== workflowId))
		fail("event_workflow_mismatch");
	if (
		event.kind === "holdout_submitted" &&
		event.resolverContext !== undefined &&
		(typeof event.resolverContext.workflowId !== "string" || event.resolverContext.workflowId !== workflowId)
	)
		fail("event_workflow_mismatch");
}

function logicalEventKey(event: AutoResearchCommittedEvent, fallbackRunId: string): string {
	const runId = runIdForEvent(event, fallbackRunId);
	switch (event.kind) {
		case "registration_locked":
			return `registration-lock:${runId}:${event.registrationDigest}`;
		case "holdout_submitted":
			return `holdout:${runId}:${event.registrationDigest}`;
		case "candidate_submitted":
			return `candidate:${runId}:${event.registrationDigest}:${event.request.candidateId}:${event.request.attemptId}`;
		case "candidate_execution_intent":
			return `candidate-execution-intent:${runId}:${event.registrationDigest}:${event.observationId}:${event.executionDigest}`;
		case "candidate_execution_completed":
			return `candidate-execution-completed:${runId}:${event.registrationDigest}:${event.observationId}:${event.executionDigest}`;
		case "observation_recorded":
			return `observation:${runId}:${event.registrationDigest}:${event.observation.observationId}`;
		case "accepted_proposal_intent":
			return `proposal-intent:${runId}:${event.registrationDigest}:${event.observation.observationId}`;
		case "accepted_proposal_committed":
			return `observation:${runId}:${event.registrationDigest}:${event.observation.observationId}`;
		case "proposal_emitted":
			return `proposal:${runId}:${event.registrationDigest}:${event.observationId}`;
	}
}

function encodeBinding(binding: NativeEventBinding): string {
	return new TextDecoder().decode(canonicalJsonBytes(binding));
}

function decodeBinding(value: string): NativeEventBinding {
	const parsed = parseCanonicalJsonBytes(new TextEncoder().encode(value));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("binding_invalid");
	const record = parsed as Record<string, unknown>;
	const artifactRef = record.artifactRef;
	if (
		typeof record.eventDigest !== "string" ||
		typeof record.idempotencyKey !== "string" ||
		typeof record.logicalKey !== "string" ||
		JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...NATIVE_BINDING_KEYS].sort()) ||
		typeof artifactRef !== "object" ||
		artifactRef === null ||
		Array.isArray(artifactRef)
	)
		fail("binding_invalid");
	const binding = {
		artifactRef: artifactRef as unknown as WorkflowArtifactRef,
		eventDigest: record.eventDigest,
		idempotencyKey: record.idempotencyKey,
		logicalKey: record.logicalKey,
	};
	assertArtifactRef(binding.artifactRef);
	assertDigest(binding.eventDigest, "event_digest");
	assertNonEmpty(binding.idempotencyKey, "idempotency_key");
	assertNonEmpty(binding.logicalKey, "logical_key");
	return binding;
}

function semanticBinding(input: {
	workflowId: string;
	expectedHead: { workflowId: string; sequence: number; eventDigest: string | null; epochRef: WorkflowEpochRef };
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	writerIdentity: string;
	executionKey: string;
	payload: WorkflowAutoResearchEventPayload;
}): WorkflowSemanticMutationBinding {
	const baselineDigest = digestObject(input.expectedHead);
	return {
		mutationId: input.idempotencyKey,
		baselineDigest,
		expectedGenerations: { workflow: input.epochRef.storeEpoch },
		ownerId: "autoresearch",
		phase: "executing",
		reducerDigest: digestObject(input.payload),
		semanticHead: {
			workflowId: input.workflowId,
			sequence: input.expectedHead.sequence,
			eventDigest: input.expectedHead.eventDigest,
			stateDigest: baselineDigest,
			epochRef: input.expectedHead.epochRef,
			generation: input.epochRef.storeEpoch,
		},
		expectedHead: input.expectedHead,
		idempotencyKey: input.idempotencyKey,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
		leaseRef: input.leaseRef,
		epochRef: input.epochRef,
	};
}

function assertProjectionPayload(
	payload: WorkflowAutoResearchEventPayload,
	commit: WorkflowJournalCommit<WorkflowAutoResearchEventPayload>,
	binding: NativeEventBinding,
	workflowId: string,
	executionKey: string,
	leaseRef?: WorkflowLeaseRef,
	writerIdentity?: string,
): void {
	if (
		payload.kind !== "projection_intent" ||
		payload.workflowId !== workflowId ||
		payload.executionKey !== executionKey ||
		payload.expectedPrefix !== null ||
		payload.epochRef.storeEpoch !== commit.epochRef.storeEpoch ||
		payload.epochRef.coordinatorEpoch !== commit.epochRef.coordinatorEpoch ||
		payload.projectionLockId !== encodeBinding(binding) ||
		payload.effectDigest !== digestObject({ eventDigest: binding.eventDigest, artifactRef: binding.artifactRef }) ||
		commit.idempotencyKey !== binding.idempotencyKey ||
		commit.sequence !== binding.artifactRef.sourceEventSequence ||
		commit.workflowId !== workflowId ||
		commit.executionKey !== executionKey ||
		(writerIdentity !== undefined && commit.writerIdentity !== writerIdentity) ||
		(leaseRef !== undefined &&
			(commit.leaseRef.storeEpoch !== leaseRef.storeEpoch ||
				commit.leaseRef.writerIdentity !== leaseRef.writerIdentity))
	)
		fail("journal_binding_invalid");
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	if (ArrayBuffer.isView(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function containsHandlerAuthority(value: unknown, depth = 0): boolean {
	if (depth > 32 || typeof value !== "object" || value === null) return depth > 32;
	if (Array.isArray(value)) return value.some((entry) => containsHandlerAuthority(entry, depth + 1));
	return Object.entries(value).some(([key, nested]) => {
		if (FORBIDDEN_HANDLER_RESULT_KEYS.has(key)) return true;
		if (key === "status" && FORBIDDEN_HANDLER_RESULT_STATUSES.has(String(nested))) return true;
		return containsHandlerAuthority(nested, depth + 1);
	});
}

function assertHostAuthority(authority: AutoResearchRunHostAuthority): void {
	if (authority.runtimeStore.identity.workflowId !== authority.workflowId) fail("handler_authority_workflow_mismatch");
	if (authority.runtimeStore.durableContext === undefined) fail("handler_authority_not_persisted");
	if (authority.receiptContext.artifactResolver !== authority.artifactResolver)
		fail("handler_receipt_authority_mismatch");
	assertNonEmpty(authority.workflowId, "handler_workflow_id");
	assertNonEmpty(authority.executionKey, "handler_execution_key");
	assertNonEmpty(authority.writerIdentity, "handler_writer_identity");
}

async function readCurrentHostAuthority(authority: AutoResearchRunHostAuthority): Promise<{
	readonly leaseRef: WorkflowLeaseRef;
	readonly replay: Awaited<ReturnType<WorkflowRuntimeStore["replay"]>>;
}> {
	assertHostAuthority(authority);
	const leaseRef = await authority.resolveLeaseRef();
	assertEpoch(leaseRef);
	if (leaseRef.writerIdentity !== authority.writerIdentity) fail("handler_lease_writer_mismatch");
	const durable = authority.runtimeStore.durableContext;
	if (durable === undefined || digestObject(durable.currentLeaseRef()) !== digestObject(leaseRef))
		fail("handler_authority_lease_mismatch");
	const replay = await authority.runtimeStore.replay({
		workflowId: authority.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: leaseRef.storeEpoch,
	});
	if (
		replay.quarantined ||
		replay.head.workflowId !== authority.workflowId ||
		replay.head.epochRef.storeEpoch !== leaseRef.storeEpoch ||
		replay.head.epochRef.coordinatorEpoch !== leaseRef.coordinatorEpoch
	)
		fail("handler_authority_head_invalid");
	return { leaseRef, replay };
}

/** Resolve host evidence through the exact persisted runtime and artifact authority. */
export async function resolveAutoResearchArtifactRefs(
	authority: AutoResearchRunHostAuthority,
	evidenceRefs: readonly WorkflowArtifactRef[],
): Promise<readonly WorkflowArtifactRef[]> {
	const before = await readCurrentHostAuthority(authority);
	const frozenEvidenceRefs = deepFreeze(evidenceRefs.map((ref) => structuredClone(ref)));
	const seenArtifactIds = new Set<string>();
	for (const ref of frozenEvidenceRefs) {
		assertArtifactRef(ref);
		if (seenArtifactIds.has(ref.artifactId)) fail("handler_evidence_duplicate");
		seenArtifactIds.add(ref.artifactId);
	}
	await Promise.all(
		frozenEvidenceRefs.map(async (ref) => {
			const artifact = await authority.artifactResolver.resolve(ref);
			assertVerifiedArtifact(ref, artifact, before.replay.head.sequence);
			const sourceCommit = before.replay.events.find((event) => event.sequence === ref.sourceEventSequence);
			if (
				sourceCommit === undefined ||
				sourceCommit.workflowId !== authority.workflowId ||
				sourceCommit.epochRef.storeEpoch !== before.leaseRef.storeEpoch ||
				sourceCommit.epochRef.coordinatorEpoch !== before.leaseRef.coordinatorEpoch
			)
				fail("handler_artifact_source_invalid");
		}),
	);
	const after = await readCurrentHostAuthority(authority);
	if (
		digestObject(before.leaseRef) !== digestObject(after.leaseRef) ||
		digestObject(before.replay.head) !== digestObject(after.replay.head)
	)
		fail("handler_authority_changed");
	return frozenEvidenceRefs;
}

const HOST_OUTPUT_KEYS = [
	"can_authorize",
	"durable_knowledge_boundary_digest",
	"evidence_refs",
	"output_digest",
	"output_kind",
	"skill_id",
	"transient_state_refs",
] as const;

function assertExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[], label: string): void {
	if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expectedKeys].sort())) fail(`${label}_schema`);
}

function validateHostResult(
	value: Record<string, unknown>,
	evidenceRefs: readonly WorkflowArtifactRef[],
): Record<string, unknown> {
	const cloned = structuredClone(value);
	if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) fail("handler_result_authority");
	const result = cloned as Record<string, unknown>;
	assertExactKeys(result, HOST_OUTPUT_KEYS, "handler_result");
	if (
		result.skill_id !== "autoresearch" ||
		(result.output_kind !== "evidence" && result.output_kind !== "knowledge_proposal") ||
		result.can_authorize !== false ||
		!Array.isArray(result.transient_state_refs) ||
		result.transient_state_refs.length !== 0 ||
		!Array.isArray(result.evidence_refs) ||
		result.evidence_refs.length > 32
	)
		fail("handler_result_authority");
	const resultRefs = result.evidence_refs.map(parseHostArtifactRef);
	if (digestObject(resultRefs) !== digestObject(evidenceRefs)) fail("handler_result_evidence_mismatch");
	if (
		result.durable_knowledge_boundary_digest !== null &&
		(typeof result.durable_knowledge_boundary_digest !== "string" ||
			!SHA256_DIGEST.test(result.durable_knowledge_boundary_digest))
	)
		fail("handler_result_boundary_invalid");
	if (typeof result.output_digest !== "string" || !SHA256_DIGEST.test(result.output_digest))
		fail("handler_result_digest_invalid");
	const unsigned = { ...result };
	delete unsigned.output_digest;
	if (result.output_digest !== digestObject(unsigned)) fail("handler_result_digest_invalid");
	return deepFreeze(result);
}

export function validateAutoResearchProjectionIntent(
	payload: WorkflowAutoResearchEventPayload,
	commit: WorkflowJournalEvent,
): void {
	if (payload.kind !== "projection_intent") return;
	if (
		payload.workflowId !== commit.workflowId ||
		payload.executionKey !== commit.executionKey ||
		payload.epochRef.storeEpoch !== commit.epochRef.storeEpoch ||
		payload.epochRef.coordinatorEpoch !== commit.epochRef.coordinatorEpoch ||
		payload.runId.length === 0 ||
		payload.projectionLockId.length === 0 ||
		!SHA256_DIGEST.test(payload.effectDigest)
	)
		fail("projection_owner_binding_invalid");
	const binding = decodeBinding(payload.projectionLockId);
	if (
		payload.effectDigest !== digestObject({ eventDigest: binding.eventDigest, artifactRef: binding.artifactRef }) ||
		commit.idempotencyKey !== binding.idempotencyKey ||
		commit.sequence !== binding.artifactRef.sourceEventSequence ||
		commit.expectedHead.workflowId !== commit.workflowId ||
		commit.expectedHead.sequence + 1 !== commit.sequence ||
		commit.expectedHead.eventDigest !== commit.priorEventDigest ||
		commit.semanticBinding.mutationId !== commit.idempotencyKey ||
		commit.semanticBinding.idempotencyKey !== commit.idempotencyKey ||
		commit.semanticBinding.executionKey !== commit.executionKey ||
		commit.semanticBinding.writerIdentity !== commit.writerIdentity ||
		commit.semanticBinding.leaseRef.writerIdentity !== commit.writerIdentity ||
		commit.semanticBinding.expectedHead.sequence !== commit.expectedHead.sequence ||
		commit.semanticBinding.expectedHead.eventDigest !== commit.expectedHead.eventDigest
	)
		fail("projection_binding_invalid");
}

class AutoResearchWorkflowRuntimeAdapter implements AutoResearchRuntimePort {
	constructor(private readonly input: AutoResearchWorkflowRuntimeAdapterInput) {
		if (input.runtimeStore.identity.workflowId !== input.workflowId) fail("workflow_binding_invalid");
		if (input.runtimeStore.durableContext === undefined) fail("durable_runtime_required");
		assertNonEmpty(input.workflowId, "workflow_id");
		assertNonEmpty(input.runId, "run_id");
		assertNonEmpty(input.executionKey, "execution_key");
		assertNonEmpty(input.writerIdentity, "writer_identity");
	}

	async replay(): Promise<readonly AutoResearchRuntimeRecord[]> {
		const leaseRef = await this.input.resolveLeaseRef();
		assertEpoch(leaseRef);
		if (leaseRef.writerIdentity !== this.input.writerIdentity) fail("lease_writer_mismatch");
		const durable = this.input.runtimeStore.durableContext;
		if (durable === undefined || digestObject(durable.currentLeaseRef()) !== digestObject(leaseRef))
			fail("lease_authority_mismatch");
		const replayed = await this.input.runtimeStore.replay({
			workflowId: this.input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: leaseRef.storeEpoch,
		});
		if (replayed.quarantined) fail("journal_quarantined");
		const records: AutoResearchRuntimeRecord[] = [];
		for (const commit of replayed.events) {
			if (commit.payload.kind !== "projection_intent") continue;
			const payload = commit.payload as WorkflowAutoResearchEventPayload;
			if (payload.kind !== "projection_intent" || payload.runId !== this.input.runId) continue;
			const autoCommit = commit as unknown as WorkflowJournalCommit<WorkflowAutoResearchEventPayload>;
			const binding = decodeBinding(payload.projectionLockId);
			assertProjectionPayload(
				payload,
				autoCommit,
				binding,
				this.input.workflowId,
				this.input.executionKey,
				leaseRef,
				this.input.writerIdentity,
			);
			const artifact = await this.input.artifactResolver.resolve(binding.artifactRef);
			assertVerifiedArtifact(binding.artifactRef, artifact, replayed.head.sequence);
			const event = parseNativeEvent(artifact.bytes);
			assertEventWorkflow(event, this.input.workflowId);
			if (runIdForEvent(event, this.input.runId) !== this.input.runId) fail("event_run_mismatch");
			if (digestObject(event) !== binding.eventDigest) fail("event_digest_mismatch");
			if (logicalEventKey(event, this.input.runId) !== binding.logicalKey) fail("event_identity_mismatch");
			records.push(
				deepFreeze({
					event: deepFreeze(event),
					payload: deepFreeze(payload),
					commit: deepFreeze(autoCommit),
					artifactRef: deepFreeze(binding.artifactRef),
					eventDigest: binding.eventDigest,
				}),
			);
		}
		return records;
	}

	async commit(input: { readonly event: AutoResearchCommittedEvent }): Promise<AutoResearchRuntimeRecord> {
		const event = deepFreeze(structuredClone(input.event));
		assertEventWorkflow(event, this.input.workflowId);
		if (runIdForEvent(event, this.input.runId) !== this.input.runId) fail("event_run_mismatch");
		const eventDigest = digestObject(event);
		const logicalKey = logicalEventKey(event, this.input.runId);
		const idempotencyKey = `autoresearch:${this.input.workflowId}:${logicalKey}`;
		const existing = (await this.replay()).find((record) => {
			if (record.payload.kind !== "projection_intent") return false;
			const binding = decodeBinding(record.payload.projectionLockId);
			return binding.idempotencyKey === idempotencyKey || binding.logicalKey === logicalKey;
		});
		if (existing !== undefined) {
			if (existing.eventDigest !== eventDigest) fail("idempotency_conflict");
			return { ...existing, commitStatus: "already_committed" };
		}

		const leaseRef = await this.input.resolveLeaseRef();
		assertEpoch(leaseRef);
		if (leaseRef.writerIdentity !== this.input.writerIdentity) fail("lease_writer_mismatch");
		const durable = this.input.runtimeStore.durableContext;
		if (durable === undefined || digestObject(durable.currentLeaseRef()) !== digestObject(leaseRef))
			fail("lease_authority_mismatch");
		const current = await this.input.runtimeStore.replay({
			workflowId: this.input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: leaseRef.storeEpoch,
		});
		if (current.quarantined) fail("journal_quarantined");
		const expectedHead = current.head;
		if (
			expectedHead.workflowId !== this.input.workflowId ||
			expectedHead.epochRef.storeEpoch !== leaseRef.storeEpoch ||
			expectedHead.epochRef.coordinatorEpoch !== leaseRef.coordinatorEpoch
		)
			fail("head_epoch_mismatch");
		const bytes = canonicalJsonBytes(event);
		if (bytes.byteLength === 0 || bytes.byteLength > MAX_NATIVE_EVENT_BYTES) fail("event_size_invalid");
		parseNativeEvent(bytes);
		const published = await this.input.runtimeStore.publishArtifact({
			workflowId: this.input.workflowId,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: expectedHead.sequence + 1,
			idempotencyKey: `${idempotencyKey}:artifact`,
		});
		const artifactRef = published.envelope.ref;
		assertArtifactRef(artifactRef);
		const binding: NativeEventBinding = { artifactRef, eventDigest, idempotencyKey, logicalKey };
		const payload: WorkflowAutoResearchEventPayload = {
			kind: "projection_intent",
			workflowId: this.input.workflowId,
			epochRef: epochOf(leaseRef),
			executionKey: this.input.executionKey,
			runId: this.input.runId,
			expectedPrefix: null,
			projectionLockId: encodeBinding(binding),
			effectDigest: digestObject({ eventDigest, artifactRef }),
		};
		let commit: Awaited<ReturnType<WorkflowRuntimeStore["commit"]>>;
		try {
			commit = await this.input.runtimeStore.commit({
				workflowId: this.input.workflowId,
				payload,
				expectedHead,
				epochRef: epochOf(leaseRef),
				leaseRef,
				idempotencyKey,
				writerIdentity: this.input.writerIdentity,
				executionKey: this.input.executionKey,
				semanticBinding: semanticBinding({
					workflowId: this.input.workflowId,
					expectedHead,
					epochRef: epochOf(leaseRef),
					leaseRef,
					idempotencyKey,
					writerIdentity: this.input.writerIdentity,
					executionKey: this.input.executionKey,
					payload,
				}),
			});
		} catch (error) {
			const recovered = (await this.replay()).find((record) => {
				if (record.payload.kind !== "projection_intent") return false;
				const binding = decodeBinding(record.payload.projectionLockId);
				return binding.idempotencyKey === idempotencyKey || binding.logicalKey === logicalKey;
			});
			if (recovered !== undefined) {
				if (recovered.eventDigest !== eventDigest) fail("idempotency_conflict");
				return { ...recovered, commitStatus: "already_committed" };
			}
			throw error;
		}
		if (commit.status === "already_committed") {
			const recovered = (await this.replay()).find((record) => {
				if (record.payload.kind !== "projection_intent") return false;
				const recoveredBinding = decodeBinding(record.payload.projectionLockId);
				return recoveredBinding.idempotencyKey === idempotencyKey || recoveredBinding.logicalKey === logicalKey;
			});
			if (recovered === undefined) fail("idempotency_missing");
			if (recovered.eventDigest !== eventDigest) fail("idempotency_conflict");
			return { ...recovered, commitStatus: "already_committed" };
		}
		const result = deepFreeze({
			event,
			payload: payload as Extract<WorkflowAutoResearchEventPayload, { kind: "projection_intent" }>,
			commit: commit.commit as WorkflowJournalCommit<WorkflowAutoResearchEventPayload>,
			artifactRef,
			eventDigest,
			commitStatus: "committed" as const,
		});
		assertProjectionPayload(
			result.payload,
			result.commit,
			binding,
			this.input.workflowId,
			this.input.executionKey,
			leaseRef,
			this.input.writerIdentity,
		);
		return result;
	}
}

/** Build the one native runtime adapter backed by a persisted workflow store. */
export function createAutoResearchWorkflowRuntimeAdapter(
	input: AutoResearchWorkflowRuntimeAdapterInput,
): AutoResearchRuntimePort {
	return new AutoResearchWorkflowRuntimeAdapter(input);
}

/** Adapt one host-owned native executor to the kernel's bounded request handler. */
export function createAutoResearchRunHostHandler(
	executor: AutoResearchRunHostExecutor,
	authority?: AutoResearchRunHostAuthority,
): HostRequestHandler {
	if (authority !== undefined) assertHostAuthority(authority);
	return async (payload, context) => {
		if (
			context !== undefined &&
			(!context.capability.capabilities.includes("autoresearch.run") || !context.isCurrent())
		)
			fail("handler_capability_invalid");
		if (authority === undefined) fail("handler_authority_missing");
		const requestPayload = structuredClone(payload);
		deepFreeze(requestPayload);
		if (
			Object.keys(requestPayload).some(
				(key) => !["cellSourceCode", "evidence_refs", "recipe_digest", "type"].includes(key),
			)
		)
			fail("handler_payload_invalid");
		if (requestPayload.cellSourceCode !== undefined && typeof requestPayload.cellSourceCode !== "string")
			fail("handler_payload_invalid");
		if (typeof requestPayload.recipe_digest !== "string") fail("handler_recipe_digest_invalid");
		assertUtf8Text(requestPayload.recipe_digest, 64, "handler_recipe_digest");
		assertDigest(requestPayload.recipe_digest, "handler_recipe_digest");
		if (!Array.isArray(requestPayload.evidence_refs) || requestPayload.evidence_refs.length > 32)
			fail("handler_evidence_refs_invalid");
		const evidenceRefs = requestPayload.evidence_refs.map(parseHostArtifactRef);
		const resolvedEvidenceRefs = await resolveAutoResearchArtifactRefs(authority, evidenceRefs);
		if (context !== undefined && !context.isCurrent()) fail("handler_capability_invalid");
		const result = await executor(
			deepFreeze({
				recipeDigest: requestPayload.recipe_digest,
				evidenceRefs: resolvedEvidenceRefs,
				...(requestPayload.cellSourceCode === undefined ? {} : { cellSourceCode: requestPayload.cellSourceCode }),
			}),
		);
		if (context !== undefined && !context.isCurrent()) fail("handler_capability_invalid");
		const clonedResult = structuredClone(result);
		if (
			containsHandlerAuthority(clonedResult) ||
			canonicalJsonBytes(clonedResult).byteLength > MAX_NATIVE_EVENT_BYTES
		)
			fail("handler_result_authority");
		if (typeof clonedResult.evidence_refs === "undefined") fail("handler_result_schema");
		if (!Array.isArray(clonedResult.evidence_refs)) fail("handler_result_evidence_invalid");
		const resultRefs = clonedResult.evidence_refs.map(parseHostArtifactRef);
		const resolvedResultRefs = await resolveAutoResearchArtifactRefs(authority, resultRefs);
		return validateHostResult(clonedResult, resolvedResultRefs);
	};
}
