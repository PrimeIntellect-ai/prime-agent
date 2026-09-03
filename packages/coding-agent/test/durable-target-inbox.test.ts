import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DurableRelayStore } from "../src/modes/daemon/durable-relay-store.js";
import {
	type AdmitReceipt,
	createDurableTargetInbox,
	type DispatcherCapability,
	type DurableTargetInbox,
	type EnsureResult,
} from "../src/modes/daemon/durable-target-inbox.js";
import type {
	RemoteHostAgentMessageFrame,
	RemoteHostFrameEnvelope,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

// ===========================================================================
// Helpers
// ===========================================================================

interface CapCounts {
	journal: number;
	marker: number;
	recovery: number;
	ensure: number;
	ensureClose: number;
}

function zeroCounts(): CapCounts {
	return { journal: 0, marker: 0, recovery: 0, ensure: 0, ensureClose: 0 };
}

interface DiskFile {
	readonly name: string;
	readonly bytes: Uint8Array;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function closeOk(): Promise<unknown> {
	return Promise.resolve({ status: "closed" });
}

function makeEnvelope(
	frameId: string,
	agentId: string,
	sentAt: string,
	message: string,
	fromActiveSessionId = "a-1",
	targetActiveSessionId = "t-1",
	deliveryMode?: "queued" | "direct",
): RemoteHostFrameEnvelope {
	const frame: RemoteHostAgentMessageFrame = {
		type: "agent_message",
		id: agentId,
		fromActiveSessionId,
		targetActiveSessionId,
		message,
	};
	if (deliveryMode !== undefined) frame.deliveryMode = deliveryMode;
	return Object.freeze({
		type: "frame",
		frameId,
		protocol: Object.freeze({
			name: "prime-agent.remote-host" as const,
			version: 1 as const,
		}),
		sentAt,
		frame,
	});
}

function createDisk(): { files: DiskFile[] } {
	return { files: [] };
}

function makeInput(
	counts: CapCounts,
	ensureResult: EnsureResult = { status: "persisted" },
	disk: { files: DiskFile[] } = createDisk(),
): {
	identity: Readonly<Record<string, unknown>>;
	direction: "received";
	journalDir: string;
	journalPublisher: Readonly<Record<string, unknown>>;
	deliveryPublisher: Readonly<Record<string, unknown>>;
	recoveryBackend: Readonly<Record<string, unknown>>;
	dispatcher: DispatcherCapability;
} {
	const save = (name: string, bytes: Uint8Array): void => {
		const copy = new Uint8Array(bytes);
		disk.files.push({ name, bytes: copy });
	};
	const journalPublisher = {
		publish(raw: unknown): Promise<unknown> {
			counts.journal += 1;
			const value = raw as { seq: number; bytes: Uint8Array };
			const result = {
				status: "success" as const,
				seq: value.seq,
				size: value.bytes.byteLength,
				sha256: sha256(value.bytes),
			};
			save(`${String(value.seq).padStart(20, "0")}.b03-journal`, value.bytes);
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			return closeOk();
		},
	};
	const deliveryPublisher = {
		publish(raw: unknown): Promise<unknown> {
			counts.marker += 1;
			const value = raw as { indexSeq: number; bytes: Uint8Array };
			const result = {
				status: "success" as const,
				sequence: value.indexSeq,
				size: value.bytes.byteLength,
				sha256: sha256(value.bytes),
			};
			save(`${String(value.indexSeq).padStart(20, "0")}.b03-delivery`, value.bytes);
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			return closeOk();
		},
	};
	const recoveryBackend = {
		listPage(raw: unknown): Promise<unknown> {
			counts.recovery += 1;
			const request = raw as { cursor: string | null };
			const sorted = [...disk.files].sort((a, b) => a.name.localeCompare(b.name));
			const cursorStr = request.cursor;
			const fidx = cursorStr === null ? -1 : sorted.findIndex((f) => f.name > cursorStr!);
			const startIndex = cursorStr === null ? 0 : fidx < 0 ? sorted.length : fidx + 1;
			const page = sorted.slice(startIndex, startIndex + 64);
			const entries = page.map((f) => ({
				name: f.name,
				stat: {
					dev: "1",
					ino: String(disk.files.indexOf(f) + 1),
					uid: "501",
					mode: 0o600,
					size: f.bytes.byteLength,
					nlink: 1,
					isFile: true,
					isSymlink: false,
					mtimeNs: "1",
					ctimeNs: "1",
				},
			}));
			const last = page[page.length - 1];
			const nextCursor = last !== undefined ? last.name : null;
			return Promise.resolve({ entries, nextCursor });
		},
		open(raw: unknown): Promise<unknown> {
			const request = raw as { name: string };
			const file = disk.files.find((f) => f.name === request.name);
			if (!file) return Promise.resolve({ status: "error" });
			const copy = new Uint8Array(file.bytes);
			let pos = 0;
			return Promise.resolve({
				status: "opened",
				handle: {
					readAt(offset: number, size: number): Promise<unknown> {
						if (offset !== pos) return Promise.resolve({ status: "error" });
						const chunk = copy.slice(offset, offset + size);
						pos = offset + chunk.byteLength;
						return Promise.resolve({ status: "bytes", bytes: chunk });
					},
					confirmEof(_size: number): Promise<unknown> {
						return Promise.resolve({ status: "eof" });
					},
					fstat(): Promise<unknown> {
						return Promise.resolve({
							dev: "1",
							ino: String(disk.files.indexOf(file) + 1),
							uid: "501",
							mode: 0o600,
							size: copy.byteLength,
							nlink: 1,
							isFile: true,
							isSymlink: false,
							mtimeNs: "1",
							ctimeNs: "1",
						});
					},
					close(): Promise<unknown> {
						return Promise.resolve({ status: "closed" });
					},
				},
			});
		},
		close(): Promise<unknown> {
			counts.recovery += 1;
			return closeOk();
		},
	};
	const ensureRaw = ensureResult;
	const dispatcher: DispatcherCapability = {
		ensure(_raw: unknown): Promise<EnsureResult> {
			counts.ensure += 1;
			return Promise.resolve(ensureRaw);
		},
		close(): Promise<{ status: "closed" | "error" }> {
			counts.ensureClose += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	return {
		identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
		direction: "received",
		journalDir: "/tmp/inbox",
		journalPublisher,
		deliveryPublisher,
		recoveryBackend,
		dispatcher,
	};
}

async function openedInbox(): Promise<{
	inbox: DurableTargetInbox;
	counts: CapCounts;
	disk: { files: DiskFile[] };
}> {
	const counts = zeroCounts();
	const disk = createDisk();
	const input = makeInput(counts, { status: "persisted" }, disk);
	const result = await createDurableTargetInbox(input);
	if (!result.ok) throw new Error(`create failed: ${result.error.code}`);
	return { inbox: result.inbox, counts, disk };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const result = await promise;
	const obj = result as { ok: boolean; error?: { code: string } };
	expect(obj.ok).toBe(false);
	expect(obj.error?.code).toBe(code);
}

// ===========================================================================
// Tests
// ===========================================================================

describe("DurableTargetInbox", () => {
	// -----------------------------------------------------------------------
	// 1. publish->pending before queued
	// -----------------------------------------------------------------------
	it("admits a valid agent_message envelope and returns queued with journal+marker published", async () => {
		const { inbox, counts } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.status).toBe("queued");
			expect(result.value.frameId).toBe("tf-1");
			expect(result.value.semanticId).toBe("sm-1");
			expect(typeof result.value.receipt.sequence).toBe("number");
			expect(typeof result.value.receipt.sha256).toBe("string");
		}
		expect(counts.journal).toBe(1);
		expect(counts.marker).toBe(1);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 2. crash recovery new/pending/delivered
	// -----------------------------------------------------------------------
	it("recovers new/pending/delivered states and marks recovered new as pending", async () => {
		const { inbox, disk } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(true);
		await inbox.close();

		const counts2 = zeroCounts();
		const input2 = makeInput(counts2, { status: "persisted" }, disk);
		const result2 = await createDurableTargetInbox(input2);
		expect(result2.ok).toBe(true);
		if (!result2.ok) return;
		const inbox2 = result2.inbox;

		const replayEnv = makeEnvelope("tf-2", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const replay = await inbox2.admit({ envelope: replayEnv });
		expect(replay.ok).toBe(true);
		if (replay.ok) {
			expect(replay.value.frameId).toBe("tf-1");
		}
		await inbox2.close();
	});
	// -----------------------------------------------------------------------
	// 4. semantic collision
	// -----------------------------------------------------------------------
	it("poisons on same semantic id with different digest", async () => {
		const { inbox } = await openedInbox();
		const envelope1 = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result1 = await inbox.admit({ envelope: envelope1 });
		expect(result1.ok).toBe(true);

		const envelope2 = makeEnvelope("tf-2", "sm-1", "2025-01-01T00:00:00.000Z", "different");
		const result2 = await inbox.admit({ envelope: envelope2 });
		expect(result2.ok).toBe(false);
		if (!result2.ok) expect(result2.error.code).toBe("MISMATCH");
		await expectCode(inbox.admit({ envelope: envelope1 }), "POISONED");
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 5. concurrent duplicate admit (serialized)
	// -----------------------------------------------------------------------
	it("serializes concurrent admits and returns consistent receipt", async () => {
		const { inbox } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const [a, b] = await Promise.all([inbox.admit({ envelope }), inbox.admit({ envelope })]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(a.value.receipt.sequence).toBe(b.value.receipt.sequence);
		}
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 6. dispatcher deferred/persisted
	// -----------------------------------------------------------------------
	it("calls ensure when started and marks delivered on persisted", async () => {
		const { inbox, counts } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(true);
		const before = counts.ensure;
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBeGreaterThan(before);
		await inbox.close();
	});

	it("leaves state deferred when ensure returns deferred", async () => {
		const counts = zeroCounts();
		const disk = createDisk();
		const input = makeInput(counts, { status: "deferred" }, disk);
		const cr = await createDurableTargetInbox(input);
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(true);
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBeGreaterThan(0);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 7. delivered verification on restart
	// -----------------------------------------------------------------------
	it("re-verifies delivered records on restart", async () => {
		const { inbox, disk } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		await inbox.admit({ envelope });
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		await inbox.close();

		const counts2 = zeroCounts();
		const input2 = makeInput(counts2, { status: "persisted" }, disk);
		const cr2 = await createDurableTargetInbox(input2);
		expect(cr2.ok).toBe(true);
		if (!cr2.ok) return;
		const inbox2 = cr2.inbox;
		expect(counts2.ensure).toBe(0);
		inbox2.start();
		// Wait for drain to complete
		await new Promise((r) => setTimeout(r, 100));
		expect(counts2.ensure).toBeGreaterThan(0);
		await inbox2.close();
	});

	// -----------------------------------------------------------------------
	// 8. close during ensure
	// -----------------------------------------------------------------------
	it("closes cleanly when ensure is pending", async () => {
		const counts = zeroCounts();
		let resolveE: ((r: EnsureResult) => void) | undefined;
		const deferred = new Promise<EnsureResult>((r) => {
			resolveE = r;
		});
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return deferred;
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const input = makeInput(counts, { status: "persisted" });
		const cr = await createDurableTargetInbox({ ...input, dispatcher });
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		inbox.start();
		await new Promise((r) => setTimeout(r, 20));
		expect(counts.ensure).toBe(1);
		const cp = inbox.close();
		if (resolveE) resolveE({ status: "persisted" });
		const cr2 = await cp;
		expect(cr2.ok).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 9. close uncertain
	// -----------------------------------------------------------------------
	it("returns CLOSE_UNCERTAIN when dispatcher close fails", async () => {
		const counts = zeroCounts();
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return Promise.resolve({ status: "persisted" });
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "error" });
			},
		};
		const input = makeInput(counts, { status: "persisted" });
		const cr = await createDurableTargetInbox({ ...input, dispatcher });
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		const cl = await inbox.close();
		expect(cl.ok).toBe(false);
		if (!cl.ok) expect(cl.error.code).toBe("CLOSE_UNCERTAIN");
	});

	// -----------------------------------------------------------------------
	// 10. rejects non-agent_message
	// -----------------------------------------------------------------------
	it("rejects envelopes with non-agent_message frames", async () => {
		const { inbox } = await openedInbox();
		const nonAgent: RemoteHostFrameEnvelope = Object.freeze({
			type: "frame",
			frameId: "tf-1",
			protocol: Object.freeze({
				name: "prime-agent.remote-host" as const,
				version: 1 as const,
			}),
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: Object.freeze({
				type: "command",
				commandId: "cmd-1",
				body: Object.freeze({ type: "prompt", message: "hi" }),
			}),
		});
		const result = await inbox.admit({ envelope: nonAgent });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 11. rejects direction other than received
	// -----------------------------------------------------------------------
	it("rejects creation with direction other than received", async () => {
		const counts = zeroCounts();
		const input = makeInput(counts, { status: "persisted" });
		const result = await createDurableTargetInbox({ ...input, direction: "sent" });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	// -----------------------------------------------------------------------
	// 12. exact dispatcher keys
	// -----------------------------------------------------------------------
	it("rejects dispatcher with extra keys", async () => {
		const counts = zeroCounts();
		const input = makeInput(counts, { status: "persisted" });
		const badDispatcher = { ...input.dispatcher, extra: true };
		const result = await createDurableTargetInbox({ ...input, dispatcher: badDispatcher });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	// -----------------------------------------------------------------------
	// 13. ensure timeout poisons
	// -----------------------------------------------------------------------
	it("admit works while dispatch ensure is pending", async () => {
		const counts = zeroCounts();
		let resolveEnsure: ((r: EnsureResult) => void) | undefined;
		const hanging = new Promise<EnsureResult>((r) => {
			resolveEnsure = r;
		});
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return hanging;
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const input = makeInput(counts, { status: "persisted" });
		const cr = await createDurableTargetInbox({ ...input, dispatcher });
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBe(1);
		// Admit works while ensure is pending (separate tails)
		const r2 = await inbox.admit({ envelope: makeEnvelope("tf-2", "sm-2", "2025-01-01T00:00:00.000Z", "world") });
		expect(r2.ok).toBe(true);
		// Resolve hanging ensure so close can proceed
		if (resolveEnsure) resolveEnsure({ status: "deferred" });
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 14. bad ensure promise (reject) poisons
	// -----------------------------------------------------------------------
	it("poisons on ensure rejection", async () => {
		const counts = zeroCounts();
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return Promise.reject(new Error("dispatch failed"));
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const input = makeInput(counts, { status: "persisted" });
		const cr = await createDurableTargetInbox({ ...input, dispatcher });
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBe(1);
		await expectCode(
			inbox.admit({ envelope: makeEnvelope("tf-2", "sm-2", "2025-01-01T00:00:00.000Z", "world") }),
			"POISONED",
		);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 15. admit before start does not drain
	// -----------------------------------------------------------------------
	it("does not drain on admits before start is called", async () => {
		const { inbox, counts } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		await inbox.admit({ envelope });
		expect(counts.ensure).toBe(0);
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBeGreaterThan(0);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 16. replay receipts are real (not fake)
	// -----------------------------------------------------------------------
	it("uses real receipts from replay in semantic index", async () => {
		const { inbox, disk } = await openedInbox();
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const r1 = await inbox.admit({ envelope });
		expect(r1.ok).toBe(true);
		const originalReceipt = (r1 as { ok: true; value: AdmitReceipt }).value.receipt;
		await inbox.close();

		const counts2 = zeroCounts();
		const input2 = makeInput(counts2, { status: "persisted" }, disk);
		const cr2 = await createDurableTargetInbox(input2);
		expect(cr2.ok).toBe(true);
		if (!cr2.ok) return;

		const r2 = await cr2.inbox.admit({
			envelope: makeEnvelope("tf-2", "sm-1", "2025-01-01T00:00:00.000Z", "hello"),
		});
		expect(r2.ok).toBe(true);
		if (r2.ok) {
			expect(r2.value.receipt.sequence).toBe(originalReceipt.sequence);
			expect(r2.value.frameId).toBe("tf-1");
			expect(r2.value.receipt.size).toBeGreaterThan(0);
		}
		await cr2.inbox.close();
	});

	// -----------------------------------------------------------------------
	// 17. close reentrancy — second close returns same promise
	// -----------------------------------------------------------------------
	it("returns the same promise on reentrant close", async () => {
		const { inbox } = await openedInbox();
		const c1 = inbox.close();
		const c2 = inbox.close();
		expect(c1).toBe(c2);
		const r1 = await c1;
		const r2 = await c2;
		expect(r1.ok).toBe(r2.ok);
	});

	// -----------------------------------------------------------------------
	// 18. start is idempotent
	// -----------------------------------------------------------------------
	it("start is idempotent, second call does not double-dispatch", async () => {
		const { inbox, counts } = await openedInbox();
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		inbox.start();
		inbox.start();
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBe(1);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 19. admit mutating caller does not change admission
	// -----------------------------------------------------------------------
	it("admit decodes synchronously so caller mutation does not affect enqueued data", async () => {
		const { inbox } = await openedInbox();
		// Use a non-frozen mutable envelope (no Object.freeze)
		const mutable = Object.assign({}, makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello"));
		const admitPromise = inbox.admit({ envelope: mutable });
		// Mutate after synchronous decode
		(mutable as unknown as Record<string, unknown>).frameId = "tf-mutated";
		const result = await admitPromise;
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.frameId).toBe("tf-1");
		}
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 20. create failure before store creation closes dispatcher
	// -----------------------------------------------------------------------
	it("closes dispatcher when invalid input fails create", async () => {
		let dpClosed = false;
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				return Promise.resolve({ status: "persisted" });
			},
			close(): Promise<{ status: "closed" | "error" }> {
				dpClosed = true;
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			dispatcher,
			extra: true, // This should fail INVALID_ARGUMENT
		});
		expect(result.ok).toBe(false);
		expect(dpClosed).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 21. >64 records — cursor advancing works
	// -----------------------------------------------------------------------
	it("drains >64 records with cursor advancing", async () => {
		const counts = zeroCounts();
		const disk = createDisk();
		const input = makeInput(counts, { status: "persisted" }, disk);
		const cr = await createDurableTargetInbox(input);
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;

		// Admit 70 messages
		for (let i = 0; i < 70; i++) {
			const env = makeEnvelope(`tf-${i}`, `sm-${i}`, "2025-01-01T00:00:00.000Z", `msg-${i}`);
			const r = await inbox.admit({ envelope: env });
			expect(r.ok).toBe(true);
		}
		expect(counts.journal).toBe(70);
		expect(counts.marker).toBe(70);

		inbox.start();
		await new Promise((r) => setTimeout(r, 100));
		// ensure should be called 70 times
		expect(counts.ensure).toBe(70);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 22. wrong target identity in admit
	// -----------------------------------------------------------------------
	it("rejects admit with mismatched targetActiveSessionId", async () => {
		const { inbox } = await openedInbox();
		// Use a different target session than the inbox identity sessionId
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello", "a-1", "wrong-target");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 23. publish UNCERTAIN poisons
	// -----------------------------------------------------------------------
	it("poisons on publish UNCERTAIN from store", async () => {
		const counts = zeroCounts();
		const journalPublisher = {
			publish(raw: unknown): Promise<unknown> {
				counts.journal += 1;
				const value = raw as { seq: number; bytes: Uint8Array };
				value.bytes.fill(0);
				return Promise.resolve({
					status: "POST_PUBLICATION_UNCERTAIN",
					seq: value.seq,
					size: value.bytes.byteLength,
					sha256: sha256(value.bytes),
				});
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const deliveryPublisher = {
			publish(raw: unknown): Promise<unknown> {
				counts.marker += 1;
				const value = raw as { indexSeq: number; bytes: Uint8Array };
				value.bytes.fill(0);
				return Promise.resolve({
					status: "success",
					sequence: value.indexSeq,
					size: value.bytes.byteLength,
					sha256: sha256(value.bytes),
				});
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const recoveryBackend = {
			listPage(): Promise<unknown> {
				counts.recovery += 1;
				return Promise.resolve({ entries: [], nextCursor: null });
			},
			open(): Promise<unknown> {
				return Promise.resolve({ status: "error" });
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return Promise.resolve({ status: "persisted" });
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const input = {
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received" as const,
			journalDir: "/tmp/inbox",
			journalPublisher,
			deliveryPublisher,
			recoveryBackend,
			dispatcher,
		};
		const cr = await createDurableTargetInbox(input);
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		const envelope = makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello");
		const result = await inbox.admit({ envelope });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("UNCERTAIN");
		await expectCode(inbox.admit({ envelope }), "POISONED");
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 24. rejected drain tail poisons
	// -----------------------------------------------------------------------
	it("poisons on store replay failure during drain", async () => {
		const counts = zeroCounts();
		const storeJournalPublisher = {
			publish(raw: unknown): Promise<unknown> {
				counts.journal += 1;
				const value = raw as { seq: number; bytes: Uint8Array };
				const result = {
					status: "success" as const,
					seq: value.seq,
					size: value.bytes.byteLength,
					sha256: sha256(value.bytes),
				};
				value.bytes.fill(0);
				return Promise.resolve(result);
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const storeDeliveryPublisher = {
			publish(raw: unknown): Promise<unknown> {
				counts.marker += 1;
				const value = raw as { indexSeq: number; bytes: Uint8Array };
				const result = {
					status: "success" as const,
					sequence: value.indexSeq,
					size: value.bytes.byteLength,
					sha256: sha256(value.bytes),
				};
				value.bytes.fill(0);
				return Promise.resolve(result);
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const storeRecoveryBackend = {
			listPage(): Promise<unknown> {
				counts.recovery += 1;
				return Promise.resolve({ entries: [], nextCursor: null });
			},
			open(): Promise<unknown> {
				return Promise.resolve({ status: "error" });
			},
			close(): Promise<unknown> {
				return closeOk();
			},
		};
		const dispatcher: DispatcherCapability = {
			ensure(_raw: unknown): Promise<EnsureResult> {
				counts.ensure += 1;
				return Promise.resolve({ status: "persisted" });
			},
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const input = {
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received" as const,
			journalDir: "/tmp/inbox",
			journalPublisher: storeJournalPublisher,
			deliveryPublisher: storeDeliveryPublisher,
			recoveryBackend: storeRecoveryBackend,
			dispatcher,
		};
		const cr = await createDurableTargetInbox(input);
		expect(cr.ok).toBe(true);
		if (!cr.ok) return;
		const inbox = cr.inbox;
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		inbox.start();
		await new Promise((r) => setTimeout(r, 50));
		expect(counts.ensure).toBe(1);
		await inbox.close();
	});

	// -----------------------------------------------------------------------
	// 25. create with malformed dispatcher but valid close
	// -----------------------------------------------------------------------
	it("rejects create with malformed dispatcher even if close is valid", async () => {
		const counts = zeroCounts();
		const disk = createDisk();
		const dispatcher = {
			extraOnly: true,
			close(): Promise<{ status: "closed" | "error" }> {
				counts.ensureClose += 1;
				return Promise.resolve({ status: "closed" });
			},
		} as unknown as DispatcherCapability;
		const input = makeInput(counts, { status: "persisted" }, disk);
		const result = await createDurableTargetInbox({ ...input, dispatcher });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	// -----------------------------------------------------------------------
	// 26. create with malformed top-level input closes dispatcher
	// -----------------------------------------------------------------------
	it("closes dispatcher on malformed top-level input", async () => {
		let closed = false;
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "00" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "00" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			dispatcher: {
				ensure() {
					return Promise.resolve({ status: "persisted" });
				},
				close() {
					closed = true;
					return Promise.resolve({ status: "closed" });
				},
			},
			extra: true,
		});
		expect(result.ok).toBe(false);
		expect(closed).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 27. create with invalid direction after valid dispatcher closes dispatcher
	// -----------------------------------------------------------------------
	it("closes dispatcher when direction is not received", async () => {
		let closed = false;
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "sent",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "00" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "00" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					return Promise.resolve({ status: "closed" });
				},
			},
			dispatcher: {
				ensure() {
					return Promise.resolve({ status: "persisted" });
				},
				close() {
					closed = true;
					return Promise.resolve({ status: "closed" });
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(closed).toBe(true);
	});

	// -----------------------------------------------------------------------
	// 28. close counters — extra top key closes all 4 caps
	// -----------------------------------------------------------------------
	it("closes all 4 caps on extra top-level key", async () => {
		const closeCounts = { journal: 0, delivery: 0, recovery: 0, dispatcher: 0 };
		const okResult = () => Promise.resolve({ status: "closed" });
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "aa" });
				},
				close() {
					closeCounts.journal += 1;
					return okResult();
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "bb" });
				},
				close() {
					closeCounts.delivery += 1;
					return okResult();
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					closeCounts.recovery += 1;
					return okResult();
				},
			},
			dispatcher: {
				ensure() {
					return Promise.resolve({ status: "persisted" });
				},
				close() {
					closeCounts.dispatcher += 1;
					return okResult();
				},
			},
			extra: true,
		});
		expect(result.ok).toBe(false);
		expect(closeCounts.journal).toBe(1);
		expect(closeCounts.delivery).toBe(1);
		expect(closeCounts.recovery).toBe(1);
		expect(closeCounts.dispatcher).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 29. close counters — invalid direction closes all 4 caps
	// -----------------------------------------------------------------------
	it("closes all 4 caps on invalid direction", async () => {
		const closeCounts = { journal: 0, delivery: 0, recovery: 0, dispatcher: 0 };
		const okResult = () => Promise.resolve({ status: "closed" });
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "sent",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "aa" });
				},
				close() {
					closeCounts.journal += 1;
					return okResult();
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "bb" });
				},
				close() {
					closeCounts.delivery += 1;
					return okResult();
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					closeCounts.recovery += 1;
					return okResult();
				},
			},
			dispatcher: {
				ensure() {
					return Promise.resolve({ status: "persisted" });
				},
				close() {
					closeCounts.dispatcher += 1;
					return okResult();
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(closeCounts.journal).toBe(1);
		expect(closeCounts.delivery).toBe(1);
		expect(closeCounts.recovery).toBe(1);
		expect(closeCounts.dispatcher).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 30. close counters — invalid ensure (no ensure) closes all 4 caps
	// -----------------------------------------------------------------------
	it("closes all 4 caps on missing ensure", async () => {
		const closeCounts = { journal: 0, delivery: 0, recovery: 0, dispatcher: 0 };
		const okResult = () => Promise.resolve({ status: "closed" });
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "aa" });
				},
				close() {
					closeCounts.journal += 1;
					return okResult();
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "bb" });
				},
				close() {
					closeCounts.delivery += 1;
					return okResult();
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					closeCounts.recovery += 1;
					return okResult();
				},
			},
			dispatcher: {
				close() {
					closeCounts.dispatcher += 1;
					return okResult();
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(closeCounts.journal).toBe(1);
		expect(closeCounts.delivery).toBe(1);
		expect(closeCounts.recovery).toBe(1);
		expect(closeCounts.dispatcher).toBe(1);
	});

	// -----------------------------------------------------------------------
	// 31. close counters — missing dispatcher close still closes publisher/recovery
	// -----------------------------------------------------------------------
	it("closes publisher/recovery when dispatcher has no close", async () => {
		const closeCounts = { journal: 0, delivery: 0, recovery: 0 };
		const result = await createDurableTargetInbox({
			identity: { hostId: "h-1", generation: "g-1", sessionId: "t-1" },
			direction: "received",
			journalDir: "/tmp/inbox",
			journalPublisher: {
				publish() {
					return Promise.resolve({ status: "success", seq: 1, size: 1, sha256: "aa" });
				},
				close() {
					closeCounts.journal += 1;
					return Promise.resolve({ status: "closed" });
				},
			},
			deliveryPublisher: {
				publish() {
					return Promise.resolve({ status: "success", sequence: 1, size: 1, sha256: "bb" });
				},
				close() {
					closeCounts.delivery += 1;
					return Promise.resolve({ status: "closed" });
				},
			},
			recoveryBackend: {
				listPage() {
					return Promise.resolve({ entries: [], nextCursor: null });
				},
				open() {
					return Promise.resolve({ status: "error" });
				},
				close() {
					closeCounts.recovery += 1;
					return Promise.resolve({ status: "closed" });
				},
			},
			dispatcher: {
				ensure() {
					return Promise.resolve({ status: "persisted" });
				},
			},
		});
		expect(result.ok).toBe(false);
		expect(closeCounts.journal).toBe(1);
		expect(closeCounts.delivery).toBe(1);
		expect(closeCounts.recovery).toBe(1);
	});

	it("installs the shared close promise before synchronous dispatcher reentry", async () => {
		const counts = zeroCounts();
		const disk = createDisk();
		let inboxRef: DurableTargetInbox | null = null;
		let reentered: Promise<unknown> | null = null;
		const dispatcher: DispatcherCapability = {
			ensure(): Promise<EnsureResult> {
				return Promise.resolve(Object.freeze({ status: "persisted" as const }));
			},
			close(): Promise<Readonly<{ status: "closed" | "error" }>> {
				if (inboxRef) reentered = inboxRef.close();
				return Promise.resolve(Object.freeze({ status: "closed" as const }));
			},
		};
		const created = await createDurableTargetInbox({
			...makeInput(counts, { status: "persisted" }, disk),
			dispatcher,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		inboxRef = created.inbox;
		const primary = created.inbox.close();
		expect(reentered).toBe(primary);
		expect(await primary).toMatchObject({ ok: true });
	});

	it("poisons when the current drain run rejects", async () => {
		const { inbox } = await openedInbox();
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		const original = DurableRelayStore.prototype.replayJournals;
		DurableRelayStore.prototype.replayJournals = function rejectReplay(): ReturnType<
			DurableRelayStore["replayJournals"]
		> {
			return Promise.reject(new Error("injected replay rejection"));
		};
		try {
			inbox.start();
			await new Promise((resolve) => setTimeout(resolve, 20));
			await expectCode(
				inbox.admit({ envelope: makeEnvelope("tf-2", "sm-2", "2025-01-01T00:00:01.000Z", "again") }),
				"POISONED",
			);
		} finally {
			DurableRelayStore.prototype.replayJournals = original;
			await inbox.close();
		}
	});

	it("exposes an awaitable dispatch pass and retries deferred records", async () => {
		const counts = zeroCounts();
		const disk = createDisk();
		let status: EnsureResult["status"] = "deferred";
		const dispatcher: DispatcherCapability = {
			ensure(): Promise<EnsureResult> {
				counts.ensure += 1;
				return Promise.resolve(Object.freeze({ status }));
			},
			close(): Promise<Readonly<{ status: "closed" | "error" }>> {
				counts.ensureClose += 1;
				return Promise.resolve(Object.freeze({ status: "closed" as const }));
			},
		};
		const created = await createDurableTargetInbox({
			...makeInput(counts, { status: "persisted" }, disk),
			dispatcher,
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const { inbox } = created;
		await inbox.admit({ envelope: makeEnvelope("tf-1", "sm-1", "2025-01-01T00:00:00.000Z", "hello") });
		expect(await inbox.dispatchPending()).toMatchObject({ ok: true });
		expect(counts.ensure).toBe(1);
		status = "persisted";
		expect(await inbox.dispatchPending()).toMatchObject({ ok: true });
		expect(counts.ensure).toBe(2);
		expect(await inbox.dispatchPending()).toMatchObject({ ok: true });
		expect(counts.ensure).toBe(3);
		await inbox.close();
	});
});
