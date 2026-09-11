import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { THINKING_LEVELS } from "../../core/thinking-levels.js";

const RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH = 64;
export function normalizeRequestedRlmSubagentSessionName(value: unknown, operation = "rlm.spawn"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} name must be a string`);
	}
	const name = value.trim();
	if (!name) {
		throw new Error(`${operation} name must not be empty`);
	}
	if (name.length > RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH) {
		throw new Error(`${operation} name must be at most ${RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH} characters`);
	}
	return name;
}

export function normalizeRequestedRlmSubagentThinkingLevel(
	value: unknown,
	operation = "rlm.spawn",
): ThinkingLevel | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} thinking must be a string`);
	}
	const level = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(level as ThinkingLevel)) {
		throw new Error(`${operation} thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
	}
	return level as ThinkingLevel;
}

export function normalizeRequestedRlmSubagentModel(value: unknown, operation = "rlm.spawn"): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${operation} model must be a string`);
	}
	const model = value.trim();
	if (!model) {
		throw new Error(`${operation} model must not be empty`);
	}
	return model;
}

/** Create a readable, collision-resistant default name usable as an agent-message selector. */
export function createDefaultRlmSubagentSessionName(prompt: string, childId: string): string {
	const promptSlug = prompt
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const idSuffix =
		childId
			.replace(/^sub-/, "")
			.replace(/[^A-Za-z0-9]+/g, "")
			.slice(-8) || "child";
	const fixedLength = "subagent--".length + idSuffix.length;
	const promptPart = (promptSlug || "worker")
		.slice(0, Math.max(1, RLM_SUBAGENT_SESSION_NAME_MAX_LENGTH - fixedLength))
		.replace(/-+$/g, "");
	return `subagent-${promptPart || "worker"}-${idSuffix}`;
}
