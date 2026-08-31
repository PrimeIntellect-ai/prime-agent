/**
 * Benchmark: daemon fan-out and attach serialization with many clients.
 *
 * This uses real local sockets but no providers or agent runtimes. It compares
 * the legacy per-recipient serialization/full-history attach paths with v2's
 * compact encode-once deltas and one cached, chunked transcript encoding.
 *
 * Run from packages/coding-agent:
 *
 *   npx tsx test/daemon-multiclient-bench.ts
 *   npx tsx test/daemon-multiclient-bench.ts --session-file /path/to/session.jsonl
 *   npx tsx test/daemon-multiclient-bench.ts --generated-session-mib 100
 *   npx tsx test/daemon-multiclient-bench.ts --generated-session-mib 500
 */
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "../src/core/session-manager.js";
import { createCompactAssistantDelta } from "../src/modes/daemon/compact-session-stream.js";
import type { DaemonOutbound } from "../src/modes/daemon/daemon-protocol.js";
import { SnapshotTranscriptCache } from "../src/modes/daemon/snapshot-transcript-cache.js";
import { serializeJsonLine } from "../src/modes/rpc/jsonl.js";

const CLIENT_COUNTS = [1, 10, 50, 100, 250] as const;
const SESSION_CLIENT_COUNTS = [1, 2, 5, 10] as const;
const STREAM_CHARS = 8192;
const STREAM_CHUNK_CHARS = 128;
const ATTACH_HISTORY_MESSAGES = 256;
const ATTACH_MESSAGE_CHARS = 1024;
const MEBIBYTE = 1024 * 1024;

interface Counters {
	serializations: number;
	serializationMs: number;
	maxSerializationMs: number;
	writes: number;
	writtenBytes: number;
}

interface BenchmarkResult extends Counters {
	scenario: "fanout" | "fanout-v2" | "attach" | "attach-v2" | "session-attach" | "session-attach-v2";
	clients: number;
	elapsedMs: number;
	throughputMiBPerSecond: number;
	heapDeltaMiB: number;
	rssDeltaMiB: number;
	externalDeltaMiB: number;
	peakRssDeltaMiB: number;
}

interface GeneratedSessionFixture {
	file: string;
	directory: string;
	bytes: number;
	messageCount: number;
}

interface SessionLoadResult {
	fileBytes: number;
	loadMs: number;
	contextMs: number;
	messageCount: number;
	heapDeltaMiB: number;
	rssDeltaMiB: number;
	externalDeltaMiB: number;
	peakRssDeltaMiB: number;
}

interface Receiver {
	readonly done: Promise<void>;
	setExpectedBytes(bytes: number): void;
}

interface SocketHarness {
	readonly server: Server;
	readonly senders: Socket[];
	readonly receivers: Receiver[];
	readonly receiverSockets: Socket[];
	readonly socketPath: string;
	close(): Promise<void>;
}

let socketCounter = 0;

function socketPathForRun(): string {
	socketCounter++;
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\prime-agent-multiclient-bench-${process.pid}-${socketCounter}`;
	}
	return `/tmp/prime-agent-multiclient-${process.pid}-${socketCounter}.sock`;
}

async function removeSocketPath(socketPath: string): Promise<void> {
	if (process.platform === "win32") {
		return;
	}
	try {
		await unlink(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
	}
}

function createReceiver(socket: Socket): Receiver {
	let receivedBytes = 0;
	let expectedBytes: number | undefined;
	let settled = false;
	let resolveDone!: () => void;
	let rejectDone!: (error: Error) => void;
	const done = new Promise<void>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});

	const checkComplete = () => {
		if (!settled && expectedBytes !== undefined && receivedBytes >= expectedBytes) {
			settled = true;
			resolveDone();
		}
	};
	socket.on("data", (chunk: Buffer) => {
		receivedBytes += chunk.length;
		checkComplete();
	});
	socket.on("error", (error) => {
		if (!settled) {
			settled = true;
			rejectDone(error);
		}
	});
	socket.on("close", () => {
		if (!settled && expectedBytes !== undefined && receivedBytes < expectedBytes) {
			settled = true;
			rejectDone(new Error(`Socket closed after ${receivedBytes} of ${expectedBytes} expected bytes`));
		}
	});

	return {
		done,
		setExpectedBytes(bytes: number): void {
			if (expectedBytes !== undefined) {
				throw new Error("Expected byte count was already set");
			}
			expectedBytes = bytes;
			checkComplete();
		},
	};
}

async function createSocketHarness(clientCount: number): Promise<SocketHarness> {
	const socketPath = socketPathForRun();
	await removeSocketPath(socketPath);

	const senders: Socket[] = [];
	let resolveAccepted!: () => void;
	const accepted = new Promise<void>((resolve) => {
		resolveAccepted = resolve;
	});
	const server = createServer((socket) => {
		senders.push(socket);
		if (senders.length === clientCount) {
			resolveAccepted();
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	// Connection setup is outside the measured region. Open sequentially so the
	// benchmark itself works on hosts with a small Unix-socket accept backlog.
	const receiverSockets: Socket[] = [];
	for (let index = 0; index < clientCount; index++) {
		const socket = createConnection(socketPath);
		await new Promise<void>((resolve, reject) => {
			const onConnect = () => {
				socket.off("error", reject);
				resolve();
			};
			socket.once("connect", onConnect);
			socket.once("error", reject);
		});
		receiverSockets.push(socket);
	}
	await accepted;
	const receivers = receiverSockets.map(createReceiver);

	return {
		server,
		senders,
		receivers,
		receiverSockets,
		socketPath,
		async close(): Promise<void> {
			for (const socket of [...senders, ...receiverSockets]) {
				socket.destroy();
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await removeSocketPath(socketPath);
		},
	};
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "benchmark-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1_700_000_000_000,
	};
}

function createStreamingEvent(text: string, delta: string, sequence: number): object {
	const activeSessionId = "active-benchmark";
	return {
		type: "session_event",
		activeSessionId,
		event: {
			type: "message_update",
			message: createAssistantMessage(text),
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
		},
		meta: {
			id: `${activeSessionId}:${sequence}`,
			protocol: { name: "prime-agent.daemon", version: 1 },
			activeSessionId,
			sequence,
			emittedAt: "2026-01-01T00:00:00.000Z",
		},
	};
}

function repeatedText(length: number, seed: string): string {
	return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

const streamCorpus = repeatedText(STREAM_CHARS, "Prime Agent daemon multi-client streaming benchmark. ");
const attachMessages = Array.from({ length: ATTACH_HISTORY_MESSAGES }, (_, index) => {
	const text = repeatedText(ATTACH_MESSAGE_CHARS, `history-message-${index} `);
	return index % 2 === 0
		? { role: "user", content: text, timestamp: 1_700_000_000_000 + index }
		: createAssistantMessage(text);
});

function createAttachResponse(clientIndex: number): object {
	return createAttachResponseForMessages(attachMessages, clientIndex);
}

function createAttachResponseForMessages(
	messages: readonly AgentMessage[] | readonly object[],
	clientIndex: number,
): object {
	const activeSessionId = "active-benchmark";
	const summary = {
		id: activeSessionId,
		lifecycle: "live",
		activity: "idle",
		runtimeKind: "top-level",
		activeSessionId,
		sessionId: "session-benchmark",
		cwd: "/tmp/prime-agent-benchmark",
		isStreaming: false,
		isCompacting: false,
		attachedClients: clientIndex + 1,
		messageCount: messages.length,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
	const state = {
		activeSessionId,
		cwd: summary.cwd,
		isStreaming: false,
		isCompacting: false,
		isBashRunning: false,
		retryAttempt: 0,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		sessionId: summary.sessionId,
		sessionDir: "/tmp/prime-agent-benchmark/sessions",
		leafId: "leaf-benchmark",
		autoCompactionEnabled: true,
		messageCount: messages.length,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		compactionCount: 0,
		scopedModels: [],
		activeToolNames: ["read", "bash", "edit"],
	};
	return {
		id: `attach-${clientIndex}`,
		type: "response",
		command: "attach",
		success: true,
		data: {
			protocol: { name: "prime-agent.daemon", version: 1 },
			activeSessionId,
			snapshot: {
				activeSessionId,
				summary,
				state,
				messages,
				lastEventSequence: 0,
			},
			replay: { status: "complete", toSequence: 0 },
			lastEventSequence: 0,
			client: {
				id: `client-${clientIndex}`,
				capabilities: ["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"],
			},
		},
	};
}

function writeToRecipient(socket: Socket, message: object, counters: Counters): number {
	// Intentionally matches AgentDaemon.write(): serialization occurs for every recipient.
	const serializationStart = performance.now();
	const line = serializeJsonLine(message);
	const serializationMs = performance.now() - serializationStart;
	const bytes = Buffer.byteLength(line);
	counters.serializations++;
	counters.serializationMs += serializationMs;
	counters.maxSerializationMs = Math.max(counters.maxSerializationMs, serializationMs);
	counters.writes++;
	counters.writtenBytes += bytes;
	socket.write(line);
	return bytes;
}

function writeBufferToRecipient(socket: Socket, buffer: string | Buffer, counters: Counters): number {
	const bytes = typeof buffer === "string" ? Buffer.byteLength(buffer) : buffer.length;
	counters.writes++;
	counters.writtenBytes += bytes;
	socket.write(buffer);
	return bytes;
}

async function runScenario(
	scenario: BenchmarkResult["scenario"],
	clientCount: number,
	work: (harness: SocketHarness, counters: Counters, expectedBytes: number[]) => void,
): Promise<BenchmarkResult> {
	const harness = await createSocketHarness(clientCount);
	try {
		const counters: Counters = {
			serializations: 0,
			serializationMs: 0,
			maxSerializationMs: 0,
			writes: 0,
			writtenBytes: 0,
		};
		const expectedBytes = Array.from({ length: clientCount }, () => 0);
		const memoryBefore = process.memoryUsage();
		let peakRss = memoryBefore.rss;
		const sampler = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 1);
		try {
			const start = performance.now();
			work(harness, counters, expectedBytes);
			for (let index = 0; index < harness.receivers.length; index++) {
				harness.receivers[index]!.setExpectedBytes(expectedBytes[index]!);
			}
			await Promise.all(harness.receivers.map((receiver) => receiver.done));
			const elapsedMs = performance.now() - start;
			const memoryAfter = process.memoryUsage();
			peakRss = Math.max(peakRss, memoryAfter.rss);
			return {
				scenario,
				clients: clientCount,
				...counters,
				elapsedMs,
				throughputMiBPerSecond: counters.writtenBytes / MEBIBYTE / (elapsedMs / 1000),
				heapDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "heapUsed"),
				rssDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "rss"),
				externalDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "external"),
				peakRssDeltaMiB: (peakRss - memoryBefore.rss) / MEBIBYTE,
			};
		} finally {
			clearInterval(sampler);
		}
	} finally {
		await harness.close();
	}
}

async function runFanout(clientCount: number): Promise<BenchmarkResult> {
	return runScenario("fanout", clientCount, (harness, counters, expectedBytes) => {
		for (let offset = 0, sequence = 1; offset < streamCorpus.length; sequence++) {
			const nextOffset = Math.min(offset + STREAM_CHUNK_CHARS, streamCorpus.length);
			const delta = streamCorpus.slice(offset, nextOffset);
			const message = createStreamingEvent(streamCorpus.slice(0, nextOffset), delta, sequence);
			for (let index = 0; index < harness.senders.length; index++) {
				expectedBytes[index]! += writeToRecipient(harness.senders[index]!, message, counters);
			}
			offset = nextOffset;
		}
	});
}

async function runFanoutV2(clientCount: number): Promise<BenchmarkResult> {
	return runScenario("fanout-v2", clientCount, (harness, counters, expectedBytes) => {
		for (let offset = 0, sequence = 1; offset < streamCorpus.length; sequence++) {
			const nextOffset = Math.min(offset + STREAM_CHUNK_CHARS, streamCorpus.length);
			const delta = streamCorpus.slice(offset, nextOffset);
			const partial = createAssistantMessage(streamCorpus.slice(0, nextOffset));
			const compact = createCompactAssistantDelta({
				type: "session_event",
				activeSessionId: "active-benchmark",
				event: {
					type: "message_update",
					message: partial,
					assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
				},
				meta: {
					id: `active-benchmark:${sequence}`,
					protocol: { name: "prime-agent.daemon", version: 2 },
					activeSessionId: "active-benchmark",
					sequence,
					cursor: { generation: "benchmark-generation", sequence },
					emittedAt: "2026-01-01T00:00:00.000Z",
				},
			} satisfies DaemonOutbound);
			if (!compact) {
				throw new Error("Expected compact assistant delta");
			}
			const serializationStart = performance.now();
			const line = serializeJsonLine(compact);
			const serializationMs = performance.now() - serializationStart;
			counters.serializations++;
			counters.serializationMs += serializationMs;
			counters.maxSerializationMs = Math.max(counters.maxSerializationMs, serializationMs);
			for (let index = 0; index < harness.senders.length; index++) {
				expectedBytes[index]! += writeBufferToRecipient(harness.senders[index]!, line, counters);
			}
			offset = nextOffset;
		}
	});
}

async function runAttach(clientCount: number): Promise<BenchmarkResult> {
	return runScenario("attach", clientCount, (harness, counters, expectedBytes) => {
		for (let index = 0; index < harness.senders.length; index++) {
			// The daemon constructs and serializes a fresh attach response per client.
			expectedBytes[index]! += writeToRecipient(harness.senders[index]!, createAttachResponse(index), counters);
		}
	});
}

async function runAttachV2(
	messages: readonly AgentMessage[],
	clientCount: number,
	scenario: "attach-v2" | "session-attach-v2",
): Promise<BenchmarkResult> {
	const cacheRoot = await mkdtemp(join(tmpdir(), "prime-agent-attach-v2-bench-"));
	const transcript = new SnapshotTranscriptCache({
		activeSessionId: "active-benchmark",
		snapshotId: `snapshot-${randomUUID()}`,
		messages,
		cacheRoot,
	});
	try {
		return await runScenario(scenario, clientCount, (harness, counters, expectedBytes) => {
			const begin = serializeJsonLine({
				type: "session_snapshot_begin",
				activeSessionId: "active-benchmark",
				snapshotId: transcript.snapshotId,
				snapshot: {
					activeSessionId: "active-benchmark",
					summary: { sessionId: "session-benchmark", messageCount: messages.length },
					state: { sessionId: "session-benchmark", messageCount: messages.length },
					lastEventSequence: 0,
					lastEventCursor: { generation: "benchmark-generation", sequence: 0 },
				},
				messageCount: messages.length,
				targetChunkBytes: transcript.targetChunkBytes,
			});
			const end = serializeJsonLine({
				type: "session_snapshot_end",
				activeSessionId: "active-benchmark",
				snapshotId: transcript.snapshotId,
				chunkCount: transcript.chunkCount,
				lastEventSequence: 0,
				lastEventCursor: { generation: "benchmark-generation", sequence: 0 },
			});
			counters.serializations += 2;
			for (let clientIndex = 0; clientIndex < harness.senders.length; clientIndex++) {
				const sender = harness.senders[clientIndex]!;
				const acknowledgement = {
					id: `attach-${clientIndex}`,
					type: "response",
					command: "attach",
					success: true,
					data: {
						activeSessionId: "active-benchmark",
						snapshotStream: {
							id: transcript.snapshotId,
							messageCount: messages.length,
							targetChunkBytes: transcript.targetChunkBytes,
						},
					},
				};
				expectedBytes[clientIndex]! += writeToRecipient(sender, acknowledgement, counters);
				expectedBytes[clientIndex]! += writeBufferToRecipient(sender, begin, counters);
				for (let chunkIndex = 0; chunkIndex < transcript.chunkCount; chunkIndex++) {
					expectedBytes[clientIndex]! += writeBufferToRecipient(
						sender,
						transcript.readChunk(chunkIndex),
						counters,
					);
				}
				expectedBytes[clientIndex]! += writeBufferToRecipient(sender, end, counters);
			}
		});
	} finally {
		transcript.dispose();
		await rm(cacheRoot, { recursive: true, force: true });
	}
}

async function runSessionAttach(messages: readonly AgentMessage[], clientCount: number): Promise<BenchmarkResult> {
	return runScenario("session-attach", clientCount, (harness, counters, expectedBytes) => {
		for (let index = 0; index < harness.senders.length; index++) {
			expectedBytes[index]! += writeToRecipient(
				harness.senders[index]!,
				createAttachResponseForMessages(messages, index),
				counters,
			);
		}
	});
}

function memoryDeltaMiB(
	after: NodeJS.MemoryUsage,
	before: NodeJS.MemoryUsage,
	field: keyof NodeJS.MemoryUsage,
): number {
	return (after[field] - before[field]) / MEBIBYTE;
}

async function loadSessionFixture(sessionFile: string): Promise<{
	messages: AgentMessage[];
	load: SessionLoadResult;
	cleanup(): Promise<void>;
}> {
	const sourceStats = await stat(sessionFile);
	if (!sourceStats.isFile()) {
		throw new Error(`Session path is not a file: ${sessionFile}`);
	}

	// Work on a private copy: SessionManager may rewrite old session versions during
	// migration, and a live daemon may append to the source while this benchmark runs.
	const tempDir = await mkdtemp(join(tmpdir(), "prime-agent-session-bench-"));
	const fixturePath = join(tempDir, "session.jsonl");
	await copyFile(sessionFile, fixturePath);

	try {
		const memoryBefore = process.memoryUsage();
		let peakRss = memoryBefore.rss;
		const sampler = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 1);
		let sessionManager: SessionManager;
		let loadMs: number;
		try {
			const loadStart = performance.now();
			sessionManager = await SessionManager.openAsync(fixturePath, tempDir, process.cwd());
			loadMs = performance.now() - loadStart;
		} finally {
			clearInterval(sampler);
		}

		const contextStart = performance.now();
		const context = sessionManager.buildSessionContext();
		const contextMs = performance.now() - contextStart;
		const memoryAfter = process.memoryUsage();
		peakRss = Math.max(peakRss, memoryAfter.rss);

		return {
			messages: context.messages,
			load: {
				fileBytes: sourceStats.size,
				loadMs,
				contextMs,
				messageCount: context.messages.length,
				heapDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "heapUsed"),
				rssDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "rss"),
				externalDeltaMiB: memoryDeltaMiB(memoryAfter, memoryBefore, "external"),
				peakRssDeltaMiB: (peakRss - memoryBefore.rss) / MEBIBYTE,
			},
			cleanup: () => rm(tempDir, { recursive: true, force: true }),
		};
	} catch (error) {
		await rm(tempDir, { recursive: true, force: true });
		throw error;
	}
}

function printResults(
	results: BenchmarkResult[],
	details = `stream=${STREAM_CHARS} chars/${STREAM_CHUNK_CHARS}-char chunks; attach=${ATTACH_HISTORY_MESSAGES} messages x ${ATTACH_MESSAGE_CHARS} chars`,
): void {
	console.log("Prime Agent daemon multi-client benchmark");
	console.log(details);
	console.table(
		results.map((result) => ({
			scenario: result.scenario,
			clients: result.clients,
			serializations: result.serializations,
			"serialize ms": result.serializationMs.toFixed(1),
			"max serialize ms": result.maxSerializationMs.toFixed(1),
			writes: result.writes,
			MiB: (result.writtenBytes / MEBIBYTE).toFixed(2),
			"elapsed ms": result.elapsedMs.toFixed(1),
			"MiB/s": result.throughputMiBPerSecond.toFixed(1),
			"heap delta MiB": result.heapDeltaMiB.toFixed(1),
			"RSS delta MiB": result.rssDeltaMiB.toFixed(1),
			"external delta MiB": result.externalDeltaMiB.toFixed(1),
			"peak RSS delta MiB": result.peakRssDeltaMiB.toFixed(1),
		})),
	);
}

function printSessionLoad(sessionFile: string, result: SessionLoadResult): void {
	console.log("Prime Agent real-session benchmark");
	console.log(`fixture: ${basename(sessionFile)} (${(result.fileBytes / MEBIBYTE).toFixed(2)} MiB)`);
	console.table([
		{
			"load ms": result.loadMs.toFixed(1),
			"context ms": result.contextMs.toFixed(1),
			messages: result.messageCount,
			"heap delta MiB": result.heapDeltaMiB.toFixed(1),
			"RSS delta MiB": result.rssDeltaMiB.toFixed(1),
			"external delta MiB": result.externalDeltaMiB.toFixed(1),
			"sampled peak RSS delta MiB": result.peakRssDeltaMiB.toFixed(1),
		},
	]);
}

function sessionFileArg(args: readonly string[]): string | undefined {
	const flagIndex = args.indexOf("--session-file");
	if (flagIndex === -1) {
		return undefined;
	}
	const value = args[flagIndex + 1];
	if (!value || value.startsWith("--")) {
		throw new Error("--session-file requires a path");
	}
	return value;
}

function generatedSessionMiBArg(args: readonly string[]): number | undefined {
	const flagIndex = args.indexOf("--generated-session-mib");
	if (flagIndex === -1) {
		return undefined;
	}
	const value = args[flagIndex + 1];
	if (!value || value.startsWith("--")) {
		throw new Error("--generated-session-mib requires 100 or 500");
	}
	const parsed = Number(value);
	if (parsed !== 100 && parsed !== 500) {
		throw new Error("--generated-session-mib must be 100 or 500");
	}
	return parsed;
}

function writeStreamChunk(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			stream.off("error", onError);
			reject(error);
		};
		stream.once("error", onError);
		stream.write(chunk, () => {
			stream.off("error", onError);
			resolve();
		});
	});
}

function closeWriteStream(stream: NodeJS.WritableStream): Promise<void> {
	return new Promise((resolve, reject) => {
		stream.once("error", reject);
		stream.end(() => resolve());
	});
}

async function generateSessionFixture(sizeMiB: number): Promise<GeneratedSessionFixture> {
	const directory = await mkdtemp(join(tmpdir(), `prime-agent-generated-${sizeMiB}mib-`));
	const file = join(directory, `generated-${sizeMiB}mib.jsonl`);
	const targetBytes = sizeMiB * MEBIBYTE;
	const stream = createWriteStream(file, { encoding: "utf8" });
	const timestamp = new Date(1_700_000_000_000).toISOString();
	const sessionId = randomUUID();
	const header = `${JSON.stringify({
		type: "session",
		version: 3,
		id: sessionId,
		timestamp,
		cwd: process.cwd(),
	})}\n`;
	let bytes = Buffer.byteLength(header);
	let messageCount = 0;
	let parentId: string | null = null;

	try {
		await writeStreamChunk(stream, header);
		while (bytes < targetBytes) {
			const entryId = randomUUID();
			const remaining = targetBytes - bytes;
			const payloadChars = Math.max(1, Math.min(512 * 1024, remaining - 512));
			const text = repeatedText(payloadChars, `generated-session-${messageCount} `);
			const role = messageCount % 2 === 0 ? "user" : "assistant";
			const message =
				role === "user"
					? { role, content: text, timestamp: 1_700_000_000_000 + messageCount }
					: createAssistantMessage(text);
			const line = `${JSON.stringify({
				type: "message",
				id: entryId,
				parentId,
				timestamp,
				message,
			})}\n`;
			await writeStreamChunk(stream, line);
			bytes += Buffer.byteLength(line);
			messageCount++;
			parentId = entryId;
		}
		await closeWriteStream(stream);
		return { file, directory, bytes, messageCount };
	} catch (error) {
		stream.destroy();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

async function runRealSessionBenchmark(sessionFile: string): Promise<void> {
	const fixture = await loadSessionFixture(sessionFile);
	try {
		printSessionLoad(sessionFile, fixture.load);
		const results: BenchmarkResult[] = [];
		for (const clientCount of SESSION_CLIENT_COUNTS) {
			results.push(await runSessionAttach(fixture.messages, clientCount));
			results.push(await runAttachV2(fixture.messages, clientCount, "session-attach-v2"));
		}
		console.log("Attach snapshot fan-out for the resolved active message path");
		printResults(results, `session messages=${fixture.load.messageCount}`);
	} finally {
		await fixture.cleanup();
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const sessionFile = sessionFileArg(args);
	const generatedSessionMiB = generatedSessionMiBArg(args);
	if (sessionFile && generatedSessionMiB !== undefined) {
		throw new Error("Use either --session-file or --generated-session-mib, not both");
	}
	if (sessionFile) {
		await runRealSessionBenchmark(sessionFile);
		return;
	}
	if (generatedSessionMiB !== undefined) {
		const fixture = await generateSessionFixture(generatedSessionMiB);
		try {
			console.log(
				`Generated ${generatedSessionMiB} MiB fixture with ${fixture.messageCount} messages ` +
					`(${(fixture.bytes / MEBIBYTE).toFixed(2)} MiB on disk)`,
			);
			await runRealSessionBenchmark(fixture.file);
		} finally {
			await rm(fixture.directory, { recursive: true, force: true });
		}
		return;
	}
	const results: BenchmarkResult[] = [];
	for (const clientCount of CLIENT_COUNTS) {
		results.push(await runFanout(clientCount));
		results.push(await runFanoutV2(clientCount));
	}
	for (const clientCount of CLIENT_COUNTS) {
		results.push(await runAttach(clientCount));
		results.push(await runAttachV2(attachMessages as AgentMessage[], clientCount, "attach-v2"));
	}
	printResults(results);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
