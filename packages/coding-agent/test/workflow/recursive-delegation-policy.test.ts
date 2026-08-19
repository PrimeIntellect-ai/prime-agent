import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
} from "../../src/core/workflow/contracts.js";
import {
	digestRecursiveDelegationHostEvidence,
	planAdaptiveRecursiveDelegation,
	planAdaptiveRecursiveDelegationFromHost,
	type RecursiveDelegationCandidate,
	type RecursiveDelegationDurableIntentBatch,
	type RecursiveDelegationHostCeilings,
	type RecursiveDelegationHostComposition,
	type RecursiveDelegationHostEvidence,
	type RecursiveDelegationHostGraphAuthority,
	type RecursiveDelegationPathProof,
	type RecursiveDelegationPolicyInput,
	type RecursiveDelegationResourceVector,
	type RecursiveDelegationSynthesisObligation,
} from "../../src/core/workflow/recursive-delegation-policy.js";

const WORKFLOW_ID = "workflow-recursive-delegation";
const WORKER_ID = "worker-root";
const COORDINATOR_ID = "coordinator-root";
const BINDING_DIGEST = digestObject({ binding: "recursive-binding" });
const STATE_DIGEST = digestObject({ state: "recursive-state" });
const LEDGER_DIGEST = digestObject({ resourceLedger: WORKFLOW_ID });
const REVISION = 7;
const EPOCH_REF: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const RECEIPT_CONTEXT = createFixtureHostReceiptConsumerContext();

const ZERO_RESOURCE: RecursiveDelegationResourceVector = {
	cpuMilliCores: 0,
	memoryBytes: 0,
	diskBytes: 0,
	ioWeight: 0,
	networkEgressBytes: 0,
	wallMilliseconds: 0,
	monetaryMicrounits: 0,
	processSlots: 0,
	childSessionSlots: 0,
	modelCallSlots: 0,
	modelInputTokens: 0,
	modelOutputTokens: 0,
	verificationSlots: 0,
	redTeamSlots: 0,
	recoverySlots: 0,
};

const CAPACITY: RecursiveDelegationResourceVector = {
	...ZERO_RESOURCE,
	cpuMilliCores: 12,
	memoryBytes: 12_000,
	diskBytes: 12_000,
	ioWeight: 12,
	networkEgressBytes: 12_000,
	wallMilliseconds: 12_000,
	monetaryMicrounits: 12_000,
	processSlots: 8,
	childSessionSlots: 5,
	modelCallSlots: 8,
	modelInputTokens: 12_000,
	modelOutputTokens: 12_000,
	verificationSlots: 5,
	redTeamSlots: 2,
	recoverySlots: 4,
};

const RESERVE: RecursiveDelegationResourceVector = {
	...ZERO_RESOURCE,
	cpuMilliCores: 1,
	memoryBytes: 1_000,
	diskBytes: 1_000,
	ioWeight: 1,
	networkEgressBytes: 1_000,
	wallMilliseconds: 1_000,
	monetaryMicrounits: 1_000,
	processSlots: 1,
	childSessionSlots: 1,
	modelCallSlots: 1,
	modelInputTokens: 1_000,
	modelOutputTokens: 1_000,
	verificationSlots: 1,
	recoverySlots: 1,
};

function artifact(id: string, sizeBytes = 256): WorkflowArtifactRef {
	return {
		artifactId: id,
		relativePath: `recursive/${id}.json`,
		digest: digestObject({ artifact: id }),
		sizeBytes,
		sourceEventSequence: 1,
	};
}

function proof(declaredPath: string, realPath = `/workspace/${declaredPath}`): RecursiveDelegationPathProof {
	const value = {
		declaredPath,
		canonicalPath: realPath,
		realPath,
		caseFoldedRealPath: realPath.toLowerCase(),
		symlinkResolved: true as const,
		caseResolved: true as const,
	};
	return { ...value, proofDigest: digestObject(value) };
}

function resource(overrides: Partial<RecursiveDelegationResourceVector> = {}): RecursiveDelegationResourceVector {
	return { ...ZERO_RESOURCE, ...overrides };
}

function candidate(id: string, overrides: Partial<RecursiveDelegationCandidate> = {}): RecursiveDelegationCandidate {
	const evidenceRef = artifact(`${id}-evidence`);
	const packetRef = artifact(`${id}-packet`, 128);
	return {
		childId: id,
		taskId: `task:${id}`,
		workKey: `work:${id}`,
		scopeId: `scope:${id}`,
		atomicGroupId: null,
		dependencyTaskIds: [],
		objective: `Independently verify ${id}`,
		ownership: "read_only",
		readSet: [],
		writeSet: [],
		pathProofs: [],
		independentVerification: {
			criterion: `criterion:${id}`,
			verified: true,
			evidenceRefs: [evidenceRef],
			verifierDigest: digestObject({ verifier: id }),
		},
		estimates: {
			estimatedCriticalPathSavedWallMilliseconds: 220,
			contextTransferWallMilliseconds: 12,
			reviewWallMilliseconds: 18,
			mergeConflictWallMilliseconds: 0,
			computeWallMilliseconds: 10,
			computeCostMicrounits: 100,
			childWallMilliseconds: 180,
			queueWaitWallMilliseconds: 12,
			verified: true,
			maxVerifiedCriticalPathSavedWallMilliseconds: 220,
			maxVerifiedComputeCostMicrounits: 100,
			maxVerifiedResourceReservation: resource({
				cpuMilliCores: 2,
				memoryBytes: 1_000,
				diskBytes: 1_000,
				ioWeight: 2,
				networkEgressBytes: 1_000,
				wallMilliseconds: 400,
				monetaryMicrounits: 500,
				processSlots: 1,
				childSessionSlots: 1,
				modelCallSlots: 1,
				modelInputTokens: 1_000,
				modelOutputTokens: 1_000,
				verificationSlots: 1,
				recoverySlots: 1,
			}),
			evidenceRef,
		},
		resourceReservation: resource({
			cpuMilliCores: 1,
			memoryBytes: 500,
			diskBytes: 500,
			ioWeight: 1,
			networkEgressBytes: 500,
			wallMilliseconds: 180,
			monetaryMicrounits: 100,
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 500,
			modelOutputTokens: 500,
			verificationSlots: 1,
		}),
		usefulVerifiedCompletionUnits: 12,
		relevance: "required",
		workClass: "substantive",
		blockerAssessment: { complete: true, blockers: [`blocker:${id}`] },
		actionable: true,
		boundedPacketRef: packetRef,
		fullReportRef: artifact(`${id}-report`, 8_000),
		...overrides,
	};
}

function input(overrides: Partial<RecursiveDelegationPolicyInput> = {}): RecursiveDelegationPolicyInput {
	return {
		workflowId: WORKFLOW_ID,
		workerId: WORKER_ID,
		coordinatorId: COORDINATOR_ID,
		workerDepth: 1,
		adaptive: {
			enabled: true,
			limits: {
				maxDepth: 99,
				maxFanout: 99,
				maxCandidates: 99,
				maxPacketBytes: 99_999,
				minUsefulVerifiedCompletionUnits: 0,
				minUsefulCompletionPerWallMillisecond: 0,
				diminishingReturnsFactor: 0,
				maxChildReservation: CAPACITY,
				maxChildCostMicrounits: Number.MAX_SAFE_INTEGER,
			},
		},
		budgets: {
			capacity: CAPACITY,
			inUse: ZERO_RESOURCE,
			verifierReserve: RESERVE,
			controlReserve: RESERVE,
			urgentRecoveryReserve: RESERVE,
		},
		coordinatorPacketRef: artifact("coordinator-packet", 512),
		candidates: [candidate("alpha"), candidate("beta")],
		childOutcomes: [],
		...overrides,
	};
}

function hostEvidenceFor(candidateValue: RecursiveDelegationCandidate): RecursiveDelegationHostEvidence {
	return {
		childId: candidateValue.childId,
		taskId: candidateValue.taskId,
		workKey: candidateValue.workKey,
		scopeId: candidateValue.scopeId,
		atomicGroupId: candidateValue.atomicGroupId,
		dependencyTaskIds: [...candidateValue.dependencyTaskIds],
		objective: candidateValue.objective,
		ownership: candidateValue.ownership,
		readSet: [...candidateValue.readSet],
		writeSet: [...candidateValue.writeSet],
		pathProofs: [...candidateValue.pathProofs],
		independentVerification: candidateValue.independentVerification,
		estimates: candidateValue.estimates,
		resourceReservation: candidateValue.resourceReservation,
		usefulVerifiedCompletionUnits: candidateValue.usefulVerifiedCompletionUnits,
		relevance: candidateValue.relevance,
		workClass: candidateValue.workClass,
		blockerAssessment: candidateValue.blockerAssessment,
		actionable: candidateValue.actionable,
		boundedPacketRef: candidateValue.boundedPacketRef,
		sectionRefs: [artifact(`${candidateValue.childId}-section`, 96)],
		modelBinding: {
			provider: "host-provider",
			model: "host-model",
			reasoning: "host-reasoning",
			allowFallback: false,
		},
	};
}

function graphFor(candidates: readonly RecursiveDelegationCandidate[]): RecursiveDelegationHostGraphAuthority {
	return {
		graphRevision: 4,
		workspaceRootRealPath: "/workspace",
		nodes: candidates.map((value) => ({
			childId: value.childId,
			taskId: value.taskId,
			workKey: value.workKey,
			scopeId: value.scopeId,
			atomicGroupId: value.atomicGroupId,
			dependencyTaskIds: [...value.dependencyTaskIds],
			readSet: [...value.readSet],
			writeSet: [...value.writeSet],
			pathProofs: [...value.pathProofs],
		})),
	};
}

interface HostOverrides {
	readonly ceilings?: Partial<RecursiveDelegationHostCeilings>;
	readonly budget?: RecursiveDelegationPolicyInput["budgets"];
	readonly hostEvidence?: readonly RecursiveDelegationHostEvidence[];
	readonly graphAuthority?: RecursiveDelegationHostGraphAuthority;
	readonly currentState?: Partial<RecursiveDelegationHostComposition["currentState"]>;
	readonly workerModelBinding?: RecursiveDelegationHostComposition["workerModelBinding"];
	readonly synthesisObligation?: RecursiveDelegationSynthesisObligation;
	readonly persistIntentBatch?: RecursiveDelegationHostComposition["persistIntentBatch"];
	readonly receiptContext?: RecursiveDelegationHostComposition["receiptContext"];
	readonly oneUse?: boolean;
}

function composition(
	request: RecursiveDelegationPolicyInput,
	overrides: HostOverrides = {},
): RecursiveDelegationHostComposition {
	const hostEvidence = overrides.hostEvidence ?? request.candidates.map(hostEvidenceFor);
	const graphAuthority = overrides.graphAuthority ?? graphFor(request.candidates);
	const ceilings: RecursiveDelegationHostCeilings = {
		maxDepth: 2,
		maxFanout: 2,
		maxCandidates: 8,
		maxPacketBytes: 4_096,
		maxPacketRefs: 32,
		minUsefulVerifiedCompletionUnits: 1,
		minUsefulCompletionPerWallMillisecond: 0.01,
		diminishingReturnsFactor: 0.2,
		maxChildReservation: resource({
			cpuMilliCores: 2,
			memoryBytes: 1_000,
			diskBytes: 1_000,
			ioWeight: 2,
			networkEgressBytes: 1_000,
			wallMilliseconds: 400,
			monetaryMicrounits: 500,
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1_000,
			modelOutputTokens: 1_000,
			verificationSlots: 1,
			recoverySlots: 1,
		}),
		maxChildCostMicrounits: 500,
		...overrides.ceilings,
	};
	const outcomeChildIds = (request.childOutcomes ?? [])
		.map(({ childId }) => childId)
		.filter((childId) => request.candidates.some((candidateValue) => candidateValue.childId === childId));
	const currentState = {
		workflowId: WORKFLOW_ID,
		stateDigest: STATE_DIGEST,
		revision: REVISION,
		epochRef: EPOCH_REF,
		resourceLedgerDigest: LEDGER_DIGEST,
		graphRevision: graphAuthority.graphRevision,
		selectedChildIds: outcomeChildIds,
		currentChildIds: outcomeChildIds,
		completedTaskIds: [],
		...overrides.currentState,
	};
	const synthesisObligation =
		overrides.synthesisObligation ??
		(() => {
			const verifier =
				[...request.candidates].sort((left, right) => left.childId.localeCompare(right.childId))[0]?.childId ??
				"missing-verifier";
			const unsigned = {
				l1OwnerId: WORKER_ID,
				contradictionVerifierChildId: verifier,
				contradictionCheckRequired: true as const,
				acceptanceCriteria: "L1 synthesizes all bounded child evidence and resolves contradictions.",
				evidenceRefs: [artifact("q25-synthesis")],
			};
			return { ...unsigned, obligationDigest: digestObject(unsigned) };
		})();
	const workerModelBinding = Object.hasOwn(overrides, "workerModelBinding")
		? overrides.workerModelBinding
		: {
				provider: "host-provider",
				model: "host-worker-model",
				reasoning: "host-worker-reasoning",
				allowFallback: false as const,
			};
	const budget = overrides.budget ?? request.budgets;
	const hostData = {
		request,
		ceilings,
		budget,
		hostEvidence,
		graphAuthority,
		currentState,
		workerModelBinding,
		synthesisObligation,
	};
	let persistedBatchDigest: string | null = null;
	const persistIntentBatch = async (batch: RecursiveDelegationDurableIntentBatch): Promise<void> => {
		if (persistedBatchDigest !== null) throw new Error("fixture CAS already committed this host revision");
		persistedBatchDigest = batch.batchDigest;
	};
	const evidenceDigest = digestRecursiveDelegationHostEvidence(hostData);
	const operationDigest = digestObject({ operation: "recursive-delegation", workflowId: WORKFLOW_ID });
	const receipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: `recursive-plan:${evidenceDigest}`,
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: BINDING_DIGEST,
		payloadDigest: evidenceDigest,
		artifactRef: artifact(`recursive-receipt:${evidenceDigest}`),
		issuedAt: "2026-08-17T15:00:00.000Z",
		validUntil: "2026-08-18T15:00:00.000Z",
		keyId: "fixture-receipt-key",
		stateDigest: STATE_DIGEST,
		revision: REVISION,
		capabilityBinding: {
			capability: "workflow_recursive_delegation_plan",
			resourceDigest: evidenceDigest,
			operationDigest,
			executionIdentity: null,
			sessionId: null,
		},
		oneUse: overrides.oneUse ?? false,
	});
	return {
		receiptContext: overrides.receiptContext ?? RECEIPT_CONTEXT,
		authorizationToken: { receipt, bindingDigest: BINDING_DIGEST, operationDigest },
		trustedNow: "2026-08-17T16:00:00.000Z",
		currentStateDigest: STATE_DIGEST,
		currentRevision: REVISION,
		epochRef: EPOCH_REF,
		ceilings,
		budget,
		hostEvidence,
		graphAuthority,
		currentState,
		workerModelBinding,
		synthesisObligation,
		persistIntentBatch: overrides.persistIntentBatch ?? persistIntentBatch,
	};
}

async function run(
	request: RecursiveDelegationPolicyInput,
	overrides: HostOverrides = {},
): Promise<Awaited<ReturnType<typeof planAdaptiveRecursiveDelegation>>> {
	return planAdaptiveRecursiveDelegation(request, composition(request, overrides));
}

describe("adaptive recursive delegation policy", () => {
	it("admits independent second-level children and reduces modeled critical path", async () => {
		const result = await run(input());

		expect(result.status).toBe("admitted");
		expect(result.selectedChildren.map(({ childId }) => childId)).toEqual(["alpha", "beta"]);
		expect(result.modeledCriticalPath.parallelWallMilliseconds).toBeLessThan(
			result.modeledCriticalPath.serialWallMilliseconds,
		);
		expect(result.modeledCriticalPath.savedWallMilliseconds).toBeGreaterThan(0);
		expect(result.parentAccountability).toEqual({
			integrationOwner: WORKER_ID,
			contextOwner: WORKER_ID,
			coordinatorId: COORDINATOR_ID,
		});
		expect(result.parentAcceptanceObligation).toMatchObject({
			required: true,
			integrationOwner: WORKER_ID,
			contextOwner: WORKER_ID,
			acceptanceOwner: WORKER_ID,
		});
		expect(result.reservationIntent?.commitRequired).toBe(true);
		expect(result.reservationIntent?.expectedStateDigest).toBe(STATE_DIGEST);
	});

	it("admits four disjoint read-only lenses with one bounded synthesis packet and a verifier reserve", async () => {
		const lensIds = ["authority", "causal-time", "model-control", "repository-reuse"];
		const lenses = lensIds.map((id) =>
			candidate(`q25-l2-${id}`, {
				readSet: [`q25/${id}.md`],
				pathProofs: [proof(`q25/${id}.md`)],
				blockerAssessment: { complete: true, blockers: ["blocker:shared"] },
			}),
		);
		const result = await run(input({ candidates: lenses }), {
			ceilings: { maxFanout: 4 },
			budget: {
				...input().budgets,
				capacity: { ...CAPACITY, childSessionSlots: 7, verificationSlots: 7 },
			},
		});

		expect(result.status).toBe("admitted");
		expect(result.selectedChildren.map(({ childId }) => childId)).toEqual(lensIds.map((id) => `q25-l2-${id}`));
		expect(result.coordinatorPacket.fullReportsTransmitted).toBe(false);
		expect(result.synthesisObligation.l1OwnerId).toBe(WORKER_ID);
		expect(result.synthesisObligation.contradictionCheckRequired).toBe(true);
		expect(result.selectedChildren.map(({ childId }) => childId)).toContain(
			result.synthesisObligation.contradictionVerifierChildId,
		);
	});

	it("keeps coupled migration source and test under one owner while admitting an independent review sibling", async () => {
		const migrationSource = candidate("migration-source", {
			taskId: "task:migration-source",
			scopeId: "migration-source-scope",
			atomicGroupId: "migration-loop",
			ownership: "write_set",
			writeSet: ["src/migration.ts"],
			pathProofs: [proof("src/migration.ts")],
		});
		const migrationTest = candidate("migration-test", {
			taskId: "task:migration-test",
			scopeId: "migration-test-scope",
			atomicGroupId: "migration-loop",
			ownership: "write_set",
			writeSet: ["test/migration.test.ts"],
			pathProofs: [proof("test/migration.test.ts")],
		});
		const independentReview = candidate("q25-spec-review", {
			readSet: ["spec/q25.md"],
			pathProofs: [proof("spec/q25.md")],
		});
		const result = await run(input({ candidates: [migrationSource, migrationTest, independentReview] }));

		expect(result.selectedChildren.map(({ childId }) => childId)).toEqual(["migration-source", "q25-spec-review"]);
		expect(result.deniedCandidates).toContainEqual({
			childId: "migration-test",
			reasons: ["atomic_group_conflict"],
		});
		expect(result.deniedCandidates).not.toContainEqual({ childId: "q25-spec-review", reasons: expect.anything() });
	});

	it("fails closed when a candidate is already present in the current or selected child graph", async () => {
		const duplicate = candidate("already-current");
		const result = await run(input({ candidates: [duplicate] }), {
			currentState: {
				selectedChildIds: [duplicate.childId],
				currentChildIds: [duplicate.childId],
			},
		});

		expect(result.status).toBe("denied");
		expect(result.deniedCandidates).toEqual([{ childId: duplicate.childId, reasons: ["host_graph_mismatch"] }]);
	});

	it("preserves verifier, control, and urgent-recovery reserves across every resource dimension", async () => {
		const saturatedCapacity = resource({
			cpuMilliCores: 3,
			childSessionSlots: 3,
			processSlots: 3,
			verificationSlots: 3,
		});
		const result = await run(
			input({
				budgets: {
					capacity: saturatedCapacity,
					inUse: RESERVE,
					verifierReserve: RESERVE,
					controlReserve: RESERVE,
					urgentRecoveryReserve: RESERVE,
				},
			}),
		);

		expect(result.status).toBe("denied");
		expect(result.denialReasons).toContain("protected_reserve");
	});

	it("emits durable urgent escalation to worker and coordinator while siblings continue", async () => {
		const result = await run(
			input({
				childOutcomes: [
					{
						childId: "alpha",
						status: "failed",
						reason: "nested verification failed",
						outputDigest: digestObject({ output: "alpha" }),
						evidenceRefs: [artifact("alpha-failure")],
						ledgerDigest: LEDGER_DIGEST,
						boundedPacketRef: artifact("alpha-failure-packet", 128),
					},
				],
			}),
		);

		expect(result.escalationIntents).toHaveLength(1);
		expect(result.escalationIntents[0]).toMatchObject({
			audiences: [WORKER_ID, COORDINATOR_ID],
			childId: "alpha",
			durable: true,
			siblingPolicy: "continue",
			releaseIntent: { durable: true, childId: "alpha" },
		});
		expect(result.escalationIntents[0]?.releaseIntent.expectedEpochRef).toEqual(EPOCH_REF);
		expect(result.escalationIntents[0]?.continueSiblingIds).toEqual(["beta"]);
	});

	it("requires authenticated ledger evidence and a bounded failure packet for nested failures", async () => {
		const outcome = {
			childId: "alpha",
			status: "failed" as const,
			reason: "nested verification failed",
			outputDigest: digestObject({ output: "alpha" }),
			evidenceRefs: [artifact("alpha-failure")],
			ledgerDigest: digestObject({ resourceLedger: WORKFLOW_ID }),
			boundedPacketRef: artifact("alpha-failure-packet", 128),
		};
		const result = await run(input({ childOutcomes: [outcome as never] }));

		expect(result.escalationIntents[0]).toMatchObject({
			childId: "alpha",
			reason: "nested verification failed",
			boundedPacketRef: outcome.boundedPacketRef,
		});

		const missingEvidence = { ...outcome, ledgerDigest: digestObject({ forgedLedger: true }) };
		await expect(run(input({ childOutcomes: [missingEvidence as never] }))).rejects.toThrow(/^CONTRACT_CHANGE:/u);
	});

	it("keeps full reports artifact-backed and sends bounded packet references only", async () => {
		const result = await run(input({ candidates: [candidate("alpha")] }));

		expect(result.selectedChildren[0]).not.toHaveProperty("fullReportRef");
		expect(result.coordinatorPacket.childArtifactRefs.map(({ artifactId }) => artifactId)).not.toContain(
			"alpha-report",
		);
		expect(result.coordinatorPacket.boundedPacketRefs).toEqual([
			{ childId: "alpha", ref: expect.objectContaining({ artifactId: "alpha-packet" }) },
		]);
		expect(result.coordinatorPacket.sectionRefs).toEqual([
			{ childId: "alpha", refs: [expect.objectContaining({ artifactId: "alpha-section" })] },
		]);
		expect(result.coordinatorPacket.blockers).toEqual([{ childId: "alpha", blockers: ["blocker:alpha"] }]);
	});

	it("rejects host-derived irrelevant microtasks, omitted blockers, and non-actionable evidence", async () => {
		const source = candidate("farmed");
		const host = hostEvidenceFor(source);
		const result = await run(input({ candidates: [source] }), {
			hostEvidence: [
				{
					...host,
					relevance: "irrelevant",
					workClass: "microtask",
					blockerAssessment: { complete: false, blockers: [] },
					actionable: false,
				},
			],
		});

		expect(result.status).toBe("denied");
		expect(result.deniedCandidates[0]?.reasons).toContain("irrelevant_microtask");

		const throughputSource = candidate("throughput-farmed");
		const throughputHost = hostEvidenceFor(throughputSource);
		const throughputResult = await run(input({ candidates: [throughputSource] }), {
			hostEvidence: [
				{
					...throughputHost,
					usefulVerifiedCompletionUnits: 1,
					estimates: { ...throughputHost.estimates, childWallMilliseconds: 900, queueWaitWallMilliseconds: 200 },
				},
			],
		});
		expect(throughputResult.deniedCandidates).toEqual([{ childId: "throughput-farmed", reasons: ["not_useful"] }]);
	});

	it("is deterministic under task reordering and rejects depth and nonpositive benefit", async () => {
		const first = await run(input());
		const reordered = input({ candidates: [...input().candidates].reverse() });
		const second = await run(reordered);
		expect(second.planDigest).toBe(first.planDigest);

		const depth = await run(input({ workerDepth: 2 }));
		expect(depth.denialReasons).toEqual(["depth_limit"]);

		const negativeCandidate = candidate("negative");
		const negativeEvidence = {
			...hostEvidenceFor(negativeCandidate),
			estimates: { ...negativeCandidate.estimates, estimatedCriticalPathSavedWallMilliseconds: 1 },
		};
		const negative = await run(input({ candidates: [negativeCandidate] }), { hostEvidence: [negativeEvidence] });
		expect(negative.deniedCandidates).toEqual([{ childId: "negative", reasons: ["nonpositive_benefit"] }]);

		const zeroCandidate = candidate("zero");
		const zeroEvidence = hostEvidenceFor(zeroCandidate);
		const zero = await run(input({ candidates: [zeroCandidate] }), {
			hostEvidence: [
				{
					...zeroEvidence,
					estimates: {
						...zeroEvidence.estimates,
						estimatedCriticalPathSavedWallMilliseconds: 52,
					},
				},
			],
		});
		expect(zero.deniedCandidates).toEqual([{ childId: "zero", reasons: ["nonpositive_benefit"] }]);
	});

	it("rejects duplicate host graph child, work, and scope identities", async () => {
		const duplicate = candidate("duplicate", {
			workKey: "work:alpha",
			scopeId: "scope:alpha",
		});
		await expect(run(input({ candidates: [candidate("alpha"), duplicate] }))).rejects.toThrow(/^CONTRACT_CHANGE:/u);
	});

	it("uses host evidence instead of caller-inflated resource and cost estimates", async () => {
		const hostCandidate = candidate("forged");
		const forgedCandidate = candidate("forged", {
			resourceReservation: resource({ cpuMilliCores: 12 }),
			estimates: {
				...candidate("tmp").estimates,
				computeCostMicrounits: 1,
				maxVerifiedComputeCostMicrounits: 1,
			},
		});
		const admitted = await run(input({ candidates: [forgedCandidate] }), {
			hostEvidence: [hostEvidenceFor(hostCandidate)],
		});
		expect(admitted.status).toBe("admitted");

		const host = hostEvidenceFor(hostCandidate);
		const rejected = await run(input({ candidates: [forgedCandidate] }), {
			hostEvidence: [
				{
					...host,
					estimates: {
						...host.estimates,
						computeCostMicrounits: 501,
						maxVerifiedComputeCostMicrounits: 500,
					},
				},
			],
		});
		expect(rejected.deniedCandidates).toEqual([{ childId: "forged", reasons: ["forged_estimate"] }]);
	});

	it("rejects symlink and canonical path write conflicts", async () => {
		const first = candidate("canonical-one", {
			ownership: "write_set",
			writeSet: ["src/one.ts"],
			pathProofs: [proof("src/one.ts", "/workspace/src/shared.ts")],
		});
		const second = candidate("canonical-two", {
			ownership: "write_set",
			writeSet: ["src/two.ts"],
			pathProofs: [proof("src/two.ts", "/workspace/src/shared.ts")],
		});
		const result = await run(input({ candidates: [first, second] }));

		expect(result.selectedChildren).toHaveLength(1);
		expect(result.deniedCandidates).toContainEqual({
			childId: "canonical-two",
			reasons: ["write_set_conflict"],
		});
	});

	it("validates nonnegative depth and host realpath workspace containment", async () => {
		const invalidDepth = await run(input({ workerDepth: -1 }));
		expect(invalidDepth.denialReasons).toEqual(["invalid_depth"]);

		const outside = candidate("outside", {
			readSet: ["src/outside.ts"],
			pathProofs: [proof("src/outside.ts", "/other-workspace/src/outside.ts")],
		});
		const outsideResult = await run(input({ candidates: [outside] }));
		expect(outsideResult.deniedCandidates).toEqual([
			{ childId: "outside", reasons: ["host_path_outside_workspace"] },
		]);
	});

	it("rejects report-only chains without an actionable child operation", async () => {
		const reportOnly = candidate("report-only", { actionable: false });
		const result = await run(input({ candidates: [reportOnly] }));

		expect(result.status).toBe("denied");
		expect(result.deniedCandidates[0]?.reasons).toEqual(["no_actionable_output"]);
	});

	it("keeps adaptive fanout disabled unless explicitly enabled", async () => {
		const result = await run(input({ adaptive: { enabled: false } }));

		expect(result.status).toBe("denied");
		expect(result.denialReasons).toEqual(["adaptive_option_disabled"]);
		expect(result.selectedChildren).toEqual([]);
	});

	it("uses host-owned ceilings, reserves one session slot per child, and binds a CAS intent", async () => {
		const callerInflated = await run(input(), { ceilings: { maxFanout: 1 } });
		expect(callerInflated.selectedChildren).toHaveLength(1);
		expect(callerInflated.reservationIntent?.expectedGraphRevision).toBe(4);
		const hostBudgetDenial = await run(input(), {
			budget: {
				capacity: resource({ childSessionSlots: 3 }),
				inUse: ZERO_RESOURCE,
				verifierReserve: resource({ childSessionSlots: 1 }),
				controlReserve: resource({ childSessionSlots: 1 }),
				urgentRecoveryReserve: resource({ childSessionSlots: 1 }),
			},
		});
		expect(hostBudgetDenial.status).toBe("denied");
		expect(hostBudgetDenial.denialReasons).toContain("resource_limit");

		const noSlotCandidate = candidate("no-slot");
		const noSlotEvidence = hostEvidenceFor(noSlotCandidate);
		const noSlot = await run(input({ candidates: [noSlotCandidate] }), {
			hostEvidence: [{ ...noSlotEvidence, resourceReservation: resource({ cpuMilliCores: 1 }) }],
		});
		expect(noSlot.deniedCandidates).toEqual([{ childId: "no-slot", reasons: ["session_slot_required"] }]);
	});

	it("rejects missing model capability and preserves explicit Q25 synthesis obligations", async () => {
		const lens = candidate("missing-model");
		const evidence = hostEvidenceFor(lens);
		const result = await run(input({ candidates: [lens] }), {
			hostEvidence: [{ ...evidence, modelBinding: { ...evidence.modelBinding, model: "", allowFallback: false } }],
		});
		expect(result.deniedCandidates).toEqual([{ childId: "missing-model", reasons: ["blocked_model_capability"] }]);

		const missingObligation = await run(input(), {
			synthesisObligation: {
				l1OwnerId: WORKER_ID,
				contradictionVerifierChildId: "not-in-graph",
				contradictionCheckRequired: true,
				acceptanceCriteria: "synthesize",
				evidenceRefs: [artifact("missing-obligation")],
				obligationDigest: digestObject({ invalid: true }),
			},
		});
		expect(missingObligation.denialReasons).toContain("synthesis_obligation_missing");

		const missingWorkerModel = await run(input(), { workerModelBinding: undefined });
		expect(missingWorkerModel.status).toBe("denied");
		expect(missingWorkerModel.denialReasons).toEqual(["blocked_model_capability"]);
	});

	it("rejects stale or dependency-blocked failures and keeps siblings running", async () => {
		const stale = await run(
			input({
				childOutcomes: [
					{
						childId: "not-selected",
						status: "failed",
						reason: "stale nested failure",
						outputDigest: digestObject({ output: "stale" }),
						evidenceRefs: [artifact("stale-failure")],
						ledgerDigest: LEDGER_DIGEST,
						boundedPacketRef: artifact("stale-failure-packet", 128),
					},
				],
			}),
		);
		expect(stale.escalationIntents).toEqual([]);
		expect(stale.denialReasons).toContain("stale_failure");

		const dependency = candidate("dependent", { dependencyTaskIds: ["task:missing"] });
		const dependencyResult = await run(
			input({
				candidates: [dependency],
				childOutcomes: [
					{
						childId: "dependent",
						status: "failed",
						reason: "dependency blocked",
						outputDigest: digestObject({ output: "blocked" }),
						evidenceRefs: [artifact("blocked-failure")],
						ledgerDigest: LEDGER_DIGEST,
						boundedPacketRef: artifact("blocked-failure-packet", 128),
					},
				],
			}),
			{
				currentState: {
					selectedChildIds: [dependency.childId],
					currentChildIds: [dependency.childId],
				},
			},
		);
		expect(dependencyResult.escalationIntents).toEqual([]);
		expect(dependencyResult.denialReasons).toContain("failure_dependency_unmet");

		const unresolved = await run(
			input({ candidates: [candidate("unresolved", { dependencyTaskIds: ["task:missing"] })] }),
		);
		expect(unresolved.status).toBe("denied");
		expect(unresolved.deniedCandidates).toEqual([{ childId: "unresolved", reasons: ["dependency_mismatch"] }]);
	});

	it("requires the host adapter, opaque authorization token, and runtime persistence seam", async () => {
		await expect(planAdaptiveRecursiveDelegation(input())).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		await expect(planAdaptiveRecursiveDelegationFromHost(input(), {} as never)).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		const boundHost = composition(input());
		const forgedTokenHost = {
			...boundHost,
			authorizationToken: {
				...(boundHost.authorizationToken as { receipt: unknown; bindingDigest: string; operationDigest: string }),
				bindingDigest: digestObject({ forged: true }),
			},
		};
		await expect(planAdaptiveRecursiveDelegationFromHost(input(), forgedTokenHost)).rejects.toThrow();
		await expect(
			planAdaptiveRecursiveDelegationFromHost(input(), {
				...composition(input()),
				persistIntentBatch: undefined,
			}),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
	});

	it("consumes a one-use authorization receipt atomically and rejects replay", async () => {
		const request = input({ candidates: [candidate("one-use")] });
		const host = composition(request, { oneUse: true });

		const first = await planAdaptiveRecursiveDelegationFromHost(request, host);
		expect(first.authorization?.oneUse).toBe(true);
		expect(first.authorization?.consumptionWitness).toMatchObject({
			receiptId: expect.stringContaining("recursive-plan:"),
			workflowId: WORKFLOW_ID,
			bindingDigest: BINDING_DIGEST,
			consumptionSequence: expect.any(Number),
		});
		await expect(planAdaptiveRecursiveDelegationFromHost(request, host)).rejects.toThrow(/^CONTRACT_CHANGE:/u);
	});

	it("persists reservation, escalation, and release as one durable transactional intent batch", async () => {
		let batchCalls = 0;
		const request = input({
			candidates: [candidate("batch-alpha")],
			childOutcomes: [
				{
					childId: "batch-alpha",
					status: "failed",
					reason: "batch failure",
					outputDigest: digestObject({ output: "batch-alpha" }),
					evidenceRefs: [artifact("batch-alpha-failure")],
					ledgerDigest: LEDGER_DIGEST,
					boundedPacketRef: artifact("batch-alpha-failure-packet", 128),
				},
			],
		});
		const host = {
			...composition(request, {
				persistIntentBatch: async () => {
					batchCalls += 1;
				},
			}),
		} as unknown as RecursiveDelegationHostComposition;

		const result = await planAdaptiveRecursiveDelegationFromHost(request, host);
		expect(batchCalls).toBe(1);
		expect(result.durableIntentBatch).toMatchObject({
			kind: "recursive_delegation_intent_batch",
			reservationIntent: result.reservationIntent,
			escalationIntents: result.escalationIntents,
			expectedStateDigest: STATE_DIGEST,
			expectedRevision: REVISION,
			expectedEpochRef: EPOCH_REF,
		});
	});

	it("persists one CAS-bound intent batch and reopens it from durable storage", async () => {
		const directory = await mkdtemp(join(tmpdir(), "recursive-delegation-"));
		const filePath = join(directory, "intent-batch.json");
		try {
			const persistIntentBatch = async (batch: RecursiveDelegationDurableIntentBatch): Promise<void> => {
				if (batch.expectedStateDigest !== STATE_DIGEST || batch.expectedRevision !== REVISION)
					throw new Error("fixture CAS state fence mismatch");
				await writeFile(filePath, JSON.stringify(batch), { encoding: "utf8", flag: "wx" });
			};
			const request = input({ candidates: [candidate("reopen")] });
			const result = await planAdaptiveRecursiveDelegationFromHost(
				request,
				composition(request, { persistIntentBatch }),
			);
			const reopened = JSON.parse(await readFile(filePath, "utf8")) as RecursiveDelegationDurableIntentBatch;

			expect(result.durableIntentBatch).not.toBeNull();
			expect(reopened.batchDigest).toBe(result.durableIntentBatch?.batchDigest);
			expect(reopened.reservationIntent?.expectedEpochRef).toEqual(EPOCH_REF);
			await expect(persistIntentBatch(result.durableIntentBatch!)).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects nonpositive host revisions, epochs, and closed artifact/resource schemas", async () => {
		const request = input({ candidates: [candidate("schema")] });
		const base = composition(request);
		await expect(
			planAdaptiveRecursiveDelegationFromHost(request, {
				...base,
				currentRevision: 0,
			} as unknown as RecursiveDelegationHostComposition),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		await expect(
			planAdaptiveRecursiveDelegationFromHost(request, {
				...base,
				currentState: { ...base.currentState, revision: 0 },
			} as unknown as RecursiveDelegationHostComposition),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		await expect(
			planAdaptiveRecursiveDelegationFromHost(request, {
				...base,
				epochRef: { storeEpoch: 0, coordinatorEpoch: 1 },
			} as unknown as RecursiveDelegationHostComposition),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		await expect(
			planAdaptiveRecursiveDelegationFromHost(request, {
				...base,
				budget: {
					...base.budget,
					capacity: { ...base.budget.capacity, forgedDimension: 1 } as never,
				},
			} as unknown as RecursiveDelegationHostComposition),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
		const forgedPacketInput = {
			...request,
			coordinatorPacketRef: { ...request.coordinatorPacketRef, forgedDimension: 1 },
		} as unknown as RecursiveDelegationPolicyInput;
		await expect(
			planAdaptiveRecursiveDelegationFromHost(forgedPacketInput, composition(forgedPacketInput)),
		).rejects.toThrow(/^CONTRACT_CHANGE:/u);
	});

	it("snapshots policy evidence before asynchronous host verification", async () => {
		const mutableCandidate = candidate("snapshot-alpha");
		const request = input({ candidates: [mutableCandidate, candidate("snapshot-beta")] });
		let releaseVerification!: () => void;
		const verificationGate = new Promise<void>((resolve) => {
			releaseVerification = resolve;
		});
		const delayedReceiptResolver = {
			...RECEIPT_CONTEXT.receiptResolver,
			resolve: async (resolveInput: Parameters<typeof RECEIPT_CONTEXT.receiptResolver.resolve>[0]) => {
				await verificationGate;
				return RECEIPT_CONTEXT.receiptResolver.resolve(resolveInput);
			},
		};
		const host = composition(request, {
			receiptContext: { ...RECEIPT_CONTEXT, receiptResolver: delayedReceiptResolver },
		});
		const pending = planAdaptiveRecursiveDelegationFromHost(request, host);
		await new Promise((resolve) => setTimeout(resolve, 0));
		(mutableCandidate as { childId: string }).childId = "forged-after-snapshot";
		(host.ceilings as { maxFanout: number }).maxFanout = 0;
		releaseVerification();
		const result = await pending;
		expect(result.selectedChildren.map(({ childId }) => childId)).toEqual(["snapshot-alpha", "snapshot-beta"]);
	});
});
