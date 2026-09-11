import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Container, type Focusable, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { ModelSelectorComponent } from "./model-selector.js";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./oauth-selector.js";

export const CONFIGURATION_MENU_TABS = ["providers", "models", "mcp-connections"] as const;

export type ConfigurationMenuTab = (typeof CONFIGURATION_MENU_TABS)[number];

export interface ConfigurationMenuScopedModel {
	model: Model<Api>;
	thinkingLevel?: string;
}

export interface ConfigurationMenuOptions {
	initialTab: ConfigurationMenuTab;
	tui: TUI;
	authStorage: AuthStorage;
	providerOptions: ReadonlyArray<AuthSelectorProvider>;
	modelRegistry: ModelRegistry;
	currentModel: Model<Api> | undefined;
	scopedModels: ReadonlyArray<ConfigurationMenuScopedModel>;
	availableModels: ReadonlyArray<Model<Api>>;
	configuredProviders: ReadonlySet<string>;
	recentModels?: ReadonlyArray<string>;
	initialModelSearch?: string;
	thinkingLevel?: ModelThinkingLevel;
	getRows?: () => number;
	requestRender: () => void;
	onSelectProvider: (provider: AuthSelectorProvider) => void;
	onSelectMcpConnection: (provider: AuthSelectorProvider) => void;
	onSelectModel: (model: Model<Api>, thinkingLevel?: ModelThinkingLevel) => void;
	onCancel: () => void;
}

export class ConfigurationMenuComponent extends Container implements Focusable {
	private readonly bodies: {
		providers: OAuthSelectorComponent;
		models: ModelSelectorComponent;
		"mcp-connections": OAuthSelectorComponent;
	};
	private activeTab: ConfigurationMenuTab;
	private _focused = false;
	private busy = false;

	constructor(private readonly options: ConfigurationMenuOptions) {
		super();
		this.activeTab = options.initialTab;
		const getRows = () => Math.max(1, (options.getRows?.() ?? 24) - 1);
		const providerOptions = options.providerOptions.filter(
			(provider) => (provider.category ?? "provider") === "provider",
		);
		const mcpOptions = options.providerOptions.filter((provider) => provider.category === "service");

		const providers = new OAuthSelectorComponent(
			"login",
			options.authStorage,
			providerOptions,
			options.onSelectProvider,
			options.onCancel,
			(providerId) => options.modelRegistry.getProviderAuthStatus(providerId),
			{
				getRows,
				inline: true,
				title: "",
				subtitle: "",
				searchPlaceholder: "Search providers",
			},
		);
		const models = new ModelSelectorComponent(
			options.tui,
			options.currentModel,
			options.modelRegistry,
			options.scopedModels,
			options.onSelectModel,
			options.onCancel,
			options.initialModelSearch,
			{
				availableModels: options.availableModels,
				configuredProviders: options.configuredProviders,
				getRows,
				inline: true,
				recentModels: options.recentModels,
				thinkingLevel: options.thinkingLevel,
			},
		);
		const mcpConnections = new OAuthSelectorComponent(
			"login",
			options.authStorage,
			mcpOptions,
			options.onSelectMcpConnection,
			options.onCancel,
			(providerId) => options.modelRegistry.getProviderAuthStatus(providerId),
			{
				getRows,
				inline: true,
				title: "",
				subtitle: "",
				searchPlaceholder: "Search MCP connections",
				emptyMessage: "No MCP connections. Use /mcp add to configure a server.",
			},
		);

		this.bodies = {
			providers,
			models,
			"mcp-connections": mcpConnections,
		};
		this.addChild(this.activeBody);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.activeBody.focused = value;
	}

	override render(width: number): string[] {
		const selectKey = keyText("tui.select.confirm", { primaryOnly: true });
		const closeKey = keyText("tui.select.cancel", { primaryOnly: true });
		const navigate = `${keyText("tui.select.up", { primaryOnly: true })}/${keyText("tui.select.down", { primaryOnly: true })}`;
		const effort = `${keyText("tui.editor.cursorLeft", { primaryOnly: true })}/${keyText("tui.editor.cursorRight", { primaryOnly: true })}`;
		const hint =
			width >= 70
				? this.activeTab === "models"
					? `${navigate} model · ${effort} effort · ${selectKey} select · ${closeKey} close`
					: `${navigate} navigate · ${selectKey} select · ${closeKey} close`
				: `${selectKey} select · ${closeKey} close`;
		return [...super.render(width), truncateToWidth(theme.fg("dim", ` ${hint}`), width, "", true)];
	}

	getActiveTab(): ConfigurationMenuTab {
		return this.activeTab;
	}

	getSearchValue(tab: ConfigurationMenuTab = this.activeTab): string {
		return this.bodies[tab].getSearchInput().getValue();
	}

	setActiveTab(tab: ConfigurationMenuTab): void {
		if (tab === this.activeTab) return;
		this.activeBody.focused = false;
		this.activeTab = tab;
		this.clear();
		this.addChild(this.activeBody);
		this.activeBody.focused = this._focused;
		this.options.requestRender();
	}

	refreshAuthentication(): void {
		this.bodies.providers.refresh();
		this.bodies["mcp-connections"].refresh();
		this.options.requestRender();
	}

	updateModels(
		currentModel: Model<Api> | undefined,
		models?: ReadonlyArray<Model<Api>>,
		configuredProviders?: ReadonlySet<string>,
	): void {
		this.bodies.models.updateState(currentModel, models, configuredProviders);
	}

	setBusy(busy: boolean): void {
		this.busy = busy;
	}

	handleInput(keyData: string): void {
		if (this.busy) return;
		this.activeBody.handleInput(keyData);
	}

	private get activeBody(): OAuthSelectorComponent | ModelSelectorComponent {
		return this.bodies[this.activeTab];
	}
}
