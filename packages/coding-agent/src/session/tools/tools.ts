import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type ExtensionRunner,
	type ToolDefinition,
	type ToolInfo,
	wrapRegisteredTools,
} from "../../core/extensions/index.js";
import type { AcpMcpServerConfig } from "../../core/mcp/acp-mcp-types.js";
import type { McpManager } from "../../core/mcp/mcp-manager.js";
import type { ResourceLoader } from "../../core/resource-loader.js";
import type { Skill } from "../../core/skills.js";
import { createSyntheticSourceInfo, type SourceInfo } from "../../core/source-info.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../../core/system-prompt.js";
import { acpMcpToolNames, createAcpMcpToolDefinitions } from "../../core/tools/acp-mcp.js";
import type { IpythonKernelProvisioner } from "../../core/tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "../../core/tools/tool-definition-wrapper.js";

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}
export interface SessionToolsHost {
	cwd: string;
	resourceLoader: Pick<ResourceLoader, "getSystemPrompt" | "getAppendSystemPrompt" | "getAgentsFiles">;
	getExtensionRunner(): ExtensionRunner;
	getSessionFile(): string | undefined;
	getModelVisibleSkills(): Skill[];
	getDepth(): number;
	getMaxDepth(): number;
	getParentAgent(): string | undefined;
	getMcpManager():
		| Pick<
				McpManager,
				"getAcpServers" | "getEnabledPersistentGenericServers" | "replaceAcpServers" | "canReleaseAcpServers"
		  >
		| undefined;
	getProvisioner(): IpythonKernelProvisioner | undefined;
	getActiveToolNames(): string[];
	setActiveToolsByName(names: string[]): void;
	getActiveTools(): AgentTool[];
	setActiveTools(tools: AgentTool[]): void;
	setSystemPrompt(prompt: string): void;
	isStreaming(): boolean;
	rebuildRuntime(options: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void;
	acquireInputPause(): { release(): void };
	waitForAgentIdle(): Promise<void>;
	getEventQueue(): Promise<void>;
}

export class SessionTools {
	private _toolRegistry = new Map<string, AgentTool>();
	private _toolDefinitions = new Map<string, ToolDefinitionEntry>();
	private _toolPromptSnippets = new Map<string, string>();
	private _toolPromptGuidelines = new Map<string, string[]>();
	private _baseToolDefinitions = new Map<string, ToolDefinition>();
	private _acpMcpTools: ToolDefinition[] = [];
	readonly customTools: ToolDefinition[];
	private readonly baseToolsOverride?: Record<string, AgentTool>;
	readonly allowedToolNames?: Set<string>;
	baseSystemPrompt = "";
	baseSystemPromptOptions!: BuildSystemPromptOptions;
	constructor(
		private readonly host: SessionToolsHost,
		config: {
			customTools?: ToolDefinition[];
			allowedToolNames?: string[];
			baseToolsOverride?: Record<string, AgentTool>;
		},
	) {
		this.customTools = config.customTools ?? [];
		this.baseToolsOverride = config.baseToolsOverride;
		this.allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
	}
	get registry(): ReadonlyMap<string, AgentTool> {
		return this._toolRegistry;
	}
	get defaultActiveToolNames(): string[] {
		return this.baseToolsOverride ? Object.keys(this.baseToolsOverride) : ["ipython"];
	}
	buildBaseOverrides(): Record<string, ToolDefinition> | undefined {
		return this.baseToolsOverride
			? Object.fromEntries(
					Object.entries(this.baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: undefined;
	}
	setBaseDefinitions(definitions: Record<string, ToolDefinition>): void {
		this._baseToolDefinitions = new Map(Object.entries(definitions));
	}
	updateAcpDefinitions(): void {
		const previousAcpMcpToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const acpServers = this.host.getMcpManager()?.getAcpServers() ?? [];
		const provisioner = this.host.getProvisioner();
		if (acpServers.length > 0 && !provisioner) throw new Error("ACP MCP servers require the built-in cpython tool");
		const acpMcpTools = provisioner ? createAcpMcpToolDefinitions(acpServers, provisioner) : [];
		this._assertAcpMcpToolNamesAvailable(acpMcpTools.map((tool) => tool.name));
		for (const name of previousAcpMcpToolNames) this.allowedToolNames?.delete(name);
		for (const tool of acpMcpTools) this.allowedToolNames?.add(tool.name);
		this._acpMcpTools = acpMcpTools;
	}
	getActiveToolNames(): string[] {
		return this.host.getActiveTools().map((t) => t.name);
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seenToolNames = new Set<string>();
		for (const name of toolNames) {
			if (seenToolNames.has(name)) {
				continue;
			}
			const tool = this._toolRegistry.get(name);
			if (tool) {
				seenToolNames.add(name);
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.host.setActiveTools(tools);

		this.baseSystemPrompt = this.rebuildSystemPrompt(validToolNames);
		this.host.setSystemPrompt(this.baseSystemPrompt);
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this.host.resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this.host.resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const loadedSkills = this.host.getModelVisibleSkills();
		const loadedContextFiles = this.host.resourceLoader.getAgentsFiles().agentsFiles;

		this.baseSystemPromptOptions = {
			cwd: this.host.cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			messagesPath: this.host.getSessionFile(),
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			allowRecursion: this.host.getDepth() < this.host.getMaxDepth(),
			rlmDepth: this.host.getDepth(),
			rlmParentAgent: this.host.getParentAgent(),
			genericMcpServers: this.host.getMcpManager()?.getEnabledPersistentGenericServers(),
		};
		return buildSystemPrompt(this.baseSystemPromptOptions);
	}

	refreshExtensionSystemPrompt(extensionPrompt: string, baseSnapshot: string): string {
		if (this.baseSystemPrompt === baseSnapshot) {
			return extensionPrompt;
		}
		if (!extensionPrompt.includes(baseSnapshot)) {
			return extensionPrompt;
		}
		return extensionPrompt.replace(baseSnapshot, () => this.baseSystemPrompt);
	}

	refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.host.getActiveToolNames();
		const allowedToolNames = this.allowedToolNames;
		const registeredTools = this.host.getExtensionRunner().getAllRegisteredTools();
		const sdkToolEntry = (definition: ToolDefinition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
				source: "sdk" as const,
			}),
		});
		const allCustomTools = [
			...registeredTools,
			...this.customTools.map(sdkToolEntry),
			...this._acpMcpTools.map(sdkToolEntry),
		];
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
		const allowedCustomTools = allCustomTools.filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, {
							source: "builtin",
						}),
					},
				]),
		);
		for (const tool of allowedCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this.host.getExtensionRunner();
		const wrappedExtensionTools = wrapRegisteredTools(allowedCustomTools, runner);
		// Resolve the runner at call time so a rebuild/reload rebinds built-in tools to the
		// live runner instead of wedging them on the invalidated one's stale-ctx guard.
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			() => this.host.getExtensionRunner(),
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.host.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	replaceAcpMcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): void {
		if (this.host.isStreaming()) throw new Error("Cannot replace ACP MCP servers while the agent is running");
		const mcpManager = this.host.getMcpManager();
		if (!mcpManager) {
			if (servers.length > 0) throw new Error("MCP is unavailable in this session");
			return;
		}
		if (servers.length > 0 && !this.host.getProvisioner()) {
			throw new Error("ACP MCP servers require the built-in cpython tool");
		}
		this._assertAcpMcpToolNamesAvailable(acpMcpToolNames(servers));
		if (!mcpManager.replaceAcpServers(servers, ownerId)) return;
		this._rebuildRuntimeForAcpMcpServers();
	}

	async releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void> {
		const mcpManager = this.host.getMcpManager();
		if (!mcpManager?.canReleaseAcpServers(ownerId)) return;
		if (mcpManager.replaceAcpServers([], ownerId)) {
			const removedToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
			const activeToolNames = this.host.getActiveToolNames().filter((name) => !removedToolNames.has(name));
			for (const name of removedToolNames) this.allowedToolNames?.delete(name);
			this._acpMcpTools = [];
			this.refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
			this.baseSystemPrompt = this.rebuildSystemPrompt(this.host.getActiveToolNames());
			this.host.setSystemPrompt(this.baseSystemPrompt);
		}
		const names = [...new Set(serverNames)];
		if (names.length === 0) return;

		const inputPause = this.host.acquireInputPause();
		try {
			// Do not rebuild or kill the notebook. Wait for the current turn, then ask
			// the kernel-owned MCP registry to close only these cached transports.
			await this.host.waitForAgentIdle();
			await this.host.getEventQueue();
			const manager = this.host.getProvisioner()?.manager;
			if (!manager?.isRunning) return;
			const code = [
				"import importlib as _prime_importlib",
				'_prime_mcp = _prime_importlib.import_module("rlm.mcp")',
				`_prime_mcp_names = ${JSON.stringify(names)}`,
				"_prime_mcp_errors = []",
				"for _prime_mcp_name in _prime_mcp_names:",
				"    try:",
				"        await _prime_mcp.reload(_prime_mcp_name)",
				"    except BaseException as _prime_mcp_error:",
				"        _prime_mcp_errors.append(_prime_mcp_error)",
				"if _prime_mcp_errors:",
				"    raise _prime_mcp_errors[0]",
				"del _prime_mcp, _prime_importlib, _prime_mcp_names, _prime_mcp_errors, _prime_mcp_name",
			].join("\n");
			const result = await manager.execute(code);
			if (result.status !== "ok") {
				throw new Error(`Failed to close ACP MCP kernel transports: ${result.stderr || "kernel error"}`);
			}
		} finally {
			inputPause.release();
		}
	}

	private _assertAcpMcpToolNamesAvailable(names: readonly string[]): void {
		const occupiedNames = new Set([
			...this._baseToolDefinitions.keys(),
			...this.customTools.map((tool) => tool.name),
			...this.host
				.getExtensionRunner()
				.getAllRegisteredTools()
				.map((tool) => tool.definition.name),
		]);
		for (const name of names) {
			if (occupiedNames.has(name)) {
				throw new Error(`ACP MCP tool name conflicts with an existing tool: ${name}`);
			}
		}
	}

	private _rebuildRuntimeForAcpMcpServers(): void {
		const previousToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const nextToolNames = acpMcpToolNames(this.host.getMcpManager()?.getAcpServers() ?? []);
		this._assertAcpMcpToolNamesAvailable(nextToolNames);
		const activeToolNames = this.host.getActiveToolNames().filter((name) => !previousToolNames.has(name));
		activeToolNames.push(...nextToolNames);
		this.host.rebuildRuntime({
			activeToolNames,
			includeAllExtensionTools: true,
		});
		this.baseSystemPrompt = this.rebuildSystemPrompt(this.host.getActiveToolNames());
		this.host.setSystemPrompt(this.baseSystemPrompt);
	}
}
