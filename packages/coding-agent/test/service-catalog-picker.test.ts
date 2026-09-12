import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { McpPluginView } from "../src/core/mcp/service-catalog.js";
import { ServiceCatalogPickerComponent } from "../src/modes/interactive/components/service-catalog-picker.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";

function viewFixture(overrides: Partial<McpPluginView> = {}): McpPluginView {
	return {
		serviceId: "acme",
		label: "Acme",
		connectionStatus: "not_connected",
		connectable: true,
		usesOAuth: true,
		source: "catalog",
		connectionIds: [],
		...overrides,
	};
}

describe("ServiceCatalogPickerComponent", () => {
	beforeAll(async () => {
		initTheme("dark");
		// initTheme fire-and-forgets the cli-highlight preload; settle it before
		// teardown or vitest records an EnvironmentTeardownError unhandled
		// rejection (a pre-existing race, see ENG-6108 notes).
		await preloadCodeHighlighter();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders service cards with honest status text", () => {
		const picker = new ServiceCatalogPickerComponent(
			[
				viewFixture({ serviceId: "notion", label: "Notion", connectionStatus: "connected", toolCount: 4 }),
				viewFixture({ serviceId: "linear", label: "Linear" }),
				viewFixture({
					serviceId: "brandapp",
					label: "BrandApp",
					connectionStatus: "setup_required",
					connectable: false,
					setupHint: "Requires a developer app.",
				}),
				viewFixture({ serviceId: "stale", label: "Stale", connectionStatus: "error" }),
			],
			() => {},
			() => {},
		);
		const output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Notion");
		expect(output).toContain("Connected · 4 tools");
		expect(output).toContain("Connect");
		expect(output).toContain("Requires setup");
		expect(output).toContain("Requires a developer app.");
		expect(output).toContain("Reconnect");
	});

	it("labels stored unverified credentials as needing verification, not an active login", () => {
		const picker = new ServiceCatalogPickerComponent(
			[viewFixture({ connectionStatus: "pending" })],
			() => {},
			() => {},
		);
		const output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Needs verification");
		expect(output).not.toContain("Verifying");
	});

	it("filters cards as the user types and restores the full list when cleared", () => {
		const picker = new ServiceCatalogPickerComponent(
			[
				viewFixture({ serviceId: "linear", label: "Linear", description: "Issue tracking" }),
				viewFixture({ serviceId: "notion", label: "Notion", description: "Docs and wikis" }),
			],
			() => {},
			() => {},
		);
		picker.handleInput("n");
		picker.handleInput("o");
		let output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Notion");
		expect(output).not.toContain("Linear");

		picker.handleInput("\x7f");
		picker.handleInput("\x7f");
		output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Linear");
		expect(output).toContain("Notion");
	});

	it("selects the highlighted card on Enter and reports cancellation on Escape", () => {
		const selections: string[] = [];
		let cancelled = false;
		const picker = new ServiceCatalogPickerComponent(
			[viewFixture({ serviceId: "linear", label: "Linear" }), viewFixture({ serviceId: "notion", label: "Notion" })],
			(service) => {
				selections.push(service.serviceId);
			},
			() => {
				cancelled = true;
			},
		);
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(selections).toEqual(["notion"]);

		picker.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	it("pre-fills the search from /plugins arguments", () => {
		const picker = new ServiceCatalogPickerComponent(
			[viewFixture({ serviceId: "linear", label: "Linear" }), viewFixture({ serviceId: "notion", label: "Notion" })],
			() => {},
			() => {},
			{ initialSearch: "lin" },
		);
		const output = stripAnsi(picker.render(120).join("\n"));
		expect(output).toContain("Linear");
		expect(output).not.toContain("Notion");
	});
});
