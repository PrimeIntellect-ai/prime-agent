import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
	CLAUDE_CODE_COORDINATION_PROMPT,
	ClaudeCodeRuntime,
	claudeCodeNativeTools,
} from "../src/core/claude-code-runtime.js";
import {
	type ClaudeCodeEvent,
	type ClaudeCodeQueryRequest,
	type ClaudeCodeSdkQuery,
	createClaudeCodeQueryStarter,
	mapClaudeCodeSdkMessages,
} from "../src/core/claude-code-sdk.js";

class EventSource implements AsyncIterable<ClaudeCodeEvent> {
	private readonly queue: ClaudeCodeEvent[] = [];
	private waiter: ((result: IteratorResult<ClaudeCodeEvent>) => void) | undefined;
	private ended = false;

	push(event: ClaudeCodeEvent): void {
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter({ done: false, value: event });
		} else {
			this.queue.push(event);
		}
	}

	end(): void {
		this.ended = true;
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<ClaudeCodeEvent> {
		return {
			next: () => {
				const event = this.queue.shift();
				if (event) return Promise.resolve({ done: false, value: event });
				if (this.ended) return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve) => {
					this.waiter = resolve;
				});
			},
		};
	}
}

const usage = {
	input: 10,
	output: 4,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 17,
	cost: 0.02,
	requests: 1,
};

function runtimeHarness() {
	const events = new EventSource();
	let request: ClaudeCodeQueryRequest | undefined;
	let input: AsyncIterator<string> | undefined;
	const close = vi.fn(() => events.end());
	const runtime = new ClaudeCodeRuntime({
		prompt: "initial task",
		model: "claude-opus-4-7",
		effort: "high",
		executable: "/opt/claude",
		cwd: "/work",
		tools: ["Read", "Edit"],
		startQuery: async (nextRequest) => {
			request = nextRequest;
			input = nextRequest.prompt[Symbol.asyncIterator]();
			return { events, close };
		},
	});
	return {
		runtime,
		events,
		close,
		request: () => request,
		input: () => {
			if (!input) throw new Error("input iterator not started");
			return input;
		},
	};
}

describe("Claude Code SDK adapter", () => {
	it("maps the parent's effective tool surface without widening restricted tools", () => {
		expect(claudeCodeNativeTools(["ipython"])).toEqual([
			"Read",
			"Grep",
			"Glob",
			"Bash",
			"Edit",
			"Write",
			"WebSearch",
		]);
		expect(claudeCodeNativeTools(["read", "bash"])).toEqual(["Read", "Bash"]);
		expect(claudeCodeNativeTools(["attach_image"])).toEqual([]);
	});

	it("projects exact executable-owned query options and streamed user input", async () => {
		let params: Parameters<ClaudeCodeSdkQuery>[0] | undefined;
		const close = vi.fn();
		const sdkQuery: ClaudeCodeSdkQuery = (nextParams) => {
			params = nextParams;
			const messages = (async function* (): AsyncGenerator<SDKMessage> {})();
			return Object.assign(messages, { close }) as unknown as ReturnType<ClaudeCodeSdkQuery>;
		};
		const start = createClaudeCodeQueryStarter(sdkQuery);
		const prompt = (async function* () {
			yield "hello";
		})();
		const abortController = new AbortController();
		const query = await start({
			prompt,
			model: "claude-opus-4-7",
			effort: "high",
			executable: "/opt/claude",
			cwd: "/work",
			appendSystemPrompt: "coordination",
			tools: ["Read", "Edit"],
			allowedTools: ["Read", "Edit"],
			disallowedTools: ["Agent", "Task", "SendMessage"],
			abortController,
		});
		expect(params?.options).toMatchObject({
			model: "claude-opus-4-7",
			effort: "high",
			cwd: "/work",
			pathToClaudeCodeExecutable: "/opt/claude",
			settingSources: [],
			tools: ["Read", "Edit"],
			allowedTools: ["Read", "Edit"],
			disallowedTools: ["Agent", "Task", "SendMessage"],
			permissionMode: "dontAsk",
			systemPrompt: { type: "preset", preset: "claude_code", append: "coordination" },
		});
		const projectedPrompt = params?.prompt;
		if (!projectedPrompt || typeof projectedPrompt === "string") throw new Error("expected streamed prompt");
		await expect(projectedPrompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({
			done: false,
			value: {
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
				origin: { kind: "coordinator" },
				priority: "next",
				shouldQuery: true,
			},
		});
		query.close();
		expect(close).toHaveBeenCalledOnce();
	});

	it("maps init, assistant, result usage, and stream closure", async () => {
		const messages = (async function* (): AsyncGenerator<SDKMessage> {
			yield {
				type: "system",
				subtype: "init",
				model: "claude-opus-4-7",
				tools: ["Read"],
				claude_code_version: "1.0",
				session_id: "session-1",
			} as unknown as SDKMessage;
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "working" }], usage: { input_tokens: 3, output_tokens: 2 } },
			} as unknown as SDKMessage;
			yield {
				type: "result",
				subtype: "success",
				is_error: false,
				result: "done",
				usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
				total_cost_usd: 0.02,
				num_turns: 1,
			} as unknown as SDKMessage;
		})();
		const mapped: ClaudeCodeEvent[] = [];
		for await (const event of mapClaudeCodeSdkMessages(messages)) mapped.push(event);
		expect(mapped).toEqual([
			{ kind: "init", model: "claude-opus-4-7", tools: ["Read"], version: "1.0", sessionId: "session-1" },
			{ kind: "assistant", text: "working", usage: expect.objectContaining({ input: 3, output: 2 }) },
			{ kind: "result", isError: false, text: "done", usage },
			{ kind: "close" },
		]);
	});
});

describe("Claude Code runtime", () => {
	it("retains one query for an ordered follow-up and projects result usage", async () => {
		const harness = runtimeHarness();
		await harness.runtime.start();
		expect(harness.request()).toMatchObject({
			model: "claude-opus-4-7",
			effort: "high",
			executable: "/opt/claude",
			cwd: "/work",
			appendSystemPrompt: CLAUDE_CODE_COORDINATION_PROMPT,
			tools: ["Read", "Edit"],
			disallowedTools: ["Agent", "Task", "SendMessage"],
		});
		await expect(harness.input().next()).resolves.toEqual({ done: false, value: "initial task" });
		harness.events.push({
			kind: "init",
			model: "claude-opus-4-7",
			tools: ["Read", "Edit"],
			version: "1.0",
			sessionId: "session-1",
		});
		harness.events.push({ kind: "assistant", text: "working", usage });
		harness.events.push({ kind: "tool-progress", toolUseId: "tool-1", toolName: "Read", elapsedSeconds: 1 });
		harness.events.push({ kind: "result", isError: false, text: "done", usage });
		await expect(harness.runtime.initialCompletion).resolves.toMatchObject({
			status: "done",
			sessionId: "session-1",
			answerPreview: "done",
			toolUseCount: 1,
			usage,
			closed: false,
		});
		expect(harness.runtime.deliver("follow up")).toBe("woken");
		await expect(harness.input().next()).resolves.toEqual({ done: false, value: "follow up" });
		harness.events.push({ kind: "result", isError: false, text: "follow-up done", usage });
		await vi.waitFor(() => expect(harness.runtime.snapshot.answerPreview).toBe("follow-up done"));
		expect(harness.runtime.snapshot.usage.totalTokens).toBe(34);
		expect(harness.close).not.toHaveBeenCalled();
		harness.runtime.dispose();
		harness.runtime.dispose();
		expect(harness.close).toHaveBeenCalledOnce();
	});

	it("closes exactly once on invalid init, startup failure, and cancellation", async () => {
		const invalid = runtimeHarness();
		await invalid.runtime.start();
		invalid.events.push({
			kind: "init",
			model: "claude-opus-4-7",
			tools: ["Agent"],
			version: "1.0",
			sessionId: "session-invalid",
		});
		await expect(invalid.runtime.initialCompletion).resolves.toMatchObject({
			status: "error",
			error: "Claude Code exposed denied tools: Agent",
		});
		invalid.runtime.dispose();
		expect(invalid.close).toHaveBeenCalledOnce();

		const startup = new ClaudeCodeRuntime({
			prompt: "task",
			model: "claude",
			executable: "/opt/claude",
			cwd: "/work",
			tools: ["Read"],
			startQuery: async () => {
				throw new Error("startup failed");
			},
		});
		await startup.start();
		await expect(startup.initialCompletion).resolves.toMatchObject({ status: "error", error: "startup failed" });
		expect(startup.snapshot.closed).toBe(true);

		const cancelled = runtimeHarness();
		await cancelled.runtime.start();
		cancelled.runtime.abort("deleted");
		cancelled.runtime.abort("again");
		await expect(cancelled.runtime.initialCompletion).resolves.toMatchObject({
			status: "cancelled",
			error: "deleted",
		});
		expect(cancelled.close).toHaveBeenCalledOnce();
	});
});
