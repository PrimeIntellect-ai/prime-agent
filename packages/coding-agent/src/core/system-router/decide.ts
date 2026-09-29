import {
	type Api,
	type AssistantMessage,
	clampThinkingLevel,
	completeSimple,
	type Model,
	type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { completeWithProviderRetry, type ProviderRetryPolicy } from "../provider-retry.js";
import type { CompiledAction } from "./action-space.js";

/** Bounded output: the decision object is a few dozen tokens. */
/**
 * Output cap for one decision call. The decision object itself is a few dozen
 * tokens, but models that keep reasoning even when "off" is requested
 * (mandatory-reasoning models map "off" to their minimum effort) spend output
 * tokens on reasoning content first; a small cap would truncate the decision.
 */
export const ROUTER_DECISION_MAX_TOKENS = 4_096;

export const ROUTER_DECISION_SYSTEM_PROMPT = [
	"You are the action model inside a System 1 control loop.",
	"You do not plan, explain, or write prose.",
	"Each step you receive the goal, the latest observation, recent history, and the finite list of available actions.",
	"Reply with exactly one JSON object: the chosen action, its parameter values, and your confidence that it is the right next step.",
	"Reply with JSON only.",
].join(" ");

export interface RouterDecisionRequest {
	prompt: string;
	/** Base64 PNG screenshot; included only when the action model accepts images. */
	image?: string;
	/** Aborted when the segment ends; provider retries and sleeps stop. */
	signal?: AbortSignal;
}

export interface RouterDecisionOutcome {
	/** null when the reply was not a valid single choice from the action space. */
	action: string | null;
	params: Record<string, string>;
	/** Parsed confidence in [0, 1]; null on parse failure. */
	confidence: number | null;
	rawText: string;
	/** Why a malformed reply was refused; counts toward the refusal streak. */
	parseError?: string;
	/** Transport or model failure; fails the run. */
	modelError?: string;
	usage?: { inputTokens?: number; outputTokens?: number };
}

export interface RouterDecisionContext {
	model: Model<Api>;
	apiKey?: string;
	headers?: Record<string, string>;
	sessionId?: string;
	policy?: ProviderRetryPolicy;
	actions: Map<string, CompiledAction>;
}

export type RouterDecisionFunction = (request: RouterDecisionRequest) => Promise<RouterDecisionOutcome>;

/** The thinking level the System 1 decision calls run at: off, clamped per model. */
export function routerThinkingLevel(model: Model<Api>): ModelThinkingLevel {
	return clampThinkingLevel(model, "off");
}

function textOf(message: AssistantMessage): string {
	return message.content
		.filter((content): content is { type: "text"; text: string } => content.type === "text")
		.map((content) => content.text)
		.join("\n")
		.trim();
}

/**
 * Extract every JSON object in the reply, in reply order: the fenced block
 * first, then the raw text. parseDecision accepts the first candidate that
 * is a valid choice, so prose (or a discarded draft object) before the
 * decision object cannot turn a well-formed reply into a parse refusal.
 */
function extractJsonObjectCandidates(raw: string): Record<string, unknown>[] {
	const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
	const candidates: Record<string, unknown>[] = [];
	for (const source of [fenced?.[1], raw]) {
		if (!source) continue;
		candidates.push(...objectCandidatesFromText(source.trim()));
	}
	return candidates;
}

/** Greedy first-brace-to-last-brace slice first, then nearest balanced-brace slices. */
function objectCandidatesFromText(trimmed: string): Record<string, unknown>[] {
	const candidates: Record<string, unknown>[] = [];
	const start = trimmed.indexOf("{");
	if (start === -1) return candidates;
	const end = trimmed.lastIndexOf("}");
	if (end > start) {
		try {
			const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
			if (isJsonObject(parsed)) candidates.push(parsed);
		} catch {
			// Fall through to the balanced scan.
		}
	}
	// The balanced scan advances past each slice to the next open brace: a
	// brace pair in prose before the decision object must not pin every slice
	// to the first brace and hide a later well-formed choice.
	let scanFrom = start;
	while (scanFrom !== -1) {
		let depth = 0;
		let inString = false;
		let escaped = false;
		let close = -1;
		for (let index = scanFrom; index < trimmed.length; index += 1) {
			const char = trimmed[index];
			if (inString) {
				if (escaped) escaped = false;
				else if (char === "\\") escaped = true;
				else if (char === '"') inString = false;
				continue;
			}
			if (char === '"') inString = true;
			// Braces inside quoted strings (e.g. a parameter choice value) are
			// content, not structure; counting them misreads the object boundary.
			else if (char === "{") depth += 1;
			else if (char === "}") {
				depth -= 1;
				if (depth === 0) {
					close = index;
					break;
				}
			}
		}
		if (close === -1) {
			// An unclosed prose `{` must not end the scan: retry from the next
			// open brace so a later complete object is still recovered.
			scanFrom = trimmed.indexOf("{", scanFrom + 1);
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(trimmed.slice(scanFrom, close + 1));
			if (isJsonObject(parsed)) candidates.push(parsed);
		} catch {
			// Keep scanning for a later balanced slice.
		}
		scanFrom = trimmed.indexOf("{", close + 1);
	}
	return candidates;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse a decision against the compiled action space. Free text never passes.
 * The first JSON object that is a valid single choice wins, so prose (or a
 * discarded draft object) before the decision object must not turn a
 * well-formed choice into a refusal that counts toward the stuck streak.
 */
export function parseDecision(raw: string, actions: Map<string, CompiledAction>): RouterDecisionOutcome {
	const candidates = extractJsonObjectCandidates(raw);
	let firstRefusal: RouterDecisionOutcome | undefined;
	for (const object of candidates) {
		const outcome = validateDecisionObject(object, actions, raw);
		if (outcome.action !== null) return outcome;
		// The first candidate keeps the diagnostic about the earliest object.
		firstRefusal ??= outcome;
	}
	if (!firstRefusal) {
		return { action: null, params: {}, confidence: null, rawText: raw, parseError: "reply was not a JSON object" };
	}
	return firstRefusal;
}

/** Validate one extracted decision object against the compiled action space. */
function validateDecisionObject(
	object: Record<string, unknown>,
	actions: Map<string, CompiledAction>,
	raw: string,
): RouterDecisionOutcome {
	const actionName = object.action;
	if (typeof actionName !== "string" || !actions.has(actionName)) {
		return {
			action: null,
			params: {},
			confidence: null,
			rawText: raw,
			parseError: `unknown action ${JSON.stringify(actionName ?? null)}`,
		};
	}
	const action = actions.get(actionName);
	if (!action) {
		return { action: null, params: {}, confidence: null, rawText: raw, parseError: "unknown action" };
	}
	const params: Record<string, string> = {};
	const rawParams = object.params;
	if (rawParams !== undefined) {
		if (typeof rawParams !== "object" || rawParams === null || Array.isArray(rawParams)) {
			return {
				action: null,
				params: {},
				confidence: null,
				rawText: raw,
				parseError: "params must be an object",
			};
		}
		for (const [key, value] of Object.entries(rawParams as Record<string, unknown>)) {
			// Own-property checks only: inherited names like "constructor" must not
			// resolve against Object.prototype and crash the parse.
			const allowed = Object.hasOwn(action.params, key) ? action.params[key] : undefined;
			if (!allowed) {
				return {
					action: null,
					params: {},
					confidence: null,
					rawText: raw,
					parseError: `unknown param "${key}" for action "${actionName}"`,
				};
			}
			if (typeof value !== "string" || !Object.hasOwn(allowed.choices, value)) {
				return {
					action: null,
					params: {},
					confidence: null,
					rawText: raw,
					parseError: `param "${key}" value must be one of its declared choices`,
				};
			}
			params[key] = value;
		}
	}
	// Own-property check only: an inherited name like "constructor" must not
	// mask a missing required parameter.
	const missing = Object.keys(action.params).filter((paramName) => !Object.hasOwn(params, paramName));
	if (missing.length > 0) {
		return {
			action: null,
			params: {},
			confidence: null,
			rawText: raw,
			parseError: `missing param(s) ${missing.join(", ")} for action "${actionName}"`,
		};
	}
	const confidence = object.confidence;
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
		return {
			action: null,
			params: {},
			confidence: null,
			rawText: raw,
			parseError: "confidence must be a number in [0, 1]",
		};
	}
	return { action: actionName, params, confidence, rawText: raw };
}

export function supportsImages(model: Model<Api>): boolean {
	return (model.input ?? []).includes("image");
}

/**
 * Build the System 1 decision function: ONE model call per step with thinking
 * disabled (clamped per model), provider-retry, and strict single-choice
 * parsing against the declared action space.
 */
export function createModelDecisionFunction(context: RouterDecisionContext): RouterDecisionFunction {
	const thinkingLevel = routerThinkingLevel(context.model);
	const includeImages = supportsImages(context.model);
	return async (request) => {
		const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
			{ type: "text", text: request.prompt },
		];
		if (includeImages && request.image) {
			content.push({ type: "image", data: request.image, mimeType: "image/png" });
		}
		const message = await completeWithProviderRetry(
			() =>
				completeSimple(
					context.model,
					{
						systemPrompt: ROUTER_DECISION_SYSTEM_PROMPT,
						messages: [
							{
								role: "user",
								content,
								timestamp: Date.now(),
							},
						],
					},
					{
						reasoning: thinkingLevel,
						maxTokens: Math.min(context.model.maxTokens, ROUTER_DECISION_MAX_TOKENS),
						apiKey: context.apiKey,
						headers: context.headers,
						sessionId: context.sessionId,
					},
				),
			{ policy: context.policy, signal: request.signal },
		);
		const usage = {
			inputTokens: message.usage?.input,
			outputTokens: message.usage?.output,
		};
		if (message.stopReason === "error") {
			return {
				action: null,
				params: {},
				confidence: null,
				rawText: "",
				modelError: `decision model failed: ${message.errorMessage || "unknown error"}`,
				usage,
			};
		}
		if (message.stopReason === "length" || message.stopReason === "aborted") {
			return {
				action: null,
				params: {},
				confidence: null,
				rawText: "",
				modelError: `decision model stopped early (${message.stopReason})`,
				usage,
			};
		}
		const outcome = parseDecision(textOf(message), context.actions);
		return { ...outcome, usage };
	};
}
