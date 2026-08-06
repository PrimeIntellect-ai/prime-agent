import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type ClaudeCodeEvent,
	type ClaudeCodeQuery,
	type ClaudeCodeQueryRequest,
	type ClaudeCodeUsage,
	type StartClaudeCodeQuery,
	startClaudeCodeQuery,
} from "./claude-code-sdk.js";

export const CLAUDE_CODE_DENIED_TOOLS = ["Agent", "Task", "SendMessage"] as const;
export const CLAUDE_CODE_COORDINATION_PROMPT =
	"You are an RLM child in a Prime Agent family. Complete the assigned task and report concrete results. Prime Agent owns child spawning and family messaging; do not use Claude Code Agent, Task, or SendMessage.";

const CLAUDE_CODE_TOOLS_BY_PRIME_TOOL: Readonly<Record<string, readonly string[]>> = {
	ipython: ["Read", "Grep", "Glob", "Bash", "Edit", "Write", "WebSearch"],
	read: ["Read"],
	grep: ["Grep"],
	glob: ["Glob"],
	bash: ["Bash"],
	edit: ["Edit"],
	write: ["Write"],
	web_search: ["WebSearch"],
};

/** Map the parent's effective tool surface to the closest Claude built-ins without widening it. */
export function claudeCodeNativeTools(activePrimeTools: readonly string[]): string[] {
	return [...new Set(activePrimeTools.flatMap((toolName) => CLAUDE_CODE_TOOLS_BY_PRIME_TOOL[toolName] ?? []))];
}

export type ClaudeCodeRuntimeStatus = "queued" | "starting" | "running" | "done" | "error" | "cancelled";

export interface ClaudeCodeRuntimeSnapshot {
	status: ClaudeCodeRuntimeStatus;
	model: string;
	sessionId?: string;
	answerPreview?: string;
	toolUseCount: number;
	runningTool?: string;
	usage: ClaudeCodeUsage;
	error?: string;
	closed: boolean;
	turnIdle: boolean;
}

export interface ClaudeCodeRuntimeOptions {
	prompt: string;
	model: string;
	effort?: ThinkingLevel;
	executable: string;
	cwd: string;
	appendSystemPrompt?: string;
	tools: string[];
	mcpServers?: ClaudeCodeQueryRequest["mcpServers"];
	requiredTools?: readonly string[];
	startQuery?: StartClaudeCodeQuery;
}

export type ClaudeCodeRuntimeListener = (snapshot: ClaudeCodeRuntimeSnapshot) => void;

const CLAUDE_CODE_INPUT_CAPACITY = 100;

function emptyClaudeCodeUsage(): ClaudeCodeUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, requests: 0 };
}

function addClaudeCodeUsage(target: ClaudeCodeUsage, usage: ClaudeCodeUsage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost += usage.cost;
	target.requests += usage.requests;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class ClaudeCodeInputMailbox implements AsyncIterable<string> {
	private readonly queue: string[] = [];
	private waiter: ((result: IteratorResult<string>) => void) | undefined;
	private closed = false;
	private iteratorCreated = false;
	private inFlightInputs = 0;

	constructor(initialPrompt: string) {
		this.queue.push(initialPrompt);
	}

	get turnIdle(): boolean {
		return this.inFlightInputs === 0 && this.queue.length === 0;
	}

	enqueue(text: string): "queued" | "woken" {
		if (this.closed) throw new Error("Claude Code input mailbox is closed");
		if (this.queue.length + this.inFlightInputs >= CLAUDE_CODE_INPUT_CAPACITY) {
			throw new Error(`Claude Code input mailbox reached its ${CLAUDE_CODE_INPUT_CAPACITY}-message capacity`);
		}
		const outcome = this.turnIdle ? "woken" : "queued";
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			this.inFlightInputs += 1;
			waiter({ done: false, value: text });
		} else {
			this.queue.push(text);
		}
		return outcome;
	}

	completeTurn(): void {
		this.inFlightInputs = 0;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.queue.length = 0;
		this.inFlightInputs = 0;
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		if (this.iteratorCreated) throw new Error("Claude Code input mailbox supports one SDK consumer");
		this.iteratorCreated = true;
		return { next: () => this.next() };
	}

	private next(): Promise<IteratorResult<string>> {
		const text = this.queue.shift();
		if (text !== undefined) {
			this.inFlightInputs += 1;
			return Promise.resolve({ done: false, value: text });
		}
		if (this.closed) return Promise.resolve({ done: true, value: undefined });
		return new Promise<IteratorResult<string>>((resolve) => {
			this.waiter = resolve;
		});
	}
}

export class ClaudeCodeRuntime {
	readonly input: ClaudeCodeInputMailbox;
	readonly initialCompletion: Promise<ClaudeCodeRuntimeSnapshot>;
	private readonly options: ClaudeCodeRuntimeOptions;
	private readonly abortController = new AbortController();
	private readonly listeners = new Set<ClaudeCodeRuntimeListener>();
	private readonly usage = emptyClaudeCodeUsage();
	private readonly resolveInitialCompletion: (snapshot: ClaudeCodeRuntimeSnapshot) => void;
	private query: ClaudeCodeQuery | undefined;
	private status: ClaudeCodeRuntimeStatus = "queued";
	private sessionId: string | undefined;
	private answerPreview: string | undefined;
	private runningTool: string | undefined;
	private readonly toolUseIds = new Set<string>();
	private toolUseCount = 0;
	private runtimeError: string | undefined;
	private closeAttempted = false;
	private initialSettled = false;
	private eventPump: Promise<void> | undefined;

	constructor(options: ClaudeCodeRuntimeOptions) {
		this.options = options;
		this.input = new ClaudeCodeInputMailbox(options.prompt);
		let resolveInitialCompletion: ((snapshot: ClaudeCodeRuntimeSnapshot) => void) | undefined;
		this.initialCompletion = new Promise((resolve) => {
			resolveInitialCompletion = resolve;
		});
		this.resolveInitialCompletion = (snapshot) => resolveInitialCompletion?.(snapshot);
	}

	get snapshot(): ClaudeCodeRuntimeSnapshot {
		return {
			status: this.status,
			model: this.options.model,
			...(this.sessionId ? { sessionId: this.sessionId } : {}),
			...(this.answerPreview ? { answerPreview: this.answerPreview } : {}),
			toolUseCount: this.toolUseCount,
			...(this.runningTool ? { runningTool: this.runningTool } : {}),
			usage: { ...this.usage },
			...(this.runtimeError ? { error: this.runtimeError } : {}),
			closed: this.closeAttempted,
			turnIdle: this.input.turnIdle,
		};
	}

	subscribe(listener: ClaudeCodeRuntimeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async start(): Promise<void> {
		if (this.status !== "queued") throw new Error("Claude Code runtime has already started");
		this.status = "starting";
		this.emit();
		try {
			const query = await (this.options.startQuery ?? startClaudeCodeQuery)({
				prompt: this.input,
				model: this.options.model,
				...(this.options.effort && this.options.effort !== "off" && this.options.effort !== "minimal"
					? { effort: this.options.effort }
					: {}),
				executable: this.options.executable,
				cwd: this.options.cwd,
				appendSystemPrompt: this.options.appendSystemPrompt ?? CLAUDE_CODE_COORDINATION_PROMPT,
				tools: [...this.options.tools],
				allowedTools: [...this.options.tools, ...(this.options.requiredTools ?? [])],
				disallowedTools: [...CLAUDE_CODE_DENIED_TOOLS],
				...(this.options.mcpServers ? { mcpServers: this.options.mcpServers } : {}),
				abortController: this.abortController,
			});
			if (this.closeAttempted) {
				query.close();
				return;
			}
			this.query = query;
			this.eventPump = this.consumeEvents(query.events);
			void this.eventPump.catch(() => undefined);
		} catch (error) {
			this.fail(error);
		}
	}

	deliver(text: string): "queued" | "woken" {
		if (this.status === "error" || this.status === "cancelled") {
			throw new Error(this.runtimeError ?? "Claude Code runtime is unavailable");
		}
		const outcome = this.input.enqueue(text);
		this.status = "running";
		this.runningTool = undefined;
		this.emit();
		return outcome;
	}

	abort(reason = "Claude Code runtime cancelled"): void {
		if (this.status === "cancelled" || this.closeAttempted) return;
		this.status = "cancelled";
		this.runtimeError = reason;
		this.settleInitial();
		this.close(reason);
		this.emit();
	}

	dispose(): void {
		if (!this.initialSettled) this.abort("Claude Code runtime disposed");
		else this.close("Claude Code runtime disposed");
	}

	private async consumeEvents(events: AsyncIterable<ClaudeCodeEvent>): Promise<void> {
		let sawInit = false;
		try {
			for await (const event of events) {
				if (this.closeAttempted) return;
				if (event.kind === "init") {
					const denied = CLAUDE_CODE_DENIED_TOOLS.filter((tool) => event.tools.includes(tool));
					const missing = (this.options.requiredTools ?? []).filter((tool) => !event.tools.includes(tool));
					if (!event.sessionId || !event.model)
						throw new Error("Claude Code init omitted session identity or model");
					if (denied.length > 0) throw new Error(`Claude Code exposed denied tools: ${denied.join(", ")}`);
					if (missing.length > 0)
						throw new Error(`Claude Code omitted required Prime tools: ${missing.join(", ")}`);
					sawInit = true;
					this.sessionId = event.sessionId;
					this.status = "running";
					this.emit();
					continue;
				}
				if (event.kind === "close") {
					if (!this.closeAttempted) throw new Error("Claude Code query ended unexpectedly");
					return;
				}
				if (!sawInit) throw new Error("Claude Code emitted an event before init");
				if (event.kind === "assistant") {
					if (event.text) this.answerPreview = event.text;
					this.emit();
				} else if (event.kind === "tool-progress") {
					if (!this.toolUseIds.has(event.toolUseId)) {
						this.toolUseIds.add(event.toolUseId);
						this.toolUseCount += 1;
					}
					this.runningTool = event.toolName;
					this.emit();
				} else if (event.kind === "result") {
					if (event.isError) throw new Error(event.text || "Claude Code query failed");
					this.answerPreview = event.text || this.answerPreview;
					this.runningTool = undefined;
					this.input.completeTurn();
					addClaudeCodeUsage(this.usage, event.usage);
					this.status = "done";
					this.settleInitial();
					this.emit();
				} else if (event.kind === "error") {
					throw event.error;
				} else if (event.kind === "aborted") {
					throw new Error(event.reason ?? "Claude Code query aborted");
				}
			}
			if (!this.closeAttempted) throw new Error("Claude Code query ended unexpectedly");
		} catch (error) {
			if (!this.closeAttempted) this.fail(error);
		}
	}

	private fail(error: unknown): void {
		this.status = "error";
		this.runtimeError = errorMessage(error);
		this.settleInitial();
		this.close(this.runtimeError);
		this.emit();
	}

	private settleInitial(): void {
		if (this.initialSettled) return;
		this.initialSettled = true;
		this.resolveInitialCompletion(this.snapshot);
	}

	private close(reason: string): void {
		if (this.closeAttempted) return;
		this.closeAttempted = true;
		this.input.close();
		this.abortController.abort(new Error(reason));
		const query = this.query;
		this.query = undefined;
		try {
			query?.close();
		} catch (error) {
			this.runtimeError ??= `Claude Code query close failed: ${errorMessage(error)}`;
			if (this.status !== "cancelled") this.status = "error";
		}
	}

	private emit(): void {
		const snapshot = this.snapshot;
		for (const listener of this.listeners) listener(snapshot);
	}
}
