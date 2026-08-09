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
		isPositiveInteger(candidate.fanout)
	);
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
	return { ...config };
}

/** Tokens the session at `depth` may generate itself under the given allowance. */
export function ownAllowance(config: RlmTokenBudgetConfig, depth: number, inheritedAllowance?: number): number {
	switch (config.schedule) {
		case "flat":
			return config.totalTokens;
		case "geometric":
			return Math.max(1, Math.floor(config.totalTokens * config.factor ** Math.max(0, depth)));
		case "split": {
			const allowance = inheritedAllowance ?? config.totalTokens;
			return Math.max(1, Math.floor(allowance * (1 - config.factor)));
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
	"Usage: /rlm-token-budget [off|<tokens> [--schedule flat|geometric|split] [--factor <0-1>] [--fanout <int>] [--global]]";

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
		} else {
			throw new Error(`Unexpected argument "${token}". ${RLM_TOKEN_BUDGET_USAGE}`);
		}
	}

	if (head === "off" || head === "none" || head === "clear") {
		return { kind: "off", global };
	}
	const totalTokens = parseRlmTokenBudgetTokens(tokens[0]);
	return { kind: "set", config: validateRlmTokenBudgetConfig({ totalTokens, schedule, factor, fanout }), global };
}
