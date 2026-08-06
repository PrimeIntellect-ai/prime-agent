/**
 * Local test harness for the new coding-agent test suite.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type {
	FauxModelDefinition,
	FauxProviderRegistration,
	FauxResponseStep,
	Model,
	ProviderNativeCompactionFunction,
} from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import type { AgentObserveController } from "../../src/core/agent-observe.js";
import { AgentSession, type AgentSessionEvent, type AutoRefineReviewer } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { AgentAutonomousConfig } from "../../src/core/autonomous.js";
import type { StartClaudeCodeQuery } from "../../src/core/claude-code-sdk.js";
import type { ExtensionRunner } from "../../src/core/extensions/index.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import type { SubagentRuntimeHost } from "../../src/core/rlm-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { Settings } from "../../src/core/settings-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import type { ExtensionFactory, ResourceLoader } from "../../src/index.js";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "../utilities.js";

type MessageTextPart = { type: "text"; text: string };

export function getMessageText(message: unknown): string {
	if (!message || typeof message !== "object" || !("content" in message)) {
		return "";
	}
	const content = (message as { content?: string | Array<{ type: string; text?: string }> }).content;
	if (content === undefined) {
		return "";
	}
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((part): part is MessageTextPart => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

export function getUserTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "user")
		.map((message) => getMessageText(message));
}

export function getAssistantTexts(harness: Harness): string[] {
	return harness.session.messages
		.filter((message) => message.role === "assistant")
		.map((message) => getMessageText(message));
}

export interface HarnessOptions {
	api?: string;
	provider?: string;
	models?: FauxModelDefinition[];
	nativeCompact?: ProviderNativeCompactionFunction<string>;
	settings?: Partial<Settings>;
	systemPrompt?: string;
	tools?: AgentTool[];
	resourceLoader?: ResourceLoader;
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
	withConfiguredAuth?: boolean;
	agentObserveController?: AgentObserveController;
	agentMessageController?: AgentSessionMessageController;
	subagentRuntimeHost?: SubagentRuntimeHost;
	startClaudeCodeQuery?: StartClaudeCodeQuery;
	persistSession?: boolean;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	autonomous?: AgentAutonomousConfig;
	autoRefineReviewer?: AutoRefineReviewer;
	serializedRefine?: boolean;
	initialGoal?: { objective: string; tokenBudget?: number };
}

export interface Harness {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	faux: FauxProviderRegistration;
	models: [Model<string>, ...Model<string>[]];
	getModel(): Model<string>;
	getModel(modelId: string): Model<string> | undefined;
	setResponses: (responses: FauxResponseStep[]) => void;
	appendResponses: (responses: FauxResponseStep[]) => void;
	getPendingResponseCount: () => number;
	events: AgentSessionEvent[];
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	tempDir: string;
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const fauxProvider: FauxProviderRegistration = registerFauxProvider({
		api: options.api,
		provider: options.provider,
		models: options.models,
		compact: options.nativeCompact,
	});
	fauxProvider.setResponses([]);
	const model = fauxProvider.getModel();
	const toolMap = options.tools ? Object.fromEntries(options.tools.map((tool) => [tool.name, tool])) : undefined;
	const withConfiguredAuth = options.withConfiguredAuth ?? true;
	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	const sessionManager = options.persistSession
		? SessionManager.create(tempDir, join(tempDir, "sessions"))
		: SessionManager.inMemory();
	const settingsManager = SettingsManager.inMemory(options.settings);

	const authStorage = AuthStorage.inMemory();
	if (withConfiguredAuth) {
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
	}
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	if (withConfiguredAuth) {
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
	}

	const agent = new Agent({
		getApiKey: () => (withConfiguredAuth ? "faux-key" : undefined),
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: [],
		},
		convertToLlm,
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		transformContext: async (messages: AgentMessage[]) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
	});
	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const resourceLoader =
		options.resourceLoader ?? createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader,
		agentObserveController: options.agentObserveController,
		agentMessageController: options.agentMessageController,
		subagentRuntimeHost: options.subagentRuntimeHost,
		startClaudeCodeQuery: options.startClaudeCodeQuery,
		baseToolsOverride: toolMap,
		extensionRunnerRef,
		rlmDepth: options.rlmDepth,
		rlmMaxDepth: options.rlmMaxDepth,
		autonomous: options.autonomous,
		autoRefineReviewer: options.autoRefineReviewer,
		serializedRefine: options.serializedRefine,
		initialGoal: options.initialGoal,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	return {
		session,
		sessionManager,
		settingsManager,
		authStorage,
		faux: fauxProvider,
		models: fauxProvider.models,
		getModel: fauxProvider.getModel,
		setResponses: fauxProvider.setResponses,
		appendResponses: fauxProvider.appendResponses,
		getPendingResponseCount: fauxProvider.getPendingResponseCount,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type);
		},
		tempDir,
		cleanup() {
			session.dispose();
			fauxProvider.unregister();
			if (existsSync(tempDir)) {
				// Spawned fixture processes may still be flushing their final registry
				// writes; retry briefly instead of failing the suite on ENOTEMPTY.
				rmSync(tempDir, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
			}
		},
	};
}
