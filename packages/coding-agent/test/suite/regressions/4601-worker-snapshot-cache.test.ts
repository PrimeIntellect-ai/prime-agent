import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon, markClientSnapshotStreaming } from "../../../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonOutbound,
} from "../../../src/modes/daemon/daemon-protocol.js";
import {
	createSnapshotTranscriptChunks,
	SnapshotTranscriptCache,
	type SnapshotTranscriptChunkSource,
} from "../../../src/modes/daemon/snapshot-transcript-cache.js";

const tempDirectories: string[] = [];
const activeSessionId = "active-4601";
const snapshotId = "snapshot-4601";

afterEach(() => {
	for (const directory of tempDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function tempDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "eng-4601-"));
	tempDirectories.push(directory);
	return directory;
}

function messages(label: string): AgentMessage[] {
	return [
		{ role: "user", content: `${label}-first`, timestamp: 1 },
		{ role: "user", content: `${label}-second`, timestamp: 2 },
	];
}

function streamedResult(
	messageCount: number,
	targetChunkBytes = 1,
	resultActiveSessionId = activeSessionId,
	resultSnapshotId = snapshotId,
): DaemonAttachResult {
	return {
		protocol: DAEMON_PROTOCOL_INFO,
		activeSessionId: resultActiveSessionId,
		snapshot: {
			activeSessionId: resultActiveSessionId,
			summary: {
				id: resultActiveSessionId,
				activeSessionId: resultActiveSessionId,
				lifecycle: "live",
				activity: "idle",
				isSessionActive: false,
				sessionId: `session-${resultActiveSessionId}`,
				cwd: "/tmp",
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			},
			state: {
				activeSessionId: resultActiveSessionId,
				sessionId: `session-${resultActiveSessionId}`,
			} as DaemonAttachResult["snapshot"]["state"],
			messages: [],
			lastEventSequence: 1,
		},
		replay: { status: "complete", toSequence: 1 },
		lastEventSequence: 1,
		snapshotStream: { id: resultSnapshotId, messageCount, targetChunkBytes },
		client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
	};
}

function socketClient(id: string): { client: DaemonSocketClient; socket: PassThrough } {
	const socket = new PassThrough();
	return {
		socket,
		client: {
			id,
			socket: socket as unknown as Socket,
			transport: "private-framed",
			attachedActiveSessionIds: new Set([activeSessionId]),
			catchupActiveSessionIds: new Set<string>(),
			detachInput: () => {},
			supportsExtensionUi: false,
			capabilities: new Set(["chunked_snapshot"]),
		},
	};
}

describe("ENG-4601 worker snapshot cache", () => {
	it("preserves legacy JSONL bytes from a stable message-array snapshot", () => {
		const transcript: AgentMessage[] = [{ role: "user", content: 'line1\n"quoted"\\tail', timestamp: 1 }];
		const chunks = createSnapshotTranscriptChunks({
			activeSessionId: 'active-"\\',
			snapshotId: "snapshot-\n",
			messages: transcript,
		});
		transcript.push({ role: "user", content: "late", timestamp: 2 });

		expect([...chunks].map((chunk) => chunk.toString("utf8"))).toEqual([
			'{"type":"session_snapshot_chunk","activeSessionId":"active-\\"\\\\","snapshotId":"snapshot-\\n","index":0,"messages":[{"role":"user","content":"line1\\n\\"quoted\\"\\\\tail","timestamp":1}]}\n',
		]);
		expect([...createSnapshotTranscriptChunks({ activeSessionId, snapshotId, messages: [] })]).toEqual([]);
	});

	it.each([1, 2])(
		"keeps %i same-ID worker stream(s) bounded by socket drain without shared cleanup",
		async (count) => {
			const root = tempDirectory();
			const oldSharedDirectory = join(root, "worker-snapshot-cache", snapshotId);
			const sentinel = join(oldSharedDirectory, "0.jsonl");
			mkdirSync(oldSharedDirectory, { recursive: true });
			writeFileSync(sentinel, "unrelated-worker");
			const daemon = new AgentDaemon(join(root, "worker.sock"), {
				defaultSessionConfig: { agentDir: root, cwd: root },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const releases: Array<(accepted: boolean) => void> = [];
			const produced: string[] = [];
			const internals = daemon as unknown as {
				writeWorkerSnapshotBuffer(
					client: DaemonSocketClient,
					buffer: Buffer,
					message: DaemonOutbound,
				): Promise<boolean>;
				streamWorkerSnapshot(
					client: DaemonSocketClient,
					result: DaemonAttachResult,
					transcript: SnapshotTranscriptChunkSource,
				): Promise<void>;
			};
			internals.writeWorkerSnapshotBuffer = async (_client, _buffer, message) => {
				if (message.type !== "session_snapshot_chunk" || message.index !== 0) {
					return true;
				}
				return new Promise<boolean>((resolve) => releases.push(resolve));
			};
			const sockets = Array.from({ length: count }, (_, index) => socketClient(`worker-${index}`));
			const streams = sockets.map(({ client }, index) => {
				const encoded = createSnapshotTranscriptChunks({
					activeSessionId,
					snapshotId,
					messages: messages(String(index)),
					targetChunkBytes: 1,
				});
				const tracked: SnapshotTranscriptChunkSource = {
					async *[Symbol.asyncIterator]() {
						let chunkIndex = 0;
						for (const chunk of encoded) {
							produced.push(`${index}:${chunkIndex++}`);
							yield chunk;
						}
					},
				};
				return internals.streamWorkerSnapshot(client, streamedResult(2), tracked);
			});

			for (let attempt = 0; attempt < 10 && releases.length < count; attempt++) {
				await Promise.resolve();
			}
			expect(releases).toHaveLength(count);
			expect(produced).toEqual(Array.from({ length: count }, (_, index) => `${index}:0`));
			for (const release of releases) release(true);
			await Promise.all(streams);

			expect(produced).toEqual([
				...Array.from({ length: count }, (_, index) => `${index}:0`),
				...Array.from({ length: count }, (_, index) => `${index}:1`),
			]);
			expect(readFileSync(sentinel, "utf8")).toBe("unrelated-worker");
			for (const { socket } of sockets) socket.destroy();
		},
	);

	it("terminates a pre-begin abort without interrupting a sibling stream", async () => {
		const root = tempDirectory();
		const daemon = new AgentDaemon(join(root, "worker.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const { client, socket } = socketClient("worker-pre-begin-abort");
		const siblingActiveSessionId = "active-4601-pre-begin-sibling";
		const siblingSnapshotId = "snapshot-4601-pre-begin-sibling";
		client.attachedActiveSessionIds.add(siblingActiveSessionId);
		const state = {
			activeSessionId,
			clients: new Set([client]),
			extensionUiRequests: new Map(),
			runtime: { metadata: { kind: "subagent" } },
		} as unknown as ActiveSessionState;
		const written: DaemonOutbound[] = [];
		const signal = markClientSnapshotStreaming(client, activeSessionId);
		const siblingSignal = markClientSnapshotStreaming(client, siblingActiveSessionId);
		const internals = daemon as unknown as {
			writeSerialized(client: DaemonSocketClient, buffer: string | Buffer, message?: DaemonOutbound): boolean;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptChunkSource,
				purpose: "attach",
				signal: AbortSignal,
				snapshotAlreadyMarked: boolean,
			): Promise<void>;
			detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
		};
		internals.writeSerialized = (_client, _buffer, message) => {
			if (message) written.push(message);
			return true;
		};

		internals.detachClientFromSession(client, state);
		await Promise.all([
			internals.streamWorkerSnapshot(
				client,
				streamedResult(2),
				createSnapshotTranscriptChunks({ activeSessionId, snapshotId, messages: messages("aborted"), signal }),
				"attach",
				signal,
				true,
			),
			internals.streamWorkerSnapshot(
				client,
				streamedResult(2, 1, siblingActiveSessionId, siblingSnapshotId),
				createSnapshotTranscriptChunks({
					activeSessionId: siblingActiveSessionId,
					snapshotId: siblingSnapshotId,
					messages: messages("sibling"),
					signal: siblingSignal,
				}),
				"attach",
				siblingSignal,
				true,
			),
		]);

		expect(
			written
				.filter((message) => "snapshotId" in message && message.activeSessionId === activeSessionId)
				.map((message) => message.type),
		).toEqual(["session_snapshot_begin", "session_snapshot_failed"]);
		expect(written).toContainEqual(
			expect.objectContaining({
				type: "session_snapshot_end",
				activeSessionId: siblingActiveSessionId,
				snapshotId: siblingSnapshotId,
			}),
		);
		expect(client.attachedActiveSessionIds.has(siblingActiveSessionId)).toBe(true);
		expect(client.snapshotStreaming).toBe(false);
		expect(socket.destroyed).toBe(false);
		socket.destroy();
	});

	it("terminates an aborted worker snapshot without interrupting a sibling stream", async () => {
		const root = tempDirectory();
		const daemon = new AgentDaemon(join(root, "worker.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const { client, socket } = socketClient("worker-detach");
		const siblingActiveSessionId = "active-4601-sibling";
		const siblingSnapshotId = "snapshot-4601-sibling";
		client.attachedActiveSessionIds.add(siblingActiveSessionId);
		const state = {
			activeSessionId,
			clients: new Set([client]),
			extensionUiRequests: new Map(),
			runtime: { metadata: { kind: "subagent" } },
		} as unknown as ActiveSessionState;
		const written: DaemonOutbound[] = [];
		const produced: number[] = [];
		const signal = markClientSnapshotStreaming(client, activeSessionId);
		const siblingSignal = markClientSnapshotStreaming(client, siblingActiveSessionId);
		const encoded = createSnapshotTranscriptChunks({
			activeSessionId,
			snapshotId,
			messages: messages("detach"),
			targetChunkBytes: 1,
			signal,
		});
		const transcript: SnapshotTranscriptChunkSource = {
			*[Symbol.iterator]() {
				let index = 0;
				for (const chunk of encoded) {
					produced.push(index++);
					yield chunk;
				}
			},
		};
		const siblingTranscript = createSnapshotTranscriptChunks({
			activeSessionId: siblingActiveSessionId,
			snapshotId: siblingSnapshotId,
			messages: messages("sibling"),
			targetChunkBytes: 1,
			signal: siblingSignal,
		});
		const internals = daemon as unknown as {
			writeSerialized(client: DaemonSocketClient, buffer: string | Buffer, message?: DaemonOutbound): boolean;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptChunkSource,
				purpose: "attach",
				signal: AbortSignal,
				snapshotAlreadyMarked: boolean,
			): Promise<void>;
			detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
		};
		internals.writeSerialized = (_client, _buffer, message) => {
			if (message) written.push(message);
			return message?.type !== "session_snapshot_chunk" || message.activeSessionId === siblingActiveSessionId;
		};

		const stream = internals.streamWorkerSnapshot(client, streamedResult(2), transcript, "attach", signal, true);
		const siblingStream = internals.streamWorkerSnapshot(
			client,
			streamedResult(2, 1, siblingActiveSessionId, siblingSnapshotId),
			siblingTranscript,
			"attach",
			siblingSignal,
			true,
		);
		for (let attempt = 0; attempt < 10 && socket.listenerCount("drain") === 0; attempt++) {
			await Promise.resolve();
		}
		expect(produced).toEqual([0]);
		expect(socket.listenerCount("drain")).toBe(1);

		internals.detachClientFromSession(client, state);
		await Promise.all([stream, siblingStream]);

		expect(produced).toEqual([0]);
		expect(
			written.some(
				(message) => message.type === "session_snapshot_end" && message.activeSessionId === activeSessionId,
			),
		).toBe(false);
		expect(written).toContainEqual({
			type: "session_snapshot_failed",
			activeSessionId,
			snapshotId,
			error: `Snapshot ${snapshotId} was aborted`,
		});
		expect(written).toContainEqual(
			expect.objectContaining({
				type: "session_snapshot_end",
				activeSessionId: siblingActiveSessionId,
				snapshotId: siblingSnapshotId,
			}),
		);
		expect(state.clients.has(client)).toBe(false);
		expect(client.attachedActiveSessionIds.has(activeSessionId)).toBe(false);
		expect(client.attachedActiveSessionIds.has(siblingActiveSessionId)).toBe(true);
		expect(client.snapshotStreaming).toBe(false);
		expect(client.snapshotActiveSessionIds?.size).toBe(0);
		expect(client.snapshotActiveSessionCounts?.size).toBe(0);
		expect(client.snapshotTransferAbortControllers?.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.listenerCount("close")).toBe(0);
		expect(socket.listenerCount("error")).toBe(0);
		expect(socket.destroyed).toBe(false);
		socket.destroy();
	});

	it("closes a permanently backpressured worker channel after an aborted snapshot", async () => {
		vi.useFakeTimers();
		try {
			const root = tempDirectory();
			const daemon = new AgentDaemon(join(root, "worker.sock"), {
				defaultSessionConfig: { agentDir: root, cwd: root },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const { client, socket } = socketClient("worker-permanent-backpressure");
			const siblingActiveSessionId = "active-4601-backpressure-sibling";
			client.attachedActiveSessionIds.add(siblingActiveSessionId);
			socket.on("error", () => {});
			const state = {
				activeSessionId,
				clients: new Set([client]),
				extensionUiRequests: new Map(),
				runtime: { metadata: { kind: "subagent" } },
			} as unknown as ActiveSessionState;
			const signal = markClientSnapshotStreaming(client, activeSessionId);
			const internals = daemon as unknown as {
				writeSerialized(client: DaemonSocketClient, buffer: string | Buffer, message?: DaemonOutbound): boolean;
				streamWorkerSnapshot(
					client: DaemonSocketClient,
					result: DaemonAttachResult,
					transcript: SnapshotTranscriptChunkSource,
					purpose: "attach",
					signal: AbortSignal,
					snapshotAlreadyMarked: boolean,
				): Promise<void>;
				detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
			};
			internals.writeSerialized = () => false;
			const stream = internals.streamWorkerSnapshot(
				client,
				streamedResult(2),
				createSnapshotTranscriptChunks({ activeSessionId, snapshotId, messages: messages("blocked"), signal }),
				"attach",
				signal,
				true,
			);
			for (let attempt = 0; attempt < 10 && socket.listenerCount("drain") === 0; attempt++) {
				await Promise.resolve();
			}

			internals.detachClientFromSession(client, state);
			for (let attempt = 0; attempt < 10 && vi.getTimerCount() === 0; attempt++) {
				await Promise.resolve();
			}
			expect(vi.getTimerCount()).toBe(1);
			await vi.advanceTimersByTimeAsync(1_000);
			await stream;

			expect(socket.destroyed).toBe(true);
			expect(client.attachedActiveSessionIds.has(siblingActiveSessionId)).toBe(true);
			expect(client.snapshotStreaming).toBe(false);
			expect(client.snapshotActiveSessionIds?.size).toBe(0);
			expect(client.snapshotTransferAbortControllers?.size).toBe(0);
			expect(socket.listenerCount("drain")).toBe(0);
			expect(socket.listenerCount("close")).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("leaves the supervisor transcript cache file-backed and reader-owned", () => {
		const cache = new SnapshotTranscriptCache({
			activeSessionId,
			snapshotId,
			messages: messages("supervisor"),
			cacheRoot: tempDirectory(),
			memoryCacheBytes: 1,
			targetChunkBytes: 1,
		});
		const release = cache.retain();
		const firstChunk = cache.readChunk(0);

		expect(cache.fileBacked).toBe(true);
		cache.dispose();
		expect(cache.readChunk(0)).toEqual(firstChunk);
		release();
		expect(() => cache.readChunk(0)).toThrow("Unknown snapshot transcript chunk");
	});
});
