/** Wire-safe types and schedule math for the /rlm-token-budget state APIs. */

export type RlmTokenBudgetSource = "default" | "env" | "global" | "inherited" | "chat";

/**
 * How a total token allowance is distributed across RLM recursion depths.
 *
 * - `flat`: every depth receives the full per-agent allowance.
 * - `geometric`: each successive depth receives `factor` of the previous depth's per-agent allowance.
 * - `split`: a parent reserves `factor` of its own allowance for descendants and divides it between them,
 *   which bounds the whole subtree by the root allowance regardless of depth or fan-out.
 */
export type RlmTokenBudgetSchedule = "flat" | "geometric" | "split";

export const RLM_TOKEN_BUDGET_SCHEDULES: readonly RlmTokenBudgetSchedule[] = ["flat", "geometric", "split"];

export const DEFAULT_RLM_TOKEN_BUDGET_SCHEDULE: RlmTokenBudgetSchedule = "split";
export const DEFAULT_RLM_TOKEN_BUDGET_FACTOR = 0.5;
export const DEFAULT_RLM_TOKEN_BUDGET_FANOUT = 3;

export interface RlmTokenBudgetConfig {
	/** Token allowance granted to the root session and, through the schedule, to its descendants. */
	totalTokens: number;
	schedule: RlmTokenBudgetSchedule;
	/** Share in (0, 1] applied per depth by the `geometric` and `split` schedules. */
	factor: number;
	/** Number of children a `split` allowance is divided between. */
	fanout: number;
	/**
	 * Smallest allowance a depth may receive. A depth the schedule would starve is raised to this
	 * floor; under `split`, where raising would break the subtree bound, the spawn is refused instead.
	 */
	minTokens?: number;
	/** Largest allowance any single depth may receive, applied after the schedule. */
	maxTokens?: number;
}

/** A token budget expressed as a range instead of a single ceiling. */
export interface RlmTokenBudgetRange {
	minTokens: number;
	maxTokens: number;
}

export interface RlmTokenBudgetStatus {
	/** Null when budgeting is disabled. */
	config: RlmTokenBudgetConfig | null;
	source: RlmTokenBudgetSource;
	depth: number;
	/** Tokens this session may generate, or null when unbounded. */
	allowanceTokens: number | null;
	tokensUsed: number;
	/** Tokens still available to descendants under `split`, or null for the other schedules. */
	subtreePoolTokens: number | null;
	exhausted: boolean;
}

export interface SetRlmTokenBudgetResult extends RlmTokenBudgetStatus {
	globalSaved: boolean;
	globalError?: string;
}

/**
 * Tokens charged against an allowance for one assistant turn.
 *
 * Cache-read tokens are repeated context served from the provider cache. Charging them
 * cumulatively would exhaust a recursive budget on context re-reads instead of new work,
 * so they are excluded exactly as the autonomous loop budget excludes them.
 */
export function rlmTokenDeltaForUsage(
	usage: { input: number; output: number; cacheWrite: number } | undefined,
): number {
	if (!usage) return 0;
	return Math.max(0, usage.input) + Math.max(0, usage.output) + Math.max(0, usage.cacheWrite);
}

export function isRlmTokenBudgetSchedule(value: unknown): value is RlmTokenBudgetSchedule {
	return typeof value === "string" && RLM_TOKEN_BUDGET_SCHEDULES.includes(value as RlmTokenBudgetSchedule);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isRlmTokenBudgetConfig(value: unknown): value is RlmTokenBudgetConfig {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RlmTokenBudgetConfig>;
	return (
		isPositiveInteger(candidate.totalTokens) &&
		isRlmTokenBudgetSchedule(candidate.schedule) &&
		typeof candidate.factor === "number" &&
		Number.isFinite(candidate.factor) &&
		candidate.factor > 0 &&
		candidate.factor <= 1 &&
		isPositiveInteger(candidate.fanout) &&
		(candidate.minTokens === undefined || isPositiveInteger(candidate.minTokens)) &&
		(candidate.maxTokens === undefined || isPositiveInteger(candidate.maxTokens)) &&
		(candidate.minTokens === undefined ||
			candidate.maxTokens === undefined ||
			candidate.minTokens <= candidate.maxTokens)
	);
}

/** Normalize a model-supplied `token_budget`, which may be a single ceiling or a [floor, ceiling] range. */
export function normalizeRlmTokenBudgetRequest(value: unknown): RlmTokenBudgetRange | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new Error("rlm.run token_budget must be a positive integer");
		}
		return { minTokens: value, maxTokens: value };
	}
	const pair = Array.isArray(value)
		? value
		: typeof value === "object" && value !== null
			? [
					(value as { min?: unknown; minTokens?: unknown }).min ?? (value as { minTokens?: unknown }).minTokens,
					(value as { max?: unknown; maxTokens?: unknown }).max ?? (value as { maxTokens?: unknown }).maxTokens,
				]
			: undefined;
	if (!pair || pair.length !== 2) {
		throw new Error(
			"rlm.run token_budget must be a positive integer or a (floor, ceiling) pair such as (200000, 600000)",
		);
	}
	const [min, max] = pair;
	if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || Number(min) <= 0 || Number(max) <= 0) {
		throw new Error("rlm.run token_budget bounds must be positive integers");
	}
	if (Number(min) > Number(max)) {
		throw new Error(`rlm.run token_budget floor ${min} exceeds its ceiling ${max}`);
	}
	return { minTokens: Number(min), maxTokens: Number(max) };
}

/** Validate a config supplied by a user or a persisted entry, throwing a user-facing message when invalid. */
export function validateRlmTokenBudgetConfig(config: RlmTokenBudgetConfig): RlmTokenBudgetConfig {
	if (!isPositiveInteger(config.totalTokens)) {
		throw new Error("RLM token budget must be a positive integer.");
	}
	if (!isRlmTokenBudgetSchedule(config.schedule)) {
		throw new Error(`RLM token budget schedule must be one of: ${RLM_TOKEN_BUDGET_SCHEDULES.join(", ")}.`);
	}
	if (!Number.isFinite(config.factor) || config.factor <= 0 || config.factor > 1) {
		throw new Error("RLM token budget factor must be greater than 0 and at most 1.");
	}
	if (!isPositiveInteger(config.fanout)) {
		throw new Error("RLM token budget fanout must be a positive integer.");
	}
	if (config.minTokens !== undefined && !isPositiveInteger(config.minTokens)) {
		throw new Error("RLM token budget floor must be a positive integer.");
	}
	if (config.maxTokens !== undefined && !isPositiveInteger(config.maxTokens)) {
		throw new Error("RLM token budget ceiling must be a positive integer.");
	}
	if (config.minTokens !== undefined && config.maxTokens !== undefined && config.minTokens > config.maxTokens) {
		throw new Error(`RLM token budget floor ${config.minTokens} exceeds its ceiling ${config.maxTokens}.`);
	}
	return { ...config };
}

/** Clamp a scheduled allowance into the configured [floor, ceiling] range. */
export function clampToBudgetRange(config: RlmTokenBudgetConfig, tokens: number): number {
	let clamped = tokens;
	if (config.maxTokens !== undefined) clamped = Math.min(clamped, config.maxTokens);
	if (config.minTokens !== undefined) clamped = Math.max(clamped, config.minTokens);
	return clamped;
}

/** Tokens the session at `depth` may generate itself under the given allowance. */
export function ownAllowance(config: RlmTokenBudgetConfig, depth: number, inheritedAllowance?: number): number {
	switch (config.schedule) {
		case "flat":
			return clampToBudgetRange(config, config.totalTokens);
		case "geometric":
			return clampToBudgetRange(
				config,
				Math.max(1, Math.floor(config.totalTokens * config.factor ** Math.max(0, depth))),
			);
		case "split": {
			const allowance = inheritedAllowance ?? config.totalTokens;
			// The floor is deliberately not applied here: raising a split allowance would break the
			// subtree bound. Under-funded children are refused at spawn instead.
			const own = Math.max(1, Math.floor(allowance * (1 - config.factor)));
			return config.maxTokens === undefined ? own : Math.min(own, config.maxTokens);
		}
	}
}

/** Tokens reserved for descendants of a session holding `allowance`; null when the schedule does not pool. */
export function subtreePool(config: RlmTokenBudgetConfig, allowance: number): number | null {
	if (config.schedule !== "split") return null;
	return Math.max(0, Math.floor(allowance * config.factor));
}

/**
 * Equal share of a `split` subtree pool handed to each child.
 *
 * The share is derived from the pool the parent started with, so siblings receive identical
 * allowances and the parent can fund exactly `fanout` children before spawns are refused.
 */
export function childAllowanceFromPool(config: RlmTokenBudgetConfig, initialPool: number): number {
	return Math.max(0, Math.floor(initialPool / config.fanout));
}

/**
 * Allowance a child inherits. `split` draws an equal share of the parent's pool; the depth-indexed
 * schedules ignore the pool and derive the child allowance from its depth alone.
 */
export function childAllowance(
	config: RlmTokenBudgetConfig,
	childDepth: number,
	parentInitialPool: number | null,
): number {
	if (config.schedule === "split") {
		return childAllowanceFromPool(config, parentInitialPool ?? 0);
	}
	return ownAllowance(config, childDepth);
}

/** A parsed `/rlm-token-budget` invocation. */
export type RlmTokenBudgetCommand =
	| { kind: "status" }
	| { kind: "off"; global: boolean }
	| { kind: "set"; config: RlmTokenBudgetConfig; global: boolean };

const RLM_TOKEN_BUDGET_USAGE =
	"Usage: /rlm-token-budget [off|<tokens>|<floor>-<ceiling> [--schedule flat|geometric|split] [--factor <0-1>] [--fanout <int>] [--floor <tokens>] [--ceiling <tokens>] [--global]]";

/** Parse a token count, accepting `_` separators and `k`/`m` suffixes (e.g. `500k`, `1_000_000`, `2m`). */
export function parseRlmTokenBudgetTokens(value: string): number {
	const match = /^(\d[\d_]*)(k|m)?$/i.exec(value);
	if (!match) {
		throw new Error(`Invalid token count "${value}". ${RLM_TOKEN_BUDGET_USAGE}`);
	}
	const digits = Number(match[1].replaceAll("_", ""));
	const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
	const total = digits * multiplier;
	if (!Number.isSafeInteger(total) || total <= 0) {
		throw new Error(`Invalid token count "${value}". ${RLM_TOKEN_BUDGET_USAGE}`);
	}
	return total;
}

function takeFlagValue(tokens: string[], index: number, flag: string): { value: string; nextIndex: number } {
	const token = tokens[index];
	const inline = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : undefined;
	if (inline !== undefined) {
		if (!inline) throw new Error(`Missing value for ${flag}. ${RLM_TOKEN_BUDGET_USAGE}`);
		return { value: inline, nextIndex: index + 1 };
	}
	const next = tokens[index + 1];
	if (next === undefined) throw new Error(`Missing value for ${flag}. ${RLM_TOKEN_BUDGET_USAGE}`);
	return { value: next, nextIndex: index + 2 };
}

export function parseRlmTokenBudgetCommand(args: string): RlmTokenBudgetCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status" };

	let global = false;
	let schedule = DEFAULT_RLM_TOKEN_BUDGET_SCHEDULE;
	let factor = DEFAULT_RLM_TOKEN_BUDGET_FACTOR;
	let fanout = DEFAULT_RLM_TOKEN_BUDGET_FANOUT;
	let minTokens: number | undefined;
	let maxTokens: number | undefined;

	const head = tokens[0].toLowerCase();
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--global") {
			global = true;
			index += 1;
		} else if (token === "--schedule" || token.startsWith("--schedule=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--schedule");
			if (!isRlmTokenBudgetSchedule(value)) {
				throw new Error(`Unknown schedule "${value}". Expected one of: ${RLM_TOKEN_BUDGET_SCHEDULES.join(", ")}.`);
			}
			schedule = value;
			index = nextIndex;
		} else if (token === "--factor" || token.startsWith("--factor=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--factor");
			factor = Number(value);
			index = nextIndex;
		} else if (token === "--fanout" || token.startsWith("--fanout=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--fanout");
			fanout = Number(value);
			index = nextIndex;
		} else if (token === "--floor" || token.startsWith("--floor=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--floor");
			minTokens = parseRlmTokenBudgetTokens(value);
			index = nextIndex;
		} else if (token === "--ceiling" || token.startsWith("--ceiling=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--ceiling");
			maxTokens = parseRlmTokenBudgetTokens(value);
			index = nextIndex;
		} else {
			throw new Error(`Unexpected argument "${token}". ${RLM_TOKEN_BUDGET_USAGE}`);
		}
	}

	if (head === "off" || head === "none" || head === "clear") {
		return { kind: "off", global };
	}
	// `<floor>-<ceiling>` is the range form; a bare value is a single ceiling.
	const rangeMatch = /^([\d_]+[km]?)-([\d_]+[km]?)$/i.exec(tokens[0]);
	if (rangeMatch) {
		minTokens = parseRlmTokenBudgetTokens(rangeMatch[1]);
		maxTokens = parseRlmTokenBudgetTokens(rangeMatch[2]);
	}
	const totalTokens = rangeMatch ? (maxTokens as number) : parseRlmTokenBudgetTokens(tokens[0]);
	return {
		kind: "set",
		config: validateRlmTokenBudgetConfig({
			totalTokens,
			schedule,
			factor,
			fanout,
			...(minTokens === undefined ? {} : { minTokens }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		}),
		global,
	};
}
