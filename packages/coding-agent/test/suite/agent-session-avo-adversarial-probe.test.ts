import { writeFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessageController,
	type AgentSessionMessageReceipt,
} from "../../src/core/agent-messages.js";
import {
	type AvoPythonProbeBindings,
	type AvoRunState,
	type AvoSessionRuntime,
	CodingAvoAdapter,
	canExecuteAvoPythonProbe,
	captureAvoWorkspaceSnapshot,
	parseAvoSupervisorMessage,
} from "../../src/core/avo/index.js";
import { createHarness, type Harness } from "./harness.js";

function supervisorMessage(cycleId: string, expectedFirstValue: number, includePlan = true, shallow = false): string {
	const contrastInputs = shallow
		? Array.from({ length: 6 }, (_, index) => ({ args: [index, 0], expected: index }))
		: [
				{ args: [0, 1], expected: expectedFirstValue },
				{ args: [1, 1], expected: 2 },
				{ args: [0, 2], expected: 2 },
				{ args: [2, 3], expected: 5 },
				{ args: [-1, 2], expected: 1 },
				{ args: [5, -3], expected: 2 },
			];
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

	it("binds progressing supervision to immutable host-executed probe evidence", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		harness = await createHarness({ persistSession: true });
		writeFileSync(`${harness.tempDir}/subject.py`, "def evaluate(left, right):\n    return left - right\n");
		harness.setResponses([fauxAssistantMessage("working")]);
		await harness.session.prompt("Fix and test every requirement of the Python evaluate(left, right) API");
		await harness.session.handleAvoHostRequest("avo.obligations.register", {
			obligations: Array.from({ length: 4 }, (_, index) => ({
				obligation_id: `requirement-${index}`,
				description: `Evaluator requirement ${index}`,
				kind: "functional",
				critical: true,
				required_evidence: ["runtime"],
			})),
		});
		writeFileSync(`${harness.tempDir}/subject.py`, "def evaluate(left, right):\n    return left + right\n");
		await harness.session.handleAvoHostRequest("avo.candidate.add", {
			candidate: {
				candidate_id: "python-candidate",
				kind: "implementation",
				summary: "Implement evaluator addition",
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
		const cycle = (cycleId: string): AvoRunState["cycles"][number] => ({
			cycleId,
			candidateId: candidate.candidateId,
			candidateKind: candidate.kind,
			evaluationIds: [],
			outcome: "accepted",
			completedAt: new Date().toISOString(),
		});
		const bind = async (cycleId: string, expectedFirstValue: number, includePlan = true, shallow = false) => {
			const message = supervisorMessage(cycleId, expectedFirstValue, includePlan, shallow);
			return internals._bindAvoPythonProbeReview(
				runtime,
				cycle(cycleId),
				candidate,
				message,
				bindings,
				parseAvoSupervisorMessage(message, cycleId),
			);
		};

		const passingReview = await bind("cycle-pass", 1);
		expect(passingReview, JSON.stringify(passingReview)).toMatchObject({
			status: "progressing",
			detectedPatterns: expect.arrayContaining(["host_executed_adversarial_probes_passed"]),
		});
		expect(runtime.getState().evaluations).toContainEqual(
			expect.objectContaining({
				candidateId: "python-candidate",
				evaluatorId: "adversarial_probe",
				status: "pass",
				issuedBy: "host",
				metrics: expect.objectContaining({
					probe_case_count: 6,
					probe_passed_case_count: 6,
					probe_callables: "evaluate",
					probe_required_callables: "evaluate",
					probe_plan: expect.stringContaining('"callable":"evaluate"'),
					probe_adequacy_policy: "required_callable_contrast_v1",
					probe_required_contrast_dimension_count: 2,
					probe_contrasted_input_dimension_count: 2,
				}),
			}),
		);
		await bind("cycle-pass", 999);
		expect(
			runtime
				.getState()
				.evaluations.filter(
					(item) => item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === "cycle-pass",
				),
		).toHaveLength(1);

		await expect(bind("cycle-fail", 999)).resolves.toMatchObject({
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
						label: "Latest adversarial probes",
						value: expect.stringMatching(/revise.*input contrasts 2\/2.*required APIs evaluate/),
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
	});

	it("queues a checkpoint behind a running supervisor bootstrap without waiting for model settlement", async () => {
		const sendAgentMessage = vi.fn(
			async (): Promise<AgentSessionMessageReceipt> => ({
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
			): Promise<{ receipt?: { deliveryStatus: string } }>;
		};
		internals._activeRlmChildRuns.set(run.id, run);
		await expect(
			internals._dispatchAvoCheckpoint({ rlmChildId: run.id, name: run.sessionName }, "cycle-probe"),
		).resolves.toMatchObject({ receipt: { deliveryStatus: "queued" } });
		expect(sendAgentMessage).toHaveBeenCalledOnce();
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
		};
		const candidate = internals._avoRuntime.getState().candidates.at(-1);
		if (!candidate) throw new Error("candidate was not recorded");
		expect(internals._avoPythonProbeBindings(internals._avoRuntime.getState(), candidate)).toMatchObject({
			modulePaths: ["api.py"],
			requiredCallables: ["match", "search", "findall"],
		});
	});
});
