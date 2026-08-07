import type {
	AgentConnection,
	AgentConnectionEventListener,
	AgentConnectionSessionEvent,
} from "../../src/modes/agent-connection/types.js";
import { runRpcModeWithConnection } from "../../src/modes/rpc/rpc-mode.js";

let listener: AgentConnectionEventListener = () => {};
let resolveExtensionUi: (() => void) | undefined;
let slowWatcherCount = 0;
let activePrompt: Promise<void> | undefined;

const actUsage = {
	input: 3,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 8,
	cost: { input: 0.003, output: 0.005, cacheRead: 0, cacheWrite: 0, total: 0.008 },
};

function actEvents(actId: string, status: "done" | "error" | "cancelled"): AgentConnectionSessionEvent[] {
	const outerToolCallId = `outer-${actId}`;
	return [
		{
			type: "act_event",
			actId,
			outerToolCallId,
			sequence: 1,
			event: "start",
			prompt: `prompt ${actId}`,
			promptTruncated: false,
			model: { provider: "test", id: "test-model" },
			cancellationCapability: "posix-managed",
		},
		{
			type: "act_event",
			actId,
			outerToolCallId,
			sequence: 2,
			event: "assistant_delta",
			stream: "text",
			text: `working ${actId}`,
			textTruncated: false,
		},
		{
			type: "act_event",
			actId,
			outerToolCallId,
			sequence: 3,
			event: "cell_start",
			cellId: "cell-1",
			code: "answer = object()",
			codeTruncated: false,
		},
		{
			type: "act_event",
			actId,
			outerToolCallId,
			sequence: 4,
			event: "cell_terminal",
			cellId: "cell-1",
			status: status === "cancelled" ? "cancelled" : status === "error" ? "error" : "ok",
			stdout: "",
			stdoutTruncated: false,
			stderr: "",
			stderrTruncated: false,
			resultTruncated: false,
			...(status === "error" ? { error: "cell failed" } : {}),
			errorTruncated: false,
		},
		{
			type: "act_event",
			actId,
			outerToolCallId,
			sequence: 5,
			event: "terminal",
			status,
			prompt: `prompt ${actId}`,
			promptTruncated: false,
			model: { provider: "test", id: "test-model" },
			cancellationCapability: "posix-managed",
			usage: actUsage,
			...(status === "error" ? { error: "provider failed" } : {}),
			errorTruncated: false,
		},
	];
}

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
		if (message === "act-stream") {
			for (const event of actEvents("main-act", "done")) {
				await listener({ type: "session_event", event });
			}
			return;
		}
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
				if (activeSessionId === "act-child") {
					for (const event of [
						...actEvents("observed-error", "error"),
						...actEvents("observed-cancel", "cancelled"),
					]) {
						void next({ type: "session_event", event });
					}
				} else {
					void next({ type: "session_event", event: { type: "agent_start" } });
				}
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
