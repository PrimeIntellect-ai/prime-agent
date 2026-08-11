import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import type { ContextTreeNode } from "./context-tree.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { HostRequestChannel } from "./kernel/index.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionEntry } from "./session-manager.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";

const ACT_TOOL_NAME = "shared_ipython";
const ACT_BRANCH_RESET_ENTRY = "prime-agent.act-branch-reset";

const ACT_SYSTEM_PROMPT_BASE = `You are a trusted colleague handling one bounded action inside the calling engineer's live IPython kernel.

Complete the assigned outcome and acceptance criteria through the simplest complete action. Write in ordinary engineering words. Do not invent process jargon. Use a focused check that can expose an error in the result. Report a missing premise, failed check, conflicting evidence, uncertainty, or untested limit when it affects the caller's decision.

The current run prompt is your sole active assignment. Prior unfinished work and attached caller-history frames are context only: never resume an earlier assignment unless the current prompt asks for it.

The current run prompt is your sole active assignment. Prior unfinished work and attached caller-history frames are context only: never resume an earlier assignment unless the current prompt asks for it.

Use the shared_ipython tool for every inspection and action. Each call runs one complete IPython cell in the calling session's existing namespace, and calls are serialized. The cell sees the same Python variables, files, processes, and root-authorized host tools as the calling session. Reuse named objects already in the namespace, and leave useful intermediate state or results in clear variable names for the caller to inspect after you return.

Confirm the supplied source scope before inspecting. Combine already-known reads, searches, parsing, and comparisons in one shared_ipython cell when they answer one bounded question. When the source location is unknown, perform one bounded discovery step and inspect its result before continuing. Keep complete results in named variables, emit only the counts or excerpts needed for the decision, and verify each reported path and symbol from source.

Complete the assigned action only by executing rlm.done(value) in a shared_ipython cell. The value remains in the root kernel and returns to the caller with exact Python identity. A normal text response does not complete Act. Do not call rlm.done from a detached task. Do not spawn ordinary RLM children or ask the user for input.`;

function actSystemPrompt(depth: number, maxDepth: number): string {
	if (depth < maxDepth) {
		return `${ACT_SYSTEM_PROMPT_BASE}

One configured Act depth remains. You may delegate one bounded next-depth action with \`nested = await rlm.act(prompt, model=...)\` in a shared_ipython cell. Omit \`model\` only when that depth has a configured default. Reuse named objects already in the namespace, identify those bindings in the action, and ask the nested Act worker to leave later-use state in named variables. After it returns, inspect the returned object and shared state before continuing or calling your own rlm.done(value).`;
	}
	return `${ACT_SYSTEM_PROMPT_BASE}

You are at the maximum configured Act depth. Complete the action through shared_ipython and rlm.done(value). Another nested Act call is unavailable.`;
}

export const ACT_SYSTEM_PROMPT = actSystemPrompt(1, 1);

export interface ActLaneResult {
	outcome: "done" | "text" | "cancelled";
	text?: string;
}

export interface ActLaneTarget {
	sessionKey: string;
	createSession(tool: AgentTool): Promise<AgentSession>;
}

type BeforeActPrompt = (state: {
	sessionKey: string;
	usage: Usage;
	model?: { provider: string; id: string; name?: string };
	thinkingLevel: string;
}) => void;

export type ActLaneProgress =
	| { type: "assistant_delta"; stream: "thinking" | "text"; text: string }
	| { type: "cell_start"; cellId: string; code: string }
	| {
			type: "cell_terminal";
			cellId: string;
			durationMs?: number;
			status: "ok" | "error" | "cancelled";
			stdout: string;
			stderr: string;
			result?: string;
			error?: string;
	  };

type ActProgressHandler = (progress: ActLaneProgress) => void;

interface ActiveAct {
	channel: HostRequestChannel;
	controller: AbortController;
	completed: boolean;
	cellActive: boolean;
	interruptScheduled: boolean;
	progress?: ActProgressHandler;
	abort(interruptCell?: boolean): void;
}

interface ActCellResult {
	type: "cell_result";
	durationMs?: number;
	stdout?: string | null;
	stderr?: string | null;
	result?: string | null;
	error?: string | null;
}

function parseCellResult(response: Record<string, unknown>): ActCellResult {
	if (response.type !== "cell_result") throw new Error("Act returned an unexpected cell response");
	if (response.durationMs !== undefined && typeof response.durationMs !== "number") {
		throw new Error("Act cell response has invalid durationMs");
	}
	for (const field of ["stdout", "stderr", "result", "error"] as const) {
		const value = response[field];
		if (value !== undefined && value !== null && typeof value !== "string") {
			throw new Error(`Act cell response has invalid ${field}`);
		}
	}
	return {
		type: "cell_result",
		durationMs: response.durationMs as number | undefined,
		stdout: response.stdout as string | null | undefined,
		stderr: response.stderr as string | null | undefined,
		result: response.result as string | null | undefined,
		error: response.error as string | null | undefined,
	};
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const field = value?.[key];
	return typeof field === "string" ? field : undefined;
}

function toolResultText(value: unknown): string | undefined {
	const content = record(value)?.content;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.flatMap((block) => {
			const item = record(block);
			return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n");
	return text || undefined;
}

function subscribeActProgress(
	session: AgentSession,
	emit: ActProgressHandler,
	isCancelled: () => boolean,
	isCompleted: () => boolean,
): () => void {
	let cellSequence = 0;
	const cellIds = new Map<string, string>();
	return session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "message_update" && event.message.role === "assistant") {
			if (event.assistantMessageEvent.type === "thinking_delta" && event.assistantMessageEvent.delta) {
				emit({ type: "assistant_delta", stream: "thinking", text: event.assistantMessageEvent.delta });
			} else if (event.assistantMessageEvent.type === "text_delta" && event.assistantMessageEvent.delta) {
				emit({ type: "assistant_delta", stream: "text", text: event.assistantMessageEvent.delta });
			}
			return;
		}
		if (event.type === "tool_execution_start" && event.toolName === ACT_TOOL_NAME) {
			const args = record(event.args);
			if (typeof args?.code !== "string") return;
			const cellId = `cell-${++cellSequence}`;
			cellIds.set(event.toolCallId, cellId);
			emit({ type: "cell_start", cellId, code: args.code });
			return;
		}
		if (event.type !== "tool_execution_end" || event.toolName !== ACT_TOOL_NAME) return;
		const cellId = cellIds.get(event.toolCallId);
		if (!cellId) return;
		cellIds.delete(event.toolCallId);
		const details = record(record(event.result)?.details);
		const completed = isCompleted() || details?.outcome === "done";
		const detailError = stringField(details, "error");
		const error = completed ? undefined : (detailError ?? (event.isError ? toolResultText(event.result) : undefined));
		emit({
			type: "cell_terminal",
			cellId,
			status: completed ? "ok" : isCancelled() ? "cancelled" : detailError || event.isError ? "error" : "ok",
			stdout: stringField(details, "stdout") ?? "",
			stderr: stringField(details, "stderr") ?? "",
			...(stringField(details, "result") !== undefined ? { result: stringField(details, "result") } : {}),
			...(error ? { error } : {}),
		});
	});
}

function usageFromSession(session: AgentSession): Usage {
	const usage = emptyUsage();
	for (const entry of session.sessionManager.getBranch()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addAssistantUsage(usage, entry.message.usage);
		}
	}
	return usage;
}

function formatCellResult(result: ActCellResult): string {
	const sections: string[] = [];
	if (result.stdout) sections.push(`[stdout]\n${result.stdout}`);
	if (result.stderr) sections.push(`[stderr]\n${result.stderr}`);
	if (result.result) sections.push(`[result]\n${result.result}`);
	if (result.error) sections.push(`[error]\n${result.error}`);
	return sections.join("\n\n") || "Cell completed without output.";
}

/** ActLane retains one private session per resolved model and serializes its root-world tasks. */
export class ActLane {
	private session: AgentSession | undefined;
	private readonly sessions = new Map<string, AgentSession>();
	private creating: Promise<AgentSession> | undefined;
	private active: ActiveAct | undefined;
	private readonly idleWaiters = new Set<() => void>();
	private disposedUsage = emptyUsage();
	private disposedModel: { provider: string; id: string } | undefined;
	private disposed = false;

	async run(
		prompt: string,
		channel: HostRequestChannel,
		target: ActLaneTarget,
		beforePrompt?: BeforeActPrompt,
		onAdmitted?: () => void,
		onProgress?: ActProgressHandler,
		historyImages: readonly ImageContent[] = [],
	): Promise<ActLaneResult> {
		if (this.disposed) throw new Error("Act lane has been disposed");
		if (this.active) throw new Error("Another Act is already active in this session");
		const controller = new AbortController();
		let active!: ActiveAct;
		const abort = (interruptCell = false) => {
			const cellWasActive = active.cellActive;
			if (!controller.signal.aborted) {
				this.session?.requestAbort();
				controller.abort();
			}
			if (interruptCell && cellWasActive && !active.interruptScheduled) {
				active.interruptScheduled = true;
				channel.interruptAfterGrace?.();
			}
		};
		active = {
			channel,
			controller,
			completed: false,
			cellActive: false,
			interruptScheduled: false,
			progress: onProgress,
			abort,
		};
		this.active = active;
		let activeSession: AgentSession | undefined;
		let previousLeafId: string | null | undefined;
		onAdmitted?.();
		const abortFromChannel = () => abort();
		const interruptFromExecution = () => abort(true);
		channel.signal.addEventListener("abort", abortFromChannel, { once: true });
		channel.interruptSignal?.addEventListener("abort", interruptFromExecution, { once: true });
		if (channel.signal.aborted) abortFromChannel();
		if (channel.interruptSignal?.aborted) interruptFromExecution();
		try {
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const session = await this.getSession(target);
			activeSession = session;
			previousLeafId = session.sessionManager.getLeafId();
			if (controller.signal.aborted) return { outcome: "cancelled" };
			beforePrompt?.({
				sessionKey: target.sessionKey,
				usage: usageFromSession(session),
				model: session.model
					? { provider: session.model.provider, id: session.model.id, name: session.model.name }
					: undefined,
				thinkingLevel: session.thinkingLevel,
			});
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const unsubscribeProgress = onProgress
				? subscribeActProgress(
						session,
						onProgress,
						() => controller.signal.aborted,
						() => active.completed,
					)
				: () => {};
			try {
				const contextNote = historyImages.length
					? `

${historyImages.length} attached bitmap frame(s) contain the caller's message delta since the previous Act at this depth. Use them only as context for the current assignment.`
					: "";
				await session.prompt(`${prompt}${contextNote}`, {
					images: historyImages.length > 0 ? [...historyImages] : undefined,
					expandPromptTemplates: false,
					internalPrompt: true,
					suppressAutonomousContinuation: true,
					signal: controller.signal,
				});
			} catch (error) {
				if (!active.completed && !controller.signal.aborted) throw error;
			} finally {
				unsubscribeProgress();
			}
			if (active.completed) return { outcome: "done" };
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const lastAssistant = session.messages
				.slice()
				.reverse()
				.find((message) => message.role === "assistant");
			if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
				throw new Error(lastAssistant.errorMessage || "Act provider failed");
			}
			const text = session.getLastAssistantText() ?? "";
			return { outcome: "text", text };
		} catch (error) {
			if (controller.signal.aborted) return { outcome: "cancelled" };
			throw error;
		} finally {
			if (!active.completed && activeSession && previousLeafId !== undefined) {
				if (previousLeafId === null) activeSession.sessionManager.resetLeaf();
				else activeSession.sessionManager.branch(previousLeafId);
				activeSession.sessionManager.appendCustomEntry(ACT_BRANCH_RESET_ENTRY);
				activeSession.agent.state.messages = activeSession.buildSessionContext().messages;
			}
			channel.signal.removeEventListener("abort", abortFromChannel);
			channel.interruptSignal?.removeEventListener("abort", interruptFromExecution);
			if (this.active === active) {
				this.active = undefined;
				for (const resolve of this.idleWaiters) resolve();
				this.idleWaiters.clear();
			}
		}
	}

	cancel(): boolean {
		if (!this.active) return false;
		this.active.abort(true);
		return true;
	}

	waitForIdle(): Promise<void> {
		if (!this.active) return Promise.resolve();
		return new Promise((resolve) => this.idleWaiters.add(resolve));
	}

	get usage(): Usage {
		return this.session ? usageFromSession(this.session) : this.disposedUsage;
	}

	get model(): { provider: string; id: string; name?: string } | undefined {
		const model = this.session?.model;
		return model ? { provider: model.provider, id: model.id, name: model.name } : this.disposedModel;
	}

	get thinkingLevel(): string | undefined {
		return this.session?.thinkingLevel;
	}

	get contextTree(): ContextTreeNode | undefined {
		return this.session?.getContextTree();
	}

	/** callerHistoryEntries returns the active branch that invoked a nested Act. */
	get callerHistoryEntries(): SessionEntry[] {
		return this.session?.sessionManager.getBranch() ?? [];
	}

	get running(): boolean {
		return this.active !== undefined;
	}

	get cellRunning(): boolean {
		return this.active?.cellActive ?? false;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const cancelledActive = this.cancel();
		if (this.session) {
			this.disposedUsage = usageFromSession(this.session);
			const model = this.session.model;
			this.disposedModel = model ? { provider: model.provider, id: model.id } : undefined;
		}
		for (const session of this.sessions.values()) {
			if (!cancelledActive || session !== this.session) session.requestAbort();
			session.dispose();
		}
		this.sessions.clear();
		this.session = undefined;
	}

	private async getSession(target: ActLaneTarget): Promise<AgentSession> {
		const retained = this.sessions.get(target.sessionKey);
		if (retained) {
			this.session = retained;
			return retained;
		}
		this.session = undefined;
		this.creating ??= target.createSession(this.createTool());
		try {
			const session = await this.creating;
			if (this.disposed) {
				session.dispose();
				throw new Error("Act lane has been disposed");
			}
			this.sessions.set(target.sessionKey, session);
			this.session = session;
			return session;
		} finally {
			this.creating = undefined;
		}
	}

	private createTool(): AgentTool {
		return {
			name: ACT_TOOL_NAME,
			label: "Shared IPython",
			description: "Run one complete cell in the directing session's live IPython namespace.",
			parameters: Type.Object({ code: Type.String() }),
			execute: async (_toolCallId, parameters) => {
				const active = this.active;
				if (!active) throw new Error("No Act is active");
				if (active.cellActive) throw new Error("An Act cell is already active");
				const code =
					typeof parameters === "object" && parameters !== null && "code" in parameters
						? parameters.code
						: undefined;
				if (typeof code !== "string") throw new Error("shared_ipython requires string code");
				active.cellActive = true;
				try {
					await active.channel.send({ type: "cell", code });
					const response = await active.channel.receive(active.controller.signal);
					if (response.type === "done") {
						active.completed = true;
						this.session?.requestAbort();
						return {
							content: [{ type: "text" as const, text: "Act completed with an in-kernel value." }],
							details: { outcome: "done" },
						};
					}
					const result = parseCellResult(response);
					return {
						content: [{ type: "text" as const, text: formatCellResult(result) }],
						details: result,
					};
				} finally {
					active.cellActive = false;
				}
			},
		};
	}
}

export function createActResourceLoader(
	options: { depth: number; maxDepth: number } = { depth: 1, maxDepth: 1 },
): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	const systemPrompt = actSystemPrompt(options.depth, options.maxDepth);
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}
