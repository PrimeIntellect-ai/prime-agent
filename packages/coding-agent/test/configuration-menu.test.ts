import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	ConfigurationMenuComponent,
	type ConfigurationMenuTab,
} from "../src/modes/interactive/components/configuration-menu.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ConfigurationMenuComponent", () => {
	const harnesses: Harness[] = [];

	async function createMenu(
		options: {
			initialTab?: ConfigurationMenuTab;
			getRows?: () => number;
			requestRender?: () => void;
			onSelectProvider?: () => void;
			onSelectModel?: (model: { id: string }) => void;
			modelCount?: number;
			cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
			noCost?: boolean;
			onCancel?: () => void;
		} = {},
	): Promise<ConfigurationMenuComponent> {
		const specifications = Array.from({ length: options.modelCount ?? 1 }, (_, index) => ({
			id: `faux-${index + 1}`,
			name: index === 0 ? "Faux One" : `Faux ${index + 1}`,
			reasoning: true,
		}));
		const harness = await createHarness({ models: specifications });
		harnesses.push(harness);
		const model = harness.getModel("faux-1")!;
		const models = specifications.map(({ id }) => harness.getModel(id)!);
		if (options.cost) model.cost = options.cost;
		if (options.noCost) model.cost = undefined as unknown as typeof model.cost;
		return new ConfigurationMenuComponent({
			initialTab: options.initialTab ?? "providers",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{
					id: "serper",
					name: "Serper (web search)",
					authType: "api_key",
					category: "service",
				},
			],
			modelRegistry: harness.session.modelRegistry,
			currentModel: model,
			scopedModels: [],
			availableModels: models,
			configuredProviders: new Set([model.provider]),
			getRows: options.getRows,
			requestRender: options.requestRender ?? (() => {}),
			onSelectProvider: options.onSelectProvider ?? (() => {}),
			onSelectMcpConnection: () => {},
			onSelectModel: options.onSelectModel ?? (() => {}),
			onCancel: options.onCancel ?? (() => {}),
		});
	}

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		initTheme("dark");
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("renders one single-purpose picker per command without tab chrome", async () => {
		const requestRender = vi.fn();
		const selectProvider = vi.fn();
		const menu = await createMenu({ requestRender, onSelectProvider: selectProvider });

		let output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("Search providers");
		expect(output).toContain("Anthropic");
		expect(output).not.toContain("Faux One");
		expect(output).not.toContain("Serper (web search)");

		const models = await createMenu({ initialTab: "models" });
		output = stripAnsi(models.render(120).join("\n"));
		expect(output).toContain("Search models");
		expect(output).toContain("Faux One");
		expect(output).not.toContain("Anthropic");
		expect(output).not.toContain("Serper (web search)");

		const mcp = await createMenu({ initialTab: "mcp-connections" });
		output = stripAnsi(mcp.render(120).join("\n"));
		expect(output).toContain("Search MCP connections");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");

		menu.handleInput("a");
		menu.setActiveTab("models");
		menu.setActiveTab("providers");
		expect(menu.getSearchValue("providers")).toBe("a");
		expect(requestRender).toHaveBeenCalled();
		menu.handleInput("\r");
		expect(selectProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "anthropic" }));
	});

	it("renders no explanatory header above the picker search rows", async () => {
		const menu = await createMenu({ initialTab: "models" });
		const lines = stripAnsi(menu.render(120).join("\n")).split("\n");
		const output = lines.join("\n");
		expect(output).not.toContain("Models");
		expect(output).not.toContain("All models across supported providers.");
		expect(output).not.toContain("Providers");
		expect(output).not.toContain("Connect with a subscription or API key.");
		expect(output).not.toContain("MCP Connections");
		expect(output).not.toContain("Connect MCP integrations and service credentials.");
		// The search row is the first content; nothing renders above it.
		expect(lines[0]).toContain("─");
		expect(output).toContain("Search models");

		const providers = await createMenu({ initialTab: "providers" });
		const providerLines = stripAnsi(providers.render(120).join("\n")).split("\n");
		expect(providerLines[0]).toContain("─");
		expect(providerLines.join("\n")).toContain("Search providers");

		const mcp = await createMenu({ initialTab: "mcp-connections" });
		const mcpLines = stripAnsi(mcp.render(120).join("\n")).split("\n");
		expect(mcpLines[0]).toContain("─");
		expect(mcpLines.join("\n")).toContain("Search MCP connections");
	});

	it("keeps Tab and Shift+Tab inside the picker without switching bodies", async () => {
		const menu = await createMenu({ initialTab: "models" });
		menu.focused = true;
		const lines = stripAnsi(menu.render(120).join("\n")).split("\n");
		expect(lines.some((line) => line.includes("↑/↓ model"))).toBe(true);
		expect(lines.some((line) => line.includes("←/→ effort"))).toBe(true);
		expect(lines.some((line) => line.includes("Esc close"))).toBe(true);
		expect(lines.some((line) => line.includes("tabs"))).toBe(false);

		menu.handleInput("f");
		expect(menu.getSearchValue("models")).toBe("f");
		menu.handleInput("\t");
		expect(menu.getActiveTab()).toBe("models");
		expect(menu.focused).toBe(true);
		expect(menu.getSearchValue("models")).toBe("f");
		menu.handleInput("\x1b[Z");
		expect(menu.getActiveTab()).toBe("models");
		expect(menu.getSearchValue("models")).toBe("f");
	});

	it("keeps the existing catalog while syncing a post-login current model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Faux One", reasoning: true },
				{ id: "faux-2", name: "Faux Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const firstModel = harness.getModel("faux-1")!;
		const postLoginModel = harness.getModel("faux-2")!;
		const menu = new ConfigurationMenuComponent({
			initialTab: "models",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [],
			modelRegistry: harness.session.modelRegistry,
			currentModel: undefined,
			scopedModels: [],
			availableModels: [firstModel],
			configuredProviders: new Set([firstModel.provider]),
			initialModelSearch: "faux",
			requestRender: () => {},
			onSelectProvider: () => {},
			onSelectMcpConnection: () => {},
			onSelectModel: () => {},
			onCancel: () => {},
		});

		menu.updateModels(postLoginModel);
		let output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("faux-1");
		expect(menu.getSearchValue("models")).toBe("faux");

		menu.updateModels(postLoginModel, [firstModel, postLoginModel]);
		output = stripAnsi(menu.render(120).join("\n"));
		const postLoginRow = output.split("\n").find((line) => line.includes("Faux Two"));
		expect(postLoginRow).toContain("current");
	});

	it("keeps arrow keys in the active search field and uses Escape to close", async () => {
		const onCancel = vi.fn();
		const menu = await createMenu({ initialTab: "models", onCancel });

		menu.handleInput("\x1b[D");
		expect(menu.getActiveTab()).toBe("models");
		expect(onCancel).not.toHaveBeenCalled();

		menu.handleInput("a");
		menu.handleInput("n");
		menu.handleInput("\x1b[D");
		menu.handleInput("\x1b[C");

		expect(menu.getActiveTab()).toBe("models");
		expect(menu.getSearchValue()).toBe("an");

		menu.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("keeps each picker inside narrow viewports without overflowing", async () => {
		for (const tab of ["providers", "models", "mcp-connections"] as const) {
			const menu = await createMenu({ initialTab: tab, getRows: () => 24 });
			const lines = menu.render(24);
			expect(lines.length).toBeLessThanOrEqual(24);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(24);
			}
		}
	});

	it("keeps picker content visible across supported themes", async () => {
		const menu = await createMenu();

		for (const themeName of ["dark", "light", "prime"] as const) {
			initTheme(themeName);
			const rendered = menu.render(120).join("\n");
			expect(stripAnsi(rendered)).toContain("Anthropic");
			expect(rendered).not.toBe(stripAnsi(rendered));
		}
	});

	it("rounds catalog input, cached-input, and output rates per million tokens", async () => {
		const menu = await createMenu({
			initialTab: "models",
			cost: { input: 1.1525, cacheRead: 0.0000015, output: 2.75, cacheWrite: 3 },
		});
		for (const width of [120, 48]) {
			const lines = stripAnsi(menu.render(width).join("\n")).split("\n");
			const output = lines.join("\n");
			expect(output).toContain("Input");
			expect(output).toContain("Cached input");
			expect(output).toContain("Output");
			expect(output).toContain("$1.153");
			expect(output).toContain("<0.001");
			expect(output).toContain("$2.75");
			expect(output).not.toContain("$1.1525");
			expect(output).not.toContain("$3");
			// The header carries only the qualified model key; the unit trails the
			// price row and the block ends with clear whitespace.
			const headerLine = lines.find((line) => line.includes("faux/faux-1"));
			expect(headerLine).toBeDefined();
			expect(headerLine).not.toContain("dollars");
			expect(output).not.toContain("USD / 1M tokens");
			const unitLine = lines.find((line) => line.includes("dollars per 1 million tokens"));
			expect(unitLine).toBeDefined();
			expect(unitLine).toContain("Output");
			const lastPriceRow = lines.findIndex((line) => line.includes("$2.75"));
			expect(lastPriceRow).toBeGreaterThan(0);
			expect(lines[lastPriceRow + 1]?.trim()).toBe("");
		}
	});

	it("distinguishes catalog zero rates from invalid prices", async () => {
		const menu = await createMenu({
			initialTab: "models",
			cost: { input: 0, cacheRead: Number.NaN, output: Number.POSITIVE_INFINITY, cacheWrite: 0 },
		});
		const output = stripAnsi(menu.render(48).join("\n"));
		expect(output).toContain("Input: $0");
		expect(output).toContain("Cached input: —");
		expect(output).toContain("Output: —");
		expect(output).not.toMatch(/NaN|Infinity/);

		const missingCostMenu = await createMenu({ initialTab: "models", noCost: true });
		const missingCostOutput = stripAnsi(missingCostMenu.render(48).join("\n"));
		expect(missingCostOutput).toContain("Input: —");
		expect(missingCostOutput).toContain("Cached input: —");
		expect(missingCostOutput).toContain("Output: —");
	});

	it("keeps navigation and selection usable when an inline picker is resized", async () => {
		let rows = 20;
		const onSelectModel = vi.fn();
		const menu = await createMenu({ initialTab: "models", modelCount: 18, getRows: () => rows, onSelectModel });
		menu.render(120);
		menu.handleInput("\x1b[6~");
		for (const width of [120, 60, 24]) {
			rows = 12;
			const lines = menu.render(width);
			expect(lines.length).toBeLessThanOrEqual(rows);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
		}
		menu.handleInput("\r");
		expect(onSelectModel).toHaveBeenCalledOnce();
		expect(onSelectModel.mock.calls[0]?.[0].id).not.toBe("faux-1");
	});

	it("reserves space for search and selection on short, narrow terminals", async () => {
		const menu = await createMenu({ getRows: () => 8 });
		for (const tab of ["providers", "models", "mcp-connections"] as const) {
			menu.setActiveTab(tab);
			const lines = menu.render(24);
			expect(lines.length).toBeLessThanOrEqual(8);
			expect(stripAnsi(lines.join("\n"))).toContain("Enter select");
			for (const line of lines) expect(visibleWidth(line)).toBe(24);
		}
	});
});
