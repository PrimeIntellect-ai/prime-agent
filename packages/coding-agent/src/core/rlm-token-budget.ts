/** Wire-safe types, validation, and command parsing for the /rlm-token-budget state APIs. */

export type RlmTokenBudgetSource = "default" | "env" | "global" | "inherited" | "chat";

export interface RlmTokenBudgetConfig {
	/** Tokens the root session may hand to subagents. Every grant is drawn from it. */
	totalTokens: number;
	/** Smallest grant worth making. A child the pool cannot fund this far is refused instead. */
	minTokens?: number;
	/** Largest grant any single child may receive, applied after the caller's request. */
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
	/** Tokens this session may generate, or null when it is unbounded (always so at depth 0). */
	allowanceTokens: number | null;
	tokensUsed: number;
	/** Tokens still grantable to subagents, or null when budgeting is off. */
	subtreePoolTokens: number | null;
	/** Tokens already handed to subagents out of this session's budget. */
	delegatedTokens: number;
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
	const { totalTokens, minTokens, maxTokens } = candidate;
	if (!isPositiveInteger(totalTokens)) {
		return "RLM token budget must be a positive integer.";
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
	if (minTokens !== undefined && minTokens > totalTokens) {
		return `RLM token budget floor ${minTokens} exceeds the ${totalTokens}-token budget, so no child could be funded.`;
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

/** Clamp a requested grant into the configured [floor, ceiling] range. */
export function clampToBudgetRange(config: RlmTokenBudgetConfig, tokens: number): number {
	let clamped = tokens;
	if (config.maxTokens !== undefined) clamped = Math.min(clamped, config.maxTokens);
	if (config.minTokens !== undefined) clamped = Math.max(clamped, config.minTokens);
	return clamped;
}

/** A parsed `/rlm-token-budget` invocation. */
export type RlmTokenBudgetCommand =
	| { kind: "status" }
	| { kind: "off"; global: boolean }
	| { kind: "set"; config: RlmTokenBudgetConfig; global: boolean };

const RLM_TOKEN_BUDGET_USAGE =
	"Usage: /rlm-token-budget [off|<tokens>|<floor>-<ceiling> [--floor <tokens>] [--ceiling <tokens>] [--global]]";

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

const RLM_TOKEN_BUDGET_VALUE_FLAGS = ["--floor", "--ceiling"] as const;

function matchValueFlag(token: string): string | undefined {
	return RLM_TOKEN_BUDGET_VALUE_FLAGS.find((flag) => token === flag || token.startsWith(`${flag}=`));
}

/**
 * `off` only takes `--global`. Range flags are consumed without validation because they shape a budget
 * that is being removed, while an unrecognized token (a misspelled `--global`) still errors.
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
	let minTokens: number | undefined;
	let maxTokens: number | undefined;

	let index = 1;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token === "--global") {
			global = true;
			index += 1;
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
			...(minTokens === undefined ? {} : { minTokens }),
			...(maxTokens === undefined ? {} : { maxTokens }),
		}),
		global,
	};
}
