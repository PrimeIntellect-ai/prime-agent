import type { AgentConnection, AgentConnectionEventListener } from "../../src/modes/agent-connection/types.js";
import { runRpcModeWithConnection } from "../../src/modes/rpc/rpc-mode.js";

let listener: AgentConnectionEventListener = () => {};
let resolveExtensionUi: (() => void) | undefined;
let slowWatcherCount = 0;
let activePrompt: Promise<void> | undefined;

const heartbeat = {
	id: "heartbeat-1",
	status: "active" as const,
	source: "heartbeat" as const,
	activeSessionId: "root-session",
	sessionId: "root",
	sessionFile: "/tmp/root.jsonl",
	cwd: "/tmp",
	prompt: "check status",
	schedule: { kind: "interval" as const, expression: "every 1h", intervalMs: 3_600_000 },
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	runCount: 0,
};

const connection = {
	subscribe(next: AgentConnectionEventListener) {
		listener = next;
		return () => {};
	},
	async prompt(message: string) {
		if (message === "async-eof") {
			activePrompt = (async () => {
				await listener({ type: "session_event", event: { type: "agent_start" } });
				await new Promise((resolve) => setTimeout(resolve, 50));
				await listener({ type: "session_event", event: { type: "agent_end", messages: [] } });
			})();
			return;
		}
		if (message === "extension-ui") {
			await new Promise<void>((resolve) => {
				resolveExtensionUi = resolve;
				void listener({
					type: "extension_ui_request",
					request: {
						id: "extension-ui-1",
						method: "confirm",
						payload: { title: "Confirm", message: "Continue?" },
					},
				});
			});
		}
		await listener({ type: "session_event", event: { type: "agent_start" } });
		await new Promise((resolve) => setTimeout(resolve, 10));
	},
	async respondToExtensionUiRequest(id: string) {
		if (id === "extension-ui-1") {
			resolveExtensionUi?.();
			resolveExtensionUi = undefined;
		}
	},
	async getAvailableModels() {
		await new Promise((resolve) => setTimeout(resolve, 25));
		return [];
	},
	async waitForIdle() {
		await activePrompt;
	},
	async getMessages() {
		return [{ role: "user" as const, content: "x".repeat(1024 * 1024), timestamp: 1 }];
	},
	async getLastAssistantText() {
		return undefined;
	},
	async setSessionName(name: string) {
		if (name !== name.trim()) {
			throw new Error("Session name was not trimmed");
		}
	},
	async listCronJobs() {
		return [heartbeat];
	},
	async listHeartbeats() {
		return [{ job: heartbeat }];
	},
	async getAgentMessageStatus() {
		return {
			paused: false,
			maxMessageChars: 16384,
			maxPendingPerSession: 20,
			rateLimitCapacity: 3,
			rateLimitRefillMs: 1000,
		};
	},
	async sendAgentMessage(targetActiveSessionId: string, message: string) {
		return {
			id: "message-1",
			source: "agent_message" as const,
			target: { activeSessionId: targetActiveSessionId, sessionId: "target" },
			message,
			deliveryStatus: "delivered" as const,
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto" as const,
		};
	},
	async watchSession(activeSessionId: string) {
		const watcherIndex = activeSessionId === "slow-child" ? slowWatcherCount++ : -1;
		return {
			async getMessages() {
				if (watcherIndex === 0) {
					await new Promise((resolve) => setTimeout(resolve, 30));
				}
				return [{ role: "user" as const, content: "child message", timestamp: 1 }];
			},
			subscribe(next: AgentConnectionEventListener) {
				void next({ type: "session_event", event: { type: "agent_start" } });
				return () => {};
			},
			async getToolDefinition() {
				return undefined;
			},
			async close() {},
		};
	},
	async dispose() {},
} as unknown as AgentConnection;

await runRpcModeWithConnection(connection);
