import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionState } from "../../../src/modes/agent-connection/types.js";
import type { DaemonClientMessageListener, DaemonTransportClient } from "../../../src/modes/daemon/daemon-client.js";
import type { DaemonCommand } from "../../../src/modes/daemon/daemon-protocol.js";

async function createConnection(modelCatalog = true, deferSessionEvents = false) {
	const messages: AgentMessage[] = [{ role: "user", content: "saved transcript", timestamp: 1 }];
	const updatedMessages: AgentMessage[] = [{ role: "user", content: "updated transcript", timestamp: 2 }];
	const model = getModel("xai", "grok-4.5");
	const state = { sessionId: "session", model, thinkingLevel: "high", serviceTier: "default" } as AgentConnectionState;
	const refreshedState = { ...state, model: { ...model, api: "openai-responses" }, thinkingLevel: "low" };
	let listener: DaemonClientMessageListener | undefined;
	let duringStateRead: (() => void) | undefined;
	const request = vi.fn(async (command: Pick<DaemonCommand, "type">) => {
		if (command.type === "get_connection_state") duringStateRead?.();
		const data = {
			attach: {
				activeSessionId: "active",
				snapshot: {
					state,
					messages,
					sessionContext: { messages, thinkingLevel: "high" },
					summary: { sessionId: "session" },
				},
			},
			get_model_catalog: { models: [model], configuredProviders: ["xai"] },
			get_available_models: { models: [model] },
			get_connection_state: refreshedState,
			get_messages: { messages: updatedMessages },
			get_session_context: { context: { messages: updatedMessages } },
		};
		return { type: "response", command: command.type, success: true, data: data[command.type as keyof typeof data] };
	});
	const client = {
		request,
		onMessage: (callback: DaemonClientMessageListener) => {
			listener = callback;
			return () => {};
		},
		onClose: () => () => {},
		supportsServerCapability: () => modelCatalog,
	} as unknown as DaemonTransportClient;
	const connection = new DaemonAgentConnection(client, "active", { deferSessionEvents });
	await connection.attach();
	return {
		connection,
		request,
		messages,
		updatedMessages,
		refreshedState,
		setDuringStateRead: (callback: (() => void) | undefined) => {
			duringStateRead = callback;
		},
		emitStatus: (recap: string) => listener?.({ type: "session_status", activeSessionId: "active", recap }),
		emit: () =>
			listener?.({
				type: "session_event",
				activeSessionId: "active",
				event: { type: "message_end", message: updatedMessages[0]! },
			}),
	};
}

describe("model catalog refresh preserves the attached transcript", () => {
	it.each(["catalog", "legacyCatalog", "available"])(
		"refreshes model state without downloading messages after %s",
		async (refresh) => {
			const { connection, request, messages, refreshedState } = await createConnection(refresh !== "legacyCatalog");
			try {
				if (refresh === "available") await connection.getAvailableModels();
				else await connection.getModelCatalog();
				expect(await connection.getState()).toBe(refreshedState);
				const snapshot = await connection.getInitialSnapshot();
				expect(snapshot.state).toBe(refreshedState);
				expect(snapshot.messages).toBe(messages);
				expect(snapshot.sessionContext).toMatchObject({
					messages,
					thinkingLevel: "low",
					model: { provider: "xai", modelId: refreshedState.model.id },
				});
				expect(request.mock.calls.map(([command]) => command.type)).not.toContain("get_messages");
				expect(request.mock.calls.map(([command]) => command.type)).not.toContain("get_session_context");
				request.mockClear();
				expect(await connection.getInitialSnapshot()).toBe(snapshot);
				expect(await connection.getState()).toBe(snapshot.state);
				expect(await connection.getSessionContext()).toBe(snapshot.sessionContext);
				expect(request).not.toHaveBeenCalled();
			} finally {
				await connection.dispose();
			}
		},
	);

	it("still reloads the transcript after a session mutation", async () => {
		const { connection, request, updatedMessages } = await createConnection();
		try {
			await connection.getModelCatalog();
			await connection.setThinkingLevel("medium");
			const snapshot = await connection.getInitialSnapshot();
			expect(snapshot.messages).toBe(updatedMessages);
			expect(request.mock.calls.map(([command]) => command.type)).toContain("get_messages");
			request.mockClear();
			expect(await connection.getInitialSnapshot()).toBe(snapshot);
			expect(await connection.getState()).toBe(snapshot.state);
			expect(await connection.getSessionContext()).toBe(snapshot.sessionContext);
			expect(request).not.toHaveBeenCalled();
		} finally {
			await connection.dispose();
		}
	});

	it("keeps a concurrent recap update without downloading the transcript", async () => {
		const { connection, request, messages, emitStatus, setDuringStateRead } = await createConnection();
		try {
			await connection.getModelCatalog();
			setDuringStateRead(() => emitStatus("Updated recap"));
			request.mockClear();
			const snapshot = await connection.getInitialSnapshot();
			expect(snapshot.messages).toBe(messages);
			expect(snapshot.state.recap).toBe("Updated recap");
			expect(await connection.getInitialSnapshot()).toBe(snapshot);
			expect(request.mock.calls.map(([command]) => command.type)).toEqual(["get_connection_state"]);
		} finally {
			await connection.dispose();
		}
	});

	it("preserves deferred updates and invalidates the transcript when they replay", async () => {
		const { connection, messages, updatedMessages, emit } = await createConnection(true, true);
		try {
			await connection.getModelCatalog();
			emit();
			expect((await connection.getInitialSnapshot()).messages).toBe(messages);
			await connection.flushBufferedSessionEvents();
			expect((await connection.getInitialSnapshot()).messages).toBe(updatedMessages);
		} finally {
			await connection.dispose();
		}
	});

	it("reloads if a live event invalidates the transcript during the state refresh", async () => {
		const { connection, updatedMessages, emit, setDuringStateRead } = await createConnection();
		try {
			await connection.getModelCatalog();
			setDuringStateRead(emit);
			expect((await connection.getInitialSnapshot()).messages).toBe(updatedMessages);
		} finally {
			await connection.dispose();
		}
	});

	it("keeps state stale when a catalog refresh lands during the state re-read", async () => {
		const { connection, request, messages, refreshedState, setDuringStateRead } = await createConnection();
		try {
			await connection.getModelCatalog();
			setDuringStateRead(() => void connection.getAvailableModels());
			const snapshot = await connection.getInitialSnapshot();
			expect(snapshot.messages).toBe(messages);
			// The concurrent catalog refresh must preserve the invalidation: getState()
			// re-reads state instead of trusting the merged snapshot's state.
			expect(await connection.getState()).toBe(refreshedState);
			expect(request.mock.calls.filter(([command]) => command.type === "get_connection_state")).toHaveLength(2);
			setDuringStateRead(undefined);
			const merged = await connection.getInitialSnapshot();
			expect(merged.state).toBe(refreshedState);
			expect(await connection.getInitialSnapshot()).toBe(merged);
			expect(await connection.getState()).toBe(merged.state);
			expect(request.mock.calls.filter(([command]) => command.type === "get_connection_state")).toHaveLength(3);
			expect(request.mock.calls.filter(([command]) => command.type === "get_messages")).toHaveLength(0);
			expect(request.mock.calls.filter(([command]) => command.type === "get_session_context")).toHaveLength(0);
		} finally {
			await connection.dispose();
		}
	});

	it("keeps state stale when a catalog refresh lands during a full snapshot reload", async () => {
		const { connection, request, updatedMessages, refreshedState, setDuringStateRead } = await createConnection();
		try {
			await connection.getModelCatalog();
			await connection.setThinkingLevel("medium");
			setDuringStateRead(() => void connection.getAvailableModels());
			const snapshot = await connection.getInitialSnapshot();
			expect(snapshot.messages).toBe(updatedMessages);
			// The concurrent catalog refresh must preserve the invalidation even
			// though the transcript cursor guard passed: getState() re-reads state.
			expect(await connection.getState()).toBe(refreshedState);
			expect(request.mock.calls.filter(([command]) => command.type === "get_connection_state")).toHaveLength(2);
			setDuringStateRead(undefined);
			const merged = await connection.getInitialSnapshot();
			expect(merged.messages).toBe(updatedMessages);
			expect(await connection.getInitialSnapshot()).toBe(merged);
			expect(request.mock.calls.filter(([command]) => command.type === "get_messages")).toHaveLength(1);
			expect(request.mock.calls.filter(([command]) => command.type === "get_session_context")).toHaveLength(1);
		} finally {
			await connection.dispose();
		}
	});
});
