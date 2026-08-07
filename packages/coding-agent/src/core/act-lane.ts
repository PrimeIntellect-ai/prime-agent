import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentSession, AgentSessionEvent } from "./agent-session.js";
import type { ContextTreeNode } from "./context-tree.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { HostRequestChannel } from "./kernel/index.js";
import type { ResourceLoader } from "./resource-loader.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";

const ACT_TOOL_NAME = "shared_ipython";

export const ACT_SYSTEM_PROMPT = `You are the retained low-level Act actor working inside the directing model's live IPython world.

Use the shared_ipython tool for every inspection and action. Each call runs one complete IPython cell in the directing session's existing namespace. Calls are serialized. Variables, files, processes, and root-authorized host tools are the real shared world, not a copy. Treat named variables as the handoff between you and the directing model: reuse objects already in the namespace, and leave useful intermediate state or results in clear variable names so the director can inspect and continue them after you return.

Finish the assigned task only by executing rlm.done(value) in a shared_ipython cell. The value remains in the root kernel and returns to Sol with exact Python identity. A normal text response does not complete the Act. Do not call rlm.done from a detached task. Do not spawn another actor or ask for user input.`;

export interface ActLaneResult {
	outcome: "done" | "text" | "cancelled";
	text?: string;
}

type CreateActSession = (tool: AgentTool, model: string | undefined) => Promise<AgentSession>;
type SelectActSession = (session: AgentSession, model: string | undefined) => Promise<void>;

type BeforeActPrompt = (state: {
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
	if (result.stdout) sections.push(result.stdout);
	if (result.stderr) sections.push(result.stderr);
	if (result.result) sections.push(result.result);
	if (result.error) sections.push(result.error);
	return sections.join("\n").trim() || "Cell completed without output.";
}

/** ActLane retains one private model session and serializes its root-world tasks. */
export class ActLane {
	private session: AgentSession | undefined;
	private creating: Promise<AgentSession> | undefined;
	private active: ActiveAct | undefined;
	private readonly idleWaiters = new Set<() => void>();
	private disposedUsage = emptyUsage();
	private disposedModel: { provider: string; id: string } | undefined;
	private disposed = false;

	constructor(
		private readonly createSession: CreateActSession,
		private readonly selectSession: SelectActSession,
	) {}

	async run(
		prompt: string,
		channel: HostRequestChannel,
		model: string | undefined,
		beforePrompt?: BeforeActPrompt,
		onAdmitted?: () => void,
		onProgress?: ActProgressHandler,
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
		onAdmitted?.();
		const abortFromChannel = () => abort();
		const interruptFromExecution = () => abort(true);
		channel.signal.addEventListener("abort", abortFromChannel, { once: true });
		channel.interruptSignal?.addEventListener("abort", interruptFromExecution, { once: true });
		if (channel.signal.aborted) abortFromChannel();
		if (channel.interruptSignal?.aborted) interruptFromExecution();
		try {
			if (controller.signal.aborted) return { outcome: "cancelled" };
			const session = await this.getSession(model);
			if (controller.signal.aborted) return { outcome: "cancelled" };
			beforePrompt?.({
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
				await session.prompt(prompt, {
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

	get model(): { provider: string; id: string } | undefined {
		const model = this.session?.model;
		return model ? { provider: model.provider, id: model.id } : this.disposedModel;
	}

	get contextTree(): ContextTreeNode | undefined {
		return this.session?.getContextTree();
	}

	get running(): boolean {
		return this.active !== undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		const cancelledActive = this.cancel();
		if (this.session) {
			this.disposedUsage = usageFromSession(this.session);
			const model = this.session.model;
			this.disposedModel = model ? { provider: model.provider, id: model.id } : undefined;
			if (!cancelledActive) this.session.requestAbort();
			this.session.dispose();
		}
		this.session = undefined;
	}

	private async getSession(model: string | undefined): Promise<AgentSession> {
		if (this.session) {
			const session = this.session;
			await this.selectSession(session, model);
			if (this.disposed || this.session !== session) throw new Error("Act lane has been disposed");
			return session;
		}
		this.creating ??= this.createSession(this.createTool(), model);
		try {
			const session = await this.creating;
			if (this.disposed) {
				session.dispose();
				throw new Error("Act lane has been disposed");
			}
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

export function createActResourceLoader(): ResourceLoader {
	const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
	return {
		getExtensions: () => extensions,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => ACT_SYSTEM_PROMPT,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}
