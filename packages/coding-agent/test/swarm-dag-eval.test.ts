import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BUILDER_MARKER,
	buildBaselinePrompt,
	buildBrokenDag,
	buildBuilderDag,
	buildHarnessStateFile,
	buildPrManagerMachine,
	buildReferenceSwarms,
	buildResidentWatcherDag,
	buildReviewSweepDag,
	buildReviewSweepFailDag,
	buildSwarmParentPrompt,
	checkReplayLedger,
	checkTaskSuccess,
	computeVerdicts,
	type EvalConfig,
	type ParsedAnswer,
	parseAnswerLine,
	parseEvalArgs,
	REVIEW_FILES,
	REVIEW_ISSUE_IDS,
	renderMarkdownReport,
	runReplayChecks,
	type SwarmDagEvalTrialResult,
	type SwarmLedgerEvent,
	type SwarmLedgerInstance,
	type SwarmLedgerNode,
	type SwarmStatusLedger,
	swarmSpecArguments,
} from "../scripts/swarm-dag-eval.js";
import { loadHarnessState } from "../src/core/refinement/refinement.js";

const WIDTH = 4;
const referenceSwarms = buildReferenceSwarms(WIDTH);
const byKind = (kind: string) => {
	const swarm = referenceSwarms.find((entry) => entry.kind === kind);
	if (!swarm) throw new Error(`missing reference swarm ${kind}`);
	return swarm;
};

describe("reference swarm shapes", () => {
	it("builds the review sweep with typed fan-in and a bounded foreach", () => {
		const dag = buildReviewSweepDag();
		expect(dag.nodes.map((node) => node.id)).toEqual(["files", "review", "report"]);
		expect(dag.run).toEqual({ budget_ms: 900_000, failure_policy: "escalate", max_parallel: 8 });
		const [files, review, report] = dag.nodes;
		expect(files.outputs).toEqual([{ name: "files", type: "json" }]);
		expect(files.budget_ms).toBe(240_000);
		expect(review.inputs).toEqual([{ name: "files", type: "json", from: "files.files" }]);
		expect(review.foreach).toEqual({ over: "files", max: 8 });
		expect(review.outputs).toEqual([{ name: "found", type: "text" }]);
		expect(report.inputs).toEqual([
			{ name: "file_list", type: "json", from: "files.files" },
			{ name: "found", type: "text", from: "review.found" },
		]);
		expect(report.outputs).toEqual([{ name: "issues", type: "json" }]);
		for (const node of dag.nodes) {
			expect(node.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
			expect(typeof node.subagent).toBe("object");
		}
	});

	it("plants one real, checkable issue per review file", () => {
		expect(REVIEW_FILES).toHaveLength(4);
		expect(REVIEW_ISSUE_IDS).toEqual(["AUDIT-A1", "AUDIT-B1", "AUDIT-C1", "AUDIT-D1"]);
		for (const file of REVIEW_FILES) {
			expect(file.code.length).toBeGreaterThan(20);
			expect(file.audit.length).toBeGreaterThan(20);
			expect(file.code).not.toContain(file.issueId);
		}
	});

	it("plants a failing reviewer that cannot be admitted (escalation variant)", () => {
		const dag = buildReviewSweepFailDag();
		const broken = dag.nodes.find((node) => node.id === "review-broken");
		expect(broken).toBeDefined();
		expect(broken?.depends_on).toEqual(["files"]);
		expect(broken?.failure_policy).toBe("escalate");
		if (typeof broken?.subagent === "object") {
			expect(broken.subagent.model).toBe("internal/no-such-model-for-eval");
			expect(broken.subagent.prompt).toContain("AUDIT-A1");
		} else {
			throw new Error("review-broken must use an inline subagent");
		}
		expect(buildReviewSweepDag().nodes.map((node) => node.id)).not.toContain("review-broken");
	});

	it("builds the N-wide builder with per-node budgets and a typed fan-in collector", () => {
		const dag = buildBuilderDag(WIDTH);
		expect(dag.nodes.map((node) => node.id)).toEqual([
			...Array.from({ length: WIDTH }, (_, i) => `builder-${i + 1}`),
			"collector",
		]);
		const collector = dag.nodes[dag.nodes.length - 1];
		expect(collector.inputs).toEqual(
			Array.from({ length: WIDTH }, (_, i) => ({
				name: `line-${i + 1}`,
				type: "text",
				from: `builder-${i + 1}.line`,
			})),
		);
		for (const node of dag.nodes) expect(node.budget_ms).toBe(240_000);
		for (let i = 1; i <= WIDTH; i++) {
			const builder = dag.nodes[i - 1];
			expect(builder?.subagent).toBeTypeOf("object");
			if (typeof builder?.subagent === "object") {
				expect(builder.subagent.prompt).toContain(`BUILT ${BUILDER_MARKER(i)}`);
			}
		}
	});

	it("builds the resident watcher with a resident head and a task chain", () => {
		const dag = buildResidentWatcherDag();
		const [watcher, taskA, taskB] = dag.nodes;
		expect(watcher?.lifecycle).toBe("resident");
		expect(watcher?.outputs).toBeUndefined();
		expect(watcher?.foreach).toBeUndefined();
		expect(watcher?.depends_on).toBeUndefined();
		expect(watcher?.budget_ms).toBeUndefined();
		expect(taskA?.outputs).toEqual([{ name: "step", type: "text" }]);
		expect(taskB?.inputs).toEqual([{ name: "prev", type: "text", from: "task-a.step" }]);
		expect(taskB?.lifecycle ?? "task").toBe("task");
		expect(taskA?.budget_ms).toBe(240_000);
	});

	it("builds the broken spec as a structurally valid but unresolvable reference", () => {
		const dag = buildBrokenDag();
		expect(dag.nodes).toHaveLength(1);
		expect(dag.nodes[0]?.subagent).toBe("no-such-subagent-entry");
	});

	it("builds the pr-manager machine with a closed review/fix loop and a resident monitor", () => {
		const machine = buildPrManagerMachine();
		expect(machine.states.map((state) => state.id)).toEqual(["entry", "reviewing", "fixing", "monitoring"]);
		expect(machine.states[0]?.entry).toBe(true);
		expect(machine.states.slice(1).every((state) => !state.entry)).toBe(true);
		expect(machine.states[1]?.max_entries).toBe(4);
		expect(machine.states[2]?.max_entries).toBe(3);
		// the loop closes: reviewing reads the previous fix report (optional, so the
		// first review binds null before the fixer ever runs)
		expect(machine.states[1]?.inputs).toEqual([
			{ name: "pr_url", type: "text", from: "entry.pr_url" },
			{ name: "fix_report", type: "json", from: "fixing.fix_report", optional: true },
		]);
		expect(machine.states[1]?.outputs).toEqual([{ name: "verdict", type: "json" }]);
		expect(machine.states[2]?.inputs).toEqual([{ name: "verdict", type: "json", from: "reviewing.verdict" }]);
		expect(machine.states[2]?.outputs).toEqual([{ name: "fix_report", type: "json" }]);
		const monitoring = machine.states[3];
		expect(monitoring?.lifecycle).toBe("resident");
		expect(monitoring?.outputs).toBeUndefined();
		expect(monitoring?.foreach).toBeUndefined();
		expect(machine.run?.max_transitions).toBe(24);
		expect(machine.transitions).toEqual([
			{ from: "entry", to: "reviewing" },
			{
				from: "reviewing",
				to: "fixing",
				when: { output: "verdict", path: "approved", op: "eq", value: false },
			},
			{
				from: "reviewing",
				to: "monitoring",
				when: { output: "verdict", path: "approved", op: "eq", value: true },
			},
			{ from: "fixing", to: "reviewing" },
		]);
		// wait blocks are gated at the kernel until the rlm.watch.* handlers land
		// (the TS shape types carry no wait field, so scan the serialized spec)
		for (const swarm of referenceSwarms) {
			if (swarm.machine) expect(JSON.stringify(swarm.machine)).not.toContain('"wait"');
		}
	});

	it("seeds the pr-manager as a machine-form reference swarm", () => {
		const swarm = byKind("pr-manager");
		expect(swarm.machine).toBeDefined();
		expect(swarm.dag).toBeUndefined();
		expect(swarm.machine?.states).toHaveLength(4);
	});
});

describe("prompt invariants", () => {
	it("swarm parent prompts contain no task-specific orchestration code", () => {
		for (const swarm of referenceSwarms) {
			const prompt = buildSwarmParentPrompt(swarm, "/tmp/ledger.json");
			expect(prompt).toContain(`rlm.swarm.run('${swarm.id}')`);
			expect(prompt).not.toMatch(/rlm\.spawn/);
			expect(prompt).not.toMatch(/rlm\.collect/);
		}
	});

	it("baseline prompts orchestrate manually and never touch rlm.swarm", () => {
		for (const kind of ["review-sweep", "builder", "resident-watcher"] as const) {
			const prompt = buildBaselinePrompt(byKind(kind), "/tmp/ledger.json");
			expect(prompt).toMatch(/rlm\.spawn/);
			expect(prompt).toMatch(/rlm\.collect/);
			expect(prompt).not.toMatch(/rlm\.swarm/);
			expect(prompt).toContain("Declared budget");
		}
	});

	it("the reviewer template carries the foreach placeholder and every audit id", () => {
		const swarm = byKind("review-sweep");
		const review = swarm.dag?.nodes.find((node) => node.id === "review");
		if (typeof review?.subagent !== "object") throw new Error("review must be inline");
		expect(review.subagent.prompt).toContain("{files}");
		for (const file of REVIEW_FILES) {
			expect(review.subagent.prompt).toContain(file.code);
			expect(review.subagent.prompt).toContain(file.issueId);
		}
	});

	it("the review-sweep baseline embeds the mini-repo exactly once (honest lower bound)", () => {
		const uniqueSnippet = "Math.max(value, max)"; // unique to file fa's listing line
		const baseline = buildBaselinePrompt(byKind("review-sweep"), "/tmp/ledger.json");
		expect(baseline.split(uniqueSnippet).length - 1).toBe(1);
		// The baseline composes reviewer prompts by substitution from the shared template.
		expect(baseline).toContain('reviewer_template.replace("{files}", name)');
		expect(baseline).not.toContain("STATE: done");
		const swarmParent = buildSwarmParentPrompt(byKind("review-sweep"), "/tmp/ledger.json");
		expect(swarmParent.split(uniqueSnippet).length - 1).toBe(0);
		// The other baseline arms also dropped the baked-in STATE.
		expect(buildBaselinePrompt(byKind("builder"), "/tmp/ledger.json")).not.toContain("STATE: done");
		expect(buildBaselinePrompt(byKind("resident-watcher"), "/tmp/ledger.json")).not.toContain("STATE: done");
	});

	it("the resident watcher prompt replies once and holds its turn open", () => {
		const swarm = byKind("resident-watcher");
		const watcher = swarm.dag?.nodes.find((node) => node.id === "watcher");
		if (typeof watcher?.subagent !== "object") throw new Error("watcher must be inline");
		expect(watcher.subagent.prompt).toContain("agent_message.send");
		expect(watcher.subagent.prompt).toContain("asyncio.sleep(900)");
		expect(watcher.subagent.prompt).toContain("Do not end your turn");
	});

	it("pr-manager machine prompts carry no orchestration code", () => {
		const swarm = byKind("pr-manager");
		const machine = swarm.machine;
		if (!machine) throw new Error("pr-manager must be machine form");
		for (const state of machine.states) {
			if (typeof state.subagent !== "object") throw new Error(`${state.id} must be inline`);
			expect(state.subagent.prompt, state.id).not.toMatch(/rlm\.spawn/);
			expect(state.subagent.prompt, state.id).not.toMatch(/rlm\.collect/);
			expect(state.subagent.prompt, state.id).not.toMatch(/rlm\.swarm/);
		}
		// the reviewing and fixing prompts embed the shared mini-repo fixtures
		const reviewing = machine.states.find((state) => state.id === "reviewing")?.subagent;
		const fixing = machine.states.find((state) => state.id === "fixing")?.subagent;
		if (typeof reviewing !== "object" || typeof fixing !== "object") throw new Error("inline prompts");
		expect(reviewing.prompt).toContain("{pr_url}");
		expect(reviewing.prompt).toContain("{fix_report}");
		expect(reviewing.prompt).toContain("null means no fixing round has run yet");
		expect(fixing.prompt).toContain("{verdict}");
		expect(fixing.prompt).toContain("fix_report");
		for (const file of REVIEW_FILES) {
			expect(reviewing.prompt).toContain(file.issueId);
			expect(fixing.prompt).toContain(file.issueId);
		}
		// the monitoring resident replies once and idles, same as the resident-watcher
		const monitoring = machine.states.find((state) => state.id === "monitoring")?.subagent;
		if (typeof monitoring !== "object") throw new Error("monitoring must be inline");
		expect(monitoring.prompt).toContain("agent_message.send");
		expect(monitoring.prompt).toContain("Do not end your turn");
	});

	it("the pr-manager parent prompt runs the machine and stops the resident; its baseline orchestrates manually", () => {
		const swarm = byKind("pr-manager");
		const parent = buildSwarmParentPrompt(swarm, "/tmp/ledger.json");
		expect(parent).toContain(`rlm.swarm.run('${swarm.id}')`);
		expect(parent).toContain("rlm.swarm.stop(run_id)");
		expect(parent).not.toMatch(/rlm\.spawn/);
		expect(parent).not.toMatch(/rlm\.collect/);
		const baseline = buildBaselinePrompt(swarm, "/tmp/ledger.json");
		expect(baseline).toMatch(/rlm\.spawn/);
		expect(baseline).toMatch(/rlm\.collect/);
		expect(baseline).not.toMatch(/rlm\.swarm/);
		expect(baseline).toContain("Declared budget");
	});
});

describe("harness state seeding", () => {
	it("seeds swarm entries the TS host can load back", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "swarm-dag-eval-seed-"));
		try {
			const stateDir = join(tempDir, "harness");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "harness_state.json"), buildHarnessStateFile([byKind("review-sweep")]));
			const state = loadHarnessState(stateDir, "local");
			const entry = state.entries.swarm["swarm-dag-eval-review-sweep"];
			expect(entry).toBeDefined();
			expect(entry?.kind).toBe("swarm");
			expect(entry?.scope).toBe("local");
			expect((entry?.arguments.dag as { nodes: { id: string }[] }).nodes.map((node) => node.id)).toEqual([
				"files",
				"review",
				"report",
			]);
			expect(state.entries.prompt).toEqual({});
			expect(state.entries.subagent).toEqual({});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("writes one entry per seeded spec with the local schema", () => {
		const file = JSON.parse(buildHarnessStateFile(referenceSwarms));
		expect(file.schema).toBe(1);
		expect(Object.keys(file.entries.swarm)).toHaveLength(referenceSwarms.length);
		expect(file.refinements).toEqual([]);
		for (const spec of referenceSwarms) {
			expect(file.entries.swarm[spec.id]?.kind).toBe("swarm");
			expect(file.entries.swarm[spec.id]?.arguments.dag).toEqual(spec.dag);
		}
	});

	it("seeds machine-form reference swarms under arguments.machine (full round-trip)", () => {
		const prManager = byKind("pr-manager");
		const tempDir = mkdtempSync(join(tmpdir(), "swarm-dag-eval-seed-machine-"));
		try {
			const stateDir = join(tempDir, "harness");
			mkdirSync(stateDir, { recursive: true });
			writeFileSync(join(stateDir, "harness_state.json"), buildHarnessStateFile([prManager]));
			const state = loadHarnessState(stateDir, "local");
			const entry = state.entries.swarm[prManager.id];
			expect(entry).toBeDefined();
			expect(entry?.kind).toBe("swarm");
			expect(entry?.scope).toBe("local");
			expect(entry?.arguments.machine).toEqual(prManager.machine);
			expect(entry?.arguments.dag).toBeUndefined();
			expect(Object.keys(state.entries.swarm)).toEqual([prManager.id]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
		const file = JSON.parse(buildHarnessStateFile([prManager]));
		expect(file.entries.swarm[prManager.id]?.arguments.machine).toEqual(prManager.machine);
		expect(swarmSpecArguments(prManager)).toEqual({ machine: prManager.machine });
		expect(swarmSpecArguments(byKind("review-sweep"))).toEqual({ dag: byKind("review-sweep").dag });
	});
});

describe("answer parsing and task-success checks", () => {
	const answer = (overrides: Partial<ParsedAnswer> = {}): ParsedAnswer => ({
		issues: [],
		markers: [],
		state: null,
		stopped: [],
		failedNode: null,
		reportStatus: null,
		rejected: null,
		children: null,
		message: null,
		approved: null,
		defects: [],
		rounds: null,
		...overrides,
	});

	it("parses every ANSWER format", () => {
		expect(parseAnswerLine("junk\nANSWER: ISSUES: AUDIT-A1, AUDIT-B1, AUDIT-C1, AUDIT-D1; STATE: done")).toEqual(
			answer({ issues: REVIEW_ISSUE_IDS, state: "done" }),
		);
		expect(parseAnswerLine("ANSWER: MARKERS: swb-marker-1,swb-marker-2; STOPPED: watcher; STATE: stopped")).toEqual(
			answer({ markers: ["swb-marker-1", "swb-marker-2"], stopped: ["watcher"], state: "stopped" }),
		);
		expect(parseAnswerLine("ANSWER: STATE: paused; FAILED-NODE: review-broken; REPORT-STATUS: pending")).toEqual(
			answer({ state: "paused", failedNode: "review-broken", reportStatus: "pending" }),
		);
		expect(
			parseAnswerLine(
				"ANSWER: APPROVED: yes; DEFECTS: AUDIT-A1, AUDIT-B1, AUDIT-C1, AUDIT-D1; ROUNDS: 2; STOPPED: monitoring; STATE: stopped",
			),
		).toEqual(
			answer({
				approved: true,
				defects: REVIEW_ISSUE_IDS,
				rounds: 2,
				stopped: ["monitoring"],
				state: "stopped",
			}),
		);
		expect(
			parseAnswerLine(
				"ANSWER: REJECTED: yes; CHILDREN: 0; MESSAGE: node 'broken-source' references unknown subagent 'no-such-subagent-entry'",
			),
		).toEqual(
			answer({
				rejected: true,
				children: 0,
				message: "node 'broken-source' references unknown subagent 'no-such-subagent-entry'",
			}),
		);
		expect(parseAnswerLine("no answer here")).toBeNull();
		expect(parseAnswerLine(undefined)).toBeNull();
	});

	it("accepts a complete review sweep and rejects a missing planted issue", () => {
		const good = answer({ issues: REVIEW_ISSUE_IDS, state: "done" });
		expect(checkTaskSuccess(byKind("review-sweep"), good, null).ok).toBe(true);
		const missing = answer({ issues: REVIEW_ISSUE_IDS.slice(1), state: "done" });
		const check = checkTaskSuccess(byKind("review-sweep"), missing, null);
		expect(check.ok).toBe(false);
		expect(check.problems[0]).toContain("AUDIT-A1 missing");
	});

	it("cross-checks the review sweep ledger against the aggregator preview", () => {
		const ledger = statusLedgerFixture({
			state: "done",
			nodes: [
				nodeFixture("files", "done"),
				nodeFixture("review", "done"),
				nodeFixture("report", "done", {
					answer_preview: '```json\n{"issues": ["AUDIT-A1","AUDIT-B2"]}\n```',
				}),
			],
		});
		const good = answer({ issues: REVIEW_ISSUE_IDS, state: "done" });
		const check = checkTaskSuccess(byKind("review-sweep"), good, ledger);
		expect(check.ok).toBe(false);
		expect(check.problems.some((problem) => problem.includes("AUDIT-B1"))).toBe(true);
	});

	it("checks the builder markers against the collector preview", () => {
		const swarm = byKind("builder");
		const markers = Array.from({ length: WIDTH }, (_, i) => BUILDER_MARKER(i + 1));
		expect(checkTaskSuccess(swarm, answer({ markers, state: "done" }), null).ok).toBe(true);
		const ledger = statusLedgerFixture({
			state: "done",
			nodes: [nodeFixture("collector", "done", { answer_preview: "COLLECTED swb-marker-1" })],
		});
		const check = checkTaskSuccess(swarm, answer({ markers, state: "done" }), ledger);
		expect(check.ok).toBe(false);
		expect(check.problems.some((problem) => problem.includes("swb-marker-2"))).toBe(true);
	});

	it("checks the resident teardown: tasks settled, watcher cancelled", () => {
		const swarm = byKind("resident-watcher");
		const good = answer({ markers: ["swt-1", "swt-2"], stopped: ["watcher"], state: "stopped" });
		expect(checkTaskSuccess(swarm, good, null).ok).toBe(true);
		expect(
			checkTaskSuccess(swarm, answer({ markers: ["swt-1", "swt-2"], stopped: [], state: "stopped" }), null).ok,
		).toBe(false);
		const ledger = statusLedgerFixture({
			spec_id: "swarm-dag-eval-resident-watcher",
			state: "stopped",
			nodes: [
				nodeFixture("watcher", "cancelled", {
					lifecycle: "resident",
					instances: [instanceFixture(-1, "cancelled")],
				}),
				nodeFixture("task-a", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 5_000 })] }),
				nodeFixture("task-b", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 4_000 })] }),
			],
		});
		expect(checkTaskSuccess(swarm, good, ledger).ok).toBe(true);
		const badLedger = statusLedgerFixture({
			state: "done",
			nodes: [
				nodeFixture("watcher", "running", { lifecycle: "resident" }),
				nodeFixture("task-a", "done"),
				nodeFixture("task-b", "done"),
			],
		});
		const check = checkTaskSuccess(swarm, good, badLedger);
		expect(check.ok).toBe(false);
		expect(check.problems.some((problem) => problem.includes("expected stopped"))).toBe(true);
		expect(check.problems.some((problem) => problem.includes("watcher node is not cancelled"))).toBe(true);
	});

	it("checks the escalation probe answer and ledger", () => {
		const swarm = byKind("review-sweep-fail");
		const good = answer({ state: "paused", failedNode: "review-broken", reportStatus: "pending" });
		expect(checkTaskSuccess(swarm, good, null).ok).toBe(true);
		const ledger = statusLedgerFixture({
			state: "paused",
			nodes: [
				nodeFixture("files", "done"),
				nodeFixture("review", "running", {
					instances: [instanceFixture(0, "running"), instanceFixture(1, "running")],
				}),
				nodeFixture("review-broken", "error", { error: "spawn admission failed: no such model" }),
				nodeFixture("report", "pending", { instances: [] }),
			],
			events: [
				eventFixture(1, "run_started"),
				eventFixture(2, "milestone", { milestone: "paused" }),
				eventFixture(3, "spawned", { node: "report" }),
			],
		});
		const check = checkTaskSuccess(swarm, good, ledger);
		expect(check.ok).toBe(false);
		expect(check.problems).toContain("report node started despite the escalation pause");
	});

	it("checks the dry-run rejection answer", () => {
		const swarm = byKind("dry-run-reject");
		const good = answer({
			rejected: true,
			children: 0,
			message: "node 'broken-source' references unknown subagent 'no-such-subagent-entry'",
		});
		expect(checkTaskSuccess(swarm, good, null).ok).toBe(true);
		const bad = answer({ rejected: false, children: 2, message: "no error" });
		expect(checkTaskSuccess(swarm, bad, null).ok).toBe(false);
		expect(checkTaskSuccess(swarm, null, null).problems).toContain("no ANSWER line in the parent's final text");
	});

	it("baseline arms cross-check the collect ledger against the ANSWER ids", () => {
		const swarm = byKind("review-sweep");
		const baselineLedger = Object.fromEntries(
			REVIEW_FILES.map((file) => [`reviewer-${file.name}`, `FOUND ${file.issueId}`]),
		);
		const good = checkTaskSuccess(swarm, answer({ issues: REVIEW_ISSUE_IDS }), null, {
			arm: "baseline",
			baselineLedger,
		});
		expect(good.ok).toBe(true);
		// No STATE field is required for baselines (the template no longer bakes one in).
		expect(good.problems).toEqual([]);

		// A planted id the children never reported must fail.
		const shortLedger = { "reviewer-fa": "FOUND AUDIT-A1" };
		const missingId = checkTaskSuccess(swarm, answer({ issues: REVIEW_ISSUE_IDS }), null, {
			arm: "baseline",
			baselineLedger: shortLedger,
		});
		expect(missingId.ok).toBe(false);
		expect(
			missingId.problems.some((problem) => problem.includes("AUDIT-B1 missing from the baseline collect ledger")),
		).toBe(true);

		// An ANSWER id absent from the ledger must fail (the parent cannot invent it).
		const invented = checkTaskSuccess(swarm, answer({ issues: [...REVIEW_ISSUE_IDS, "AUDIT-Z9"] }), null, {
			arm: "baseline",
			baselineLedger,
		});
		expect(invented.ok).toBe(false);
		expect(
			invented.problems.some((problem) =>
				problem.includes("AUDIT-Z9 is not present in the baseline collect ledger"),
			),
		).toBe(true);

		// A missing ledger fails completion instead of passing on the self-reported ANSWER.
		const noLedger = checkTaskSuccess(swarm, answer({ issues: REVIEW_ISSUE_IDS }), null, {
			arm: "baseline",
			baselineLedger: null,
		});
		expect(noLedger.ok).toBe(false);
		expect(noLedger.problems.some((problem) => problem.includes("baseline collect ledger missing"))).toBe(true);
	});

	it("baseline arms check builder markers and the resident chain against the collect ledger", () => {
		const builder = byKind("builder");
		const markers = Array.from({ length: WIDTH }, (_, i) => BUILDER_MARKER(i + 1));
		const builderLedger = Object.fromEntries(markers.map((marker) => [`builder-${marker}`, `BUILT ${marker}`]));
		expect(
			checkTaskSuccess(builder, answer({ markers }), null, { arm: "baseline", baselineLedger: builderLedger }).ok,
		).toBe(true);
		const missingMarker = checkTaskSuccess(builder, answer({ markers }), null, {
			arm: "baseline",
			baselineLedger: { "builder-1": "BUILT swb-marker-1" },
		});
		expect(missingMarker.ok).toBe(false);
		expect(
			missingMarker.problems.some((problem) =>
				problem.includes("swb-marker-2 missing from the baseline collect ledger"),
			),
		).toBe(true);

		const resident = byKind("resident-watcher");
		const residentLedger = { "task-a": "STEP swt-1", "task-b": "STEP swt-2" };
		expect(
			checkTaskSuccess(resident, answer({ markers: ["swt-1", "swt-2"], stopped: ["watcher"] }), null, {
				arm: "baseline",
				baselineLedger: residentLedger,
			}).ok,
		).toBe(true);
		const missingTask = checkTaskSuccess(resident, answer({ markers: ["swt-1"], stopped: ["watcher"] }), null, {
			arm: "baseline",
			baselineLedger: residentLedger,
		});
		expect(missingTask.ok).toBe(false);
		expect(missingTask.problems.some((problem) => problem.includes("swt-2 missing from the ANSWER line"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Replay checker fixtures.
// ---------------------------------------------------------------------------

function eventFixture(seq: number, kind: string, extra: Partial<SwarmLedgerEvent> = {}): SwarmLedgerEvent {
	return { seq, kind, stage: "delivered", ...extra };
}

function instanceFixture(index: number, status: string, extra: Partial<SwarmLedgerInstance> = {}): SwarmLedgerInstance {
	return { index, status, attempt: 1, child: "child-1", duration_ms: null, ...extra };
}

function nodeFixture(id: string, status: string, extra: Partial<SwarmLedgerNode> = {}): SwarmLedgerNode {
	return { id, status, lifecycle: "task", attempts: 1, instances: [instanceFixture(-1, status)], ...extra };
}

function statusLedgerFixture(overrides: Partial<SwarmStatusLedger> = {}): SwarmStatusLedger {
	return {
		run_id: "run-1",
		spec_id: "swarm-dag-eval-review-sweep",
		name: null,
		state: "done",
		nodes: [],
		events: [],
		elapsed_ms: 12_345,
		usage: { spawns: 0, settled: 0, tool_uses: 0, max_parallel: 8, running: 0 },
		...overrides,
	};
}

function reviewSweepLedger(): SwarmStatusLedger {
	return statusLedgerFixture({
		state: "done",
		nodes: [
			nodeFixture("files", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 4_000 })] }),
			nodeFixture("review", "done", {
				instances: REVIEW_FILES.map((_, index) => instanceFixture(index, "done", { duration_ms: 8_000 })),
			}),
			nodeFixture("report", "done", {
				instances: [instanceFixture(-1, "done", { duration_ms: 3_000 })],
				answer_preview: '```json\n{"issues": ["AUDIT-A1","AUDIT-B1","AUDIT-C1","AUDIT-D1"]}\n```',
			}),
		],
		events: [
			eventFixture(1, "run_started", { detail: "3 nodes, max_parallel 8" }),
			eventFixture(2, "node_ready", { node: "files" }),
			eventFixture(3, "spawned", { node: "files", instance: -1 }),
			eventFixture(4, "settled", { node: "files", instance: -1, status: "done", duration_ms: 4_000 }),
			eventFixture(5, "answer_captured", { node: "files", instance: -1 }),
			eventFixture(6, "node_ready", { node: "review" }),
			...REVIEW_FILES.flatMap((_, index) => [
				eventFixture(7 + index * 3, "spawned", { node: "review", instance: index }),
				eventFixture(8 + index * 3, "settled", {
					node: "review",
					instance: index,
					status: "done",
					duration_ms: 8_000,
				}),
				eventFixture(9 + index * 3, "answer_captured", { node: "review", instance: index }),
			]),
			eventFixture(19, "node_ready", { node: "report" }),
			eventFixture(20, "spawned", { node: "report", instance: -1 }),
			eventFixture(21, "settled", { node: "report", instance: -1, status: "done", duration_ms: 3_000 }),
			eventFixture(22, "answer_captured", { node: "report", instance: -1 }),
			eventFixture(23, "milestone", { milestone: "finished" }),
		],
		usage: { spawns: 6, settled: 6, tool_uses: 6, max_parallel: 8, running: 0 },
	});
}

function residentLedger(): SwarmStatusLedger {
	return statusLedgerFixture({
		spec_id: "swarm-dag-eval-resident-watcher",
		state: "stopped",
		nodes: [
			nodeFixture("watcher", "cancelled", {
				lifecycle: "resident",
				instances: [instanceFixture(-1, "cancelled")],
			}),
			nodeFixture("task-a", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 5_000 })] }),
			nodeFixture("task-b", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 4_000 })] }),
		],
		events: [
			eventFixture(1, "run_started"),
			eventFixture(2, "node_ready", { node: "watcher" }),
			eventFixture(3, "spawned", { node: "watcher", instance: -1 }),
			eventFixture(4, "node_ready", { node: "task-a" }),
			eventFixture(5, "spawned", { node: "task-a", instance: -1 }),
			eventFixture(6, "settled", { node: "task-a", instance: -1, status: "done", duration_ms: 5_000 }),
			eventFixture(7, "answer_captured", { node: "task-a", instance: -1 }),
			eventFixture(8, "node_ready", { node: "task-b" }),
			eventFixture(9, "spawned", { node: "task-b", instance: -1 }),
			eventFixture(10, "settled", { node: "task-b", instance: -1, status: "done", duration_ms: 4_000 }),
			eventFixture(11, "answer_captured", { node: "task-b", instance: -1 }),
			eventFixture(12, "milestone", { milestone: "finished" }),
			eventFixture(13, "node_cancelled", { node: "watcher" }),
			eventFixture(14, "cancelled", { node: "watcher", instance: -1 }),
			eventFixture(15, "run_stopped", { detail: "stopped; 1 node(s) cancelled" }),
		],
		usage: { spawns: 3, settled: 2, tool_uses: 2, max_parallel: 8, running: 0 },
	});
}

function escalationLedger(): SwarmStatusLedger {
	return statusLedgerFixture({
		spec_id: "swarm-dag-eval-review-fail",
		state: "paused",
		nodes: [
			nodeFixture("files", "done", { instances: [instanceFixture(-1, "done", { duration_ms: 4_000 })] }),
			nodeFixture("review", "running", {
				instances: [
					instanceFixture(0, "running"),
					instanceFixture(1, "running"),
					instanceFixture(2, "running"),
					instanceFixture(3, "running"),
				],
			}),
			nodeFixture("review-broken", "error", {
				instances: [instanceFixture(-1, "error", { error: "spawn admission failed: no such model" })],
				error: "spawn admission failed: no such model",
			}),
			nodeFixture("report", "pending", { instances: [] }),
		],
		events: [
			eventFixture(1, "run_started"),
			eventFixture(2, "node_ready", { node: "files" }),
			eventFixture(3, "spawned", { node: "files", instance: -1 }),
			eventFixture(4, "settled", { node: "files", instance: -1, status: "done", duration_ms: 4_000 }),
			eventFixture(5, "node_ready", { node: "review" }),
			eventFixture(6, "spawned", { node: "review", instance: 0 }),
			eventFixture(7, "spawned", { node: "review", instance: 1 }),
			eventFixture(8, "spawned", { node: "review", instance: 2 }),
			eventFixture(9, "spawned", { node: "review", instance: 3 }),
			eventFixture(10, "node_ready", { node: "review-broken" }),
			eventFixture(11, "settled", {
				node: "review-broken",
				instance: -1,
				status: "error",
				error: "spawn admission failed: no such model",
			}),
			eventFixture(12, "node_error", { node: "review-broken", error: "spawn admission failed" }),
			eventFixture(13, "milestone", { milestone: "paused" }),
		],
		usage: { spawns: 5, settled: 1, tool_uses: 1, max_parallel: 8, running: 4 },
	});
}

function prManagerLedger(): SwarmStatusLedger {
	// The pr-manager's closed two-round loop: entry -> reviewing (fix report
	// null, verdict false, all four findings) -> fixing (fix_report with all
	// four ids) -> reviewing (verdict approved true) -> resident monitoring,
	// then the caller stops the run. rounds = reviewing entries_used = 2.
	const events: SwarmLedgerEvent[] = [];
	let seq = 0;
	const push = (kind: string, extra: Partial<SwarmLedgerEvent> = {}) => {
		seq += 1;
		events.push(eventFixture(seq, kind, extra));
	};
	const settle = (node: string, entry: number, instance: number, answer: string) => {
		push("node_ready", { node, entry, instance });
		push("spawned", { node, entry, instance });
		push("settled", { node, entry, instance, status: "done", duration_ms: 6_000 });
		push("answer_captured", { node, entry, instance, answer });
	};
	push("run_started", { detail: "4 states, max_parallel 8" });
	push("state_entry", { node: "entry", entry: 0, detail: "entry state" });
	settle("entry", 0, 0, "PR swp://mini-repo: the snapshot under review carries four planted defects with audit notes");
	push("transition_fired", { from: "entry", to: "reviewing", detail: "'entry' -> 'reviewing'" });
	push("state_entry", { node: "reviewing", entry: 0, detail: "entered from entry" });
	settle(
		"reviewing",
		0,
		0,
		'```json\n{"verdict": {"approved": false, "findings": ["AUDIT-A1","AUDIT-B1","AUDIT-C1","AUDIT-D1"]}}\n```',
	);
	push("transition_fired", { from: "reviewing", to: "fixing", detail: "'reviewing' -> 'fixing'" });
	push("state_entry", { node: "fixing", entry: 0, detail: "entered from reviewing" });
	settle("fixing", 0, 0, '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1","AUDIT-C1","AUDIT-D1"]}}\n```');
	push("transition_fired", { from: "fixing", to: "reviewing", detail: "'fixing' -> 'reviewing'" });
	push("state_entry", { node: "reviewing", entry: 1, detail: "entered from fixing" });
	settle("reviewing", 1, 1, '```json\n{"verdict": {"approved": true, "findings": []}}\n```');
	push("transition_fired", { from: "reviewing", to: "monitoring", detail: "'reviewing' -> 'monitoring'" });
	push("state_entry", { node: "monitoring", entry: 0, detail: "entered from reviewing" });
	push("node_ready", { node: "monitoring", entry: 0 });
	push("spawned", { node: "monitoring", entry: 0, instance: 0 });
	push("milestone", { milestone: "finished", detail: "resident still running" });
	push("cancelled", { node: "monitoring", entry: 0, instance: 0, child: "child-5", detail: "resident torn down" });
	push("run_stopped", { detail: "stopped; 1 state(s) cancelled" });
	return statusLedgerFixture({
		spec_id: "swarm-dag-eval-pr-manager",
		state: "stopped",
		nodes: [
			nodeFixture("entry", "done", {
				instances: [instanceFixture(0, "done", { duration_ms: 6_000 })],
				entries_used: 1,
				max_entries: 1,
				entries: [{ index: 0, status: "done" }],
			}),
			nodeFixture("reviewing", "done", {
				attempts: 2,
				instances: [0, 1].map((index) => instanceFixture(index, "done", { entry: index, duration_ms: 6_000 })),
				entries_used: 2,
				max_entries: 4,
				entries: [0, 1].map((index) => ({ index, status: "done" })),
				answer_preview: '```json\n{"verdict": {"approved": true, "findings": []}}\n```',
			}),
			nodeFixture("fixing", "done", {
				instances: [instanceFixture(0, "done", { duration_ms: 6_000 })],
				entries_used: 1,
				max_entries: 3,
				entries: [{ index: 0, status: "done" }],
				answer_preview: '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1","AUDIT-C1","AUDIT-D1"]}}\n```',
			}),
			nodeFixture("monitoring", "cancelled", {
				lifecycle: "resident",
				attempts: 1,
				instances: [instanceFixture(0, "cancelled", { entry: 0 })],
				entries_used: 1,
				max_entries: 1,
				entries: [{ index: 0, status: "cancelled" }],
			}),
		],
		events,
		usage: { spawns: 5, settled: 4, tool_uses: 5, max_parallel: 8, running: 0, transitions_fired: 4 },
	});
}

function waitMachineLedger(): SwarmStatusLedger {
	// A wait-state machine: watch registers a path watch, the event settles it
	// (timed_out false), the guarded transition enters act, and a duplicate
	// self-target transition is blocked by max_entries before quiescence.
	return statusLedgerFixture({
		spec_id: "swarm-dag-eval-wait-probe",
		state: "done",
		nodes: [
			nodeFixture("watch", "done", {
				instances: [],
				entries_used: 1,
				max_entries: 1,
				entries: [{ index: 0, status: "done" }],
			}),
			nodeFixture("act", "done", {
				instances: [instanceFixture(0, "done", { duration_ms: 2_000 })],
				entries_used: 1,
				max_entries: 1,
				entries: [{ index: 0, status: "done" }],
			}),
		],
		events: [
			eventFixture(1, "run_started", { detail: "2 states, max_parallel 8" }),
			eventFixture(2, "state_entry", { node: "watch", entry: 0, detail: "entry state" }),
			eventFixture(3, "node_ready", { node: "watch", entry: 0, detail: "waiting on path '/tmp/x'" }),
			eventFixture(4, "wait_settled", { node: "watch", entry: 0, detail: "path changed: /tmp/x", timed_out: false }),
			eventFixture(5, "transition_fired", { from: "watch", to: "act", detail: "'watch' -> 'act'" }),
			eventFixture(6, "state_entry", { node: "act", entry: 0, detail: "entered from watch" }),
			eventFixture(7, "node_ready", { node: "act", entry: 0, instance: 0 }),
			eventFixture(8, "spawned", { node: "act", entry: 0, instance: 0 }),
			eventFixture(9, "settled", { node: "act", entry: 0, instance: 0, status: "done", duration_ms: 2_000 }),
			eventFixture(10, "answer_captured", { node: "act", entry: 0, instance: 0, answer: "acted on the event" }),
			eventFixture(11, "transition_blocked", { from: "act", to: "act", detail: "state 'act' is at max_entries 1" }),
			eventFixture(12, "milestone", {
				milestone: "finished",
				detail: "run complete: 2 state(s), 1 transition(s) fired",
			}),
		],
		usage: { spawns: 1, settled: 1, tool_uses: 1, max_parallel: 8, running: 0, transitions_fired: 1 },
	});
}

describe("pr-manager task checks", () => {
	const prAnswer = (overrides: Partial<ParsedAnswer> = {}): ParsedAnswer => ({
		issues: [],
		markers: [],
		state: "stopped",
		stopped: ["monitoring"],
		failedNode: null,
		reportStatus: null,
		rejected: null,
		children: null,
		message: null,
		approved: true,
		defects: REVIEW_ISSUE_IDS,
		rounds: 2,
		...overrides,
	});
	const prManager = byKind("pr-manager");

	it("accepts the pr-manager answer and machine ledger: approved, defects, rounds, monitor teardown", () => {
		const check = checkTaskSuccess(prManager, prAnswer(), prManagerLedger());
		expect(check.problems).toEqual([]);
		expect(check.ok).toBe(true);
	});

	it("rejects an unapproved final verdict, wrong rounds, and missing defects", () => {
		const unapproved = checkTaskSuccess(prManager, prAnswer({ approved: false }), prManagerLedger());
		expect(unapproved.problems.some((problem) => problem.includes("approved"))).toBe(true);
		const wrongRounds = checkTaskSuccess(prManager, prAnswer({ rounds: 3 }), prManagerLedger());
		expect(wrongRounds.problems.some((problem) => problem.includes("rounds"))).toBe(true);
		const missingDefect = checkTaskSuccess(
			prManager,
			prAnswer({ defects: REVIEW_ISSUE_IDS.slice(1) }),
			prManagerLedger(),
		);
		expect(missingDefect.problems.some((problem) => problem.includes("AUDIT-A1 missing from the ANSWER line"))).toBe(
			true,
		);
	});

	it("cross-checks the machine ledger: review rounds, the fix ledger, and the resident teardown", () => {
		const ledger = prManagerLedger();
		const reviewing = ledger.nodes.find((node) => node.id === "reviewing");
		const fixing = ledger.nodes.find((node) => node.id === "fixing");
		// the closed loop: two reviewing rounds (rounds), one fixing round
		expect(reviewing?.entries_used).toBe(2);
		expect(reviewing?.max_entries).toBe(4);
		expect(fixing?.entries_used).toBe(1);
		const ok = checkReplayLedger(ledger);
		expect(ok.problems).toEqual([]);
		// mutating the ledger breaks the task check
		const broken = structuredClone(ledger);
		const brokenReviewing = broken.nodes.find((node) => node.id === "reviewing");
		brokenReviewing!.entries_used = 3;
		const check = checkTaskSuccess(prManager, prAnswer(), broken);
		expect(check.problems.some((problem) => problem.includes("reviewing entries_used"))).toBe(true);
		// a forged approved verdict (loose "true" substring, not the parsed field) fails
		const forged = structuredClone(ledger);
		const forgedReviewing = forged.nodes.find((node) => node.id === "reviewing");
		forgedReviewing!.answer_preview = "verdict said false but this preview contains the word true somewhere";
		const forgedCheck = checkTaskSuccess(prManager, prAnswer(), forged);
		expect(forgedCheck.problems.some((problem) => problem.includes("not approved true"))).toBe(true);
		// a missing planted defect in the fix ledger breaks the check
		const holed = structuredClone(ledger);
		for (const event of holed.events) {
			if (event.kind === "answer_captured" && event.node === "fixing") {
				event.answer = '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1"]}}\n```';
			}
		}
		const holedFixing = holed.nodes.find((node) => node.id === "fixing");
		holedFixing!.answer_preview = '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1"]}}\n```';
		const holedCheck = checkTaskSuccess(prManager, prAnswer(), holed);
		expect(holedCheck.problems.some((problem) => problem.includes("missing from the fixing ledger"))).toBe(true);
	});

	it("accepts the baseline arm against the collect dump (ids, rounds, no inventions)", () => {
		const baselineLedger = {
			"pr-fixing-1": '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1","AUDIT-C1","AUDIT-D1"]}}\n```',
			rounds: 2,
		};
		const check = checkTaskSuccess(prManager, prAnswer({ state: "done" }), null, {
			arm: "baseline",
			baselineLedger,
		});
		expect(check.problems).toEqual([]);
		// a planted id the children never reported fails the baseline arm
		const missing = checkTaskSuccess(prManager, prAnswer({ state: "done" }), null, {
			arm: "baseline",
			baselineLedger: {
				"pr-fixing-1": '```json\n{"fix_report": {"fixed": ["AUDIT-A1","AUDIT-B1"]}}\n```',
				rounds: 2,
			},
		});
		expect(missing.problems.some((problem) => problem.includes("baseline collect ledger"))).toBe(true);
		// an invented ANSWER defect id (absent from the dump) is rejected
		const invented = checkTaskSuccess(
			prManager,
			prAnswer({ state: "done", defects: [...REVIEW_ISSUE_IDS, "AUDIT-Z9"] }),
			null,
			{
				arm: "baseline",
				baselineLedger,
			},
		);
		expect(
			invented.problems.some((problem) =>
				problem.includes("AUDIT-Z9 is not present in the baseline collect ledger"),
			),
		).toBe(true);
		// a self-reported ROUNDS the dump does not carry is rejected
		const wrongRounds = checkTaskSuccess(prManager, prAnswer({ state: "done", rounds: 3 }), null, {
			arm: "baseline",
			baselineLedger,
		});
		expect(
			wrongRounds.problems.some((problem) =>
				problem.includes("rounds 3 is not present in the baseline collect ledger"),
			),
		).toBe(true);
	});
});

describe("replay checker", () => {
	it("accepts the three reference ledgers with stable identities and full accounting", () => {
		for (const ledger of [reviewSweepLedger(), residentLedger(), escalationLedger()]) {
			const result = checkReplayLedger(ledger);
			expect(result.problems).toEqual([]);
			expect(result.ok).toBe(true);
		}
	});

	it("accepts machine-form ledgers with the state-machine event kinds", () => {
		for (const ledger of [prManagerLedger(), waitMachineLedger()]) {
			const result = checkReplayLedger(ledger);
			expect(result.problems).toEqual([]);
			expect(result.ok).toBe(true);
		}
		const wait = waitMachineLedger();
		expect(wait.events.some((event) => event.kind === "wait_settled")).toBe(true);
		expect(wait.events.some((event) => event.kind === "transition_blocked")).toBe(true);
	});

	it("flags a state_entry index gap (dropped or forged entry events)", () => {
		const ledger = prManagerLedger();
		const reviewingEntries = ledger.events.filter(
			(event) => event.kind === "state_entry" && event.node === "reviewing",
		);
		expect(reviewingEntries.map((event) => event.entry)).toEqual([0, 1]);
		reviewingEntries[1]!.entry = 2;
		const result = checkReplayLedger(ledger);
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("state_entry indices are not contiguous"))).toBe(true);
		// the nodes[].entries report must match the state_entry events too
		const mismatched = prManagerLedger();
		const reported = mismatched.nodes.find((node) => node.id === "reviewing");
		reported!.entries = [{ index: 0, status: "done" }];
		const mismatchResult = checkReplayLedger(mismatched);
		expect(mismatchResult.ok).toBe(false);
		expect(mismatchResult.problems.some((problem) => problem.includes("do not match its state_entry events"))).toBe(
			true,
		);
	});

	it("flags a wait_settled node that spawned instances", () => {
		const ledger = waitMachineLedger();
		const result = checkReplayLedger(ledger);
		expect(result.problems).toEqual([]);
		// the same shape but the "watch" node spawned: impossible, must fail
		const broken = waitMachineLedger();
		broken.nodes[0]!.instances = [instanceFixture(0, "done", { duration_ms: 1_000 })];
		broken.events.splice(3, 0, eventFixture(4, "spawned", { node: "watch", entry: 0, instance: 0 }));
		for (const [position, event] of broken.events.slice(4).entries()) {
			event.seq = 5 + position;
		}
		broken.usage = { spawns: 2, settled: 2, tool_uses: 2, max_parallel: 8, running: 0, transitions_fired: 1 };
		const brokenResult = checkReplayLedger(broken);
		expect(brokenResult.ok).toBe(false);
		expect(brokenResult.problems.some((problem) => problem.includes("settled a wait but spawned"))).toBe(true);
	});

	it("flags transition events missing their from/to endpoints", () => {
		const ledger = prManagerLedger();
		const fired = ledger.events.find((event) => event.kind === "transition_fired");
		if (!fired) throw new Error("fixture lost its transition event");
		const from = fired.from;
		fired.from = undefined;
		const result = checkReplayLedger(ledger);
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("requires from and to"))).toBe(true);
		fired.from = from;
	});

	it("cross-checks usage.transitions_fired against the transition_fired events", () => {
		const ledger = prManagerLedger();
		const ok = checkReplayLedger(ledger);
		expect(ok.problems.some((problem) => problem.includes("transitions_fired"))).toBe(false);
		const mismatch = prManagerLedger();
		mismatch.usage.transitions_fired = 99;
		const result = checkReplayLedger(mismatch);
		expect(result.problems.some((problem) => problem.includes("usage.transitions_fired"))).toBe(true);
	});

	it("flags transitions that reference unknown states", () => {
		const ledger = waitMachineLedger();
		const fired = ledger.events.find((event) => event.kind === "transition_fired");
		if (!fired) throw new Error("fixture lost its transition event");
		fired.to = "ghost-state";
		const result = checkReplayLedger(ledger);
		expect(result.problems.some((problem) => problem.includes("transitions to unknown state"))).toBe(true);
	});

	it("rejects a ledger that does not match the status shape", () => {
		const result = checkReplayLedger({ hello: "world" });
		expect(result.ok).toBe(false);
		expect(result.problems[0]).toContain("shape");
	});

	it("flags a settled-done event without a duration", () => {
		const ledger = reviewSweepLedger();
		const settled = ledger.events.find((event) => event.kind === "settled");
		if (!settled) throw new Error("fixture lost its settled event");
		settled.duration_ms = undefined;
		const result = checkReplayLedger(ledger);
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("without a duration_ms"))).toBe(true);
	});

	it("flags non-increasing and duplicate event seqs", () => {
		const ledger = reviewSweepLedger();
		ledger.events[1]!.seq = 1;
		const result = checkReplayLedger(ledger);
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("non-increasing seq"))).toBe(true);
	});

	it("flags a dropped event as a seq gap within the window (1, 2, 4)", () => {
		const ledger = reviewSweepLedger();
		// Drop event 3 (a spawned) and renumber nothing: the gap 2 -> 4 must fail even
		// though every remaining seq is strictly increasing and unique.
		const dropped = ledger.events.filter((event) => event.seq !== 3);
		expect(dropped.map((event) => event.seq).slice(0, 4)).toEqual([1, 2, 4, 5]);
		const result = checkReplayLedger({ ...ledger, events: dropped });
		expect(result.ok).toBe(false);
		expect(result.problems.some((problem) => problem.includes("seq gap"))).toBe(true);
		expect(result.problems.some((problem) => problem.includes("expected 3, got 4"))).toBe(true);
	});

	it("accepts a retry ledger: two settled events on one spawned key match usage.settled", () => {
		// A retried builder node: first attempt fails (settled error with duration),
		// the retry event re-spawns, the second attempt settles done. The executor's
		// settle_count increments per settlement, so usage.settled is 2 — the checker
		// must count settled EVENTS, not distinct keys.
		const ledger = statusLedgerFixture({
			spec_id: "swarm-dag-eval-builder",
			state: "done",
			nodes: [
				nodeFixture("builder-1", "done", {
					attempts: 2,
					instances: [instanceFixture(-1, "done", { attempt: 2, duration_ms: 9_000 })],
				}),
			],
			events: [
				eventFixture(1, "run_started"),
				eventFixture(2, "node_ready", { node: "builder-1" }),
				eventFixture(3, "spawned", { node: "builder-1", instance: -1 }),
				eventFixture(4, "settled", {
					node: "builder-1",
					instance: -1,
					status: "error",
					error: "child error",
					duration_ms: 8_000,
				}),
				eventFixture(5, "retry", { node: "builder-1", instance: -1 }),
				eventFixture(6, "spawned", { node: "builder-1", instance: -1 }),
				eventFixture(7, "settled", { node: "builder-1", instance: -1, status: "done", duration_ms: 9_000 }),
				eventFixture(8, "answer_captured", { node: "builder-1", instance: -1 }),
				eventFixture(9, "milestone", { milestone: "finished" }),
			],
			usage: { spawns: 2, settled: 2, tool_uses: 2, max_parallel: 8, running: 0 },
		});
		const result = checkReplayLedger(ledger);
		expect(result.problems).toEqual([]);
		expect(result.ok).toBe(true);
		// The old distinct-key count would have reported settled 1 != usage.settled 2.
		const distinctKeyLedger = { ...ledger, usage: { ...ledger.usage, settled: 1 } };
		const mismatch = checkReplayLedger(distinctKeyLedger);
		expect(mismatch.problems.some((problem) => problem.includes("usage.settled"))).toBe(true);
	});

	it("flags unknown event kinds and stages", () => {
		const ledger = reviewSweepLedger();
		ledger.events[0] = eventFixture(1, "teleported");
		const kindResult = checkReplayLedger(ledger);
		expect(kindResult.problems.some((problem) => problem.includes("unknown kind"))).toBe(true);
		const staged = reviewSweepLedger();
		staged.events[0] = eventFixture(1, "run_started", { stage: "vaporized" });
		const stageResult = checkReplayLedger(staged);
		expect(stageResult.problems.some((problem) => problem.includes("unknown stage"))).toBe(true);
	});

	it("flags usage counts that disagree with the event stream", () => {
		const ledger = reviewSweepLedger();
		ledger.usage = { spawns: 99, settled: 6, tool_uses: 6, max_parallel: 8, running: 0 };
		const result = checkReplayLedger(ledger);
		expect(result.problems.some((problem) => problem.includes("usage.spawns"))).toBe(true);
	});

	it("flags a done run without a finished milestone", () => {
		const ledger = reviewSweepLedger();
		ledger.events = ledger.events.filter((event) => event.kind !== "milestone");
		const result = checkReplayLedger(ledger);
		expect(result.problems.some((problem) => problem.includes("finished milestone"))).toBe(true);
	});

	it("flags a spawned instance that never settles on a completed run", () => {
		const ledger = reviewSweepLedger();
		// Drop the report node's settle+answer events and mark it done: unaccounted spawn.
		ledger.events = ledger.events.filter(
			(event) => !(event.node === "report" && ["settled", "answer_captured"].includes(event.kind)),
		);
		const result = checkReplayLedger(ledger);
		expect(result.problems.some((problem) => problem.includes("never settled or cancelled"))).toBe(true);
	});

	it("notes a truncated event window instead of asserting counts", () => {
		const ledger = reviewSweepLedger();
		ledger.events = ledger.events.slice(10);
		ledger.events = ledger.events.map((event, index) => ({ ...event, seq: 11 + index }));
		const result = checkReplayLedger(ledger);
		expect(result.problems.some((problem) => problem.includes("truncated"))).toBe(true);
		expect(result.problems.some((problem) => problem.includes("usage.spawns"))).toBe(false);
	});

	it("runs over a saved report.json and a bare ledger", () => {
		const trial = (ledger: SwarmStatusLedger | null): SwarmDagEvalTrialResult =>
			({
				swarm: "review-sweep",
				arm: "swarm",
				trial: 1,
				ledger,
			}) as SwarmDagEvalTrialResult;
		const report = runReplayChecks({ trials: [trial(reviewSweepLedger()), trial(null)] });
		expect(report.ok).toBe(true);
		expect(report.ledgers).toHaveLength(1);
		const bare = runReplayChecks(residentLedger());
		expect(bare.ok).toBe(true);
		expect(bare.ledgers[0]?.id).toBe("ledger");
	});
});

describe("computeVerdicts", () => {
	const trial = (overrides: Partial<SwarmDagEvalTrialResult>): SwarmDagEvalTrialResult => ({
		swarm: "review-sweep",
		arm: "swarm",
		trial: 1,
		model: "internal/glm-5.2-fast",
		taskSuccess: true,
		problems: [],
		state: "done",
		wallMs: 1_000,
		contextTokens: null,
		totalTokens: 1,
		declaredFanIn: 4,
		queueLatencyMs: null,
		teardownLatencyMs: null,
		declaredBudgetMs: 900_000,
		budgetOvershootMs: 0,
		elapsedMs: null,
		spawns: null,
		settled: null,
		replayOk: null,
		replayProblems: [],
		answer: null,
		ledger: null,
		verdict: "pass",
		...overrides,
	});

	it("excludes the escalation and dry-run probes from the budget sum", () => {
		const verdicts = computeVerdicts([
			trial({ swarm: "review-sweep", budgetOvershootMs: 1_000 }),
			trial({ swarm: "review-sweep-fail", budgetOvershootMs: 50_000, verdict: "pass" }),
			trial({ swarm: "dry-run-reject", budgetOvershootMs: 70_000, verdict: "pass" }),
		]);
		expect(verdicts.budgetOvershootMs).toBe(1_000);
		expect(verdicts.budgetOvershootZero).toBe(false);
		expect(verdicts.failurePolicyMatched).toBe(true);
		expect(verdicts.dryRunRejected).toBe(true);
		const clean = computeVerdicts([
			trial({ swarm: "review-sweep", budgetOvershootMs: 0 }),
			trial({ swarm: "review-sweep-fail", budgetOvershootMs: 123, verdict: "fail" }),
			trial({ swarm: "dry-run-reject", budgetOvershootMs: 456, verdict: "fail" }),
		]);
		expect(clean.budgetOvershootMs).toBe(0);
		expect(clean.budgetOvershootZero).toBe(true);
		expect(clean.failurePolicyMatched).toBe(false);
		expect(clean.dryRunRejected).toBe(false);
	});

	it("reports null probe verdicts when the probes did not run", () => {
		const verdicts = computeVerdicts([trial({ swarm: "review-sweep" })]);
		expect(verdicts.failurePolicyMatched).toBeNull();
		expect(verdicts.dryRunRejected).toBeNull();
	});

	it("averages context tokens per pair and flags lower only when measured", () => {
		const verdicts = computeVerdicts([
			trial({ swarm: "review-sweep", trial: 1, contextTokens: 100 }),
			trial({ swarm: "review-sweep", trial: 2, contextTokens: 200 }),
			trial({ swarm: "review-sweep", arm: "baseline", trial: 1, contextTokens: 300 }),
			trial({ swarm: "review-sweep", arm: "baseline", trial: 2, contextTokens: 500 }),
		]);
		expect(verdicts.contextPairs).toHaveLength(1);
		const pair = verdicts.contextPairs[0]!;
		expect(pair.swarmContextTokens).toBe(150);
		expect(pair.baselineContextTokens).toBe(400);
		expect(pair.lower).toBe(true);
		expect(pair.bothCorrect).toBe(true);

		const higher = computeVerdicts([
			trial({ swarm: "review-sweep", contextTokens: 900 }),
			trial({ swarm: "review-sweep", arm: "baseline", contextTokens: 800 }),
		]);
		expect(higher.contextPairs[0]!.lower).toBe(false);

		const unknown = computeVerdicts([
			trial({ swarm: "review-sweep", contextTokens: null }),
			trial({ swarm: "review-sweep", arm: "baseline", contextTokens: 800 }),
		]);
		expect(unknown.contextPairs[0]!.lower).toBeNull();

		const incorrect = computeVerdicts([
			trial({ swarm: "review-sweep", contextTokens: 100, taskSuccess: false, verdict: "fail" }),
			trial({ swarm: "review-sweep", arm: "baseline", contextTokens: 800 }),
		]);
		expect(incorrect.contextPairs[0]!.bothCorrect).toBe(false);
	});

	it("keeps the static no-orchestration verdict asserted", () => {
		expect(computeVerdicts([trial({ swarm: "review-sweep" })]).noOrchestrationCode).toBe(true);
	});
});

describe("args and report rendering", () => {
	it("parses args with defaults and clamps the width", () => {
		const defaults = parseEvalArgs([]);
		expect(defaults).not.toHaveProperty("error");
		if ("error" in defaults) throw new Error("unreachable");
		expect(defaults.model).toBe("internal/glm-5.2-fast");
		expect(defaults.swarms).toEqual(["review-sweep", "builder", "resident-watcher"]);
		expect(defaults.width).toBe(6);
		expect(defaults.outDir).toContain("swarm-dag-eval-reports/");
		const clamped = parseEvalArgs(["--width", "99", "--swarms", "builder,review-sweep", "--trials", "3"]);
		if ("error" in clamped) throw new Error("unreachable");
		expect(clamped.width).toBe(12);
		expect(clamped.swarms).toEqual(["builder", "review-sweep"]);
		expect(clamped.trials).toBe(3);
		expect(parseEvalArgs(["--nope"])).toEqual({ error: "Unknown argument: --nope" });
		// A typo in --swarms must fail before any token is spent.
		const typo = parseEvalArgs(["--swarms", "review-swep"]);
		expect("error" in typo).toBe(true);
		if ("error" in typo) expect(typo.error).toContain("Unknown swarm in --swarms: review-swep");
		const mixed = parseEvalArgs(["--swarms", "builder,review-swep"]);
		expect("error" in mixed).toBe(true);
	});

	it("renders the markdown table, pair comparison, and verdict rules", () => {
		const config: EvalConfig = {
			model: "internal/glm-5.2-fast",
			swarms: ["review-sweep"],
			width: 4,
			trials: 1,
			timeoutMinutes: 20,
			outDir: "out",
		};
		const result = (
			arm: "swarm" | "baseline",
			contextTokens: number | null,
			ok: boolean,
		): SwarmDagEvalTrialResult => ({
			swarm: "review-sweep",
			arm,
			trial: 1,
			model: config.model,
			taskSuccess: ok,
			problems: ok ? [] : ["planted issue AUDIT-A1 missing from the ANSWER line"],
			state: "done",
			wallMs: 12_345,
			contextTokens,
			totalTokens: 9_999,
			declaredFanIn: 4,
			queueLatencyMs: null,
			teardownLatencyMs: null,
			declaredBudgetMs: 900_000,
			budgetOvershootMs: 0,
			elapsedMs: 100_000,
			spawns: 6,
			settled: 6,
			replayOk: arm === "swarm" ? true : null,
			replayProblems: [],
			answer: null,
			ledger: null,
			verdict: ok ? "pass" : "fail",
		});
		const markdown = renderMarkdownReport([result("swarm", 10_000, true), result("baseline", 20_000, false)], config);
		expect(markdown).toContain("# Swarm DAG capability eval report");
		expect(markdown).toContain("over budget ms*");
		expect(markdown).toContain("budget overshoot is measured per arm and is not directly comparable*");
		expect(markdown).toContain("| review-sweep | swarm | 1 | ok | done |");
		expect(markdown).toContain("| review-sweep | baseline | 1 | failed | done |");
		expect(markdown).toContain("| review-sweep | 10000 | 20000 | yes | no |");
		expect(markdown).toContain(
			"no task-specific orchestration code in swarm prompts (asserted statically, prompt invariant): PASS",
		);
		expect(markdown).toContain("declared failure policy matches observed behavior (escalation): (not run)");
		expect(markdown).toContain("total budget overshoot (swarm arms only): 0 ms (PASS)");
		expect(markdown).toContain("- review-sweep/baseline/trial 1: planted issue AUDIT-A1 missing");
	});
});
