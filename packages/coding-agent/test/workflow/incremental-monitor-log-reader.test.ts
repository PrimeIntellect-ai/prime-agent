import { execFile as execFileCallback } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { appendFile, mkdtemp, open as openFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	createIncrementalMonitorLogReader,
	createNodeIncrementalMonitorLogFileSystem,
	type IncrementalMonitorLogCursor,
	type IncrementalMonitorLogCursorAuthority,
	type IncrementalMonitorLogFileHandle,
	type IncrementalMonitorLogFileSystem,
} from "../../src/core/workflow/incremental-monitor-log-reader.js";

const execFile = promisify(execFileCallback);

interface TestEvent {
	id: string;
	relevant?: boolean;
	message: string;
}

const parseEvent = (line: string): TestEvent | null => {
	if (line.length === 0) return null;
	try {
		return JSON.parse(line) as TestEvent;
	} catch (error) {
		if (error instanceof SyntaxError) return null;
		throw error;
	}
};

const isRelevant = (event: TestEvent): boolean => event.relevant === true;

function eventLine(id: string, message = id, relevant = true): string {
	return `${JSON.stringify({ id, message, relevant })}\n`;
}

function recomputeLegacyCursorDigest(cursor: IncrementalMonitorLogCursor): string {
	const sourceCheckpoint = cursor.sourceCheckpoint;
	const payload = {
		version: cursor.version,
		sourceIdentity: {
			kind: cursor.sourceIdentity.kind,
			device: cursor.sourceIdentity.device,
			inode: cursor.sourceIdentity.inode,
			generation: cursor.sourceIdentity.generation,
		},
		sourceCheckpoint:
			sourceCheckpoint === null
				? null
				: {
						sourceSizeBytes: sourceCheckpoint.sourceSizeBytes,
						sourceMutationFingerprint: sourceCheckpoint.sourceMutationFingerprint,
						prefixDigest: sourceCheckpoint.prefixDigest,
						prefixBytes: sourceCheckpoint.prefixBytes,
						anchorOffset: sourceCheckpoint.anchorOffset,
						anchorDigest: sourceCheckpoint.anchorDigest,
						anchorBytes: sourceCheckpoint.anchorBytes,
						tailOffset: sourceCheckpoint.tailOffset,
						tailDigest: sourceCheckpoint.tailDigest,
						tailBytes: sourceCheckpoint.tailBytes,
					},
		byteOffset: cursor.byteOffset,
		trailingPartialLine: cursor.trailingPartialLine,
		trailingPartialLineBytes: cursor.trailingPartialLineBytes,
		baseline:
			cursor.baseline.mode === "bounded_historical"
				? { mode: cursor.baseline.mode, maxBytes: cursor.baseline.maxBytes }
				: { mode: cursor.baseline.mode },
		baselineOmittedBytes: cursor.baselineOmittedBytes,
		skipLeadingPartialLine: cursor.skipLeadingPartialLine,
		seenEventIds: cursor.seenEventIds,
	};
	return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function createCursorAuthority(key = "monitor-log-test-key"): IncrementalMonitorLogCursorAuthority {
	return {
		sign: (payload) => createHmac("sha256", key).update(payload, "utf8").digest("hex"),
		verify: (payload, mac) => createHmac("sha256", key).update(payload, "utf8").digest("hex") === mac,
	};
}

async function withTempLog<T>(name: string, callback: (path: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), `prime-monitor-${name}-`));
	const path = join(root, "monitor.log");
	try {
		return await callback(path);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function createReader(
	path: string,
	overrides: Partial<Parameters<typeof createIncrementalMonitorLogReader<TestEvent>>[0]> = {},
) {
	return createIncrementalMonitorLogReader<TestEvent>({
		path,
		baseline: { mode: "from_start" },
		cursorAuthority: createCursorAuthority(),
		parseLine: parseEvent,
		isRelevant,
		eventIdentity: (event) => event.id,
		limits: { maxBytes: 64 * 1024, maxEvents: 100, maxElapsedMs: 1_000 },
		...overrides,
	});
}

function instrumentReads(base: IncrementalMonitorLogFileSystem): {
	fileSystem: IncrementalMonitorLogFileSystem;
	reads: Array<{ offset: number; maxBytes: number; actualBytes: number }>;
} {
	const reads: Array<{ offset: number; maxBytes: number; actualBytes: number }> = [];
	return {
		reads,
		fileSystem: {
			open: async (path) => {
				const handle = await base.open(path);
				return {
					stat: () => handle.stat(),
					readAt: async (offset, maxBytes) => {
						const bytes = await handle.readAt(offset, maxBytes);
						reads.push({ offset, maxBytes, actualBytes: bytes.byteLength });
						return bytes;
					},
					close: () => handle.close(),
				} satisfies IncrementalMonitorLogFileHandle;
			},
		},
	};
}

describe("incremental monitor log reader", () => {
	it("reads only bounded appended pages and reopens exactly at the durable cursor", async () => {
		await withTempLog("restart", async (path) => {
			await writeFile(path, `${eventLine("old-1")}not relevant\n${eventLine("old-2").trimEnd()}`);
			const base = createNodeIncrementalMonitorLogFileSystem();
			const instrumented = instrumentReads(base);
			const reader = createReader(path, {
				fileSystem: instrumented.fileSystem,
				limits: { maxBytes: 128, maxEvents: 1, maxElapsedMs: 1_000 },
			});

			const first = await reader.readPage();
			expect(first.events.map((event) => event.id)).toEqual(["old-1"]);
			expect(first.continuation.hasMore).toBe(true);

			const partial = await reader.readPage(first.cursor);
			expect(partial.events).toEqual([]);
			expect(partial.cursor.trailingPartialLine).toContain("old-2");
			expect(instrumented.reads.slice(0, 1).every((read) => read.maxBytes <= 128)).toBe(true);

			await appendFile(path, `\n${eventLine("new-1")}not relevant\n${eventLine("new-2")}`);
			const afterAppendReader = createReader(path, {
				fileSystem: instrumented.fileSystem,
				limits: { maxBytes: 128, maxEvents: 2, maxElapsedMs: 1_000 },
			});
			const afterAppend = await afterAppendReader.readPage(partial.cursor);
			expect(afterAppend.events.map((event) => event.id)).toEqual(["old-2", "new-1"]);
			expect(afterAppend.continuation.hasMore).toBe(true);
			expect(afterAppend.events).toHaveLength(2);

			const reopened = createReader(path, {
				fileSystem: instrumented.fileSystem,
				limits: { maxBytes: 128, maxEvents: 10, maxElapsedMs: 1_000 },
			});
			const persistedCursor = JSON.parse(JSON.stringify(afterAppend.cursor)) as typeof afterAppend.cursor;
			const resumed = await reopened.readPage(persistedCursor);
			expect(resumed.events.map((event) => event.id)).toEqual(["new-2"]);
			const replayed = await reopened.readPage(resumed.cursor);
			expect(replayed.events).toEqual([]);
			expect(instrumented.reads.every((read) => read.maxBytes <= 128)).toBe(true);
		});
	});

	it("completes a trailing partial line exactly once and paginates by event count", async () => {
		await withTempLog("partial", async (path) => {
			await writeFile(path, JSON.stringify({ id: "partial", message: "unfinished", relevant: true }));
			const reader = createReader(path, {
				limits: { maxBytes: 256, maxEvents: 10, maxElapsedMs: 1_000 },
			});
			const unfinished = await reader.readPage();
			expect(unfinished.events).toEqual([]);
			expect(unfinished.cursor.trailingPartialLine).toContain('"partial"');

			await appendFile(path, `\n${eventLine("next")}${eventLine("last")}`);
			const completed = await reader.readPage(unfinished.cursor);
			expect(completed.events.map((event) => event.id)).toEqual(["partial", "next", "last"]);
			expect(completed.cursor.trailingPartialLine).toBe("");
			const afterRestart = await createReader(path).readPage(completed.cursor);
			expect(afterRestart.events).toEqual([]);
		});
	});

	it("resets on replacement and truncation while deduplicating stable event identities", async () => {
		await withTempLog("identity", async (path) => {
			await writeFile(path, `${eventLine("stable-a")}${eventLine("stable-b")}`);
			const reader = createReader(path);
			const initial = await reader.readPage();
			const oldIdentity = initial.cursor.sourceIdentity;

			const rotatedPath = `${path}.1`;
			await rename(path, rotatedPath);
			await writeFile(path, `${eventLine("stable-a")}${eventLine("stable-c")}`);
			const replaced = await reader.readPage(initial.cursor);
			expect(replaced.events.map((event) => event.id)).toEqual(["stable-c"]);
			expect(replaced.cursor.sourceIdentity).not.toEqual(oldIdentity);

			await truncate(path, 0);
			await appendFile(path, eventLine("stable-d"));
			const truncated = await reader.readPage(replaced.cursor);
			expect(truncated.events.map((event) => event.id)).toEqual(["stable-d"]);
			const converged = await reader.readPage(truncated.cursor);
			expect(converged.events).toEqual([]);
		});
	});

	it("makes initialization baseline explicit instead of silently tailing historical data", async () => {
		await withTempLog("baseline", async (path) => {
			const historical = `${eventLine("before-window")}${"x".repeat(200)}\n${eventLine("in-window")}`;
			await writeFile(path, historical);
			const endReader = createReader(path, { baseline: { mode: "from_end" } });
			const fromEnd = await endReader.readPage();
			expect(fromEnd.events).toEqual([]);
			expect(fromEnd.cursor.baseline).toEqual({ mode: "from_end" });
			await appendFile(path, eventLine("after-end"));
			expect((await endReader.readPage(fromEnd.cursor)).events.map((event) => event.id)).toEqual(["after-end"]);

			const boundedReader = createReader(path, {
				baseline: { mode: "bounded_historical", maxBytes: Buffer.byteLength(eventLine("after-end")) },
			});
			const bounded = await boundedReader.readPage();
			expect(bounded.events.map((event) => event.id)).toEqual(["after-end"]);
			expect(bounded.cursor.baseline).toEqual({
				mode: "bounded_historical",
				maxBytes: Buffer.byteLength(eventLine("after-end")),
			});
			expect(bounded.cursor.baselineOmittedBytes).toBeGreaterThan(0);
		});
	});

	it("reports bounded retained-state telemetry and releases ephemeral event state", async () => {
		await withTempLog("telemetry", async (path) => {
			await writeFile(path, eventLine("telemetry", "a retained event"));
			const page = await createReader(path).readPage();
			expect(page.telemetry.cursorSerializedBytes).toBeGreaterThan(0);
			expect(page.telemetry.serializedEventBytes).toBeGreaterThan(0);
			expect(page.telemetry.largestRetainedValues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ kind: "cursor", type: "cursor" }),
					expect.objectContaining({ kind: "event", type: "object" }),
				]),
			);
			expect(page.telemetry.largestRetainedValues.length).toBeLessThanOrEqual(8);
			expect(Object.keys(page)).not.toEqual(expect.arrayContaining(["rawBytes", "decodedLines", "allLines"]));
			expect(page.events).toHaveLength(1);
			page.ephemeral.release();
			expect(page.events).toEqual([]);
			expect(page.cursor.byteOffset).toBeGreaterThan(0);
		});
	});

	it("bounds positional reads for a large sparse file and honors an elapsed-time page limit", async () => {
		await withTempLog("bounds", async (path) => {
			await writeFile(path, "");
			await truncate(path, 8 * 1024 * 1024);
			const base = createNodeIncrementalMonitorLogFileSystem();
			const instrumented = instrumentReads(base);
			let now = 0;
			const reader = createReader(path, {
				baseline: { mode: "from_end" },
				fileSystem: instrumented.fileSystem,
				clock: () => {
					const tick = now;
					now += 1;
					return tick;
				},
				limits: { maxBytes: 32, maxEvents: 100, maxElapsedMs: 50 },
			});
			const baseline = await reader.readPage();
			expect(baseline.events).toEqual([]);
			expect(instrumented.reads.length).toBeGreaterThan(0);
			expect(instrumented.reads.every((read) => read.maxBytes <= 32)).toBe(true);

			await appendFile(path, `${eventLine("first")}${eventLine("second")}`);
			instrumented.reads.length = 0;
			const page = await reader.readPage(baseline.cursor);
			expect(page.events.length).toBeLessThanOrEqual(1);
			expect(page.continuation.hasMore).toBe(true);
			expect(instrumented.reads.length).toBeGreaterThan(0);
			expect(instrumented.reads.every((read) => read.maxBytes <= 32)).toBe(true);
			expect(instrumented.reads.every((read) => read.actualBytes <= read.maxBytes)).toBe(true);
			expect(instrumented.reads.some((read) => read.offset >= 8 * 1024 * 1024)).toBe(true);
		});
	});

	it("detects copytruncate followed by regrowth instead of skipping the new prefix", async () => {
		await withTempLog("copytruncate-regrowth", async (path) => {
			await writeFile(path, `${eventLine("old-a")}${eventLine("old-b")}`);
			const reader = createReader(path, { limits: { maxBytes: 4096, maxEvents: 1, maxElapsedMs: 1_000 } });
			const first = await reader.readPage();
			expect(first.events.map((event) => event.id)).toEqual(["old-a"]);

			await truncate(path, 0);
			await appendFile(path, `${eventLine("new-a")}${eventLine("new-b")}${eventLine("new-c")}`);
			const regrown = await createReader(path, {
				limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 1_000 },
			}).readPage(first.cursor);
			expect(regrown.events.map((event) => event.id)).toEqual(["new-a", "new-b", "new-c"]);
		});
	});

	it("does not skip a rewritten prefix when copytruncate regrowth preserves checkpoint samples", async () => {
		await withTempLog("copytruncate-matching-samples", async (path) => {
			const oldPrefix = eventLine("prefix-old");
			const unchangedTail = eventLine("tail", "tail", false);
			await writeFile(path, `${oldPrefix}${unchangedTail}`);
			const reader = createReader(path, { limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 1_000 } });
			const first = await reader.readPage();
			expect(first.events.map((event) => event.id)).toEqual(["prefix-old"]);

			await truncate(path, 0);
			await appendFile(path, `${eventLine("prefix-new")}${unchangedTail}${eventLine("after")}`);
			const regrown = await createReader(path, {
				limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 1_000 },
			}).readPage(first.cursor);
			expect(regrown.events.map((event) => event.id)).toContain("prefix-new");
		});
	});

	it("does not commit stale events when the source mutates during a page", async () => {
		await withTempLog("mutation-during-page", async (path) => {
			await writeFile(path, eventLine("old-page"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			let mutated = false;
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					const handle = await base.open(sourcePath);
					return {
						stat: () => handle.stat(),
						readAt: async (offset, maxBytes) => {
							const bytes = await handle.readAt(offset, maxBytes);
							if (!mutated && maxBytes > 8) {
								mutated = true;
								const rewrite = await openFile(sourcePath, "r+");
								try {
									const replacement = Buffer.from(eventLine("new-page"));
									await rewrite.write(replacement, 0, replacement.byteLength, 0);
								} finally {
									await rewrite.close();
								}
							}
							return bytes;
						},
						close: () => handle.close(),
					} satisfies IncrementalMonitorLogFileHandle;
				},
			};
			await expect(createReader(path, { fileSystem }).readPage()).rejects.toThrow(
				/source_changed|mutation|retry|rebaseline/i,
			);
		});
	});

	it("opens one handle and rejects an identity change before emitting parsed events", async () => {
		await withTempLog("handle-toctou", async (path) => {
			await writeFile(path, eventLine("identity-change"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			let opened = 0;
			let stats = 0;
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					opened += 1;
					const handle = await base.open(sourcePath);
					return {
						stat: async () => {
							const snapshot = await handle.stat();
							stats += 1;
							return stats >= 3
								? { ...snapshot, sourceIdentity: { ...snapshot.sourceIdentity, generation: "swapped" } }
								: snapshot;
						},
						readAt: (offset, maxBytes) => handle.readAt(offset, maxBytes),
						close: () => handle.close(),
					};
				},
			};

			const reader = createReader(path, { fileSystem });
			await expect(reader.readPage()).rejects.toThrow(/source_changed|retry|identity/i);
			expect(opened).toBe(1);
			expect(stats).toBeGreaterThanOrEqual(3);
		});
	});

	it("rejects a symlink swap on the open handle before emitting events", async () => {
		await withTempLog("symlink-swap", async (path) => {
			await writeFile(path, eventLine("symlink-change"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					const handle = await base.open(sourcePath);
					let swapped = false;
					return {
						stat: async () => {
							if (!swapped) {
								swapped = true;
								const target = `${sourcePath}.real`;
								await rename(sourcePath, target);
								await symlink(target, sourcePath);
							}
							return handle.stat();
						},
						readAt: (offset, maxBytes) => handle.readAt(offset, maxBytes),
						close: () => handle.close(),
					} satisfies IncrementalMonitorLogFileHandle;
				},
			};
			await expect(createReader(path, { fileSystem }).readPage()).rejects.toThrow(/symlink|source_changed|retry/i);
		});
	});

	it("rejects oversized or structurally closed cursors before reading", async () => {
		await withTempLog("cursor-bounds", async (path) => {
			await writeFile(path, eventLine("cursor"));
			const reader = createReader(path, {
				maxPartialLineBytes: 8,
				maxSeenEventIds: 2,
				maxSeenEventIdsSerializedBytes: 16,
			});
			const page = await reader.readPage();
			await expect(reader.readPage({ ...page.cursor, trailingPartialLine: "x".repeat(9) })).rejects.toThrow(
				/partial|cursor/i,
			);
			await expect(reader.readPage({ ...page.cursor, seenEventIds: ["a", "b", "c"] })).rejects.toThrow(
				/event_ids|cursor/i,
			);
			await expect(reader.readPage({ ...page.cursor, seenEventIds: ["012345678901234567"] })).rejects.toThrow(
				/event_ids|cursor/i,
			);
			await expect(reader.readPage({ ...page.cursor, version: 2 as 1 })).rejects.toThrow(/version|cursor/i);
		});
	});

	it("does not commit events when a single I/O or parser call crosses the elapsed deadline", async () => {
		await withTempLog("elapsed-hard", async (path) => {
			await writeFile(path, eventLine("slow-io"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			let now = 0;
			const delayedIo: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					const handle = await base.open(sourcePath);
					return {
						stat: () => handle.stat(),
						readAt: async (offset, maxBytes) => {
							now = 100;
							return handle.readAt(offset, maxBytes);
						},
						close: () => handle.close(),
					};
				},
			};
			await expect(
				createReader(path, {
					fileSystem: delayedIo,
					clock: () => now,
					limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 10 },
				}).readPage(),
			).rejects.toThrow(/budget|elapsed/i);

			await writeFile(path, `${eventLine("parser-first")}${eventLine("parser-second")}`);
			now = 0;
			let parseCalls = 0;
			await expect(
				createReader(path, {
					clock: () => now,
					parseLine: (line) => {
						parseCalls += 1;
						if (parseCalls === 2) now = 100;
						return parseEvent(line);
					},
					limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 10 },
				}).readPage(),
			).rejects.toThrow(/budget|elapsed/i);
		});
	});

	it("gives default identities source-generation and byte-offset scope", async () => {
		await withTempLog("default-identities", async (path) => {
			const identical = eventLine("same");
			await writeFile(path, `${identical}${identical}`);
			const reader = createReader(path, { eventIdentity: undefined });
			const initial = await reader.readPage();
			expect(initial.events).toHaveLength(2);
			expect(await reader.readPage(initial.cursor).then((page) => page.events)).toEqual([]);

			await rename(path, `${path}.1`);
			await writeFile(path, identical);
			const rotated = await reader.readPage(initial.cursor);
			expect(rotated.events).toHaveLength(1);
		});
	});

	it("measures parsed-event, partial-line, and ID bytes without retaining telemetry strings", async () => {
		await withTempLog("telemetry-bounds", async (path) => {
			await writeFile(path, `${eventLine("secret-id", "secret-payload")}${JSON.stringify({ id: "partial" })}`);
			const page = await createReader(path).readPage();
			expect(page.telemetry.serializedEventBytes).toBeGreaterThan(0);
			expect(page.telemetry.cursorPartialLineBytes).toBeGreaterThan(0);
			expect(page.telemetry.cursorEventIdBytes).toBeGreaterThan(0);
			expect(JSON.stringify(page.telemetry)).not.toContain("secret-id");
			expect(JSON.stringify(page.telemetry)).not.toContain("secret-payload");
			expect(page.telemetry.largestRetainedValues.length).toBeLessThanOrEqual(8);
		});
	});

	it("requires rebaseline when same-size same-inode content changes outside sampled segments", async () => {
		await withTempLog("middle-rewrite", async (path) => {
			const first = eventLine("first");
			const middle = eventLine("middle-old");
			const middleOffset = Buffer.byteLength(`${first}${"x".repeat(8192)}\n`);
			await writeFile(path, `${first}${"x".repeat(8192)}\n${middle}${eventLine("tail-old")}`);
			const reader = createReader(path, { limits: { maxBytes: 1024, maxEvents: 1, maxElapsedMs: 1_000 } });
			const firstPage = await reader.readPage();
			expect(firstPage.events.map((event) => event.id)).toEqual(["first"]);

			const handle = await openFile(path, "r+");
			const replacement = Buffer.from(eventLine("middle-new"));
			await handle.write(replacement, 0, replacement.byteLength, middleOffset);
			await handle.close();

			await expect(reader.readPage(firstPage.cursor)).rejects.toThrow(/rebaseline|reset|source_changed/i);
		});
	});

	it("returns an explicit rebaseline when a large copied prefix is outside bounded proof samples", async () => {
		await withTempLog("incomplete-growth-proof", async (path) => {
			const lines = Array.from({ length: 400 }, (_, index) => eventLine(`id-${String(index).padStart(3, "0")}`));
			await writeFile(path, lines.join(""));
			const reader = createReader(path, {
				limits: { maxBytes: 64 * 1024, maxEvents: 20, maxElapsedMs: 1_000 },
			});
			const first = await reader.readPage();
			expect(first.events).toHaveLength(20);

			const rewrite = await openFile(path, "r+");
			try {
				const replacement = Buffer.from(eventLine("id-008", "new-08"));
				await rewrite.write(replacement, 0, replacement.byteLength, Buffer.byteLength(lines.slice(0, 8).join("")));
			} finally {
				await rewrite.close();
			}
			await appendFile(path, eventLine("proof-after"));
			await expect(reader.readPage(first.cursor)).rejects.toThrow(/rebaseline|reset|source_changed/i);
		});
	});

	it("requires rebaseline when the source cannot prove same-size content stability", async () => {
		await withTempLog("incomplete-checkpoint-proof", async (path) => {
			await writeFile(path, eventLine("proof"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					const handle = await base.open(sourcePath);
					return {
						stat: async () => {
							const snapshot = await handle.stat();
							return { ...snapshot, sourceMutationFingerprint: undefined };
						},
						readAt: (offset, maxBytes) => handle.readAt(offset, maxBytes),
						close: () => handle.close(),
					} satisfies IncrementalMonitorLogFileHandle;
				},
			};
			const reader = createReader(path, { fileSystem });
			const first = await reader.readPage();
			await expect(reader.readPage(first.cursor)).rejects.toThrow(/rebaseline|reset|checkpoint/i);
		});
	});

	it("rejects caller-mutated initialized cursor content and missing checkpoints", async () => {
		await withTempLog("cursor-authentication", async (path) => {
			await writeFile(path, eventLine("cursor-auth"));
			const reader = createReader(path);
			const page = await reader.readPage();
			await expect(reader.readPage({ ...page.cursor, trailingPartialLine: "caller-mutated" })).rejects.toThrow(
				/cursor|digest|auth/i,
			);
			await expect(reader.readPage({ ...page.cursor, sourceCheckpoint: null })).rejects.toThrow(
				/checkpoint|initialized|cursor/i,
			);
		});
	});

	it("rejects a recomputed digest that moves a durable cursor to EOF", async () => {
		await withTempLog("cursor-forgery", async (path) => {
			await writeFile(path, `${eventLine("forgery-first")}${eventLine("forgery-second")}`);
			const reader = createReader(path);
			const page = await reader.readPage();
			const forgedCursor = {
				...page.cursor,
				byteOffset: page.cursor.sourceCheckpoint?.sourceSizeBytes ?? page.cursor.byteOffset,
			};
			const recomputed = {
				...forgedCursor,
				cursorMac: recomputeLegacyCursorDigest(forgedCursor),
			};
			await expect(reader.readPage(recomputed)).rejects.toThrow(/auth|authority|cursor|digest/i);
		});
	});

	it("counts physical metadata and checkpoint I/O against the byte budget", async () => {
		await withTempLog("physical-budget", async (path) => {
			await writeFile(path, eventLine("physical"));
			const base = createNodeIncrementalMonitorLogFileSystem();
			let opened = 0;
			let stats = 0;
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					opened += 1;
					const handle = await base.open(sourcePath);
					return {
						stat: async () => {
							stats += 1;
							return handle.stat();
						},
						readAt: (offset, maxBytes) => handle.readAt(offset, maxBytes),
						close: () => handle.close(),
					} satisfies IncrementalMonitorLogFileHandle;
				},
			};
			const page = await createReader(path, {
				fileSystem,
				limits: { maxBytes: 32, maxEvents: 10, maxElapsedMs: 1_000 },
			}).readPage();
			expect(opened).toBe(1);
			expect(stats).toBeGreaterThan(0);
			expect(page.telemetry.physicalBytes).toBeLessThanOrEqual(32);
			expect(page.telemetry.metadataBytes).toBeGreaterThan(0);
			expect(page.telemetry.metadataBytes).toBeLessThan(page.telemetry.physicalBytes);
			expect(
				page.telemetry.metadataBytes + page.telemetry.contentBytesRead + page.telemetry.checkpointBytesRead,
			).toBe(page.telemetry.physicalBytes);
			await expect(() => createReader(path, { limits: { maxBytes: 1, maxEvents: 1, maxElapsedMs: 1_000 } })).toThrow(
				/metadata|max_bytes|budget/i,
			);
		});
	});

	it("measures retained parsed event serialization and rejects oversize retained values", async () => {
		await withTempLog("parsed-retention", async (path) => {
			const sourceLine = eventLine("derived");
			await writeFile(path, sourceLine);
			const derived = await createReader(path, {
				parseLine: (line) => {
					const event = parseEvent(line);
					return event === null ? null : { ...event, derived: "x".repeat(2048) };
				},
				limits: { maxBytes: 4096, maxEvents: 1, maxElapsedMs: 1_000 },
			}).readPage();
			expect(derived.telemetry.serializedEventBytes).toBeGreaterThan(Buffer.byteLength(sourceLine));

			const huge = "x".repeat(5 * 1024 * 1024 + 1);
			await writeFile(path, eventLine("oversize", huge));
			await expect(
				createReader(path, {
					maxPartialLineBytes: 6 * 1024 * 1024,
					limits: { maxBytes: 6 * 1024 * 1024, maxEvents: 1, maxElapsedMs: 5_000 },
				}).readPage(),
			).rejects.toThrow(/oversize|externalize|retained|serialized/i);
		});
	});

	it("does not invoke arbitrary parsed-event getters for retention telemetry", async () => {
		await withTempLog("parsed-retention-safe", async (path) => {
			await writeFile(path, eventLine("getter"));
			let getterCalls = 0;
			await expect(
				createReader(path, {
					parseLine: () => {
						const event = { id: "getter", message: "safe", relevant: true } as TestEvent & { secret?: string };
						Object.defineProperty(event, "secret", {
							enumerable: true,
							get: () => {
								getterCalls += 1;
								return "should-not-run";
							},
						});
						return event;
					},
				}).readPage(),
			).rejects.toThrow(/unsafe|serialization/i);
			expect(getterCalls).toBe(0);
		});
	});

	it("checks the deadline after cursor normalization before opening the source", async () => {
		await withTempLog("normalization-budget", async (path) => {
			await writeFile(path, eventLine("normalization"));
			const initial = await createReader(path).readPage();
			let now = 0;
			let opened = 0;
			const base = createNodeIncrementalMonitorLogFileSystem();
			const fileSystem: IncrementalMonitorLogFileSystem = {
				open: async (sourcePath) => {
					opened += 1;
					return base.open(sourcePath);
				},
			};
			const cursor = new Proxy(initial.cursor, {
				get(target, property, receiver) {
					if (property === "trailingPartialLine") now = 100;
					return Reflect.get(target, property, receiver);
				},
			});
			await expect(
				createReader(path, {
					clock: () => now,
					fileSystem,
					limits: { maxBytes: 1024, maxEvents: 1, maxElapsedMs: 10 },
				}).readPage(cursor),
			).rejects.toThrow(/budget|elapsed/i);
			expect(opened).toBe(0);
		});
	});

	it("rejects unsafe page and retained-state ceilings at construction", async () => {
		await withTempLog("safe-ceilings", async (path) => {
			await writeFile(path, "");
			expect(() => createReader(path, { limits: { maxBytes: 64 * 1024 * 1024 + 1 } })).toThrow(/unsafe|max_bytes/i);
			expect(() => createReader(path, { limits: { maxBytes: 8 } })).toThrow(/max_bytes|usable|metadata/i);
			expect(() => createReader(path, { maxPartialLineBytes: 16 * 1024 * 1024 + 1 })).toThrow(/unsafe|partial/i);
			expect(() => createReader(path, { maxSeenEventIds: 100_001 })).toThrow(/unsafe|event_ids/i);
			expect(() => createReader(path, { maxSeenEventIdsSerializedBytes: 16 * 1024 * 1024 + 1 })).toThrow(
				/unsafe|serialized/i,
			);
			expect(() => createReader(path, { maxLargestRetainedValues: 1025 })).toThrow(/unsafe|retained/i);
		});
	});

	it("rejects a FIFO before opening can block", async () => {
		if (process.platform === "win32") return;
		await withTempLog("fifo", async (path) => {
			await execFile("mkfifo", [path]);
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timeoutId = setTimeout(() => reject(new Error("fifo_open_blocked")), 250);
			});
			try {
				await expect(
					Promise.race([createNodeIncrementalMonitorLogFileSystem().open(path), timeout]),
				).rejects.toThrow(/regular|fifo|source/i);
			} finally {
				if (timeoutId !== undefined) clearTimeout(timeoutId);
			}
		});
	});

	it("reopens a durable authenticated cursor in a child process", async () => {
		await withTempLog("child-restart", async (path) => {
			const key = "child-process-monitor-key";
			await writeFile(path, eventLine("child-first"));
			const reader = createReader(path, { cursorAuthority: createCursorAuthority(key) });
			const first = await reader.readPage();
			await appendFile(path, eventLine("child-second"));
			const cursorPath = `${path}.cursor.json`;
			await writeFile(cursorPath, JSON.stringify(first.cursor));
			const childScript = `
				const { readFile } = await import("node:fs/promises");
				const { createHmac } = await import("node:crypto");
				const { createIncrementalMonitorLogReader } = await import("./src/core/workflow/incremental-monitor-log-reader.ts");
				const key = process.env.MONITOR_CURSOR_KEY;
				const authority = {
					sign: (payload) => createHmac("sha256", key).update(payload, "utf8").digest("hex"),
					verify: (payload, mac) => createHmac("sha256", key).update(payload, "utf8").digest("hex") === mac,
				};
				const cursor = JSON.parse(await readFile(process.env.MONITOR_CURSOR_PATH, "utf8"));
				const reader = createIncrementalMonitorLogReader({
					path: process.env.MONITOR_SOURCE_PATH,
					baseline: { mode: "from_start" },
					cursorAuthority: authority,
					parseLine: (line) => line.length === 0 ? null : JSON.parse(line),
					isRelevant: (event) => event.relevant === true,
					eventIdentity: (event) => event.id,
					limits: { maxBytes: 4096, maxEvents: 10, maxElapsedMs: 1000 },
				});
				const page = await reader.readPage(cursor);
				process.stdout.write(JSON.stringify(page.events.map((event) => event.id)));
			`;
			const { stdout } = await execFile(
				process.execPath,
				["--import", "tsx/esm", "--input-type=module", "-e", childScript],
				{
					cwd: process.cwd(),
					env: {
						...process.env,
						MONITOR_CURSOR_KEY: key,
						MONITOR_CURSOR_PATH: cursorPath,
						MONITOR_SOURCE_PATH: path,
					},
				},
			);
			expect(JSON.parse(stdout)).toEqual(["child-second"]);
		});
	});
});
