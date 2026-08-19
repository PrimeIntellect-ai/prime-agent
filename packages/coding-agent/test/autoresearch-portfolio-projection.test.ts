import { describe, expect, it } from "vitest";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioImpactClosure,
	type AutoResearchPortfolioMeasurement,
	autoResearchPortfolioCandidateDigest,
	parseAutoResearchPortfolioContract,
} from "../src/core/autoresearch/portfolio-contracts.js";
import { deriveAutoResearchPortfolioImpactClosure } from "../src/core/autoresearch/portfolio-frontier.js";
import {
	AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION,
	type AutoResearchPortfolioProjectionEvent,
	type AutoResearchPortfolioProjectionEventInput,
	type AutoResearchPortfolioProjectionInput,
	autoResearchPortfolioProjectionDigest,
	autoResearchPortfolioProjectionEventBindingDigest,
	createAutoResearchPortfolioProjection,
	createAutoResearchPortfolioProjectionEvent,
	reduceAutoResearchPortfolioProjection,
	replayAutoResearchPortfolioProjection,
} from "../src/core/autoresearch/portfolio-projection.js";
import {
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	type WorkflowEpochRef,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";

const DIGEST = "a".repeat(64);
const SECOND_DIGEST = "b".repeat(64);
const THIRD_DIGEST = "c".repeat(64);
const FOURTH_DIGEST = "d".repeat(64);
const FIFTH_DIGEST = "e".repeat(64);
const TIMESTAMP = "2026-08-17T00:00:00.000Z";
const WORKFLOW_ID = "workflow-portfolio-projection-test";
const PROJECTION_ID = "portfolio-projection-1";
const EPOCH_REF: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

function digestWithoutField(value: Record<string, unknown>, field: string): string {
	const body = { ...value };
	delete body[field];
	return digestObject(body);
}

function splitRoots(): Record<string, string> {
	return { training: SECOND_DIGEST, validation: THIRD_DIGEST, holdout: FOURTH_DIGEST };
}

function artifact(
	split: "training" | "validation" | "holdout",
	closureRootDigest: string,
	accessAuthority: "training_workers_training_only" | "validation_evaluator_host_only" | "holdout_host_aggregate_only",
): Record<string, unknown> {
	const timeRange =
		split === "training"
			? { sourceTimeStart: "2024-01-01T00:00:00.000Z", sourceTimeEnd: "2025-01-01T00:00:00.000Z" }
			: split === "validation"
				? { sourceTimeStart: "2025-01-01T00:00:00.000Z", sourceTimeEnd: "2026-01-01T00:00:00.000Z" }
				: { sourceTimeStart: "2026-01-01T00:00:00.000Z", sourceTimeEnd: "2027-01-01T00:00:00.000Z" };
	return {
		split,
		objectUri: `gs://projection-${split}/manifest.json`,
		generation: 1,
		sha256: DIGEST,
		bytes: 64,
		schemaVersion: "observations-v1",
		modality: "tabular",
		instrumentSet: ["EUR_USD"],
		...timeRange,
		validationResult: "passed",
		coverage: "complete",
		gapClassification: "none",
		lifecycle: "sealed",
		restoreVerification: {
			locked: true,
			independentlyRestored: true,
			independentlyRehashed: true,
			verificationEvidenceDigest: FIFTH_DIGEST,
		},
		provenance: {
			sourceSystem: "projection-fixture",
			sourceDataset: `projection-${split}`,
			ingestDigest: DIGEST,
			lineageDigest: DIGEST,
			provenanceReceiptDigest: DIGEST,
		},
		closureRootDigest,
		accessAuthority,
	};
}

function contract(): AutoResearchPortfolioContract {
	const roots = splitRoots();
	const splitBoundaryPolicy = {
		locked: true as const,
		trainingEndExclusive: "2025-01-01T00:00:00.000Z",
		validationStartInclusive: "2025-01-01T00:00:00.000Z",
		validationEndExclusive: "2026-01-01T00:00:00.000Z",
		holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
		holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
		policyDigest: "",
	};
	splitBoundaryPolicy.policyDigest = digestWithoutField(splitBoundaryPolicy, "policyDigest");
	const inputManifest: Record<string, unknown> = {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: DIGEST,
		manifestDigest: "",
		splitClosureRoots: roots,
		splitBoundaryPolicy,
		training: {
			locked: true,
			split: "training",
			closureRootDigest: roots.training,
			artifacts: [artifact("training", roots.training, "training_workers_training_only")],
		},
		validation: {
			locked: true,
			split: "validation",
			closureRootDigest: roots.validation,
			artifacts: [artifact("validation", roots.validation, "validation_evaluator_host_only")],
		},
		holdout: {
			locked: true,
			split: "holdout",
			closureRootDigest: roots.holdout,
			artifacts: [artifact("holdout", roots.holdout, "holdout_host_aggregate_only")],
		},
		modelAccess: {
			training: "training_workers_training_only",
			validation: "validation_evaluator_host_only",
			holdout: "holdout_host_aggregate_only",
			holdoutRowsVisible: false,
			holdoutPerCaseFeedback: false,
			holdoutReturns: "aggregate_signed_evidence_only",
			signedAggregateEvidence: true,
		},
	};
	inputManifest.manifestDigest = digestWithoutField(inputManifest, "manifestDigest");
	const metricBody = {
		metricId: "quality",
		name: "quality",
		requirementId: "requirement-quality",
		direction: "higher" as const,
		target: 0.8,
		unit: "ratio",
		locked: true as const,
		evaluationEpoch: 1,
		metricRevision: 1,
		closureRootDigest: DIGEST,
		inputManifestDigest: inputManifest.manifestDigest,
		splitClosureRoots: roots,
	};
	const evaluatorBody = {
		locked: true as const,
		evaluatorId: "evaluator-quality",
		sourceDigest: DIGEST,
		inputDigest: DIGEST,
		environmentDigest: DIGEST,
		evaluationEpoch: 1,
		evaluatorRevision: 1,
		closureRootDigest: DIGEST,
		inputManifestDigest: inputManifest.manifestDigest,
		splitClosureRoots: roots,
	};
	const parserBody = {
		locked: true as const,
		parserId: "parser-quality",
		kind: "scalar_number" as const,
		metricKeys: ["quality"],
		evaluationEpoch: 1,
		inputManifestRevision: 1,
		closureRootDigest: DIGEST,
		inputManifestDigest: inputManifest.manifestDigest,
		splitClosureRoots: roots,
	};
	const commandBody = {
		locked: true as const,
		argv: ["node", "evaluate.mjs"],
		shell: false as const,
		cwd: "candidate",
	};
	const goal = {
		goalId: "goal-quality",
		domainId: "domain-quality",
		title: "Quality",
		description: "Improve quality.",
		scope: "terminal" as const,
		metrics: [metricBody],
		baseline: {
			locked: true as const,
			measurementId: "measurement-baseline",
			metricValues: [{ metricId: "quality", value: 0.5 }],
			evidenceDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: DIGEST,
			inputManifestDigest: inputManifest.manifestDigest,
			splitClosureRoots: roots,
		},
		evaluator: { ...evaluatorBody, evaluatorDigest: digestObject(evaluatorBody) },
		parser: { ...parserBody, parserDigest: digestObject(parserBody) },
		command: { ...commandBody, commandDigest: digestObject(commandBody) },
		repeatability: { locked: true as const, runs: 1, aggregation: "exact" as const, seed: "seed", maxVariance: 0.1 },
		uncertainty: {
			locked: true as const,
			method: "deterministic" as const,
			confidence: 0.95,
			maxWidth: 0.2,
			maxVariance: 0.1,
		},
		opaqueHoldout: {
			locked: true as const,
			policy: "host_only" as const,
			candidateVisible: false as const,
			handleDigest: DIGEST,
			inputDigest: DIGEST,
			resolverDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: DIGEST,
			splitClosureRoots: roots,
		},
		falsification: {
			locked: true as const,
			criteria: ["quality fails"],
			manifestDigest: digestObject({ locked: true, criteria: ["quality fails"] }),
		},
		adversarial: {
			locked: true as const,
			checks: ["metric omission"],
			manifestDigest: digestObject({ locked: true, checks: ["metric omission"] }),
		},
	};
	return parseAutoResearchPortfolioContract({
		schemaVersion: 3,
		contractId: "portfolio-projection-contract",
		objective: "Improve quality under locked host evidence.",
		acceptanceRequirements: [
			{
				requirementId: "requirement-quality",
				statement: "Quality meets the locked target.",
				locked: true,
				requirementDigest: digestObject({
					requirementId: "requirement-quality",
					statement: "Quality meets the locked target.",
					locked: true,
				}),
			},
		],
		goals: [goal],
		goalRelations: [],
		lexicographicTiers: [{ tier: 1, goalIds: ["goal-quality"] }],
		hardBoundaries: [
			{ boundaryId: "boundary-safety", statement: "No unsafe effects.", scope: "terminal", locked: true },
		],
		invariants: [
			{
				invariantId: "invariant-safety",
				statement: "The evaluator is unchanged.",
				scope: "terminal",
				locked: true,
				checkDigest: DIGEST,
			},
		],
		nonGoals: [],
		budgets: {
			maxCandidates: 8,
			maxMeasurements: 24,
			maxWallSeconds: 60,
			maxCostMicrounits: 1000,
			maxParallelCandidates: 2,
			maxTokens: 10000,
		},
		safety: {
			locked: true,
			network: "disabled",
			externalEffects: "none",
			requireOpaqueHoldout: true,
			requireAdversarialReview: true,
			maxUncertainty: 0.2,
		},
		inputManifest,
		scopePartitions: [
			{
				partitionId: "terminal-code",
				scope: "terminal",
				paths: ["src/"],
				dataDigests: [DIGEST],
				mutableBy: "candidate",
			},
		],
		terminalScope: "terminal",
		learningScope: "learning",
	});
}

const CONTRACT = contract();
const CONTRACT_DIGEST = digestObject(CONTRACT);
const PROVENANCE = {
	kind: "read_only_provenance" as const,
	source: "host",
	sourceDigest: DIGEST,
	recordedAt: TIMESTAMP,
};

function projectionInput(
	overrides: Partial<AutoResearchPortfolioProjectionInput> = {},
): AutoResearchPortfolioProjectionInput {
	return {
		projectionId: PROJECTION_ID,
		workflowId: WORKFLOW_ID,
		epochRef: EPOCH_REF,
		contract: CONTRACT,
		provenance: PROVENANCE,
		receiptContext: createFixtureHostReceiptConsumerContext(),
		budget: {
			maxCandidates: 8,
			maxMeasurements: 24,
			maxWallMilliseconds: 60_000,
			maxCostMicrounits: 10_000,
			maxTokens: 100_000,
		},
		...overrides,
	};
}

function canonicalCandidate(candidateId = "candidate-1"): AutoResearchPortfolioCandidate {
	return {
		candidateId,
		goalIds: ["goal-quality"],
		solutionFamily: {
			familyId: `family-${candidateId}`,
			name: `representation ${candidateId}`,
			mechanismClass: "representation",
		},
		ancestry: { parentCandidateIds: [], baseDigest: DIGEST, lineageDigest: DIGEST },
		causalMechanism: {
			hypothesis: "A representation separates regimes.",
			intervention: "Replace the shared representation.",
			expectedObservation: "The quality vector improves.",
			falsificationCondition: "The improvement disappears on the sealed sample.",
			mechanismDigest: DIGEST,
		},
		change: {
			kind: "mechanism",
			changedPaths: ["src/representation.ts", "src/adapter.ts"],
			parameterChanges: [],
			changeDigest: DIGEST,
		},
		scope: "terminal",
	};
}

function measurement(candidateId = "candidate-1", measurementId = "measurement-1"): AutoResearchPortfolioMeasurement {
	const withoutDigest = {
		measurementId,
		goalId: "goal-quality",
		candidateId,
		scope: "terminal" as const,
		kind: "candidate" as const,
		vector: [{ metricId: "quality", value: 0.91 }],
		repeatIndex: 1,
		sampleCount: 1,
		evaluationEpoch: 1,
		inputManifestDigest: CONTRACT.inputManifest.manifestDigest,
		splitClosureRoots: CONTRACT.inputManifest.splitClosureRoots,
		confidenceInterval: { lower: 0.9, upper: 0.92, level: 0.95 },
		variance: 0,
		runCount: 1,
		aggregation: "exact" as const,
		inputDigest: CONTRACT.inputManifest.manifestDigest,
		evaluatorDigest: CONTRACT.goals[0]!.evaluator.evaluatorDigest,
		parserDigest: CONTRACT.goals[0]!.parser.parserDigest,
		commandDigest: CONTRACT.goals[0]!.command.commandDigest,
		workspaceDigest: DIGEST,
		evidenceDigests: [SECOND_DIGEST, THIRD_DIGEST],
		measuredAt: TIMESTAMP,
	};
	return { ...withoutDigest, measurementDigest: digestObject(withoutDigest) };
}

function impactClosure(): AutoResearchPortfolioImpactClosure {
	return deriveAutoResearchPortfolioImpactClosure(CONTRACT, canonicalCandidate());
}

function eventResourceDigest(): string {
	return digestObject({
		kind: "portfolio_projection.resource.v1",
		projectionId: PROJECTION_ID,
		contractDigest: CONTRACT_DIGEST,
	});
}

function eventOperationDigest(eventId: string, kind: string): string {
	return digestObject({
		kind: "portfolio_projection.operation.v1",
		eventId,
		eventKind: kind,
		contractDigest: CONTRACT_DIGEST,
	});
}

function receiptFor(
	state: ReturnType<typeof createAutoResearchPortfolioProjection>,
	eventId: string,
	bindingDigest: string,
	resourceDigest: string,
	operationDigest: string,
	issuerId = "fixture-host",
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: `receipt-${eventId}`,
		issuerId,
		workflowId: WORKFLOW_ID,
		bindingDigest,
		payloadDigest: digestObject({ eventId, bindingDigest }),
		artifactRef: {
			artifactId: `artifact-${eventId}`,
			relativePath: `evidence/${eventId}.json`,
			digest: DIGEST,
			sizeBytes: 0,
			sourceEventSequence: 1,
		},
		issuedAt: TIMESTAMP,
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: "fixture-key",
		stateDigest: state.projectionDigest,
		revision: Math.max(1, state.revision),
		capabilityBinding: {
			capability: "autoresearch_portfolio_projection_commit",
			resourceDigest,
			operationDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
}

function event(
	state: ReturnType<typeof createAutoResearchPortfolioProjection>,
	data: Record<string, unknown>,
	issuerId = "fixture-host",
): AutoResearchPortfolioProjectionEvent {
	const resourceDigest = eventResourceDigest();
	const operationDigest = eventOperationDigest(String(data.eventId), String(data.kind));
	const body: Record<string, unknown> = {
		schemaVersion: AUTO_RESEARCH_PORTFOLIO_PROJECTION_SCHEMA_VERSION,
		eventId: data.eventId,
		projectionId: PROJECTION_ID,
		revision: state.revision + 1,
		epoch: state.epoch,
		occurredAt: TIMESTAMP,
		contractDigest: CONTRACT_DIGEST,
		provenance: PROVENANCE,
		priorHead: state.head,
		resourceDigest,
		operationDigest,
		...data,
	};
	body.hostReceipt = receiptFor(
		state,
		String(data.eventId),
		autoResearchPortfolioProjectionEventBindingDigest(body, WORKFLOW_ID),
		resourceDigest,
		operationDigest,
		issuerId,
	);
	return createAutoResearchPortfolioProjectionEvent(body as unknown as AutoResearchPortfolioProjectionEventInput);
}

function registration(
	state: ReturnType<typeof createAutoResearchPortfolioProjection>,
	candidate = canonicalCandidate(),
	eventId = "event-registration",
) {
	return event(state, {
		eventId,
		kind: "candidate_registered",
		candidate,
		candidateDigest: autoResearchPortfolioCandidateDigest(candidate),
	});
}

function terminalEvaluation(): Record<string, unknown> {
	const body = {
		accepted: true,
		outcome: "complete" as const,
		goalDispositions: [{ goalId: "goal-quality", disposition: "achieved" as const }],
		requiredGoalIds: ["goal-quality"],
		unresolvedGoalIds: [],
		selectedFrontierEntryIds: [],
		reasons: [],
		authority: "host" as const,
		workerCanAuthorize: false as const,
		candidateCanAuthorize: false as const,
		mutated: false as const,
	};
	return {
		...body,
		evaluationDigest: digestObject({
			contractDigest: CONTRACT_DIGEST,
			outcome: body.outcome,
			goalDispositions: body.goalDispositions,
			selectedFrontierEntryIds: body.selectedFrontierEntryIds,
			reasons: body.reasons,
		}),
	};
}

function terminalEvidence(): Record<string, unknown> {
	return {
		measurements: [],
		frontier: { entries: [], selectedEntryIds: [], receipt: {} },
		boundaries: [],
		acquisition: { splits: [] },
		completion: { artifacts: [] },
		tradeoff: null,
		infeasibility: [],
		goalDecisions: [],
		stop: null,
	};
}

describe("AutoResearch portfolio durable projection", () => {
	it("requires the generic host principal capability authorizer instead of self-provisioned PEM authority", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const forgedWorker = event(
			initial,
			{
				eventId: "event-worker-signed",
				kind: "candidate_registered",
				candidate: canonicalCandidate(),
				candidateDigest: autoResearchPortfolioCandidateDigest(canonicalCandidate()),
			},
			"worker",
		);
		await expect(reduceAutoResearchPortfolioProjection(initial, forgedWorker, input.receiptContext)).rejects.toThrow(
			/principal|receipt|signature|authority|canonical/i,
		);
	});

	it("stores parsed candidates and measurements and converges canonical-equivalent input digests", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const candidate = canonicalCandidate();
		const equivalentCandidate: AutoResearchPortfolioCandidate = {
			...structuredClone(candidate),
			goalIds: ["goal-quality"],
			change: {
				...structuredClone(candidate.change),
				changedPaths: [...candidate.change.changedPaths].reverse(),
			},
		};
		const first = registration(initial, candidate, "event-registration");
		const equivalent = registration(initial, equivalentCandidate, "event-registration");
		expect(equivalent.eventDigest).toBe(first.eventDigest);
		const registered = await reduceAutoResearchPortfolioProjection(initial, first, input.receiptContext);
		const equivalentRegistered = await reduceAutoResearchPortfolioProjection(
			initial,
			equivalent,
			input.receiptContext,
		);
		expect(equivalentRegistered.projectionDigest).toBe(registered.projectionDigest);
		const closed = await reduceAutoResearchPortfolioProjection(
			registered,
			event(registered, {
				eventId: "event-closure",
				kind: "impact_closure_recorded",
				candidateId: "candidate-1",
				candidateDigest: registered.candidates[0]!.candidateDigest,
				impactClosure: impactClosure(),
			}),
			input.receiptContext,
		);
		const measurementEventData = {
			eventId: "event-measurement",
			kind: "host_vector_measured",
			candidateId: "candidate-1",
			candidateDigest: closed.candidates[0]!.candidateDigest,
			measurement: measurement(),
		};
		const canonicalMeasurement = measurement();
		const equivalentMeasurement: AutoResearchPortfolioMeasurement = {
			...canonicalMeasurement,
			evidenceDigests: [...canonicalMeasurement.evidenceDigests].reverse(),
		};
		const measured = event(closed, measurementEventData);
		const equivalentMeasured = event(closed, { ...measurementEventData, measurement: equivalentMeasurement });
		expect(equivalentMeasured.eventDigest).toBe(measured.eventDigest);
		const projected = await reduceAutoResearchPortfolioProjection(closed, measured, input.receiptContext);
		const projectedEquivalent = await reduceAutoResearchPortfolioProjection(
			closed,
			equivalentMeasured,
			input.receiptContext,
		);
		expect(projectedEquivalent.projectionDigest).toBe(projected.projectionDigest);
		expect(projected.candidates[0]).toMatchObject({ candidateId: "candidate-1", lifecycle: "measured" });
		expect(projected.measurements[0]).toMatchObject({
			measurementId: "measurement-1",
			evaluatorDigest: CONTRACT.goals[0]!.evaluator.evaluatorDigest,
		});
		expect(projected.projectionDigest).toBe(autoResearchPortfolioProjectionDigest(projected));
	});

	it("requires prior-head binding and rejects signed branch replay", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const first = registration(initial);
		const branch = registration(initial, canonicalCandidate("candidate-2"), "event-branch");
		await expect(replayAutoResearchPortfolioProjection(input, [first, branch])).rejects.toThrow(
			/prior|causal|head|sequence/i,
		);
	});

	it("rejects mutable or tampered input state before applying a signed event", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const eventValue = registration(initial);
		const mutable = structuredClone(initial) as unknown as Record<string, unknown>;
		mutable.status = "complete";
		await expect(
			reduceAutoResearchPortfolioProjection(mutable as unknown as typeof initial, eventValue, input.receiptContext),
		).rejects.toThrow(/frozen|projectionDigest|state/i);
	});

	it("requires actual authenticated usage to reach a configured budget before budget_limited", async () => {
		const input = projectionInput({ budget: undefined });
		const initial = createAutoResearchPortfolioProjection(input);
		const zeroUsage = event(initial, {
			eventId: "event-zero-usage",
			kind: "budget_usage_recorded",
			usage: { wallMilliseconds: 0 },
		});
		const used = await reduceAutoResearchPortfolioProjection(initial, zeroUsage, input.receiptContext);
		const limited = event(used, {
			eventId: "event-budget-limited",
			kind: "status_changed",
			status: "budget_limited",
			reason: "zero usage",
		});
		await expect(reduceAutoResearchPortfolioProjection(used, limited, input.receiptContext)).rejects.toThrow(
			/budget|usage|limit/i,
		);
		const reached = await reduceAutoResearchPortfolioProjection(
			initial,
			event(initial, {
				eventId: "event-real-usage",
				kind: "budget_usage_recorded",
				usage: { wallMilliseconds: 60_000 },
			}),
			input.receiptContext,
		);
		const reachedLimited = await reduceAutoResearchPortfolioProjection(
			reached,
			event(reached, {
				eventId: "event-real-budget-limited",
				kind: "status_changed",
				status: "budget_limited",
				reason: "configured wall budget reached",
			}),
			input.receiptContext,
		);
		expect(reachedLimited.status).toBe("budget_limited");
		const mutableTerminal = structuredClone(reachedLimited) as unknown as Record<string, unknown>;
		mutableTerminal.status = "active";
		await expect(
			reduceAutoResearchPortfolioProjection(
				mutableTerminal as unknown as typeof reachedLimited,
				limited,
				input.receiptContext,
			),
		).rejects.toThrow(/frozen|projectionDigest|state/i);
	});

	it("cross-checks terminal output against the parsed contract and evaluator", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const registered = await reduceAutoResearchPortfolioProjection(
			initial,
			registration(initial),
			input.receiptContext,
		);
		const forgedTerminal = event(registered, {
			eventId: "event-terminal",
			kind: "terminal_decision_recorded",
			decisionId: "terminal-1",
			candidateId: "candidate-1",
			candidateDigest: registered.candidates[0]!.candidateDigest,
			terminalEvaluation: terminalEvaluation(),
			terminalEvidence: terminalEvidence(),
			evidenceDigest: digestObject(terminalEvidence()),
		});
		await expect(
			reduceAutoResearchPortfolioProjection(registered, forgedTerminal, input.receiptContext),
		).rejects.toThrow(/contract|terminal|evaluation|evidence/i);
	});

	it("accepts only exact frontier dispositions, never empty or substring values", () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		for (const disposition of ["", "admittedly"]) {
			expect(() =>
				event(initial, {
					eventId: `event-frontier-${disposition || "empty"}`,
					kind: "frontier_disposition_recorded",
					candidateId: "candidate-1",
					disposition,
					candidateDigest: autoResearchPortfolioCandidateDigest(canonicalCandidate()),
					frontierDigest: DIGEST,
				} as unknown as Record<string, unknown>),
			).toThrow(/frontier|disposition|invalid/i);
		}
	});

	it("rejects custom prototypes, accessors, and attacker-controlled array methods before traversal", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const candidate = canonicalCandidate();
		Object.setPrototypeOf(candidate.goalIds, {
			map: () => {
				throw new Error("attacker map called");
			},
		});
		expect(() => registration(initial, candidate)).toThrow(/prototype|array|field|candidate/i);

		const accessorCandidate = canonicalCandidate();
		Object.defineProperty(accessorCandidate.goalIds, "0", {
			enumerable: true,
			get: () => {
				throw new Error("accessor called");
			},
		});
		expect(() => registration(initial, accessorCandidate)).toThrow(/accessor|array|field|candidate/i);

		const events = [registration(initial)];
		Object.setPrototypeOf(events, {
			map: () => {
				throw new Error("attacker map called");
			},
		});
		await expect(replayAutoResearchPortfolioProjection(input, events)).rejects.toThrow(/prototype|array|events/i);
	});

	it("rejects hidden authority fields and freezes terminal state", async () => {
		const input = projectionInput();
		const initial = createAutoResearchPortfolioProjection(input);
		const hidden = structuredClone(registration(initial)) as unknown as Record<string, unknown>;
		Object.defineProperty(hidden, "workerAuthority", { value: "worker", enumerable: false });
		expect(() =>
			createAutoResearchPortfolioProjectionEvent(hidden as unknown as AutoResearchPortfolioProjectionEventInput),
		).toThrow(/field|authority|enumerable/i);
		const terminal = await reduceAutoResearchPortfolioProjection(
			initial,
			event(initial, {
				eventId: "event-terminal-failed",
				kind: "terminal_decision_recorded",
				decisionId: "terminal-failed",
				candidateId: null,
				candidateDigest: null,
				terminalEvaluation: terminalEvaluation(),
				terminalEvidence: terminalEvidence(),
				evidenceDigest: digestObject(terminalEvidence()),
			}),
			input.receiptContext,
		).catch(() => null);
		expect(terminal).toBeNull();
	});
});
