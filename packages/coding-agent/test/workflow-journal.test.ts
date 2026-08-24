import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	access,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open as openFile,
	readFile,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { GoalState } from "../src/core/goals.js";
import type {
	WorkflowArtifactRef,
	WorkflowAuthenticatedMutationTuple,
	WorkflowCapacityGrant,
	WorkflowDescriptorHandle,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGoalMutationDelta,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowResourceAdmission,
	WorkflowResourceLease,
	WorkflowResourceVector,
	WorkflowSemanticMutationBinding,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	DurableStoreCrashBoundary,
	digestObject,
	sha256Hex,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowAppendLease,
	WorkflowGenerationContext,
	WorkflowGenerationContextOpener,
	WorkflowGoalProjectionAuthorization,
	WorkflowJournalImpl,
	WorkflowJournalKey,
	WorkflowJournalKeyProvider,
	WorkflowJournalOptions,
} from "../src/core/workflow/journal.js";
import {
	consumeWorkflowGoalProjectionAuthorization,
	createFileWorkflowAppendLease,
	createNodeWorkflowDescriptorFs,
	createWorkflowDescriptorRootAdapters,
	createWorkflowGenerationContextOpener,
	createWorkflowOwnerValidators,
	decodeWorkflowEventPayload,
	deriveWorkflowGenerationId,
	deriveWorkflowGenerationPath,
	inspectWorkflowJournalRecovery,
	validateWorkflowGoalProjectionAuthorization,
	verifyWorkflowFrameGoldenVectors,
	WORKFLOW_FRAME_GOLDEN_VECTORS,
	WorkflowArtifactStore,
	WorkflowJournal,
	WorkflowOutboxStore,
	WorkflowSnapshotStore,
} from "../src/core/workflow/journal.js";
import { createNodeWorkflowDescriptorFs as createProductionWorkflowDescriptorFs } from "../src/core/workflow/node-descriptor-fs.js";
import { applyWorkflowGoalTransition } from "../src/core/workflow/projections.js";
import { WorkflowStore } from "../src/core/workflow/reducer.js";
import { loadPersistedEpochFixture } from "./workflow-fixtures.js";

function managerResourceLeasePayload(): Extract<WorkflowEventPayload, { kind: "workflow_resource_lease_acquired" }> {
	const epochRef: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
	const workflowId = "workflow-manager-shaped";
	const vector: WorkflowResourceVector = {
		cpuMilliCores: 10,
		memoryBytes: 20,
		diskBytes: 30,
		ioWeight: 40,
		accelerators: [],
		providers: [],
		networkEgressBytes: 50,
		wallMilliseconds: 60,
		monetaryMicrounits: 70,
	};
	const controlCapacity = {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	} as const;
	const canonicalPoolLedgerRef = managerArtifactRef("canonical-pool-ledger");
	const capacityGrant: WorkflowCapacityGrant = {
		kind: "worker",
		grantId: "grant:attempt-1",
		resourceVector: vector,
		controlCapacity,
		canonicalPoolLedgerRef,
		grantDigest: digestObject({ kind: "worker", vector, canonicalPoolLedgerRef }),
	};
	const admission: WorkflowResourceAdmission = {
		capacityGrant,
		canonicalPoolLedgerRef,
		controlCapacity,
		controlCapacityProjectionDigest: digestObject(controlCapacity),
		declaredVector: vector,
		hostDerivedConservativeVector: vector,
		reservedVector: vector,
		declaredControlCapacity: controlCapacity,
		hostDerivedControlCapacity: controlCapacity,
		reservedControlCapacity: controlCapacity,
		derivationPolicyDigest: digestObject({ enforcementClass: "isolated_metered", controlPlane: false }),
		enforcementClass: "isolated_metered",
		unknownPoolIds: [],
		canonicalLedgerRef: canonicalPoolLedgerRef,
		canonicalLedgerDigest: canonicalPoolLedgerRef.digest,
		admitted: true,
		admissionDigest: digestObject({ workflowId, capacityGrant }),
	};
	const lease: WorkflowResourceLease = {
		leaseId: "resource:workflow-manager-shaped:attempt-1",
		workflowId,
		taskId: "task-1",
		attemptId: "attempt-1",
		holderIdentity: "writer-1",
		resourceAdmission: admission,
		controlCapacity,
		workerCapacity: controlCapacity,
		status: "active",
		storeEpoch: epochRef.storeEpoch,
		coordinatorEpoch: epochRef.coordinatorEpoch,
		acquisitionEventSequence: 1,
		idempotencyKey: "resource:attempt-1",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:01:00.000Z",
		releaseEventSequence: null,
	};
	return { kind: "workflow_resource_lease_acquired", workflowId, lease, epochRef };
}

function managerArtifactRef(artifactId: string): WorkflowArtifactRef {
	return {
		artifactId,
		relativePath: `artifacts/${artifactId}.json`,
		digest: digestObject({ artifactId }),
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

describe("workflow journal", () => {
	it("keeps the fixed authenticated frame vectors stable", () => {
		expect(verifyWorkflowFrameGoldenVectors()).toBe(true);
		expect(WORKFLOW_FRAME_GOLDEN_VECTORS).toHaveLength(7);
	});

	it("accepts canonical closed event payloads and rejects unknown shapes", () => {
		const payload = {
			kind: "workflow_started" as const,
			workflowId: "workflow-1",
			rootSessionId: "session-1",
			objective: "objective",
		};

		expect(decodeWorkflowEventPayload(canonicalJsonBytes(payload))).toEqual(payload);
		expect(() => decodeWorkflowEventPayload(canonicalJsonBytes({ ...payload, unexpected: true }))).toThrow(
			/closed event|canonical/i,
		);
	});

	it("mints an opaque one-use goal projection authorization only for the authenticated current head", async () => {
		const harness = await createJournalHarness("workflow-goal-authorization");
		try {
			const started = await harness.journal.append(createStartAppendInput(harness, "goal-auth-start"));
			const expectedGoal: GoalState = {
				active: true,
				status: "active",
				goalId: "goal-1",
				objective: "durable",
				tokenBudget: 100,
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
				createdAt: 1,
				updatedAt: 1,
			};
			const delta: WorkflowGoalMutationDelta = {
				goalId: expectedGoal.goalId ?? null,
				objective: expectedGoal.objective ?? null,
				active: false,
				status: "paused",
				tokenBudget: expectedGoal.tokenBudget ?? null,
				tokensUsed: expectedGoal.tokensUsed,
				timeUsedSeconds: expectedGoal.timeUsedSeconds,
				continuationsUsed: expectedGoal.continuationsUsed,
				createdAt: expectedGoal.createdAt ?? null,
				updatedAt: 2,
				lastReason: "operator pause",
				lastError: null,
			};
			const payload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
				kind: "workflow_status_changed",
				status: "paused",
				phase: "adjudicating",
				reason: "operator pause",
				goalDelta: delta,
			};
			const expectedHead: WorkflowJournalHead = {
				workflowId: harness.workflowId,
				sequence: started.sequence,
				eventDigest: started.eventDigest,
				epochRef: harness.epoch,
			};
			const baseInput = createStartAppendInput(harness, "goal-auth-pause");
			const semanticBinding: WorkflowSemanticMutationBinding = {
				...baseInput.semanticBinding,
				mutationId: "goal-auth-pause",
				baselineDigest: digestObject(expectedHead),
				reducerDigest: digestObject(payload),
				semanticHead: {
					...expectedHead,
					stateDigest: digestObject(expectedHead),
					generation: harness.epoch.storeEpoch,
				},
				expectedHead,
				idempotencyKey: "goal-auth-pause",
			};
			const pausedEvent = await harness.journal.append({
				...baseInput,
				payload,
				expectedHead,
				idempotencyKey: "goal-auth-pause",
				returnProofId: "return-proof:goal-auth-pause",
				semanticBinding,
			});
			const nextGoal = applyWorkflowGoalTransition(expectedGoal, payload);
			const authorization = await harness.journal.authorizeGoalProjection({
				eventSequence: pausedEvent.sequence,
				eventDigest: pausedEvent.eventDigest,
				expectedGoal,
				nextGoal,
			});

			expect(Object.getOwnPropertyNames(authorization)).toEqual([]);
			expect(Object.keys(authorization)).toEqual([]);
			expect(JSON.stringify(authorization)).toBe("{}");
			expect(
				validateWorkflowGoalProjectionAuthorization(authorization, {
					workflowId: harness.workflowId,
					expectedGoal,
					nextGoal,
				}),
			).toBe(true);
			expect(
				validateWorkflowGoalProjectionAuthorization(
					{ ...authorization, workflowId: harness.workflowId } as unknown as WorkflowGoalProjectionAuthorization,
					{ workflowId: harness.workflowId, expectedGoal, nextGoal },
				),
			).toBe(false);
			await expect(
				harness.journal.authorizeGoalProjection({
					eventSequence: pausedEvent.sequence,
					eventDigest: pausedEvent.eventDigest,
					expectedGoal,
					nextGoal: { ...nextGoal, lastReason: "forged next goal" },
				}),
			).rejects.toThrow(/canonical event-derived snapshot/i);
			expect(
				consumeWorkflowGoalProjectionAuthorization(authorization, {
					workflowId: harness.workflowId,
					expectedGoal,
					nextGoal,
				}),
			).toBe(true);
			expect(
				consumeWorkflowGoalProjectionAuthorization(authorization, {
					workflowId: harness.workflowId,
					expectedGoal,
					nextGoal,
				}),
			).toBe(false);
			const staleAuthorization = await harness.journal.authorizeGoalProjection({
				eventSequence: pausedEvent.sequence,
				eventDigest: pausedEvent.eventDigest,
				expectedGoal,
				nextGoal,
			});
			const followupPayload: Extract<WorkflowEventPayload, { kind: "workflow_status_changed" }> = {
				...payload,
				reason: "pause replay",
				goalDelta: { ...delta, updatedAt: 3, lastReason: "pause replay" },
			};
			const followupHead: WorkflowJournalHead = {
				workflowId: harness.workflowId,
				sequence: pausedEvent.sequence,
				eventDigest: pausedEvent.eventDigest,
				epochRef: harness.epoch,
			};
			const followupBase = createStartAppendInput(harness, "goal-auth-followup");
			await harness.journal.append({
				...followupBase,
				payload: followupPayload,
				expectedHead: followupHead,
				idempotencyKey: "goal-auth-followup",
				returnProofId: "return-proof:goal-auth-followup",
				semanticBinding: {
					...followupBase.semanticBinding,
					mutationId: "goal-auth-followup",
					baselineDigest: digestObject(followupHead),
					reducerDigest: digestObject(followupPayload),
					semanticHead: {
						...followupHead,
						stateDigest: digestObject(followupHead),
						generation: harness.epoch.storeEpoch,
					},
					expectedHead: followupHead,
					idempotencyKey: "goal-auth-followup",
				},
			});
			expect(
				validateWorkflowGoalProjectionAuthorization(staleAuthorization, {
					workflowId: harness.workflowId,
					expectedGoal,
					nextGoal,
				}),
			).toBe(false);
		} finally {
			await harness.close();
		}
	});

	it("revokes an old-instance goal authorization after another journal rotates the generation", async () => {
		const harness = await createJournalHarness("workflow-goal-rotation-revocation");
		let secondJournal: WorkflowJournalImpl | null = null;
		try {
			const expectedHead: WorkflowJournalHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			const expectedGoal: GoalState = {
				active: false,
				status: "idle",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
			};
			const nextGoal: GoalState = {
				active: true,
				status: "active",
				workflowId: harness.workflowId,
				goalId: "goal-rotation-revocation",
				objective: "rotate the goal authority",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				continuationsUsed: 0,
				createdAt: 1,
				updatedAt: 1,
			};
			const payload: Extract<WorkflowEventPayload, { kind: "goal_binding_committed" }> = {
				kind: "goal_binding_committed",
				workflowId: harness.workflowId,
				goalId: nextGoal.goalId ?? "",
				objective: nextGoal.objective ?? "",
				goalDelta: {
					goalId: nextGoal.goalId ?? null,
					objective: nextGoal.objective ?? null,
					active: true,
					status: "active",
					tokenBudget: null,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					continuationsUsed: 0,
					createdAt: 1,
					updatedAt: 1,
					lastReason: null,
					lastError: null,
				},
			};
			const baseInput = createStartAppendInput(harness, "goal-rotation-revocation-binding");
			const binding = await harness.journal.append({
				...baseInput,
				payload,
				expectedHead,
				idempotencyKey: "goal-rotation-revocation-binding",
				returnProofId: "return-proof:goal-rotation-revocation-binding",
				semanticBinding: {
					...baseInput.semanticBinding,
					mutationId: "goal-rotation-revocation-binding",
					baselineDigest: digestObject(expectedHead),
					reducerDigest: digestObject(payload),
					semanticHead: {
						...expectedHead,
						stateDigest: digestObject(expectedHead),
						generation: harness.epoch.storeEpoch,
					},
					expectedHead,
					idempotencyKey: "goal-rotation-revocation-binding",
				},
			});
			const authorization = await harness.journal.authorizeGoalProjection({
				eventSequence: binding.sequence,
				eventDigest: binding.eventDigest,
				expectedGoal,
				nextGoal,
			});
			const successorKeys = new Map<number, WorkflowJournalKey>();
			const predecessorProvider = createTestKeyProviderWithOverrides(successorKeys);
			harness.options.keyProvider = predecessorProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: predecessorProvider });
			const { input, successorKey } = await createRotationRequest(harness, "goal-rotation-revocation", "writer-2", {
				...expectedHead,
				sequence: binding.sequence,
				eventDigest: binding.eventDigest,
			});
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			const secondOptions: WorkflowJournalOptions = {
				...harness.options,
				keyProvider: predecessorProvider,
				successorContextOpener: createWorkflowGenerationContextOpener({
					...harness.options,
					keyProvider: predecessorProvider,
				}),
			};
			secondJournal = await WorkflowJournal.open(secondOptions);
			await secondJournal.rotateGeneration(input);
			expect(
				validateWorkflowGoalProjectionAuthorization(authorization, {
					workflowId: harness.workflowId,
					expectedGoal,
					nextGoal,
				}),
			).toBe(false);
		} finally {
			if (secondJournal !== null) await closeJournalDescriptors(secondJournal);
			await harness.close();
		}
	});

	it("round-trips the manager-shaped resource lease admission as one canonical event", () => {
		const payload = managerResourceLeasePayload();

		expect(decodeWorkflowEventPayload(canonicalJsonBytes(payload))).toEqual(payload);
	});

	it("rejects omitted or extra resource admission fields instead of accepting a legacy shape", () => {
		const payload = managerResourceLeasePayload();
		const requiredFields = [
			"capacityGrant",
			"canonicalPoolLedgerRef",
			"controlCapacity",
			"controlCapacityProjectionDigest",
			"admitted",
		] as const;

		for (const field of requiredFields) {
			const admission = { ...payload.lease.resourceAdmission } as Record<string, unknown>;
			delete admission[field];
			const omitted = {
				...payload,
				lease: { ...payload.lease, resourceAdmission: admission },
			};
			expect(() => decodeWorkflowEventPayload(canonicalJsonBytes(omitted))).toThrow(/closed event|canonical/i);
		}

		const extra = {
			...payload,
			lease: {
				...payload.lease,
				resourceAdmission: { ...payload.lease.resourceAdmission, unexpected: true },
			},
		};
		expect(() => decodeWorkflowEventPayload(canonicalJsonBytes(extra))).toThrow(/closed event|canonical/i);

		const legacyAdmission = { ...payload.lease.resourceAdmission } as Record<string, unknown>;
		for (const field of requiredFields) delete legacyAdmission[field];
		const legacy = {
			...payload,
			lease: { ...payload.lease, resourceAdmission: legacyAdmission },
		};
		expect(() => decodeWorkflowEventPayload(canonicalJsonBytes(legacy))).toThrow(/closed event|canonical/i);
	});

	it("rejects relative descriptor roots before opening any host descriptors", async () => {
		const harness = await createJournalHarness("workflow-relative-root");
		try {
			const relativeRoot = "relative-artifacts";
			const relativeWorkflowDir = `${relativeRoot}/workflows/${harness.workflowId}`;
			await expect(
				WorkflowJournal.open({
					...harness.options,
					artifactRoot: relativeRoot,
					sessionArtifactRoot: relativeRoot,
					workflowDir: relativeWorkflowDir,
					descriptorRoots: {
						sessionRoot: {
							rootSessionId: harness.rootSessionId,
							descriptorRoot: relativeRoot,
							identityDigest: "relative-root",
						},
						workflowRoot: {
							workflowId: harness.workflowId,
							descriptorRoot: relativeWorkflowDir,
							identityDigest: "relative-workflow",
						},
					},
				}),
			).rejects.toThrow(/canonical host-rooted descriptor path/i);
		} finally {
			await harness.close();
		}
	});

	it("rejects symlink and hardlink descriptor leaves and pins an opened leaf across a path swap", async () => {
		const harness = await createJournalHarness("workflow-descriptor-race");
		const descriptorFs = harness.journal.descriptorContext.descriptorFs;
		const workflow = harness.journal.descriptorContext.workflow;
		const targetPath = join(harness.workflowDir, "descriptor-race-target");
		const symlinkPath = join(harness.workflowDir, "descriptor-race-symlink");
		const hardlinkPath = join(harness.workflowDir, "descriptor-race-hardlink");
		const movedPath = `${targetPath}.moved`;
		try {
			await writeFile(targetPath, "original", { mode: 0o600 });
			await symlink(targetPath, symlinkPath);
			await expect(
				descriptorFs.openAt(
					workflow,
					"descriptor-race-symlink",
					fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				),
			).rejects.toThrow(/symlink|no-follow/i);

			await link(targetPath, hardlinkPath);
			await expect(
				descriptorFs.openAt(
					workflow,
					"descriptor-race-hardlink",
					fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				),
			).rejects.toThrow(/hard-link|regular file/i);
			await unlink(hardlinkPath);

			const opened = await descriptorFs.openAt(
				workflow,
				"descriptor-race-target",
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				await rename(targetPath, movedPath);
				await writeFile(targetPath, "replacement", { mode: 0o600 });
				expect(Buffer.from(await opened.read()).toString()).toBe("original");
				expect((await opened.stat()).identityDigest).toBe(opened.identityDigest);
			} finally {
				await opened.close().catch(() => undefined);
			}
		} finally {
			await unlink(symlinkPath).catch(() => undefined);
			await unlink(hardlinkPath).catch(() => undefined);
			await unlink(targetPath).catch(() => undefined);
			await unlink(movedPath).catch(() => undefined);
			await harness.close();
		}
	});

	it("publishes immutable artifacts and replays only committed events", async () => {
		const harness = await createJournalHarness("workflow-artifacts");
		try {
			const artifactStore = WorkflowArtifactStore.fromJournal(harness.journal);
			const bytes = canonicalJsonBytes({ objective: "durable" });
			const published = await artifactStore.publish({
				workflowId: harness.workflowId,
				payloadKind: "evidence",
				bytes,
				codec: "canonical_json",
				sourceEventSequence: 0,
				idempotencyKey: "artifact-1",
			});
			const resolved = await artifactStore.resolve(published.envelope.ref);
			expect(resolved.exists).toBe(true);
			expect(resolved.envelope.immutable).toBe(true);
			expect(resolved.bytes).toEqual(bytes);
			expect(resolved.verifiedDigest).toBe(sha256Hex(bytes));

			const input = createStartAppendInput(harness, "event-1");
			const event = await harness.journal.append(input);
			expect(event.sequence).toBe(1);
			expect(event.payloadBytes).toEqual(canonicalJsonBytes(input.payload));
			expect(await harness.journal.recover()).toMatchObject({
				quarantined: false,
				metadata: { status: "complete" },
			});
			expect(await harness.journal.replay()).toEqual([event]);
		} finally {
			await harness.close();
		}
	});

	it("serializes concurrent immutable publication through the lease guard", async () => {
		const harness = await createJournalHarness("workflow-race");
		try {
			const artifactStore = WorkflowArtifactStore.fromJournal(harness.journal);
			const input = {
				workflowId: harness.workflowId,
				payloadKind: "evidence" as const,
				bytes: canonicalJsonBytes({ race: true }),
				codec: "canonical_json" as const,
				sourceEventSequence: 0,
				idempotencyKey: "race-artifact",
			};
			const results = await Promise.all([artifactStore.publish(input), artifactStore.publish(input)]);
			expect(results.map((result) => result.status).sort()).toEqual(["already_published", "published"]);
		} finally {
			await harness.close();
		}
	});

	it("proves two independently opened descriptor adapters cannot both commit across the injected process lease", async () => {
		const harness = await createJournalHarness("workflow-interprocess-race");
		let competing: WorkflowJournalImpl | null = null;
		try {
			competing = await WorkflowJournal.open({
				...harness.options,
				descriptorFs: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter()),
				successorContextOpener: {
					openSuccessor: async () => {
						throw new Error("competing process successor is not used by this test");
					},
				},
			});
			const results = await Promise.allSettled([
				harness.journal.append(createStartAppendInput(harness, "interprocess-race-owner")),
				competing.append(createStartAppendInput(harness, "interprocess-race-competing")),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
			await expect(harness.journal.replay()).resolves.toHaveLength(1);
		} finally {
			if (competing !== null) await closeJournalDescriptors(competing);
			await harness.close();
		}
	});

	it("serializes a journal append against a real child-process filesystem lease", async () => {
		const harness = await createJournalHarness("workflow-child-process-lease-race");
		let child: ReturnType<typeof spawn> | null = null;
		try {
			const lockPath = join(harness.root, "workflow-append.lock");
			const fileLease = createFileWorkflowAppendLease({
				lockPath,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
			});
			harness.options.appendLease = fileLease;
			harness.journal.options.appendLease = fileLease;
			const sourceUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/journal.ts")).href;
			const childScript = `
				import { createFileWorkflowAppendLease } from ${JSON.stringify(sourceUrl)};
				const leaseRef = ${JSON.stringify(harness.leaseRef)};
				const lease = createFileWorkflowAppendLease({
					lockPath: ${JSON.stringify(lockPath)},
					leaseRef,
					writerIdentity: ${JSON.stringify(harness.writerIdentity)},
				});
				await lease.withExclusiveGuard(
					{
						workflowId: ${JSON.stringify(harness.workflowId)},
						writerIdentity: ${JSON.stringify(harness.writerIdentity)},
						leaseRef,
						epochRef: { storeEpoch: leaseRef.storeEpoch, coordinatorEpoch: leaseRef.coordinatorEpoch },
						rootDigest: leaseRef.rootDigest,
						boundary: "child-process-race",
					},
					async () => {
						process.stdout.write("ready\\n");
						await new Promise((resolve) => setTimeout(resolve, 250));
					},
				);
			`;
			child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
				stdio: ["ignore", "pipe", "pipe"],
			});
			const childExit = new Promise<number>((resolve, reject) => {
				child?.on("error", reject);
				child?.on("exit", (code) => resolve(code ?? -1));
			});
			let output = "";
			const ready = new Promise<void>((resolve, reject) => {
				child?.stdout?.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					if (output.includes("ready")) resolve();
				});
				child?.stderr?.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
			});
			await ready;
			const startedAt = Date.now();
			await expect(
				harness.journal.append(createStartAppendInput(harness, "child-process-race-event")),
			).resolves.toMatchObject({ sequence: 1 });
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
			expect(await childExit).toBe(0);
		} finally {
			if (child !== null && child.exitCode === null) child.kill("SIGTERM");
			await harness.close();
		}
	});

	it("proves one real process append wins, the stale writer is rejected, and a fresh open recovers it", async () => {
		const harness = await createJournalHarness("workflow-two-process-recovery", createTestKeyProvider(), "file");
		let child: ReturnType<typeof spawn> | null = null;
		try {
			const lockPath = join(harness.root, "workflow-append.lock");
			const childWriterIdentity = "writer-2";
			const childLeaseRef: WorkflowLeaseRef = {
				...harness.leaseRef,
				leaseId: `${harness.leaseRef.leaseId}-child`,
				processIdentity: "process-2",
				writerIdentity: childWriterIdentity,
			};
			const journalUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/journal.ts")).href;
			const contractsUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/contracts.ts")).href;
			const descriptorUrl = pathToFileURL(join(process.cwd(), "src/core/workflow/node-descriptor-fs.ts")).href;
			const childConfig = {
				artifactRoot: harness.root,
				sessionArtifactRoot: harness.root,
				workflowDir: harness.workflowDir,
				descriptorRoots: harness.options.descriptorRoots,
				storeKind: harness.options.storeKind,
				namespace: harness.options.namespace,
				storeId: harness.options.storeId,
				workflowId: harness.workflowId,
				rootSessionId: harness.rootSessionId,
				epoch: harness.epoch,
				writerIdentity: childWriterIdentity,
				leaseRef: childLeaseRef,
				lockPath,
			};
			const childScript = `
				import { createNodeWorkflowDescriptorFs } from ${JSON.stringify(descriptorUrl)};
				import {
					createFileWorkflowAppendLease,
					createWorkflowOwnerValidators,
					deriveWorkflowGenerationId,
					WorkflowJournal,
				} from ${JSON.stringify(journalUrl)};
				import { digestObject } from ${JSON.stringify(contractsUrl)};
				const config = ${JSON.stringify(childConfig)};
				const createKey = (workflowId, epoch) => ({
					keyId: "test-key-" + epoch.storeEpoch,
					secret: new TextEncoder().encode("workflow-journal-test-secret"),
					validStoreEpoch: epoch.storeEpoch,
					generationId: deriveWorkflowGenerationId({
						workflowId,
						nextEpoch: epoch,
						rotationId: "bootstrap",
						priorHeadDigest: "test-head",
					}),
				});
				const keyProvider = {
					current: async (workflowId, epoch) => createKey(workflowId, epoch),
					resolve: async (workflowId, _keyId, epoch) => createKey(workflowId, epoch),
				};
				const appendLease = createFileWorkflowAppendLease({
					lockPath: config.lockPath,
					leaseRef: config.leaseRef,
					writerIdentity: config.writerIdentity,
				});
				const descriptorFs = createNodeWorkflowDescriptorFs();
				const options = {
					...config,
					keyProvider,
					appendLease,
					descriptorFs,
					ownerValidators: createWorkflowOwnerValidators(),
					now: () => "2026-08-13T00:00:00.000Z",
					successorContextOpener: { openSuccessor: async () => { throw new Error("unused"); } },
				};
				const journal = await WorkflowJournal.open(options);
				process.stdout.write("ready\\n");
				await new Promise((resolve, reject) => {
					process.stdin.setEncoding("utf8");
					process.stdin.on("data", (chunk) => chunk.includes("go") ? resolve() : undefined);
					process.stdin.on("error", reject);
				});
				const expectedHead = {
					workflowId: config.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: config.epoch,
				};
				const idempotencyKey = "two-process-child";
				const payload = {
					kind: "workflow_started",
					workflowId: config.workflowId,
					rootSessionId: config.rootSessionId,
					objective: "child",
				};
				const semanticBinding = {
					mutationId: idempotencyKey,
					baselineDigest: digestObject(expectedHead),
					expectedGenerations: { [journal.descriptorContext.generationId]: config.epoch.storeEpoch },
					ownerId: "workflow-test",
					phase: "recovering",
					reducerDigest: digestObject(payload),
					semanticHead: { ...expectedHead, stateDigest: digestObject(expectedHead), generation: config.epoch.storeEpoch },
					expectedHead,
					idempotencyKey,
					executionKey: null,
					writerIdentity: config.writerIdentity,
					leaseRef: config.leaseRef,
					epochRef: config.epoch,
				};
				let outcome;
				try {
					const event = await journal.append({
						workflowId: config.workflowId,
						payload,
						expectedHead,
						epochRef: config.epoch,
						leaseRef: config.leaseRef,
						idempotencyKey,
						writerIdentity: config.writerIdentity,
						executionKey: null,
						semanticBinding,
						returnProofId: "return-proof:" + idempotencyKey,
					});
					outcome = { status: "committed", sequence: event.sequence };
				} catch (error) {
					outcome = { status: "rejected", error: error instanceof Error ? error.message : String(error) };
				}
				await journal.descriptorContext.workflow.close();
				await journal.descriptorContext.root.close();
				process.stdout.write(JSON.stringify(outcome) + "\\n");
			`;
			child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", childScript], {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let childOutput = "";
			let childError = "";
			child.stdout?.on("data", (chunk: Buffer) => {
				childOutput += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				childError += chunk.toString();
			});
			const childExit = new Promise<number>((resolve, reject) => {
				child?.on("error", reject);
				child?.on("exit", (code) => resolve(code ?? -1));
			});
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => reject(new Error(`Child process did not open: ${childError}`)), 5_000);
				const poll = setInterval(() => {
					if (childOutput.includes("ready\n")) {
						clearTimeout(timeout);
						clearInterval(poll);
						resolve();
					}
				}, 10);
				child?.once("exit", (code) => {
					if (!childOutput.includes("ready\n")) {
						clearTimeout(timeout);
						clearInterval(poll);
						reject(new Error(`Child process exited before opening (${code}): ${childError}`));
					}
				});
			});
			child.stdin?.end("go\n");
			const parentResult = await Promise.allSettled([
				harness.journal.append(createStartAppendInput(harness, "two-process-parent")),
			]);
			expect(await childExit).toBe(0);
			const childOutcome = JSON.parse(childOutput.trim().split("\n").at(-1) ?? "{}");
			const parentCommitted = parentResult[0].status === "fulfilled";
			const childCommitted = childOutcome.status === "committed";
			expect(Number(parentCommitted) + Number(childCommitted)).toBe(1);
			if (parentCommitted) {
				expect(parentResult[0]).toMatchObject({ status: "fulfilled", value: { sequence: 1 } });
				expect(childOutcome).toMatchObject({
					status: "rejected",
					error: expect.stringMatching(/expected head is stale/i),
				});
			} else {
				expect(parentResult[0]).toMatchObject({
					status: "rejected",
					reason: expect.objectContaining({ message: expect.stringMatching(/expected head is stale/i) }),
				});
				expect(childOutcome).toMatchObject({ status: "committed", sequence: 1 });
			}
			const recovery = await harness.journal.recover();
			expect(recovery).toMatchObject({ quarantined: false, metadata: { status: "complete", sequence: 1 } });
			expect(recovery.events).toHaveLength(1);

			const reopened = await WorkflowJournal.open({
				...harness.options,
				descriptorFs: createProductionWorkflowDescriptorFs(),
				appendLease: createFileWorkflowAppendLease({
					lockPath,
					leaseRef: harness.leaseRef,
					writerIdentity: harness.writerIdentity,
				}),
			});
			try {
				const freshRecovery = await reopened.recover();
				expect(freshRecovery).toMatchObject({ quarantined: false, metadata: { status: "complete", sequence: 1 } });
				expect(await reopened.replay()).toHaveLength(1);
			} finally {
				await closeJournalDescriptors(reopened);
			}
		} finally {
			if (child !== null && child.exitCode === null) child.kill("SIGTERM");
			await harness.close();
		}
	});

	it("rejects an artifact envelope with an unknown field even when its bytes remain immutable", async () => {
		const harness = await createJournalHarness("workflow-artifact-shape");
		try {
			const artifactStore = WorkflowArtifactStore.fromJournal(harness.journal);
			const published = await artifactStore.publish({
				workflowId: harness.workflowId,
				payloadKind: "evidence",
				bytes: canonicalJsonBytes({ shape: true }),
				codec: "canonical_json",
				sourceEventSequence: 0,
				idempotencyKey: "artifact-shape",
			});
			const metadataPath = join(
				harness.workflowDir,
				"artifacts",
				"evidence",
				`${published.envelope.ref.digest}.metadata.json`,
			);
			const envelope = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
			envelope.unexpected = true;
			await writeFile(metadataPath, canonicalJsonBytes(envelope));
			await expect(artifactStore.resolve(published.envelope.ref)).rejects.toThrow(/closed record|envelope/i);
		} finally {
			await harness.close();
		}
	});

	it("rejects a validly re-MACed artifact idempotency record with a malformed epoch", async () => {
		const harness = await createJournalHarness("workflow-artifact-idempotency-shape");
		try {
			const artifactStore = WorkflowArtifactStore.fromJournal(harness.journal);
			const input = {
				workflowId: harness.workflowId,
				payloadKind: "evidence" as const,
				bytes: canonicalJsonBytes({ idempotency: "shape" }),
				codec: "canonical_json" as const,
				sourceEventSequence: 0,
				idempotencyKey: "artifact-idempotency-shape",
			};
			await artifactStore.publish(input);
			const idempotencyPath = join(
				harness.workflowDir,
				"artifact-idempotency",
				`${sha256Hex(new TextEncoder().encode(input.idempotencyKey))}.json`,
			);
			const record = JSON.parse(await readFile(idempotencyPath, "utf8")) as Record<string, unknown>;
			record.epochRef = { ...(record.epochRef as Record<string, unknown>), unexpected: true };
			record.sideRecordMac = authenticateTestSideRecord(record).sideRecordMac;
			await writeFile(idempotencyPath, canonicalJsonBytes(record));
			await expect(artifactStore.publish(input)).rejects.toThrow(/idempotency record|host-authenticated tuple/i);
		} finally {
			await harness.close();
		}
	});

	it("quarantines a returned proof when its committed frame disappears before reopen", async () => {
		const harness = await createJournalHarness("workflow-returned-proof-gap");
		let originalClosed = false;
		let reopened: WorkflowJournalImpl | null = null;
		try {
			await harness.journal.append(createStartAppendInput(harness, "event-returned-proof-gap"));
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const bytes = await readFile(generationPath);
			const preparedFrameLength = Buffer.from(bytes).readUInt32BE(8);
			await writeFile(generationPath, bytes.subarray(0, preparedFrameLength));
			await closeJournalDescriptors(harness.journal);
			originalClosed = true;
			reopened = await WorkflowJournal.open(harness.options);
			expect(await reopened.recover()).toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "uncertain_committed", reason: "commit_return_uncertain" },
			});
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!originalClosed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("waits for an in-flight append return proof before replaying the committed event", async () => {
		const harness = await createJournalHarness("workflow-replay-in-flight-return-proof");
		let releaseReturnProof = (): void => undefined;
		const returnProofBlocked = new Promise<void>((resolve) => {
			releaseReturnProof = resolve;
		});
		let markReturnedStarted: (() => void) | null = null;
		const markReturnedReached = new Promise<void>((resolve) => {
			markReturnedStarted = resolve;
		});
		const originalMarkReturned = harness.journal.returnProofStore.markReturned.bind(harness.journal.returnProofStore);
		harness.journal.returnProofStore.markReturned = async (proof) => {
			markReturnedStarted?.();
			await returnProofBlocked;
			await originalMarkReturned(proof);
		};
		try {
			const append = harness.journal.append(createStartAppendInput(harness, "event-in-flight-return-proof"));
			await markReturnedReached;
			let replaySettled = false;
			const replay = harness.journal.replay().finally(() => {
				replaySettled = true;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			expect(replaySettled).toBe(false);

			releaseReturnProof();
			const [event, events] = await Promise.all([append, replay]);
			expect(events).toHaveLength(1);
			expect(events[0]?.eventDigest).toBe(event.eventDigest);
		} finally {
			releaseReturnProof();
			await harness.close();
		}
	});

	it("replays the stable head while an append waits for the caller-owned lease", async () => {
		const harness = await createJournalHarness("workflow-replay-while-append-waits-for-lease");
		let appendCompletion = Promise.resolve();
		try {
			await harness.appendLease.withExclusiveGuard(
				{
					workflowId: harness.workflowId,
					writerIdentity: harness.writerIdentity,
					leaseRef: harness.leaseRef,
					epochRef: harness.epoch,
					rootDigest: harness.leaseRef.rootDigest,
					boundary: "test-replay-while-append-waits-for-lease",
				},
				async () => {
					appendCompletion = harness.journal
						.append(createStartAppendInput(harness, "event-waiting-for-lease"))
						.then(() => undefined);
					await new Promise<void>((resolve) => setTimeout(resolve, 10));
					const replay = await Promise.race([
						harness.journal.replay(),
						new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
					]);
					expect(replay).toEqual([]);
				},
			);
			await appendCompletion;
			expect(await harness.journal.replay()).toHaveLength(1);
		} finally {
			await appendCompletion.catch(() => undefined);
			await harness.close();
		}
	});

	it("rejects authenticated active-generation shape mutations across repeated opens", async () => {
		const harness = await createJournalHarness("workflow-active-shape");
		let closed = false;
		try {
			const activePath = join(harness.workflowDir, "side-records", "active-generation.json");
			const active = JSON.parse(await readFile(activePath, "utf8")) as Record<string, unknown>;
			const epochRef = active.epochRef as Record<string, unknown>;
			active.epochRef = { ...epochRef, unexpected: true };
			active.sideRecordMac = authenticateTestSideRecord(active).sideRecordMac;
			await writeFile(activePath, JSON.stringify(active));
			await closeJournalDescriptors(harness.journal);
			closed = true;
			for (let attempt = 0; attempt < 3; attempt += 1)
				await expect(WorkflowJournal.open(harness.options)).rejects.toThrow(
					/closed durable map|active-generation/i,
				);
		} finally {
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("rejects a validly re-MACed return proof with a malformed nested expected head", async () => {
		const harness = await createJournalHarness("workflow-return-proof-shape");
		try {
			const input = createStartAppendInput(harness, "return-proof-shape");
			await harness.journal.append(input);
			const proofPath = join(harness.workflowDir, "side-records", "return-proofs", `${input.returnProofId}.json`);
			const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
			const pending = proof.pending as Record<string, unknown>;
			pending.expectedHead = { ...(pending.expectedHead as Record<string, unknown>), unexpected: true };
			proof.sideRecordMac = authenticateTestSideRecord(proof).sideRecordMac;
			await writeFile(proofPath, canonicalJsonBytes(proof));
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("quarantines a prepared-only tail after a post-flush crash boundary", async () => {
		const harness = await createJournalHarness("workflow-prepared-tail");
		try {
			await expect(
				harness.journal.append({
					...createStartAppendInput(harness, "event-prepared-tail"),
					crashHook: {
						checkpoint: DurableStoreCrashBoundary.afterPreparedFileFlushBeforeCommittedMarkerAppend,
						before: async () => {
							throw new Error("simulated crash");
						},
						after: async () => undefined,
					},
				}),
			).rejects.toThrow(/simulated crash/i);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "prepared_only", reason: "prepared_without_commit" },
			});
		} finally {
			await harness.close();
		}
	});

	it("quarantines a committed journal marker when the directory-flush crash boundary fires", async () => {
		const harness = await createJournalHarness("workflow-committed-crash");
		try {
			await expect(
				harness.journal.append({
					...createStartAppendInput(harness, "event-committed-crash"),
					crashHook: {
						checkpoint: DurableStoreCrashBoundary.afterCommittedFileFlushBeforeDirectoryFlush,
						before: async () => {
							throw new Error("simulated committed crash");
						},
						after: async () => undefined,
					},
				}),
			).rejects.toThrow(/simulated committed crash|durably proven/i);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("publishes an authenticated snapshot through real descriptor fsync boundaries", async () => {
		const harness = await createJournalHarness("workflow-snapshot");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-snapshot"));
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				sourceEventDigest: null,
				stateDigest: null,
				epochRef: harness.epoch,
			};
			const tuple = createAuthenticatedTuple(event, {
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
				idempotencyKey: "snapshot-1",
			});
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				sourceEventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				stateBytes: new TextEncoder().encode("state"),
				stateDigest: sha256Hex(new TextEncoder().encode("state")),
				idempotencyKey: "snapshot-1",
				authenticatedTuple: tuple,
			};
			const snapshot = WorkflowSnapshotStore.fromJournal(harness.journal);
			await expect(snapshot.publish(input)).resolves.toMatchObject({ status: "published", sequence: 1 });
			await expect(snapshot.publish(input)).resolves.toMatchObject({ status: "already_published", sequence: 1 });
			const snapshotHeadPath = join(harness.workflowDir, "snapshots", "HEAD");
			const snapshotHead = JSON.parse(await readFile(snapshotHeadPath, "utf8")) as Record<string, unknown>;
			snapshotHead.epochRef = { ...(snapshotHead.epochRef as Record<string, unknown>), unexpected: true };
			await writeFile(snapshotHeadPath, canonicalJsonBytes(snapshotHead));
			await expect(snapshot.publish(input)).rejects.toThrow(/snapshot head|closed/i);
			await expect(access(join(harness.workflowDir, "snapshots", "snapshot-1.bin"))).resolves.toBeUndefined();
		} finally {
			await harness.close();
		}
	});

	it("rejects a validly re-MACed snapshot envelope whose nonzero head has a null source digest", async () => {
		const harness = await createJournalHarness("workflow-snapshot-shape");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-snapshot-shape"));
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				sourceEventDigest: null,
				stateDigest: null,
				epochRef: harness.epoch,
			};
			const tuple = createAuthenticatedTuple(event, {
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
				idempotencyKey: "snapshot-shape",
			});
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				sourceEventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				stateBytes: new TextEncoder().encode("snapshot-shape"),
				stateDigest: sha256Hex(new TextEncoder().encode("snapshot-shape")),
				idempotencyKey: "snapshot-shape",
				authenticatedTuple: tuple,
			};
			const snapshot = WorkflowSnapshotStore.fromJournal(harness.journal);
			await snapshot.publish(input);
			const snapshotPath = join(harness.workflowDir, "snapshots", "snapshot-shape.bin");
			const envelope = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
			envelope.expectedHead = {
				...(envelope.expectedHead as Record<string, unknown>),
				sequence: 1,
				sourceEventDigest: null,
			};
			const unsigned = { ...envelope };
			delete unsigned.frameMac;
			delete unsigned.frameChecksum;
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			envelope.frameMac = createHmac("sha256", secret).update(canonicalJsonBytes(unsigned)).digest("hex");
			envelope.frameChecksum = createHash("sha256").update(canonicalJsonBytes(unsigned)).digest("hex").slice(0, 8);
			await writeFile(snapshotPath, canonicalJsonBytes(envelope));
			await expect(snapshot.publish(input)).rejects.toThrow(/snapshot frame|closed|source digest/i);
		} finally {
			await harness.close();
		}
	});

	it("rejects a snapshot publish input with a noncanonical source event digest before writing", async () => {
		const harness = await createJournalHarness("workflow-snapshot-source-digest");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-snapshot-source-digest"));
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				sourceEventDigest: null,
				stateDigest: null,
				epochRef: harness.epoch,
			};
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				sourceEventDigest: "not-a-canonical-digest",
				epochRef: harness.epoch,
				expectedHead,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				stateBytes: new TextEncoder().encode("snapshot-source-digest"),
				stateDigest: sha256Hex(new TextEncoder().encode("snapshot-source-digest")),
				idempotencyKey: "snapshot-source-digest",
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "snapshot-source-digest",
				}),
			};
			const snapshot = WorkflowSnapshotStore.fromJournal(harness.journal);
			await expect(snapshot.publish(input)).rejects.toThrow(/snapshot|source digest|authenticated/i);
			await expect(access(join(harness.workflowDir, "snapshots", "snapshot-source-digest.bin"))).rejects.toThrow();
		} finally {
			await harness.close();
		}
	});

	it("reopens cleanly after a snapshot file-flush crash boundary", async () => {
		const harness = await createJournalHarness("workflow-snapshot-crash");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-snapshot-crash"));
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				sourceEventDigest: null,
				stateDigest: null,
				epochRef: harness.epoch,
			};
			const tuple = createAuthenticatedTuple(event, {
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
				idempotencyKey: "snapshot-crash",
			});
			const stateBytes = new TextEncoder().encode("snapshot-crash");
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				sourceEventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				stateBytes,
				stateDigest: sha256Hex(stateBytes),
				idempotencyKey: "snapshot-crash",
				authenticatedTuple: tuple,
			};
			const snapshot = WorkflowSnapshotStore.fromJournal(harness.journal);
			await expect(
				snapshot.publish(input, {
					checkpoint: DurableStoreCrashBoundary.afterSnapshotFileFlushBeforeSnapshotRename,
					before: async () => {
						throw new Error("simulated snapshot crash");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated snapshot crash|durably proven/i);
			await expect(snapshot.publish(input)).resolves.toMatchObject({ status: "published", sequence: 1 });
		} finally {
			await harness.close();
		}
	});

	it("returns the same event for an idempotent append and rejects lease or path drift", async () => {
		const harness = await createJournalHarness("workflow-guards");
		try {
			const input = createStartAppendInput(harness, "event-guard");
			const first = await harness.journal.append(input);
			const retry = await harness.journal.append(input);
			expect(retry).toEqual(first);
			const before = await harness.journal.replay();
			await expect(
				harness.journal.append({
					...input,
					writerIdentity: "foreign-writer",
					leaseRef: { ...harness.leaseRef, writerIdentity: "foreign-writer" },
					idempotencyKey: "event-foreign",
					returnProofId: "return-proof:event-foreign",
				}),
			).rejects.toThrow(/lease|authenticated|writer/i);
			await expect(
				harness.journal.append({
					...input,
					idempotencyKey: "event-path/escape",
					returnProofId: "return-proof:event-path/escape",
				}),
			).rejects.toThrow(/safe|deterministic|lease|authenticated/i);
			expect(await harness.journal.replay()).toEqual(before);
		} finally {
			await harness.close();
		}
	});

	it("classifies a torn outbox frame and rejects authenticated corruption", async () => {
		const harness = await createJournalHarness("workflow-corruption");
		try {
			const input = createStartAppendInput(harness, "event-corruption");
			const event = await harness.journal.append(input);
			const outboxExpectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				entryDigest: null,
				epochRef: harness.epoch,
			};
			const tuple = createAuthenticatedTuple(event, {
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
				idempotencyKey: "outbox-1",
			});
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			const stateBytes = new TextEncoder().encode("state");
			await outbox.append({
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: outboxExpectedHead,
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-1",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: tuple,
			});
			const outboxPath = join(harness.workflowDir, "outbox", "events.log");
			const outboxBytes = await readFile(outboxPath);
			await writeFile(outboxPath, outboxBytes.subarray(0, outboxBytes.byteLength - 1));
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "partial_frame", reason: "tail_truncated" },
			});
		} finally {
			await harness.close();
		}
	});

	it("recovers multiple outbox entries without replacing the proofed log inode", async () => {
		const harness = await createJournalHarness("workflow-outbox-multi-entry");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-multi-entry"));
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			const firstBytes = new TextEncoder().encode("outbox-first");
			const firstInput = {
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-first",
				bytes: firstBytes,
				entryDigest: sha256Hex(firstBytes),
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "outbox-first",
				}),
			};
			await outbox.append(firstInput);
			const secondBytes = new TextEncoder().encode("outbox-second");
			const secondInput = {
				...firstInput,
				sequence: 2,
				idempotencyKey: "outbox-second",
				bytes: secondBytes,
				entryDigest: sha256Hex(secondBytes),
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 1,
					eventDigest: event.eventDigest,
					entryDigest: firstInput.entryDigest,
					epochRef: harness.epoch,
				},
				authenticatedTuple: {
					...firstInput.authenticatedTuple,
					sequence: 2,
					idempotencyKey: "outbox-second",
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 1,
						eventDigest: event.eventDigest,
						epochRef: harness.epoch,
					},
				},
			};
			await outbox.append(secondInput);
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: false,
				entries: [firstInput, secondInput],
				head: {
					sequence: 2,
					entryDigest: secondInput.entryDigest,
				},
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects an outbox frame whose authenticated tuple contains an unknown nested field", async () => {
		const harness = await createJournalHarness("workflow-outbox-shape");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-shape"));
			const stateBytes = new TextEncoder().encode("outbox-shape");
			const tuple = createAuthenticatedTuple(event, {
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
				idempotencyKey: "outbox-shape",
			});
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			await outbox.append({
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-shape",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: tuple,
			});
			const outboxPath = join(harness.workflowDir, "outbox", "events.log");
			const outboxBytes = await readFile(outboxPath);
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const tampered = rewriteAuthenticatedJsonFrame(outboxBytes, secret, (record) => {
				const authenticatedTuple = record.authenticatedTuple as Record<string, unknown>;
				record.authenticatedTuple = {
					...authenticatedTuple,
					expectedHead: { ...(authenticatedTuple.expectedHead as Record<string, unknown>), unexpected: true },
				};
			});
			await writeFile(outboxPath, tampered);
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "invalid_record", reason: "invalid_record" },
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects a validly re-MACed outbox frame with malformed persisted bytes", async () => {
		const harness = await createJournalHarness("workflow-outbox-bytes-shape");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-bytes-shape"));
			const stateBytes = new TextEncoder().encode("outbox-bytes-shape");
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			await outbox.append({
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-bytes-shape",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "outbox-bytes-shape",
				}),
			});
			const outboxPath = join(harness.workflowDir, "outbox", "events.log");
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const tampered = rewriteAuthenticatedJsonFrame(await readFile(outboxPath), secret, (record) => {
				record.bytes = [256];
			});
			await writeFile(outboxPath, tampered);
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "invalid_record", reason: "invalid_record" },
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects an outbox frame whose authenticated header workflow digest disagrees with its payload", async () => {
		const harness = await createJournalHarness("workflow-outbox-header-shape");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-header-shape"));
			const stateBytes = new TextEncoder().encode("outbox-header-shape");
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-header-shape",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "outbox-header-shape",
				}),
			};
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			await outbox.append(input);
			const outboxPath = join(harness.workflowDir, "outbox", "events.log");
			const outboxBytes = await readFile(outboxPath);
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const rewritten = rewriteAuthenticatedJsonFrame(
				outboxBytes,
				secret,
				() => undefined,
				(header) => {
					header[28] ^= 1;
				},
			);
			await rewriteTestFlushProof(
				join(
					harness.workflowDir,
					"side-records",
					"flush-proofs",
					`${sha256Hex(new TextEncoder().encode(`${input.idempotencyKey}:outbox`))}.json`,
				),
				rewritten,
			);
			await writeFile(outboxPath, rewritten);
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "invalid_record", reason: "invalid_record" },
			});
		} finally {
			await harness.close();
		}
	});

	it("replays a durably flushed outbox entry after the outbox crash boundary fires", async () => {
		const harness = await createJournalHarness("workflow-outbox-crash");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-crash"));
			const stateBytes = new TextEncoder().encode("outbox-crash");
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-crash",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "outbox-crash",
				}),
			};
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			await expect(
				outbox.append(input, {
					checkpoint: DurableStoreCrashBoundary.afterOutboxFileFlush,
					before: async () => {
						throw new Error("simulated outbox crash");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated outbox crash|durably proven/i);
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: false,
				entries: [input],
			});
		} finally {
			await harness.close();
		}
	});

	it("verifies an outbox flush proof against the encoded frame bytes rather than entryDigest", async () => {
		const harness = await createJournalHarness("workflow-outbox-proof-bytes");
		try {
			const event = await harness.journal.append(createStartAppendInput(harness, "event-outbox-proof-bytes"));
			const stateBytes = new TextEncoder().encode("outbox-proof-bytes");
			const input = {
				workflowId: harness.workflowId,
				sequence: 1,
				eventDigest: event.eventDigest,
				epochRef: harness.epoch,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: harness.epoch,
				},
				leaseRef: harness.leaseRef,
				writerIdentity: harness.writerIdentity,
				idempotencyKey: "outbox-proof-bytes",
				bytes: stateBytes,
				entryDigest: sha256Hex(stateBytes),
				authenticatedTuple: createAuthenticatedTuple(event, {
					expectedHead: {
						workflowId: harness.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: harness.epoch,
					},
					idempotencyKey: "outbox-proof-bytes",
				}),
			};
			const outbox = WorkflowOutboxStore.fromJournal(harness.journal);
			await outbox.append(input);
			const proofPath = join(
				harness.workflowDir,
				"side-records",
				"flush-proofs",
				`${sha256Hex(new TextEncoder().encode(`${input.idempotencyKey}:outbox`))}.json`,
			);
			const proof = JSON.parse(await readFile(proofPath, "utf8")) as Record<string, unknown>;
			proof.frameDigest = input.entryDigest;
			proof.proofDigest = digestObject({
				mutationId: proof.mutationId,
				frameKind: proof.frameKind,
				frameDigest: proof.frameDigest,
				fileIdentityDigest: proof.fileIdentityDigest,
				parentDirectoryIdentityDigest: proof.parentDirectoryIdentityDigest,
				fileSynced: true,
				parentDirectorySynced: true,
			});
			proof.sideRecordMac = authenticateTestSideRecord(proof).sideRecordMac;
			await writeFile(proofPath, canonicalJsonBytes(proof));
			await expect(outbox.recover(harness.epoch)).resolves.toMatchObject({
				quarantined: true,
				entries: [],
				metadata: { status: "invalid_record", reason: "invalid_record" },
			});
		} finally {
			await harness.close();
		}
	});

	it("quarantines a journal MAC break without exposing a replay prefix", async () => {
		const harness = await createJournalHarness("workflow-mac-break");
		try {
			await harness.journal.append(createStartAppendInput(harness, "event-mac-break"));
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const journalBytes = await readFile(generationPath);
			const corrupted = new Uint8Array(journalBytes);
			corrupted[corrupted.byteLength - 5] ^= 1;
			await writeFile(generationPath, corrupted);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "invalid_mac" },
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects an authenticated journal frame with an unknown nested semantic binding field", async () => {
		const harness = await createJournalHarness("workflow-frame-shape");
		try {
			const input = createStartAppendInput(harness, "event-frame-shape");
			await harness.journal.append(input);
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const journalBytes = await readFile(generationPath);
			const preparedFrameLength = Buffer.from(journalBytes).readUInt32BE(8);
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const rewrittenPrepared = rewriteAuthenticatedJsonFrame(
				journalBytes.subarray(0, preparedFrameLength),
				secret,
				(record) => {
					const semanticBinding = record.semanticBinding as Record<string, unknown>;
					record.semanticBinding = { ...semanticBinding, unexpected: true };
				},
			);
			const preparedProofPath = join(
				harness.workflowDir,
				"side-records",
				"flush-proofs",
				`${sha256Hex(new TextEncoder().encode(`${input.returnProofId}:prepared`))}.json`,
			);
			const preparedProof = JSON.parse(await readFile(preparedProofPath, "utf8")) as Record<string, unknown>;
			preparedProof.frameDigest = sha256Hex(rewrittenPrepared);
			preparedProof.proofDigest = digestObject({
				mutationId: preparedProof.mutationId,
				frameKind: preparedProof.frameKind,
				frameDigest: preparedProof.frameDigest,
				fileIdentityDigest: preparedProof.fileIdentityDigest,
				parentDirectoryIdentityDigest: preparedProof.parentDirectoryIdentityDigest,
				fileSynced: true,
				parentDirectorySynced: true,
			});
			preparedProof.sideRecordMac = authenticateTestSideRecord(preparedProof).sideRecordMac;
			await writeFile(preparedProofPath, canonicalJsonBytes(preparedProof));
			await writeFile(
				generationPath,
				Buffer.concat([Buffer.from(rewrittenPrepared), Buffer.from(journalBytes.subarray(preparedFrameLength))]),
			);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects a journal frame whose authenticated header workflow digest disagrees with its payload", async () => {
		const harness = await createJournalHarness("workflow-frame-header-shape");
		try {
			const input = createStartAppendInput(harness, "event-frame-header-shape");
			await harness.journal.append(input);
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const journalBytes = await readFile(generationPath);
			const preparedFrameLength = Buffer.from(journalBytes).readUInt32BE(8);
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const rewrittenPrepared = rewriteAuthenticatedJsonFrame(
				journalBytes.subarray(0, preparedFrameLength),
				secret,
				() => undefined,
				(header) => {
					header[28] ^= 1;
				},
			);
			await rewriteTestFlushProof(
				join(
					harness.workflowDir,
					"side-records",
					"flush-proofs",
					`${sha256Hex(new TextEncoder().encode(`${input.returnProofId}:prepared`))}.json`,
				),
				rewrittenPrepared,
			);
			await writeFile(
				generationPath,
				Buffer.concat([Buffer.from(rewrittenPrepared), Buffer.from(journalBytes.subarray(preparedFrameLength))]),
			);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects a validly reauthenticated journal frame with a mutated fixed binding digest", async () => {
		const harness = await createJournalHarness("workflow-frame-binding-shape");
		try {
			const input = createStartAppendInput(harness, "event-frame-binding-shape");
			await harness.journal.append(input);
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const journalBytes = await readFile(generationPath);
			const preparedFrameLength = Buffer.from(journalBytes).readUInt32BE(8);
			const secret = new TextEncoder().encode("workflow-journal-test-secret");
			const rewrittenPrepared = rewriteAuthenticatedJsonFrame(
				journalBytes.subarray(0, preparedFrameLength),
				secret,
				() => undefined,
				(header) => {
					header[60] ^= 1;
				},
			);
			await rewriteTestFlushProof(
				join(
					harness.workflowDir,
					"side-records",
					"flush-proofs",
					`${sha256Hex(new TextEncoder().encode(`${input.returnProofId}:prepared`))}.json`,
				),
				rewrittenPrepared,
			);
			await writeFile(
				generationPath,
				Buffer.concat([Buffer.from(rewrittenPrepared), Buffer.from(journalBytes.subarray(preparedFrameLength))]),
			);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("matches the fixed frame binding golden tuple for prior digest, payload digest, and writer", async () => {
		const harness = await createJournalHarness("workflow-frame-binding-golden");
		try {
			await harness.journal.append(createStartAppendInput(harness, "event-frame-binding-golden"));
			const generationPath = join(
				harness.workflowDir,
				"generations",
				harness.journal.descriptorContext.generationId,
				"events.log",
			);
			const journalBytes = await readFile(generationPath);
			const preparedFrameLength = Buffer.from(journalBytes).readUInt32BE(8);
			expect(Buffer.from(journalBytes.subarray(52, 64)).toString("hex")).toBe("03d2ecc48f8b12d6437d2b30");
			expect(
				Buffer.from(journalBytes.subarray(preparedFrameLength + 52, preparedFrameLength + 64)).toString("hex"),
			).toBe("995e99530407387efaa4113f");
		} finally {
			await harness.close();
		}
	});

	it("keeps immutable production golden frames for both PWFK and PAOB encoders", () => {
		const outboxVector = WORKFLOW_FRAME_GOLDEN_VECTORS.find((vector) => vector.name === "outbox_entry");
		if (outboxVector === undefined) throw new Error("The PAOB production golden vector is required.");
		expect(outboxVector.headerBytesHex.startsWith("50414f42")).toBe(true);
		expect(verifyWorkflowFrameGoldenVectors()).toBe(true);
	});

	it("rejects a journal frame whose file inode was replaced after its durable flush proof", async () => {
		const harness = await createJournalHarness("workflow-frame-inode-replacement");
		try {
			const input = createStartAppendInput(harness, "event-frame-inode-replacement");
			await harness.journal.append(input);
			const generationDir = join(harness.workflowDir, "generations", harness.journal.descriptorContext.generationId);
			const generationPath = join(generationDir, "events.log");
			const replacementPath = join(generationDir, "events.replacement");
			const journalBytes = await readFile(generationPath);
			await writeFile(replacementPath, journalBytes);
			await rename(replacementPath, generationPath);
			await expect(harness.journal.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "interior_corruption" },
			});
		} finally {
			await harness.close();
		}
	});

	it("keeps generation identities canonical for rotation ports", async () => {
		const harness = await createJournalHarness("workflow-rotation");
		try {
			const epoch = loadPersistedEpochFixture().acquired;
			const nextEpoch = { storeEpoch: epoch.storeEpoch + 1, coordinatorEpoch: epoch.coordinatorEpoch };
			const generationId = deriveWorkflowGenerationId({
				workflowId: "workflow-rotation",
				nextEpoch,
				rotationId: "rotation-1",
				priorHeadDigest: "head-digest",
			});
			expect(generationId).toMatch(/^generation-[0-9a-f]{32}$/);
			expect(deriveWorkflowGenerationPath(generationId)).toBe(`generations/${generationId}`);
			expect(harness.journal.currentLeaseRef()).toEqual(harness.leaseRef);
			expect(typeof harness.journal.rotateGeneration).toBe("function");
			expect(typeof harness.journal.rebindSuccessor).toBe("function");
			expect((await harness.journal.rotationStore.readActiveGeneration(harness.workflowId))?.generationId).toBe(
				harness.journal.descriptorContext.generationId,
			);
			expect(await harness.journal.rotationStore.resolve("missing-rotation")).toBeNull();
		} finally {
			await harness.close();
		}
	});

	it("returns immutable dual-key evidence for one unfinished rotation", async () => {
		const harness = await createJournalHarness("workflow-recovery-inspection");
		try {
			const { input, successorKey } = await createRotationRequest(harness, "recovery-inspection");
			const keyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = keyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider });
			await harness.journal.rotationStore.prepare({
				...input,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
			});

			const evidence = await inspectWorkflowJournalRecovery(harness.options);

			expect(evidence).not.toBeNull();
			if (evidence === null) throw new Error("Recovery inspection evidence is required.");
			expect(evidence.previous).toMatchObject({
				generationId: input.previousGenerationId,
				keyId: input.previousKeyId,
				epochRef: input.previousEpoch,
				writerIdentity: input.previousWriterIdentity,
				rootDigest: harness.journal.descriptorContext.rootDigest,
				leaseRef: input.previousLeaseRef,
				head: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
			});
			expect(evidence.successor).toMatchObject({
				generationId: input.generationId,
				keyId: input.keyId,
				epochRef: input.nextEpoch,
				writerIdentity: input.generationBinding.writerIdentity,
				rootDigest: input.nextLeaseRef.rootDigest,
				leaseRef: input.nextLeaseRef,
			});
			expect(input.generationBinding.ownerIdentity).toBe(input.generationBinding.writerIdentity);
			expect(evidence.previousKey).toMatchObject({
				keyId: input.previousKeyId,
				generationId: input.previousGenerationId,
				validStoreEpoch: input.previousEpoch.storeEpoch,
			});
			expect(evidence.successorKey).toEqual(successorKey);
			expect(evidence.rotation.lastCheckpoint).toBe("after_rotation_prepare_before_fence");
			expect(Object.isFrozen(evidence)).toBe(true);
		} finally {
			await harness.close();
		}
	});

	it("rejects a root-session or foreign writer substitution during rotation recovery", async () => {
		for (const [caseName, ownerKind] of [
			["root-session", "root"],
			["foreign-writer", "foreign"],
		] as const) {
			const successorKeys = new Map<number, WorkflowJournalKey>();
			const keyProvider = createTestKeyProviderWithOverrides(successorKeys);
			const harness = await createJournalHarness(`workflow-owner-substitution-${caseName}`, keyProvider);
			try {
				const ownerIdentity = ownerKind === "root" ? harness.rootSessionId : "foreign-writer";
				const { input, successorKey } = await createRotationRequest(
					harness,
					`owner-substitution-${caseName}`,
					ownerIdentity,
				);
				successorKeys.set(successorKey.validStoreEpoch, successorKey);
				harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
				harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
				await expect(harness.journal.rotateGeneration(input)).rejects.toThrow(
					/owner|writer|binding|authenticated|preflight/i,
				);
			} finally {
				await harness.close();
			}
		}
	});

	it("rejects a root-session owner substitution while inspecting unfinished recovery", async () => {
		const successorKeys = new Map<number, WorkflowJournalKey>();
		const keyProvider = createTestKeyProviderWithOverrides(successorKeys);
		const harness = await createJournalHarness("workflow-owner-recovery-substitution", keyProvider);
		try {
			const { input, successorKey } = await createRotationRequest(
				harness,
				"owner-recovery-substitution",
				harness.rootSessionId,
			);
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			await harness.journal.rotationStore.prepare({
				...input,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
			});
			await expect(inspectWorkflowJournalRecovery(harness.journal)).rejects.toThrow(
				/owner|writer|binding|authenticated|closed durable map/i,
			);
		} finally {
			await harness.close();
		}
	});

	it("fails closed when an unfinished rotation is missing", async () => {
		const keyProvider = createMultiGenerationKeyProvider();
		const harness = await createJournalHarness("workflow-recovery-missing-rotation", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		try {
			harness.journal.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			await harness.journal.append(createStartAppendInput(harness, "missing-rotation-start"));
			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 1, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			await closeJournalDescriptors(harness.journal);
			await unlink(join(harness.workflowDir, "side-records", "rotations", "records.json"));
			reopened = await WorkflowJournal.open(harness.options);
			await expect(reopened.replay()).rejects.toThrow(/rotation|predecessor|chain|manifest/i);
			await expect(reopened.replayLogicalHistory()).rejects.toThrow(/rotation|predecessor|chain|manifest/i);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("fails closed for duplicate or tampered unfinished rotations", async () => {
		const harness = await createJournalHarness("workflow-recovery-duplicate-rotation");
		try {
			const { input, successorKey } = await createRotationRequest(harness, "recovery-duplicate");
			const keyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = keyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider });
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			await harness.journal.rotationStore.prepare({ ...input, expectedHead });
			await harness.journal.rotationStore.prepare({
				...input,
				rotationId: "recovery-duplicate-second",
				mutationId: "recovery-duplicate-second-mutation",
				idempotencyKey: "recovery-duplicate-second-idempotency",
				expectedHead,
			});
			await expect(inspectWorkflowJournalRecovery(harness.journal)).rejects.toThrow(/one|multiple|duplicate/i);

			const recordsPath = join(harness.workflowDir, "side-records", "rotations", "records.json");
			const records = JSON.parse(await readFile(recordsPath, "utf8")) as Record<string, Record<string, unknown>>;
			const record = records[input.rotationId];
			if (record === undefined) throw new Error("Prepared rotation record is required.");
			const request = record.request;
			if (typeof request !== "object" || request === null || Array.isArray(request))
				throw new Error("Prepared rotation request is required.");
			const requestRecord = request as Record<string, unknown>;
			const nextLeaseRef = requestRecord.nextLeaseRef;
			if (typeof nextLeaseRef !== "object" || nextLeaseRef === null || Array.isArray(nextLeaseRef))
				throw new Error("Prepared rotation lease reference is required.");
			requestRecord.nextLeaseRef = {
				...(nextLeaseRef as Record<string, unknown>),
				writerIdentity: "tampered-writer",
			};
			await writeFile(recordsPath, canonicalJsonBytes(records));
			await expect(inspectWorkflowJournalRecovery(harness.journal)).rejects.toThrow(
				/authenticated|rotation|MAC|tuple/i,
			);
		} finally {
			await harness.close();
		}
	});

	it("fails closed when either rotation key resolves to a mismatched generation", async () => {
		const harness = await createJournalHarness("workflow-recovery-key-mismatch");
		try {
			const { input, successorKey } = await createRotationRequest(harness, "recovery-key-mismatch");
			const rotationKeyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = rotationKeyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: rotationKeyProvider });
			await harness.journal.rotationStore.prepare({
				...input,
				expectedHead: {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				},
			});
			const mismatched: WorkflowJournalKeyProvider = {
				current: rotationKeyProvider.current,
				resolve: async (workflowId, keyId, epoch) => {
					const key = await rotationKeyProvider.resolve(workflowId, keyId, epoch);
					return { ...key, generationId: `generation-${"f".repeat(32)}` };
				},
			};
			harness.options.keyProvider = mismatched;
			await expect(inspectWorkflowJournalRecovery(harness.journal)).rejects.toThrow(/key|generation|tuple/i);
		} finally {
			await harness.close();
		}
	});

	it("persists an exact rotation artifact reference and rejects a missing artifact", async () => {
		const harness = await createJournalHarness("workflow-rotation-artifact-ref");
		try {
			const { input } = await createRotationRequest(harness, "rotation-artifact-ref");
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			const artifactRef = await harness.journal.rotationStore.prepare({ ...input, expectedHead });
			const artifactPath = join(harness.workflowDir, "side-records", "rotations", `${input.rotationId}.json`);
			const artifactBytes = await readFile(artifactPath);
			expect(artifactRef.relativePath).toBe(`rotations/${input.rotationId}.json`);
			expect(artifactRef.sizeBytes).toBe(artifactBytes.byteLength);
			expect(artifactRef.digest).toBe(sha256Hex(artifactBytes));
			await unlink(artifactPath);
			await expect(harness.journal.rotationStore.resolve(input.rotationId)).rejects.toThrow(
				/rotation artifact|artifact reference|missing/i,
			);
		} finally {
			await harness.close();
		}
	});

	it.each(["", "rotation/id", ".."])(
		"rejects noncanonical rotation id %j before prepare persists it",
		async (rotationId) => {
			const harness = await createJournalHarness(`workflow-rotation-id-${rotationId.length}`);
			try {
				const { input } = await createRotationRequest(harness, "rotation-valid-for-id-check");
				const expectedHead = {
					workflowId: harness.workflowId,
					sequence: 0,
					eventDigest: null,
					epochRef: harness.epoch,
				};
				const generationId = deriveWorkflowGenerationId({
					workflowId: harness.workflowId,
					nextEpoch: input.nextEpoch,
					rotationId,
					priorHeadDigest: input.expectedHeadDigest,
				});
				await expect(
					harness.journal.rotationStore.prepare({
						...input,
						rotationId,
						generationId,
						activeGenerationManifestRef: {
							...input.activeGenerationManifestRef,
							relativePath: `${deriveWorkflowGenerationPath(generationId)}/ACTIVE`,
						},
						expectedHead,
					}),
				).rejects.toThrow(/rotation|identifier|safe|canonical/i);
				const recordsPath = join(harness.workflowDir, "side-records", "rotations", "records.json");
				await expect(access(recordsPath)).rejects.toThrow(/ENOENT|no such file/i);
			} finally {
				await harness.close();
			}
		},
	);

	it("quarantines a prepared rotation after a crash checkpoint and reopens with the predecessor key", async () => {
		const harness = await createJournalHarness("workflow-rotation-crash");
		let closed = false;
		let reopened: WorkflowJournalImpl | null = null;
		try {
			const { input, successorKey } = await createRotationRequest(harness, "rotation-crash");
			const rotationKeyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = rotationKeyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: rotationKeyProvider });
			const active = await harness.journal.rotationStore.readActiveGeneration(harness.workflowId);
			expect(active).not.toBeNull();
			if (active !== null) {
				expect(input.previousGenerationId).toBe(active.generationId);
				const predecessorKey = await harness.options.keyProvider.resolve(
					harness.workflowId,
					active.keyId,
					active.epochRef,
				);
				expect(predecessorKey).toMatchObject({
					keyId: active.keyId,
					generationId: active.generationId,
					validStoreEpoch: active.epochRef.storeEpoch,
				});
			}
			expect(input.generationId).toBe(successorKey.generationId);
			const resolvedSuccessorKey = await harness.options.keyProvider.resolve(
				harness.workflowId,
				input.keyId,
				input.nextEpoch,
			);
			expect(resolvedSuccessorKey).toMatchObject({
				keyId: input.keyId,
				generationId: input.generationId,
				validStoreEpoch: input.nextEpoch.storeEpoch,
			});
			await expect(
				harness.journal.rotateGeneration(input, {
					checkpoint: DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
					before: async () => {
						throw new Error("simulated rotation crash");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated rotation crash|durably proven/i);
			await closeJournalDescriptors(harness.journal);
			closed = true;
			reopened = await WorkflowJournal.open(harness.options);
			await expect(reopened.rotationStore.resolve(input.rotationId)).resolves.toMatchObject({
				state: "quarantined",
				quarantineReason: "rotation_prepared_only",
			});
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("rejects a validly re-MACed rotation file with an unknown nested epoch field", async () => {
		const harness = await createJournalHarness("workflow-rotation-shape");
		let closed = false;
		let reopened: WorkflowJournalImpl | null = null;
		try {
			const { input, successorKey } = await createRotationRequest(harness, "rotation-shape");
			const rotationKeyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = rotationKeyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: rotationKeyProvider });
			await expect(
				harness.journal.rotateGeneration(input, {
					checkpoint: DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
					before: async () => {
						throw new Error("simulated rotation crash");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated rotation crash|durably proven/i);
			await closeJournalDescriptors(harness.journal);
			closed = true;
			const recordsPath = join(harness.workflowDir, "side-records", "rotations", "records.json");
			const records = JSON.parse(await readFile(recordsPath, "utf8")) as Record<string, unknown>;
			const rotationRecord = records[input.rotationId] as Record<string, unknown>;
			const request = rotationRecord.request as Record<string, unknown>;
			request.nextEpoch = { ...(request.nextEpoch as Record<string, unknown>), unexpected: true };
			rotationRecord.sideRecordMac = authenticateTestSideRecord(rotationRecord).sideRecordMac;
			await writeFile(recordsPath, canonicalJsonBytes(records));
			reopened = await WorkflowJournal.open(harness.options);
			await expect(reopened.rotationStore.resolve(input.rotationId)).rejects.toThrow(
				/closed durable map|rotation side record/i,
			);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("returns typed quarantine metadata for malformed authenticated rotation side records", async () => {
		const successorKeys = new Map<number, WorkflowJournalKey>();
		const harness = await createJournalHarness(
			"workflow-rotation-recovery-shape",
			createTestKeyProviderWithOverrides(successorKeys),
		);
		let closed = false;
		let reopened: WorkflowJournalImpl | null = null;
		try {
			const { input, successorKey } = await createRotationRequest(harness, "rotation-recovery-shape");
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			await expect(
				harness.journal.rotateGeneration(input, {
					checkpoint: DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
					before: async () => {
						throw new Error("simulated rotation recovery-shape crash");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated rotation|durably proven/i);
			await closeJournalDescriptors(harness.journal);
			closed = true;
			const recordsPath = join(harness.workflowDir, "side-records", "rotations", "records.json");
			const records = JSON.parse(await readFile(recordsPath, "utf8")) as Record<string, unknown>;
			const rotationRecord = records[input.rotationId] as Record<string, unknown>;
			const request = rotationRecord.request as Record<string, unknown>;
			request.nextEpoch = { ...(request.nextEpoch as Record<string, unknown>), unexpected: true };
			rotationRecord.sideRecordMac = authenticateTestSideRecord(rotationRecord).sideRecordMac;
			await writeFile(recordsPath, canonicalJsonBytes(records));
			reopened = await WorkflowJournal.open(harness.options);
			await expect(reopened.recover()).resolves.toMatchObject({
				quarantined: true,
				events: [],
				metadata: { status: "partial_frame", reason: "rotation_fence_chain_break" },
			});
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it.each([
		["manifest", DurableStoreCrashBoundary.afterRotationManifestBeforeCommit],
		["commit", DurableStoreCrashBoundary.afterRotationCommitBeforeRetire],
	] as const)("quarantines rotation after the %s crash checkpoint", async (_name, checkpoint) => {
		const harness = await createJournalHarness(`workflow-rotation-${checkpoint}`);
		try {
			const { input, successorKey } = await createRotationRequest(harness, `rotation-${checkpoint}`);
			const rotationKeyProvider = createRotationKeyProvider(successorKey);
			harness.options.keyProvider = rotationKeyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: rotationKeyProvider });
			await expect(
				harness.journal.rotateGeneration(input, {
					checkpoint,
					before: async () => {
						throw new Error(`simulated rotation ${checkpoint} crash`);
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/simulated rotation|durably proven/i);
			await expect(harness.journal.rotationStore.resolve(input.rotationId)).resolves.toMatchObject({
				state: "quarantined",
				quarantineReason: "rotation_commit_uncertain",
			});
		} finally {
			await harness.close();
		}
	});

	it("rotates, rebinds to a successor generation, closes, and reopens the successor", async () => {
		const successorKeys = new Map<number, WorkflowJournalKey>();
		const predecessorProvider = createTestKeyProviderWithOverrides(successorKeys);
		const harness = await createJournalHarness("workflow-rotation-success", predecessorProvider);
		let reopened: WorkflowJournalImpl | null = null;
		let closed = false;
		try {
			const { input, successorKey } = await createRotationRequest(harness, "rotation-success");
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			const successorProvider = createRotationKeyProvider(successorKey);
			harness.options.successorContextOpener = {
				openSuccessor: async ({ rotation }) => {
					predecessorProvider.disableOverrides();
					const successorAppendLease = createTestAppendLease(
						rotation.nextLeaseRef,
						rotation.generationBinding.writerIdentity,
						[rotation.nextLeaseRef.rootDigest, harness.journal.descriptorContext.workflow.identityDigest],
					);
					const successorOptions: WorkflowJournalOptions = {
						...harness.options,
						keyProvider: successorProvider,
						epoch: rotation.nextEpoch,
						writerIdentity: rotation.generationBinding.writerIdentity,
						leaseRef: rotation.nextLeaseRef,
						appendLease: successorAppendLease,
						successorContextOpener: {
							openSuccessor: async () => {
								throw new Error("nested successor generation is not used by this test");
							},
						},
					};
					const successorJournal = await WorkflowJournal.open(successorOptions);
					const replayHead = {
						workflowId: rotation.expectedHead.workflowId,
						sequence: rotation.fenceEventSequence,
						eventDigest: rotation.fenceEventDigest,
						epochRef: rotation.nextEpoch,
					};
					const successorStorage = {
						...successorJournal.storage,
						append: async () => undefined,
						read: async () => successorJournal.storage.readJournalBytes(),
						sync: async () => undefined,
					};
					const successorContext: WorkflowGenerationContext & {
						workflowId: string;
						rootSessionId: string;
						rootDigest: string;
						successorKeyId: string;
						successorKeyProvider: WorkflowJournalKeyProvider;
						successorBinding: {
							generationId: string;
							epochRef: WorkflowEpochRef;
							leaseRef: WorkflowLeaseRef;
							writerIdentity: string;
						};
						bindSuccessor(input: {
							generationId: string;
							epochRef: WorkflowEpochRef;
							leaseRef: WorkflowLeaseRef;
							writerIdentity: string;
						}): void;
					} = {
						workflowId: harness.workflowId,
						rootSessionId: harness.rootSessionId,
						rootDigest: harness.journal.descriptorContext.rootDigest,
						successorKeyId: successorKey.keyId,
						successorKeyProvider: successorProvider,
						successorBinding: {
							generationId: rotation.generationId,
							epochRef: rotation.nextEpoch,
							leaseRef: rotation.nextLeaseRef,
							writerIdentity: rotation.generationBinding.writerIdentity,
						},
						bindSuccessor: (next) => {
							successorContext.successorBinding = next;
						},
						descriptorContext: successorJournal.descriptorContext,
						storage: successorStorage,
						returnProofStore: successorJournal.returnProofStore,
						rotationStore: successorJournal.rotationStore,
						replayHead,
						seededStateDigest: digestObject({ generationId: rotation.generationId, replayHead }),
						appendSuccessorFence: async () => {
							throw new Error("The predecessor generation fence is the sole authenticated transition event.");
						},
					};
					return successorContext;
				},
			};
			const rotation = await harness.journal.rotateGeneration(input);
			expect(rotation.status).toBe("committed");
			expect(harness.journal.options.keyProvider).toBe(successorProvider);
			expect(harness.journal.descriptorContext.generationId).toBe(input.generationId);
			expect(harness.journal.options.epoch).toEqual(input.nextEpoch);
			expect(await harness.journal.replay()).toEqual([]);
			const successorHead = {
				workflowId: rotation.expectedHead.workflowId,
				sequence: rotation.fenceEventSequence,
				eventDigest: rotation.fenceEventDigest,
				epochRef: rotation.nextEpoch,
			};
			const successorInput = createAppendAfterRebindInput(harness, successorHead, "event-after-rebind");
			await expect(harness.journal.append(successorInput)).resolves.toMatchObject({ sequence: 2 });
			await closeJournalDescriptors(harness.journal);
			closed = true;
			reopened = await WorkflowJournal.open(harness.options);
			expect(reopened.descriptorContext.generationId).toBe(input.generationId);
			expect((await reopened.replay()).map((event) => event.kind)).toEqual(["workflow_started"]);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("uses the public successor opener to rotate, rebind, append, and reopen on a real root", async () => {
		const successorKeys = new Map<number, WorkflowJournalKey>();
		const keyProvider = createTestKeyProviderWithOverrides(successorKeys);
		const harness = await createJournalHarness("workflow-public-successor-opener", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		let closed = false;
		try {
			const { input, successorKey } = await createRotationRequest(harness, "public-successor-opener");
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);

			const rotation = await harness.journal.rotateGeneration(input);
			expect(rotation.status).toBe("committed");
			expect(harness.journal.descriptorContext.generationId).toBe(rotation.generationId);
			expect(harness.journal.options.epoch).toEqual(rotation.nextEpoch);
			const fence = {
				workflowId: rotation.expectedHead.workflowId,
				sequence: rotation.fenceEventSequence,
				eventDigest: rotation.fenceEventDigest,
				epochRef: rotation.nextEpoch,
			};
			await expect(
				harness.journal.append(createAppendAfterRebindInput(harness, fence, "public-successor-event")),
			).resolves.toMatchObject({ sequence: 2 });

			await closeJournalDescriptors(harness.journal);
			closed = true;
			reopened = await WorkflowJournal.open(harness.options);
			expect(reopened.descriptorContext.generationId).toBe(rotation.generationId);
			expect((await reopened.replay()).map((event) => event.kind)).toEqual(["workflow_started"]);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			if (!closed) await harness.close();
			await rm(harness.root, { recursive: true, force: true });
		}
	});

	it("preserves workflow state across a coordinator epoch rotation and successor reopen", async () => {
		const harness = await createJournalHarness("workflow-store-coordinator-rotation");
		let reopened: WorkflowJournalImpl | null = null;
		try {
			const initialEvent = await harness.journal.append(createStartAppendInput(harness, "coordinator-start"));
			const initialHead = {
				workflowId: harness.workflowId,
				sequence: initialEvent.sequence,
				eventDigest: initialEvent.eventDigest,
				epochRef: harness.epoch,
			};
			const continuityPayload = {
				kind: "continuity_capsule_published" as const,
				capsuleDigest: "a".repeat(64),
			};
			await harness.journal.append({
				workflowId: harness.workflowId,
				payload: continuityPayload,
				expectedHead: initialHead,
				epochRef: harness.epoch,
				leaseRef: harness.leaseRef,
				idempotencyKey: "coordinator-continuity",
				writerIdentity: harness.writerIdentity,
				executionKey: null,
				semanticBinding: {
					mutationId: "coordinator-continuity",
					baselineDigest: digestObject(initialHead),
					expectedGenerations: { [harness.journal.descriptorContext.generationId]: harness.epoch.storeEpoch },
					ownerId: "workflow-test",
					phase: "recovering",
					reducerDigest: digestObject(continuityPayload),
					semanticHead: {
						...initialHead,
						stateDigest: digestObject(initialHead),
						generation: harness.epoch.storeEpoch,
					},
					expectedHead: initialHead,
					idempotencyKey: "coordinator-continuity",
					executionKey: null,
					writerIdentity: harness.writerIdentity,
					leaseRef: harness.leaseRef,
					epochRef: harness.epoch,
				},
				returnProofId: "return-proof:coordinator-continuity",
			});

			const successorKeyProvider = createCoordinatorRotationKeyProvider(harness);
			harness.options.keyProvider = successorKeyProvider;
			Object.assign(harness.journal.descriptorContext, { keyProvider: successorKeyProvider });
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
			harness.options.appendLease = createAppendLeaseReadyAfterRotation(harness.appendLease, successorKeyProvider);
			harness.journal.options.appendLease = harness.options.appendLease;

			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			const before = store.snapshot();
			if (before === null) throw new Error("Workflow store did not replay its initial history.");
			await store.replaceCoordinatorEpoch(
				{ storeEpoch: harness.epoch.storeEpoch, coordinatorEpoch: harness.epoch.coordinatorEpoch + 1 },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			const after = store.snapshot();
			if (after === null) throw new Error("Workflow store lost its state after coordinator rotation.");
			expect(after).toMatchObject({
				workflowId: before.workflowId,
				rootSessionId: before.rootSessionId,
				objective: before.objective,
				status: before.status,
				phase: before.phase,
				continuityCapsuleDigest: before.continuityCapsuleDigest,
				storeEpoch: before.storeEpoch,
				coordinatorEpoch: before.coordinatorEpoch + 1,
				generationBinding: {
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			});
			expect(after.sourceJournalSequence).toBe(before.sourceJournalSequence + 1);
			expect(after.sourceJournalDigest).not.toBe(before.sourceJournalDigest);

			await harness.journal.descriptorContext.workflow.close();
			await harness.journal.descriptorContext.root.close();
			reopened = await WorkflowJournal.open(harness.options);
			const reopenedStore = await WorkflowStore.open(reopened, harness.rootSessionId);
			expect(reopenedStore.snapshot()).toEqual(after);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("replays the exact workflow state across two successor generations", async () => {
		const keyProvider = createMultiGenerationKeyProvider();
		const harness = await createJournalHarness("workflow-logical-two-generations", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		try {
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
			await harness.journal.append(createStartAppendInput(harness, "logical-two-generations-start"));
			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 1, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 2, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-3",
					processGenerationId: "process-generation-3",
					ownerIdentity: "writer-3",
				},
			);
			const expected = store.snapshot();
			if (expected === null) throw new Error("Two-generation workflow replay lost its state.");
			expect((await store.journal.replayLogicalHistory()).map((event) => event.kind)).toEqual([
				"workflow_started",
				"store_generation_fenced",
				"store_generation_fenced",
			]);
			await closeJournalDescriptors(harness.journal);
			reopened = await WorkflowJournal.open(harness.options);
			const reopenedStore = await WorkflowStore.open(reopened, harness.rootSessionId);
			expect(reopenedStore.snapshot()).toEqual(expected);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("rejects logical replay when a predecessor generation log is missing", async () => {
		const keyProvider = createMultiGenerationKeyProvider();
		const harness = await createJournalHarness("workflow-logical-missing-predecessor-log", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		const predecessorGenerationId = harness.journal.descriptorContext.generationId;
		try {
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
			await harness.journal.append(createStartAppendInput(harness, "logical-missing-log-start"));
			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 1, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 2, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-3",
					processGenerationId: "process-generation-3",
					ownerIdentity: "writer-3",
				},
			);
			await closeJournalDescriptors(harness.journal);
			await unlink(join(harness.workflowDir, "generations", predecessorGenerationId, "events.log"));
			reopened = await WorkflowJournal.open(harness.options);
			await expect(WorkflowStore.open(reopened, harness.rootSessionId)).rejects.toThrow(
				/predecessor|generation|journal|history/i,
			);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("rejects logical replay when a predecessor generation key is unavailable", async () => {
		const keyProvider = createMultiGenerationKeyProvider();
		const harness = await createJournalHarness("workflow-logical-missing-predecessor-key", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		const predecessorGenerationId = harness.journal.descriptorContext.generationId;
		try {
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
			await harness.journal.append(createStartAppendInput(harness, "logical-missing-key-start"));
			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 1, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 2, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-3",
					processGenerationId: "process-generation-3",
					ownerIdentity: "writer-3",
				},
			);
			keyProvider.rejectGeneration(predecessorGenerationId);
			await closeJournalDescriptors(harness.journal);
			reopened = await WorkflowJournal.open(harness.options);
			await expect(WorkflowStore.open(reopened, harness.rootSessionId)).rejects.toThrow(
				/key|generation|predecessor/i,
			);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("rejects a reauthenticated predecessor manifest whose source head disagrees with its rotation", async () => {
		const keyProvider = createMultiGenerationKeyProvider();
		const harness = await createJournalHarness("workflow-logical-tampered-predecessor-manifest", keyProvider);
		let reopened: WorkflowJournalImpl | null = null;
		let predecessorGenerationId = harness.journal.descriptorContext.generationId;
		try {
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			harness.journal.options.successorContextOpener = harness.options.successorContextOpener;
			await harness.journal.append(createStartAppendInput(harness, "logical-tampered-manifest-start"));
			const store = await WorkflowStore.open(harness.journal, harness.rootSessionId);
			const firstRotation = await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 1, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-2",
					processGenerationId: "process-generation-2",
					ownerIdentity: "writer-2",
				},
			);
			predecessorGenerationId = firstRotation.generationId;
			await store.replaceStoreEpoch(
				{ storeEpoch: harness.epoch.storeEpoch + 2, coordinatorEpoch: harness.epoch.coordinatorEpoch },
				{
					writerIdentity: "writer-3",
					processGenerationId: "process-generation-3",
					ownerIdentity: "writer-3",
				},
			);
			await closeJournalDescriptors(harness.journal);
			const manifestPath = join(harness.workflowDir, "generations", predecessorGenerationId, "ACTIVE");
			const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
			const sourceHead = manifest.sourceHead as Record<string, unknown>;
			manifest.sourceHead = { ...sourceHead, eventDigest: "b".repeat(64) };
			const manifestRef = manifest.manifestRef as Record<string, unknown>;
			const unsignedManifest = {
				...manifest,
				manifestRef: { ...manifestRef, digest: "", sizeBytes: 0 },
				manifestBytesDigest: "",
				sideRecordMac: "",
			};
			const manifestDigest = sha256Hex(canonicalJsonBytes(unsignedManifest));
			manifest.manifestRef = { ...manifestRef, digest: manifestDigest };
			manifest.manifestBytesDigest = manifestDigest;
			manifest.sideRecordMac = createHmac("sha256", new TextEncoder().encode("workflow-journal-test-secret"))
				.update(canonicalJsonBytes({ ...manifest, sideRecordMac: "" }))
				.digest("hex");
			await writeFile(manifestPath, canonicalJsonBytes(manifest));
			reopened = await WorkflowJournal.open(harness.options);
			await expect(WorkflowStore.open(reopened, harness.rootSessionId)).rejects.toThrow(
				/manifest|predecessor|rotation|head/i,
			);
		} finally {
			if (reopened !== null) await closeJournalDescriptors(reopened);
			await harness.close();
		}
	});

	it("rejects foreign and tampered rotations before the public successor opener opens descriptors", async () => {
		const harness = await createJournalHarness("workflow-public-opener-validation");
		try {
			const { input } = await createRotationRequest(harness, "public-opener-validation");
			const expectedHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			const rotation = {
				...input,
				expectedHead,
				status: "committed" as const,
				fenceEventSequence: 1,
				fenceEventDigest: "a".repeat(64),
				rotationArtifactRef: input.activeGenerationManifestRef,
			} satisfies Parameters<WorkflowGenerationContextOpener["openSuccessor"]>[0]["rotation"];
			const opener = createWorkflowGenerationContextOpener(harness.options);
			await expect(
				opener.openSuccessor({
					workflowId: "foreign-workflow",
					rootSessionId: harness.rootSessionId,
					rotation,
					predecessorHead: expectedHead,
					predecessorRootDigest: harness.journal.descriptorContext.rootDigest,
				}),
			).rejects.toThrow(/workflow|foreign/i);
			const tamperedRotation = {
				...rotation,
				expectedHead: { ...expectedHead, sequence: 1 },
			};
			await expect(
				opener.openSuccessor({
					workflowId: harness.workflowId,
					rootSessionId: harness.rootSessionId,
					rotation: tamperedRotation,
					predecessorHead: expectedHead,
					predecessorRootDigest: harness.journal.descriptorContext.rootDigest,
				}),
			).rejects.toThrow(/head|generation|predecessor/i);
		} finally {
			await harness.close();
		}
	});

	it("quarantines a crash before public successor binding and reopens only through authenticated recovery", async () => {
		const successorKeys = new Map<number, WorkflowJournalKey>();
		const keyProvider = createTestKeyProviderWithOverrides(successorKeys);
		const harness = await createJournalHarness("workflow-public-opener-crash", keyProvider);
		try {
			const { input, successorKey } = await createRotationRequest(harness, "public-opener-crash");
			successorKeys.set(successorKey.validStoreEpoch, successorKey);
			harness.options.successorContextOpener = createWorkflowGenerationContextOpener(harness.options);
			await expect(
				harness.journal.rotateGeneration(input, {
					checkpoint: DurableStoreCrashBoundary.afterRotationRetireBeforeRebind,
					before: async () => {
						throw new Error("public opener crash checkpoint");
					},
					after: async () => undefined,
				}),
			).rejects.toThrow(/public opener crash checkpoint|durably proven/i);
			await expect(harness.journal.rotationStore.resolve(input.rotationId)).resolves.toMatchObject({
				state: "quarantined",
				quarantineReason: "rotation_commit_uncertain",
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects a foreign successor context instead of splitting the workflow binding", async () => {
		const harness = await createJournalHarness("workflow-rebind-owner");
		const foreign = await createJournalHarness("workflow-rebind-foreign");
		try {
			const replayHead = {
				workflowId: foreign.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: foreign.epoch,
			};
			const foreignStorage = {
				...foreign.journal.storage,
				append: async () => undefined,
				read: async () => foreign.journal.storage.readJournalBytes(),
				sync: async () => undefined,
			};
			const foreignContext: WorkflowGenerationContext = {
				descriptorContext: foreign.journal.descriptorContext,
				storage: foreignStorage,
				returnProofStore: foreign.journal.returnProofStore,
				rotationStore: foreign.journal.rotationStore,
				replayHead,
				seededStateDigest: digestObject(replayHead),
				appendSuccessorFence: async () => {
					throw new Error("foreign successor fence is not allowed");
				},
			};
			await expect(
				harness.journal.rebindSuccessor(foreignContext, {
					generationId: foreign.journal.descriptorContext.generationId,
					epochRef: foreign.epoch,
					head: replayHead,
				}),
			).rejects.toThrow(/foreign|workflow|descriptor|successor/i);
		} finally {
			await harness.close();
			await foreign.close();
		}
	});

	it("rejects a same-root successor context with a foreign key provider and storage binding", async () => {
		const harness = await createJournalHarness("workflow-rebind-foreign-provider");
		const foreign = await WorkflowJournal.open({
			...harness.options,
			descriptorFs: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter()),
			successorContextOpener: {
				openSuccessor: async () => {
					throw new Error("foreign provider successor is not used by this test");
				},
			},
		});
		let foreignClosedByRebind = false;
		try {
			const generationId = `generation-${"f".repeat(32)}`;
			const replayHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			const foreignStorage = {
				...foreign.storage,
				append: async () => undefined,
				read: async () => foreign.storage.readJournalBytes(),
				sync: async () => undefined,
			};
			const foreignContext: WorkflowGenerationContext & {
				workflowId: string;
				rootSessionId: string;
				rootDigest: string;
				successorBinding: {
					generationId: string;
					epochRef: WorkflowEpochRef;
					leaseRef: WorkflowLeaseRef;
					writerIdentity: string;
				};
				bindSuccessor(input: {
					generationId: string;
					epochRef: WorkflowEpochRef;
					leaseRef: WorkflowLeaseRef;
					writerIdentity: string;
				}): void;
			} = {
				workflowId: harness.workflowId,
				rootSessionId: harness.rootSessionId,
				rootDigest: harness.journal.descriptorContext.rootDigest,
				successorBinding: {
					generationId,
					epochRef: harness.epoch,
					leaseRef: harness.leaseRef,
					writerIdentity: harness.writerIdentity,
				},
				bindSuccessor: () => undefined,
				descriptorContext: { ...foreign.descriptorContext, generationId },
				storage: foreignStorage,
				returnProofStore: foreign.returnProofStore,
				rotationStore: foreign.rotationStore,
				replayHead,
				seededStateDigest: digestObject(replayHead),
				appendSuccessorFence: async () => {
					throw new Error("foreign provider successor fence is not allowed");
				},
			};
			await expect(
				harness.journal.rebindSuccessor(foreignContext, {
					generationId,
					epochRef: harness.epoch,
					head: replayHead,
				}),
			).rejects.toThrow(/key provider|successor/i);
			foreignClosedByRebind = true;
		} finally {
			if (!foreignClosedByRebind) await closeJournalDescriptors(foreign);
			await harness.close();
		}
	});

	it("rejects a foreign provider that returns a valid generation with a different key identity", async () => {
		const harness = await createJournalHarness("workflow-rebind-valid-foreign-provider");
		const baseProvider = harness.options.keyProvider;
		const foreignProvider: WorkflowJournalKeyProvider = {
			current: async (workflowId, epoch) => {
				const key = await baseProvider.current(workflowId, epoch);
				return epoch.storeEpoch === harness.epoch.storeEpoch ? { ...key, keyId: `foreign-${key.keyId}` } : key;
			},
			resolve: (workflowId, keyId, epoch) => baseProvider.resolve(workflowId, keyId, epoch),
		};
		const foreign = await WorkflowJournal.open({
			...harness.options,
			keyProvider: foreignProvider,
			descriptorFs: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter()),
			successorContextOpener: {
				openSuccessor: async () => {
					throw new Error("foreign valid-generation successor is not used by this test");
				},
			},
		});
		try {
			const active = await harness.journal.rotationStore.readActiveGeneration(harness.workflowId);
			if (active === null) throw new Error("Active generation is required for foreign-provider validation.");
			const replayHead = {
				workflowId: harness.workflowId,
				sequence: 0,
				eventDigest: null,
				epochRef: harness.epoch,
			};
			const foreignStorage = {
				...foreign.storage,
				append: async () => undefined,
				read: async () => foreign.storage.readJournalBytes(),
				sync: async () => undefined,
			};
			const foreignContext = {
				workflowId: harness.workflowId,
				rootSessionId: harness.rootSessionId,
				rootDigest: harness.journal.descriptorContext.rootDigest,
				successorBinding: {
					generationId: active.generationId,
					epochRef: harness.epoch,
					leaseRef: harness.leaseRef,
					writerIdentity: harness.writerIdentity,
				},
				successorKeyId: active.keyId,
				successorKeyProvider: foreignProvider,
				bindSuccessor: () => undefined,
				descriptorContext: foreign.descriptorContext,
				storage: foreignStorage,
				returnProofStore: foreign.returnProofStore,
				rotationStore: foreign.rotationStore,
				replayHead,
				seededStateDigest: digestObject(replayHead),
				appendSuccessorFence: async () => {
					throw new Error("foreign valid-generation successor fence is not used by this test");
				},
			};
			await expect(
				harness.journal.rebindSuccessor(foreignContext, {
					generationId: active.generationId,
					epochRef: harness.epoch,
					head: replayHead,
				}),
			).rejects.toThrow(/key provider|key identity|successor/i);
		} finally {
			await closeJournalDescriptors(foreign);
			await harness.close();
		}
	});
});

interface JournalHarness {
	readonly root: string;
	readonly workflowDir: string;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epoch: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly keyProvider: WorkflowJournalKeyProvider;
	readonly appendLease: WorkflowAppendLease;
	readonly options: WorkflowJournalOptions;
	readonly journal: WorkflowJournalImpl;
	close(): Promise<void>;
}

type JournalHarnessLeaseMode = "test" | "file";

async function createJournalHarness(
	workflowId: string,
	keyProvider: WorkflowJournalKeyProvider = createTestKeyProvider(),
	leaseMode: JournalHarnessLeaseMode = "test",
): Promise<JournalHarness> {
	const root = await mkdtemp(join(tmpdir(), "workflow-journal-real-"));
	const workflowDir = join(root, "workflows", workflowId);
	await mkdir(workflowDir, { recursive: true, mode: 0o700 });
	const epoch = loadPersistedEpochFixture().acquired;
	const rootIdentityDigest = await descriptorIdentityDigest(root, "directory");
	const workflowIdentityDigest = await descriptorIdentityDigest(workflowDir, "directory");
	const rootSessionId = `session-${workflowId}`;
	const writerIdentity = "writer-1";
	const leaseRef: WorkflowLeaseRef = {
		...epoch,
		leaseId: `lease-${workflowId}`,
		acquisitionEventSequence: 1,
		processIdentity: "process-1",
		rootDigest: digestObject({
			descriptorIdentity: rootIdentityDigest,
			workflowIdentity: workflowIdentityDigest,
			workflowId,
		}),
		writerIdentity,
		acquiredAt: "2026-08-13T00:00:00.000Z",
		expiresAt: "2026-08-14T00:00:00.000Z",
	};
	const appendLease =
		leaseMode === "file"
			? createFileWorkflowAppendLease({
					lockPath: join(root, "workflow-append.lock"),
					leaseRef,
					writerIdentity,
				})
			: createTestAppendLease(leaseRef, writerIdentity, [leaseRef.rootDigest, workflowIdentityDigest]);
	const descriptorFs =
		leaseMode === "file"
			? createProductionWorkflowDescriptorFs()
			: createNodeWorkflowDescriptorFs(createRealDescriptorNativeAdapter());
	const descriptorRoots = createWorkflowDescriptorRootAdapters({
		sessionArtifactRoot: root,
		workflowDir,
		rootSessionId,
		workflowId,
		sessionIdentityDigest: rootIdentityDigest,
		workflowIdentityDigest,
	});
	const options: WorkflowJournalOptions = {
		artifactRoot: root,
		sessionArtifactRoot: root,
		workflowDir,
		descriptorRoots,
		storeKind: "workflow",
		namespace: "workflow",
		storeId: `store-${workflowId}`,
		workflowId,
		rootSessionId,
		epoch,
		writerIdentity,
		keyProvider,
		appendLease,
		leaseRef,
		descriptorFs,
		ownerValidators: createWorkflowOwnerValidators(),
		now: () => "2026-08-13T00:00:00.000Z",
		successorContextOpener: {
			openSuccessor: async () => {
				throw new Error("successor context is not used by this focused harness");
			},
		},
	};
	const journal = await WorkflowJournal.open(options);
	return {
		root,
		workflowDir,
		workflowId,
		rootSessionId,
		epoch,
		writerIdentity,
		leaseRef,
		keyProvider,
		appendLease,
		options: journal.options,
		journal,
		close: async () => {
			await closeJournalDescriptors(journal);
			await rm(root, { recursive: true, force: true });
		},
	};
}

async function closeJournalDescriptors(journal: WorkflowJournalImpl): Promise<void> {
	await journal.descriptorContext.workflow.close();
	await journal.descriptorContext.root.close();
}

function createTestKeyProvider(): WorkflowJournalKeyProvider {
	return {
		current: async (workflowId, epoch) => createTestKey(workflowId, epoch),
		resolve: async (workflowId, _keyId, epoch) => createTestKey(workflowId, epoch),
	};
}

function createCoordinatorRotationKeyProvider(
	harness: JournalHarness,
): WorkflowJournalKeyProvider & { markSuccessorReady(): void } {
	const previousKey: WorkflowJournalKey = {
		keyId: `test-key-${harness.epoch.storeEpoch}`,
		secret: new TextEncoder().encode("workflow-journal-test-secret"),
		validStoreEpoch: harness.epoch.storeEpoch,
		generationId: harness.journal.descriptorContext.generationId,
	};
	let successorKey: WorkflowJournalKey | null = null;
	let successorReady = false;
	return {
		current: async () => {
			if (successorReady) {
				if (successorKey === null) throw new Error("Successor key was not issued before lease transfer.");
				return successorKey;
			}
			return previousKey;
		},
		resolve: async (_workflowId, keyId, epoch) => {
			if (keyId === previousKey.keyId && epoch.storeEpoch === previousKey.validStoreEpoch) return previousKey;
			if (successorKey !== null && keyId === successorKey.keyId && epoch.storeEpoch === successorKey.validStoreEpoch)
				return successorKey;
			throw new Error("Coordinator rotation key tuple is foreign.");
		},
		rotateGeneration: async (input) => {
			successorKey = {
				keyId: "test-coordinator-successor-key",
				secret: new TextEncoder().encode("workflow-journal-successor-secret"),
				validStoreEpoch: input.nextEpoch.storeEpoch,
				generationId: deriveWorkflowGenerationId({
					workflowId: input.workflowId,
					nextEpoch: input.nextEpoch,
					rotationId: input.rotationId,
					priorHeadDigest: input.priorHeadDigest,
				}),
			};
			return successorKey;
		},
		markSuccessorReady: () => {
			successorReady = true;
		},
	};
}

function createMultiGenerationKeyProvider(): WorkflowJournalKeyProvider & {
	rejectGeneration(generationId: string): void;
} {
	const keysByEpoch = new Map<string, WorkflowJournalKey>();
	const keysById = new Map<string, WorkflowJournalKey>();
	const rejectedGenerations = new Set<string>();
	const epochKey = (epoch: WorkflowEpochRef): string => `${epoch.storeEpoch}:${epoch.coordinatorEpoch}`;
	const remember = (key: WorkflowJournalKey, epoch: WorkflowEpochRef): WorkflowJournalKey => {
		keysByEpoch.set(epochKey(epoch), key);
		keysById.set(key.keyId, key);
		return key;
	};
	const ensureInitial = (workflowId: string, epoch: WorkflowEpochRef): WorkflowJournalKey => {
		const existing = keysByEpoch.get(epochKey(epoch));
		if (existing !== undefined) return existing;
		return remember(createTestKey(workflowId, epoch), epoch);
	};
	const assertAvailable = (key: WorkflowJournalKey): WorkflowJournalKey => {
		if (rejectedGenerations.has(key.generationId)) throw new Error("Historical generation key is unavailable.");
		return { ...key };
	};
	return {
		current: async (workflowId, epoch) => assertAvailable(ensureInitial(workflowId, epoch)),
		resolve: async (workflowId, keyId, epoch) => {
			const key = keysById.get(keyId) ?? ensureInitial(workflowId, epoch);
			if (
				key.keyId !== keyId ||
				key.validStoreEpoch !== epoch.storeEpoch ||
				keysByEpoch.get(epochKey(epoch))?.generationId !== key.generationId
			)
				throw new Error("Historical generation key tuple is foreign.");
			return assertAvailable(key);
		},
		rotateGeneration: async (input) => {
			const key: WorkflowJournalKey = {
				keyId: `multi-key-${input.nextEpoch.storeEpoch}-${input.nextEpoch.coordinatorEpoch}`,
				secret: new TextEncoder().encode("workflow-journal-test-secret"),
				validStoreEpoch: input.nextEpoch.storeEpoch,
				generationId: deriveWorkflowGenerationId({
					workflowId: input.workflowId,
					nextEpoch: input.nextEpoch,
					rotationId: input.rotationId,
					priorHeadDigest: input.priorHeadDigest,
				}),
			};
			return remember(key, input.nextEpoch);
		},
		rejectGeneration: (generationId) => {
			rejectedGenerations.add(generationId);
		},
	};
}

function createAppendLeaseReadyAfterRotation(
	base: WorkflowAppendLease,
	keyProvider: WorkflowJournalKeyProvider & { markSuccessorReady(): void },
): WorkflowAppendLease {
	return {
		...base,
		rotate: async (input) => {
			await base.rotate(input);
			keyProvider.markSuccessorReady();
		},
	};
}

function createTestKey(
	workflowId: string,
	epoch: WorkflowEpochRef,
): { keyId: string; secret: Uint8Array; validStoreEpoch: number; generationId: string } {
	const generationId = deriveWorkflowGenerationId({
		workflowId,
		nextEpoch: epoch,
		rotationId: "bootstrap",
		priorHeadDigest: "test-head",
	});
	return {
		keyId: `test-key-${epoch.storeEpoch}`,
		secret: new TextEncoder().encode("workflow-journal-test-secret"),
		validStoreEpoch: epoch.storeEpoch,
		generationId,
	};
}

function createRotationKeyProvider(successorKey: {
	keyId: string;
	generationId: string;
	secret: Uint8Array;
	validStoreEpoch: number;
}): WorkflowJournalKeyProvider {
	return {
		current: async (workflowId, epoch) =>
			epoch.storeEpoch === successorKey.validStoreEpoch ? { ...successorKey } : createTestKey(workflowId, epoch),
		resolve: async (workflowId, keyId, epoch) => {
			const key =
				keyId === successorKey.keyId && epoch.storeEpoch === successorKey.validStoreEpoch
					? { ...successorKey }
					: createTestKey(workflowId, epoch);
			const expectedGenerationId =
				keyId === successorKey.keyId ? successorKey.generationId : createTestKey(workflowId, epoch).generationId;
			if (
				key.keyId !== keyId ||
				key.validStoreEpoch !== epoch.storeEpoch ||
				key.generationId !== expectedGenerationId
			)
				throw new Error(
					`test key mismatch requested=${keyId}/${epoch.storeEpoch}/${epoch.coordinatorEpoch}/${expectedGenerationId} resolved=${key.keyId}/${key.validStoreEpoch}/${key.generationId}`,
				);
			return key;
		},
	};
}

function createTestKeyProviderWithOverrides(
	overrides: ReadonlyMap<number, WorkflowJournalKey>,
): WorkflowJournalKeyProvider & { disableOverrides(): void } {
	let overridesEnabled = true;
	return {
		current: async (workflowId, epoch) => {
			if (!overridesEnabled && overrides.has(epoch.storeEpoch))
				throw new Error("predecessor provider cannot resolve successor generation after rebind");
			return overrides.get(epoch.storeEpoch) ?? createTestKey(workflowId, epoch);
		},
		resolve: async (workflowId, keyId, epoch) => {
			if (!overridesEnabled && overrides.has(epoch.storeEpoch))
				throw new Error("predecessor provider cannot resolve successor generation after rebind");
			const key = overrides.get(epoch.storeEpoch) ?? createTestKey(workflowId, epoch);
			if (key.keyId !== keyId || key.validStoreEpoch !== epoch.storeEpoch)
				throw new Error("test override key does not match the requested epoch");
			return key;
		},
		disableOverrides: () => {
			overridesEnabled = false;
		},
	};
}

async function createRotationRequest(
	harness: JournalHarness,
	rotationId: string,
	ownerIdentity = "writer-2",
	expectedHeadOverride?: WorkflowJournalHead,
): Promise<{
	input: Parameters<WorkflowJournalImpl["rotateGeneration"]>[0];
	successorKey: { keyId: string; generationId: string; secret: Uint8Array; validStoreEpoch: number };
}> {
	const expectedHead =
		expectedHeadOverride ??
		({
			workflowId: harness.workflowId,
			sequence: 0,
			eventDigest: null,
			epochRef: harness.epoch,
		} satisfies WorkflowJournalHead);
	const nextEpoch: WorkflowEpochRef = {
		storeEpoch: harness.epoch.storeEpoch + 1,
		coordinatorEpoch: harness.epoch.coordinatorEpoch,
	};
	const expectedHeadDigest = digestObject(expectedHead);
	const generationId = deriveWorkflowGenerationId({
		workflowId: harness.workflowId,
		nextEpoch,
		rotationId,
		priorHeadDigest: expectedHeadDigest,
	});
	const successorKey = {
		keyId: `test-key-${nextEpoch.storeEpoch}`,
		secret: new TextEncoder().encode("workflow-journal-test-secret"),
		validStoreEpoch: nextEpoch.storeEpoch,
		generationId,
	};
	const nextLeaseRef: WorkflowLeaseRef = {
		...harness.leaseRef,
		storeEpoch: nextEpoch.storeEpoch,
		leaseId: `${harness.leaseRef.leaseId}-next`,
		acquisitionEventSequence: harness.leaseRef.acquisitionEventSequence + 1,
		processIdentity: `${harness.leaseRef.processIdentity}-next`,
		writerIdentity: "writer-2",
	};
	const generationBinding = {
		writerIdentity: "writer-2",
		processGenerationId: "process-generation-2",
		ownerIdentity,
	};
	const active = await harness.journal.rotationStore.readActiveGeneration(harness.workflowId);
	if (active === null) throw new Error("Rotation request requires the bootstrap active generation.");
	const priorRecordDigest = sha256Hex(canonicalJsonBytes(active));
	const mutationId = `${rotationId}-mutation`;
	const idempotencyKey = `${rotationId}-idempotency`;
	const authenticatedTuple = {
		workflowId: harness.workflowId,
		rotationId,
		mutationId,
		idempotencyKey,
		expectedHeadDigest,
		previousEpoch: harness.epoch,
		nextEpoch,
		previousGenerationId: harness.journal.descriptorContext.generationId,
		generationId,
		previousWriterIdentity: harness.writerIdentity,
		previousLeaseRef: harness.leaseRef,
		nextLeaseRef,
		generationBinding,
	};
	const previousFrameBytes = canonicalJsonBytes({ role: "predecessor", authenticatedTuple });
	const successorFrameBytes = canonicalJsonBytes({ role: "successor", authenticatedTuple });
	const previousSecret = new TextEncoder().encode("workflow-journal-test-secret");
	const previousFrameMac = createHmac("sha256", previousSecret).update(previousFrameBytes).digest("hex");
	const previousFrameChecksum = sha256Hex(previousFrameBytes).slice(0, 8);
	const frameMac = createHmac("sha256", successorKey.secret).update(successorFrameBytes).digest("hex");
	const frameChecksum = sha256Hex(successorFrameBytes).slice(0, 8);
	const recordBytes = canonicalJsonBytes({
		authenticatedTuple,
		previousFrameMac,
		previousFrameChecksum,
		frameMac,
		frameChecksum,
		keyId: successorKey.keyId,
	});
	const recordMac = createHmac("sha256", successorKey.secret).update(recordBytes).digest("hex");
	const recordChecksum = sha256Hex(recordBytes).slice(0, 8);
	const activeGenerationManifestRef = {
		artifactId: `generation-manifest:${generationId}`,
		relativePath: `${deriveWorkflowGenerationPath(generationId)}/ACTIVE`,
		digest: "",
		sizeBytes: 0,
		sourceEventSequence: expectedHead.sequence,
	};
	const manifestDigest = sha256Hex(
		canonicalJsonBytes({
			workflowId: harness.workflowId,
			generationId,
			manifestRef: activeGenerationManifestRef,
			sourceHead: expectedHead,
			epochRef: nextEpoch,
			generationBinding,
			leaseRef: nextLeaseRef,
			keyId: successorKey.keyId,
			frameMac,
			frameChecksum,
			priorRecordDigest,
			manifestBytesDigest: "",
			sideRecordMac: "",
		}),
	);
	return {
		input: {
			recordVersion: 1,
			generationId,
			rotationId,
			mutationId,
			idempotencyKey,
			expectedHeadDigest,
			previousEpoch: harness.epoch,
			nextEpoch,
			previousKeyId: `test-key-${harness.epoch.storeEpoch}`,
			previousGenerationId: harness.journal.descriptorContext.generationId,
			previousFrameMac,
			previousFrameChecksum,
			previousWriterIdentity: harness.writerIdentity,
			previousLeaseRef: harness.leaseRef,
			nextLeaseRef,
			generationBinding,
			activeGenerationManifestRef: { ...activeGenerationManifestRef, digest: manifestDigest },
			keyId: successorKey.keyId,
			frameMac,
			frameChecksum,
			recordMac,
			recordChecksum,
			priorRecordDigest,
		},
		successorKey,
	};
}

function createTestAppendLease(
	initialLease: WorkflowLeaseRef,
	initialWriter: string,
	acceptedRootDigests: readonly string[] = [initialLease.rootDigest],
): WorkflowAppendLease {
	// Task 2 delegates cross-process ownership to this injected lease; the native adapter separately proves host path identity and no-replace races.
	let currentLease = initialLease;
	let currentWriter = initialWriter;
	let guard: Promise<void> = Promise.resolve();
	const assertGuardOwned = async (input: Parameters<WorkflowAppendLease["assertOwned"]>[0]): Promise<void> => {
		if (
			input.workflowId.length === 0 ||
			input.writerIdentity !== currentWriter ||
			input.leaseRef.writerIdentity !== currentWriter ||
			digestObject(input.leaseRef) !== digestObject(currentLease) ||
			digestObject(input.epochRef) !==
				digestObject({ storeEpoch: currentLease.storeEpoch, coordinatorEpoch: currentLease.coordinatorEpoch }) ||
			!acceptedRootDigests.includes(input.rootDigest) ||
			input.boundary.length === 0
		)
			throw new Error("append lease is not owned");
	};
	return {
		acquire: async () => currentLease,
		renew: async () => undefined,
		assertOwned: assertGuardOwned,
		withExclusiveGuard: async (input, operation) => {
			const previous = guard;
			let release!: () => void;
			guard = new Promise<void>((resolve) => {
				release = resolve;
			});
			await previous;
			try {
				await assertGuardOwned(input);
				return await operation();
			} finally {
				release();
			}
		},
		observe: async () => ({ writerIdentity: currentWriter, leaseRef: currentLease }),
		rotate: async (input) => {
			if (
				input.expectedWriterIdentity !== currentWriter ||
				digestObject(input.expectedLeaseRef) !== digestObject(currentLease)
			)
				throw new Error("append lease rotation tuple is stale");
			currentWriter = input.nextWriterIdentity;
			currentLease = input.nextLeaseRef;
		},
		release: async () => undefined,
	};
}

function createStartAppendInput(harness: JournalHarness, idempotencyKey: string) {
	const expectedHead = { workflowId: harness.workflowId, sequence: 0, eventDigest: null, epochRef: harness.epoch };
	const payload = {
		kind: "workflow_started" as const,
		workflowId: harness.workflowId,
		rootSessionId: harness.rootSessionId,
		objective: "durable",
	};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { [harness.journal.descriptorContext.generationId]: harness.epoch.storeEpoch },
		ownerId: "workflow-test",
		phase: "recovering",
		reducerDigest: digestObject(payload),
		semanticHead: { ...expectedHead, stateDigest: digestObject(expectedHead), generation: harness.epoch.storeEpoch },
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity: harness.writerIdentity,
		leaseRef: harness.leaseRef,
		epochRef: harness.epoch,
	};
	return {
		workflowId: harness.workflowId,
		payload,
		expectedHead,
		epochRef: harness.epoch,
		leaseRef: harness.leaseRef,
		idempotencyKey,
		writerIdentity: harness.writerIdentity,
		executionKey: null,
		semanticBinding,
		returnProofId: `return-proof:${idempotencyKey}`,
	};
}

function createAppendAfterRebindInput(
	harness: JournalHarness,
	previousEvent: Pick<WorkflowJournalEvent, "sequence" | "eventDigest"> | WorkflowJournalHead,
	idempotencyKey: string,
) {
	const epochRef = harness.journal.options.epoch;
	const leaseRef = harness.journal.options.leaseRef;
	const writerIdentity = harness.journal.options.writerIdentity;
	const expectedHead = {
		workflowId: harness.workflowId,
		sequence: previousEvent.sequence,
		eventDigest: previousEvent.eventDigest,
		epochRef,
	};
	const payload = {
		kind: "workflow_started" as const,
		workflowId: harness.workflowId,
		rootSessionId: harness.rootSessionId,
		objective: "after-rebind",
	};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: idempotencyKey,
		baselineDigest: digestObject(expectedHead),
		expectedGenerations: { [harness.journal.descriptorContext.generationId]: epochRef.storeEpoch },
		ownerId: "workflow-test",
		phase: "recovering",
		reducerDigest: digestObject(payload),
		semanticHead: { ...expectedHead, stateDigest: digestObject(expectedHead), generation: epochRef.storeEpoch },
		expectedHead,
		idempotencyKey,
		executionKey: null,
		writerIdentity,
		leaseRef,
		epochRef,
	};
	return {
		workflowId: harness.workflowId,
		payload,
		expectedHead,
		epochRef,
		leaseRef,
		idempotencyKey,
		writerIdentity,
		executionKey: null,
		semanticBinding,
		returnProofId: `return-proof:${idempotencyKey}`,
	};
}

function createAuthenticatedTuple(
	event: WorkflowJournalEvent,
	overrides: Partial<Pick<WorkflowAuthenticatedMutationTuple, "expectedHead" | "idempotencyKey">> = {},
): WorkflowAuthenticatedMutationTuple {
	return {
		recordVersion: 1,
		generationId: event.generationId,
		workflowId: event.workflowId,
		mutationId: event.returnProofId,
		expectedHead: overrides.expectedHead ?? event.expectedHead,
		sequence: event.sequence,
		eventDigest: event.eventDigest,
		epochRef: event.epochRef,
		leaseRef: event.leaseRef,
		writerIdentity: event.writerIdentity,
		idempotencyKey: overrides.idempotencyKey ?? event.idempotencyKey,
		keyId: event.keyId,
		frameMac: event.committedFrameMac,
		frameChecksum: event.committedFrameChecksum,
		recordMac: event.recordMac,
		recordChecksum: event.recordChecksum,
		priorRecordDigest: event.priorEventDigest,
	};
}

function authenticateTestSideRecord(value: Record<string, unknown>): Record<string, unknown> {
	const secret = new TextEncoder().encode("workflow-journal-test-secret");
	const unsigned = { ...value, sideRecordMac: "" };
	return {
		...value,
		sideRecordMac: createHmac("sha256", secret).update(canonicalJsonBytes(unsigned)).digest("hex"),
	};
}

function rewriteAuthenticatedJsonFrame(
	bytes: Uint8Array,
	secret: Uint8Array,
	mutate: (record: Record<string, unknown>) => void,
	mutateHeader?: (header: Buffer) => void,
): Uint8Array {
	const header = Buffer.from(bytes.subarray(0, 64));
	const frameLength = header.readUInt32BE(8);
	const payloadLength = header.readUInt32BE(12);
	if (frameLength !== bytes.byteLength || payloadLength + 100 !== frameLength)
		throw new Error("Test frame helper requires one complete fixed frame.");
	const payload = JSON.parse(new TextDecoder().decode(bytes.subarray(64, 64 + payloadLength))) as Record<
		string,
		unknown
	>;
	mutate(payload);
	const unsigned = { ...payload };
	delete unsigned.frameMac;
	delete unsigned.frameChecksum;
	const unsignedBytes = canonicalJsonBytes(unsigned);
	const innerMac = createHmac("sha256", secret).update(unsignedBytes).digest("hex");
	const innerChecksum = createHash("sha256").update(unsignedBytes).digest("hex").slice(0, 8);
	const nextPayload = canonicalJsonBytes({ ...payload, frameMac: innerMac, frameChecksum: innerChecksum });
	mutateHeader?.(header);
	header.writeUInt32BE(64 + nextPayload.byteLength + 36, 8);
	header.writeUInt32BE(nextPayload.byteLength, 12);
	const authenticated = Buffer.concat([header, Buffer.from(nextPayload)]);
	const outerMac = createHmac("sha256", secret).update(authenticated).digest();
	const outerChecksum = createHash("sha256")
		.update(Buffer.concat([authenticated, outerMac]))
		.digest()
		.subarray(0, 4);
	return new Uint8Array(Buffer.concat([authenticated, outerMac, outerChecksum]));
}

async function rewriteTestFlushProof(path: string, frameBytes: Uint8Array): Promise<void> {
	const proof = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
	proof.frameDigest = sha256Hex(frameBytes);
	proof.proofDigest = digestObject({
		mutationId: proof.mutationId,
		frameKind: proof.frameKind,
		frameDigest: proof.frameDigest,
		fileIdentityDigest: proof.fileIdentityDigest,
		parentDirectoryIdentityDigest: proof.parentDirectoryIdentityDigest,
		fileSynced: true,
		parentDirectorySynced: true,
	});
	proof.sideRecordMac = authenticateTestSideRecord(proof).sideRecordMac;
	await writeFile(path, canonicalJsonBytes(proof));
}

async function descriptorIdentityDigest(path: string, kind: "file" | "directory"): Promise<string> {
	const stats = await lstat(path);
	return digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
}

interface RealDescriptorState {
	readonly path: string;
	readonly file: Awaited<ReturnType<typeof openFile>>;
	readonly kind: "file" | "directory";
	readonly identityDigest: string;
}

function createRealDescriptorNativeAdapter() {
	const states = new WeakMap<WorkflowDescriptorHandle, RealDescriptorState>();
	const stateOf = (handle: WorkflowDescriptorHandle): RealDescriptorState => {
		const state = states.get(handle);
		if (state === undefined) throw new Error("Unknown real descriptor handle.");
		return state;
	};
	const openHandle = async (path: string, flags: number, mode: number): Promise<WorkflowDescriptorHandle> => {
		let beforeStats: Awaited<ReturnType<typeof lstat>> | undefined;
		try {
			beforeStats = await lstat(path);
			if (beforeStats.isSymbolicLink()) throw new Error("descriptor adapter refuses symlink traversal");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const file = await openFile(path, flags, mode);
		try {
			const stats = await file.stat();
			const kind = stats.isDirectory() ? "directory" : "file";
			if (
				beforeStats !== undefined &&
				(Number(beforeStats.dev) !== Number(stats.dev) || Number(beforeStats.ino) !== Number(stats.ino))
			)
				throw new Error("descriptor adapter detected a path swap during open");
			if (kind === "file" && Number(stats.nlink) !== 1)
				throw new Error("descriptor adapter refuses hard-linked regular files");
			const identityDigest = digestObject({ device: Number(stats.dev), inode: Number(stats.ino), kind });
			const state: RealDescriptorState = { path, file, kind, identityDigest };
			const handle: WorkflowDescriptorHandle = {
				identityDigest,
				write: async (bytes) => {
					if (kind !== "file") throw new Error("directory descriptor cannot be written");
					await file.writeFile(bytes);
				},
				read: async () => new Uint8Array(await file.readFile()),
				stat: async () => {
					const current = await file.stat();
					return { kind, linkCount: Number(current.nlink), device: Number(current.dev), identityDigest };
				},
				sync: async () => {
					await file.sync();
				},
				close: async () => {
					await file.close();
				},
			};
			states.set(handle, state);
			return handle;
		} catch (error) {
			await file.close().catch(() => undefined);
			throw error;
		}
	};
	const pathOf = (handle: WorkflowDescriptorHandle): string => stateOf(handle).path;
	return {
		openRoot: (rootPath: string) =>
			openHandle(
				rootPath,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
				0o700,
			),
		mkdirAt: async (parent: WorkflowDescriptorHandle, component: string, mode: number) => {
			const path = join(pathOf(parent), component);
			await mkdir(path, { recursive: false, mode });
			return openHandle(
				path,
				fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
				mode,
			);
		},
		openAt: (parent: WorkflowDescriptorHandle, component: string, flags: number, mode: number) =>
			openHandle(join(pathOf(parent), component), flags, mode),
		renameAt: async (
			parent: WorkflowDescriptorHandle,
			fromComponent: string,
			toComponent: string,
			options = { replace: true, noReplace: false },
		) => {
			const from = join(pathOf(parent), fromComponent);
			const to = join(pathOf(parent), toComponent);
			if (options.noReplace) {
				try {
					await link(from, to);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
					throw error;
				}
				await unlink(from);
				return;
			}
			await rename(from, to);
		},
		unlinkAt: (parent: WorkflowDescriptorHandle, component: string) => unlink(join(pathOf(parent), component)),
		syncDirectoryChain: async (leaf: WorkflowDescriptorHandle, root: WorkflowDescriptorHandle) => {
			const rootPath = pathOf(root);
			const leafState = stateOf(leaf);
			await leafState.file.sync();
			let ancestorPath = leafState.path === rootPath ? rootPath : dirname(leafState.path);
			while (ancestorPath !== rootPath) {
				const ancestor = await openHandle(
					ancestorPath,
					fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0),
					0o700,
				);
				try {
					await ancestor.sync();
				} finally {
					await ancestor.close().catch(() => undefined);
				}
				const parentPath = dirname(ancestorPath);
				if (parentPath === ancestorPath) throw new Error("descriptor adapter could not reach the opened root");
				ancestorPath = parentPath;
			}
			await stateOf(root).file.sync();
		},
	};
}
