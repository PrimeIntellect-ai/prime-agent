import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDurableRelayStore, type DurableRelayStore } from "../src/modes/daemon/durable-relay-store.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
	type RemoteHostFrameEnvelope,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

const IDENTITY = Object.freeze({ hostId: "h-1", generation: "g-1", sessionId: "s-1" });

interface CapState {
	journalPublishes: number;
	markerPublishes: number;
	journalCloses: number;
	markerCloses: number;
	recoveryCloses: number;
	listCalls: number;
}

interface StoredFile {
	readonly name: string;
	readonly bytes: Uint8Array;
	readonly stat: Readonly<Record<string, unknown>>;
}

interface TestCaps {
	readonly state: CapState;
	readonly files: StoredFile[];
	readonly journalPublisher: Readonly<Record<string, unknown>>;
	readonly deliveryPublisher: Readonly<Record<string, unknown>>;
	readonly recoveryBackend: Readonly<Record<string, unknown>>;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function closeResult(): Promise<unknown> {
	return Promise.resolve({ status: "closed" });
}

function standardCaps(initialFiles: readonly StoredFile[] = []): TestCaps {
	const state: CapState = {
		journalPublishes: 0,
		markerPublishes: 0,
		journalCloses: 0,
		markerCloses: 0,
		recoveryCloses: 0,
		listCalls: 0,
	};
	const files: StoredFile[] = initialFiles.map((file) => ({
		...file,
		bytes: new Uint8Array(file.bytes),
	}));
	const makeStored = (name: string, bytes: Uint8Array): StoredFile => {
		const copy = new Uint8Array(bytes);
		return {
			name,
			bytes: copy,
			stat: {
				dev: "1",
				ino: String(files.length + 1),
				uid: "501",
				mode: 0o600,
				size: copy.byteLength,
				nlink: 1,
				isFile: true,
				isSymlink: false,
				mtimeNs: "1",
				ctimeNs: "1",
			},
		};
	};
	const journalPublisher = {
		publish(options: unknown): Promise<unknown> {
			state.journalPublishes += 1;
			const value = options as { seq: number; bytes: Uint8Array };
			const result = {
				status: "success",
				seq: value.seq,
				size: value.bytes.byteLength,
				sha256: sha256(value.bytes),
			};
			files.push(makeStored(`${String(value.seq).padStart(20, "0")}.b03-journal`, value.bytes));
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			state.journalCloses += 1;
			return closeResult();
		},
	};
	const deliveryPublisher = {
		publish(options: unknown): Promise<unknown> {
			state.markerPublishes += 1;
			const value = options as { indexSeq: number; bytes: Uint8Array };
			const result = {
				status: "success",
				sequence: value.indexSeq,
				size: value.bytes.byteLength,
				sha256: sha256(value.bytes),
			};
			files.push(makeStored(`${String(value.indexSeq).padStart(20, "0")}.b03-delivery`, value.bytes));
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			state.markerCloses += 1;
			return closeResult();
		},
	};
	const recoveryBackend = {
		listPage(): Promise<unknown> {
			state.listCalls += 1;
			const entries = [...files]
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((file) => ({ name: file.name, stat: file.stat }));
			return Promise.resolve({ entries, nextCursor: null });
		},
		open(request: unknown): Promise<unknown> {
			const name = (request as { name: string }).name;
			const file = files.find((candidate) => candidate.name === name);
			if (!file) return Promise.resolve({ status: "error" });
			const handle = {
				readAt(offset: number, size: number): Promise<unknown> {
					if (offset >= file.bytes.byteLength) return Promise.resolve({ status: "eof" });
					return Promise.resolve({
						status: "bytes",
						bytes: file.bytes.slice(offset, Math.min(offset + size, file.bytes.byteLength)),
					});
				},
				confirmEof(size: number): Promise<unknown> {
					return Promise.resolve({ status: size === file.bytes.byteLength ? "eof" : "error" });
				},
				fstat(): Promise<unknown> {
					return Promise.resolve(file.stat);
				},
				close(): Promise<unknown> {
					return closeResult();
				},
			};
			return Promise.resolve({ status: "opened", handle });
		},
		close(): Promise<unknown> {
			state.recoveryCloses += 1;
			return closeResult();
		},
	};
	return { state, files, journalPublisher, deliveryPublisher, recoveryBackend };
}

function createInput(caps: TestCaps): Readonly<Record<string, unknown>> {
	return {
		identity: IDENTITY,
		direction: "received",
		journalDir: "/safe/journal",
		journalPublisher: caps.journalPublisher,
		deliveryPublisher: caps.deliveryPublisher,
		recoveryBackend: caps.recoveryBackend,
	};
}

function envelope(frameId = "f-1"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: {
			type: "event",
			id: `event-${frameId}`,
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "agent_start" },
		},
	};
}

function journalInput(frameId = "f-1"): Readonly<Record<string, unknown>> {
	return {
		version: 1,
		direction: "received",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		envelope: envelope(frameId),
	};
}

async function opened(caps = standardCaps()): Promise<Readonly<{ store: DurableRelayStore; caps: TestCaps }>> {
	const result = await createDurableRelayStore(createInput(caps));
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("store did not open");
	return { store: result.store, caps };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
	const result = (await promise) as { ok: boolean; error?: { code: string } };
	expect(result.ok).toBe(false);
	expect(result.error?.code).toBe(code);
}

describe("durable relay store", () => {
	it("recovers before becoming available and returns sanitized status", async () => {
		const { store, caps } = await opened();
		expect(caps.state.listCalls).toBe(1);
		const query = await store.query("missing");
		expect(query).toEqual({ ok: false, error: { code: "NOT_FOUND" } });
		await store.close();
	});

	it("persists new, pending, and delivered transitions before updating queries", async () => {
		const { store, caps } = await opened();
		const published = await store.publish(journalInput());
		expect(published.ok).toBe(true);
		const initial = await store.query("f-1");
		expect(initial.ok && initial.value.state).toBe("new");
		const pending = await store.markPending({
			frameId: "f-1",
			recordedAt: "2025-01-15T10:30:01.000Z",
		});
		expect(pending.ok).toBe(true);
		const afterPending = await store.query("f-1");
		expect(afterPending.ok && afterPending.value.state).toBe("pending");
		const delivered = await store.markDelivered({
			frameId: "f-1",
			recordedAt: "2025-01-15T10:30:02.000Z",
		});
		expect(delivered.ok).toBe(true);
		const afterDelivered = await store.query("f-1");
		expect(afterDelivered.ok && afterDelivered.value.state).toBe("delivered");
		expect(caps.state.journalPublishes).toBe(1);
		expect(caps.state.markerPublishes).toBe(2);
		await store.close();
	});

	it("reconstructs delivered state and exact receipts after restart", async () => {
		const firstCaps = standardCaps();
		const { store: first } = await opened(firstCaps);
		const journal = await first.publish(journalInput());
		const pending = await first.markPending({
			frameId: "f-1",
			recordedAt: "2025-01-15T10:30:01.000Z",
		});
		const delivered = await first.markDelivered({
			frameId: "f-1",
			recordedAt: "2025-01-15T10:30:02.000Z",
		});
		expect((await first.close()).ok).toBe(true);
		const secondCaps = standardCaps(firstCaps.files);
		const { store: second } = await opened(secondCaps);
		const recovered = await second.query("f-1");
		expect(recovered).toEqual({
			ok: true,
			value: {
				state: "delivered",
				journal: journal.ok ? journal.value : null,
				pending: pending.ok ? pending.value : null,
				delivered: delivered.ok ? delivered.value : null,
			},
		});
		await second.close();
	});

	it("returns exact durable receipts for idempotent retries", async () => {
		const { store, caps } = await opened();
		const first = await store.publish(journalInput());
		const duplicate = await store.publish(journalInput());
		expect(duplicate).toEqual(first);
		const pending = await store.markPending({ frameId: "f-1", recordedAt: "2025-01-15T10:30:01.000Z" });
		await store.markDelivered({ frameId: "f-1", recordedAt: "2025-01-15T10:30:02.000Z" });
		const pendingReplay = await store.markPending({
			frameId: "f-1",
			recordedAt: "2025-01-15T10:30:03.000Z",
		});
		expect(pendingReplay).toEqual(pending);
		expect(caps.state.journalPublishes).toBe(1);
		expect(caps.state.markerPublishes).toBe(2);
		await store.close();
	});

	it("snapshots mutable envelope input before FIFO acceptance", async () => {
		const { store, caps } = await opened();
		const mutableEnvelope = { ...envelope() };
		const raw = { ...journalInput(), envelope: mutableEnvelope };
		const firstPromise = store.publish(raw);
		mutableEnvelope.sentAt = "2025-01-15T10:31:00.000Z";
		const first = await firstPromise;
		const duplicate = await store.publish(journalInput());
		expect(duplicate).toEqual(first);
		expect(caps.state.journalPublishes).toBe(1);
		await store.close();
	});

	it("poisons on a frame-id digest mismatch", async () => {
		const { store } = await opened();
		await store.publish(journalInput());
		const changed = journalInput() as Record<string, unknown>;
		changed.envelope = {
			...envelope(),
			sentAt: "2025-01-15T10:31:00.000Z",
		};
		await expectCode(store.publish(changed), "MISMATCH");
		await expectCode(store.query("f-1"), "POISONED");
		await store.close();
	});

	it("requires pending before delivered", async () => {
		const { store } = await opened();
		await store.publish(journalInput());
		await expectCode(store.markDelivered({ frameId: "f-1", recordedAt: "2025-01-15T10:30:02.000Z" }), "COLLISION");
		await store.close();
	});

	it("serializes accepted work and drains it before close", async () => {
		const caps = standardCaps();
		const gate: { release: (() => void) | null } = { release: null };
		let startedResolve: (() => void) | null = null;
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const original = caps.journalPublisher.publish as (options: unknown) => Promise<unknown>;
		const journalPublisher = {
			publish(options: unknown): Promise<unknown> {
				if (caps.state.journalPublishes === 0) {
					caps.state.journalPublishes += 1;
					const value = options as { seq: number; bytes: Uint8Array };
					const result = {
						status: "success",
						seq: value.seq,
						size: value.bytes.byteLength,
						sha256: sha256(value.bytes),
					};
					startedResolve?.();
					return new Promise((resolve) => {
						gate.release = () => {
							value.bytes.fill(0);
							resolve(result);
						};
					});
				}
				return original(options);
			},
			close: caps.journalPublisher.close,
		};
		const custom: TestCaps = { ...caps, journalPublisher };
		const { store } = await opened(custom);
		const first = store.publish(journalInput("f-1"));
		await started;
		const second = store.publish(journalInput("f-2"));
		const close = store.close();
		expect(store.close()).toBe(close);
		expect(custom.state.journalPublishes).toBe(1);
		expect(custom.state.journalCloses).toBe(0);
		gate.release?.();
		expect((await first).ok).toBe(true);
		expect((await second).ok).toBe(true);
		expect((await close).ok).toBe(true);
		expect(custom.state.journalPublishes).toBe(2);
		expect(custom.state.journalCloses).toBe(1);
	});

	it("latches close synchronously and closes each capability once", async () => {
		const { store, caps } = await opened();
		const first = store.close();
		const second = store.close();
		expect(second).toBe(first);
		await expectCode(store.publish(journalInput()), "CLOSED");
		expect(await first).toEqual({ ok: true, value: undefined });
		expect(caps.state.journalCloses).toBe(1);
		expect(caps.state.markerCloses).toBe(1);
		expect(caps.state.recoveryCloses).toBe(1);
	});

	it("closes discovered capabilities when unrelated factory validation fails", async () => {
		const caps = standardCaps();
		const invalid = { ...createInput(caps), extra: true };
		const result = await createDurableRelayStore(invalid);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(caps.state.journalCloses).toBe(1);
		expect(caps.state.markerCloses).toBe(1);
		expect(caps.state.recoveryCloses).toBe(1);
	});

	it("lets close uncertainty dominate factory failure", async () => {
		const caps = standardCaps();
		const brokenJournal = {
			publish: caps.journalPublisher.publish,
			close(): Promise<unknown> {
				caps.state.journalCloses += 1;
				return Promise.reject(new Error("uncertain"));
			},
		};
		const invalid = {
			...createInput({ ...caps, journalPublisher: brokenJournal }),
			extra: true,
		};
		const result = await createDurableRelayStore(invalid);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("poisons on non-native publication promises", async () => {
		const caps = standardCaps();
		const journalPublisher = {
			publish(): unknown {
				caps.state.journalPublishes += 1;
				return Object.create(Promise.prototype);
			},
			close: caps.journalPublisher.close,
		};
		const { store } = await opened({ ...caps, journalPublisher });
		await expectCode(store.publish(journalInput()), "UNCERTAIN");
		await expectCode(store.query("f-1"), "POISONED");
		await store.close();
	});

	it("replays bounded sequence-cursor pages", async () => {
		const { store } = await opened();
		await store.publish(journalInput("f-1"));
		await store.publish(journalInput("f-2"));
		const first = await store.replayJournals({ cursor: null, maxCount: 1 });
		expect(first.ok && first.value.entries).toHaveLength(1);
		expect(first.ok && first.value.nextCursor).toBe(2);
		const second = await store.replayJournals({ cursor: 2, maxCount: 1 });
		expect(second.ok && second.value.entries).toHaveLength(1);
		expect(second.ok && second.value.nextCursor).toBeNull();
		await store.close();
	});

	it("rejects hostile public inputs without invoking accessors", async () => {
		const { store } = await opened();
		let invoked = false;
		const hostile = Object.defineProperty({}, "frameId", {
			enumerable: true,
			get() {
				invoked = true;
				return "f-1";
			},
		});
		await expectCode(store.markPending(hostile), "INVALID_ARGUMENT");
		expect(invoked).toBe(false);
		await store.close();
	});
});
