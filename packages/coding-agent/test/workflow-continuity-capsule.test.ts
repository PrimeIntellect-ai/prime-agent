import { describe, expect, it } from "vitest";
import {
	assertFreshContinuityCapsule,
	type ContinuityCapsuleOptions,
	deriveContinuityCapsule,
	deriveContinuityReadyTaskIds,
} from "../src/core/workflow/continuity-capsule.js";
import {
	canonicalJsonBytes,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowLeaseRef,
	type WorkflowLeaseStatus,
	type WorkflowProgressEntry,
	type WorkflowProgressLedger,
	type WorkflowResourceEnvelope,
	type WorkflowResourceVector,
} from "../src/core/workflow/contracts.js";
import type { WorkflowState } from "../src/core/workflow/reducer.js";
import {
	validateWorkflowTaskGraph,
	type WorkflowTask,
	type WorkflowTaskGraph,
} from "../src/core/workflow/task-graph.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

function artifactRef(artifactId: string): WorkflowArtifactRef {
	return {
		artifactId,
		relativePath: `artifacts/${artifactId}`,
		digest: digestObject({ artifactId }),
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function leaseRef(leaseId: string): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId,
		acquisitionEventSequence: 1,
		processIdentity: `process-${leaseId}`,
		rootDigest: "root",
		writerIdentity: "writer",
		acquiredAt: "2026-08-16T00:00:00.000Z",
		expiresAt: "2026-08-16T01:00:00.000Z",
	};
}

function decisionRef(decisionId: string): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "session-1" },
		decisionId,
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: digestObject({ decisionId }),
	};
}

function progressEntry(
	requirementId: string,
	status: WorkflowProgressEntry["status"],
	evidenceRefs: readonly WorkflowArtifactRef[],
	invalidatedByDecisionId: string | null = null,
): WorkflowProgressEntry {
	return {
		requirementId,
		status,
		evidenceRefs,
		evidenceRevisions: evidenceRefs.map(() => 1),
		regressionReason: status === "regressed" ? "current-audit-regression" : null,
		workspaceDigest: "workspace-3",
		auditorDecisionRef: decisionRef(`audit-${requirementId}`),
		observedAt: "2026-08-16T00:15:00.000Z",
		invalidatedByDecisionId: status === "regressed" ? invalidatedByDecisionId : null,
	};
}

function createWorkflowState(): WorkflowState {
	return {
		workflowId: "workflow-1",
		rootSessionId: "session-1",
		status: "active",
		phase: "planning",
		objective: "prove continuity",
		goalId: "goal-1",
		goalActive: true,
		goalStatus: "active",
		goalTokenBudget: 100,
		goalTokensUsed: 2,
		goalTimeUsedSeconds: 1,
		goalContinuationsUsed: 0,
		goalCreatedAt: 1,
		goalUpdatedAt: 1,
		goalLastReason: null,
		goalLastError: null,
		sourceJournalSequence: 3,
		sourceJournalDigest: "journal-3",
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		goalProjectionDigest: null,
		capacityDigest: "capacity",
		goalContractDigest: "goal-contract",
		approvalRequest: null,
		decisionRefs: [],
		profileDigest: "profile",
		configDigest: "config-3",
		skillSnapshotDigests: [],
		cloudAvailabilityDigest: null,
		scorecardDigest: "scorecard",
		resourceEnvelopeDigest: "envelope",
		continuityCapsuleDigest: null,
		provenRequirementIds: ["requirement-b", "requirement-a"],
		unprovenRequirementIds: ["requirement-c"],
		regressedRequirementIds: ["requirement-d"],
		workspaceDigest: "workspace-3",
		executionProfile: "inline",
		planRevision: 3,
		acceptedEvidenceRefs: [artifactRef("evidence-b"), artifactRef("evidence-a")],
		ownershipLeaseRefs: [leaseRef("ownership-b"), leaseRef("ownership-a")],
		resourceLeaseRefs: [leaseRef("resource-b"), leaseRef("resource-a")],
		failedStrategies: ["strategy-b", "strategy-a"],
		unresolvedDecisionRefs: [decisionRef("decision-b"), decisionRef("decision-a")],
		continuationEntryPoint: "planning",
		generationBinding: {
			writerIdentity: "writer",
			processGenerationId: "process",
			ownerIdentity: "owner",
		},
	};
}

function createProgressLedger(): WorkflowProgressLedger {
	const revisions = {
		contractRevision: 1,
		scorecardRevision: 2,
		planRevision: 3,
		configRevision: 1,
		evidenceRevision: 1,
	};
	const entries = [
		progressEntry("requirement-a", "proven", [artifactRef("evidence-a")]),
		progressEntry("requirement-b", "proven", [artifactRef("evidence-b")]),
		progressEntry("requirement-c", "unproven", []),
		progressEntry("requirement-d", "regressed", [], "audit-requirement-d"),
	];
	return {
		workflowId: "workflow-1",
		contractRevision: 1,
		scorecardRevision: 2,
		planRevision: 3,
		configRevision: 1,
		evidenceRevision: 1,
		revisions: {
			contractRevision: 1,
			scorecardRevision: 2,
			planRevision: 3,
			configRevision: 1,
			evidenceRevision: 1,
		},
		entries,
		progressDigest: digestObject({
			workflowId: "workflow-1",
			revisions,
			entries,
			evidenceDigest: progressEvidenceDigest(),
		}),
	};
}

function progressEvidenceDigest(): string {
	return digestObject(["evidence-a", "evidence-b"]);
}

function createCapsuleOptions(
	state: WorkflowState,
	ledger: WorkflowProgressLedger,
	includeReadinessContext = true,
): ContinuityCapsuleOptions {
	const artifactRefs = uniqueRefs([
		...state.acceptedEvidenceRefs,
		...ledger.entries.flatMap((entry) => entry.evidenceRefs),
	]);
	const decisionRefs: readonly WorkflowDecisionRef[] = uniqueRefs([
		...state.unresolvedDecisionRefs.map((ref) => decisionRef(ref.decisionId)),
		...ledger.entries.map((entry) => entry.auditorDecisionRef),
	]);
	const leaseRefs = uniqueRefs([...state.ownershipLeaseRefs, ...state.resourceLeaseRefs]);
	const leaseStatusById: Record<string, WorkflowLeaseStatus> = {};
	for (const lease of leaseRefs) leaseStatusById[lease.leaseId] = "active";
	const options: ContinuityCapsuleOptions = {
		validationContext: {
			currentAt: "2026-08-16T00:30:00.000Z",
			currentEpoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			validatedArtifactRefs: artifactRefs,
			validatedDecisionRefs: decisionRefs,
			validatedLeaseRefs: leaseRefs,
			leaseStatusById,
			progressEvidenceDigest: progressEvidenceDigest(),
		},
	};
	if (includeReadinessContext) options.readinessContext = { running: [], envelope: createReadinessEnvelope() };
	return options;
}

function uniqueRefs<T>(refs: readonly T[]): readonly T[] {
	const seen = new Set<string>();
	const unique: T[] = [];
	for (const ref of refs) {
		const digest = digestObject(ref);
		if (seen.has(digest)) continue;
		seen.add(digest);
		unique.push(ref);
	}
	return unique;
}

function deriveTestCapsule(
	state: WorkflowState,
	ledger: WorkflowProgressLedger,
	graph: WorkflowTaskGraph,
	readyTaskIds: readonly string[],
	mode: "resume" | "status_only" = "resume",
) {
	return deriveContinuityCapsule(state, ledger, graph, readyTaskIds, {
		...createCapsuleOptions(state, ledger),
		mode,
	});
}

function createTaskGraph(): WorkflowTaskGraph {
	return validateWorkflowTaskGraph([createReadinessTask("task-a"), createReadinessTask("task-b")], {
		knownSkillSnapshotDigests: [],
		allowedAuthority: ["read_workspace"],
		workspacePaths: ["src"],
		generatedOutputPaths: [],
		namedContracts: [],
	});
}

function createReadinessTask(taskId: string): WorkflowTask {
	return {
		taskId,
		planRevision: 1,
		objective: taskId,
		requirementIds: [],
		completionCriteria: [],
		dependencyTaskIds: [],
		ownedPaths: [`src/${taskId}.ts`],
		ownedContracts: [],
		requiredSkillSnapshotDigests: [],
		verificationCommandDigests: [],
		authority: ["read_workspace"],
		declaredResourceVector: {
			cpuMilliCores: 1,
			memoryBytes: 1,
			diskBytes: 1,
			ioWeight: 1,
			accelerators: [],
			providers: [],
			networkEgressBytes: 0,
			wallMilliseconds: 1,
			monetaryMicrounits: 1,
		},
		declaredControlCapacity: {
			processSlots: 0,
			childSessionSlots: 0,
			modelCallSlots: 0,
			modelInputTokens: 0,
			modelOutputTokens: 0,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		},
		status: "ready",
		attemptIds: [],
	};
}

function createReadinessGraph(): WorkflowTaskGraph {
	return validateWorkflowTaskGraph([createReadinessTask("task-a")], {
		knownSkillSnapshotDigests: [],
		allowedAuthority: ["read_workspace"],
		workspacePaths: ["src"],
		generatedOutputPaths: [],
		namedContracts: [],
	});
}

function createReadinessEnvelope(): WorkflowResourceEnvelope {
	const resources: WorkflowResourceVector = {
		cpuMilliCores: 10,
		memoryBytes: 10,
		diskBytes: 10,
		ioWeight: 10,
		accelerators: [],
		providers: [],
		networkEgressBytes: 10,
		wallMilliseconds: 100,
		monetaryMicrounits: 10,
	};
	const reserve: WorkflowResourceVector = {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 1,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
	};
	const capacity: WorkflowControlCapacityVector = {
		processSlots: 2,
		childSessionSlots: 2,
		modelCallSlots: 2,
		modelInputTokens: 2,
		modelOutputTokens: 2,
		verificationSlots: 2,
		redTeamSlots: 2,
		recoverySlots: 2,
	};
	const ledgerRef = artifactRef("ledger");
	return {
		envelopeId: "envelope-1",
		resources,
		controlPlaneReserve: reserve,
		controlPlaneReserveCapacity: { ...capacity },
		controlCapacity: { ...capacity },
		workerCapacity: { ...capacity },
		processSlots: 1,
		childSessionSlots: 1,
		candidateSlots: 0,
		executionCeilings: {
			maxWorkflowWallMilliseconds: 100,
			maxWorkflowTokens: 100,
			maxModelCalls: 2,
			maxTaskAttempts: 2,
			maxPlannerCycles: 2,
			maxDistinctStrategiesPerRequirement: 2,
			maxAnalysisAttemptsPerRequirement: 2,
			maxRecoveryAttemptsPerEffectClass: 2,
			renewalRequiresUserApproval: true,
		},
		providerQuotaSnapshotRef: ledgerRef,
		inventoryDigest: "inventory",
		pricingDigest: "pricing",
		terminationPolicyDigest: "termination",
		billingReconciliationPolicyDigest: "billing",
		egressPolicyDigest: "egress",
		validFrom: "2026-08-16T00:00:00.000Z",
		validUntil: "2026-08-16T00:01:00.000Z",
		capacityReceipt: null,
		approvalDecisionRef: decisionRef("decision-envelope"),
		canonicalLedgerRef: ledgerRef,
		canonicalLedgerDigest: "ledger-digest",
		envelopeDigest: "envelope-digest",
	};
}

describe("workflow continuity capsule", () => {
	it("derives deterministic canonical bytes with bounded sorted projections", () => {
		const state = createWorkflowState();
		const ledger = createProgressLedger();
		const graph = createTaskGraph();
		const capsule = deriveTestCapsule(state, ledger, graph, ["task-b", "task-a"]);

		expect(capsule).toMatchObject({
			workflowId: "workflow-1",
			sourceJournalSequence: 3,
			sourceEpoch: EPOCH,
			sourceJournalDigest: "journal-3",
			sourceConfigDigest: "config-3",
			workspaceDigest: "workspace-3",
			goalContractRevision: 1,
			scorecardRevision: 2,
			executionProfile: "inline",
			phase: "planning",
			provenRequirementIds: ["requirement-a", "requirement-b"],
			unprovenRequirementIds: ["requirement-c"],
			regressedRequirementIds: ["requirement-d"],
			planRevision: 3,
			readyTaskIds: ["task-a", "task-b"],
			ownershipLeaseRefs: [leaseRef("ownership-a"), leaseRef("ownership-b")],
			resourceLeaseRefs: [leaseRef("resource-a"), leaseRef("resource-b")],
			failedStrategies: ["strategy-a", "strategy-b"],
			unresolvedDecisionRefs: [decisionRef("decision-a"), decisionRef("decision-b")],
			continuationEntryPoint: "planning",
			maxBytes: 16_384,
		});
		expect(capsule.capsuleDigest).toBe(digestObject({ ...capsule, capsuleDigest: "" }));
		expect(canonicalSize(capsule)).toBeLessThanOrEqual(capsule.maxBytes);
		expect(deriveTestCapsule(state, ledger, graph, ["task-a", "task-b"])).toEqual(capsule);
	});

	it("fails closed when any authoritative freshness input or digest is stale", () => {
		const state = createWorkflowState();
		const ledger = createProgressLedger();
		const graph = createTaskGraph();
		const readyTaskIds = ["task-a", "task-b"];
		const options = createCapsuleOptions(state, ledger);
		const capsule = deriveTestCapsule(state, ledger, graph, readyTaskIds);

		expect(() =>
			assertFreshContinuityCapsule(
				capsule,
				state,
				ledger,
				graph,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				capsule.maxBytes,
				readyTaskIds,
				options,
			),
		).not.toThrow();

		const staleInputs: Array<
			[
				string,
				Parameters<typeof assertFreshContinuityCapsule>[1],
				Parameters<typeof assertFreshContinuityCapsule>[4],
				Parameters<typeof assertFreshContinuityCapsule>[5],
				string,
				string,
				number,
				number,
				number,
				readonly string[],
			]
		> = [
			[
				"journal",
				state,
				"changed-journal",
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"epoch",
				state,
				state.sourceJournalDigest,
				{ storeEpoch: 1, coordinatorEpoch: 2 },
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"config",
				state,
				state.sourceJournalDigest,
				EPOCH,
				"changed-config",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"workspace",
				state,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				"changed-workspace",
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"contract revision",
				state,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				2,
				ledger.scorecardRevision,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"scorecard revision",
				state,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				3,
				ledger.planRevision,
				readyTaskIds,
			],
			[
				"plan revision",
				state,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				4,
				readyTaskIds,
			],
			[
				"ready IDs",
				state,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				["task-c"],
			],
		];
		for (const [
			,
			currentState,
			journalDigest,
			epoch,
			configDigest,
			workspaceDigest,
			contractRevision,
			scorecardRevision,
			planRevision,
			currentReadyTaskIds,
		] of staleInputs) {
			expect(() =>
				assertFreshContinuityCapsule(
					capsule,
					currentState,
					ledger,
					graph,
					journalDigest,
					epoch,
					configDigest,
					workspaceDigest,
					contractRevision,
					scorecardRevision,
					planRevision,
					capsule.maxBytes,
					currentReadyTaskIds,
					options,
				),
			).toThrow(/stale|foreign|ready|graph/i);
		}

		const forged = { ...capsule, capsuleDigest: "0".repeat(64) };
		expect(() =>
			assertFreshContinuityCapsule(
				forged,
				state,
				ledger,
				graph,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				capsule.maxBytes,
				readyTaskIds,
				options,
			),
		).toThrow(/stale/i);
	});

	it("uses the task graph readiness projection supplied by the host", () => {
		const graph = createReadinessGraph();
		const envelope = createReadinessEnvelope();

		expect(deriveContinuityReadyTaskIds(graph, [], envelope)).toEqual(["task-a"]);
	});

	it("recomputes readiness during freshness validation when host resources change", () => {
		const state = createWorkflowState();
		const ledger = createProgressLedger();
		const graph = createReadinessGraph();
		const envelope = createReadinessEnvelope();
		const options: ContinuityCapsuleOptions = {
			...createCapsuleOptions(state, ledger),
			readinessContext: { running: [], envelope },
		};
		const capsule = deriveContinuityCapsule(state, ledger, graph, ["task-a"], options);
		expect(() =>
			assertFreshContinuityCapsule(
				capsule,
				state,
				ledger,
				graph,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				capsule.maxBytes,
				["task-a"],
				options,
			),
		).not.toThrow();

		const constrainedEnvelope = {
			...envelope,
			resources: { ...envelope.resources, cpuMilliCores: 1 },
		};
		expect(() =>
			assertFreshContinuityCapsule(
				capsule,
				state,
				ledger,
				graph,
				state.sourceJournalDigest,
				EPOCH,
				state.configDigest ?? "",
				state.workspaceDigest,
				ledger.contractRevision,
				ledger.scorecardRevision,
				ledger.planRevision,
				capsule.maxBytes,
				["task-a"],
				{ ...options, readinessContext: { running: [], envelope: constrainedEnvelope } },
			),
		).toThrow(/readiness|stale/i);
	});

	it("requires a complete current readiness context for resumable freshness", () => {
		const state = createWorkflowState();
		const ledger = createProgressLedger();
		const graph = createTaskGraph();
		const incompleteOptions = createCapsuleOptions(state, ledger, false);

		expect(() => deriveContinuityCapsule(state, ledger, graph, ["task-a", "task-b"], incompleteOptions)).toThrow(
			/readiness context/i,
		);
	});

	it("rejects readiness IDs that are foreign to the current graph", () => {
		const state = createWorkflowState();
		expect(() => deriveTestCapsule(state, createProgressLedger(), createTaskGraph(), ["foreign-task"])).toThrow(
			/ready|unknown|graph/i,
		);
	});

	it("projects status, phase, wait state, and the complete progress ledger", () => {
		const state = createWorkflowState();
		const ledger = createProgressLedger();
		const capsule = deriveTestCapsule(state, ledger, createTaskGraph(), ["task-a", "task-b"]);

		expect(capsule.status).toBe(state.status);
		expect(capsule.phase).toBe(state.phase);
		expect(capsule.waitState).toBe("ready");
		expect(capsule.progressLedger).toMatchObject({
			contractRevision: ledger.contractRevision,
			scorecardRevision: ledger.scorecardRevision,
			planRevision: ledger.planRevision,
			configRevision: ledger.configRevision,
			evidenceRevision: ledger.evidenceRevision,
			progressDigest: ledger.progressDigest,
		});
		expect(new Set(capsule.progressLedger.entries.map((entry) => entry.requirementId))).toEqual(
			new Set(ledger.entries.map((entry) => entry.requirementId)),
		);
		expect(capsule.progressLedger).not.toBe(ledger);
		expect(capsule.progressLedger.evidenceRevision).toBe(ledger.evidenceRevision);
		expect(capsule.progressLedger.progressDigest).toBe(ledger.progressDigest);
	});

	it("independently validates progress digest and evidence for proven requirements", () => {
		const state = createWorkflowState();
		const graph = createTaskGraph();
		const ledger = createProgressLedger();
		const emptyProvenEntry = {
			...ledger.entries[0]!,
			evidenceRefs: [],
			evidenceRevisions: [],
		};
		const emptyProvenLedger = {
			...ledger,
			entries: [emptyProvenEntry, ...ledger.entries.slice(1)],
			progressDigest: digestObject({
				workflowId: ledger.workflowId,
				revisions: ledger.revisions,
				entries: [emptyProvenEntry, ...ledger.entries.slice(1)],
				evidenceDigest: progressEvidenceDigest(),
			}),
		};
		expect(() => deriveTestCapsule(state, emptyProvenLedger, graph, ["task-a", "task-b"])).toThrow(
			/proven|evidence/i,
		);

		const mismatchedEntry = {
			...ledger.entries[0]!,
			evidenceRefs: [artifactRef("unrelated-evidence")],
			evidenceRevisions: [1],
		};
		const mismatchedEntries = [mismatchedEntry, ...ledger.entries.slice(1)];
		const mismatchedLedger = {
			...ledger,
			entries: mismatchedEntries,
			progressDigest: digestObject({
				workflowId: ledger.workflowId,
				revisions: ledger.revisions,
				entries: mismatchedEntries,
				evidenceDigest: progressEvidenceDigest(),
			}),
		};
		expect(() => deriveTestCapsule(state, mismatchedLedger, graph, ["task-a", "task-b"])).toThrow(
			/evidence|accepted|requirement/i,
		);

		const forgedDigestLedger = { ...ledger, progressDigest: digestObject({ forged: true }) };
		expect(() => deriveTestCapsule(state, forgedDigestLedger, graph, ["task-a", "task-b"])).toThrow(
			/progress|digest/i,
		);
	});

	it("rejects terminal resume unless status-only projection is explicit", () => {
		const terminalState = { ...createWorkflowState(), status: "complete" as const };
		const graph = createTaskGraph();
		const ledger = createProgressLedger();

		expect(() => deriveTestCapsule(terminalState, ledger, graph, ["task-a", "task-b"])).toThrow(/terminal|resume/i);
		expect(deriveTestCapsule(terminalState, ledger, graph, ["task-a", "task-b"], "status_only").status).toBe(
			"complete",
		);
	});

	it("allows status-only terminal projections to describe released leases without resumable authority", () => {
		const terminalState = { ...createWorkflowState(), status: "complete" as const };
		const ledger = createProgressLedger();
		const graph = createTaskGraph();
		const options = createCapsuleOptions(terminalState, ledger);
		const context = options.validationContext!;
		const releasedAt = "2026-08-16T02:00:00.000Z";
		const releasedOptions: ContinuityCapsuleOptions = {
			...options,
			mode: "status_only",
			validationContext: {
				...context,
				currentAt: releasedAt,
				leaseStatusById: Object.fromEntries(
					Object.keys(context.leaseStatusById).map((leaseId) => [leaseId, "released"]),
				),
			},
		};
		const capsule = deriveContinuityCapsule(terminalState, ledger, graph, ["task-a", "task-b"], releasedOptions);
		expect(capsule.status).toBe("complete");
		expect(capsule.ownershipLeaseRefs).not.toHaveLength(0);
		const activeReleasedOptions: ContinuityCapsuleOptions = {
			...releasedOptions,
			mode: "resume",
			validationContext: {
				...releasedOptions.validationContext!,
				currentAt: "2026-08-16T00:30:00.000Z",
			},
		};
		expect(() =>
			deriveContinuityCapsule(createWorkflowState(), ledger, graph, ["task-a", "task-b"], activeReleasedOptions),
		).toThrow(/resumable|released|lease/i);
		expect(() =>
			deriveContinuityCapsule(terminalState, ledger, graph, ["task-a", "task-b"], {
				...releasedOptions,
				mode: "resume",
			}),
		).toThrow(/terminal|resume|lease/i);
	});

	it("uses a code-point total order and deep-freezes cloned projections", () => {
		const state = {
			...createWorkflowState(),
			failedStrategies: ["\uE000", "\u{10000}"],
		};
		const ledger = createProgressLedger();
		const capsule = deriveTestCapsule(state, ledger, createTaskGraph(), ["task-a", "task-b"]);

		expect(capsule.failedStrategies).toEqual(["\uE000", "\u{10000}"]);
		expect(Object.isFrozen(capsule)).toBe(true);
		expect(Object.isFrozen(capsule.sourceEpoch)).toBe(true);
		expect(Object.isFrozen(capsule.provenRequirementIds)).toBe(true);
		expect(Object.isFrozen(capsule.progressLedger)).toBe(true);
		expect(Object.isFrozen(capsule.acceptedEvidenceRefs)).toBe(true);
		expect(Object.isFrozen(capsule.acceptedEvidenceRefs[0])).toBe(true);
	});

	it("rejects invalid nested reference scope, epoch, sequence, and expiry", () => {
		const graph = createTaskGraph();
		const ledger = createProgressLedger();
		const base = createWorkflowState();
		const invalidStates: WorkflowState[] = [
			{
				...base,
				unresolvedDecisionRefs: [
					{
						...decisionRef("foreign"),
						decisionScope: { kind: "workflow", workflowId: "other", rootSessionId: "session-1" },
					},
				],
			},
			{ ...base, unresolvedDecisionRefs: [{ ...decisionRef("future-epoch"), coordinatorEpoch: 2 }] },
			{
				...base,
				acceptedEvidenceRefs: [{ ...artifactRef("future-artifact"), sourceEventSequence: 99 }],
			},
			{
				...base,
				ownershipLeaseRefs: [{ ...leaseRef("expired"), expiresAt: "2026-08-15T23:00:00.000Z" }],
			},
		];

		for (const invalidState of invalidStates) {
			expect(() => deriveTestCapsule(invalidState, ledger, graph, ["task-a", "task-b"])).toThrow(
				/decision|scope|epoch|sequence|expiry|lease|artifact/i,
			);
		}
	});

	it.each([
		"/absolute/path",
		"C:/absolute/path",
		"C:\\absolute\\path",
		"\\\\server\\share\\path",
		"//server/share/path",
	])("rejects non-relative artifact paths on every host", (relativePath) => {
		const state = {
			...createWorkflowState(),
			acceptedEvidenceRefs: [{ ...artifactRef("unsafe-path"), relativePath }],
		};
		expect(() => deriveTestCapsule(state, createProgressLedger(), createTaskGraph(), ["task-a", "task-b"])).toThrow(
			/path|relative|unsafe/i,
		);
	});

	it("rejects oversized semantic input before canonical processing", () => {
		const state = { ...createWorkflowState(), failedStrategies: ["x".repeat(2048)] };

		expect(() => deriveTestCapsule(state, createProgressLedger(), createTaskGraph(), ["task-a", "task-b"])).toThrow(
			/bound|size|length/i,
		);
		const oversizedArrayState = {
			...createWorkflowState(),
			failedStrategies: Array.from({ length: 257 }, (_, index) => `strategy-${index}`),
		};
		expect(() =>
			deriveTestCapsule(oversizedArrayState, createProgressLedger(), createTaskGraph(), ["task-a", "task-b"]),
		).toThrow(/bound|size|length/i);
	});
});

function canonicalSize(value: unknown): number {
	return canonicalJsonBytes(value).byteLength;
}
