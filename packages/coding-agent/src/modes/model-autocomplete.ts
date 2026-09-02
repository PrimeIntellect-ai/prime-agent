import type { AutocompleteItem } from "@prime-intellect/prime-agent-tui";
import { fuzzyFilter } from "@prime-intellect/prime-agent-tui";

export interface ModelAutocompleteCandidate {
	id: string;
	provider: string;
}

export function getModelArgumentCompletions(
	prefix: string,
	models: ReadonlyArray<ModelAutocompleteCandidate>,
): AutocompleteItem[] | null {
	if (models.length === 0) return null;

	const items = models.map((model) => ({
		id: model.id,
		provider: model.provider,
		label: `${model.provider}/${model.id}`,
	}));
	const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);
	if (filtered.length === 0) return null;

	return filtered.map((item) => ({
		value: item.label,
		label: item.id,
		description: item.provider,
	}));
}
