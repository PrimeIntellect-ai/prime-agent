import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ModelSelectorComponent custom model ids", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("keeps an arbitrary provider-style model id on the current provider", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const base = harness.getModel("base")!;
		const current = {
			...base,
			provider: "cline",
			id: "anthropic/claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.cline.bot/api/v1",
		};
		const externalMatch = {
			...base,
			provider: "openrouter",
			id: "deepseek/deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			baseUrl: "https://openrouter.ai/api/v1",
		};
		let selectedProvider: string | undefined;
		let selectedId: string | undefined;
		let selectedBaseUrl: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedProvider = model.provider;
				selectedId = model.id;
				selectedBaseUrl = model.baseUrl;
			},
			() => {},
			"deepseek/deepseek-v4-flash",
			{
				availableModels: [current, externalMatch],
				configuredProviders: new Set(["cline", "openrouter"]),
			},
		);

		await waitForAsyncRender();
		selector.handleInput("\r");

		expect(selectedProvider).toBe("cline");
		expect(selectedId).toBe("deepseek/deepseek-v4-flash");
		expect(selectedBaseUrl).toBe("https://api.cline.bot/api/v1");
	});

	it("keeps fuzzy search as autocomplete for the current provider", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const base = harness.getModel("base")!;
		const current = {
			...base,
			provider: "cline",
			id: "anthropic/claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.cline.bot/api/v1",
		};
		let selectedId: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedId = model.id;
			},
			() => {},
			"sonnet",
			{ availableModels: [current], configuredProviders: new Set(["cline"]) },
		);

		await waitForAsyncRender();
		selector.handleInput("\r");

		expect(selectedId).toBe("anthropic/claude-sonnet-4-6");
	});

	it("accepts an unknown plain model id when the current provider has no catalog match", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const base = harness.getModel("base")!;
		const current = {
			...base,
			provider: "cline",
			id: "anthropic/claude-sonnet-4-6",
			name: "Claude Sonnet 4.6",
			baseUrl: "https://api.cline.bot/api/v1",
		};
		let selectedId: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			current,
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedId = model.id;
			},
			() => {},
			"vendor-model-v99",
			{ availableModels: [current], configuredProviders: new Set(["cline"]) },
		);

		await waitForAsyncRender();
		selector.handleInput("\r");

		expect(selectedId).toBe("vendor-model-v99");
	});
});
