import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
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
	it.each([
		[1, false],
		[2, false],
		[2, true],
	] as const)("worker: replays after %i snapshots (final fails=%s)", async (streamCount, failFinal) => {
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
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
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
		vi.spyOn(internals, "catchUpBackpressuredClient").mockResolvedValue();
		internals.sessions.set(activeSessionId, state);
		const snapshotSignal = markClientSnapshotStreaming(client, activeSessionId);

		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		async function* gatedTranscript(fail = false): AsyncGenerator<Buffer> {
			yield Buffer.from(`{"type":"session_snapshot_chunk"}`);
			await chunkGate;
			if (fail) throw new Error("last snapshot failed");
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
					gatedTranscript(failFinal),
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
		const outcomes = await Promise.allSettled(streams);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(failFinal ? 1 : 0);

		const decoder = new PrivateFrameDecoder(isDaemonWorkerFrameHeader);
		const frames = decoder.push(Buffer.concat(written));
		const outboundTypes = frames.map((frame) => (frame.header.kind === "outbound" ? frame.header.outboundType : ""));
		expect(outboundTypes).toEqual([
			...Array.from({ length: streamCount }, (_, index) =>
				failFinal && index === streamCount - 1
					? ["session_snapshot_begin", "session_snapshot_chunk", "session_snapshot_failed"]
					: ["session_snapshot_begin", "session_snapshot_chunk", "session_snapshot_chunk", "session_snapshot_end"],
			).flat(),
			...(failFinal ? [] : ["session_event", "session_event"]),
		]);
		const replayed = frames
			.filter((frame) => frame.header.kind === "outbound" && frame.header.outboundType === "session_event")
			.map((frame) => JSON.parse(frame.payload.toString("utf8")));
		expect(replayed).toEqual(
			failFinal
				? []
				: [
						expect.objectContaining({ event: { type: "session_info_changed", name: "change-2" } }),
						expect.objectContaining({ event: { type: "session_info_changed", name: "change-3" } }),
					],
		);
		expect(client.catchupActiveSessionIds?.size ?? 0).toBe(failFinal ? 1 : 0);
		socket.destroy();
	});

	it.each([
		["count", 257, 0],
		["single payload", 1, 2 * 1024 * 1024],
		["total bytes", 2, 1024 * 1024],
	] as const)("worker: catches up when the deferral %s limit overflows", async (_limit, count, textLength) => {
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
		for (let index = 0; index < count; index++) {
			const outbound = sessionEventMessage(index + 2);
			if (textLength && outbound.type === "session_event") {
				const message = fauxAssistantMessage("é".repeat(textLength));
				outbound.event = {
					type: "message_update",
					message,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "é", partial: message },
				};
			}
			internals.broadcastToSession(state, outbound);
			if (index < count - 1)
				expect(client.deferredSessionOutbounds?.get(activeSessionId)?.frames).toHaveLength(index + 1);
		}
		expect(client.deferredSessionOutbounds?.size ?? 0).toBe(0);
		// Once overflow requests a snapshot, later events cannot restart a partial replay.
		internals.broadcastToSession(state, sessionEventMessage(count + 2));
		expect(client.deferredSessionOutbounds?.size ?? 0).toBe(0);
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

	const supervisorScenarios = [
		"attached",
		"detached",
		"replaced",
		"failed",
		"failed-detached",
		"oversized",
		"byte-limit",
		"count-limit",
		"closed",
		"oversized-closed",
		"replaced-closed",
		"pending-closed",
		"backpressured-closed",
	];
	it.each(supervisorScenarios)("supervisor: replay (%s)", async (scenario) => {
		const overflow = scenario.startsWith("oversized") || scenario.endsWith("-limit");
		const closed = scenario.endsWith("closed");
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
		socket.on("data", (chunk: Buffer) => {
			written.push(chunk.toString("utf8"));
			if (scenario === "backpressured-closed" && written.length === 1) socket.pause();
		});
		const client = socketClient(socket);
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, SupervisorWorkerHarness>;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: SupervisorWorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach",
			): Promise<void>;
			handleWorkerFrame(worker: SupervisorWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		vi.spyOn(internals, "catchUpClient").mockResolvedValue();
		internals.clients.add(client);
		internals.workers.set(worker.descriptor.workerId, worker);

		const messages: AgentMessage[] = [
			{
				role: "user",
				content: scenario === "backpressured-closed" ? "x".repeat(128 * 1024) : "stable",
				timestamp: 1,
			},
		];
		const transcript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId,
			messages: scenario === "pending-closed" ? undefined : messages,
			cacheRoot: tmpdir(),
		});
		let releaseChunk: () => void = () => {};
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve;
		});
		const waitForChunk = transcript.waitForChunk.bind(transcript);
		transcript.waitForChunk = async (index: number, signal?: AbortSignal) => {
			if (index === 1) {
				await chunkGate;
				if (scenario.startsWith("failed")) throw new Error("snapshot failed");
			}
			return waitForChunk(index, signal);
		};

		const stream = internals.streamSnapshot(client, worker, streamedResult(), transcript, "attach");
		const completion = stream.catch((error: unknown) => error);
		await nextMacroTaskTurn();
		// The stream is parked before the end record; relayed frames are withheld.
		if (scenario.startsWith("replaced")) {
			internals.handleWorkerFrame(worker, {
				header: {
					kind: "outbound",
					outboundType: "session_replaced",
					activeSessionId,
					payloadEncoding: "jsonl",
				},
				payload: Buffer.from(
					`${JSON.stringify({ type: "session_replaced", activeSessionId, state: streamedResult().snapshot.state, messages: [] })}\n`,
				),
			});
		}
		const eventFrame: PrivateFrame<DaemonWorkerFrameHeader> = {
			header: {
				kind: "outbound",
				outboundType: "session_event",
				activeSessionId,
				sessionEventType: "session_info_changed",
				payloadEncoding: "jsonl",
			},
			payload: Buffer.from(
				`${JSON.stringify({
					...sessionEventMessage(2),
					padding: "x".repeat(
						scenario.startsWith("oversized") ? 8 * 1024 * 1024 : scenario === "byte-limit" ? 4 * 1024 * 1024 : 0,
					),
				})}\n`,
			),
		};
		internals.handleWorkerFrame(worker, eventFrame);
		if (scenario === "byte-limit") internals.handleWorkerFrame(worker, eventFrame);
		if (scenario === "count-limit") {
			for (let index = 1; index < 257; index++) internals.handleWorkerFrame(worker, eventFrame);
		}
		if (overflow) {
			expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
			expect(client.catchupActiveSessionIds?.has(activeSessionId)).toBe(true);
		}
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

		const closeFrame: PrivateFrame<DaemonWorkerFrameHeader> = {
			header: { kind: "outbound", outboundType: "session_closed", activeSessionId, payloadEncoding: "jsonl" },
			payload: Buffer.from(`${JSON.stringify({ type: "session_closed", activeSessionId, reason: "killed" })}\n`),
		};
		if (closed && !overflow) internals.handleWorkerFrame(worker, closeFrame);
		if (scenario.endsWith("detached")) client.attachedActiveSessionIds.delete(activeSessionId);
		releaseChunk();
		const error = await completion;
		if (scenario === "backpressured-closed") {
			socket.resume();
			await nextMacroTaskTurn();
		}
		if (closed && overflow) internals.handleWorkerFrame(worker, closeFrame);
		if (scenario.startsWith("failed")) expect(error).toBeInstanceOf(Error);
		else expect(error).toBeUndefined();

		const lines = written.join("").split("\n").filter(Boolean);
		const parsed = lines.map((line) => JSON.parse(line) as { type: string });
		expect(parsed.map((entry) => entry.type)).toEqual([
			"session_snapshot_begin",
			...(scenario === "pending-closed" ? [] : ["session_snapshot_chunk"]),
			...(closed && !overflow ? ["session_closed"] : []),
			...(closed && !overflow
				? []
				: [scenario.startsWith("failed") ? "session_snapshot_failed" : "session_snapshot_end"]),
			...(closed && overflow ? ["session_closed"] : []),
			...(scenario === "attached" ? ["session_event", "session_event"] : []),
		]);
		expect(client.deferredSessionPayloads?.size ?? 0).toBe(0);
		expect(client.snapshotTransferAbortControllers?.size ?? 0).toBe(0);
		expect(client.catchupActiveSessionIds?.size ?? 0).toBe(
			!closed && (scenario === "replaced" || scenario === "failed" || overflow) ? 1 : 0,
		);
		if (!closed && (scenario === "replaced" || overflow)) {
			const before = written.length;
			const frame: PrivateFrame<DaemonWorkerFrameHeader> = {
				header: { kind: "outbound", outboundType: "session_event", activeSessionId, payloadEncoding: "jsonl" },
				payload: Buffer.from(`${JSON.stringify(sessionEventMessage(4))}\n`),
			};
			internals.handleWorkerFrame(worker, frame);
			expect(written).toHaveLength(before);
			const replacement = internals.streamSnapshot(client, worker, streamedResult(), transcript, "attach");
			internals.handleWorkerFrame(worker, frame);
			await replacement;
			expect(written.map((line) => JSON.parse(line).type).slice(before)).toEqual([
				"session_snapshot_begin",
				"session_snapshot_chunk",
				"session_snapshot_end",
				"session_event",
			]);
		}
		transcript.dispose();
		socket.destroy();
	});

	it.each(["backpressure", "closed", "detached", "replaced"] as const)("worker: stop after %s", async (scenario) => {
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
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
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
		vi.spyOn(internals, "catchUpBackpressuredClient").mockResolvedValue();
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
			if (scenario === "replaced") {
				internals.broadcastToSession(state, {
					type: "session_replaced",
					activeSessionId,
					state: streamedResult().snapshot.state,
					messages: [],
				});
				internals.broadcastToSession(state, sessionEventMessage(4));
			}
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
			if (scenario === "replaced") {
				internals.broadcastToSession(state, sessionEventMessage(5));
				expect(written.some((message) => message.type === "session_event")).toBe(false);
				expect(client.catchupPurposes?.get(activeSessionId)).toBe("replacement");
				const replacement = internals.streamWorkerSnapshot(
					client,
					streamedResult(),
					transcript(),
					"attach",
					markClientSnapshotStreaming(client, activeSessionId),
					true,
				);
				internals.broadcastToSession(state, sessionEventMessage(6));
				await replacement;
				expect(written.filter((message) => message.type === "session_event")).toEqual([sessionEventMessage(6)]);
			}
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
			deferredSessionPayloads: new Map([
				[activeSessionId, { payloads: [Buffer.alloc(128 * 1024), Buffer.from("later")], bytes: 128 * 1024 + 5 }],
			]),
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
