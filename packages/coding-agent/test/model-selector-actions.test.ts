import { parsePrimeInferenceModelCatalog } from "@earendil-works/pi-ai";
import { setKeybindings, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildPrimeInferenceModels } from "../src/core/prime-inference-model-catalog.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function getFauxModels(harness: Harness, count: number) {
	return Array.from({ length: count }, (_, index) => harness.getModel(`faux-${index + 1}`)!);
}

describe("ModelSelectorComponent", () => {
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

	it("does not write catalog OSC actions to the terminal", async () => {
		const harness = await createHarness({ models: [{ id: "base", name: "Base", reasoning: true }] });
		harnesses.push(harness);
		const osc = "\x1b]52;c;VFJJQUdF\x07";
		const entry = {
			id: "vendor/模型",
			display_name: `模型 é${osc}`,
			pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
			specs: {
				context_window: 1000,
				max_output_tokens: 100,
				supports_reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
			},
		};
		const models = buildPrimeInferenceModels(
			[],
			parsePrimeInferenceModelCatalog({
				data: [entry, { ...entry, id: `vendor/bad${osc}` }],
			}),
		)!;
		expect(models.map((model) => model.id)).toEqual([entry.id]);
		const terminal = new VirtualTerminal(120, 40);
		const write = vi.spyOn(terminal, "write");
		const tui = new TUI(terminal);
		const selector = new ModelSelectorComponent(
			tui,
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: models,
				configuredProviders: new Set(["prime-inference"]),
			},
		);
		tui.addChild(selector);
		tui.start();
		try {
			await terminal.waitForRender();
			const output = write.mock.calls.map(([data]) => data).join("");
			expect(output).not.toContain(osc);
			expect(output).toContain("模型 é");
			expect(output).toContain(entry.id);
		} finally {
			tui.stop();
		}
	});

	it("explains model authentication without a provider shortcut", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
		});
		harnesses.push(harness);

		let selectedModel: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedModel = model.id;
			},
			() => {},
			undefined,
			{
				subtitle: "Choose a Prime model, or add another provider.",
			},
		);

		await waitForAsyncRender();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Choose a Prime model, or add another provider.");
		expect(output).toContain("Signed-in providers first.");
		expect(output).not.toContain("opens providers");

		selector.handleInput("\r");
		expect(selectedModel).toBe("faux-1");
	});

	it("renders injected daemon models without refreshing the local registry", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "Local One", reasoning: true }],
		});
		harnesses.push(harness);

		const localModel = harness.getModel("faux-1")!;
		const connectionModel = { ...localModel, name: "Connection One" };
		const refresh = vi.spyOn(harness.session.modelRegistry, "refresh");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			localModel,
			harness.session.modelRegistry,
			[{ model: localModel }],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [connectionModel],
			},
		);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Connection One");
		expect(output).not.toContain("Local One");
		expect(refresh).not.toHaveBeenCalled();

		selector.updateAvailableModels([connectionModel]);

		expect(refresh).not.toHaveBeenCalled();
	});

	it("updates injected models without clearing the current search", async () => {
		const harness = await createHarness({
			models: [
				{ id: "alpha", name: "Alpha", reasoning: true },
				{ id: "beta", name: "Beta", reasoning: true },
			],
		});
		harnesses.push(harness);

		const alpha = harness.getModel("alpha")!;
		const beta = harness.getModel("beta")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"beta",
			{
				availableModels: [alpha],
			},
		);

		await waitForAsyncRender();
		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("Beta");

		await selector.updateAvailableModels([beta]);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(selector.getSearchInput().getValue()).toBe("beta");
		expect(output).toContain("beta");
		expect(output).toContain("Beta");
	});

	it("keeps an empty injected model snapshot empty instead of falling back to local models", async () => {
		const harness = await createHarness({
			models: [{ id: "alpha", name: "Alpha", reasoning: true }],
		});
		harnesses.push(harness);

		const alpha = harness.getModel("alpha")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [alpha],
			},
		);

		await waitForAsyncRender();
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Alpha");

		await selector.updateAvailableModels([]);

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).not.toContain("Alpha");
		expect(output).toContain("No matching models");
	});

	it("keeps the model menu within a short terminal viewport", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux Model ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{ availableModels: getFauxModels(harness, 12), getRows: () => 12 },
		);

		await waitForAsyncRender();

		expect(selector.render(120).length).toBeLessThanOrEqual(12);

		selector.handleInput("\x1b[B");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(selector.render(120).length).toBeLessThanOrEqual(12);
		expect(output).toContain("faux-2");
		expect(output).toContain("(2/12)");
	});

	it("keeps signed-in matches above unsigned matches and orders by quality within them", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const signedInExact = { ...base, provider: "prime-inference", id: "z-ai/glm-5.2", name: "GLM 5.2" };
		const signedOutExact = { ...base, provider: "opencode", id: "glm-5.2", name: "GLM 5.2" };
		const signedInFuzzy = {
			...base,
			provider: "prime-inference",
			id: "glorious-language-model-5.2",
			name: "Glorious Language Model 5.2",
		};
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"glm5.2",
			{
				availableModels: [signedInFuzzy, signedOutExact, signedInExact],
				configuredProviders: new Set(["prime-inference"]),
			},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const signedInExactRow = lines.findIndex((line) => line.includes("z-ai/glm-5.2"));
		const signedOutExactRow = lines.findIndex((line) => line.includes("opencode"));
		const signedInFuzzyRow = lines.findIndex((line) => line.includes("glorious-language-model-5.2"));
		expect(signedInExactRow).toBeGreaterThanOrEqual(0);
		expect(signedInExactRow).toBeLessThan(signedInFuzzyRow);
		expect(signedInFuzzyRow).toBeLessThan(signedOutExactRow);
	});

	it("orders provider-qualified exact, prefix, and fuzzy matches by quality", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const exact = { ...base, provider: "openai", id: "gpt-5", name: "GPT-5" };
		const prefix = { ...base, provider: "openai", id: "openai-gpt-5-preview", name: "GPT-5 Preview" };
		const fuzzy = { ...base, provider: "openai", id: "other-openai-gpt-5", name: "Other GPT-5" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"openai/gpt5",
			{
				availableModels: [fuzzy, prefix, exact],
				configuredProviders: new Set(["openai"]),
			},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const exactRow = lines.findIndex(
			(line) => line.includes("gpt-5") && !line.includes("preview") && !line.includes("other-"),
		);
		const prefixRow = lines.findIndex((line) => line.includes("openai-gpt-5-preview"));
		const fuzzyRow = lines.findIndex((line) => line.includes("other-openai-gpt-5"));
		expect(exactRow).toBeGreaterThanOrEqual(0);
		expect(exactRow).toBeLessThan(prefixRow);
		expect(prefixRow).toBeLessThan(fuzzyRow);
	});

	it("keeps signed-in providers above unsigned matches in search results", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const primeCodex = { ...base, provider: "prime-inference", id: "codex-prime", name: "Prime Codex Model" };
		const openaiExact = { ...base, provider: "openai", id: "codex", name: "Standard Codex" };
		const openaiWeaker = { ...base, provider: "openai", id: "glorious-codex-thing", name: "Glorious Codex" };
		const opencodeCodex = { ...base, provider: "opencode", id: "gpt-5-codex", name: "Rival Codex" };
		const vercelCodex = {
			...base,
			provider: "vercel-ai-gateway",
			id: "codex-gateway",
			name: "Gateway Codex",
		};
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"codex",
			{
				availableModels: [opencodeCodex, vercelCodex, openaiWeaker, openaiExact, primeCodex],
				configuredProviders: new Set(["prime-inference", "openai"]),
				inline: true,
			},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(80).join("\n")).split("\n");
		const rowOf = (text: string) => lines.findIndex((line) => line.includes(text));
		const primeRow = rowOf("Prime Codex Model");
		const openaiExactRow = rowOf("Standard Codex");
		const openaiWeakerRow = rowOf("Glorious Codex");
		const opencodeRow = rowOf("Rival Codex");
		const vercelRow = rowOf("Gateway Codex");
		expect(primeRow).toBeGreaterThanOrEqual(0);
		expect(primeRow).toBeLessThan(openaiExactRow);
		expect(openaiExactRow).toBeLessThan(openaiWeakerRow);
		expect(openaiWeakerRow).toBeLessThan(opencodeRow);
		expect(openaiWeakerRow).toBeLessThan(vercelRow);
	});

	it("right-aligns the provider with the require sign in hint to its left", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const configured = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One" };
		const unconfigured = { ...base, provider: "unsigned-zeta", id: "zeta-one", name: "Zeta One" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [configured, unconfigured],
				configuredProviders: new Set([configured.provider]),
				inline: true,
			},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(80).join("\n")).split("\n");
		const configuredRow = lines.find((line) => line.includes("Beta One"));
		const unconfiguredRow = lines.find((line) => line.includes("Zeta One"));
		expect(configuredRow).toBeDefined();
		expect(unconfiguredRow).toBeDefined();
		expect(configuredRow?.endsWith("signed-in-beta")).toBe(true);
		expect(unconfiguredRow?.endsWith("unsigned-zeta")).toBe(true);
		expect(unconfiguredRow).toContain("require sign in · unsigned-zeta");
		expect(configuredRow).not.toContain("require sign in");
	});

	it("pins signed-in Prime Inference models above other signed-in providers", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const prime = { ...base, provider: "prime-inference", id: "glm-5-3", name: "GLM 5.3" };
		const signedIn = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One" };
		const unsigned = { ...base, provider: "unsigned-zeta", id: "zeta-one", name: "Zeta One" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [unsigned, signedIn, prime],
				configuredProviders: new Set([prime.provider, signedIn.provider]),
				inline: true,
			},
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(80).join("\n")).split("\n");
		const primeRow = lines.findIndex((line) => line.includes("GLM 5.3"));
		const signedInRow = lines.findIndex((line) => line.includes("Beta One"));
		const unsignedRow = lines.findIndex((line) => line.includes("Zeta One"));
		expect(primeRow).toBeGreaterThanOrEqual(0);
		expect(primeRow).toBeLessThan(signedInRow);
		expect(signedInRow).toBeLessThan(unsignedRow);
	});

	it("keeps Prime Inference models ordered with the rest when it is not signed in", async () => {
		const previousPrimeKey = process.env.PRIME_API_KEY;
		delete process.env.PRIME_API_KEY;
		try {
			const harness = await createHarness({
				models: [{ id: "base", name: "Base", reasoning: true }],
			});
			harnesses.push(harness);

			const base = harness.getModel("base")!;
			const prime = { ...base, provider: "prime-inference", id: "glm-5-3", name: "GLM 5.3" };
			const signedIn = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One" };
			const unsigned = { ...base, provider: "a-unsigned", id: "alpha-one", name: "Alpha One" };
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				undefined,
				harness.session.modelRegistry,
				[],
				() => {},
				() => {},
				undefined,
				{
					availableModels: [prime, signedIn, unsigned],
					configuredProviders: new Set([signedIn.provider]),
					inline: true,
				},
			);

			await waitForAsyncRender();

			const lines = stripAnsi(selector.render(80).join("\n")).split("\n");
			const primeRow = lines.findIndex((line) => line.includes("GLM 5.3"));
			const signedInRow = lines.findIndex((line) => line.includes("Beta One"));
			const unsignedRow = lines.findIndex((line) => line.includes("Alpha One"));
			expect(signedInRow).toBeGreaterThanOrEqual(0);
			expect(signedInRow).toBeLessThan(unsignedRow);
			expect(unsignedRow).toBeLessThan(primeRow);
			expect(lines.findIndex((line) => line.includes("require sign in · prime-inference"))).toBe(primeRow);
		} finally {
			if (previousPrimeKey === undefined) {
				delete process.env.PRIME_API_KEY;
			} else {
				process.env.PRIME_API_KEY = previousPrimeKey;
			}
		}
	});

	it("renders effort squares for the preselected level and adjusts with left/right", async () => {
		const harness = await createHarness({
			models: [{ id: "reasoning", name: "Reasoning One", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("reasoning")!;
		const model = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [model],
				configuredProviders: new Set([model.provider]),
				inline: true,
				thinkingLevel: "low",
			},
		);

		await waitForAsyncRender();

		const row = () =>
			stripAnsi(selector.render(80).join("\n"))
				.split("\n")
				.find((line) => line.includes("Beta One"));

		expect(row()).toContain("← ● ● ○ ○ → low");
		// The cluster sits near the row's horizontal center, clear of the name.
		expect(row()?.search(/[●○]/)).toBe(34);

		selector.handleInput("\x1b[C");
		expect(row()).toContain("● ● ● ○");
		expect(row()).toContain("medium");

		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[D");
		expect(row()).toContain("○ ○ ○ ○");
		expect(row()).toContain("off");

		selector.handleInput("\x1b[D");
		expect(row()).toContain("● ● ● ●");
		expect(row()).toContain("high");
	});

	it("shows no effort squares for models without reasoning support", async () => {
		const harness = await createHarness({
			models: [{ id: "base", name: "Base", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("base")!;
		const model = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One", reasoning: false };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [model],
				configuredProviders: new Set([model.provider]),
				inline: true,
				thinkingLevel: "high",
			},
		);

		await waitForAsyncRender();

		const renderRow = () =>
			stripAnsi(selector.render(80).join("\n"))
				.split("\n")
				.find((line) => line.includes("Beta One"));

		expect(renderRow()).toBeDefined();
		expect(renderRow()).not.toContain("●");
		expect(renderRow()).not.toContain("○");
		expect(renderRow()).not.toContain("←");
		expect(renderRow()).not.toContain("→");

		selector.handleInput("\x1b[C");
		expect(renderRow()).not.toContain("●");
	});

	it("applies the selected model and effort level together on confirm", async () => {
		const harness = await createHarness({
			models: [{ id: "reasoning", name: "Reasoning One", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("reasoning")!;
		const model = { ...base, provider: "signed-in-beta", id: "beta-one", name: "Beta One" };
		let selectedId: string | undefined;
		let selectedLevel: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			(selected, thinkingLevel) => {
				selectedId = selected.id;
				selectedLevel = thinkingLevel;
			},
			() => {},
			undefined,
			{
				availableModels: [model],
				configuredProviders: new Set([model.provider]),
				inline: true,
			},
		);

		await waitForAsyncRender();

		const row = () =>
			stripAnsi(selector.render(80).join("\n"))
				.split("\n")
				.find((line) => line.includes("Beta One"));
		expect(row()).toContain("○ ○ ○ ○");
		expect(row()).toContain("off");

		selector.handleInput("\x1b[C");
		expect(row()).toContain("● ○ ○ ○");

		selector.handleInput("\r");
		expect(selectedId).toBe("beta-one");
		expect(selectedLevel).toBe("minimal");
	});

	it("aligns effort squares, arrows, and labels across rows", async () => {
		const harness = await createHarness({
			models: [{ id: "reasoning", name: "Reasoning One", reasoning: true }],
		});
		harnesses.push(harness);

		const base = harness.getModel("reasoning")!;
		const short = { ...base, provider: "signed-in-beta", id: "beta-one", name: "GLM 5.3" };
		const long = { ...base, provider: "unsigned-zeta", id: "zeta-one", name: "A Considerably Longer Model Name" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [short, long],
				configuredProviders: new Set([short.provider]),
				inline: true,
				thinkingLevel: "low",
			},
		);

		await waitForAsyncRender();

		const rawLines = selector.render(80).join("\n").split("\n");
		const lines = rawLines.map((line) => stripAnsi(line));
		const shortRow = lines.find((line) => line.includes("GLM 5.3"));
		const longRow = lines.find((line) => line.includes("A Considerably Longer"));
		expect(shortRow).toBeDefined();
		expect(longRow).toBeDefined();
		expect(shortRow?.search(/[●○]/)).toBe(longRow?.search(/[●○]/));
		expect(shortRow?.indexOf(" low")).toBe(longRow?.indexOf(" low"));
		expect(shortRow).toContain("←");
		expect(shortRow).toContain("→");
		expect(longRow).not.toContain("←");
		expect(longRow).not.toContain("→");
		expect(longRow).toContain("● ● ○ ○");

		// Purple fills are reserved for the highlighted row; other rows fill light gray.
		const shortRaw = rawLines.find((line) => line.includes("GLM 5.3"));
		const longRaw = rawLines.find((line) => line.includes("A Considerably Longer"));
		expect(shortRaw).toContain(theme.getEffortSquareColor()("●"));
		expect(shortRaw).toContain(theme.fg("dim", "○"));
		expect(longRaw).not.toContain(theme.getEffortSquareColor()("●"));
		expect(longRaw).toContain(theme.fg("muted", "●"));
		expect(longRaw).toContain(theme.fg("dim", "○"));
	});

	it("uses current model, recency, and alphabetical order for equivalent matches", async () => {
		const harness = await createHarness({
			models: [
				{ id: "glm-5", name: "GLM 5", reasoning: true },
				{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
				{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
				{ id: "glm-6", name: "GLM 6", reasoning: true },
			],
		});
		harnesses.push(harness);

		const provider = harness.getModel("glm-5")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("glm-5.1"),
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"glm",
			{ recentModels: [`${provider}/glm-5.2`] },
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const currentRow = lines.findIndex((line) => /glm-5\.1/.test(line));
		const recentRow = lines.findIndex((line) => /glm-5\.2/.test(line));
		const alphabeticalRow = lines.findIndex((line) => /glm-5(?![.\d])/.test(line));
		const lastRow = lines.findIndex((line) => /glm-6/.test(line));
		expect(currentRow).toBeGreaterThanOrEqual(0);
		expect(currentRow).toBeLessThan(recentRow);
		expect(recentRow).toBeLessThan(alphabeticalRow);
		expect(alphabeticalRow).toBeLessThan(lastRow);
	});

	it("treats a whitespace-only query as no search and keeps the current model first", async () => {
		const harness = await createHarness({
			models: [
				{ id: "glm-5", name: "GLM 5", reasoning: true },
				{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
				{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
			],
		});
		harnesses.push(harness);

		const provider = harness.getModel("glm-5")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("glm-5"),
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"   ",
			{ recentModels: [`${provider}/glm-5.2`, `${provider}/glm-5.1`] },
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const firstRow = lines.findIndex((line) => /glm-5/.test(line));
		expect(/glm-5(?![.\d])/.test(lines[firstRow] ?? "")).toBe(true);
	});

	it("keeps scoped model help within a short terminal viewport", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux Model ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);
		const scopedModel = harness.getModel("faux-1");
		if (!scopedModel) {
			throw new Error("Missing model faux-1");
		}

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			[{ model: scopedModel }],
			() => {},
			() => {},
			undefined,
			{ availableModels: getFauxModels(harness, 12), getRows: () => 16 },
		);

		await waitForAsyncRender();

		let lines = selector.render(120);
		let output = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(16);
		expect(output).toContain("Scope: ");
		expect(output).toContain(`${process.platform === "darwin" ? "Option" : "Alt"}+S scope`);
		expect(output).toContain("(all/scoped)");
		expect(output).not.toContain("(1/12)");

		selector.handleInput("\x1bs");
		lines = selector.render(120);
		output = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(16);
		expect(output).toContain("(1/12)");
	});
});
