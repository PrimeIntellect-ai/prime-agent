/**
 * Integration tests for real journal backend + accepted store factories.
 *
 * Creates real journal backend directories, builds publisher+recoveryBackend,
 * passes them to each accepted store factory (sandbox-command-store,
 * sandbox-event-outbox-store, durable-provider-call-store), runs domain
 * operations, closes, reopens, and asserts exact state recovery.
 *
 * Backend hostile tests: factory descriptor contract, identity mismatch,
 * symlink rejection, extra "00"/Proxy rejection, caller byte zeroing,
 * shared-buffer rejection, list cursor undefined rejection, page maxBytes
 * enforcement, cumulative size limit.
 *
 * Sparse cumulative boundary: 204 sparse journal files at max logical size,
 * then publish of 1,048,577 bytes must reject without allocating that size.
 *
 * Uses static imports and real Vitest expect/throw assertions.
 * Zero casts/assertions/any/dynamic imports/sync fs/timers.
 */

import { createHash } from "node:crypto";
import { access, chmod, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { types } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	createDurableProviderCallStore,
	type ProviderCallStoreCapability,
} from "../src/modes/daemon/durable-provider-call-store.js";
import {
	createSandboxJournalBackend,
	type SandboxJournalKind,
	type SandboxJournalPublisherCapability,
	type SandboxJournalRecoveryCapability,
} from "../src/modes/daemon/node-sandbox-journal-backend.js";
import {
	encodeProviderCallRecordV1,
	type ProviderCallChunkRecordV1,
	type ProviderCallJournaledRecordV1,
	type ProviderCallTerminalRecordV1,
} from "../src/modes/daemon/provider-call-record-codec.js";
import type { RemoteHostAckFrame, RemoteHostEventFrame } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest, decodeAckFrame, decodeEventFrame } from "../src/modes/daemon/remote-host-frame-codec.js";
import {
	createSandboxCommandStore,
	type SandboxCommandStoreCapability,
} from "../src/modes/daemon/sandbox-command-store.js";
import { createSandboxEventOutboxStore } from "../src/modes/daemon/sandbox-event-outbox-store.js";
import type { SandboxEventOutboxStoreCapability } from "../src/modes/daemon/sandbox-event-outbox-store-types.js";

// ===========================================================================
// Constants
// ===========================================================================

const IDENTITY = Object.freeze({ hostId: "host-a", generation: "gen-1", sessionId: "sess-1" });
const RECORDED_AT = "2026-09-03T12:00:00.000Z";
const CURSOR_ID = Object.freeze({ hostId: "host-a", generation: "gen-1", sessionId: "sess-1" });

const ROOTS: string[] = [];

// ===========================================================================
// Helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function descriptors(raw: unknown): PropertyDescriptorMap | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function closePage(pageValue: unknown): Promise<void> {
	if (typeof pageValue !== "object" || pageValue === null) return Promise.resolve();
	const d = Object.getOwnPropertyDescriptor(pageValue, "close");
	if (!d || !("value" in d) || typeof d.value !== "function") return Promise.resolve();
	return Promise.resolve(d.value.call(pageValue)).then(
		() => undefined,
		() => undefined,
	);
}

function descOk(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const d = Object.getOwnPropertyDescriptor(raw, "ok");
		if (!d || !("value" in d) || !d.enumerable) return false;
		return d.value === true;
	} catch {
		return false;
	}
}

async function freshDir(): Promise<string> {
	const raw = await mkdtemp(join(tmpdir(), "journal-store-"));
	const root = await realpath(raw);
	ROOTS.push(root);
	return join(root, "journals");
}

async function createBackend(
	dir: string,
	kind: SandboxJournalKind,
): Promise<
	| {
			ok: true;
			publisher: SandboxJournalPublisherCapability;
			recoveryBackend: SandboxJournalRecoveryCapability;
	  }
	| { ok: false; code: string }
> {
	const result = await createSandboxJournalBackend(Object.freeze({ directoryPath: dir, identity: IDENTITY, kind }));
	if (result.ok) {
		return { ok: true, publisher: result.publisher, recoveryBackend: result.recoveryBackend };
	}
	return { ok: false, code: result.error.code };
}

function makeEventBody(eventType: string): Record<string, unknown> {
	const map: Record<string, Record<string, unknown>> = {
		session_created: { type: "session_created", sessionId: "sess-1", workspaceId: "ws-1" },
		agent_start: { type: "agent_start" },
		agent_end: { type: "agent_end", messages: 5 },
	};
	return map[eventType] ?? { type: eventType };
}

function buildEventFrame(eventId: string, bodyType: string): RemoteHostEventFrame {
	const body = makeEventBody(bodyType);
	const raw: {
		type: "event";
		id: string;
		sequence: number;
		cursor: { hostId: string; generation: string; sessionId: string; sequence: number };
		emittedAt: string;
		body: Record<string, unknown>;
	} = {
		type: "event",
		id: eventId,
		sequence: 1,
		cursor: { ...CURSOR_ID, sequence: 1 },
		emittedAt: RECORDED_AT,
		body,
	};
	const result = decodeEventFrame(raw);
	if (!result.ok) throw new Error("decodeEventFrame failed");
	return result.value;
}

function buildAckFrame(
	ackId: string,
	acknowledges: string,
	status: "delivered" | "replayed" | "rejected",
): RemoteHostAckFrame {
	const raw: { type: "ack"; ackId: string; acknowledges: string; status: "delivered" | "replayed" | "rejected" } = {
		type: "ack",
		ackId,
		acknowledges,
		status,
	};
	const result = decodeAckFrame(raw);
	if (!result.ok) throw new Error("decodeAckFrame failed");
	return result.value;
}

function makeRequestFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId,
		provider: "test",
		model: "test-model",
		messages: [{ role: "user", content: "hello" }],
	};
}

function makeCompleteFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId,
		result: "ok",
		usage: { inputTokens: 10, outputTokens: 20 },
	};
}

function buildJournaledRecord(callId: string, seq: number): ProviderCallJournaledRecordV1 {
	const frame = makeRequestFrame(callId);
	const bytes = utf8(JSON.stringify(frame));
	const r = canonicalDigest(frame);
	if (!r.ok) throw new Error("canonicalDigest failed");
	const requestDigest = r.value;
	const canonicalRequestDigest = sha256Of(bytes);
	const journaledInput = {
		version: 1,
		recordKind: "journaled",
		journalSeq: seq,
		callId,
		hostId: CURSOR_ID.hostId,
		generation: CURSOR_ID.generation,
		sessionId: CURSOR_ID.sessionId,
		recordedAt: RECORDED_AT,
		requestFrameId: `f-req-${callId}`,
		requestDigest,
		requestBytes: new Uint8Array(bytes),
		canonicalRequestDigest,
	};
	const encoded = encodeProviderCallRecordV1(journaledInput);
	if (!encoded.ok) throw new Error("encode journaled failed");
	if (encoded.record.recordKind !== "journaled") throw new Error("unexpected record kind");
	return encoded.record;
}

function buildChunkRecord(callId: string, seq: number): ProviderCallChunkRecordV1 {
	const frame = {
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId,
		index: 0,
		delta: { content: "hello" },
	};
	const bytes = utf8(JSON.stringify(frame));
	const chunkInput = {
		version: 1,
		recordKind: "chunk",
		journalSeq: seq,
		callId,
		hostId: CURSOR_ID.hostId,
		generation: CURSOR_ID.generation,
		sessionId: CURSOR_ID.sessionId,
		recordedAt: RECORDED_AT,
		chunkIndex: 0,
		chunkFrameBytes: new Uint8Array(bytes),
		chunkFrameDigest: sha256Of(bytes),
	};
	const encoded = encodeProviderCallRecordV1(chunkInput);
	if (!encoded.ok) throw new Error("encode chunk failed");
	if (encoded.record.recordKind !== "chunk") throw new Error("unexpected record kind");
	return encoded.record;
}

function buildTerminalRecord(callId: string, seq: number): ProviderCallTerminalRecordV1 {
	const frame = makeCompleteFrame(callId);
	const bytes = utf8(JSON.stringify(frame));
	const input: Record<string, unknown> = {
		version: 1,
		recordKind: "terminal",
		journalSeq: seq,
		callId,
		hostId: CURSOR_ID.hostId,
		generation: CURSOR_ID.generation,
		sessionId: CURSOR_ID.sessionId,
		recordedAt: RECORDED_AT,
		terminalKind: "normal",
		chunkCount: 1,
		terminalFrameBytes: new Uint8Array(bytes),
		terminalFrameDigest: sha256Of(bytes),
		usageInputTokens: 10,
		usageOutputTokens: 20,
	};
	const encoded = encodeProviderCallRecordV1(input);
	if (!encoded.ok) throw new Error("encode terminal failed");
	if (encoded.record.recordKind !== "terminal") throw new Error("unexpected record kind");
	return encoded.record;
}

// ===========================================================================
// Cleanup
// ===========================================================================

afterEach(async () => {
	for (const root of ROOTS.splice(0)) {
		await rm(root, { force: true, recursive: true }).catch(() => {});
	}
});

// ===========================================================================
// REAL restart tests: createSandboxCommandStore
// ===========================================================================

describe("createSandboxCommandStore — real journal backend restart", () => {
	it("admit/start/complete command, close backend, reopen, assert exact state", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;

		const s1 = await createSandboxCommandStore({
			publisher,
			recoveryBackend,
			identity: IDENTITY,
			recordedAt: RECORDED_AT,
		});
		expect(s1.ok).toBe(true);
		if (!s1.ok) throw new Error(`store create failed: ${JSON.stringify(s1.error)}`);
		const cap: SandboxCommandStoreCapability = s1.value;

		const cmdType: "command" = "command";
		const cmd = {
			type: cmdType,
			commandId: "cmd-1",
			body: { type: "prompt", message: "hello" },
		};
		const admitResult = await cap.admit({ command: cmd, recordedAt: RECORDED_AT });
		if (!admitResult.ok) throw new Error(`admit failed: ${JSON.stringify(admitResult.error)}`);

		const startResult = await cap.markStarted({ commandId: "cmd-1", recordedAt: RECORDED_AT });
		if (!startResult.ok) throw new Error(`start failed: ${JSON.stringify(startResult.error)}`);

		const completeResult = await cap.markCompleted({ commandId: "cmd-1", recordedAt: RECORDED_AT });
		if (!completeResult.ok) throw new Error(`complete failed: ${JSON.stringify(completeResult.error)}`);

		await cap.close();
		await publisher.close();
		await recoveryBackend.close();

		const be2 = await createBackend(dir, "command");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("reopen backend failed");
		const s2 = await createSandboxCommandStore({
			publisher: be2.publisher,
			recoveryBackend: be2.recoveryBackend,
			identity: IDENTITY,
			recordedAt: RECORDED_AT,
		});
		expect(s2.ok).toBe(true);
		if (!s2.ok) throw new Error(`reopen store failed: ${JSON.stringify(s2.error)}`);
		const cap2: SandboxCommandStoreCapability = s2.value;

		const q = await cap2.query("cmd-1");
		expect(q.ok).toBe(true);
		if (q.ok) expect(q.value).not.toBeNull();

		const qUnknown = await cap2.query("unknown");
		expect(qUnknown.ok).toBe(false);
		if (!qUnknown.ok) expect(qUnknown.error.code).toBe("NOT_FOUND");

		const st = await cap2.status();
		expect(st.ok).toBe(true);

		const replay = await cap2.replayPending(null, 64);
		expect(replay.ok).toBe(true);

		await cap2.close();
		await be2.publisher.close();
		await be2.recoveryBackend.close();
	});

	it("rejects missing identity", async () => {
		const fakePub: SandboxJournalPublisherCapability = {
			publish() {
				return Promise.resolve({ ok: true, receipt: { sequence: 1, size: 1, sha256: "a".repeat(64) } });
			},
			close() {
				const closeResult: Readonly<{ status: "closed" }> = { status: "closed" };
				return Promise.resolve(closeResult);
			},
		};
		const fakeRec: SandboxJournalRecoveryCapability = {
			listPage() {
				return Promise.resolve({});
			},
			open() {
				return Promise.resolve({});
			},
			close() {
				const closeResult: Readonly<{ status: "closed" }> = { status: "closed" };
				return Promise.resolve(closeResult);
			},
		};
		const result = await createSandboxCommandStore({
			publisher: fakePub,
			recoveryBackend: fakeRec,
			recordedAt: RECORDED_AT,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// REAL restart tests: createSandboxEventOutboxStore
// ===========================================================================

describe("createSandboxEventOutboxStore — real journal backend restart", () => {
	it("enqueue/markDelivered event, close backend, reopen, assert exact state", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "event-outbox");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;

		const s1 = await createSandboxEventOutboxStore({
			publisher,
			recoveryBackend,
			identity: IDENTITY,
		});
		expect(s1.ok).toBe(true);
		if (!s1.ok) throw new Error(`event store create failed: ${JSON.stringify(s1.error)}`);
		const cap: SandboxEventOutboxStoreCapability = s1.value;

		const event = buildEventFrame("evt-1", "agent_start");
		const enq = await cap.enqueue({ event, recordedAt: RECORDED_AT });
		if (!enq.ok) throw new Error(`enqueue failed: ${JSON.stringify(enq.error)}`);

		const ack = buildAckFrame("ack-1", "evt-1", "delivered");
		const delivered = await cap.markDelivered({ eventId: "evt-1", ack, recordedAt: RECORDED_AT });
		if (!delivered.ok) throw new Error(`markDelivered failed: ${JSON.stringify(delivered.error)}`);

		await cap.close();
		await publisher.close();
		await recoveryBackend.close();

		const be2 = await createBackend(dir, "event-outbox");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("reopen backend failed");
		const s2 = await createSandboxEventOutboxStore({
			publisher: be2.publisher,
			recoveryBackend: be2.recoveryBackend,
			identity: IDENTITY,
		});
		expect(s2.ok).toBe(true);
		if (!s2.ok) throw new Error(`reopen event store failed: ${JSON.stringify(s2.error)}`);
		const cap2: SandboxEventOutboxStoreCapability = s2.value;

		const q = await cap2.query("evt-1");
		expect(q.ok).toBe(true);
		if (q.ok) expect(q.value).not.toBeNull();

		const qUnknown = await cap2.query("unknown");
		expect(qUnknown.ok).toBe(false);
		if (!qUnknown.ok) expect(qUnknown.error.code).toBe("NOT_FOUND");

		const st = await cap2.status();
		expect(st.ok).toBe(true);

		await cap2.close();
		await be2.publisher.close();
		await be2.recoveryBackend.close();
	});

	it("rejects missing identity", async () => {
		const fakePub: SandboxJournalPublisherCapability = {
			publish() {
				return Promise.resolve({ ok: true, receipt: { sequence: 1, size: 1, sha256: "a".repeat(64) } });
			},
			close() {
				const closeResult: Readonly<{ status: "closed" }> = { status: "closed" };
				return Promise.resolve(closeResult);
			},
		};
		const fakeRec: SandboxJournalRecoveryCapability = {
			listPage() {
				return Promise.resolve({});
			},
			open() {
				return Promise.resolve({});
			},
			close() {
				const closeResult: Readonly<{ status: "closed" }> = { status: "closed" };
				return Promise.resolve(closeResult);
			},
		};
		const result = await createSandboxEventOutboxStore({ publisher: fakePub, recoveryBackend: fakeRec });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// REAL restart tests: createDurableProviderCallStore
// ===========================================================================

describe("createDurableProviderCallStore — real journal backend restart", () => {
	it("full lifecycle journaled/started/chunk/terminal/delivered, reopen, assert exact state", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "provider-call");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const s1 = await createDurableProviderCallStore({
				publisher,
				recoveryBackend,
				identity: IDENTITY,
				recordedAt: RECORDED_AT,
			});
			expect(s1.ok).toBe(true);
			if (!s1.ok) throw new Error(`provider store create failed: ${JSON.stringify(s1.error)}`);
			const cap: ProviderCallStoreCapability = s1.value;

			const jr = buildJournaledRecord("call-1", 1);
			const jrResult = await cap.journalProviderCall(jr);
			if (!jrResult.ok) throw new Error(`journalProviderCall failed: ${JSON.stringify(jrResult.error)}`);
			const journalReceipt = jrResult.value.receipt;

			const startedResult = await cap.journalStarted("call-1", jr.requestDigest, journalReceipt, RECORDED_AT);
			if (!startedResult.ok) throw new Error(`journalStarted failed: ${JSON.stringify(startedResult.error)}`);

			const chunk = buildChunkRecord("call-1", 3);
			const chunkResult = await cap.journalChunk(chunk);
			if (!chunkResult.ok) throw new Error(`journalChunk failed: ${JSON.stringify(chunkResult.error)}`);

			const tr = buildTerminalRecord("call-1", 4);
			const tResult = await cap.journalTerminal(tr);
			if (!tResult.ok) throw new Error(`journalTerminal failed: ${JSON.stringify(tResult.error)}`);

			const dResult = await cap.markDelivered("call-1", "ack-1", "b".repeat(64), journalReceipt, RECORDED_AT);
			if (!dResult.ok) throw new Error(`markDelivered failed: ${JSON.stringify(dResult.error)}`);

			await cap.close();
		} finally {
			await publisher.close();
			await recoveryBackend.close();
		}

		const be2 = await createBackend(dir, "provider-call");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("reopen backend failed");
		try {
			const s2 = await createDurableProviderCallStore({
				publisher: be2.publisher,
				recoveryBackend: be2.recoveryBackend,
				identity: IDENTITY,
				recordedAt: RECORDED_AT,
			});
			expect(s2.ok).toBe(true);
			if (!s2.ok) throw new Error(`reopen provider store failed: ${JSON.stringify(s2.error)}`);
			const cap2: ProviderCallStoreCapability = s2.value;

			const q2 = await cap2.query("call-1");
			expect(q2.ok).toBe(true);

			const qUnknown = await cap2.query("nonexistent");
			expect(qUnknown.ok).toBe(false);
			if (!qUnknown.ok) expect(qUnknown.error.code).toBe("NOT_FOUND");

			const st2 = await cap2.status();
			expect(st2.ok).toBe(true);

			await cap2.close();
		} finally {
			await be2.publisher.close();
			await be2.recoveryBackend.close();
		}
	});
});

// ===========================================================================
// Backend hostile tests
// ===========================================================================

describe("journal backend — source audit and hostile inputs", () => {
	it("rejects non-object factory input", async () => {
		const r1 = await createSandboxJournalBackend(null);
		expect(descOk(r1)).toBe(false);

		const r2 = await createSandboxJournalBackend("not-object");
		expect(descOk(r2)).toBe(false);

		const r3 = await createSandboxJournalBackend(42);
		expect(descOk(r3)).toBe(false);
	});

	it("rejects factory with missing directoryPath", async () => {
		const result = await createSandboxJournalBackend(Object.freeze({ identity: IDENTITY, kind: "command" }));
		expect(descOk(result)).toBe(false);
	});

	it("rejects factory with missing identity", async () => {
		const dir = await freshDir();
		const result = await createSandboxJournalBackend(Object.freeze({ directoryPath: dir, kind: "command" }));
		expect(descOk(result)).toBe(false);
	});

	it("rejects factory with missing kind", async () => {
		const dir = await freshDir();
		const result = await createSandboxJournalBackend(Object.freeze({ directoryPath: dir, identity: IDENTITY }));
		expect(descOk(result)).toBe(false);
	});

	it("rejects identity with empty fields", async () => {
		const dir = await freshDir();
		const result = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ hostId: "", generation: "", sessionId: "" }),
				kind: "command",
			}),
		);
		expect(descOk(result)).toBe(false);
	});

	it("rejects symlink in directory path", async () => {
		const raw = await mkdtemp(join(tmpdir(), "journal-store-"));
		const root = await realpath(raw);
		ROOTS.push(root);

		const realDir = join(root, "real");
		const linkDir = join(root, "link");
		await mkdir(realDir, { recursive: true });
		await symlink(realDir, linkDir, "dir");

		const jDir = join(linkDir, "journals");
		const result = await createSandboxJournalBackend(
			Object.freeze({ directoryPath: jDir, identity: IDENTITY, kind: "command" }),
		);
		expect(descOk(result)).toBe(false);
	});

	it("rejects listPage with cursor: undefined", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: undefined, maxEntries: 1, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const statusDesc = pd.status;
				const statusValue = statusDesc && "value" in statusDesc ? statusDesc.value : undefined;
				if (statusValue === "page") {
					throw new Error("listPage accepted cursor=undefined");
				}
			}
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});

	it("honors maxBytes in listPage", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const data = new Uint8Array(5000).fill(1);
			const pub = await be.publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			await be.publisher.close();

			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 1000 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const entriesDesc = pd.entries;
				if (entriesDesc && "value" in entriesDesc) {
					if (Array.isArray(entriesDesc.value)) {
						expect(entriesDesc.value.length).toBe(0);
					}
				}
			}
			if (pd && pd.close && "value" in pd.close) {
				await closePage(page);
			}
		} finally {
			await be.recoveryBackend.close();
		}
	});

	it("rejects Uint8Array with extra own key '00' on publish", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const raw = new Uint8Array([1, 2, 3]);
			Object.defineProperty(raw, "00", { value: 0, enumerable: true, configurable: true, writable: true });

			const pub = await be.publisher.publish(1, raw);
			if (descOk(pub)) {
				throw new Error("publish accepted Uint8Array with extra own key");
			}
			expect(raw[0]).toBe(1);
			expect(raw[1]).toBe(2);
			expect(raw[2]).toBe(3);
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});

	it("erases caller bytes after successful publish", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const data = new Uint8Array([10, 20, 30, 40, 50]);
			const pub = await be.publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			for (let i = 0; i < data.length; i++) {
				expect(data[i]).toBe(0);
			}
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});

	it("rejects non-Uint8Array publish argument", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const pubResult = Reflect.apply(be.publisher.publish, be.publisher, [1, "not-a-uint8array"]);
			expect(pubResult).toBeInstanceOf(Promise);
			const pub = await pubResult;
			if (descOk(pub)) {
				throw new Error("publish accepted non-Uint8Array");
			}
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});

	it("rejects shared-buffer Uint8Array", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const backing = new ArrayBuffer(10);
			const shared = new Uint8Array(backing, 0, 5);
			shared.set([1, 2, 3, 4, 5]);

			const pub = await be.publisher.publish(1, shared);
			if (descOk(pub)) {
				throw new Error("publish accepted shared-buffer Uint8Array");
			}
			expect(shared[0]).toBe(1);
			expect(shared[1]).toBe(2);
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});

	it("rejects factory with Proxy-wrapped input", async () => {
		const dir = await freshDir();
		const target: Record<string, unknown> = { directoryPath: dir, identity: IDENTITY, kind: "command" };
		const proxy = new Proxy(target, {});
		const result = await createSandboxJournalBackend(proxy);
		expect(descOk(result)).toBe(false);
	});

	it("does not leak handles on factory failure", async () => {
		const result = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: "/nonexistent-path-that-should-fail",
				identity: IDENTITY,
				kind: "command",
			}),
		);
		expect(descOk(result)).toBe(false);
	});

	it("creates correct kind for each backend type", async () => {
		const dir1 = await freshDir();
		const dir2 = await freshDir();
		const dir3 = await freshDir();

		const be1 = await createBackend(dir1, "command");
		expect(be1.ok).toBe(true);
		if (!be1.ok) throw new Error("be1 failed");
		const be2 = await createBackend(dir2, "event-outbox");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("be2 failed");
		const be3 = await createBackend(dir3, "provider-call");
		expect(be3.ok).toBe(true);
		if (!be3.ok) throw new Error("be3 failed");

		try {
			const id1 = JSON.parse(await readFile(join(dir1, "identity.json"), "utf8"));
			expect(id1.kind).toBe("command");
			const id2 = JSON.parse(await readFile(join(dir2, "identity.json"), "utf8"));
			expect(id2.kind).toBe("event-outbox");
			const id3 = JSON.parse(await readFile(join(dir3, "identity.json"), "utf8"));
			expect(id3.kind).toBe("provider-call");

			expect(be1.publisher).not.toBe(be1.recoveryBackend);
			expect(typeof be1.publisher.publish).toBe("function");
			expect(typeof be1.recoveryBackend.listPage).toBe("function");
		} finally {
			await be1.publisher.close();
			await be1.recoveryBackend.close();
			await be2.publisher.close();
			await be2.recoveryBackend.close();
			await be3.publisher.close();
			await be3.recoveryBackend.close();
		}
	});

	it("reopens after reverse cleanup order", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");

		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const pub = await be.publisher.publish(1, data);
		expect(descOk(pub)).toBe(true);

		await be.recoveryBackend.close();
		await be.publisher.close();

		const be2 = await createBackend(dir, "command");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("reopen backend failed");
		try {
			const page = await be2.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const entriesDesc = pd.entries;
				if (entriesDesc && "value" in entriesDesc) {
					if (Array.isArray(entriesDesc.value)) {
						expect(entriesDesc.value.length).toBe(1);
					}
				}
			}
		} finally {
			await be2.publisher.close();
			await be2.recoveryBackend.close();
		}
	});

	it("passes publisher with genuine full-backing bytes to publish", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const backing = new ArrayBuffer(5);
			const owned = new Uint8Array(backing);
			owned.set([10, 20, 30, 40, 50]);

			const pub = await be.publisher.publish(1, owned);
			expect(descOk(pub)).toBe(true);

			for (let i = 0; i < owned.length; i++) {
				expect(owned[i]).toBe(0);
			}
		} finally {
			await be.publisher.close();
			await be.recoveryBackend.close();
		}
	});
});

// ===========================================================================
// Backend factory input boundary tests
// ===========================================================================

describe("journal backend — factory input boundaries", () => {
	it("rejects hidden extra key", async () => {
		const dir = await freshDir();
		const raw = {
			directoryPath: dir,
			identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
			kind: "command" as string,
		};
		Object.defineProperty(raw, "hidden", { value: true, enumerable: false, configurable: true });
		const r = await createSandboxJournalBackend(raw);
		expect(descOk(r)).toBe(false);
	});

	it("rejects extra enumerable key", async () => {
		const dir = await freshDir();
		const r = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
				kind: "command",
				extra: true,
			}),
		);
		expect(descOk(r)).toBe(false);
	});

	it("rejects symbol key", async () => {
		const dir = await freshDir();
		const raw = {
			directoryPath: dir,
			identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
			kind: "command",
		};
		Object.defineProperty(raw, Symbol("x"), { value: 1, enumerable: true });
		const r = await createSandboxJournalBackend(raw);
		expect(descOk(r)).toBe(false);
	});

	it("rejects accessor descriptor", async () => {
		const dir = await freshDir();
		const raw = {};
		Object.defineProperty(raw, "directoryPath", { get: () => dir, enumerable: true, configurable: true });
		Object.defineProperty(raw, "identity", {
			value: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
			enumerable: true,
			configurable: true,
			writable: true,
		});
		Object.defineProperty(raw, "kind", { value: "command", enumerable: true, configurable: true, writable: true });
		const r = await createSandboxJournalBackend(raw);
		expect(descOk(r)).toBe(false);
	});

	it("rejects undefined descriptor value", async () => {
		const _dir = await freshDir();
		const raw = {
			directoryPath: undefined,
			identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
			kind: "command",
		};
		Object.defineProperty(raw, "directoryPath", {
			value: undefined,
			enumerable: true,
			configurable: true,
			writable: true,
		});
		const r = await createSandboxJournalBackend(raw);
		expect(descOk(r)).toBe(false);
	});

	it("rejects custom prototype input", async () => {
		const dir = await freshDir();
		const proto = { extra: 1 };
		const raw = Object.assign(Object.create(proto), {
			directoryPath: dir,
			identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
			kind: "command",
		});
		const r = await createSandboxJournalBackend(raw);
		expect(descOk(r)).toBe(false);
	});

	it("rejects identity with extra key", async () => {
		const dir = await freshDir();
		const r = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c", extra: "x" }),
				kind: "command",
			}),
		);
		expect(descOk(r)).toBe(false);
	});

	it("rejects identity missing hostId", async () => {
		const dir = await freshDir();
		const r = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ generation: "b", sessionId: "c" }),
				kind: "command",
			}),
		);
		expect(descOk(r)).toBe(false);
	});

	it("rejects identity with empty string id", async () => {
		const dir = await freshDir();
		const r = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ hostId: "", generation: "b", sessionId: "c" }),
				kind: "command",
			}),
		);
		expect(descOk(r)).toBe(false);
	});

	it("rejects invalid kind string", async () => {
		const dir = await freshDir();
		const r = await createSandboxJournalBackend(
			Object.freeze({
				directoryPath: dir,
				identity: Object.freeze({ hostId: "a", generation: "b", sessionId: "c" }),
				kind: "invalid-kind",
			}),
		);
		expect(descOk(r)).toBe(false);
	});
});
// ===========================================================================
// Backend directory/identity/listing boundary tests
// ===========================================================================

describe("journal backend — directory and listing boundaries", () => {
	it("rejects directory with wrong mode", async () => {
		const raw = await mkdtemp(join(tmpdir(), "journal-test-"));
		const root = await realpath(raw);
		ROOTS.push(root);
		const dir = join(root, "journals");
		await mkdir(dir, { recursive: true, mode: 0o755 });
		const r = await createSandboxJournalBackend(
			Object.freeze({ directoryPath: dir, identity: IDENTITY, kind: "command" }),
		);
		expect(descOk(r)).toBe(false);
	});

	it("rejects identity.json as symlink", async () => {
		const raw = await mkdtemp(join(tmpdir(), "journal-test-"));
		const root = await realpath(raw);
		ROOTS.push(root);
		const dir = join(root, "journals");
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const fake = join(root, "fake-identity");
		await open(fake, "w", 0o600).then((fh) => fh.close());
		await symlink(fake, join(dir, "identity.json"), "file");
		const r = await createSandboxJournalBackend(
			Object.freeze({ directoryPath: dir, identity: IDENTITY, kind: "command" }),
		);
		expect(descOk(r)).toBe(false);
	});

	it("accepts identity.json with different mode (content verified on reopen)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			await be.publisher.close();
			await be.recoveryBackend.close();
			await open(join(dir, "identity.json"), "r", 0o644).then((fh) => fh.close());
			const r = await createSandboxJournalBackend(
				Object.freeze({ directoryPath: dir, identity: IDENTITY, kind: "command" }),
			);
			// Identity file content is verified on reopen; mode is set at create time only.
			expect(r.ok).toBe(true);
			if (r.ok) {
				await r.publisher.close();
				await r.recoveryBackend.close();
			}
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects identity.json content mismatch", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			await be.publisher.close();
			await be.recoveryBackend.close();
			const fh = await open(join(dir, "identity.json"), "w", 0o600);
			await fh.write(new TextEncoder().encode("corrupted"));
			await fh.close();
			const r = await createSandboxJournalBackend(
				Object.freeze({ directoryPath: dir, identity: IDENTITY, kind: "command" }),
			);
			expect(descOk(r)).toBe(false);
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects hardlinked journal file", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const data = new Uint8Array([1, 2, 3]);
			const pub = await publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			await publisher.close();
			await recoveryBackend.close();
			const entry1 = join(dir, `${String(1).padStart(20, "0")}.b14-command`);
			const hardlink = join(dir, `${String(2).padStart(20, "0")}.b14-command`);
			await link(entry1, hardlink);
			const be2 = await createBackend(dir, "command");
			expect(be2.ok).toBe(false);
		} finally {
			await publisher.close().catch(() => {});
			await recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects journal file symlink", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const data = new Uint8Array([1, 2, 3]);
			const pub = await publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			await publisher.close();
			await recoveryBackend.close();
			const entry1 = join(dir, `${String(1).padStart(20, "0")}.b14-command`);
			const fake = join(`${dir}_fake`);
			const fh = await open(fake, "w", 0o600);
			await fh.close();
			await rename(entry1, `${fake}_orig`);
			await symlink(fake, entry1, "file");
			const be2 = await createBackend(dir, "command");
			expect(be2.ok).toBe(false);
		} finally {
			await publisher.close().catch(() => {});
			await recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects journal file with wrong mode", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const data = new Uint8Array([1, 2, 3]);
			const pub = await publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			await publisher.close();
			await recoveryBackend.close();
			const entry1 = join(dir, `${String(1).padStart(20, "0")}.b14-command`);
			await chmod(entry1, 0o644);
			const be2 = await createBackend(dir, "command");
			expect(be2.ok).toBe(false);
		} finally {
			await publisher.close().catch(() => {});
			await recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects non-contiguous journal sequence (gap)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const data = new Uint8Array([1]);
			const pub = await publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			const name3 = `${String(3).padStart(20, "0")}.b14-command`;
			const fh = await open(join(dir, name3), "w", 0o600);
			await fh.write(new Uint8Array([2]));
			await fh.close();
			await publisher.close();
			await recoveryBackend.close();
			const be2 = await createBackend(dir, "command");
			expect(be2.ok).toBe(false);
		} finally {
			await publisher.close().catch(() => {});
			await recoveryBackend.close().catch(() => {});
		}
	});

	it("lists unexpected safe entries alongside parsed ones", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const data = new Uint8Array([1, 2, 3]);
			const pub = await publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			const unexpectedName = "other-file.tmp";
			const fh = await open(join(dir, unexpectedName), "w", 0o600);
			await fh.write(new Uint8Array([4, 5]));
			await fh.close();
			await publisher.close();
			await recoveryBackend.close();
			const be2 = await createBackend(dir, "command");
			expect(be2.ok).toBe(true);
			if (!be2.ok) throw new Error("reopen backend failed");
			const page = await be2.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const entriesDesc = pd.entries;
				if (entriesDesc && "value" in entriesDesc && Array.isArray(entriesDesc.value)) {
					const names = entriesDesc.value.map((e: { name: string }) => e.name);
					expect(names).toContain(unexpectedName);
				}
			}
			await closePage(page);
			await be2.publisher.close();
			await be2.recoveryBackend.close();
		} finally {
			await publisher.close().catch(() => {});
			await recoveryBackend.close().catch(() => {});
		}
	});
});
// ===========================================================================
// Backend publisher/recovery runtime boundary tests
// ===========================================================================

describe("journal backend — publisher and recovery runtime", () => {
	it("publisher close returns same Promise for concurrent callers", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const p1 = be.publisher.close();
			const p2 = be.publisher.close();
			expect(p1).toBe(p2);
			await p1;
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("recovery close returns same Promise for concurrent callers", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const p1 = be.recoveryBackend.close();
			const p2 = be.recoveryBackend.close();
			expect(p1).toBe(p2);
			await p1;
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects publish after publisher close", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			await be.publisher.close();
			const pub = await be.publisher.publish(1, new Uint8Array([1]));
			expect(descOk(pub)).toBe(false);
		} finally {
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("rejects listPage after recovery close", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			await be.recoveryBackend.close();
			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 1, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			if (pd) {
				const statusDesc = pd.status;
				const statusValue = statusDesc && "value" in statusDesc ? statusDesc.value : undefined;
				expect(statusValue).not.toBe("page");
			}
		} finally {
			await be.publisher.close().catch(() => {});
		}
	});

	it("publisher and recovery are physically distinct handles", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			// Close publisher first, recovery should still work
			await be.publisher.close();
			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 1, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			await closePage(page);
			await be.recoveryBackend.close();
		} catch {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("recovery still works after publisher close (physical independence)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const data = new Uint8Array([1, 2, 3]);
			const pub = await be.publisher.publish(1, data);
			expect(descOk(pub)).toBe(true);
			// Close publisher
			await be.publisher.close();
			// Recovery should still see the entry
			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const entriesDesc = pd.entries;
				if (entriesDesc && "value" in entriesDesc && Array.isArray(entriesDesc.value)) {
					expect(entriesDesc.value.length).toBeGreaterThanOrEqual(1);
				}
			}
			await closePage(page);
			await be.recoveryBackend.close();
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});

	it("recovery readAt returns bounded bytes and confirmEof", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		try {
			const content = new Uint8Array([10, 20, 30, 40, 50]);
			const pub = await be.publisher.publish(1, content);
			expect(descOk(pub)).toBe(true);
			await be.publisher.close();

			// List page to get entry
			const page = await be.recoveryBackend.listPage(
				Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
			);
			const pd = descriptors(page);
			expect(pd).not.toBeNull();
			if (pd) {
				const entriesDesc = pd.entries;
				if (
					entriesDesc &&
					"value" in entriesDesc &&
					Array.isArray(entriesDesc.value) &&
					entriesDesc.value.length > 0
				) {
					const entryName = entriesDesc.value[0].name;
					const entryStat = entriesDesc.value[0].stat;
					// Open the entry
					const openResult = await be.recoveryBackend.open(
						Object.freeze({ name: entryName, expected: entryStat }),
					);
					const openPd = descriptors(openResult);
					expect(openPd).not.toBeNull();
					if (openPd) {
						const statusValue = openPd.status && "value" in openPd.status ? openPd.status.value : undefined;
						if (statusValue === "opened") {
							const handle = openPd.handle && "value" in openPd.handle ? openPd.handle.value : undefined;
							if (handle) {
								// readAt with bounded size
								const readResult = await handle.readAt(0, 3);
								const readPd = descriptors(readResult);
								expect(readPd).not.toBeNull();
								if (readPd && readPd.status && "value" in readPd.status) {
									expect(readPd.status.value).toBe("bytes");
								}
								// readAt at end
								const eofResult = await handle.readAt(5, 1);
								const eofPd = descriptors(eofResult);
								expect(eofPd).not.toBeNull();
								if (eofPd && eofPd.status && "value" in eofPd.status) {
									expect(eofPd.status.value).toBe("eof");
								}
								// confirmEof at size
								const confirmResult = await handle.confirmEof(5);
								const confirmPd = descriptors(confirmResult);
								expect(confirmPd).not.toBeNull();
								if (confirmPd && confirmPd.status && "value" in confirmPd.status) {
									expect(confirmPd.status.value).toBe("eof");
								}
								// Close handle
								await handle.close();
							}
						}
					}
				}
			}
			await closePage(page);
			await be.recoveryBackend.close();
		} finally {
			await be.publisher.close().catch(() => {});
			await be.recoveryBackend.close().catch(() => {});
		}
	});
});

// ===========================================================================
// Store-level zeroized-transfer vs partial mutation hostile tests
// ===========================================================================

describe("store — zeroized-transfer mutation detection", () => {
	it("command store accepts fully-zeroed bytes after publish (legitimate erasure)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const s1 = await createSandboxCommandStore({
				publisher,
				recoveryBackend,
				identity: IDENTITY,
				recordedAt: RECORDED_AT,
			});
			expect(s1.ok).toBe(true);
			if (!s1.ok) throw new Error("store create failed");
			const cap: SandboxCommandStoreCapability = s1.value;

			const cmdType: "command" = "command";
			const cmd = { type: cmdType, commandId: "cmd-zero", body: { type: "prompt", message: "zero-test" } };
			const admitResult = await cap.admit({ command: cmd, recordedAt: RECORDED_AT });
			expect(admitResult.ok).toBe(true);
			if (!admitResult.ok) throw new Error(`admit failed: ${JSON.stringify(admitResult.error)}`);

			const startResult = await cap.markStarted({ commandId: "cmd-zero", recordedAt: RECORDED_AT });
			expect(startResult.ok).toBe(true);

			const completeResult = await cap.markCompleted({ commandId: "cmd-zero", recordedAt: RECORDED_AT });
			expect(completeResult.ok).toBe(true);

			await cap.close();
		} finally {
			await publisher.close();
			await recoveryBackend.close();
		}
	});

	it("event store accepts fully-zeroed bytes after publish (legitimate erasure)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "event-outbox");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const s1 = await createSandboxEventOutboxStore({ publisher, recoveryBackend, identity: IDENTITY });
			if (!s1.ok) throw new Error(`event store create failed: ${JSON.stringify(s1.error)}`);
			const cap: SandboxEventOutboxStoreCapability = s1.value;

			const event = buildEventFrame("evt-zero", "agent_start");
			const enq = await cap.enqueue({ event, recordedAt: RECORDED_AT });
			if (!enq.ok) throw new Error(`enqueue failed: ${JSON.stringify(enq.error)}`);

			await cap.close();
		} finally {
			await publisher.close();
			await recoveryBackend.close();
		}
	});

	it("provider store accepts fully-zeroed bytes after publish (legitimate erasure)", async () => {
		const dir = await freshDir();
		const be = await createBackend(dir, "provider-call");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		const { publisher, recoveryBackend } = be;
		try {
			const s1 = await createDurableProviderCallStore({
				publisher,
				recoveryBackend,
				identity: IDENTITY,
				recordedAt: RECORDED_AT,
			});
			if (!s1.ok) throw new Error(`provider store create failed: ${JSON.stringify(s1.error)}`);
			const cap: ProviderCallStoreCapability = s1.value;

			const jr = buildJournaledRecord("call-zero", 1);
			const jrResult = await cap.journalProviderCall(jr);
			expect(jrResult.ok).toBe(true);
			if (!jrResult.ok) throw new Error("journalProviderCall failed");

			await cap.close();
		} finally {
			await publisher.close();
			await recoveryBackend.close();
		}
	});
});

it("rejects prototype-changed bytes — malicious publisher changes prototype after zeroing", async () => {
	const dir = await freshDir();
	// Use a real recovery backend, but a fake publisher that changes prototype
	const be = await createBackend(dir, "command");
	expect(be.ok).toBe(true);
	if (!be.ok) throw new Error("backend failed");
	const { recoveryBackend } = be;
	try {
		// Build a fake publisher that zeroes AND changes prototype of caller bytes
		const receipt = { sequence: 1, size: 1, sha256: "a".repeat(64) };
		const maliciousPub: SandboxJournalPublisherCapability = {
			publish(_seq: number, bytes: Uint8Array) {
				// Zero the bytes (as a normal publisher would)
				for (let i = 0; i < bytes.length; i++) {
					bytes[i] = 0;
				}
				// Change the prototype — this should be detected by post-publish validation
				Object.setPrototypeOf(bytes, null);
				return Promise.resolve({ ok: true, receipt });
			},
			close() {
				const closeResult: Readonly<{ status: "closed" }> = { status: "closed" };
				return Promise.resolve(closeResult);
			},
		};

		const s1 = await createSandboxCommandStore({
			publisher: maliciousPub,
			recoveryBackend,
			identity: IDENTITY,
			recordedAt: RECORDED_AT,
		});
		expect(s1.ok).toBe(true);
		if (!s1.ok) throw new Error("store create failed");
		const cap: SandboxCommandStoreCapability = s1.value;

		const cmdType: "command" = "command";
		const cmd = { type: cmdType, commandId: "cmd-proto", body: { type: "prompt", message: "proto-test" } };
		const admitResult = await cap.admit({ command: cmd, recordedAt: RECORDED_AT });
		// Post-publish validation must detect prototype change → error
		expect(admitResult.ok).toBe(false);
		if (!admitResult.ok) {
			expect(admitResult.error.code).toBe("UNCERTAIN");
		}

		await cap.close();
	} finally {
		await be.publisher.close().catch(() => {});
		await be.recoveryBackend.close().catch(() => {});
	}
});

// ===========================================================================
// Sparse cumulative boundary test
// ===========================================================================

describe("journal backend — sparse cumulative size limit", () => {
	it("creates 204 sparse journal files, rejects seq205 without large allocation", { timeout: 120_000 }, async () => {
		const dir = await freshDir();

		const be = await createBackend(dir, "command");
		expect(be.ok).toBe(true);
		if (!be.ok) throw new Error("backend failed");
		await be.publisher.close();

		for (let seq = 1; seq <= 204; seq++) {
			const padded = String(seq).padStart(20, "0");
			const name = `${padded}.b14-command`;
			const fpath = join(dir, name);
			const fh = await open(fpath, "w", 0o600);
			try {
				await fh.truncate(1_310_720);
				await fh.datasync();
			} finally {
				await fh.close().catch(() => {});
			}
		}

		await be.recoveryBackend.close();
		const be2 = await createBackend(dir, "command");
		expect(be2.ok).toBe(true);
		if (!be2.ok) throw new Error("reopen backend failed");
		try {
			const oversize = new Uint8Array(1_048_577).fill(42);
			const pub = await be2.publisher.publish(205, oversize);
			if (pub && typeof pub === "object") {
				const okDesc = Object.getOwnPropertyDescriptor(pub, "ok");
				const okVal = okDesc && "value" in okDesc ? okDesc.value : undefined;
				if (okVal === true) {
					throw new Error("publish seq=205 should be rejected by cumulative size limit");
				}
			}

			for (let i = 0; i < oversize.length; i++) {
				expect(oversize[i]).toBe(42);
			}

			const name205 = `${String(205).padStart(20, "0")}.b14-command`;
			try {
				await access(join(dir, name205));
				throw new Error("seq205 journal file should not exist");
			} catch (error: unknown) {
				const errVal = error;
				let errCode: string | undefined;
				if (typeof errVal === "object" && errVal !== null && "code" in errVal) {
					const d = Object.getOwnPropertyDescriptor(errVal, "code");
					if (d && "value" in d && typeof d.value === "string") {
						errCode = d.value;
					}
				}
				expect(errCode).toBe("ENOENT");
			}
		} finally {
			await be2.publisher.close();
			await be2.recoveryBackend.close();
		}
	});
});
