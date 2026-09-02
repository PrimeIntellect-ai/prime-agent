import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDurableRelayStore, type DurableRelayStore } from "../src/modes/daemon/durable-relay-store.js";
import { createOrderedDurableRelay, type OrderedDurableRelay } from "../src/modes/daemon/ordered-durable-relay.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
	type RemoteHostFrameEnvelope,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

const IDENTITY = Object.freeze({ hostId: "h-1", generation: "g-1", sessionId: "s-1" });

interface CloseCounts {
	journal: number;
	marker: number;
	recovery: number;
	transport: number;
	application: number;
}

function hash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface DiskFile {
	readonly name: string;
	readonly bytes: Uint8Array;
	readonly stat: Readonly<Record<string, unknown>>;
}

interface RelayDisk {
	readonly files: DiskFile[];
}

function emptyDisk(): RelayDisk {
	return { files: [] };
}

async function openStore(
	direction: "sent" | "received",
	counts: CloseCounts,
	disk: RelayDisk = emptyDisk(),
): Promise<DurableRelayStore> {
	const save = (name: string, bytes: Uint8Array): void => {
		const copy = new Uint8Array(bytes);
		disk.files.push({
			name,
			bytes: copy,
			stat: {
				dev: "1",
				ino: String(disk.files.length + 1),
				uid: "501",
				mode: 0o600,
				size: copy.byteLength,
				nlink: 1,
				isFile: true,
				isSymlink: false,
				mtimeNs: "1",
				ctimeNs: "1",
			},
		});
	};
	const journalPublisher = {
		publish(raw: unknown): Promise<unknown> {
			const value = raw as { seq: number; bytes: Uint8Array };
			const result = {
				status: "success",
				seq: value.seq,
				size: value.bytes.byteLength,
				sha256: hash(value.bytes),
			};
			save(`${String(value.seq).padStart(20, "0")}.b03-journal`, value.bytes);
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			counts.journal += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	const deliveryPublisher = {
		publish(raw: unknown): Promise<unknown> {
			const value = raw as { indexSeq: number; bytes: Uint8Array };
			const result = {
				status: "success",
				sequence: value.indexSeq,
				size: value.bytes.byteLength,
				sha256: hash(value.bytes),
			};
			save(`${String(value.indexSeq).padStart(20, "0")}.b03-delivery`, value.bytes);
			value.bytes.fill(0);
			return Promise.resolve(result);
		},
		close(): Promise<unknown> {
			counts.marker += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	const recoveryBackend = {
		listPage(): Promise<unknown> {
			const entries = [...disk.files]
				.sort((left, right) => left.name.localeCompare(right.name))
				.map((file) => ({ name: file.name, stat: file.stat }));
			return Promise.resolve({ entries, nextCursor: null });
		},
		open(raw: unknown): Promise<unknown> {
			const name = (raw as { name: string }).name;
			const file = disk.files.find((candidate) => candidate.name === name);
			if (!file) return Promise.resolve({ status: "error" });
			return Promise.resolve({
				status: "opened",
				handle: {
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
						return Promise.resolve({ status: "closed" });
					},
				},
			});
		},
		close(): Promise<unknown> {
			counts.recovery += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	const created = await createDurableRelayStore({
		identity: IDENTITY,
		direction,
		journalDir: `/journal/${direction}`,
		journalPublisher,
		deliveryPublisher,
		recoveryBackend,
	});
	if (!created.ok) throw new Error("failed to create store");
	return created.store;
}

function eventEnvelope(frameId = "incoming-1"): RemoteHostFrameEnvelope {
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

function ackEnvelope(acknowledges: string, frameId = "incoming-ack"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:01.000Z",
		frame: {
			type: "ack",
			ackId: `semantic-${frameId}`,
			acknowledges,
			status: "delivered",
		},
	};
}

function capCounts(): CloseCounts {
	return { journal: 0, marker: 0, recovery: 0, transport: 0, application: 0 };
}

interface RelayHarness {
	readonly relay: OrderedDurableRelay;
	readonly incoming: DurableRelayStore;
	readonly outgoing: DurableRelayStore;
	readonly counts: CloseCounts;
	readonly sent: RemoteHostFrameEnvelope[];
	readonly applied: RemoteHostFrameEnvelope[];
}

async function openRelay(
	overrides?: Readonly<{
		transportSend?: (raw: unknown) => Promise<unknown>;
		applicationApply?: (raw: unknown) => Promise<unknown>;
		incomingDisk?: RelayDisk;
		outgoingDisk?: RelayDisk;
	}>,
): Promise<RelayHarness> {
	const counts = capCounts();
	const incoming = await openStore("received", counts, overrides?.incomingDisk);
	const outgoing = await openStore("sent", counts, overrides?.outgoingDisk);
	const sent: RemoteHostFrameEnvelope[] = [];
	const applied: RemoteHostFrameEnvelope[] = [];
	const transport = {
		send(raw: unknown): Promise<unknown> {
			const envelope = (raw as { envelope: RemoteHostFrameEnvelope }).envelope;
			sent.push(envelope);
			return overrides?.transportSend?.(raw) ?? Promise.resolve({ status: "sent" });
		},
		close(): Promise<unknown> {
			counts.transport += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	const application = {
		apply(raw: unknown): Promise<unknown> {
			const envelope = (raw as { envelope: RemoteHostFrameEnvelope }).envelope;
			applied.push(envelope);
			return overrides?.applicationApply?.(raw) ?? Promise.resolve({ status: "applied" });
		},
		close(): Promise<unknown> {
			counts.application += 1;
			return Promise.resolve({ status: "closed" });
		},
	};
	const created = await createOrderedDurableRelay({
		identity: IDENTITY,
		incomingStore: incoming,
		outgoingStore: outgoing,
		transport,
		application,
	});
	if (!created.ok) throw new Error("failed to create relay");
	return { relay: created.relay, incoming, outgoing, counts, sent, applied };
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
	const result = (await promise) as { ok: boolean; error?: { code: string } };
	return result.error?.code;
}

describe("ordered durable relay", () => {
	it("persists pending before apply and delivered ACK before transport", async () => {
		let incoming: DurableRelayStore;
		let outgoing: DurableRelayStore;
		const harness = await openRelay({
			applicationApply: async (raw) => {
				const frameId = (raw as { envelope: RemoteHostFrameEnvelope }).envelope.frameId;
				const state = await incoming.query(frameId);
				expect(state.ok && state.value.state).toBe("pending");
				return { status: "applied" };
			},
			transportSend: async (raw) => {
				const ack = (raw as { envelope: RemoteHostFrameEnvelope }).envelope;
				const incomingState = await incoming.query("incoming-1");
				const outgoingState = await outgoing.query(ack.frameId);
				expect(incomingState.ok && incomingState.value.state).toBe("delivered");
				expect(outgoingState.ok && outgoingState.value.state).toBe("delivered");
				return { status: "sent" };
			},
		});
		incoming = harness.incoming;
		outgoing = harness.outgoing;
		const result = await harness.relay.receive(eventEnvelope());
		expect(result.ok && result.value.action).toBe("applied_and_acknowledged");
		expect(harness.applied).toHaveLength(1);
		expect(harness.sent).toHaveLength(1);
		await harness.relay.close();
	});

	it("replays the exact persisted deterministic ACK without reapplying", async () => {
		const harness = await openRelay();
		const first = await harness.relay.receive(eventEnvelope());
		const second = await harness.relay.receive(eventEnvelope());
		expect(first.ok && first.value.action).toBe("applied_and_acknowledged");
		expect(second.ok && second.value.action).toBe("replayed_ack");
		expect(harness.applied).toHaveLength(1);
		expect(harness.sent).toHaveLength(2);
		expect(harness.sent[1]).toEqual(harness.sent[0]);
		expect(harness.sent[0].frameId).not.toBe(eventEnvelope().frameId);
		expect(harness.sent[0].frame.type).toBe("ack");
		if (harness.sent[0].frame.type === "ack") {
			expect(harness.sent[0].frame.ackId).not.toBe(harness.sent[0].frameId);
		}
		await harness.relay.close();
	});

	it("replays the exact ACK after both durable stores restart", async () => {
		const incomingDisk = emptyDisk();
		const outgoingDisk = emptyDisk();
		const first = await openRelay({ incomingDisk, outgoingDisk });
		const initial = await first.relay.receive(eventEnvelope());
		expect(initial.ok).toBe(true);
		const exactAck = first.sent[0];
		await first.relay.close();
		const second = await openRelay({ incomingDisk, outgoingDisk });
		const replay = await second.relay.receive(eventEnvelope());
		expect(replay.ok && replay.value.action).toBe("replayed_ack");
		expect(second.applied).toHaveLength(0);
		expect(second.sent).toEqual([exactAck]);
		await second.relay.close();
	});

	it("leaves pending durable evidence and poisons after application failure", async () => {
		const harness = await openRelay({
			applicationApply: () => Promise.resolve({ status: "error" }),
		});
		expect(await code(harness.relay.receive(eventEnvelope()))).toBe("APPLICATION_FAILED");
		const state = await harness.incoming.query("incoming-1");
		expect(state.ok && state.value.state).toBe("pending");
		expect(await code(harness.relay.receive(eventEnvelope("incoming-2")))).toBe("POISONED");
		await harness.relay.close();
	});

	it("persists delivered evidence before a transport uncertainty", async () => {
		const harness = await openRelay({
			transportSend: () => Promise.reject(new Error("transport failed")),
		});
		expect(await code(harness.relay.receive(eventEnvelope()))).toBe("TRANSPORT_UNCERTAIN");
		const state = await harness.incoming.query("incoming-1");
		expect(state.ok && state.value.state).toBe("delivered");
		await harness.relay.close();
	});

	it("persists outgoing before send and marks it delivered before applying its ACK", async () => {
		let outgoing: DurableRelayStore;
		const harness = await openRelay({
			transportSend: async (raw) => {
				const envelope = (raw as { envelope: RemoteHostFrameEnvelope }).envelope;
				const state = await outgoing.query(envelope.frameId);
				expect(state.ok && state.value.state).toBe("pending");
				return { status: "sent" };
			},
			applicationApply: async (raw) => {
				const envelope = (raw as { envelope: RemoteHostFrameEnvelope }).envelope;
				if (envelope.frame.type === "ack") {
					const state = await outgoing.query(envelope.frame.acknowledges);
					expect(state.ok && state.value.state).toBe("delivered");
				}
				return { status: "applied" };
			},
		});
		outgoing = harness.outgoing;
		const outbound = eventEnvelope("outbound-1");
		expect((await harness.relay.send(outbound)).ok).toBe(true);
		const pending = await outgoing.query("outbound-1");
		expect(pending.ok && pending.value.state).toBe("pending");
		const received = await harness.relay.receive(ackEnvelope("outbound-1"));
		expect(received.ok && received.value.action).toBe("acknowledged_outbound");
		const delivered = await outgoing.query("outbound-1");
		expect(delivered.ok && delivered.value.state).toBe("delivered");
		await harness.relay.close();
	});

	it("does not reapply a delivered ACK frame", async () => {
		const harness = await openRelay();
		await harness.relay.send(eventEnvelope("outbound-1"));
		const ack = ackEnvelope("outbound-1");
		const first = await harness.relay.receive(ack);
		const duplicate = await harness.relay.receive(ack);
		expect(first.ok && first.value.action).toBe("acknowledged_outbound");
		expect(duplicate.ok && duplicate.value.action).toBe("replayed");
		expect(harness.applied).toHaveLength(1);
		await harness.relay.close();
	});

	it("replays pending outgoing frames in durable sequence order", async () => {
		const harness = await openRelay();
		await harness.relay.send(eventEnvelope("outbound-1"));
		await harness.relay.send(eventEnvelope("outbound-2"));
		const replayed = await harness.relay.replayOutgoing({ cursor: null, maxCount: 64 });
		expect(replayed).toEqual({ ok: true, value: { sent: 2, nextCursor: null } });
		expect(harness.sent.map((item) => item.frameId)).toEqual([
			"outbound-1",
			"outbound-2",
			"outbound-1",
			"outbound-2",
		]);
		await harness.relay.receive(ackEnvelope("outbound-1", "ack-1"));
		const afterAck = await harness.relay.replayOutgoing({ cursor: null, maxCount: 64 });
		expect(afterAck.ok && afterAck.value.sent).toBe(1);
		expect(harness.sent.at(-1)?.frameId).toBe("outbound-2");
		await harness.relay.close();
	});

	it("serializes receive operations through awaited application", async () => {
		const gate: { release: (() => void) | null } = { release: null };
		let calls = 0;
		const firstGate = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		const harness = await openRelay({
			applicationApply: async () => {
				calls += 1;
				if (calls === 1) await firstGate;
				return { status: "applied" };
			},
		});
		const first = harness.relay.receive(eventEnvelope("incoming-1"));
		await Promise.resolve();
		const second = harness.relay.receive(eventEnvelope("incoming-2"));
		await Promise.resolve();
		expect(calls).toBeLessThanOrEqual(1);
		gate.release?.();
		expect((await first).ok).toBe(true);
		expect((await second).ok).toBe(true);
		expect(calls).toBe(2);
		await harness.relay.close();
	});

	it("latches one close, drains accepted work, and closes all owners once", async () => {
		const harness = await openRelay();
		const accepted = harness.relay.receive(eventEnvelope());
		const first = harness.relay.close();
		expect(harness.relay.close()).toBe(first);
		expect(await code(harness.relay.receive(eventEnvelope("late")))).toBe("CLOSED");
		expect((await accepted).ok).toBe(true);
		expect((await first).ok).toBe(true);
		expect(harness.counts.journal).toBe(2);
		expect(harness.counts.marker).toBe(2);
		expect(harness.counts.recovery).toBe(2);
		expect(harness.counts.transport).toBe(1);
		expect(harness.counts.application).toBe(1);
	});

	it("closes every discovered owner on unrelated factory rejection", async () => {
		const counts = capCounts();
		const incoming = await openStore("received", counts);
		const outgoing = await openStore("sent", counts);
		const transport = {
			send: () => Promise.resolve({ status: "sent" }),
			close: () => {
				counts.transport += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const application = {
			apply: () => Promise.resolve({ status: "applied" }),
			close: () => {
				counts.application += 1;
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await createOrderedDurableRelay({
			identity: IDENTITY,
			incomingStore: incoming,
			outgoingStore: outgoing,
			transport,
			application,
			extra: true,
		});
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(counts.journal).toBe(2);
		expect(counts.transport).toBe(1);
		expect(counts.application).toBe(1);
	});

	it("rejects store aliases with one checked close", async () => {
		const counts = capCounts();
		const store = await openStore("received", counts);
		let transportCloses = 0;
		let applicationCloses = 0;
		const result = await createOrderedDurableRelay({
			identity: IDENTITY,
			incomingStore: store,
			outgoingStore: store,
			transport: {
				send: () => Promise.resolve({ status: "sent" }),
				close: () => {
					transportCloses += 1;
					return Promise.resolve({ status: "closed" });
				},
			},
			application: {
				apply: () => Promise.resolve({ status: "applied" }),
				close: () => {
					applicationCloses += 1;
					return Promise.resolve({ status: "closed" });
				},
			},
		});
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(counts.journal).toBe(1);
		expect(transportCloses).toBe(1);
		expect(applicationCloses).toBe(1);
	});
});
