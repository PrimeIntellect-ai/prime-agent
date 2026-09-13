import type { Api, Model } from "@earendil-works/pi-ai";
import type { HostRequestHandler } from "../../core/kernel/index.js";

export interface RlmModelMatch {
	provider: string;
	id: string;
	name: string;
	selector: string;
}

export interface RlmFindModelsResult {
	models: RlmModelMatch[];
}

export type RlmFindModelsHandler = (query: string, limit: number) => RlmFindModelsResult | Promise<RlmFindModelsResult>;

export const DEFAULT_RLM_MODEL_SEARCH_LIMIT = 8;
export const MAX_RLM_MODEL_SEARCH_LIMIT = 20;

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function findRlmModelMatches(query: string, models: Model<Api>[], limit: number): RlmModelMatch[] {
	const normalizedQuery = normalizeModelSearchText(query.trim());
	return models
		.map((model) => {
			const selector = `${model.provider}/${model.id}`;
			const fields = [selector, model.id, model.name || model.id];
			const normalizedFields = fields.map(normalizeModelSearchText);
			let score = normalizedQuery ? Number.POSITIVE_INFINITY : 0;
			if (normalizedQuery) {
				const exactIndex = normalizedFields.indexOf(normalizedQuery);
				const prefixIndex = normalizedFields.findIndex((field) => field.startsWith(normalizedQuery));
				const partialIndex = normalizedFields.findIndex((field) => field.includes(normalizedQuery));
				if (exactIndex >= 0) score = exactIndex;
				else if (prefixIndex >= 0) score = 3 + prefixIndex;
				else if (partialIndex >= 0) score = 6 + partialIndex;
			}
			return { model, selector, score };
		})
		.filter((candidate) => Number.isFinite(candidate.score))
		.sort((a, b) => a.score - b.score || a.selector.localeCompare(b.selector))
		.slice(0, limit)
		.map(({ model, selector }) => ({
			provider: model.provider,
			id: model.id,
			name: model.name || model.id,
			selector,
		}));
}

/** Search a bounded authenticated model catalog without adding it to the system prompt. */
export function createRlmFindModelsHostHandler(handler: RlmFindModelsHandler): HostRequestHandler {
	return async (payload) => {
		if (typeof payload.query !== "string") {
			throw new Error("rlm.find_models query must be a string");
		}
		const limit = payload.limit === undefined ? DEFAULT_RLM_MODEL_SEARCH_LIMIT : payload.limit;
		if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_RLM_MODEL_SEARCH_LIMIT) {
			throw new Error(`rlm.find_models limit must be an integer from 1 to ${MAX_RLM_MODEL_SEARCH_LIMIT}`);
		}
		return { models: (await handler(payload.query, limit as number)).models };
	};
}
