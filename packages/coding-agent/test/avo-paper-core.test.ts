import { describe, expect, it } from "vitest";
import {
	AVO_PAPER_CORE_VERSION,
	type AvoCommittedSolution,
	type AvoKnowledgeEntry,
	type AvoLineage,
	type AvoScoreDimension,
	type AvoScoringUtility,
	type AvoVariationContract,
	type AvoVariationResult,
	createAvoLineage,
	digestContent,
	executeAvoVariationEpisode,
	updateAvoLineage,
} from "../src/core/avo/index.js";
import { createHarness } from "./suite/harness.js";

describe("Paper-Faithful AVO Core (arXiv:2603.24517)", () => {
	const scoreDimensions: AvoScoreDimension[] = [{ name: "throughput_tflops", direction: "maximize", unit: "TFLOPS" }];

	function createMockScorer(
		options: {
			evaluatorFn?: (code: string) => { correctness: boolean; tflops: number; logs?: string };
			digest?: string;
		} = {},
	): AvoScoringUtility {
		const scorerDigest = options.digest ?? "scorer-digest-fa4-v1";
		return {
			scorerId: "b200-mha-scorer",
			version: "1.0.0",
			scorerDigest,
			scoreDimensions,
			evaluate: async (input) => {
				const content = input.content ?? "";
				const outcome = options.evaluatorFn ? options.evaluatorFn(content) : { correctness: true, tflops: 1500 };

				return {
					scorerId: "b200-mha-scorer",
					scorerVersion: "1.0.0",
					scorerDigest,
					candidateDigest: digestContent(content),
					passedCorrectness: outcome.correctness,
					scores: {
						throughput_tflops: outcome.correctness ? outcome.tflops : 0,
					},
					executionStatus: outcome.correctness ? "pass" : "fail",
					logs: outcome.logs,
					timestamp: new Date().toISOString(),
				};
			},
		};
	}

	const knowledgeBase: AvoKnowledgeEntry[] = [
		{
			knowledgeId: "blackwell-warp-spec",
			title: "Blackwell Warp Specialization Architecture",
			kind: "specification",
			content: "MMA warps (QK/PV GEMM), Softmax warps, Correction warps (rescale accumulator O).",
			digest: digestContent("Blackwell Warp Specialization Architecture"),
		},
		{
			knowledgeId: "online-softmax-branchless",
			title: "Branchless Rescaling with Predicated Select",
			kind: "reference_kernel",
			content: "Eliminate branch on running max; use non-blocking memory fence.",
			digest: digestContent("Branchless Rescaling with Predicated Select"),
		},
	];

	const seedSolution: AvoCommittedSolution<string> = {
		solutionId: "v0-seed",
		solutionRef: "commit-v0",
		payload: "naive_mha_kernel()",
		scores: { throughput_tflops: 1400 },
		passedCorrectness: true,
		timestamp: new Date().toISOString(),
	};

	// -----------------------------------------------------------------------
	// Issue #48: Define a paper-faithful variation-operator boundary
	// -----------------------------------------------------------------------
	it("[Issue #48] executes variation operator with explicit (P_t, K, f, budget) input and returns (x_{t+1}, f(x_{t+1}), trajectory)", async () => {
		const lineage = createAvoLineage("lineage-mha-1", seedSolution);
		const scorer = createMockScorer({
			evaluatorFn: () => ({ correctness: true, tflops: 1580 }),
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Optimize forward MHA prefill kernel on Blackwell B200",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			budget: { maxEvaluations: 5 },
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			// Agent inspects knowledge and proposes an edit
			agent.sampleKnowledge("blackwell-warp-spec", "Check warp roles");
			agent.recordEdit("v1-candidate", "optimized_mha_v1()");
			await agent.evaluateCandidate("v1-candidate", "optimized_mha_v1()");
		});

		expect(result.status).toBe("committed");
		expect(result.paperCoreVersion).toBe(AVO_PAPER_CORE_VERSION);
		expect(result.candidateSolution).toBeDefined();
		expect(result.candidateSolution?.scores.throughput_tflops).toBe(1580);
		expect(result.candidateSolution?.parentSolutionId).toBe("v0-seed");
		expect(result.sampledKnowledgeIds).toContain("blackwell-warp-spec");
		expect(result.trajectory.length).toBeGreaterThanOrEqual(3);

		// Outer loop Update(P_t, (x_{t+1}, f(x_{t+1})))
		const updateResult = updateAvoLineage(lineage, result.candidateSolution!, scoreDimensions);
		expect(updateResult.updated).toBe(true);
		expect(updateResult.lineage.entries.length).toBe(2);
		expect(updateResult.lineage.bestSolutionId).toBe(result.candidateSolution!.solutionId);
		expect(updateResult.lineage.baselineScore?.throughput_tflops).toBe(1580);
	});

	// -----------------------------------------------------------------------
	// Issue #53: Separate paper AVO core from Prime-specific extensions
	// -----------------------------------------------------------------------
	it("[Issue #53] operates cleanly with paper core alone and accurately reports enabled extensions", async () => {
		const lineage = createAvoLineage("lineage-mha-ext", seedSolution);
		const scorer = createMockScorer();

		// Case A: Paper core alone (no extensions)
		const coreOnlyContract: AvoVariationContract<string> = {
			taskContext: "Paper core standalone test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		const coreResult = await executeAvoVariationEpisode(coreOnlyContract, async (agent) => {
			agent.recordEdit("v1-core", "code_core()");
			await agent.evaluateCandidate("v1-core", "code_core()");
		});

		expect(coreResult.enabledExtensions).toEqual([]);
		expect(coreResult.status).toBe("committed");

		// Case B: Paper core with optional Prime extensions enabled
		const extContract: AvoVariationContract<string> = {
			taskContext: "Paper core with extensions",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			extensions: {
				enableNooaMemory: true,
				enableObligations: true,
				enableCanonicalDelivery: true,
			},
		};

		const extResult = await executeAvoVariationEpisode(extContract, async (agent) => {
			agent.recordEdit("v1-ext", "code_ext()");
			await agent.evaluateCandidate("v1-ext", "code_ext()");
		});

		expect(extResult.enabledExtensions).toContain("nooa_memory");
		expect(extResult.enabledExtensions).toContain("obligations");
		expect(extResult.enabledExtensions).toContain("canonical_delivery");
	});

	// -----------------------------------------------------------------------
	// Issue #49: Replace prescribed lifecycle with an autonomous variation episode
	// -----------------------------------------------------------------------
	it("[Issue #49] allows arbitrary action sequences including multiple evaluations and diagnostic repairs", async () => {
		const lineage = createAvoLineage("lineage-mha-freeform", seedSolution);

		let evalAttempt = 0;
		const scorer = createMockScorer({
			evaluatorFn: (_code) => {
				evalAttempt++;
				if (evalAttempt === 1) {
					return { correctness: false, tflops: 0, logs: "CUDA syntax error line 42" };
				}
				if (evalAttempt === 2) {
					return { correctness: true, tflops: 1420 }; // Modest improvement
				}
				return { correctness: true, tflops: 1650 }; // Major breakthrough
			},
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Free-form agentic search trajectory",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			// Action 1: Consult knowledge
			agent.sampleKnowledge("online-softmax-branchless");

			// Action 2: First attempt (fails)
			agent.recordEdit("attempt-1", "buggy_code()");
			const receipt1 = await agent.evaluateCandidate("attempt-1", "buggy_code()");
			expect(receipt1.passedCorrectness).toBe(false);

			// Action 3: Diagnose failure
			agent.recordDiagnosis("Syntax error occurred in barrier handshake; fixing syncthreads");

			// Action 4: Repair code
			agent.recordRepair("attempt-2", "fixed_barrier_code()");
			const receipt2 = await agent.evaluateCandidate("attempt-2", "fixed_barrier_code()");
			expect(receipt2.passedCorrectness).toBe(true);

			// Action 5: Return to knowledge and perform another micro-architectural refinement
			agent.sampleKnowledge("blackwell-warp-spec");
			agent.recordEdit("attempt-3", "fully_pipelined_code()");
			const receipt3 = await agent.evaluateCandidate("attempt-3", "fully_pipelined_code()");
			expect(receipt3.scores.throughput_tflops).toBe(1650);
		});

		expect(result.status).toBe("committed");
		expect(result.evaluationCount).toBe(3);
		expect(result.candidateSolution?.scores.throughput_tflops).toBe(1650);

		// Verify that the action sequence in trajectory matches the agent's autonomous choices
		const actionTypes = result.trajectory.map((a) => a.actionType);
		expect(actionTypes).toEqual([
			"inspect_knowledge",
			"edit",
			"evaluate",
			"diagnose",
			"repair",
			"evaluate",
			"inspect_knowledge",
			"edit",
			"evaluate",
		]);
	});

	it("[Issue #49] demonstrates second valid trajectory with inverted retrieval and evaluation ordering", async () => {
		const lineage = createAvoLineage("lineage-inverted-order", seedSolution);

		let attempt = 0;
		const scorer = createMockScorer({
			evaluatorFn: () => {
				attempt++;
				return attempt === 1
					? { correctness: false, tflops: 0, logs: "Warp divergence detected" }
					: { correctness: true, tflops: 1550 };
			},
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Agent edits first, evaluates, then inspects lineage/knowledge on failure",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		// Trajectory: Edit first -> Evaluate -> Failure -> Sample Lineage -> Sample Knowledge -> Repair -> Evaluate
		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			agent.recordEdit("speculative-v1", "fast_unverified_kernel()");
			const receipt1 = await agent.evaluateCandidate("speculative-v1", "fast_unverified_kernel()");
			expect(receipt1.passedCorrectness).toBe(false);

			// Interleaved inspection only triggered because of runtime failure
			agent.sampleLineage("v0-seed", "Compare register usage with baseline");
			agent.sampleKnowledge("blackwell-warp-spec", "Check divergence barrier spec");

			agent.recordDiagnosis("Need to avoid branch inside warp; use branchless ballot");
			agent.recordRepair("speculative-v2", "branchless_ballot_kernel()");
			const receipt2 = await agent.evaluateCandidate("speculative-v2", "branchless_ballot_kernel()");
			expect(receipt2.passedCorrectness).toBe(true);
		});

		expect(result.status).toBe("committed");
		expect(result.evaluationCount).toBe(2);
		expect(result.candidateSolution?.scores.throughput_tflops).toBe(1550);

		const actionTypes = result.trajectory.map((a) => a.actionType);
		expect(actionTypes).toEqual([
			"edit",
			"evaluate",
			"inspect_lineage",
			"inspect_knowledge",
			"diagnose",
			"repair",
			"evaluate",
		]);
	});

	// -----------------------------------------------------------------------
	// Issue #50: Keep failed working attempts out of the committed lineage
	// -----------------------------------------------------------------------
	it("[Issue #50] keeps failed attempts in trajectory and commits exactly one passing non-regressing solution to P_t", async () => {
		const lineage = createAvoLineage("lineage-cleanliness", seedSolution);

		let attemptCount = 0;
		const scorer = createMockScorer({
			evaluatorFn: () => {
				attemptCount++;
				if (attemptCount === 1) return { correctness: false, tflops: 0 };
				if (attemptCount === 2) return { correctness: false, tflops: 0 };
				if (attemptCount === 3) return { correctness: true, tflops: 1350 }; // Regressed below 1400 baseline
				return { correctness: true, tflops: 1620 }; // Passed and improved
			},
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Lineage hygiene test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			// Failed attempt 1
			agent.recordEdit("try-1", "bad-1");
			await agent.evaluateCandidate("try-1", "bad-1");

			// Failed attempt 2
			agent.recordEdit("try-2", "bad-2");
			await agent.evaluateCandidate("try-2", "bad-2");

			// Regressing attempt 3 (passed correctness, but lower throughput than baseline 1400)
			agent.recordEdit("try-3", "slow-3");
			await agent.evaluateCandidate("try-3", "slow-3");

			// Passing attempt 4
			agent.recordEdit("try-4", "fast-4");
			await agent.evaluateCandidate("try-4", "fast-4");
		});

		expect(result.status).toBe("committed");
		expect(result.evaluationCount).toBe(4);
		expect(result.candidateSolution?.solutionRef).toBe("try-4");

		// Crucial assertion: Lineage initially has 1 entry. Updating with result adds exactly ONE entry.
		const updateResult = updateAvoLineage(lineage, result.candidateSolution!, scoreDimensions);
		expect(updateResult.updated).toBe(true);
		expect(updateResult.lineage.entries.length).toBe(2);
		expect(updateResult.lineage.entries.map((e) => e.solutionRef)).toEqual(["commit-v0", "try-4"]);

		// All 4 attempts remain fully auditable in trajectory
		expect(result.trajectory.filter((a) => a.actionType === "evaluate").length).toBe(4);
	});

	it("[Issue #50] rejects committing an uncommitted attempt if final candidate regressed or failed", async () => {
		const lineage = createAvoLineage("lineage-fail", seedSolution);
		const scorer = createMockScorer({
			evaluatorFn: () => ({ correctness: false, tflops: 0 }),
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Failed variation episode",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			agent.recordEdit("broken-attempt", "syntax error");
			await agent.evaluateCandidate("broken-attempt", "syntax error");
		});

		expect(result.status).toBe("uncommitted_exhausted");
		expect(result.candidateSolution).toBeUndefined();

		// Attempting to update lineage with invalid solution fails closed
		const updateResult = updateAvoLineage(
			lineage,
			{
				solutionId: "fake-fail",
				solutionRef: "broken-attempt",
				scores: { throughput_tflops: 0 },
				passedCorrectness: false,
				timestamp: new Date().toISOString(),
			},
			scoreDimensions,
		);
		expect(updateResult.updated).toBe(false);
		expect(updateResult.lineage.entries.length).toBe(1);
	});

	// -----------------------------------------------------------------------
	// Issue #51: Expose full lineage and knowledge base for agent-directed sampling
	// -----------------------------------------------------------------------
	it("[Issue #51] allows agent to list and deliberately sample any lineage entry and knowledge item with attribution", async () => {
		// Create lineage with multiple historical versions
		const v1: AvoCommittedSolution<string> = {
			solutionId: "v1-sol",
			solutionRef: "commit-v1",
			scores: { throughput_tflops: 1450 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};
		const v2: AvoCommittedSolution<string> = {
			solutionId: "v2-sol",
			solutionRef: "commit-v2",
			scores: { throughput_tflops: 1520 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};
		const lineage: AvoLineage<string> = {
			lineageId: "lineage-deep",
			entries: [seedSolution, v1, v2],
			bestSolutionId: "v2-sol",
			baselineScore: { throughput_tflops: 1520 },
		};

		const scorer = createMockScorer();
		const contract: AvoVariationContract<string> = {
			taskContext: "Lineage sampling test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			// Agent lists the full committed lineage catalog
			const availableSolutions = agent.listLineage();
			expect(availableSolutions.length).toBe(3);

			// Deliberately sample the older v0 seed rather than the latest top-k
			const sampledV0 = agent.sampleLineage("v0-seed", "Inspect initial tiling parameters");
			expect(sampledV0.solutionId).toBe("v0-seed");

			// Deliberately sample knowledge entry
			const sampledK = agent.sampleKnowledge("online-softmax-branchless", "Review select implementation");
			expect(sampledK.knowledgeId).toBe("online-softmax-branchless");

			agent.recordEdit("v3-sol", "new_code");
			await agent.evaluateCandidate("v3-sol", "new_code");
		});

		expect(result.sampledLineageIds).toContain("v0-seed");
		expect(result.sampledKnowledgeIds).toContain("online-softmax-branchless");

		// Verify retrieval records are present in trajectory
		const lineageAudit = result.trajectory.find((a) => a.actionType === "inspect_lineage");
		expect(lineageAudit?.targetId).toBe("v0-seed");
		expect(lineageAudit?.reason).toBe("Inspect initial tiling parameters");
	});

	it("[Issue #51 Integration] lists and deliberately samples lineage and knowledge via host RPC with trace attribution", async () => {
		const harness = await createHarness({ enableAvo: true });
		const v1: AvoCommittedSolution<string> = {
			solutionId: "v1-sol",
			solutionRef: "commit-v1",
			scores: { throughput_tflops: 1450 },
			passedCorrectness: true,
			timestamp: new Date().toISOString(),
		};
		const lineage = createAvoLineage("lineage-rpc-sample", seedSolution);
		lineage.entries.push(v1);

		const runtime = (
			harness.session as unknown as {
				_avoRuntime: { setLineage: (l: unknown) => void; setKnowledgeBase: (k: unknown) => void };
			}
		)._avoRuntime;
		runtime.setLineage(lineage);
		runtime.setKnowledgeBase(knowledgeBase);

		// 1. List lineage via host RPC
		const lineageListResponse = await harness.session.handleAvoHostRequest("avo.lineage.list");
		const lineageEntries = lineageListResponse.entries as Array<{ solutionId: string }>;
		expect(lineageEntries.length).toBe(2);
		expect(lineageEntries.map((e) => e.solutionId)).toEqual(["v0-seed", "v1-sol"]);

		// 2. Deliberately sample an older lineage entry via host RPC
		const lineageSampleResponse = await harness.session.handleAvoHostRequest("avo.lineage.sample", {
			solutionId: "v0-seed",
			reason: "Inspect initial register tiling baseline",
		});
		expect(lineageSampleResponse.solution).toMatchObject({ solutionId: "v0-seed" });
		expect(lineageSampleResponse.trace).toMatchObject({
			sourceType: "lineage",
			sourceId: "v0-seed",
			reason: "Inspect initial register tiling baseline",
		});

		// 3. List knowledge via host RPC
		const knowledgeListResponse = await harness.session.handleAvoHostRequest("avo.knowledge.list");
		const knowledgeEntries = knowledgeListResponse.entries as Array<{ knowledgeId: string }>;
		expect(knowledgeEntries.length).toBe(2);
		expect(knowledgeEntries.map((e) => e.knowledgeId)).toEqual(["blackwell-warp-spec", "online-softmax-branchless"]);

		// 4. Deliberately sample knowledge via host RPC
		const knowledgeSampleResponse = await harness.session.handleAvoHostRequest("avo.knowledge.sample", {
			knowledgeId: "blackwell-warp-spec",
			reason: "Review TMA barrier specifications",
		});
		expect(knowledgeSampleResponse.knowledge).toMatchObject({ knowledgeId: "blackwell-warp-spec" });
		expect(knowledgeSampleResponse.trace).toMatchObject({
			sourceType: "knowledge",
			sourceId: "blackwell-warp-spec",
			reason: "Review TMA barrier specifications",
		});

		// 5. Fail-closed security tests
		await expect(
			harness.session.handleAvoHostRequest("avo.lineage.sample", { solutionId: "nonexistent-sol" }),
		).rejects.toThrow("not found in P_t");

		await expect(
			harness.session.handleAvoHostRequest("avo.knowledge.sample", { knowledgeId: "nonexistent-doc" }),
		).rejects.toThrow("not found in K");
	});

	// -----------------------------------------------------------------------
	// Issue #52: Make scoring utility immutable but agent-scheduled
	// -----------------------------------------------------------------------
	it("[Issue #52] enforces scorer digest integrity and rejects forged or replaced scorers", async () => {
		const lineage = createAvoLineage("lineage-scorer", seedSolution);
		const scorer = createMockScorer({ digest: "authentic-b200-manifest-v1" });

		const contract: AvoVariationContract<string> = {
			taskContext: "Scorer immutability test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			budget: { maxEvaluations: 2 },
		};

		// Test A: Normal invocation succeeds
		await executeAvoVariationEpisode(contract, async (agent) => {
			agent.recordEdit("cand-1", "valid_code");
			const receipt = await agent.evaluateCandidate("cand-1", "valid_code");
			expect(receipt.scorerDigest).toBe("authentic-b200-manifest-v1");
		});

		// Test B: Tampered receipt scorer digest fails closed
		const tamperedScorer: AvoScoringUtility = {
			scorerId: "b200-mha-scorer",
			version: "1.0.0",
			scorerDigest: "expected-digest",
			scoreDimensions,
			evaluate: async () => ({
				scorerId: "b200-mha-scorer",
				scorerVersion: "1.0.0",
				scorerDigest: "forged-digest", // Tampered
				candidateDigest: "abc",
				passedCorrectness: true,
				scores: { throughput_tflops: 9999 },
				executionStatus: "pass",
				timestamp: new Date().toISOString(),
			}),
		};

		const tamperedContract: AvoVariationContract<string> = {
			taskContext: "Tampered scorer test",
			lineage,
			knowledge: knowledgeBase,
			scorer: tamperedScorer,
		};

		await expect(
			executeAvoVariationEpisode(tamperedContract, async (agent) => {
				agent.recordEdit("cand-hack", "hack");
				await agent.evaluateCandidate("cand-hack", "hack");
			}),
		).rejects.toThrow(/Scorer digest mismatch/);
	});

	it("[Issue #52] enforces evaluation budget bounds", async () => {
		const lineage = createAvoLineage("lineage-budget", seedSolution);
		let evaluationCount = 0;
		const scorer = createMockScorer({
			evaluatorFn: () => {
				evaluationCount++;
				return { correctness: true, tflops: 1400 };
			},
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Budget enforcement",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			budget: { maxEvaluations: 2 },
		};

		await expect(
			executeAvoVariationEpisode(contract, async (agent) => {
				agent.recordEdit("c1", "c1");
				await agent.evaluateCandidate("c1", "c1");

				agent.recordEdit("c2", "c2");
				await agent.evaluateCandidate("c2", "c2");

				// Third evaluation exceeds budget
				agent.recordEdit("c3", "c3");
				await agent.evaluateCandidate("c3", "c3");
			}),
		).rejects.toThrow(/Evaluation budget exceeded/);
		expect(evaluationCount).toBe(2);
	});

	it("[Issue #52 Integration] returns immutable scoring manifest and rejects model command overrides via host RPC", async () => {
		const harness = await createHarness({ enableAvo: true });
		const scorer = createMockScorer({ digest: "immutable-manifest-v100" });

		const runtime = (
			harness.session as unknown as {
				_avoRuntime: { setScoringUtility: (s: unknown) => void };
			}
		)._avoRuntime;
		runtime.setScoringUtility(scorer);

		// 1. Inspect manifest
		const manifestRes = await harness.session.handleAvoHostRequest("avo.scoring.manifest.get");
		expect(manifestRes.manifest).toMatchObject({
			scorerId: scorer.scorerId,
			version: scorer.version,
			scorerDigest: "immutable-manifest-v100",
		});

		// 2. Evaluate candidate with immutable scorer handle
		const evalRes = await harness.session.handleAvoHostRequest("avo.scoring.evaluate", {
			candidateRef: "kernel-candidate-v1",
			content: "__global__ void fast_kernel() {}",
		});
		expect(evalRes.receipt).toMatchObject({
			scorerDigest: "immutable-manifest-v100",
			passedCorrectness: true,
			candidateDigest: expect.any(String),
		});

		// 3. Reject model-supplied command override
		await expect(
			harness.session.handleAvoHostRequest("avo.scoring.evaluate", {
				candidateRef: "kernel-candidate-v1",
				command: "pytest -s -k mock_pass",
			}),
		).rejects.toThrow(/rejects model-supplied command overrides; scorer is immutable/);
	});

	// -----------------------------------------------------------------------
	// Issue #54: Restrict supervisor to conditional stagnation steering
	// -----------------------------------------------------------------------
	it("[Issue #54] activates supervisor only when stagnation occurs and provides high-level steering without micromanaging API calls", async () => {
		const lineage = createAvoLineage("lineage-supervisor", seedSolution);

		let _evalTurn = 0;
		const scorer = createMockScorer({
			evaluatorFn: () => {
				_evalTurn++;
				// 3 consecutive failures trigger stagnation
				return { correctness: false, tflops: 0, logs: "Warp divergence stall" };
			},
		});

		let supervisorTriggerCount = 0;
		const contract: AvoVariationContract<string> = {
			taskContext: "Supervisor stagnation test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			supervisor: {
				enabled: true,
				maxConsecutiveFailuresBeforeIntervention: 3,
				steer: async (_trajectory, stagnation) => {
					supervisorTriggerCount++;
					expect(stagnation.isStagnating).toBe(true);
					expect(stagnation.consecutiveFailures).toBe(3);
					return {
						detectedPattern: "Repeated warp divergence stalls across 3 evaluations",
						suggestedDirections: [
							"Consider replacing the conditional loop exit with a branchless predicated select",
							"Inspect the Blackwell TMA epilogue synchronization pattern",
						],
						rationale: "Warp synchronization is stalling all threads on unmasked iterations.",
						timestamp: new Date().toISOString(),
					};
				},
			},
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			// Eval 1: Failure 1 (no supervisor yet)
			agent.recordEdit("fail-1", "bad1");
			await agent.evaluateCandidate("fail-1", "bad1");
			expect(supervisorTriggerCount).toBe(0);

			// Eval 2: Failure 2 (no supervisor yet)
			agent.recordEdit("fail-2", "bad2");
			await agent.evaluateCandidate("fail-2", "bad2");
			expect(supervisorTriggerCount).toBe(0);

			// Eval 3: Failure 3 -> triggers stagnation threshold 3!
			agent.recordEdit("fail-3", "bad3");
			await agent.evaluateCandidate("fail-3", "bad3");
			expect(supervisorTriggerCount).toBe(1);
		});

		expect(result.supervisorInterventions.length).toBe(1);
		expect(result.supervisorInterventions[0].detectedPattern).toContain("Repeated warp divergence");
		expect(result.supervisorInterventions[0].suggestedDirections.length).toBe(2);
	});

	it("[Issue #54] supervisor remains completely dormant when the trajectory is making measurable progress", async () => {
		const lineage = createAvoLineage("lineage-progress", seedSolution);
		const scorer = createMockScorer({
			evaluatorFn: () => ({ correctness: true, tflops: 1550 }),
		});

		let supervisorCalled = false;
		const contract: AvoVariationContract<string> = {
			taskContext: "Supervisor dormancy test",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			supervisor: {
				enabled: true,
				maxConsecutiveFailuresBeforeIntervention: 3,
				steer: async () => {
					supervisorCalled = true;
					return null;
				},
			},
		};

		const result = await executeAvoVariationEpisode(contract, async (agent) => {
			for (let i = 1; i <= 3; i++) {
				agent.recordEdit(`pass-${i}`, `code-${i}`);
				await agent.evaluateCandidate(`pass-${i}`, `code-${i}`);
			}
		});

		expect(result.status).toBe("committed");
		expect(supervisorCalled).toBe(false);
		expect(result.supervisorInterventions.length).toBe(0);
	});

	it("[Issue #48] does not automatically redefine normal root tasks as AVO variation episodes when enableAvo is false", async () => {
		const harness = await createHarness({ enableAvo: false });
		expect(harness.session.isAvoEnabled).toBe(false);
	});

	it("[Issue #48] normal root tasks without explicit AVO config do not enable AVO by default", async () => {
		const harness = await createHarness();
		expect(harness.session.isAvoEnabled).toBe(false);
	});

	it("[Issue #48] activates AVO runtime when enableAvo is true", async () => {
		const harness = await createHarness({ enableAvo: true });
		expect(harness.session.isAvoEnabled).toBe(true);
	});

	it("[Issue #48 Integration] executes variation episode through host RPC handleAvoHostRequest('avo.variation.run')", async () => {
		const harness = await createHarness({ enableAvo: true });
		const lineage = createAvoLineage("lineage-rpc-1", seedSolution);
		const scorer = createMockScorer({
			evaluatorFn: () => ({ correctness: true, tflops: 1690 }),
		});

		const contract: AvoVariationContract<string> = {
			taskContext: "Optimize forward MHA prefill kernel on Blackwell B200 via RPC",
			lineage,
			knowledge: knowledgeBase,
			scorer,
			budget: { maxEvaluations: 3 },
		};

		const response = await harness.session.handleAvoHostRequest("avo.variation.run", {
			contract,
			actions: [
				{ type: "sample_knowledge", knowledgeId: "blackwell-warp-spec", reason: "Check TMA rules" },
				{ type: "edit", candidateRef: "cand-rpc-1", content: "mha_rpc_v1()" },
				{ type: "evaluate", candidateRef: "cand-rpc-1", content: "mha_rpc_v1()" },
			],
		});

		const result = response.result as unknown as AvoVariationResult<string>;
		expect(result).toBeDefined();
		expect(result.status).toBe("committed");
		expect(result.candidateSolution?.scores.throughput_tflops).toBe(1690);
		expect(result.candidateSolution?.parentSolutionId).toBe("v0-seed");
		expect(result.sampledKnowledgeIds).toContain("blackwell-warp-spec");
		expect(result.trajectory.length).toBe(3);

		// Outer loop update
		const updatedLineage = updateAvoLineage(lineage, result.candidateSolution!, scoreDimensions);
		expect(updatedLineage.updated).toBe(true);
		expect(updatedLineage.lineage.entries.length).toBe(2);
		expect(updatedLineage.lineage.bestSolutionId).toBe(result.candidateSolution?.solutionId);
	});
});
