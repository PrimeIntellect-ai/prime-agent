import { describe, expect, it } from "vitest";
import type { GoalState } from "../../src/core/goals.js";
import type { WorkflowAdmissionResult } from "../../src/core/workflow/admission.js";
import {
	createWorkflowCancellationCoordinator,
	type WorkflowCancellationDependencies,
} from "../../src/core/workflow/cancellation.js";
import type {
	DurableDecisionRef,
	WorkflowAttemptStatus,
	WorkflowChildAuthority,
	WorkflowChildIdentity,
	WorkflowChildProcessBinding,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowLeaseRef,
	WorkflowLeaseStatus,
	WorkflowPhaseOutcomeRecord,
	WorkflowProcessGroupIdentity,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreIdentity,
	WorkflowStoreCommitResult,
	WorkflowStoreReplayResult,
} from "../../src/core/workflow/contracts.js";
import { digestObject } from "../../src/core/workflow/contracts.js";
import {
	canonicalWorkflowBindingDigest,
	canonicalWorkflowIdentityDigest,
	canonicalWorkflowProcessGroupDigest,
} from "../../src/core/workflow/process-groups.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const WORKFLOW_ID = "workflow-cancellation-test";
const WRITER_ID = "writer-cancellation-test";

function leaseRef(leaseId: string): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId,
		acquisitionEventSequence: 1,
		processIdentity: "process-cancellation-test",
		rootDigest: "root-cancellation-test",
		writerIdentity: WRITER_ID,
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T00:10:00.000Z",
	};
}

const ROOT_LEASE = leaseRef("root-lease-cancellation-test");

function processGroup(groupId: string): WorkflowProcessGroupIdentity {
	const base = {
		pid: groupId === "root-group" ? 41 : 42,
		processStartId: `start-${groupId}`,
		processGroupId: groupId,
		parentPid: 1,
	};
	return { ...base, identityDigest: canonicalWorkflowProcessGroupDigest(base) };
}

function childIdentity(
	attemptId: string,
	executionKey: string,
	groupId: string,
	parentAttemptId: string | null,
): WorkflowChildIdentity {
	const base = {
		admissionId: `admission:${executionKey}`,
		childSessionId: `child:${attemptId}`,
		processGroupId: groupId,
		executionKey,
		epochRef: EPOCH,
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-cancellation-test",
		agentRole: "worker",
		modelId: "model-cancellation-test",
		reasoningEffort: "medium",
		launchConfigDigest: "launch-cancellation-test",
		parentAttemptId,
	};
	const { parentAttemptId: _parentAttemptId, ...identityBase } = base;
	return { ...identityBase, identityDigest: canonicalWorkflowIdentityDigest(identityBase) };
}

function childBinding(
	attemptId: string,
	executionKey: string,
	groupId: string,
	parentAttemptId: string | null,
): WorkflowChildProcessBinding {
	const identity = childIdentity(attemptId, executionKey, groupId, parentAttemptId);
	const processGroup = processGroupFor(groupId);
	return {
		workflowId: WORKFLOW_ID,
		taskId: `task:${attemptId}`,
		attemptId,
		childIdentity: identity,
		processGroup,
		bindingDigest: canonicalWorkflowBindingDigest({ childIdentity: identity, processGroup }),
	};
}

function processGroupFor(groupId: string): WorkflowProcessGroupIdentity {
	return processGroup(groupId);
}

function phaseOutcome(
	admission: WorkflowAdmissionResult,
	status: "complete" | "failed" = "complete",
): WorkflowPhaseOutcomeRecord {
	return {
		attemptStatus: status === "complete" ? "completed" : "failed",
		outcome:
			status === "complete"
				? {
						workflowId: WORKFLOW_ID,
						phaseAttemptId: admission.context.attemptId,
						epochRef: EPOCH,
						invocationToken: admission.context.executionKey,
						inputStateDigest: admission.context.expectedEffectDigest,
						status: "complete",
						outputStateDigest: `output:${admission.context.attemptId}`,
						artifactRefs: [],
						evidenceRefs: [],
					}
				: {
						workflowId: WORKFLOW_ID,
						phaseAttemptId: admission.context.attemptId,
						epochRef: EPOCH,
						invocationToken: admission.context.executionKey,
						inputStateDigest: admission.context.expectedEffectDigest,
						status: "failed",
						errorCode: "workflow_cancelled",
						retryable: false,
						artifactRefs: [],
						evidenceRefs: [],
					},
	};
}

function admission(
	attemptId: string,
	executionKey: string,
	parentAttemptId: string | null,
	status: WorkflowAdmissionResult["status"],
	binding: WorkflowChildProcessBinding | null,
	outcome: WorkflowPhaseOutcomeRecord | null = null,
): WorkflowAdmissionResult {
	const attemptLease = leaseRef(`lease:${attemptId}`);
	const decisionRef: DurableDecisionRef = {
		decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: "session-cancellation-test" },
		decisionId: `decision:${attemptId}`,
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		decisionDigest: `decision-digest:${attemptId}`,
	};
	const context = {
		workflowId: WORKFLOW_ID,
		rootSessionId: "session-cancellation-test",
		taskId: `task:${attemptId}`,
		attemptId,
		executionKey,
		idempotencyKey: `admission:${executionKey}`,
		decisionRef,
		resourceLeaseRef: attemptLease,
		controlCapacity: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		},
		ownershipLeaseRef: null,
		childAuthority: {
			capabilities: ["read_only"],
			writeClass: "read_only",
			parentAttemptId,
			rootSpawned: parentAttemptId === null,
		} satisfies WorkflowChildAuthority,
		launchConfigDigest: "launch-cancellation-test",
		runtimeVersion: "0.147.0-alpha.10",
		hostCapabilityRevision: "host-cancellation-test",
		agentRole: "worker",
		modelId: "model-cancellation-test",
		reasoningEffort: "medium",
		expectedEffectDigest: `expected-effect:${attemptId}`,
		epochRef: EPOCH,
		configSnapshotDigest: "config-cancellation-test",
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision-cancellation-test",
			relativePath: "revision/cancellation-test",
			digest: "revision-cancellation-test",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-registry-cancellation-test",
		writerIdentity: WRITER_ID,
	};
	const lifecycle = {
		workflowId: WORKFLOW_ID,
		taskId: context.taskId,
		attemptId,
		status,
		childIdentity: binding?.childIdentity ?? null,
		childAuthority: context.childAuthority,
		admissionEventSequence: 1,
		terminalEventSequence: outcome === null ? null : 2,
		epochRef: EPOCH,
		statusDigest: `status:${attemptId}:${status}`,
	};
	return {
		context,
		admissionId: `admission:${executionKey}`,
		lifecycle,
		status,
		childIdentity: binding?.childIdentity ?? null,
		processBinding: binding,
		admissionEventSequence: 1,
		terminalEventSequence: outcome === null ? null : 2,
		outcomeDigest: outcome === null ? null : digestObject(outcome),
	};
}

class RecordingStore implements WorkflowRuntimeStore {
	readonly identity: WorkflowRuntimeStoreIdentity = {
		storeKind: "workflow",
		namespace: "test",
		rootDir: "/tmp/workflow-cancellation-test",
		storeId: "store-cancellation-test",
		workflowId: WORKFLOW_ID,
		identityDigest: "store-cancellation-test",
	};
	readonly payloads: WorkflowEventPayload[] = [];

	async commit<TPayload extends WorkflowEventPayload>(input: {
		payload: TPayload;
	}): Promise<WorkflowStoreCommitResult<TPayload>> {
		this.payloads.push(input.payload);
		const sequence = this.payloads.length;
		const commit = { sequence, payload: input.payload } as unknown as WorkflowStoreCommitResult<TPayload>["commit"];
		return {
			status: "committed",
			payload: input.payload,
			commit,
			state: undefined,
			head: {
				workflowId: WORKFLOW_ID,
				sequence,
				eventDigest: digestObject(input.payload),
				epochRef: EPOCH,
			},
		};
	}

	async replay(): Promise<WorkflowStoreReplayResult> {
		return {
			workflowId: WORKFLOW_ID,
			executionKey: null,
			events: this.payloads.map((payload, index) => ({ payload, idempotencyKey: `event:${index}` })) as never,
			head: {
				workflowId: WORKFLOW_ID,
				sequence: this.payloads.length,
				eventDigest: this.payloads.length === 0 ? null : digestObject(this.payloads.at(-1)),
				epochRef: EPOCH,
			},
			quarantined: false,
			quarantineReason: null,
		};
	}

	async publishArtifact(): Promise<never> {
		return undefined as never;
	}
	async publishSnapshot(): Promise<never> {
		return undefined as never;
	}
	async compareAndSwapProjection(): Promise<"applied"> {
		return "applied";
	}
	async appendOutbox(): Promise<never> {
		return undefined as never;
	}
	async replaceCoordinatorEpoch(): Promise<never> {
		return undefined as never;
	}
	async replaceStoreEpoch(): Promise<never> {
		return undefined as never;
	}
}

interface Fixture {
	store: RecordingStore;
	coordinator: ReturnType<typeof createWorkflowCancellationCoordinator>;
	attempts: WorkflowAdmissionResult[];
	order: string[];
	counts: { release: number; quarantine: number; terminate: number; reap: number; effect: number };
	goal: {
		goal: GoalState;
		binding: {
			workflowId: string;
			eventSequence: number;
			transitionDigest: string;
			storeEpoch: number;
			coordinatorEpoch: number;
		} | null;
	};
}

function fixture(
	options: {
		attempts?: WorkflowAdmissionResult[];
		unknown?: boolean;
		effectStatus?: "completed" | "already_completed" | "ambiguous" | "quarantined";
		stale?: boolean;
	} = {},
): Fixture {
	const store = new RecordingStore();
	const order: string[] = [];
	const counts = { release: 0, quarantine: 0, terminate: 0, reap: 0, effect: 0 };
	const attempts = options.attempts ?? [];
	const leaseStatuses = new Map<string, WorkflowLeaseStatus>(
		attempts.map((attempt) => [attempt.context.resourceLeaseRef.leaseId, "active" as const]),
	);
	const goal: Fixture["goal"] = {
		goal: {
			active: true,
			status: "active" as const,
			goalId: "goal-cancellation-test",
			objective: "cancel safely",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		},
		binding: {
			workflowId: WORKFLOW_ID,
			eventSequence: 1,
			transitionDigest: "binding-cancellation-test",
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
		},
	};
	const boundary = {
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH,
		leaseRef: ROOT_LEASE,
		executionKey: null,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: {
			artifactId: "revision-cancellation-test",
			relativePath: "revision/cancellation-test",
			digest: "revision-cancellation-test",
			sizeBytes: 1,
			sourceEventSequence: 1,
		},
		revisionRegistryDigest: "revision-registry-cancellation-test",
		configSnapshotDigest: "config-cancellation-test",
		tupleDigest: "",
	};
	boundary.tupleDigest = digestObject({
		workflowId: boundary.workflowId,
		epochRef: boundary.epochRef,
		leaseRef: boundary.leaseRef,
		executionKey: boundary.executionKey,
		revisionTuple: boundary.revisionTuple,
		revisionRegistryRef: boundary.revisionRegistryRef,
		revisionRegistryDigest: boundary.revisionRegistryDigest,
		configSnapshotDigest: boundary.configSnapshotDigest,
	});
	const recovery = {
		reconcile: async (request: { attemptId: string; executionKey: string }) => {
			const current = attempts.find((attempt) => attempt.context.attemptId === request.attemptId);
			const terminal = current?.terminalEventSequence !== null && current?.terminalEventSequence !== undefined;
			return {
				workflowId: WORKFLOW_ID,
				reconciliationAttemptId: `recovery:${request.attemptId}`,
				taskId: current?.context.taskId ?? `task:${request.attemptId}`,
				attemptId: request.attemptId,
				disposition: terminal ? ("completed" as const) : ("user_input_required" as const),
				persistedChildIdentity: current?.childIdentity ?? null,
				observedChildIdentity: current?.childIdentity ?? null,
				observedProcessGroupId: current?.processBinding?.processGroup.processGroupId ?? null,
				observedTranscriptDigest: null,
				observedWorkspaceDigest: "workspace-cancellation-test",
				epochRef: EPOCH,
				evidenceRefs: [],
				stateDigest: digestObject({ request, terminal }),
			};
		},
	};
	const dependencies: WorkflowCancellationDependencies = {
		workflowId: WORKFLOW_ID,
		store,
		epochs: {
			assertCurrent: async () => {
				if (options.stale === true) throw new Error("workflow_epoch_stale");
			},
		},
		admission: {
			listByWorkflow: async () => attempts,
			listDescendants: async (_workflowId: string, rootAttemptId: string | null) =>
				rootAttemptId === null
					? attempts
					: attempts.filter((attempt) => attempt.context.childAuthority.parentAttemptId === rootAttemptId),
			recordOutcome: async (admissionId: string, outcome: WorkflowPhaseOutcomeRecord) => {
				const current = attempts.find((attempt) => attempt.admissionId === admissionId);
				if (current === undefined) throw new Error("workflow_admission_not_found");
				const mutable = current as unknown as {
					status: WorkflowAttemptStatus;
					lifecycle: { status: WorkflowAttemptStatus; terminalEventSequence: number | null };
					terminalEventSequence: number | null;
					outcomeDigest: string | null;
				};
				mutable.status = outcome.attemptStatus;
				mutable.lifecycle.status = outcome.attemptStatus;
				mutable.terminalEventSequence = store.payloads.length + 1;
				mutable.lifecycle.terminalEventSequence = mutable.terminalEventSequence;
				mutable.outcomeDigest = digestObject(outcome);
				store.payloads.push({
					kind: "workflow_child_outcome_committed",
					workflowId: WORKFLOW_ID,
					attemptId: current.context.attemptId,
					executionKey: current.context.executionKey,
					outcome,
					outcomeDigest: digestObject(outcome),
					epochRef: EPOCH,
				});
				return current;
			},
		} as unknown as WorkflowCancellationDependencies["admission"],
		leases: {
			lookupByLease: async (_workflowId: string, ref: WorkflowLeaseRef) => {
				const status = leaseStatuses.get(ref.leaseId);
				return status === undefined
					? undefined
					: {
							terminalEventSequence: null,
							executionKey:
								attempts.find((attempt) => attempt.context.resourceLeaseRef.leaseId === ref.leaseId)?.context
									.executionKey ?? ref.leaseId,
							outcomeDigest: null,
							leaseStatus: status,
						};
			},
			release: async (input: { leaseRef: WorkflowLeaseRef; attemptId: string }) => {
				counts.release += 1;
				leaseStatuses.set(input.leaseRef.leaseId, "released");
				order.push(`release:${input.attemptId}`);
				return {
					status: "released" as const,
					leaseRef: input.leaseRef,
					releaseEventSequence: store.payloads.length + 1,
					epochRef: EPOCH,
				};
			},
			quarantine: async (input: { leaseRef: WorkflowLeaseRef; reason: string }) => {
				counts.quarantine += 1;
				leaseStatuses.set(input.leaseRef.leaseId, "quarantined");
				return { leaseRef: input.leaseRef, status: "quarantined" as const, reason: input.reason };
			},
		} as unknown as WorkflowCancellationDependencies["leases"],
		groups: {
			verify: async () => true,
			terminate: async (_identity: WorkflowProcessGroupIdentity, reason: string) => {
				counts.terminate += 1;
				order.push(`terminate:${reason}`);
				expect(store.payloads.some((payload) => payload.kind === "workflow_cancellation_intent")).toBe(true);
			},
			reap: async (identity: WorkflowProcessGroupIdentity) => {
				counts.reap += 1;
				order.push(`reap:${identity.processGroupId}`);
				return {
					remainingPids: [],
					reapDigest: `reap:${identity.processGroupId}`,
					reapEventSequence: store.payloads.length + 1,
				};
			},
			quarantine: async () => undefined,
			scanUnknownDescendants: async () =>
				options.unknown === true
					? [
							{
								descendantId: "unknown-cancellation-descendant",
								processGroupId: "unknown-group",
								pid: 91,
								processStartId: "start-91",
								evidenceDigest: "unknown-evidence",
							},
						]
					: [],
		} as unknown as WorkflowCancellationDependencies["groups"],
		broker: {
			reconcile: async () => {
				counts.effect += 1;
				return {
					status: options.effectStatus ?? "already_completed",
					resultDigest: "effect-result",
					evidenceArtifact: null,
				};
			},
		} as unknown as WorkflowCancellationDependencies["broker"],
		recovery: recovery as unknown as WorkflowCancellationDependencies["recovery"],
		goal: {
			coordinator: {
				transition: async () => {
					order.push("goal-paused");
					goal.goal.active = false;
					goal.goal.status = "paused";
					return goal.goal;
				},
			} as never,
			read: () => goal,
			compareAndSwapUnbind: async (input) => {
				order.push("goal-unbind");
				const cancelled = store.payloads.some((payload) => payload.kind === "workflow_cancelled");
				if (!cancelled || input.expectedGoalDigest !== digestObject(goal.goal)) return "conflict";
				goal.binding = null;
				return "unbound";
			},
		},
		writerIdentity: WRITER_ID,
		resolveRootLeaseRef: async () => ROOT_LEASE,
		fenceCallbacks: async () => {
			order.push("fence-callbacks");
			const intentIndex = store.payloads.findIndex((payload) => payload.kind === "workflow_cancellation_intent");
			expect(intentIndex).toBeGreaterThanOrEqual(0);
		},
		readRevisionBoundaryContext: async (_workflowId, epochRef, executionKey) => ({
			...boundary,
			epochRef,
			executionKey,
		}),
		revisionRegistry: { assertActive: async () => undefined },
	};
	const coordinator = createWorkflowCancellationCoordinator(dependencies);
	return { store, coordinator, attempts, order, counts, goal };
}

describe("workflow cancellation barrier", () => {
	it("persists intent before fencing or termination and keeps unresolved descendants bound", async () => {
		const root = admission(
			"root-attempt",
			"root-execution",
			null,
			"running",
			childBinding("root-attempt", "root-execution", "root-group", null),
		);
		const child = admission(
			"child-attempt",
			"child-execution",
			"root-attempt",
			"running",
			childBinding("child-attempt", "child-execution", "child-group", "root-attempt"),
		);
		const fixture = fixtureFor({ attempts: [root, child] });

		const result = await fixture.coordinator.cancel(WORKFLOW_ID, "root-attempt", EPOCH, "user-request");

		expect(result.status).toBe("paused");
		expect(result.goal.binding).not.toBeNull();
		expect(result.attempts.map((attempt) => attempt.attemptId)).toEqual(
			expect.arrayContaining(["root-attempt", "child-attempt"]),
		);
		expect(fixture.store.payloads.map((payload) => payload.kind)).toContain("workflow_cancellation_intent");
		expect(fixture.store.payloads.map((payload) => payload.kind)).toContain(
			"workflow_cancellation_descendants_reconciled",
		);
		expect(fixture.store.payloads.map((payload) => payload.kind)).not.toContain("workflow_cancelled");
		expect(fixture.order).toContain("fence-callbacks");
	});

	it("rejects stale epochs before writing intent or terminating a process group", async () => {
		const root = admission(
			"root-attempt",
			"root-execution",
			null,
			"running",
			childBinding("root-attempt", "root-execution", "root-group", null),
		);
		const fixture = fixtureFor({ attempts: [root], stale: true });

		await expect(fixture.coordinator.cancel(WORKFLOW_ID, null, EPOCH, "stale-request")).rejects.toMatchObject({
			code: "workflow_epoch_stale",
		});
		expect(fixture.store.payloads).toHaveLength(0);
		expect(fixture.counts.terminate).toBe(0);
	});

	it("releases terminal leases once and unbinds the goal only after the durable barrier", async () => {
		const terminal = admission(
			"terminal-attempt",
			"terminal-execution",
			null,
			"completed",
			null,
			phaseOutcome(admission("terminal-attempt", "terminal-execution", null, "completed", null)),
		);
		const fixture = fixtureFor({ attempts: [terminal] });

		const result = await fixture.coordinator.cancel(WORKFLOW_ID, null, EPOCH, "terminal-request");

		expect(result.status).toBe("cancelled");
		expect(result.barrier?.barrierEventSequence).toBeGreaterThan(0);
		expect(result.goal.binding).toBeNull();
		expect(fixture.counts.release).toBe(1);
		expect(fixture.order.indexOf("goal-unbind")).toBeGreaterThan(
			fixture.store.payloads.findIndex((payload) => payload.kind === "workflow_cancelled"),
		);
		const repeated = await fixture.coordinator.cancel(WORKFLOW_ID, null, EPOCH, "terminal-request");
		expect(repeated.status).toBe("already_cancelled");
		expect(fixture.counts.release).toBe(1);
	});

	it("keeps the goal bound when an effect remains ambiguous", async () => {
		const running = admission("effect-attempt", "effect-execution", null, "running", null);
		const fixture = fixtureFor({ attempts: [running], effectStatus: "ambiguous" });
		fixture.store.payloads.push({
			kind: "workflow_effect_intent",
			workflowId: WORKFLOW_ID,
			attemptId: running.context.attemptId,
			executionKey: running.context.executionKey,
			effectDigest: "effect-digest",
			decisionRef: running.context.decisionRef,
			epochRef: EPOCH,
			idempotencyKey: "effect-cancellation-test",
			effect: {
				kind: "file_read",
				operationId: "read-cancellation-test",
				path: "input.txt",
				pathDigest: "path-digest",
			},
		});

		const result = await fixture.coordinator.cancel(WORKFLOW_ID, null, EPOCH, "ambiguous-effect");

		expect(result.status).toBe("paused");
		expect(result.goal.binding).not.toBeNull();
		expect(result.barrier).toBeNull();
		expect(fixture.counts.release).toBe(0);
		expect(fixture.counts.effect).toBe(1);
	});

	it("quarantines unknown descendants instead of declaring cancellation complete", async () => {
		const fixture = fixtureFor({ unknown: true });

		const result = await fixture.coordinator.cancel(WORKFLOW_ID, null, EPOCH, "unknown-descendant");

		expect(result.status).toBe("paused");
		expect(result.attempts).toEqual(
			expect.arrayContaining([expect.objectContaining({ status: "quarantined", detail: "identity_lost" })]),
		);
		expect(fixture.store.payloads.map((payload) => payload.kind)).not.toContain("workflow_cancelled");
	});
});

function fixtureFor(options: Parameters<typeof fixture>[0] = {}): Fixture {
	return fixture(options);
}
