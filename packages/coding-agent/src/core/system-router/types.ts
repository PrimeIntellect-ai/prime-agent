/**
 * System 1 / System 2 harness router.
 *
 * The session model (System 2) declares an environment with a finite action
 * space and a System 1 action model. The router then runs the action-only
 * step loop: observe -> decide (ONE model call per step, thinking off,
 * single choice from the declared action space + confidence) -> gate ->
 * execute -> record, mirroring the SystemOneHarness controller
 * (https://github.com/HarnessRouter/SystemOneHarness, docs/design.md).
 * System 2 steers between segments: it sets or updates the goal, reviews the
 * returned trace, and re-invokes the router with a new goal or thresholds.
 */

export type RouterActionRisk = "read" | "write" | "destructive";

/** A finite parameter: every allowed value with a one-line description. */
export interface RouterActionParamSpec {
	choices: Record<string, string>;
}

export interface RouterActionSpec {
	/** What executing this action does. The action model reads this verbatim. */
	description: string;
	risk?: RouterActionRisk;
	params?: Record<string, RouterActionParamSpec>;
}

/** Confidence gate thresholds per risk level (SystemOneHarness defaults). */
export interface RouterGateSpec {
	read?: number;
	write?: number;
	destructive?: number;
	finish?: number;
}

export const DEFAULT_ROUTER_GATE: Required<Pick<RouterGateSpec, "read" | "write" | "destructive" | "finish">> = {
	read: 0.5,
	write: 0.6,
	destructive: 0.8,
	finish: 0.5,
};

export interface RouterStdioEnvironmentSpec {
	/** Adapter command. The first element is the executable, the rest are arguments. */
	command: string[];
	/** Working directory for the adapter process. */
	cwd?: string;
	/** Per-request adapter timeout in milliseconds. */
	requestTimeoutMs?: number;
	/** Initialisation payload forwarded to the adapter (e.g. ROM path, memory reads). */
	init?: unknown;
}

export interface RouterEnvironmentSpec {
	stdio: RouterStdioEnvironmentSpec;
}

export interface SystemRouterRunSpec {
	goal: string;
	/** Declared finite action space. Omit when the environment supplies its own. */
	actions?: Record<string, RouterActionSpec>;
	environment: RouterEnvironmentSpec;
	/** System 1 action model selector. Defaults to the subagent default, then the session model. */
	model?: string;
	/** Maximum decision steps for this segment. */
	maxSteps?: number;
	/** Whole-segment wall-clock budget in milliseconds. */
	timeoutMs?: number;
	gate?: RouterGateSpec;
	/** How many recent steps ride the prompt as bounded history. */
	historySteps?: number;
	/** Truncation budget for the observation text. */
	observationChars?: number;
}

export const DEFAULT_ROUTER_MAX_STEPS = 25;
export const MAX_ROUTER_STEPS = 200;
export const DEFAULT_ROUTER_TIMEOUT_MS = 120_000;
export const MAX_ROUTER_TIMEOUT_MS = 600_000;
export const DEFAULT_ROUTER_HISTORY_STEPS = 8;
export const MAX_ROUTER_HISTORY_STEPS = 32;
export const DEFAULT_ROUTER_OBSERVATION_CHARS = 6_000;
export const MAX_ROUTER_OBSERVATION_CHARS = 32_000;
export const DEFAULT_ROUTER_ENV_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_ROUTER_ENV_REQUEST_TIMEOUT_MS = 120_000;

export const FINISH_ACTION = "finish";
export const ESCALATE_ACTION = "escalate";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`system_router.run ${what} must be a non-empty string`);
	}
	return value;
}

function asPortNumber(value: unknown, what: string, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > max) {
		throw new Error(`system_router.run ${what} must be a whole number in [1, ${max}]`);
	}
	return value;
}

function parseRisk(value: unknown, what: string): RouterActionRisk {
	if (value === undefined) return "write";
	if (value !== "read" && value !== "write" && value !== "destructive") {
		throw new Error(`system_router.run ${what} must be "read", "write", or "destructive"`);
	}
	return value;
}

/** A validated run spec: budgets are always concrete numbers after parsing. */
export interface ParsedSystemRouterRunSpec extends SystemRouterRunSpec {
	environment: RouterEnvironmentSpec & {
		stdio: Omit<RouterStdioEnvironmentSpec, "requestTimeoutMs"> & { requestTimeoutMs: number };
	};
	maxSteps: number;
	timeoutMs: number;
	historySteps: number;
	observationChars: number;
	gate: RouterGateSpec;
}

/** Parse and validate an untrusted system_router.run payload into a run spec. */
export function parseSystemRouterRunSpec(payload: unknown): ParsedSystemRouterRunSpec {
	if (!isRecord(payload)) {
		throw new Error("system_router.run payload must be an object");
	}
	const goal = asString(payload.goal, "goal");
	const environment = payload.environment;
	if (!isRecord(environment) || !isRecord(environment.stdio)) {
		throw new Error("system_router.run environment must be an object with a stdio adapter");
	}
	const command = environment.stdio.command;
	if (
		!Array.isArray(command) ||
		command.length === 0 ||
		command.some((part) => typeof part !== "string" || !part.trim())
	) {
		throw new Error("system_router.run environment.stdio.command must be a non-empty string array");
	}
	if (environment.stdio.cwd !== undefined && typeof environment.stdio.cwd !== "string") {
		throw new Error("system_router.run environment.stdio.cwd must be a string when provided");
	}
	const actions = parseActionSpace(payload.actions);
	const gate = parseGate(payload.gate);
	// A malformed selector (present but not a non-empty string) must fail the
	// run: silently falling back to the default model would incur usage on a
	// model the caller did not select.
	if (payload.model !== undefined && (typeof payload.model !== "string" || !payload.model.trim())) {
		throw new Error("system_router.run model must be a non-empty string when provided");
	}
	return {
		goal,
		...(actions ? { actions } : {}),
		environment: {
			stdio: {
				command: command.map((part) => (part as string).trim()),
				...(typeof environment.stdio.cwd === "string" ? { cwd: environment.stdio.cwd } : {}),
				requestTimeoutMs: asPortNumber(
					environment.stdio.requestTimeoutMs,
					"environment.stdio.requestTimeoutMs",
					DEFAULT_ROUTER_ENV_REQUEST_TIMEOUT_MS,
					MAX_ROUTER_ENV_REQUEST_TIMEOUT_MS,
				),
				...(environment.stdio.init !== undefined ? { init: environment.stdio.init } : {}),
			},
		},
		...(typeof payload.model === "string" && payload.model.trim() ? { model: payload.model.trim() } : {}),
		maxSteps: asPortNumber(payload.maxSteps, "maxSteps", DEFAULT_ROUTER_MAX_STEPS, MAX_ROUTER_STEPS),
		timeoutMs: asPortNumber(payload.timeoutMs, "timeoutMs", DEFAULT_ROUTER_TIMEOUT_MS, MAX_ROUTER_TIMEOUT_MS),
		historySteps: asPortNumber(
			payload.historySteps,
			"historySteps",
			DEFAULT_ROUTER_HISTORY_STEPS,
			MAX_ROUTER_HISTORY_STEPS,
		),
		observationChars: asPortNumber(
			payload.observationChars,
			"observationChars",
			DEFAULT_ROUTER_OBSERVATION_CHARS,
			MAX_ROUTER_OBSERVATION_CHARS,
		),
		gate,
	};
}

/**
 * Resolve the run's action space: the spec's declaration wins; the
 * environment's supplied defaults are parsed and validated otherwise.
 * Returns undefined when neither declares one.
 */
export function parseEnvironmentActions(
	declared: unknown,
	supplied: unknown,
): Record<string, RouterActionSpec> | undefined {
	if (declared !== undefined) return parseActionSpace(declared);
	if (supplied === undefined) return undefined;
	return parseActionSpace(supplied) ?? undefined;
}

/** Parse the declared action space. Returns undefined when the environment is expected to supply it. */
export function parseActionSpace(value: unknown): Record<string, RouterActionSpec> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.keys(value).length === 0) {
		throw new Error(
			"system_router.run actions must be a non-empty object of actions, or omitted when the environment supplies its own",
		);
	}
	const actions: Record<string, RouterActionSpec> = {};
	for (const [name, raw] of Object.entries(value)) {
		if (!/^[a-z0-9_]{1,32}$/.test(name)) {
			throw new Error(`system_router.run action name "${name}" must be lowercase snake_case (max 32 chars)`);
		}
		if (name === "__proto__") {
			throw new Error(`system_router.run action name "${name}" is reserved`);
		}
		if (name === FINISH_ACTION || name === ESCALATE_ACTION) {
			throw new Error(`system_router.run action name "${name}" is reserved for the loop itself`);
		}
		if (!isRecord(raw)) {
			throw new Error(`system_router.run action "${name}" must be an object`);
		}
		const description = asString(raw.description, `action "${name}" description`);
		const action: RouterActionSpec = {
			description,
			risk: parseRisk(raw.risk, `action "${name}" risk`),
		};
		if (raw.params !== undefined) {
			if (!isRecord(raw.params)) {
				throw new Error(`system_router.run action "${name}" params must be an object when provided`);
			}
			const params: Record<string, RouterActionParamSpec> = {};
			for (const [paramName, rawParam] of Object.entries(raw.params)) {
				if (!/^[a-z0-9_]{1,32}$/.test(paramName)) {
					throw new Error(
						`system_router.run action "${name}" param name "${paramName}" must be lowercase snake_case (max 32 chars)`,
					);
				}
				if (paramName === "__proto__") {
					throw new Error(`system_router.run action "${name}" param name "${paramName}" is reserved`);
				}
				if (!isRecord(rawParam) || !isRecord(rawParam.choices) || Object.keys(rawParam.choices).length === 0) {
					throw new Error(
						`system_router.run action "${name}" param "${paramName}" must declare a non-empty finite choices set`,
					);
				}
				for (const [choice, choiceDescription] of Object.entries(rawParam.choices)) {
					if (typeof choiceDescription !== "string" || !choiceDescription.trim()) {
						throw new Error(
							`system_router.run action "${name}" param "${paramName}" choice "${choice}" needs a non-empty description`,
						);
					}
					if (choice === "") {
						throw new Error(`system_router.run action "${name}" param "${paramName}" has an empty choice value`);
					}
				}
				params[paramName] = { choices: rawParam.choices as Record<string, string> };
			}
			action.params = params;
		}
		actions[name] = action;
	}
	return actions;
}

function parseGate(value: unknown): RouterGateSpec {
	if (value === undefined) return {};
	if (!isRecord(value)) {
		throw new Error("system_router.run gate must be an object when provided");
	}
	const gate: RouterGateSpec = {};
	for (const risk of ["read", "write", "destructive", "finish"] as const) {
		const threshold = value[risk];
		if (threshold !== undefined) {
			if (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
				throw new Error(`system_router.run gate.${risk} must be a number in [0, 1]`);
			}
			gate[risk] = threshold;
		}
	}
	return gate;
}

export function resolveGate(spec: RouterGateSpec): Required<RouterGateSpec> {
	return { ...DEFAULT_ROUTER_GATE, ...spec };
}

export interface RouterModelInfo {
	id: string;
	provider: string;
	input: string[];
	thinkingLevel: string;
}

/** What the environment reports to the loop each step. */
export interface RouterObservation {
	/** Legible state summary. The environment states the goal's own predicates outright, including the false ones. */
	text: string;
	/** Structured scalars rendered as "key: value" lines after the text. */
	fields?: Record<string, string | number | boolean>;
	/** Base64 PNG screenshot, included only when the action model accepts images. */
	image?: string;
	terminal?: boolean;
}

/** What the environment reports after executing an action. */
export interface RouterExecution {
	text: string;
	terminal?: boolean;
}

/** Options for stopping an adapter: `budgetMs` bounds the graceful shutdown wait. */
export interface RouterCloseOptions {
	budgetMs?: number;
}

/** The environment adapter contract: load (constructor/init), reset, observe, execute, close. */
export interface RouterEnvironment {
	/** Restore the environment to the start of this segment. Called once before the first observe. */
	reset(goal: string): Promise<void>;
	observe(): Promise<RouterObservation>;
	execute(action: string, params: Record<string, string>): Promise<RouterExecution>;
	/**
	 * Stop the adapter. `budgetMs` bounds the graceful shutdown wait so cleanup
	 * cannot extend a timed-out segment past its wall-clock budget; callers
	 * pass the remaining segment budget on timeout paths.
	 */
	close(options?: RouterCloseOptions): Promise<void>;
}

export type RouterGateVerdict = "pass" | "refused" | "parse_failure";

export interface RouterStepTrace {
	/** 0-based decision index. */
	step: number;
	timestampMs: number;
	/** Model round-trip milliseconds. */
	latencyMs: number;
	action: string | null;
	params: Record<string, string>;
	confidence: number | null;
	gate: { threshold: number; verdict: RouterGateVerdict };
	/** fnv1a (32-bit) digest of the observation for repeated-state detection. */
	observationDigest: string;
	observationChars: number;
	/** Execution result text or the refusal reason. */
	result: string;
	terminal: boolean;
	thinkingLevel: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}

export type RouterRunStatus = "done" | "incomplete" | "stuck" | "failed" | "escalated";

export interface SystemRouterRunResult {
	status: RouterRunStatus;
	/** Machine-readable terminal reason (e.g. "environment_terminal", "max_steps", "no_confident_decision"). */
	reason: string;
	/** Trace entries recorded this segment (executed + refused + terminal entries). */
	steps: number;
	executed: number;
	refused: number;
	trace: RouterStepTrace[];
	/** Harness-rendered terminal sentence; never presented as the model's own words. */
	summary: string;
	model: { provider: string; id: string; thinkingLevel: string };
	usage: { inputTokens: number; outputTokens: number };
}
