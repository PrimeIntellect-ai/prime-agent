import { createHash } from "node:crypto";
import type {
	AvoCommittedSolution,
	AvoKnowledgeEntry,
	AvoLineage,
	AvoScoreDimension,
	AvoScoringReceipt,
	AvoStagnationPattern,
	AvoSupervisorSteering,
	AvoVariationActionType,
	AvoVariationContract,
	AvoVariationResult,
	AvoWorkingAttempt,
} from "./types.js";
import { AVO_PAPER_CORE_VERSION } from "./types.js";

/**
 * Calculates SHA-256 digest of arbitrary text content.
 */
export function digestContent(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Creates an initial AvoLineage with a seed solution.
 */
export function createAvoLineage<T = unknown>(lineageId: string, seedSolution: AvoCommittedSolution<T>): AvoLineage<T> {
	return {
		lineageId,
		entries: [seedSolution],
		bestSolutionId: seedSolution.solutionId,
		baselineScore: { ...seedSolution.scores },
	};
}

/**
 * Determines whether a candidate score vector matches or improves upon baseline scores.
 */
export function isScoreImproving(
	candidateScores: Record<string, number>,
	baselineScores: Record<string, number>,
	dimensions: AvoScoreDimension[],
): boolean {
	if (dimensions.length === 0) {
		return true;
	}

	let hasImprovement = false;

	for (const dim of dimensions) {
		const candVal = candidateScores[dim.name];
		const baseVal = baselineScores[dim.name];

		if (candVal === undefined || baseVal === undefined) {
			continue;
		}

		if (dim.direction === "maximize") {
			if (candVal < baseVal) {
				return false; // Regressed along a dimension
			}
			if (candVal > baseVal) {
				hasImprovement = true;
			}
		} else {
			if (candVal > baseVal) {
				return false; // Regressed along a dimension
			}
			if (candVal < baseVal) {
				hasImprovement = true;
			}
		}
	}

	return hasImprovement;
}

/**
 * Commits an evaluated solution into the evolutionary lineage if it passes correctness
 * and matches or improves upon the baseline score (Update(P_t, (x_{t+1}, f(x_{t+1})))).
 *
 * Failed or regressing attempts are rejected from P_t to preserve evolutionary lineage hygiene.
 */
export function updateAvoLineage<T = unknown>(
	lineage: AvoLineage<T>,
	candidate: AvoCommittedSolution<T>,
	dimensions: AvoScoreDimension[],
): {
	updated: boolean;
	lineage: AvoLineage<T>;
	reason?: string;
} {
	if (!candidate.passedCorrectness) {
		return {
			updated: false,
			lineage,
			reason: "Candidate failed numerical/specification correctness gate",
		};
	}

	const baseline = lineage.baselineScore ?? {};
	const improves = isScoreImproving(candidate.scores, baseline, dimensions);

	// Also check if candidate matches baseline (tie)
	const matches = Object.entries(baseline).every(([key, val]) => candidate.scores[key] === val);

	if (!improves && !matches) {
		return {
			updated: false,
			lineage,
			reason: "Candidate does not match or improve upon baseline score",
		};
	}

	const updatedEntries = [...lineage.entries, candidate];
	return {
		updated: true,
		lineage: {
			...lineage,
			entries: updatedEntries,
			bestSolutionId: improves ? candidate.solutionId : lineage.bestSolutionId,
			baselineScore: improves ? { ...candidate.scores } : lineage.baselineScore,
		},
	};
}

/**
 * Detects stagnation patterns within the agent's recent working trajectory.
 */
export function detectAvoStagnation(
	trajectory: AvoWorkingAttempt[],
	threshold = 3,
	baselineScore?: Record<string, number>,
	scoreDimensions?: AvoScoreDimension[],
): AvoStagnationPattern {
	const evalAttempts = trajectory.filter((a) => a.actionType === "evaluate" && a.receipt);

	let consecutiveFailures = 0;
	let consecutiveRegressions = 0;
	const repeatedErrors: string[] = [];

	for (let i = evalAttempts.length - 1; i >= 0; i--) {
		const receipt = evalAttempts[i].receipt;
		if (!receipt) continue;

		if (!receipt.passedCorrectness || receipt.executionStatus !== "pass") {
			consecutiveFailures++;
			if (receipt.logs) {
				repeatedErrors.push(receipt.logs.slice(0, 100));
			}
		} else {
			if (baselineScore && scoreDimensions) {
				const improves = isScoreImproving(receipt.scores, baselineScore, scoreDimensions);
				const matches = Object.entries(baselineScore).every(([k, v]) => receipt.scores[k] === v);
				if (!improves && !matches) {
					consecutiveRegressions++;
					continue;
				}
			}
			break;
		}
	}

	const isStagnating = consecutiveFailures >= threshold || consecutiveRegressions >= threshold;
	let rationale = "Trajectory is progressing normally.";
	if (consecutiveFailures >= threshold) {
		rationale = `Detected ${consecutiveFailures} consecutive failed evaluations exceeding threshold ${threshold}.`;
	} else if (consecutiveRegressions >= threshold) {
		rationale = `Detected ${consecutiveRegressions} consecutive score regressions without improvement exceeding threshold ${threshold}.`;
	}

	return {
		isStagnating,
		consecutiveFailures,
		consecutiveRegressions,
		repeatedErrors,
		rationale,
	};
}

/**
 * Controller providing the agent-facing API for an autonomous variation episode:
 * - Direct deliberate sampling from P_t (lineage) and K (knowledge)
 * - Free-form action ordering (edit, evaluate, diagnose, repair)
 * - Invocation of the fixed, immutable scoring utility
 * - Trajectory auditing without polluting committed P_t with failures
 */
export class AvoVariationEpisodeController<T = unknown> {
	readonly contract: AvoVariationContract<T>;
	readonly trajectory: AvoWorkingAttempt[] = [];
	readonly sampledLineageIds = new Set<string>();
	readonly sampledKnowledgeIds = new Set<string>();
	readonly supervisorInterventions: AvoSupervisorSteering[] = [];

	private _evaluationCount = 0;
	private _actionCounter = 0;
	private _latestReceipt?: AvoScoringReceipt;
	private _latestCandidateRef?: string;
	private _latestContentDigest?: string;
	private _latestPayload?: T;

	constructor(contract: AvoVariationContract<T>) {
		this.contract = contract;
	}

	get evaluationCount(): number {
		return this._evaluationCount;
	}

	get latestReceipt(): AvoScoringReceipt | undefined {
		return this._latestReceipt;
	}

	get latestContentDigest(): string | undefined {
		return this._latestContentDigest;
	}

	private nextAttemptId(prefix: string): string {
		this._actionCounter++;
		return `${prefix}-${this._actionCounter}`;
	}

	private recordAction(
		actionType: AvoVariationActionType,
		details: Partial<AvoWorkingAttempt> = {},
	): AvoWorkingAttempt {
		const attempt: AvoWorkingAttempt = {
			attemptId: this.nextAttemptId(actionType),
			actionType,
			timestamp: new Date().toISOString(),
			...details,
		};
		this.trajectory.push(attempt);
		return attempt;
	}

	/**
	 * Lists all committed lineage entries available for agent sampling.
	 */
	listLineage(): Array<{
		solutionId: string;
		solutionRef: string;
		scores: Record<string, number>;
		passedCorrectness: boolean;
		timestamp: string;
	}> {
		return this.contract.lineage.entries.map((entry) => ({
			solutionId: entry.solutionId,
			solutionRef: entry.solutionRef,
			scores: { ...entry.scores },
			passedCorrectness: entry.passedCorrectness,
			timestamp: entry.timestamp,
		}));
	}

	/**
	 * Deliberately inspects a specific solution from the committed lineage P_t.
	 */
	sampleLineage(solutionId: string, reason?: string): AvoCommittedSolution<T> {
		const solution = this.contract.lineage.entries.find((e) => e.solutionId === solutionId);
		if (!solution) {
			throw new Error(`Lineage solution '${solutionId}' not found in P_t`);
		}
		this.sampledLineageIds.add(solutionId);
		this.recordAction("inspect_lineage", {
			targetId: solutionId,
			reason,
			candidateRef: solution.solutionRef,
		});
		return solution;
	}

	/**
	 * Lists all domain knowledge entries in K.
	 */
	listKnowledge(): Array<{
		knowledgeId: string;
		title: string;
		kind: string;
		digest: string;
	}> {
		return this.contract.knowledge.map((k) => ({
			knowledgeId: k.knowledgeId,
			title: k.title,
			kind: k.kind,
			digest: k.digest,
		}));
	}

	/**
	 * Deliberately consults a domain knowledge entry from K.
	 */
	sampleKnowledge(knowledgeId: string, reason?: string): AvoKnowledgeEntry {
		const entry = this.contract.knowledge.find((k) => k.knowledgeId === knowledgeId);
		if (!entry) {
			throw new Error(`Knowledge entry '${knowledgeId}' not found in K`);
		}
		this.sampledKnowledgeIds.add(knowledgeId);
		this.recordAction("inspect_knowledge", {
			targetId: knowledgeId,
			reason,
			contentDigest: entry.digest,
		});
		return entry;
	}

	/**
	 * Records a candidate modification edit in the working trajectory.
	 */
	recordEdit(candidateRef: string, content: string, payload?: T, reason?: string): AvoWorkingAttempt {
		const contentDigest = digestContent(content);
		this._latestCandidateRef = candidateRef;
		this._latestContentDigest = contentDigest;
		this._latestPayload = payload;

		return this.recordAction("edit", {
			candidateRef,
			contentDigest,
			reason,
		});
	}

	/**
	 * Invokes the fixed, immutable scoring utility f on the candidate.
	 */
	async evaluateCandidate(
		candidateRef: string,
		content?: string,
		parameters?: Record<string, unknown>,
	): Promise<AvoScoringReceipt> {
		const maxEvals = this.contract.budget?.maxEvaluations;
		if (maxEvals !== undefined && this._evaluationCount >= maxEvals) {
			throw new Error(`Evaluation budget exceeded: ${this._evaluationCount} >= ${maxEvals}`);
		}

		this._evaluationCount++;

		// Invoke the immutable scoring utility handle
		const receipt = await this.contract.scorer.evaluate({
			candidateRef,
			content,
			parameters,
		});

		// Verify scorer digest integrity
		if (receipt.scorerDigest !== this.contract.scorer.scorerDigest) {
			throw new Error(
				`Scorer digest mismatch: received '${receipt.scorerDigest}', expected '${this.contract.scorer.scorerDigest}'`,
			);
		}

		this._latestReceipt = receipt;

		this.recordAction("evaluate", {
			candidateRef,
			contentDigest: receipt.candidateDigest,
			receipt,
		});

		// Check for stagnation and trigger conditional supervisor steering if configured
		if (this.contract.supervisor?.enabled && this.contract.supervisor.steer) {
			const threshold = this.contract.supervisor.maxConsecutiveFailuresBeforeIntervention ?? 3;
			const stagnation = detectAvoStagnation(
				this.trajectory,
				threshold,
				this.contract.lineage.baselineScore,
				this.contract.scorer.scoreDimensions,
			);

			if (stagnation.isStagnating) {
				const steering = await this.contract.supervisor.steer(this.trajectory, stagnation);
				if (steering) {
					this.supervisorInterventions.push(steering);
				}
			}
		}

		return receipt;
	}

	/**
	 * Records a diagnostic observation after an evaluation failure.
	 */
	recordDiagnosis(diagnostics: string, reason?: string): AvoWorkingAttempt {
		return this.recordAction("diagnose", {
			diagnostics,
			reason,
		});
	}

	/**
	 * Records a repair attempt after diagnosing an issue.
	 */
	recordRepair(candidateRef: string, content: string, payload?: T, reason?: string): AvoWorkingAttempt {
		const contentDigest = digestContent(content);
		this._latestCandidateRef = candidateRef;
		this._latestContentDigest = contentDigest;
		this._latestPayload = payload;

		return this.recordAction("repair", {
			candidateRef,
			contentDigest,
			reason,
		});
	}

	/**
	 * Completes the autonomous variation episode and returns the VariationResult.
	 */
	finish(): AvoVariationResult<T> {
		const enabledExtensions: string[] = [];
		if (this.contract.extensions?.enableNooaMemory) {
			enabledExtensions.push("nooa_memory");
		}
		if (this.contract.extensions?.enableObligations) {
			enabledExtensions.push("obligations");
		}
		if (this.contract.extensions?.enableCanonicalDelivery) {
			enabledExtensions.push("canonical_delivery");
		}

		if (this._latestReceipt && this._latestReceipt.passedCorrectness && this._latestCandidateRef) {
			const baseline = this.contract.lineage.baselineScore ?? {};
			const improves = isScoreImproving(this._latestReceipt.scores, baseline, this.contract.scorer.scoreDimensions);
			const matches = Object.entries(baseline).every(([k, v]) => this._latestReceipt?.scores[k] === v);

			if (improves || matches) {
				const candidateSolution: AvoCommittedSolution<T> = {
					solutionId: `sol-${digestContent(this._latestCandidateRef).slice(0, 12)}`,
					solutionRef: this._latestCandidateRef,
					payload: this._latestPayload,
					scores: { ...this._latestReceipt.scores },
					passedCorrectness: true,
					parentSolutionId: this.contract.lineage.bestSolutionId,
					trajectoryRef: `traj-${this.trajectory.length}`,
					timestamp: new Date().toISOString(),
				};

				return {
					status: "committed",
					paperCoreVersion: AVO_PAPER_CORE_VERSION,
					candidateSolution,
					trajectory: [...this.trajectory],
					sampledLineageIds: Array.from(this.sampledLineageIds),
					sampledKnowledgeIds: Array.from(this.sampledKnowledgeIds),
					evaluationCount: this._evaluationCount,
					enabledExtensions,
					supervisorInterventions: [...this.supervisorInterventions],
				};
			}
		}

		return {
			status: "uncommitted_exhausted",
			paperCoreVersion: AVO_PAPER_CORE_VERSION,
			trajectory: [...this.trajectory],
			sampledLineageIds: Array.from(this.sampledLineageIds),
			sampledKnowledgeIds: Array.from(this.sampledKnowledgeIds),
			evaluationCount: this._evaluationCount,
			enabledExtensions,
			supervisorInterventions: [...this.supervisorInterventions],
		};
	}
}

/**
 * Top-level variation operator entry point:
 * Vary(P_t) = Agent(P_t, K, f)
 */
export async function executeAvoVariationEpisode<T = unknown>(
	contract: AvoVariationContract<T>,
	runAgentSession: (controller: AvoVariationEpisodeController<T>) => Promise<void>,
): Promise<AvoVariationResult<T>> {
	const controller = new AvoVariationEpisodeController<T>(contract);
	await runAgentSession(controller);
	return controller.finish();
}
