import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AVO_INTERNAL_ABLATIONS_ENV,
	AVO_PYTHON_PROBE_BROKER_SOCKET_ENV,
	AVO_PYTHON_PROBE_BROKER_TOKEN_ENV,
	AVO_PYTHON_PROBE_RESULT_MARKER,
	buildAvoSupervisorMessage,
	buildAvoSupervisorPrompt,
	canExecuteAvoPythonProbe,
	executeAvoPythonProbeSandbox,
	findAvoSupervisorResponseText,
	parseAvoPythonProbePlan,
	parseAvoPythonProbeReport,
	parseAvoSupervisorMessage,
	requiresAvoAdversarialReview,
	shouldActivateAvoSupervisor,
	startAvoPythonProbeBroker,
} from "../src/core/avo/index.js";
import type { AvoCheckpoint, AvoRunState } from "../src/core/avo/types.js";
import { summarizePrimeIntegrityTrace } from "../src/evals/prime-integrity/runner.js";

function state(options: { horizon?: "direct" | "iterative" | "long"; obligations?: number } = {}): AvoRunState {
	const horizon = options.horizon ?? "iterative";
	const cycleId = "cycle-accepted";
	return {
		routing: { environment: "coding", horizon, source: "host_auto", reasons: [], decidedAt: "now" },
		verificationPolicy: "required",
		objective: "Implement every parser requirement",
		cycles: [
			{
				cycleId,
				candidateId: "candidate",
				candidateKind: "implementation",
				evaluationIds: [],
				outcome: "accepted",
				completedAt: "now",
			},
		],
		obligations: Array.from({ length: options.obligations ?? 8 }, (_, index) => ({
			obligationId: `requirement-${index}`,
			critical: true,
		})),
	} as unknown as AvoRunState;
}

describe.sequential("AVO adversarial acceptance supervision", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	test("reviews accepted requirement-dense iterative coding candidates", () => {
		const current = state();
		expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(true);
		expect(
			shouldActivateAvoSupervisor(current, {
				cycleId: "cycle-accepted",
				interventionNeeded: false,
			} as AvoCheckpoint),
		).toBe(true);
		const prompt = buildAvoSupervisorPrompt(current, "cycle-accepted", {});
		expect(prompt).toContain("acceptance reviewer");
		expect(prompt).toContain("Select at most three highest-risk specification boundaries");
		expect(prompt).toContain("may veto; it cannot create host evidence");
		expect(prompt).toContain("No tools are available");
		expect(prompt).not.toContain(JSON.stringify({}));
	});

	test("keeps direct and small iterative tasks lightweight", () => {
		expect(requiresAvoAdversarialReview(state({ horizon: "direct" }), "cycle-accepted")).toBe(false);
		expect(requiresAvoAdversarialReview(state({ obligations: 7 }), "cycle-accepted")).toBe(false);
	});

	test("keeps a dense adversarial review message below the retained-message limit", () => {
		const current = state({ horizon: "long", obligations: 40 });
		current.runId = "run-dense";
		current.objective = "Implement the complete dense specification. ".repeat(200);
		const context = {
			accepted_candidate: {
				candidate_id: "candidate",
				summary: "implemented a complete parser".repeat(20),
				changed_paths: ["regex_engine.py"],
			},
			critical_requirement_excerpts: Array.from({ length: 40 }, (_, index) => ({
				requirement_id: `requirement-${index}`,
				description: "handle a concrete grammar boundary and output shape",
			})),
			review_files: [
				{ path: "regex_engine.py", excerpt: "x".repeat(3_000), truncated: true },
				{ path: "test_specbench_contract.py", excerpt: "y".repeat(1_000), truncated: true },
			],
		};
		const message = buildAvoSupervisorMessage(current, "cycle-accepted", context);
		expect(message.length).toBeLessThanOrEqual(16_384);
		expect(message).toContain('"packet_version":2');
		expect(message).toContain('"review_files"');
	});

	test("supports a hidden benchmark ablation without disclosing it", () => {
		vi.stubEnv(AVO_INTERNAL_ABLATIONS_ENV, "adversarial_supervision");
		const current = state({ horizon: "long" });
		expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(false);
		expect(buildAvoSupervisorPrompt(current, "cycle-accepted", {})).not.toContain("acceptance reviewer");
	});

	test("exposes supervisor decisions in benchmark traces", () => {
		const root = mkdtempSync(join(tmpdir(), "avo-supervisor-trace-"));
		temporaryRoots.push(root);
		const stateDir = join(root, "run", "avo");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "state.json"),
			JSON.stringify({
				supervision: [{ status: "progressing" }, { status: "watch" }, { status: "intervene" }],
			}),
		);
		expect(summarizePrimeIntegrityTrace([], root)).toMatchObject({
			supervisorReviews: 3,
			supervisorProgressingReviews: 1,
			supervisorWatchReviews: 1,
			supervisorInterventions: 1,
		});
	});

	test("recovers every tool-free verdict from a retained child transcript", () => {
		const messages = [
			'AVO_SUPERVISION_JSON:cycle-one\n{"cycle_id":"cycle-one","status":"watch"}',
			'AVO_SUPERVISION_JSON:cycle-two\n{"cycle_id":"cycle-two","status":"progressing"}',
		];
		expect(findAvoSupervisorResponseText(messages, "cycle-one")).toContain('"status":"watch"');
		expect(findAvoSupervisorResponseText(messages, "cycle-two")).toContain('"status":"progressing"');
		expect(findAvoSupervisorResponseText(messages, "cycle-missing")).toBeUndefined();
	});

	test("downgrades a generic adversarial rubber stamp and accepts a bound counterexample analysis", () => {
		const bindings = { sourcePaths: ["parser.py"], requirementIds: ["requirement-edge"] };
		const message = (recommendedActions: string[]) =>
			`AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
				cycle_id: "cycle",
				status: "progressing",
				reason: "all requirements are verified",
				detected_patterns: ["looks_good"],
				recommended_actions: recommendedActions,
			})}`;
		expect(parseAvoSupervisorMessage(message(["Proceed with the implementation."]), "cycle", bindings)).toMatchObject(
			{
				status: "watch",
				detectedPatterns: ["looks_good", "uncalibrated_adversarial_review"],
			},
		);
		expect(
			parseAvoSupervisorMessage(
				message([
					"source=parser.py; requirement=requirement-edge; counterexample=empty nested group; expected=returns an empty capture; analysis=the epsilon transition preserves the capture slot",
				]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "progressing" });
	});

	test("requires dense progressing reviews to analyze distinct and interacting requirements", () => {
		const bindings = {
			sourcePaths: ["parser.py"],
			requirementIds: ["requirement-a", "requirement-b", "requirement-c", "requirement-d"],
			minimumAnalyses: 3,
			requireCrossRequirement: true,
		};
		const response = (actions: string[]) =>
			`AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
				cycle_id: "cycle",
				status: "progressing",
				reason: "three boundaries were inspected",
				detected_patterns: [],
				recommended_actions: actions,
			})}`;
		const action = (requirement: string, related = "") =>
			`source=parser.py; requirement=${requirement}; related_requirement=${related}; counterexample=compound empty input; expected=stable structured result; analysis=the shown branch preserves the required state`;
		expect(
			parseAvoSupervisorMessage(
				response([action("requirement-a"), action("requirement-b"), action("requirement-c")]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "watch" });
		expect(
			parseAvoSupervisorMessage(
				response([action("requirement-a", "requirement-d"), action("requirement-b"), action("requirement-c")]),
				"cycle",
				bindings,
			),
		).toMatchObject({ status: "progressing" });
	});

	test("accepts only bounded host-referenced Python call probe plans", () => {
		const contrastInputs = [
			{ args: [0, 1], expected: 1 },
			{ args: [1, 1], expected: 2 },
			{ args: [0, 2], expected: 2 },
			{ args: [2, 3], expected: 5 },
			{ args: [-1, 2], expected: 1 },
			{ args: [5, -3], expected: 2 },
		];
		const cases = contrastInputs.map((input, index) => ({
			case_id: `case-${index}`,
			callable: "evaluate",
			requirement_ids: [`requirement-${index % 4}`, `requirement-${(index + 1) % 4}`],
			args: input.args,
			kwargs: {},
			expect: { kind: "return", value: input.expected },
		}));
		const response = (probePlan: Record<string, unknown>) =>
			`AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
				cycle_id: "cycle",
				status: "progressing",
				reason: "the probes cover the risky boundaries",
				detected_patterns: [],
				recommended_actions: [],
				probe_plan: probePlan,
			})}`;
		const bindings = {
			modulePaths: ["subject.py"],
			requiredCallables: ["evaluate"],
			requirementIds: Array.from({ length: 6 }, (_, index) => `requirement-${index}`),
			minimumCases: 6,
			maximumCases: 8,
			minimumCrossRequirementCases: 3,
			minimumDistinctRequirements: 4,
			minimumContrastedInputDimensions: 2,
		};
		const validPlan = { probe_version: 1, runtime: "python_call_v1", module_path: "subject.py", cases };
		expect(parseAvoPythonProbePlan(response(validPlan), "cycle", bindings)).toMatchObject({
			probeVersion: 1,
			runtime: "python_call_v1",
			modulePath: "subject.py",
			cases: expect.arrayContaining([expect.objectContaining({ caseId: "case-0", callable: "evaluate" })]),
		});
		const singleRequirementCases = cases.map((item) => ({ ...item, requirement_ids: ["requirement-0"] }));
		expect(
			parseAvoPythonProbePlan(response({ ...validPlan, cases: singleRequirementCases }), "cycle", {
				...bindings,
				requirementIds: ["requirement-0"],
				minimumCrossRequirementCases: 0,
				minimumDistinctRequirements: 1,
			}),
		).toMatchObject({ cases: expect.arrayContaining([expect.objectContaining({ callable: "evaluate" })]) });
		const shallowCases = cases.map((item, index) => ({
			...item,
			args: [index, 0],
			expect: { kind: "return", value: index },
		}));
		expect(() => parseAvoPythonProbePlan(response({ ...validPlan, cases: shallowCases }), "cycle", bindings)).toThrow(
			/discriminating contrast pair for callable evaluate input arg:1/,
		);
		expect(() => parseAvoPythonProbePlan(response({ ...validPlan, runtime: "shell" }), "cycle", bindings)).toThrow(
			/runtime must be python_call_v1/,
		);
		expect(() =>
			parseAvoPythonProbePlan(response({ ...validPlan, module_path: "other.py" }), "cycle", bindings),
		).toThrow(/host-exposed Python source file/);
		expect(() =>
			parseAvoPythonProbePlan(
				response({ ...validPlan, cases: [{ ...cases[0], callable: "_private" }, ...cases.slice(1)] }),
				"cycle",
				bindings,
			),
		).toThrow(/callable has an invalid format/);
		expect(() =>
			parseAvoPythonProbePlan(response({ ...validPlan, cases: cases.slice(0, 5) }), "cycle", bindings),
		).toThrow(/must contain 6-8 cases/);
		expect(() =>
			parseAvoPythonProbePlan(response(validPlan), "cycle", {
				...bindings,
				requiredCallables: ["evaluate", "render"],
			}),
		).toThrow(/must exercise host-required callable render/);
		const renderCases = cases.map((item, index) =>
			index === 0 ? { ...item, callable: "render", requirement_ids: ["requirement-0"] } : item,
		);
		expect(() =>
			parseAvoPythonProbePlan(response({ ...validPlan, cases: renderCases }), "cycle", {
				...bindings,
				requiredCallables: ["evaluate", "render"],
			}),
		).toThrow(/cross-requirement case for callable render/);
	});

	test("executes Python probes in a read-only sandbox and reports actual failures", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			[
				"import os",
				"",
				"def evaluate(left, right):",
				"    return left + right",
				"",
				"def explode():",
				"    raise ValueError('bad')",
				"",
				"def mutate():",
				"    open('forbidden-write.txt', 'w').write('no')",
				"",
				"def can_see_agent_home():",
				"    return os.path.exists(os.path.expanduser('~/.prime'))",
			].join("\n"),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: [
				...Array.from({ length: 5 }, (_, index) => ({
					caseId: `sum-${index}`,
					callable: "evaluate",
					requirementIds: ["requirement-a", "requirement-b"],
					args: [index, 1],
					kwargs: {},
					expect: { kind: "return" as const, value: index + 1 },
				})),
				{
					caseId: "raises",
					callable: "explode",
					requirementIds: ["requirement-c", "requirement-d"],
					args: [],
					kwargs: {},
					expect: { kind: "raises" as const, error: "ValueError" },
				},
				{
					caseId: "read-only-workspace",
					callable: "mutate",
					requirementIds: ["requirement-a", "requirement-c"],
					args: [],
					kwargs: {},
					expect: { kind: "raises" as const, error: "OSError" },
				},
				{
					caseId: "masked-home",
					callable: "can_see_agent_home",
					requirementIds: ["requirement-b", "requirement-d"],
					args: [],
					kwargs: {},
					expect: { kind: "return" as const, value: false },
				},
			],
		};
		const passing = await executeAvoPythonProbeSandbox(root, plan);
		expect(passing, JSON.stringify(passing)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: { passed: true },
		});
		expect(passing.stderr).toBe("");
		expect(() => lstatSync(join(root, "forbidden-write.txt"))).toThrow();

		const broker = await startAvoPythonProbeBroker(root);
		try {
			const brokerResponse = await new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
				const clientSource = [
					'const net=require("node:net")',
					"const [socketPath,token,planText]=process.argv.slice(1)",
					"let response=''",
					"const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify({protocolVersion:1,token,plan:JSON.parse(planText)})+'\\n'))",
					"socket.setEncoding('utf8')",
					"socket.on('data',chunk=>{response+=chunk;if(response.includes('\\n')){process.stdout.write(response);socket.end()}})",
					"socket.on('error',error=>{process.stderr.write(error.message);process.exitCode=1})",
				].join(";");
				const child = spawn(
					"/usr/bin/bwrap",
					[
						"--ro-bind",
						"/",
						"/",
						"--dev-bind",
						"/dev",
						"/dev",
						"--proc",
						"/proc",
						"--tmpfs",
						"/tmp",
						"--bind",
						root,
						root,
						"--unshare-pid",
						"--die-with-parent",
						"--chdir",
						root,
						"--",
						process.execPath,
						"-e",
						clientSource,
						broker.socketPath,
						broker.token,
						JSON.stringify(plan),
					],
					{ stdio: ["ignore", "pipe", "pipe"] },
				);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
				child.once("error", rejectResponse);
				child.once("close", (code) => {
					if (code !== 0) rejectResponse(new Error(`outer sandbox broker client failed: ${stderr}`));
					else resolveResponse(JSON.parse(stdout.trim()) as Record<string, unknown>);
				});
			});
			expect(brokerResponse).toMatchObject({
				protocolVersion: 1,
				execution: { exitCode: 0, report: { passed: true } },
			});
			vi.stubEnv(AVO_PYTHON_PROBE_BROKER_SOCKET_ENV, broker.socketPath);
			vi.stubEnv(AVO_PYTHON_PROBE_BROKER_TOKEN_ENV, broker.token);
			const brokered = await executeAvoPythonProbeSandbox(root, plan);
			expect(brokered, JSON.stringify(brokered)).toMatchObject({
				exitCode: 0,
				report: { passed: true },
			});
		} finally {
			vi.unstubAllEnvs();
			await broker.close();
		}

		const failing = await executeAvoPythonProbeSandbox(root, {
			...plan,
			cases: plan.cases.map((item, index) =>
				index === 0 ? { ...item, expect: { kind: "return" as const, value: 999 } } : item,
			),
		});
		expect(failing).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(failing.report?.results[0]).toMatchObject({ caseId: "sum-0", status: "fail", actual: 1, expected: 999 });
	});

	test("rejects fabricated or internally inconsistent probe reports", () => {
		const results = [{ case_id: "case-one", status: "fail", actual: 1, expected: 2 }];
		expect(() => parseAvoPythonProbeReport("unrelated output", ["case-one"])).toThrow(/no host-runner result/);
		expect(() =>
			parseAvoPythonProbeReport(
				`${AVO_PYTHON_PROBE_RESULT_MARKER}${JSON.stringify({ report_version: 1, passed: true, results })}`,
				["case-one"],
			),
		).toThrow(/aggregate status is inconsistent/);
	});
});
