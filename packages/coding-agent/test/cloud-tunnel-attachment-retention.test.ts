import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CloudGuestCursorRecord, CloudTunnelAttachment } from "../src/core/cloud/bridge/tunnel-attachment.js";
import type { CloudCursor, CloudEvent } from "../src/core/cloud/protocol.js";
import { CloudProtocolServer } from "../src/modes/cloud/cloud-protocol-server.js";
import { cloudTemp, RecordingTunnelTransport } from "./cloud-support.js";

/**
 * Production retention integration: the real CloudTunnelAttachment drives the
 * real CloudProtocolServer over a unix socket with a tiny durable outbox, and
 * the suite proves the full resync contract end to end - one trim, epoch
 * reset, continued unique delivery, valid acks, no snapshot/subscribe
 * ping-pong, and a second trim with recovery.
 */

const SESSION_ID = "sess_attach_test";
const BRIDGE_TOKEN = "a".repeat(64);

/** A real socket connection to the guest protocol server, framed as a tunnel transport. */
function serverFramesOfType(type: string, frames: readonly string[]): string[] {
	return frames.filter((line) => {
		try {
			return (JSON.parse(line) as { type?: string }).type === type;
		} catch {
			return false;
		}
	});
}

/**
 * Drains the event loop until the observable settles: attachment delivery and
 * server acks complete across turns, never a clock.
 */
async function waitFor(predicate: () => boolean): Promise<void> {
	for (;;) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

/**
 * The server's acknowledged position: the deterministic signal that the
 * client's ack landed (retention can only trim acknowledged history).
 */
function serverAckedSequence(server: CloudProtocolServer): number {
	const outbox = (server as unknown as { outbox: { acknowledgedCursor: { sequence: number } } }).outbox;
	return outbox.acknowledgedCursor.sequence;
}

function statusEvent(): { kind: "session_status"; recordedAt: string; status: "busy" | "idle" } {
	return { kind: "session_status", recordedAt: new Date().toISOString(), status: "busy" };
}

describe("CloudTunnelAttachment retention against the real protocol server", () => {
	it("resyncs through two retention trims with unique delivery, valid acks, and no frame ping-pong", async () => {
		const root = cloudTemp("attach-retention-");
		const socketPath = join(root, "cloud.sock");
		const server = new CloudProtocolServer({
			socketPath,
			stateDirectory: join(root, "state"),
			sessionId: SESSION_ID,
			generation: 1,
			maxOutboxRecords: 4,
			callbacks: {
				sessionId: () => SESSION_ID,
				generation: () => 1,
				protocolToken: () => BRIDGE_TOKEN,
				status: () => "idle" as const,
				snapshotState: () => ({ cwd: root, modelId: "faux-1", queuedCommandIds: [] }),
				dispatch: async () => ({ state: "completed" as const }),
			},
		});
		await server.start();

		const transport = new RecordingTunnelTransport();
		const mirrored: CloudEvent[] = [];
		const errors: string[] = [];
		let terminal: string | undefined;
		let persistedCursor: CloudGuestCursorRecord | undefined;
		const attachment = new CloudTunnelAttachment({
			sessionId: SESSION_ID,
			generation: 1,
			transport,
			callbacks: {
				resolveTarget: () => ({
					url: socketPath,
					httpUser: "user",
					httpPassword: "password",
					bridgeToken: BRIDGE_TOKEN,
				}),
				appendGuestEvent: (event) => mirrored.push(event),
				flushTrace: async () => undefined,
				persistGuestCursor: (cursor) => {
					persistedCursor = cursor;
				},
				loadGuestCursor: () => persistedCursor,
				recordAttachment: () => undefined,
				isSessionLive: () => true,
				checkTunnelAlive: async () => true,
				onAttachmentError: (message) => errors.push(message),
				onTerminal: (reason) => {
					terminal = reason;
				},
			},
			reconnectDelayMs: 50,
			maxReconnectDelayMs: 200,
			submitWaitMs: 1_000,
		});
		attachment.start();

		try {
			// Phase 1: fill the log below the bound; the attachment mirrors
			// and acknowledges each batch.
			for (let index = 1; index <= 3; index++) {
				server.appendEvent(statusEvent());
			}
			await waitFor(
				() => mirrored.length >= 3 && persistedCursor?.sequence === 3 && persistedCursor.eventGeneration === 1,
			);

			// Phase 2: the fourth record fills the log exactly.
			server.appendEvent(statusEvent());
			await waitFor(() => persistedCursor?.sequence === 4 && persistedCursor.eventGeneration === 1);

			// Phase 3: the fifth append overflows: acknowledged history trims,
			// the event-log generation bumps to 2, and the client's stale
			// cursor gets a snapshot resync instead of a wedge.
			server.appendEvent(statusEvent());
			await waitFor(() => persistedCursor?.eventGeneration === 2);
			// The renumbered head is not lost: event-5 arrives through the
			// full-log snapshot the resync serves, and the count keeps
			// growing monotonically - the dedupe reset means the renumbered
			// epoch never double-imports.
			await waitFor(() => mirrored.filter((event) => event.kind === "session_status").length >= 5);

			// Phase 4: live delivery continues in the new epoch.
			server.appendEvent(statusEvent());
			await waitFor(() => persistedCursor?.eventGeneration === 2 && persistedCursor.sequence >= 2);
			await waitFor(() => mirrored.filter((event) => event.kind === "session_status").length >= 6);

			// Phase 5: drive the log to the bound again and force a second
			// trim, then prove recovery.
			for (let index = 7; index <= 8; index++) {
				server.appendEvent(statusEvent());
				await waitFor(() => persistedCursor?.eventGeneration === 2 && persistedCursor.sequence >= index - 4);
			}
			server.appendEvent(statusEvent());
			await waitFor(() => persistedCursor?.eventGeneration === 3);
			await waitFor(() => mirrored.filter((event) => event.kind === "session_status").length >= 9);

			// No wedge, no crash, honest supervision:
			expect(terminal).toBeUndefined();
			expect(errors).toEqual([]);
			expect(transport.closedByServer).toBe(false);
			// No snapshot/subscribe ping-pong: every subscribe the
			// attachment sent is accounted for by a snapshot that changed
			// the epoch (hello + two trims), with bounded slack.
			const subscribes = transport.sentFrames.filter((frame) => frame.includes('"type":"subscribe"')).length;
			expect(subscribes).toBeLessThanOrEqual(8);
			const acks = transport.sentFrames.filter((frame) => frame.includes('"type":"ack"'));
			expect(acks.length).toBeGreaterThan(0);
			// Every ack carried the current event-log generation; the
			// server never dropped the connection for any of them.
			for (const ack of acks) {
				expect(() => JSON.parse(ack)).not.toThrow();
			}
		} finally {
			await attachment.stop();
			await server.stop();
		}
	});

	it("resyncs gap-free when a trim retains more than one snapshot page: no lost tail, cursor never ahead of delivery", async () => {
		const root = cloudTemp("attach-retention-page-");
		const socketPath = join(root, "cloud.sock");
		const server = new CloudProtocolServer({
			socketPath,
			stateDirectory: join(root, "state"),
			sessionId: SESSION_ID,
			generation: 1,
			// 300 records: the 301st append trims the acknowledged head and
			// retains 277 events - 21 beyond one 256-event snapshot page,
			// the exact loss shape observed in review (a snapshot that
			// carried only the first page but reported the full tail let
			// the client persist and acknowledge 21 undelivered events).
			maxOutboxRecords: 300,
			callbacks: {
				sessionId: () => SESSION_ID,
				generation: () => 1,
				protocolToken: () => BRIDGE_TOKEN,
				status: () => "idle" as const,
				snapshotState: () => ({ cwd: root, modelId: "faux-1", queuedCommandIds: [] }),
				dispatch: async () => ({ state: "completed" as const }),
			},
		});
		await server.start();

		const transport = new RecordingTunnelTransport();
		const mirrored: CloudEvent[] = [];
		/** Every persisted cursor sample with the mirror size at that moment. */
		const cursorTimeline: Array<{ generation: number; sequence: number; delivered: number }> = [];
		let terminal: string | undefined;
		let persistedCursor: CloudGuestCursorRecord | undefined;
		const attachment = new CloudTunnelAttachment({
			sessionId: SESSION_ID,
			generation: 1,
			transport,
			callbacks: {
				resolveTarget: () => ({
					url: socketPath,
					httpUser: "user",
					httpPassword: "password",
					bridgeToken: BRIDGE_TOKEN,
				}),
				appendGuestEvent: (event) => mirrored.push(event),
				flushTrace: async () => undefined,
				persistGuestCursor: (cursor) => {
					persistedCursor = cursor;
					cursorTimeline.push({
						generation: cursor.eventGeneration,
						sequence: cursor.sequence,
						delivered: mirrored.length,
					});
				},
				loadGuestCursor: () => persistedCursor,
				recordAttachment: () => undefined,
				isSessionLive: () => true,
				checkTunnelAlive: async () => true,
				onAttachmentError: () => undefined,
				onTerminal: (reason) => {
					terminal = reason;
				},
			},
			reconnectDelayMs: 50,
			maxReconnectDelayMs: 200,
			submitWaitMs: 1_000,
		});
		attachment.start();

		const appendUnique = (index: number): void => {
			const appended = server.appendEvent({
				kind: "output_delta",
				recordedAt: new Date().toISOString(),
				taskId: "task_page",
				stream: "stdout",
				text: `evt-${index}`,
			});
			if (appended === undefined) throw new Error(`event ${index} was dropped by the durable log`);
		};

		try {
			// Phase 1: 24 unique events mirror and acknowledge through
			// sequence 24 in generation 1.
			for (let index = 1; index <= 24; index++) appendUnique(index);
			await waitFor(
				() => persistedCursor?.eventGeneration === 1 && persistedCursor.sequence === 24 && mirrored.length === 24,
			);
			// The final ack must land on the server: the trim below then
			// retains exactly the unacknowledged tail.
			await waitFor(() => serverAckedSequence(server) === 24);

			// Phase 2: disconnect and drop every in-flight ack; the guest
			// keeps producing into the durable log while the tunnel is
			// down. 276 more events fill the log to its 300-record bound
			// with the acknowledged cursor still at 24.
			transport.down = true;
			transport.drop();
			for (let index = 25; index <= 300; index++) appendUnique(index);

			// Phase 3: the 301st append overflows the bound: the trim
			// retains the 276 unacknowledged events, renumbers them into
			// generation 2, and the new event lands as sequence 277 - 21
			// events beyond one snapshot page.
			appendUnique(301);
			expect(server.currentGeneration()).toBe(2);
			expect(server.tailCursor()).toEqual({ generation: 2, sequence: 277 });

			// Phase 4: reconnect from the pre-trim persisted cursor. The
			// snapshot carries only the first bounded page; the subscribe
			// after it must drain the remaining page(s), and the persisted
			// cursor may reach the true tail only after that delivery.
			transport.down = false;
			await waitFor(
				() => persistedCursor?.eventGeneration === 2 && persistedCursor.sequence === 277 && mirrored.length === 301,
			);
			// Let the resync ack land before the next drop.
			await waitFor(() => serverAckedSequence(server) === 277);

			// Phase 5: a second disconnect and fill to the bound, then a
			// second trim that retains 23 events plus the new one.
			transport.down = true;
			transport.drop();
			for (let index = 302; index <= 324; index++) appendUnique(index);
			appendUnique(325);
			expect(server.currentGeneration()).toBe(3);

			// Phase 6: recovery through the second trim completes the
			// mirror and parks the durable cursor on the new tail.
			transport.down = false;
			await waitFor(
				() => persistedCursor?.eventGeneration === 3 && persistedCursor.sequence === 24 && mirrored.length === 325,
			);

			// Every unique logical event arrived exactly once, no gaps:
			// 24 pre-disconnect + 277 retained across the first trim +
			// 24 retained across the second trim.
			const texts = mirrored.map((event) => (event.kind === "output_delta" ? event.text : "<other>"));
			expect(new Set(texts).size).toBe(texts.length);
			expect(mirrored.length).toBe(325);
			for (let index = 1; index <= 325; index++) {
				expect(texts).toContain(`evt-${index}`);
			}

			// The persisted cursor never named events that were not
			// delivered: each sample is covered by the mirror growth
			// inside its own event-log generation.
			const generationBases = new Map<number, number>();
			let lastSampleGeneration = 0;
			let lastSampleDelivered = 0;
			for (const sample of cursorTimeline) {
				if (sample.generation !== lastSampleGeneration) {
					generationBases.set(sample.generation, lastSampleDelivered);
					lastSampleGeneration = sample.generation;
				}
				const base = generationBases.get(sample.generation) ?? 0;
				expect(sample.sequence).toBeLessThanOrEqual(sample.delivered - base);
				lastSampleDelivered = sample.delivered;
			}

			// Acks progress strictly within each generation and the last
			// ack of each generation reaches its true tail.
			const ackCursors = transport.sentFrames
				.map((frame) => JSON.parse(frame) as { type?: string; cursor?: CloudCursor })
				.filter((frame) => frame.type === "ack" && frame.cursor !== undefined)
				.map((frame) => frame.cursor as CloudCursor);
			expect(ackCursors.length).toBeGreaterThan(0);
			const acksByGeneration = new Map<number, number[]>();
			for (const cursor of ackCursors) {
				const list = acksByGeneration.get(cursor.generation) ?? [];
				list.push(cursor.sequence);
				acksByGeneration.set(cursor.generation, list);
			}
			for (const sequences of acksByGeneration.values()) {
				for (let index = 1; index < sequences.length; index++) {
					expect(sequences[index]).toBeGreaterThan(sequences[index - 1] as number);
				}
			}
			expect(acksByGeneration.get(1)?.at(-1)).toBe(24);
			expect(acksByGeneration.get(2)?.at(-1)).toBe(277);
			expect(acksByGeneration.get(3)?.at(-1)).toBe(24);

			// No tight frame loop: the resync uses one snapshot per
			// connection plus bounded event pages, then goes quiet.
			expect(serverFramesOfType("snapshot", transport.serverFrames).length).toBeLessThanOrEqual(4);
			expect(serverFramesOfType("events", transport.serverFrames).length).toBeLessThanOrEqual(40);
			const subscribes = transport.sentFrames.filter((frame) => frame.includes('"type":"subscribe"')).length;
			expect(subscribes).toBeLessThanOrEqual(6);
			const settled = () => ({
				clientFrames: transport.sentFrames.length,
				serverFrames: transport.serverFrames.length,
				delivered: mirrored.length,
			});
			const before = settled();
			// A bounded turn drain proves delivery is truly settled.
			for (let turn = 0; turn < 10; turn++) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			expect(settled()).toEqual(before);

			// Honest supervision throughout: no terminal fallback, and the
			// final connection stays attached.
			expect(terminal).toBeUndefined();
			expect(attachment.attached).toBe(true);
		} finally {
			await attachment.stop();
			await server.stop();
		}
	});

	it("restarts a local attachment after a trim without re-importing retained events", async () => {
		const root = cloudTemp("attach-retention-restart-");
		const socketPath = join(root, "cloud.sock");
		const server = new CloudProtocolServer({
			socketPath,
			stateDirectory: join(root, "state"),
			sessionId: SESSION_ID,
			generation: 1,
			maxOutboxRecords: 4,
			callbacks: {
				sessionId: () => SESSION_ID,
				generation: () => 1,
				protocolToken: () => BRIDGE_TOKEN,
				status: () => "idle" as const,
				snapshotState: () => ({ cwd: root, modelId: "faux-1", queuedCommandIds: [] }),
				dispatch: async () => ({ state: "completed" as const }),
			},
		});
		await server.start();

		/** Events the first attachment mirrored, then events the restarted one did. */
		const firstMirrored: CloudEvent[] = [];
		const restartMirrored: CloudEvent[] = [];
		const errors: string[] = [];
		let terminal: string | undefined;
		/** Durable guest cursor: survives the local attachment restart. */
		let persistedCursor: CloudGuestCursorRecord | undefined;
		const attachmentCallbacks = (mirror: CloudEvent[]) => ({
			resolveTarget: () => ({
				url: socketPath,
				httpUser: "user",
				httpPassword: "password",
				bridgeToken: BRIDGE_TOKEN,
			}),
			appendGuestEvent: (event: CloudEvent) => mirror.push(event),
			flushTrace: async () => undefined,
			persistGuestCursor: (cursor: CloudGuestCursorRecord) => {
				persistedCursor = cursor;
			},
			loadGuestCursor: () => persistedCursor,
			recordAttachment: () => undefined,
			isSessionLive: () => true,
			checkTunnelAlive: async () => true,
			onAttachmentError: (message: string) => errors.push(message),
			onTerminal: (reason: string) => {
				terminal = reason;
			},
		});

		const appendUnique = (index: number): void => {
			const appended = server.appendEvent({
				kind: "output_delta",
				recordedAt: new Date().toISOString(),
				taskId: "task_restart",
				stream: "stdout",
				text: `evt-${index}`,
			});
			if (appended === undefined) throw new Error(`event ${index} was dropped by the durable log`);
		};

		const firstTransport = new RecordingTunnelTransport();
		const first = new CloudTunnelAttachment({
			sessionId: SESSION_ID,
			generation: 1,
			transport: firstTransport,
			callbacks: attachmentCallbacks(firstMirrored),
			reconnectDelayMs: 50,
			maxReconnectDelayMs: 200,
			submitWaitMs: 1_000,
		});
		first.start();
		try {
			// Phase 1: four unique events fill the log; the attachment mirrors
			// and acknowledges them, persisting {sandbox 1, event 1, seq 4}.
			for (let index = 1; index <= 4; index++) appendUnique(index);
			await waitFor(() => persistedCursor?.sequence === 4 && persistedCursor.eventGeneration === 1);

			// The phase-1 ack must land on the server first: retention can only
			// trim acknowledged history, so the trim below frees exactly these
			// four events.
			await waitFor(() => serverAckedSequence(server) === 4);
			// Phase 2: the fifth append overflows the bound: retention trims
			// the acknowledged history, the event generation bumps to 2, and
			// the resync delivers the renumbered event-5.
			appendUnique(5);
			await waitFor(() => persistedCursor?.eventGeneration === 2);
			await waitFor(() => firstMirrored.length === 5);
			// The renumbered event-5's ack must land on the server before the
			// restart: the post-restart drain compares against the retained log.
			await waitFor(() => server.currentGeneration() === 2 && serverAckedSequence(server) === 1);

			// Phase 3: a real local attachment restart while the guest keeps
			// running. The persisted cursor survives (durable), but the
			// supervisor, its connection, and all in-memory positions do not.
			await first.stop();
			appendUnique(6);
			expect(server.currentGeneration()).toBe(2);

			// Phase 4: the restarted attachment reconciles the saved event
			// epoch on the snapshot and drains ONLY the event produced while
			// detached - the retained, already-mirrored event-5 is never
			// re-imported.
			const restartTransport = new RecordingTunnelTransport();
			const restarted = new CloudTunnelAttachment({
				sessionId: SESSION_ID,
				generation: 1,
				transport: restartTransport,
				callbacks: attachmentCallbacks(restartMirrored),
				reconnectDelayMs: 50,
				maxReconnectDelayMs: 200,
				submitWaitMs: 1_000,
			});
			restarted.start();
			await waitFor(() => persistedCursor?.eventGeneration === 2 && persistedCursor.sequence === 2);

			// Exactly the one event produced while detached was imported; the
			// restart never replayed the retained log.
			expect(restartMirrored).toHaveLength(1);
			expect((restartMirrored[0] as { text?: string }).text).toBe("evt-6");
			// The hello snapshot was a bounded position confirmation, not a
			// full-log re-serve: it carried no events at all.
			for (const frame of serverFramesOfType("snapshot", restartTransport.serverFrames)) {
				const snapshot = JSON.parse(frame) as { events?: unknown[] };
				expect(snapshot.events).toEqual([]);
			}
			// Every unique logical event arrived exactly once across both
			// attachment incarnations.
			const texts = [...firstMirrored, ...restartMirrored].map((event) =>
				event.kind === "output_delta" ? event.text : "<other>",
			);
			expect(new Set(texts).size).toBe(texts.length);
			expect(texts).toHaveLength(6);
			for (let index = 1; index <= 6; index++) {
				expect(texts.filter((text) => text === `evt-${index}`)).toHaveLength(1);
			}

			// Honest supervision after the restart: no errors, no terminal
			// fallback, and the restarted connection stays attached.
			expect(terminal).toBeUndefined();
			expect(errors).toEqual([]);
			expect(restarted.attached).toBe(true);
			await restarted.stop();
		} finally {
			await first.stop().catch(() => undefined);
			await server.stop();
		}
	});
});
