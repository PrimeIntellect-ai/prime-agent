import type { ChildProcess } from "node:child_process";
import type * as PiAi from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	compileActionSpace,
	compileDecisionPrompt,
	createModelDecisionFunction,
	ESCALATE_ACTION,
	FINISH_ACTION,
	formatHistoryEntry,
	gateThreshold,
	observationDigest,
	parseDecision,
	parseEnvironmentActions,
	parseSystemRouterRunSpec,
	type RouterActionSpec,
	type RouterDecisionOutcome,
	type RouterEnvironment,
	type RouterObservation,
	type RouterSegmentEnvironment,
	runRouterSegment,
	runSystemRouterLoop,
	StdioRouterEnvironment,
	truncateObservation,
} from "../src/core/system-router/index.js";
import { isProcessAlive, waitForChildProcess } from "../src/utils/child-process.js";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof PiAi>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

const PRESS_ACTIONS: Record<string, RouterActionSpec> = {
	press_a: { description: "Press the A button." },
	read_menu: { description: "Read the menu.", risk: "read" },
	press_b: { description: "Press the B button.", risk: "destructive" },
	set_power: {
		description: "Set the power level.",
		risk: "write",
		params: { power: { choices: { low: "Slow but safe", high: "Fast but risky", "low}": "Brace-bearing." } } },
	},
};

class FakeEnvironment implements RouterSegmentEnvironment {
	resetCalls = 0;
	closeCalls = 0;
	observeCalls = 0;
	executeLog: Array<[string, Record<string, string>]> = [];
	observations: RouterObservation[];
	executionResults: string[];
	terminalAfterExecute = Infinity;
	throwOnObserve: Error | undefined;
	throwOnExecute: Error | undefined;

	constructor(observations: string[], executionResults: string[] = []) {
		this.observations = observations.map((text) => ({ text }));
		this.executionResults = executionResults;
	}

	initCalls = 0;

	async init(): Promise<Record<string, unknown> | undefined> {
		this.initCalls += 1;
		return undefined;
	}

	async reset(): Promise<void> {
		this.resetCalls += 1;
	}

	async observe(): Promise<RouterObservation> {
		this.observeCalls += 1;
		if (this.throwOnObserve) throw this.throwOnObserve;
		const observation = this.observations[Math.min(this.observeCalls - 1, this.observations.length - 1)];
		return { ...observation };
	}

	async execute(action: string, params: Record<string, string>): Promise<{ text: string }> {
		if (this.throwOnExecute) throw this.throwOnExecute;
		this.executeLog.push([action, params]);
		const executions = this.executeLog.length;
		const text = this.executionResults[Math.min(executions - 1, this.executionResults.length - 1)] ?? `${action} ok`;
		return { text, ...(executions >= this.terminalAfterExecute ? { terminal: true } : {}) };
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
	}
}

function decision(outcome: Partial<RouterDecisionOutcome>): RouterDecisionOutcome {
	return { action: null, params: {}, confidence: null, rawText: "", ...outcome };
}

/** A decide function that replays outcomes; the last entry repeats. */
function scriptedDecide(outcomes: RouterDecisionOutcome[]) {
	let index = 0;
	return async () => {
		const outcome = outcomes[Math.min(index, outcomes.length - 1)];
		index += 1;
		return { ...outcome };
	};
}

interface LoopOverrides {
	decide?: (request: unknown) => Promise<RouterDecisionOutcome>;
	goal?: string;
	maxSteps?: number;
	timeoutMs?: number;
	actions?: Record<string, RouterActionSpec>;
	gate?: { read?: number; write?: number; destructive?: number; finish?: number };
	signal?: AbortSignal;
}

function runLoop(env: RouterEnvironment, overrides: LoopOverrides = {}) {
	const model = { id: "faux-fast", provider: "faux", input: [], thinkingLevel: "off" };
	return runSystemRouterLoop({
		env,
		goal: overrides.goal ?? "Finish the demo",
		actions: overrides.actions ?? PRESS_ACTIONS,
		decide: overrides.decide ?? scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]),
		model,
		...(overrides.gate ? { gate: overrides.gate } : {}),
		...(overrides.signal ? { signal: overrides.signal } : {}),
		maxSteps: overrides.maxSteps ?? 10,
		timeoutMs: overrides.timeoutMs ?? 30_000,
	});
}

afterEach(() => {
	completeSimpleMock.mockReset();
});

describe("parseSystemRouterRunSpec", () => {
	const valid = {
		goal: "Play the game",
		environment: { stdio: { command: ["node", "adapter.mjs"] } },
	};

	it.each<[string, unknown, string | null]>([
		["minimal spec", valid, null],
		["with model and budgets", { ...valid, model: "internal/glm-5.3-fast", maxSteps: 5, timeoutMs: 1_000 }, null],
		["with actions", { ...valid, actions: { press_a: { description: "Press A." } } }, null],
		[
			"with env init payload",
			{ ...valid, environment: { stdio: { command: ["node", "a.mjs"], init: { romPath: "/x" } } } },
			null,
		],
		["non-string model", { ...valid, model: 3 }, "model must be a non-empty string"],
		["non-object payload", null, "payload must be an object"],
		["empty goal", { ...valid, goal: " " }, "goal must be a non-empty string"],
		["missing environment", { goal: "g" }, "environment must be an object with a stdio adapter"],
		[
			"empty command",
			{ ...valid, environment: { stdio: { command: [] } } },
			"command must be a non-empty string array",
		],
		[
			"non-string command entry",
			{ ...valid, environment: { stdio: { command: ["node", 3] } } },
			"command must be a non-empty string array",
		],
		["empty actions object", { ...valid, actions: {} }, "actions must be a non-empty object"],
		[
			"non-snake-case action name",
			{ ...valid, actions: { PressA: { description: "x" } } },
			"must be lowercase snake_case",
		],
		[
			"reserved action name",
			{ ...valid, actions: { finish: { description: "x" } } },
			"is reserved for the loop itself",
		],
		[
			"reserved escalate name",
			{ ...valid, actions: { escalate: { description: "x" } } },
			"is reserved for the loop itself",
		],
		["proto action name", { ...valid, actions: JSON.parse('{"__proto__":{"description":"x"}}') }, "is reserved"],
		[
			"proto param name",
			{ ...valid, actions: JSON.parse('{"p":{"description":"x","params":{"__proto__":{"choices":{"v":"d"}}}}}') },
			"is reserved",
		],
		["missing action description", { ...valid, actions: { press_a: {} } }, "description must be a non-empty string"],
		[
			"bad risk",
			{ ...valid, actions: { press_a: { description: "x", risk: "extreme" } } },
			'must be "read", "write", or "destructive"',
		],
		[
			"non-finite param choices",
			{ ...valid, actions: { press_a: { description: "x", params: { p: {} } } } },
			"must declare a non-empty finite choices set",
		],
		[
			"empty param choice value",
			{ ...valid, actions: { press_a: { description: "x", params: { p: { choices: { "": "d" } } } } } },
			"has an empty choice value",
		],
		[
			"param choice missing description",
			{ ...valid, actions: { press_a: { description: "x", params: { p: { choices: { v: "" } } } } } },
			"needs a non-empty description",
		],
		["gate out of range", { ...valid, gate: { read: 1.5 } }, "gate.read must be a number in [0, 1]"],
		["maxSteps zero", { ...valid, maxSteps: 0 }, "maxSteps must be a whole number in [1, 200]"],
		["maxSteps over cap", { ...valid, maxSteps: 201 }, "maxSteps must be a whole number in [1, 200]"],
		["timeoutMs over cap", { ...valid, timeoutMs: 600_001 }, "timeoutMs must be a whole number in [1, 600000]"],
		["historySteps over cap", { ...valid, historySteps: 33 }, "historySteps must be a whole number in [1, 32]"],
		[
			"observationChars zero",
			{ ...valid, observationChars: 0 },
			"observationChars must be a whole number in [1, 32000]",
		],
		[
			"fractional maxSteps floors to zero",
			{ ...valid, maxSteps: 0.5 },
			"maxSteps must be a whole number in [1, 200]",
		],
		["fractional maxSteps 1.9 rejected", { ...valid, maxSteps: 1.9 }, "maxSteps must be a whole number in [1, 200]"],
		[
			"fractional timeoutMs 1000.5 rejected",
			{ ...valid, timeoutMs: 1_000.5 },
			"timeoutMs must be a whole number in [1, 600000]",
		],
		[
			"fractional timeoutMs floors to zero",
			{ ...valid, timeoutMs: 0.5 },
			"timeoutMs must be a whole number in [1, 600000]",
		],
		[
			"fractional historySteps floors to zero",
			{ ...valid, historySteps: 0.5 },
			"historySteps must be a whole number in [1, 32]",
		],
	])("%s %s", (_label, payload, errorFragment) => {
		if (errorFragment === null) {
			expect(() => parseSystemRouterRunSpec(payload)).not.toThrow();
		} else {
			expect(() => parseSystemRouterRunSpec(payload)).toThrow(errorFragment);
		}
	});

	it("applies default budgets", () => {
		const spec = parseSystemRouterRunSpec(valid);
		expect(spec.maxSteps).toBe(25);
		expect(spec.timeoutMs).toBe(120_000);
		expect(spec.historySteps).toBe(8);
		expect(spec.observationChars).toBe(6_000);
		expect(spec.environment.stdio.requestTimeoutMs).toBe(30_000);
	});
});

describe("parseDecision", () => {
	const { byName } = compileActionSpace(PRESS_ACTIONS);

	it.each<[string, string, Partial<RouterDecisionOutcome>]>([
		["valid action", '{"action":"press_a","params":{},"confidence":0.8}', { action: "press_a", confidence: 0.8 }],
		["finish", '{"action":"finish","confidence":0.9}', { action: FINISH_ACTION, confidence: 0.9 }],
		["escalate", '{"action":"escalate","confidence":0.4}', { action: ESCALATE_ACTION, confidence: 0.4 }],
		[
			"param in choices",
			'{"action":"set_power","params":{"power":"low"},"confidence":0.7}',
			{ action: "set_power", params: { power: "low" }, confidence: 0.7 },
		],
		["fenced json", '```json\n{"action":"press_b","confidence":0.6}\n```', { action: "press_b", confidence: 0.6 }],
		["prose-wrapped json", 'Sure! {"action":"press_a","confidence":1} done', { action: "press_a", confidence: 1 }],
		["free text", "press A please", { action: null, parseError: "reply was not a JSON object" }],
		["array not object", '["press_a"]', { action: null, parseError: "reply was not a JSON object" }],
		[
			"unknown action",
			'{"action":"press_x","confidence":0.9}',
			{ action: null, parseError: 'unknown action "press_x"' },
		],
		["missing action", '{"confidence":0.9}', { action: null, parseError: "unknown action null" }],
		[
			"unknown param",
			'{"action":"press_a","params":{"other":"x"},"confidence":0.9}',
			{ action: null, parseError: 'unknown param "other" for action "press_a"' },
		],
		[
			"param value not in choices",
			'{"action":"set_power","params":{"power":"turbo"},"confidence":0.9}',
			{ action: null, parseError: 'param "power" value must be one of its declared choices' },
		],
		[
			"params not object",
			'{"action":"press_a","params":"x","confidence":0.9}',
			{ action: null, parseError: "params must be an object" },
		],
		[
			"missing declared param",
			'{"action":"set_power","confidence":0.9}',
			{ action: null, parseError: 'missing param(s) power for action "set_power"' },
		],

		[
			"valid json followed by braced prose",
			'{"action":"press_a","confidence":0.9} (note: use {"action":"finish"} for done)',
			{ action: "press_a", confidence: 0.9 },
		],
		["stray trailing brace", '{"action":"press_b","confidence":0.7}\n}', { action: "press_b", confidence: 0.7 }],
		[
			"brace in a choice with braced prose",
			'Sure! {"action":"set_power","params":{"power":"low}"},"confidence":0.7} (or {"action":"finish"} later)',
			{ action: "set_power", params: { power: "low}" }, confidence: 0.7 },
		],
		["prose braces then choice", 'a {x} b {"action":"press_a","confidence":1}', { action: "press_a", confidence: 1 }],
		["draft then choice", 'a {"t":1} b {"action":"press_a","confidence":1}', { action: "press_a", confidence: 1 }],
		["refusal from the first object", 'x {"t":1} then {"action":"press_a"}', { parseError: "unknown action null" }],
		[
			"unclosed brace before the choice",
			'a { b {"action":"press_a","confidence":1}',
			{ action: "press_a", confidence: 1 },
		],
		[
			"missing confidence",
			'{"action":"press_a"}',
			{ action: null, parseError: "confidence must be a number in [0, 1]" },
		],
		[
			"confidence too high",
			'{"action":"press_a","confidence":1.2}',
			{ action: null, parseError: "confidence must be a number in [0, 1]" },
		],
		[
			"confidence not number",
			'{"action":"press_a","confidence":"high"}',
			{ action: null, parseError: "confidence must be a number in [0, 1]" },
		],
	])("%s", (_label, raw, expected) => {
		const outcome = parseDecision(raw, byName);
		expect({
			action: outcome.action,
			params: outcome.params,
			confidence: outcome.confidence,
			parseError: outcome.parseError,
		}).toMatchObject(expected);
	});

	it("reports an omitted parameter named like a prototype member as missing", () => {
		const { byName: own } = compileActionSpace({
			press_a: { description: "P.", params: { constructor: { choices: { v: "Pick." } } } },
		});
		const outcome = parseDecision('{"action":"press_a","confidence":0.9}', own);
		expect(outcome.action).toBeNull();
		expect(outcome.parseError).toBe('missing param(s) constructor for action "press_a"');
	});
});

describe("action space compilation", () => {
	const { byName } = compileActionSpace(PRESS_ACTIONS);

	it("appends finish and escalate to the declared space", () => {
		expect(byName.has(FINISH_ACTION)).toBe(true);
		expect(byName.has(ESCALATE_ACTION)).toBe(true);
		expect(byName.get("press_b")?.risk).toBe("destructive");
		expect(byName.get("press_a")?.risk).toBe("write");
	});

	it.each<[string, string, number, Record<string, number>]>([
		["write default", "press_a", 0.6, {}],
		["read default", "read_menu", 0.5, {}],
		["write gate override", "press_a", 0.9, { write: 0.9 }],
		["destructive default", "press_b", 0.8, {}],
		["finish default", FINISH_ACTION, 0.5, {}],
		["finish override", FINISH_ACTION, 0.7, { finish: 0.7 }],
	])("gate threshold: %s", (_label, action, expected, gate) => {
		const compiled = byName.get(action);
		if (!compiled) throw new Error("missing action");
		expect(gateThreshold(gate, compiled)).toBe(expected);
	});

	it("compileDecisionPrompt carries goal, observation, fields, actions, and format", () => {
		const prompt = compileDecisionPrompt({
			goal: "Leave the house",
			observation: { text: "Mom is talking.", fields: { ram: 12 } },
			history: ["press_a() -> screen advanced"],
			actions: byName,
			observationChars: 6_000,
		});
		expect(prompt).toContain("Leave the house");
		expect(prompt).toContain("Mom is talking.");
		expect(prompt).toContain("ram: 12");
		expect(prompt).toContain("- press_a [risk=write]: Press the A button.");
		expect(prompt).toContain('param "power"');
		expect(prompt).toContain('"low" (Slow but safe)');
		expect(prompt).toContain("- finish [risk=read]");
		expect(prompt).toContain("- escalate [risk=read]");
		expect(prompt).toContain("press_a() -> screen advanced");
		expect(prompt).toContain('"action"');
		expect(prompt).toContain('"confidence"');
	});

	it("honors a tiny observationChars budget", () => {
		const prompt = compileDecisionPrompt({
			goal: "g",
			observation: { text: "y".repeat(10_000) },
			history: [],
			actions: compileActionSpace({ press_a: { description: "d" } }).byName,
			observationChars: 1,
		});
		expect(prompt).not.toContain("yyyyyy");
	});

	it("bounds the rendered observation (text plus fields) by the budget", () => {
		const fields = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`field_${i}`, "x".repeat(500)]));
		const prompt = compileDecisionPrompt({
			goal: "g",
			observation: { text: "y".repeat(10_000), fields },
			history: [],
			actions: compileActionSpace({ press_a: { description: "d" } }).byName,
			observationChars: 6_000,
		});
		expect(prompt.length).toBeLessThan(6_000 + 3_000);
		expect(prompt).toContain("more fields truncated");
		expect(prompt).toContain("field_0:");
	});

	it("truncates the observation to the budget", () => {
		const long = "x".repeat(100);
		expect(truncateObservation(long, 50).length).toBeLessThanOrEqual(50);
		expect(truncateObservation(long, 50)).toContain("<observation truncated>");
		expect(truncateObservation("short", 50)).toBe("short");
	});

	it("observation digest changes with content and history lines stay bounded", () => {
		expect(observationDigest({ text: "a" })).not.toBe(observationDigest({ text: "b" }));
		expect(observationDigest({ text: "a" })).toBe(observationDigest({ text: "a" }));
		expect(observationDigest({ text: "s", fields: { x: 1, y: 2 } })).toBe(
			observationDigest({ text: "s", fields: { y: 2, x: 1 } }),
		);
		expect(formatHistoryEntry("press_a", {}, "r".repeat(300))).toBe(`press_a() -> ${"r".repeat(157)}...`);
		expect(formatHistoryEntry("set_power", { power: "low" }, "ok")).toBe('set_power(power="low") -> ok');
	});
});

describe("runSystemRouterLoop", () => {
	it("executes gated decisions and stops on environment terminal state", async () => {
		const env = new FakeEnvironment(["intro screen", "overworld"]);
		env.terminalAfterExecute = 2;
		const result = await runLoop(env);
		expect(result.status).toBe("done");
		expect(result.reason).toBe("environment_terminal");
		expect(result.executed).toBe(2);
		expect(result.refused).toBe(0);
		expect(env.resetCalls).toBe(1);
		expect(env.closeCalls).toBe(1);
		expect(env.executeLog).toEqual([
			["press_a", {}],
			["press_a", {}],
		]);
	});

	it("records a complete trace entry per step and sums usage", async () => {
		const env = new FakeEnvironment(["screen 1", "screen 2"]);
		const decide = scriptedDecide([
			decision({ action: "press_a", confidence: 0.9, usage: { inputTokens: 10, outputTokens: 2 } }),
			decision({ action: FINISH_ACTION, confidence: 0.95, usage: { inputTokens: 11, outputTokens: 3 } }),
		]);
		const result = await runLoop(env, { decide });
		expect(result.status).toBe("done");
		expect(result.reason).toBe("goal_reached");
		expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 5 });
		expect(result.trace).toHaveLength(2);
		const step = result.trace[0];
		expect(step).toMatchObject({
			action: "press_a",
			params: {},
			confidence: 0.9,
			gate: { threshold: 0.6, verdict: "pass" },
			observationDigest: observationDigest({ text: "screen 1" }),
		});
		expect(typeof step.latencyMs).toBe("number");
		expect(result.trace[1].terminal).toBe(true);
		expect(result.summary).toContain("step 1");
	});

	it("passes params through to the environment", async () => {
		const env = new FakeEnvironment(["screen"]);
		const decide = scriptedDecide([decision({ action: "set_power", params: { power: "low" }, confidence: 0.9 })]);
		await runLoop(env, { decide });
		expect(env.executeLog).toEqual([["set_power", { power: "low" }]]);
	});

	it("refuses below the gate, resets the streak on a pass, and never executes refused actions", async () => {
		const env = new FakeEnvironment(["screen 1", "screen 2", "screen 3"]);
		const decide = scriptedDecide([
			decision({ action: "press_b", confidence: 0.5 }), // below destructive 0.8
			decision({ action: "press_a", confidence: 0.7 }), // above write 0.6
			decision({ action: FINISH_ACTION, confidence: 1 }),
		]);
		const result = await runLoop(env, { decide });
		expect(result.status).toBe("done");
		expect(result.refused).toBe(1);
		expect(result.executed).toBe(1);
		expect(env.executeLog).toEqual([["press_a", {}]]);
		const refused = result.trace[0];
		expect(refused.gate.verdict).toBe("refused");
		expect(refused.action).toBe("press_b");
		expect(refused.result).toContain("below destructive gate 0.80");
	});

	it("stops as stuck after the refusal streak and escalates when asked", async () => {
		const stuckEnv = new FakeEnvironment(["screen"]);
		const stuck = await runLoop(stuckEnv, {
			decide: scriptedDecide([decision({ action: "press_b", confidence: 0.5 })]),
		});
		expect(stuck.status).toBe("stuck");
		expect(stuck.reason).toBe("no_confident_decision");
		expect(stuck.executed).toBe(0);

		const escalEnv = new FakeEnvironment(["screen"]);
		const escalated = await runLoop(escalEnv, {
			decide: scriptedDecide([decision({ action: ESCALATE_ACTION, confidence: 0.3 })]),
		});
		expect(escalated.status).toBe("escalated");
		expect(escalated.reason).toBe("escalation_requested");
	});

	it("counts parse failures in the refusal streak without executing", async () => {
		const env = new FakeEnvironment(["screen 1", "screen 2", "screen 3"]);
		const decide = scriptedDecide([decision({ parseError: "reply was not a JSON object" })]);
		const result = await runLoop(env, { decide });
		expect(result.status).toBe("stuck");
		expect(result.reason).toBe("no_confident_decision");
		expect(env.executeLog).toEqual([]);
		expect(result.trace[0].gate.verdict).toBe("parse_failure");
		expect(result.trace[0].result).toContain("refused:");
	});

	it("stops as stuck when the same action repeats on the same observation", async () => {
		const env = new FakeEnvironment(["same screen", "same screen", "same screen"]);
		const decide = scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]);
		const result = await runLoop(env, { decide });
		expect(result.status).toBe("stuck");
		expect(result.reason).toBe("repeated_state");
		expect(env.executeLog).toHaveLength(1);
		// The repetition stop is a refusal by the loop, so steps stays consistent.
		expect(result.refused).toBe(1);
		expect(result.steps).toBe(result.executed + result.refused);
	});

	it("flags interleaved repeats without treating colliding distinct param sets as repeats", async () => {
		const env = new FakeEnvironment(["same screen", "same screen", "same screen"]);
		const decide = scriptedDecide([
			decision({ action: "combo", params: { a: "x&b=y" }, confidence: 0.9 }),
			decision({ action: "combo", params: { a: "x", b: "y" }, confidence: 0.9 }),
			decision({ action: "combo", params: { a: "x&b=y" }, confidence: 0.9 }),
		]);
		const actions = {
			combo: {
				description: "Combo.",
				params: { a: { choices: { "x&b=y": "Collide.", x: "Plain x." } }, b: { choices: { y: "Plain y." } } },
			},
		};
		const result = await runLoop(env, { decide, actions });
		expect(result).toMatchObject({ status: "stuck", reason: "repeated_state" });
		expect(env.executeLog).toEqual([
			["combo", { a: "x&b=y" }],
			["combo", { a: "x", b: "y" }],
		]);
	});

	it("fails the run when the environment cannot reset", async () => {
		const env = {
			reset: () => Promise.reject(new Error("no savestate")),
			observe: () => Promise.resolve({ text: "x" }),
			execute: () => Promise.resolve({ text: "y" }),
			close: () => Promise.resolve(),
		};
		const result = await runLoop(env as unknown as RouterEnvironment, {});
		expect(result.status).toBe("failed");
		expect(result.reason).toBe("environment_error");
		expect(result.summary).toContain("no savestate");
	});

	it("parseEnvironmentActions prefers the declared space and validates supplied ones", () => {
		const declared = { press_a: { description: "Declared press." } };
		expect(parseEnvironmentActions(declared, { press_b: { description: "Supplied." } })).toEqual({
			press_a: { description: "Declared press.", risk: "write" },
		});
		const supplied = { wait: { description: "Wait a bit." } };
		expect(parseEnvironmentActions(undefined, supplied)).toEqual({
			wait: { description: "Wait a bit.", risk: "write" },
		});
		expect(parseEnvironmentActions(undefined, undefined)).toBeUndefined();
		expect(() => parseEnvironmentActions(undefined, { finish: { description: "Nope." } })).toThrow(
			"is reserved for the loop itself",
		);
	});

	it("allows the same action twice when the observation moves", async () => {
		const env = new FakeEnvironment(["screen a", "screen b", "screen c"]);
		const decide = scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]);
		env.terminalAfterExecute = 2;
		const result = await runLoop(env, { decide });
		expect(result.status).toBe("done");
		expect(env.executeLog).toHaveLength(2);
	});

	it("ends incomplete at the step budget", async () => {
		const env = new FakeEnvironment(["screen a", "screen b", "screen c"]);
		const result = await runLoop(env, {
			maxSteps: 2,
			decide: scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]),
		});
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("max_steps");
		expect(result.executed).toBe(2);
	});

	it("fails on environment observe errors, execute errors, and decision model errors", async () => {
		const observeEnv = new FakeEnvironment(["x"]);
		observeEnv.throwOnObserve = new Error("bus detached");
		const observeFailure = await runLoop(observeEnv);
		expect(observeFailure.status).toBe("failed");
		expect(observeFailure.reason).toBe("environment_error");
		expect(observeFailure.summary).toContain("bus detached");

		const executeEnv = new FakeEnvironment(["x"]);
		executeEnv.throwOnExecute = new Error("button jammed");
		const executeFailure = await runLoop(executeEnv);
		expect(executeFailure.status).toBe("failed");
		expect(executeFailure.reason).toBe("environment_error");
		expect(executeFailure.summary).toContain("button jammed");
		expect(executeFailure.trace[0]?.result).toContain("outcome unknown");

		const crashEnv = new FakeEnvironment(["x"]);
		const crash = await runLoop(crashEnv, {
			decide: async () => {
				throw new Error("provider exploded");
			},
		});
		expect(crash.status).toBe("failed");
		expect(crash.reason).toBe("decision_model_error");

		const modelEnv = new FakeEnvironment(["x"]);
		const modelFailure = await runLoop(modelEnv, {
			decide: scriptedDecide([decision({ modelError: "decision model failed: 500" })]),
		});
		expect(modelFailure.status).toBe("failed");
		expect(modelFailure.reason).toBe("decision_model_error");
		expect(modelFailure.summary).toContain("500");
	});

	it("reports aborted when the signal fires before the first step", async () => {
		const controller = new AbortController();
		controller.abort();
		const aborted = await runSystemRouterLoop({
			env: new FakeEnvironment(["x"]),
			goal: "g",
			actions: PRESS_ACTIONS,
			decide: scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]),
			model: { id: "m", provider: "p", input: [], thinkingLevel: "off" },
			maxSteps: 3,
			timeoutMs: 30_000,
			signal: controller.signal,
		});
		expect(aborted.status).toBe("failed");
		expect(aborted.reason).toBe("aborted");
	});

	it.each([
		["done", decision({ action: FINISH_ACTION, confidence: 1 })],
		["a model error", decision({ modelError: "decision model stopped early (aborted)" })],
	])("reports aborted instead of %s when the signal fires during the decision", async (_label, outcome) => {
		const controller = new AbortController();
		const result = await runLoop(new FakeEnvironment(["x"]), {
			decide: async (request) => {
				controller.abort();
				// The in-flight decision's retries stop with the external signal.
				expect((request as { signal?: AbortSignal }).signal?.aborted).toBe(true);
				return { ...outcome };
			},
			signal: controller.signal,
		});
		expect(result.reason).toBe("aborted");
	});

	it.each([
		["observe", () => Promise.resolve({ text: "x", terminal: true })],
		["execute", () => Promise.resolve({ text: "x", terminal: true })],
		["a failed execute", () => Promise.reject(new Error("adapter closed"))],
	])("reports aborted when the signal fires during %s", async (phase, settle) => {
		const controller = new AbortController();
		const env = new FakeEnvironment(["x"]);
		const during = async () => {
			controller.abort();
			return settle();
		};
		if (phase === "observe") env.observe = during;
		else env.execute = during;
		expect((await runLoop(env, { signal: controller.signal })).reason).toBe("aborted");
	});

	it("reports the timeout instead of done when the deadline passes during observe", async () => {
		const env = new FakeEnvironment(["x"]);
		env.observe = async () => {
			vi.setSystemTime(new Date(Date.now() + 30_000));
			return { text: "x", terminal: true };
		};
		vi.useFakeTimers();
		try {
			const result = await runLoop(env);
			expect(result.reason).toBe("timeout");
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes the environment even when the loop fails", async () => {
		const env = new FakeEnvironment(["x"]);
		env.throwOnObserve = new Error("nope");
		await runLoop(env);
		expect(env.closeCalls).toBe(1);
	});

	it.each([
		["an empty action space", {}, "action space is empty"],
		["a reserved action name", { finish: { description: "Reserved." } }, "is reserved for the loop itself"],
	])("closes the environment on %s validation errors", async (_label, actions, error) => {
		const env = new FakeEnvironment(["x"]);
		await expect(runLoop(env, { actions })).rejects.toThrow(error);
		expect(env.closeCalls).toBe(1);
	});
});

describe("runRouterSegment wiring", () => {
	const model = {
		id: "seg-model",
		provider: "faux",
		api: "openai-completions",
		reasoning: false,
		maxTokens: 4_096,
		input: ["text"],
	} as unknown as PiAi.Model<PiAi.Api>;

	function segmentEnv(log: string[], supplied: unknown, initError?: Error): RouterSegmentEnvironment {
		let observations = 0;
		return {
			init: async () => {
				log.push("init");
				if (initError) throw initError;
				return supplied === undefined ? undefined : { actions: supplied };
			},
			reset: async () => {
				log.push("reset");
			},
			observe: async () => {
				observations += 1;
				return { text: `seg screen ${observations}` };
			},
			execute: async (action: string) => {
				log.push(`execute:${action}`);
				return { text: `${action} ok` };
			},
			close: async () => {
				log.push("close");
			},
		};
	}

	function queueDecisions(replies: string[]): void {
		for (const reply of replies) {
			completeSimpleMock.mockResolvedValueOnce({
				role: "assistant",
				content: [{ type: "text", text: reply }],
				stopReason: "stop",
				timestamp: Date.now(),
			});
		}
	}

	it("always inits the adapter and prefers the declared action space", async () => {
		const log: string[] = [];
		const spec = parseSystemRouterRunSpec({
			goal: "seg goal",
			actions: { press_a: { description: "Declared." } },
			environment: { stdio: { command: ["true"] } },
			maxSteps: 2,
		});
		queueDecisions(['{"action":"press_a","confidence":0.9}', '{"action":"press_a","confidence":0.9}']);
		const result = await runRouterSegment(spec, {
			model,
			env: segmentEnv(log, { wait: { description: "Supplied." } }),
		});
		expect(log[0]).toBe("init");
		expect(log[log.length - 1]).toBe("close");
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("max_steps");
		expect(result.executed).toBe(2);
	});

	it("uses the adapter-supplied action space when the spec declares none", async () => {
		const log: string[] = [];
		const spec = parseSystemRouterRunSpec({
			goal: "seg goal",
			environment: { stdio: { command: ["true"] } },
			maxSteps: 2,
		});
		queueDecisions(['{"action":"wait","confidence":0.9}', '{"action":"wait","confidence":0.9}']);
		const result = await runRouterSegment(spec, {
			model,
			env: segmentEnv(log, { wait: { description: "Wait a bit." } }),
		});
		expect(result.status).toBe("incomplete");
		expect(log).toContain("init");
		expect(log[log.length - 1]).toBe("close");
		expect(log).toContain("execute:wait");
	});

	it.each<[string, () => Promise<undefined>]>([
		["init never settles", () => new Promise<undefined>(() => {})],
		[
			"init settles after the budget",
			() =>
				Promise.resolve().then(() => {
					vi.setSystemTime(new Date(Date.now() + 5));
					return undefined;
				}),
		],
	])("bounds adapter init by the segment timeout (%s) and still closes the adapter", async (_label, makeInit) => {
		const spec = parseSystemRouterRunSpec({ goal: "g", environment: { stdio: { command: ["true"] } }, timeoutMs: 5 });
		const env = new FakeEnvironment(["x"]);
		(env as unknown as { init: () => Promise<undefined> }).init = makeInit;
		vi.useFakeTimers();
		try {
			const run = runRouterSegment(spec, { model, env: env as unknown as RouterSegmentEnvironment });
			// Attach the rejection handler before advancing any timer.
			run.catch(() => {});
			await vi.advanceTimersByTimeAsync(5);
			await expect(run).rejects.toThrow(/environment adapter init exceeded the segment timeout of 5ms/);
		} finally {
			vi.useRealTimers();
		}
		expect(env.closeCalls).toBe(1);
	});

	it.each([
		["init fails", undefined, new Error("rom not found")],
		["no action space anywhere", undefined, undefined],
	])("closes the adapter when %s", async (_label, supplied, initError) => {
		const log: string[] = [];
		const spec = parseSystemRouterRunSpec({
			goal: "seg goal",
			environment: { stdio: { command: ["true"] } },
		});
		await expect(runRouterSegment(spec, { model, env: segmentEnv(log, supplied, initError) })).rejects.toThrow(
			initError ? "environment adapter init failed: rom not found" : "no action space",
		);
		expect(log).toEqual(["init", "close"]);
	});

	it("passes an abort signal through to the loop without resetting", async () => {
		const spec = parseSystemRouterRunSpec({
			goal: "g",
			actions: { a: { description: "P" } },
			environment: { stdio: { command: ["true"] } },
			timeoutMs: 60,
		});
		const early = new FakeEnvironment(["x"]);
		await runRouterSegment(spec, { model, env: early, signal: AbortSignal.abort() });
		expect(early.initCalls).toBe(0);
		const controller = new AbortController();
		const late = new FakeEnvironment(["x"]);
		late.init = async () => void controller.abort();
		await runRouterSegment(spec, { model, env: late, signal: controller.signal });
		expect(late.resetCalls).toBe(0);
		const pending = new FakeEnvironment(["x"]);
		pending.init = () => new Promise(() => {});
		const pendingController = new AbortController();
		const pendingRun = runRouterSegment(spec, { model, env: pending, signal: pendingController.signal });
		pendingController.abort();
		expect((await pendingRun).reason).toBe("aborted");
		expect(pending.resetCalls).toBe(0);
	});
});

describe("runSystemRouterLoop budgets (fake timers)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ends incomplete when the deadline elapses mid-decision", async () => {
		const env = new FakeEnvironment(["screen"]);
		const never = new Promise<RouterDecisionOutcome>(() => {});
		// The never-settling promise never rejects, but keep it handled anyway.
		void never.catch(() => {});
		const run = runLoop(env, { decide: () => never, timeoutMs: 5_000 });
		// Attach the rejection handler before advancing any timer.
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await run;
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("timeout");
		expect(result.summary).toContain("timeout");
		expect(env.closeCalls).toBe(1);
	});

	it("ends incomplete when the deadline elapses during reset", async () => {
		const env = {
			reset: () => new Promise<void>(() => {}),
			observe: () => Promise.resolve({ text: "x" }),
			execute: () => Promise.resolve({ text: "y" }),
			close: () => Promise.resolve(),
		};
		const run = runLoop(env as unknown as RouterEnvironment, { timeoutMs: 5 });
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(5);
		const result = await run;
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("timeout");
	});

	it("ends incomplete when the losing side rejects after the deadline fires", async () => {
		const env = new FakeEnvironment(["screen"]);
		// The decide call rejects 25ms after the 5ms deadline; its rejection must
		// stay handled (the raceDeadline invariant), not crash the host.
		let lateReject: ((error: Error) => void) | undefined;
		const decide: (request: unknown) => Promise<RouterDecisionOutcome> = () =>
			new Promise<RouterDecisionOutcome>((_, reject) => {
				lateReject = reject;
			});
		const run = runLoop(env, { decide, timeoutMs: 5 });
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(5);
		const result = await run;
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("timeout");
		// The losing promise rejects only now; it was already handled by raceDeadline.
		lateReject?.(new Error("late rejection"));
		await vi.advanceTimersByTimeAsync(0);
	});

	it("ends incomplete when the deadline elapses mid-observe", async () => {
		const env = {
			reset: () => Promise.resolve(),
			observe: () => new Promise<RouterObservation>(() => {}),
			execute: () => Promise.resolve({ text: "" }),
			close: () => Promise.resolve(),
		};
		const run = runLoop(env as unknown as RouterEnvironment, { timeoutMs: 2_000 });
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(2_000);
		const result = await run;
		expect(result.status).toBe("incomplete");
		expect(result.reason).toBe("timeout");
	});

	it("records the dispatched execution with an unknown outcome when the deadline fires mid-execution", async () => {
		const env = {
			reset: () => Promise.resolve(),
			observe: () => Promise.resolve({ text: "screen" }),
			execute: () => new Promise(() => {}),
			close: () => Promise.resolve(),
		};
		const decide = scriptedDecide([decision({ action: "press_a", confidence: 0.9 })]);
		const run = runLoop(env as unknown as RouterEnvironment, { decide, timeoutMs: 5_000 });
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(5_000);
		const result = await run;
		expect(result).toMatchObject({ status: "incomplete", reason: "timeout", executed: 1 });
		expect(result.trace[0]).toMatchObject({ action: "press_a", result: expect.stringContaining("outcome unknown") });
	});

	it("does not dispatch or record an execution once the wall-clock deadline has passed", async () => {
		const env = new FakeEnvironment(["screen"]);
		let resolveDecide: ((value: RouterDecisionOutcome) => void) | undefined;
		const decide = () =>
			new Promise<RouterDecisionOutcome>((resolve) => {
				resolveDecide = resolve;
			});
		const run = runLoop(env, { decide, timeoutMs: 5_000 });
		run.catch(() => {});
		await vi.advanceTimersByTimeAsync(0); // reset + observe + decide started
		vi.setSystemTime(Date.now() + 5_001); // clock past the deadline, timer un-fired
		resolveDecide?.(decision({ action: "press_a", confidence: 0.9 }));
		const result = await run;
		expect(result).toMatchObject({ status: "incomplete", reason: "timeout", executed: 0, steps: 0 });
		expect(env.executeLog).toEqual([]);
	});
});

describe("createModelDecisionFunction", () => {
	const { byName } = compileActionSpace(PRESS_ACTIONS);
	const textModel = {
		id: "glm-fast",
		provider: "internal",
		api: "openai-completions",
		maxTokens: 4_096,
		input: ["text"],
		reasoning: false,
	} as unknown as PiAi.Model<PiAi.Api>;

	function assistant(text: string): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: Date.now(),
		} as AssistantMessage;
	}

	it("makes one call with thinking off, parses the choice, and reports usage", async () => {
		completeSimpleMock.mockResolvedValueOnce(assistant('{"action":"press_a","params":{},"confidence":0.75}'));
		const decide = createModelDecisionFunction({ model: textModel, actions: byName });
		const outcome = await decide({ prompt: "go" });
		expect(outcome.action).toBe("press_a");
		expect(outcome.confidence).toBe(0.75);
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		const [_model, context, options] = completeSimpleMock.mock.calls[0];
		expect(options.reasoning).toBe("off");
		expect(options.maxTokens).toBeLessThanOrEqual(4_096);
		expect(context.systemPrompt).toContain("action model");
		expect(context.messages[0].content[0].text).toBe("go");
		expect(context.messages[0].content).toHaveLength(1);
	});

	it.each([
		[4_096, 4_096],
		[512, 512],
		[131_072, 4_096],
	])(
		"caps decision output at the model ceiling or 4096, whichever is smaller (maxTokens=%d)",
		async (modelMaxTokens, expectedCap) => {
			const model = { ...textModel, maxTokens: modelMaxTokens } as unknown as PiAi.Model<PiAi.Api>;
			completeSimpleMock.mockReset();
			completeSimpleMock.mockResolvedValueOnce(assistant('{"action":"press_a","confidence":0.6}'));
			const decide = createModelDecisionFunction({ model, actions: byName });
			const outcome = await decide({ prompt: "p" });
			expect(outcome.action).toBe("press_a");
			expect(completeSimpleMock.mock.calls[0][2].maxTokens).toBe(expectedCap);
		},
	);

	it("surfaces length and abort stop reasons as model errors, not parse refusals", async () => {
		const decide = createModelDecisionFunction({ model: textModel, actions: byName });
		completeSimpleMock.mockResolvedValueOnce({ ...assistant('{"action":"pre'), stopReason: "length" });
		const truncated = await decide({ prompt: "p" });
		expect(truncated.modelError).toContain("stopped early (length)");
		expect(truncated.action).toBeNull();
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValueOnce({ ...assistant(""), stopReason: "aborted" });
		const aborted = await decide({ prompt: "p" });
		expect(aborted.modelError).toContain("stopped early (aborted)");
	});

	it("attaches the screenshot only for image-capable models", async () => {
		const imageModel = { ...textModel, input: ["text", "image"] } as unknown as PiAi.Model<PiAi.Api>;
		completeSimpleMock.mockResolvedValueOnce(assistant('{"action":"press_a","confidence":0.6}'));
		const textDecide = createModelDecisionFunction({ model: textModel, actions: byName });
		await textDecide({ prompt: "p", image: "aGk=" });
		expect(completeSimpleMock.mock.calls[0][1].messages[0].content).toHaveLength(1);
		completeSimpleMock.mockClear();
		completeSimpleMock.mockResolvedValueOnce(assistant('{"action":"press_a","confidence":0.6}'));
		const imageDecide = createModelDecisionFunction({ model: imageModel, actions: byName });
		await imageDecide({ prompt: "p", image: "aGk=" });
		expect(completeSimpleMock.mock.calls[0][1].messages[0].content).toHaveLength(2);
		expect(completeSimpleMock.mock.calls[0][1].messages[0].content[1]).toMatchObject({ type: "image" });
	});

	it("surfaces model errors as modelError and malformed replies as parseError", async () => {
		completeSimpleMock.mockResolvedValueOnce({
			...assistant(""),
			stopReason: "error",
			errorMessage: "boom 500",
		});
		const decide = createModelDecisionFunction({
			model: textModel,
			actions: byName,
			policy: { enabled: false, maxRetries: 0, baseDelayMs: 0, maxRetryDelayMs: 0 },
		});
		const modelError = await decide({ prompt: "p" });
		expect(modelError.modelError).toContain("boom 500");
		expect(modelError.action).toBeNull();
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValueOnce(assistant("let me press the A button now"));
		const parseFailure = await decide({ prompt: "p" });
		expect(parseFailure.parseError).toBe("reply was not a JSON object");
	});
});

describe("StdioRouterEnvironment (real subprocess)", () => {
	const echoAdapter = (script: string) => [process.execPath, "-e", script];

	it("speaks init/reset/observe/execute and surfaces adapter errors", async () => {
		const script = `
			const lines = require("readline").createInterface({ input: process.stdin });
			const state = { ticks: 0 };
			lines.on("line", (line) => {
				const msg = JSON.parse(line);
				const reply = (payload) => process.stdout.write(JSON.stringify({ id: msg.id, ...payload }) + "\\n");
				if (msg.type === "init") reply({ ok: true, environment: { actions: { wait: { description: "Wait." } } } });
				else if (msg.type === "reset") { state.ticks = 0; reply({ ok: true }); }
				else if (msg.type === "observe") reply({ ok: true, observation: { text: "frame " + state.ticks, fields: { ticks: state.ticks } } });
				else if (msg.type === "execute") {
					if (msg.action === "wait") { state.ticks += 1; reply({ ok: true, text: "waited" }); }
					else reply({ ok: false, error: "unknown action: " + msg.action });
				} else if (msg.type === "close") { lines.close(); process.exit(0); }
			});
		`;
		const env = new StdioRouterEnvironment({ command: echoAdapter(script), requestTimeoutMs: 5_000 });
		try {
			const environment = await env.init();
			expect(environment?.actions).toMatchObject({ wait: { description: "Wait." } });
			await env.reset("goal");
			const first = await env.observe();
			expect(first.text).toBe("frame 0");
			expect(first.fields).toMatchObject({ ticks: 0 });
			await env.execute("wait", {});
			const second = await env.observe();
			expect(second.text).toBe("frame 1");
			await expect(env.execute("explode", {})).rejects.toThrow("unknown action: explode");
		} finally {
			await env.close();
		}
	});

	it("rejects init when the adapter exits early, with stderr context", async () => {
		const env = new StdioRouterEnvironment({
			command: [process.execPath, "-e", "console.error('adapter blew up'); process.exit(3);"],
			requestTimeoutMs: 5_000,
		});
		await expect(env.init()).rejects.toThrow(/exited early .*adapter blew up/);
		await env.close();
	});

	it("closes fast when the adapter already exited, and twice in a row", async () => {
		const env = new StdioRouterEnvironment({
			command: [process.execPath, "-e", "process.exit(0);"],
			requestTimeoutMs: 5_000,
		});
		await expect(env.init()).rejects.toThrow(/exited early/);
		const started = Date.now();
		await env.close();
		expect(Date.now() - started).toBeLessThan(500);
		await env.close();
	});

	it("close() is idempotent: a second close after a SIGKILL does not repeat the shutdown", async () => {
		const env = new StdioRouterEnvironment({ command: echoAdapter("setInterval(()=>{},99)"), requestTimeoutMs: 50 });
		await expect(env.init()).rejects.toThrow(/timed out/);
		const child = (env as unknown as { child: ChildProcess }).child;
		const closeRequests: string[] = [];
		const originalEnd = (child.stdin!.end as unknown as (chunk?: unknown) => unknown).bind(child.stdin);
		(child.stdin as unknown as { end: (chunk?: unknown) => unknown }).end = (chunk?: unknown) => {
			if (typeof chunk === "string" && chunk.includes('"type":"close"')) closeRequests.push(chunk);
			return originalEnd(chunk);
		};
		await env.close({ budgetMs: 0 });
		await env.close({ budgetMs: 60_000 });
		expect(closeRequests).toHaveLength(1);
	});

	it("tolerates a reply split across two stdout chunks and noise lines", async () => {
		const script = `
			const lines = require("readline").createInterface({ input: process.stdin });
			lines.on("line", (line) => {
				const msg = JSON.parse(line);
				if (msg.type === "init") {
					process.stdout.write('{"id":' + msg.id + ',');
					setTimeout(() => {
						process.stdout.write('"ok":true,"environment":{"actions":{"wait":{"description":"Wait."}}}}\\n');
						process.stdout.write('not json noise\\n');
						process.stdout.write('{"id":999,"ok":true}\\n');
					}, 10);
				} else if (msg.type === "observe") {
					process.stdout.write(JSON.stringify({ id: msg.id, ok: true, observation: { text: "ok screen" } }) + "\\n");
				} else if (msg.type === "close") { lines.close(); process.exit(0); }
			});
		`;
		const env = new StdioRouterEnvironment({ command: [process.execPath, "-e", script], requestTimeoutMs: 5_000 });
		try {
			const environment = await env.init();
			expect(environment?.actions).toMatchObject({ wait: { description: "Wait." } });
			const observation = await env.observe();
			expect(observation.text).toBe("ok screen");
		} finally {
			await env.close();
		}
	});

	it("fails fast when the adapter writes an oversized terminated reply line", async () => {
		const script = `
			process.stdout.write(JSON.stringify({ id: 1, ok: true }) + "|" + "x".repeat(1_100_000) + "\\n");
			process.stdin.on("end", () => process.exit(0));
		`;
		const env = new StdioRouterEnvironment({
			command: [process.execPath, "-e", script],
			requestTimeoutMs: 5_000,
		});
		try {
			await expect(env.init()).rejects.toThrow(/reply line over/);
		} finally {
			await env.close();
		}
	});

	it("fails fast when the adapter writes an unterminated oversized line", async () => {
		const script = `
			process.stdout.write("x".repeat(1_100_000));
			process.stdout.write(JSON.stringify({ id: 1, ok: true }) + "\\n");
			process.stdin.on("end", () => process.exit(0));
		`;
		const env = new StdioRouterEnvironment({
			command: [process.execPath, "-e", script],
			requestTimeoutMs: 5_000,
		});
		try {
			await expect(env.init()).rejects.toThrow(/unterminated reply line over/);
		} finally {
			await env.close();
		}
	});

	it("times out requests against a silent adapter", async () => {
		const env = new StdioRouterEnvironment({
			command: [
				process.execPath,
				"-e",
				"process.stdin.on('end', () => process.exit(0)); setInterval(() => {}, 1000);",
			],
			requestTimeoutMs: 50,
		});
		try {
			await expect(env.init()).rejects.toThrow(/init timed out after 50ms/);
		} finally {
			await env.close();
		}
	});

	it("forwards a falsy init payload and fails the next request instead of crashing on EPIPE", async () => {
		if (process.platform !== "win32") {
			const script = `
				process.stdin.on("error", () => {});
				require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.type === "init") {
						require("fs").closeSync(0);
						console.log(JSON.stringify({ id: msg.id, ok: true, environment: { echo: line } }));
					}
				});
				setInterval(() => {}, 1000);
			`;
			const env = new StdioRouterEnvironment({ command: echoAdapter(script), requestTimeoutMs: 2_000, init: false });
			try {
				const environment = await env.init();
				expect(environment?.echo).toContain('"init":false');
				// No stdin error listener -> the stream "error" event crashes the host.
				await expect(env.observe()).rejects.toThrow(/EPIPE/);
			} finally {
				await env.close({ budgetMs: 250 });
			}
		}
	});

	it("gives a SIGTERM-forwarding adapter part of the cleanup budget on the timeout path", async () => {
		const script = `
			process.on("SIGTERM", () => { setTimeout(() => process.exit(0), 100); });
			require("readline").createInterface({ input: process.stdin }).on("line", () => {});
			setInterval(() => {}, 1000);
		`;
		const env = new StdioRouterEnvironment({ command: echoAdapter(script), requestTimeoutMs: 2_000 });
		const decide = scriptedDecide([decision({ action: FINISH_ACTION, confidence: 1 })]);
		const result = await runLoop(env, { decide, timeoutMs: 200 });
		expect(result.status).toBe("incomplete");
		const child = (env as unknown as { child: ChildProcess }).child;
		await waitForChildProcess(child);
		// Without the reserved SIGTERM wait, SIGKILL lands first (exitCode null).
		expect(child.exitCode).toBe(0);
	});

	it("ends the segment at its wall-clock budget and kills the adapter tree, descendants included", async () => {
		if (process.platform !== "win32") {
			const script = `
				process.on("SIGTERM", () => {});
				const { spawn } = require("node:child_process");
				const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
				const reply = (payload) => console.log(JSON.stringify(payload));
				require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
					const msg = JSON.parse(line);
					if (msg.type === "init") reply({ id: msg.id, ok: true, environment: { grandchildPid: grandchild.pid } });
					else if (msg.type === "reset") reply({ id: msg.id, ok: true });
					else if (msg.type === "observe") reply({ id: msg.id, ok: true, observation: { text: "screen" } });
				});
				setInterval(() => {}, 1000);
			`;
			const env = new StdioRouterEnvironment({ command: echoAdapter(script), requestTimeoutMs: 2_000 });
			const grandchildPid = Number((await env.init())?.grandchildPid);
			const decide = scriptedDecide([decision({ action: FINISH_ACTION, confidence: 1 })]);
			const started = Date.now();
			const result = await runLoop(env, { decide, timeoutMs: 200 });
			expect(result.status).toBe("done");
			expect(Date.now() - started).toBeLessThan(2_000);
			await waitForChildProcess((env as unknown as { child: ChildProcess }).child);
			expect(isProcessAlive(grandchildPid)).toBe(false);
		}
	});
});
