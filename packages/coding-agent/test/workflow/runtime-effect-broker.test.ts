import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	canonicalJsonBytes,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowConcreteEffect,
	type WorkflowEpochRef,
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
	type WorkflowEffectOwnershipToken,
} from "../../src/core/workflow/effect-broker.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const PREIMAGES = new Map<string, Uint8Array>();

function leaseRef(): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId: "lease-effect-test",
		acquisitionEventSequence: 1,
		processIdentity: "process-effect-test",
		rootDigest: "root-effect-test",
		writerIdentity: "writer-effect-test",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:10:00.000Z",
	};
}

function artifactRef(value: unknown): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes(value);
	const digest = sha256Hex(bytes);
	PREIMAGES.set(digest, bytes);
	return {
		artifactId: digest,
		relativePath: `effects/${digest}`,
		digest,
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function context(): WorkflowEffectExecutionContext {
	const currentLease = leaseRef();
	const ownershipTokenBase: Omit<WorkflowEffectOwnershipToken, "tokenDigest"> = {
		tokenId: "token-effect-test",
		workflowId: "workflow-effect-test",
		taskId: "task-effect-test",
		attemptId: "attempt-effect-test",
		executionKey: "execution-effect-test",
		epochRef: EPOCH,
		resourceLeaseRef: currentLease,
		ownershipLeaseRef: currentLease,
	};
	return {
		workflowId: "workflow-effect-test",
		taskId: "task-effect-test",
		attemptId: "attempt-effect-test",
		executionKey: "execution-effect-test",
		epochRef: EPOCH,
		revisionBoundary: {
			workflowId: "workflow-effect-test",
			epochRef: EPOCH,
			leaseRef: currentLease,
			executionKey: "execution-effect-test",
			revisionTuple: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			revisionRegistryRef: artifactRef("registry"),
			revisionRegistryDigest: "registry-digest",
			configSnapshotDigest: "config-digest",
			tupleDigest: "tuple-digest",
		},
		decisionRef: {
			decisionScope: { kind: "workflow", workflowId: "workflow-effect-test", rootSessionId: "session-effect-test" },
			decisionId: "decision-effect-test",
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			decisionDigest: "decision-digest",
		},
		approvalResponse: null,
		idempotencyKey: "effect-request-effect-test",
		leaseRef: currentLease,
		resourceLeaseRef: currentLease,
		ownershipLeaseRef: currentLease,
		ownershipToken: { ...ownershipTokenBase, tokenDigest: digestObject(ownershipTokenBase) },
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

interface RecordingStore {
	readonly store: WorkflowRuntimeStore;
	readonly payloads: WorkflowRuntimeEventPayload[];
}

function recordingStore(): RecordingStore {
	const payloads: WorkflowRuntimeEventPayload[] = [];
	const store = {
		identity: {
			storeKind: "workflow" as const,
			namespace: "test",
			rootDir: "/tmp/workflow-effect-test",
			storeId: "store-effect-test",
			workflowId: "workflow-effect-test",
			identityDigest: "store-effect-test-digest",
		},
		async commit(input: { payload: WorkflowRuntimeEventPayload }): Promise<unknown> {
			payloads.push(input.payload);
			return { status: "committed" };
		},
		async replay(): Promise<unknown> {
			return {
				workflowId: "workflow-effect-test",
				executionKey: "execution-effect-test",
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
					workflowId: "workflow-effect-test",
					sequence: payloads.length,
					eventDigest: payloads.length === 0 ? null : digestObject(payloads.at(-1)),
					epochRef: EPOCH,
				},
				quarantined: false,
				quarantineReason: null,
			};
		},
		async publishArtifact(input: {
			workflowId: string;
			payloadKind: "recovery_finding";
			bytes: Uint8Array;
			codec: "canonical_json";
			sourceEventSequence: number;
			idempotencyKey: string;
		}): Promise<unknown> {
			const digest = sha256Hex(input.bytes);
			return {
				status: "published",
				envelope: {
					ref: {
						artifactId: digest,
						relativePath: `recovery/${digest}`,
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
	} as unknown as WorkflowRuntimeStore;
	return { store, payloads };
}

function dependencies(
	store: WorkflowRuntimeStore,
	executors: WorkflowEffectExecutors,
	workspaceRoot = process.cwd(),
): WorkflowEffectBrokerDependencies {
	const currentLease = leaseRef();
	return {
		store,
		workflowId: "workflow-effect-test",
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
		workspaceRoot,
		executors,
		preimages: {
			resolve: async (ref: WorkflowArtifactRef) => {
				const bytes = PREIMAGES.get(ref.digest);
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
		decisionVerifier: { verify: async (): Promise<"approved" | "rejected" | "not_required"> => "approved" },
		approvalProof: { verifyAndConsume: async (): Promise<boolean> => true },
		evidenceSigner: {
			sign: async (): Promise<{ signature: string; signingKeyId: string }> => ({
				signature: "sig",
				signingKeyId: "key",
			}),
		},
		hookRegistry: hookRegistry(),
		writerIdentity: currentLease.writerIdentity,
	};
}

describe("workflow effect broker", () => {
	it("classifies a concrete file write from the operation policy", () => {
		const { store } = recordingStore();
		const broker = createWorkflowEffectBroker(
			dependencies(store, {
				bash: { exec: async () => ({}) },
				edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
				ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
				packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
				session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
				childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
			}),
		);
		const effect: WorkflowConcreteEffect = {
			kind: "file_write",
			operationId: "write-effect",
			path: `${process.cwd()}/output.txt`,
			contentPreimageRef: artifactRef("content"),
			writeClass: "workspace_write",
		};

		const classified = broker.classify(effect, context());

		expect(classified.host).toBe("edit");
		expect(classified.materiality).toBe("durable");
		expect(classified.authority).toBe("workspace_write");
		expect(classified.normalizedWriteSet).toEqual([`${process.cwd()}/output.txt`]);
	});

	it("commits intent before execution and replays a committed result", async () => {
		const fixture = recordingStore();
		let calls = 0;
		const broker = createWorkflowEffectBroker(
			dependencies(fixture.store, {
				bash: {
					exec: async () => {
						calls += 1;
						return { exitCode: 0 };
					},
				},
				edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
				ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
				packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
				session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
				childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
			}),
		);
		const effect: WorkflowConcreteEffect = {
			kind: "bash_exec",
			operationId: "bash-effect",
			commandPreimageRef: artifactRef("printf hello"),
			cwd: process.cwd(),
			timeoutMs: 1_000,
			writeClass: "read_only",
		};

		const first = await broker.execute(effect, context());
		const second = await broker.execute(effect, context());

		expect(first.status).toBe("completed");
		expect(second.status).toBe("already_completed");
		expect(calls).toBe(1);
		expect(fixture.payloads.map((payload) => payload.kind)).toEqual([
			"workflow_effect_intent",
			"workflow_effect_completed",
		]);
	});

	it("quarantines an executor failure without replaying the effect", async () => {
		const fixture = recordingStore();
		let calls = 0;
		const broker = createWorkflowEffectBroker(
			dependencies(fixture.store, {
				bash: {
					exec: async () => {
						calls += 1;
						throw new Error("host_outcome_unknown");
					},
				},
				edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
				ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
				packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
				session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
				childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
			}),
		);
		const effect: WorkflowConcreteEffect = {
			kind: "bash_exec",
			operationId: "ambiguous-bash-effect",
			commandPreimageRef: artifactRef("held command"),
			cwd: process.cwd(),
			timeoutMs: 1_000,
			writeClass: "read_only",
		};

		const first = await broker.execute(effect, context());
		const second = await broker.execute(effect, context());

		expect(first.status).toBe("ambiguous");
		expect(second.status).toBe("ambiguous");
		expect(calls).toBe(1);
		expect(fixture.payloads.map((payload) => payload.kind)).toContain("workflow_effect_ambiguous");
	});

	it("rejects before intent when the resource lease is inactive", async () => {
		const fixture = recordingStore();
		const deps = dependencies(fixture.store, {
			bash: { exec: async () => ({ exitCode: 0 }) },
			edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
			ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
			packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
			session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
			childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
		});
		deps.leases.assertActive = async (): Promise<void> => {
			throw new Error("resource_lease_inactive");
		};
		const broker = createWorkflowEffectBroker(deps);
		const effect: WorkflowConcreteEffect = {
			kind: "bash_exec",
			operationId: "inactive-lease-effect",
			commandPreimageRef: artifactRef("held command"),
			cwd: process.cwd(),
			timeoutMs: 1_000,
			writeClass: "read_only",
		};

		await expect(broker.execute(effect, context())).rejects.toThrow("resource_lease_inactive");
		expect(fixture.payloads).toEqual([]);
	});

	it("requires the exact canonical path digest and rejects symlink escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "workflow-effect-path-"));
		const outside = mkdtempSync(join(tmpdir(), "workflow-effect-outside-"));
		try {
			const inside = join(root, "input.txt");
			const outsideFile = join(outside, "secret.txt");
			writeFileSync(inside, "inside");
			writeFileSync(outsideFile, "secret");
			symlinkSync(outsideFile, join(root, "escape.txt"));
			const fixture = recordingStore();
			const broker = createWorkflowEffectBroker(
				dependencies(
					fixture.store,
					{
						bash: { exec: async () => ({}) },
						edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
						ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
						packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
						session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
						childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
					},
					root,
				),
			);
			const good: WorkflowConcreteEffect = {
				kind: "file_read",
				operationId: "path-good",
				path: inside,
				pathDigest: digestObject(realpathSync.native(inside)),
			};
			expect(broker.classify(good, context()).normalizedReadSet).toEqual([realpathSync.native(inside)]);
			expect(() => broker.classify({ ...good, pathDigest: "wrong" }, context())).toThrow(
				"workflow_effect_path_digest_mismatch",
			);
			expect(() =>
				broker.classify(
					{ ...good, path: join(root, "escape.txt"), pathDigest: digestObject(outsideFile) },
					context(),
				),
			).toThrow("workflow_effect_path_outside_workspace");
		} finally {
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("serializes same-key executions before invoking the host", async () => {
		const fixture = recordingStore();
		let calls = 0;
		let release!: () => void;
		let started!: () => void;
		const startedPromise = new Promise<void>((resolveStarted) => {
			started = resolveStarted;
		});
		const releasePromise = new Promise<void>((resolveRelease) => {
			release = resolveRelease;
		});
		const broker = createWorkflowEffectBroker(
			dependencies(fixture.store, {
				bash: {
					exec: async () => {
						calls += 1;
						started();
						await releasePromise;
						return { exitCode: 0 };
					},
				},
				edit: { readFile: async () => new Uint8Array(), writeFile: async () => undefined },
				ipython: { execute: async () => ({ resultDigest: "ipython", evidenceArtifact: null }) },
				packageManager: { execute: async () => ({ resultDigest: "package", evidenceArtifact: null }) },
				session: { mutate: async () => ({ resultDigest: "session", evidenceArtifact: null }) },
				childProcess: { spawn: async () => ({ binding: undefined as never, resultDigest: "child" }) },
			}),
		);
		const effect: WorkflowConcreteEffect = {
			kind: "bash_exec",
			operationId: "serialized-effect",
			commandPreimageRef: artifactRef("serialized command"),
			cwd: process.cwd(),
			timeoutMs: 1_000,
			writeClass: "read_only",
		};
		const first = broker.execute(effect, context());
		await startedPromise;
		const second = broker.execute(effect, context());
		release();
		await expect(first).resolves.toMatchObject({ status: "completed" });
		await expect(second).resolves.toMatchObject({ status: "already_completed" });
		expect(calls).toBe(1);
	});
});
