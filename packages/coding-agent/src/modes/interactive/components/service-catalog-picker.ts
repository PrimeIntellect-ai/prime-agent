import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	TruncatedText,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { McpPluginView } from "../../../core/mcp/service-catalog.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import {
	getMenuListLayout,
	inlineMenuPanelTopRuleRows,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
} from "./menu-panel.js";

export interface ServiceCatalogPickerOptions extends MenuViewportProvider {
	/** Pre-filled search (e.g. from `/plugins notion`). */
	initialSearch?: string;
	/** Panel title override (e.g. the account picker reuses this component). */
	title?: string;
	/**
	 * Accounts mode: the static description shown above the options. Defaults
	 * to the shared card description (every account row inherits the service's).
	 */
	description?: string;
	/** Account rows preserve their account/disconnect grouping and expose explicit actions. */
	mode?: "catalog" | "accounts";
	/** Host-resolved intent and copy for settings-managed transports. */
	getRowPresentation?: (service: McpPluginView) => { action?: string; status?: string; detail?: string } | undefined;
}

/**
 * Catalog copy (descriptions, setup hints) is imported verbatim from upstream
 * plugin manifests and routinely contains newlines — Canva's description, for
 * example, lists its skills one per line. A rendered line must be exactly one
 * terminal line: an embedded newline paints extra physical rows that the
 * differential renderer never accounted for, so every row below it drifts and
 * stale rows survive (duplicated entries, doubled scroll counters). Flatten all
 * whitespace runs before the text becomes a line.
 */
function flattenToSingleLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

const PREFERRED_VISIBLE_SERVICES = 8;
const SEARCH_AND_FOOTER_ROWS = 4;
const SCROLL_INDICATOR_ROWS = 1;
/** The one fixed line under the list describing the selected connector. */
const DETAIL_ROWS = 1;
/** The one blank line between the last row and the description line. */
const DETAIL_SPACER_ROWS = 1;
/**
 * Viewports below this height cannot fit the search box, one result row, the
 * counter, the spacer, the description, and the hint; the description line
 * drops instead of overflowing the terminal. Real terminals never reach this
 * boundary.
 */
const MIN_ROWS_FOR_DETAIL = SEARCH_AND_FOOTER_ROWS + DETAIL_ROWS + DETAIL_SPACER_ROWS + 2;

/** Accounts mode: description wrap width, the onboarding choice panel's (PR #2340). */
const ACCOUNTS_DESCRIPTION_WIDTH = 50;
/** Accounts mode: the description block is hard-capped at three rendered lines. */
const ACCOUNTS_DESCRIPTION_MAX_LINES = 3;
/** Accounts mode: description lines plus the blank line under them, budgeted at the cap. */
const ACCOUNTS_DESCRIPTION_BUDGET_ROWS = ACCOUNTS_DESCRIPTION_MAX_LINES + 1;
/**
 * Accounts mode rows that are not option rows: the separator rule, the blank
 * under it, the header, the blank under the header, and the shortcuts line.
 */
const ACCOUNTS_FRAME_ROWS = 5;

// Search bands: lower scores rank first. Identity fields (label, service id,
// aliases) always outrank description/setup-hint text.
const EXACT_SCORE = 0;
const PREFIX_SCORE = 100;
const WORD_START_SCORE = 200;
const SUBSTRING_SCORE = 300;
const SUBSEQUENCE_SCORE = 400;
const DESCRIPTION_WORD_START_SCORE = 500;
const DESCRIPTION_SUBSTRING_SCORE = 600;

function words(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** Identity match: exact, prefix, word start, substring, then the subsequence fallback. */
function identityMatchScore(text: string, token: string): number | undefined {
	const haystack = text.toLowerCase();
	if (haystack === token) return EXACT_SCORE;
	if (haystack.startsWith(token)) return PREFIX_SCORE + (haystack.length - token.length) * 0.01;
	if (words(haystack).some((word) => word.startsWith(token))) return WORD_START_SCORE;
	const at = haystack.indexOf(token);
	if (at >= 0) return SUBSTRING_SCORE + at * 0.01;
	return subsequenceMatchScore(haystack, token);
}

/**
 * Identity-only subsequence fallback. The consecutive-run floor — half the
 * query, minimum two characters — keeps the fallback for tight abbreviations
 * ("crdb" finds cockroachdb) while rejecting the scattered matches that made
 * the old joined-haystack search return noise for almost any query.
 */
function subsequenceMatchScore(haystack: string, token: string): number | undefined {
	if (token.length < 2 || token.length > haystack.length) return undefined;
	let tokenIndex = 0;
	let runLength = 0;
	let longestRun = 0;
	let firstMatch = -1;
	let lastMatch = -1;
	for (let index = 0; index < haystack.length && tokenIndex < token.length; index++) {
		if (haystack[index] !== token[tokenIndex]) continue;
		runLength = lastMatch === index - 1 ? runLength + 1 : 1;
		longestRun = Math.max(longestRun, runLength);
		if (firstMatch === -1) firstMatch = index;
		lastMatch = index;
		tokenIndex++;
	}
	if (tokenIndex < token.length || longestRun < Math.max(2, Math.ceil(token.length / 2))) return undefined;
	return SUBSEQUENCE_SCORE + (lastMatch - firstMatch + 1 - token.length) * 2;
}

/** Description text matches only as a word start or substring — never a subsequence. */
function descriptionMatchScore(text: string, token: string): number | undefined {
	const haystack = text.toLowerCase();
	if (words(haystack).some((word) => word.startsWith(token))) return DESCRIPTION_WORD_START_SCORE;
	const at = haystack.indexOf(token);
	if (at >= 0) return DESCRIPTION_SUBSTRING_SCORE + at * 0.01;
	return undefined;
}

/**
 * Score one row against the query; undefined means "not a match". Every query
 * token must match somewhere. Only the catalog picker searches (accounts mode
 * has no search box), so description and setup-hint text only ever matches
 * catalog rows.
 */
function serviceMatchScore(service: McpPluginView, query: string): number | undefined {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return 0;
	let total = 0;
	for (const token of tokens) {
		let best: number | undefined;
		for (const field of [service.label, service.serviceId, ...(service.aliases ?? [])]) {
			const score = identityMatchScore(field, token);
			if (score !== undefined && (best === undefined || score < best)) best = score;
		}
		if (best === undefined) {
			for (const field of [service.description, service.setupHint]) {
				if (!field) continue;
				const score = descriptionMatchScore(field, token);
				if (score !== undefined && (best === undefined || score < best)) best = score;
			}
		}
		if (best === undefined) return undefined;
		total += best;
	}
	return total;
}

/** One option row of the accounts menu (the label carries the action). */
interface ServiceAccountsRow {
	label: string;
	selected: boolean;
}

/**
 * The accounts-mode body: a static choice list in the same selection language
 * as the onboarding choice panel (PR #2340) — one leading blank row, a single
 * column of indent, a prompt-style header, a muted wrapped description capped
 * at three lines, then `> label` for the selection (bold text over the
 * soft-selection background) and `  label` muted otherwise. No search box, no
 * counter, no right-hand column: the labels carry the actions.
 *
 * #2340 is not merged yet, so this mirrors OnboardingChoiceComponent's visual
 * language locally instead of importing it — dedupe the two once it lands.
 */
class ServiceAccountsBodyComponent implements Component {
	/** Full-width body: MenuPanel renders it without adding its own indent. */
	readonly fillsMenuPanel = true;

	constructor(
		private readonly header: string,
		private readonly description: string,
		private readonly getRowsState: () => readonly ServiceAccountsRow[],
	) {}

	invalidate(): void {
		// Render output derives from the picker's live state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		// The #2340 shape: a leading blank row, then the one-column indent.
		const lines: string[] = [this.line(safeWidth, "")];
		if (this.header) {
			lines.push(this.line(safeWidth, theme.fg("text", this.header)));
			lines.push(this.line(safeWidth, ""));
		}
		if (this.description) {
			const wrapWidth = Math.max(1, Math.min(ACCOUNTS_DESCRIPTION_WIDTH, safeWidth - 2));
			const wrapped = wrapTextWithAnsi(this.description, wrapWidth);
			// Hard cap: at most three lines, and when the description ran
			// longer the third line ALWAYS carries an ellipsis — even when the
			// wrapped line happens to fill the wrap width exactly.
			const shown = wrapped.slice(0, ACCOUNTS_DESCRIPTION_MAX_LINES);
			if (wrapped.length > shown.length && shown.length > 0) {
				const last = shown.length - 1;
				shown[last] = `${truncateToWidth(shown[last] ?? "", Math.max(0, wrapWidth - 1), "")}…`;
			}
			for (const row of shown) lines.push(this.line(safeWidth, theme.fg("muted", row)));
			lines.push(this.line(safeWidth, ""));
		}
		for (const row of this.getRowsState()) {
			const name = `${row.selected ? "> " : "  "}${row.label}`;
			const content = row.selected ? theme.bold(theme.fg("text", name)) : theme.fg("muted", name);
			lines.push(this.rowLine(safeWidth, content, row.selected));
		}
		return lines;
	}

	/** One indented line (the #2340 shape: a single column of indent). */
	private line(width: number, content: string): string {
		const truncated = truncateToWidth(content ? ` ${content}` : "", width, "");
		return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
	}

	/** A full-width option row; the selection is a bold label over the soft-selection background. */
	private rowLine(width: number, content: string, selected: boolean): string {
		const body = truncateToWidth(` ${content}`, width, "");
		const padded = body + " ".repeat(Math.max(0, width - visibleWidth(body)));
		return selected ? theme.getSoftSelectionBackgroundColor()(padded) : padded;
	}
}

/**
 * Inline catalog/account picker on the same menu primitives as models/providers.
 * Selection only reports intent; the host owns every guarded account operation.
 */
export class ServiceCatalogPickerComponent extends Container implements Focusable {
	/** Catalog mode only: accounts mode has no search box (Kevin, live testing). */
	private searchInput: MenuSearchInput | undefined;
	/** Accounts mode only: the static choice-list body. */
	private accountsBody: ServiceAccountsBodyComponent | undefined;
	/** Accounts mode: description rows budgeted for the viewport layout. */
	private accountsDescriptionRows = 0;

	// Delegate focus to the search input so its IME cursor remains positioned correctly.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		if (this.searchInput) this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allServices: McpPluginView[];
	private filteredServices: McpPluginView[];
	private searchQuery = "";
	private selectedIndex = 0;
	private readonly viewport: MenuViewportProvider;
	private readonly mode: "catalog" | "accounts";
	private readonly contextRows: number;
	private readonly getRowPresentation: ServiceCatalogPickerOptions["getRowPresentation"];
	private detailRows = 0;
	private readonly onSelectCallback: (service: McpPluginView) => void;
	private readonly onCancelCallback: () => void;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
		reservedRows: SEARCH_AND_FOOTER_ROWS,
		comfortableItemRows: 1,
		comfortableListPaddingRows: 0,
	});

	constructor(
		services: readonly McpPluginView[],
		onSelect: (service: McpPluginView) => void,
		onCancel: () => void,
		options: ServiceCatalogPickerOptions = {},
	) {
		super();
		this.allServices = [...services];
		this.filteredServices = this.allServices;
		this.viewport = options;
		this.mode = options.mode ?? "catalog";
		this.getRowPresentation = options.getRowPresentation;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const panel = new MenuPanel({
			title: this.mode === "accounts" ? "" : (options.title ?? ""),
			inline: true,
		});
		this.addChild(panel);
		// The catalog list container; accounts mode never attaches it — the
		// accounts body renders its rows from live state instead.
		this.listContainer = new MenuList({ inline: true });

		if (this.mode === "accounts") {
			// Kevin (live testing): the accounts menu had a search box that
			// filtered nothing useful, a first row that only re-verified, and
			// right-hand "remove account"/"add account" echoes of what the row
			// labels already say. The redesign is a static choice list —
			// header, description, then Reconnect/Disconnect/Add rows.
			const description = flattenToSingleLine(
				options.description ?? this.allServices[0]?.description ?? this.allServices[0]?.setupHint ?? "",
			);
			this.accountsDescriptionRows = description ? ACCOUNTS_DESCRIPTION_BUDGET_ROWS : 0;
			this.accountsBody = new ServiceAccountsBodyComponent(
				flattenToSingleLine(options.title ?? ""),
				description,
				() => this.accountsRows(),
			);
			panel.addChild(this.accountsBody);
			// The accounts body owns every fixed row (blank, header,
			// description); only the separator rule leads the panel, and the
			// viewport budget lives in updateLayout's accounts branch.
			this.contextRows = inlineMenuPanelTopRuleRows({ firstChild: this.accountsBody });
			return;
		}

		const searchInput = new MenuSearchInput("Search MCP connections", true);
		this.searchInput = searchInput;
		searchInput.onSubmit = () => {
			const service = this.filteredServices[this.selectedIndex];
			if (service) this.onSelectCallback(service);
		};
		panel.addChild(searchInput);
		// A titled panel renders the separator rule plus the title before its
		// children; a headerless panel's rule IS the search input's top border,
		// already budgeted in SEARCH_AND_FOOTER_ROWS. The helper is the same
		// decision MenuPanel.render applies.
		this.contextRows =
			(options.title ? 1 : 0) + inlineMenuPanelTopRuleRows({ title: options.title, firstChild: searchInput });

		panel.addChild(this.listContainer);

		if (options.initialSearch) searchInput.setValue(options.initialSearch);
		this.filterServices(options.initialSearch ?? "");
	}

	getSearchInput(): MenuSearchInput | undefined {
		return this.searchInput;
	}

	private filterServices(query: string): void {
		if (this.mode === "accounts") {
			// No search box in accounts mode: the row set IS the menu and
			// typing is inert, so the filter never runs.
			this.filteredServices = this.allServices;
			return;
		}
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		const trimmed = query.trim();
		if (!trimmed) {
			this.filteredServices = this.allServices;
		} else {
			const scored: { service: McpPluginView; score: number }[] = [];
			for (const service of this.allServices) {
				const score = serviceMatchScore(service, trimmed);
				if (score !== undefined) scored.push({ service, score });
			}
			// Stable sort: rows that score the same keep their catalog order.
			scored.sort((left, right) => left.score - right.score);
			this.filteredServices = scored.map((entry) => entry.service);
		}
		this.selectedIndex = queryChanged
			? 0
			: Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredServices.length - 1)));
		this.updateList();
	}

	override render(width: number): string[] {
		// Pure projection: rebuild the visible window from the CURRENT selection,
		// filter, and viewport on every render. The old layout-change heuristic
		// kept stale row children whenever a rebuild was skipped, so frames
		// rendered at unusual times (resizes, host re-renders) could disagree
		// about which rows were visible or selected. Rebuilding here makes
		// consecutive frames with unchanged state render byte-identical output.
		this.updateList();
		const selected = this.filteredServices[this.selectedIndex];
		const confirm = keyText("tui.select.confirm", { primaryOnly: true });
		const cancel = keyText("tui.select.cancel", { primaryOnly: true });
		const action = selected
			? `${confirm} ${this.getRowPresentation?.(selected)?.action ?? this.actionText(selected)} · `
			: "";
		const navigation = `${keyText("tui.select.up", { primaryOnly: true })}/${keyText("tui.select.down", { primaryOnly: true })} navigate · `;
		const hint = `${width >= 70 ? navigation : ""}${action}${cancel} close`;
		return [...super.render(width), truncateToWidth(theme.fg("dim", ` ${hint}`), width, "", true)];
	}

	private updateList(): void {
		this.updateLayout();
		if (this.mode === "accounts") {
			// The accounts body renders from the picker's live state every
			// frame; there is no child list to rebuild.
			return;
		}
		this.listContainer.clear();

		// Centered window over the selection, clamped to the list bounds: at the
		// top boundary the window starts at row 0 and moving down only ever
		// shifts it forward — rows never wrap around or repeat.
		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredServices.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredServices.length);

		for (let index = startIndex; index < endIndex; index++) {
			const service = this.filteredServices[index];
			if (!service) continue;
			this.listContainer.addChild(
				new MenuRow({
					// Labels and host-provided status are catalog copy too: flatten
					// them so a stray newline can never split a row.
					primary: flattenToSingleLine(service.label),
					trailing: [flattenToSingleLine(this.getRowPresentation?.(service)?.status ?? this.statusText(service))],
					selected: index === this.selectedIndex,
					inline: true,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredServices.length) {
			// One leading space plus TruncatedText's one-column padding puts the
			// counter's first glyph in the same column as the rows' labels
			// (the rows render "› "/" before their primary text).
			const scrollInfo = theme.fg("muted", ` (${this.selectedIndex + 1}/${this.filteredServices.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		if (this.filteredServices.length === 0) {
			const message = this.allServices.length === 0 ? "No external services available" : "No matching services";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", ` ${message}`), 1, 0));
			// One blank row between the empty state and the shortcuts line
			// (Kevin, live testing): the message never touches the keybinds.
			// The pair is fixed, so the empty frame stays deterministic — the
			// panel height never jumps between renders of the same state.
			this.listContainer.addChild({
				render: () => [""],
				invalidate: () => {},
			});
		} else if (this.detailRows > 0) {
			// One blank line between the last row and the description, so the
			// settings block reads as its own group. updateLayout() budgets the
			// spacer, so the panel height never changes to fit it.
			this.listContainer.addChild({
				render: () => [""],
				invalidate: () => {},
			});
			// ONE fixed line about the selected connector — never a growing
			// description block — with the shortcuts row underneath from render().
			// updateLayout() budgets the line, so the panel never resizes to fit it.
			const selected = this.filteredServices[this.selectedIndex];
			this.listContainer.addChild({
				render: (width) => [
					truncateToWidth(
						theme.fg(
							"muted",
							` ${flattenToSingleLine(
								this.getRowPresentation?.(selected)?.detail ??
									this.secondaryText(selected) ??
									this.statusText(selected),
							)}`,
						),
						width,
						"…",
						true,
					),
				],
				invalidate: () => {},
			});
		}
	}

	private actionText(service: McpPluginView): string {
		// The relabelled Disconnect row keeps the remove semantics; the hint
		// names the row (Kevin, live testing).
		if (service.removeAction) return "disconnect";
		if (service.loginPending && this.mode === "accounts") return "login in progress";
		// A requires-setup token service connects by pasting: the hint is the
		// action, not a dead-end "see setup" pointer.
		if (service.pasteToken && service.connectionIds.length === 0) return "paste token";
		if (this.mode === "catalog" && service.connectionIds.length > 0) return "manage accounts";
		if (this.mode === "accounts" && service.connectionIds.length === 0)
			return service.usesOAuth ? "add account" : "setup guidance";
		if (service.source === "user" && !service.usesOAuth) return "manage";
		// Enter on the accounts Reconnect row re-verifies a connected account;
		// disconnect is the explicit Disconnect row's job, so Reconnect never
		// disconnects. The hint names the row.
		if (service.connectionStatus === "connected") return this.mode === "accounts" ? "reconnect" : "re-verify";
		if (service.connectionStatus === "pending") return "verify";
		if (!service.connectable) return "setup guidance";
		return service.connectionStatus === "error" ? "reconnect" : "connect";
	}

	private statusText(service: McpPluginView): string {
		if (service.removeAction) return theme.fg("muted", "Remove account");
		// The accounts-mode paste row carries its action; the catalog row keeps
		// the honest "Requires setup" state with the paste-token hint.
		if (service.pasteToken && this.mode === "accounts") return theme.fg("accent", "Paste token");
		if (service.loginPending) return theme.fg("warning", "Login in progress");
		if (this.mode === "accounts" && service.connectionIds.length === 0)
			return service.usesOAuth ? theme.fg("accent", "Add account") : theme.fg("warning", "Requires setup");
		switch (service.connectionStatus) {
			case "connected":
				return theme.fg(
					"success",
					service.toolCount !== undefined ? `Connected · ${service.toolCount} tools` : "Connected",
				);
			case "pending":
				return theme.fg("warning", "Needs verification");
			case "error":
				return theme.fg("error", service.connectable ? "Reconnect" : "Needs attention");
			case "setup_required":
				return theme.fg("warning", "Requires setup");
			case "disabled":
				return theme.fg("muted", "Disabled");
			default:
				// "Connect" is the plain next step, not a semantic state like
				// the success/warning/error trailing texts around it, so it
				// reads in the white text colour instead of the accent purple
				// (Kevin, live testing).
				return service.connectable ? theme.fg("text", "Connect") : theme.fg("muted", "Not connected");
		}
	}

	private secondaryText(service: McpPluginView): string | undefined {
		if (service.removeAction) return "Remove this account and its saved credential.";
		if (this.mode === "accounts" && service.connectionIds.length === 0)
			return service.usesOAuth
				? "Connect a separate account without replacing an existing one."
				: "Manage this connection through /mcp or your settings file.";
		if (service.connectionStatus === "setup_required" || service.connectionStatus === "error") {
			return service.setupHint ?? service.description;
		}
		return service.description ?? service.setupHint;
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredServices.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredServices.length === 0) return;
			this.selectedIndex = Math.min(this.filteredServices.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (
			keybindings.matches(keyData, "tui.select.pageUp") ||
			keybindings.matches(keyData, "tui.select.pageDown")
		) {
			if (this.filteredServices.length === 0) return;
			const direction = keybindings.matches(keyData, "tui.select.pageUp") ? -1 : 1;
			this.selectedIndex = Math.max(
				0,
				Math.min(this.filteredServices.length - 1, this.selectedIndex + direction * this.listLayout.visibleItems),
			);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			const service = this.filteredServices[this.selectedIndex];
			if (service) this.onSelectCallback(service);
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else if (this.mode === "accounts") {
			// No search box in accounts mode: plain typing is inert.
			return;
		} else {
			const searchInput = this.searchInput;
			if (!searchInput) return;
			const previousQuery = searchInput.getValue();
			searchInput.handleInput(keyData);
			if (previousQuery !== searchInput.getValue()) this.filterServices(searchInput.getValue());
		}
	}

	/**
	 * Visible accounts rows: the same centered window the catalog list uses,
	 * projected onto the choice-list shape. There is no scroll counter — the
	 * account menu is a short static list, and the window only exists so a
	 * pathological account count can never overflow the terminal.
	 */
	private accountsRows(): ServiceAccountsRow[] {
		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredServices.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredServices.length);
		const rows: ServiceAccountsRow[] = [];
		for (let index = startIndex; index < endIndex; index++) {
			const service = this.filteredServices[index];
			if (!service) continue;
			// Row labels carry the action (Reconnect / Disconnect <id> / Add
			// another account); flatten so a stray newline can never split one.
			rows.push({ label: flattenToSingleLine(service.label), selected: index === this.selectedIndex });
		}
		return rows;
	}

	private updateLayout(): void {
		if (this.mode === "accounts") {
			// Accounts frame: rule + blank + header + blank + (description +
			// blank, budgeted at the cap) + hint. Budgeting the description at
			// its MAX keeps the frame deterministic; a shorter description only
			// undershoots the viewport, it never overflows it.
			this.detailRows = 0;
			this.listLayout = getMenuListLayout({
				getRows: this.viewport.getRows,
				preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
				totalItems: this.filteredServices.length,
				reservedRows: ACCOUNTS_FRAME_ROWS + this.accountsDescriptionRows,
				comfortableItemRows: 1,
				comfortableListPaddingRows: 0,
				scrollIndicatorRows: 0,
			});
			return;
		}
		// The description is ONE fixed line (no appearance-driven resize); it
		// only drops in terminals too short to fit the panel skeleton at all.
		this.detailRows =
			(this.viewport.getRows?.() ?? Number.POSITIVE_INFINITY) >= MIN_ROWS_FOR_DETAIL + this.contextRows
				? DETAIL_ROWS
				: 0;
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
			totalItems: this.filteredServices.length,
			reservedRows:
				SEARCH_AND_FOOTER_ROWS +
				this.contextRows +
				this.detailRows +
				(this.detailRows > 0 ? DETAIL_SPACER_ROWS : 0),
			comfortableItemRows: 1,
			comfortableListPaddingRows: 0,
			scrollIndicatorRows: SCROLL_INDICATOR_ROWS,
		});
	}
}
