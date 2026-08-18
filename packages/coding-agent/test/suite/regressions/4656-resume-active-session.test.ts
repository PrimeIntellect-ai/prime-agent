import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { DaemonAgentConnection } from "../../../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionEvent, AgentConnectionState } from "../../../src/modes/agent-connection/types.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import type {
	DaemonClient,
	DaemonClientCloseListener,
	DaemonClientMessageListener,
} from "../../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	type DaemonResponse,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

const sourceActiveSessionId = "source-active";
const targetActiveSessionId = "target-active";

class ResumeDaemonClient {
	readonly requests: DaemonCommand[] = [];
	private readonly messageListeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();

	constructor(private readonly switchTarget = targetActiveSessionId) {}

	async request(command: DaemonCommand): Promise<DaemonResponse> {
		this.requests.push(command);
		if (command.type === "attach") {
			return {
				type: "response",
				command: command.type,
				success: true,
				data: createAttachResult(command.activeSessionId),
			};
		}
		if (command.type === "switch_session") {
			return {
				type: "response",
				command: command.type,
				success: false,
				error: `Session is already active in ${this.switchTarget}: ${command.sessionPath}`,
				errorInfo: {
					code: "session_already_active",
					sessionPath: command.sessionPath,
					activeSessionId: this.switchTarget,
				},
			};
		}
		if (command.type === "reattach") {
			const result = createAttachResult(command.targetActiveSessionId, [
				{ role: "user", content: "target prompt", timestamp: 2 },
			]);
			const snapshotId = "target-snapshot";
			const { messages, ...snapshot } = result.snapshot;
			this.emitMessage({
				type: "session_snapshot_begin",
				activeSessionId: command.targetActiveSessionId,
				snapshotId,
				snapshot,
				messageCount: messages.length,
				targetChunkBytes: 512 * 1024,
				purpose: "replacement",
			});
			this.emitMessage({
				type: "session_snapshot_chunk",
				activeSessionId: command.targetActiveSessionId,
				snapshotId,
				index: 0,
				messages,
			});
			this.emitMessage({
				type: "session_snapshot_end",
				activeSessionId: command.targetActiveSessionId,
				snapshotId,
				chunkCount: 1,
				lastEventSequence: result.lastEventSequence,
				lastEventCursor: result.lastEventCursor,
			});
			return {
				type: "response",
				command: command.type,
				success: true,
				data: {
					...result,
					snapshot: { ...result.snapshot, messages: [] },
					snapshotStream: {
						id: snapshotId,
						messageCount: messages.length,
						targetChunkBytes: 512 * 1024,
					},
				},
			};
		}
		if (command.type === "detach") {
			return { type: "response", command: command.type, success: true };
		}
		throw new Error(`Unexpected command: ${command.type}`);
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	emitMessage(message: DaemonOutbound): void {
		for (const listener of this.messageListeners) {
			listener(message);
		}
	}

	close(): void {}
}

function createConnectionState(activeSessionId: string): AgentConnectionState {
	return {
		activeSessionId,
		cwd: "/tmp/project",
		model: undefined,
		thinkingLevel: "medium",
		serviceTier: "default",
		availableThinkingLevels: ["minimal", "low", "medium", "high", "xhigh"],
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: `/tmp/${activeSessionId}.jsonl`,
		sessionId: `${activeSessionId}-session`,
		sessionDir: "/tmp/sessions",
		leafId: `${activeSessionId}-leaf`,
		autoCompactionEnabled: true,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		goal: { active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 },
		scopedModels: [],
		activeToolNames: [],
		contextUsage: undefined,
	};
}

function createAttachResult(activeSessionId: string, messages: AgentMessage[] = []): DaemonAttachResult {
	const state = createConnectionState(activeSessionId);
	const lastEventCursor = { generation: `generation-${activeSessionId}`, sequence: 3 };
	const summary: SessionSummary = {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: state.sessionId,
		sessionFile: state.sessionFile,
		cwd: state.cwd,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 1,
		messageCount: messages.length,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary,
			state,
			messages,
			lastEventSequence: 3,
			lastEventCursor,
		},
		replay: { status: "complete", toSequence: 3, toCursor: lastEventCursor },
		lastEventSequence: 3,
		lastEventCursor,
		client: {
			id: "client-1",
			capabilities: ["attach_snapshot", "event_sequence", "chunked_snapshot"],
		},
	};
}

function asDaemonClient(client: ResumeDaemonClient): DaemonClient {
	return client as unknown as DaemonClient;
}

function createSocketClient(id: string, attachedActiveSessionIds: string[]): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set(attachedActiveSessionIds),
		detachInput: () => {},
		supportsExtensionUi: true,
		capabilities: new Set(["attach_snapshot", "event_sequence", "extension_ui", "slim_attach", "chunked_snapshot"]),
	};
}

interface SupervisorHarness {
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

describe("ENG-4656 active session resume", () => {
	it("reattaches /resume to the existing worker even when the snapshot arrives with the response", async () => {
		const client = new ResumeDaemonClient();
		const connection = await DaemonAgentConnection.attach(asDaemonClient(client), sourceActiveSessionId);
		const events: AgentConnectionEvent[] = [];
		connection.subscribe((event) => {
			events.push(event);
		});

		await expect(connection.switchSession("/tmp/target-active.jsonl")).resolves.toEqual({ cancelled: false });

		expect(client.requests.map((request) => request.type)).toEqual(["attach", "switch_session", "reattach"]);
		expect(client.requests[2]).toMatchObject({
			type: "reattach",
			activeSessionId: sourceActiveSessionId,
			targetActiveSessionId,
		});
		await expect(connection.getState()).resolves.toMatchObject({
			activeSessionId: targetActiveSessionId,
			sessionId: `${targetActiveSessionId}-session`,
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "session_replaced",
				state: expect.objectContaining({ activeSessionId: targetActiveSessionId }),
			}),
		);
		await connection.dispose();
		expect(client.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: targetActiveSessionId });
	});

	it("keeps other source and target clients attached when one client moves", async () => {
		const movingClient = createSocketClient("moving", [sourceActiveSessionId]);
		const sourcePeer = createSocketClient("source-peer", [sourceActiveSessionId]);
		const targetPeer = createSocketClient("target-peer", [targetActiveSessionId]);
		const operations: string[] = [];
		const targetSummary = createAttachResult(targetActiveSessionId).snapshot.summary;
		const targetWorker = {};
		const releaseReservation = vi.fn(() => operations.push("release"));
		const write = vi.fn((_client: DaemonSocketClient, message: DaemonOutbound) => {
			operations.push(message.type === "response" ? "response" : message.type);
			return true;
		});
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
			clients: new Set([movingClient, sourcePeer, targetPeer]),
			findWorker: vi.fn(async () => ({ worker: targetWorker, summary: targetSummary })),
			reserveSnapshotStream: vi.fn(() => {
				operations.push("reserve");
				return releaseReservation;
			}),
			attachClient: vi.fn(async (client: DaemonSocketClient) => {
				expect(client.attachedActiveSessionIds.has(targetActiveSessionId)).toBe(true);
				operations.push("attach");
				client.attachedActiveSessionIds.add(targetActiveSessionId);
				return { worker: targetWorker, result: createAttachResult(targetActiveSessionId) };
			}),
			getOrCreateTranscriptCache: vi.fn(() => ({})),
			createStreamedAttachResult: vi.fn((result: DaemonAttachResult) => ({
				...result,
				snapshotStream: { id: "snapshot-1", messageCount: 0, targetChunkBytes: 512 * 1024 },
			})),
			streamSnapshot: vi.fn(async () => {
				operations.push("stream");
				releaseReservation();
			}),
			matchWorkers: vi.fn(() => []),
			dropPendingReplacementSnapshot: vi.fn(),
			syncWorkerExtensionUi: vi.fn(async () => undefined),
			write,
			log: vi.fn(),
		}) as SupervisorHarness;

		await supervisor.handleCommand(movingClient, {
			type: "reattach",
			activeSessionId: sourceActiveSessionId,
			targetActiveSessionId,
			capabilities: [...movingClient.capabilities],
		});

		expect([...movingClient.attachedActiveSessionIds]).toEqual([targetActiveSessionId]);
		expect([...sourcePeer.attachedActiveSessionIds]).toEqual([sourceActiveSessionId]);
		expect([...targetPeer.attachedActiveSessionIds]).toEqual([targetActiveSessionId]);
		expect(operations).toEqual(["reserve", "attach", "response", "session_detached", "stream", "release"]);
	});

	it("leaves repeated --resume clients independently attached to the same worker", async () => {
		const firstClient = new ResumeDaemonClient();
		const secondClient = new ResumeDaemonClient();
		const [first, second] = await Promise.all([
			DaemonAgentConnection.attach(asDaemonClient(firstClient), targetActiveSessionId),
			DaemonAgentConnection.attach(asDaemonClient(secondClient), targetActiveSessionId),
		]);

		expect(firstClient.requests.map((request) => request.type)).toEqual(["attach"]);
		expect(secondClient.requests.map((request) => request.type)).toEqual(["attach"]);
		await Promise.all([first.dispose(), second.dispose()]);
		expect(firstClient.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: targetActiveSessionId });
		expect(secondClient.requests.at(-1)).toMatchObject({ type: "detach", activeSessionId: targetActiveSessionId });
	});
});
