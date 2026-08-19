import type { Api, Model } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { formatNoModelsAvailableMessage } from "../core/auth-guidance.js";
import type { ModelRegistry } from "../core/model-registry.js";

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		const millions = count / 1_000_000;
		return millions % 1 === 0 ? `${millions}M` : `${millions.toFixed(1)}M`;
	}
	if (count >= 1_000) {
		const thousands = count / 1_000;
		return thousands % 1 === 0 ? `${thousands}K` : `${thousands.toFixed(1)}K`;
	}
	return count.toString();
}

export async function listModels(modelRegistry: ModelRegistry, searchPattern?: string): Promise<void> {
	const loadError = modelRegistry.getError();
	if (loadError) {
		console.error(chalk.yellow(`Warning: errors loading models.json:\n${loadError}`));
	}

	const models = await modelRegistry.refreshAvailableModels();

	if (models.length === 0) {
		console.log(formatNoModelsAvailableMessage());
		return;
	}

	let filteredModels: Model<Api>[] = models;
	if (searchPattern) {
		filteredModels = fuzzyFilter(models, searchPattern, (m) => `${m.provider} ${m.id}`);
	}

	if (filteredModels.length === 0) {
		console.log(`No models matching "${searchPattern}"`);
		return;
	}

	filteredModels.sort((a, b) => {
		const providerCmp = a.provider.localeCompare(b.provider);
		if (providerCmp !== 0) return providerCmp;
		return a.id.localeCompare(b.id);
	});

	const rows = filteredModels.map((m) => ({
		provider: m.provider,
		model: m.id,
		context: formatTokenCount(m.contextWindow),
		maxOut: formatTokenCount(m.maxTokens),
		thinking: m.reasoning ? "yes" : "no",
		images: m.input.includes("image") ? "yes" : "no",
	}));

	const headers = {
		provider: "provider",
		model: "model",
		context: "context",
		maxOut: "max-out",
		thinking: "thinking",
		images: "images",
	};

	const widths = {
		provider: Math.max(headers.provider.length, ...rows.map((r) => r.provider.length)),
		model: Math.max(headers.model.length, ...rows.map((r) => r.model.length)),
		context: Math.max(headers.context.length, ...rows.map((r) => r.context.length)),
		maxOut: Math.max(headers.maxOut.length, ...rows.map((r) => r.maxOut.length)),
		thinking: Math.max(headers.thinking.length, ...rows.map((r) => r.thinking.length)),
		images: Math.max(headers.images.length, ...rows.map((r) => r.images.length)),
	};

	const headerLine = [
		headers.provider.padEnd(widths.provider),
		headers.model.padEnd(widths.model),
		headers.context.padEnd(widths.context),
		headers.maxOut.padEnd(widths.maxOut),
		headers.thinking.padEnd(widths.thinking),
		headers.images.padEnd(widths.images),
	].join("  ");
	console.log(headerLine);

	for (const row of rows) {
		const line = [
			row.provider.padEnd(widths.provider),
			row.model.padEnd(widths.model),
			row.context.padEnd(widths.context),
			row.maxOut.padEnd(widths.maxOut),
			row.thinking.padEnd(widths.thinking),
			row.images.padEnd(widths.images),
		].join("  ");
		console.log(line);
	}
}
