import { basename, dirname } from "node:path";
import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type Model, resetApiProviders } from "@earendil-works/pi-ai";
import type { AgentSessionMessageController } from "../core/agent-messages.js";
import type { CompactionResult } from "../core/compaction/index.js";
import {
	type ContextUsage,
	type ExtensionActions,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolInfo,
} from "../core/extensions/index.js";
import { emitSessionShutdownEvent } from "../core/extensions/runner.js";
import type { McpManager } from "../core/mcp/mcp-manager.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { PromptTemplate } from "../core/prompt-templates.js";
import type { ResourceExtensionPaths, ResourceLoader } from "../core/resource-loader.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SlashCommandInfo } from "../core/slash-commands.js";

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}
export interface SessionExtensionsHost {
	cwd: string;
	sessionManager: SessionManager;
	resourceLoader: ResourceLoader;
	modelRegistry: ModelRegistry;
	getModelRegistry(): ModelRegistry;
	getPromptTemplates(): ReadonlyArray<PromptTemplate>;
	bindShutdownHandler(handler: ShutdownHandler | undefined): ShutdownHandler | undefined;
	getAgentMessageController(): AgentSessionMessageController | undefined;
	refreshCurrentModel(): void;
	sendCustomMessage(...args: Parameters<ExtensionActions["sendMessage"]>): Promise<void>;
	sendUserMessage(...args: Parameters<ExtensionActions["sendUserMessage"]>): Promise<void>;
	setSessionName(name: string): void;
	getActiveToolNames(): string[];
	getAllTools(): ToolInfo[];
	setActiveToolsByName(names: string[]): void;
	refreshTools(): void;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): ThinkingLevel;
	setThinkingLevel(level: ThinkingLevel): void;
	getModel(): Model<Api> | undefined;
	isStreaming(): boolean;
	getSignal(): AbortSignal | undefined;
	abort(): Promise<void>;
	getQueuedActionCount(): number;
	getContextUsage(): ContextUsage | undefined;
	compact(instructions?: string): Promise<CompactionResult>;
	getSystemPrompt(): string;
	rebuildSystemPrompt(): void;
	reloadSettings(): Promise<void>;
	getMcpManager(): McpManager | undefined;
	rebuildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void;
}
export class SessionExtensions {
	private _extensionRunner!: ExtensionRunner;
	private _execEnvProvider?: () => Record<string, string | undefined> | undefined;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	constructor(
		private readonly host: SessionExtensionsHost,
		private readonly _sessionStartEvent: SessionStartEvent,
		private readonly _extensionRunnerRef?: { current?: ExtensionRunner },
	) {}
	get runner(): ExtensionRunner {
		return this._extensionRunner;
	}
	setExecEnvProvider(provider: (() => Record<string, string | undefined> | undefined) | undefined): void {
		this._execEnvProvider = provider;
		const extensions = this.host.resourceLoader.getExtensions();
		extensions.runtime.getExecEnv = provider;
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = this.host.bindShutdownHandler(bindings.shutdownHandler);
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this.host.cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this.host.resourceLoader.extendResources(extensionPaths);
		this.host.rebuildSystemPrompt();
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: {
			source: string;
			scope: "temporary";
			origin: "top-level";
			baseDir?: string;
		};
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.host.getPromptTemplates().map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this.host.resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.host.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.host.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.host.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: async (name) => {
					const controller = this.host.getAgentMessageController();
					if (controller?.setSessionName) {
						await controller.setSessionName(name);
						return;
					}
					this.host.setSessionName(name);
				},
				getSessionName: () => {
					return this.host.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.host.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.host.getActiveToolNames(),
				getAllTools: () => this.host.getAllTools(),
				setActiveTools: (toolNames) => this.host.setActiveToolsByName(toolNames),
				refreshTools: () => this.host.refreshTools(),
				getCommands,
				setModel: async (model) => {
					if (!this.host.getModelRegistry().hasConfiguredAuth(model)) return false;
					await this.host.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.host.getThinkingLevel(),
				setThinkingLevel: (level) => this.host.setThinkingLevel(level),
			},
			{
				getModel: () => this.host.getModel(),
				isIdle: () => !this.host.isStreaming(),
				getSignal: () => this.host.getSignal(),
				abort: () => this.host.abort(),
				hasPendingMessages: () => this.host.getQueuedActionCount() > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.host.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.host.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.host.getSystemPrompt(),
			},
			{
				registerProvider: (name, config) => {
					this.host.modelRegistry.registerProvider(name, config);
					this.host.refreshCurrentModel();
				},
				unregisterProvider: (name) => {
					this.host.modelRegistry.unregisterProvider(name);
					this.host.refreshCurrentModel();
				},
			},
		);
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, {
			type: "session_shutdown",
			reason: "reload",
		});
		await this.host.reloadSettings();
		// Re-read auth.json: a login saved by the client process (daemon mode) must be
		// visible here so MCP skill gating sees the new credentials.
		this.host.modelRegistry.authStorage.reload();
		resetApiProviders();
		this.host.getMcpManager()?.refresh();
		await this.host.resourceLoader.reload();
		this.host.rebuildRuntime({
			activeToolNames: this.host.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({
				type: "session_start",
				reason: "reload",
			});
			await this.extendResourcesFromExtensions("reload");
		}
	}

	build(flagValues?: Map<string, boolean | string>): void {
		const extensionsResult = this.host.resourceLoader.getExtensions();
		if (flagValues) {
			for (const [name, value] of flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		// Re-apply on (re)build so the provider survives /reload. Guarded: the
		// runtime object can be shared across sessions from one ResourceLoader
		// (RLM children), so a provider-less session must not wipe the owner's.
		if (this._execEnvProvider) {
			extensionsResult.runtime.getExecEnv = this._execEnvProvider;
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this.host.cwd,
			this.host.sessionManager,
			this.host.modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);
	}
}

export function installExtensionToolHooks(
	agent: Pick<Agent, "beforeToolCall" | "afterToolCall">,
	getRunner: () => ExtensionRunner,
	getEventQueue: () => Promise<void>,
): void {
	agent.beforeToolCall = async ({ toolCall, args }) => {
		const runner = getRunner();
		if (!runner.hasHandlers("tool_call")) {
			return undefined;
		}

		await getEventQueue();

		try {
			return await runner.emitToolCall({
				type: "tool_call",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
			});
		} catch (err) {
			if (err instanceof Error) {
				throw err;
			}
			throw new Error(`Extension failed, blocking execution: ${String(err)}`);
		}
	};

	agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
		const runner = getRunner();
		if (!runner.hasHandlers("tool_result")) {
			return undefined;
		}

		const hookResult = await runner.emitToolResult({
			type: "tool_result",
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			input: args as Record<string, unknown>,
			content: result.content,
			details: result.details,
			isError,
		});

		if (!hookResult) {
			return undefined;
		}

		return {
			content: hookResult.content,
			details: hookResult.details,
			isError: hookResult.isError ?? isError,
		};
	};
}
