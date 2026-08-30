import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	AVO_INTERNAL_ABLATIONS_ENV,
	AVO_PYTHON_PROBE_BROKER_SOCKET_ENV,
	AVO_PYTHON_PROBE_BROKER_TOKEN_ENV,
	AVO_PYTHON_PROBE_MAX_CASES,
	AVO_PYTHON_PROBE_RESULT_MARKER,
	buildAvoSupervisorMessage,
	buildAvoSupervisorPrompt,
	canExecuteAvoPythonProbe,
	createAvoPythonProbeBundle,
	executeAvoPythonProbeSandbox,
	findAvoSupervisorResponseText,
	inspectAvoPythonPublicCallables,
	parseAvoPythonProbePlan,
	parseAvoPythonProbeReport,
	parseAvoSupervisorMessage,
	requiresAvoAdversarialReview,
	requiresAvoTrajectoryVerification,
	shouldActivateAvoSupervisor,
	startAvoPythonProbeBroker,
} from "../src/core/avo/index.js";
import type { AvoCheckpoint, AvoRunState } from "../src/core/avo/types.js";
import { summarizePrimeIntegrityTrace } from "../src/evals/prime-integrity/runner.js";

function state(
	options: { horizon?: "direct" | "iterative" | "long"; obligations?: number; python?: boolean } = {},
): AvoRunState {
	const horizon = options.horizon ?? "iterative";
	const cycleId = "cycle-accepted";
	return {
		routing: { environment: "coding", horizon, source: "host_auto", reasons: [], decidedAt: "now" },
		verificationPolicy: "required",
		objective: "Implement every parser requirement",
		candidates: [
			{
				candidateId: "candidate",
				workspaceChangedPaths: [options.python ? "parser.py" : "parser.ts"],
			},
		],
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
		checkpoints: [],
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

	test("requires retained adversarial review for every accepted required Python mutation", () => {
		const current = state({ horizon: "direct", obligations: 1, python: true });
		expect(requiresAvoTrajectoryVerification(current, "cycle-accepted")).toBe(true);
		expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(true);
		expect(shouldActivateAvoSupervisor(current)).toBe(true);
	});

	test.each([
		{
			environment: "general",
			horizon: "long",
			policy: "best_effort",
			intervention: false,
			trajectory: true,
			adversarial: false,
		},
		{
			environment: "research",
			horizon: "long",
			policy: "required",
			intervention: false,
			trajectory: true,
			adversarial: false,
		},
		{
			environment: "general",
			horizon: "iterative",
			policy: "required",
			intervention: true,
			trajectory: true,
			adversarial: false,
		},
		{
			environment: "coding",
			horizon: "iterative",
			policy: "required",
			intervention: false,
			trajectory: true,
			adversarial: true,
		},
		{
			environment: "coding",
			horizon: "direct",
			policy: "required",
			intervention: false,
			trajectory: false,
			adversarial: false,
		},
	] as const)(
		"separates generic trajectory review from coding probes for $environment/$horizon",
		({ environment, horizon, policy, intervention, trajectory, adversarial }) => {
			const current = state({ horizon });
			current.routing.environment = environment;
			current.verificationPolicy = policy;
			current.checkpoints = intervention
				? [{ cycleId: "cycle-accepted", interventionNeeded: true } as AvoCheckpoint]
				: [];
			expect(requiresAvoTrajectoryVerification(current, "cycle-accepted")).toBe(trajectory);
			expect(requiresAvoAdversarialReview(current, "cycle-accepted")).toBe(adversarial);
		},
	);

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
			callableInputDimensions: { evaluate: ["arg:0", "arg:1"] },
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
		const missingArgumentCases = cases.map((item, index) => ({
			...item,
			args: [],
			kwargs: { probe_nonce: index },
			expect: { kind: "raises", error: "TypeError", message: "missing required arguments" },
		}));
		expect(() =>
			parseAvoPythonProbePlan(response({ ...validPlan, cases: missingArgumentCases }), "cycle", bindings),
		).toThrow(/discriminating contrast pair for callable evaluate input arg:0/);
		const fillerCases = cases.map((item, index) => (index >= 3 ? { ...item, callable: "math.sqrt" } : item));
		expect(() => parseAvoPythonProbePlan(response({ ...validPlan, cases: fillerCases }), "cycle", bindings)).toThrow(
			/callable must be a host-required callable/,
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

	test("binds defaults, annotations, async kind, and uncertain public re-exports into AST authority", () => {
		const strict = inspectAvoPythonPublicCallables(
			'def match(value: str, mode="strict") -> bool:\n    return True\n',
		);
		const lazy = inspectAvoPythonPublicCallables('def match(value: str, mode="lazy") -> bool:\n    return True\n');
		const annotated = inspectAvoPythonPublicCallables(
			'def match(value: object, mode="strict") -> bool:\n    return True\n',
		);
		const asynchronous = inspectAvoPythonPublicCallables(
			'async def match(value: str, mode="strict") -> bool:\n    return True\n',
		);
		const namedStrict = inspectAvoPythonPublicCallables(
			'DEFAULT = "strict"\ndef match(value, mode=DEFAULT):\n    return True\n',
		);
		const namedLazy = inspectAvoPythonPublicCallables(
			'DEFAULT = "lazy"\ndef match(value, mode=DEFAULT):\n    return True\n',
		);
		const reassignedStrict = inspectAvoPythonPublicCallables(
			'DEFAULT = "strict"\ndef match(value, mode=DEFAULT):\n    return True\nDEFAULT = "tail"\n',
		);
		const reassignedLazy = inspectAvoPythonPublicCallables(
			'DEFAULT = "lazy"\ndef match(value, mode=DEFAULT):\n    return True\nDEFAULT = "tail"\n',
		);
		const computedStrict = inspectAvoPythonPublicCallables(
			'def make_default():\n    return "strict"\nDEFAULT = make_default()\ndef match(value, mode=DEFAULT):\n    return True\n',
		);
		const computedLazy = inspectAvoPythonPublicCallables(
			'def make_default():\n    return "lazy"\nDEFAULT = make_default()\ndef match(value, mode=DEFAULT):\n    return True\n',
		);
		expect(strict.callables[0]?.signatureDigest).not.toBe(lazy.callables[0]?.signatureDigest);
		expect(strict.callables[0]?.signatureDigest).not.toBe(annotated.callables[0]?.signatureDigest);
		expect(strict.callables[0]?.signatureDigest).not.toBe(asynchronous.callables[0]?.signatureDigest);
		expect(namedStrict.callables[0]?.signatureDigest).not.toBe(namedLazy.callables[0]?.signatureDigest);
		expect(reassignedStrict.callables[0]?.signatureDigest).not.toBe(reassignedLazy.callables[0]?.signatureDigest);
		expect(computedStrict.callables.find((item) => item.name === "match")?.signatureDigest).not.toBe(
			computedLazy.callables.find((item) => item.name === "match")?.signatureDigest,
		);
		expect(
			inspectAvoPythonPublicCallables(
				"from config import DEFAULT\ndef match(value, mode=DEFAULT):\n    return True\n",
			),
		).toMatchObject({
			callables: [],
			errors: expect.arrayContaining([
				expect.objectContaining({ name: "match", reason: expect.stringContaining("unresolved") }),
			]),
		});
		expect(
			inspectAvoPythonPublicCallables("def match(value):\n    return value\n\ndef unrelated():\n    match = 0\n"),
		).toMatchObject({ callables: expect.arrayContaining([expect.objectContaining({ name: "match" })]) });
		expect(inspectAvoPythonPublicCallables("from impl import match\n")).toMatchObject({
			callables: [],
			errors: [expect.objectContaining({ name: "match" })],
		});
	});

	test("rejects duplicate Python probe inputs despite distinct case IDs and expectations", () => {
		const cases = Array.from({ length: 6 }, (_, index) => ({
			case_id: `duplicate-input-${index}`,
			callable: "evaluate",
			requirement_ids: [`requirement-${index}`],
			args: [1, 2],
			kwargs: { scale: 1 },
			expect: { kind: "return", value: index },
		}));
		const message = `AVO_SUPERVISION_JSON:cycle\n${JSON.stringify({
			cycle_id: "cycle",
			status: "progressing",
			reason: "six differently labelled checks cover the implementation",
			detected_patterns: [],
			recommended_actions: [],
			probe_plan: {
				probe_version: 1,
				runtime: "python_call_v1",
				module_path: "subject.py",
				cases,
			},
		})}`;

		expect(() =>
			parseAvoPythonProbePlan(message, "cycle", {
				modulePaths: ["subject.py"],
				requiredCallables: ["evaluate"],
				callableInputDimensions: { evaluate: [] },
				requirementIds: Array.from({ length: 6 }, (_, index) => `requirement-${index}`),
				minimumCases: 6,
				maximumCases: 8,
				minimumCrossRequirementCases: 0,
				minimumDistinctRequirements: 6,
				minimumContrastedInputDimensions: 0,
			}),
		).toThrow(/distinct callable inputs/i);
	});

	test("executes Python probes in a content-addressed disposable sandbox and reports actual failures", async () => {
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
					expect: { kind: "raises" as const, error: "ValueError", message: "bad" },
				},
				{
					caseId: "read-only-workspace",
					callable: "mutate",
					requirementIds: ["requirement-a", "requirement-c"],
					args: [],
					kwargs: {},
					expect: { kind: "return" as const, value: null },
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
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);
		const passing = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(passing, JSON.stringify(passing)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: { passed: true },
		});
		expect(passing.stderr).toBe("");
		expect(() => lstatSync(join(root, "forbidden-write.txt"))).toThrow();

		const wrongExceptionMessage = await executeAvoPythonProbeSandbox(
			root,
			{
				...plan,
				cases: plan.cases.map((item) =>
					item.caseId === "raises"
						? { ...item, expect: { kind: "raises" as const, error: "ValueError", message: "different" } }
						: item,
				),
			},
			bundle,
		);
		expect(wrongExceptionMessage).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(wrongExceptionMessage.report?.results.find((item) => item.caseId === "raises")?.status).toBe("fail");

		const broker = await startAvoPythonProbeBroker(root);
		try {
			const brokerResponse = await new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
				const clientSource = [
					'const net=require("node:net")',
					"const [socketPath,token,planText,bundleText]=process.argv.slice(1)",
					"let response=''",
					"const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify({protocolVersion:3,token,plan:JSON.parse(planText),bundle:JSON.parse(bundleText)})+'\\n'))",
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
						JSON.stringify(bundle),
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
				protocolVersion: 3,
				execution: { exitCode: 0, report: { passed: true } },
			});
			const staleProtocolResponse = await new Promise<Record<string, unknown>>((resolveResponse, rejectResponse) => {
				let response = "";
				const socket = createConnection(broker.socketPath, () => {
					socket.write(`${JSON.stringify({ protocolVersion: 2, token: broker.token, plan, bundle })}\n`);
				});
				socket.setEncoding("utf8");
				socket.on("data", (chunk: string) => {
					response += chunk;
					if (response.includes("\n")) socket.end();
				});
				socket.once("error", rejectResponse);
				socket.once("close", () => resolveResponse(JSON.parse(response.trim()) as Record<string, unknown>));
			});
			expect(staleProtocolResponse).toMatchObject({
				protocolVersion: 3,
				error: expect.stringContaining("invalid broker request"),
			});
			vi.stubEnv(AVO_PYTHON_PROBE_BROKER_SOCKET_ENV, broker.socketPath);
			vi.stubEnv(AVO_PYTHON_PROBE_BROKER_TOKEN_ENV, broker.token);
			const brokered = await executeAvoPythonProbeSandbox(root, plan, bundle);
			expect(brokered, JSON.stringify(brokered)).toMatchObject({
				exitCode: 0,
				report: { passed: true },
			});
		} finally {
			vi.unstubAllEnvs();
			await broker.close();
		}

		const failing = await executeAvoPythonProbeSandbox(
			root,
			{
				...plan,
				cases: plan.cases.map((item, index) =>
					index === 0 ? { ...item, expect: { kind: "return" as const, value: 999 } } : item,
				),
			},
			bundle,
		);
		expect(failing).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(failing.report?.results[0]).toMatchObject({ caseId: "sum-0", status: "fail", actual: 1, expected: 999 });
	});

	test("executes captured Python bundle bytes instead of a subsequently changed live workspace", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-captured-bundle-"));
		temporaryRoots.push(root);
		const capturedSource = ["def evaluate(left, right):", "    return left + right"].join("\n");
		writeFileSync(join(root, "subject.py"), capturedSource);
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: Buffer.from(capturedSource).toString("base64") },
		]);
		writeFileSync(join(root, "subject.py"), ["def evaluate(left, right):", "    return -999"].join("\n"));
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `captured-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index, index + 10],
				kwargs: {},
				expect: { kind: "return" as const, value: index * 2 + 10 },
			})),
		};

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: { passed: true },
		});
		expect(execution.report?.results.every((result) => result.status === "pass")).toBe(true);
		expect(execution.report?.results.map((result) => result.actual)).not.toContain(-999);
	});

	test("executes package modules that use relative imports from the captured bundle", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-package-"));
		temporaryRoots.push(root);
		const files = [
			{ path: "pkg/helper.py", source: ["def adjust(value):", "    return value + 10"].join("\n") },
			{
				path: "pkg/api.py",
				source: ["from .helper import adjust", "", "def evaluate(value):", "    return adjust(value)"].join("\n"),
			},
		];
		for (const file of files) {
			const path = join(root, file.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, file.source);
		}
		const bundle = createAvoPythonProbeBundle(
			files.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.source).toString("base64") })),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "pkg/api.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `package-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: index + 10 },
			})),
		};

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: { passed: true },
		});
	});

	test("hides mutable host files outside the captured bundle", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-host-file-"));
		const externalRoot = mkdtempSync(join("/var/tmp", "avo-python-probe-external-"));
		temporaryRoots.push(root, externalRoot);
		const externalPath = join(externalRoot, "live.txt");
		writeFileSync(externalPath, "host-secret");
		const source = [
			"from pathlib import Path",
			"",
			"def evaluate(value):",
			`    path = Path(${JSON.stringify(externalPath)})`,
			"    return path.read_text() if path.exists() else 'hidden'",
		].join("\n");
		writeFileSync(join(root, "subject.py"), source);
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: Buffer.from(source).toString("base64") },
		]);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `host-file-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: "hidden" },
			})),
		};
		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({ exitCode: 0, report: { passed: true } });
	});

	test("does not preserve candidate state through host shared memory between cases", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-shm-"));
		temporaryRoots.push(root);
		const source = [
			"from pathlib import Path",
			"",
			"def evaluate(value):",
			"    counter = Path('/dev/shm/avo-probe-sequence')",
			"    try:",
			"        index = int(counter.read_text())",
			"    except (FileNotFoundError, ValueError):",
			"        index = 0",
			"    try:",
			"        counter.write_text(str(index + 1))",
			"    except FileNotFoundError:",
			"        pass",
			"    return [11, 22, 33, 44, 55, 66][index]",
		].join("\n");
		writeFileSync(join(root, "subject.py"), source);
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: Buffer.from(source).toString("base64") },
		]);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: [11, 22, 33, 44, 55, 66].map((value, index) => ({
				caseId: `shm-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value },
			})),
		};
		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(execution.report?.results.map((item) => item.actual)).toEqual([11, 11, 11, 11, 11, 11]);
	});

	test("supports async callables and rejects tuple/list shape confusion", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-shapes-"));
		temporaryRoots.push(root);
		const source = [
			"async def async_value(value):",
			"    return value + 1",
			"",
			"def tuple_value(value):",
			"    return (value, value + 1)",
		].join("\n");
		writeFileSync(join(root, "subject.py"), source);
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: Buffer.from(source).toString("base64") },
		]);
		const asyncPlan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `async-${index}`,
				callable: "async_value",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: index + 1 },
			})),
		};
		expect(await executeAvoPythonProbeSandbox(root, asyncPlan, bundle)).toMatchObject({
			exitCode: 0,
			report: { passed: true },
		});
		const tuplePlan = {
			...asyncPlan,
			cases: asyncPlan.cases.map((item, index) => ({
				...item,
				caseId: `tuple-${index}`,
				callable: "tuple_value",
				expect: { kind: "return" as const, value: [index, index + 1] },
			})),
		};
		const tupleExecution = await executeAvoPythonProbeSandbox(root, tuplePlan, bundle);
		expect(tupleExecution).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(
			tupleExecution.report?.results.every((item) => item.error?.includes("unsupported return type tuple")),
		).toBe(true);
	});

	test("executes src-layout package modules from the captured bundle", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-src-package-"));
		temporaryRoots.push(root);
		const files = [
			{ path: "src/pkg/__init__.py", source: "" },
			{ path: "src/pkg/helper.py", source: ["def adjust(value):", "    return value * 3"].join("\n") },
			{
				path: "src/pkg/api.py",
				source: ["from .helper import adjust", "", "def evaluate(value):", "    return adjust(value)"].join("\n"),
			},
		];
		for (const file of files) {
			const path = join(root, file.path);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, file.source);
		}
		const bundle = createAvoPythonProbeBundle(
			files.map((file) => ({ path: file.path, contentBase64: Buffer.from(file.source).toString("base64") })),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "src/pkg/api.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `src-package-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index + 1],
				kwargs: {},
				expect: { kind: "return" as const, value: (index + 1) * 3 },
			})),
		};

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: { passed: true },
		});
	});

	test("isolates every Python probe case from module-global sequence state", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-sequence-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			[
				"_scripted_results = [11, 22, 33, 44, 55, 66]",
				"",
				"def evaluate(left, right):",
				"    return _scripted_results.pop(0)",
			].join("\n"),
		);
		const expected = [11, 22, 33, 44, 55, 66];
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: expected.map((value, index) => ({
				caseId: `contrast-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index, index + 1],
				kwargs: {},
				expect: { kind: "return" as const, value },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 1,
			timedOut: false,
			truncated: false,
			report: { passed: false },
		});
		expect(execution.report?.results[0]).toMatchObject({ caseId: "contrast-0", status: "pass", actual: 11 });
		expect(execution.report?.results.slice(1).every((result) => result.status === "fail")).toBe(true);
		expect(execution.report?.results.map((result) => result.actual)).toEqual([11, 11, 11, 11, 11, 11]);
	});

	test("keeps expectations and the former result sender outside candidate Python frames", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-frame-forgery-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			[
				"import inspect",
				"",
				"def evaluate(value):",
				"    frame = inspect.currentframe()",
				"    observed_expectation = None",
				"    observed_sender = None",
				"    while frame is not None:",
				"        local_values = frame.f_locals",
				"        for name in ('expect', 'expected'):",
				"            if isinstance(local_values.get(name), dict):",
				"                observed_expectation = local_values[name]",
				"        case = local_values.get('case')",
				"        if isinstance(case, dict) and isinstance(case.get('expect'), dict):",
				"            observed_expectation = case['expect']",
				"        if hasattr(local_values.get('sender'), 'send'):",
				"            observed_sender = local_values['sender']",
				"        frame = frame.f_back",
				"    if observed_expectation is not None and observed_sender is not None:",
				"        try:",
				"            observed_sender.send({'kind': 'return', 'actual': observed_expectation.get('value')})",
				"        except BaseException:",
				"            pass",
				"    return -999",
			].join("\n"),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `frame-forgery-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: index + 100 },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 1,
			timedOut: false,
			truncated: false,
			report: { passed: false },
		});
		expect(execution.report?.results.every((result) => result.status === "fail")).toBe(true);
		expect(execution.report?.results.map((result) => result.actual)).toEqual([-999, -999, -999, -999, -999, -999]);
	});

	test("isolates absolute workspace files between Python probe cases", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-absolute-counter-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			[
				"from pathlib import Path",
				"",
				"_counter = Path('/tmp/workspace/.case_counter')",
				"_scripted_results = [11, 22, 33, 44, 55, 66]",
				"",
				"def evaluate(value):",
				"    try:",
				"        index = int(_counter.read_text(encoding='utf-8'))",
				"    except FileNotFoundError:",
				"        index = 0",
				"    _counter.write_text(str(index + 1), encoding='utf-8')",
				"    return _scripted_results[index]",
			].join("\n"),
		);
		const expected = [11, 22, 33, 44, 55, 66];
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: expected.map((value, index) => ({
				caseId: `absolute-counter-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 1,
			timedOut: false,
			truncated: false,
			report: { passed: false },
		});
		expect(execution.report?.results[0]).toMatchObject({
			caseId: "absolute-counter-0",
			status: "pass",
			actual: 11,
		});
		expect(execution.report?.results.slice(1).every((result) => result.status === "fail")).toBe(true);
		expect(execution.report?.results.map((result) => result.actual)).toEqual([11, 11, 11, 11, 11, 11]);
	});

	test("rejects Python integers outside the host JSON safe-integer range", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-unsafe-integer-"));
		temporaryRoots.push(root);
		writeFileSync(join(root, "subject.py"), ["def evaluate(value):", "    return 9007199254740993"].join("\n"));
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `unsafe-integer-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: 9_007_199_254_740_992 },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(execution.report?.results.every((result) => result.status === "fail")).toBe(true);
		expect(execution.report?.results.every((result) => result.error?.includes("safe-integer range"))).toBe(true);
	});

	test("rejects unsupported Python returns instead of accepting their normalization sentinel", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-unsupported-return-"));
		temporaryRoots.push(root);
		writeFileSync(join(root, "subject.py"), ["def evaluate(value):", "    return {value}"].join("\n"));
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `unsupported-return-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index + 1],
				kwargs: {},
				expect: {
					kind: "return" as const,
					value: { __unsupported__: "set", repr: `{${index + 1}}` },
				},
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(execution.report?.results.every((result) => result.status === "fail")).toBe(true);
		expect(execution.report?.results.every((result) => result.error?.includes("unsupported return type set"))).toBe(
			true,
		);
	});

	test("bounds candidate memory allocation inside each Python probe process", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-memory-limit-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			["def evaluate(value):", "    return len(bytearray(600 * 1024 * 1024)) + value"].join("\n"),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: 6 }, (_, index) => ({
				caseId: `memory-limit-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: 600 * 1024 * 1024 + index },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);
		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution).toMatchObject({ exitCode: 1, report: { passed: false } });
		expect(
			execution.report?.results.every((item) => item.error?.includes("MemoryError")),
			JSON.stringify(execution),
		).toBe(true);
	});

	test("denies candidate child-process creation inside the Python probe sandbox", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-process-limit-"));
		temporaryRoots.push(root);
		const source = [
			"import errno",
			"import os",
			"",
			"def attempt_fork():",
			"    try:",
			"        child_pid = os.fork()",
			"    except OSError as error:",
			"        return {'denied': error.errno == errno.EAGAIN, 'errno': error.errno}",
			"    if child_pid == 0:",
			"        os._exit(0)",
			"    os.waitpid(child_pid, 0)",
			"    return {'denied': False, 'errno': None}",
		].join("\n");
		writeFileSync(join(root, "subject.py"), source);
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: Buffer.from(source).toString("base64") },
		]);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: [
				{
					caseId: "fork-denied",
					callable: "attempt_fork",
					requirementIds: ["sandbox-process-limit"],
					args: [],
					kwargs: {},
					expect: { kind: "return" as const, value: { denied: true, errno: 11 } },
				},
			],
		};

		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 0,
			timedOut: false,
			truncated: false,
			report: {
				passed: true,
				results: [
					{
						caseId: "fork-denied",
						status: "pass",
						actual: { denied: true, errno: 11 },
					},
				],
			},
		});
	});

	test("bounds aggregate wall time for the maximum Python probe case count", async () => {
		if (!canExecuteAvoPythonProbe()) return;
		const root = mkdtempSync(join(tmpdir(), "avo-python-probe-aggregate-timeout-"));
		temporaryRoots.push(root);
		writeFileSync(
			join(root, "subject.py"),
			["import time", "", "def evaluate(value):", "    time.sleep(60)", "    return value"].join("\n"),
		);
		const plan = {
			probeVersion: 1 as const,
			runtime: "python_call_v1" as const,
			modulePath: "subject.py",
			cases: Array.from({ length: AVO_PYTHON_PROBE_MAX_CASES }, (_, index) => ({
				caseId: `aggregate-timeout-${index}`,
				callable: "evaluate",
				requirementIds: ["requirement-a", "requirement-b"],
				args: [index],
				kwargs: {},
				expect: { kind: "return" as const, value: index },
			})),
		};
		const bundle = createAvoPythonProbeBundle([
			{ path: "subject.py", contentBase64: readFileSync(join(root, "subject.py")).toString("base64") },
		]);

		const wallStartedAt = Date.now();
		const execution = await executeAvoPythonProbeSandbox(root, plan, bundle);
		const wallDurationMs = Date.now() - wallStartedAt;

		expect(execution, JSON.stringify(execution)).toMatchObject({
			exitCode: 1,
			timedOut: true,
			report: { passed: false },
		});
		expect(execution.report?.results).toHaveLength(AVO_PYTHON_PROBE_MAX_CASES);
		expect(execution.report?.results.some((result) => result.status === "fail")).toBe(true);
		expect(wallDurationMs).toBeLessThan(20_000);
	}, 25_000);

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
