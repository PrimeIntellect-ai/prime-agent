import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
	DurableDecisionRef,
	WorkflowActiveLeaseContext,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowChildAuthority,
	WorkflowEpochRef,
	WorkflowJournalHead,
	WorkflowOwnershipLease,
	WorkflowResourceLease,
	WorkflowRevisionBoundaryContext,
	WorkflowTask,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "../../src/core/workflow/contracts.js";
import {
	assertCanonicalDispatchInput,
	assertWorkflowRecoveryBinding,
	createWorkflowDispatcher,
	createWorkflowDispatchReadinessProvider,
	deriveWorkflowExecutionKey,
	leaseRefOf,
	resolveCanonicalDispatchArtifact,
	type WorkflowApprovedDispatchConfiguration,
	type WorkflowCanonicalDispatchInput,
	type WorkflowDispatcher,
	type WorkflowDispatchReadiness,
	type WorkflowReadinessInput,
	type WorkflowWorkerLaunchObservation,
} from "../../src/core/workflow/dispatch.js";
import type { WorkflowTaskGraph } from "../../src/core/workflow/task-graph.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 7 };
const WORKFLOW_ID = "workflow-dispatch-test";
const TASK_ID = "task-dispatch-test";
const ATTEMPT_ID = "attempt-dispatch-test";

function artifactRef(label: string): WorkflowArtifactRef {
	return {
		artifactId: label,
		relativePath: `artifacts/${label}`,
		digest: `${label}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function task(taskId = TASK_ID): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: "dispatch a task",
		requirementIds: ["requirement-1"],
		completionCriteria: ["complete"],
		dependencyTaskIds: [],
		ownedPaths: ["workspace"],
		ownedContracts: ["contract-1"],
		requiredSkillSnapshotDigests: ["skill-1"],
		verificationCommandDigests: ["command-1"],
		authority: ["observe_workflow"],
		declaredResourceVector: {
			cpuMilliCores: 1,
			memoryBytes: 1,
			diskBytes: 1,
			ioWeight: 1,
			accelerators: [],
			providers: [],
			networkEgressBytes: 0,
			wallMilliseconds: 1,
			monetaryMicrounits: 0,
		},
		declaredControlCapacity: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 1,
			redTeamSlots: 1,
			recoverySlots: 1,
		},
		status: "ready",
		attemptIds: [],
	};
}

function graph(currentTask = task()): WorkflowTaskGraph {
	return {
		graphRevision: 1,
		tasks: [currentTask],
		byId: new Map([[currentTask.taskId, currentTask]]),
		allowedAuthority: ["observe_workflow"],
		ownershipPaths: ["workspace"],
		generatedOutputPaths: [],
		lockPaths: [],
		namedContracts: ["contract-1"],
		graphDigest: "graph-digest",
	};
}

function resourceLease(overrides: Partial<WorkflowResourceLease> = {}): WorkflowResourceLease {
	const lease = {
		leaseId: "resource-lease",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		holderIdentity: "worker-1",
		resourceAdmission: {
			capacityGrant: {
				kind: "worker",
				grantId: "grant-1",
				resourceVector: {
					cpuMilliCores: 1,
					memoryBytes: 1,
					diskBytes: 1,
					ioWeight: 1,
					accelerators: [],
					providers: [],
					networkEgressBytes: 0,
					wallMilliseconds: 1,
					monetaryMicrounits: 0,
				},
				controlCapacity: {
					processSlots: 0,
					childSessionSlots: 0,
					modelCallSlots: 0,
					modelInputTokens: 0,
					modelOutputTokens: 0,
					verificationSlots: 0,
					redTeamSlots: 0,
					recoverySlots: 0,
				},
				canonicalPoolLedgerRef: artifactRef("ledger"),
				grantDigest: "grant-digest",
			},
			canonicalPoolLedgerRef: artifactRef("ledger"),
			controlCapacity: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			controlCapacityProjectionDigest: "control-digest",
			declaredVector: {
				cpuMilliCores: 1,
				memoryBytes: 1,
				diskBytes: 1,
				ioWeight: 1,
				accelerators: [],
				providers: [],
				networkEgressBytes: 0,
				wallMilliseconds: 1,
				monetaryMicrounits: 0,
			},
			hostDerivedConservativeVector: {
				cpuMilliCores: 1,
				memoryBytes: 1,
				diskBytes: 1,
				ioWeight: 1,
				accelerators: [],
				providers: [],
				networkEgressBytes: 0,
				wallMilliseconds: 1,
				monetaryMicrounits: 0,
			},
			reservedVector: {
				cpuMilliCores: 1,
				memoryBytes: 1,
				diskBytes: 1,
				ioWeight: 1,
				accelerators: [],
				providers: [],
				networkEgressBytes: 0,
				wallMilliseconds: 1,
				monetaryMicrounits: 0,
			},
			declaredControlCapacity: {
				processSlots: 1,
				childSessionSlots: 1,
				modelCallSlots: 1,
				modelInputTokens: 1,
				modelOutputTokens: 1,
				verificationSlots: 1,
				redTeamSlots: 1,
				recoverySlots: 1,
			},
			hostDerivedControlCapacity: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			reservedControlCapacity: {
				processSlots: 1,
				childSessionSlots: 1,
				modelCallSlots: 1,
				modelInputTokens: 1,
				modelOutputTokens: 1,
				verificationSlots: 1,
				redTeamSlots: 1,
				recoverySlots: 1,
			},
			derivationPolicyDigest: "policy-digest",
			enforcementClass: "isolated_metered",
			unknownPoolIds: [],
			canonicalLedgerRef: artifactRef("ledger"),
			canonicalLedgerDigest: "ledger-digest",
			admitted: true,
			admissionDigest: "admission-digest",
		},
		controlCapacity: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 1,
			redTeamSlots: 1,
			recoverySlots: 1,
		},
		workerCapacity: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 1,
			redTeamSlots: 1,
			recoverySlots: 1,
		},
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		acquisitionEventSequence: 11,
		idempotencyKey: "lease-idempotency",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:10:00.000Z",
		releaseEventSequence: null,
	} as WorkflowResourceLease;
	return { ...lease, ...overrides };
}

function ownershipLease(overrides: Partial<WorkflowOwnershipLease> = {}): WorkflowOwnershipLease {
	return {
		leaseId: "ownership-lease",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		ownedPaths: ["workspace"],
		ownedContracts: ["contract-1"],
		status: "active",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		acquisitionEventSequence: 12,
		releaseEventSequence: null,
		...overrides,
	};
}

function authority(overrides: Partial<WorkflowChildAuthority> = {}): WorkflowChildAuthority {
	return {
		capabilities: ["read_only"],
		writeClass: "read_only",
		parentAttemptId: null,
		rootSpawned: true,
		...overrides,
	};
}

function canonicalInput(overrides: Partial<WorkflowCanonicalDispatchInput> = {}): WorkflowCanonicalDispatchInput {
	const decisionRef: DurableDecisionRef & { coordinatorEpoch: number } = {
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "root-session" },
		decisionId: "decision-1",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: "decision-digest",
	};
	const revisionRegistryRef = artifactRef("revision-registry");
	const promptArtifactRef = artifactRef("prompt");
	const lease = resourceLease();
	const bundle = {
		ledger: { workflowId: WORKFLOW_ID, epoch: EPOCH, digest: "ledger-digest", artifactRef: artifactRef("ledger") },
		grantLedger: { digest: "grant-ledger-digest" },
		grant: { grantId: "grant-1", grantDigest: "grant-digest" },
		window: { windowId: "window-1" },
		admission: { admissionId: "admission-1" },
		budget: { budgetDigest: "budget-digest" },
		schedule: { scheduleId: "schedule-1" },
		envelope: {
			envelopeDigest: "envelope-digest",
			approvalDecisionRef: decisionRef,
			canonicalLedgerRef: artifactRef("ledger"),
			canonicalLedgerDigest: "ledger-digest",
			controlCapacity: {
				processSlots: 1,
				childSessionSlots: 1,
				modelCallSlots: 1,
				modelInputTokens: 1,
				modelOutputTokens: 1,
				verificationSlots: 1,
				redTeamSlots: 1,
				recoverySlots: 1,
			},
			controlPlaneReserveCapacity: {
				processSlots: 1,
				childSessionSlots: 1,
				modelCallSlots: 1,
				modelInputTokens: 1,
				modelOutputTokens: 1,
				verificationSlots: 1,
				redTeamSlots: 1,
				recoverySlots: 1,
			},
		},
		resourceLease: lease,
		snapshot: { resolvedConfigDigest: "config-digest", configRevision: 1 },
		refs: { revisionRegistryRef, promptArtifactRef },
	};
	const controlReserveProof = {
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		envelopeDigest: "envelope-digest",
		canonicalLedgerRef: artifactRef("ledger"),
		canonicalLedgerDigest: "ledger-digest",
		controlCapacity: bundle.envelope.controlCapacity,
		controlPlaneReserveCapacity: bundle.envelope.controlPlaneReserveCapacity,
		proofDigest: "",
	};
	controlReserveProof.proofDigest = digestObject({
		workflowId: controlReserveProof.workflowId,
		epochRef: controlReserveProof.epochRef,
		envelopeDigest: controlReserveProof.envelopeDigest,
		canonicalLedgerRef: controlReserveProof.canonicalLedgerRef,
		canonicalLedgerDigest: controlReserveProof.canonicalLedgerDigest,
		controlCapacity: controlReserveProof.controlCapacity,
		controlPlaneReserveCapacity: controlReserveProof.controlPlaneReserveCapacity,
	});
	(bundle as unknown as { controlReserveProof: typeof controlReserveProof }).controlReserveProof = controlReserveProof;
	const base = {
		workflowId: WORKFLOW_ID,
		rootSessionId: "root-session",
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		executionKey: "",
		decisionRef,
		epochRef: EPOCH,
		rootLeaseRef: {
			...EPOCH,
			leaseId: "root-lease",
			acquisitionEventSequence: 10,
			processIdentity: "process-1",
			rootDigest: "root-digest",
			writerIdentity: "writer-1",
			acquiredAt: "2030-01-01T00:00:00.000Z",
			expiresAt: "2030-01-01T00:10:00.000Z",
		},
		resourceLease: lease,
		ownershipLease: null,
		childAuthority: authority(),
		launchConfigDigest: "launch-config-digest",
		configSnapshotDigest: "config-digest",
		canonicalAdmissionBundleRef: artifactRef("admission-bundle"),
		canonicalAdmissionBundleDigest: "",
		canonicalAdmissionBundle: bundle as unknown as WorkflowCanonicalDispatchInput["canonicalAdmissionBundle"],
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef,
		revisionRegistryDigest: "revision-registry-digest",
		writerIdentity: "writer-1",
		expectedEffectDigest: "effect-digest",
		promptArtifactRef,
		prompt: "dispatch prompt",
		sessionName: "workflow-child",
		sessionDir: "/tmp/workflow-dispatch-test/workflows/workflow-dispatch-test",
		cwd: "/tmp/workflow-dispatch-test",
		modelProvider: "provider",
		modelId: "model",
		reasoningLevel: "medium",
		serviceTier: "default",
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-capability-1",
		agentRole: "worker",
		processGroupRequest: {
			executable: process.execPath,
			arguments: [],
			cwd: "/tmp/workflow-dispatch-test",
			detached: true,
			requireProcessStartId: true,
		},
	};
	return {
		...base,
		executionKey: deriveWorkflowExecutionKey(base),
		canonicalAdmissionBundleDigest: digestObject(bundle),
		...overrides,
	};
}

function readiness(input: WorkflowCanonicalDispatchInput): WorkflowDispatchReadiness {
	return {
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		rootLeaseRef: input.rootLeaseRef,
		leaseRef: {
			...input.epochRef,
			leaseId: input.resourceLease.leaseId,
			acquisitionEventSequence: input.resourceLease.acquisitionEventSequence,
			processIdentity: input.resourceLease.holderIdentity,
			rootDigest: "root-digest",
			writerIdentity: input.writerIdentity,
			acquiredAt: "2030-01-01T00:00:00.000Z",
			expiresAt: input.resourceLease.expiresAt,
		},
		executionKey: input.executionKey,
		revisionTuple: input.revisionTuple,
		revisionRegistryRef: input.revisionRegistryRef,
		revisionRegistryDigest: input.revisionRegistryDigest,
		readinessDigest: "readiness-digest",
		canDispatch: false,
		childSpawnPath: "same_process_rlm",
		processStartIdentity: "missing",
		processGroup: "unavailable",
		artifactRoot: "/tmp/workflow-dispatch-test",
		canonicalArtifactRoot: "/tmp/workflow-dispatch-test",
		artifactRootRelativePath: "workflows/workflow-dispatch-test",
		artifactRootPathDigest: "artifact-root-digest",
		activeGenerationDigest: "generation-digest",
		configSnapshotDigest: input.configSnapshotDigest,
		currentHeadDigest: "",
		currentHead: null,
		checks: {
			artifactRootVerified: false,
			rootLeaseVerified: false,
			currentEpochVerified: true,
			approvedConfigVerified: false,
			canonicalAdmissionBundleVerified: false,
			approvedEnvelopeVerified: false,
			kernelAdapterAvailable: false,
			authorityClosureVerified: false,
			workerCapabilityVerified: false,
		},
		blockingReasons: ["same_process_child_session", "process_start_identity_unavailable"],
		observedAt: "2030-01-01T00:00:00.000Z",
	};
}

function createDispatcher(
	input: WorkflowCanonicalDispatchInput,
	result: WorkflowDispatchReadiness = readiness(input),
	launchWorker?: (dispatchInput: WorkflowCanonicalDispatchInput) => Promise<WorkflowWorkerLaunchObservation>,
): {
	dispatcher: WorkflowDispatcher;
	providerCalls: { count: number };
} {
	const providerCalls = { count: 0 };
	const provider = {
		observe: async (): Promise<WorkflowDispatchReadiness> => {
			providerCalls.count += 1;
			return result;
		},
	};
	const dispatcher = createWorkflowDispatcher({
		taskGraph: graph(),
		epochs: { assertCurrent: async (): Promise<void> => undefined },
		readRevisionBoundaryContext: async (
			workflowId: string,
			epochRef: WorkflowEpochRef,
			executionKey: string | null,
		): Promise<WorkflowRevisionBoundaryContext> => ({
			workflowId,
			epochRef,
			leaseRef: input.rootLeaseRef,
			executionKey,
			revisionTuple: input.revisionTuple,
			revisionRegistryRef: input.revisionRegistryRef,
			revisionRegistryDigest: input.revisionRegistryDigest,
			configSnapshotDigest: input.configSnapshotDigest,
			tupleDigest: digestObject({
				workflowId,
				epochRef,
				leaseRef: input.rootLeaseRef,
				executionKey,
				revisionTuple: input.revisionTuple,
				revisionRegistryRef: input.revisionRegistryRef,
				revisionRegistryDigest: input.revisionRegistryDigest,
				configSnapshotDigest: input.configSnapshotDigest,
			}),
		}),
		revisionRegistry: { assertActive: async (): Promise<void> => undefined },
		readinessProvider: provider,
		...(launchWorker === undefined ? {} : { launchWorker }),
	});
	return { dispatcher, providerCalls };
}

function readinessInput(input: WorkflowCanonicalDispatchInput): WorkflowReadinessInput {
	return {
		canonicalInput: input,
		rootLeaseRef: input.rootLeaseRef,
		leaseRef: leaseRefOf(input.resourceLease),
		executionKey: input.executionKey,
		revisionTuple: input.revisionTuple,
		revisionRegistryRef: input.revisionRegistryRef,
		revisionRegistryDigest: input.revisionRegistryDigest,
		configSnapshotDigest: input.configSnapshotDigest,
		effectReadiness: { canExecute: true, blockingReasons: [] },
		authority: input.childAuthority,
		task: task(),
		graph: graph(),
	};
}

describe("workflow runtime dispatch boundary", () => {
	it("forwards a complete canonical input to readiness without starting a child", async () => {
		const input = canonicalInput();
		const { dispatcher, providerCalls } = createDispatcher(input);
		const observed = await dispatcher.observe(input);

		expect(observed.canDispatch).toBe(false);
		expect(observed.blockingReasons).toContain("same_process_child_session");
		expect(providerCalls.count).toBe(1);
	});

	it("rejects a caller-chosen execution key before readiness", async () => {
		const input = canonicalInput({ executionKey: "caller-chosen-key" });
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_noncanonical_execution_key",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("rejects mixed epochs across the canonical input before readiness", async () => {
		const input = canonicalInput({
			resourceLease: resourceLease({ coordinatorEpoch: EPOCH.coordinatorEpoch + 1 }),
		});
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_epoch_mismatch",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("rejects a resource lease whose trusted acquisition interval is not real", async () => {
		const input = canonicalInput({
			resourceLease: resourceLease({
				acquiredAt: "2030-01-01T00:10:00.000Z",
				expiresAt: "2030-01-01T00:10:00.000Z",
			}),
		});

		expect(() => assertCanonicalDispatchInput(input, graph())).toThrow("workflow_resource_lease_invalid");
	});

	it("rejects an unknown task instead of falling back to a plain DAG", async () => {
		const input = canonicalInput({ taskId: "missing-task" });
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_task_missing_from_graph",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("rejects recursive authority from a non-root child", async () => {
		const input = canonicalInput({
			childAuthority: authority({
				capabilities: ["read_only", "recursive_spawn"],
				parentAttemptId: "parent-attempt",
				rootSpawned: false,
			}),
		});
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_child_authority_invalid",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("requires process-start identity and non-empty canonical fields", async () => {
		const input = canonicalInput({
			launchConfigDigest: "",
			processGroupRequest: {
				executable: process.execPath,
				arguments: [],
				cwd: "/tmp/workflow-dispatch-test",
				detached: true,
				requireProcessStartId: false,
			},
		});
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_dispatch_input_invalid",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("keeps the default readiness provider fail-closed when mandatory sources are absent", async () => {
		const input = canonicalInput();
		const provider = createWorkflowDispatchReadinessProvider({});
		const observed = await provider.observe(readinessInput(input));

		expect(observed.canDispatch).toBe(false);
		expect(observed.blockingReasons).toEqual(
			expect.arrayContaining([
				"artifact_root_unavailable",
				"kernel_contract_unavailable",
				"process_start_identity_unavailable",
			]),
		);
	});

	it("does not classify an unavailable worker as same-process", async () => {
		const input = canonicalInput();
		const provider = createWorkflowDispatchReadinessProvider({
			workerReadiness: {
				observe: async () => ({ status: "unavailable", artifact: null, capabilityAttestation: null }),
			},
		});
		const observed = await provider.observe(readinessInput(input));

		expect(observed.childSpawnPath).toBe("unavailable");
		expect(observed.blockingReasons).not.toContain("same_process_child_session");
	});

	it("rejects a self-consistent caller bundle without a separate control reserve proof", async () => {
		const input = canonicalInput();
		const bundle = { ...input.canonicalAdmissionBundle } as Record<string, unknown>;
		delete bundle.controlReserveProof;
		const forged = {
			...input,
			canonicalAdmissionBundle: bundle,
			canonicalAdmissionBundleDigest: digestObject(bundle),
		} as unknown as WorkflowCanonicalDispatchInput;
		const { dispatcher, providerCalls } = createDispatcher(forged);

		await expect(dispatcher.observe(forged)).rejects.toMatchObject({
			code: "workflow_control_reserve_proof_invalid",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("requires ownership paths to match the task and an exact ownership lease binding", async () => {
		const input = canonicalInput({
			ownershipLease: ownershipLease({ ownedPaths: ["workspace/other"] }),
		});
		const { dispatcher, providerCalls } = createDispatcher(input);

		await expect(dispatcher.observe(input)).rejects.toMatchObject({
			code: "workflow_ownership_binding_invalid",
		});
		expect(providerCalls.count).toBe(0);
	});

	it("returns readiness bound to a current journal head", async () => {
		const input = canonicalInput();
		const head: WorkflowJournalHead = {
			workflowId: WORKFLOW_ID,
			sequence: 4,
			eventDigest: "head-event-digest",
			epochRef: EPOCH,
		};
		const provider = createWorkflowDispatchReadinessProvider({
			readCurrentHead: async () => head,
		});
		const observed = await provider.observe(readinessInput(input));

		expect(observed.currentHeadDigest).toBe(digestObject(head));
	});

	it("authenticates canonical bytes from a real runtime artifact resolver", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-dispatch-artifact-"));
		try {
			await mkdir(join(root, "artifacts"));
			const relativePath = "artifacts/admission-bundle.json";
			const path = join(root, relativePath);
			const bytes = canonicalJsonBytes({ kind: "workflow-canonical-admission-bundle", workflowId: WORKFLOW_ID });
			await writeFile(path, bytes);
			const ref = {
				artifactId: "admission-bundle",
				relativePath,
				digest: sha256Hex(bytes),
				sizeBytes: bytes.byteLength,
				sourceEventSequence: 4,
			};
			const resolver = {
				resolve: async (candidate: WorkflowArtifactRef) => {
					const resolved = await readFile(join(root, candidate.relativePath));
					return {
						envelope: {
							ref: candidate,
							payloadKind: "workflow_artifact",
							codec: "canonical_json",
							immutable: true,
						},
						exists: true,
						bytes: new Uint8Array(resolved) as unknown as Readonly<Uint8Array>,
						verifiedDigest: sha256Hex(resolved),
						verifiedSizeBytes: resolved.byteLength,
					};
				},
			} as unknown as WorkflowArtifactResolver;

			await expect(resolveCanonicalDispatchArtifact(ref, resolver)).resolves.toEqual(new Uint8Array(bytes));
			await writeFile(path, Buffer.from("tampered"));
			await expect(resolveCanonicalDispatchArtifact(ref, resolver)).rejects.toMatchObject({
				code: "workflow_artifact_digest_mismatch",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses persisted runtime artifacts for readiness instead of caller digests", async () => {
		const root = await mkdtemp(join(tmpdir(), "workflow-dispatch-runtime-"));
		try {
			await mkdir(join(root, "artifacts"));
			const stored = new Map<string, Uint8Array>();
			const storeArtifact = async (artifactId: string, payload: unknown): Promise<WorkflowArtifactRef> => {
				const bytes = canonicalJsonBytes(payload);
				const relativePath = `artifacts/${artifactId}.json`;
				await writeFile(join(root, relativePath), bytes);
				stored.set(relativePath, bytes);
				return {
					artifactId,
					relativePath,
					digest: sha256Hex(bytes),
					sizeBytes: bytes.byteLength,
					sourceEventSequence: 4,
				};
			};
			const input = canonicalInput();
			const bundle = input.canonicalAdmissionBundle as unknown as Record<string, unknown>;
			const ledger = bundle.ledger as Record<string, unknown>;
			const grantLedger = bundle.grantLedger as Record<string, unknown>;
			const grant = bundle.grant as Record<string, unknown>;
			const envelope = bundle.envelope as Record<string, unknown>;
			const snapshot = bundle.snapshot as Record<string, unknown>;
			const resourceLease = bundle.resourceLease as Record<string, unknown>;
			const resourceAdmission = resourceLease.resourceAdmission as Record<string, unknown>;
			const capacityGrant = resourceAdmission.capacityGrant as Record<string, unknown>;
			const revisionRef = await storeArtifact("revision-registry", { kind: "revision-registry" });
			const promptRef = await storeArtifact("prompt", { kind: "prompt" });
			const ledgerRef = await storeArtifact("ledger", { kind: "canonical-ledger" });
			const quotaRef = await storeArtifact("quota", { kind: "provider-quota" });
			const closureRef = await storeArtifact("closure", { kind: "closure-manifest" });
			const configRef = await storeArtifact("config", { kind: "runtime-config" });
			ledger.artifactRef = ledgerRef;
			grantLedger.canonical = { canonicalLedgerRef: ledgerRef };
			grant.canonicalPoolLedgerRef = ledgerRef;
			capacityGrant.canonicalPoolLedgerRef = ledgerRef;
			resourceAdmission.canonicalLedgerRef = ledgerRef;
			envelope.canonicalLedgerRef = ledgerRef;
			envelope.providerQuotaSnapshotRef = quotaRef;
			snapshot.closureManifestRef = closureRef;
			bundle.refs = { revisionRef, promptRef, ledgerRef, quotaRef, closureRef, configRef };
			const proof = bundle.controlReserveProof as Record<string, unknown>;
			proof.canonicalLedgerRef = ledgerRef;
			proof.proofDigest = digestObject({
				workflowId: proof.workflowId,
				epochRef: proof.epochRef,
				envelopeDigest: proof.envelopeDigest,
				canonicalLedgerRef: proof.canonicalLedgerRef,
				canonicalLedgerDigest: proof.canonicalLedgerDigest,
				controlCapacity: proof.controlCapacity,
				controlPlaneReserveCapacity: proof.controlPlaneReserveCapacity,
			});
			const bundleBytes = canonicalJsonBytes(bundle);
			const bundleRef: WorkflowArtifactRef = {
				artifactId: "admission-bundle",
				relativePath: "artifacts/admission-bundle.json",
				digest: sha256Hex(bundleBytes),
				sizeBytes: bundleBytes.byteLength,
				sourceEventSequence: 4,
			};
			await writeFile(join(root, bundleRef.relativePath), bundleBytes);
			stored.set(bundleRef.relativePath, bundleBytes);
			const rootBytes = canonicalJsonBytes({
				workflowId: WORKFLOW_ID,
				rootSessionId: "root-session",
				artifactRoot: root,
				epochRef: EPOCH,
			});
			const rootRef: WorkflowArtifactRef = {
				artifactId: "workflow-root",
				relativePath: "artifacts/workflow-root.json",
				digest: sha256Hex(rootBytes),
				sizeBytes: rootBytes.byteLength,
				sourceEventSequence: 4,
			};
			await writeFile(join(root, rootRef.relativePath), rootBytes);
			stored.set(rootRef.relativePath, rootBytes);
			const dispatchInput = {
				...input,
				canonicalAdmissionBundle: bundle,
				canonicalAdmissionBundleRef: bundleRef,
				canonicalAdmissionBundleDigest: digestObject(bundle),
				revisionRegistryRef: revisionRef,
				promptArtifactRef: promptRef,
			} as unknown as WorkflowCanonicalDispatchInput;
			const resolver = {
				resolve: async (candidate: WorkflowArtifactRef) => {
					const bytes = stored.get(candidate.relativePath);
					if (bytes === undefined) throw new Error("artifact missing");
					return {
						envelope: {
							ref: candidate,
							payloadKind: "evidence",
							codec: "canonical_json",
							immutable: true,
						},
						exists: true,
						bytes: bytes as unknown as Readonly<Uint8Array>,
						verifiedDigest: sha256Hex(bytes),
						verifiedSizeBytes: bytes.byteLength,
					};
				},
			} as unknown as WorkflowArtifactResolver;
			const head: WorkflowJournalHead = {
				workflowId: WORKFLOW_ID,
				sequence: 4,
				eventDigest: "head-event-digest",
				epochRef: EPOCH,
			};
			const revisionBoundary: WorkflowRevisionBoundaryContext = {
				workflowId: WORKFLOW_ID,
				epochRef: EPOCH,
				leaseRef: dispatchInput.rootLeaseRef,
				executionKey: dispatchInput.executionKey,
				revisionTuple: dispatchInput.revisionTuple,
				revisionRegistryRef: revisionRef,
				revisionRegistryDigest: dispatchInput.revisionRegistryDigest,
				configSnapshotDigest: dispatchInput.configSnapshotDigest,
				tupleDigest: digestObject({
					workflowId: WORKFLOW_ID,
					epochRef: EPOCH,
					leaseRef: dispatchInput.rootLeaseRef,
					executionKey: dispatchInput.executionKey,
					revisionTuple: dispatchInput.revisionTuple,
					revisionRegistryRef: revisionRef,
					revisionRegistryDigest: dispatchInput.revisionRegistryDigest,
					configSnapshotDigest: dispatchInput.configSnapshotDigest,
				}),
			};
			const activeLease: WorkflowActiveLeaseContext = {
				workflowId: WORKFLOW_ID,
				epochRef: EPOCH,
				leaseRef: dispatchInput.rootLeaseRef,
				writerIdentity: dispatchInput.writerIdentity,
				generationId: "generation-1",
				revisionBoundary,
			};
			const provider = createWorkflowDispatchReadinessProvider({
				artifactRoot: root,
				canonicalArtifactRoot: root,
				artifactRootRelativePath: "workflows/workflow-dispatch-test",
				artifactRootPathDigest: "artifact-root-path-digest",
				activeGenerationDigest: "generation-digest",
				artifactResolver: resolver,
				rootArtifactRef: async () => rootRef,
				verifyArtifactRoot: async () => true,
				readCurrentEpoch: async () => EPOCH,
				readCurrentHead: async () => head,
				readActiveLeaseContext: async () => activeLease,
				readApprovedConfig: async (): Promise<WorkflowApprovedDispatchConfiguration> =>
					({
						snapshot: bundle.snapshot,
						envelope: bundle.envelope,
						decisionRef: dispatchInput.decisionRef,
						configArtifactRef: configRef,
						canonicalAdmissionBundleRef: bundleRef,
						canonicalAdmissionBundle: bundle,
						canonicalAdmissionBundleDigest: digestObject(bundle),
					}) as unknown as WorkflowApprovedDispatchConfiguration,
				readRevisionBoundaryContext: async () => revisionBoundary,
				revisionRegistry: { assertActive: async () => undefined },
				epochs: { assertCurrent: async () => undefined },
				adapterAvailable: async () => true,
				authorityClosure: async () => true,
				workerReadiness: {
					observe: async () => ({
						status: "same_process_child_session",
						artifact: null,
						capabilityAttestation: null,
					}),
				},
				effectReadiness: () => ({ canExecute: true, blockingReasons: [] }),
			});
			const observed = await provider.observe(readinessInput(dispatchInput));

			expect(observed.checks.artifactRootVerified).toBe(true);
			expect(observed.checks.canonicalAdmissionBundleVerified).toBe(true);
			expect(observed.currentHeadDigest).toBe(digestObject(head));
			expect(observed.childSpawnPath).toBe("same_process_rlm");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails recovery closed when exact binding and a reconciliation port are absent", async () => {
		await expect(
			assertWorkflowRecoveryBinding({
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
				executionKey: "execution-key",
				epochRef: EPOCH,
				leaseRef: null,
				writerIdentity: "writer-1",
				runtimeVersion: "0.147.0-alpha.10",
				hostCapabilityRevision: "host-capability-1",
				capabilityDigest: "capability-digest",
				revisionTuple: canonicalInput().revisionTuple,
				revisionRegistryRef: artifactRef("revision-registry"),
				revisionRegistryDigest: "revision-registry-digest",
				workspaceDigest: null,
			}),
		).rejects.toMatchObject({ code: "workflow_recovery_unavailable" });
	});

	it("rejects readiness input whose derived lease differs from the canonical input", async () => {
		const input = canonicalInput();
		const provider = createWorkflowDispatchReadinessProvider({});
		const mismatched = readinessInput(input);
		mismatched.leaseRef = { ...mismatched.leaseRef, acquisitionEventSequence: 12 };

		await expect(provider.observe(mismatched)).rejects.toMatchObject({
			code: "workflow_readiness_input_mismatch",
		});
	});

	it("does not launch a child even if an injected provider reports readiness", async () => {
		const input = canonicalInput();
		const observed = { ...readiness(input), canDispatch: true, blockingReasons: [] };
		const { dispatcher } = createDispatcher(input, observed);

		await expect(dispatcher.dispatch(input)).rejects.toMatchObject({
			code: "workflow_child_launch_unavailable",
		});
	});

	it("launches exactly one worker through the authenticated dispatcher after readiness", async () => {
		const input = canonicalInput();
		const observed = { ...readiness(input), canDispatch: true, blockingReasons: [] };
		let launches = 0;
		const { dispatcher } = createDispatcher(input, observed, async (dispatchInput) => {
			launches += 1;
			return {
				workflowId: dispatchInput.workflowId,
				taskId: dispatchInput.taskId,
				attemptId: dispatchInput.attemptId,
				executionKey: dispatchInput.executionKey,
				epochRef: dispatchInput.epochRef,
				workerId: "worker-1",
				executionIdentity: "worker-execution-1",
				processStartId: "process-start-1",
				processGroupId: "process-group-1",
				launchedAt: "2030-01-01T00:00:00.000Z",
				launchEvidenceRef: artifactRef("worker-launch-1"),
			};
		});

		await expect(dispatcher.dispatch(input)).resolves.toMatchObject({
			status: "launched",
			phase: "execution",
			worker: {
				workerId: "worker-1",
				executionIdentity: "worker-execution-1",
				processStartId: "process-start-1",
				processGroupId: "process-group-1",
			},
		});
		expect(launches).toBe(1);
	});

	it("rejects a worker launch that is not bound to the admitted task attempt", async () => {
		const input = canonicalInput();
		const observed = { ...readiness(input), canDispatch: true, blockingReasons: [] };
		const { dispatcher } = createDispatcher(input, observed, async (dispatchInput) => ({
			workflowId: dispatchInput.workflowId,
			taskId: "foreign-task",
			attemptId: dispatchInput.attemptId,
			executionKey: dispatchInput.executionKey,
			epochRef: dispatchInput.epochRef,
			workerId: "worker-1",
			executionIdentity: "worker-execution-1",
			processStartId: "process-start-1",
			processGroupId: "process-group-1",
			launchedAt: "2030-01-01T00:00:00.000Z",
			launchEvidenceRef: artifactRef("worker-launch-foreign"),
		}));

		await expect(dispatcher.dispatch(input)).rejects.toMatchObject({ code: "workflow_child_launch_invalid" });
	});
});
