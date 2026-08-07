import type { SessionUpdate } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import type { ActProjectionEvent } from "../src/core/act-events.js";
import { actToolCallId } from "../src/modes/acp/acp-events.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/index.js";
import type {
	AgentConnection,
	AgentConnectionEvent,
	AgentConnectionEventListener,
} from "../src/modes/agent-connection/types.js";

const usage = {
	input: 3,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 5,
	cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
};

function actEvents(): ActProjectionEvent[] {
	const base = { type: "act_event" as const, actId: "act-sdk", outerToolCallId: "outer-sdk" };
	return [
		{
			...base,
			sequence: 1,
			event: "start",
			prompt: "use the retained kernel",
			promptTruncated: false,
			model: { provider: "test", id: "model-sdk" },
			cancellationCapability: "posix-managed",
		},
		{
			...base,
			sequence: 2,
			event: "assistant_delta",
			stream: "thinking",
			text: "inspect state",
			textTruncated: false,
		},
		{
			...base,
			sequence: 3,
			event: "terminal",
			status: "done",
			prompt: "use the retained kernel",
			promptTruncated: false,
			model: { provider: "test", id: "model-sdk" },
			cancellationCapability: "posix-managed",
			usage,
			errorTruncated: false,
		},
	];
}

class EventOnlyConnection {
	private readonly listeners = new Set<AgentConnectionEventListener>();

	subscribe(listener: AgentConnectionEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async getState(): Promise<{ cwd: string }> {
		return { cwd: process.cwd() };
	}

	async emit(event: AgentConnectionEvent): Promise<void> {
		for (const listener of this.listeners) await listener(event);
	}
}

describe("ACP Act projection", () => {
	it("delivers standard tool updates that a vanilla ACP client can consume without Prime Agent metadata", async () => {
		const connection = new EventOnlyConnection();
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: SessionUpdate[] = [];
		void runAcpModeWithConnection(
			connection as unknown as AgentConnection,
			{
				stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			} as never,
		);
		const handle = acp
			.client({ name: "vanilla-acp-client" })
			.onNotification("session/update", (ctx) => {
				updates.push(ctx.params.update);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		await handle.agent.request("session/new", { cwd: process.cwd(), mcpServers: [] });
		for (const event of actEvents()) {
			await connection.emit({ type: "session_event", event });
		}
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(updates.map((update) => update.sessionUpdate)).toEqual([
			"tool_call",
			"tool_call_update",
			"tool_call_update",
		]);
		expect(updates.map((update) => (update as { toolCallId?: string }).toolCallId)).toEqual([
			actToolCallId("act-sdk"),
			actToolCallId("act-sdk"),
			actToolCallId("act-sdk"),
		]);
		expect(updates.map((update) => (update as { status?: string }).status)).toEqual([
			"in_progress",
			"in_progress",
			"completed",
		]);

		// A vanilla client reads only standard fields. Removing the reserved
		// metadata leaves a valid and complete ACP tool-call lifecycle.
		const vanilla = updates.map(({ _meta: _ignored, ...update }) => update);
		expect(vanilla).toEqual([
			expect.objectContaining({ sessionUpdate: "tool_call", status: "in_progress" }),
			expect.objectContaining({ sessionUpdate: "tool_call_update", status: "in_progress" }),
			expect.objectContaining({ sessionUpdate: "tool_call_update", status: "completed" }),
		]);
		expect(updates.at(-1)?._meta).toMatchObject({
			[PRIME_AGENT_META_NAMESPACE]: {
				act: {
					actId: "act-sdk",
					outerToolCallId: "outer-sdk",
					sequence: 3,
					model: { provider: "test", id: "model-sdk" },
					cancellationCapability: "posix-managed",
					terminalStatus: "done",
					usage,
				},
			},
		});
	}, 10_000);
});
