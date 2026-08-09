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

const RLM_TOKEN_BUDGET_SCHEDULES: readonly RlmTokenBudgetSchedule[] = ["flat", "geometric", "split"];

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

function isRlmTokenBudgetSchedule(value: unknown): value is RlmTokenBudgetSchedule {
	return typeof value === "string" && RLM_TOKEN_BUDGET_SCHEDULES.includes(value as RlmTokenBudgetSchedule);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Single source of truth for config validity: returns a user-facing message, or undefined when the
 * value is a usable config. The type guard and the validator both delegate here so a persisted
 * config the validator would reject is dropped at load time instead of throwing in every child.
 */
function rlmTokenBudgetConfigError(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return "RLM token budget must be an object.";
	const candidate = value as Partial<RlmTokenBudgetConfig>;
	const totalTokens = candidate.totalTokens;
	const schedule = candidate.schedule;
	const factor = candidate.factor;
	const fanout = candidate.fanout;
	const minTokens = candidate.minTokens;
	const maxTokens = candidate.maxTokens;
	if (!isPositiveInteger(totalTokens)) {
		return "RLM token budget must be a positive integer.";
	}
	if (!isRlmTokenBudgetSchedule(schedule)) {
		return `RLM token budget schedule must be one of: ${RLM_TOKEN_BUDGET_SCHEDULES.join(", ")}.`;
	}
	if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0 || factor > 1) {
		return "RLM token budget factor must be greater than 0 and at most 1.";
	}
	if (schedule === "split" && factor === 1) {
		return (
			'RLM token budget factor must be less than 1 for the "split" schedule: a factor of 1 reserves the entire ' +
			"allowance for descendants and leaves every session 1 token. Lower --factor, or use --schedule geometric."
		);
	}
	if (!isPositiveInteger(fanout)) {
		return "RLM token budget fanout must be a positive integer.";
	}
	if (minTokens !== undefined && !isPositiveInteger(minTokens)) {
		return "RLM token budget floor must be a positive integer.";
	}
	if (maxTokens !== undefined && !isPositiveInteger(maxTokens)) {
		return "RLM token budget ceiling must be a positive integer.";
	}
	if (minTokens !== undefined && maxTokens !== undefined && minTokens > maxTokens) {
		return `RLM token budget floor ${minTokens} exceeds its ceiling ${maxTokens}.`;
	}
	// `split` refuses children it cannot fund at the floor, so a floor above the per-child share would
	// reject every spawn. Reject the configuration instead of silently disabling delegation.
	if (schedule === "split" && minTokens !== undefined) {
		const probe: RlmTokenBudgetConfig = { totalTokens, schedule, factor, fanout, minTokens };
		const share = childAllowanceFromPool(probe, subtreePool(probe, totalTokens) ?? 0);
		// The floor promises what a child may SPEND, and a funded child keeps only `1 - factor` of
		// its grant, so the feasibility check must use the spendable amount rather than the grant.
		const spendable = ownAllowance(probe, 1, share);
		if (spendable < minTokens) {
			return (
				`RLM token budget floor ${minTokens} cannot be funded: the "split" schedule gives each of ${fanout} children a ${share}-token grant worth ${spendable} spendable tokens. ` +
				"Lower the floor, raise the total, reduce --fanout, or raise --factor."
			);
		}
	}
	return undefined;
}

export function isRlmTokenBudgetConfig(value: unknown): value is RlmTokenBudgetConfig {
	return rlmTokenBudgetConfigError(value) === undefined;
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
	const error = rlmTokenBudgetConfigError(config);
	if (error !== undefined) throw new Error(error);
	return { ...config };
}

/** Clamp a scheduled allowance into the configured [floor, ceiling] range. */
function clampToBudgetRange(config: RlmTokenBudgetConfig, tokens: number): number {
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
function childAllowanceFromPool(config: RlmTokenBudgetConfig, initialPool: number): number {
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
	// Separators must sit between digits: a trailing `_` would otherwise make `1_000_-1m` a valid range.
	const match = /^(\d(?:[\d_]*\d)?)(k|m)?$/i.exec(value);
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

/** Parse a `--factor` value, quoting the offending input the way `parseRlmTokenBudgetTokens` does. */
function parseRlmTokenBudgetFactor(value: string): number {
	const factor = Number(value);
	if (!Number.isFinite(factor) || factor <= 0 || factor > 1) {
		throw new Error(
			`Invalid factor "${value}". Expected a number greater than 0 and at most 1. ${RLM_TOKEN_BUDGET_USAGE}`,
		);
	}
	return factor;
}

/** Parse a `--fanout` value, quoting the offending input the way `parseRlmTokenBudgetTokens` does. */
function parseRlmTokenBudgetFanout(value: string): number {
	const fanout = Number(value);
	if (!isPositiveInteger(fanout)) {
		throw new Error(`Invalid fanout "${value}". Expected a positive integer. ${RLM_TOKEN_BUDGET_USAGE}`);
	}
	return fanout;
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

const RLM_TOKEN_BUDGET_VALUE_FLAGS = ["--schedule", "--factor", "--fanout", "--floor", "--ceiling"] as const;

function matchValueFlag(token: string): string | undefined {
	return RLM_TOKEN_BUDGET_VALUE_FLAGS.find((flag) => token === flag || token.startsWith(`${flag}=`));
}

/**
 * `off` only takes `--global`. The schedule flags are consumed without validation because they shape a
 * budget that is being removed, while an unrecognized token (a misspelled `--global`) still errors.
 */
function parseRlmTokenBudgetOffFlags(tokens: string[]): boolean {
	let global = false;
	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--global") {
			global = true;
			index += 1;
			continue;
		}
		const flag = matchValueFlag(token);
		if (flag === undefined) throw new Error(`Unexpected argument "${token}". ${RLM_TOKEN_BUDGET_USAGE}`);
		index = takeFlagValue(tokens, index, flag).nextIndex;
	}
	return global;
}

export function parseRlmTokenBudgetCommand(args: string): RlmTokenBudgetCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "status" };

	const head = tokens[0].toLowerCase();
	if (head === "off" || head === "none" || head === "clear") {
		return { kind: "off", global: parseRlmTokenBudgetOffFlags(tokens) };
	}
	if (tokens[0].startsWith("-")) {
		throw new Error(`Missing token count before "${tokens[0]}". ${RLM_TOKEN_BUDGET_USAGE}`);
	}

	let global = false;
	let schedule = DEFAULT_RLM_TOKEN_BUDGET_SCHEDULE;
	let factor = DEFAULT_RLM_TOKEN_BUDGET_FACTOR;
	let fanout = DEFAULT_RLM_TOKEN_BUDGET_FANOUT;
	let minTokens: number | undefined;
	let maxTokens: number | undefined;

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
			factor = parseRlmTokenBudgetFactor(value);
			index = nextIndex;
		} else if (token === "--fanout" || token.startsWith("--fanout=")) {
			const { value, nextIndex } = takeFlagValue(tokens, index, "--fanout");
			fanout = parseRlmTokenBudgetFanout(value);
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

	// `<floor>-<ceiling>` is the range form; a bare value is a single ceiling.
	const rangeMatch = /^([\d_]+[km]?)-([\d_]+[km]?)$/i.exec(tokens[0]);
	if (rangeMatch) {
		if (minTokens !== undefined || maxTokens !== undefined) {
			throw new Error(`Cannot combine the range "${tokens[0]}" with --floor/--ceiling. Use one form or the other.`);
		}
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
