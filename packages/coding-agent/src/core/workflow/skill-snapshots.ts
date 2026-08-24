import type { Dirent, Stats } from "node:fs";
import { constants as fsConstants, realpathSync } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ResourceDiagnostic } from "../diagnostics.js";
import type { Skill } from "../skills.js";
import type {
	WorkflowArtifactCodec,
	WorkflowArtifactPayloadKind,
	WorkflowArtifactPublisher,
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowDecisionRef,
	WorkflowDescriptorFs,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowEventType,
	WorkflowHostReceiptConsumerContext,
	WorkflowHostReceiptConsumptionWitness,
	WorkflowJournalCommit,
	WorkflowReceiptVerificationKeyResolver,
	WorkflowRuntimeStore,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
} from "./contracts.js";

const SKILL_ARTIFACT_NAMESPACE = "artifacts/skills/";
const ALLOWED_SKILL_ARTIFACT_PAYLOAD_KINDS: readonly WorkflowArtifactPayloadKind[] = [
	"handoff",
	"evidence",
	"process_identity",
	"effect_result",
	"recovery_finding",
	"barrier",
];

const MAX_SKILL_SOURCE_BYTES = 1024 * 1024;
const MAX_PACKAGE_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_FILES = 256;
const MAX_PACKAGE_DEPTH = 16;
const MAX_SKILL_DEPENDENCIES = 256;
const MAX_DEPENDENCY_BYTES = 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 64;
const MAX_MANIFEST_VALUE_BYTES = 4096;
const MAX_BUILTIN_MANIFEST_BYTES = 256 * 1024;
const MAX_LOADER_SKILLS = 256;
const MAX_LOADER_DIAGNOSTICS = 256;
const MAX_LOADER_STRING_BYTES = 64 * 1024;
const MAX_LOADER_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_SKILL_EFFECT_EVENTS = 32;
const MAX_SKILL_EFFECT_ARTIFACT_REFS = 256;
const MAX_SKILL_EFFECT_SCAN_DEPTH = 16;
const MAX_SKILL_EFFECT_PAYLOAD_FIELDS = 1024;
export const WORKFLOW_SKILL_DEFAULT_EFFECT_EVENT_KINDS: readonly WorkflowEventType[] = Object.freeze([
	"workflow_effect_intent",
	"workflow_effect_completed",
	"workflow_effect_ambiguous",
]);
const AUTHENTICATED_PRODUCTION_EXECUTION_ADAPTERS = new WeakSet<object>();
const SKILL_HOST_STATE_RUNTIME_STORES = new WeakMap<object, WorkflowRuntimeStore>();
const PRODUCTION_EXECUTION_ADAPTER_RUNTIME_STORES = new WeakMap<object, WorkflowRuntimeStore>();

/** Built-ins are resolved by the host package, never by a caller-controlled resource source. */
export const REQUIRED_BUILTIN_SKILL_NAMES = Object.freeze(["workflow-autoresearch", "mempalace"] as const);

export interface WorkflowSkillFileIdentity {
	device: number;
	inode: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	identityDigest: string;
}

export interface WorkflowSkillDependency {
	name: string;
	artifactRef: WorkflowArtifactRef;
	bytes: Readonly<Uint8Array>;
	contentDigest: string;
	sourcePath?: string;
}

export interface WorkflowSkillManifestSource {
	artifactRef: WorkflowArtifactRef;
	bytes: Readonly<Uint8Array>;
	contentDigest: string;
}

export interface WorkflowSkillPackageSource {
	name: string;
	artifactRef: WorkflowArtifactRef;
	bytes: Readonly<Uint8Array>;
	contentDigest: string;
	sourcePath?: string;
}

export interface WorkflowSkillBuiltinSourceEvent {
	eventId: string;
	skillName: string;
	vendoredRoot: string;
	canonicalPath: string;
	sourceManifestDigest: string;
	sourceBytesDigest: string;
	sourceEventSequence: number;
	issuedAt: string;
	validUntil: string;
	keyId: string;
	signatureAlgorithm: "ed25519";
	signature: string;
	eventDigest: string;
}

export interface WorkflowSkillBuiltinProvenance {
	vendoredRoot: string;
	registryArtifactRef: WorkflowArtifactRef;
	registryBytes: Readonly<Uint8Array>;
	sourceManifestArtifactRef: WorkflowArtifactRef;
	sourceManifestBytes: Readonly<Uint8Array>;
	sourceEvent: WorkflowSkillBuiltinSourceEvent;
}

export interface WorkflowSkillBuiltinSnapshotProvenance {
	vendoredRoot: string;
	registryArtifactRef: WorkflowArtifactRef;
	registryBytesDigest: string;
	sourceManifestArtifactRef: WorkflowArtifactRef;
	sourceManifestBytesDigest: string;
	sourceEvent: WorkflowSkillBuiltinSourceEvent;
}

export interface WorkflowSkillBuiltinProvenanceContext {
	artifactResolver: WorkflowArtifactResolver;
	keyResolver: WorkflowReceiptVerificationKeyResolver;
	revokedEventIds: ReadonlySet<string>;
	/** Host-fixed catalog roots and manifest refs; callers cannot authorize a different built-in source. */
	hostCatalog: {
		vendoredRoot: string;
		registryArtifactRef: WorkflowArtifactRef;
		sourceManifestArtifactRef: WorkflowArtifactRef;
	};
}

export interface WorkflowSkillSourceProvenance {
	sourcePath: string;
	sourceBytes: Readonly<Uint8Array>;
	sourceRef?: WorkflowArtifactRef;
	sourceArtifactRef?: WorkflowArtifactRef;
	packageSources: readonly WorkflowSkillPackageSource[];
	builtin?: WorkflowSkillBuiltinProvenance;
}

export interface WorkflowResourceLoaderResult {
	skills: readonly Skill[];
	diagnostics: readonly ResourceDiagnostic[];
	revision?: number;
}

/** Host-owned adapter around ResourceLoader.getSkills(). */
export interface WorkflowResourceLoaderPort {
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
}

export interface WorkflowResourceLoaderProvenance {
	issuedBy: "ResourceLoader";
	issuanceReceipt: WorkflowVerifiedHostReceipt;
	loaderRevision: number;
	workspaceDigest: string;
	sourceManifestDigest: string;
	diagnosticsDigest: string;
	artifactPathDigest: string;
	loaderResultDigest: string;
	artifactNamespace: "artifacts/skills";
}

export interface WorkflowSkillSnapshotInput {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	journalHeadDigest: string;
	skill: Skill;
	dependencies: readonly WorkflowSkillDependency[];
	manifest: WorkflowSkillManifestSource | null;
	artifacts: WorkflowArtifactResolver;
	publisher: WorkflowArtifactPublisher;
	workflowContractRevision: number;
	configDigest: string;
	workspaceDigest: string;
	attemptId: string;
	loader: WorkflowResourceLoaderPort;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow: string;
	sourceProvenance?: WorkflowSkillSourceProvenance;
	builtinProvenanceContext?: WorkflowSkillBuiltinProvenanceContext;
	epochRef: WorkflowEpochRef;
	sourceEventSequence: number;
}

export interface WorkflowSkillManifest {
	requiredApprovalGates: readonly string[];
	requiredArtifactKinds: readonly string[];
	requiredPressureTests: readonly string[];
	allowedTransitions: readonly string[];
	manifestDigest: string;
}

export interface WorkflowSkillSnapshot {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	journalHeadDigest: string;
	trustedNow: string;
	epochRef: WorkflowEpochRef;
	configDigest: string;
	workspaceDigest: string;
	attemptId: string;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	loaderReceiptConsumptionWitness: WorkflowHostReceiptConsumptionWitness;
	loaderResultDigest: string;
	requiredBuiltIn: boolean;
	builtinProvenance: WorkflowSkillBuiltinSnapshotProvenance | null;
	canonicalBaseDir: string;
	skillName: string;
	skillKind: "markdown" | "python";
	canonicalPath: string;
	sourceInfo: Skill["sourceInfo"];
	disableModelInvocation: boolean;
	contentDigest: string;
	contentBytes: number;
	sourceFileIdentity: WorkflowSkillFileIdentity;
	dependencyNames: readonly string[];
	dependencyDigests: readonly string[];
	dependencyRefs: readonly WorkflowArtifactRef[];
	dependencySourceRefs: readonly WorkflowArtifactRef[];
	dependencySourcePaths: readonly (string | null)[];
	dependencySourceIdentities: readonly (WorkflowSkillFileIdentity | null)[];
	dependencyManifestDigest: string;
	manifest: WorkflowSkillManifest | null;
	manifestArtifactRef: WorkflowArtifactRef | null;
	manifestArtifactPayloadKind: "evidence" | null;
	manifestArtifactCodec: "canonical_json" | null;
	manifestSourceArtifactRef: WorkflowArtifactRef | null;
	authoritativeDependencyManifestDigest: string;
	authoritativeHostDependencyRefs: readonly WorkflowArtifactRef[];
	hostSourceArtifactRef: WorkflowArtifactRef | null;
	hostPackageArtifactRefs: readonly WorkflowArtifactRef[];
	sourceArtifactRef: WorkflowArtifactRef;
	sourceBytesDigest: string;
	packageSourceNames: readonly string[];
	packageSourcePaths: readonly string[];
	packageSourceIdentities: readonly WorkflowSkillFileIdentity[];
	packageBytesDigests: readonly string[];
	packageArtifactRefs: readonly WorkflowArtifactRef[];
	workflowContractRevision: number;
	skillMetadataDigest: string;
	snapshotDigest: string;
	invocationTokenId: string;
	invocationTokenHash: string;
	invocationTokenBytesDigest: string;
	invocationTokenEpoch: WorkflowEpochRef;
	consumeSequence: number;
	artifactRef: WorkflowArtifactRef;
	hostVerificationReceipt: WorkflowVerifiedHostReceipt;
	snapshotEpoch: WorkflowEpochRef;
}

export type WorkflowSkillInvocationStoreDurability = "durable" | "test";

export class WorkflowSkillDurableStoreRequiredError extends Error {
	readonly code = "workflow_skill_durable_store_required" as const;

	constructor() {
		super("Skill invocation requires a durable production store; test-only stores need explicit opt-in.");
		this.name = "WorkflowSkillDurableStoreRequiredError";
	}
}

export interface WorkflowSkillInvocationWitnessSigner {
	readonly keyId: string;
	readonly signatureAlgorithm: "ed25519";
	sign(bytes: Readonly<Uint8Array>): Promise<string>;
}

export interface WorkflowSkillActiveHostState {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	journalHeadDigest: string;
	journalHeadSequence?: number;
	/** Host-owned execution capability for the active journal run, when one exists. */
	executionKey?: string | null;
}

export interface WorkflowSkillEffectChainVerificationInput {
	workflowId: string;
	priorHeadDigest: string;
	priorHeadSequence?: number;
	expectedEpoch: WorkflowEpochRef;
	executionKey: string;
	capabilityDigest: string;
	allowedEventKinds: readonly WorkflowEventType[];
	allowedArtifactRefs: readonly WorkflowArtifactRef[];
	maxEvents?: number;
	maxArtifactRefs?: number;
}

export interface WorkflowSkillEffectChainEvent {
	sequence: number;
	workflowId: string;
	kind: WorkflowEventType;
	priorEventDigest: string | null;
	eventDigest: string;
	epochRef: WorkflowEpochRef;
	executionKey: string;
	artifactRefs: readonly WorkflowArtifactRef[];
}

export interface WorkflowSkillEffectChain {
	workflowId: string;
	priorHeadDigest: string;
	successorHeadDigest: string;
	expectedEpoch: WorkflowEpochRef;
	executionKey: string;
	capabilityDigest: string;
	events: readonly WorkflowSkillEffectChainEvent[];
	chainDigest: string;
}

export interface WorkflowSkillActiveHostStateReader {
	read(workflowId: string): Promise<WorkflowSkillActiveHostState>;
	withExclusiveLease<T>(
		workflowId: string,
		boundary: string,
		operation: (active: WorkflowSkillActiveHostState) => Promise<T>,
	): Promise<T>;
	/** Authenticated runtime-store projection of the exact successor journal chain. */
	verifySuccessorEffectChain?(input: WorkflowSkillEffectChainVerificationInput): Promise<WorkflowSkillEffectChain>;
}

export interface WorkflowSkillDescriptorInvocationStoreOptions {
	descriptorFs: WorkflowDescriptorFs;
	rootPath: string;
	signer: WorkflowSkillInvocationWitnessSigner;
	activeHostState: WorkflowSkillActiveHostStateReader;
}

const SKILL_INVOCATION_CAS_NAMESPACE = "skill-invocations";
const SKILL_EXECUTION_CAS_NAMESPACE = "skill-executions";
const MAX_INVOCATION_WITNESS_BYTES = 64 * 1024;
const MAX_EXECUTION_CLAIM_WITNESS_BYTES = 64 * 1024;

/** Create the host descriptor-backed one-use store used by production admission. */
export function createWorkflowSkillDescriptorInvocationStore(
	input: WorkflowSkillDescriptorInvocationStoreOptions,
): WorkflowSkillDurableInvocationStore {
	if (!isAbsolute(input.rootPath) || resolve(input.rootPath) !== input.rootPath)
		throw new Error("Skill invocation CAS root must be an absolute canonical path.");
	assertNonEmpty(input.signer.keyId, "skill invocation witness signer key id");
	if (input.signer.signatureAlgorithm !== "ed25519")
		throw new Error("Skill invocation witness signer must use Ed25519.");
	assertActiveHostStateReader(input.activeHostState);
	const rootPath = input.rootPath;
	const signer = Object.freeze({
		keyId: input.signer.keyId,
		signatureAlgorithm: input.signer.signatureAlgorithm,
		sign: input.signer.sign.bind(input.signer),
	});
	const activeHostState = freezeActiveHostStateReader(input.activeHostState);
	const descriptorFs = freezeDescriptorFs(input.descriptorFs);
	const runtimeStore = SKILL_HOST_STATE_RUNTIME_STORES.get(input.activeHostState);
	if (runtimeStore !== undefined) SKILL_HOST_STATE_RUNTIME_STORES.set(activeHostState, runtimeStore);
	return Object.freeze({
		durability: "durable",
		activeHostState,
		consume: async (consumeInput: Parameters<WorkflowSkillDurableInvocationStore["consume"]>[0]) => {
			assertDecisionWorkflowBinding(
				consumeInput.decisionRef,
				consumeInput.workflowId,
				"skill invocation decision reference",
			);
			assertDecisionEpochBinding(
				consumeInput.decisionRef,
				consumeInput.expectedEpoch,
				"skill invocation consumption",
			);
			return withActiveHostStateLease(
				activeHostState,
				consumeInput.workflowId,
				consumeInput.expectedEpoch,
				consumeInput.journalHeadDigest,
				"skill invocation consumption",
				async () => {
					const unsigned = {
						...consumeInput,
						decisionRef: cloneDecisionRef(consumeInput.decisionRef),
						keyId: signer.keyId,
						signatureAlgorithm: signer.signatureAlgorithm,
						trustedNow: consumeInput.trustedNow,
						consumedAt: consumeInput.trustedNow,
						consumptionSequence: consumeInput.consumeSequence,
						signature: "",
					};
					const { signature: _signature, ...signedValue } = unsigned;
					const signature = await signer.sign(canonicalJsonBytes(signedValue));
					const witness: WorkflowSkillInvocationConsumptionWitness = { ...unsigned, signature };
					const bytes = canonicalJsonBytes(witness);
					if (bytes.byteLength > MAX_INVOCATION_WITNESS_BYTES)
						throw new Error("Skill invocation witness exceeds the immutable byte limit.");
					let root: Awaited<ReturnType<WorkflowDescriptorFs["openRoot"]>> | undefined;
					let namespace: Awaited<ReturnType<WorkflowDescriptorFs["mkdirAt"]>> | undefined;
					let claim: Awaited<ReturnType<WorkflowDescriptorFs["mkdirAt"]>> | undefined;
					let witnessFile: Awaited<ReturnType<WorkflowDescriptorFs["openAt"]>> | undefined;
					try {
						root = await descriptorFs.openRoot(rootPath);
						namespace = await descriptorFs.mkdirAt(root, SKILL_INVOCATION_CAS_NAMESPACE, 0o700);
						claim = await descriptorFs.mkdirAt(namespace, sha256Hex(consumeInput.invocationTokenId), 0o700);
						witnessFile = await descriptorFs.openAt(
							claim,
							"witness",
							fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
							0o600,
						);
						await witnessFile.write(bytes);
						await witnessFile.sync();
						await descriptorFs.syncDirectoryChain(witnessFile, root);
						return witness;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST")
							throw new Error("Skill invocation durable CAS rejected replay.", { cause: error });
						throw error;
					} finally {
						if (witnessFile !== undefined) await witnessFile.close().catch(() => undefined);
						if (claim !== undefined) await claim.close().catch(() => undefined);
						if (namespace !== undefined) await namespace.close().catch(() => undefined);
						if (root !== undefined) await root.close().catch(() => undefined);
					}
				},
			);
		},
		claimExecution: async (claimInput: WorkflowSkillExecutionClaimInput) => {
			assertDecisionWorkflowBinding(
				claimInput.decisionRef,
				claimInput.workflowId,
				"skill execution decision reference",
			);
			assertDecisionEpochBinding(claimInput.decisionRef, claimInput.expectedEpoch, "skill execution claim");
			assertExecutionClaimInput(claimInput);
			return withActiveHostStateLease(
				activeHostState,
				claimInput.workflowId,
				claimInput.expectedEpoch,
				claimInput.journalHeadDigest,
				"skill execution claim",
				async () => {
					const unsigned = {
						...claimInput,
						decisionRef: cloneDecisionRef(claimInput.decisionRef),
						claimKind: "workflow-skill-execution" as const,
						keyId: signer.keyId,
						signatureAlgorithm: signer.signatureAlgorithm,
						claimedAt: claimInput.trustedNow,
						claimSequence: 1,
						signature: "",
					};
					const { signature: _signature, ...signedValue } = unsigned;
					const signature = await signer.sign(canonicalJsonBytes(signedValue));
					const witness: WorkflowSkillExecutionClaimWitness = { ...unsigned, signature };
					const bytes = canonicalJsonBytes(witness);
					if (bytes.byteLength > MAX_EXECUTION_CLAIM_WITNESS_BYTES)
						throw new Error("Skill execution claim witness exceeds the immutable byte limit.");
					let root: Awaited<ReturnType<WorkflowDescriptorFs["openRoot"]>> | undefined;
					let namespace: Awaited<ReturnType<WorkflowDescriptorFs["mkdirAt"]>> | undefined;
					let claim: Awaited<ReturnType<WorkflowDescriptorFs["mkdirAt"]>> | undefined;
					let witnessFile: Awaited<ReturnType<WorkflowDescriptorFs["openAt"]>> | undefined;
					try {
						root = await descriptorFs.openRoot(rootPath);
						namespace = await descriptorFs.mkdirAt(root, SKILL_EXECUTION_CAS_NAMESPACE, 0o700);
						claim = await descriptorFs.mkdirAt(namespace, sha256Hex(claimInput.admissionDigest), 0o700);
						witnessFile = await descriptorFs.openAt(
							claim,
							"witness",
							fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
							0o600,
						);
						await witnessFile.write(bytes);
						await witnessFile.sync();
						await descriptorFs.syncDirectoryChain(witnessFile, root);
						return witness;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "EEXIST")
							throw new Error("Skill execution durable CAS rejected replay.", { cause: error });
						throw error;
					} finally {
						if (witnessFile !== undefined) await witnessFile.close().catch(() => undefined);
						if (claim !== undefined) await claim.close().catch(() => undefined);
						if (namespace !== undefined) await namespace.close().catch(() => undefined);
						if (root !== undefined) await root.close().catch(() => undefined);
					}
				},
			);
		},
	});
}

export function createWorkflowSkillRuntimeStoreHostStateReader(
	runtimeStore: WorkflowRuntimeStore,
): WorkflowSkillActiveHostStateReader {
	const read = async (workflowId: string): Promise<WorkflowSkillActiveHostState> => {
		assertNonEmpty(workflowId, "active runtime workflow id");
		if (runtimeStore.identity.workflowId !== workflowId)
			throw new Error("Skill runtime store is bound to a different workflow.");
		const durableContext = runtimeStore.durableContext;
		if (durableContext === undefined) throw new Error("Skill runtime store has no durable host state.");
		const epochRef = cloneEpochRef(durableContext.epochRef);
		assertEpochRef(epochRef, "active runtime epoch");
		const replay = await runtimeStore.replay({
			workflowId,
			fromSequence: 0,
			expectedStoreEpoch: epochRef.storeEpoch,
		});
		if (
			replay.quarantined ||
			replay.workflowId !== workflowId ||
			replay.head.workflowId !== workflowId ||
			replay.head.epochRef.storeEpoch !== epochRef.storeEpoch ||
			replay.head.epochRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
			typeof replay.head.eventDigest !== "string" ||
			replay.head.eventDigest.length === 0
		)
			throw new Error("Skill runtime store active epoch or journal head is unavailable.");
		return {
			workflowId,
			epochRef: cloneEpochRef(replay.head.epochRef),
			journalHeadDigest: replay.head.eventDigest,
			journalHeadSequence: replay.head.sequence,
			executionKey: replay.executionKey,
		};
	};
	const verifySuccessorEffectChain = async (
		input: WorkflowSkillEffectChainVerificationInput,
	): Promise<WorkflowSkillEffectChain> => verifyRuntimeStoreSuccessorEffectChain(runtimeStore, input);
	const reader = Object.freeze({
		read,
		verifySuccessorEffectChain,
		withExclusiveLease: async <T>(
			workflowId: string,
			boundary: string,
			operation: (active: WorkflowSkillActiveHostState) => Promise<T>,
		): Promise<T> => {
			if (runtimeStore.identity.workflowId !== workflowId)
				throw new Error("Skill runtime store is bound to a different workflow.");
			const durableContext = runtimeStore.durableContext;
			if (durableContext === undefined) throw new Error("Skill runtime store has no durable host state.");
			return durableContext.withExclusiveLease(boundary, async () => operation(await read(workflowId)));
		},
	});
	SKILL_HOST_STATE_RUNTIME_STORES.set(reader, runtimeStore);
	return reader;
}

function verifyRuntimeStoreSuccessorEffectChain(
	runtimeStore: WorkflowRuntimeStore,
	input: WorkflowSkillEffectChainVerificationInput,
): Promise<WorkflowSkillEffectChain> {
	return (async () => {
		assertNonEmpty(input.workflowId, "skill effect workflow id");
		assertDigest(input.priorHeadDigest, "skill effect prior head digest");
		assertEpochRef(input.expectedEpoch, "skill effect expected epoch");
		assertNonEmpty(input.executionKey, "skill effect execution key");
		assertDigest(input.capabilityDigest, "skill effect capability digest");
		if (
			input.priorHeadSequence !== undefined &&
			(!Number.isSafeInteger(input.priorHeadSequence) || input.priorHeadSequence < 0)
		)
			throw new Error("Skill effect prior head sequence is invalid.");
		if (
			input.allowedEventKinds.length === 0 ||
			new Set(input.allowedEventKinds).size !== input.allowedEventKinds.length
		)
			throw new Error("Skill effect policy has no unique allowed event kinds.");
		const allowedEventKinds = new Set(input.allowedEventKinds);
		const maxEvents = input.maxEvents ?? MAX_SKILL_EFFECT_EVENTS;
		const maxArtifactRefs = input.maxArtifactRefs ?? MAX_SKILL_EFFECT_ARTIFACT_REFS;
		if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_SKILL_EFFECT_EVENTS)
			throw new Error("Skill effect policy event bound is invalid.");
		if (
			!Number.isSafeInteger(maxArtifactRefs) ||
			maxArtifactRefs < 1 ||
			maxArtifactRefs > MAX_SKILL_EFFECT_ARTIFACT_REFS
		)
			throw new Error("Skill effect policy artifact bound is invalid.");
		for (const [index, ref] of input.allowedArtifactRefs.entries())
			assertArtifactRef(ref, `skill effect allowed artifact ${index}`, false);
		const replay = await runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: input.priorHeadSequence === undefined ? 0 : input.priorHeadSequence + 1,
			expectedStoreEpoch: input.expectedEpoch.storeEpoch,
		});
		if (
			replay.quarantined ||
			replay.workflowId !== input.workflowId ||
			replay.head.workflowId !== input.workflowId ||
			replay.head.epochRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
			replay.head.epochRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
			replay.head.eventDigest === null
		)
			throw new Error("Skill effect successor journal is unavailable or stale.");
		let priorSequence: number;
		let successorEvents: readonly WorkflowJournalCommit<WorkflowEventPayload>[];
		if (input.priorHeadSequence !== undefined) {
			priorSequence = input.priorHeadSequence;
			successorEvents = replay.events;
		} else {
			const priorIndexes = replay.events
				.map((event, index) => (event.eventDigest === input.priorHeadDigest ? index : -1))
				.filter((index) => index >= 0);
			if (priorIndexes.length !== 1)
				throw new Error("Skill effect prior head is not a unique authenticated journal head.");
			const priorIndex = priorIndexes[0];
			const priorEvent = replay.events[priorIndex];
			if (
				priorEvent === undefined ||
				priorEvent.epochRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
				priorEvent.epochRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch
			)
				throw new Error("Skill effect prior head is foreign to the expected epoch.");
			priorSequence = priorEvent.sequence;
			successorEvents = replay.events.slice(priorIndex + 1);
		}
		if (replay.head.sequence < priorSequence)
			throw new Error("Skill effect successor journal moved behind the admitted prior head.");
		if (successorEvents.length > maxEvents)
			throw new Error("Skill effect successor chain exceeds the immutable event bound.");
		let previousDigest = input.priorHeadDigest;
		let previousSequence = priorSequence;
		let artifactCount = 0;
		const events: WorkflowSkillEffectChainEvent[] = [];
		for (const [index, event] of successorEvents.entries()) {
			const payload = event.payload;
			const kind = payload.kind;
			if (!allowedEventKinds.has(kind)) throw new Error(`Skill effect event kind ${kind} is not allowed.`);
			if (
				event.workflowId !== input.workflowId ||
				event.sequence !== previousSequence + 1 ||
				event.priorEventDigest !== previousDigest ||
				event.expectedHead.workflowId !== input.workflowId ||
				event.expectedHead.sequence !== previousSequence ||
				event.expectedHead.eventDigest !== previousDigest ||
				event.epochRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
				event.epochRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
				event.executionKey !== input.executionKey
			)
				throw new Error(`Skill effect successor event ${index} is not bound to the authenticated prior chain.`);
			const payloadRecord = asRecord(payload);
			if (
				payloadRecord.workflowId !== input.workflowId ||
				payloadRecord.executionKey !== input.executionKey ||
				digestObject(payloadRecord.epochRef) !== digestObject(input.expectedEpoch)
			)
				throw new Error(`Skill effect successor event ${index} is not bound to the admitted host capability.`);
			const artifactRefs = collectWorkflowSkillArtifactRefs(payload);
			artifactCount += artifactRefs.length;
			if (artifactCount > maxArtifactRefs)
				throw new Error("Skill effect successor chain exceeds the immutable artifact bound.");
			for (const [artifactIndex, ref] of artifactRefs.entries()) {
				if (!input.allowedArtifactRefs.some((allowed) => sameArtifactRef(allowed, ref)))
					throw new Error(
						`Skill effect successor artifact ${artifactIndex} is not allowed by the host capability.`,
					);
			}
			assertDigest(event.eventDigest, `skill effect successor event ${index} digest`);
			events.push({
				sequence: event.sequence,
				workflowId: event.workflowId,
				kind,
				priorEventDigest: event.priorEventDigest,
				eventDigest: event.eventDigest,
				epochRef: cloneEpochRef(event.epochRef),
				executionKey: input.executionKey,
				artifactRefs,
			});
			previousDigest = event.eventDigest;
			previousSequence = event.sequence;
		}
		if (replay.head.eventDigest !== previousDigest)
			throw new Error("Skill effect successor chain does not terminate at the authenticated journal head.");
		const chain = {
			workflowId: input.workflowId,
			priorHeadDigest: input.priorHeadDigest,
			successorHeadDigest: replay.head.eventDigest,
			expectedEpoch: cloneEpochRef(input.expectedEpoch),
			executionKey: input.executionKey,
			capabilityDigest: input.capabilityDigest,
			events,
		};
		return freezeDeep({
			...chain,
			chainDigest: computeWorkflowSkillEffectChainDigest(chain),
		});
	})();
}

function collectWorkflowSkillArtifactRefs(value: unknown): readonly WorkflowArtifactRef[] {
	const refs: WorkflowArtifactRef[] = [];
	const seen = new Set<object>();
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > MAX_SKILL_EFFECT_SCAN_DEPTH || refs.length > MAX_SKILL_EFFECT_ARTIFACT_REFS)
			throw new Error("Skill effect payload exceeds the immutable traversal bound.");
		if (candidate === null || typeof candidate !== "object") return;
		if (candidate instanceof Uint8Array) return;
		if (seen.has(candidate)) throw new Error("Skill effect payload contains a cyclic object.");
		seen.add(candidate);
		if (isWorkflowArtifactRefValue(candidate)) {
			const ref = candidate as WorkflowArtifactRef;
			assertArtifactRef(ref, "skill effect payload artifact", false);
			refs.push(cloneArtifactRef(ref));
			return;
		}
		if (Array.isArray(candidate)) {
			if (candidate.length > MAX_SKILL_EFFECT_PAYLOAD_FIELDS)
				throw new Error("Skill effect payload array exceeds the immutable bound.");
			for (const item of candidate) visit(item, depth + 1);
			return;
		}
		const fields = Object.values(candidate as Record<string, unknown>);
		if (fields.length > MAX_SKILL_EFFECT_PAYLOAD_FIELDS)
			throw new Error("Skill effect payload object exceeds the immutable bound.");
		for (const child of fields) visit(child, depth + 1);
	};
	visit(value, 0);
	return Object.freeze(refs);
}

function isWorkflowArtifactRefValue(value: object): boolean {
	const record = value as Record<string, unknown>;
	return (
		typeof record.artifactId === "string" &&
		typeof record.relativePath === "string" &&
		typeof record.digest === "string" &&
		typeof record.sizeBytes === "number" &&
		typeof record.sourceEventSequence === "number"
	);
}

function asRecord(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("Skill effect payload is not an object.");
	return value as Record<string, unknown>;
}

function computeWorkflowSkillEffectChainDigest(chain: Omit<WorkflowSkillEffectChain, "chainDigest">): string {
	return digestObject({
		kind: "workflow-skill-effect-chain",
		workflowId: chain.workflowId,
		priorHeadDigest: chain.priorHeadDigest,
		successorHeadDigest: chain.successorHeadDigest,
		expectedEpoch: chain.expectedEpoch,
		executionKey: chain.executionKey,
		capabilityDigest: chain.capabilityDigest,
		events: chain.events,
	});
}

export interface WorkflowSkillInvocationStore {
	readonly durability?: WorkflowSkillInvocationStoreDurability;
	readonly activeHostState?: WorkflowSkillActiveHostStateReader;
	consume(input: {
		workflowId: string;
		taskId: string;
		decisionRef: WorkflowDecisionRef;
		attemptId: string;
		snapshotDigest: string;
		invocationTokenId: string;
		tokenHash: string;
		configDigest: string;
		dependencyManifestDigest: string;
		consumeSequence: number;
		expectedEpoch: WorkflowEpochRef;
		journalHeadDigest: string;
		trustedNow: string;
	}): Promise<boolean | WorkflowSkillInvocationConsumptionWitness>;
}

export interface WorkflowSkillInvocationConsumptionWitness {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	attemptId: string;
	snapshotDigest: string;
	invocationTokenId: string;
	tokenHash: string;
	configDigest: string;
	dependencyManifestDigest: string;
	consumeSequence: number;
	expectedEpoch: WorkflowEpochRef;
	journalHeadDigest: string;
	keyId: string;
	signatureAlgorithm: "ed25519";
	signature: string;
	trustedNow: string;
	consumedAt: string;
	consumptionSequence: number;
}

export interface WorkflowSkillExecutionClaimInput {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	attemptId: string;
	snapshotDigest: string;
	admissionDigest: string;
	invocationTokenId: string;
	tokenHash: string;
	configDigest: string;
	workspaceDigest: string;
	dependencyManifestDigest: string;
	workflowContractRevision: number;
	consumeSequence: number;
	expectedEpoch: WorkflowEpochRef;
	journalHeadDigest: string;
	trustedNow: string;
}

export interface WorkflowSkillExecutionClaimWitness extends WorkflowSkillExecutionClaimInput {
	claimKind: "workflow-skill-execution";
	keyId: string;
	signatureAlgorithm: "ed25519";
	signature: string;
	claimedAt: string;
	claimSequence: number;
}

export interface WorkflowSkillInvocationAdmission {
	status: "admitted";
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	attemptId: string;
	configDigest: string;
	workspaceDigest: string;
	dependencyManifestDigest: string;
	workflowContractRevision: number;
	skillName: string;
	skillKind: "markdown" | "python";
	disableModelInvocation: boolean;
	snapshotDigest: string;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	loaderResultDigest: string;
	loaderReceiptConsumptionWitness: WorkflowHostReceiptConsumptionWitness;
	hostVerificationReceipt: WorkflowVerifiedHostReceipt;
	invocationTokenId: string;
	invocationTokenHash: string;
	invocationTokenBytesDigest: string;
	consumeSequence: number;
	epochRef: WorkflowEpochRef;
	journalHeadDigest: string;
	trustedNow: string;
	requiredApprovalGates: readonly string[];
	requiredArtifactKinds: readonly string[];
	requiredPressureTests: readonly string[];
	allowedTransitions: readonly string[];
	consumptionWitness: WorkflowSkillInvocationConsumptionWitness;
	artifacts: WorkflowSkillInvocationArtifacts;
	admissionDigest: string;
}

export interface WorkflowSkillImmutableArtifact {
	ref: WorkflowArtifactRef;
	bytes: readonly number[];
}

export interface WorkflowSkillInvocationArtifacts {
	source: WorkflowSkillImmutableArtifact;
	dependencies: readonly WorkflowSkillImmutableArtifact[];
	packageFiles: readonly WorkflowSkillImmutableArtifact[];
	manifest: WorkflowSkillImmutableArtifact | null;
}

/** Production callers must provide a durable CAS implementation, never the test-only in-memory port. */
export interface WorkflowSkillDurableInvocationStore extends WorkflowSkillInvocationStore {
	readonly durability: "durable";
	readonly activeHostState: WorkflowSkillActiveHostStateReader;
	consume(input: {
		workflowId: string;
		taskId: string;
		decisionRef: WorkflowDecisionRef;
		attemptId: string;
		snapshotDigest: string;
		invocationTokenId: string;
		tokenHash: string;
		configDigest: string;
		dependencyManifestDigest: string;
		consumeSequence: number;
		expectedEpoch: WorkflowEpochRef;
		journalHeadDigest: string;
		trustedNow: string;
	}): Promise<WorkflowSkillInvocationConsumptionWitness>;
	claimExecution(input: WorkflowSkillExecutionClaimInput): Promise<WorkflowSkillExecutionClaimWitness>;
}

export interface WorkflowSkillInvocationValidationOptions {
	allowTestStore?: boolean;
}

export interface WorkflowSkillInvocationContext {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	configDigest: string;
	workspaceDigest: string;
	attemptId: string;
	epochRef: WorkflowEpochRef;
	dependencyManifestDigest: string;
	loader: WorkflowResourceLoaderPort;
	workflowContractRevision: number;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow: string;
	journalHeadDigest: string;
	builtinProvenanceContext?: WorkflowSkillBuiltinProvenanceContext;
}

/** Host-owned policy for the journal successor chain produced by one skill invocation. */
export interface WorkflowSkillEffectPolicy {
	executionKey: string;
	allowedEventKinds: readonly WorkflowEventType[];
	allowedArtifactRefs: readonly WorkflowArtifactRef[];
	maxEvents?: number;
	maxArtifactRefs?: number;
}

/**
 * Host-owned production adapter. The host constructs this object once with its
 * canonical loader, receipt/key registries, immutable artifact store, and CAS.
 * Callers provide workflow data to the service, never replacement authorities.
 */
export interface WorkflowSkillHostAdapter {
	loader: WorkflowResourceLoaderPort;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	artifacts: WorkflowArtifactResolver;
	publisher: WorkflowArtifactPublisher;
	receiptContext: WorkflowHostReceiptConsumerContext;
	/** Verify the exact authenticated journal successors produced by one skill effect. */
	verifyExecutionEffects?: WorkflowSkillExecutionEffectVerifier;
	builtinProvenanceContext?: WorkflowSkillBuiltinProvenanceContext;
	/** Resolve the immutable built-in catalog for the admitted snapshot being executed. */
	builtinProvenanceContextForSnapshot?: (
		snapshot: WorkflowSkillSnapshot,
	) => WorkflowSkillBuiltinProvenanceContext | undefined;
	/** Optional host-owned execution capability/effect policy; required for journal effects. */
	effectPolicy?: WorkflowSkillEffectPolicy;
	invocationStore: WorkflowSkillDurableInvocationStore;
}

export interface WorkflowSkillExecutionEffectVerificationInput {
	workflowId: string;
	epochRef: WorkflowEpochRef;
	priorJournalHeadDigest: string;
	priorJournalHeadSequence?: number;
	admissionDigest: string;
	invocationTokenId: string;
	consumeSequence: number;
	skillName: string;
	result: unknown;
}

/**
 * Verify effects while the skill execution lease is still held.
 *
 * Implementations must authenticate a contiguous successor chain from
 * priorJournalHeadDigest; returning the latest head without that proof is not
 * a valid verifier.
 */
export type WorkflowSkillExecutionEffectVerifier = (
	input: WorkflowSkillExecutionEffectVerificationInput,
) => Promise<WorkflowSkillActiveHostState>;

/** Test-only adapter input; production service construction rejects this port. */
export interface WorkflowSkillTestHostBinding extends Omit<WorkflowSkillHostAdapter, "invocationStore"> {
	invocationStore: WorkflowSkillInvocationStore;
}

function freezeDurableInvocationStore(
	invocationStore: WorkflowSkillDurableInvocationStore,
): WorkflowSkillDurableInvocationStore {
	const activeHostState = freezeActiveHostStateReader(invocationStore.activeHostState);
	const frozen = Object.freeze({
		durability: "durable" as const,
		activeHostState,
		consume: invocationStore.consume.bind(invocationStore),
		claimExecution: invocationStore.claimExecution.bind(invocationStore),
	});
	const runtimeStore = SKILL_HOST_STATE_RUNTIME_STORES.get(invocationStore.activeHostState);
	if (runtimeStore !== undefined) SKILL_HOST_STATE_RUNTIME_STORES.set(activeHostState, runtimeStore);
	return frozen;
}

function freezeWorkflowResourceLoader(loader: WorkflowResourceLoaderPort): WorkflowResourceLoaderPort {
	const getSkills = loader.getSkills.bind(loader);
	const frozenResult = structuredClone(getSkills());
	return Object.freeze({
		getSkills: () => structuredClone(frozenResult),
	});
}

function freezeWorkflowArtifactResolver(resolver: WorkflowArtifactResolver): WorkflowArtifactResolver {
	const resolveArtifact = resolver.resolve.bind(resolver);
	return Object.freeze({
		resolve: async (ref: WorkflowArtifactRef): Promise<WorkflowArtifactReadResult> => {
			const resolved = await resolveArtifact(ref);
			if (resolved.exists !== true) throw new Error("Host artifact resolver returned a non-existent artifact.");
			assertUint8Bytes(resolved.bytes, "host artifact resolver bytes", MAX_PACKAGE_TOTAL_BYTES);
			return Object.freeze({
				envelope: freezeDeep({
					...resolved.envelope,
					ref: cloneArtifactRef(resolved.envelope.ref),
				}),
				exists: true as const,
				bytes: Uint8Array.from(resolved.bytes),
				verifiedDigest: resolved.verifiedDigest,
				verifiedSizeBytes: resolved.verifiedSizeBytes,
			});
		},
	});
}

function freezeWorkflowArtifactPublisher(publisher: WorkflowArtifactPublisher): WorkflowArtifactPublisher {
	return Object.freeze({ publish: publisher.publish.bind(publisher) });
}

function freezeWorkflowKeyResolver(
	keyResolver: WorkflowReceiptVerificationKeyResolver,
): WorkflowReceiptVerificationKeyResolver {
	const resolveKey = keyResolver.resolve.bind(keyResolver);
	return Object.freeze({
		resolve: async (keyId: string) => {
			const key = await resolveKey(keyId);
			return Object.freeze({
				algorithm: key.algorithm,
				verify: key.verify.bind(key),
				ownerPrincipal: key.ownerPrincipal,
				allowedCapabilities: freezeReadonlyStringSet(key.allowedCapabilities),
				generationId: key.generationId,
				epochRef: cloneEpochRef(key.epochRef),
				fencingDigest: key.fencingDigest,
				revoked: key.revoked,
			});
		},
	});
}

class FrozenStringSet<T extends string> implements ReadonlySet<T> {
	#entriesSet: Set<T>;

	constructor(values: ReadonlySet<T>) {
		this.#entriesSet = new Set(values);
		Object.freeze(this);
	}

	get size(): number {
		return this.#entriesSet.size;
	}

	has(value: T): boolean {
		return this.#entriesSet.has(value);
	}

	forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
		this.#entriesSet.forEach((value) => {
			callbackfn.call(thisArg, value, value, this);
		});
	}

	entries(): SetIterator<[T, T]> {
		return this.#entriesSet.entries();
	}

	keys(): SetIterator<T> {
		return this.#entriesSet.keys();
	}

	values(): SetIterator<T> {
		return this.#entriesSet.values();
	}

	[Symbol.iterator](): SetIterator<T> {
		return this.#entriesSet[Symbol.iterator]();
	}
}

function freezeReadonlyStringSet<T extends string>(values: ReadonlySet<T>): ReadonlySet<T> {
	return new FrozenStringSet(values);
}

function freezeWorkflowReceiptContext(context: WorkflowHostReceiptConsumerContext): WorkflowHostReceiptConsumerContext {
	const receiptResolver = context.receiptResolver;
	const resolveReceipt = receiptResolver.resolve.bind(receiptResolver);
	const consumeIfOneUse = receiptResolver.consumeIfOneUse.bind(receiptResolver);
	const resolveConsumptionWitness = receiptResolver.resolveConsumptionWitness.bind(receiptResolver);
	const principalAuthorizer = context.principalAuthorizer;
	const authorize = principalAuthorizer.authorize.bind(principalAuthorizer);
	return Object.freeze({
		receiptResolver: Object.freeze({
			resolve: async (input: Parameters<typeof receiptResolver.resolve>[0]) =>
				freezeDeep(cloneReceipt(await resolveReceipt(input))),
			consumeIfOneUse,
			resolveConsumptionWitness: async (input: Parameters<typeof receiptResolver.resolveConsumptionWitness>[0]) =>
				freezeDeep(structuredClone(await resolveConsumptionWitness(input))),
		}),
		keyResolver: freezeWorkflowKeyResolver(context.keyResolver),
		revokedReceiptIds: freezeReadonlyStringSet(context.revokedReceiptIds),
		artifactResolver: freezeWorkflowArtifactResolver(context.artifactResolver),
		principalAuthorizer: Object.freeze({ authorize }),
		...(context.revokeReceipt === undefined ? {} : { revokeReceipt: context.revokeReceipt.bind(context) }),
		...(context.signer === undefined
			? {}
			: {
					signer: Object.freeze({
						keyId: context.signer.keyId,
						signatureAlgorithm: context.signer.signatureAlgorithm,
						sign: context.signer.sign.bind(context.signer),
					}),
				}),
	});
}

function freezeWorkflowBuiltinProvenanceContext(
	context: WorkflowSkillBuiltinProvenanceContext | undefined,
): WorkflowSkillBuiltinProvenanceContext | undefined {
	if (context === undefined) return undefined;
	return Object.freeze({
		artifactResolver: freezeWorkflowArtifactResolver(context.artifactResolver),
		keyResolver: freezeWorkflowKeyResolver(context.keyResolver),
		revokedEventIds: freezeReadonlyStringSet(context.revokedEventIds),
		hostCatalog: freezeDeep({
			vendoredRoot: context.hostCatalog.vendoredRoot,
			registryArtifactRef: cloneArtifactRef(context.hostCatalog.registryArtifactRef),
			sourceManifestArtifactRef: cloneArtifactRef(context.hostCatalog.sourceManifestArtifactRef),
		}),
	});
}

function freezeWorkflowSkillEffectPolicy(
	policy: WorkflowSkillEffectPolicy | undefined,
): WorkflowSkillEffectPolicy | undefined {
	if (policy === undefined) return undefined;
	assertNonEmpty(policy.executionKey, "skill effect execution key");
	if (
		policy.allowedEventKinds.length === 0 ||
		new Set(policy.allowedEventKinds).size !== policy.allowedEventKinds.length
	)
		throw new Error("Skill effect policy must contain unique allowed event kinds.");
	if (policy.allowedEventKinds.some((kind) => typeof kind !== "string" || kind.length === 0))
		throw new Error("Skill effect policy contains an invalid event kind.");
	for (const [index, ref] of policy.allowedArtifactRefs.entries())
		assertArtifactRef(ref, `skill effect policy artifact ${index}`, false);
	if (
		policy.maxEvents !== undefined &&
		(!Number.isSafeInteger(policy.maxEvents) || policy.maxEvents < 1 || policy.maxEvents > MAX_SKILL_EFFECT_EVENTS)
	)
		throw new Error("Skill effect policy event bound is invalid.");
	if (
		policy.maxArtifactRefs !== undefined &&
		(!Number.isSafeInteger(policy.maxArtifactRefs) ||
			policy.maxArtifactRefs < 1 ||
			policy.maxArtifactRefs > MAX_SKILL_EFFECT_ARTIFACT_REFS)
	)
		throw new Error("Skill effect policy artifact bound is invalid.");
	return freezeDeep({
		executionKey: policy.executionKey,
		allowedEventKinds: [...policy.allowedEventKinds],
		allowedArtifactRefs: policy.allowedArtifactRefs.map(cloneArtifactRef),
		maxEvents: policy.maxEvents,
		maxArtifactRefs: policy.maxArtifactRefs,
	});
}

export function createWorkflowSkillHostAdapter(input: WorkflowSkillHostAdapter): WorkflowSkillHostAdapter {
	if (input.invocationStore.durability !== "durable") throw new WorkflowSkillDurableStoreRequiredError();
	if (typeof input.invocationStore.consume !== "function")
		throw new Error("Skill host adapter requires a durable invocation consume store.");
	if (typeof input.invocationStore.claimExecution !== "function")
		throw new Error("Skill host adapter requires a durable execution claim store.");
	assertActiveHostStateReader(input.invocationStore.activeHostState);
	if (
		input.verifyExecutionEffects !== undefined &&
		input.invocationStore.activeHostState.verifySuccessorEffectChain === undefined
	)
		throw new Error("Skill host effect verification must be bound to the authenticated runtime store.");
	const invocationStore = freezeDurableInvocationStore(input.invocationStore);
	const loader = freezeWorkflowResourceLoader(input.loader);
	const artifacts = freezeWorkflowArtifactResolver(input.artifacts);
	const publisher = freezeWorkflowArtifactPublisher(input.publisher);
	const receiptContext = freezeWorkflowReceiptContext(input.receiptContext);
	const builtinProvenanceContext = freezeWorkflowBuiltinProvenanceContext(input.builtinProvenanceContext);
	const effectPolicy = freezeWorkflowSkillEffectPolicy(input.effectPolicy);
	const builtinProvenanceContextForSnapshot =
		input.builtinProvenanceContextForSnapshot === undefined
			? undefined
			: (snapshot: WorkflowSkillSnapshot) =>
					freezeWorkflowBuiltinProvenanceContext(input.builtinProvenanceContextForSnapshot!(snapshot));
	return Object.freeze({
		...input,
		loader,
		artifacts,
		publisher,
		receiptContext,
		builtinProvenanceContext,
		builtinProvenanceContextForSnapshot,
		effectPolicy,
		invocationStore,
		loaderProvenance: freezeDeep(cloneLoaderProvenance(input.loaderProvenance)),
	});
}

export function createWorkflowSkillTestAdapter(input: WorkflowSkillTestHostBinding): WorkflowSkillTestHostBinding {
	if (input.invocationStore.durability !== "test")
		throw new Error("Test skill adapter requires an explicitly marked test-only invocation store.");
	return Object.freeze({ ...input, loaderProvenance: freezeDeep(cloneLoaderProvenance(input.loaderProvenance)) });
}

export type WorkflowSkillHostSnapshotInput = Omit<
	WorkflowSkillSnapshotInput,
	"artifacts" | "publisher" | "loader" | "loaderProvenance" | "receiptContext" | "builtinProvenanceContext"
>;

export type WorkflowSkillHostInvocationContext = Omit<
	WorkflowSkillInvocationContext,
	"loader" | "receiptContext" | "builtinProvenanceContext"
>;

export interface WorkflowSkillSnapshotService {
	createSnapshot(input: WorkflowSkillHostSnapshotInput): Promise<WorkflowSkillSnapshot>;
	reissueSnapshot(
		snapshot: WorkflowSkillSnapshot,
		input: WorkflowSkillSnapshotReissueInput,
	): Promise<WorkflowSkillSnapshot>;
	validateAndConsume(
		snapshot: WorkflowSkillSnapshot,
		token: string | Readonly<Uint8Array>,
		current: WorkflowSkillHostInvocationContext,
		options?: WorkflowSkillInvocationValidationOptions,
	): Promise<WorkflowSkillInvocationAdmission | undefined>;
}

export interface WorkflowSkillSnapshotReissueInput {
	/** Sequence allocated by the host's durable invocation sequencer. */
	consumeSequence: number;
	/** Trusted host time used for the rebased invocation token. */
	trustedNow: string;
}

export function createWorkflowSkillSnapshotService(input: WorkflowSkillHostAdapter): WorkflowSkillSnapshotService {
	const adapter = createWorkflowSkillHostAdapter(input);
	const loaderProvenance = adapter.loaderProvenance;
	return Object.freeze({
		createSnapshot: (snapshotInput: WorkflowSkillHostSnapshotInput) =>
			createSkillSnapshot({
				...snapshotInput,
				artifacts: adapter.artifacts,
				publisher: adapter.publisher,
				loader: adapter.loader,
				loaderProvenance,
				receiptContext: adapter.receiptContext,
				builtinProvenanceContext: adapter.builtinProvenanceContext,
			}),
		reissueSnapshot: (snapshot: WorkflowSkillSnapshot, reissueInput: WorkflowSkillSnapshotReissueInput) =>
			reissueWorkflowSkillInvocationSnapshot(snapshot, adapter.invocationStore.activeHostState, reissueInput),
		validateAndConsume: (
			snapshot: WorkflowSkillSnapshot,
			token: string | Readonly<Uint8Array>,
			current: WorkflowSkillHostInvocationContext,
			options?: WorkflowSkillInvocationValidationOptions,
		) => {
			if (digestObject(snapshot.loaderProvenance) !== digestObject(loaderProvenance))
				throw new Error("Skill snapshot host loader provenance drifted.");
			const builtinProvenanceContext =
				adapter.builtinProvenanceContextForSnapshot?.(snapshot) ?? adapter.builtinProvenanceContext;
			return validateAndConsumeSkillInvocation(
				snapshot,
				token,
				adapter.invocationStore,
				adapter.artifacts,
				{
					...current,
					loader: adapter.loader,
					receiptContext: adapter.receiptContext,
					builtinProvenanceContext,
				},
				options,
			);
		},
	});
}

export interface WorkflowSkillProductionExecutionAdapter extends WorkflowSkillSnapshotService {
	execute<TResult>(
		admission: WorkflowSkillInvocationAdmission,
		snapshot: WorkflowSkillSnapshot,
		current: WorkflowSkillHostInvocationContext,
		executor: WorkflowSkillExecutor<TResult>,
	): Promise<TResult>;
}

/** Return true only for an adapter constructed by the authenticated skill host factory. */
export function isWorkflowSkillProductionExecutionAdapter(
	value: unknown,
	runtimeStore?: WorkflowRuntimeStore,
): value is WorkflowSkillProductionExecutionAdapter {
	return (
		typeof value === "object" &&
		value !== null &&
		AUTHENTICATED_PRODUCTION_EXECUTION_ADAPTERS.has(value) &&
		(runtimeStore === undefined || PRODUCTION_EXECUTION_ADAPTER_RUNTIME_STORES.get(value) === runtimeStore)
	);
}

export function createWorkflowSkillProductionExecutionAdapter(
	input: WorkflowSkillHostAdapter,
): WorkflowSkillProductionExecutionAdapter {
	const host = createWorkflowSkillHostAdapter(input);
	const service = createWorkflowSkillSnapshotService(host);
	const execute = <TResult>(
		admission: WorkflowSkillInvocationAdmission,
		snapshot: WorkflowSkillSnapshot,
		current: WorkflowSkillHostInvocationContext,
		executor: WorkflowSkillExecutor<TResult>,
	): Promise<TResult> =>
		executeWorkflowSkillInvocation(
			admission,
			executor,
			createWorkflowSkillExecutionVerificationContext(host, snapshot, current),
		);
	const adapter = Object.freeze({
		createSnapshot: service.createSnapshot,
		reissueSnapshot: service.reissueSnapshot,
		validateAndConsume: service.validateAndConsume,
		execute,
	});
	AUTHENTICATED_PRODUCTION_EXECUTION_ADAPTERS.add(adapter);
	const runtimeStore = SKILL_HOST_STATE_RUNTIME_STORES.get(host.invocationStore.activeHostState);
	if (runtimeStore !== undefined) PRODUCTION_EXECUTION_ADAPTER_RUNTIME_STORES.set(adapter, runtimeStore);
	return adapter;
}

export interface WorkflowSkillExecutionInput {
	workflowId: string;
	taskId: string;
	decisionRef: WorkflowDecisionRef;
	attemptId: string;
	skillName: string;
	skillKind: "markdown" | "python";
	disableModelInvocation: boolean;
	artifacts: WorkflowSkillInvocationArtifacts;
}

export interface WorkflowSkillExecutor<TResult> {
	execute(input: WorkflowSkillExecutionInput): Promise<TResult>;
}

export interface WorkflowSkillExecutionVerificationContext {
	snapshot: WorkflowSkillSnapshot;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	receiptContext: WorkflowHostReceiptConsumerContext;
	host: WorkflowSkillHostAdapter;
	current: WorkflowSkillHostInvocationContext;
}

export function createWorkflowSkillExecutionVerificationContext(
	adapter: WorkflowSkillHostAdapter,
	snapshot: WorkflowSkillSnapshot,
	current: WorkflowSkillHostInvocationContext,
): WorkflowSkillExecutionVerificationContext {
	const baseHost = createWorkflowSkillHostAdapter(adapter);
	const host = createWorkflowSkillHostAdapter({
		...baseHost,
		builtinProvenanceContext:
			baseHost.builtinProvenanceContextForSnapshot?.(snapshot) ?? baseHost.builtinProvenanceContext,
		builtinProvenanceContextForSnapshot: undefined,
	});
	if (!isDeepFrozen(snapshot)) throw new Error("Skill execution verification requires a frozen snapshot.");
	if (digestObject(snapshot.loaderProvenance) !== digestObject(host.loaderProvenance))
		throw new Error("Skill execution verification adapter is not bound to the snapshot loader provenance.");
	const frozenCurrent = freezeDeep({
		...current,
		decisionRef: cloneDecisionRef(current.decisionRef),
		epochRef: cloneEpochRef(current.epochRef),
	});
	return Object.freeze({
		snapshot,
		loaderProvenance: host.loaderProvenance,
		receiptContext: host.receiptContext,
		host,
		current: frozenCurrent,
	});
}

type WorkflowSkillInvocationAdmissionUnsigned = Omit<WorkflowSkillInvocationAdmission, "admissionDigest">;

function computeInvocationAdmissionDigest(
	admission: WorkflowSkillInvocationAdmissionUnsigned | WorkflowSkillInvocationAdmission,
): string {
	const { admissionDigest: _admissionDigest, ...unsigned } = admission as WorkflowSkillInvocationAdmission;
	return digestObject(unsigned);
}

function assertAdmissionShape(admission: WorkflowSkillInvocationAdmission): void {
	const requiredKeys = [
		"status",
		"workflowId",
		"taskId",
		"decisionRef",
		"attemptId",
		"configDigest",
		"workspaceDigest",
		"dependencyManifestDigest",
		"workflowContractRevision",
		"skillName",
		"skillKind",
		"disableModelInvocation",
		"snapshotDigest",
		"loaderProvenance",
		"loaderResultDigest",
		"loaderReceiptConsumptionWitness",
		"hostVerificationReceipt",
		"invocationTokenId",
		"invocationTokenHash",
		"invocationTokenBytesDigest",
		"consumeSequence",
		"epochRef",
		"journalHeadDigest",
		"trustedNow",
		"requiredApprovalGates",
		"requiredArtifactKinds",
		"requiredPressureTests",
		"allowedTransitions",
		"consumptionWitness",
		"artifacts",
		"admissionDigest",
	];
	const actualKeys = Object.keys(admission);
	if (actualKeys.length !== requiredKeys.length || actualKeys.some((key) => !requiredKeys.includes(key)))
		throw new Error("Skill execution admission has an unknown or missing field.");
	if (admission.status !== "admitted") throw new Error("Skill execution admission status is not admitted.");
}

function assertImmutableExecutionArtifact(
	artifact: WorkflowSkillImmutableArtifact,
	expectedRef: WorkflowArtifactRef,
	label: string,
	maxBytes: number,
): void {
	assertDenseByteArray(artifact.bytes, `execution ${label}`, maxBytes);
	if (!sameArtifactRef(artifact.ref, expectedRef)) throw new Error(`Skill execution ${label} ref drifted.`);
	if (artifact.bytes.length > maxBytes || artifact.bytes.length !== expectedRef.sizeBytes)
		throw new Error(`Skill execution ${label} bytes exceed the immutable bound.`);
	if (sha256Hex(Uint8Array.from(artifact.bytes)) !== expectedRef.digest)
		throw new Error(`Skill execution ${label} bytes are not content addressed.`);
}

function assertExecutionArtifacts(admission: WorkflowSkillInvocationAdmission, snapshot: WorkflowSkillSnapshot): void {
	assertImmutableExecutionArtifact(
		admission.artifacts.source,
		snapshot.sourceArtifactRef,
		"source",
		MAX_SKILL_SOURCE_BYTES,
	);
	if (admission.artifacts.dependencies.length !== snapshot.dependencyRefs.length)
		throw new Error("Skill execution dependency artifact count drifted.");
	for (const [index, artifact] of admission.artifacts.dependencies.entries())
		assertImmutableExecutionArtifact(
			artifact,
			snapshot.dependencyRefs[index],
			`dependency ${index}`,
			MAX_DEPENDENCY_BYTES,
		);
	if (admission.artifacts.packageFiles.length !== snapshot.packageArtifactRefs.length)
		throw new Error("Skill execution package artifact count drifted.");
	for (const [index, artifact] of admission.artifacts.packageFiles.entries())
		assertImmutableExecutionArtifact(
			artifact,
			snapshot.packageArtifactRefs[index],
			`package ${index}`,
			MAX_PACKAGE_FILE_BYTES,
		);
	if (snapshot.manifestArtifactRef === null) {
		if (admission.artifacts.manifest !== null) throw new Error("Skill execution manifest artifact drifted.");
	} else if (admission.artifacts.manifest === null) {
		throw new Error("Skill execution manifest artifact is missing.");
	} else {
		assertImmutableExecutionArtifact(
			admission.artifacts.manifest,
			snapshot.manifestArtifactRef,
			"manifest",
			MAX_MANIFEST_VALUE_BYTES,
		);
	}
}

function assertAdmissionSnapshotBinding(
	admission: WorkflowSkillInvocationAdmission,
	snapshot: WorkflowSkillSnapshot,
): void {
	if (
		admission.workflowId !== snapshot.workflowId ||
		admission.taskId !== snapshot.taskId ||
		digestObject(admission.decisionRef) !== digestObject(snapshot.decisionRef) ||
		admission.attemptId !== snapshot.attemptId ||
		admission.configDigest !== snapshot.configDigest ||
		admission.workspaceDigest !== snapshot.workspaceDigest ||
		admission.dependencyManifestDigest !== snapshot.authoritativeDependencyManifestDigest ||
		admission.workflowContractRevision !== snapshot.workflowContractRevision ||
		admission.skillName !== snapshot.skillName ||
		admission.skillKind !== snapshot.skillKind ||
		admission.disableModelInvocation !== snapshot.disableModelInvocation ||
		admission.loaderResultDigest !== snapshot.loaderResultDigest ||
		digestObject(admission.loaderReceiptConsumptionWitness) !==
			digestObject(snapshot.loaderReceiptConsumptionWitness) ||
		digestObject(admission.hostVerificationReceipt) !== digestObject(snapshot.hostVerificationReceipt) ||
		admission.invocationTokenId !== snapshot.invocationTokenId ||
		admission.invocationTokenHash !== snapshot.invocationTokenHash ||
		admission.invocationTokenBytesDigest !== snapshot.invocationTokenBytesDigest ||
		admission.consumeSequence !== snapshot.consumeSequence ||
		admission.epochRef.storeEpoch !== snapshot.epochRef.storeEpoch ||
		admission.epochRef.coordinatorEpoch !== snapshot.epochRef.coordinatorEpoch ||
		admission.journalHeadDigest !== snapshot.journalHeadDigest ||
		admission.trustedNow !== snapshot.trustedNow
	)
		throw new Error("Skill execution admission is not bound to the immutable snapshot.");
	if (snapshot.manifest === null) throw new Error("Skill execution snapshot has no immutable gate manifest.");
	if (
		digestObject(admission.requiredApprovalGates) !== digestObject(snapshot.manifest.requiredApprovalGates) ||
		digestObject(admission.requiredArtifactKinds) !== digestObject(snapshot.manifest.requiredArtifactKinds) ||
		digestObject(admission.requiredPressureTests) !== digestObject(snapshot.manifest.requiredPressureTests) ||
		digestObject(admission.allowedTransitions) !== digestObject(snapshot.manifest.allowedTransitions)
	)
		throw new Error("Skill execution gate admission is not bound to the immutable snapshot.");
}

function workflowSkillEffectCapabilityDigest(
	admission: WorkflowSkillInvocationAdmission,
	executionKey: string,
): string {
	return digestObject({
		kind: "workflow-skill-effect-capability",
		workflowId: admission.workflowId,
		taskId: admission.taskId,
		decisionRef: admission.decisionRef,
		attemptId: admission.attemptId,
		snapshotDigest: admission.snapshotDigest,
		admissionDigest: admission.admissionDigest,
		invocationTokenId: admission.invocationTokenId,
		consumeSequence: admission.consumeSequence,
		epochRef: admission.epochRef,
		priorHeadDigest: admission.journalHeadDigest,
		executionKey,
	});
}

function workflowSkillAdmissionArtifactRefs(
	admission: WorkflowSkillInvocationAdmission,
): readonly WorkflowArtifactRef[] {
	const refs = [
		admission.artifacts.source.ref,
		...admission.artifacts.dependencies.map((artifact) => artifact.ref),
		...admission.artifacts.packageFiles.map((artifact) => artifact.ref),
	];
	if (admission.artifacts.manifest !== null) refs.push(admission.artifacts.manifest.ref);
	const unique = new Map<string, WorkflowArtifactRef>();
	for (const ref of refs) unique.set(`${ref.artifactId}\0${ref.digest}`, cloneArtifactRef(ref));
	return Object.freeze([...unique.values()]);
}

function assertWorkflowSkillEffectChain(
	chain: WorkflowSkillEffectChain,
	input: WorkflowSkillEffectChainVerificationInput,
): void {
	if (chain === null || typeof chain !== "object")
		throw new Error("Skill effect verifier returned no authenticated chain.");
	if (
		chain.workflowId !== input.workflowId ||
		chain.priorHeadDigest !== input.priorHeadDigest ||
		chain.expectedEpoch.storeEpoch !== input.expectedEpoch.storeEpoch ||
		chain.expectedEpoch.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
		chain.executionKey !== input.executionKey ||
		chain.capabilityDigest !== input.capabilityDigest
	)
		throw new Error("Skill effect verifier returned a foreign invocation chain.");
	const maxEvents = input.maxEvents ?? MAX_SKILL_EFFECT_EVENTS;
	const maxArtifactRefs = input.maxArtifactRefs ?? MAX_SKILL_EFFECT_ARTIFACT_REFS;
	if (!Array.isArray(chain.events) || chain.events.length > maxEvents)
		throw new Error("Skill effect verifier returned an unbounded event chain.");
	const allowedKinds = new Set(input.allowedEventKinds);
	const allowedArtifactRefs = input.allowedArtifactRefs;
	let artifactCount = 0;
	let previousDigest = input.priorHeadDigest;
	let previousSequence: number | null = null;
	for (const [index, event] of chain.events.entries()) {
		if (
			event.workflowId !== input.workflowId ||
			event.epochRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
			event.epochRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
			event.executionKey !== input.executionKey ||
			!allowedKinds.has(event.kind) ||
			event.priorEventDigest !== previousDigest
		)
			throw new Error(`Skill effect verifier returned an unbound event ${index}.`);
		if (previousSequence !== null && event.sequence !== previousSequence + 1)
			throw new Error("Skill effect verifier returned a non-contiguous event chain.");
		assertDigest(event.eventDigest, `skill effect verifier event ${index} digest`);
		artifactCount += event.artifactRefs.length;
		if (artifactCount > maxArtifactRefs) throw new Error("Skill effect verifier returned too many artifacts.");
		for (const [artifactIndex, ref] of event.artifactRefs.entries()) {
			assertArtifactRef(ref, `skill effect verifier artifact ${artifactIndex}`, false);
			if (!allowedArtifactRefs.some((allowed) => sameArtifactRef(allowed, ref)))
				throw new Error("Skill effect verifier returned an unauthorized artifact.");
		}
		previousDigest = event.eventDigest;
		previousSequence = event.sequence;
	}
	if (chain.successorHeadDigest !== previousDigest)
		throw new Error("Skill effect verifier successor head is not the end of the authenticated chain.");
	if (chain.chainDigest !== computeWorkflowSkillEffectChainDigest(chain))
		throw new Error("Skill effect verifier chain digest failed verification.");
}

export function executeWorkflowSkillInvocation<TResult>(
	admission: WorkflowSkillInvocationAdmission,
	executor: WorkflowSkillExecutor<TResult>,
	verification: WorkflowSkillExecutionVerificationContext,
): Promise<TResult> {
	if (!isDeepFrozen(admission)) throw new Error("Skill execution requires a frozen immutable admission contract.");
	assertAdmissionShape(admission);
	assertSnapshot(verification.snapshot);
	assertExecutionArtifacts(admission, verification.snapshot);
	if (admission.admissionDigest !== computeInvocationAdmissionDigest(admission))
		throw new Error("Skill execution admission digest verification failed.");
	if (admission.snapshotDigest !== verification.snapshot.snapshotDigest)
		throw new Error("Skill execution admission is bound to a different snapshot.");
	if (digestObject(admission.loaderProvenance) !== digestObject(verification.loaderProvenance))
		throw new Error("Skill execution loader provenance drifted.");
	if (digestObject(admission.loaderProvenance) !== digestObject(verification.snapshot.loaderProvenance))
		throw new Error("Skill execution loader provenance is not snapshot-bound.");
	assertAdmissionSnapshotBinding(admission, verification.snapshot);
	assertExecutionCurrentBinding(admission, verification.current);
	assertDecisionWorkflowBinding(admission.decisionRef, admission.workflowId, "execution decision reference");
	assertEpochRef(admission.epochRef, "execution epoch");
	assertDecisionEpochBinding(admission.decisionRef, admission.epochRef, "execution");
	assertNonEmpty(admission.configDigest, "execution configuration digest");
	assertNonEmpty(admission.workspaceDigest, "execution workspace digest");
	assertDigest(admission.dependencyManifestDigest, "execution dependency manifest digest");
	assertDigest(admission.loaderResultDigest, "execution loader result digest");
	assertDigest(admission.invocationTokenHash, "execution invocation token hash");
	assertDigest(admission.invocationTokenBytesDigest, "execution invocation token bytes digest");
	if (
		admission.invocationTokenId !== `skill-token:${admission.invocationTokenHash}` ||
		admission.invocationTokenHash !== admission.invocationTokenBytesDigest
	)
		throw new Error("Skill execution invocation token metadata drifted.");
	assertHostReceipt(
		admission.hostVerificationReceipt,
		admission.workflowId,
		admission.workspaceDigest,
		admission.loaderProvenance.loaderRevision,
	);
	if (digestObject(admission.hostVerificationReceipt) !== digestObject(admission.loaderProvenance.issuanceReceipt))
		throw new Error("Skill execution host receipt is not bound to loader provenance.");
	const expectedBindingDigest = getWorkflowResourceLoaderReceiptBindingDigest({
		workflowId: admission.workflowId,
		workspaceDigest: admission.workspaceDigest,
		loaderRevision: admission.loaderProvenance.loaderRevision,
		loaderResultDigest: admission.loaderResultDigest,
	});
	if (admission.hostVerificationReceipt.bindingDigest !== expectedBindingDigest)
		throw new Error("Skill execution host receipt binding drifted.");
	return verifyExecutionReceiptAndInvoke(admission, executor, verification);
}

async function verifyExecutionReceiptAndInvoke<TResult>(
	admission: WorkflowSkillInvocationAdmission,
	executor: WorkflowSkillExecutor<TResult>,
	verification: WorkflowSkillExecutionVerificationContext,
): Promise<TResult> {
	await assertActiveHostStateBinding(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		verification.current.journalHeadDigest,
		"skill execution pre-revalidation",
	);
	const expectedBindingDigest = getWorkflowResourceLoaderReceiptBindingDigest({
		workflowId: admission.workflowId,
		workspaceDigest: admission.workspaceDigest,
		loaderRevision: admission.loaderProvenance.loaderRevision,
		loaderResultDigest: admission.loaderResultDigest,
	});
	const verified = await resolveVerifiedLoaderReceipt({
		receipt: admission.hostVerificationReceipt,
		context: verification.receiptContext,
		workflowId: admission.workflowId,
		workspaceDigest: admission.workspaceDigest,
		loaderRevision: admission.loaderProvenance.loaderRevision,
		loaderResultDigest: admission.loaderResultDigest,
		trustedNow: admission.loaderReceiptConsumptionWitness.consumedAt,
		consume: false,
	});
	assertVerifiedReceiptIdentity(admission.hostVerificationReceipt, verified.receipt);
	assertLoaderReceiptConsumptionWitness({
		witness: verified.consumptionWitness,
		receipt: verified.receipt,
		workflowId: admission.workflowId,
		expectedBindingDigest,
		trustedNow: admission.trustedNow,
	});
	if (digestObject(admission.loaderReceiptConsumptionWitness) !== digestObject(verified.consumptionWitness))
		throw new Error("Skill execution loader receipt consumption witness drifted.");
	await assertActiveHostStateBinding(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		verification.current.journalHeadDigest,
		"skill execution witness verification",
	);
	await assertInvocationConsumptionWitness(
		admission.consumptionWitness,
		{
			workflowId: admission.workflowId,
			taskId: admission.taskId,
			decisionRef: admission.decisionRef,
			attemptId: admission.attemptId,
			snapshotDigest: admission.snapshotDigest,
			invocationTokenId: admission.invocationTokenId,
			tokenHash: admission.invocationTokenHash,
			configDigest: admission.configDigest,
			dependencyManifestDigest: admission.dependencyManifestDigest,
			consumeSequence: admission.consumeSequence,
			expectedEpoch: admission.epochRef,
			journalHeadDigest: admission.journalHeadDigest,
			trustedNow: admission.trustedNow,
		},
		{ trustedNow: admission.trustedNow, receiptContext: verification.receiptContext },
	);
	const refreshedArtifacts = await revalidateSkillSnapshot(verification.snapshot, verification.host.artifacts, {
		...verification.current,
		loader: verification.host.loader,
		receiptContext: verification.receiptContext,
		builtinProvenanceContext: verification.host.builtinProvenanceContext,
	});
	assertExecutionArtifacts({ ...admission, artifacts: refreshedArtifacts }, verification.snapshot);
	if (digestObject(admission.artifacts) !== digestObject(refreshedArtifacts))
		throw new Error("Skill execution artifacts drifted after admission revalidation.");
	await assertActiveHostStateBinding(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		verification.current.journalHeadDigest,
		"skill execution pre-CAS",
	);
	const claimInput: WorkflowSkillExecutionClaimInput = {
		workflowId: admission.workflowId,
		taskId: admission.taskId,
		decisionRef: cloneDecisionRef(admission.decisionRef),
		attemptId: admission.attemptId,
		snapshotDigest: admission.snapshotDigest,
		admissionDigest: admission.admissionDigest,
		invocationTokenId: admission.invocationTokenId,
		tokenHash: admission.invocationTokenHash,
		configDigest: admission.configDigest,
		workspaceDigest: admission.workspaceDigest,
		dependencyManifestDigest: admission.dependencyManifestDigest,
		workflowContractRevision: admission.workflowContractRevision,
		consumeSequence: admission.consumeSequence,
		expectedEpoch: cloneEpochRef(verification.current.epochRef),
		journalHeadDigest: verification.current.journalHeadDigest,
		trustedNow: verification.current.trustedNow,
	};
	const claimWitness = await verification.host.invocationStore.claimExecution(claimInput);
	await assertExecutionClaimWitness(claimWitness, claimInput, verification.receiptContext);
	await assertActiveHostStateBinding(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		verification.current.journalHeadDigest,
		"skill execution post-claim",
	);
	const effectExecution = await withActiveHostStateLease(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		verification.current.journalHeadDigest,
		"skill execution effects",
		async (active) => {
			const result = await executor.execute({
				workflowId: admission.workflowId,
				taskId: admission.taskId,
				decisionRef: cloneDecisionRef(admission.decisionRef),
				attemptId: admission.attemptId,
				skillName: admission.skillName,
				skillKind: admission.skillKind,
				disableModelInvocation: admission.disableModelInvocation,
				artifacts: refreshedArtifacts,
			});
			if (verification.host.verifyExecutionEffects !== undefined) {
				const postEffects = await verification.host.verifyExecutionEffects({
					workflowId: admission.workflowId,
					epochRef: cloneEpochRef(active.epochRef),
					priorJournalHeadDigest: active.journalHeadDigest,
					priorJournalHeadSequence: active.journalHeadSequence,
					admissionDigest: admission.admissionDigest,
					invocationTokenId: admission.invocationTokenId,
					consumeSequence: admission.consumeSequence,
					skillName: admission.skillName,
					result,
				});
				assertActiveHostStateValue(
					postEffects,
					admission.workflowId,
					active.epochRef,
					postEffects.journalHeadDigest,
					"skill execution post-effects",
				);
				return { result, successorHeadDigest: postEffects.journalHeadDigest };
			}
			if (
				verification.host.invocationStore.activeHostState.verifySuccessorEffectChain !== undefined &&
				verification.host.effectPolicy !== undefined
			) {
				const effectPolicy = verification.host.effectPolicy;
				const effectInput: WorkflowSkillEffectChainVerificationInput = {
					workflowId: admission.workflowId,
					priorHeadDigest: active.journalHeadDigest,
					priorHeadSequence: active.journalHeadSequence,
					expectedEpoch: cloneEpochRef(active.epochRef),
					executionKey: effectPolicy.executionKey,
					capabilityDigest: workflowSkillEffectCapabilityDigest(admission, effectPolicy.executionKey),
					allowedEventKinds:
						effectPolicy.allowedEventKinds.length > 0
							? effectPolicy.allowedEventKinds
							: WORKFLOW_SKILL_DEFAULT_EFFECT_EVENT_KINDS,
					allowedArtifactRefs:
						effectPolicy.allowedArtifactRefs.length > 0
							? effectPolicy.allowedArtifactRefs
							: workflowSkillAdmissionArtifactRefs(admission),
					maxEvents: effectPolicy.maxEvents,
					maxArtifactRefs: effectPolicy.maxArtifactRefs,
				};
				const effectChain =
					await verification.host.invocationStore.activeHostState.verifySuccessorEffectChain(effectInput);
				assertWorkflowSkillEffectChain(effectChain, effectInput);
				return { result, successorHeadDigest: effectChain.successorHeadDigest };
			}
			return { result, successorHeadDigest: active.journalHeadDigest };
		},
	);
	await assertActiveHostStateBinding(
		verification.host.invocationStore.activeHostState,
		admission.workflowId,
		verification.current.epochRef,
		effectExecution.successorHeadDigest,
		"skill execution post-effects",
	);
	return effectExecution.result;
}

interface SkillInspection {
	canonicalPath: string;
	canonicalBaseDir: string;
	canonicalSourceInfoBaseDir: string | null;
	packageRoot: string | null;
	pythonProjectMetadataPath: string | null;
	contentBytes: Uint8Array;
	contentIdentity: WorkflowSkillFileIdentity;
	contentDigest: string;
	packageFiles: readonly PackageFile[];
	pythonProjectMetadataDigest: string | null;
	metadataDigest: string;
}

interface PackageFile {
	name: string;
	sourcePath: string;
	bytes: Uint8Array;
	digest: string;
	identity: WorkflowSkillFileIdentity;
}

interface BuiltinRegistryEntry {
	skillName: string;
	relativePath: string;
	sourceManifestDigest: string;
	sourceBytesDigest: string;
	sourceEventId: string;
}

interface BuiltinRegistry {
	registryKind: "workflow-builtin-registry";
	entries: readonly BuiltinRegistryEntry[];
}

interface BuiltinSourceManifest {
	sourceManifestKind: "workflow-skill-source-manifest";
	skillName: string;
	relativePath: string;
	sourceBytesDigest: string;
	requiredApprovalGates: readonly string[];
	requiredArtifactKinds: readonly string[];
	requiredPressureTests: readonly string[];
	allowedTransitions: readonly string[];
}

function snapshotBuiltinProvenanceFromProof(
	provenance: WorkflowSkillBuiltinProvenance,
): WorkflowSkillBuiltinSnapshotProvenance {
	assertUint8Bytes(provenance.registryBytes, "built-in registry bytes", MAX_BUILTIN_MANIFEST_BYTES);
	assertUint8Bytes(provenance.sourceManifestBytes, "built-in source manifest bytes", MAX_BUILTIN_MANIFEST_BYTES);
	return {
		vendoredRoot: realpathSync(provenance.vendoredRoot),
		registryArtifactRef: cloneArtifactRef(provenance.registryArtifactRef),
		registryBytesDigest: sha256Hex(provenance.registryBytes),
		sourceManifestArtifactRef: cloneArtifactRef(provenance.sourceManifestArtifactRef),
		sourceManifestBytesDigest: sha256Hex(provenance.sourceManifestBytes),
		sourceEvent: { ...provenance.sourceEvent },
	};
}

function builtinSnapshotProvenanceDigest(provenance: WorkflowSkillBuiltinSnapshotProvenance | null): string | null {
	if (provenance === null) return null;
	return digestObject(provenance);
}

function assertNonEmpty(value: string, label: string): void {
	if (typeof value !== "string" || value.length === 0) throw new Error(`Skill ${label} is empty.`);
}

function assertActiveHostStateReader(reader: WorkflowSkillActiveHostStateReader | undefined): void {
	if (
		reader === undefined ||
		reader === null ||
		typeof reader.read !== "function" ||
		typeof reader.withExclusiveLease !== "function"
	)
		throw new Error("Skill durable store requires an active host state reader.");
}

function freezeActiveHostStateReader(reader: WorkflowSkillActiveHostStateReader): WorkflowSkillActiveHostStateReader {
	const read = reader.read.bind(reader);
	const withExclusiveLease = reader.withExclusiveLease.bind(reader);
	const verifySuccessorEffectChain = reader.verifySuccessorEffectChain?.bind(reader);
	return Object.freeze({
		read: async (workflowId: string) => freezeActiveHostState(await read(workflowId)),
		withExclusiveLease: async <T>(
			workflowId: string,
			boundary: string,
			operation: (active: WorkflowSkillActiveHostState) => Promise<T>,
		) => withExclusiveLease(workflowId, boundary, async (active) => operation(freezeActiveHostState(active))),
		...(verifySuccessorEffectChain === undefined
			? {}
			: {
					verifySuccessorEffectChain: async (input: WorkflowSkillEffectChainVerificationInput) =>
						freezeDeep(await verifySuccessorEffectChain(input)),
				}),
	});
}

function freezeActiveHostState(active: WorkflowSkillActiveHostState): WorkflowSkillActiveHostState {
	if (active === null || typeof active !== "object") throw new Error("Skill active host state is invalid.");
	const frozen = {
		workflowId: active.workflowId,
		epochRef: cloneEpochRef(active.epochRef),
		journalHeadDigest: active.journalHeadDigest,
		...(active.journalHeadSequence === undefined ? {} : { journalHeadSequence: active.journalHeadSequence }),
		...(active.executionKey === undefined ? {} : { executionKey: active.executionKey }),
	};
	return freezeDeep(frozen);
}

function freezeDescriptorFs(descriptorFs: WorkflowDescriptorFs): WorkflowDescriptorFs {
	return Object.freeze({
		openRoot: descriptorFs.openRoot.bind(descriptorFs),
		mkdirAt: descriptorFs.mkdirAt.bind(descriptorFs),
		openAt: descriptorFs.openAt.bind(descriptorFs),
		renameAt: descriptorFs.renameAt.bind(descriptorFs),
		unlinkAt: descriptorFs.unlinkAt.bind(descriptorFs),
		syncDirectoryChain: descriptorFs.syncDirectoryChain.bind(descriptorFs),
	});
}

async function withActiveHostStateLease<T>(
	reader: WorkflowSkillActiveHostStateReader,
	workflowId: string,
	expectedEpoch: WorkflowEpochRef,
	expectedJournalHeadDigest: string,
	label: string,
	operation: (active: WorkflowSkillActiveHostState) => Promise<T>,
): Promise<T> {
	assertActiveHostStateReader(reader);
	assertNonEmpty(workflowId, `${label} workflow id`);
	assertEpochRef(expectedEpoch, `${label} expected epoch`);
	assertNonEmpty(expectedJournalHeadDigest, `${label} expected journal head digest`);
	return reader.withExclusiveLease(workflowId, label, async (active) => {
		assertActiveHostStateValue(active, workflowId, expectedEpoch, expectedJournalHeadDigest, label);
		return operation(active);
	});
}

function assertActiveHostStateValue(
	active: WorkflowSkillActiveHostState,
	workflowId: string,
	expectedEpoch: WorkflowEpochRef,
	expectedJournalHeadDigest: string,
	label: string,
): void {
	if (active === null || typeof active !== "object") throw new Error(`Skill ${label} active host state is invalid.`);
	assertNonEmpty(active.workflowId, `${label} active workflow id`);
	assertEpochRef(active.epochRef, `${label} active epoch`);
	assertNonEmpty(active.journalHeadDigest, `${label} active journal head digest`);
	if (
		active.journalHeadSequence !== undefined &&
		(!Number.isSafeInteger(active.journalHeadSequence) || active.journalHeadSequence < 0)
	)
		throw new Error(`Skill ${label} active journal head sequence is invalid.`);
	if (active.executionKey !== undefined && active.executionKey !== null) {
		assertNonEmpty(active.executionKey, `${label} active execution key`);
	}
	if (
		active.workflowId !== workflowId ||
		active.epochRef.storeEpoch !== expectedEpoch.storeEpoch ||
		active.epochRef.coordinatorEpoch !== expectedEpoch.coordinatorEpoch ||
		active.journalHeadDigest !== expectedJournalHeadDigest
	)
		throw new Error(`Skill ${label} is stale or foreign to the active durable host epoch and journal head.`);
}

async function assertActiveHostStateBinding(
	reader: WorkflowSkillActiveHostStateReader,
	workflowId: string,
	expectedEpoch: WorkflowEpochRef,
	expectedJournalHeadDigest: string,
	label: string,
): Promise<WorkflowSkillActiveHostState> {
	assertActiveHostStateReader(reader);
	assertNonEmpty(workflowId, `${label} workflow id`);
	assertEpochRef(expectedEpoch, `${label} expected epoch`);
	assertNonEmpty(expectedJournalHeadDigest, `${label} expected journal head digest`);
	let active: WorkflowSkillActiveHostState;
	try {
		active = await reader.read(workflowId);
	} catch (error) {
		throw new Error(`Skill ${label} active host state could not be read.`, { cause: error });
	}
	assertActiveHostStateValue(active, workflowId, expectedEpoch, expectedJournalHeadDigest, label);
	return {
		workflowId: active.workflowId,
		epochRef: cloneEpochRef(active.epochRef),
		journalHeadDigest: active.journalHeadDigest,
		...(active.executionKey === undefined ? {} : { executionKey: active.executionKey }),
	};
}

function assertDigest(value: string, label: string): void {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`Skill ${label} is not a SHA-256 digest.`);
}

function assertEpochRef(epochRef: WorkflowEpochRef, label: string): void {
	if (
		!Number.isSafeInteger(epochRef.storeEpoch) ||
		epochRef.storeEpoch < 0 ||
		!Number.isSafeInteger(epochRef.coordinatorEpoch) ||
		epochRef.coordinatorEpoch < 0
	)
		throw new Error(`Skill ${label} is not a valid epoch reference.`);
}

function cloneDecisionRef(decisionRef: WorkflowDecisionRef): WorkflowDecisionRef {
	return {
		...decisionRef,
		decisionScope: { ...decisionRef.decisionScope },
	};
}

function assertDecisionRef(decisionRef: WorkflowDecisionRef, label: string): void {
	if (decisionRef === null || typeof decisionRef !== "object") throw new Error(`Skill ${label} is invalid.`);
	assertNonEmpty(decisionRef.decisionId, `${label} id`);
	assertDigest(decisionRef.decisionDigest, `${label} digest`);
	if (!Number.isSafeInteger(decisionRef.revision) || decisionRef.revision < 1)
		throw new Error(`Skill ${label} revision is invalid.`);
	if (!Number.isSafeInteger(decisionRef.storeEpoch) || decisionRef.storeEpoch < 0)
		throw new Error(`Skill ${label} store epoch is invalid.`);
	if (!Number.isSafeInteger(decisionRef.coordinatorEpoch) || decisionRef.coordinatorEpoch < 0)
		throw new Error(`Skill ${label} coordinator epoch is invalid.`);
	if (decisionRef.decisionScope === null || typeof decisionRef.decisionScope !== "object")
		throw new Error(`Skill ${label} scope is invalid.`);
	if (decisionRef.decisionScope.kind !== "workflow") throw new Error(`Skill ${label} scope kind is invalid.`);
	assertNonEmpty(decisionRef.decisionScope.workflowId, `${label} scope workflow id`);
	assertNonEmpty(decisionRef.decisionScope.rootSessionId, `${label} scope root session id`);
}

function assertDecisionWorkflowBinding(decisionRef: WorkflowDecisionRef, workflowId: string, label: string): void {
	assertDecisionRef(decisionRef, label);
	if (decisionRef.decisionScope.workflowId !== workflowId)
		throw new Error(`Skill ${label} is bound to a different workflow.`);
}

function assertDecisionEpochBinding(decisionRef: WorkflowDecisionRef, epochRef: WorkflowEpochRef, label: string): void {
	assertEpochRef(epochRef, `${label} epoch`);
	// Store epoch is the durable anchor and must match: a rotated store is a different history.
	// Coordinator epoch is deliberately excluded. It rotates on every resume as live-coordinator
	// fencing, so requiring it would mean no decision recorded before a restart could ever be
	// referenced after one — the decision itself (id, revision, digest) is unchanged.
	if (decisionRef.storeEpoch !== epochRef.storeEpoch)
		throw new Error(`Skill ${label} decision reference is bound to a different epoch.`);
}

function assertExecutionClaimInput(input: WorkflowSkillExecutionClaimInput): void {
	assertNonEmpty(input.workflowId, "skill execution claim workflow id");
	assertNonEmpty(input.taskId, "skill execution claim task id");
	assertNonEmpty(input.attemptId, "skill execution claim attempt id");
	assertDigest(input.snapshotDigest, "skill execution claim snapshot digest");
	assertDigest(input.admissionDigest, "skill execution claim admission digest");
	assertNonEmpty(input.invocationTokenId, "skill execution claim token id");
	assertDigest(input.tokenHash, "skill execution claim token hash");
	assertNonEmpty(input.configDigest, "skill execution claim configuration digest");
	assertNonEmpty(input.workspaceDigest, "skill execution claim workspace digest");
	assertDigest(input.dependencyManifestDigest, "skill execution claim dependency manifest digest");
	if (!Number.isSafeInteger(input.workflowContractRevision) || input.workflowContractRevision < 1)
		throw new Error("Skill execution claim workflow contract revision is invalid.");
	if (!Number.isSafeInteger(input.consumeSequence) || input.consumeSequence < 1)
		throw new Error("Skill execution claim consume sequence is invalid.");
	assertEpochRef(input.expectedEpoch, "skill execution claim expected epoch");
	assertNonEmpty(input.journalHeadDigest, "skill execution claim journal head digest");
	assertTrustedNow(input.trustedNow);
}

function assertArtifactRef(ref: WorkflowArtifactRef, label: string, requireSkillNamespace = true): void {
	assertNonEmpty(ref.artifactId, `${label} artifact id`);
	assertNonEmpty(ref.relativePath, `${label} relative path`);
	assertDigest(ref.digest, `${label} digest`);
	if (
		ref.relativePath.includes("\\") ||
		ref.relativePath.includes("\0") ||
		ref.relativePath.startsWith("/") ||
		ref.relativePath.includes("//") ||
		ref.relativePath.split("/").some((part) => part === "." || part === ".." || part.length === 0) ||
		(requireSkillNamespace && !ref.relativePath.startsWith(SKILL_ARTIFACT_NAMESPACE))
	)
		throw new Error(`Skill ${label} artifact path is outside the immutable skills namespace.`);
	if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0)
		throw new Error(`Skill ${label} artifact size is invalid.`);
	if (!Number.isSafeInteger(ref.sourceEventSequence) || ref.sourceEventSequence < 0)
		throw new Error(`Skill ${label} artifact source sequence is invalid.`);
}

function sameBytes(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>): boolean {
	assertUint8Bytes(left, "left byte sequence", MAX_PACKAGE_TOTAL_BYTES);
	assertUint8Bytes(right, "right byte sequence", MAX_PACKAGE_TOTAL_BYTES);
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function assertUint8Bytes(
	value: unknown,
	label: string,
	maxBytes = Number.MAX_SAFE_INTEGER,
): asserts value is Uint8Array {
	if (!(value instanceof Uint8Array)) throw new Error(`Skill ${label} must be a Uint8Array.`);
	if (!Number.isSafeInteger(value.byteLength) || value.byteLength > maxBytes)
		throw new Error(`Skill ${label} exceeds the immutable byte limit.`);
	for (let index = 0; index < value.length; index += 1) {
		const byte = value[index];
		if (!Number.isInteger(byte) || byte < 0 || byte > 255)
			throw new Error(`Skill ${label} contains a byte outside the integer 0..255 range.`);
	}
}

function assertDenseByteArray(
	value: unknown,
	label: string,
	maxBytes = Number.MAX_SAFE_INTEGER,
): asserts value is readonly number[] {
	if (!Array.isArray(value)) throw new Error(`Skill ${label} must be a dense byte array.`);
	if (!Number.isSafeInteger(value.length) || value.length > maxBytes)
		throw new Error(`Skill ${label} exceeds the immutable byte limit.`);
	for (let index = 0; index < value.length; index += 1) {
		if (!Object.hasOwn(value, index)) throw new Error(`Skill ${label} contains a sparse byte array.`);
		const byte = value[index];
		if (!Number.isInteger(byte) || byte < 0 || byte > 255)
			throw new Error(`Skill ${label} contains a byte outside the integer 0..255 range.`);
	}
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function fileIdentityFromStats(stats: Stats): WorkflowSkillFileIdentity {
	const fields = {
		device: Number(stats.dev),
		inode: Number(stats.ino),
		size: Number(stats.size),
		mtimeMs: Number(stats.mtimeMs),
		ctimeMs: Number(stats.ctimeMs),
	};
	if (
		!Number.isSafeInteger(fields.device) ||
		fields.device < 0 ||
		!Number.isSafeInteger(fields.inode) ||
		fields.inode < 0 ||
		!Number.isSafeInteger(fields.size) ||
		fields.size < 0 ||
		!Number.isFinite(fields.mtimeMs) ||
		fields.mtimeMs < 0 ||
		!Number.isFinite(fields.ctimeMs) ||
		fields.ctimeMs < 0
	)
		throw new Error("Skill file identity contains an unsafe stat value.");
	return { ...fields, identityDigest: digestObject(fields) };
}

function sameFileIdentityRecord(left: WorkflowSkillFileIdentity, right: WorkflowSkillFileIdentity): boolean {
	return (
		left.device === right.device &&
		left.inode === right.inode &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.identityDigest === right.identityDigest
	);
}

function assertFileIdentity(identity: WorkflowSkillFileIdentity, label: string): void {
	if (identity === null || typeof identity !== "object") throw new Error(`Skill ${label} file identity is invalid.`);
	const fields = {
		device: identity.device,
		inode: identity.inode,
		size: identity.size,
		mtimeMs: identity.mtimeMs,
		ctimeMs: identity.ctimeMs,
	};
	if (
		!Number.isSafeInteger(fields.device) ||
		fields.device < 0 ||
		!Number.isSafeInteger(fields.inode) ||
		fields.inode < 0 ||
		!Number.isSafeInteger(fields.size) ||
		fields.size < 0 ||
		!Number.isFinite(fields.mtimeMs) ||
		fields.mtimeMs < 0 ||
		!Number.isFinite(fields.ctimeMs) ||
		fields.ctimeMs < 0
	)
		throw new Error(`Skill ${label} file identity contains an unsafe stat value.`);
	assertDigest(identity.identityDigest, `${label} file identity digest`);
	if (identity.identityDigest !== digestObject(fields))
		throw new Error(`Skill ${label} file identity digest is not canonical.`);
}

interface StableFileRead {
	bytes: Uint8Array;
	identity: WorkflowSkillFileIdentity;
}

async function readStableFile(path: string, label: string, maxBytes: number): Promise<StableFileRead> {
	const beforePath = await realpath(path);
	const handle = await open(beforePath, "r");
	try {
		const before = await handle.stat();
		if (!before.isFile()) throw new Error(`Skill ${label} is not a regular file.`);
		if (!Number.isSafeInteger(before.size) || before.size > maxBytes)
			throw new Error(`Skill ${label} exceeds the immutable byte limit.`);
		const buffer = Buffer.allocUnsafe(before.size);
		let offset = 0;
		while (offset < before.size) {
			const result = await handle.read(buffer, offset, before.size - offset, offset);
			if (result.bytesRead <= 0) throw new Error(`Skill ${label} changed while being read.`);
			offset += result.bytesRead;
		}
		const bytes = Uint8Array.from(buffer);
		if (bytes.byteLength > maxBytes) throw new Error(`Skill ${label} exceeds the immutable byte limit.`);
		const after = await handle.stat();
		const afterPath = await realpath(path);
		if (!sameFileIdentity(before, after) || afterPath !== beforePath)
			throw new Error(`Skill ${label} changed while being read.`);
		return { bytes, identity: fileIdentityFromStats(after) };
	} finally {
		await handle.close();
	}
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return (
		left.artifactId === right.artifactId &&
		left.relativePath === right.relativePath &&
		left.digest === right.digest &&
		left.sizeBytes === right.sizeBytes &&
		left.sourceEventSequence === right.sourceEventSequence
	);
}

function cloneArtifactRef(ref: WorkflowArtifactRef): WorkflowArtifactRef {
	return { ...ref };
}

function cloneEpochRef(epochRef: WorkflowEpochRef): WorkflowEpochRef {
	return { storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch };
}

function cloneReceipt(receipt: WorkflowVerifiedHostReceipt): WorkflowVerifiedHostReceipt {
	return { ...receipt, artifactRef: cloneArtifactRef(receipt.artifactRef) };
}

function cloneLoaderProvenance(provenance: WorkflowResourceLoaderProvenance): WorkflowResourceLoaderProvenance {
	return {
		...provenance,
		issuanceReceipt: cloneReceipt(provenance.issuanceReceipt),
	};
}

function freezeDeep<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
	return Object.freeze(value);
}

function isDeepFrozen(value: unknown, seen = new Set<object>()): boolean {
	if (value === null || typeof value !== "object") return true;
	if (seen.has(value)) return true;
	if (!Object.isFrozen(value)) return false;
	seen.add(value);
	return Object.values(value as Record<string, unknown>).every((child) => isDeepFrozen(child, seen));
}

/** Compare strings by Unicode code point, including supplementary characters. */
export function compareWorkflowCodePoints(left: string, right: string): number {
	if (left === right) return 0;
	const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		if (leftPoints[index] !== rightPoints[index]) return leftPoints[index] - rightPoints[index];
	}
	return leftPoints.length - rightPoints.length;
}

function sortByCodePoint<T>(values: readonly T[], identity: (value: T) => string): T[] {
	return [...values].sort((left, right) => compareWorkflowCodePoints(identity(left), identity(right)));
}

function normalizeRelativeName(value: string, label: string): string {
	assertNonEmpty(value, label);
	if (
		value.includes("\\") ||
		value.includes("\0") ||
		value.startsWith("/") ||
		value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	)
		throw new Error(`Skill ${label} is not a safe relative identity.`);
	return value;
}

function normalizedSourceInfo(
	skill: Skill,
	canonicalPath: string,
	canonicalSourceInfoBaseDir?: string,
): Record<string, unknown> {
	return {
		path: canonicalPath,
		source: skill.sourceInfo.source,
		scope: skill.sourceInfo.scope,
		origin: skill.sourceInfo.origin,
		baseDir:
			skill.sourceInfo.baseDir === undefined
				? null
				: canonicalSourceInfoBaseDir === undefined
					? resolve(skill.sourceInfo.baseDir)
					: canonicalSourceInfoBaseDir,
	};
}

function normalizedLoaderSkill(skill: Skill): Record<string, unknown> {
	const canonicalPath = realpathSync(skill.filePath);
	const canonicalBaseDir = realpathSync(skill.baseDir);
	const canonicalSourceInfoBaseDir =
		skill.sourceInfo.baseDir === undefined ? undefined : realpathSync(skill.sourceInfo.baseDir);
	return {
		name: skill.name,
		description: skill.description,
		kind: skill.kind,
		filePath: canonicalPath,
		baseDir: canonicalBaseDir,
		sourceInfo: normalizedSourceInfo(skill, canonicalPath, canonicalSourceInfoBaseDir),
		disableModelInvocation: skill.disableModelInvocation,
		python:
			skill.kind === "python"
				? {
						importName: skill.python.importName,
						packagePath: realpathSync(skill.python.packagePath),
						pyprojectPath: realpathSync(skill.python.pyprojectPath),
					}
				: null,
	};
}

async function normalizedRealpathLoaderSkill(skill: Skill): Promise<Record<string, unknown>> {
	const canonicalPath = await realpath(skill.filePath);
	const canonicalBaseDir = await realpath(skill.baseDir);
	const sourceInfoPath = await realpath(skill.sourceInfo.path);
	if (sourceInfoPath !== canonicalPath)
		throw new Error("Skill ResourceLoader source-info path is not the selected realpath.");
	const canonicalSourceInfoBaseDir =
		skill.sourceInfo.baseDir === undefined ? null : await realpath(skill.sourceInfo.baseDir);
	const normalized = normalizedLoaderSkill(skill);
	normalized.filePath = canonicalPath;
	normalized.baseDir = canonicalBaseDir;
	normalized.sourceInfo = normalizedSourceInfo(skill, canonicalPath, canonicalSourceInfoBaseDir ?? undefined);
	if (skill.kind === "python") {
		const packagePath = await realpath(skill.python.packagePath);
		const pyprojectPath = await realpath(skill.python.pyprojectPath);
		normalized.python = {
			importName: skill.python.importName,
			packagePath,
			pyprojectPath,
		};
	}
	return normalized;
}

function normalizedDiagnostic(diagnostic: ResourceDiagnostic): Record<string, unknown> {
	return {
		type: diagnostic.type,
		message: diagnostic.message,
		path: diagnostic.path === undefined ? null : resolve(diagnostic.path),
		collision:
			diagnostic.collision === undefined
				? null
				: {
						resourceType: diagnostic.collision.resourceType,
						name: diagnostic.collision.name,
						winnerPath: resolve(diagnostic.collision.winnerPath),
						loserPath: resolve(diagnostic.collision.loserPath),
						winnerSource: diagnostic.collision.winnerSource ?? null,
						loserSource: diagnostic.collision.loserSource ?? null,
					},
	};
}

function assertLoaderString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string") throw new Error(`Skill ResourceLoader ${label} is not a string.`);
	if (new TextEncoder().encode(value).byteLength > MAX_LOADER_STRING_BYTES)
		throw new Error(`Skill ResourceLoader ${label} exceeds the immutable byte limit.`);
}

function assertLoaderSkillBounds(skill: Skill, index: number): void {
	if (skill === null || typeof skill !== "object") throw new Error(`Skill ResourceLoader skill ${index} is invalid.`);
	assertLoaderString(skill.name, `skill ${index} name`);
	assertLoaderString(skill.description, `skill ${index} description`);
	assertLoaderString(skill.filePath, `skill ${index} file path`);
	assertLoaderString(skill.baseDir, `skill ${index} base directory`);
	assertLoaderString(skill.sourceInfo.path, `skill ${index} source-info path`);
	assertLoaderString(skill.sourceInfo.source, `skill ${index} source-info source`);
	assertLoaderString(skill.sourceInfo.scope, `skill ${index} source-info scope`);
	assertLoaderString(skill.sourceInfo.origin, `skill ${index} source-info origin`);
	if (skill.sourceInfo.baseDir !== undefined)
		assertLoaderString(skill.sourceInfo.baseDir, `skill ${index} source-info base directory`);
	if (skill.kind === "python") {
		assertLoaderString(skill.python.importName, `skill ${index} Python import name`);
		assertLoaderString(skill.python.packagePath, `skill ${index} Python package path`);
		assertLoaderString(skill.python.pyprojectPath, `skill ${index} Python project path`);
	}
}

function assertLoaderDiagnosticBounds(diagnostic: ResourceDiagnostic, index: number): void {
	if (diagnostic === null || typeof diagnostic !== "object")
		throw new Error(`Skill ResourceLoader diagnostic ${index} is invalid.`);
	assertLoaderString(diagnostic.type, `diagnostic ${index} type`);
	assertLoaderString(diagnostic.message, `diagnostic ${index} message`);
	if (diagnostic.path !== undefined) assertLoaderString(diagnostic.path, `diagnostic ${index} path`);
	if (diagnostic.collision !== undefined) {
		assertLoaderString(diagnostic.collision.resourceType, `diagnostic ${index} collision resource type`);
		assertLoaderString(diagnostic.collision.name, `diagnostic ${index} collision name`);
		assertLoaderString(diagnostic.collision.winnerPath, `diagnostic ${index} collision winner path`);
		assertLoaderString(diagnostic.collision.loserPath, `diagnostic ${index} collision loser path`);
		if (diagnostic.collision.winnerSource !== undefined)
			assertLoaderString(diagnostic.collision.winnerSource, `diagnostic ${index} collision winner source`);
		if (diagnostic.collision.loserSource !== undefined)
			assertLoaderString(diagnostic.collision.loserSource, `diagnostic ${index} collision loser source`);
	}
}

function cloneLoaderSkill(skill: Skill): Skill {
	const sourceInfo = { ...skill.sourceInfo };
	if (skill.kind === "python") {
		return {
			...skill,
			sourceInfo,
			python: { ...skill.python },
		};
	}
	return { ...skill, sourceInfo };
}

function cloneLoaderDiagnostic(diagnostic: ResourceDiagnostic): ResourceDiagnostic {
	return {
		...diagnostic,
		collision: diagnostic.collision === undefined ? undefined : { ...diagnostic.collision },
	};
}

function snapshotLoaderResult(rawResult: {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}): WorkflowResourceLoaderResult {
	if (!Array.isArray(rawResult.skills) || rawResult.skills.length > MAX_LOADER_SKILLS)
		throw new Error("Skill ResourceLoader result exceeds the skill-count limit.");
	if (!Array.isArray(rawResult.diagnostics) || rawResult.diagnostics.length > MAX_LOADER_DIAGNOSTICS)
		throw new Error("Skill ResourceLoader result exceeds the diagnostic-count limit.");
	for (const [index, skill] of rawResult.skills.entries()) assertLoaderSkillBounds(skill, index);
	for (const [index, diagnostic] of rawResult.diagnostics.entries()) assertLoaderDiagnosticBounds(diagnostic, index);
	const skills = rawResult.skills.map(cloneLoaderSkill);
	const diagnostics = rawResult.diagnostics.map(cloneLoaderDiagnostic);
	if (canonicalJsonBytes({ skills, diagnostics }).byteLength > MAX_LOADER_RESULT_BYTES)
		throw new Error("Skill ResourceLoader result exceeds the aggregate byte limit.");
	return freezeDeep({
		skills,
		diagnostics,
	});
}

export function getWorkflowResourceLoaderProvenanceDigests(
	result: WorkflowResourceLoaderResult,
	revision = result.revision ?? 1,
): {
	sourceManifestDigest: string;
	diagnosticsDigest: string;
	artifactPathDigest: string;
	loaderResultDigest: string;
} {
	const skills = sortByCodePoint(result.skills, (skill) => {
		const normalized = normalizedLoaderSkill(skill);
		return `${skill.name}\0${normalized.filePath as string}\0${skill.kind}`;
	}).map(normalizedLoaderSkill);
	const diagnostics = sortByCodePoint(result.diagnostics, (diagnostic) => {
		return new TextDecoder().decode(canonicalJsonBytes(normalizedDiagnostic(diagnostic)));
	}).map(normalizedDiagnostic);
	const artifactPaths = sortByCodePoint(
		result.skills.map((skill) => realpathSync(skill.filePath)),
		(value) => value,
	);
	const sourceManifestDigest = digestObject(skills);
	const diagnosticsDigest = digestObject(diagnostics);
	const artifactPathDigest = digestObject(artifactPaths);
	return {
		sourceManifestDigest,
		diagnosticsDigest,
		artifactPathDigest,
		loaderResultDigest: digestObject({
			revision,
			sourceManifestDigest,
			diagnosticsDigest,
			artifactPathDigest,
		}),
	};
}

export function digestWorkflowResourceLoaderResult(result: WorkflowResourceLoaderResult): string {
	return getWorkflowResourceLoaderProvenanceDigests(result).loaderResultDigest;
}

export function getWorkflowResourceLoaderReceiptBindingDigest(input: {
	workflowId: string;
	workspaceDigest: string;
	loaderRevision: number;
	loaderResultDigest: string;
}): string {
	assertNonEmpty(input.workflowId, "workflow id");
	assertNonEmpty(input.workspaceDigest, "workspace digest");
	assertDigest(input.loaderResultDigest, "loader result digest");
	if (!Number.isSafeInteger(input.loaderRevision) || input.loaderRevision < 1)
		throw new Error("Skill ResourceLoader revision is invalid.");
	return digestObject({
		bindingKind: "workflow-resource-loader",
		workflowId: input.workflowId,
		workspaceDigest: input.workspaceDigest,
		loaderRevision: input.loaderRevision,
		loaderResultDigest: input.loaderResultDigest,
	});
}

function assertTrustedNow(trustedNow: string): void {
	assertNonEmpty(trustedNow, "trusted receipt time");
	if (!Number.isFinite(Date.parse(trustedNow))) throw new Error("Skill trusted receipt time is invalid.");
}

function assertHostReceipt(
	receipt: WorkflowVerifiedHostReceipt,
	workflowId: string,
	workspaceDigest: string,
	loaderRevision: number,
): void {
	if (
		receipt.receiptKind !== "artifact" ||
		receipt.issuerId.trim().length === 0 ||
		receipt.workflowId !== workflowId ||
		receipt.signatureAlgorithm !== "ed25519" ||
		receipt.oneUse !== true ||
		receipt.revision !== loaderRevision
	)
		throw new Error("Skill ResourceLoader issuance receipt is not host-authenticated.");
	assertNonEmpty(receipt.receiptId, "ResourceLoader receipt id");
	assertDigest(receipt.bindingDigest, "ResourceLoader receipt binding digest");
	assertDigest(receipt.payloadDigest, "ResourceLoader receipt payload digest");
	assertNonEmpty(receipt.keyId, "ResourceLoader receipt key id");
	assertNonEmpty(receipt.signature, "ResourceLoader receipt signature");
	assertDigest(receipt.verificationDigest, "ResourceLoader receipt verification digest");
	assertDigest(receipt.stateDigest, "ResourceLoader receipt state digest");
	assertDigest(receipt.artifactBytesDigest, "ResourceLoader receipt artifact bytes digest");
	if (receipt.verificationDigest !== digestObject({ ...receipt, verificationDigest: "" }))
		throw new Error("Skill ResourceLoader receipt verification digest is not canonical.");
	if (receipt.artifactBytesDigest !== receipt.artifactRef.digest)
		throw new Error("Skill ResourceLoader receipt is not bound to its artifact bytes.");
	assertArtifactRef(receipt.artifactRef, "ResourceLoader receipt", true);
	if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1)
		throw new Error("Skill ResourceLoader receipt revision is invalid.");
	if (workspaceDigest.length === 0) throw new Error("Skill ResourceLoader receipt has no workspace binding.");
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || validUntil <= issuedAt)
		throw new Error("Skill ResourceLoader receipt validity window is invalid.");
}

function assertVerifiedReceiptIdentity(
	receipt: WorkflowVerifiedHostReceipt,
	verifiedReceipt: WorkflowVerifiedHostReceipt,
): void {
	if (digestObject(receipt) !== digestObject(verifiedReceipt))
		throw new Error("Skill ResourceLoader receipt resolver returned a different receipt.");
}

function assertLoaderReceiptConsumptionWitness(input: {
	witness: WorkflowHostReceiptConsumptionWitness;
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	expectedBindingDigest: string;
	trustedNow: string;
}): void {
	if (!input.receipt.oneUse) throw new Error("Skill ResourceLoader issuance receipt must be one-use.");
	if (
		input.witness.receiptId !== input.receipt.receiptId ||
		input.witness.workflowId !== input.workflowId ||
		input.witness.bindingDigest !== input.expectedBindingDigest
	)
		throw new Error("Skill ResourceLoader receipt consumption witness is not bound to the receipt.");
	assertNonEmpty(input.witness.receiptId, "ResourceLoader receipt witness id");
	assertDigest(input.witness.bindingDigest, "ResourceLoader receipt witness binding digest");
	if (!Number.isSafeInteger(input.witness.consumptionSequence) || input.witness.consumptionSequence < 1)
		throw new Error("Skill ResourceLoader receipt consumption witness sequence is invalid.");
	const consumedAt = Date.parse(input.witness.consumedAt);
	const trustedNow = Date.parse(input.trustedNow);
	if (!Number.isFinite(consumedAt) || !Number.isFinite(trustedNow) || consumedAt > trustedNow)
		throw new Error("Skill ResourceLoader receipt consumption witness time is invalid.");
}

function receiptSignedValue(receipt: WorkflowVerifiedHostReceipt): Record<string, unknown> {
	const { signature: _signature, verificationDigest: _verificationDigest, ...signedValue } = receipt;
	return signedValue;
}

async function resolveVerifiedLoaderReceipt(input: {
	receipt: WorkflowVerifiedHostReceipt;
	context: WorkflowHostReceiptConsumerContext;
	workflowId: string;
	workspaceDigest: string;
	loaderRevision: number;
	loaderResultDigest: string;
	trustedNow: string;
	consume?: boolean;
}): Promise<{
	receipt: WorkflowVerifiedHostReceipt;
	consumptionWitness: WorkflowHostReceiptConsumptionWitness;
}> {
	assertTrustedNow(input.trustedNow);
	const expectedBindingDigest = getWorkflowResourceLoaderReceiptBindingDigest({
		workflowId: input.workflowId,
		workspaceDigest: input.workspaceDigest,
		loaderRevision: input.loaderRevision,
		loaderResultDigest: input.loaderResultDigest,
	});
	const key = await input.context.keyResolver.resolve(input.receipt.keyId);
	if (
		key.algorithm !== input.receipt.signatureAlgorithm ||
		!key.verify({
			bytes: canonicalJsonBytes(receiptSignedValue(input.receipt)),
			signature: input.receipt.signature,
		})
	)
		throw new Error("Skill ResourceLoader receipt signature verification failed.");
	let verifiedReceipt: WorkflowVerifiedHostReceipt;
	try {
		verifiedReceipt = await resolveAndVerifyWorkflowHostReceipt({
			context: input.context,
			workflowId: input.workflowId,
			expectedBindingDigest,
			receipt: input.receipt,
			currentStateDigest: input.loaderResultDigest,
			currentRevision: input.loaderRevision,
			trustedNow: input.trustedNow,
		});
	} catch (error) {
		throw new Error("Skill ResourceLoader receipt failed trusted host verification.", { cause: error });
	}
	assertHostReceipt(verifiedReceipt, input.workflowId, input.workspaceDigest, input.loaderRevision);
	assertVerifiedReceiptIdentity(input.receipt, verifiedReceipt);
	if (
		verifiedReceipt.bindingDigest !== expectedBindingDigest ||
		verifiedReceipt.payloadDigest !== input.loaderResultDigest ||
		verifiedReceipt.stateDigest !== input.loaderResultDigest
	)
		throw new Error("Skill ResourceLoader receipt is not bound to the current loader state.");
	if (input.consume !== false) {
		await input.context.receiptResolver.consumeIfOneUse({
			receipt: verifiedReceipt,
			workflowId: input.workflowId,
			expectedBindingDigest,
			currentRevision: input.loaderRevision,
		});
	}
	let consumptionWitness: WorkflowHostReceiptConsumptionWitness;
	try {
		consumptionWitness = await input.context.receiptResolver.resolveConsumptionWitness({
			receiptId: verifiedReceipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest,
		});
	} catch (error) {
		throw new Error("Skill ResourceLoader receipt durable consumption witness is required.", { cause: error });
	}
	assertLoaderReceiptConsumptionWitness({
		witness: consumptionWitness,
		receipt: verifiedReceipt,
		workflowId: input.workflowId,
		expectedBindingDigest,
		trustedNow: input.trustedNow,
	});
	return { receipt: cloneReceipt(verifiedReceipt), consumptionWitness: structuredClone(consumptionWitness) };
}

function assertLoaderPort(loader: WorkflowResourceLoaderPort, revision: number): void {
	if (loader === undefined || loader === null || typeof loader.getSkills !== "function")
		throw new Error("Skill ResourceLoader port does not expose the host loader API.");
	if (!Number.isSafeInteger(revision) || revision < 1)
		throw new Error("Skill ResourceLoader provenance revision is invalid.");
}

function assertLoaderProvenance(
	provenance: WorkflowResourceLoaderProvenance,
	workflowId: string,
	workspaceDigest: string,
	loaderRevision: number,
	loaderResult: WorkflowResourceLoaderResult,
): void {
	if (
		provenance.issuedBy !== "ResourceLoader" ||
		provenance.artifactNamespace !== "artifacts/skills" ||
		provenance.workspaceDigest !== workspaceDigest ||
		provenance.loaderRevision !== loaderRevision
	)
		throw new Error("Skill ResourceLoader provenance is invalid.");
	assertDigest(provenance.sourceManifestDigest, "ResourceLoader source manifest digest");
	assertDigest(provenance.diagnosticsDigest, "ResourceLoader diagnostics digest");
	assertDigest(provenance.artifactPathDigest, "ResourceLoader artifact path digest");
	assertDigest(provenance.loaderResultDigest, "ResourceLoader result digest");
	const expected = getWorkflowResourceLoaderProvenanceDigests(loaderResult, loaderRevision);
	if (
		provenance.sourceManifestDigest !== expected.sourceManifestDigest ||
		provenance.diagnosticsDigest !== expected.diagnosticsDigest ||
		provenance.artifactPathDigest !== expected.artifactPathDigest ||
		provenance.loaderResultDigest !== expected.loaderResultDigest
	)
		throw new Error("Skill ResourceLoader provenance does not match the current host loader result.");
	if (provenance.issuanceReceipt.payloadDigest !== expected.loaderResultDigest)
		throw new Error("Skill ResourceLoader host receipt is not bound to the current loader result.");
	assertHostReceipt(provenance.issuanceReceipt, workflowId, workspaceDigest, loaderRevision);
}

async function verifyHostReceiptArtifact(
	artifacts: WorkflowArtifactResolver,
	receipt: WorkflowVerifiedHostReceipt,
): Promise<void> {
	if (receipt.artifactRef.sizeBytes > MAX_PACKAGE_TOTAL_BYTES)
		throw new Error("Skill ResourceLoader receipt artifact exceeds the immutable byte limit.");
	let resolved: WorkflowArtifactReadResult;
	try {
		resolved = await artifacts.resolve(receipt.artifactRef);
	} catch (error) {
		throw new Error("Skill ResourceLoader receipt artifact could not be resolver-verified.", { cause: error });
	}
	assertUint8Bytes(resolved.bytes, "ResourceLoader receipt artifact bytes", MAX_PACKAGE_TOTAL_BYTES);
	if (resolved.bytes.byteLength > MAX_PACKAGE_TOTAL_BYTES || resolved.verifiedSizeBytes > MAX_PACKAGE_TOTAL_BYTES)
		throw new Error("Skill ResourceLoader receipt artifact exceeds the immutable byte limit.");
	if (
		!resolved.exists ||
		!resolved.envelope.immutable ||
		resolved.envelope.payloadKind !== "evidence" ||
		!sameArtifactRef(resolved.envelope.ref, receipt.artifactRef) ||
		resolved.verifiedDigest !== receipt.artifactRef.digest ||
		sha256Hex(resolved.bytes) !== receipt.artifactRef.digest ||
		resolved.verifiedSizeBytes !== receipt.artifactRef.sizeBytes ||
		resolved.bytes.byteLength !== receipt.artifactRef.sizeBytes
	)
		throw new Error("Skill ResourceLoader receipt artifact is not immutable host evidence.");
}

function assertContainedPath(path: string, root: string, label: string, allowRoot = false): void {
	const child = resolve(path);
	const parent = resolve(root);
	const childRelative = relative(parent, child);
	if (
		(!allowRoot && childRelative.length === 0) ||
		(childRelative.length > 0 && (childRelative === ".." || childRelative.startsWith(`..${sep}`))) ||
		isAbsolute(childRelative)
	)
		throw new Error(`Skill ${label} escapes its host-owned package root.`);
}

async function realpathContained(path: string, root: string, label: string, allowRoot = false): Promise<string> {
	let resolvedPath: string;
	let resolvedRoot: string;
	try {
		[resolvedPath, resolvedRoot] = await Promise.all([realpath(path), realpath(root)]);
	} catch (error) {
		throw new Error(`Skill ${label} is missing or cannot be realpath-verified.`, { cause: error });
	}
	assertContainedPath(resolvedPath, resolvedRoot, label, allowRoot);
	return resolvedPath;
}

async function collectPackageFiles(root: string, excludedPath: string): Promise<readonly PackageFile[]> {
	const canonicalRoot = await realpath(root);
	const canonicalExcluded = await realpath(excludedPath);
	const files: PackageFile[] = [];
	const visitedDirectories = new Set<string>();
	const visitedFiles = new Set<string>();
	let totalBytes = 0;

	async function visit(directory: string, relativePrefix: string, depth: number): Promise<void> {
		if (depth > MAX_PACKAGE_DEPTH) throw new Error("Skill package traversal exceeds the directory depth limit.");
		const canonicalDirectory = await realpathContained(directory, canonicalRoot, "package directory", true);
		if (visitedDirectories.has(canonicalDirectory))
			throw new Error(`Skill package directory ${relativePrefix || "."} aliases another source directory.`);
		visitedDirectories.add(canonicalDirectory);
		const entries: Dirent[] = [];
		let directoryHandle: Awaited<ReturnType<typeof opendir>> | undefined;
		try {
			directoryHandle = await opendir(canonicalDirectory);
			for await (const entry of directoryHandle) {
				entries.push(entry);
				if (entries.length > MAX_PACKAGE_FILES)
					throw new Error("Skill package traversal exceeds the directory entry-count limit.");
			}
		} catch (error) {
			throw new Error("Skill package directory could not be read.", { cause: error });
		} finally {
			if (directoryHandle !== undefined) await directoryHandle.close().catch(() => undefined);
		}
		const orderedEntries = sortByCodePoint(entries, (entry) => entry.name);
		for (const entry of orderedEntries) {
			if (entry.name === "__pycache__" || entry.name.endsWith(".pyc"))
				throw new Error(`Skill package member ${entry.name} is executable Python bytecode.`);
			const candidate = resolve(canonicalDirectory, entry.name);
			const canonicalCandidate = await realpathContained(candidate, canonicalRoot, "package member");
			const name = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
			if (resolve(canonicalCandidate) === canonicalExcluded) continue;
			const info = await stat(canonicalCandidate);
			if (info.isDirectory()) {
				await visit(canonicalCandidate, name, depth + 1);
			} else if (info.isFile()) {
				if (files.length >= MAX_PACKAGE_FILES)
					throw new Error("Skill package traversal exceeds the file-count limit.");
				if (!Number.isSafeInteger(info.size) || info.size > MAX_PACKAGE_FILE_BYTES)
					throw new Error(`Skill package member ${name} exceeds the immutable byte limit.`);
				if (totalBytes + info.size > MAX_PACKAGE_TOTAL_BYTES)
					throw new Error("Skill package traversal exceeds the total byte limit.");
				if (visitedFiles.has(canonicalCandidate))
					throw new Error(`Skill package member ${name} aliases another source file.`);
				visitedFiles.add(canonicalCandidate);
				const stable = await readStableFile(canonicalCandidate, `package member ${name}`, MAX_PACKAGE_FILE_BYTES);
				totalBytes += stable.bytes.byteLength;
				files.push({
					name,
					sourcePath: canonicalCandidate,
					bytes: stable.bytes,
					digest: sha256Hex(stable.bytes),
					identity: stable.identity,
				});
			} else {
				throw new Error(`Skill package member ${name} is not a regular file.`);
			}
		}
	}

	await visit(canonicalRoot, "", 0);
	return sortByCodePoint(files, (file) => file.name);
}

function packageClosureDigest(
	files: readonly {
		name: string;
		sourcePath: string;
		digest: string;
		bytes: Readonly<Uint8Array>;
		identity: WorkflowSkillFileIdentity;
		artifactRef?: WorkflowArtifactRef;
	}[],
): string {
	return digestObject(
		sortByCodePoint(files, (file) => file.name).map((file) => ({
			name: file.name,
			sourcePath: file.sourcePath,
			digest: file.digest,
			sizeBytes: file.bytes.byteLength,
			identity: file.identity,
			artifactRef: file.artifactRef ?? null,
		})),
	);
}

function skillMetadataDigest(
	skill: Skill,
	canonicalPath: string,
	_canonicalBaseDir: string,
	canonicalSourceInfoBaseDir: string | null,
	canonicalPackageRoot: string | null,
	canonicalPyprojectPath: string | null,
	pythonProjectMetadataDigest: string | null,
	packageDigest: string,
): string {
	return digestObject({
		name: skill.name,
		description: skill.description,
		kind: skill.kind,
		canonicalPath,
		sourceInfo: normalizedSourceInfo(skill, canonicalPath, canonicalSourceInfoBaseDir ?? undefined),
		disableModelInvocation: skill.disableModelInvocation,
		python:
			skill.kind === "python"
				? {
						importName: skill.python.importName,
						packagePath: canonicalPackageRoot,
						pyprojectPath: canonicalPyprojectPath,
					}
				: null,
		pythonProjectMetadataDigest,
		packageDigest,
	});
}

async function inspectSkill(skill: Skill): Promise<SkillInspection> {
	assertNonEmpty(skill.filePath, "file path");
	assertNonEmpty(skill.baseDir, "base directory");
	if (skill.filePath.includes("\0") || skill.baseDir.includes("\0"))
		throw new Error("Skill file paths contain a NUL byte.");
	if (skill.kind !== "markdown" && skill.kind !== "python") throw new Error("Skill kind is unsupported.");
	let canonicalBaseDir: string;
	let canonicalPath: string;
	try {
		[canonicalBaseDir, canonicalPath] = await Promise.all([realpath(skill.baseDir), realpath(skill.filePath)]);
	} catch (error) {
		throw new Error("Skill source is missing or cannot be realpath-verified.", { cause: error });
	}
	assertContainedPath(canonicalPath, canonicalBaseDir, "skill source");
	let canonicalSourceInfoBaseDir: string | null = null;
	if (skill.sourceInfo.baseDir !== undefined) {
		canonicalSourceInfoBaseDir = await realpath(skill.sourceInfo.baseDir);
	}
	if ((await realpath(skill.sourceInfo.path)) !== canonicalPath)
		throw new Error("Skill source-info path is not bound to the skill file path.");
	assertNonEmpty(skill.name, "name");
	assertNonEmpty(skill.description, "description");
	if (skill.name.includes("/") || skill.name.includes("\\") || skill.name.includes("\0"))
		throw new Error("Skill name is not a safe identifier.");
	if (typeof skill.disableModelInvocation !== "boolean") throw new Error("Skill invocation policy is invalid.");
	let packageRoot: string | null = null;
	let pythonProjectMetadataPath: string | null = null;
	let packageFiles: readonly PackageFile[] = [];
	let pythonProjectMetadataDigest: string | null = null;
	if (skill.kind === "python") {
		assertNonEmpty(skill.python.importName, "Python import name");
		assertNonEmpty(skill.python.packagePath, "Python package path");
		assertNonEmpty(skill.python.pyprojectPath, "Python project metadata path");
		if (
			skill.python.importName.includes("/") ||
			skill.python.importName.includes("\\") ||
			skill.python.importName.includes("\0") ||
			skill.python.packagePath.includes("\0") ||
			skill.python.pyprojectPath.includes("\0")
		)
			throw new Error("Skill Python metadata contains an unsafe path or import name.");
		packageRoot = await realpathContained(skill.python.packagePath, canonicalBaseDir, "Python package root", true);
		const pyprojectPath = await realpathContained(skill.python.pyprojectPath, packageRoot, "Python project metadata");
		pythonProjectMetadataPath = pyprojectPath;
		const pyprojectRead = await readStableFile(pyprojectPath, "Python project metadata", MAX_PACKAGE_FILE_BYTES);
		pythonProjectMetadataDigest = sha256Hex(pyprojectRead.bytes);
		packageFiles = await collectPackageFiles(packageRoot, canonicalPath);
	}
	const contentRead = await readStableFile(canonicalPath, "source", MAX_SKILL_SOURCE_BYTES);
	const contentBytes = contentRead.bytes;
	const contentDigest = sha256Hex(contentBytes);
	const packageDigest = packageClosureDigest(packageFiles);
	return {
		canonicalPath,
		canonicalBaseDir,
		canonicalSourceInfoBaseDir,
		packageRoot,
		pythonProjectMetadataPath,
		contentBytes,
		contentIdentity: contentRead.identity,
		contentDigest,
		packageFiles,
		pythonProjectMetadataDigest,
		metadataDigest: skillMetadataDigest(
			skill,
			canonicalPath,
			canonicalBaseDir,
			canonicalSourceInfoBaseDir,
			packageRoot,
			pythonProjectMetadataPath,
			pythonProjectMetadataDigest,
			packageDigest,
		),
	};
}

function isRequiredBuiltinName(name: string): boolean {
	return REQUIRED_BUILTIN_SKILL_NAMES.includes(name as (typeof REQUIRED_BUILTIN_SKILL_NAMES)[number]);
}

async function assertLoaderState(input: {
	workflowId: string;
	workspaceDigest: string;
	skill: Skill;
	canonicalPath: string;
	loader: WorkflowResourceLoaderPort;
	loaderProvenance: WorkflowResourceLoaderProvenance;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow: string;
	artifacts: WorkflowArtifactResolver;
}): Promise<{
	result: WorkflowResourceLoaderResult;
	revision: number;
	issuanceReceipt: WorkflowVerifiedHostReceipt;
	issuanceConsumptionWitness: WorkflowHostReceiptConsumptionWitness;
	hostDerivedBuiltin: boolean;
}> {
	const revision = input.loaderProvenance.loaderRevision;
	assertLoaderPort(input.loader, revision);
	let rawResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	try {
		rawResult = input.loader.getSkills();
	} catch (error) {
		throw new Error("Skill ResourceLoader result could not be obtained.", { cause: error });
	}
	const result = { ...snapshotLoaderResult(rawResult), revision };
	assertLoaderProvenance(input.loaderProvenance, input.workflowId, input.workspaceDigest, revision, result);
	await verifyHostReceiptArtifact(input.artifacts, input.loaderProvenance.issuanceReceipt);
	const verifiedIssuance = await resolveVerifiedLoaderReceipt({
		receipt: input.loaderProvenance.issuanceReceipt,
		context: input.receiptContext,
		workflowId: input.workflowId,
		workspaceDigest: input.workspaceDigest,
		loaderRevision: revision,
		loaderResultDigest: input.loaderProvenance.loaderResultDigest,
		trustedNow: input.trustedNow,
	});
	const matching = result.skills.filter((skill) => skill.name === input.skill.name);
	if (matching.length !== 1) throw new Error("Skill ResourceLoader result has missing or ambiguous skill precedence.");
	const selected = matching[0];
	if ((await realpath(selected.filePath)) !== input.canonicalPath)
		throw new Error("Skill ResourceLoader result selected a different skill source.");
	const [selectedMetadata, requestedMetadata] = await Promise.all([
		normalizedRealpathLoaderSkill(selected),
		normalizedRealpathLoaderSkill(input.skill),
	]);
	if (digestObject(selectedMetadata) !== digestObject(requestedMetadata))
		throw new Error("Skill ResourceLoader result does not match the requested skill metadata.");
	const hostDerivedBuiltin = selected.sourceInfo.source === "builtin";
	return {
		result,
		revision,
		issuanceReceipt: verifiedIssuance.receipt,
		issuanceConsumptionWitness: verifiedIssuance.consumptionWitness,
		hostDerivedBuiltin,
	};
}

function sourceRefFromProvenance(provenance: WorkflowSkillSourceProvenance): WorkflowArtifactRef {
	if (
		provenance.sourceRef !== undefined &&
		provenance.sourceArtifactRef !== undefined &&
		!sameArtifactRef(provenance.sourceRef, provenance.sourceArtifactRef)
	)
		throw new Error("Skill host source provenance contains conflicting source artifact references.");
	const sourceRef = provenance.sourceRef ?? provenance.sourceArtifactRef;
	if (sourceRef === undefined) throw new Error("Skill host source provenance has no source artifact reference.");
	return sourceRef;
}

async function assertHostSourceProvenance(input: {
	skill: Skill;
	inspection: SkillInspection;
	provenance: WorkflowSkillSourceProvenance | undefined;
	required: boolean;
	artifacts: WorkflowArtifactResolver;
	sourceEventSequence: number;
}): Promise<{
	hostSourceArtifactRef: WorkflowArtifactRef | null;
	hostPackageSources: readonly WorkflowSkillPackageSource[];
}> {
	if (!input.required && input.provenance === undefined)
		return { hostSourceArtifactRef: null, hostPackageSources: [] };
	const provenance = input.provenance;
	if (provenance === undefined) throw new Error("Required skill source provenance is missing.");
	if (input.required && provenance.builtin === undefined)
		throw new Error("Required built-in skill has no immutable registry and signed source event.");
	const sourceRef = sourceRefFromProvenance(provenance);
	assertArtifactRef(sourceRef, "host skill source", true);
	const sourcePath = await realpathContained(
		provenance.sourcePath,
		input.inspection.canonicalBaseDir,
		"host skill source",
	);
	if (sourcePath !== input.inspection.canonicalPath)
		throw new Error("Host skill source provenance points at a different realpath.");
	if (!sameBytes(provenance.sourceBytes, input.inspection.contentBytes))
		throw new Error("Host skill source provenance bytes drifted from the skill file.");
	if (
		sourceRef.digest !== input.inspection.contentDigest ||
		sourceRef.sizeBytes !== input.inspection.contentBytes.byteLength ||
		sourceRef.sourceEventSequence !== input.sourceEventSequence
	)
		throw new Error("Host skill source artifact is not content addressed.");
	await verifyArtifactRef(
		input.artifacts,
		sourceRef,
		"binary",
		"host skill source",
		"evidence",
		MAX_SKILL_SOURCE_BYTES,
	);
	if (input.skill.kind !== "python" || input.inspection.packageRoot === null) {
		if (provenance.packageSources.length !== 0)
			throw new Error("Markdown skill has an unexpected Python package closure.");
		return { hostSourceArtifactRef: cloneArtifactRef(sourceRef), hostPackageSources: [] };
	}
	const discovered = new Map(input.inspection.packageFiles.map((file) => [file.name, file]));
	const supplied = new Map<string, WorkflowSkillPackageSource>();
	for (const packageSource of provenance.packageSources) {
		const name = normalizeRelativeName(packageSource.name, "host package source name");
		if (supplied.has(name)) throw new Error(`Host package source ${name} is duplicated.`);
		const file = discovered.get(name);
		if (file === undefined) throw new Error(`Host package source ${name} is not in the package closure.`);
		const packagePath =
			packageSource.sourcePath === undefined
				? file.sourcePath
				: await realpathContained(
						packageSource.sourcePath,
						input.inspection.packageRoot,
						`host package source ${name}`,
					);
		if (packagePath !== file.sourcePath) throw new Error(`Host package source ${name} realpath drifted.`);
		assertArtifactRef(packageSource.artifactRef, `host package source ${name}`, true);
		assertDigest(packageSource.contentDigest, `host package source ${name} content`);
		if (
			packageSource.contentDigest !== file.digest ||
			packageSource.artifactRef.digest !== file.digest ||
			packageSource.artifactRef.sizeBytes !== file.bytes.byteLength ||
			packageSource.artifactRef.sourceEventSequence !== input.sourceEventSequence ||
			!sameBytes(packageSource.bytes, file.bytes)
		)
			throw new Error(`Host package source ${name} is not content addressed.`);
		await verifyArtifactRef(
			input.artifacts,
			packageSource.artifactRef,
			"binary",
			`host package source ${name}`,
			"evidence",
			MAX_PACKAGE_FILE_BYTES,
		);
		supplied.set(name, {
			...packageSource,
			name,
			sourcePath: packagePath,
			bytes: Uint8Array.from(packageSource.bytes),
		});
	}
	if (supplied.size !== discovered.size || [...discovered.keys()].some((name) => !supplied.has(name)))
		throw new Error("Host Python package provenance does not cover every source and manifest byte.");
	return {
		hostSourceArtifactRef: cloneArtifactRef(sourceRef),
		hostPackageSources: sortByCodePoint([...supplied.values()], (source) => source.name),
	};
}

function assertDependencySource(dependency: WorkflowSkillDependency, index: number, sourceEventSequence: number): void {
	assertUint8Bytes(dependency.bytes, `dependency ${index} bytes`, MAX_DEPENDENCY_BYTES);
	assertNonEmpty(dependency.name, `dependency ${index} name`);
	if (dependency.name.includes("/") || dependency.name.includes("\\") || dependency.name.includes("\0"))
		throw new Error(`Skill dependency ${index} name is not a safe identifier.`);
	assertDigest(dependency.contentDigest, `dependency ${dependency.name} content`);
	assertArtifactRef(dependency.artifactRef, `dependency ${dependency.name} source`);
	if (
		dependency.artifactRef.digest !== dependency.contentDigest ||
		dependency.artifactRef.sizeBytes !== dependency.bytes.byteLength ||
		dependency.artifactRef.sourceEventSequence !== sourceEventSequence ||
		sha256Hex(dependency.bytes) !== dependency.contentDigest
	)
		throw new Error(`Skill dependency ${dependency.name} is not content addressed.`);
}

function dependencyIdentity(dependency: WorkflowSkillDependency): string {
	return `${dependency.name}\0${dependency.artifactRef.relativePath}\0${dependency.artifactRef.digest}\0${dependency.sourcePath ?? ""}`;
}

function parseStringList(record: Record<string, unknown>, key: string): readonly string[] {
	const value = record[key];
	if (
		!Array.isArray(value) ||
		value.length > MAX_MANIFEST_ENTRIES ||
		value.some((item) => typeof item !== "string" || item.length === 0 || item.length > MAX_MANIFEST_VALUE_BYTES)
	)
		throw new Error(`Skill manifest ${key} is not a non-empty string list.`);
	if (new Set(value).size !== value.length) throw new Error(`Skill manifest ${key} contains duplicate entries.`);
	return value;
}

function parseSkillManifest(bytes: Uint8Array, digest: string): WorkflowSkillManifest {
	assertUint8Bytes(bytes, "skill manifest bytes", MAX_MANIFEST_VALUE_BYTES);
	const parsed = parseCanonicalJsonBytes(bytes);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Skill manifest is not a canonical object.");
	const record = parsed as Record<string, unknown>;
	const keys = [
		"requiredApprovalGates",
		"requiredArtifactKinds",
		"requiredPressureTests",
		"allowedTransitions",
	] as const;
	const actualKeys = Object.keys(record);
	if (actualKeys.length !== keys.length || actualKeys.some((key) => !keys.includes(key as (typeof keys)[number])))
		throw new Error("Skill manifest has an unknown or missing closed field.");
	return {
		requiredApprovalGates: parseStringList(record, "requiredApprovalGates"),
		requiredArtifactKinds: parseStringList(record, "requiredArtifactKinds"),
		requiredPressureTests: parseStringList(record, "requiredPressureTests"),
		allowedTransitions: parseStringList(record, "allowedTransitions"),
		manifestDigest: digest,
	};
}

function assertManifestBounds(manifest: WorkflowSkillManifest, label: string): void {
	const lists = [
		manifest.requiredApprovalGates,
		manifest.requiredArtifactKinds,
		manifest.requiredPressureTests,
		manifest.allowedTransitions,
	];
	for (const values of lists) {
		if (
			values.length > MAX_MANIFEST_ENTRIES ||
			values.some(
				(value) => typeof value !== "string" || value.length === 0 || value.length > MAX_MANIFEST_VALUE_BYTES,
			)
		)
			throw new Error(`Skill ${label} contains an unbounded gate list.`);
		if (new Set(values).size !== values.length) throw new Error(`Skill ${label} contains duplicate gate entries.`);
	}
}

function manifestBytes(manifest: WorkflowSkillManifest): Uint8Array {
	return canonicalJsonBytes({
		allowedTransitions: manifest.allowedTransitions,
		requiredApprovalGates: manifest.requiredApprovalGates,
		requiredArtifactKinds: manifest.requiredArtifactKinds,
		requiredPressureTests: manifest.requiredPressureTests,
	});
}

function recordField(record: Record<string, unknown>, key: string, label: string): unknown {
	if (!(key in record)) throw new Error(`Skill ${label} is missing ${key}.`);
	return record[key];
}

function stringField(record: Record<string, unknown>, key: string, label: string): string {
	const value = recordField(record, key, label);
	if (typeof value !== "string" || value.length === 0) throw new Error(`Skill ${label} ${key} is invalid.`);
	return value;
}

function parseBuiltinRegistry(bytes: Readonly<Uint8Array>): BuiltinRegistry {
	assertUint8Bytes(bytes, "built-in registry bytes", MAX_BUILTIN_MANIFEST_BYTES);
	const parsed = parseCanonicalJsonBytes(Uint8Array.from(bytes));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Skill built-in registry is not a canonical object.");
	const record = parsed as Record<string, unknown>;
	if (
		record.registryKind !== "workflow-builtin-registry" ||
		!Array.isArray(record.entries) ||
		record.entries.length > MAX_MANIFEST_ENTRIES
	)
		throw new Error("Skill built-in registry envelope is invalid.");
	if (
		Object.keys(record).length !== 2 ||
		Object.keys(record).some((key) => key !== "registryKind" && key !== "entries")
	)
		throw new Error("Skill built-in registry has an unknown or missing field.");
	const entries = record.entries.map((entry, index) => {
		if (entry === null || typeof entry !== "object" || Array.isArray(entry))
			throw new Error(`Skill built-in registry entry ${index} is invalid.`);
		const entryRecord = entry as Record<string, unknown>;
		const entryKeys = ["skillName", "relativePath", "sourceManifestDigest", "sourceBytesDigest", "sourceEventId"];
		if (
			Object.keys(entryRecord).length !== entryKeys.length ||
			Object.keys(entryRecord).some((key) => !entryKeys.includes(key))
		)
			throw new Error(`Skill built-in registry entry ${index} has an unknown or missing field.`);
		return {
			skillName: stringField(entryRecord, "skillName", `built-in registry entry ${index}`),
			relativePath: normalizeRelativeName(
				stringField(entryRecord, "relativePath", `built-in registry entry ${index}`),
				`built-in registry entry ${index} path`,
			),
			sourceManifestDigest: stringField(entryRecord, "sourceManifestDigest", `built-in registry entry ${index}`),
			sourceBytesDigest: stringField(entryRecord, "sourceBytesDigest", `built-in registry entry ${index}`),
			sourceEventId: stringField(entryRecord, "sourceEventId", `built-in registry entry ${index}`),
		};
	});
	const skillNames = new Set<string>();
	const relativePaths = new Set<string>();
	const sourceEventIds = new Set<string>();
	for (const entry of entries) {
		if (skillNames.has(entry.skillName)) throw new Error("Skill built-in registry contains a duplicate skill name.");
		if (relativePaths.has(entry.relativePath)) throw new Error("Skill built-in registry contains a duplicate path.");
		if (sourceEventIds.has(entry.sourceEventId))
			throw new Error("Skill built-in registry contains a duplicate source event id.");
		skillNames.add(entry.skillName);
		relativePaths.add(entry.relativePath);
		sourceEventIds.add(entry.sourceEventId);
	}
	for (const [index, entry] of entries.entries()) {
		assertDigest(entry.sourceManifestDigest, `built-in registry entry ${index} source manifest`);
		assertDigest(entry.sourceBytesDigest, `built-in registry entry ${index} source bytes`);
	}
	return { registryKind: "workflow-builtin-registry", entries };
}

function parseBuiltinSourceManifest(bytes: Readonly<Uint8Array>): BuiltinSourceManifest {
	assertUint8Bytes(bytes, "built-in source manifest bytes", MAX_BUILTIN_MANIFEST_BYTES);
	const parsed = parseCanonicalJsonBytes(Uint8Array.from(bytes));
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("Skill built-in source manifest is not a canonical object.");
	const record = parsed as Record<string, unknown>;
	if (record.sourceManifestKind !== "workflow-skill-source-manifest")
		throw new Error("Skill built-in source manifest envelope is invalid.");
	const sourceManifestKeys = [
		"sourceManifestKind",
		"skillName",
		"relativePath",
		"sourceBytesDigest",
		"requiredApprovalGates",
		"requiredArtifactKinds",
		"requiredPressureTests",
		"allowedTransitions",
	];
	if (
		Object.keys(record).length !== sourceManifestKeys.length ||
		Object.keys(record).some((key) => !sourceManifestKeys.includes(key))
	)
		throw new Error("Skill built-in source manifest has an unknown or missing field.");
	const sourceManifest = {
		sourceManifestKind: "workflow-skill-source-manifest" as const,
		skillName: stringField(record, "skillName", "built-in source manifest"),
		relativePath: normalizeRelativeName(
			stringField(record, "relativePath", "built-in source manifest"),
			"built-in source manifest path",
		),
		sourceBytesDigest: stringField(record, "sourceBytesDigest", "built-in source manifest"),
		requiredApprovalGates: parseStringList(record, "requiredApprovalGates"),
		requiredArtifactKinds: parseStringList(record, "requiredArtifactKinds"),
		requiredPressureTests: parseStringList(record, "requiredPressureTests"),
		allowedTransitions: parseStringList(record, "allowedTransitions"),
	};
	assertDigest(sourceManifest.sourceBytesDigest, "built-in source manifest source bytes");
	return sourceManifest;
}

function builtinSourceEventSignedValue(event: WorkflowSkillBuiltinSourceEvent): Record<string, unknown> {
	return { ...event, signature: "", eventDigest: "" };
}

async function assertBuiltinProvenance(input: {
	skill: Skill;
	inspection: SkillInspection;
	provenance: WorkflowSkillSourceProvenance | undefined;
	context: WorkflowSkillBuiltinProvenanceContext | undefined;
	manifest: WorkflowSkillManifest;
	sourceEventSequence: number;
	trustedNow: string;
}): Promise<void> {
	const builtin = input.provenance?.builtin;
	if (builtin === undefined || input.context === undefined)
		throw new Error("Required built-in skill has no verified host registry provenance.");
	const canonicalRoot = await realpath(builtin.vendoredRoot);
	const catalogRoot = await realpath(input.context.hostCatalog.vendoredRoot);
	if (
		catalogRoot !== canonicalRoot ||
		!sameArtifactRef(input.context.hostCatalog.registryArtifactRef, builtin.registryArtifactRef) ||
		!sameArtifactRef(input.context.hostCatalog.sourceManifestArtifactRef, builtin.sourceManifestArtifactRef)
	)
		throw new Error("Built-in provenance does not match the host-fixed source catalog.");
	assertArtifactRef(input.context.hostCatalog.registryArtifactRef, "host built-in registry", true);
	assertArtifactRef(input.context.hostCatalog.sourceManifestArtifactRef, "host built-in source manifest", true);
	const expectedRoot =
		input.inspection.canonicalSourceInfoBaseDir === null
			? input.inspection.canonicalBaseDir
			: await realpath(input.inspection.canonicalSourceInfoBaseDir);
	if (canonicalRoot !== expectedRoot)
		throw new Error("Built-in skill provenance does not use the host-owned vendored root.");
	assertContainedPath(input.inspection.canonicalPath, canonicalRoot, "built-in skill source", true);
	const relativePath = relative(canonicalRoot, input.inspection.canonicalPath).split(sep).join("/");
	const registryRef = await verifyArtifactRef(
		input.context.artifactResolver,
		builtin.registryArtifactRef,
		"canonical_json",
		"built-in registry",
		"evidence",
		MAX_BUILTIN_MANIFEST_BYTES,
	);
	const sourceManifestRef = await verifyArtifactRef(
		input.context.artifactResolver,
		builtin.sourceManifestArtifactRef,
		"canonical_json",
		"built-in source manifest",
		"evidence",
		MAX_BUILTIN_MANIFEST_BYTES,
	);
	assertUint8Bytes(builtin.registryBytes, "built-in registry bytes", MAX_BUILTIN_MANIFEST_BYTES);
	assertUint8Bytes(builtin.sourceManifestBytes, "built-in source manifest bytes", MAX_BUILTIN_MANIFEST_BYTES);
	if (
		builtin.registryBytes.byteLength > MAX_BUILTIN_MANIFEST_BYTES ||
		builtin.sourceManifestBytes.byteLength > MAX_BUILTIN_MANIFEST_BYTES ||
		!sameBytes(registryRef.bytes, builtin.registryBytes) ||
		!sameBytes(sourceManifestRef.bytes, builtin.sourceManifestBytes) ||
		sha256Hex(builtin.registryBytes) !== builtin.registryArtifactRef.digest ||
		sha256Hex(builtin.sourceManifestBytes) !== builtin.sourceManifestArtifactRef.digest ||
		builtin.registryArtifactRef.sourceEventSequence !== input.sourceEventSequence ||
		builtin.sourceManifestArtifactRef.sourceEventSequence !== input.sourceEventSequence
	)
		throw new Error("Built-in registry or source manifest bytes drifted from immutable artifacts.");
	const registry = parseBuiltinRegistry(builtin.registryBytes);
	const sourceManifest = parseBuiltinSourceManifest(builtin.sourceManifestBytes);
	const registryEntry = registry.entries.find((entry) => entry.skillName === input.skill.name);
	if (
		registryEntry === undefined ||
		registryEntry.relativePath !== relativePath ||
		registryEntry.sourceManifestDigest !== builtin.sourceManifestArtifactRef.digest ||
		registryEntry.sourceBytesDigest !== input.inspection.contentDigest ||
		registryEntry.sourceEventId !== builtin.sourceEvent.eventId
	)
		throw new Error("Built-in registry does not authenticate the selected skill source.");
	if (
		sourceManifest.skillName !== input.skill.name ||
		sourceManifest.relativePath !== relativePath ||
		sourceManifest.sourceBytesDigest !== input.inspection.contentDigest ||
		digestObject({
			requiredApprovalGates: sourceManifest.requiredApprovalGates,
			requiredArtifactKinds: sourceManifest.requiredArtifactKinds,
			requiredPressureTests: sourceManifest.requiredPressureTests,
			allowedTransitions: sourceManifest.allowedTransitions,
		}) !==
			digestObject({
				requiredApprovalGates: input.manifest.requiredApprovalGates,
				requiredArtifactKinds: input.manifest.requiredArtifactKinds,
				requiredPressureTests: input.manifest.requiredPressureTests,
				allowedTransitions: input.manifest.allowedTransitions,
			})
	)
		throw new Error("Built-in source manifest gate fields are not bound to the skill admission manifest.");
	const event = builtin.sourceEvent;
	const eventKeys = [
		"eventId",
		"skillName",
		"vendoredRoot",
		"canonicalPath",
		"sourceManifestDigest",
		"sourceBytesDigest",
		"sourceEventSequence",
		"issuedAt",
		"validUntil",
		"keyId",
		"signatureAlgorithm",
		"signature",
		"eventDigest",
	];
	const actualEventKeys = Object.keys(event);
	if (actualEventKeys.length !== eventKeys.length || actualEventKeys.some((key) => !eventKeys.includes(key)))
		throw new Error("Built-in source event has an unknown or missing field.");
	if (
		event.eventId !== registryEntry.sourceEventId ||
		event.skillName !== input.skill.name ||
		event.vendoredRoot !== canonicalRoot ||
		event.canonicalPath !== input.inspection.canonicalPath ||
		event.sourceManifestDigest !== builtin.sourceManifestArtifactRef.digest ||
		event.sourceBytesDigest !== input.inspection.contentDigest ||
		event.sourceEventSequence !== input.sourceEventSequence ||
		event.signatureAlgorithm !== "ed25519" ||
		input.context.revokedEventIds.has(event.eventId)
	)
		throw new Error("Built-in source event is not bound to the selected host source.");
	assertNonEmpty(event.keyId, "built-in source event key id");
	assertNonEmpty(event.signature, "built-in source event signature");
	if (event.signature.length > MAX_MANIFEST_VALUE_BYTES)
		throw new Error("Built-in source event signature exceeds the immutable byte limit.");
	assertDigest(event.eventDigest, "built-in source event digest");
	if (event.eventDigest !== digestObject(builtinSourceEventSignedValue(event)))
		throw new Error("Built-in source event digest is not canonical.");
	const issuedAt = Date.parse(event.issuedAt);
	const validUntil = Date.parse(event.validUntil);
	const trustedNow = Date.parse(input.trustedNow);
	if (
		!Number.isFinite(issuedAt) ||
		!Number.isFinite(validUntil) ||
		!Number.isFinite(trustedNow) ||
		validUntil <= issuedAt ||
		trustedNow < issuedAt ||
		trustedNow >= validUntil
	)
		throw new Error("Built-in source event is outside its trusted validity window.");
	const key = await input.context.keyResolver.resolve(event.keyId);
	if (
		key.algorithm !== event.signatureAlgorithm ||
		!key.verify({ bytes: canonicalJsonBytes(builtinSourceEventSignedValue(event)), signature: event.signature })
	)
		throw new Error("Built-in source event signature verification failed.");
}

function assertPublicationEnvelope(
	publication: {
		envelope: {
			ref: WorkflowArtifactRef;
			payloadKind: WorkflowArtifactPayloadKind;
			codec: WorkflowArtifactCodec;
			immutable: true;
		};
	},
	workflowId: string,
	expectedCodec: WorkflowArtifactCodec,
	expectedSequence: number,
	expectedDigest: string,
	expectedSize: number,
): void {
	if (
		publication.envelope.payloadKind !== "evidence" ||
		!ALLOWED_SKILL_ARTIFACT_PAYLOAD_KINDS.includes(publication.envelope.payloadKind) ||
		publication.envelope.codec !== expectedCodec ||
		publication.envelope.immutable !== true
	)
		throw new Error("Skill artifact publication uses an unsupported payload envelope.");
	assertArtifactRef(publication.envelope.ref, "published skill", true);
	if (
		publication.envelope.ref.sourceEventSequence !== expectedSequence ||
		publication.envelope.ref.artifactId.length === 0 ||
		publication.envelope.ref.digest !== expectedDigest ||
		publication.envelope.ref.sizeBytes !== expectedSize ||
		workflowId.length === 0
	)
		throw new Error("Skill artifact publication is not bound to the recomputed immutable bytes.");
}

async function publishAndVerifyArtifact(input: {
	workflowId: string;
	bytes: Readonly<Uint8Array>;
	codec: WorkflowArtifactCodec;
	idempotencyKey: string;
	sourceEventSequence: number;
	artifacts: WorkflowArtifactResolver;
	publisher: WorkflowArtifactPublisher;
	label: string;
}): Promise<WorkflowArtifactRef> {
	assertUint8Bytes(input.bytes, `${input.label} bytes`, MAX_PACKAGE_TOTAL_BYTES);
	const bytes = Uint8Array.from(input.bytes);
	const digest = sha256Hex(bytes);
	const sizeBytes = bytes.byteLength;
	const publication = await input.publisher.publish({
		workflowId: input.workflowId,
		payloadKind: "evidence",
		bytes: Uint8Array.from(bytes),
		codec: input.codec,
		sourceEventSequence: input.sourceEventSequence,
		idempotencyKey: input.idempotencyKey,
	});
	assertPublicationEnvelope(publication, input.workflowId, input.codec, input.sourceEventSequence, digest, sizeBytes);
	const resolved = await input.artifacts.resolve(publication.envelope.ref);
	assertUint8Bytes(resolved.bytes, `${input.label} published artifact bytes`, MAX_PACKAGE_TOTAL_BYTES);
	if (
		!resolved.exists ||
		!resolved.envelope.immutable ||
		resolved.envelope.payloadKind !== "evidence" ||
		!ALLOWED_SKILL_ARTIFACT_PAYLOAD_KINDS.includes(resolved.envelope.payloadKind) ||
		resolved.envelope.codec !== input.codec ||
		!sameArtifactRef(resolved.envelope.ref, publication.envelope.ref) ||
		resolved.verifiedDigest !== digest ||
		sha256Hex(resolved.bytes) !== digest ||
		resolved.verifiedSizeBytes !== sizeBytes ||
		resolved.bytes.byteLength !== sizeBytes
	)
		throw new Error(`Skill ${input.label} did not round-trip through immutable artifact storage.`);
	return cloneArtifactRef(resolved.envelope.ref);
}

async function verifyArtifactRef(
	artifacts: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	expectedCodec: WorkflowArtifactCodec | null,
	label: string,
	expectedPayloadKind: WorkflowArtifactPayloadKind = "evidence",
	maxBytes = MAX_PACKAGE_TOTAL_BYTES,
): Promise<WorkflowArtifactReadResult> {
	assertArtifactRef(ref, label, true);
	if (ref.sizeBytes > maxBytes) throw new Error(`Skill ${label} artifact exceeds the immutable byte limit.`);
	let resolved: WorkflowArtifactReadResult;
	try {
		resolved = await artifacts.resolve(ref);
	} catch (error) {
		throw new Error(`Skill ${label} artifact could not be resolved immutably.`, { cause: error });
	}
	assertUint8Bytes(resolved.bytes, `${label} artifact bytes`, maxBytes);
	if (resolved.bytes.byteLength > maxBytes || resolved.verifiedSizeBytes > maxBytes)
		throw new Error(`Skill ${label} artifact exceeds the immutable byte limit.`);
	if (
		!resolved.exists ||
		!resolved.envelope.immutable ||
		resolved.envelope.payloadKind !== expectedPayloadKind ||
		resolved.envelope.payloadKind === ("skill" as WorkflowArtifactPayloadKind) ||
		(expectedCodec !== null && resolved.envelope.codec !== expectedCodec) ||
		!sameArtifactRef(resolved.envelope.ref, ref) ||
		resolved.verifiedDigest !== ref.digest ||
		sha256Hex(resolved.bytes) !== ref.digest ||
		resolved.verifiedSizeBytes !== ref.sizeBytes ||
		resolved.bytes.byteLength !== ref.sizeBytes
	)
		throw new Error(`Skill ${label} artifact failed immutable resolver verification.`);
	return resolved;
}

function immutableArtifactFromResolved(
	ref: WorkflowArtifactRef,
	resolved: WorkflowArtifactReadResult,
): WorkflowSkillImmutableArtifact {
	assertUint8Bytes(resolved.bytes, `immutable artifact ${ref.artifactId} bytes`, ref.sizeBytes);
	return {
		ref: cloneArtifactRef(ref),
		bytes: Object.freeze(Array.from(resolved.bytes)),
	};
}

function normalizedSnapshotSourceInfo(sourceInfo: Skill["sourceInfo"], canonicalPath: string): Record<string, unknown> {
	return {
		path: canonicalPath,
		source: sourceInfo.source,
		scope: sourceInfo.scope,
		origin: sourceInfo.origin,
		baseDir: sourceInfo.baseDir === undefined ? null : resolve(sourceInfo.baseDir),
		canonicalPath,
	};
}

function dependencyManifestValue(snapshot: WorkflowSkillSnapshot): Record<string, unknown> {
	return {
		dependencies: snapshot.dependencyNames.map((name, index) => ({
			name,
			digest: snapshot.dependencyDigests[index],
			sourceRef: snapshot.dependencySourceRefs[index],
			sourcePath: snapshot.dependencySourcePaths[index],
			artifactRef: snapshot.dependencyRefs[index],
		})),
		manifestDigest: snapshot.manifest?.manifestDigest ?? null,
		manifestArtifactRef: snapshot.manifestArtifactRef,
		manifestSourceArtifactRef: snapshot.manifestSourceArtifactRef,
		hostSourceArtifactRef: snapshot.hostSourceArtifactRef,
		packageSources: snapshot.packageSourceNames.map((name, index) => ({
			name,
			sourcePath: snapshot.packageSourcePaths[index],
			digest: snapshot.packageBytesDigests[index],
			artifactRef: snapshot.packageArtifactRefs[index],
		})),
	};
}

function snapshotDigestValue(snapshot: WorkflowSkillSnapshot): Record<string, unknown> {
	return {
		workflowId: snapshot.workflowId,
		taskId: snapshot.taskId,
		decisionRef: snapshot.decisionRef,
		journalHeadDigest: snapshot.journalHeadDigest,
		trustedNow: snapshot.trustedNow,
		epochRef: snapshot.epochRef,
		configDigest: snapshot.configDigest,
		workspaceDigest: snapshot.workspaceDigest,
		attemptId: snapshot.attemptId,
		loaderProvenance: snapshot.loaderProvenance,
		loaderReceiptConsumptionWitness: snapshot.loaderReceiptConsumptionWitness,
		loaderResultDigest: snapshot.loaderResultDigest,
		requiredBuiltIn: snapshot.requiredBuiltIn,
		builtinProvenanceDigest: builtinSnapshotProvenanceDigest(snapshot.builtinProvenance),
		canonicalBaseDir: snapshot.canonicalBaseDir,
		skillName: snapshot.skillName,
		skillKind: snapshot.skillKind,
		canonicalPath: snapshot.canonicalPath,
		sourceInfo: normalizedSnapshotSourceInfo(snapshot.sourceInfo, snapshot.canonicalPath),
		disableModelInvocation: snapshot.disableModelInvocation,
		contentDigest: snapshot.contentDigest,
		contentBytes: snapshot.contentBytes,
		sourceFileIdentity: snapshot.sourceFileIdentity,
		dependencyNames: snapshot.dependencyNames,
		dependencyDigests: snapshot.dependencyDigests,
		dependencyRefs: snapshot.dependencyRefs,
		dependencySourceRefs: snapshot.dependencySourceRefs,
		dependencySourcePaths: snapshot.dependencySourcePaths,
		dependencySourceIdentities: snapshot.dependencySourceIdentities,
		dependencyManifestDigest: snapshot.dependencyManifestDigest,
		manifest:
			snapshot.manifest === null
				? null
				: {
						requiredApprovalGates: snapshot.manifest.requiredApprovalGates,
						requiredArtifactKinds: snapshot.manifest.requiredArtifactKinds,
						requiredPressureTests: snapshot.manifest.requiredPressureTests,
						allowedTransitions: snapshot.manifest.allowedTransitions,
						manifestDigest: snapshot.manifest.manifestDigest,
					},
		manifestArtifactRef: snapshot.manifestArtifactRef,
		manifestArtifactPayloadKind: snapshot.manifestArtifactPayloadKind,
		manifestArtifactCodec: snapshot.manifestArtifactCodec,
		manifestSourceArtifactRef: snapshot.manifestSourceArtifactRef,
		authoritativeDependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
		authoritativeHostDependencyRefs: snapshot.authoritativeHostDependencyRefs,
		hostSourceArtifactRef: snapshot.hostSourceArtifactRef,
		hostPackageArtifactRefs: snapshot.hostPackageArtifactRefs,
		sourceArtifactRef: snapshot.sourceArtifactRef,
		sourceBytesDigest: snapshot.sourceBytesDigest,
		packageSourceNames: snapshot.packageSourceNames,
		packageSourcePaths: snapshot.packageSourcePaths,
		packageSourceIdentities: snapshot.packageSourceIdentities,
		packageBytesDigests: snapshot.packageBytesDigests,
		packageArtifactRefs: snapshot.packageArtifactRefs,
		workflowContractRevision: snapshot.workflowContractRevision,
		skillMetadataDigest: snapshot.skillMetadataDigest,
		artifactRef: snapshot.artifactRef,
		snapshotEpoch: snapshot.snapshotEpoch,
		consumeSequence: snapshot.consumeSequence,
	};
}

function computeSnapshotDigest(snapshot: WorkflowSkillSnapshot): string {
	return digestObject(snapshotDigestValue(snapshot));
}

function computeCanonicalSnapshotAdmissionDigest(snapshot: WorkflowSkillSnapshot): string {
	return digestObject({ ...snapshotDigestValue(snapshot), consumeSequence: 1 });
}

function invocationTokenValue(snapshot: WorkflowSkillSnapshot): Record<string, unknown> {
	return {
		snapshotDigest: snapshot.snapshotDigest,
		workflowId: snapshot.workflowId,
		taskId: snapshot.taskId,
		decisionRef: snapshot.decisionRef,
		journalHeadDigest: snapshot.journalHeadDigest,
		trustedNow: snapshot.trustedNow,
		epochRef: snapshot.epochRef,
		workspaceDigest: snapshot.workspaceDigest,
		attemptId: snapshot.attemptId,
		configDigest: snapshot.configDigest,
		dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
		consumeSequence: snapshot.consumeSequence,
	};
}

function invocationTokenBytes(snapshot: WorkflowSkillSnapshot): Uint8Array {
	return canonicalJsonBytes(invocationTokenValue(snapshot));
}

export function getSkillInvocationToken(snapshot: WorkflowSkillSnapshot): string {
	return new TextDecoder().decode(invocationTokenBytes(snapshot));
}

function assertSnapshot(snapshot: WorkflowSkillSnapshot): void {
	assertNonEmpty(snapshot.workflowId, "snapshot workflow id");
	assertNonEmpty(snapshot.taskId, "snapshot task id");
	assertDecisionWorkflowBinding(snapshot.decisionRef, snapshot.workflowId, "snapshot decision reference");
	assertNonEmpty(snapshot.journalHeadDigest, "snapshot journal head digest");
	assertTrustedNow(snapshot.trustedNow);
	assertNonEmpty(snapshot.configDigest, "snapshot configuration digest");
	assertNonEmpty(snapshot.workspaceDigest, "snapshot workspace digest");
	assertNonEmpty(snapshot.attemptId, "snapshot attempt id");
	assertNonEmpty(snapshot.skillName, "snapshot skill name");
	assertNonEmpty(snapshot.canonicalPath, "snapshot canonical path");
	if (
		resolve(snapshot.sourceInfo.path) !== snapshot.canonicalPath ||
		realpathSync(snapshot.canonicalPath) !== snapshot.canonicalPath
	)
		throw new Error("Skill snapshot source-info path is not the canonical realpath.");
	if (
		!isAbsolute(snapshot.canonicalBaseDir) ||
		resolve(snapshot.canonicalBaseDir) !== snapshot.canonicalBaseDir ||
		realpathSync(snapshot.canonicalBaseDir) !== snapshot.canonicalBaseDir
	)
		throw new Error("Skill snapshot base directory is not the canonical realpath.");
	assertContainedPath(snapshot.canonicalPath, snapshot.canonicalBaseDir, "snapshot skill base directory", true);
	if (snapshot.sourceInfo.baseDir !== undefined) {
		if (
			resolve(snapshot.sourceInfo.baseDir) !== snapshot.sourceInfo.baseDir ||
			realpathSync(snapshot.sourceInfo.baseDir) !== snapshot.sourceInfo.baseDir
		)
			throw new Error("Skill snapshot source-info base directory is not canonical.");
	}
	assertDigest(snapshot.contentDigest, "snapshot content digest");
	assertDigest(snapshot.sourceBytesDigest, "snapshot source bytes digest");
	assertDigest(snapshot.loaderResultDigest, "snapshot loader result digest");
	if (snapshot.loaderResultDigest !== snapshot.loaderProvenance.loaderResultDigest)
		throw new Error("Skill snapshot loader result digest is not bound to loader provenance.");
	assertDigest(snapshot.dependencyManifestDigest, "snapshot dependency manifest digest");
	assertDigest(snapshot.authoritativeDependencyManifestDigest, "snapshot authoritative dependency manifest digest");
	assertDigest(snapshot.snapshotDigest, "snapshot digest");
	assertDigest(snapshot.skillMetadataDigest, "snapshot metadata digest");
	assertDigest(snapshot.invocationTokenHash, "snapshot invocation token hash");
	assertDigest(snapshot.invocationTokenBytesDigest, "snapshot invocation token bytes digest");
	assertEpochRef(snapshot.epochRef, "snapshot epoch");
	assertEpochRef(snapshot.invocationTokenEpoch, "invocation token epoch");
	assertEpochRef(snapshot.snapshotEpoch, "snapshot publication epoch");
	assertDecisionEpochBinding(snapshot.decisionRef, snapshot.epochRef, "snapshot");
	if (snapshot.skillKind !== "markdown" && snapshot.skillKind !== "python")
		throw new Error("Skill snapshot kind is unsupported.");
	if (typeof snapshot.requiredBuiltIn !== "boolean" || typeof snapshot.disableModelInvocation !== "boolean")
		throw new Error("Skill snapshot invocation policy is invalid.");
	if (
		snapshot.requiredBuiltIn !==
		(isRequiredBuiltinName(snapshot.skillName) || snapshot.sourceInfo.source === "builtin")
	)
		throw new Error("Skill snapshot built-in classification is not canonical.");
	if (snapshot.requiredBuiltIn !== (snapshot.builtinProvenance !== null))
		throw new Error("Skill snapshot built-in registry provenance is incomplete.");
	if (snapshot.builtinProvenance !== null) {
		assertNonEmpty(snapshot.builtinProvenance.vendoredRoot, "snapshot built-in vendored root");
		if (
			!isAbsolute(snapshot.builtinProvenance.vendoredRoot) ||
			resolve(snapshot.builtinProvenance.vendoredRoot) !== snapshot.builtinProvenance.vendoredRoot ||
			realpathSync(snapshot.builtinProvenance.vendoredRoot) !== snapshot.builtinProvenance.vendoredRoot
		)
			throw new Error("Skill snapshot built-in vendored root is not the canonical realpath.");
		assertArtifactRef(snapshot.builtinProvenance.registryArtifactRef, "snapshot built-in registry", true);
		assertArtifactRef(
			snapshot.builtinProvenance.sourceManifestArtifactRef,
			"snapshot built-in source manifest",
			true,
		);
		assertDigest(snapshot.builtinProvenance.registryBytesDigest, "snapshot built-in registry bytes");
		assertDigest(snapshot.builtinProvenance.sourceManifestBytesDigest, "snapshot built-in source manifest bytes");
		if (
			snapshot.builtinProvenance.registryArtifactRef.digest !== snapshot.builtinProvenance.registryBytesDigest ||
			snapshot.builtinProvenance.sourceManifestArtifactRef.digest !==
				snapshot.builtinProvenance.sourceManifestBytesDigest
		)
			throw new Error("Skill snapshot built-in registry refs are not content addressed.");
		const sourceEvent = snapshot.builtinProvenance.sourceEvent;
		assertNonEmpty(sourceEvent.eventId, "snapshot built-in source event id");
		assertNonEmpty(sourceEvent.skillName, "snapshot built-in source event skill name");
		assertNonEmpty(sourceEvent.vendoredRoot, "snapshot built-in source event vendored root");
		assertNonEmpty(sourceEvent.canonicalPath, "snapshot built-in source event canonical path");
		assertNonEmpty(sourceEvent.keyId, "snapshot built-in source event key id");
		assertNonEmpty(sourceEvent.signature, "snapshot built-in source event signature");
		assertDigest(sourceEvent.sourceManifestDigest, "snapshot built-in source event manifest");
		assertDigest(sourceEvent.sourceBytesDigest, "snapshot built-in source event bytes");
		assertDigest(sourceEvent.eventDigest, "snapshot built-in source event digest");
		if (!Number.isSafeInteger(sourceEvent.sourceEventSequence) || sourceEvent.sourceEventSequence < 0)
			throw new Error("Skill snapshot built-in source event sequence is invalid.");
		if (sourceEvent.signatureAlgorithm !== "ed25519")
			throw new Error("Skill snapshot built-in source event signature algorithm is invalid.");
	}
	if (
		!Number.isSafeInteger(snapshot.contentBytes) ||
		snapshot.contentBytes < 0 ||
		snapshot.contentBytes > MAX_SKILL_SOURCE_BYTES
	)
		throw new Error("Skill snapshot content size is invalid.");
	if (snapshot.dependencyNames.length > MAX_SKILL_DEPENDENCIES)
		throw new Error("Skill snapshot dependency closure exceeds the dependency-count limit.");
	if (snapshot.packageSourceNames.length > MAX_PACKAGE_FILES)
		throw new Error("Skill snapshot package closure exceeds the file-count limit.");
	const dependencyArrays = [
		snapshot.dependencyNames,
		snapshot.dependencyDigests,
		snapshot.dependencyRefs,
		snapshot.dependencySourceRefs,
		snapshot.dependencySourcePaths,
		snapshot.dependencySourceIdentities,
		snapshot.authoritativeHostDependencyRefs,
	];
	if (dependencyArrays.some((values) => values.length > MAX_SKILL_DEPENDENCIES))
		throw new Error("Skill snapshot dependency arrays exceed the dependency-count limit.");
	const packageArrays = [
		snapshot.packageSourceNames,
		snapshot.packageSourcePaths,
		snapshot.packageSourceIdentities,
		snapshot.packageBytesDigests,
		snapshot.packageArtifactRefs,
		snapshot.hostPackageArtifactRefs,
	];
	if (packageArrays.some((values) => values.length > MAX_PACKAGE_FILES))
		throw new Error("Skill snapshot package arrays exceed the file-count limit.");
	const dependencyBytes = snapshot.dependencyRefs.reduce((total, ref) => total + ref.sizeBytes, 0);
	if (!Number.isSafeInteger(dependencyBytes) || dependencyBytes > MAX_PACKAGE_TOTAL_BYTES)
		throw new Error("Skill snapshot dependency closure exceeds the total byte limit.");
	const packageBytes = snapshot.packageArtifactRefs.reduce((total, ref) => total + ref.sizeBytes, 0);
	if (!Number.isSafeInteger(packageBytes) || packageBytes > MAX_PACKAGE_TOTAL_BYTES)
		throw new Error("Skill snapshot package closure exceeds the total byte limit.");
	if (!Number.isSafeInteger(snapshot.workflowContractRevision) || snapshot.workflowContractRevision < 1)
		throw new Error("Skill snapshot workflow contract revision is invalid.");
	if (!Number.isSafeInteger(snapshot.consumeSequence) || snapshot.consumeSequence < 1)
		throw new Error("Skill snapshot consume sequence is invalid.");
	if (
		snapshot.epochRef.storeEpoch !== snapshot.invocationTokenEpoch.storeEpoch ||
		snapshot.epochRef.coordinatorEpoch !== snapshot.invocationTokenEpoch.coordinatorEpoch ||
		snapshot.epochRef.storeEpoch !== snapshot.snapshotEpoch.storeEpoch ||
		snapshot.epochRef.coordinatorEpoch !== snapshot.snapshotEpoch.coordinatorEpoch
	)
		throw new Error("Skill snapshot epochs are inconsistent.");
	if (
		snapshot.loaderProvenance.issuedBy !== "ResourceLoader" ||
		snapshot.loaderProvenance.artifactNamespace !== "artifacts/skills"
	)
		throw new Error("Skill snapshot ResourceLoader provenance is invalid.");
	assertDigest(snapshot.loaderProvenance.sourceManifestDigest, "snapshot source manifest digest");
	assertDigest(snapshot.loaderProvenance.diagnosticsDigest, "snapshot diagnostics digest");
	assertDigest(snapshot.loaderProvenance.artifactPathDigest, "snapshot artifact path digest");
	assertDigest(snapshot.loaderProvenance.loaderResultDigest, "snapshot loader result digest");
	assertHostReceipt(
		snapshot.loaderProvenance.issuanceReceipt,
		snapshot.workflowId,
		snapshot.workspaceDigest,
		snapshot.loaderProvenance.loaderRevision,
	);
	if (digestObject(snapshot.hostVerificationReceipt) !== digestObject(snapshot.loaderProvenance.issuanceReceipt))
		throw new Error("Skill snapshot host receipt is not the ResourceLoader issuance receipt.");
	assertLoaderReceiptConsumptionWitness({
		witness: snapshot.loaderReceiptConsumptionWitness,
		receipt: snapshot.loaderProvenance.issuanceReceipt,
		workflowId: snapshot.workflowId,
		expectedBindingDigest: snapshot.loaderProvenance.issuanceReceipt.bindingDigest,
		trustedNow: snapshot.trustedNow,
	});
	assertArtifactRef(snapshot.artifactRef, "snapshot content", true);
	assertArtifactRef(snapshot.sourceArtifactRef, "snapshot source", true);
	if (!sameArtifactRef(snapshot.artifactRef, snapshot.sourceArtifactRef))
		throw new Error("Skill snapshot source ref is not bound to its immutable content ref.");
	if (
		snapshot.sourceArtifactRef.digest !== snapshot.contentDigest ||
		snapshot.sourceArtifactRef.sizeBytes !== snapshot.contentBytes
	)
		throw new Error("Skill snapshot source ref is not bound to content bytes.");
	if (snapshot.hostSourceArtifactRef !== null) {
		assertArtifactRef(snapshot.hostSourceArtifactRef, "snapshot host source", true);
		if (
			snapshot.hostSourceArtifactRef.digest !== snapshot.contentDigest ||
			snapshot.hostSourceArtifactRef.sizeBytes !== snapshot.contentBytes
		)
			throw new Error("Skill snapshot host source ref is not bound to source bytes.");
	}
	for (const [index, ref] of snapshot.dependencyRefs.entries())
		if (ref.sizeBytes > MAX_DEPENDENCY_BYTES)
			throw new Error(`Skill snapshot dependency ${index} exceeds the byte limit.`);
	for (const [index, ref] of snapshot.dependencyRefs.entries())
		assertArtifactRef(ref, `snapshot dependency ${index}`, true);
	for (const [index, ref] of snapshot.dependencySourceRefs.entries())
		assertArtifactRef(ref, `snapshot dependency source ${index}`, true);
	for (const [index, ref] of snapshot.authoritativeHostDependencyRefs.entries())
		assertArtifactRef(ref, `snapshot host dependency ${index}`, true);
	for (const [index, ref] of snapshot.packageArtifactRefs.entries())
		if (ref.sizeBytes > MAX_PACKAGE_FILE_BYTES)
			throw new Error(`Skill snapshot package ${index} exceeds the byte limit.`);
	for (const [index, ref] of snapshot.packageArtifactRefs.entries())
		assertArtifactRef(ref, `snapshot package ${index}`, true);
	for (const [index, ref] of snapshot.hostPackageArtifactRefs.entries())
		assertArtifactRef(ref, `snapshot host package ${index}`, true);
	if (
		snapshot.hostPackageArtifactRefs.some(
			(ref) => !snapshot.packageArtifactRefs.some((packageRef) => sameArtifactRef(ref, packageRef)),
		)
	)
		throw new Error("Skill snapshot host package refs are not members of the package closure.");
	if (
		snapshot.dependencyRefs.length !== snapshot.dependencyDigests.length ||
		snapshot.dependencyRefs.length !== snapshot.dependencyNames.length ||
		snapshot.dependencyRefs.length !== snapshot.dependencySourceRefs.length ||
		snapshot.dependencyRefs.length !== snapshot.dependencySourcePaths.length ||
		snapshot.dependencyRefs.length !== snapshot.dependencySourceIdentities.length
	)
		throw new Error("Skill snapshot dependency refs, names, and digests are not aligned.");
	const dependencyIdentities = snapshot.dependencyNames.map(
		(name, index) =>
			`${name}\0${snapshot.dependencySourceRefs[index].relativePath}\0${snapshot.dependencySourcePaths[index] ?? ""}`,
	);
	if (new Set(snapshot.dependencyNames).size !== snapshot.dependencyNames.length)
		throw new Error("Skill snapshot dependency names are duplicated.");
	for (let index = 1; index < dependencyIdentities.length; index += 1) {
		if (compareWorkflowCodePoints(dependencyIdentities[index - 1], dependencyIdentities[index]) > 0)
			throw new Error("Skill snapshot dependency closure is not code-point canonical.");
	}
	if (
		snapshot.authoritativeHostDependencyRefs.length !== snapshot.dependencyRefs.length ||
		snapshot.authoritativeHostDependencyRefs.some(
			(ref, index) => !sameArtifactRef(ref, snapshot.dependencyRefs[index]),
		)
	)
		throw new Error("Skill snapshot host dependency refs are not the authoritative dependency refs.");
	if (
		snapshot.packageArtifactRefs.length !== snapshot.packageSourceNames.length ||
		snapshot.packageArtifactRefs.length !== snapshot.packageSourcePaths.length ||
		snapshot.packageArtifactRefs.length !== snapshot.packageSourceIdentities.length ||
		snapshot.packageArtifactRefs.length !== snapshot.packageBytesDigests.length
	)
		throw new Error("Skill snapshot package closure arrays are not aligned.");
	snapshot.dependencyDigests.forEach((digest, index) => {
		assertDigest(digest, `snapshot dependency ${index} digest`);
		if (digest !== snapshot.dependencyRefs[index].digest || digest !== snapshot.dependencySourceRefs[index].digest)
			throw new Error("Skill snapshot dependency digest is not bound to its refs.");
	});
	for (const [index, sourcePath] of snapshot.dependencySourcePaths.entries()) {
		if (sourcePath !== null) {
			assertNonEmpty(sourcePath, `snapshot dependency ${index} source path`);
			if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath || realpathSync(sourcePath) !== sourcePath)
				throw new Error(`Skill snapshot dependency ${index} source path is not a canonical realpath.`);
		}
		if (sourcePath === null) {
			if (snapshot.dependencySourceIdentities[index] !== null)
				throw new Error(`Skill snapshot dependency ${index} has identity without a source path.`);
		} else {
			const identity = snapshot.dependencySourceIdentities[index];
			if (identity === null) throw new Error(`Skill snapshot dependency ${index} source identity is missing.`);
			assertFileIdentity(identity, `snapshot dependency ${index}`);
		}
	}
	assertFileIdentity(snapshot.sourceFileIdentity, "snapshot source");
	for (const [index, sourcePath] of snapshot.packageSourcePaths.entries()) {
		assertNonEmpty(sourcePath, `snapshot package ${index} source path`);
		if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath || realpathSync(sourcePath) !== sourcePath)
			throw new Error("Skill snapshot package source paths are not canonical realpaths.");
		assertFileIdentity(snapshot.packageSourceIdentities[index], `snapshot package ${index}`);
	}
	snapshot.packageBytesDigests.forEach((digest, index) => {
		assertDigest(digest, `snapshot package ${index} digest`);
		if (digest !== snapshot.packageArtifactRefs[index].digest)
			throw new Error("Skill snapshot package digest is not bound to its artifact ref.");
	});
	for (let index = 1; index < snapshot.packageSourceNames.length; index += 1) {
		if (compareWorkflowCodePoints(snapshot.packageSourceNames[index - 1], snapshot.packageSourceNames[index]) > 0)
			throw new Error("Skill snapshot package closure is not code-point canonical.");
	}
	if (snapshot.manifestArtifactRef !== null) {
		assertArtifactRef(snapshot.manifestArtifactRef, "snapshot manifest", true);
		if (snapshot.manifestArtifactRef.sizeBytes > MAX_MANIFEST_VALUE_BYTES)
			throw new Error("Skill snapshot manifest exceeds the immutable byte limit.");
		if (snapshot.manifestArtifactPayloadKind !== "evidence" || snapshot.manifestArtifactCodec !== "canonical_json")
			throw new Error("Skill snapshot manifest artifact envelope is not canonical.");
	} else if (snapshot.manifestArtifactPayloadKind !== null || snapshot.manifestArtifactCodec !== null) {
		throw new Error("Skill snapshot has manifest envelope metadata without an artifact.");
	}
	if (snapshot.manifest === null) {
		throw new Error("Skill snapshot has no immutable gate manifest.");
	} else {
		assertManifestBounds(snapshot.manifest, "snapshot gate manifest");
		assertDigest(snapshot.manifest.manifestDigest, "snapshot manifest digest");
		if (snapshot.manifestArtifactRef === null || snapshot.manifestSourceArtifactRef === null)
			throw new Error("Skill snapshot manifest metadata has no source and publication refs.");
		if (snapshot.manifestSourceArtifactRef.sizeBytes > MAX_MANIFEST_VALUE_BYTES)
			throw new Error("Skill snapshot manifest source exceeds the immutable byte limit.");
		const canonicalBytes = manifestBytes(snapshot.manifest);
		if (
			sha256Hex(canonicalBytes) !== snapshot.manifest.manifestDigest ||
			snapshot.manifestArtifactRef.digest !== snapshot.manifest.manifestDigest ||
			snapshot.manifestArtifactRef.sizeBytes !== canonicalBytes.byteLength ||
			snapshot.manifestSourceArtifactRef.digest !== snapshot.manifest.manifestDigest ||
			snapshot.manifestSourceArtifactRef.sizeBytes !== canonicalBytes.byteLength
		)
			throw new Error("Skill snapshot manifest digest is not bound to canonical artifact bytes and refs.");
	}
	const expectedDependencyManifestDigest = digestObject(dependencyManifestValue(snapshot));
	if (
		snapshot.dependencyManifestDigest !== expectedDependencyManifestDigest ||
		snapshot.authoritativeDependencyManifestDigest !== expectedDependencyManifestDigest
	)
		throw new Error("Skill snapshot dependency manifest digest is not canonical.");
	if (
		snapshot.snapshotDigest !== computeSnapshotDigest(snapshot) &&
		snapshot.snapshotDigest !== computeCanonicalSnapshotAdmissionDigest(snapshot)
	)
		throw new Error("Skill snapshot digest does not authenticate its immutable metadata.");
	const tokenBytes = invocationTokenBytes(snapshot);
	const tokenHash = sha256Hex(tokenBytes);
	if (
		snapshot.invocationTokenHash !== tokenHash ||
		snapshot.invocationTokenBytesDigest !== tokenHash ||
		snapshot.invocationTokenId !== `skill-token:${tokenHash}`
	)
		throw new Error("Skill snapshot invocation token metadata is not canonical.");
}

export function validateSkillSnapshot(snapshot: WorkflowSkillSnapshot): void {
	assertSnapshot(snapshot);
}

/**
 * Reissue an immutable skill invocation against the host's current durable head.
 *
 * Args:
 * snapshot: Previously admitted immutable skill recipe to rebase.
 * activeHostState: Host-owned durable epoch/head authority.
 * input: Fresh host sequence and trusted time.
 * Return: New immutable snapshot/token bound to the active head.
 */
export async function reissueWorkflowSkillInvocationSnapshot(
	snapshot: WorkflowSkillSnapshot,
	activeHostState: WorkflowSkillActiveHostStateReader,
	input: WorkflowSkillSnapshotReissueInput,
): Promise<WorkflowSkillSnapshot> {
	validateSkillSnapshot(snapshot);
	assertActiveHostStateReader(activeHostState);
	if (!Number.isSafeInteger(input.consumeSequence) || input.consumeSequence <= snapshot.consumeSequence)
		throw new Error("Skill snapshot reissue requires a fresh durable invocation sequence.");
	assertTrustedNow(input.trustedNow);
	const previousTrustedNow = Date.parse(snapshot.trustedNow);
	const nextTrustedNow = Date.parse(input.trustedNow);
	if (!Number.isFinite(previousTrustedNow) || !Number.isFinite(nextTrustedNow) || nextTrustedNow < previousTrustedNow)
		throw new Error("Skill snapshot reissue trusted time cannot move backwards.");
	return activeHostState.withExclusiveLease(snapshot.workflowId, "skill snapshot reissue", async (active) => {
		if (active === null || typeof active !== "object")
			throw new Error("Skill snapshot reissue active state is invalid.");
		assertNonEmpty(active.workflowId, "skill snapshot reissue active workflow id");
		assertEpochRef(active.epochRef, "skill snapshot reissue active epoch");
		assertNonEmpty(active.journalHeadDigest, "skill snapshot reissue active journal head digest");
		if (
			active.journalHeadSequence !== undefined &&
			(!Number.isSafeInteger(active.journalHeadSequence) || active.journalHeadSequence < 0)
		)
			throw new Error("Skill snapshot reissue active journal head sequence is invalid.");
		if (
			active.workflowId !== snapshot.workflowId ||
			active.epochRef.storeEpoch !== snapshot.epochRef.storeEpoch ||
			active.epochRef.coordinatorEpoch !== snapshot.epochRef.coordinatorEpoch
		)
			throw new Error("Skill snapshot reissue cannot cross a durable host epoch rotation.");
		const rebased = structuredClone(snapshot);
		rebased.journalHeadDigest = active.journalHeadDigest;
		rebased.epochRef = cloneEpochRef(active.epochRef);
		rebased.snapshotEpoch = cloneEpochRef(active.epochRef);
		rebased.invocationTokenEpoch = cloneEpochRef(active.epochRef);
		rebased.trustedNow = input.trustedNow;
		rebased.consumeSequence = input.consumeSequence;
		rebased.snapshotDigest = computeSnapshotDigest(rebased);
		const tokenHash = sha256Hex(invocationTokenBytes(rebased));
		rebased.invocationTokenId = `skill-token:${tokenHash}`;
		rebased.invocationTokenHash = tokenHash;
		rebased.invocationTokenBytesDigest = tokenHash;
		validateSkillSnapshot(rebased);
		return freezeDeep(rebased);
	});
}

/**
 * Derive a fresh host-owned one-use invocation from an admitted immutable snapshot.
 *
 * Args:
 * snapshot: Authenticated recipe-bound skill snapshot.
 * consumeSequence: Monotonic host sequence for this invocation.
 * Return: Snapshot view with a new durable token while preserving recipe identity.
 */
export function deriveWorkflowSkillInvocationSnapshot(
	snapshot: WorkflowSkillSnapshot,
	consumeSequence: number,
): WorkflowSkillSnapshot {
	validateSkillSnapshot(snapshot);
	if (!Number.isSafeInteger(consumeSequence) || consumeSequence < 1)
		throw new Error("Skill invocation sequence must be a positive safe integer.");
	const derived = structuredClone(snapshot);
	derived.consumeSequence = consumeSequence;
	const tokenBytes = invocationTokenBytes(derived);
	const tokenHash = sha256Hex(tokenBytes);
	derived.invocationTokenId = `skill-token:${tokenHash}`;
	derived.invocationTokenHash = tokenHash;
	derived.invocationTokenBytesDigest = tokenHash;
	return freezeDeep(derived);
}

export async function createSkillSnapshot(input: WorkflowSkillSnapshotInput): Promise<WorkflowSkillSnapshot> {
	assertNonEmpty(input.workflowId, "workflow id");
	assertNonEmpty(input.taskId, "task id");
	assertDecisionWorkflowBinding(input.decisionRef, input.workflowId, "decision reference");
	assertNonEmpty(input.journalHeadDigest, "journal head digest");
	assertTrustedNow(input.trustedNow);
	assertNonEmpty(input.configDigest, "configuration digest");
	assertNonEmpty(input.workspaceDigest, "workspace digest");
	assertNonEmpty(input.attemptId, "attempt id");
	if (!Number.isSafeInteger(input.workflowContractRevision) || input.workflowContractRevision < 1)
		throw new Error("Skill workflow contract revision is invalid.");
	if (!Number.isSafeInteger(input.sourceEventSequence) || input.sourceEventSequence < 0)
		throw new Error("Skill source event sequence is invalid.");
	if (input.dependencies.length > MAX_SKILL_DEPENDENCIES)
		throw new Error("Skill dependency closure exceeds the dependency-count limit.");
	if (input.manifest === null) throw new Error("Skill admission requires an immutable gate manifest.");
	assertUint8Bytes(input.manifest.bytes, "skill gate manifest bytes", MAX_MANIFEST_VALUE_BYTES);
	if (input.manifest.bytes.byteLength > MAX_MANIFEST_VALUE_BYTES)
		throw new Error("Skill gate manifest exceeds the immutable byte limit.");
	let dependencyBytes = 0;
	for (const dependency of input.dependencies) {
		assertUint8Bytes(dependency.bytes, `dependency ${dependency.name} bytes`, MAX_DEPENDENCY_BYTES);
		if (dependency.bytes.byteLength > MAX_DEPENDENCY_BYTES)
			throw new Error(`Skill dependency ${dependency.name} exceeds the immutable byte limit.`);
		dependencyBytes += dependency.bytes.byteLength;
	}
	if (dependencyBytes > MAX_PACKAGE_TOTAL_BYTES)
		throw new Error("Skill dependency closure exceeds the total byte limit.");
	assertEpochRef(input.epochRef, "input epoch");
	assertDecisionEpochBinding(input.decisionRef, input.epochRef, "input");
	const inspection = await inspectSkill(input.skill);
	const loaderState = await assertLoaderState({
		workflowId: input.workflowId,
		workspaceDigest: input.workspaceDigest,
		skill: input.skill,
		canonicalPath: inspection.canonicalPath,
		loader: input.loader,
		loaderProvenance: input.loaderProvenance,
		receiptContext: input.receiptContext,
		trustedNow: input.trustedNow,
		artifacts: input.artifacts,
	});
	const requiredBuiltIn = loaderState.hostDerivedBuiltin || isRequiredBuiltinName(input.skill.name);
	if (requiredBuiltIn && !loaderState.hostDerivedBuiltin)
		throw new Error("Required built-in skill must come from immutable host-owned built-in resources.");
	const hostSource = await assertHostSourceProvenance({
		skill: input.skill,
		inspection,
		provenance: input.sourceProvenance,
		required: requiredBuiltIn,
		artifacts: input.artifacts,
		sourceEventSequence: input.sourceEventSequence,
	});
	const dependencies = sortByCodePoint(
		input.dependencies.map((dependency) => ({ ...dependency, bytes: Uint8Array.from(dependency.bytes) })),
		dependencyIdentity,
	);
	const dependencyNames = new Set<string>();
	const dependencySourceRefs: WorkflowArtifactRef[] = [];
	const dependencySourcePaths: (string | null)[] = [];
	const dependencySourceIdentities: (WorkflowSkillFileIdentity | null)[] = [];
	for (const [index, dependency] of dependencies.entries()) {
		assertDependencySource(dependency, index, input.sourceEventSequence);
		if (dependencyNames.has(dependency.name)) throw new Error(`Skill dependency ${dependency.name} is duplicated.`);
		dependencyNames.add(dependency.name);
		const dependencySourcePath =
			dependency.sourcePath === undefined
				? null
				: await realpathContained(
						dependency.sourcePath,
						inspection.canonicalBaseDir,
						`dependency ${dependency.name}`,
					);
		let dependencySourceIdentity: WorkflowSkillFileIdentity | null = null;
		if (dependencySourcePath !== null) {
			const sourceRead = await readStableFile(
				dependencySourcePath,
				`dependency ${dependency.name} source`,
				MAX_DEPENDENCY_BYTES,
			);
			if (sourceRead.bytes.byteLength > dependency.bytes.byteLength)
				throw new Error(`Skill dependency ${dependency.name} source exceeds its declared byte bound.`);
			if (sha256Hex(sourceRead.bytes) !== dependency.contentDigest)
				throw new Error(`Skill dependency ${dependency.name} source bytes drifted before publication.`);
			dependencySourceIdentity = sourceRead.identity;
		}
		await verifyArtifactRef(
			input.artifacts,
			dependency.artifactRef,
			"binary",
			`dependency ${dependency.name} source`,
			"evidence",
			MAX_DEPENDENCY_BYTES,
		);
		dependencySourceRefs.push(cloneArtifactRef(dependency.artifactRef));
		dependencySourcePaths.push(dependencySourcePath);
		dependencySourceIdentities.push(dependencySourceIdentity);
	}
	const manifestSource =
		input.manifest === null
			? null
			: {
					...input.manifest,
					bytes: Uint8Array.from(input.manifest.bytes),
				};
	let manifestSourceDigest: string | null = null;
	let parsedManifestSource: WorkflowSkillManifest | null = null;
	if (manifestSource !== null) {
		assertUint8Bytes(manifestSource.bytes, "skill manifest source bytes", MAX_MANIFEST_VALUE_BYTES);
		manifestSourceDigest = sha256Hex(manifestSource.bytes);
		assertDigest(manifestSource.contentDigest, "manifest content");
		assertArtifactRef(manifestSource.artifactRef, "manifest source", true);
		if (
			manifestSource.contentDigest !== manifestSourceDigest ||
			manifestSource.artifactRef.digest !== manifestSourceDigest ||
			manifestSource.artifactRef.sizeBytes !== manifestSource.bytes.byteLength ||
			manifestSource.artifactRef.sourceEventSequence !== input.sourceEventSequence
		)
			throw new Error("Skill manifest source is not content addressed.");
		await verifyArtifactRef(
			input.artifacts,
			manifestSource.artifactRef,
			"canonical_json",
			"manifest source",
			"evidence",
			MAX_MANIFEST_VALUE_BYTES,
		);
		parsedManifestSource = parseSkillManifest(Uint8Array.from(manifestSource.bytes), manifestSourceDigest);
	}
	if (requiredBuiltIn) {
		if (parsedManifestSource === null) throw new Error("Required built-in skill has no parsed gate manifest.");
		await assertBuiltinProvenance({
			skill: input.skill,
			inspection,
			provenance: input.sourceProvenance,
			context: input.builtinProvenanceContext,
			manifest: parsedManifestSource,
			sourceEventSequence: input.sourceEventSequence,
			trustedNow: input.trustedNow,
		});
	}
	const builtinSnapshotProvenance =
		requiredBuiltIn && input.sourceProvenance?.builtin !== undefined
			? snapshotBuiltinProvenanceFromProof(input.sourceProvenance.builtin)
			: null;
	const contentRef = await publishAndVerifyArtifact({
		workflowId: input.workflowId,
		bytes: inspection.contentBytes,
		codec: "binary",
		idempotencyKey: `skill-content:${input.skill.name}:${inspection.contentDigest}`,
		sourceEventSequence: input.sourceEventSequence,
		artifacts: input.artifacts,
		publisher: input.publisher,
		label: "content",
	});

	const dependencyRefs: WorkflowArtifactRef[] = [];
	const dependencyDigests: string[] = [];
	for (const dependency of dependencies) {
		const dependencyRef = await publishAndVerifyArtifact({
			workflowId: input.workflowId,
			bytes: dependency.bytes,
			codec: "binary",
			idempotencyKey: `skill-dependency:${dependency.name}:${dependency.contentDigest}`,
			sourceEventSequence: input.sourceEventSequence,
			artifacts: input.artifacts,
			publisher: input.publisher,
			label: `dependency ${dependency.name}`,
		});
		dependencyRefs.push(dependencyRef);
		dependencyDigests.push(dependency.contentDigest);
	}

	const packageSourcesByName = new Map<string, WorkflowSkillPackageSource>();
	for (const packageSource of input.sourceProvenance?.packageSources ?? []) {
		const name = normalizeRelativeName(packageSource.name, "package source name");
		if (packageSourcesByName.has(name)) throw new Error(`Skill package source ${name} is duplicated.`);
		packageSourcesByName.set(name, packageSource);
	}
	const packageArtifactRefs: WorkflowArtifactRef[] = [];
	const packageSourceNames: string[] = [];
	const packageSourcePaths: string[] = [];
	const packageSourceIdentities: WorkflowSkillFileIdentity[] = [];
	const packageBytesDigests: string[] = [];
	const hostPackageArtifactRefs: WorkflowArtifactRef[] = [];
	for (const file of inspection.packageFiles) {
		const supplied = packageSourcesByName.get(file.name);
		const packageRef =
			supplied === undefined
				? await publishAndVerifyArtifact({
						workflowId: input.workflowId,
						bytes: file.bytes,
						codec: "binary",
						idempotencyKey: `skill-package:${input.skill.name}:${file.name}:${file.digest}`,
						sourceEventSequence: input.sourceEventSequence,
						artifacts: input.artifacts,
						publisher: input.publisher,
						label: `package ${file.name}`,
					})
				: cloneArtifactRef(supplied.artifactRef);
		if (supplied !== undefined && !sameArtifactRef(packageRef, supplied.artifactRef))
			throw new Error(`Skill package source ${file.name} publication changed its host ref.`);
		packageArtifactRefs.push(packageRef);
		packageSourceNames.push(file.name);
		packageSourcePaths.push(file.sourcePath);
		packageSourceIdentities.push(file.identity);
		packageBytesDigests.push(file.digest);
		if (supplied !== undefined) hostPackageArtifactRefs.push(cloneArtifactRef(packageRef));
	}
	if (input.sourceProvenance !== undefined && packageSourcesByName.size !== inspection.packageFiles.length)
		throw new Error("Skill package provenance contains bytes outside the discovered package closure.");

	let manifest: WorkflowSkillManifest | null = null;
	let manifestArtifactRef: WorkflowArtifactRef | null = null;
	let manifestSourceArtifactRef: WorkflowArtifactRef | null = null;
	if (manifestSource !== null) {
		if (manifestSourceDigest === null || parsedManifestSource === null)
			throw new Error("Skill manifest preflight did not produce canonical metadata.");
		const publishedManifestRef = await publishAndVerifyArtifact({
			workflowId: input.workflowId,
			bytes: manifestSource.bytes,
			codec: "canonical_json",
			idempotencyKey: `skill-manifest:${manifestSourceDigest}`,
			sourceEventSequence: input.sourceEventSequence,
			artifacts: input.artifacts,
			publisher: input.publisher,
			label: "manifest",
		});
		const resolvedManifest = await verifyArtifactRef(
			input.artifacts,
			publishedManifestRef,
			"canonical_json",
			"manifest",
			"evidence",
			MAX_MANIFEST_VALUE_BYTES,
		);
		if (
			resolvedManifest.envelope.payloadKind !== "evidence" ||
			resolvedManifest.envelope.codec !== "canonical_json" ||
			resolvedManifest.envelope.ref.digest !== manifestSourceDigest ||
			resolvedManifest.envelope.ref.sizeBytes !== manifestSource.bytes.byteLength ||
			resolvedManifest.verifiedDigest !== manifestSourceDigest ||
			resolvedManifest.verifiedSizeBytes !== manifestSource.bytes.byteLength
		)
			throw new Error("Skill manifest digest is not bound to the resolved immutable artifact envelope.");
		manifest = parseSkillManifest(Uint8Array.from(resolvedManifest.bytes), resolvedManifest.envelope.ref.digest);
		if (!manifestEquals(manifest, parsedManifestSource) || manifest.manifestDigest !== publishedManifestRef.digest)
			throw new Error("Skill manifest bytes changed during immutable publication.");
		manifestArtifactRef = publishedManifestRef;
		manifestSourceArtifactRef = cloneArtifactRef(manifestSource.artifactRef);
	}

	const dependencyManifestDigest = digestObject({
		dependencies:
			dependencyNames.size === dependencies.length
				? dependencies.map((dependency, index) => ({
						name: dependency.name,
						digest: dependencyDigests[index],
						sourceRef: dependencySourceRefs[index],
						sourcePath: dependencySourcePaths[index],
						artifactRef: dependencyRefs[index],
					}))
				: [],
		manifestDigest: manifest?.manifestDigest ?? null,
		manifestArtifactRef,
		manifestSourceArtifactRef,
		hostSourceArtifactRef: hostSource.hostSourceArtifactRef,
		packageSources: packageSourceNames.map((name, index) => ({
			name,
			sourcePath: packageSourcePaths[index],
			digest: packageBytesDigests[index],
			artifactRef: packageArtifactRefs[index],
		})),
	});
	const snapshotWithoutDigest: WorkflowSkillSnapshot = {
		workflowId: input.workflowId,
		taskId: input.taskId,
		decisionRef: cloneDecisionRef(input.decisionRef),
		journalHeadDigest: input.journalHeadDigest,
		trustedNow: input.trustedNow,
		epochRef: cloneEpochRef(input.epochRef),
		configDigest: input.configDigest,
		workspaceDigest: input.workspaceDigest,
		attemptId: input.attemptId,
		loaderProvenance: {
			...cloneLoaderProvenance(input.loaderProvenance),
			issuanceReceipt: cloneReceipt(loaderState.issuanceReceipt),
		},
		loaderReceiptConsumptionWitness: structuredClone(loaderState.issuanceConsumptionWitness),
		loaderResultDigest: input.loaderProvenance.loaderResultDigest,
		requiredBuiltIn,
		builtinProvenance: builtinSnapshotProvenance,
		canonicalBaseDir: inspection.canonicalBaseDir,
		skillName: input.skill.name,
		skillKind: input.skill.kind,
		canonicalPath: inspection.canonicalPath,
		sourceInfo: {
			...input.skill.sourceInfo,
			path: inspection.canonicalPath,
			baseDir:
				input.skill.sourceInfo.baseDir === undefined
					? undefined
					: (inspection.canonicalSourceInfoBaseDir ?? inspection.canonicalBaseDir),
		},
		disableModelInvocation: input.skill.disableModelInvocation,
		contentDigest: inspection.contentDigest,
		contentBytes: inspection.contentBytes.byteLength,
		sourceFileIdentity: { ...inspection.contentIdentity },
		dependencyNames: dependencies.map((dependency) => dependency.name),
		dependencyDigests: [...dependencyDigests],
		dependencyRefs: dependencyRefs.map(cloneArtifactRef),
		dependencySourceRefs: dependencySourceRefs.map(cloneArtifactRef),
		dependencySourcePaths: [...dependencySourcePaths],
		dependencySourceIdentities: dependencySourceIdentities.map((identity) =>
			identity === null ? null : { ...identity },
		),
		dependencyManifestDigest,
		manifest:
			manifest === null
				? null
				: {
						requiredApprovalGates: [...manifest.requiredApprovalGates],
						requiredArtifactKinds: [...manifest.requiredArtifactKinds],
						requiredPressureTests: [...manifest.requiredPressureTests],
						allowedTransitions: [...manifest.allowedTransitions],
						manifestDigest: manifest.manifestDigest,
					},
		manifestArtifactRef: manifestArtifactRef === null ? null : cloneArtifactRef(manifestArtifactRef),
		manifestArtifactPayloadKind: manifestArtifactRef === null ? null : "evidence",
		manifestArtifactCodec: manifestArtifactRef === null ? null : "canonical_json",
		manifestSourceArtifactRef:
			manifestSourceArtifactRef === null ? null : cloneArtifactRef(manifestSourceArtifactRef),
		authoritativeDependencyManifestDigest: dependencyManifestDigest,
		authoritativeHostDependencyRefs: dependencyRefs.map(cloneArtifactRef),
		hostSourceArtifactRef: hostSource.hostSourceArtifactRef,
		hostPackageArtifactRefs: hostPackageArtifactRefs.map(cloneArtifactRef),
		sourceArtifactRef: cloneArtifactRef(contentRef),
		sourceBytesDigest: inspection.contentDigest,
		packageSourceNames: [...packageSourceNames],
		packageSourcePaths: [...packageSourcePaths],
		packageSourceIdentities: packageSourceIdentities.map((identity) => ({ ...identity })),
		packageBytesDigests: [...packageBytesDigests],
		packageArtifactRefs: packageArtifactRefs.map(cloneArtifactRef),
		workflowContractRevision: input.workflowContractRevision,
		skillMetadataDigest: inspection.metadataDigest,
		snapshotDigest: "",
		invocationTokenId: "",
		invocationTokenHash: "",
		invocationTokenBytesDigest: "",
		invocationTokenEpoch: cloneEpochRef(input.epochRef),
		consumeSequence: 1,
		artifactRef: cloneArtifactRef(contentRef),
		hostVerificationReceipt: cloneReceipt(loaderState.issuanceReceipt),
		snapshotEpoch: cloneEpochRef(input.epochRef),
	};
	snapshotWithoutDigest.snapshotDigest = computeSnapshotDigest(snapshotWithoutDigest);
	const tokenHash = sha256Hex(invocationTokenBytes(snapshotWithoutDigest));
	snapshotWithoutDigest.invocationTokenId = `skill-token:${tokenHash}`;
	snapshotWithoutDigest.invocationTokenHash = tokenHash;
	snapshotWithoutDigest.invocationTokenBytesDigest = tokenHash;
	return freezeDeep(snapshotWithoutDigest);
}

function manifestEquals(left: WorkflowSkillManifest, right: WorkflowSkillManifest): boolean {
	return digestObject(left) === digestObject(right);
}

async function assertCurrentLoaderAndSkill(
	snapshot: WorkflowSkillSnapshot,
	current: WorkflowSkillInvocationContext,
	artifacts: WorkflowArtifactResolver,
): Promise<void> {
	if (current.workflowContractRevision !== snapshot.workflowContractRevision)
		throw new Error("Skill invocation workflow contract revision drifted.");
	const revision = snapshot.loaderProvenance.loaderRevision;
	assertLoaderPort(current.loader, revision);
	if (revision !== snapshot.loaderProvenance.loaderRevision)
		throw new Error("Skill invocation ResourceLoader revision drifted.");
	let rawResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	try {
		rawResult = current.loader.getSkills();
	} catch (error) {
		throw new Error("Skill invocation ResourceLoader result could not be re-resolved.", { cause: error });
	}
	const result = { ...snapshotLoaderResult(rawResult), revision };
	assertLoaderProvenance(snapshot.loaderProvenance, snapshot.workflowId, snapshot.workspaceDigest, revision, result);
	await verifyHostReceiptArtifact(artifacts, snapshot.loaderProvenance.issuanceReceipt);
	const issuanceReceipt = await resolveVerifiedLoaderReceipt({
		receipt: snapshot.loaderProvenance.issuanceReceipt,
		context: current.receiptContext,
		workflowId: snapshot.workflowId,
		workspaceDigest: snapshot.workspaceDigest,
		loaderRevision: revision,
		loaderResultDigest: snapshot.loaderResultDigest,
		trustedNow: snapshot.loaderReceiptConsumptionWitness.consumedAt,
		consume: false,
	});
	assertVerifiedReceiptIdentity(snapshot.hostVerificationReceipt, issuanceReceipt.receipt);
	assertLoaderReceiptConsumptionWitness({
		witness: issuanceReceipt.consumptionWitness,
		receipt: issuanceReceipt.receipt,
		workflowId: snapshot.workflowId,
		expectedBindingDigest: snapshot.loaderProvenance.issuanceReceipt.bindingDigest,
		trustedNow: current.trustedNow,
	});
	if (digestObject(snapshot.loaderReceiptConsumptionWitness) !== digestObject(issuanceReceipt.consumptionWitness))
		throw new Error("Skill invocation ResourceLoader receipt consumption witness drifted.");
	const matches = result.skills.filter((skill) => skill.name === snapshot.skillName);
	if (matches.length !== 1) throw new Error("Skill invocation ResourceLoader skill was deleted or became ambiguous.");
	const currentSkill = matches[0];
	if ((await realpath(currentSkill.filePath)) !== snapshot.canonicalPath)
		throw new Error("Skill invocation source path drifted.");
	const hostDerivedBuiltin = currentSkill.sourceInfo.source === "builtin";
	if (snapshot.requiredBuiltIn !== hostDerivedBuiltin && isRequiredBuiltinName(snapshot.skillName))
		throw new Error("Skill invocation built-in provenance drifted from the host loader.");
	if (snapshot.requiredBuiltIn && !hostDerivedBuiltin)
		throw new Error("Required built-in skill was replaced during invocation recovery.");
	const inspection = await inspectSkill(currentSkill);
	if (
		inspection.canonicalPath !== snapshot.canonicalPath ||
		inspection.metadataDigest !== snapshot.skillMetadataDigest ||
		!sameFileIdentityRecord(inspection.contentIdentity, snapshot.sourceFileIdentity)
	)
		throw new Error("Skill invocation source or package metadata drifted.");
	if (snapshot.requiredBuiltIn) {
		const builtin = snapshot.builtinProvenance;
		const context = current.builtinProvenanceContext;
		const sourceRef = snapshot.hostSourceArtifactRef;
		if (builtin === null || context === undefined || sourceRef === null || snapshot.manifest === null)
			throw new Error("Required built-in skill has no revalidation provenance context.");
		const registry = await verifyArtifactRef(
			context.artifactResolver,
			builtin.registryArtifactRef,
			"canonical_json",
			"built-in registry",
			"evidence",
		);
		const sourceManifest = await verifyArtifactRef(
			context.artifactResolver,
			builtin.sourceManifestArtifactRef,
			"canonical_json",
			"built-in source manifest",
			"evidence",
		);
		await assertBuiltinProvenance({
			skill: currentSkill,
			inspection,
			provenance: {
				sourcePath: inspection.canonicalPath,
				sourceBytes: inspection.contentBytes,
				sourceRef,
				packageSources: [],
				builtin: {
					vendoredRoot: builtin.vendoredRoot,
					registryArtifactRef: builtin.registryArtifactRef,
					registryBytes: registry.bytes,
					sourceManifestArtifactRef: builtin.sourceManifestArtifactRef,
					sourceManifestBytes: sourceManifest.bytes,
					sourceEvent: builtin.sourceEvent,
				},
			},
			context,
			manifest: snapshot.manifest,
			sourceEventSequence: sourceRef.sourceEventSequence,
			trustedNow: snapshot.loaderReceiptConsumptionWitness.consumedAt,
		});
	}
	if (
		inspection.contentDigest !== snapshot.contentDigest ||
		inspection.contentBytes.byteLength !== snapshot.contentBytes
	)
		throw new Error("Skill invocation source bytes were deleted or changed.");
	if (inspection.packageFiles.length !== snapshot.packageSourceNames.length)
		throw new Error("Skill invocation Python package closure was deleted or changed.");
	const packageByName = new Map(inspection.packageFiles.map((file) => [file.name, file]));
	for (const [index, name] of snapshot.packageSourceNames.entries()) {
		const file = packageByName.get(name);
		if (
			file === undefined ||
			file.sourcePath !== snapshot.packageSourcePaths[index] ||
			file.digest !== snapshot.packageBytesDigests[index] ||
			!sameFileIdentityRecord(file.identity, snapshot.packageSourceIdentities[index])
		)
			throw new Error(`Skill invocation package source ${name} was deleted or changed.`);
	}
}

export async function revalidateSkillSnapshot(
	snapshot: WorkflowSkillSnapshot,
	artifacts: WorkflowArtifactResolver,
	current: WorkflowSkillInvocationContext,
): Promise<WorkflowSkillInvocationArtifacts> {
	assertSnapshot(snapshot);
	assertNonEmpty(current.workflowId, "current workflow id");
	assertNonEmpty(current.taskId, "current task id");
	assertDecisionWorkflowBinding(current.decisionRef, current.workflowId, "current decision reference");
	assertNonEmpty(current.configDigest, "current configuration digest");
	assertNonEmpty(current.workspaceDigest, "current workspace digest");
	assertNonEmpty(current.attemptId, "current attempt id");
	assertNonEmpty(current.journalHeadDigest, "current journal head digest");
	assertDigest(current.dependencyManifestDigest, "current dependency manifest digest");
	assertTrustedNow(current.trustedNow);
	assertEpochRef(current.epochRef, "current epoch");
	assertDecisionEpochBinding(current.decisionRef, current.epochRef, "current");
	if (
		snapshot.workflowId !== current.workflowId ||
		snapshot.taskId !== current.taskId ||
		digestObject(snapshot.decisionRef) !== digestObject(current.decisionRef) ||
		snapshot.journalHeadDigest !== current.journalHeadDigest ||
		snapshot.trustedNow !== current.trustedNow ||
		snapshot.configDigest !== current.configDigest ||
		snapshot.workspaceDigest !== current.workspaceDigest ||
		snapshot.attemptId !== current.attemptId ||
		snapshot.epochRef.storeEpoch !== current.epochRef.storeEpoch ||
		snapshot.epochRef.coordinatorEpoch !== current.epochRef.coordinatorEpoch ||
		snapshot.authoritativeDependencyManifestDigest !== current.dependencyManifestDigest
	)
		throw new Error("Skill invocation context does not match the immutable snapshot.");
	await assertCurrentLoaderAndSkill(snapshot, current, artifacts);
	const sourceArtifact = await verifyArtifactRef(
		artifacts,
		snapshot.sourceArtifactRef,
		"binary",
		"source",
		"evidence",
		MAX_SKILL_SOURCE_BYTES,
	);
	const executableDependencies: WorkflowSkillImmutableArtifact[] = [];
	const executablePackageFiles: WorkflowSkillImmutableArtifact[] = [];
	if (snapshot.hostSourceArtifactRef !== null)
		await verifyArtifactRef(
			artifacts,
			snapshot.hostSourceArtifactRef,
			"binary",
			"host source",
			"evidence",
			MAX_SKILL_SOURCE_BYTES,
		);
	for (const [index, ref] of snapshot.dependencyRefs.entries()) {
		const resolved = await verifyArtifactRef(
			artifacts,
			ref,
			"binary",
			`dependency ${index}`,
			"evidence",
			MAX_DEPENDENCY_BYTES,
		);
		executableDependencies.push(immutableArtifactFromResolved(ref, resolved));
	}
	for (const [index, ref] of snapshot.dependencySourceRefs.entries())
		await verifyArtifactRef(artifacts, ref, "binary", `dependency source ${index}`, "evidence", MAX_DEPENDENCY_BYTES);
	for (const [index, sourcePath] of snapshot.dependencySourcePaths.entries()) {
		if (sourcePath === null) continue;
		const currentPath = await realpathContained(sourcePath, snapshot.canonicalBaseDir, `dependency ${index} source`);
		if (currentPath !== sourcePath) throw new Error(`Skill invocation dependency source ${index} realpath drifted.`);
		const currentRead = await readStableFile(currentPath, `dependency ${index} source`, MAX_DEPENDENCY_BYTES);
		const expectedIdentity = snapshot.dependencySourceIdentities[index];
		if (expectedIdentity === null || !sameFileIdentityRecord(currentRead.identity, expectedIdentity))
			throw new Error(`Skill invocation dependency source ${index} file identity drifted.`);
		if (sha256Hex(currentRead.bytes) !== snapshot.dependencyDigests[index])
			throw new Error(`Skill invocation dependency source ${index} was deleted or changed.`);
	}
	for (const [index, ref] of snapshot.packageArtifactRefs.entries()) {
		const resolved = await verifyArtifactRef(
			artifacts,
			ref,
			"binary",
			`package ${index}`,
			"evidence",
			MAX_PACKAGE_FILE_BYTES,
		);
		executablePackageFiles.push(immutableArtifactFromResolved(ref, resolved));
	}
	for (const [index, ref] of snapshot.hostPackageArtifactRefs.entries())
		await verifyArtifactRef(artifacts, ref, "binary", `host package ${index}`, "evidence", MAX_PACKAGE_FILE_BYTES);
	let executableManifest: WorkflowSkillImmutableArtifact | null = null;
	if (snapshot.manifestArtifactRef !== null) {
		if (snapshot.manifest === null || snapshot.manifestSourceArtifactRef === null)
			throw new Error("Skill invocation manifest artifact has no immutable metadata.");
		const resolvedManifest = await verifyArtifactRef(
			artifacts,
			snapshot.manifestArtifactRef,
			"canonical_json",
			"manifest",
			"evidence",
			MAX_MANIFEST_VALUE_BYTES,
		);
		if (
			resolvedManifest.envelope.payloadKind !== snapshot.manifestArtifactPayloadKind ||
			resolvedManifest.envelope.codec !== snapshot.manifestArtifactCodec ||
			resolvedManifest.envelope.ref.digest !== snapshot.manifest.manifestDigest ||
			resolvedManifest.envelope.ref.sizeBytes !== manifestBytes(snapshot.manifest).byteLength
		)
			throw new Error("Skill invocation manifest artifact envelope drifted from its digest binding.");
		const parsedManifest = parseSkillManifest(
			Uint8Array.from(resolvedManifest.bytes),
			resolvedManifest.envelope.ref.digest,
		);
		if (!manifestEquals(parsedManifest, snapshot.manifest))
			throw new Error("Skill invocation manifest metadata does not match immutable manifest bytes.");
		executableManifest = immutableArtifactFromResolved(snapshot.manifestArtifactRef, resolvedManifest);
		await verifyArtifactRef(
			artifacts,
			snapshot.manifestSourceArtifactRef,
			"canonical_json",
			"manifest source",
			"evidence",
			MAX_MANIFEST_VALUE_BYTES,
		);
	} else if (snapshot.manifest !== null || snapshot.manifestSourceArtifactRef !== null) {
		throw new Error("Skill invocation manifest metadata is incomplete.");
	}
	return freezeDeep({
		source: immutableArtifactFromResolved(snapshot.sourceArtifactRef, sourceArtifact),
		dependencies: executableDependencies,
		packageFiles: executablePackageFiles,
		manifest: executableManifest,
	});
}

function invocationWitnessSignedValue(witness: WorkflowSkillInvocationConsumptionWitness): Record<string, unknown> {
	const { signature: _signature, ...signedValue } = witness;
	return signedValue;
}

async function assertInvocationConsumptionWitness(
	witness: WorkflowSkillInvocationConsumptionWitness,
	expected: {
		workflowId: string;
		taskId: string;
		decisionRef: WorkflowDecisionRef;
		attemptId: string;
		snapshotDigest: string;
		invocationTokenId: string;
		tokenHash: string;
		configDigest: string;
		dependencyManifestDigest: string;
		consumeSequence: number;
		expectedEpoch: WorkflowEpochRef;
		journalHeadDigest: string;
		trustedNow: string;
	},
	current: Pick<WorkflowSkillInvocationContext, "trustedNow" | "receiptContext">,
): Promise<void> {
	const witnessKeys = [
		"workflowId",
		"taskId",
		"decisionRef",
		"attemptId",
		"snapshotDigest",
		"invocationTokenId",
		"tokenHash",
		"configDigest",
		"dependencyManifestDigest",
		"consumeSequence",
		"expectedEpoch",
		"journalHeadDigest",
		"keyId",
		"signatureAlgorithm",
		"signature",
		"trustedNow",
		"consumedAt",
		"consumptionSequence",
	];
	const actualWitnessKeys = Object.keys(witness);
	if (actualWitnessKeys.length !== witnessKeys.length || actualWitnessKeys.some((key) => !witnessKeys.includes(key)))
		throw new Error("Skill durable invocation witness has an unknown or missing field.");
	if (
		witness.workflowId !== expected.workflowId ||
		witness.taskId !== expected.taskId ||
		digestObject(witness.decisionRef) !== digestObject(expected.decisionRef) ||
		witness.attemptId !== expected.attemptId ||
		witness.snapshotDigest !== expected.snapshotDigest ||
		witness.invocationTokenId !== expected.invocationTokenId ||
		witness.tokenHash !== expected.tokenHash ||
		witness.configDigest !== expected.configDigest ||
		witness.dependencyManifestDigest !== expected.dependencyManifestDigest ||
		witness.consumeSequence !== expected.consumeSequence ||
		witness.expectedEpoch.storeEpoch !== expected.expectedEpoch.storeEpoch ||
		witness.expectedEpoch.coordinatorEpoch !== expected.expectedEpoch.coordinatorEpoch ||
		witness.journalHeadDigest !== expected.journalHeadDigest ||
		witness.trustedNow !== expected.trustedNow
	)
		throw new Error("Skill durable invocation witness is not bound to the consumed token.");
	assertNonEmpty(witness.keyId, "Skill durable invocation witness key id");
	assertNonEmpty(witness.signature, "Skill durable invocation witness signature");
	if (witness.signatureAlgorithm !== "ed25519")
		throw new Error("Skill durable invocation witness signature algorithm is invalid.");
	if (witness.trustedNow !== current.trustedNow)
		throw new Error("Skill durable invocation witness is not bound to the trusted time.");
	if (!Number.isSafeInteger(witness.consumptionSequence) || witness.consumptionSequence !== expected.consumeSequence)
		throw new Error("Skill durable invocation witness has an invalid consumption sequence.");
	const trustedNow = Date.parse(current.trustedNow);
	const consumedAt = Date.parse(witness.consumedAt);
	if (
		witness.consumedAt !== witness.trustedNow ||
		!Number.isFinite(consumedAt) ||
		!Number.isFinite(trustedNow) ||
		consumedAt !== trustedNow
	)
		throw new Error("Skill durable invocation witness has an invalid trusted consumption time.");
	const key = await current.receiptContext.keyResolver.resolve(witness.keyId);
	if (
		key.algorithm !== witness.signatureAlgorithm ||
		!key.verify({
			bytes: canonicalJsonBytes(invocationWitnessSignedValue(witness)),
			signature: witness.signature,
		})
	)
		throw new Error("Skill durable invocation witness signature verification failed.");
}

function executionClaimSignedValue(witness: WorkflowSkillExecutionClaimWitness): Record<string, unknown> {
	const { signature: _signature, ...signedValue } = witness;
	return signedValue;
}

async function assertExecutionClaimWitness(
	witness: WorkflowSkillExecutionClaimWitness,
	expected: WorkflowSkillExecutionClaimInput,
	receiptContext: WorkflowHostReceiptConsumerContext,
): Promise<void> {
	const witnessKeys = [
		"workflowId",
		"taskId",
		"decisionRef",
		"attemptId",
		"snapshotDigest",
		"admissionDigest",
		"invocationTokenId",
		"tokenHash",
		"configDigest",
		"workspaceDigest",
		"dependencyManifestDigest",
		"workflowContractRevision",
		"consumeSequence",
		"expectedEpoch",
		"journalHeadDigest",
		"trustedNow",
		"claimKind",
		"keyId",
		"signatureAlgorithm",
		"signature",
		"claimedAt",
		"claimSequence",
	];
	if (witness === null || typeof witness !== "object") throw new Error("Skill execution claim witness is invalid.");
	const actualWitnessKeys = Object.keys(witness);
	if (actualWitnessKeys.length !== witnessKeys.length || actualWitnessKeys.some((key) => !witnessKeys.includes(key)))
		throw new Error("Skill execution claim witness has an unknown or missing field.");
	assertExecutionClaimInput(expected);
	if (
		witness.claimKind !== "workflow-skill-execution" ||
		witness.workflowId !== expected.workflowId ||
		witness.taskId !== expected.taskId ||
		digestObject(witness.decisionRef) !== digestObject(expected.decisionRef) ||
		witness.attemptId !== expected.attemptId ||
		witness.snapshotDigest !== expected.snapshotDigest ||
		witness.admissionDigest !== expected.admissionDigest ||
		witness.invocationTokenId !== expected.invocationTokenId ||
		witness.tokenHash !== expected.tokenHash ||
		witness.configDigest !== expected.configDigest ||
		witness.workspaceDigest !== expected.workspaceDigest ||
		witness.dependencyManifestDigest !== expected.dependencyManifestDigest ||
		witness.workflowContractRevision !== expected.workflowContractRevision ||
		witness.consumeSequence !== expected.consumeSequence ||
		witness.expectedEpoch.storeEpoch !== expected.expectedEpoch.storeEpoch ||
		witness.expectedEpoch.coordinatorEpoch !== expected.expectedEpoch.coordinatorEpoch ||
		witness.journalHeadDigest !== expected.journalHeadDigest ||
		witness.trustedNow !== expected.trustedNow
	)
		throw new Error("Skill execution claim witness is not bound to the current admission.");
	assertNonEmpty(witness.keyId, "Skill execution claim witness key id");
	assertNonEmpty(witness.signature, "Skill execution claim witness signature");
	if (witness.signatureAlgorithm !== "ed25519")
		throw new Error("Skill execution claim witness signature algorithm is invalid.");
	if (witness.claimedAt !== witness.trustedNow) throw new Error("Skill execution claim witness time is not trusted.");
	if (!Number.isSafeInteger(witness.claimSequence) || witness.claimSequence !== 1)
		throw new Error("Skill execution claim witness sequence is invalid.");
	const trustedNow = Date.parse(expected.trustedNow);
	const claimedAt = Date.parse(witness.claimedAt);
	if (!Number.isFinite(trustedNow) || !Number.isFinite(claimedAt) || trustedNow !== claimedAt)
		throw new Error("Skill execution claim witness time is invalid.");
	const key = await receiptContext.keyResolver.resolve(witness.keyId);
	if (
		key.algorithm !== witness.signatureAlgorithm ||
		!key.verify({ bytes: canonicalJsonBytes(executionClaimSignedValue(witness)), signature: witness.signature })
	)
		throw new Error("Skill execution claim witness signature verification failed.");
}

function assertExecutionCurrentBinding(
	admission: WorkflowSkillInvocationAdmission,
	current: WorkflowSkillHostInvocationContext,
): void {
	assertNonEmpty(current.workflowId, "execution current workflow id");
	assertNonEmpty(current.taskId, "execution current task id");
	assertDecisionWorkflowBinding(current.decisionRef, current.workflowId, "execution current decision reference");
	assertDecisionEpochBinding(current.decisionRef, current.epochRef, "execution current");
	assertNonEmpty(current.configDigest, "execution current configuration digest");
	assertNonEmpty(current.workspaceDigest, "execution current workspace digest");
	assertNonEmpty(current.attemptId, "execution current attempt id");
	assertDigest(current.dependencyManifestDigest, "execution current dependency manifest digest");
	assertNonEmpty(current.journalHeadDigest, "execution current journal head digest");
	assertTrustedNow(current.trustedNow);
	if (
		admission.workflowId !== current.workflowId ||
		admission.taskId !== current.taskId ||
		digestObject(admission.decisionRef) !== digestObject(current.decisionRef) ||
		admission.attemptId !== current.attemptId ||
		admission.configDigest !== current.configDigest ||
		admission.workspaceDigest !== current.workspaceDigest ||
		admission.dependencyManifestDigest !== current.dependencyManifestDigest ||
		admission.workflowContractRevision !== current.workflowContractRevision ||
		admission.epochRef.storeEpoch !== current.epochRef.storeEpoch ||
		admission.epochRef.coordinatorEpoch !== current.epochRef.coordinatorEpoch ||
		admission.journalHeadDigest !== current.journalHeadDigest ||
		admission.trustedNow !== current.trustedNow
	)
		throw new Error("Skill execution admission is stale or foreign to the current host context.");
}

export async function validateAndConsumeSkillInvocation(
	snapshot: WorkflowSkillSnapshot,
	token: string | Readonly<Uint8Array>,
	store: WorkflowSkillInvocationStore,
	artifacts: WorkflowArtifactResolver,
	current: WorkflowSkillInvocationContext,
	options: WorkflowSkillInvocationValidationOptions = {},
): Promise<WorkflowSkillInvocationAdmission | undefined> {
	if (store.durability !== "durable" && !(store.durability === "test" && options.allowTestStore === true))
		throw new WorkflowSkillDurableStoreRequiredError();
	const durableStore = store.durability === "durable" ? (store as WorkflowSkillDurableInvocationStore) : undefined;
	if (durableStore !== undefined) {
		await assertActiveHostStateBinding(
			durableStore.activeHostState,
			snapshot.workflowId,
			snapshot.epochRef,
			current.journalHeadDigest,
			"skill invocation validation",
		);
		await assertActiveHostStateBinding(
			durableStore.activeHostState,
			snapshot.workflowId,
			current.epochRef,
			current.journalHeadDigest,
			"skill invocation current context",
		);
	}
	const tokenBytes = typeof token === "string" ? new TextEncoder().encode(token) : Uint8Array.from(token);
	const expectedTokenBytes = invocationTokenBytes(snapshot);
	if (!sameBytes(tokenBytes, expectedTokenBytes))
		throw new Error("Skill invocation token does not match the immutable snapshot.");
	const parsedToken = parseCanonicalJsonBytes(tokenBytes);
	if (digestObject(parsedToken) !== digestObject(invocationTokenValue(snapshot)))
		throw new Error("Skill invocation token is not a canonical snapshot binding.");
	const executableArtifacts = await revalidateSkillSnapshot(snapshot, artifacts, current);
	if (durableStore !== undefined)
		await assertActiveHostStateBinding(
			durableStore.activeHostState,
			snapshot.workflowId,
			snapshot.epochRef,
			current.journalHeadDigest,
			"skill invocation pre-CAS validation",
		);
	const consumeInput = {
		workflowId: snapshot.workflowId,
		taskId: current.taskId,
		decisionRef: cloneDecisionRef(current.decisionRef),
		attemptId: snapshot.attemptId,
		snapshotDigest: snapshot.snapshotDigest,
		invocationTokenId: snapshot.invocationTokenId,
		tokenHash: snapshot.invocationTokenHash,
		configDigest: snapshot.configDigest,
		dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
		consumeSequence: snapshot.consumeSequence,
		expectedEpoch: cloneEpochRef(snapshot.epochRef),
		journalHeadDigest: current.journalHeadDigest,
		trustedNow: current.trustedNow,
	};
	assertDecisionEpochBinding(consumeInput.decisionRef, consumeInput.expectedEpoch, "consumption");
	const consumed = await store.consume(consumeInput);
	if (store.durability === "durable") {
		if (typeof consumed !== "object" || consumed === null)
			throw new Error("Skill durable invocation store did not return a one-use consumption witness.");
		await assertInvocationConsumptionWitness(consumed, consumeInput, current);
		const manifest = snapshot.manifest;
		if (manifest === null) throw new Error("Skill invocation has no immutable gate manifest.");
		const admission: WorkflowSkillInvocationAdmissionUnsigned = {
			status: "admitted",
			workflowId: snapshot.workflowId,
			taskId: current.taskId,
			decisionRef: cloneDecisionRef(current.decisionRef),
			attemptId: snapshot.attemptId,
			configDigest: snapshot.configDigest,
			workspaceDigest: snapshot.workspaceDigest,
			dependencyManifestDigest: snapshot.authoritativeDependencyManifestDigest,
			workflowContractRevision: snapshot.workflowContractRevision,
			skillName: snapshot.skillName,
			skillKind: snapshot.skillKind,
			disableModelInvocation: snapshot.disableModelInvocation,
			snapshotDigest: snapshot.snapshotDigest,
			loaderProvenance: cloneLoaderProvenance(snapshot.loaderProvenance),
			loaderResultDigest: snapshot.loaderResultDigest,
			loaderReceiptConsumptionWitness: structuredClone(snapshot.loaderReceiptConsumptionWitness),
			hostVerificationReceipt: cloneReceipt(snapshot.hostVerificationReceipt),
			invocationTokenId: snapshot.invocationTokenId,
			invocationTokenHash: snapshot.invocationTokenHash,
			invocationTokenBytesDigest: snapshot.invocationTokenBytesDigest,
			consumeSequence: snapshot.consumeSequence,
			epochRef: cloneEpochRef(snapshot.epochRef),
			journalHeadDigest: current.journalHeadDigest,
			trustedNow: current.trustedNow,
			requiredApprovalGates: [...manifest.requiredApprovalGates],
			requiredArtifactKinds: [...manifest.requiredArtifactKinds],
			requiredPressureTests: [...manifest.requiredPressureTests],
			allowedTransitions: [...manifest.allowedTransitions],
			consumptionWitness: freezeDeep({ ...consumed, expectedEpoch: cloneEpochRef(consumed.expectedEpoch) }),
			artifacts: executableArtifacts,
		};
		return freezeDeep({
			...admission,
			admissionDigest: computeInvocationAdmissionDigest(admission),
		});
	}
	if (consumed !== true) throw new Error("Skill invocation token was already consumed or failed its durable CAS.");
}
