import { Container, type Focusable, fuzzyFilter, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { McpPluginView } from "../../../core/mcp/service-catalog.js";
import { theme } from "../theme/theme.js";
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
}

const PREFERRED_VISIBLE_SERVICES = 9;
const SERVICE_LIST_RESERVED_ROWS = 7;
const SCROLL_INDICATOR_ROWS = 1;

/**
 * Searchable external-service picker for /plugins and bare /mcp. Shows one card
 * per service with its honest connection state; Enter connects (OAuth), verifies,
 * or disconnects depending on the state.
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
	private readonly onSelectCallback: (service: McpPluginView) => void;
	private readonly onCancelCallback: () => void;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
		reservedRows: SERVICE_LIST_RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
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
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const panel = new MenuPanel({
			title: "External Services",
			subtitle: "Search services; Enter connects, verifies, or disconnects.",
		});
		this.addChild(panel);

		this.searchInput = new MenuSearchInput("Search services (e.g. Notion)");
		this.searchInput.onSubmit = () => {
			const service = this.filteredServices[this.selectedIndex];
			if (service) this.onSelectCallback(service);
		};
		panel.addChild(this.searchInput);
		panel.addChild(new Spacer(1));

		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
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
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems
		) {
			this.updateList();
		}
		return super.render(width);
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
					secondary: this.secondaryText(service),
					meta: this.statusText(service),
					selected: index === this.selectedIndex,
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
		}
	}

	private statusText(service: McpPluginView): string {
		switch (service.connectionStatus) {
			case "connected":
				return theme.fg(
					"success",
					service.toolCount !== undefined ? `Connected · ${service.toolCount} tools` : "Connected",
				);
			case "pending":
				return theme.fg("warning", "Verifying");
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
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			const service = this.filteredServices[this.selectedIndex];
			if (service) this.onSelectCallback(service);
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterServices(this.searchInput.getValue());
		}
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_SERVICES,
			totalItems: this.filteredServices.length,
			reservedRows: SERVICE_LIST_RESERVED_ROWS,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: SCROLL_INDICATOR_ROWS,
		});
	}
}
