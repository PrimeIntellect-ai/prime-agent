import { Container, type Focusable, getKeybindings, TruncatedText, truncateToWidth } from "@earendil-works/pi-tui";
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
	/** Account rows preserve their account/remove grouping and expose explicit actions. */
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
 * token must match somewhere. Account rows all carry the SAME description and
 * setup hint (inherited from the service), so matching that text could never
 * filter anything — accounts mode matches identity only: the account label
 * and the connection id are the fields that distinguish rows.
 */
function serviceMatchScore(service: McpPluginView, query: string, mode: "catalog" | "accounts"): number | undefined {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return 0;
	let total = 0;
	for (const token of tokens) {
		let best: number | undefined;
		for (const field of [service.label, service.serviceId, ...(service.aliases ?? [])]) {
			const score = identityMatchScore(field, token);
			if (score !== undefined && (best === undefined || score < best)) best = score;
		}
		if (best === undefined && mode === "catalog") {
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

/**
 * Inline catalog/account picker on the same menu primitives as models/providers.
 * Selection only reports intent; the host owns every guarded account operation.
 */
export class ServiceCatalogPickerComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	// Delegate focus to the search input so its IME cursor remains positioned correctly.
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
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
			title: options.title ?? "",
			inline: true,
		});
		this.addChild(panel);

		this.searchInput = new MenuSearchInput(
			this.mode === "accounts" ? "Search accounts" : "Search MCP connections",
			true,
		);
		this.searchInput.onSubmit = () => {
			const service = this.filteredServices[this.selectedIndex];
			if (service) this.onSelectCallback(service);
		};
		panel.addChild(this.searchInput);
		// A titled panel (accounts mode) renders the separator rule plus the
		// title before its children; a headerless panel's rule IS the search
		// input's top border, already budgeted in SEARCH_AND_FOOTER_ROWS. The
		// helper is the same decision MenuPanel.render applies.
		this.contextRows =
			(options.title ? 1 : 0) + inlineMenuPanelTopRuleRows({ title: options.title, firstChild: this.searchInput });

		this.listContainer = new MenuList({ inline: true });
		panel.addChild(this.listContainer);

		if (options.initialSearch) this.searchInput.setValue(options.initialSearch);
		this.filterServices(options.initialSearch ?? "");
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private filterServices(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		const trimmed = query.trim();
		if (!trimmed) {
			this.filteredServices = this.allServices;
		} else {
			const scored: { service: McpPluginView; score: number }[] = [];
			for (const service of this.allServices) {
				const score = serviceMatchScore(service, trimmed, this.mode);
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
		if (service.removeAction) return "remove account";
		if (service.loginPending && this.mode === "accounts") return "login in progress";
		if (this.mode === "catalog" && service.connectionIds.length > 0) return "manage accounts";
		if (this.mode === "accounts" && service.connectionIds.length === 0)
			return service.usesOAuth ? "add account" : "setup guidance";
		if (service.source === "user" && !service.usesOAuth) return "manage";
		// Enter on the account NAME row re-verifies a connected account; removal
		// is the explicit Remove row's job, so the name row never disconnects.
		if (service.connectionStatus === "connected") return "re-verify";
		if (service.connectionStatus === "pending") return "verify";
		if (!service.connectable) return "setup guidance";
		return service.connectionStatus === "error" ? "reconnect" : "connect";
	}

	private statusText(service: McpPluginView): string {
		if (service.removeAction) return theme.fg("muted", "Remove account");
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
				return service.connectable ? theme.fg("accent", "Connect") : theme.fg("muted", "Not connected");
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
		} else {
			const previousQuery = this.searchInput.getValue();
			this.searchInput.handleInput(keyData);
			if (previousQuery !== this.searchInput.getValue()) this.filterServices(this.searchInput.getValue());
		}
	}

	private updateLayout(): void {
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
