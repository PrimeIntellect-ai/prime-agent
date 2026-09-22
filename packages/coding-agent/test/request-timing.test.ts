import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	type LogEntry,
	type Message,
	type Model,
	registerFauxProvider,
	setLogSink,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { instrumentConvertToLlm, instrumentStreamFn, instrumentTransformContext } from "../src/core/request-timing.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const model = {
	id: "bench/bench-model",
	api: "openai-completions",
	provider: "bench",
	baseUrl: "https://bench.test/v1",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 128_000,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.2 },
} as unknown as Model<"openai-completions">;
const PAYLOAD = { messages: [{ role: "user", content: "hello \u{1F680}" }] };

function finalMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "hm" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 800_000,
			output: 12,
			cacheRead: 790_000,
			cacheWrite: 0,
			totalTokens: 800_012,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function createGate() {
	let open!: () => void;
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

function scriptedProvider(
	gates: Record<"response" | "firstToken" | "done", { promise: Promise<void> }>,
	onResponse: boolean,
): StreamFn {
	return async (_model, _context, options) => {
		const stream = createAssistantMessageEventStream();
		await options?.onPayload?.(PAYLOAD, model);
		void (async () => {
			await gates.response.promise;
			if (onResponse) await options?.onResponse?.({ status: 200, headers: {} }, model);
			const partial = { ...finalMessage() };
			stream.push({ type: "start", partial });
			await gates.firstToken.promise;
			stream.push({ type: "thinking_start", contentIndex: 0, partial });
			await gates.done.promise;
			stream.push({ type: "done", reason: "stop", message: finalMessage() });
		})();
		return stream;
	};
}

async function drain(stream: AssistantMessageEventStream): Promise<void> {
	for await (const _event of stream) {
		// Consume everything the provider emits.
	}
}

async function runTimedRequest(streamFn: StreamFn): Promise<AssistantMessageEventStream> {
	const enabled = () => true;
	const transform = instrumentTransformContext(enabled, async (messages) => messages);
	const convert = instrumentConvertToLlm(enabled, (messages) => messages as unknown as Message[]);
	const input = [{ role: "user", content: "hello" } as unknown as AgentMessage];
	const llmMessages = convert(await transform(input));
	return instrumentStreamFn(enabled, streamFn)(model, {
		systemPrompt: "",
		messages: llmMessages,
		sessionId: "sess-timing",
	} as never);
}

describe("request timing", () => {
	let entries: LogEntry[];
	const originalEnv = process.env.PI_REQUEST_TIMING;
	beforeEach(() => {
		entries = [];
		setLogSink((entry) => entries.push(entry));
		delete process.env.PI_REQUEST_TIMING;
	});
	afterEach(() => {
		setLogSink(undefined);
		process.env.PI_REQUEST_TIMING = originalEnv;
	});
	const timingEntries = () =>
		entries.filter((entry) => entry.component === "coding-agent.request-timing") as Array<Record<string, any>>;

	it.each([
		["first-byte from onResponse", true],
		["first-byte from the start event when onResponse is omitted", false],
	])("%s", async (_name, onResponse: boolean) => {
		vi.useFakeTimers();
		try {
			const gates = { response: createGate(), firstToken: createGate(), done: createGate() };
			const stream = await runTimedRequest(scriptedProvider(gates, onResponse));
			// Attach the rejection handler before advancing timers per the race-test convention.
			const consumed = drain(stream);
			consumed.catch(() => undefined);
			await vi.advanceTimersByTimeAsync(25);
			gates.response.open();
			await vi.advanceTimersByTimeAsync(0); // flush at t=25
			await vi.advanceTimersByTimeAsync(10);
			gates.firstToken.open();
			await vi.advanceTimersByTimeAsync(0); // flush at t=35
			await vi.advanceTimersByTimeAsync(5);
			gates.done.open();
			await consumed;
		} finally {
			vi.useRealTimers();
		}
		const timing = timingEntries();
		expect(timing.map((entry) => entry.phase).join(",")).toBe(
			"prompt-built,request-sent,first-byte,first-token,stream-done",
		);
		expect(new Set(timing.map((entry) => entry.requestSeq)).size).toBe(1);
		expect(timing.at(-1)).toMatchObject({
			outcome: "done",
			contextEntries: 1,
			requestBytes: Buffer.byteLength(JSON.stringify(PAYLOAD)),
			usage: { input: 800_000, output: 12, cacheRead: 790_000, cacheWrite: 0 },
			phases: {
				dispatchToPromptBuiltMs: 0,
				promptBuiltToRequestSentMs: 0,
				requestSentToFirstByteMs: 25,
				firstByteToFirstTokenMs: 10,
				firstTokenToStreamDoneMs: 5,
			},
			totalMs: 40,
		});
	});

	it("measures the payload exactly once when enabled and never when disabled", async () => {
		const seenOptions: unknown[] = [];
		const probes: number[] = [];
		const baseStreamFn: StreamFn = async (_model, _context, options) => {
			seenOptions.push(options);
			const probe = {
				toJSON: () => {
					probes.push(1);
					return PAYLOAD;
				},
			};
			await options?.onPayload?.(probe, model);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: "stop", message: finalMessage() });
			return stream;
		};
		const plainOptions = { sessionId: "sess-off" };
		await drain(await instrumentStreamFn(() => false, baseStreamFn)(model, {} as Context, plainOptions));
		expect(seenOptions[0]).toBe(plainOptions);
		expect(probes).toHaveLength(0);
		expect(timingEntries()).toHaveLength(0);
		// Enabled: serialized once; the size lands on later entries, not request-sent.
		await drain(await instrumentStreamFn(() => true, baseStreamFn)(model, {} as Context, {}));
		expect(probes).toHaveLength(1);
		const enabled = timingEntries();
		expect(enabled.find((entry) => entry.phase === "request-sent")!.requestBytes).toBeUndefined();
		expect(enabled.at(-1)!.requestBytes).toBe(Buffer.byteLength(JSON.stringify(PAYLOAD)));
	});

	it("reports provider failures as failed instead of losing the timeline", async () => {
		const partial = { ...finalMessage(), content: [] };
		const crashing = async () =>
			({
				async *[Symbol.asyncIterator]() {
					yield { type: "start", partial } as never;
					throw new Error("socket hang up");
				},
			}) as never;
		const crashed = drain(await instrumentStreamFn(() => true, crashing)(model, {} as Context, {}));
		await expect(crashed).rejects.toThrow("socket hang up");
		expect(timingEntries().at(-1)).toMatchObject({
			phase: "stream-done",
			outcome: "failed",
			errorMessage: "socket hang up",
		});

		const errorEvent = async () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() =>
				stream.push({
					type: "error",
					reason: "error",
					error: { ...finalMessage(), stopReason: "error", errorMessage: "provider exploded" },
				}),
			);
			return stream;
		};
		await drain(await instrumentStreamFn(() => true, errorEvent)(model, {} as Context, {}));
		expect(timingEntries().at(-1)).toMatchObject({
			phase: "stream-done",
			outcome: "failed",
			stopReason: "error",
			errorMessage: "provider exploded",
		});
	});

	it("pins the sdk wiring: faux sessions emit the timeline only when the flag is on", async () => {
		// Isolate the ambient agent dir so the harness digest renders empty state.
		const dir = join(tmpdir(), `pi-request-timing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(dir, { recursive: true });
		const ambientAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
		const created: AgentSession[] = [];
		try {
			// Flag on: faux never calls onPayload, so request-sent is absent and unmeasured phases are omitted.
			await promptOnFauxSession(dir, true, created);
			expect(
				timingEntries()
					.map((entry) => entry.phase)
					.join(","),
			).toBe("prompt-built,first-byte,first-token,stream-done");
			expect(timingEntries().at(-1)).toMatchObject({
				outcome: "done",
				sessionId: created[0].sessionManager.getSessionId(),
			});
		} finally {
			for (const session of created) session.dispose();
			rmSync(dir, { recursive: true, force: true });
			process.env.PRIME_AGENT_CODING_AGENT_DIR = ambientAgentDir;
		}
	});
});

async function promptOnFauxSession(dir: string, requestTiming: boolean, created: AgentSession[]) {
	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("ok")]);
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		model: faux.getModel(),
		authStorage,
		modelRegistry: ModelRegistry.create(authStorage, join(dir, "models.json")),
		sessionManager: SessionManager.inMemory(dir),
		settingsManager: SettingsManager.inMemory({ requestTiming }),
	});
	created.push(session);
	await session.prompt("hello");
	faux.unregister();
}
