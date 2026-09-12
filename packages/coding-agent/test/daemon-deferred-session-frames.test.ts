import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon, markClientSnapshotStreaming } from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { type DaemonWorkerFrameHeader, isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import { type PrivateFrame, PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";

const activeSessionId = "active-deferred";
const snapshotId = "snapshot-deferred";

function summary(): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-deferred",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function streamedResult(): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(),
			state: { activeSessionId, sessionId: "session-deferred" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
			lastEventCursor: { generation: "generation-deferred", sequence: 1 },
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		lastEventCursor: { generation: "generation-deferred", sequence: 1 },
		snapshotStream: { id: snapshotId, messageCount: 0, targetChunkBytes: 512 * 1024 },
		client: { id: "client", capabilities: ["chunked_snapshot"] },
	};
}

function sessionEventMessage(sequence: number): DaemonOutbound {
	return {
		type: "session_event",
		activeSessionId,
		event: { type: "session_info_changed", name: `change-${sequence}` },
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			sequence,
			cursor: { generation: "generation-deferred", sequence },
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

function socketClient(socket: PassThrough, extra: Partial<DaemonSocketClient> = {}): DaemonSocketClient {
	return {
		id: "client",
		socket: socket as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot"]),
		...extra,
	} as DaemonSocketClient;
}

async function nextMacroTaskTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

interface SupervisorWorkerHarness {
	descriptor: { workerId: string; lifecycle: "ready"; pid: number };
	client?: { close: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<string, Map<string, unknown>>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	intentionalStop: boolean;
	stopRevision: number;
}

describe("deferred session frames during snapshot streams", () => {
	it.each([1, 2])("worker: replays frames only after all %i queued snapshots complete", async (streamCount) => {
		const daemon = new AgentDaemon(join(tmpdir(), "deferred-frames-worker.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const socket = new PassThrough();
		socket.on("error", () => {});
		const written: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
		const client = socketClient(socket, { transport: "private-framed" });
		const state = {
			activeSessionId,
			clients: new Set([client]),
			eventGeneration: "generation-deferred",
			lastEventSequence: 1,
			runtime: { metadata: { kind: "top-level" as const, createdAt: 1 } },
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: AsyncIterable<Buffer> & { dispose?(): void },
				purpose: "attach",
				signal: AbortSignal,
				snapshotAlreadyMarked: boolean,
			): Promise<void>;
		};
		internals.sessions.set(activeSessionId, state);
		const snapshotSignal = markClientSnapshotStreaming(client, activeSessionId);

		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		async function* gatedTranscript(): AsyncGenerator<Buffer> {
			yield Buffer.from(`{"type":"session_snapshot_chunk"}`);
			await chunkGate;
			yield Buffer.from(`{"type":"session_snapshot_chunk"}`);
		}
		const transcript = gatedTranscript();

		const stream = internals.streamWorkerSnapshot(
			client,
			streamedResult(),
			transcript,
			"attach",
			snapshotSignal,
			true,
		);
		await nextMacroTaskTurn();
		const streams = [stream];
		for (let index = 1; index < streamCount; index++) {
			streams.push(
				internals.streamWorkerSnapshot(
					client,
					streamedResult(),
					gatedTranscript(),
					"attach",
					markClientSnapshotStreaming(client, activeSessionId),
					true,
				),
			);
		}
		// The stream is parked between chunks; events broadcast now are withheld.
		internals.broadcastToSession(state, sessionEventMessage(2));
		internals.broadcastToSession(state, sessionEventMessage(3));
		expect(written.length).toBeGreaterThan(0);

		releaseChunk();
		await Promise.all(streams);

		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(Buffer.concat(written));
		const outboundTypes = frames.map((frame) => (frame.header.kind === "outbound" ? frame.header.outboundType : ""));
		expect(outboundTypes).toEqual([
			...Array.from({ length: streamCount }, () => [
				"session_snapshot_begin",
				"session_snapshot_chunk",
				"session_snapshot_chunk",
				"session_snapshot_end",
			]).flat(),
			"session_event",
			"session_event",
		]);
		const replayed = frames
			.filter((frame) => frame.header.kind === "outbound" && frame.header.outboundType === "session_event")
			.map((frame) => JSON.parse(frame.payload.toString("utf8")));
		expect(replayed).toEqual([
			expect.objectContaining({ event: { type: "session_info_changed", name: "change-2" } }),
			expect.objectContaining({ event: { type: "session_info_changed", name: "change-3" } }),
		]);
		expect(client.catchupActiveSessionIds?.size ?? 0).toBe(0);
		socket.destroy();
	});

	it("worker: falls back to a resync catch-up when the deferral buffer overflows", async () => {
		const daemon = new AgentDaemon(join(tmpdir(), "deferred-frames-overflow.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const socket = new PassThrough();
		socket.on("error", () => {});
		const written: Buffer[] = [];
		socket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
		const client = socketClient(socket, { transport: "private-framed" });
		const state = {
			activeSessionId,
			clients: new Set([client]),
			eventGeneration: "generation-deferred",
			lastEventSequence: 1,
			runtime: { metadata: { kind: "top-level" as const, createdAt: 1 } },
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: AsyncIterable<Buffer> & { dispose?(): void },
				purpose: "attach",
				signal: AbortSignal,
				snapshotAlreadyMarked: boolean,
			): Promise<void>;
			queueClientCatchup(
				client: DaemonSocketClient,
				activeSessionId: string,
				purpose: "replacement" | "resync",
			): void;
		};
		const queueClientCatchup = vi.fn();
		internals.queueClientCatchup = queueClientCatchup;
		internals.sessions.set(activeSessionId, state);
		const snapshotSignal = markClientSnapshotStreaming(client, activeSessionId);

		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		async function* gatedTranscript(): AsyncGenerator<Buffer> {
			yield Buffer.from(`{"type":"session_snapshot_chunk"}`);
			await chunkGate;
			yield Buffer.from(`{"type":"session_snapshot_chunk"}`);
		}
		const transcript = gatedTranscript();

		const stream = internals.streamWorkerSnapshot(
			client,
			streamedResult(),
			transcript,
			"attach",
			snapshotSignal,
			true,
		);
		await nextMacroTaskTurn();
		// MAX_DEFERRED_SESSION_FRAMES is 256: the 257th event overflows, and
		// every later event of the same stream queues a resync catch-up too.
		for (let sequence = 2; sequence <= 2 + 257; sequence++) {
			internals.broadcastToSession(state, sessionEventMessage(sequence));
		}
		releaseChunk();
		await stream;

		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(Buffer.concat(written));
		const outboundTypes = frames.map((frame) => (frame.header.kind === "outbound" ? frame.header.outboundType : ""));
		expect(outboundTypes).toEqual([
			"session_snapshot_begin",
			"session_snapshot_chunk",
			"session_snapshot_chunk",
			"session_snapshot_end",
		]);
		expect(queueClientCatchup).toHaveBeenCalledWith(client, activeSessionId, "resync");
		socket.destroy();
	});

	it.each([false, true])("supervisor: replays payloads only while attached (detached=%s)", async (detached) => {
		const supervisor = new DaemonSupervisor(join(tmpdir(), "deferred-frames-supervisor.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: join(tmpdir(), "deferred-frames-supervisor-state"),
		});
		const worker: SupervisorWorkerHarness = {
			descriptor: { workerId: "worker-deferred", lifecycle: "ready", pid: 987_654 },
			client: { close: vi.fn(), request: vi.fn(async () => ({ success: true })) },
			summaries: new Map([[activeSessionId, summary()]]),
			snapshotCache: new Map<string, DaemonAttachResult>(),
			transcriptCaches: new Map<string, SnapshotTranscriptCache>(),
			snapshotGenerations: new Map<string, Map<string, unknown>>(),
			snapshotLoads: new Map<string, Promise<DaemonAttachResult>>(),
			intentionalStop: false,
			stopRevision: 0,
		};
		const socket = new PassThrough();
		socket.on("error", () => {});
		const written: string[] = [];
		socket.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
		const client = socketClient(socket);
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, SupervisorWorkerHarness>;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: SupervisorWorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach",
			): Promise<void>;
			handleWorkerFrame(worker: SupervisorWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.clients.add(client);
		internals.workers.set(worker.descriptor.workerId, worker);

		const messages: AgentMessage[] = [{ role: "user", content: "stable", timestamp: 1 }];
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId,
			messages,
			cacheRoot: tmpdir(),
		});
		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		const waitForChunk = transcript.waitForChunk.bind(transcript);
		transcript.waitForChunk = async (index: number) => {
			if (index === 1) {
				await chunkGate;
			}
			return waitForChunk(index);
		};

		const stream = internals.streamSnapshot(client, worker, streamedResult(), transcript, "attach");
		await nextMacroTaskTurn();
		// The stream is parked before the end record; relayed frames are withheld.
		internals.handleWorkerFrame(worker, {
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "session_info_changed",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(`${JSON.stringify(sessionEventMessage(2))}\n`),
		});
		internals.handleWorkerFrame(worker, {
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "session_info_changed",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(`${JSON.stringify(sessionEventMessage(3))}\n`),
		});

		if (detached) client.attachedActiveSessionIds.delete(activeSessionId);
		releaseChunk();
		await stream;

		const lines = written.join("").split("\n").filter(Boolean);
		const parsed = lines.map((line) => JSON.parse(line) as { type: string });
		expect(parsed.map((entry) => entry.type)).toEqual([
			"session_snapshot_begin",
			"session_snapshot_chunk",
			"session_snapshot_end",
			...(detached ? [] : ["session_event", "session_event"]),
		]);
		expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
		expect(client.catchupActiveSessionIds?.size ?? 0).toBe(0);
		socket.destroy();
	});

	it.each(["backpressure", "closed", "detached"] as const)("worker: stops replay after %s", async (scenario) => {
		const daemon = new AgentDaemon(join(tmpdir(), "deferred-frames-stop.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const socket = new PassThrough();
		const client = socketClient(socket);
		const written: DaemonOutbound[] = [];
		socket.on("data", (chunk: Buffer) => {
			const message = JSON.parse(chunk.toString("utf8")) as DaemonOutbound;
			written.push(message);
			if (scenario === "backpressure" && message.type === "session_snapshot_end") socket.pause();
		});
		const write = vi.spyOn(socket, "write");
		const state = {
			activeSessionId,
			clients: new Set([client]),
			eventGeneration: "generation-deferred",
			lastEventSequence: 1,
			runtime: { metadata: { kind: "top-level", createdAt: 1 } },
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: AsyncIterable<Buffer>,
				purpose: "attach",
				signal: AbortSignal,
				marked: boolean,
			): Promise<void>;
		};
		internals.sessions.set(activeSessionId, state);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		async function* transcript(): AsyncGenerator<Buffer> {
			await gate;
			yield Buffer.from('{"type":"session_snapshot_chunk"}\n');
		}
		const stream = internals.streamWorkerSnapshot(
			client,
			streamedResult(),
			transcript(),
			"attach",
			markClientSnapshotStreaming(client, activeSessionId),
			true,
		);
		try {
			await nextMacroTaskTurn();
			internals.broadcastToSession(state, {
				...sessionEventMessage(2),
				type: "session_event",
				activeSessionId,
				event: { type: "session_info_changed", name: "x".repeat(128 * 1024) },
			});
			internals.broadcastToSession(state, sessionEventMessage(3));
			if (scenario === "closed")
				internals.broadcastToSession(state, { type: "session_closed", activeSessionId, reason: "killed" });
			if (scenario === "detached") client.attachedActiveSessionIds.delete(activeSessionId);
			release();
			await stream;
			const eventWrites = write.mock.calls.filter(([chunk]) => JSON.parse(String(chunk)).type === "session_event");
			expect(eventWrites).toHaveLength(scenario === "backpressure" ? 1 : 0);
			expect(client.deferredSessionOutbounds?.size ?? 0).toBe(0);
			if (scenario === "backpressure") {
				expect(socket.writableNeedDrain).toBe(true);
				expect(client.backpressured).toBe(true);
				expect(client.catchupActiveSessionIds?.has(activeSessionId)).toBe(true);
				internals.broadcastToSession(state, sessionEventMessage(4));
				expect(
					write.mock.calls.filter(([chunk]) => JSON.parse(String(chunk)).type === "session_event"),
				).toHaveLength(1);
			}
			if (scenario === "closed") expect(written.some((message) => message.type === "session_closed")).toBe(true);
		} finally {
			release();
			socket.destroy();
			await stream;
		}
	});

	it("supervisor: preserves replay backpressure when another session's snapshot finishes", () => {
		const supervisor = new DaemonSupervisor(join(tmpdir(), "deferred-backpressure-supervisor.sock"), {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			descriptorDir: join(tmpdir(), "deferred-backpressure-state"),
		});
		const socket = new PassThrough();
		const client = socketClient(socket, {
			deferredSessionPayloads: new Map([[activeSessionId, [Buffer.alloc(128 * 1024), Buffer.from("later")]]]),
		});
		const internals = supervisor as unknown as {
			reserveSnapshotStream(client: DaemonSocketClient, activeSessionId: string): () => void;
			flushDeferredSessionPayloads(client: DaemonSocketClient, activeSessionId: string): void;
		};
		try {
			const finishOtherSnapshot = internals.reserveSnapshotStream(client, "other-session");
			const write = vi.spyOn(socket, "write");
			internals.flushDeferredSessionPayloads(client, activeSessionId);
			finishOtherSnapshot();
			expect(write).toHaveBeenCalledOnce();
			expect(client.backpressured).toBe(true);
			expect(client.catchupActiveSessionIds?.has(activeSessionId)).toBe(true);
			expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
		} finally {
			socket.destroy();
		}
	});
});
