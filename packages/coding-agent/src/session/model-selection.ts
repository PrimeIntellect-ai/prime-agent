import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Model,
	modelsAreEqual,
	type ServiceTier,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { formatAuthenticationFailedMessage, formatNoApiKeyFoundMessage } from "../core/auth-guidance.js";
import { DEFAULT_THINKING_LEVEL } from "../core/defaults.js";
import type { ExtensionRunner } from "../core/extensions/index.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { THINKING_LEVELS } from "../core/thinking-levels.js";

export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	isScoped: boolean;
}
export interface ModelSelectOptions {
	waitForExtensions?: boolean;
}
export interface ScopedModel {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}
export interface ModelSelectionHost {
	getState(): Pick<AgentState, "model" | "thinkingLevel" | "serviceTier">;
	getRegistry(): Pick<
		ModelRegistry,
		| "getApiKeyAndHeaders"
		| "isUsingOAuth"
		| "hasConfiguredAuth"
		| "getProviderAuthStatus"
		| "canUseModel"
		| "clearProviderAuthStale"
		| "refreshAvailableModels"
		| "find"
	>;
	getExtensions(): Pick<ExtensionRunner, "emit" | "emitError">;
	sessionManager: Pick<SessionManager, "appendModelChange" | "appendThinkingLevelChange" | "appendServiceTierChange">;
	settingsManager: Pick<
		SettingsManager,
		"setDefaultModelAndProvider" | "setDefaultThinkingLevel" | "getDefaultThinkingLevel" | "setDefaultServiceTier"
	>;
	emit(
		event:
			| { type: "thinking_level_changed"; level: ThinkingLevel }
			| { type: "service_tier_changed"; serviceTier: ServiceTier },
	): void;
}

export class SessionModelSelection {
	private _modelSelectEmitQueue: Promise<void> = Promise.resolve();
	private _modelSelectEmitQueueIdle = true;
	private _modelSelectEmitContext = new AsyncLocalStorage<boolean>();
	constructor(
		private readonly host: ModelSelectionHost,
		private _serviceTierPreference: ServiceTier,
		private _scopedModels: ScopedModel[],
	) {}
	get model(): Model<Api> | undefined {
		return this.host.getState().model;
	}
	get thinkingLevel(): ThinkingLevel {
		return this.host.getState().thinkingLevel;
	}
	get serviceTier(): ServiceTier {
		return this.host.getState().serviceTier;
	}
	get scopedModels(): readonly ScopedModel[] {
		return this._scopedModels;
	}
	setScopedModels(models: ScopedModel[]): void {
		this._scopedModels = models;
	}
	async getRequiredRequestAuth(model: Model<Api>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this.host.getRegistry().getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this.host.getRegistry().isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(formatAuthenticationFailedMessage(model.provider));
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _emitModelSelect(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this.host.getExtensions().emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private _queueModelSelectEmit(
		nextModel: Model<Api>,
		previousModel: Model<Api> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		const emit = () =>
			this._modelSelectEmitContext.run(true, () => this._emitModelSelect(nextModel, previousModel, source));
		this._modelSelectEmitQueueIdle = false;
		const promise = this._modelSelectEmitQueue.then(emit, emit);
		const queued = promise.catch(() => {});
		this._modelSelectEmitQueue = queued;
		void queued.finally(() => {
			if (this._modelSelectEmitQueue === queued) {
				this._modelSelectEmitQueueIdle = true;
			}
		});
		return promise;
	}

	async setModel(model: Model<Api>, options: ModelSelectOptions = {}): Promise<void> {
		// Explicit selection recovers from a stale-auth lockout, but only a fully
		// validated switch commits the clear (single owner): failed selections never unlock.
		const staleOnly =
			!this.host.getRegistry().hasConfiguredAuth(model) &&
			this.host.getRegistry().getProviderAuthStatus(model.provider).source === "stale";
		if (!staleOnly && !this.host.getRegistry().hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this.host.getRegistry().canUseModel(model, { assumeAuthConfigured: staleOnly }))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}
		if (staleOnly) {
			this.host.getRegistry().clearProviderAuthStale(model.provider);
			if (!this.host.getRegistry().hasConfiguredAuth(model)) {
				throw new Error(`No API key for ${model.provider}/${model.id}`);
			}
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.host.getState().model = model;
		this.host.sessionManager.appendModelChange(model.provider, model.id);
		this.host.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(model, previousModel, "set");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}
	}

	private _trackModelSelectEmitError(emitPromise: Promise<void>): void {
		void emitPromise.catch((error) => {
			this.host.getExtensions().emitError({
				extensionPath: "<internal>",
				event: "model_select",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	private _shouldWaitForModelSelectEmit(options: ModelSelectOptions): boolean {
		return options.waitForExtensions !== false && !this._modelSelectEmitContext.getStore();
	}

	pendingModelSelectEmit(): Promise<void> | undefined {
		if (!this._modelSelectEmitContext.getStore() && !this._modelSelectEmitQueueIdle) {
			return this._modelSelectEmitQueue;
		}
		return undefined;
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelSelectOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this.host.getRegistry().refreshAvailableModels();
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableModels.some((model) => modelsAreEqual(model, scoped.model)),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
		const serviceTier = this._getServiceTierForModelSwitch();

		this.host.getState().model = next.model;
		this.host.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.host.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(next.model, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this.host.getRegistry().refreshAvailableModels();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.host.getState().model = nextModel;
		this.host.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.host.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(nextModel, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: nextModel,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: false,
		};
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		const previousLevel = this.host.getState().thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.host.getState().thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.host.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.host.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this.host.emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this.host.getExtensions().emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	setServiceTier(serviceTier: ServiceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		const preferenceChanged = effectiveServiceTier !== this._serviceTierPreference;
		const effectiveTierChanged = effectiveServiceTier !== this.host.getState().serviceTier;
		if (!preferenceChanged && !effectiveTierChanged) {
			return;
		}
		this._serviceTierPreference = effectiveServiceTier;
		if (preferenceChanged) {
			this.host.sessionManager.appendServiceTierChange(effectiveServiceTier);
			if (this.model && supportsFastMode(this.model)) {
				this.host.settingsManager.setDefaultServiceTier(effectiveServiceTier);
			}
		}
		if (effectiveTierChanged) {
			this.host.getState().serviceTier = effectiveServiceTier;
			this.host.emit({
				type: "service_tier_changed",
				serviceTier: effectiveServiceTier,
			});
		}
	}

	private _getEffectiveServiceTier(serviceTier: ServiceTier): ServiceTier {
		return serviceTier === "priority" && (!this.model || !supportsFastMode(this.model)) ? "default" : serviceTier;
	}

	private _getServiceTierForModelSwitch(): ServiceTier {
		return this._serviceTierPreference;
	}

	private _clampServiceTierForModel(serviceTier: ServiceTier = this.serviceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		if (effectiveServiceTier === this.host.getState().serviceTier) {
			return;
		}
		this.host.getState().serviceTier = effectiveServiceTier;
		this.host.emit({
			type: "service_tier_changed",
			serviceTier: effectiveServiceTier,
		});
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.host.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this.host.getRegistry().find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.host.getState().model = refreshedModel;
	}
}
