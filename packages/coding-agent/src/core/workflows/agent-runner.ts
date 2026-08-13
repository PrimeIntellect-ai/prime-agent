import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import type { Static, TSchema } from "typebox";
import { getAgentDir } from "../../config.js";
import type { ToolDefinition } from "../extensions/types.js";
import { DefaultResourceLoader } from "../resource-loader.js";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk.js";
import { SessionManager } from "../session-manager.js";
import { SettingsManager } from "../settings-manager.js";
import type { WorkflowAgentRunner, WorkflowAgentRunOptions, WorkflowAgentRunResult, WorkflowUsage } from "./runtime.js";

interface OutputCapture {
	called: boolean;
	value?: unknown;
}

export interface WorkflowSubagentRunnerOptions {
	cwd: string;
	modelRegistry: CreateAgentSessionOptions["modelRegistry"];
	model?: CreateAgentSessionOptions["model"];
	thinkingLevel?: ThinkingLevel;
	agentDir?: string;
	activeToolNames?: string[];
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class WorkflowSubagentRunner implements WorkflowAgentRunner {
	private readonly agentDir: string;
	private readonly settingsManager: SettingsManager;
	private resourceLoaderPromise?: Promise<DefaultResourceLoader>;

	constructor(private readonly options: WorkflowSubagentRunnerOptions) {
		this.agentDir = options.agentDir ?? getAgentDir();
		this.settingsManager = SettingsManager.create(options.cwd, this.agentDir);
	}

	async run(prompt: string, options: WorkflowAgentRunOptions): Promise<WorkflowAgentRunResult> {
		if (options.signal?.aborted) throw abortError(options.signal.reason);
		if (options.isolation) {
			throw new Error(`workflow agent isolation "${options.isolation}" is not available in this Prime Agent build`);
		}
		if (options.agentType) {
			throw new Error(`workflow agent type "${options.agentType}" is not available in this Prime Agent build`);
		}
		const startedAt = Date.now();
		const capture: OutputCapture = { called: false };
		const schema = normalizeSchema(options.schema);
		const outputTool = schema ? createWorkflowOutputTool(schema, capture) : undefined;
		const { model, thinkingLevel } = await this.resolveModel(options.model, options.effort);
		const execution = {
			...(model ? { model: `${model.provider}/${model.id}` } : {}),
			...(thinkingLevel ? { effort: thinkingLevel } : {}),
		};
		const tools = [
			...(this.options.activeToolNames === undefined || this.options.activeToolNames.includes("ipython")
				? ["ipython"]
				: []),
			...(outputTool ? [outputTool.name] : []),
		];
		const timeoutController = new AbortController();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let removeAbortListener: (() => void) | undefined;
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let creationPromise: ReturnType<typeof createAgentSession> | undefined;
		let abortPromise: Promise<void> | undefined;
		const abortSession = (reason: unknown) => {
			if (timeoutController.signal.aborted) return;
			timeoutController.abort(reason);
			if (session) abortPromise = session.abort().catch(() => undefined);
		};
		if (options.signal) {
			const forwardAbort = () => abortSession(options.signal?.reason);
			if (options.signal.aborted) forwardAbort();
			else options.signal.addEventListener("abort", forwardAbort, { once: true });
			removeAbortListener = () => options.signal?.removeEventListener("abort", forwardAbort);
		}
		if (options.timeoutMs) {
			timeout = setTimeout(
				() => abortSession(new Error(`workflow agent timed out after ${options.timeoutMs}ms`)),
				Math.max(1, options.timeoutMs - (Date.now() - startedAt)),
			);
		}

		try {
			const resourceLoader = await raceWithSignal(this.getResourceLoader(), timeoutController.signal);
			creationPromise = createAgentSession({
				cwd: this.options.cwd,
				agentDir: this.agentDir,
				modelRegistry: this.options.modelRegistry,
				model,
				thinkingLevel,
				settingsManager: this.settingsManager,
				resourceLoader,
				sessionManager: SessionManager.inMemory(this.options.cwd),
				tools,
				customTools: outputTool ? [outputTool] : [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 0,
				rlmMaxDepth: 0,
			});
			const created = await raceWithSignal(creationPromise, timeoutController.signal);
			session = created.session;
			if (timeoutController.signal.aborted) {
				await session.abort();
				throw abortError(timeoutController.signal.reason);
			}
			await raceWithSignal(
				session.prompt(buildSubagentPrompt(prompt, options, Boolean(schema))),
				timeoutController.signal,
			);
			const usage = collectUsage(session.messages);
			if (schema) {
				if (!capture.called) throw new Error("workflow subagent finished without calling workflow_output");
				return { result: capture.value, usage, ...execution };
			}
			const text = lastAssistantText(session.messages);
			if (!text.trim()) throw new Error("workflow subagent produced empty output");
			return { result: text, usage, ...execution };
		} finally {
			if (timeout) clearTimeout(timeout);
			removeAbortListener?.();
			await abortPromise;
			if (session) await session.disposeAsync();
			else if (creationPromise) {
				void creationPromise
					.then(async (created) => {
						await created.session.abort().catch(() => undefined);
						await created.session.disposeAsync().catch(() => undefined);
					})
					.catch(() => undefined);
			}
		}
	}

	private async getResourceLoader(): Promise<DefaultResourceLoader> {
		this.resourceLoaderPromise ??= (async () => {
			const loader = new DefaultResourceLoader({
				cwd: this.options.cwd,
				agentDir: this.agentDir,
				settingsManager: this.settingsManager,
				noExtensions: true,
				noPromptTemplates: true,
			});
			await loader.reload();
			return loader;
		})();
		return this.resourceLoaderPromise;
	}

	private async resolveModel(
		spec: string | undefined,
		effort: ThinkingLevel | undefined,
	): Promise<{
		model: CreateAgentSessionOptions["model"];
		thinkingLevel: ThinkingLevel | undefined;
	}> {
		if (!spec) return { model: this.options.model, thinkingLevel: effort ?? this.options.thinkingLevel };
		const registry = this.options.modelRegistry;
		const isSubscription = (candidate: NonNullable<CreateAgentSessionOptions["model"]>) =>
			registry?.isUsingOAuth(candidate) === true;
		if (!spec.includes("/")) {
			const available = (await registry?.getExecutableModels()) ?? [];
			const shorthand = available.filter((candidate) => modelMatches(candidate.id, candidate.name, spec));
			const selected = selectAvailableModel(shorthand, this.options.model?.provider, isSubscription);
			if (selected) {
				return { model: selected, thinkingLevel: effort ?? this.options.thinkingLevel };
			}
			throw new Error(
				shorthand.length > 1
					? `workflow model "${spec}" is ambiguous across available subscription models; use provider/model`
					: `workflow model "${spec}" is not available from the configured subscriptions`,
			);
		}
		const slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) {
			throw new Error(`invalid workflow model "${spec}"; expected provider/model[:thinking]`);
		}
		const provider = spec.slice(0, slash);
		const modelAndThinking = spec.slice(slash + 1);
		const colon = modelAndThinking.lastIndexOf(":");
		const maybeThinking = colon >= 0 ? modelAndThinking.slice(colon + 1) : undefined;
		const hasThinking = maybeThinking !== undefined && THINKING_LEVELS.has(maybeThinking as ThinkingLevel);
		const modelId = hasThinking ? modelAndThinking.slice(0, colon) : modelAndThinking;
		const available = (await registry?.getExecutableModels()) ?? [];
		const exact = available.find((candidate) => candidate.provider === provider && candidate.id === modelId);
		const subscriptionFallback = selectAvailableModel(
			available.filter(
				(candidate) => isSubscription(candidate) && modelMatches(candidate.id, candidate.name, modelId),
			),
			this.options.model?.provider,
			isSubscription,
		);
		const model = exact ?? subscriptionFallback;
		if (!model)
			throw new Error(`workflow model "${provider}/${modelId}" is not available from configured subscriptions`);
		return {
			model,
			thinkingLevel: effort ?? (hasThinking ? (maybeThinking as ThinkingLevel) : this.options.thinkingLevel),
		};
	}
}

function modelMatches(id: string, name: string, requested: string): boolean {
	const normalizedRequest = normalizeModelSelector(requested);
	return [id, name].some((value) => {
		const normalizedValue = normalizeModelSelector(value);
		return normalizedValue === normalizedRequest || sortedTokens(normalizedValue) === sortedTokens(normalizedRequest);
	});
}

function normalizeModelSelector(value: string): string {
	return value
		.toLowerCase()
		.replace(/([a-z])([0-9])/g, "$1 $2")
		.replace(/([0-9])([a-z])/g, "$1 $2")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function sortedTokens(value: string): string {
	return value.split(" ").filter(Boolean).sort().join(" ");
}

function selectAvailableModel<T extends { provider: string }>(
	matches: T[],
	parentProvider: string | undefined,
	isSubscription: (candidate: T) => boolean,
): T | undefined {
	if (matches.length === 1) return matches[0];
	const subscriptions = matches.filter(isSubscription);
	if (subscriptions.length === 1) return subscriptions[0];
	if (parentProvider) {
		const inherited = matches.filter((candidate) => candidate.provider === parentProvider);
		if (inherited.length === 1) return inherited[0];
	}
	return undefined;
}

function createWorkflowOutputTool(schema: TSchema, capture: OutputCapture): ToolDefinition<TSchema> {
	return {
		name: "workflow_output",
		label: "Workflow Output",
		description: "Return the final schema-validated value to the workflow orchestrator.",
		promptSnippet: "Return the final structured workflow result",
		promptGuidelines: [
			"When workflow_output is available, call it exactly once as your final action.",
			"Do not emit a prose answer instead of workflow_output.",
		],
		parameters: schema,
		async execute(_toolCallId, params: Static<TSchema>) {
			capture.called = true;
			capture.value = structuredClone(params);
			return {
				content: [{ type: "text", text: "Structured workflow output captured." }],
				details: capture.value,
				terminate: true,
			};
		},
	};
}

function normalizeSchema(value: unknown): TSchema | undefined {
	if (value === undefined) return undefined;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("workflow agent schema must be a JSON Schema object");
	}
	return value as TSchema;
}

function buildSubagentPrompt(prompt: string, options: WorkflowAgentRunOptions, structured: boolean): string {
	const sections = [
		"You are a dynamic workflow subagent. Complete only the delegated task. Your final output is consumed by an orchestration script, so return the requested data without conversational filler.",
		options.phase ? `Workflow phase: ${options.phase}` : undefined,
		options.agentType ? `Role: ${options.agentType}` : undefined,
		`Task label: ${options.label}`,
		prompt,
		structured
			? "Your final action must be one workflow_output tool call matching its schema. You may inspect files and run commands first."
			: undefined,
	];
	return sections.filter((section): section is string => Boolean(section)).join("\n\n");
}

function collectUsage(messages: unknown[]): WorkflowUsage {
	const usage: WorkflowUsage = { input: 0, output: 0, totalTokens: 0, cost: 0 };
	for (const value of messages) {
		const message = value as Partial<AssistantMessage>;
		if (message.role !== "assistant" || !message.usage) continue;
		usage.input += message.usage.input ?? 0;
		usage.output += message.usage.output ?? 0;
		usage.totalTokens += message.usage.totalTokens ?? 0;
		usage.cost += message.usage.cost?.total ?? 0;
	}
	return usage;
}

function lastAssistantText(messages: unknown[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as Partial<AssistantMessage> | undefined;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
		if (text.trim()) return text;
	}
	return "";
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw abortError(signal.reason);
	let removeListener: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		const onAbort = () => reject(abortError(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
		removeListener = () => signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([promise, aborted]);
	} finally {
		removeListener?.();
	}
}

function abortError(reason: unknown): Error {
	return reason instanceof Error ? reason : new Error("workflow subagent aborted");
}
