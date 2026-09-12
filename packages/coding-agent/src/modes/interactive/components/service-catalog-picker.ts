import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	TruncatedText,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { McpPluginView } from "../../../core/mcp/service-catalog.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import {
	getMenuListLayout,
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

const PREFERRED_VISIBLE_SERVICES = 8;
const SEARCH_AND_FOOTER_ROWS = 4;
const SCROLL_INDICATOR_ROWS = 1;

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
		this.contextRows = options.title ? 1 : 0;
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
		this.filteredServices = query
			? fuzzyFilter(this.allServices, query, (service) =>
					[
						service.label,
						service.serviceId,
						service.description ?? "",
						...(service.setupHint ? [service.setupHint] : []),
					].join(" "),
				)
			: this.allServices;
		this.selectedIndex = queryChanged
			? 0
			: Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredServices.length - 1)));
		this.updateList();
	}

	override render(width: number): string[] {
		const previousLayout = this.listLayout;
		const previousDetailRows = this.detailRows;
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems ||
			this.detailRows !== previousDetailRows
		) {
			this.updateList();
		}
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
					primary: service.label,
					trailing: [this.getRowPresentation?.(service)?.status ?? this.statusText(service)],
					selected: index === this.selectedIndex,
					inline: true,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredServices.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredServices.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		if (this.filteredServices.length === 0) {
			const message = this.allServices.length === 0 ? "No external services available" : "No matching services";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", message), 1, 0));
		} else if (this.detailRows > 0) {
			const selected = this.filteredServices[this.selectedIndex];
			this.listContainer.addChild({
				render: (width) => [
					"",
					truncateToWidth(
						theme.fg(
							"muted",
							` ${this.getRowPresentation?.(selected)?.detail ?? this.secondaryText(selected) ?? this.statusText(selected)}`,
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
		if (this.mode === "catalog" && service.connectionIds.length > 0) return "manage accounts";
		if (this.mode === "accounts" && service.connectionIds.length === 0)
			return service.usesOAuth ? "add account" : "setup guidance";
		if (service.source === "user" && !service.usesOAuth) return "manage";
		if (service.connectionStatus === "connected") return "disconnect";
		if (service.connectionStatus === "pending") return "verify";
		if (!service.connectable) return "setup guidance";
		return service.connectionStatus === "error" ? "reconnect" : "connect";
	}

	private statusText(service: McpPluginView): string {
		if (service.removeAction) return theme.fg("muted", "Remove account");
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
				return theme.fg("error", "Reconnect");
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
		this.detailRows = (this.viewport.getRows?.() ?? Number.POSITIVE_INFINITY) >= 9 + this.contextRows ? 2 : 0;
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
			totalItems: this.filteredServices.length,
			reservedRows: SEARCH_AND_FOOTER_ROWS + this.contextRows + this.detailRows,
			comfortableItemRows: 1,
			comfortableListPaddingRows: 0,
			scrollIndicatorRows: SCROLL_INDICATOR_ROWS,
		});
	}
}
