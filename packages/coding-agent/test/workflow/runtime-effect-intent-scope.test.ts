import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	digestObject,
	sha256Hex,
	type WorkflowArtifactPublishInput,
	type WorkflowArtifactRef,
	type WorkflowConcreteEffect,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowRuntimeEventPayload,
	type WorkflowRuntimeStore,
} from "../../src/core/workflow/contracts.js";
import {
	createWorkflowEffectBroker,
	type WorkflowConcreteEffectKind,
	type WorkflowEffectBrokerDependencies,
	type WorkflowEffectExecutionContext,
	type WorkflowEffectExecutors,
	type WorkflowEffectHookRegistry,
	type WorkflowEffectIntentRedGateway,
	type WorkflowEffectOwnershipToken,
} from "../../src/core/workflow/effect-broker.js";
import {
	createWorkflowIntentRedManifest,
	type WorkflowIntentRedManifestBindingInput,
	type WorkflowIntentRedMutationScope,
	type WorkflowIntentRedTestCaseDraft,
	workflowIntentRedManifestBindingDigest,
	workflowIntentRedMutationEffectDigest,
	workflowIntentRedMutationOperationDigest,
	workflowIntentRedMutationResourceDigest,
} from "../../src/core/workflow/intent-red-manifest.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

const WORKFLOW_ID = "workflow-intent-scope";
const TASK_ID = "task-intent-scope";
const ATTEMPT_ID = "attempt-intent-scope";
const RED_NOW = "2026-08-17T16:30:00.000Z";
const RED_STATE_DIGEST = "1".repeat(64);

function manifestArtifactRef(id: string): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes({ id, source: "runtime-effect-intent-scope" });
	return {
		artifactId: id,
		relativePath: `red/${id}`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function redTestCase(): WorkflowIntentRedTestCaseDraft {
	const commandArtifactRef = manifestArtifactRef("red-command");
	const sourceArtifactRef = manifestArtifactRef("red-source");
	const inputArtifactRef = manifestArtifactRef("red-input");
	const scanArtifactRef = manifestArtifactRef("red-scan");
	return {
		testId: "scope-test",
		attackId: "scope-substitution",
		commandArtifactRef,
		commandDigest: commandArtifactRef.digest,
		sourceArtifactRef,
		sourceDigest: sourceArtifactRef.digest,
		inputArtifactRefs: [inputArtifactRef],
		inputDigest: digestObject([inputArtifactRef]),
		publicBoundary: "public:workflow-submit",
		hostScanEvidenceRefs: [scanArtifactRef],
		evidenceClassification: "acceptance",
		assertions: [
			{
				assertionId: "user-outcome",
				target: "user_outcome",
				outcomeId: "user-visible-success",
				publicBoundary: "public:workflow-submit",
				description: "the user-visible outcome remains unproven",
			},
			{
				assertionId: "forbidden-outcome",
				target: "forbidden_outcome",
				outcomeId: "mock-success-accepted",
				publicBoundary: "public:workflow-submit",
				description: "a mocked success must not authorize promotion",
			},
		],
		expectedExitCode: 1,
		timeoutMilliseconds: 500,
		requiredEvidenceKinds: ["process"],
		owner: "host",
		hidden: true,
		requiresRealRuntime: true,
		mockOnly: false,
	};
}

function redManifest(currentHead: WorkflowJournalHead, allowedPath: string) {
	const test = redTestCase();
	const durabilityEvidence = ["integration", "restart", "process", "store"].map((kind) => {
		const artifactRef = manifestArtifactRef(`red-${kind}`);
		return {
			kind: kind as "integration" | "restart" | "process" | "store",
			artifactRef,
			provenanceDigest: digestObject({
				kind,
				artifactRef,
				observedAt: RED_NOW,
				freshUntil: "2026-08-17T17:30:00.000Z",
				source: `runtime-${kind}`,
			}),
			observedAt: RED_NOW,
			freshUntil: "2026-08-17T17:30:00.000Z",
			source: `runtime-${kind}`,
		} as const;
	});
	const binding: WorkflowIntentRedManifestBindingInput = {
		schemaId: "workflow-red-test-manifest-v1",
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		expectedHead: currentHead,
		expectedHeadDigest: digestObject(currentHead),
		epochRef: EPOCH,
		scopeDigest: "2".repeat(64),
		recipeDigest: "3".repeat(64),
		planRevision: 1,
		tests: [test],
		maxTests: 1,
		maxRuntimeMilliseconds: 500,
		evidenceRefs: [
			test.commandArtifactRef,
			test.sourceArtifactRef,
			...test.inputArtifactRefs,
			...test.hostScanEvidenceRefs,
			...durabilityEvidence.map((item) => item.artifactRef),
		],
		durabilityEvidence,
		executable: true,
		owner: "host",
	};
	const hostReceipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: "red-manifest-host-receipt",
		issuerId: "host",
		workflowId: WORKFLOW_ID,
		bindingDigest: workflowIntentRedManifestBindingDigest(binding),
		payloadDigest: digestObject(binding),
		artifactRef: manifestArtifactRef("red-manifest-receipt"),
		issuedAt: RED_NOW,
		validUntil: "2026-08-17T17:30:00.000Z",
		keyId: "fixture-receipt-key",
	});
	const manifest = createWorkflowIntentRedManifest({ ...binding, hostReceipt });
	const resourceDigest = workflowIntentRedMutationResourceDigest({
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
	});
	const operationDigest = workflowIntentRedMutationOperationDigest({
		manifestDigest: manifest.manifestDigest,
		recipeDigest: manifest.recipeDigest,
		planRevision: manifest.planRevision,
		resourceDigest,
	});
	const authorizedScope: WorkflowIntentRedMutationScope = {
		operationDigest,
		resourceDigest,
		effectDigest: workflowIntentRedMutationEffectDigest({
			resourceDigest,
			affectedProductionSurface: [allowedPath],
			writeSet: [allowedPath],
			closureRationale: "The RED authority is limited to the declared public workflow submission invariant.",
		}),
		affectedProductionSurface: [allowedPath],
		writeSet: [allowedPath],
		closureRationale: "The RED authority is limited to the declared public workflow submission invariant.",
	};
	return { manifest, authorizedScope };
}

function leaseRef(): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId: "lease-intent-scope",
		acquisitionEventSequence: 1,
		processIdentity: "process-intent-scope",
		rootDigest: "root-intent-scope",
		writerIdentity: "writer-intent-scope",
		acquiredAt: "2026-08-17T16:30:00.000Z",
		expiresAt: "2026-08-17T17:00:00.000Z",
	};
}

function context(): WorkflowEffectExecutionContext {
	const currentLease = leaseRef();
	const ownershipTokenBase: Omit<WorkflowEffectOwnershipToken, "tokenDigest"> = {
		tokenId: "token-intent-scope",
		workflowId: "workflow-intent-scope",
		taskId: "task-intent-scope",
		attemptId: "attempt-intent-scope",
		executionKey: "execution-intent-scope",
		epochRef: EPOCH,
		resourceLeaseRef: currentLease,
		ownershipLeaseRef: currentLease,
	};
	return {
		workflowId: "workflow-intent-scope",
		taskId: "task-intent-scope",
		attemptId: "attempt-intent-scope",
		executionKey: "execution-intent-scope",
		epochRef: EPOCH,
		revisionBoundary: {
			workflowId: "workflow-intent-scope",
			epochRef: EPOCH,
			leaseRef: currentLease,
			executionKey: "execution-intent-scope",
			revisionTuple: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			revisionRegistryRef: artifactRef("revision-registry"),
			revisionRegistryDigest: "revision-registry-digest",
			configSnapshotDigest: "config-snapshot-digest",
			tupleDigest: "revision-tuple-digest",
		},
		decisionRef: {
			decisionScope: {
				kind: "workflow",
				workflowId: "workflow-intent-scope",
				rootSessionId: "session-intent-scope",
			},
			decisionId: "decision-intent-scope",
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			decisionDigest: "decision-intent-scope-digest",
		},
		approvalResponse: null,
		idempotencyKey: "effect-intent-scope",
		leaseRef: currentLease,
		resourceLeaseRef: currentLease,
		ownershipLeaseRef: currentLease,
		ownershipToken: { ...ownershipTokenBase, tokenDigest: digestObject(ownershipTokenBase) },
	};
}

const preimages = new Map<string, Uint8Array>();

function artifactRef(value: unknown): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes(value);
	const digest = sha256Hex(bytes);
	preimages.set(digest, bytes);
	return {
		artifactId: digest,
		relativePath: `effects/${digest}`,
		digest,
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function hookRegistry(): WorkflowEffectHookRegistry {
	const hooks = new Map<WorkflowConcreteEffectKind, string>([
		["bash_exec", "hook:bash"],
		["file_read", "hook:file-read"],
		["file_write", "hook:file-write"],
		["ipython_exec", "hook:ipython"],
		["package_manager", "hook:package-manager"],
		["child_process_spawn", "hook:child-process"],
		["artifact_publish", "hook:artifact"],
		["session_mutation", "hook:session"],
	]);
	const capabilityDigest = "capabilities";
	const preimageResolverDigest = "preimages";
	const approvalVerifierDigest = "approvals";
	const evidenceWriterDigest = "evidence";
	return {
		hooks,
		capabilityDigest,
		preimageResolverDigest,
		approvalVerifierDigest,
		evidenceWriterDigest,
		registryDigest: digestObject({
			hooks: [...hooks.entries()].sort(([left], [right]) => left.localeCompare(right)),
			capabilityDigest,
			preimageResolverDigest,
			approvalVerifierDigest,
			evidenceWriterDigest,
		}),
	};
}

interface RecordingRuntimeStore extends WorkflowRuntimeStore {
	readonly payloads: WorkflowRuntimeEventPayload[];
}

function store(): RecordingRuntimeStore {
	const payloads: WorkflowRuntimeEventPayload[] = [];
	return {
		payloads,
		identity: {
			storeKind: "workflow",
			namespace: "intent-scope",
			rootDir: tmpdir(),
			storeId: "store-intent-scope",
			workflowId: "workflow-intent-scope",
			identityDigest: "store-intent-scope-digest",
		},
		async commit<TPayload extends WorkflowEventPayload>(input: { payload: TPayload }) {
			payloads.push(input.payload as WorkflowRuntimeEventPayload);
			return { status: "committed", payload: input.payload };
		},
		async replay() {
			return {
				workflowId: "workflow-intent-scope",
				executionKey: "execution-intent-scope",
				events: payloads.map((payload, index) => ({
					payload,
					idempotencyKey:
						payload.kind === "workflow_effect_intent" ||
						payload.kind === "workflow_effect_completed" ||
						payload.kind === "workflow_effect_ambiguous"
							? payload.idempotencyKey
							: `event-${index}`,
				})),
				head: {
					workflowId: "workflow-intent-scope",
					sequence: payloads.length,
					eventDigest: payloads.length === 0 ? null : digestObject(payloads.at(-1)),
					epochRef: EPOCH,
				},
				quarantined: false,
				quarantineReason: null,
			};
		},
		async publishArtifact(input: WorkflowArtifactPublishInput) {
			const digest = sha256Hex(input.bytes);
			return {
				status: "published",
				envelope: {
					ref: {
						artifactId: digest,
						relativePath: `evidence/${digest}`,
						digest,
						sizeBytes: input.bytes.byteLength,
						sourceEventSequence: input.sourceEventSequence,
					},
					payloadKind: input.payloadKind,
					codec: input.codec,
					immutable: true,
				},
			};
		},
	} as unknown as RecordingRuntimeStore;
}

function dependencies(
	root: string,
	executors: WorkflowEffectExecutors,
	intentRed?: WorkflowEffectIntentRedGateway,
	runtimeStore: RecordingRuntimeStore = store(),
): WorkflowEffectBrokerDependencies {
	const currentLease = leaseRef();
	return {
		store: runtimeStore,
		workflowId: "workflow-intent-scope",
		epochs: { assertCurrent: async (): Promise<void> => undefined },
		leases: {
			assertActive: async (): Promise<void> => undefined,
			assertOwnershipToken: async (): Promise<void> => undefined,
			quarantine: async (): Promise<void> => undefined,
		},
		groups: {
			hydrateFromReplay: async (): Promise<void> => undefined,
			spawn: async () => {
				throw new Error("not used");
			},
			verify: async () => true,
			inspect: async () => {
				throw new Error("not used");
			},
			terminate: async (): Promise<void> => undefined,
			reap: async () => ({ remainingPids: [], reapDigest: "reap", reapEventSequence: 1 }),
			scanUnknownDescendants: async () => [],
			quarantine: async (): Promise<void> => undefined,
		},
		workspaceRoot: root,
		executors,
		preimages: {
			resolve: async (ref) => {
				const bytes = preimages.get(ref.digest);
				if (bytes === undefined) throw new Error("preimage not found");
				return {
					artifactRef: ref,
					codec: "canonical_json" as const,
					immutable: true as const,
					bytes,
					verifiedDigest: ref.digest,
					verifiedSizeBytes: bytes.byteLength,
				};
			},
		},
		decisionVerifier: { verify: async (): Promise<"approved" | "rejected" | "not_required"> => "not_required" },
		approvalProof: { verifyAndConsume: async (): Promise<boolean> => true },
		evidenceSigner: {
			sign: async (): Promise<{ signature: string; signingKeyId: string }> => ({
				signature: "signature",
				signingKeyId: "key",
			}),
		},
		hookRegistry: hookRegistry(),
		writerIdentity: currentLease.writerIdentity,
		...(intentRed === undefined ? {} : { intentRed }),
	};
}

function intentRedGateway(): WorkflowEffectIntentRedGateway {
	const initialHead: WorkflowJournalHead = {
		workflowId: WORKFLOW_ID,
		sequence: 0,
		eventDigest: null,
		epochRef: EPOCH,
	};
	const inspection = redManifest(initialHead, "allowed.ts");
	return {
		resolveScope: async ({ classified }) => {
			const resourceDigest = workflowIntentRedMutationResourceDigest({
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
			});
			const operationDigest = workflowIntentRedMutationOperationDigest({
				manifestDigest: inspection.manifest.manifestDigest,
				recipeDigest: inspection.manifest.recipeDigest,
				planRevision: inspection.manifest.planRevision,
				resourceDigest,
			});
			const target = classified.normalizedWriteSet[0]!.split("/").at(-1)!;
			return {
				operationDigest,
				resourceDigest,
				affectedProductionSurface: [target],
				writeSet: [target],
				closureRationale: "The attempted replacement claims a single production module.",
			};
		},
		inspect: async () => inspection,
		authorize: async () => {
			throw new Error("scope mismatch must be denied before one-use authorization");
		},
	};
}

describe("workflow effect broker intent scope", () => {
	it("blocks a broad replacement before the real workspace write", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-intent-scope-"));
		try {
			const target = join(root, "intent-red-manifest.ts");
			const baseline = "export const baseline = true;\n";
			const replacement = "export const replacement = true;\n".repeat(2_300);
			await writeFile(target, baseline, "utf8");
			const effect: WorkflowConcreteEffect = {
				kind: "file_write",
				operationId: "broad-replacement",
				path: target,
				contentPreimageRef: artifactRef(replacement),
				writeClass: "workspace_write",
			};
			const writes: string[] = [];
			const runtimeStore = store();
			const broker = createWorkflowEffectBroker(
				dependencies(
					root,
					{
						bash: { exec: async () => ({}) },
						edit: {
							readFile: async ({ path }) => readFile(path),
							writeFile: async ({ path, content }) => {
								writes.push(path);
								await writeFile(path, content, "utf8");
							},
						},
						ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
						packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
						session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
						childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
					},
					intentRedGateway(),
					runtimeStore,
				),
			);

			const requestContext = {
				...context(),
				intentRedAuthorization: Object.freeze({
					manifestDigest: "red-manifest-digest",
					allowedSemanticBehaviorSurface: ["public:workflow-submit"],
					normalizedWriteClosure: [target],
					operationDigest: "red-operation-digest",
					baseProductionHeadDigest: "base-production-head-digest",
				}),
				intentRedCurrent: {
					stateDigest: RED_STATE_DIGEST,
					revision: 1,
					trustedNow: RED_NOW,
				},
			} as unknown as WorkflowEffectExecutionContext;

			await expect(broker.execute(effect, requestContext)).rejects.toThrow("intent_scope_exceeded");
			expect(writes).toEqual([]);
			expect(await readFile(target, "utf8")).toBe(baseline);
			expect(runtimeStore.payloads.map((payload) => (payload as unknown as { kind: string }).kind)).toContain(
				"intent_scope_exceeded",
			);
			const restartedBroker = createWorkflowEffectBroker(
				dependencies(
					root,
					{
						bash: { exec: async () => ({}) },
						edit: {
							readFile: async ({ path }) => readFile(path),
							writeFile: async ({ path, content }) => {
								writes.push(path);
								await writeFile(path, content, "utf8");
							},
						},
						ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
						packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
						session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
						childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
					},
					intentRedGateway(),
					runtimeStore,
				),
			);
			await expect(restartedBroker.execute(effect, requestContext)).rejects.toThrow("intent_scope_exceeded");
			expect(writes).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
