import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	CompactAssistantStreamReconstructor,
	createCompactAssistantDelta,
} from "../src/modes/daemon/compact-session-stream.js";
import { DAEMON_PROTOCOL_INFO, type DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("compact daemon assistant streaming", () => {
	it("reconstructs the legacy full message_update from start and delta frames", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-1",
			event: { type: "message_start", message: assistant([]) },
		});

		const started = assistant([{ type: "text", text: "" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		expect(startFrame).toBeDefined();
		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { type: "message_update", message: { content: [{ type: "text", text: "" }] } },
		});

		const updated = assistant([{ type: "text", text: "hello" }]);
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: updated },
			},
			meta: {
				id: "active-1:2",
				protocol: DAEMON_PROTOCOL_INFO,
				activeSessionId: "active-1",
				sequence: 2,
				cursor: { generation: "generation-1", sequence: 2 },
				emittedAt: "2026-01-01T00:00:00.000Z",
			},
		});
		if (!deltaFrame) {
			throw new Error("Expected a compact delta frame");
		}
		const reconstructed = reconstructor.reconstruct(deltaFrame);
		expect(reconstructed).toMatchObject({
			type: "session_event",
			activeSessionId: "active-1",
			event: {
				type: "message_update",
				message: { content: [{ type: "text", text: "hello" }] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
			},
			meta: { cursor: { generation: "generation-1", sequence: 2 } },
		});
		expect((reconstructed as Extract<DaemonOutbound, { type: "session_event" }>).event).not.toHaveProperty(
			"assistantMessageEvent.partial",
		);
	});

	it("keeps delta payload size independent of the growing assistant message", () => {
		const text = "x".repeat(1024 * 1024);
		const partial = assistant([{ type: "text", text }]);
		const full: DaemonOutbound = {
			type: "session_event",
			activeSessionId: "active-large",
			event: {
				type: "message_update",
				message: partial,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
			},
		};
		const compact = createCompactAssistantDelta(full);
		expect(compact).toBeDefined();
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(1024);
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(2 * 1024 * 1024);
	});

	it("does not duplicate text already present on a provider start event", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: { type: "message_start", message: assistant([]) },
		});
		const started = assistant([{ type: "text", text: "Hello" }]);
		const startFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: started },
			},
		});
		const deltaFrame = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-start-text",
			event: {
				type: "message_update",
				message: started,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello", partial: started },
			},
		});

		expect(reconstructor.reconstruct(startFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "" }] } },
		});
		expect(reconstructor.reconstruct(deltaFrame!)).toMatchObject({
			event: { message: { content: [{ type: "text", text: "Hello" }] } },
		});
	});

	it("requests resync when a raw suffix follows an authoritative snapshot", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.seed(
			"active-tool",
			assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hel" } }]),
		);
		const updated = assistant([{ type: "toolCall", id: "tool-1", name: "search", arguments: { query: "hello" } }]);
		const snapshot = createCompactAssistantDelta({
			type: "session_event",
			activeSessionId: "active-tool",
			event: {
				type: "message_update",
				message: updated,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: 'lo"}', partial: updated },
			},
		});
		expect(reconstructor.reconstruct(snapshot!)).toBeDefined();
		const rawSuffix = {
			type: "assistant_stream_delta" as const,
			activeSessionId: "active-tool",
			assistantMessageEvent: { type: "toolcall_delta" as const, contentIndex: 0, delta: " " },
		};
		expect(reconstructor.reconstruct(rawSuffix)).toBeUndefined();
	});
	it("reconstructs legacy raw tool deltas incrementally", () => {
		const reconstructor = new CompactAssistantStreamReconstructor();
		reconstructor.observe({
			type: "session_event",
			activeSessionId: "legacy-tool",
			event: { type: "message_start", message: assistant([]) },
		});
		const start = {
			type: "assistant_stream_delta" as const,
			activeSessionId: "legacy-tool",
			contentStart: { type: "toolCall" as const, id: "tool", name: "search", arguments: {} },
			assistantMessageEvent: { type: "toolcall_start" as const, contentIndex: 0 },
		};
		expect(reconstructor.reconstruct(start)).toBeDefined();
		const delta = {
			type: "assistant_stream_delta" as const,
			activeSessionId: "legacy-tool",
			assistantMessageEvent: { type: "toolcall_delta" as const, contentIndex: 0, delta: '{"query":"hello"}' },
		};
		expect(reconstructor.reconstruct(delta)).toMatchObject({
			event: { message: { content: [{ arguments: { query: "hello" } }] } },
		});
		reconstructor.clear("legacy-tool");
		expect(reconstructor.reconstruct(delta)).toBeUndefined();
	});
	it("clears fallback parser state for every compact terminal lifecycle event", () => {
		for (const terminal of ["message_end", "session_replaced", "session_resynced", "session_closed"] as const) {
			const reconstructor = new CompactAssistantStreamReconstructor();
			reconstructor.observe({
				type: "session_event",
				activeSessionId: terminal,
				event: { type: "message_start", message: assistant([]) },
			});
			const start = {
				type: "assistant_stream_delta" as const,
				activeSessionId: terminal,
				contentStart: { type: "toolCall" as const, id: "tool", name: "search", arguments: {} },
				assistantMessageEvent: { type: "toolcall_start" as const, contentIndex: 0 },
			};
			expect(reconstructor.reconstruct(start)).toBeDefined();
			if (terminal === "message_end")
				reconstructor.observe({
					type: "session_event",
					activeSessionId: terminal,
					event: { type: "message_end" },
				} as DaemonOutbound);
			else reconstructor.observe({ type: terminal, activeSessionId: terminal } as DaemonOutbound);
			expect(reconstructor.reconstruct(start)).toBeUndefined();
		}
	});
});
