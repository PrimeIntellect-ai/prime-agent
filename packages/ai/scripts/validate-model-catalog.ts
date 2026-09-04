import type { Api } from "../src/types.js";

/** The subset of a catalog row the invariants read; MODELS rows satisfy it. */
export interface CatalogRowLike {
	id: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

export type CatalogLike = Readonly<Record<string, Readonly<Record<string, CatalogRowLike>>>>;

/**
 * Explicit API classification for GitHub Copilot models. Copilot serves each
 * model family through exactly one endpoint; a new family must be classified
 * here before it can ship (unclassified ids fail catalog validation).
 */
export function copilotModelApi(modelId: string): Api | undefined {
	if (modelId.startsWith("claude-")) return "anthropic-messages";
	// Served only through the Copilot /responses endpoint; /chat/completions
	// rejects these families (upstream pi-mono PR #906).
	if (
		modelId.startsWith("gpt-5") ||
		modelId.startsWith("oswe") ||
		modelId.startsWith("grok-") ||
		modelId.startsWith("mai-")
	) {
		return "openai-responses";
	}
	if (modelId.startsWith("gemini-") || modelId.startsWith("kimi-")) return "openai-completions";
	return undefined;
}

function familyKey(modelId: string): string {
	const segments = modelId.split("/");
	return segments[segments.length - 1].toLowerCase();
}

/**
 * Thinking levels a user can select from a map. The "off" level is excluded:
 * whether thinking can be disabled legitimately varies per provider transport
 * (e.g. reasoning effort "none" exists only on the native OpenAI Responses API).
 */
function selectableLevels(map: Readonly<Record<string, string | null>>): string {
	return Object.entries(map)
		.filter(([level, mapped]) => level !== "off" && mapped !== null)
		.map(([level]) => level)
		.sort()
		.join(",");
}

/** Generation-time catalog invariants; an empty return means the catalog is valid. */
export function validateModelCatalog(catalog: CatalogLike): string[] {
	const violations: string[] = [];

	for (const [provider, models] of Object.entries(catalog)) {
		for (const model of Object.values(models)) {
			if (model.maxTokens > model.contextWindow) {
				violations.push(
					`${provider}/${model.id}: maxTokens ${model.maxTokens} exceeds contextWindow ${model.contextWindow}`,
				);
			}
		}
	}

	for (const model of Object.values(catalog["github-copilot"] ?? {})) {
		const expectedApi = copilotModelApi(model.id);
		if (expectedApi === undefined) {
			violations.push(
				`github-copilot/${model.id}: unclassified model family; add it to copilotModelApi in validate-model-catalog.ts`,
			);
		} else if (model.api !== expectedApi) {
			violations.push(`github-copilot/${model.id}: api ${model.api} does not match classification ${expectedApi}`);
		}
	}

	for (const model of Object.values(catalog["openai-codex"] ?? {})) {
		const openaiTwin = catalog.openai?.[model.id];
		if (!openaiTwin) continue;
		const ratio = openaiTwin.contextWindow / model.contextWindow;
		if (ratio > 2 || ratio < 0.5) {
			violations.push(
				`openai-codex/${model.id}: contextWindow ${model.contextWindow} diverges more than 2x from openai/${model.id} (${openaiTwin.contextWindow})`,
			);
		}
	}

	const familyLevels = new Map<string, Map<string, string>>();
	for (const [provider, models] of Object.entries(catalog)) {
		for (const model of Object.values(models)) {
			if (!model.thinkingLevelMap) continue;
			const key = `${familyKey(model.id)} [${model.api}]`;
			const seen = familyLevels.get(key) ?? new Map<string, string>();
			seen.set(`${provider}/${model.id}`, selectableLevels(model.thinkingLevelMap));
			familyLevels.set(key, seen);
		}
	}
	for (const [key, seen] of familyLevels) {
		const distinct = new Set(seen.values());
		if (distinct.size > 1) {
			const detail = [...seen.entries()].map(([row, levels]) => `${row}=[${levels}]`).join(", ");
			violations.push(`${key}: thinkingLevelMap selectable levels disagree across providers: ${detail}`);
		}
	}

	return violations;
}
