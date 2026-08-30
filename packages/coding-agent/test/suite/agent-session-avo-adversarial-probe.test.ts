import { rmSync, symlinkSync, writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageController,
	type AgentSessionMessageReceipt,
	type AgentSessionMessageSendInput,
} from "../../src/core/agent-messages.js";
import {
	type AvoPythonProbeBindings,
	type AvoPythonProbeExecutorAvailability,
	type AvoRunState,
	type AvoSessionRuntime,
	CodingAvoAdapter,
	canExecuteAvoPythonProbe,
	captureAvoPythonProbeBundle,
	captureAvoWorkspaceSnapshot,
	digestAvoPythonProbeApplicability,
	isAuthoritativeAvoEvaluation,
	parseAvoPythonProbePlan,
	parseAvoSupervisorMessage,
} from "../../src/core/avo/index.js";
import { createHarness, type Harness } from "./harness.js";

function recordProbeContract(
	runtime: AvoSessionRuntime,
	candidate: AvoRunState["candidates"][number],
	bindings: AvoPythonProbeBindings,
): void {
	const contractDigest = digestAvoPythonProbeApplicability(runtime.getState(), candidate);
	runtime.recordHostEvaluation({
		candidateId: candidate.candidateId,
		evaluatorId: "adversarial_probe_contract",
		status: "inconclusive",
		authority: "environment",
		evidenceRefs: [`host:probe-contract:${contractDigest}`],
		metrics: {
			meaningful: false,
			probe_required: true,
			probe_surface_supported: bindings.surfaceError === undefined,
			probe_contract_digest: contractDigest,
			candidate_payload_digest: candidate.payloadDigest,
			candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
			candidate_python_bundle_digest: candidate.pythonProbeBundleDigest ?? "missing",
			workspace_matches_candidate: true,
			python_bundle_matches_candidate: true,
		},
	});
}

function supervisorMessage(
	cycleId: string,
	expectedFirstValue: number,
	includePlan = true,
	shallow = false,
	oracle: "addition" | "subtraction" = "addition",
): string {
	const contrastInputs = shallow
		? Array.from({ length: 6 }, (_, index) => ({ args: [index, 0], expected: index }))
		: (
				[
					[0, 1],
					[1, 1],
					[0, 2],
					[2, 3],
					[-1, 2],
					[5, -3],
				] as const
			).map(([left, right], index) => ({
				args: [left, right],
				expected: index === 0 ? expectedFirstValue : oracle === "addition" ? left + right : left - right,
			}));
	return `AVO_SUPERVISION_JSON:${cycleId}\n${JSON.stringify({
		cycle_id: cycleId,
		status: "progressing",
		reason: "Concrete counterexamples cover the exposed requirements.",
		detected_patterns: [],
		recommended_actions: [],
		probe_plan: includePlan
			? {
					probe_version: 1,
					runtime: "python_call_v1",
					module_path: "subject.py",
					cases: contrastInputs.map((input, index) => ({
						case_id: `case-${index}`,
						callable: "evaluate",
						requirement_ids: [`requirement-${index % 4}`, `requirement-${(index + 1) % 4}`],
						args: input.args,
						kwargs: {},
						expect: { kind: "return", value: input.expected },
					})),
				}
			: undefined,
	})}`;
}

describe("AgentSession AVO adversarial probes", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps a matching wrong model oracle non-authoritative after immutable host execution", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def evaluate(left, right):\n    return left * right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Implement and test the Python evaluate(left, right) API as addition");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: Array.from({ length: 4 }, (_, index) => ({
				obligation_id: `requirement-${index}`,
				description: `Evaluator requirement ${index}`,
				kind: "functional",
				critical: true,
				required_evidence: ["runtime"],
			})),
		});
		writeFileSync(`${harness.tempDir}/subject.py`, "def evaluate(left, right):\n    return left - right\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "python-candidate",
				kind: "implementation",
				summary: "Incorrectly implement evaluator subtraction",
				payload: { module: "subject.py" },
				obligation_ids: Array.from({ length: 4 }, (_, index) => `requirement-${index}`),
			},
		});

		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoWorkspaceExcludedRoots(): string[];
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
				reviewPaths?: string[],
			): AvoPythonProbeBindings | undefined;
			_bindAvoPythonProbeReview(
				runtime: AvoSessionRuntime,
				cycle: AvoRunState["cycles"][number],
				candidate: AvoRunState["candidates"][number],
				message: string,
				bindings: AvoPythonProbeBindings,
				parsed: ReturnType<typeof parseAvoSupervisorMessage>,
			): Promise<ReturnType<typeof parseAvoSupervisorMessage>>;
		};
		const runtime = internals._avoRuntime;
		const candidate = runtime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const currentWorkspace = captureAvoWorkspaceSnapshot(harness.tempDir, {
			excludedRoots: internals._avoWorkspaceExcludedRoots(),
		});
		expect(candidate.workspaceDigest, JSON.stringify({ candidate, currentWorkspace })).toBe(currentWorkspace.digest);
		const bindings = internals._avoPythonProbeBindings(runtime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: ["arg:0", "arg:1"] },
			minimumCases: 6,
			maximumCases: 8,
			minimumCrossRequirementCases: 3,
			minimumDistinctRequirements: 4,
			minimumContrastedInputDimensions: 2,
		});
		expect(
			internals._avoPythonProbeBindings(
				{
					...runtime.getState(),
					obligations: runtime
						.getState()
						.obligations.filter((item) => item.kind !== "outcome")
						.slice(0, 1),
				},
				candidate,
				["subject.py"],
			),
		).toMatchObject({
			requirementIds: ["requirement-0"],
			minimumCrossRequirementCases: 0,
			minimumDistinctRequirements: 1,
			minimumContrastedInputDimensions: 2,
		});
		if (!bindings) throw new Error("Python probe bindings were not exposed");
		recordProbeContract(runtime, candidate, bindings);
		const cycle = (cycleId: string): AvoRunState["cycles"][number] => ({
			cycleId,
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds: [],
			outcome: "accepted",
			completedAt: new Date().toISOString(),
		});
		const bind = async (
			cycleId: string,
			expectedFirstValue: number,
			includePlan = true,
			shallow = false,
			oracle: "addition" | "subtraction" = "addition",
		) => {
			const message = supervisorMessage(cycleId, expectedFirstValue, includePlan, shallow, oracle);
			return internals._bindAvoPythonProbeReview(
				runtime,
				cycle(cycleId),
				candidate,
				message,
				bindings,
				parseAvoSupervisorMessage(message, cycleId),
			);
		};

		const passingReview = await bind("cycle-pass", -1, true, false, "subtraction");
		expect(passingReview, JSON.stringify(passingReview)).toMatchObject({
			status: "progressing",
			detectedPatterns: expect.arrayContaining(["host_executed_model_oracle_matched"]),
		});
		const passingProbe = runtime
			.getState()
			.evaluations.find(
				(item) => item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === "cycle-pass",
			);
		expect(passingProbe).toMatchObject(
			expect.objectContaining({
				candidateId: "python-candidate",
				evaluatorId: "adversarial_probe",
				status: "pass",
				issuedBy: "host",
				authority: "model_opinion",
				metrics: expect.objectContaining({
					meaningful: false,
					probe_execution_observed: true,
					probe_oracle_source: "retained_supervisor",
					probe_semantic_authority: false,
					probe_case_count: 6,
					probe_passed_case_count: 6,
					probe_callables: "evaluate",
					probe_required_callables: "evaluate",
					probe_plan: expect.stringContaining('"callable":"evaluate"'),
					probe_adequacy_policy: "host_signature_contrast_model_oracle_v4",
					probe_required_contrast_dimension_count: 2,
					probe_contrasted_input_dimension_count: 2,
				}),
			}),
		);
		expect(passingProbe && isAuthoritativeAvoEvaluation(passingProbe)).toBe(false);
		await bind("cycle-pass", 999, true, false, "subtraction");
		expect(
			runtime
				.getState()
				.evaluations.filter(
					(item) => item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === "cycle-pass",
				),
		).toHaveLength(1);

		await expect(bind("cycle-fail", 999, true, false, "subtraction")).resolves.toMatchObject({
			status: "intervene",
			detectedPatterns: expect.arrayContaining(["adversarial_probe_failure"]),
		});
		expect(runtime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				evaluatorId: "adversarial_probe",
				status: "revise",
				metrics: expect.objectContaining({ supervisor_cycle_id: "cycle-fail", probe_failed_case_count: 1 }),
			}),
		);
		expect(new CodingAvoAdapter().dashboardProjection(runtime.getState()).sections).toContainEqual(
			expect.objectContaining({
				id: "coding_feedback",
				items: expect.arrayContaining([
					expect.objectContaining({
						label: "Supervisor challenge probes",
						value: expect.stringMatching(
							/revise.*model oracle did not clear.*input contrasts 2\/2.*required APIs evaluate/,
						),
					}),
				]),
			}),
		);

		await expect(bind("cycle-shallow", 0, true, true)).resolves.toMatchObject({
			status: "watch",
			detectedPatterns: expect.arrayContaining(["invalid_adversarial_probe_plan"]),
		});
		expect(runtime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				evaluatorId: "adversarial_probe",
				status: "inconclusive",
				metrics: expect.objectContaining({
					supervisor_cycle_id: "cycle-shallow",
					probe_case_count: 0,
					validation_reason: expect.stringContaining("discriminating contrast pair"),
				}),
			}),
		);

		await expect(bind("cycle-invalid", 1, false)).resolves.toMatchObject({
			status: "watch",
			detectedPatterns: expect.arrayContaining(["invalid_adversarial_probe_plan"]),
		});
		expect(runtime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				evaluatorId: "adversarial_probe",
				status: "inconclusive",
				metrics: expect.objectContaining({ supervisor_cycle_id: "cycle-invalid", probe_case_count: 0 }),
			}),
		);

		await expect(bind("cycle-invalid", -1, true, false, "subtraction")).resolves.toMatchObject({
			status: "progressing",
			detectedPatterns: expect.arrayContaining(["host_executed_model_oracle_matched"]),
		});
		const repairedAttempts = runtime
			.getState()
			.evaluations.filter(
				(item) => item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === "cycle-invalid",
			);
		expect(repairedAttempts).toHaveLength(2);
		expect(repairedAttempts.map((item) => item.status)).toEqual(["inconclusive", "pass"]);
		expect(repairedAttempts.map((item) => item.metrics.probe_attempt_index)).toEqual([0, 1]);
	});

	it("queues a checkpoint behind a running supervisor bootstrap without waiting for model settlement", async () => {
		const sendAgentMessage = vi.fn(
			async (_input: AgentSessionMessageSendInput): Promise<AgentSessionMessageReceipt> => ({
				id: "agent-message-probe",
				source: AGENT_MESSAGE_SOURCE,
				target: { activeSessionId: "supervisor-active", sessionId: "supervisor-session" },
				message: "checkpoint",
				deliveryStatus: "queued" as const,
				queuedAt: new Date().toISOString(),
			}),
		);
		const controller: AgentSessionMessageController = {
			listAgents: () => ({ agents: [] }),
			sendAgentMessage,
		};
		harness = await createHarness({ persistSession: true, agentMessageController: controller });
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Implement and test a dense Python parser specification");
		const neverSettles = new Promise<void>(() => undefined);
		const run = {
			id: "supervisor-probe-child",
			sessionName: "avo-supervisor-probe",
			status: "running",
			error: undefined,
			detachedDeletion: undefined,
			publication: { promise: Promise.resolve() },
			settlement: { promise: neverSettles },
			session: { sessionId: "supervisor-session" },
		};
		const internals = harness.session as unknown as {
			_activeRlmChildRuns: Map<string, typeof run>;
			_dispatchAvoCheckpoint(
				supervisor: { rlmChildId: string; name: string },
				cycleId: string,
				probeValidationFeedback?: string,
			): Promise<{ receipt?: { deliveryStatus: string } }>;
		};
		internals._activeRlmChildRuns.set(run.id, run);
		await expect(
			internals._dispatchAvoCheckpoint({ rlmChildId: run.id, name: run.sessionName }, "cycle-probe"),
		).resolves.toMatchObject({ receipt: { deliveryStatus: "queued" } });
		expect(sendAgentMessage).toHaveBeenCalledOnce();
		await expect(
			internals._dispatchAvoCheckpoint(
				{ rlmChildId: run.id, name: run.sessionName },
				"cycle-probe",
				"probe_plan requires a discriminating contrast pair for callable evaluate input arg:1",
			),
		).resolves.toMatchObject({ receipt: { deliveryStatus: "queued" } });
		const correctionPrompt = sendAgentMessage.mock.calls.at(-1)?.[0].message;
		expect(correctionPrompt).toContain("[HOST PROBE VALIDATION]");
		expect(correctionPrompt).toContain(
			"probe_plan requires a discriminating contrast pair for callable evaluate input arg:1",
		);
		expect(correctionPrompt).toContain("only automatic schema-repair turn");
		internals._activeRlmChildRuns.delete(run.id);
	});

	it("host-selects the relevant changed module and every specification-named public API", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(
			`${harness.tempDir}/api.py`,
			"def match(pattern, text): raise NotImplementedError\ndef search(pattern, text): raise NotImplementedError\ndef findall(pattern, text): raise NotImplementedError\n",
		);
		writeFileSync(`${harness.tempDir}/easy.py`, "def convenient(): return True\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(
			"Modify api.py and run tests for its match(pattern, text), search(pattern, text), and findall(pattern, text) functions",
		);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: Array.from({ length: 4 }, (_, index) => ({
				obligation_id: `surface-${index}`,
				description: `Required API behavior ${index}`,
				kind: "functional",
				critical: true,
				required_evidence: ["runtime"],
			})),
		});
		writeFileSync(
			`${harness.tempDir}/api.py`,
			"def match(pattern, text): return None\ndef search(pattern, text): return None\ndef findall(pattern, text): return []\ndef _helper(): return True\n",
		);
		writeFileSync(`${harness.tempDir}/easy.py`, "def convenient(): return False\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "api-candidate",
				kind: "implementation",
				summary: "Implement the three public APIs",
				payload: { modules: ["api.py", "easy.py"] },
				obligation_ids: Array.from({ length: 4 }, (_, index) => `surface-${index}`),
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
			_bindAvoPythonProbeReview(
				runtime: AvoSessionRuntime,
				cycle: AvoRunState["cycles"][number],
				candidate: AvoRunState["candidates"][number],
				message: string,
				bindings: AvoPythonProbeBindings,
				parsed: ReturnType<typeof parseAvoSupervisorMessage>,
				executorAvailability?: AvoPythonProbeExecutorAvailability,
			): Promise<ReturnType<typeof parseAvoSupervisorMessage>>;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const bindings = internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["api.py"],
			requiredCallables: ["match", "search", "findall"],
		});
		if (!bindings) throw new Error("the required Python probe surface was not derived");
		recordProbeContract(internals._avoRuntime, candidate, bindings);

		const cycle = {
			cycleId: "cycle-executor-unavailable",
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds: [],
			outcome: "accepted" as const,
			completedAt: new Date().toISOString(),
		};
		const message = supervisorMessage(cycle.cycleId, 1);
		const unavailable = {
			available: false,
			mode: "unavailable" as const,
			reason: "test host intentionally has no isolated executor",
		};
		await expect(
			internals._bindAvoPythonProbeReview(
				internals._avoRuntime,
				cycle,
				candidate,
				message,
				bindings,
				parseAvoSupervisorMessage(message, cycle.cycleId),
				unavailable,
			),
		).resolves.toMatchObject({
			status: "watch",
			detectedPatterns: expect.arrayContaining(["adversarial_probe_environment_unsupported"]),
		});
		expect(internals._avoRuntime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				evaluatorId: "adversarial_probe",
				status: "inconclusive",
				metrics: expect.objectContaining({
					probe_environment_unsupported: true,
					probe_executor_available: false,
					validation_reason: "test host intentionally has no isolated executor",
				}),
			}),
		);
		await expect(
			internals._bindAvoPythonProbeReview(
				internals._avoRuntime,
				cycle,
				candidate,
				message,
				bindings,
				parseAvoSupervisorMessage(message, cycle.cycleId),
				unavailable,
			),
		).resolves.toMatchObject({ status: "watch" });
	});

	it("derives every named API from all changed Python modules without excerpt or eight-API truncation", async () => {
		harness = await createHarness({ persistSession: true });
		const apiNames = [
			"match",
			"search",
			"findall",
			"finditer",
			"fullmatch",
			"split",
			"sub",
			"subn",
			"escape",
			"compile",
		];
		const apiSource = apiNames.map((name) => `def ${name}(left, right): raise NotImplementedError`).join("\n");
		for (const name of ["a_easy.py", "b_easy.py", "c_easy.py", "d_easy.py"]) {
			writeFileSync(`${harness.tempDir}/${name}`, "def convenient(): return True\n");
		}
		writeFileSync(`${harness.tempDir}/z_api.py`, `${apiSource}\n`);
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(`Modify z_api.py and verify ${apiNames.join(", ")}`);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: Array.from({ length: 4 }, (_, index) => ({
				obligation_id: `wide-surface-${index}`,
				description: `Required API behavior ${index}`,
				kind: "functional",
				critical: true,
				required_evidence: ["runtime"],
			})),
		});
		for (const name of ["a_easy.py", "b_easy.py", "c_easy.py", "d_easy.py"]) {
			writeFileSync(`${harness.tempDir}/${name}`, "def convenient(): return False\n");
		}
		writeFileSync(
			`${harness.tempDir}/z_api.py`,
			`${apiNames.map((name) => `def ${name}(left, right): return None`).join("\n")}\n`,
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "wide-api-candidate",
				kind: "implementation",
				summary: "Implement the complete public API",
				payload: { modules: ["a_easy.py", "b_easy.py", "c_easy.py", "d_easy.py", "z_api.py"] },
				obligation_ids: Array.from({ length: 4 }, (_, index) => `wide-surface-${index}`),
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)).toMatchObject({
			modulePaths: ["z_api.py"],
			requiredCallables: apiNames,
			maximumCases: 30,
		});
	});

	it("blocks instead of silently omitting named APIs spread across changed modules", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/match_api.py`, "def match(pattern, text): raise NotImplementedError\n");
		writeFileSync(`${harness.tempDir}/search_api.py`, "def search(pattern, text): raise NotImplementedError\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(
			"Implement match(pattern, text) in match_api.py and search(pattern, text) in search_api.py",
		);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: Array.from({ length: 4 }, (_, index) => ({
				obligation_id: `multi-module-${index}`,
				description: `Cross-module API behavior ${index}`,
				kind: "functional",
				critical: true,
				required_evidence: ["runtime"],
			})),
		});
		writeFileSync(`${harness.tempDir}/match_api.py`, "def match(pattern, text): return None\n");
		writeFileSync(`${harness.tempDir}/search_api.py`, "def search(pattern, text): return None\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "multi-module-candidate",
				kind: "implementation",
				summary: "Implement both public APIs",
				payload: { modules: ["match_api.py", "search_api.py"] },
				obligation_ids: Array.from({ length: 4 }, (_, index) => `multi-module-${index}`),
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)).toMatchObject({
			modulePaths: ["match_api.py", "search_api.py"],
			requiredCallables: ["match", "search"],
			surfaceError: expect.stringContaining("span 2 Python entrypoint modules"),
		});
	});

	it("does not let model-preregistered obligation text manufacture trusted callable dimensions", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Modify subject.py source code and run its local tests without searching online");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "model-signature",
					description: "The evaluate(left, right) API must combine both inputs",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\ndef evaluate(): return 3\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "model-signature-candidate",
				kind: "implementation",
				summary: "Add the requested evaluator",
				payload: { module: "subject.py" },
				obligation_ids: ["model-signature"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const bindings = internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: [] },
			surfaceError: expect.stringContaining(
				"new callable evaluate has no task-start or explicit specification signature",
			),
		});
	});

	it("probes an unchanged task-start entrypoint through the complete changed-helper bundle", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(
			`${harness.tempDir}/api.py`,
			"from helper import combine\n\ndef evaluate(left, right):\n    return combine(left, right)\n",
		);
		writeFileSync(`${harness.tempDir}/helper.py`, "def combine(left, right):\n    return left - right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(
			"Fix the internal helper behind api.py evaluate(left, right) without changing the public entrypoint",
		);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "entrypoint-helper",
					description: "The public evaluator must return the correct combined result",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/helper.py`, "def combine(left, right):\n    return left + right\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "entrypoint-helper-candidate",
				kind: "implementation",
				summary: "Correct the internal helper implementation",
				payload: { modules: ["api.py", "helper.py"] },
				obligation_ids: ["entrypoint-helper"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(candidate.workspaceChangedPaths).toEqual(["helper.py"]);
		const bindings = internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["api.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: ["arg:0", "arg:1"] },
		});
		expect(bindings?.surfaceError).toBeUndefined();
		const bundle = captureAvoPythonProbeBundle(harness.tempDir);
		expect(bundle.files.map((file) => file.path)).toEqual(expect.arrayContaining(["api.py", "helper.py"]));
		expect(candidate.pythonProbeBundleDigest).toBe(bundle.digest);
	});

	it.each([
		{
			name: "weakening",
			source: "def evaluate(left): return left\n",
			reason: "baseline callable evaluate changed its public parameter contract",
		},
		{
			name: "removal",
			source: "def replacement(left, right): return left + right\n",
			reason: "specification-named baseline callable evaluate is missing from api.py",
		},
	])("surfaces baseline callable $name instead of weakening the probe contract", async ({ name, source, reason }) => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/api.py`, "def evaluate(left, right): return left + right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Preserve and verify api.py evaluate(left, right)");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "preserve-signature",
					description: "Preserve the evaluator API",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/api.py`, source);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: `signature-${name}`,
				kind: "implementation",
				summary: "Modify the public evaluator",
				payload: { module: "api.py" },
				obligation_ids: ["preserve-signature"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)?.surfaceError).toContain(
			reason,
		);
	});

	it.each([
		{
			name: "adds a required third argument",
			candidateId: "declared-signature-required-third",
			source: "def evaluate(left, right, mode): return left + right\n",
		},
		{
			name: "renames the keyword parameters",
			candidateId: "declared-signature-renamed-keywords",
			source: "def evaluate(x, y): return x + y\n",
		},
	])("rejects a new host-declared API when the candidate $name", async ({ candidateId, source }) => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(
			"Modify subject.py to add evaluate(left, right), then run local tests without searching online",
		);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "declared-evaluator-api",
					description: "Implement the requested evaluator API",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/subject.py`, `def existing(): return True\n${source}`);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: candidateId,
				kind: "implementation",
				summary: "Add the requested evaluator",
				payload: { module: "subject.py" },
				obligation_ids: ["declared-evaluator-api"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)).toMatchObject({
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			surfaceError: expect.stringContaining(
				"callable evaluate does not match its host-declared public parameter contract",
			),
		});
	});

	it("uses the Python AST rather than a fake signature inside a string", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/api.py`, "def evaluate(left, right): return left + right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Preserve and verify api.py evaluate(left, right)");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "ast-signature-authority",
					description: "Preserve the evaluator public signature",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(
			`${harness.tempDir}/api.py`,
			'"""Misleading documentation:\ndef evaluate(left, right):\n    return left + right\n"""\n\ndef evaluate(x, y):\n    return x + y\n',
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "ast-signature-candidate",
				kind: "implementation",
				summary: "Rename the evaluator parameters while retaining a fake documented signature",
				payload: { module: "api.py" },
				obligation_ids: ["ast-signature-authority"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)).toMatchObject({
			modulePaths: ["api.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: ["arg:0", "arg:1"] },
			surfaceError: expect.stringContaining("baseline callable evaluate changed its public parameter contract"),
		});
	});

	it("requires a discriminating contrast for every input dimension of a three-input callable", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(
			`${harness.tempDir}/api.py`,
			"def evaluate(left, right, mode):\n    return left - right if mode else left + right\n",
		);
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Preserve and verify api.py evaluate(left, right, mode)");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "three-input-contract",
					description: "Verify every evaluator input dimension",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(
			`${harness.tempDir}/api.py`,
			"def evaluate(left, right, mode):\n    return left + right if mode else left - right\n",
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "three-input-candidate",
				kind: "implementation",
				summary: "Correct the three-input evaluator",
				payload: { module: "api.py" },
				obligation_ids: ["three-input-contract"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const bindings = internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["api.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: ["arg:0", "arg:1", "arg:2"] },
			minimumContrastedInputDimensions: 3,
		});
		if (!bindings) throw new Error("the required Python probe surface was not derived");
		const cycleId = "cycle-three-input";
		const message = `AVO_SUPERVISION_JSON:${cycleId}\n${JSON.stringify({
			cycle_id: cycleId,
			status: "progressing",
			reason: "The plan contrasts only two of the three inputs.",
			detected_patterns: [],
			recommended_actions: [],
			probe_plan: {
				probe_version: 1,
				runtime: "python_call_v1",
				module_path: "api.py",
				cases: [
					{ args: [0, 0, true], expected: 0 },
					{ args: [1, 0, true], expected: 1 },
					{ args: [0, 1, true], expected: 1 },
					{ args: [2, 0, true], expected: 2 },
					{ args: [0, 2, true], expected: 2 },
					{ args: [3, 0, true], expected: 3 },
				].map((item, index) => ({
					case_id: `three-input-${index}`,
					callable: "evaluate",
					requirement_ids: ["three-input-contract"],
					args: item.args,
					kwargs: {},
					expect: { kind: "return", value: item.expected },
				})),
			},
		})}`;
		expect(() => parseAvoPythonProbePlan(message, cycleId, bindings)).toThrow(
			"probe_plan requires a discriminating contrast pair for callable evaluate input arg:2",
		);
	});

	it("fails closed when a zero-argument-only surface cannot supply six distinct host probe inputs", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Modify subject.py to add evaluate(), then verify it locally");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "zero-argument-contract",
					description: "Verify the zero-argument evaluator",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\ndef evaluate(): return 2\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "zero-argument-candidate",
				kind: "implementation",
				summary: "Add a zero-argument evaluator",
				payload: { module: "subject.py" },
				obligation_ids: ["zero-argument-contract"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
			_bindAvoPythonProbeReview(
				runtime: AvoSessionRuntime,
				cycle: AvoRunState["cycles"][number],
				candidate: AvoRunState["candidates"][number],
				message: string,
				bindings: AvoPythonProbeBindings,
				parsed: ReturnType<typeof parseAvoSupervisorMessage>,
				executorAvailability?: AvoPythonProbeExecutorAvailability,
			): Promise<ReturnType<typeof parseAvoSupervisorMessage>>;
		};
		const runtime = internals._avoRuntime;
		const candidate = runtime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const bindings = internals._avoPythonProbeBindings(runtime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: [] },
			surfaceError: expect.stringContaining(
				"zero-input public APIs cannot supply the six distinct host probe inputs",
			),
			surfaceErrorDisposition: "environment_unsupported",
		});
		if (!bindings) throw new Error("the required Python probe surface was not derived");
		recordProbeContract(runtime, candidate, bindings);
		const cycle: AvoRunState["cycles"][number] = {
			cycleId: "cycle-zero-argument",
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds: [],
			outcome: "accepted",
			completedAt: new Date().toISOString(),
		};
		const message = `AVO_SUPERVISION_JSON:${cycle.cycleId}\n${JSON.stringify({
			cycle_id: cycle.cycleId,
			status: "progressing",
			reason: "The candidate appears complete.",
			detected_patterns: [],
			recommended_actions: [],
		})}`;
		await expect(
			internals._bindAvoPythonProbeReview(
				runtime,
				cycle,
				candidate,
				message,
				bindings,
				parseAvoSupervisorMessage(message, cycle.cycleId),
				{ available: true, mode: "local_sandbox" },
			),
		).resolves.toMatchObject({
			status: "watch",
			detectedPatterns: expect.arrayContaining(["adversarial_probe_environment_unsupported"]),
		});
		expect(runtime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				evaluatorId: "adversarial_probe",
				status: "inconclusive",
				metrics: expect.objectContaining({
					probe_surface_unsupported: true,
					probe_surface_disposition: "environment_unsupported",
				}),
			}),
		);
	});

	it("accepts an annotated new API whose signature is explicitly host-declared", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def existing(): return True\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt(
			"Modify subject.py to add evaluate(left: int, right: int), then run local tests without searching online",
		);
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "annotated-evaluator-api",
					description: "Implement the host-declared annotated evaluator API",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(
			`${harness.tempDir}/subject.py`,
			"def existing(): return True\ndef evaluate(left: int, right: int): return left + right\n",
		);
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "annotated-evaluator-candidate",
				kind: "implementation",
				summary: "Add the annotated evaluator",
				payload: { module: "subject.py" },
				obligation_ids: ["annotated-evaluator-api"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_avoPythonProbeBindings(
				state: AvoRunState,
				candidate: AvoRunState["candidates"][number],
			): AvoPythonProbeBindings | undefined;
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const bindings = internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate);
		expect(bindings).toMatchObject({
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			callableInputDimensions: { evaluate: ["arg:0", "arg:1"] },
			minimumContrastedInputDimensions: 2,
		});
		expect(bindings?.surfaceError).toBeUndefined();
		expect(bindings?.surfaceErrorDisposition).toBeUndefined();
	});

	it.each(["deletion", "symbolic-link"] as const)(
		"classifies candidate Python module $case as candidate-invalid surface evidence",
		async (surfaceMutation) => {
			harness = await createHarness({ persistSession: true });
			const apiPath = `${harness.tempDir}/api.py`;
			writeFileSync(apiPath, "def evaluate(left, right): return left - right\n");
			harness.setResponses([fauxAssistantMessage("working")]);
			await harness.session.prompt("Preserve and verify api.py evaluate(left, right)");
			await harness.session.handleAvoHostRequest("avo.obligations.register", {
				obligations: [
					{
						obligation_id: "candidate-surface",
						description: "Preserve the evaluator surface",
						kind: "functional",
						critical: true,
						required_evidence: ["runtime"],
					},
				],
			});
			rmSync(apiPath);
			if (surfaceMutation === "symbolic-link") {
				writeFileSync(
					`${harness.tempDir}/candidate-target.txt`,
					"def evaluate(left, right): return left + right\n",
				);
				symlinkSync("candidate-target.txt", apiPath);
			}
			await harness.session.handleAvoHostRequest("avo.candidate.add", {
				candidate: {
					candidate_id: `candidate-surface-${surfaceMutation}`,
					kind: "implementation",
					summary: "Mutate the required evaluator module",
					payload: { module: "api.py" },
					obligation_ids: ["candidate-surface"],
				},
			});
			const internals = harness.session as unknown as {
				_avoRuntime: AvoSessionRuntime;
				_avoPythonProbeBindings(
					state: AvoRunState,
					candidate: AvoRunState["candidates"][number],
				): AvoPythonProbeBindings | undefined;
				_bindAvoPythonProbeReview(
					runtime: AvoSessionRuntime,
					cycle: AvoRunState["cycles"][number],
					candidate: AvoRunState["candidates"][number],
					message: string,
					bindings: AvoPythonProbeBindings,
					parsed: ReturnType<typeof parseAvoSupervisorMessage>,
					executorAvailability?: AvoPythonProbeExecutorAvailability,
				): Promise<ReturnType<typeof parseAvoSupervisorMessage>>;
			};
			const runtime = internals._avoRuntime;
			const candidate = runtime.getState().candidates.at(-1);
			if (!candidate) throw new Error("candidate was not recorded");
			const bindings = internals._avoPythonProbeBindings(runtime.getState(), candidate);
			expect(bindings).toMatchObject({
				modulePaths: ["api.py"],
				surfaceError: expect.stringContaining(
					"required Python module is missing from the candidate bundle: api.py",
				),
				surfaceErrorDisposition: "candidate_invalid",
			});
			if (!bindings) throw new Error("the required Python probe surface was not derived");
			recordProbeContract(runtime, candidate, bindings);
			const cycle: AvoRunState["cycles"][number] = {
				cycleId: `cycle-candidate-surface-${surfaceMutation}`,
				candidateId: candidate.candidateId,
				candidateKind: candidate.kind,
				evaluationIds: [],
				outcome: "accepted",
				completedAt: new Date().toISOString(),
			};
			const message = `AVO_SUPERVISION_JSON:${cycle.cycleId}\n${JSON.stringify({
				cycle_id: cycle.cycleId,
				status: "progressing",
				reason: "The candidate appears complete.",
				detected_patterns: [],
				recommended_actions: [],
			})}`;
			await expect(
				internals._bindAvoPythonProbeReview(
					runtime,
					cycle,
					candidate,
					message,
					bindings,
					parseAvoSupervisorMessage(message, cycle.cycleId),
					{ available: true, mode: "local_sandbox" },
				),
			).resolves.toMatchObject({
				status: "intervene",
				detectedPatterns: expect.arrayContaining(["adversarial_probe_surface_invalid"]),
			});
			expect(runtime.getState().evaluations).toContainEqual(
				expect.objectContaining({
					evaluatorId: "adversarial_probe",
					status: "revise",
					metrics: expect.objectContaining({ probe_surface_disposition: "candidate_invalid" }),
				}),
			);
		},
	);

	it("never turns a transient non-candidate source tree into a no-probe applicability contract", async () => {
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/api.py`, "def evaluate(left, right): return left - right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix and verify api.py evaluate(left, right)");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: [
				{
					obligation_id: "applicability-integrity",
					description: "Verify the evaluator API",
					kind: "functional",
					critical: true,
					required_evidence: ["runtime"],
				},
			],
		});
		writeFileSync(`${harness.tempDir}/api.py`, "def evaluate(left, right): return left + right\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "applicability-candidate",
				kind: "implementation",
				summary: "Correct the evaluator",
				payload: { module: "api.py" },
				obligation_ids: ["applicability-integrity"],
			},
		});
		const internals = harness.session as unknown as {
			_avoRuntime: AvoSessionRuntime;
			_recordAvoPythonProbeApplicability(): void;
		};
		const runtime = internals._avoRuntime;
		const candidate = runtime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		const originalGetState = runtime.getState.bind(runtime);
		const acceptedCycle: AvoRunState["cycles"][number] = {
			cycleId: "cycle-applicability-integrity",
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds: [],
			outcome: "accepted",
			completedAt: new Date().toISOString(),
		};
		const getStateSpy = vi
			.spyOn(runtime, "getState")
			.mockImplementation(() => ({ ...originalGetState(), cycles: [acceptedCycle] }));
		writeFileSync(`${harness.tempDir}/api.py`, "def unrelated(): return True\n");
		internals._recordAvoPythonProbeApplicability();
		writeFileSync(`${harness.tempDir}/api.py`, "def evaluate(left, right): return left + right\n");
		internals._recordAvoPythonProbeApplicability();
		getStateSpy.mockRestore();

		const contracts = originalGetState().evaluations.filter(
			(item) => item.candidateId === candidate.candidateId && item.evaluatorId === "adversarial_probe_contract",
		);
		expect(contracts).toHaveLength(2);
		expect(contracts[0]?.metrics).toMatchObject({
			probe_required: true,
			probe_surface_supported: false,
			workspace_matches_candidate: false,
			python_bundle_matches_candidate: false,
		});
		expect(contracts[1]?.metrics).toMatchObject({
			probe_required: true,
			probe_surface_supported: true,
			workspace_matches_candidate: true,
			python_bundle_matches_candidate: true,
		});
		expect(contracts.some((item) => item.metrics.probe_required === false)).toBe(false);
	});
});
