import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
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

	it("renders compact inline rows with honest status text", () => {
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
		expect(output).not.toContain("Requires a developer app.");
		expect(output).toContain("Reconnect");
		picker.handleInput("\x1b[B");
		picker.handleInput("\x1b[B");
		const selected = stripAnsi(picker.render(120).join("\n"));
		expect(selected).toContain("Requires a developer app.");
		expect(selected).toContain("setup guidance");
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

	it("uses the shared inline row and bordered search instead of card padding", () => {
		const picker = new ServiceCatalogPickerComponent(
			[viewFixture({ label: "Acme", description: "Selected detail" })],
			() => {},
			() => {},
		);
		const lines = picker.render(80).map(stripAnsi);
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines[1]).toContain("Search MCP connections");
		expect(lines[2]).toBe("─".repeat(80));
		expect(lines[3]).toMatch(/^› Acme\s+Connect$/);
		expect(lines).toHaveLength(7);
		expect(lines[5]).toContain("Selected detail");
		expect(lines[6]).toContain("↑/↓ navigate");
		expect(lines[6]).toContain("Enter connect");
	});

	it.each([24, 40, 80, 120])(
		"bounds Unicode rows/details at width %s and shrinks detail in short viewports",
		(width) => {
			let rows = 14;
			const picker = new ServiceCatalogPickerComponent(
				Array.from({ length: 100 }, (_, i) =>
					viewFixture({
						serviceId: `svc-${i}`,
						label: `服務 ${i} ${"long".repeat(30)}`,
						description: "selected description ".repeat(20),
						connectionStatus: "pending",
					}),
				),
				() => {},
				() => {},
				{ getRows: () => rows },
			);
			for (rows of [14, 8, 6, 14]) {
				const lines = picker.render(width);
				expect(lines.length).toBeLessThanOrEqual(rows);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(stripAnsi(lines.join("\n"))).toContain(width < 40 ? "Needs verificati…" : "Needs verification");
			}
		},
	);

	it("uses configured page/select/cancel keys and keeps search cursor movement editable", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.pageDown": "ctrl+d",
				"tui.select.pageUp": "ctrl+u",
				"tui.select.confirm": "ctrl+y",
				"tui.select.cancel": "ctrl+x",
			}),
		);
		const selected: string[] = [];
		let cancelled = 0;
		const picker = new ServiceCatalogPickerComponent(
			Array.from({ length: 30 }, (_, i) => viewFixture({ serviceId: `svc-${i}`, label: `Service ${i}` })),
			(view) => selected.push(view.serviceId),
			() => {
				cancelled++;
			},
			{ getRows: () => 14 },
		);
		picker.render(80);
		picker.handleInput("\x04");
		picker.handleInput("\x19");
		expect(selected).toEqual(["svc-7"]);
		picker.handleInput("\x15");
		picker.handleInput("\x19");
		expect(selected).toEqual(["svc-7", "svc-0"]);
		const output = stripAnsi(picker.render(80).join("\n"));
		expect(output).toContain("Ctrl+Y connect");
		expect(output).toContain("Ctrl+X close");
		picker.handleInput("ab");
		picker.handleInput("\x1b[D");
		picker.handleInput("c");
		expect(picker.getSearchInput().getValue()).toBe("acb");
		picker.handleInput("\x19");
		expect(selected).toHaveLength(2);
		picker.handleInput("\x18");
		expect(cancelled).toBe(1);
	});

	it("keeps account/remove/add grouping, visible search, and distinct actions", () => {
		const account = viewFixture({
			serviceId: "acme-work",
			label: "Acme work",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			toolCount: 3,
		});
		const picker = new ServiceCatalogPickerComponent(
			[
				account,
				{ ...account, label: "Remove acme-work", removeAction: true },
				viewFixture({ label: "Add another account" }),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Accounts — Acme" },
		);
		let output = stripAnsi(picker.render(100).join("\n"));
		expect(output).toContain("Accounts — Acme");
		expect(output).toContain("Search accounts");
		expect(output.indexOf("Acme work")).toBeLessThan(output.indexOf("Remove acme-work"));
		expect(output.indexOf("Remove acme-work")).toBeLessThan(output.indexOf("Add another account"));
		expect(output).toContain("Enter disconnect");
		picker.handleInput("\x1b[B");
		output = stripAnsi(picker.render(100).join("\n"));
		expect(output).toContain("Enter remove account");
		expect(output).toContain("Remove this account and its saved credential.");
		const removeRow = output.split("\n").find((line) => line.startsWith("›"));
		expect(removeRow).toContain("Remove account");
		expect(removeRow).not.toContain("Connected");
		picker.handleInput("\x1b[B");
		expect(stripAnsi(picker.render(100).join("\n"))).toContain("Enter add account");
		picker.handleInput("work");
		expect(stripAnsi(picker.render(100).join("\n"))).not.toContain("Add another account");
	});

	it.each([
		{
			view: viewFixture({ connectionIds: ["acme"], connectionStatus: "connected" }),
			mode: "catalog" as const,
			action: "manage accounts",
		},
		{
			view: viewFixture({ connectionIds: ["acme"], connectionStatus: "pending" }),
			mode: "accounts" as const,
			action: "verify",
		},
		{
			view: viewFixture({ connectionIds: ["acme"], connectionStatus: "error" }),
			mode: "accounts" as const,
			action: "reconnect",
		},
		{
			view: viewFixture({
				connectionIds: ["acme"],
				connectionStatus: "connected",
				source: "user",
				usesOAuth: false,
			}),
			mode: "accounts" as const,
			action: "manage",
		},
		{
			view: viewFixture({ connectionStatus: "disabled", connectable: false }),
			mode: "catalog" as const,
			action: "setup guidance",
		},
	])("describes $action without invoking it on navigation", ({ view, mode, action }) => {
		let calls = 0;
		const picker = new ServiceCatalogPickerComponent(
			[view],
			() => {
				calls++;
			},
			() => {},
			{ mode },
		);
		picker.focused = true;
		expect(picker.getSearchInput().focused).toBe(true);
		picker.handleInput("\x1b[B");
		expect(stripAnsi(picker.render(100).join("\n"))).toContain(`Enter ${action}`);
		expect(calls).toBe(0);
	});

	it("keeps empty and unmatched lists inert with a visible close hint", () => {
		let calls = 0;
		for (const views of [[], [viewFixture()]]) {
			const picker = new ServiceCatalogPickerComponent(
				views,
				() => {
					calls++;
				},
				() => {},
			);
			if (views.length) picker.handleInput("zzzzzzzz");
			picker.handleInput("\x1b[6~");
			picker.handleInput("\r");
			const output = stripAnsi(picker.render(40).join("\n"));
			expect(output).toContain(views.length ? "No matching services" : "No external services available");
			expect(output).toContain("Esc close");
		}
		expect(calls).toBe(0);
	});
});
