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

	it("never emits an embedded newline, even when catalog copy is multi-line", () => {
		// Real catalog copy (Canva's description) lists skills one per line. A
		// rendered line containing "\n" paints extra physical rows that the
		// differential renderer never counted, so rows below it drift and stale
		// rows survive — duplicated entries and doubled scroll counters.
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
		// Exactly one full-width rule opens this headerless panel: the bordered
		// search input leads, so its top border IS the separator rule and the
		// panel never doubles it.
		expect(lines[0]).toBe("─".repeat(80));
		expect(lines[1]).not.toBe("─".repeat(80));
		expect(lines[1]).toContain("Search MCP connections");
		expect(lines[2]).toBe("─".repeat(80));
		expect(lines[3]).toMatch(/^› Acme\s+Connect$/);
		// One fixed description line about the selected connector, one blank
		// line above it, and the shortcuts underneath — no viewport-driven resize.
		expect(lines).toHaveLength(7);
		expect(lines[4].trim()).toBe("");
		expect(lines[5]).toContain("Selected detail");
		expect(lines[6]).toContain("↑/↓ navigate");
		expect(lines[6]).toContain("Enter connect");
	});

	it.each([24, 40, 80, 120])(
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
		// Enter on the account NAME row re-verifies; only the Remove row removes.
		expect(output).toContain("Enter re-verify");
		expect(output).not.toContain("Enter disconnect");
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
			view: viewFixture({ connectionIds: ["acme"], connectionStatus: "connected" }),
			mode: "accounts" as const,
			action: "re-verify",
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

	it("keeps a single selection and no duplicated rows when navigating up to the first row then down", () => {
		const picker = new ServiceCatalogPickerComponent(
			Array.from({ length: 77 }, (_, i) => viewFixture({ serviceId: `svc-${i}`, label: `Service ${i}` })),
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		const renderState = () => {
			const lines = picker.render(100).map(stripAnsi);
			return {
				selected: lines.filter((line) => line.includes("›")),
				rows: lines.filter((line) => /Service \d/.test(line)).map((line) => (line.match(/Service \d+/) ?? [""])[0]),
				counter: lines.find((line) => /\(\d+\/\d+\)/.test(line)),
			};
		};
		// Up at the top boundary clamps at the first row without wrapping.
		picker.handleInput("\x1b[A");
		picker.handleInput("\x1b[A");
		let state = renderState();
		expect(state.selected).toHaveLength(1);
		expect(new Set(state.rows).size).toBe(state.rows.length);
		expect(state.rows[0]).toBe("Service 0");
		expect(state.counter).toContain("(1/77)");
		// Scrolling back down shifts the window forward one row per step: the
		// first connector renders once and exactly one row stays selected.
		for (let step = 0; step < 6; step++) picker.handleInput("\x1b[B");
		state = renderState();
		expect(state.selected).toHaveLength(1);
		expect(new Set(state.rows).size).toBe(state.rows.length);
		expect(state.counter).toContain("(7/77)");
		// Returning to the boundary behaves the same on the way back up.
		for (let step = 0; step < 8; step++) picker.handleInput("\x1b[A");
		state = renderState();
		expect(state.selected).toHaveLength(1);
		expect(new Set(state.rows).size).toBe(state.rows.length);
		expect(state.counter).toContain("(1/77)");
	});

	it("renders byte-identical frames while nothing changes", () => {
		const picker = new ServiceCatalogPickerComponent(
			Array.from({ length: 77 }, (_, i) => viewFixture({ serviceId: `svc-${i}`, label: `Service ${i}` })),
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		picker.handleInput("\x1b[B");
		picker.handleInput("\x1b[B");
		expect(picker.render(100)).toEqual(picker.render(100));
		expect(picker.render(100)).toEqual(picker.render(100));
	});

	it("shows one fixed description line with the shortcuts underneath, never resizing for the description", () => {
		const services = [
			viewFixture({
				serviceId: "canva",
				label: "Canva",
				connectionStatus: "connected",
				connectionIds: ["canva"],
				toolCount: 34,
				description: "Design and publish social content.",
			}),
			...Array.from({ length: 76 }, (_, i) =>
				viewFixture({
					serviceId: `svc-${i}`,
					label: `Service ${i}`,
					description: `Description ${i} long enough to need truncation at narrow widths for the single detail line.`,
				}),
			),
		];
		const picker = new ServiceCatalogPickerComponent(
			services,
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		const frame = () => picker.render(100).map(stripAnsi);
		let lines = frame();
		const detailIndex = lines.findIndex((line) => line.includes("Design and publish social content."));
		expect(detailIndex).toBeGreaterThan(0);
		// Exactly ONE description line with ONE blank line above it: the
		// counter sits directly above the blank, the shortcuts directly
		// underneath the description, and the hint is the panel's last line.
		expect(lines[detailIndex - 1].trim()).toBe("");
		expect(lines[detailIndex - 2].trim()).toMatch(/\(\d+\/\d+\)/);
		expect(lines[detailIndex + 1]).toContain("↑/↓ navigate");
		expect(lines[detailIndex + 1]).toContain("Enter manage accounts");
		expect(lines[lines.length - 1]).toContain("Esc close");
		const heightAtFirst = lines.length;
		// Navigating swaps the description text but never the panel height.
		picker.handleInput("\x1b[B");
		picker.handleInput("\x1b[B");
		lines = frame();
		expect(lines).toHaveLength(heightAtFirst);
		// Two downs move to svc-1 (index 2, after Canva): the description line
		// swaps to that connector without changing the panel height.
		expect(lines.some((line) => line.includes("Description 1"))).toBe(true);
		// The one-line contract holds at narrow widths too.
		expect(picker.render(40).map(stripAnsi)).toHaveLength(heightAtFirst);
	});

	it("counts exactly the rows it renders, including pinned installed connections", () => {
		// Kevin's live /mcp read (1/77) against the 75-entry catalog: the two
		// extra rows are his installed figma/huggingface-skills connections
		// pinned from records after the catalog cut. The counter counts the
		// rendered list — 77 unique rows — and follows the search filter.
		const services = [
			...Array.from({ length: 75 }, (_, i) => viewFixture({ serviceId: `svc-${i}`, label: `Service ${i}` })),
			viewFixture({ serviceId: "figma", label: "Figma" }),
			viewFixture({ serviceId: "huggingface-skills", label: "Hugging Face" }),
		];
		const picker = new ServiceCatalogPickerComponent(
			services,
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		const counterLine = () =>
			picker
				.render(100)
				.map(stripAnsi)
				.find((line) => /\(\d+\/\d+\)/.test(line));
		expect(counterLine()).toContain("(1/77)");
		picker.handleInput("service");
		expect(counterLine()).toContain("(1/75)");
		// A filtered list that fits on screen drops the scroll counter entirely.
		for (let i = 0; i < 7; i++) picker.handleInput("\x7f");
		picker.handleInput("hugg");
		expect(counterLine()).toBeUndefined();
		expect(stripAnsi(picker.render(100).join("\n"))).toContain("Hugging Face");
	});
	it("aligns the scroll counter and the empty state with the row indent", () => {
		// Kevin (live testing): the (1/77) counter sat one column off the rows.
		// Rows render "› "/" before their label, so label text starts at column
		// 2 — the counter and the empty-state message must align to that.
		const services = Array.from({ length: 77 }, (_, i) =>
			viewFixture({ serviceId: `svc-${i}`, label: `Service ${i}` }),
		);
		const picker = new ServiceCatalogPickerComponent(
			services,
			() => {},
			() => {},
			{ getRows: () => 24 },
		);
		const lines = picker.render(100).map(stripAnsi);
		const counter = lines.find((line) => /\(\d+\/\d+\)/.test(line));
		const row = lines.find((line) => /^ {2}Service \d/.test(line));
		expect(counter).toBeDefined();
		expect(row).toBeDefined();
		expect(counter?.indexOf("(1/77)")).toBe(2);
		expect(row?.indexOf("Service")).toBe(2);
		picker.handleInput("zzzzzzzz");
		const empty = picker
			.render(100)
			.map(stripAnsi)
			.find((line) => line.includes("No matching services"));
		expect(empty?.indexOf("No matching services")).toBe(2);
	});

	it("returns zero rows for a query nothing matches, never scattered-subsequence noise", () => {
		// Kevin's live report: searching "vercel" surfaced eight unrelated rows
		// through the shared setup-hint boilerplate ("...not been VERified.
		// ConneCt ... capabilitiEs ... Login"). Vercel is not in the catalog, so
		// the honest answer is the empty state.
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
		let detailIndex = lines.findIndex((line) => line.includes("Selected detail"));
		expect(detailIndex).toBeGreaterThan(0);
		expect(lines[detailIndex - 1].trim()).toBe("");
		expect(lines[detailIndex - 2]).toMatch(/Acme/);

		const account = viewFixture({
			serviceId: "acme-work",
			label: "Acme work",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			description: "Bring operational data into your conversations.",
		});
		const accounts = new ServiceCatalogPickerComponent(
			[
				account,
				{ ...account, label: "Remove acme-work", removeAction: true },
				viewFixture({
					label: "Add another account",
					description: "Bring operational data into your conversations.",
				}),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Accounts — Acme" },
		);
		lines = accounts.render(80).map(stripAnsi);
		detailIndex = lines.findIndex((line) => line.includes("Bring operational data"));
		expect(detailIndex).toBeGreaterThan(0);
		expect(lines[detailIndex - 1].trim()).toBe("");
		expect(lines[detailIndex - 2]).toMatch(/Add another account/);
	});

	it("opens every inline panel with exactly one leading separator rule", () => {
		// Kevin (live testing): inline pickers need a line between the chat view
		// and the picker. A headerless panel borrows the bordered search's top
		// border as that rule; a titled panel draws the rule above its title.
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
			label: "Acme work",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
		});
		const accounts = new ServiceCatalogPickerComponent(
			[account, { ...account, label: "Remove acme-work", removeAction: true }],
			() => {},
			() => {},
			{ mode: "accounts", title: "Accounts — Acme" },
		);
		const titled = accounts.render(80).map(stripAnsi);
		expect(titled[0]).toBe("─".repeat(80));
		expect(titled[1]).toContain("Accounts — Acme");
		expect(titled[2]).toBe("─".repeat(80));
	});

	it("filters account rows by their distinguishing fields only", () => {
		// Every account row inherits the service's description and setup hint,
		// so matching that text filters nothing ("search accounts doesn't
		// really do anything"). Accounts search matches the account label and
		// the connection id — the fields that actually distinguish rows.
		const account = viewFixture({
			serviceId: "acme-work",
			label: "Acme · acme-work",
			connectionIds: ["acme-work"],
			connectionStatus: "connected",
			description: "Bring operational data into your conversations.",
		});
		const picker = new ServiceCatalogPickerComponent(
			[
				account,
				{ ...account, label: "Remove acme-work", removeAction: true },
				viewFixture({
					label: "Add another account",
					description: "Bring operational data into your conversations.",
				}),
			],
			() => {},
			() => {},
			{ mode: "accounts", title: "Accounts — Acme", getRows: () => 24 },
		);
		const visible = () => {
			const output = stripAnsi(picker.render(100).join("\n"));
			return {
				accountRow: output.includes("Acme · acme-work"),
				removeRow: output.includes("Remove acme-work"),
				addRow: output.includes("Add another account"),
				empty: output.includes("No matching services"),
			};
		};
		const backspace = (count: number) => {
			for (let i = 0; i < count; i++) picker.handleInput("\x7f");
		};
		picker.handleInput("work");
		expect(visible()).toEqual({ accountRow: true, removeRow: true, addRow: false, empty: false });
		backspace(4);
		picker.handleInput("remove");
		expect(visible()).toEqual({ accountRow: false, removeRow: true, addRow: false, empty: false });
		backspace(6);
		picker.handleInput("operational");
		expect(visible().empty).toBe(true);
	});
});
