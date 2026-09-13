import {
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	type ModelThinkingLevel,
	modelsAreEqual,
} from "@earendil-works/pi-ai";
import { getOAuthProviders } from "@earendil-works/pi-ai/oauth";
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
import { PRIME_INFERENCE_PROVIDER_ID } from "../../../core/prime-inference-auth.js";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../../core/provider-display-names.js";
import { theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";
import {
	getInlineTrailingWidth,
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

interface ProviderItem {
	id: string;
	name: string;
	modelCount: number;
	configured: boolean;
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
	thinkingLevel?: ModelThinkingLevel;
}

type ModelScope = "all" | "scoped";

const PREFERRED_VISIBLE_MODELS = 10;
const MODEL_LIST_RESERVED_ROWS = {
	base: 4,
	detail: 2,
};
const MODEL_SCROLL_INDICATOR_ROWS = 1;
const MODEL_HELP_MIN_ROWS = 12;
const MODEL_DETAIL_MIN_ROWS = 14;
const EFFORT_NAME_COLUMN_MAX = 30;
const EFFORT_NAME_COLUMN_MIN = 12;
const PRICE_UNIT_TEXT = "$ / 1M tokens";
/** Wide detail columns must still fit the longest label, "Cached input". */
const PRICE_COLUMN_MIN_WIDTH = 13;

interface EffortLayout {
	nameColumn: number;
	squareSlots: number;
	gap: number;
	labelWidth: number;
	showLabel: boolean;
	showCluster: boolean;
}

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
	private filteredProviders: ProviderItem[] = [];
	private step: "providers" | "models" = "providers";
	private selectedProvider?: string;
	private providerSearchQuery = "";
	private selectedIndex: number = 0;
	private searchQuery = "";
	private currentModel?: Model<any>;
	private modelRegistry: ModelRegistry;
	private onSelectCallback: (model: Model<any>, thinkingLevel?: ModelThinkingLevel) => void;
	private onCancelCallback: () => void;
	private availableModels?: ReadonlyArray<Model<any>>;
	private configuredProviders?: ReadonlySet<string>;
	private recentRank: Map<string, number>;
	private errorMessage?: string;
	private configuredAuth = new Map<string, boolean>();
	private readonly effortLevels = new Map<string, ModelThinkingLevel>();
	private readonly editedEffortModels = new Set<string>();
	private initialThinkingLevel?: ModelThinkingLevel;
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
		onSelect: (model: Model<any>, thinkingLevel?: ModelThinkingLevel) => void,
		onCancel: () => void,
		initialSearchInput?: string,
		options: ModelSelectorOptions = {},
	) {
		super();

		this.tui = tui;
		this.inline = options.inline === true;
		this.step = initialSearchInput ? "models" : "providers";
		this.currentModel = currentModel;
		this.modelRegistry = modelRegistry;
		this.scopedModels = scopedModels;
		this.scope = scopedModels.length > 0 ? "scoped" : "all";
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.availableModels = options.availableModels;
		this.configuredProviders = options.configuredProviders;
		this.initialThinkingLevel = options.thinkingLevel;
		this.recentRank = new Map((options.recentModels ?? []).map((key, i) => [key, i]));
		this.viewport = { getRows: options.getRows };
		this.getHeaderRows = options.header ? (options.getHeaderRows ?? (() => 2)) : () => 0;

		this.panel = new MenuPanel({
			title: "",
			subtitle: options.subtitle,
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
		this.searchInput = this.createSearchInput(initialSearchInput ?? "");
		this.panel.addChild(this.searchInput);

		if (!this.inline) this.panel.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new MenuList({ compact: () => this.listLayout.compact, inline: this.inline });
		this.panel.addChild(this.listContainer);
		this.updateResponsiveLayout();

		this.loadModels();
		this.filterModels(initialSearchInput ?? "");
		if (!initialSearchInput?.trim()) this.selectCurrentItem();
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
		const selectedKey = this.getSelectedItemKey();

		this.loadModels();
		this.filterModels(query);

		if (selectedKey) {
			const selectedIndex =
				this.step === "providers"
					? this.filteredProviders.findIndex((item) => item.id === selectedKey)
					: this.filteredModels.findIndex((item) => this.getModelKey(item) === selectedKey);
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
	}

	private getModelKey(item: ModelItem): string {
		return `${item.provider}/${item.id}`;
	}

	private getSelectedItemKey(): string | undefined {
		if (this.step === "providers") return this.filteredProviders[this.selectedIndex]?.id;
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

	private isPinnedProvider(item: ModelItem): boolean {
		return item.provider === PRIME_INFERENCE_PROVIDER_ID && this.isProviderConfigured(item);
	}

	private getSelectableLevels(item: ModelItem): ModelThinkingLevel[] {
		const levels = getSupportedThinkingLevels(item.model);
		if (levels.length === 1 && levels[0] === "off") return [];
		return levels;
	}

	private getEffort(item: ModelItem): ModelThinkingLevel | undefined {
		const levels = this.getSelectableLevels(item);
		if (levels.length === 0) return undefined;
		const key = this.getModelKey(item);
		const stored = this.effortLevels.get(key);
		if (stored !== undefined && levels.includes(stored)) return stored;
		const initial = this.initialThinkingLevel ?? "off";
		const level = levels.includes(initial) ? initial : clampThinkingLevel(item.model, initial);
		const resolved = levels.includes(level) ? level : levels[0]!;
		this.effortLevels.set(key, resolved);
		return resolved;
	}

	private adjustEffort(item: ModelItem, direction: number): boolean {
		const levels = this.getSelectableLevels(item);
		if (levels.length === 0) return false;
		const current = this.getEffort(item) ?? levels[0]!;
		const index = levels.indexOf(current);
		const next = levels[(index + direction + levels.length) % levels.length]!;
		this.effortLevels.set(this.getModelKey(item), next);
		this.editedEffortModels.add(this.getModelKey(item));
		return true;
	}

	private getTrailingSegments(item: ModelItem, isCurrent: boolean, isConfigured: boolean): string[] {
		const segments: string[] = [];
		if (isCurrent) segments.push("current");
		if (!isConfigured) segments.push("require sign in");
		segments.push(item.provider);
		return segments;
	}

	private getEffortLayout(startIndex: number, endIndex: number): EffortLayout {
		const empty: EffortLayout = {
			nameColumn: 0,
			squareSlots: 0,
			gap: 0,
			labelWidth: 0,
			showLabel: false,
			showCluster: false,
		};
		const reasoningItems: ModelItem[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (item && this.getSelectableLevels(item).length > 0) reasoningItems.push(item);
		}
		if (reasoningItems.length === 0) return empty;

		const width = this.renderWidth;
		let maxTrailingWidth = 0;
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;
			const segments = this.getTrailingSegments(
				item,
				modelsAreEqual(this.currentModel, item.model),
				this.isProviderConfigured(item),
			);
			maxTrailingWidth = Math.max(maxTrailingWidth, getInlineTrailingWidth(segments, width));
		}
		const available = Math.max(1, width - 2 - maxTrailingWidth - 2);

		const maxNameColumn = Math.min(
			Math.max(...reasoningItems.map((item) => visibleWidth(item.model.name))),
			EFFORT_NAME_COLUMN_MAX,
		);
		const squareSlots = Math.max(
			...reasoningItems.map((item) => this.getSelectableLevels(item).filter((level) => level !== "off").length),
		);
		const clusterWidth = squareSlots;
		// Fixed label cell sized to the longest supported level name, so changing
		// the selected level never changes the cluster span or its centered gap.
		const labelWidth = Math.max(
			...reasoningItems.flatMap((item) => this.getSelectableLevels(item).map((level) => visibleWidth(level))),
		);
		// Arrow slots and the spaces around the squares and label. The ladder
		// keeps one of those columns as the gap after the name cell, shrinks the
		// name column next, and only then drops the label or the whole cluster,
		// so rows stay aligned at every width.
		const arrowsAndGaps = 6;
		// Sit the cluster near the row's horizontal center, clamped between the
		// name column and the trailing zone.
		const place = (nameColumn: number, showLabel: boolean): EffortLayout => {
			const span = clusterWidth + (showLabel ? labelWidth + 5 : 4);
			const desired = Math.floor(width / 2 - span / 2) - 2 - nameColumn;
			const gap = Math.max(1, Math.min(desired, available - nameColumn - span));
			return { nameColumn, squareSlots, gap, labelWidth, showLabel, showCluster: true };
		};
		if (maxNameColumn + clusterWidth + labelWidth + arrowsAndGaps <= available) {
			return place(maxNameColumn, true);
		}
		const labelNameColumn = available - clusterWidth - labelWidth - arrowsAndGaps;
		if (labelNameColumn >= EFFORT_NAME_COLUMN_MIN) {
			return place(Math.min(maxNameColumn, labelNameColumn), true);
		}
		if (maxNameColumn + clusterWidth + arrowsAndGaps <= available) {
			return place(maxNameColumn, false);
		}
		const clusterNameColumn = available - clusterWidth - arrowsAndGaps;
		if (clusterNameColumn >= EFFORT_NAME_COLUMN_MIN) {
			return place(Math.min(maxNameColumn, clusterNameColumn), false);
		}
		return empty;
	}

	private renderEffortSquares(
		levels: ModelThinkingLevel[],
		effort: ModelThinkingLevel | undefined,
		squareSlots: number,
		selected: boolean,
	): string {
		const onLevels = levels.filter((level) => level !== "off");
		if (onLevels.length === 0) return "";
		const filledColor = selected ? theme.getEffortSquareColor() : (glyph: string) => theme.fg("muted", glyph);
		const filled = effort === undefined || effort === "off" ? 0 : onLevels.indexOf(effort) + 1;
		const squares = onLevels.map((_, index) => (index < filled ? filledColor("■") : theme.fg("dim", "□")));
		// The glyphs carry their own cell padding, so render them edge to edge.
		const marks = squares.join("");
		return marks + " ".repeat(Math.max(0, squareSlots - visibleWidth(marks)));
	}

	private sortModels(models: ModelItem[]): ModelItem[] {
		const sorted = [...models];
		sorted.sort((a, b) => {
			const configuredDiff = Number(this.isProviderConfigured(b)) - Number(this.isProviderConfigured(a));
			if (configuredDiff !== 0) return configuredDiff;
			const pinnedDiff = Number(this.isPinnedProvider(b)) - Number(this.isPinnedProvider(a));
			if (pinnedDiff !== 0) return pinnedDiff;
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
		this.selectedIndex = 0;
		this.filterModels(this.searchInput.getValue());
		if (!this.searchInput.getValue().trim()) this.selectCurrentItem();
		if (this.scopeText) {
			this.scopeText.setText(this.getScopeText());
		}
	}

	private getProviderName(provider: string): string {
		return (
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			getOAuthProviders().find((item) => item.id === provider)?.name ??
			provider
		);
	}

	private createSearchInput(query: string): MenuSearchInput {
		const placeholder =
			this.step === "providers"
				? "Search providers"
				: this.selectedProvider
					? `Search ${this.getProviderName(this.selectedProvider)} models`
					: "Search models";
		const input = new MenuSearchInput(placeholder, this.inline);
		input.setValue(query);
		input.focused = this.focused;
		input.onSubmit = () => this.handleConfirm();
		return input;
	}

	private replaceSearchInput(query: string): void {
		const index = this.panel.children.indexOf(this.searchInput);
		this.searchInput = this.createSearchInput(query);
		this.panel.children[index] = this.searchInput;
	}

	private selectCurrentItem(): void {
		const index =
			this.step === "providers"
				? this.filteredProviders.findIndex((item) => item.id === this.currentModel?.provider)
				: this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));
		this.selectedIndex = index >= 0 ? index : 0;
		this.updateList();
	}

	private showProviders(): void {
		const provider = this.selectedProvider ?? this.filteredModels[this.selectedIndex]?.provider;
		this.step = "providers";
		this.selectedProvider = undefined;
		this.replaceSearchInput(this.providerSearchQuery);
		this.selectedIndex = 0;
		this.filterModels(this.providerSearchQuery);
		const index = this.filteredProviders.findIndex((item) => item.id === provider);
		if (index >= 0) this.selectedIndex = index;
		this.updateList();
		this.tui.requestRender();
	}

	private filterProviders(query: string): void {
		const providers = new Map<string, ProviderItem>();
		for (const item of this.sortModels(this.activeModels)) {
			const existing = providers.get(item.provider);
			if (existing) {
				existing.modelCount++;
				existing.configured ||= this.isProviderConfigured(item);
			} else {
				providers.set(item.provider, {
					id: item.provider,
					name: this.getProviderName(item.provider),
					modelCount: 1,
					configured: this.isProviderConfigured(item),
				});
			}
		}
		const tokens = query.trim().split(/\s+/).map(normalizeModelSearchText).filter(Boolean);
		this.filteredProviders = [...providers.values()].filter(
			(item) =>
				tokens.length === 0 ||
				getBestFuzzyScore(tokens, [item.id, item.name].map(normalizeModelSearchText)) !== null,
		);
	}

	private updateProviderList(): void {
		const count = this.filteredProviders.length;
		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), count - maxVisible));
		const endIndex = Math.min(startIndex + maxVisible, count);
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredProviders[i]!;
			const status = [
				...(item.id === this.currentModel?.provider ? ["current"] : []),
				item.configured ? "signed in" : "require sign in",
			];
			const modelCount = `${item.modelCount} ${item.modelCount === 1 ? "model" : "models"}`;
			this.listContainer.addChild(
				new MenuRow({
					primary: item.name,
					secondary: this.inline ? undefined : `${item.id} · ${modelCount}`,
					meta: this.inline ? undefined : status.join(" · "),
					trailing: this.inline ? [...status, modelCount] : undefined,
					selected: i === this.selectedIndex,
					inline: this.inline,
				}),
			);
		}
		if (startIndex > 0 || endIndex < count) {
			this.listContainer.addChild(new Text(theme.fg("muted", `  (${this.selectedIndex + 1}/${count})`), 0, 0));
		}
		if (this.errorMessage) {
			for (const line of this.errorMessage.split("\n")) {
				this.listContainer.addChild(new Text(theme.fg("error", line), 0, 0));
			}
		} else if (count === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "No matching providers"), 0, 0));
		}
	}

	private filterModels(query: string): void {
		const queryChanged = query !== this.searchQuery;
		this.searchQuery = query;
		if (this.step === "providers") {
			this.filterProviders(query);
			this.filteredModels = [];
			this.selectedIndex = queryChanged
				? 0
				: Math.min(this.selectedIndex, Math.max(0, this.getSelectableCount() - 1));
			this.updateList();
			return;
		}
		const models = this.selectedProvider
			? this.activeModels.filter((item) => item.provider === this.selectedProvider)
			: this.activeModels;
		if (query.trim()) {
			const matches = models.flatMap((item) => {
				const match = scoreModelSearch(item, query);
				return match ? [{ item, ...match }] : [];
			});
			matches.sort(
				(a, b) =>
					Number(this.isProviderConfigured(b.item)) - Number(this.isProviderConfigured(a.item)) ||
					Number(this.isPinnedProvider(b.item)) - Number(this.isPinnedProvider(a.item)) ||
					a.quality - b.quality ||
					a.score - b.score ||
					Number(modelsAreEqual(this.currentModel, b.item.model)) -
						Number(modelsAreEqual(this.currentModel, a.item.model)) ||
					this.recentRankOf(a.item) - this.recentRankOf(b.item) ||
					this.getModelKey(a.item).localeCompare(this.getModelKey(b.item), undefined, { numeric: true }),
			);
			this.filteredModels = matches.map(({ item }) => item);
		} else {
			this.filteredModels = models;
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
		if (this.step === "providers") {
			this.updateProviderList();
			return;
		}

		const maxVisible = this.listLayout.visibleItems;
		const selectedModelIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		const startIndex = Math.max(
			0,
			Math.min(selectedModelIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		const effortLayout = this.inline
			? this.getEffortLayout(startIndex, endIndex)
			: { nameColumn: 0, squareSlots: 0, gap: 0, labelWidth: 0, showLabel: false, showCluster: false };

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
				: theme.fg("warning", isCurrent ? "current · require sign in" : "require sign in");
			const inlineSegments = this.getTrailingSegments(item, isCurrent, isConfigured);
			let primary = this.inline ? item.model.name : item.id;
			if (this.inline && effortLayout.showCluster) {
				const levels = this.getSelectableLevels(item);
				const effort = this.getEffort(item);
				if (levels.length > 0 && effort !== undefined) {
					const nameCell = truncateToWidth(item.model.name, effortLayout.nameColumn, "…", true);
					const gap = " ".repeat(effortLayout.gap);
					const leftArrow = isSelected ? theme.fg("dim", "←") : " ";
					const rightArrow = isSelected ? theme.fg("dim", "→") : " ";
					const squares = this.renderEffortSquares(levels, effort, effortLayout.squareSlots, isSelected);
					const label = effortLayout.showLabel ? theme.fg("muted", effort.padEnd(effortLayout.labelWidth)) : "";
					primary = label
						? `${nameCell}${gap}${leftArrow} ${squares} ${rightArrow} ${label}`
						: `${nameCell}${gap}${leftArrow} ${squares} ${rightArrow}`;
				}
			}

			this.listContainer.addChild(
				new MenuRow({
					primary,
					secondary: this.inline ? undefined : item.provider,
					meta: this.inline ? undefined : meta,
					trailing: this.inline ? inlineSegments : undefined,
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
		// Keep arrows available for editing a filter; an empty filter controls effort.
		if (
			this.step === "models" &&
			this.searchInput.getValue() === "" &&
			(kb.matches(keyData, "tui.editor.cursorLeft") || kb.matches(keyData, "tui.editor.cursorRight"))
		) {
			const direction = kb.matches(keyData, "tui.editor.cursorLeft") ? -1 : 1;
			const selected = this.filteredModels[this.selectedIndex];
			if (selected && this.adjustEffort(selected, direction)) {
				this.updateList();
				this.tui.requestRender();
				return;
			}
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
				Math.min(this.getSelectableCount() - 1, this.selectedIndex + direction * this.listLayout.visibleItems),
			);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			this.handleConfirm();
		}
		// Escape / Ctrl+C, or left arrow when the search field is at its start
		else if (kb.matches(keyData, "tui.select.cancel") || shouldTreatAsBack(keyData, this.searchInput)) {
			if (this.step === "models") this.showProviders();
			else this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			const previousQuery = this.searchInput.getValue();
			this.searchInput.handleInput(keyData);
			if (previousQuery !== this.searchInput.getValue()) this.filterModels(this.searchInput.getValue());
		}
	}

	private handleConfirm(): void {
		if (this.step === "providers") {
			const provider = this.filteredProviders[this.selectedIndex];
			if (!provider) return;
			this.providerSearchQuery = this.searchInput.getValue();
			this.selectedProvider = provider.id;
			this.step = "models";
			this.replaceSearchInput("");
			this.selectedIndex = 0;
			this.filterModels("");
			this.selectCurrentItem();
			this.tui.requestRender();
			return;
		}
		const selectedModel = this.filteredModels[this.selectedIndex];
		if (selectedModel) {
			const effort = this.editedEffortModels.has(this.getModelKey(selectedModel))
				? this.getEffort(selectedModel)
				: undefined;
			this.onSelectCallback(selectedModel.model, effort);
			return;
		}
	}

	private getSelectableCount(): number {
		return this.step === "providers" ? this.filteredProviders.length : this.filteredModels.length;
	}

	isSelectingProvider(): boolean {
		return this.step === "providers";
	}

	getSearchInput(): MenuSearchInput {
		return this.searchInput;
	}

	private updateResponsiveLayout(): void {
		this.panel.setTitle(
			this.step === "providers"
				? "Choose provider"
				: this.selectedProvider
					? `${this.getProviderName(this.selectedProvider)} models`
					: "Search all models",
		);
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
				totalItems: this.getSelectableCount(),
				reservedRows: this.getHeaderRows() + 4 + scopeRows + detailRows,
				comfortableItemRows: 1,
				comfortableListPaddingRows: 0,
				scrollIndicatorRows: 1,
			});
			this.responsiveLayoutKey = `inline:${this.getHeaderRows()}:${detailRows}:${this.listLayout.visibleItems}:${this.renderWidth}`;
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
			2 +
			headerRows +
			headerHelpRows +
			(this.shouldShowSelectedDetails() ? MODEL_LIST_RESERVED_ROWS.detail : 0);
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_MODELS,
			totalItems: this.getSelectableCount(),
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
		if (this.step === "providers" || this.filteredModels.length === 0) return 0;
		const detailRows = this.renderWidth >= 58 ? 4 : 5;
		return this.hasRows(this.getHeaderRows() + 6 + (this.scopeText ? 1 : 0) + detailRows) ? detailRows : 0;
	}

	private renderInlineModelDetails(item: ModelItem, width: number): string[] {
		const price = (value: number | undefined) => {
			if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
			if (value === 0) return "$0";
			const rounded = Math.round(value * 1000) / 1000;
			return rounded === 0 ? "<0.001" : `$${rounded}`;
		};
		const entries = [
			["Input", price(item.model.cost?.input)],
			["Cached input", price(item.model.cost?.cacheRead)],
			["Output", price(item.model.cost?.output)],
		];
		const unit = theme.fg("muted", PRICE_UNIT_TEXT);
		const lines = [""];
		if (width >= 58) {
			// Shrink the columns so the unit can trail the Output column.
			const columnWidth = Math.max(
				PRICE_COLUMN_MIN_WIDTH,
				Math.floor((width - 2 - (visibleWidth(PRICE_UNIT_TEXT) + 1)) / 3),
			);
			const row = (index: number) =>
				entries
					.map((entry) => {
						const text = entry[index] ?? "";
						return text + " ".repeat(Math.max(0, columnWidth - visibleWidth(text)));
					})
					.join("");
			lines.push(`${theme.fg("muted", row(0))} ${unit}`, row(1));
		} else {
			lines.push(
				...entries.map(([label, value], index) => {
					const suffix = index === entries.length - 1 ? ` ${unit}` : "";
					return `${theme.fg("muted", `${label}:`)} ${value}${suffix}`;
				}),
			);
		}
		lines.push("");
		return lines.map((line) => truncateToWidth(` ${line}`, width, "…", true));
	}

	private shouldShowSelectedDetails(): boolean {
		return this.step === "models" && this.filteredModels.length > 0 && this.hasRows(MODEL_DETAIL_MIN_ROWS + 2);
	}

	private hasRows(minRows: number): boolean {
		const rows = this.viewport.getRows?.();
		return rows === undefined || !Number.isFinite(rows) || rows >= minRows;
	}
}
