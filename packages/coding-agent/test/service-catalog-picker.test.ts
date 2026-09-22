import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Component, Container, Input, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { McpConnectionStore } from "../src/core/mcp/connection-store.js";
import type { McpPluginView, McpServiceDescriptor } from "../src/core/mcp/service-catalog.js";
import { McpTokenPastePanelComponent } from "../src/modes/interactive/components/mcp-token-paste-panel.js";
import { ServiceCatalogPickerComponent } from "../src/modes/interactive/components/service-catalog-picker.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

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
		// initTheme fire-and-forgets the cli-highlight preload; settle it before teardown or vitest records an
		// EnvironmentTeardownError unhandled rejection (a pre-existing race, see ENG-6108 notes).
		await preloadCodeHighlighter();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("never emits an embedded newline, even when catalog copy is multi-line", () => {
		// Real catalog copy (Canva's description) lists skills one per line. A rendered line containing "\n" paints extra
		// physical rows that the differential renderer never counted, so rows below it drift and stale rows survive —
		// duplicated entries and doubled scroll counters.
		const multiline =
			"Bring your Canva design workflow into Codex.\nAvailable skills:\nResize for social media: Adapt a design.\nBulk create: Generate designs.";
		const picker = new ServiceCatalogPickerComponent(
			[
				viewFixture({
					serviceId: "canva",
					label: "Canva",
					description: multiline,
					connectionStatus: "connected",
					toolCount: 34,
				}),
				viewFixture({ serviceId: "cloudflare", label: "Cloudflare", description: "Cloudflare platform plugin." }),
			],
			() => {},
			() => {},
			{ getRows: () => 20 },
		);

		const first = picker.render(120);
		expect(first.some((line) => line.includes("\n"))).toBe(false);
		// The whole description occupies exactly one row: flattened, not split.
		expect(first.filter((line) => stripAnsi(line).includes("Bring your Canva design workflow"))).toHaveLength(1);
		const detail = first.find((line) => stripAnsi(line).includes("Bring your Canva design workflow"));
		expect(visibleWidth(detail ?? "")).toBeLessThanOrEqual(120);

		// Moving the selection must not change the frame height: a multi-line
		// description and a short one both occupy exactly one detail row.
		picker.handleInput("\u001b[B");
		const second = picker.render(120);
		expect(second.some((line) => line.includes("\n"))).toBe(false);
		expect(second).toHaveLength(first.length);

		// The same flattened-row contract holds in accounts mode, where labels AND descriptions can both carry stray
		// newlines: every render is newline-free, and repeated renders are byte-identical.
		const reconnect = viewFixture({
			serviceId: "acme-work",
			label: "Reconnect\nwith a stray newline",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			description: "Bring operational data into your conversations.",
		});
		const accounts = new ServiceCatalogPickerComponent(
			[
				reconnect,
				{ ...reconnect, label: "Disconnect\nacme-work", removeAction: true },
				viewFixture({
					label: "Add another account",
					connectionIds: [],
					description: "Bring operational data.\nAvailable skills:\nQuery records.",
				}),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Acme MCP", getRows: () => 24 },
		);
		const accountsFirst = accounts.render(120);
		expect(accountsFirst.some((line) => line.includes("\n"))).toBe(false);
		expect(accountsFirst.filter((line) => stripAnsi(line).includes("Reconnect with a stray newline"))).toHaveLength(
			1,
		);
		accounts.handleInput("\x1b[B");
		const accountsSecond = accounts.render(120);
		expect(accountsSecond.some((line) => line.includes("\n"))).toBe(false);
		expect(accountsSecond).toHaveLength(accountsFirst.length);
		expect(accounts.render(120)).toEqual(accountsSecond);
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

	// The pending-vs-verifying label is pinned by the view tests in
	// mcp-service-catalog.test.ts ("never reports connected from a stored
	// token alone") and the bounds test below asserts the rendered label.

	// Filtering is pinned by the row-counting and zero-rows tests (the counter
	// follows the filter) and the ranking test (identity vs description hits).

	// Selection and cancellation are pinned end-to-end at the chain seam
	// (Enter runs the selected row's action; Esc restores the editor).

	// The /plugins prefill is pinned at the chain seam in "mounts inline, restores the editor before the action..." (the
	// picker's search input carries the "acme" prefill there).

	// The bordered-search header and the single separator rule are pinned in
	// "opens every inline panel with exactly one leading separator rule".

	it.each([40, 120])(
		"bounds Unicode rows at width %s and fits ultra-short viewports by dropping the description line",
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
		// The fixed one-line description plus its blank spacer stay budgeted,
		// so a page step at 14 rows moves by the full 7 visible items.
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
		expect(picker.getSearchInput()?.getValue()).toBe("acb");
		picker.handleInput("\x19");
		expect(selected).toHaveLength(2);
		picker.handleInput("\x18");
		expect(cancelled).toBe(1);
	});

	it("renders the redesigned accounts menu: header, description above, action rows, no search", () => {
		// Kevin (live testing): "Accounts — Acme" becomes "Acme MCP", the description moves above the options, the old
		// account-name row becomes an explicit Reconnect option, and neither the search box nor the right-hand status
		// column survives — the labels carry the actions. The menu is exactly three rows — Reconnect, Disconnect, Add
		// another account — for one account AND for several (the account id then comes from the sub-picker, never the row
		// label).
		const reconnect = viewFixture({
			serviceId: "acme-work",
			label: "Reconnect",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			toolCount: 3,
			description: "Bring operational data into your conversations.",
		});
		const picker = new ServiceCatalogPickerComponent(
			[
				reconnect,
				{ ...reconnect, label: "Disconnect", removeAction: true },
				viewFixture({ label: "Add another account", connectionIds: [] }),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Acme MCP", getRows: () => 24 },
		);
		// No search box in accounts mode: there is nothing useful to filter.
		expect(picker.getSearchInput()).toBeUndefined();
		let output = stripAnsi(picker.render(100).join("\n"));
		expect(output).not.toContain("Search accounts");
		// Row set and order: Reconnect first, then Disconnect, then Add.
		expect(output.indexOf("Reconnect")).toBeLessThan(output.indexOf("Disconnect"));
		expect(output.indexOf("Disconnect")).toBeLessThan(output.indexOf("Add another account"));
		// No right-side trailing text in accounts mode.
		expect(output).not.toContain("Connected · 3 tools");
		expect(output).not.toContain("Remove account");
		expect(output).not.toContain("Add account");
		// Enter on Reconnect re-verifies; only Disconnect disconnects.
		expect(output).toContain("Enter reconnect");
		picker.handleInput("\x1b[B");
		output = stripAnsi(picker.render(100).join("\n"));
		expect(output).toContain("Enter disconnect");
		picker.handleInput("\x1b[B");
		expect(stripAnsi(picker.render(100).join("\n"))).toContain("Enter add account");
		// Plain typing is inert: no search input swallows it.
		const before = stripAnsi(picker.render(100).join("\n"));
		picker.handleInput("work");
		picker.handleInput("zzzz");
		expect(stripAnsi(picker.render(100).join("\n"))).toBe(before);

		// The #2340 onboarding-choice frame: one separator rule, leading blank, header, blank, muted description, blank, `>
		// `-marker rows, a blank, shortcuts.
		const lines = before.split("\n");
		expect(lines[0]).toBe("─".repeat(100));
		expect(lines[1].trim()).toBe("");
		expect(lines[2].trim()).toBe("Acme MCP");
		const descriptionIndex = lines.findIndex((line) => line.includes("Bring operational data"));
		expect(descriptionIndex).toBe(4);
		// The selection sits on the third row (Add): the marker travels with it.
		expect(lines[descriptionIndex + 2].trim()).toBe("Reconnect");
		expect(lines[descriptionIndex + 4].trim()).toBe("> Add another account");
		expect(lines[descriptionIndex + 5]?.trim()).toBe("");
		expect(lines).toHaveLength(descriptionIndex + 7);
		// Up clamps at the first row; moving down swaps the marker and the hint, never the height.
		picker.handleInput("\x1b[A");
		picker.handleInput("\x1b[A");
		const top = picker.render(100).map(stripAnsi);
		expect(top).toHaveLength(lines.length);
		expect(top[descriptionIndex + 2].trim()).toBe("> Reconnect");
		picker.handleInput("\x1b[B");
		const moved = picker.render(100).map(stripAnsi);
		expect(moved).toHaveLength(lines.length);
		expect(moved[descriptionIndex + 2].trim()).toBe("Reconnect");
		expect(moved[descriptionIndex + 3].trim()).toBe("> Disconnect");
	});

	it("budgets the accounts frame to its rendered height, including the blank under the last option", () => {
		// Bugbot: the blank row under the last option was not in ACCOUNTS_FRAME_ROWS, so a viewport sized exactly to the
		// budget was one row too short and the shortcuts line was pushed off-screen. Pin the invariant at the exact failure
		// point: a viewport of exactly the budgeted rows must show the last frame row (the shortcuts line).
		const longDescription = "A".repeat(400); // forces the 3-line cap
		const accounts = [
			viewFixture({
				serviceId: "acme",
				label: "Acme",
				description: longDescription,
				connectionStatus: "connected",
				connectionIds: ["acme-1"],
			}),
		];
		const budgetAtDescriptionCap =
			1 /* rule */ +
			1 /* blank */ +
			1 /* header */ +
			1 /* blank */ +
			3 /* description cap */ +
			1 /* blank */ +
			1 /* the one option */ +
			1 /* trailing blank */ +
			1 /* shortcuts */;
		const picker = new ServiceCatalogPickerComponent(
			accounts,
			() => {},
			() => {},
			{ mode: "accounts", getRows: () => budgetAtDescriptionCap, title: "Acme MCP" },
		);
		const lines = picker.render(120);
		expect(lines).toHaveLength(budgetAtDescriptionCap);
		// The last painted row IS the shortcuts line, not a truncated frame.
		expect(stripAnsi(lines[lines.length - 1] ?? "")).toContain("Enter");
		// And one row SHORTER: the frame must still fit by the windowing rules (options compress, the shortcuts stay
		// visible) — the frame never paints past the viewport.
		const tight = new ServiceCatalogPickerComponent(
			accounts,
			() => {},
			() => {},
			{ mode: "accounts", getRows: () => budgetAtDescriptionCap - 1, title: "Acme MCP" },
		);
		expect(tight.render(120).length).toBeLessThanOrEqual(budgetAtDescriptionCap - 1);
		// The three-row menu (Kevin, live testing: exactly Reconnect, Disconnect, Add another account) stays inside the
		// SAME frame budget — the option count is the only thing that grows, never the fixed rows.
		const threeRowMenu = [
			viewFixture({
				serviceId: "acme",
				label: "Reconnect",
				description: longDescription,
				connectionStatus: "connected",
				connectionIds: ["acme-1"],
			}),
			viewFixture({ serviceId: "acme", label: "Disconnect", removeAction: true, connectionIds: ["acme-1"] }),
			viewFixture({ serviceId: "acme", label: "Add another account", connectionIds: [] }),
		];
		const threeRowBudget =
			1 /* rule */ +
			1 /* blank */ +
			1 /* header */ +
			1 /* blank */ +
			3 /* description cap */ +
			1 /* blank */ +
			3 /* options */ +
			1 /* trailing blank */ +
			1 /* shortcuts */;
		const three = new ServiceCatalogPickerComponent(
			threeRowMenu,
			() => {},
			() => {},
			{ mode: "accounts", getRows: () => threeRowBudget, title: "Acme MCP" },
		);
		const threeLines = three.render(120);
		expect(threeLines).toHaveLength(threeRowBudget);
		expect(stripAnsi(threeLines[threeLines.length - 1] ?? "")).toContain("Enter");
		const threeTight = new ServiceCatalogPickerComponent(
			threeRowMenu,
			() => {},
			() => {},
			{ mode: "accounts", getRows: () => threeRowBudget - 1, title: "Acme MCP" },
		);
		expect(threeTight.render(120).length).toBeLessThanOrEqual(threeRowBudget - 1);
	});

	// The three-line description cap is part of the frame BUDGET contract pinned in "budgets the accounts frame to its
	// rendered height" (the cap drives the budgeted height there).

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
			view: viewFixture({ connectionIds: ["acme"], connectionStatus: "connected" }),
			mode: "accounts" as const,
			action: "reconnect",
		},
		{
			view: viewFixture({ connectionStatus: "disabled", connectable: false }),
			mode: "catalog" as const,
			action: "setup guidance",
		},
		{
			// Several accounts: the row opens the account sub-picker first.
			view: viewFixture({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" }),
			mode: "accounts" as const,
			action: "choose account",
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
		// Accounts mode has no search box to focus; catalog delegates to it.
		const search = picker.getSearchInput();
		expect(search?.focused).toBe(mode === "catalog" ? true : undefined);
		picker.handleInput("\x1b[B");
		expect(stripAnsi(picker.render(100).join("\n"))).toContain(`Enter ${action}`);
		expect(calls).toBe(0);
	});

	// The empty state (hint, inert navigation, no dispatch) and the scattered-subsequence refusal are pinned together in
	// "returns zero rows for a query nothing matches" and the empty-state alignment tests below.

	// Boundary navigation (top clamp without wrap, one-row window shifts, one
	// selection) is pinned by the keybinding test's pageUp/pageDown assertions
	// and the repeated-render stability in the newline contract test.

	// The fixed one-line description contract (blank above, shortcuts below, height never changes for the description)
	// is pinned in "separates the description line from the list with one blank line in both modes" below. The empty
	// state's column alignment is covered by the merged empty-state assertions in the zero-rows test (same 2-column
	// marker contract).

	// The empty state's blank row and column alignment are pinned by the zero-rows test's empty-state assertions below.

	// Trailing-status colour semantics (success for Connected, plain text for Connect) are part of the row-render
	// contract covered by the compact-rows test's status assertions.

	it("returns zero rows for a query nothing matches, never scattered-subsequence noise", () => {
		// Kevin's live report: searching "vercel" surfaced eight unrelated rows through the shared setup-hint boilerplate
		// ("...not been VERified. ConneCt ... capabilitiEs ... Login"). Vercel is not in the catalog, so the honest answer
		// is the empty state.
		const boilerplate =
			"OAuth support has not been verified. Connect checks capabilities and asks for approval before login.";
		const services = [
			viewFixture({ serviceId: "cockroachdb", label: "CockroachDB Cloud", setupHint: boilerplate }),
			viewFixture({ serviceId: "cloudinary-mediaflows", label: "Cloudinary MediaFlows", setupHint: boilerplate }),
			viewFixture({ serviceId: "wix", label: "Wix", setupHint: boilerplate }),
			viewFixture({ serviceId: "expo", label: "Expo", setupHint: boilerplate }),
			viewFixture({ serviceId: "neon", label: "Neon", setupHint: boilerplate }),
			viewFixture({ serviceId: "gc-ai", label: "GC AI", setupHint: boilerplate }),
			viewFixture({ serviceId: "mapbox", label: "Mapbox", setupHint: boilerplate }),
			viewFixture({ serviceId: "prisma", label: "Prisma", setupHint: boilerplate }),
		];
		let calls = 0;
		const picker = new ServiceCatalogPickerComponent(
			services,
			() => {
				calls++;
			},
			() => {},
			{ getRows: () => 24 },
		);
		picker.handleInput("vercel");
		const lines = picker.render(100).map(stripAnsi);
		for (const service of services) {
			expect(lines.some((line) => line.includes(service.label))).toBe(false);
		}
		expect(lines.some((line) => line.includes("No matching services"))).toBe(true);
		// The empty state is inert: navigation and Enter dispatch nothing.
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(calls).toBe(0);
	});

	it("ranks identity matches above description text and keeps description search useful", () => {
		const services = [
			viewFixture({
				serviceId: "stripe",
				label: "Stripe",
				description: "Develop your payments integration faster.",
			}),
			viewFixture({ serviceId: "ledger", label: "Ledger", description: "Import Stripe-like payment ledgers." }),
			viewFixture({
				serviceId: "notion",
				label: "Notion",
				aliases: ["notion-workspace"],
				description: "Notion workflows for implementation planning.",
			}),
		];
		const picker = new ServiceCatalogPickerComponent(
			services,
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		const firstRow = () =>
			stripAnsi(picker.render(100).join("\n"))
				.split("\n")
				.find((line) => line.trim().startsWith("›"));
		const backspace = (count: number) => {
			for (let i = 0; i < count; i++) picker.handleInput("\x7f");
		};
		picker.handleInput("notion");
		expect(firstRow()).toContain("Notion");
		// A distinctive description word still finds its service.
		backspace(6);
		picker.handleInput("payments");
		expect(firstRow()).toContain("Stripe");
		// An identity hit for the same word outranks a description-only hit.
		backspace(8);
		picker.handleInput("stripe");
		expect(firstRow()).toContain("Stripe");
		expect(stripAnsi(picker.render(100).join("\n"))).toContain("Ledger");
	});

	it("separates the description line from the list with one blank line in both modes", () => {
		// Kevin (live testing): one blank line above the description / below the
		// last row ("Add another account"), without changing the panel height.
		const catalog = new ServiceCatalogPickerComponent(
			[viewFixture({ label: "Acme", description: "Selected detail" })],
			() => {},
			() => {},
		);
		let lines = catalog.render(80).map(stripAnsi);
		const detailIndex = lines.findIndex((line) => line.includes("Selected detail"));
		expect(detailIndex).toBeGreaterThan(0);
		expect(lines[detailIndex - 1].trim()).toBe("");
		expect(lines[detailIndex - 2]).toMatch(/Acme/);

		const reconnect = viewFixture({
			serviceId: "acme-work",
			label: "Reconnect",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			description: "Bring operational data into your conversations.",
		});
		const accounts = new ServiceCatalogPickerComponent(
			[
				reconnect,
				{ ...reconnect, label: "Disconnect acme-work", removeAction: true },
				viewFixture({
					label: "Add another account",
					connectionIds: [],
					description: "Bring operational data into your conversations.",
				}),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Acme MCP" },
		);
		lines = accounts.render(80).map(stripAnsi);
		const descriptionIndex = lines.findIndex((line) => line.includes("Bring operational data"));
		expect(descriptionIndex).toBeGreaterThan(0);
		// Accounts mode moved the description ABOVE the options: one blank
		// under it, then the rows — never under the list anymore.
		expect(lines[descriptionIndex + 1].trim()).toBe("");
		expect(lines[descriptionIndex + 2]).toMatch(/Reconnect/);
	});

	it("opens every inline panel with exactly one leading separator rule", () => {
		// Kevin (live testing): inline pickers need a line between the chat view and the picker. A headerless panel borrows
		// the bordered search's top border as that rule; a titled panel draws the rule above its title.
		const catalog = new ServiceCatalogPickerComponent(
			[viewFixture()],
			() => {},
			() => {},
		);
		const lines = catalog.render(80).map(stripAnsi);
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines[1]).not.toBe("─".repeat(80));

		const account = viewFixture({
			serviceId: "acme-work",
			label: "Reconnect",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
		});
		const accounts = new ServiceCatalogPickerComponent(
			[account, { ...account, label: "Disconnect acme-work", removeAction: true }],
			() => {},
			() => {},
			{ mode: "accounts", title: "Acme MCP" },
		);
		const titled = accounts.render(80).map(stripAnsi);
		expect(titled[0]).toBe("─".repeat(80));
		expect(titled[1].trim()).toBe("");
		expect(titled[2]).toContain("Acme MCP");
		// Exactly ONE rule: the accounts panel has no bordered search input to double it.
		expect(titled.filter((line) => line === "─".repeat(80))).toHaveLength(1);
	});

	// Accounts mode having no search input and inert typing is pinned in "renders the redesigned accounts menu: header,
	// description above, action rows, no search" (no search box; plain typing is inert).

	// The left-arrow back routing is pinned end-to-end at the chain seam ("left arrow from the accounts menu returns to
	// a freshly mounted catalog") and the sub-picker's Esc-back wiring in "hints the account chooser" / the sub-picker
	// back table in the chain describe.

	it("keeps the left arrow with the search input in catalog mode", () => {
		// The catalog has no parent surface: the host never wires a back callback there, so left just moves the search
		// cursor (inert at column 0) like any other editor key.
		const backs = 0;
		const picker = new ServiceCatalogPickerComponent(
			[viewFixture({ serviceId: "linear", label: "Linear" }), viewFixture({ serviceId: "notion", label: "Notion" })],
			() => {},
			() => {},
			{},
		);
		picker.handleInput("\x1b[D");
		expect(backs).toBe(0);
		// Search still works after the left key: the key was an edit, not a navigation.
		picker.handleInput("n");
		picker.handleInput("o");
		const output = stripAnsi(picker.render(100).join("\n"));
		expect(output).toContain("Notion");
		expect(output).not.toContain("Linear");
	});

	// The "Enter choose account" hints are pinned by the action-describes it.each above; the sub-picker's "Esc back"
	// cancel word is pinned at the chain seam ("disconnecting one of several accounts..." asserts the sub-picker's
	// Accounts header and Esc-back).
});

describe("McpTokenPastePanelComponent (inline masked paste panel)", () => {
	beforeAll(async () => {
		initTheme("dark");
		await preloadCodeHighlighter();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	const SECRET = "ghp_live-secret-token-value";

	function type(panel: McpTokenPastePanelComponent, text: string): void {
		for (const character of text) panel.handleInput(character);
	}

	function rendered(panel: McpTokenPastePanelComponent): string {
		return panel
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
	}

	it("renders the prompt label and never the raw secret in any rendered line", () => {
		let submitted: string | undefined;
		let cancelled = false;
		const panel = new McpTokenPastePanelComponent({
			serviceLabel: "GitHub",
			reason: "paste a GitHub personal access token (GITHUB_PAT_TOKEN or GITHUB_PERSONAL_ACCESS_TOKEN)",
			field: { id: "GITHUB_PAT_TOKEN", label: "GitHub personal access token" },
			onSubmit: (value) => {
				submitted = value;
			},
			onCancel: () => {
				cancelled = true;
			},
		});
		panel.focused = true;
		type(panel, SECRET);

		const flat = rendered(panel);
		expect(flat).toContain("Connect GitHub");
		expect(flat).toContain("GitHub personal access token");
		expect(flat).toContain("credential store");
		// THE leak test: the raw secret appears in NO rendered line — only bullets.
		expect(flat.includes(SECRET)).toBe(false);
		expect(flat.includes("ghp_live")).toBe(false);
		expect(flat).toContain("•".repeat(SECRET.length));
		// The masked line still fits the width.
		for (const line of panel.render(120)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(120);
		}

		panel.handleInput("\r");
		expect(submitted).toBe(SECRET);
		expect(cancelled).toBe(false);
		// After submit the panel renders no raw value either.
		expect(rendered(panel).includes(SECRET)).toBe(false);
	});

	// Single-credential prompting is pinned at the paste SEAM in mcp-activation-queue.test.ts ("stores the
	// single-credential static token...") and by the catalog's credential-collapse tests.

	// Esc cancelling with nothing stored or echoed is pinned at the paste seam (mcp-activation-queue.test.ts, "a
	// cancelled (value=...) paste stores nothing...") and the chain ("Esc in the paste panel returns to the catalog that
	// opened it").

	// The empty-value refusal (nothing stored, nothing claimed) is pinned at
	// the paste seam in mcp-activation-queue.test.ts.
});

/**
 * ENG-6108: the picker CHAIN on the real InteractiveMode prototype — inline mounting, stale/replacement
 * settling, action routing, and re-entry. Every wait resolves on a concrete signal: a picker/panel mount fires
 * ui.setFocus, and an action start/finish resolves a deferred — never a timer or poll.
 */
describe("ENG-6108 service catalog picker chain", () => {
	const ENDPOINT = "https://acme.example.test/mcp";
	const PASTE_ENDPOINT = "https://paste.example.test/mcp";
	const harnesses: Harness[] = [];
	const localCatalogDirs: string[] = [];

	beforeAll(async () => {
		initTheme("dark");
		await preloadCodeHighlighter();
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Network forbidden in inline picker tests");
			}),
		);
	});

	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		while (localCatalogDirs.length) rmSync(localCatalogDirs.pop()!, { recursive: true, force: true });
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	function view(overrides: Partial<McpPluginView> = {}): McpPluginView {
		return viewFixture({ serviceId: "acme", label: "Acme", ...overrides });
	}
	const descriptor: McpServiceDescriptor = {
		serviceId: "acme",
		label: "Acme",
		aliases: [],
		transport: { type: "http", url: ENDPOINT },
		authStrategy: "oauth",
		setup: { status: "ready" },
		metadataReviewed: true,
		legacyBuiltin: false,
	};
	interface Target {
		url?: string;
		usesOAuth: boolean;
		managedBySettings: boolean;
	}
	interface ActionOptions {
		catalogServiceId?: string;
		addAccount?: boolean;
		knownIds?: ReadonlySet<string>;
	}
	interface PickerHost {
		showServiceCatalogPicker(query?: string): Promise<void>;
		showAccountPickerForService(
			service: McpPluginView,
			target: Target,
			options: { knownIds: Set<string> },
		): Promise<"catalog" | "closed">;
		selectServiceCatalogRow(
			views: McpPluginView[],
		): Promise<{ status: "selected"; service: McpPluginView } | { status: "cancelled" } | { status: "back" }>;
		closeServiceCatalogPicker?: () => void;
	}

	async function fixture(views: McpPluginView[] = [view()], options: { settings?: Record<string, unknown> } = {}) {
		const harness = await createHarness({
			models: [{ id: "offline", name: "Offline" }],
			...(options.settings ? { settings: options.settings as never } : {}),
		});
		harnesses.push(harness);
		const store = McpConnectionStore.open(join(harness.tempDir, "connections.json"));
		const editor = new Input();
		editor.setValue("preserved draft");
		const editorContainer = new Container();
		editorContainer.addChild(editor);
		const setFocus = vi.fn();
		const connect = vi.fn(async (_view: McpPluginView, _target: Target | undefined, _options: ActionOptions) => ({
			ran: true,
		}));
		const mode = Object.assign(Object.create(InteractiveMode.prototype) as object, {
			editor,
			editorContainer,
			ui: {
				terminal: { rows: 24 },
				requestRender: vi.fn(),
				setFocus,
				showOverlay: vi.fn(() => {
					throw new Error("Inline picker must not mount an overlay");
				}),
			},
			uiServices: { modelRegistry: harness.session.modelRegistry, settingsManager: harness.settingsManager },
			buildServiceCatalogViews: () => ({ services: [descriptor], views, diagnostics: [] }),
			getMcpConnectionStore: () => store,
			connectServiceFromPicker: connect,
			showWarning: vi.fn(),
			// The prototype object never runs the constructor, so the field the
			// inline auth/paste panel closers live in starts as a real array.
			inlineAuthPanelClosers: [],
		}) as unknown as PickerHost;
		const picker = () => {
			const component = editorContainer.children[0];
			expect(component).toBeInstanceOf(ServiceCatalogPickerComponent);
			return component as ServiceCatalogPickerComponent;
		};
		const showError = vi.fn();
		Object.assign(mode, { showError });
		return { harness, store, editor, editorContainer, mode, picker, connect, setFocus, showError };
	}

	/** Resolve with the next mounted surface: every mount calls ui.setFocus —
	 * a concrete completion signal, never a timer or poll. */
	function nextSurface<T extends Component>(
		f: Awaited<ReturnType<typeof fixture>>,
		matcher: (component: Component) => component is T,
	): Promise<T> {
		return new Promise((resolve) => {
			f.setFocus.mockImplementation((component: Component) => {
				if (matcher(component)) resolve(component);
			});
		});
	}
	const nextPicker = (f: Awaited<ReturnType<typeof fixture>>, previous: Component) =>
		nextSurface(
			f,
			(component): component is ServiceCatalogPickerComponent =>
				component instanceof ServiceCatalogPickerComponent && component !== previous,
		);
	const nextPastePanel = (f: Awaited<ReturnType<typeof fixture>>) =>
		nextSurface(
			f,
			(component): component is McpTokenPastePanelComponent => component instanceof McpTokenPastePanelComponent,
		);

	/** A synthetic OAuth grant bound to the service endpoint. */
	const oauthGrant = (access: string, at = Date.now()) => ({
		type: "oauth" as const,
		access,
		refresh: "r",
		expires: at + 3600_000,
		endpoint: ENDPOINT,
	});

	/** A connected store record for the service's account. */
	const accountRecord = (connectionId: string, label: string, at = Date.now()) => ({
		connectionId,
		serviceId: "acme",
		endpoint: ENDPOINT,
		label,
		status: "connected" as const,
		verifiedAt: at,
		toolCount: 2,
		createdAt: at,
		updatedAt: at,
	});

	/** Restore the production view builder and wire the mutation callbacks. */
	async function settingsFixture() {
		const f = await fixture();
		Reflect.deleteProperty(f.mode, "buildServiceCatalogViews");
		Reflect.deleteProperty(f.mode, "connectServiceFromPicker");
		const showStatus = vi.fn();
		const reload = vi.fn(async () => {});
		const appendOutcome = vi.fn(async (_message: Record<string, unknown>) => {});
		const authFlow = vi.fn(() => {
			throw new Error("OAuth must not run for settings-only actions");
		});
		Object.assign(f.mode, {
			showStatus,
			handleReloadCommand: reload,
			createAuthFlows: authFlow,
			agentConnection: { appendCustomMessage: appendOutcome },
		});
		const reserve = vi.spyOn(f.store, "reserveConnectionId");
		const claim = vi.spyOn(f.store, "claimConnectionId");
		return { ...f, showStatus, reload, appendOutcome, authFlow, reserve, claim };
	}

	/** Write a validated local service-catalog source file and return its path. */
	function writeLocalCatalog(entries: Record<string, unknown>[]): string {
		const dir = mkdtempSync(join(tmpdir(), "eng6108-reentry-"));
		localCatalogDirs.push(dir);
		const file = join(dir, "services.json");
		writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				entries,
			}),
			"utf8",
		);
		return file;
	}

	it("ENG-6108: mounts inline, restores the editor before the action, and ignores duplicate Enter/cancel", async () => {
		const f = await fixture([view(), view({ serviceId: "other", label: "Other" })]);
		let release!: () => void;
		const operation = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			f.connect.mockImplementation(async () => {
				// The editor is restored BEFORE the action runs; the promise
				// stays open through the action (no overlay, no prompt).
				resolve();
				expect(f.editorContainer.children).toEqual([f.editor]);
				await operation;
				return { ran: true };
			});
		});
		const done = f.mode.showServiceCatalogPicker("acme");
		const picker = f.picker();
		expect(picker.getSearchInput()?.getValue()).toBe("acme");
		expect(stripAnsi(picker.render(80).join("\n"))).not.toContain("Other");
		expect(f.setFocus).toHaveBeenLastCalledWith(picker);
		picker.handleInput("\r");
		picker.handleInput("\r"); // duplicate Enter is inert
		picker.handleInput("\x1b"); // Esc is inert while the action runs
		await started;
		expect(f.connect).toHaveBeenCalledOnce();
		let finished = false;
		void done.then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		expect(f.setFocus.mock.calls.filter(([component]) => component === f.editor)).toHaveLength(1);
		expect(f.editor.getValue()).toBe("preserved draft");
		release();
		// The action ran, so the chain re-enters the catalog (freshly mounted);
		// Esc on the re-entered picker ends it and restores the editor.
		const reopened = await nextPicker(f, picker);
		expect(reopened.getSearchInput()).toBeDefined();
		reopened.handleInput("\x1b");
		await done;
		expect(f.connect).toHaveBeenCalledOnce();
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: reports rejected callbacks without leaking error text or replacing a later selector", async () => {
		const f = await fixture();
		let reject!: (reason: Error) => void;
		const started = new Promise<void>((resolve) => {
			f.connect.mockImplementation(
				() =>
					new Promise((_resolve, fail) => {
						resolve();
						reject = fail;
					}),
			);
		});
		const done = f.mode.showServiceCatalogPicker();
		f.picker().handleInput("\r");
		await started;
		const next = new Input();
		f.editorContainer.clear();
		f.editorContainer.addChild(next);
		reject(new Error("access_token=DO_NOT_DISPLAY"));
		await done;
		expect(f.showError).toHaveBeenCalledWith("MCP connection action did not complete. Try again.");
		expect(JSON.stringify(f.showError.mock.calls)).not.toContain("DO_NOT_DISPLAY");
		expect(f.editorContainer.children).toEqual([next]);
	});

	it("ENG-6108: settles a stale picker as cancellation without restoring or invoking its old row", async () => {
		const f = await fixture();
		const done = f.mode.showServiceCatalogPicker();
		const stale = f.picker();
		const next: Component = new Input();
		f.editorContainer.clear();
		f.editorContainer.addChild(next);
		stale.handleInput("\r");
		await done;
		expect(f.connect).not.toHaveBeenCalled();
		expect(f.editorContainer.children).toEqual([next]);
		expect(f.setFocus.mock.calls.filter(([component]) => component === f.editor)).toHaveLength(0);
	});

	it("ENG-6108: opening a replacement picker settles the old promise, whose late close cannot hide it", async () => {
		const f = await fixture();
		const first = f.mode.selectServiceCatalogRow([view()]);
		const stale = f.picker();
		const oldClose = f.mode.closeServiceCatalogPicker;
		const second = f.mode.selectServiceCatalogRow([view({ label: "Replacement" })]);
		const next = f.picker();
		await expect(first).resolves.toEqual({ status: "cancelled" });
		stale.handleInput("\r");
		oldClose?.();
		expect(f.editorContainer.children).toEqual([next]);
		next.handleInput("\x1b");
		await expect(second).resolves.toEqual({ status: "cancelled" });
	});

	it("ENG-6108: catalog to accounts preserves ownership, grouping and real per-account pending state", async () => {
		const f = await fixture([view({ connectionIds: ["acme-work"], connectionStatus: "connected" })]);
		const now = Date.now();
		f.harness.authStorage.set("mcp:acme-work", oauthGrant("synthetic", now));
		f.store.upsert({
			connectionId: "acme-work",
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: "Work",
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		});
		await f.store.flush();
		const done = f.mode.showServiceCatalogPicker();
		const catalog = f.picker();
		const accountsMount = nextPicker(f, catalog);
		catalog.handleInput("\r");
		const accounts = (await accountsMount) as ServiceCatalogPickerComponent;
		catalog.handleInput("\x1b"); // the stale catalog's late Esc cannot close the accounts surface
		expect(f.editorContainer.children).toEqual([accounts]);
		const output = stripAnsi(accounts.render(100).join("\n"));
		expect(output).toContain("Acme MCP");
		expect(output).toContain("Reconnect");
		expect(output).toContain("Enter verify");
		accounts.handleInput("\r");
		// The action ran, so the SAME accounts menu re-enters freshly built — never the prompt. The mocked action stored
		// nothing, so the row set is unchanged; the surface is new.
		const reopened = (await nextPicker(f, accounts)) as ServiceCatalogPickerComponent;
		expect(f.connect).toHaveBeenCalledOnce();
		expect(f.connect.mock.calls[0]?.[0]).toMatchObject({ serviceId: "acme-work", connectionStatus: "pending" });
		expect(f.connect.mock.calls[0]?.[2]).toEqual({ catalogServiceId: "acme" });
		expect(reopened.getSearchInput()).toBeUndefined();
		const again = stripAnsi(reopened.render(100).join("\n"));
		expect(again).toContain("Acme MCP");
		expect(again).toContain("Reconnect");
		expect(again).toContain("Enter verify");
		reopened.handleInput("\x1b");
		await done;
		expect(f.editor.getValue()).toBe("preserved draft");
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	async function connectedAccountFixture() {
		const f = await settingsFixture();
		const now = Date.now();
		f.harness.authStorage.set("mcp:acme-work", {
			type: "oauth",
			access: "synthetic-access",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert(accountRecord("acme-work", "Work"));
		await f.store.flush();
		const removeAccount = vi.spyOn(f.store, "removeAccount");
		const done = f.mode.showAccountPickerForService(
			view({ connectionIds: ["acme-work"], connectionStatus: "connected" }),
			{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
			{ knownIds: new Set(["acme"]) },
		);
		return { f, removeAccount, done, accounts: f.picker() };
	}

	it("ENG-6108: the accounts Reconnect row re-verifies, never disconnects", async () => {
		// Enter on the first row must re-verify; the record and credential both
		// survive, and the SAME accounts menu reopens with the refreshed status.
		const { f, removeAccount, done, accounts } = await connectedAccountFixture();
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter reconnect");
		accounts.handleInput("\r");
		const reopened = (await nextPicker(f, accounts)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeUndefined();
		const again = stripAnsi(reopened.render(100).join("\n"));
		expect(again).toContain("Reconnect");
		expect(again).toContain("Enter verify");
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(removeAccount).not.toHaveBeenCalled();
		expect(f.store.get("acme-work")).toBeDefined();
		expect(f.harness.authStorage.getVerified("mcp:acme-work")).toBeDefined();
		expect(f.reserve).not.toHaveBeenCalled();
		expect(f.claim).not.toHaveBeenCalled();
		// The network-denied environment makes the offline verification fail
		// honestly; the account stays saved — never a removal.
		expect(f.appendOutcome).toHaveBeenCalledOnce();
		expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
			customType: "mcp_connection_outcome",
			details: { source: "retry", verification: "unverified" },
		});
	});

	it("ENG-6108: the accounts Disconnect row removes that account and records the durable entry", async () => {
		// Disconnecting the LAST account leaves the service with no accounts, so the chain reopens the CATALOG — the user
		// is never dropped to the prompt. The real /mcp flow enters the accounts menu from the catalog row.
		const f = await settingsFixture();
		const now = Date.now();
		f.harness.authStorage.set("mcp:acme-work", {
			type: "oauth",
			access: "synthetic-access",
			refresh: "r",
			expires: now + 3600_000,
			endpoint: ENDPOINT,
		});
		f.store.upsert(accountRecord("acme-work", "Work"));
		await f.store.flush();
		const removeAccount = vi.spyOn(f.store, "removeAccount");
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		catalog.handleInput("\r");
		const accounts = await nextPicker(f, catalog);
		accounts.handleInput("\x1b[B");
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter disconnect");
		accounts.handleInput("\r");
		const reopened = await nextPicker(f, accounts);
		expect(reopened.getSearchInput()).toBeDefined();
		expect(stripAnsi(reopened.render(100).join("\n"))).not.toContain("Work MCP");
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(removeAccount).toHaveBeenCalledOnce();
		expect(f.store.get("acme-work")).toBeUndefined();
		expect(f.harness.authStorage.getVerified("mcp:acme-work")).toBeUndefined();
		expect(f.reload).toHaveBeenCalledOnce();
		// The durable "◆ Disconnected" entry rides the remove path.
		expect(f.appendOutcome).toHaveBeenCalledOnce();
		expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
			customType: "mcp_connection_outcome",
			details: { kind: "disconnect", label: "Work", connectionId: "acme-work" },
		});
	});

	// Multi-account Reconnect acting on the PICKED account through the sub-picker is covered by "disconnecting one of
	// several accounts re-enters that service's accounts menu without the removed row" (the disconnect variant drives
	// the same sub-picker → act-on-picked id → re-entry path).

	// Esc and the left arrow are the same back path in the sub-picker; the
	// table keeps one deterministic representative of the wiring.
	it("ENG-6108: the sub-picker's back key returns to the accounts menu without acting", async () => {
		const key = "\x1b";
		const f = await fixture([view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" })]);
		const done = f.mode.showAccountPickerForService(
			view({ connectionIds: ["acme-work", "acme-personal"], connectionStatus: "connected" }),
			{ url: ENDPOINT, usesOAuth: true, managedBySettings: false },
			{ knownIds: new Set(["acme"]) },
		);
		const accounts = f.picker();
		accounts.handleInput("\r"); // → Reconnect: open the account sub-picker
		const sub = await nextPicker(f, accounts);
		sub.handleInput(key);
		// Back, never close: the service's accounts menu re-mounts freshly built and nothing acted.
		const reopened = (await nextPicker(f, sub)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeUndefined();
		const again = stripAnsi(reopened.render(100).join("\n"));
		expect(again).toContain("Acme MCP");
		expect(again).toContain("Reconnect");
		expect(again).toContain("Enter choose account");
		expect(f.connect).not.toHaveBeenCalled();
		reopened.handleInput("\x1b"); // Esc from the accounts menu closes the chain
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: left arrow from the accounts menu returns to a freshly mounted catalog", async () => {
		const f = await fixture([view({ connectionIds: ["acme-work"], connectionStatus: "connected" })]);
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		catalog.handleInput("\r"); // → the service's accounts menu
		const accounts = await nextPicker(f, catalog);
		expect(accounts.getSearchInput()).toBeUndefined();
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("← back");
		accounts.handleInput("\x1b[D");
		const reopened = (await nextPicker(f, accounts)) as ServiceCatalogPickerComponent;
		// The catalog surface, freshly mounted: the search box is back and
		// EMPTY — the "acme" prefill that opened the chain did not survive.
		expect(reopened.getSearchInput()).toBeDefined();
		expect(reopened.getSearchInput()?.getValue()).toBe("");
		expect(stripAnsi(reopened.render(100).join("\n"))).toContain("Acme");
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: captured disabled stdio guidance cannot disable a server re-enabled while the picker is open", async () => {
		const f = await settingsFixture();
		const config = { type: "stdio" as const, command: "synthetic-not-executed", enabled: false };
		f.harness.settingsManager.setGlobalMcpServer("stdio-proof", config, true);
		const done = f.mode.showServiceCatalogPicker("stdio-proof");
		const picker = f.picker();
		expect(stripAnsi(picker.render(100).join("\n"))).toContain("Enter settings guidance");
		f.harness.settingsManager.setGlobalMcpServer("stdio-proof", { ...config, enabled: true }, true);
		const writeSettings = vi.spyOn(f.harness.settingsManager, "setGlobalMcpServer");
		picker.handleInput("\r");
		await done;
		expect(f.harness.settingsManager.getGlobalMcpServers()?.["stdio-proof"]?.enabled).toBe(true);
		expect(writeSettings).not.toHaveBeenCalled();
		expect(f.reload).not.toHaveBeenCalled();
		expect(f.showStatus).toHaveBeenCalled();
		expect(f.authFlow).not.toHaveBeenCalled();
		expect(f.reserve).not.toHaveBeenCalled();
		expect(f.claim).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	// Settings-only guidance surfaces (no mutation, no OAuth, status line as the outcome) are pinned at the ACTION seam
	// in mcp-activation-queue.test.ts ("Enter on an already-disabled stdio server reports the disabled state", "a
	// vanished stdio settings entry reports it is gone") and in mcp-catalog-eligibility.test.ts (bearer/user-server
	// semantics).

	it.each([false, true])(
		"ENG-6108: nonOAuth pending HTTP follows real Verify without OAuth (saved=%s)",
		async (saved) => {
			const f = await settingsFixture();
			vi.stubEnv("ENG_6108_PRESENT_BEARER", "synthetic-env-token");
			f.harness.settingsManager.setGlobalMcpServer(
				"http-proof",
				{ type: "http", url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_PRESENT_BEARER" },
				true,
			);
			if (saved) {
				f.store.upsert({
					connectionId: "http-proof",
					serviceId: "http-proof",
					endpoint: ENDPOINT,
					label: "HTTP",
					status: "pending",
					createdAt: 1,
					updatedAt: 1,
				});
				await f.store.flush();
			}
			const done = f.mode.showServiceCatalogPicker("http-proof");
			let picker = f.picker();
			if (saved) {
				expect(stripAnsi(picker.render(100).join("\n"))).toContain("Enter manage saved account");
				picker.handleInput("\r");
				picker = (await nextPicker(f, picker)) as ServiceCatalogPickerComponent;
			}
			const output = stripAnsi(picker.render(100).join("\n"));
			expect(output).toContain("Enter verify");
			expect(output).not.toContain("Add another account");
			if (saved) {
				expect(output).toContain("Reconnect");
				expect(output).not.toContain("Needs verification");
			} else {
				expect(output).toContain("Needs verification");
				expect(output).not.toContain("Remove saved data");
			}
			picker.handleInput("\r");
			// The verify RAN, so the accounts menu re-enters freshly built: even the
			// saved=false case now manages the persisted record — never the prompt.
			const reopened = (await nextPicker(f, picker)) as ServiceCatalogPickerComponent;
			expect(reopened.getSearchInput()).toBeUndefined();
			expect(stripAnsi(reopened.render(100).join("\n"))).toContain("Remove saved data for http-proof");
			reopened.handleInput("\x1b");
			await done;
			expect(f.editorContainer.children).toEqual([f.editor]);
			// Global fetch is denied: the existing verifier ran, not a login.
			expect(fetch).toHaveBeenCalled();
			expect(f.store.get("http-proof")?.status).toBe("pending");
			expect(f.store.get("http-proof")?.lastError).toBeDefined();
			expect(f.store.get("http-proof")?.verifiedAt).toBeUndefined();
			expect(f.reload).toHaveBeenCalledOnce();
			expect(f.appendOutcome).toHaveBeenCalledOnce();
			expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
				customType: "mcp_connection_outcome",
				details: { source: "retry", verification: "unverified" },
			});
			expect(f.authFlow).not.toHaveBeenCalled();
			expect(f.reserve).not.toHaveBeenCalled();
			expect(f.claim).not.toHaveBeenCalled();
		},
	);

	it.each(["record", "credential-only"] as const)(
		"ENG-6108: real nonOAuth HTTP %s cleanup removes saved data but keeps server settings and environment token",
		async (saved) => {
			const f = await settingsFixture();
			vi.stubEnv("ENG_6108_SAVED_BEARER", "");
			const config = { type: "http" as const, url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_SAVED_BEARER" };
			f.harness.settingsManager.setGlobalMcpServer("http-proof", config, true);
			f.harness.authStorage.set("mcp:http-proof", {
				type: "oauth",
				access: "synthetic-saved-token",
				refresh: "r",
				endpoint: ENDPOINT,
				expires: Date.now() + 3600_000,
			});
			if (saved === "record") {
				f.store.upsert({
					connectionId: "http-proof",
					serviceId: "http-proof",
					endpoint: ENDPOINT,
					label: "HTTP",
					status: "error",
					createdAt: 1,
					updatedAt: 1,
				});
				await f.store.flush();
			}
			const done = f.mode.showServiceCatalogPicker("http-proof");
			const catalog = f.picker();
			expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Enter manage saved account");
			catalog.handleInput("\r");
			const accounts = (await nextPicker(f, catalog)) as ServiceCatalogPickerComponent;
			expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter settings guidance");
			expect(stripAnsi(accounts.render(100).join("\n"))).not.toContain("Add another account");
			accounts.handleInput("\x1b[B");
			expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter remove saved data");
			// Changing the environment does not change the cleanup's meaning.
			vi.stubEnv("ENG_6108_SAVED_BEARER", "synthetic-current-token");
			accounts.handleInput("\r");
			// The removal RAN: the chain re-enters the CATALOG, where the
			// settings-managed server is still visible — now honestly empty.
			const reopened = await nextPicker(f, accounts);
			expect(reopened.getSearchInput()).toBeDefined();
			const after = stripAnsi(reopened.render(120).join("\n"));
			expect(after).toContain("http-proof");
			expect(after).not.toContain("Remove saved data");
			reopened.handleInput("\x1b");
			await done;
			expect(f.editorContainer.children).toEqual([f.editor]);
			expect(f.harness.authStorage.getVerified("mcp:http-proof")).toBeUndefined();
			expect(f.store.get("http-proof")).toBeUndefined();
			expect(f.harness.settingsManager.getGlobalMcpServers()?.["http-proof"]).toEqual(config);
			expect(f.reload).toHaveBeenCalledOnce();
			expect(f.authFlow).not.toHaveBeenCalled();
			expect(f.reserve).not.toHaveBeenCalled();
			expect(f.claim).not.toHaveBeenCalled();
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it("ENG-6108: saved HTTP guidance stays inert if the bearer environment changes after rendering", async () => {
		const f = await settingsFixture();
		vi.stubEnv("ENG_6108_GUIDANCE_BEARER", "");
		f.harness.settingsManager.setGlobalMcpServer(
			"http-proof",
			{ type: "http", url: ENDPOINT, bearerTokenEnvVar: "ENG_6108_GUIDANCE_BEARER" },
			true,
		);
		f.store.upsert({
			connectionId: "http-proof",
			serviceId: "http-proof",
			endpoint: ENDPOINT,
			label: "HTTP",
			status: "pending",
			createdAt: 1,
			updatedAt: 1,
		});
		await f.store.flush();
		const done = f.mode.showServiceCatalogPicker("http-proof");
		const catalog = f.picker();
		catalog.handleInput("\r");
		const accounts = await nextPicker(f, catalog);
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("Enter settings guidance");
		vi.stubEnv("ENG_6108_GUIDANCE_BEARER", "synthetic-new-token");
		accounts.handleInput("\r");
		await done;
		expect(f.authFlow).not.toHaveBeenCalled();
		expect(f.reload).not.toHaveBeenCalled();
		expect(f.reserve).not.toHaveBeenCalled();
		expect(f.claim).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
		expect(f.store.get("http-proof")?.status).toBe("pending");
	});

	/** A real-picker fixture whose service catalog comes from a declared LOCAL
	 * catalog source file (the same resolution production uses), with the REAL
	 * view builder, connect action, and paste flow. */
	async function localCatalogFixture(entries: Record<string, unknown>[]) {
		const file = writeLocalCatalog(entries);
		const f = await fixture([], { settings: { mcpCatalogSources: [file] } });
		Reflect.deleteProperty(f.mode, "buildServiceCatalogViews");
		Reflect.deleteProperty(f.mode, "connectServiceFromPicker");
		const showStatus = vi.fn();
		const reload = vi.fn(async () => {});
		const appendOutcome = vi.fn(async (_message: Record<string, unknown>) => {});
		const authFlow = vi.fn(() => {
			throw new Error("OAuth must not run for paste-only fixtures");
		});
		Object.assign(f.mode, {
			showStatus,
			handleReloadCommand: reload,
			createAuthFlows: authFlow,
			agentConnection: { appendCustomMessage: appendOutcome },
		});
		return { ...f, showStatus, reload, appendOutcome, authFlow };
	}

	const pasteEntry = {
		server: "paste-svc",
		service: "paste-svc",
		label: "Paste Service",
		url: PASTE_ENDPOINT,
		aliases: [],
		transport: { type: "http", url: PASTE_ENDPOINT },
		auth: { strategy: "api_key", clientRegistration: "unknown" },
		setup: {
			status: "requires-setup",
			reason: "Requires a paste token.",
			fields: [{ id: "PASTE_SVC_TOKEN", label: "Paste Service token", required: true, kind: "bearer-token" }],
		},
		verification: { status: "unverified" },
		legacyBuiltin: false,
		provenance: [{ source: "user" }],
	};

	it("ENG-6108: a submitted paste token re-enters the accounts menu with the new account", async () => {
		const f = await localCatalogFixture([pasteEntry]);
		const done = f.mode.showServiceCatalogPicker("paste-svc");
		const catalog = f.picker();
		expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Paste Service");
		catalog.handleInput("\r");
		// The paste panel mounts INLINE (never an overlay) over the editor.
		const panel = (await nextPastePanel(f)) as McpTokenPastePanelComponent;
		for (const character of "synthetic-pasted-token") panel.handleInput(character);
		panel.handleInput("\r");
		// The paste RAN and the service now owns an account: the accounts menu
		// re-enters — success or failure, the surface is state, not the verdict.
		const reopened = (await nextPicker(f, catalog)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeUndefined();
		const again = stripAnsi(reopened.render(100).join("\n"));
		expect(again).toContain("Paste Service MCP");
		expect(again).toContain("Reconnect");
		expect(again).toContain("Disconnect");
		// The token is stored under the shared MCP credential key and never leaks into the rendered surface.
		const credential = f.harness.authStorage.get("mcp:paste-svc");
		expect(credential).toMatchObject({ type: "mcp_static_token", bearer: "synthetic-pasted-token" });
		expect(again).not.toContain("synthetic-pasted-token");
		expect(f.appendOutcome).toHaveBeenCalledOnce();
		expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
			customType: "mcp_connection_outcome",
			details: { source: "paste" },
		});
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: Esc in the paste panel returns to the catalog that opened it", async () => {
		const f = await localCatalogFixture([pasteEntry]);
		const done = f.mode.showServiceCatalogPicker("paste-svc");
		const catalog = f.picker();
		catalog.handleInput("\r");
		const panel = (await nextPastePanel(f)) as McpTokenPastePanelComponent;
		panel.handleInput("\x1b");
		// Cancel stored NOTHING, so the surface that opened the panel — the
		// catalog — re-enters, not the prompt and not an empty accounts menu.
		const reopened = (await nextPicker(f, catalog)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeDefined();
		for (const character of "paste-svc") reopened.handleInput(character);
		expect(stripAnsi(reopened.render(120).join("\n"))).toContain("Paste Service");
		expect(f.harness.authStorage.get("mcp:paste-svc")).toBeUndefined();
		expect(f.store.records()).toEqual([]);
		expect(f.appendOutcome).not.toHaveBeenCalled();
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: a blocked action (login in progress) reports its status and never re-enters", async () => {
		const f = await settingsFixture();
		const now = Date.now();
		f.store.upsert({
			connectionId: "acme-work",
			serviceId: "acme",
			endpoint: ENDPOINT,
			label: "Work",
			status: "pending",
			createdAt: now,
			updatedAt: now,
			attemptId: "attempt-in-flight",
		});
		await f.store.flush();
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		catalog.handleInput("\r");
		const accounts = await nextPicker(f, catalog);
		expect(stripAnsi(accounts.render(100).join("\n"))).toContain("login in progress");
		accounts.handleInput("\r");
		// The action is blocked BEFORE it starts: the status line is the
		// outcome and the chain ends right there — no re-entry, no loop.
		await done;
		expect(f.showStatus).toHaveBeenCalledWith("Login in progress. Finish it or remove the account to cancel.");
		expect(f.editorContainer.children).toEqual([f.editor]);
		expect(f.appendOutcome).not.toHaveBeenCalled();
	});

	it("ENG-6108: disconnecting one of several accounts re-enters that service's accounts menu without the removed row", async () => {
		const f = await settingsFixture();
		const now = Date.now();
		// "acme-work" sorts before "acme-zzz", so the store's file (written
		// sorted) keeps the row order deterministic after the disk reload in re-entry.
		const second = "acme-zzz";
		for (const id of ["acme-work", second]) {
			f.harness.authStorage.set(`mcp:${id}`, oauthGrant("synthetic"));
			f.store.upsert({
				connectionId: id,
				serviceId: "acme",
				endpoint: ENDPOINT,
				label: id,
				status: "connected",
				verifiedAt: now,
				toolCount: 2,
				createdAt: now,
				updatedAt: now,
			});
		}
		await f.store.flush();
		const removeAccount = vi.spyOn(f.store, "removeAccount");
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		catalog.handleInput("\r");
		const accounts = await nextPicker(f, catalog);
		accounts.handleInput("\x1b[B"); // → Disconnect (the service-wide chooser)
		accounts.handleInput("\r");
		const sub = (await nextPicker(f, accounts)) as ServiceCatalogPickerComponent;
		expect(sub.getSearchInput()).toBeUndefined();
		const subOutput = stripAnsi(sub.render(100).join("\n"));
		expect(subOutput).toContain("Accounts");
		expect(subOutput).toContain("Enter disconnect");
		sub.handleInput("\r"); // → acme-work
		const reopened = (await nextPicker(f, sub)) as ServiceCatalogPickerComponent;
		// Same surface, rebuilt from the live store: acme-work is gone, the sibling remains.
		expect(reopened.getSearchInput()).toBeUndefined();
		const after = stripAnsi(reopened.render(100).join("\n"));
		expect(after).not.toContain("acme-work");
		expect(after).toContain("Reconnect");
		expect(after).toContain("Disconnect");
		expect(f.store.get("acme-work")).toBeUndefined();
		expect(f.store.get(second)).toBeDefined();
		expect(removeAccount).toHaveBeenCalledOnce();
		expect(f.appendOutcome).toHaveBeenCalledOnce();
		expect(f.appendOutcome.mock.calls[0]?.[0]).toMatchObject({
			details: { kind: "disconnect", connectionId: "acme-work" },
		});
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: a cancelled connect from the catalog re-enters the accounts menu of its preserved shell", async () => {
		const f = await settingsFixture();
		f.harness.settingsManager.setGlobalMcpServer("acme", { type: "http", url: ENDPOINT, oauth: true }, true);
		Object.assign(f.mode, { createAuthFlows: () => ({ runMcpLogin: vi.fn(async () => ({ status: "cancelled" })) }) });
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		expect(stripAnsi(catalog.render(100).join("\n"))).toContain("Enter connect");
		catalog.handleInput("\r");
		// The login was cancelled, and the guarded flow DELIBERATELY preserves the reserved pending shell (no credential,
		// no claim). Something IS stored, so the chain re-enters that service's accounts menu — never the prompt.
		const reopened = (await nextPicker(f, catalog)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeUndefined();
		const after = stripAnsi(reopened.render(100).join("\n"));
		expect(after).toContain("Reconnect");
		expect(after).toContain("Disconnect");
		expect(f.store.get("acme")?.attemptId).toBeUndefined();
		expect(f.harness.authStorage.get("mcp:acme")).toBeUndefined();
		expect(f.appendOutcome).not.toHaveBeenCalled();
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});

	it("ENG-6108: a committed connect from the catalog re-enters the accounts menu for the service just connected", async () => {
		const f = await settingsFixture();
		f.harness.settingsManager.setGlobalMcpServer("acme", { type: "http", url: ENDPOINT, oauth: true }, true);
		const _now = Date.now();
		Object.assign(f.mode, {
			createAuthFlows: () => ({
				runMcpLogin: vi.fn(async (serverId: string) => {
					// The staged login writes the STAGED credential; the guarded finalize moves it to the real account key.
					f.harness.authStorage.set(`mcp:${serverId}`, oauthGrant("new-grant"));
					return { status: "success" as const };
				}),
			}),
		});
		const done = f.mode.showServiceCatalogPicker("acme");
		const catalog = f.picker();
		catalog.handleInput("\r");
		// The login committed: the service now owns an account, so the ACCOUNTS
		// menu re-enters for it (offline verification is honestly unverified).
		const reopened = (await nextPicker(f, catalog)) as ServiceCatalogPickerComponent;
		expect(reopened.getSearchInput()).toBeUndefined();
		const after = stripAnsi(reopened.render(100).join("\n"));
		expect(after).toContain("Reconnect");
		expect(after).toContain("Disconnect");
		expect(f.store.get("acme")).toBeDefined();
		expect(f.harness.authStorage.getVerified("mcp:acme")).toBeDefined();
		expect(f.appendOutcome).toHaveBeenCalledOnce();
		reopened.handleInput("\x1b");
		await done;
		expect(f.editorContainer.children).toEqual([f.editor]);
	});
});
