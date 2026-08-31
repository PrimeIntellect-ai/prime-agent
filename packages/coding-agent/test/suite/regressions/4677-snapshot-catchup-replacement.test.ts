import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";
import type { DaemonWorkerFrameHeader } from "../../../src/modes/daemon/daemon-worker-protocol.js";
import { SnapshotTranscriptCache } from "../../../src/modes/daemon/snapshot-transcript-cache.js";
import type { PrivateFrame } from "../../../src/modes/session-worker/private-framing.js";

const activeSessionId = "active-4677";
const directories: string[] = [];

interface WorkerHarness {
	descriptor: { workerId: string; rootActiveSessionId: string; lifecycle: "ready"; pid: number };
	client?: { request: ReturnType<typeof vi.fn> };
	summaries: Map<string, SessionSummary>;
	snapshotCache: Map<string, DaemonAttachResult>;
	transcriptCaches: Map<string, SnapshotTranscriptCache>;
	snapshotGenerations: Map<
		string,
		Map<
			string,
			{
				transcript: SnapshotTranscriptCache;
				result: DaemonAttachResult;
				incoming: boolean;
				retired: boolean;
				validation?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
			}
		>
	>;
	snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
	intentionalStop: boolean;
	stopRevision: number;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "eng-4677-"));
	directories.push(directory);
	return directory;
}

function summary(messageCount: number): SessionSummary {
	return {
		id: activeSessionId,
		activeSessionId,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-4677",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function streamedResult(snapshotId: string, messageCount: number, lastEventSequence: number): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId,
		snapshot: {
			activeSessionId,
			summary: summary(messageCount),
			state: { activeSessionId, sessionId: "session-4677" } as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence,
		},
		replay: { status: "complete", toSequence: lastEventSequence },
		lastEventSequence,
		snapshotStream: { id: snapshotId, messageCount, targetChunkBytes: 1 },
		client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
	};
}

function snapshotFrame(
	message: Extract<
		DaemonOutbound,
		{ type: "session_snapshot_begin" | "session_snapshot_chunk" | "session_snapshot_end" }
	>,
	purpose: "attach" | "replacement" | "catchup" = "replacement",
): PrivateFrame<DaemonWorkerFrameHeader> {
	return {
		header: {
			kind: "outbound",
			outboundType: message.type,
			activeSessionId,
			snapshotId: message.snapshotId,
			payloadEncoding: "jsonl",
			snapshotPurpose: purpose,
		},
		payload: Buffer.from(JSON.stringify(message)),
	};
}

function socketClient(id: string): DaemonSocketClient {
	const socket = new PassThrough();
	return {
		id,
		socket: socket as unknown as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		catchupActiveSessionIds: new Set(),
		detachInput: () => {},
		supportsExtensionUi: false,
		capabilities: new Set(["chunked_snapshot"]),
	};
}

function workerHarness(result: DaemonAttachResult, transcript: SnapshotTranscriptCache): WorkerHarness {
	return {
		descriptor: {
			workerId: "worker-4677",
			rootActiveSessionId: activeSessionId,
			lifecycle: "ready",
			pid: 4677,
		},
		client: {
			request: vi.fn(async () => {
				throw new Error("unexpected snapshot reload");
			}),
		},
		summaries: new Map([[activeSessionId, result.snapshot.summary]]),
		snapshotCache: new Map([[activeSessionId, result]]),
		transcriptCaches: new Map([[activeSessionId, transcript]]),
		snapshotGenerations: new Map(),
		snapshotLoads: new Map(),
		intentionalStop: false,
		stopRevision: 0,
	};
}

describe("ENG-4677 snapshot catch-up replacement", () => {
	it("lets an incomplete retained snapshot finish after a newer generation begins", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const firstSnapshotId = "snapshot-4677-incomplete-a";
		const replacementSnapshotId = "snapshot-4677-incomplete-b";
		const placeholder = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: firstSnapshotId,
			cacheRoot: root,
			targetChunkBytes: 1,
		});
		const worker = workerHarness(streamedResult(firstSnapshotId, 1, 1), placeholder);
		worker.snapshotCache.clear();
		worker.transcriptCaches.clear();
		const client = socketClient("incomplete-reader");
		const written: DaemonOutbound[] = [];
		const writeSnapshotBuffer = vi.fn((_client: DaemonSocketClient, buffer: Uint8Array) => {
			written.push(JSON.parse(Buffer.from(buffer).toString("utf8")) as DaemonOutbound);
			return Promise.resolve(true);
		});
		const internals = supervisor as unknown as {
			writeSnapshotBuffer: typeof writeSnapshotBuffer;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: WorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
			): Promise<void>;
		};
		internals.writeSnapshotBuffer = writeSnapshotBuffer;

		const firstResult = streamedResult(firstSnapshotId, 1, 1);
		const { messages: _firstMessages, ...firstSnapshot } = firstResult.snapshot;
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_begin",
				activeSessionId,
				snapshotId: firstSnapshotId,
				snapshot: firstSnapshot,
				messageCount: 1,
				targetChunkBytes: 1,
			}),
		);
		const firstTranscript = worker.transcriptCaches.get(activeSessionId);
		if (!firstTranscript) {
			throw new Error("first transcript was not initialized");
		}
		const firstStream = internals.streamSnapshot(client, worker, firstResult, firstTranscript);
		void firstStream.catch(() => undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));

		const replacementResult = streamedResult(replacementSnapshotId, 1, 2);
		const { messages: _replacementMessages, ...replacementSnapshot } = replacementResult.snapshot;
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_begin",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				snapshot: replacementSnapshot,
				messageCount: 1,
				targetChunkBytes: 1,
			}),
		);
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_chunk",
				activeSessionId,
				snapshotId: firstSnapshotId,
				index: 0,
				messages: [{ role: "user", content: "first", timestamp: 1 }],
			}),
		);
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_end",
				activeSessionId,
				snapshotId: firstSnapshotId,
				chunkCount: 1,
				lastEventSequence: 1,
			}),
		);
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_chunk",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				index: 0,
				messages: [{ role: "user", content: "replacement", timestamp: 2 }],
			}),
		);
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_end",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				chunkCount: 1,
				lastEventSequence: 2,
			}),
		);

		await expect(firstStream).resolves.toBeUndefined();
		expect(written.some((message) => message.type === "session_snapshot_failed")).toBe(false);
		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);
		client.socket.destroy();
	});

	it("does not let a stale attach response replace a newer completed generation", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const firstSnapshotId = "snapshot-4677-stale-a";
		const replacementSnapshotId = "snapshot-4677-stale-b";
		const firstResult = streamedResult(firstSnapshotId, 1, 1);
		const placeholder = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: firstSnapshotId,
			cacheRoot: root,
			targetChunkBytes: 1,
		});
		const worker = workerHarness(firstResult, placeholder);
		worker.snapshotCache.clear();
		worker.transcriptCaches.clear();
		let resolveAttach!: (response: { success: true; data: DaemonAttachResult }) => void;
		worker.client = {
			request: vi.fn(
				() =>
					new Promise<{ success: true; data: DaemonAttachResult }>((resolve) => {
						resolveAttach = resolve;
					}),
			),
		};
		const client = socketClient("stale-attach");
		const internals = supervisor as unknown as {
			workers: Map<string, WorkerHarness>;
			attachClient(
				client: DaemonSocketClient,
				command: { type: "attach"; activeSessionId: string; capabilities: ["chunked_snapshot"] },
			): Promise<{
				result: DaemonAttachResult;
				transcript?: SnapshotTranscriptCache;
				releaseTranscript?: () => void;
			}>;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.workers.set(worker.descriptor.workerId, worker);
		const attaching = internals.attachClient(client, {
			type: "attach",
			activeSessionId,
			capabilities: ["chunked_snapshot"],
		});
		await Promise.resolve();

		for (const result of [firstResult, streamedResult(replacementSnapshotId, 1, 2)]) {
			const { messages: _messages, ...snapshot } = result.snapshot;
			const message = result.lastEventSequence === 1 ? "first" : "replacement";
			internals.handleWorkerFrame(
				worker,
				snapshotFrame({
					type: "session_snapshot_begin",
					activeSessionId,
					snapshotId: result.snapshotStream!.id,
					snapshot,
					messageCount: 1,
					targetChunkBytes: 1,
				}),
			);
			internals.handleWorkerFrame(
				worker,
				snapshotFrame({
					type: "session_snapshot_chunk",
					activeSessionId,
					snapshotId: result.snapshotStream!.id,
					index: 0,
					messages: [{ role: "user", content: message, timestamp: result.lastEventSequence }],
				}),
			);
			internals.handleWorkerFrame(
				worker,
				snapshotFrame({
					type: "session_snapshot_end",
					activeSessionId,
					snapshotId: result.snapshotStream!.id,
					chunkCount: 1,
					lastEventSequence: result.lastEventSequence,
				}),
			);
		}
		resolveAttach({ success: true, data: firstResult });

		const attached = await attaching;
		expect(attached.result.snapshotStream?.id).toBe(replacementSnapshotId);
		expect(attached.transcript?.snapshotId).toBe(replacementSnapshotId);
		expect(attached.transcript?.complete).toBe(true);
		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);
		attached.releaseTranscript?.();
		client.socket.destroy();
	});

	it("fails and disposes an orphaned incomplete transcript before replacing it", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const firstSnapshotId = "snapshot-4677-orphan-a";
		const replacementSnapshotId = "snapshot-4677-orphan-b";
		const firstResult = streamedResult(firstSnapshotId, 1, 1);
		const firstTranscript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: firstSnapshotId,
			cacheRoot: root,
			targetChunkBytes: 1,
			memoryCacheBytes: 1,
		});
		firstTranscript.appendEncodedChunk(Buffer.from("orphaned transcript chunk"));
		expect(firstTranscript.fileBacked).toBe(true);
		const cacheDirectory = join(root, firstSnapshotId);
		expect(existsSync(cacheDirectory)).toBe(true);
		const waiter = firstTranscript.waitForChunk(1);
		void waiter.catch(() => undefined);
		const worker = workerHarness(firstResult, firstTranscript);
		const internals = supervisor as unknown as {
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		const replacementResult = streamedResult(replacementSnapshotId, 1, 2);
		const { messages: _messages, ...snapshot } = replacementResult.snapshot;

		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_begin",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				snapshot,
				messageCount: 1,
				targetChunkBytes: 1,
			}),
		);

		await expect(waiter).rejects.toThrow("superseded");
		expect(firstTranscript.fileBacked).toBe(false);
		expect(existsSync(cacheDirectory)).toBe(false);
		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);
	});

	it("releases duplicate validation waiters when a newer generation retires it", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const firstSnapshotId = "snapshot-4677-validation-a";
		const replacementSnapshotId = "snapshot-4677-validation-b";
		const firstResult = streamedResult(firstSnapshotId, 1, 1);
		const placeholder = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: firstSnapshotId,
			cacheRoot: root,
			targetChunkBytes: 1,
		});
		const worker = workerHarness(firstResult, placeholder);
		worker.snapshotCache.clear();
		worker.transcriptCaches.clear();
		const client = socketClient("validation-waiter");
		const internals = supervisor as unknown as {
			workers: Map<string, WorkerHarness>;
			attachClient(
				client: DaemonSocketClient,
				command: { type: "attach"; activeSessionId: string; capabilities: ["chunked_snapshot"] },
			): Promise<{ result: DaemonAttachResult; releaseTranscript?: () => void }>;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.workers.set(worker.descriptor.workerId, worker);
		const { messages: _firstMessages, ...firstSnapshot } = firstResult.snapshot;
		const firstBegin = {
			type: "session_snapshot_begin",
			activeSessionId,
			snapshotId: firstSnapshotId,
			snapshot: firstSnapshot,
			messageCount: 1,
			targetChunkBytes: 1,
		} satisfies DaemonOutbound;
		const firstChunk = {
			type: "session_snapshot_chunk",
			activeSessionId,
			snapshotId: firstSnapshotId,
			index: 0,
			messages: [{ role: "user", content: "first", timestamp: 1 }],
		} satisfies DaemonOutbound;
		const firstEnd = {
			type: "session_snapshot_end",
			activeSessionId,
			snapshotId: firstSnapshotId,
			chunkCount: 1,
			lastEventSequence: 1,
		} satisfies DaemonOutbound;
		for (const message of [firstBegin, firstChunk, firstEnd, firstBegin]) {
			internals.handleWorkerFrame(worker, snapshotFrame(message));
		}
		expect(worker.snapshotGenerations.get(activeSessionId)?.get(firstSnapshotId)?.validation).toBeDefined();

		let attached = false;
		const attaching = internals
			.attachClient(client, {
				type: "attach",
				activeSessionId,
				capabilities: ["chunked_snapshot"],
			})
			.then((result) => {
				attached = true;
				return result;
			});
		await Promise.resolve();
		const replacementResult = streamedResult(replacementSnapshotId, 1, 2);
		const { messages: _replacementMessages, ...replacementSnapshot } = replacementResult.snapshot;
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_begin",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				snapshot: replacementSnapshot,
				messageCount: 1,
				targetChunkBytes: 1,
			}),
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const attachedBeforeRetiredTransferFinished = attached;

		internals.handleWorkerFrame(worker, snapshotFrame(firstChunk));
		internals.handleWorkerFrame(worker, snapshotFrame(firstEnd));
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_chunk",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				index: 0,
				messages: [{ role: "user", content: "replacement", timestamp: 2 }],
			}),
		);
		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_end",
				activeSessionId,
				snapshotId: replacementSnapshotId,
				chunkCount: 1,
				lastEventSequence: 2,
			}),
		);
		const result = await attaching;
		result.releaseTranscript?.();

		expect(attachedBeforeRetiredTransferFinished).toBe(true);
		expect(result.result.snapshotStream?.id).toBe(replacementSnapshotId);
		client.socket.destroy();
	});

	it("waits for supervisor socket drain before continuing catch-up", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const client = socketClient("supervisor-backpressure");
		client.backpressured = true;
		client.catchupActiveSessionIds?.add(activeSessionId);
		const drainClientCatchups = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
		});
		const internals = supervisor as unknown as {
			drainClientCatchups: typeof drainClientCatchups;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.drainClientCatchups = drainClientCatchups;

		await internals.catchUpClient(client);
		expect(drainClientCatchups).not.toHaveBeenCalled();
		expect(client.catchupActiveSessionIds).toContain(activeSessionId);

		client.backpressured = false;
		await internals.catchUpClient(client);
		expect(drainClientCatchups).toHaveBeenCalledOnce();
		client.socket.destroy();
	});

	it("waits for worker socket drain before continuing catch-up", async () => {
		const root = tempDirectory();
		const daemon = new AgentDaemon(join(root, "worker.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const client = socketClient("worker-backpressure");
		client.backpressured = true;
		client.catchupActiveSessionIds?.add(activeSessionId);
		const drainBackpressuredClientCatchups = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
		});
		const internals = daemon as unknown as {
			drainBackpressuredClientCatchups: typeof drainBackpressuredClientCatchups;
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.drainBackpressuredClientCatchups = drainBackpressuredClientCatchups;

		await internals.catchUpBackpressuredClient(client);
		expect(drainBackpressuredClientCatchups).not.toHaveBeenCalled();
		expect(client.catchupActiveSessionIds).toContain(activeSessionId);

		client.backpressured = false;
		await internals.catchUpBackpressuredClient(client);
		expect(drainBackpressuredClientCatchups).toHaveBeenCalledOnce();
		client.socket.destroy();
	});

	it("lets a retained snapshot finish while a newer generation becomes current", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const firstSnapshotId = "snapshot-4677-a";
		const replacementSnapshotId = "snapshot-4677-b";
		const firstMessages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		];
		const firstResult = streamedResult(firstSnapshotId, firstMessages.length, 1);
		const firstTranscript = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId: firstSnapshotId,
			messages: firstMessages,
			cacheRoot: root,
			targetChunkBytes: 1,
		});
		const worker = workerHarness(firstResult, firstTranscript);
		const client = socketClient("slow-client");
		const written: DaemonOutbound[] = [];
		let releaseFirstChunk!: (accepted: boolean) => void;
		const firstChunkBlocked = new Promise<boolean>((resolve) => {
			releaseFirstChunk = resolve;
		});
		let firstChunkStarted!: () => void;
		const firstChunkReached = new Promise<void>((resolve) => {
			firstChunkStarted = resolve;
		});
		const writeSnapshotBuffer = vi.fn((_client: DaemonSocketClient, buffer: Uint8Array) => {
			const message = JSON.parse(Buffer.from(buffer).toString("utf8")) as DaemonOutbound;
			written.push(message);
			if (
				message.type === "session_snapshot_chunk" &&
				message.snapshotId === firstSnapshotId &&
				message.index === 0
			) {
				firstChunkStarted();
				return firstChunkBlocked;
			}
			return Promise.resolve(true);
		});
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, WorkerHarness>;
			writeSnapshotBuffer: typeof writeSnapshotBuffer;
			syncWorkerExtensionUi: ReturnType<typeof vi.fn>;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: WorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach" | "replacement" | "resync",
			): Promise<void>;
			handleWorkerFrame(worker: WorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
			queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose: "replacement" | "resync"): void;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.writeSnapshotBuffer = writeSnapshotBuffer;
		internals.syncWorkerExtensionUi = vi.fn(async () => {});

		const firstStream = internals.streamSnapshot(client, worker, firstResult, firstTranscript, "attach");
		await firstChunkReached;

		const replacementResult = streamedResult(replacementSnapshotId, 1, 2);
		const { messages: _messages, ...replacementSnapshot } = replacementResult.snapshot;
		const begin = {
			type: "session_snapshot_begin",
			activeSessionId,
			snapshotId: replacementSnapshotId,
			snapshot: replacementSnapshot,
			messageCount: 1,
			targetChunkBytes: 1,
		} satisfies DaemonOutbound;
		const staleChunk = {
			type: "session_snapshot_chunk",
			activeSessionId,
			snapshotId: firstSnapshotId,
			index: 2,
			messages: [{ role: "user", content: "stale", timestamp: 3 }],
		} satisfies DaemonOutbound;
		const replacementChunk = {
			type: "session_snapshot_chunk",
			activeSessionId,
			snapshotId: replacementSnapshotId,
			index: 0,
			messages: [{ role: "user", content: "replacement", timestamp: 4 }],
		} satisfies DaemonOutbound;
		const end = {
			type: "session_snapshot_end",
			activeSessionId,
			snapshotId: replacementSnapshotId,
			chunkCount: 1,
			lastEventSequence: 2,
		} satisfies DaemonOutbound;
		internals.handleWorkerFrame(worker, snapshotFrame(begin));
		internals.handleWorkerFrame(worker, snapshotFrame(staleChunk));
		internals.handleWorkerFrame(worker, snapshotFrame(replacementChunk));
		internals.handleWorkerFrame(worker, snapshotFrame(end));

		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);
		expect(worker.transcriptCaches.get(activeSessionId)?.chunkCount).toBe(1);
		expect(worker.transcriptCaches.get(activeSessionId)?.complete).toBe(true);

		releaseFirstChunk(true);
		await firstStream;

		expect(written.filter((message) => message.type === "session_snapshot_failed")).toHaveLength(0);
		expect(
			written.filter(
				(message) => message.type === "session_snapshot_chunk" && message.snapshotId === firstSnapshotId,
			),
		).toHaveLength(2);
		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);

		internals.clients.add(client);
		internals.workers.set(worker.descriptor.workerId, worker);
		internals.queueCatchup(client, activeSessionId, "replacement");
		await internals.catchUpClient(client);

		expect(
			written.some(
				(message) =>
					message.type === "session_snapshot_begin" &&
					message.snapshotId === replacementSnapshotId &&
					message.purpose === "replacement",
			),
		).toBe(true);
		expect(worker.transcriptCaches.get(activeSessionId)?.snapshotId).toBe(replacementSnapshotId);
		client.socket.destroy();
	});

	it("coalesces concurrent catch-up triggers into one drain", async () => {
		const root = tempDirectory();
		const supervisor = new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
		const client = socketClient("coalesced-client");
		let releaseFirstDrain!: () => void;
		const firstDrainBlocked = new Promise<void>((resolve) => {
			releaseFirstDrain = resolve;
		});
		const drainClientCatchups = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
			target.catchupPurposes?.clear();
			if (drainClientCatchups.mock.calls.length === 1) {
				await firstDrainBlocked;
			}
		});
		const internals = supervisor as unknown as {
			drainClientCatchups: typeof drainClientCatchups;
			queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose?: "replacement" | "resync"): void;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.drainClientCatchups = drainClientCatchups;
		internals.queueCatchup(client, activeSessionId);

		const first = internals.catchUpClient(client);
		const concurrent = internals.catchUpClient(client);
		expect(concurrent).toBe(first);
		expect(drainClientCatchups).toHaveBeenCalledOnce();

		internals.queueCatchup(client, activeSessionId, "replacement");
		releaseFirstDrain();
		await first;
		for (let attempt = 0; attempt < 10 && drainClientCatchups.mock.calls.length < 2; attempt++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		expect(drainClientCatchups).toHaveBeenCalledTimes(2);
		expect(client.catchupActiveSessionIds?.size).toBe(0);
		client.socket.destroy();
	});

	it("coalesces worker catch-up triggers into one drain", async () => {
		const root = tempDirectory();
		const daemon = new AgentDaemon(join(root, "worker.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const client = socketClient("worker-client");
		let releaseFirstDrain!: () => void;
		const firstDrainBlocked = new Promise<void>((resolve) => {
			releaseFirstDrain = resolve;
		});
		const drainBackpressuredClientCatchups = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
			target.catchupPurposes?.clear();
			if (drainBackpressuredClientCatchups.mock.calls.length === 1) {
				await firstDrainBlocked;
			}
		});
		const internals = daemon as unknown as {
			drainBackpressuredClientCatchups: typeof drainBackpressuredClientCatchups;
			queueClientCatchup(
				client: DaemonSocketClient,
				activeSessionId: string,
				purpose?: "replacement" | "resync",
			): void;
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.drainBackpressuredClientCatchups = drainBackpressuredClientCatchups;
		internals.queueClientCatchup(client, activeSessionId);

		const first = internals.catchUpBackpressuredClient(client);
		const concurrent = internals.catchUpBackpressuredClient(client);
		expect(concurrent).toBe(first);
		expect(drainBackpressuredClientCatchups).toHaveBeenCalledOnce();

		internals.queueClientCatchup(client, activeSessionId, "replacement");
		releaseFirstDrain();
		await first;
		for (let attempt = 0; attempt < 10 && drainBackpressuredClientCatchups.mock.calls.length < 2; attempt++) {
			await new Promise<void>((resolve) => setImmediate(resolve));
		}

		expect(drainBackpressuredClientCatchups).toHaveBeenCalledTimes(2);
		expect(client.catchupActiveSessionIds?.size).toBe(0);
		client.socket.destroy();
	});
});
