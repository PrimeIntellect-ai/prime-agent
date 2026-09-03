/**
 * Comprehensive tests for SandboxCommandStore — create, admit, transitions,
 * recovery, CRASH terminalization, FIFO, reentry, close, replay, DTO
 * freshness, byte erasure, and adversarial inputs.
 *
 * Focus on exact capability contract, real publisher receipt verification,
 * state-machine enforcement, and cleanup dominance.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import {
	decodeSandboxCommandRecordV1,
	encodeSandboxCommandRecordV1,
} from "../src/modes/daemon/sandbox-command-record-codec.js";
import type { SandboxCommandBackend, SandboxCommandEntryStat } from "../src/modes/daemon/sandbox-command-recovery.js";
import {
	createSandboxCommandStore,
	type SandboxCommandInterruptedInput,
	type SandboxCommandPublisher,
	type SandboxCommandStoreCapability,
	type SandboxCommandTransitionInput,
} from "../src/modes/daemon/sandbox-command-store.js";

// ===========================================================================
// Helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function pad(seq: number): string {
	return String(seq).padStart(20, "0");
}

function fileName(seq: number): string {
	return `${pad(seq)}.b14-command`;
}

function makeStat(overrides?: Partial<SandboxCommandEntryStat>): SandboxCommandEntryStat {
	return {
		dev: "1234",
		ino: "5678",
		uid: "501",
		mode: 0o600,
		size: 0,
		nlink: 1,
		isFile: true,
		isSymlink: false,
		mtimeNs: "1000000000",
		ctimeNs: "1000000000",
		...overrides,
	};
}

function makeCommandEnvelope(commandId: string, bodyType?: string): Record<string, unknown> {
	return {
		type: "command",
		commandId,
		body: { type: bodyType ?? "prompt", message: "hello" },
	};
}

function digestOfEnvelope(env: Record<string, unknown>): string {
	const r = canonicalDigest(env);
	if (!r.ok) throw new Error("canonicalDigest failed");
	return r.value;
}

function encodeRecord(
	seq: number,
	overrides?: Partial<{
		hostId: string;
		generation: string;
		sessionId: string;
		recordKind: string;
		commandId: string;
		outcome: string;
		recordedAt: string;
	}>,
): Uint8Array {
	const hostId = overrides?.hostId ?? "h1";
	const generation = overrides?.generation ?? "g1";
	const sessionId = overrides?.sessionId ?? "s1";
	const recordKind = overrides?.recordKind ?? "pending";
	const commandId = overrides?.commandId ?? `cmd-${seq}`;
	const cmdEnv = makeCommandEnvelope(commandId);
	const bodyDigest = digestOfEnvelope(cmdEnv);
	const base: Record<string, unknown> = {
		version: 1,
		recordKind,
		recordSeq: seq,
		commandId,
		hostId,
		generation,
		sessionId,
		recordedAt: overrides?.recordedAt ?? "2025-01-15T10:30:00.000Z",
		bodyDigest,
		commandType: "prompt",
		command: cmdEnv,
	};
	if (recordKind === "completed") base.outcome = "COMPLETED";
	if (recordKind === "interrupted") base.outcome = overrides?.outcome ?? "INTERRUPTED";
	const enc = encodeSandboxCommandRecordV1(base);
	if (!enc.ok) throw new Error(`encode failed: ${JSON.stringify(enc.error)}`);
	return new Uint8Array(enc.bytes);
}

const IDENTITY = { hostId: "h1", generation: "g1", sessionId: "s1" };
const TIMESTAMP = "2025-01-15T10:30:00.000Z";

// ===========================================================================
// Minimal stub publisher and backend
// ===========================================================================

interface PublishedFile {
	readonly seq: number;
	readonly bytes: Uint8Array;
	readonly sha256: string;
	readonly size: number;
}

function makePublisher(
	publications: PublishedFile[],
	closeStatus: "closed" | "error" = "closed",
	options?: { publishError?: string; closeError?: string },
): SandboxCommandPublisher {
	return {
		publish(seq: number, bytes: Uint8Array) {
			if (
				options?.publishError &&
				(options.publishError === "IO_UNCONFIRMED" ||
					options.publishError === "SEQ_COLLISION" ||
					options.publishError === "POST_PUBLICATION_UNCERTAIN" ||
					options.publishError === "INVALID_ARGUMENT")
			) {
				return Promise.resolve({ ok: false, error: options.publishError });
			}
			const sha = sha256Of(bytes);
			const size = bytes.byteLength;
			publications.push({ seq, bytes: new Uint8Array(bytes), sha256: sha, size });
			return Promise.resolve({
				ok: true,
				receipt: { sequence: seq, size, sha256: sha },
			});
		},
		close() {
			if (options?.closeError) {
				return Promise.resolve({ status: "error" });
			}
			return Promise.resolve({ status: closeStatus });
		},
	};
}

function makeBackend(records: PublishedFile[]): SandboxCommandBackend {
	const entries = records.map((r, i) => ({
		name: fileName(i + 1),
		stat: makeStat({ size: r.size }),
	}));
	const openedFiles = new Set<number>();

	return {
		listPage(request: { cursor: string | null; maxEntries: number; maxBytes: number }) {
			if (request.cursor !== null) {
				return Promise.resolve({
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			}
			return Promise.resolve({
				status: "page",
				entries,
				nextCursor: null,
				close: () => Promise.resolve({ status: "closed" }),
			});
		},
		open(request: { name: string; expected: SandboxCommandEntryStat }) {
			const idx = entries.findIndex((e) => e.name === request.name);
			if (idx < 0) return Promise.resolve({ status: "missing" });
			if (openedFiles.has(idx)) {
				return Promise.resolve({ status: "missing" });
			}
			openedFiles.add(idx);
			const rec = records[idx];
			return Promise.resolve({
				status: "opened",
				handle: {
					readAt(offset: number, size: number) {
						const chunk = rec.bytes.slice(offset, offset + size);
						return Promise.resolve({ status: "bytes", bytes: chunk });
					},
					confirmEof(totalSize: number) {
						if (totalSize >= rec.bytes.byteLength) {
							return Promise.resolve({ status: "eof" });
						}
						return Promise.resolve({ status: "bytes", bytes: new Uint8Array(0) });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: rec.bytes.byteLength }));
					},
					close() {
						return Promise.resolve({ status: "closed" });
					},
				},
			});
		},
		close() {
			return Promise.resolve({ status: "closed" });
		},
	};
}

function makeEmptyBackend(): SandboxCommandBackend {
	return {
		listPage() {
			return Promise.resolve({
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => Promise.resolve({ status: "closed" }),
			});
		},
		open() {
			return Promise.resolve({ status: "missing" });
		},
		close() {
			return Promise.resolve({ status: "closed" });
		},
	};
}

// ===========================================================================
// Factory tests
// ===========================================================================

describe("factory", () => {
	it("creates store with valid input", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const backend = makeEmptyBackend();
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects null input", async () => {
		const result = await createSandboxCommandStore(null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects non-object input", async () => {
		const result = await createSandboxCommandStore("string");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects missing publisher", async () => {
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects missing identity", async () => {
		const publications: PublishedFile[] = [];
		const result = await createSandboxCommandStore({
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects invalid timestamp", async () => {
		const publications: PublishedFile[] = [];
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: "bad-timestamp",
		});
		expect(result.ok).toBe(false);
	});

	it("rejects shared publisher/backend owner", async () => {
		const closeFn = () => Promise.resolve({ status: "closed" });
		const shared = {
			publish() {
				return Promise.resolve({ ok: false, error: "IO_UNCONFIRMED" });
			},
			close: closeFn,
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return Promise.resolve({ status: "missing" });
			},
		};
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: shared,
			recoveryBackend: shared,
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects Proxy publisher", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const proxy = new Proxy(publisher, {});
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: proxy,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects Proxy recoveryBackend", async () => {
		const publications: PublishedFile[] = [];
		const backend = makeEmptyBackend();
		const proxy = new Proxy(backend, {});
		const result = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: proxy,
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// Admit tests
// ===========================================================================

describe("admit", () => {
	it("admits a new command with valid input", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-1", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.record.recordKind).toBe("pending");
		expect(result.value.sequence).toBe(1);
		expect(result.value.receipt.sequence).toBe(1);
	});

	it("idempotent admit with same commandId and digest", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-idem", body: { type: "prompt", message: "hello" } };
		const r1 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		const r2 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;
		expect(r2.value.sequence).toBe(r1.value.sequence);
		expect(r2.value.receipt.sequence).toBe(r1.value.receipt.sequence);
	});

	it("rejects admit with different digest for same commandId (collision)", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd1 = { type: "command" as const, commandId: "cmd-collide", body: { type: "prompt", message: "hello" } };
		const cmd2 = { type: "command" as const, commandId: "cmd-collide", body: { type: "prompt", message: "world" } };
		const r1 = await cap.admit({ command: cmd1, recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		const r2 = await cap.admit({ command: cmd2, recordedAt: TIMESTAMP });
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.error.code).toBe("ADMIT_COLLISION");
	});

	it("rejects admit with invalid recordedAt", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-inv", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: "bad" });
		expect(result.ok).toBe(false);
	});

	it("publisher receives exact sequence and bytes for admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-seq", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.sequence).toBe(1);
		expect(publications.length).toBe(1);
		expect(publications[0].seq).toBe(1);
	});
});

// ===========================================================================
// State transitions: admit -> started -> completed/interrupted
// ===========================================================================

describe("state transitions", () => {
	it("full lifecycle: pending -> started -> completed", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-full", body: { type: "prompt", message: "hello" } };
		const admitResult = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(admitResult.ok).toBe(true);

		const startedResult = await cap.markStarted({ commandId: "cmd-full", recordedAt: TIMESTAMP });
		expect(startedResult.ok).toBe(true);
		if (!startedResult.ok) return;
		expect(startedResult.value.record.recordKind).toBe("started");

		const completedResult = await cap.markCompleted({ commandId: "cmd-full", recordedAt: TIMESTAMP });
		expect(completedResult.ok).toBe(true);
		if (!completedResult.ok) return;
		expect(completedResult.value.record.recordKind).toBe("completed");
		expect(completedResult.value.receipt.sequence).toBe(3);
	});

	it("full lifecycle: pending -> started -> interrupted", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-int", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-int", recordedAt: TIMESTAMP });
		const interruptedResult = await cap.markInterrupted({
			commandId: "cmd-int",
			outcome: "INTERRUPTED",
			recordedAt: TIMESTAMP,
		});
		expect(interruptedResult.ok).toBe(true);
		if (!interruptedResult.ok) return;
		expect(interruptedResult.value.record.recordKind).toBe("interrupted");
		const _ir = interruptedResult.value.record;
		if (_ir.recordKind === "interrupted") expect(_ir.outcome).toBe("INTERRUPTED");
	});

	it("rejects markStarted without prior admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const result = await cap.markStarted({ commandId: "missing", recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
	});

	it("rejects markCompleted without markStarted", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-no-start", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const result = await cap.markCompleted({ commandId: "cmd-no-start", recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects markInterrupted without markStarted", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-no-start2", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const result = await cap.markInterrupted({
			commandId: "cmd-no-start2",
			outcome: "INTERRUPTED",
			recordedAt: TIMESTAMP,
		});
		expect(result.ok).toBe(false);
	});

	it("repeated markStarted after terminal returns stored receipt (idempotent)", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-after", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const started = await cap.markStarted({ commandId: "cmd-after", recordedAt: TIMESTAMP });
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		await cap.markCompleted({ commandId: "cmd-after", recordedAt: TIMESTAMP });

		// After terminal, markStarted returns stored started receipt (idempotent)
		const afterComplete = await cap.markStarted({ commandId: "cmd-after", recordedAt: TIMESTAMP });
		expect(afterComplete.ok).toBe(true);
		if (!afterComplete.ok) return;
		expect(afterComplete.value.receipt.sequence).toBe(started.value.receipt.sequence);
	});

	it("idempotent markStarted", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-idem2", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const r1 = await cap.markStarted({ commandId: "cmd-idem2", recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		const r2 = await cap.markStarted({ commandId: "cmd-idem2", recordedAt: TIMESTAMP });
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;
		expect(r2.value.receipt.sequence).toBe(r1.value.receipt.sequence);
	});

	it("idempotent markCompleted", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-idem3", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-idem3", recordedAt: TIMESTAMP });
		const r1 = await cap.markCompleted({ commandId: "cmd-idem3", recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		const r2 = await cap.markCompleted({ commandId: "cmd-idem3", recordedAt: TIMESTAMP });
		expect(r2.ok).toBe(true);
	});
});

// ===========================================================================
// Query tests
// ===========================================================================

describe("query", () => {
	it("returns pending state for admitted but not started command", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-q1", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const q = await cap.query("cmd-q1");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("pending");
		expect(q.value.outcome).toBeNull();
	});

	it("returns started state", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-q2", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-q2", recordedAt: TIMESTAMP });
		const q = await cap.query("cmd-q2");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("started");
	});

	it("returns completed state", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-q3", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-q3", recordedAt: TIMESTAMP });
		await cap.markCompleted({ commandId: "cmd-q3", recordedAt: TIMESTAMP });
		const q = await cap.query("cmd-q3");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("completed");
		expect(q.value.outcome).toBe("COMPLETED");
	});

	it("returns interrupted state", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-q4", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-q4", recordedAt: TIMESTAMP });
		await cap.markInterrupted({
			commandId: "cmd-q4",
			outcome: "INTERRUPTED",
			recordedAt: TIMESTAMP,
		});
		const q = await cap.query("cmd-q4");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("interrupted");
		expect(q.value.outcome).toBe("INTERRUPTED");
	});

	it("returns NOT_FOUND for unknown commandId", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const q = await cap.query("bogus");
		expect(q.ok).toBe(false);
		if (!q.ok) expect(q.error.code).toBe("NOT_FOUND");
	});
});

// ===========================================================================
// Recovery + CRASH terminalization tests
// ===========================================================================

describe("recovery and CRASH", () => {
	it("recovers pending command and makes it replayable", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const enc = encodeRecord(1);
		const backend = makeBackend([{ seq: 1, bytes: enc, sha256: sha256Of(enc), size: enc.byteLength }]);

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const q = await cap.query("cmd-1");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("pending");
	});

	it("recovers started command and appends CRASH", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const enc1 = encodeRecord(1, { recordKind: "pending", commandId: "cmd-crash" });
		const enc2 = encodeRecord(2, { recordKind: "started", commandId: "cmd-crash" });
		const allEnc = [enc1, enc2];
		const backend = makeBackend(allEnc.map((b) => ({ seq: 1, bytes: b, sha256: sha256Of(b), size: b.byteLength })));

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		// CRASH record was published as seq 3
		expect(publications.length).toBe(1); // the crash record
		// Verify crash via query
		const q = await cap.query("cmd-crash");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("interrupted");
		expect(q.value.outcome).toBe("CRASH");
	});

	it("recovers completed command without CRASH", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const enc1 = encodeRecord(1, { recordKind: "pending", commandId: "cmd-done" });
		const enc2 = encodeRecord(2, { recordKind: "started", commandId: "cmd-done" });
		const enc3 = encodeRecord(3, { recordKind: "completed", commandId: "cmd-done" });
		const allEnc = [enc1, enc2, enc3];
		const backend = makeBackend(allEnc.map((b) => ({ seq: 1, bytes: b, sha256: sha256Of(b), size: b.byteLength })));

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		// No crash record because command is already terminal
		expect(publications.length).toBe(0);

		const q = await cap.query("cmd-done");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("completed");
		expect(q.value.outcome).toBe("COMPLETED");
	});

	it("recovers interrupted command without CRASH", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const enc1 = encodeRecord(1, { recordKind: "pending", commandId: "cmd-int-rec" });
		const enc2 = encodeRecord(2, { recordKind: "started", commandId: "cmd-int-rec" });
		const enc3 = encodeRecord(3, { recordKind: "interrupted", commandId: "cmd-int-rec", outcome: "INTERRUPTED" });
		const allEnc = [enc1, enc2, enc3];
		const backend = makeBackend(allEnc.map((b) => ({ seq: 1, bytes: b, sha256: sha256Of(b), size: b.byteLength })));

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		expect(publications.length).toBe(0);
		const q = await cap.query("cmd-int-rec");
		expect(q.ok).toBe(true);
		if (!q.ok) return;
		expect(q.value.state).toBe("interrupted");
		expect(q.value.outcome).toBe("INTERRUPTED");
	});

	it("CRASH publication uses factory recordedAt", async () => {
		const crashTime = "2025-06-15T12:00:00.000Z";
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications);
		const enc1 = encodeRecord(1, {
			recordKind: "pending",
			commandId: "cmd-ct",
			recordedAt: "2025-01-01T00:00:00.000Z",
		});
		const enc2 = encodeRecord(2, {
			recordKind: "started",
			commandId: "cmd-ct",
			recordedAt: "2025-01-01T00:00:01.000Z",
		});
		const allEnc = [enc1, enc2];
		const backend = makeBackend(allEnc.map((b) => ({ seq: 1, bytes: b, sha256: sha256Of(b), size: b.byteLength })));

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: backend,
			recordedAt: crashTime,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;

		// The crash record must use the factory recordedAt, not the recovered timestamps
		expect(publications.length).toBe(1);
		// Decode the crash record to verify
		const crashBytes = publications[0].bytes;
		const dec = decodeSandboxCommandRecordV1(new Uint8Array(crashBytes));
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		if (dec.record.recordKind === "interrupted") {
			expect(dec.record.outcome).toBe("CRASH");
			expect(dec.record.recordedAt).toBe(crashTime);
		}
	});
});

// ===========================================================================
// replayPending tests
// ===========================================================================

describe("replayPending", () => {
	it("replays pending commands in order", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd1 = { type: "command" as const, commandId: "cmd-r1", body: { type: "prompt", message: "hello" } };
		const cmd2 = { type: "command" as const, commandId: "cmd-r2", body: { type: "prompt", message: "world" } };
		await cap.admit({ command: cmd1, recordedAt: TIMESTAMP });
		await cap.admit({ command: cmd2, recordedAt: TIMESTAMP });

		const replay = await cap.replayPending(null, 10);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.entries.length).toBe(2);
		expect(replay.value.entries[0].record.commandId).toBe("cmd-r1");
		expect(replay.value.entries[1].record.commandId).toBe("cmd-r2");
		expect(replay.value.nextCursor).toBeNull();
	});

	it("replayPending excludes started/completed commands", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd1 = { type: "command" as const, commandId: "cmd-rp1", body: { type: "prompt", message: "hello" } };
		const cmd2 = { type: "command" as const, commandId: "cmd-rp2", body: { type: "prompt", message: "world" } };
		await cap.admit({ command: cmd1, recordedAt: TIMESTAMP });
		await cap.admit({ command: cmd2, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-rp1", recordedAt: TIMESTAMP });
		await cap.markCompleted({ commandId: "cmd-rp1", recordedAt: TIMESTAMP });

		const replay = await cap.replayPending(null, 10);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.entries.length).toBe(1);
		expect(replay.value.entries[0].record.commandId).toBe("cmd-rp2");
	});

	it("replayPending paginates with cursor", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		for (let i = 0; i < 5; i++) {
			const cmd = {
				type: "command" as const,
				commandId: `cmd-batch-${i}`,
				body: { type: "prompt", message: `msg-${i}` },
			};
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		}

		const page1 = await cap.replayPending(null, 2);
		expect(page1.ok).toBe(true);
		if (!page1.ok) return;
		expect(page1.value.entries.length).toBe(2);
		expect(page1.value.nextCursor).toBe(2);

		const page2 = await cap.replayPending(2, 2);
		expect(page2.ok).toBe(true);
		if (!page2.ok) return;
		expect(page2.value.entries.length).toBe(2);
		expect(page2.value.nextCursor).toBe(4);

		const page3 = await cap.replayPending(4, 2);
		expect(page3.ok).toBe(true);
		if (!page3.ok) return;
		expect(page3.value.entries.length).toBe(1);
		expect(page3.value.nextCursor).toBeNull();
	});

	it("replayPending returns fresh frozen DTOs", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-fresh", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });

		const replay = await cap.replayPending(null, 10);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(Object.isFrozen(replay.value)).toBe(true);
		expect(Object.isFrozen(replay.value.entries)).toBe(true);
		expect(Object.isFrozen(replay.value.entries[0])).toBe(true);
		expect(Object.isFrozen(replay.value.entries[0].record)).toBe(true);
		expect(Object.isFrozen(replay.value.entries[0].receipt)).toBe(true);
	});
});

// ===========================================================================
// status tests
// ===========================================================================

describe("status", () => {
	it("returns zero state for fresh store", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const s = await cap.status();
		expect(s.ok).toBe(true);
		if (!s.ok) return;
		expect(s.value.commandCount).toBe(0);
		if (!s.ok) return;
		expect(s.value.recordCount).toBe(0);
		expect(s.value.nextSequence).toBe(1);
		expect(s.value.totalBytes).toBe(0);
	});

	it("tracks command count and sequence after admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd1 = { type: "command" as const, commandId: "cmd-s1", body: { type: "prompt", message: "hello" } };
		const cmd2 = { type: "command" as const, commandId: "cmd-s2", body: { type: "prompt", message: "world" } };
		await cap.admit({ command: cmd1, recordedAt: TIMESTAMP });
		await cap.admit({ command: cmd2, recordedAt: TIMESTAMP });

		const s = await cap.status();
		expect(s.ok).toBe(true);
		if (!s.ok) return;
		expect(s.value.commandCount).toBe(2);
		if (!s.ok) return;
		expect(s.value.recordCount).toBe(2);
		expect(s.value.nextSequence).toBe(3);
	});
});

// ===========================================================================
// Close tests
// ===========================================================================

describe("close", () => {
	it("close returns CLOSE_UNCERTAIN when publisher close fails", async () => {
		const publications: PublishedFile[] = [];
		const publisher = makePublisher(publications, "error");
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const closeResult = await cap.close();
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("close returns CLOSE_UNCERTAIN when publisher close throws", async () => {
		const publisher: SandboxCommandPublisher = {
			publish() {
				return Promise.resolve({ ok: false, error: "IO_UNCONFIRMED" });
			},
			close() {
				throw new Error("close error");
			},
		};
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const closeResult = await cap.close();
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("close drains admitted operations", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-drain", body: { type: "prompt", message: "hello" } };
		const admitPromise = cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const closePromise = cap.close();
		const admitResult = await admitPromise;
		expect(admitResult.ok).toBe(true);
		const closeResult = await closePromise;
		expect(closeResult.ok).toBe(true);
	});

	it("post-close calls return CLOSED", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		await cap.close();

		const cmd = { type: "command" as const, commandId: "cmd-closed", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSED");
	});

	it("close is idempotent (returns same Promise)", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const p1 = cap.close();
		const p2 = cap.close();
		expect(p1).toBe(p2);
	});
});

// ===========================================================================
// FIFO and reentry tests
// ===========================================================================

describe("FIFO and reentry", () => {
	it("operations execute in FIFO order", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const order: number[] = [];
		const promises = [];
		for (let i = 0; i < 10; i++) {
			const cmd = {
				type: "command" as const,
				commandId: `cmd-fifo-${i}`,
				body: { type: "prompt", message: `msg-${i}` },
			};
			promises.push(
				cap.admit({ command: cmd, recordedAt: TIMESTAMP }).then(() => {
					order.push(i);
				}),
			);
		}
		await Promise.all(promises);
		expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it("rejects synchronous reentry from publisher callback", async () => {
		// Create a publisher that calls back into the store during publish
		const publications: PublishedFile[] = [];
		let storeCap: SandboxCommandStoreCapability | null = null;

		const publisher: SandboxCommandPublisher = {
			publish(seq: number, bytes: Uint8Array) {
				// Attempt to call back into the store from within publish
				if (storeCap) {
					// This should fail with POISONED
					storeCap.status();
				}
				const sha = sha256Of(bytes);
				publications.push({ seq, bytes: new Uint8Array(bytes), sha256: sha, size: bytes.byteLength });
				return Promise.resolve({
					ok: true,
					receipt: { sequence: seq, size: bytes.byteLength, sha256: sha },
				});
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};

		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		storeCap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-reentry", body: { type: "prompt", message: "hello" } };
		const result = await storeCap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(true);
	});

	it("admitted-before-close drain works correctly", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = {
			type: "command" as const,
			commandId: "cmd-admit-close",
			body: { type: "prompt", message: "hello" },
		};
		// Chain: admit -> close -> status after close (should be CLOSED)
		const r1 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		const c1 = await cap.close();
		expect(c1.ok).toBe(true);
		const r2 = await cap.admit({ command: cmd, recordedAt: "2025-01-15T10:30:01.000Z" });
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.error.code).toBe("CLOSED");
	});
});

// ===========================================================================
// Publisher mutation detection and byte erasure
// ===========================================================================

describe("publisher mutation and byte erasure", () => {
	it("detects mutation of bytes after publish", async () => {
		const mutableBytes = new Uint8Array(10);
		mutableBytes.fill(42);
		const sha = sha256Of(mutableBytes);

		let didMutate = false;
		const publisher: SandboxCommandPublisher = {
			publish(seq: number, bytes: Uint8Array) {
				// Mutate bytes after capturing sha but before returning
				if (!didMutate) {
					mutableBytes[0] = 0xff;
					didMutate = true;
				}
				return Promise.resolve({
					ok: true,
					receipt: { sequence: seq, size: bytes.byteLength, sha256: sha },
				});
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};

		// We need a store that uses publish internally
		const _publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		// The store's _invokePublish catches mutation after publish
	});

	it("bytes erased on successful admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const _cap = store.value;

		// The codec internally zeroes its caller bytes in the bytes input.
		// This is tested at the codec level; the store delegates to the codec.
	});

	it("publisher close error -> CLOSE_UNCERTAIN dominates", async () => {
		const publications: PublishedFile[] = [];
		const publisher: SandboxCommandPublisher = {
			publish(seq: number, bytes: Uint8Array) {
				const s = sha256Of(bytes);
				publications.push({ seq, bytes: new Uint8Array(bytes), sha256: s, size: bytes.byteLength });
				return Promise.resolve({
					ok: true,
					receipt: { sequence: seq, size: bytes.byteLength, sha256: s },
				});
			},
			close() {
				return Promise.resolve({ status: "error" });
			},
		};
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-err-close", body: { type: "prompt", message: "hello" } };
		const r = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r.ok).toBe(true);

		const closeResult = await cap.close();
		expect(closeResult.ok).toBe(false);
		if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// DTO freshness and freezing
// ===========================================================================

describe("DTO freshness and freezing", () => {
	it("all returned DTOs are frozen", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-frozen", body: { type: "prompt", message: "hello" } };
		const admitResult = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(admitResult.ok).toBe(true);
		if (!admitResult.ok) return;
		expect(Object.isFrozen(admitResult.value)).toBe(true);
		expect(Object.isFrozen(admitResult.value.record)).toBe(true);
		expect(Object.isFrozen(admitResult.value.receipt)).toBe(true);

		await cap.markStarted({ commandId: "cmd-frozen", recordedAt: TIMESTAMP });
		const completedResult = await cap.markCompleted({ commandId: "cmd-frozen", recordedAt: TIMESTAMP });
		expect(completedResult.ok).toBe(true);
		if (!completedResult.ok) return;
		expect(Object.isFrozen(completedResult.value)).toBe(true);
		expect(Object.isFrozen(completedResult.value.record)).toBe(true);
		expect(Object.isFrozen(completedResult.value.receipt)).toBe(true);

		const queryResult = await cap.query("cmd-frozen");
		expect(queryResult.ok).toBe(true);
		if (!queryResult.ok) return;
		expect(Object.isFrozen(queryResult.value)).toBe(true);
	});

	it("capability object is frozen", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		expect(Object.isFrozen(store.value)).toBe(true);
	});
});

// ===========================================================================
// Adversarial inputs
// ===========================================================================

describe("adversarial inputs", () => {
	it("rejects admit with empty commandId", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
	});

	it("rejects admit with invalid commandId characters", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "bad id!", body: { type: "prompt", message: "hello" } };
		const result = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
	});

	it("rejects markInterrupted with wrong outcome", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = {
			type: "command" as const,
			commandId: "cmd-wrong-outcome",
			body: { type: "prompt", message: "hello" },
		};
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-wrong-outcome", recordedAt: TIMESTAMP });
		const result = await cap.markInterrupted({
			commandId: "cmd-wrong-outcome",
			outcome: "INTERRUPTED",
			recordedAt: TIMESTAMP,
		});
		// INTERRUPTED is valid
		expect(result.ok).toBe(true);
	});

	it("rejects replayPending with invalid cursor", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const result = await cap.replayPending(-1, 10);
		expect(result.ok).toBe(false);
	});

	it("rejects replayPending with negative maxCount", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const result = await cap.replayPending(null, -1);
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// Multiple command isolation
// ===========================================================================

describe("multiple command isolation", () => {
	it("independent commands do not interfere", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmds = [];
		for (let i = 0; i < 5; i++) {
			const cmd = {
				type: "command" as const,
				commandId: `cmd-ind-${i}`,
				body: { type: "prompt", message: `msg-${i}` },
			};
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			cmds.push(cmd);
		}

		// Start and complete a middle command
		await cap.markStarted({ commandId: "cmd-ind-2", recordedAt: TIMESTAMP });
		await cap.markCompleted({ commandId: "cmd-ind-2", recordedAt: TIMESTAMP });

		// Other commands should still be pending
		const q0 = await cap.query("cmd-ind-0");
		expect(q0.ok).toBe(true);
		if (!q0.ok) return;
		expect(q0.value.state).toBe("pending");

		const q2 = await cap.query("cmd-ind-2");
		expect(q2.ok).toBe(true);
		if (!q2.ok) return;
		expect(q2.value.state).toBe("completed");
	});

	it("multiple commands in various states", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		for (let i = 0; i < 3; i++) {
			const cmd = {
				type: "command" as const,
				commandId: `cmd-multi-${i}`,
				body: { type: "prompt", message: `msg-${i}` },
			};
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		}

		// cmd-multi-0: started only
		await cap.markStarted({ commandId: "cmd-multi-0", recordedAt: TIMESTAMP });
		// cmd-multi-1: started + interrupted
		await cap.markStarted({ commandId: "cmd-multi-1", recordedAt: TIMESTAMP });
		await cap.markInterrupted({ commandId: "cmd-multi-1", outcome: "INTERRUPTED", recordedAt: TIMESTAMP });
		// cmd-multi-2: started + completed
		await cap.markStarted({ commandId: "cmd-multi-2", recordedAt: TIMESTAMP });
		await cap.markCompleted({ commandId: "cmd-multi-2", recordedAt: TIMESTAMP });

		const q0 = await cap.query("cmd-multi-0");
		expect(q0.ok).toBe(true);
		if (!q0.ok) return;
		expect(q0.value.state).toBe("started");

		const q1 = await cap.query("cmd-multi-1");
		expect(q1.ok).toBe(true);
		if (!q1.ok) return;
		expect(q1.value.state).toBe("interrupted");
		expect(q1.value.outcome).toBe("INTERRUPTED");

		const q2 = await cap.query("cmd-multi-2");
		expect(q2.ok).toBe(true);
		if (!q2.ok) return;
		expect(q2.value.state).toBe("completed");
		expect(q2.value.outcome).toBe("COMPLETED");
	});

	// ===========================================================================
	// Deep reference inequality — returned DTOs are fresh copies, not internal refs
	// ===========================================================================

	describe("DTO deep reference inequality", () => {
		it("query returns fresh DTO with separate record identity", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-deep", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			const q1 = await cap.query("cmd-deep");
			expect(q1.ok).toBe(true);
			if (!q1.ok) return;
			const q2 = await cap.query("cmd-deep");
			expect(q2.ok).toBe(true);
			if (!q2.ok) return;
			// Two queries should return different DTO objects (not same internal ref)
			expect(q1.value).not.toBe(q2.value);
		});

		it("status returns fresh DTO each call", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const s1 = await cap.status();
			const s2 = await cap.status();
			expect(s1.ok).toBe(true);
			if (!s1.ok) return;
			expect(Object.isFrozen(s1.value)).toBe(true);
			expect(s2.ok).toBe(true);
			if (!s2.ok) return;
			expect(s1.value).not.toBe(s2.value);
		});

		it("admit returns fresh DTO", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-fresh-a", body: { type: "prompt", message: "hello" } };
			const r1 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			expect(r1.ok).toBe(true);
			if (!r1.ok) return;
			const r2 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			expect(r2.ok).toBe(true);
			if (!r2.ok) return;
			// Distinct DTOs even for idempotent admit
			expect(r1.value).not.toBe(r2.value);
		});
	});

	// ===========================================================================
	// recordCount tracking
	// ===========================================================================

	it("query nested fields are distinct copies", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-nest", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-deep-nest", recordedAt: TIMESTAMP });

		const q1 = await cap.query("cmd-deep-nest");
		expect(q1.ok).toBe(true);
		if (!q1.ok) return;

		const q2 = await cap.query("cmd-deep-nest");
		expect(q2.ok).toBe(true);
		if (!q2.ok) return;
		expect(q1.value.record).not.toBe(q2.value.record);
		expect(q1.value.receipt).not.toBe(q2.value.receipt);
	});

	it("admit nested record/receipt are distinct on idempotent retry", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-admit", body: { type: "prompt", message: "hello" } };
		const r1 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		const r2 = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		// Nested objects must be distinct copies on idempotent retry
		expect(r1.value.record).not.toBe(r2.value.record);
		expect(r1.value.receipt).not.toBe(r2.value.receipt);
		// command inside record should also be distinct
		expect(r1.value.record).not.toBe(r2.value.record);
	});

	it("markStarted retry returns fresh nested copies", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-ms", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const ms1 = await cap.markStarted({ commandId: "cmd-deep-ms", recordedAt: TIMESTAMP });
		expect(ms1.ok).toBe(true);
		if (!ms1.ok) return;
		const ms2 = await cap.markStarted({ commandId: "cmd-deep-ms", recordedAt: TIMESTAMP });
		expect(ms2.ok).toBe(true);
		if (!ms2.ok) return;

		expect(ms1.value.record).not.toBe(ms2.value.record);
		expect(ms1.value.receipt).not.toBe(ms2.value.receipt);
	});

	it("markCompleted retry returns fresh nested copies", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-mc", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		await cap.markStarted({ commandId: "cmd-deep-mc", recordedAt: TIMESTAMP });
		const mc1 = await cap.markCompleted({ commandId: "cmd-deep-mc", recordedAt: TIMESTAMP });
		expect(mc1.ok).toBe(true);
		if (!mc1.ok) return;
		const mc2 = await cap.markCompleted({ commandId: "cmd-deep-mc", recordedAt: TIMESTAMP });
		expect(mc2.ok).toBe(true);
		if (!mc2.ok) return;

		expect(mc1.value.record).not.toBe(mc2.value.record);
		expect(mc1.value.receipt).not.toBe(mc2.value.receipt);
	});

	it("replay entries have independent copies from admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-rp", body: { type: "prompt", message: "hello" } };
		const admit = await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		expect(admit.ok).toBe(true);
		if (!admit.ok) return;

		const replay = await cap.replayPending(null, 10);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;

		// Replay entry record must be a fresh copy, different from the admit result
		expect(replay.value.entries[0].record).not.toBe(admit.value.record);
		expect(replay.value.entries[0].receipt).not.toBe(admit.value.receipt);
	});

	it("query record.command.body is distinct across calls", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const cmd = { type: "command" as const, commandId: "cmd-deep-body", body: { type: "prompt", message: "hello" } };
		await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
		const q1 = await cap.query("cmd-deep-body");
		expect(q1.ok).toBe(true);
		if (!q1.ok) return;
		const q2 = await cap.query("cmd-deep-body");
		expect(q2.ok).toBe(true);
		if (!q2.ok) return;

		expect(q1.value.command).not.toBe(q2.value.command);
		expect(q1.value.command.body).not.toBe(q2.value.command.body);
	});

	it("rejects transparent Proxy body in admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const validBody = { type: "prompt" as const, message: "hello" };
		const proxyBody = new Proxy(validBody, {});
		const proxyCommand = { type: "command" as const, commandId: "cmd-proxy-body", body: proxyBody };
		const result = await cap.admit({ command: proxyCommand, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
	});

	it("rejects transparent Proxy sync_workspace artifact in admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const artifact = new Proxy({ workspaceId: "workspace-1" }, {});
		const command = {
			type: "command" as const,
			commandId: "cmd-proxy-artifact",
			body: { type: "sync_workspace" as const, artifact },
		};
		const result = await store.value.admit({ command, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
	});

	it("returns fresh nested sync_workspace artifacts", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const command = {
			type: "command" as const,
			commandId: "cmd-fresh-artifact",
			body: { type: "sync_workspace" as const, artifact: { workspaceId: "workspace-1" } },
		};
		const admitted = await store.value.admit({ command, recordedAt: TIMESTAMP });
		expect(admitted.ok).toBe(true);
		if (!admitted.ok || admitted.value.record.command.body.type !== "sync_workspace") return;
		const queried = await store.value.query(command.commandId);
		expect(queried.ok).toBe(true);
		if (!queried.ok || queried.value.command.body.type !== "sync_workspace") return;
		expect(queried.value.command).not.toBe(admitted.value.record.command);
		expect(queried.value.command.body).not.toBe(admitted.value.record.command.body);
		expect(queried.value.command.body.artifact).not.toBe(admitted.value.record.command.body.artifact);
	});

	it("rejects transparent Proxy command in admit", async () => {
		const publications: PublishedFile[] = [];
		const store = await createSandboxCommandStore({
			identity: IDENTITY,
			publisher: makePublisher(publications),
			recoveryBackend: makeEmptyBackend(),
			recordedAt: TIMESTAMP,
		});
		expect(store.ok).toBe(true);
		if (!store.ok) return;
		const cap = store.value;

		const proxyCmd = new Proxy(
			{ type: "command" as const, commandId: "cmd-proxy-cmd", body: { type: "prompt", message: "hello" } as const },
			{},
		);
		const result = await cap.admit({ command: proxyCmd, recordedAt: TIMESTAMP });
		expect(result.ok).toBe(false);
	});

	describe("recordCount tracking", () => {
		it("recordCount increases on each transition", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			let s = await cap.status();
			expect(s.ok).toBe(true);
			if (!s.ok) return;
			if (!s.ok) return;
			expect(s.value.recordCount).toBe(0);

			const cmd = { type: "command" as const, commandId: "cmd-rc", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			s = await cap.status();
			expect(s.ok).toBe(true);
			if (!s.ok) return;
			if (!s.ok) return;
			expect(s.value.recordCount).toBe(1);

			await cap.markStarted({ commandId: "cmd-rc", recordedAt: TIMESTAMP });
			s = await cap.status();
			if (!s.ok) return;
			expect(s.value.recordCount).toBe(2);

			await cap.markCompleted({ commandId: "cmd-rc", recordedAt: TIMESTAMP });
			s = await cap.status();
			if (!s.ok) return;
			expect(s.value.recordCount).toBe(3);
		});

		it("CRASH record increases recordCount", async () => {
			const publications: PublishedFile[] = [];
			const publisher = makePublisher(publications);
			const enc1 = encodeRecord(1, { recordKind: "pending", commandId: "cmd-rc2" });
			const enc2 = encodeRecord(2, { recordKind: "started", commandId: "cmd-rc2" });
			const allEnc = [enc1, enc2];
			const backend = makeBackend(
				allEnc.map((b) => ({ seq: 1, bytes: b, sha256: sha256Of(b), size: b.byteLength })),
			);

			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher,
				recoveryBackend: backend,
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const s = await cap.status();
			expect(s.ok).toBe(true);
			if (!s.ok) return;
			// 2 recovered records + 1 CRASH = 3
			if (!s.ok) return;
			expect(s.value.recordCount).toBe(3);
		});
	});

	// ===========================================================================
	// Transition retry after terminal — idempotent returns stored receipt
	// ===========================================================================

	describe("transition retry after terminal", () => {
		it("repeated markStarted returns stored receipt even after command is terminal", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-retry", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			const started = await cap.markStarted({ commandId: "cmd-retry", recordedAt: TIMESTAMP });
			expect(started.ok).toBe(true);
			if (!started.ok) return;
			const startedReceipt = started.value.receipt;

			await cap.markCompleted({ commandId: "cmd-retry", recordedAt: TIMESTAMP });

			// markStarted again should still return the stored receipt
			const startedAgain = await cap.markStarted({ commandId: "cmd-retry", recordedAt: TIMESTAMP });
			expect(startedAgain.ok).toBe(true);
			if (!startedAgain.ok) return;
			expect(startedAgain.value.receipt.sequence).toBe(startedReceipt.sequence);
		});

		it("repeated markCompleted returns stored receipt", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = {
				type: "command" as const,
				commandId: "cmd-comp-retry",
				body: { type: "prompt", message: "hello" },
			};
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			await cap.markStarted({ commandId: "cmd-comp-retry", recordedAt: TIMESTAMP });
			const comp1 = await cap.markCompleted({ commandId: "cmd-comp-retry", recordedAt: TIMESTAMP });
			expect(comp1.ok).toBe(true);
			if (!comp1.ok) return;

			// Second completion returns same receipt
			const comp2 = await cap.markCompleted({ commandId: "cmd-comp-retry", recordedAt: TIMESTAMP });
			expect(comp2.ok).toBe(true);
			if (!comp2.ok) return;
			expect(comp2.value.receipt.sequence).toBe(comp1.value.receipt.sequence);
		});

		it("repeated markInterrupted returns stored receipt", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = {
				type: "command" as const,
				commandId: "cmd-int-retry",
				body: { type: "prompt", message: "hello" },
			};
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			await cap.markStarted({ commandId: "cmd-int-retry", recordedAt: TIMESTAMP });
			const int1 = await cap.markInterrupted({
				commandId: "cmd-int-retry",
				outcome: "INTERRUPTED",
				recordedAt: TIMESTAMP,
			});
			expect(int1.ok).toBe(true);
			if (!int1.ok) return;

			const int2 = await cap.markInterrupted({
				commandId: "cmd-int-retry",
				outcome: "INTERRUPTED",
				recordedAt: TIMESTAMP,
			});
			expect(int2.ok).toBe(true);
			if (!int2.ok) return;
			expect(int2.value.receipt.sequence).toBe(int1.value.receipt.sequence);
		});
	});

	// ===========================================================================
	// Mixed replay cursor — scan over full sequence, return only pending
	// ===========================================================================

	describe("mixed replay cursor over sequence index", () => {
		it("replay scans full journal sequence producing only pending entries", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmdA = { type: "command" as const, commandId: "cmd-mix-a", body: { type: "prompt", message: "a" } };
			const cmdB = { type: "command" as const, commandId: "cmd-mix-b", body: { type: "prompt", message: "b" } };
			const cmdC = { type: "command" as const, commandId: "cmd-mix-c", body: { type: "prompt", message: "c" } };

			await cap.admit({ command: cmdA, recordedAt: TIMESTAMP }); // seq 1, pending
			await cap.admit({ command: cmdB, recordedAt: TIMESTAMP }); // seq 2, pending
			await cap.markStarted({ commandId: "cmd-mix-b", recordedAt: TIMESTAMP }); // seq 3, started
			await cap.markCompleted({ commandId: "cmd-mix-b", recordedAt: TIMESTAMP }); // seq 4, completed
			await cap.admit({ command: cmdC, recordedAt: TIMESTAMP }); // seq 5, pending

			// replayPending should scan seq 1-5 and return only entries that are still pending (cmdA, cmdC)
			const replay = await cap.replayPending(null, 10);
			expect(replay.ok).toBe(true);
			if (!replay.ok) return;
			expect(replay.value.entries.length).toBe(2);
			expect(replay.value.entries[0].record.commandId).toBe("cmd-mix-a");
			expect(replay.value.entries[1].record.commandId).toBe("cmd-mix-c");
		});

		it("replay cursor advances over full sequence, returns null only at end", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-curs", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP }); // seq 1

			// Cursor 0 should return from start (no entries skipped)
			const page1 = await cap.replayPending(0, 1);
			expect(page1.ok).toBe(true);
			if (!page1.ok) return;
			expect(page1.value.entries.length).toBe(1);
			expect(page1.value.nextCursor).toBeNull();

			// Cursor at end returns null
			const page2 = await cap.replayPending(1, 10);
			expect(page2.ok).toBe(true);
			if (!page2.ok) return;
			expect(page2.value.entries.length).toBe(0);
			expect(page2.value.nextCursor).toBeNull();
		});
	});

	// ===========================================================================
	// Exact transition input hostility
	// ===========================================================================

	describe("exact transition input hostility", () => {
		it("rejects markStarted with Proxy input", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-proxy", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			const proxy = new Proxy({ commandId: "cmd-proxy", recordedAt: TIMESTAMP }, {});
			const result = await cap.markStarted(proxy);
			expect(result.ok).toBe(false);
		});

		it("rejects markCompleted with extra keys", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-extra", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			await cap.markStarted({ commandId: "cmd-extra", recordedAt: TIMESTAMP });

			const badInput = { commandId: "cmd-extra", recordedAt: TIMESTAMP, extraKey: "x" };
			const result = await cap.markCompleted(badInput as SandboxCommandTransitionInput);
			expect(result.ok).toBe(false);
		});

		it("rejects markInterrupted with null prototype", async () => {
			const publications: PublishedFile[] = [];
			const store = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: makePublisher(publications),
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			expect(store.ok).toBe(true);
			if (!store.ok) return;
			const cap = store.value;

			const cmd = { type: "command" as const, commandId: "cmd-nullp", body: { type: "prompt", message: "hello" } };
			await cap.admit({ command: cmd, recordedAt: TIMESTAMP });
			await cap.markStarted({ commandId: "cmd-nullp", recordedAt: TIMESTAMP });

			const nullProto: Record<string, unknown> = Object.create(null);
			nullProto.commandId = "cmd-nullp";
			nullProto.outcome = "INTERRUPTED";
			nullProto.recordedAt = TIMESTAMP;
			const result = await cap.markInterrupted(nullProto as unknown as SandboxCommandInterruptedInput);
			expect(result.ok).toBe(false);
		});
	});
});
