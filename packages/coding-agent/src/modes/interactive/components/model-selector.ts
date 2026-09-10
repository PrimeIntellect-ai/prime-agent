import { type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	fuzzyMatch,
	getKeybindings,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import {
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
} from "./menu-panel.js";
import { shouldTreatAsBack } from "./modal-back.js";

interface ModelItem {
	provider: string;
	id: string;
	model: Model<any>;
}

interface ScopedModelItem {
	model: Model<any>;
	thinkingLevel?: string;
}

enum ModelSearchMatchQuality {
	ExactShortId,
	ExactFullId,
	PrefixOrToken,
	Fuzzy,
}

interface ModelSearchMatch {
	quality: ModelSearchMatchQuality;
	score: number;
}

function normalizeModelSearchText(value: string): string {
	return value.toLowerCase().replace(/[\s\-_.:/]+/g, "");
}

function getModelSearchFields(item: ModelItem): { shortId: string; fullIds: string[]; all: string[] } {
	const shortId = item.id.slice(item.id.lastIndexOf("/") + 1);
	const fullIds = [item.id, `${item.provider}/${item.id}`];
	return {
		shortId,
		fullIds,
		all: [shortId, ...fullIds, item.model.name, item.provider],
	};
}

function getBestFuzzyScore(queryTokens: string[], fields: string[]): number | null {
	let total = 0;
	for (const token of queryTokens) {
		let best = Number.POSITIVE_INFINITY;
		for (const field of fields) {
			const match = fuzzyMatch(token, field);
			if (match.matches) best = Math.min(best, match.score);
		}
		if (!Number.isFinite(best)) return null;
		total += best;
	}
	return total;
}

function scoreModelSearch(item: ModelItem, query: string): ModelSearchMatch | null {
	const queryTokens = query.trim().split(/\s+/);
	const normalizedQuery = normalizeModelSearchText(query);
	const normalizedTokens = queryTokens.map(normalizeModelSearchText).filter(Boolean);
	if (!normalizedQuery || normalizedTokens.length === 0) return null;

	const fields = getModelSearchFields(item);
	if (normalizeModelSearchText(fields.shortId) === normalizedQuery) {
		return { quality: ModelSearchMatchQuality.ExactShortId, score: 0 };
	}
	if (fields.fullIds.some((field) => normalizeModelSearchText(field) === normalizedQuery)) {
		return { quality: ModelSearchMatchQuality.ExactFullId, score: 0 };
	}

	const normalizedFields = fields.all.map(normalizeModelSearchText);
	const fieldTokens = fields.all
		.flatMap((field) => field.split(/[\s/_-]+/))
		.map(normalizeModelSearchText)
		.filter(Boolean);
	const fuzzyScore = getBestFuzzyScore(normalizedTokens, normalizedFields);
	const isPrefixOrToken = normalizedTokens.every(
		(token) =>
			normalizedFields.some((field) => field.startsWith(token)) ||
			fieldTokens.some((field) => field.startsWith(token)),
	);
	if (isPrefixOrToken && fuzzyScore !== null) {
		return { quality: ModelSearchMatchQuality.PrefixOrToken, score: fuzzyScore };
	}
	return fuzzyScore === null ? null : { quality: ModelSearchMatchQuality.Fuzzy, score: fuzzyScore };
}

export interface ModelSelectorOptions {
	availableModels?: ReadonlyArray<Model<any>>;
	configuredProviders?: ReadonlySet<string>;
	header?: Component;
	getHeaderRows?: () => number;
	subtitle?: string;
	getRows?: () => number;
	recentModels?: ReadonlyArray<string>;
	inline?: boolean;
}

type ModelScope = "all" | "scoped";

const PREFERRED_VISIBLE_MODELS = 10;
const MODEL_LIST_RESERVED_ROWS = {
	base: 7,
	detail: 2,
};
const MODEL_SCROLL_INDICATOR_ROWS = 1;
const MODEL_HELP_MIN_ROWS = 12;
const MODEL_DETAIL_MIN_ROWS = 14;

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private scopedModelItems: ModelItem[] = [];
	private activeModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private searchQuery = "";
	private currentModel?: Model<any>;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>) => void;
	private onCancelCallback: () => void;
	private availableModels?: ReadonlyArray<Model<any>>;
	private configuredProviders?: ReadonlySet<string>;
	private recentRank: Map<string, number>;
	private errorMessage?: string;
	private configuredAuth = new Map<string, boolean>();
	private readonly inline: boolean;
	private renderWidth = 80;
	private tui: TUI;
	private scopedModels: ReadonlyArray<ScopedModelItem>;
	private scope: ModelScope = "all";
	private scopeText?: Text;
	private scopeHintText?: Text;
	private panel: MenuPanel;
	private headerHelpContainer: Container;
	private warningText?: Text;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
		reservedRows: MODEL_LIST_RESERVED_ROWS.base,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private responsiveLayoutKey = "";
	private readonly viewport: MenuViewportProvider;
	private readonly getHeaderRows: () => number;

	constructor(
		tui: TUI,
		currentModel: Model<any> | undefined,
		modelRegistry: ModelRegistry,
		scopedModels: ReadonlyArray<ScopedModelItem>,
		onSelect: (model: Model<any>) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		options: ModelSelectorOptions = {},
	) {
		super();

		this.tui = tui;
		this.inline = options.inline === true;
		this.currentModel = currentModel;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.availableModels = options.availableModels;
		this.configuredProviders = options.configuredProviders;
		this.recentRank = new Map((options.recentModels ?? []).map((key, i) => [key, i]));
		this.viewport = { getRows: options.getRows };
		this.getHeaderRows = options.header ? (options.getHeaderRows ?? (() => 2)) : () => (this.inline ? 1 : 0);

		this.panel = new MenuPanel({
			title: this.inline && options.header ? "" : "Models",
			subtitle: options.subtitle ?? "All models across supported providers.",
			inline: this.inline,
		});
		this.addChild(this.panel);
		if (options.header) {
			this.panel.addChild(options.header);
			if (!this.inline) this.panel.addChild(new Spacer(1));
		}

		// Add hint about model filtering
		if (scopedModels.length > 0) {
			this.scopeText = new Text(this.getScopeText(), 0, 0);
			this.scopeHintText = new Text(this.getScopeHintText(), 0, 0);
		} else {
			const hintText = "Signed-in providers first. Other models prompt sign-in.";
			this.warningText = new Text(theme.fg("muted", hintText), 0, 0);
		}
		this.headerHelpContainer = new Container();
		this.panel.addChild(this.headerHelpContainer);

		// Create search input
		this.searchInput = new MenuSearchInput("Search models", this.inline);
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			this.handleConfirm();
		};
		this.panel.addChild(this.searchInput);

		if (!this.inline) this.panel.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new MenuList({ compact: () => this.listLayout.compact, inline: this.inline });
		this.panel.addChild(this.listContainer);
		this.updateResponsiveLayout();

		this.loadModels();
		if (initialSearchInput) {
			this.filterModels(initialSearchInput);
		} else {
			this.updateList();
		}
		this.tui.requestRender();
	}

	updateAvailableModels(availableModels: ReadonlyArray<Model<any>>): void {
		this.updateState(this.currentModel, availableModels);
	}

	updateState(
		currentModel: Model<any> | undefined,
		availableModels = this.availableModels,
		configuredProviders = this.configuredProviders,
	): void {
		this.currentModel = currentModel;
		this.availableModels = availableModels;
		this.configuredProviders = configuredProviders;
		const query = this.searchInput.getValue();
		const selectedKey = this.getSelectedModelKey();

		this.loadModels();
		this.filterModels(query);

		if (selectedKey) {
			const selectedIndex = this.filteredModels.findIndex((item) => this.getModelKey(item) === selectedKey);
			if (selectedIndex >= 0) {
				this.selectedIndex = selectedIndex;
				this.updateList();
			}
		}

		this.tui.requestRender();
	}

	private loadModels(): void {
		let models: ModelItem[];
		this.errorMessage = undefined;
		this.configuredAuth.clear();

		if (this.availableModels === undefined) {
			this.modelRegistry.refresh();
			const loadError = this.modelRegistry.getError();
			if (loadError) {
				this.errorMessage = loadError;
			}
		}

		// Load available models (built-in models still work even if models.json failed)
		let availableModels: ReadonlyArray<Model<any>>;
		try {
			availableModels =
				this.availableModels !== undefined ? this.availableModels : this.modelRegistry.getAvailable();
			models = availableModels.map((model: Model<any>) => ({
				provider: model.provider,
				id: model.id,
				model,
			}));
		} catch (error) {
			this.allModels = [];
			this.scopedModelItems = [];
			this.activeModels = [];
			this.filteredModels = [];
			this.errorMessage = error instanceof Error ? error.message : String(error);
			return;
		}

		this.allModels = this.sortModels(models);
		const availableModelsById = new Map(availableModels.map((model) => [`${model.provider}/${model.id}`, model]));
		this.scopedModels = this.scopedModels.map((scoped) => {
			const scopedModelId = `${scoped.model.provider}/${scoped.model.id}`;
			const refreshed =
				availableModelsById.get(scopedModelId) ??
				(this.availableModels !== undefined
					? undefined
					: this.modelRegistry.find(scoped.model.provider, scoped.model.id));
			return refreshed ? { ...scoped, model: refreshed } : scoped;
		});
		this.scopedModelItems = this.scopedModels.map((scoped) => ({
			provider: scoped.model.provider,
			id: scoped.model.id,
			model: scoped.model,
		}));
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		this.filteredModels = this.activeModels;
		const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
	}

	private getModelKey(item: ModelItem): string {
		return `${item.provider}/${item.id}`;
	}

	private getSelectedModelKey(): string | undefined {
		const selected = this.filteredModels[this.selectedIndex];
		return selected ? this.getModelKey(selected) : undefined;
	}

	private recentRankOf(item: ModelItem): number {
		// Finite sentinel so subtracting two non-recent ranks yields 0, not NaN.
		return this.recentRank.get(`${item.provider}/${item.id}`) ?? Number.MAX_SAFE_INTEGER;
	}

	private isProviderConfigured(item: ModelItem): boolean {
		const key = this.getModelKey(item);
		let configured = this.configuredAuth.get(key);
		if (configured === undefined) {
			configured = this.configuredProviders?.has(item.provider) || this.modelRegistry.hasConfiguredAuth(item.model);
			this.configuredAuth.set(key, configured);
		}
		return configured;
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		sorted.sort((a, b) => {
			const configuredDiff = Number(this.isProviderConfigured(b)) - Number(this.isProviderConfigured(a));
			if (configuredDiff !== 0) return configuredDiff;
			const aIsCurrent = modelsAreEqual(this.currentModel, a.model);
			const bIsCurrent = modelsAreEqual(this.currentModel, b.model);
			if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
			const rankDiff = this.recentRankOf(a) - this.recentRankOf(b);
			if (rankDiff !== 0) return rankDiff;
			const providerDiff = a.provider.localeCompare(b.provider);
			if (providerDiff !== 0) return providerDiff;
			const aFeatured = a.model.featured === true;
			const bFeatured = b.model.featured === true;
			if (aFeatured !== bFeatured) return aFeatured ? -1 : 1;
			return a.id.localeCompare(b.id, undefined, { numeric: true });
		});
		return sorted;
	}

	private getScopeText(): string {
		const allText = this.scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
		const scopedText = this.scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
		return `${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`;
	}

	private getScopeHintText(): string {
		return keyHint("app.model.toggleScope", "scope") + theme.fg("muted", " (all/scoped)");
	}

	private setScope(scope: ModelScope): void {
		if (this.scope === scope) return;
		this.scope = scope;
		this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;
		const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;
		this.filterModels(this.searchInput.getValue());
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private filterModels(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		if (query.trim()) {
			const matches = this.activeModels.flatMap((item) => {
				const match = scoreModelSearch(item, query);
				return match ? [{ item, ...match }] : [];
			});
			matches.sort(
				(a, b) =>
					a.quality - b.quality ||
					a.score - b.score ||
					Number(this.isProviderConfigured(b.item)) - Number(this.isProviderConfigured(a.item)) ||
					Number(modelsAreEqual(this.currentModel, b.item.model)) -
						Number(modelsAreEqual(this.currentModel, a.item.model)) ||
					this.recentRankOf(a.item) - this.recentRankOf(b.item) ||
					this.getModelKey(a.item).localeCompare(this.getModelKey(b.item), undefined, { numeric: true }),
			);
			this.filteredModels = matches.map(({ item }) => item);
		} else {
			this.filteredModels = this.activeModels;
		}
		this.selectedIndex = queryChanged ? 0 : Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
		this.updateList();
	}

	override render(width: number): string[] {
		this.renderWidth = width;
		const previousLayoutKey = this.responsiveLayoutKey;
		this.updateResponsiveLayout();
		if (this.responsiveLayoutKey !== previousLayoutKey) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.updateResponsiveLayout();
		this.listContainer.clear();

		const maxVisible = this.listLayout.visibleItems;
		const selectedModelIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		const startIndex = Math.max(
			0,
			Math.min(selectedModelIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = modelsAreEqual(this.currentModel, item.model);
			const isConfigured = this.isProviderConfigured(item);
			const meta = isConfigured
				? isCurrent
					? theme.fg("success", "current")
					: undefined
				: theme.fg("warning", isCurrent ? "current · sign in" : "sign in");

			this.listContainer.addChild(
				new MenuRow({
					primary: this.inline ? item.model.name : item.id,
					secondary: item.provider,
					meta: this.inline ? (isCurrent ? "current" : isConfigured ? undefined : "sign in") : meta,
					selected: isSelected,
					inline: this.inline,
				}),
			);
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${selectedModelIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show error message or "no results" if empty
		if (this.errorMessage) {
			// Show error in red
			const errorLines = this.errorMessage.split("\n");
			for (const line of errorLines) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			if (selected && this.inline && this.getInlineDetailRows() > 0) {
				this.listContainer.addChild({
					render: (width) => this.renderInlineModelDetails(selected, width),
					invalidate: () => {},
				});
			} else if (selected && !this.inline && this.shouldShowSelectedDetails()) {
				this.listContainer.addChild(new Spacer(1));
				this.listContainer.addChild(new Text(theme.fg("muted", selected.model.name), 0, 0));
			}
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.model.toggleScope")) {
			if (this.scopedModelItems.length > 0) {
				const nextScope: ModelScope = this.scope === "all" ? "scoped" : "all";
				this.setScope(nextScope);
				if (this.scopeHintText) {
					this.scopeHintText.setText(this.getScopeHintText());
				}
			}
			return;
		}
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			const selectableCount = this.getSelectableCount();
			if (selectableCount === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? selectableCount - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			const selectableCount = this.getSelectableCount();
			if (selectableCount === 0) return;
			this.selectedIndex = this.selectedIndex === selectableCount - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.pageUp") || kb.matches(keyData, "tui.select.pageDown")) {
			const direction = kb.matches(keyData, "tui.select.pageUp") ? -1 : 1;
			this.selectedIndex = Math.max(
				0,
				Math.min(this.filteredModels.length - 1, this.selectedIndex + direction * this.listLayout.visibleItems),
			);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.handleConfirm();
		}
		// Escape / Ctrl+C, or left arrow when the search field is at its start
		else if (kb.matches(keyData, "tui.select.cancel") || shouldTreatAsBack(keyData, this.searchInput)) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			const previousQuery = this.searchInput.getValue();
			this.searchInput.handleInput(keyData);
			if (previousQuery !== this.searchInput.getValue()) this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(model: Model<any>): void {
		this.onSelectCallback(model);
	}

	private handleConfirm(): void {
		const selectedModel = this.filteredModels[this.selectedIndex];
		if (selectedModel) {
			this.handleSelect(selectedModel.model);
			return;
		}
	}

	private getSelectableCount(): number {
		return this.filteredModels.length;
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private updateResponsiveLayout(): void {
		if (this.inline) {
			this.headerHelpContainer.clear();
			const scopeRows = this.scopeText ? 1 : 0;
			if (this.scopeText) {
				this.headerHelpContainer.addChild({
					render: (width) => [
						truncateToWidth(theme.fg("muted", `${this.getScopeText()} · ${this.getScopeHintText()}`), width),
					],
					invalidate: () => {},
				});
			}
			const detailRows = this.getInlineDetailRows();
			this.listLayout = getMenuListLayout({
				getRows: this.viewport.getRows,
				preferredVisibleItems: 8,
				totalItems: this.filteredModels.length,
				reservedRows: this.getHeaderRows() + 3 + scopeRows + detailRows,
				comfortableItemRows: 1,
				comfortableListPaddingRows: 0,
				scrollIndicatorRows: 1,
			});
			this.responsiveLayoutKey = `inline:${this.getHeaderRows()}:${detailRows}:${this.listLayout.visibleItems}`;
			return;
		}
		const showHeaderHelp = this.shouldShowHeaderHelp();
		let headerHelpRows = 0;
		this.headerHelpContainer.clear();
		if (showHeaderHelp) {
			if (this.scopeText && this.scopeHintText) {
				this.headerHelpContainer.addChild(this.scopeText);
				this.headerHelpContainer.addChild(this.scopeHintText);
				headerHelpRows += 2;
			} else if (this.warningText) {
				this.headerHelpContainer.addChild(this.warningText);
				headerHelpRows += 1;
			}
			this.headerHelpContainer.addChild(new Spacer(1));
			headerHelpRows += 1;
		}

		const headerRows = this.getHeaderRows();
		const reservedRows =
			MODEL_LIST_RESERVED_ROWS.base +
			headerRows +
			headerHelpRows +
			(this.shouldShowSelectedDetails() ? MODEL_LIST_RESERVED_ROWS.detail : 0);
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
			totalItems: this.filteredModels.length,
			reservedRows,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: MODEL_SCROLL_INDICATOR_ROWS,
		});
		this.responsiveLayoutKey = [
			headerRows,
			showHeaderHelp ? "help" : "no-help",
			headerHelpRows,
			this.shouldShowSelectedDetails() ? "detail" : "no-detail",
			this.listLayout.compact ? "compact" : "comfortable",
			this.listLayout.visibleItems,
		].join(":");
	}

	private shouldShowHeaderHelp(): boolean {
		return this.hasRows(MODEL_HELP_MIN_ROWS);
	}

	private getInlineDetailRows(): number {
		const detailRows = this.renderWidth >= 58 ? 5 : 6;
		return this.hasRows(this.getHeaderRows() + 5 + (this.scopeText ? 1 : 0) + detailRows) ? detailRows : 0;
	}

	private renderInlineModelDetails(item: ModelItem, width: number): string[] {
		const price = (value: number | undefined) =>
			value !== undefined && Number.isFinite(value) && value >= 0 ? `$${value}` : "—";
		const entries = [
			["Input", price(item.model.cost?.input)],
			["Cached input", price(item.model.cost?.cacheRead)],
			["Output", price(item.model.cost?.output)],
		];
		const lines = ["", theme.fg("muted", `${item.provider} · ${item.id}`)];
		if (width >= 58) {
			const columnWidth = Math.floor((width - 2) / 3);
			const row = (index: number) =>
				entries
					.map((entry) => {
						const text = entry[index] ?? "";
						return text + " ".repeat(Math.max(0, columnWidth - visibleWidth(text)));
					})
					.join("");
			lines.push(theme.fg("muted", row(0)), row(1));
		} else {
			lines.push(...entries.map(([label, value]) => `${theme.fg("muted", `${label}:`)} ${value}`));
		}
		lines.push(theme.fg("dim", "USD / 1M tokens · catalog rates"));
		return lines.map((line) => truncateToWidth(` ${line}`, width, "…", true));
	}

	private shouldShowSelectedDetails(): boolean {
		return this.hasRows(MODEL_DETAIL_MIN_ROWS);
	}

	private hasRows(minRows: number): boolean {
		const rows = this.viewport.getRows?.();
		return rows === undefined || !Number.isFinite(rows) || rows >= minRows;
	}
}
