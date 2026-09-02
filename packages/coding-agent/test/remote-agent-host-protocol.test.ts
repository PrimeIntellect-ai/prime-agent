/**
 * Unit tests for the remote-agent-host protocol and journal primitives.
 *
 * Covers: validation, ordering, replay, duplicate IDs, and incompatible
 * versions and build identities.
 */

import { describe, expect, it } from "vitest";
import type {
	RemoteHostBuildIdentity,
	RemoteHostCapability,
	RemoteHostEventCursor,
	RemoteHostFrameEnvelope,
	RemoteHostHandshakeFrame,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import {
	intersectRemoteHostCapabilities,
	isRemoteHostBuildCompatible,
	isRemoteHostEventSequenceAfter,
	isRemoteHostEventSequenceBefore,
	isRemoteHostEventSequenceGap,
	isRemoteHostProtocolCompatible,
	REMOTE_HOST_PROTOCOL_INFO,
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
	validateRemoteHostFrame,
	validateRemoteHostHandshake,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { InMemoryRemoteHostJournal } from "../src/modes/daemon/remote-host-journal.js";

const TEST_BUILD: RemoteHostBuildIdentity = {
	buildId: "build-abc",
	daemonProtocolVersion: 7,
	daemonSchemaRevision: 25,
};

function buildHandshake(overrides?: Partial<RemoteHostHandshakeFrame>): RemoteHostHandshakeFrame {
	return {
		type: "handshake",
		direction: "home_to_host",
		hostId: "sandbox-1",
		generation: "gen-abc123",
		capabilities: ["session_commands", "sequenced_events"],
		runtime: TEST_BUILD,
		protocol: REMOTE_HOST_PROTOCOL_INFO,
		...overrides,
	};
}

function j(opts: { hostId: string; generation: string }): InMemoryRemoteHostJournal {
	return new InMemoryRemoteHostJournal(opts);
}

describe("remote host protocol versioning", () => {
	it("has the correct protocol identity constants", () => {
		expect(REMOTE_HOST_PROTOCOL_NAME).toBe("prime-agent.remote-host");
		expect(REMOTE_HOST_PROTOCOL_VERSION).toBe(1);
		expect(REMOTE_HOST_PROTOCOL_INFO).toEqual({
			name: "prime-agent.remote-host",
			version: 1,
		});
	});

	it("rejects incompatible protocol names", () => {
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, { name: "prime-agent.daemon" as never, version: 1 }),
		).toBe(false);
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, { name: "prime-agent.remote-host", version: 1 }),
		).toBe(true);
	});

	it("rejects mismatched protocol versions", () => {
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, {
				name: "prime-agent.remote-host",
				version: 0 as never,
			}),
		).toBe(false);
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, {
				name: "prime-agent.remote-host",
				version: 2 as never,
			}),
		).toBe(false);
		expect(
			isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, { name: "prime-agent.remote-host", version: 1 }),
		).toBe(true);
	});

	it("rejects mismatched build identities across all three dimensions", () => {
		const local: RemoteHostBuildIdentity = TEST_BUILD;
		expect(isRemoteHostBuildCompatible(local, { ...local })).toBe(true);

		// Mismatched buildId
		expect(isRemoteHostBuildCompatible(local, { ...local, buildId: "build-xyz" })).toBe(false);

		// Mismatched daemonProtocolVersion
		expect(isRemoteHostBuildCompatible(local, { ...local, daemonProtocolVersion: 8 })).toBe(false);

		// Mismatched daemonSchemaRevision
		expect(isRemoteHostBuildCompatible(local, { ...local, daemonSchemaRevision: 26 })).toBe(false);

		// All three match
		expect(
			isRemoteHostBuildCompatible(
				{ buildId: "b1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
				{ buildId: "b1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
			),
		).toBe(true);
	});

	it("computes capability intersection correctly", () => {
		const home: RemoteHostCapability[] = ["session_commands", "sequenced_events", "provider_proxy", "link_health"];
		const host: RemoteHostCapability[] = ["session_commands", "sequenced_events", "checkpoint"];
		expect(intersectRemoteHostCapabilities(home, host)).toEqual(["session_commands", "sequenced_events"]);

		expect(intersectRemoteHostCapabilities(["checkpoint"], ["link_health"])).toEqual([]);
		expect(intersectRemoteHostCapabilities(["session_commands"], ["session_commands"])).toEqual(["session_commands"]);
	});
});

describe("remote host frame validation", () => {
	it("validates a well-formed frame envelope", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "frame-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("rejects non-object frames", () => {
		expect(validateRemoteHostFrame(null)).toEqual({
			code: "NOT_AN_OBJECT",
			message: "Frame must be a non-null object",
		});
		expect(validateRemoteHostFrame("hello")).toEqual({
			code: "NOT_AN_OBJECT",
			message: "Frame must be a non-null object",
		});
	});

	it("rejects wrong envelope type", () => {
		const frame = {
			type: "not_frame",
			frameId: "f-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health" },
		};
		expect(validateRemoteHostFrame(frame)).toMatchObject({ code: "INVALID_ENVELOPE_TYPE" });
	});

	it("rejects missing or empty frameId", () => {
		const base = {
			type: "frame" as const,
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "health" as const, healthSeq: 1, status: "connected" as const },
		};
		expect(validateRemoteHostFrame({ ...base, frameId: "" })).toMatchObject({ code: "MISSING_FRAME_ID" });
		expect(validateRemoteHostFrame({ ...base, frameId: 7 })).toMatchObject({ code: "MISSING_FRAME_ID" });
	});

	it("rejects missing protocol", () => {
		const frame = { type: "frame", frameId: "f-1", sentAt: "now", frame: { type: "health" } };
		expect(validateRemoteHostFrame(frame)).toMatchObject({ code: "MISSING_PROTOCOL" });
	});

	it("rejects wrong protocol name", () => {
		const frame = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "wrong", version: 1 },
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		expect(validateRemoteHostFrame(frame)).toMatchObject({ code: "UNKNOWN_PROTOCOL" });
	});

	it("accepts all known frame types", () => {
		const knownTypes = [
			buildHandshake(),
			{
				type: "handshake_ack",
				hostId: "h",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				accepted: true,
				capabilities: [],
				linkId: "l",
			},
			{ type: "command", commandId: "c-1", body: { type: "abort" } },
			{
				type: "event",
				id: "e-1",
				sequence: 1,
				cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
			{ type: "ack", ackId: "a-1", acknowledges: "f-1", status: "delivered" },
			{ type: "agent_message", id: "am-1", fromActiveSessionId: "a", targetActiveSessionId: "b", message: "hello" },
			{
				type: "provider_proxy",
				proxyType: "model_call_request",
				callId: "c-1",
				provider: "test",
				model: "test",
				messages: [],
			},
			{ type: "health", healthSeq: 1, status: "connected" },
			{ type: "error", code: "E", message: "err" },
		];
		for (const frameBody of knownTypes) {
			const envelope: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId: `f-${(frameBody as Record<string, unknown>).type as string}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "2026-01-01T00:00:00.000Z",
				frame: frameBody as never,
			};
			expect(validateRemoteHostFrame(envelope)).toBeUndefined();
		}
	});
});

describe("remote host handshake validation", () => {
	it("validates a well-formed handshake", () => {
		expect(validateRemoteHostHandshake(buildHandshake())).toBeUndefined();
	});

	it("rejects missing runtime/buildId", () => {
		const h: Record<string, unknown> = { ...buildHandshake() };
		delete h.runtime;
		expect(validateRemoteHostHandshake(h as unknown as RemoteHostHandshakeFrame)).toMatchObject({
			code: "MISSING_RUNTIME",
		});

		const h2 = buildHandshake({ runtime: { ...TEST_BUILD, buildId: "" } });
		expect(validateRemoteHostHandshake(h2)).toMatchObject({ code: "MISSING_BUILD_ID" });
	});

	it("rejects handshake with missing daemonProtocolVersion", () => {
		const { daemonProtocolVersion: _, ...partial } = TEST_BUILD;
		const h = buildHandshake({ runtime: partial as RemoteHostBuildIdentity });
		expect(validateRemoteHostHandshake(h)).toMatchObject({ code: "MISSING_DAEMON_PROTOCOL_VERSION" });
	});

	it("rejects handshake with missing daemonSchemaRevision", () => {
		const { daemonSchemaRevision: _, ...partial } = TEST_BUILD;
		const h = buildHandshake({ runtime: partial as RemoteHostBuildIdentity });
		expect(validateRemoteHostHandshake(h)).toMatchObject({ code: "MISSING_DAEMON_SCHEMA_REVISION" });
	});

	it("rejects non-object handshake", () => {
		expect(validateRemoteHostHandshake(null)).toMatchObject({ code: "NOT_AN_OBJECT" });
	});

	it("rejects wrong type", () => {
		expect(
			validateRemoteHostHandshake({ type: "handshake_ack" } as unknown as RemoteHostHandshakeFrame),
		).toMatchObject({ code: "INVALID_TYPE" });
	});

	it("rejects invalid direction", () => {
		expect(validateRemoteHostHandshake(buildHandshake({ direction: "upstream" as never }))).toMatchObject({
			code: "INVALID_DIRECTION",
		});
	});

	it("rejects missing hostId", () => {
		const h: Record<string, unknown> = { ...buildHandshake() };
		delete h.hostId;
		expect(validateRemoteHostHandshake(h as unknown as RemoteHostHandshakeFrame)).toMatchObject({
			code: "MISSING_HOST_ID",
		});
	});

	it("rejects missing generation", () => {
		const h: Record<string, unknown> = { ...buildHandshake() };
		delete h.generation;
		expect(validateRemoteHostHandshake(h as unknown as RemoteHostHandshakeFrame)).toMatchObject({
			code: "MISSING_GENERATION",
		});
	});

	it("rejects missing capabilities", () => {
		const h: Record<string, unknown> = { ...buildHandshake() };
		delete h.capabilities;
		expect(validateRemoteHostHandshake(h as unknown as RemoteHostHandshakeFrame)).toMatchObject({
			code: "MISSING_CAPABILITIES",
		});
	});
});

describe("sequence ordering", () => {
	it("detects sequence ordering correctly", () => {
		expect(isRemoteHostEventSequenceAfter(5, 3)).toBe(true);
		expect(isRemoteHostEventSequenceAfter(3, 5)).toBe(false);
		expect(isRemoteHostEventSequenceAfter(5, 5)).toBe(false);
		expect(isRemoteHostEventSequenceBefore(3, 5)).toBe(true);
		expect(isRemoteHostEventSequenceBefore(5, 3)).toBe(false);
		expect(isRemoteHostEventSequenceBefore(5, 5)).toBe(false);
	});

	it("detects sequence gaps", () => {
		expect(isRemoteHostEventSequenceGap(3, 5)).toBe(true);
		expect(isRemoteHostEventSequenceGap(3, 4)).toBe(false);
		expect(isRemoteHostEventSequenceGap(3, 3)).toBe(false);
		expect(isRemoteHostEventSequenceGap(0, 2)).toBe(true);
		expect(isRemoteHostEventSequenceGap(0, 1)).toBe(false);
	});
});

describe("remote host journal", () => {
	it("records sent and received frames", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });

		const sentFrame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "f-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		const sentEntry = journal.recordSent(sentFrame);
		expect(sentEntry.journalSeq).toBe(1);
		expect(sentEntry.type).toBe("sent");
		expect(sentEntry.frameId).toBe("f-1");
		expect(sentEntry.hostId).toBe("sandbox-1");
		expect(sentEntry.generation).toBe("gen-1");

		const receivedFrame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "f-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: { type: "health", healthSeq: 2, status: "connected" },
		};
		const receivedResult = journal.recordReceived(receivedFrame);
		expect(receivedResult.entry.journalSeq).toBe(2);
		expect(receivedResult.entry.type).toBe("received");
		expect(receivedResult.isDuplicate).toBe(false);
		expect(journal.dedupCount).toBe(1);
	});

	it("detects duplicate frame IDs and does not advance state", () => {
		const journal = j({ hostId: "s", generation: "s" });

		journal.recordReceived({
			type: "frame",
			frameId: "evt-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: {
				type: "event",
				id: "evt-1",
				sequence: 1,
				cursor: { hostId: "s", generation: "s", sessionId: "sess", sequence: 1 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(journal.lastReceivedEventSequence).toBe(1);
		expect(journal.dedupCount).toBe(1);

		const result = journal.recordReceived({
			type: "frame",
			frameId: "evt-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: {
				type: "event",
				id: "evt-1",
				sequence: 5,
				cursor: { hostId: "s", generation: "s", sessionId: "sess", sequence: 5 },
				emittedAt: "now",
				body: { type: "agent_end", messages: 3 },
			},
		});
		expect(result.isDuplicate).toBe(true);
		expect(journal.lastReceivedEventSequence).toBe(1);
		expect(journal.dedupCount).toBe(1);
	});

	it("reports duplicate check without recording", () => {
		const journal = j({ hostId: "s", generation: "s" });
		expect(journal.isDuplicate("not-yet-seen")).toBe(false);

		journal.recordReceived({
			type: "frame",
			frameId: "f-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});
		expect(journal.isDuplicate("f-1")).toBe(true);
		expect(journal.isDuplicate("f-2")).toBe(false);
	});

	it("reads back recorded entries in sequence order", () => {
		const journal = j({ hostId: "s", generation: "g" });

		for (let i = 1; i <= 5; i++) {
			journal.recordSent({
				type: "frame",
				frameId: `f-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: { type: "health", healthSeq: i, status: "connected" },
			});
		}

		const entries = journal.readEntries(1);
		expect(entries).toHaveLength(5);
		expect(entries[0].frameId).toBe("f-1");
		expect(entries[4].frameId).toBe("f-5");

		const later = journal.readEntries(3);
		expect(later).toHaveLength(3);
		expect(later[0].frameId).toBe("f-3");
	});

	it("tracks last event sequences for sent and received events", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordSent({
			type: "frame",
			frameId: "evt-s-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: {
				type: "event",
				id: "evt-s-1",
				sequence: 1,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		expect(journal.lastSentEventSequence).toBe(1);

		journal.recordReceived({
			type: "frame",
			frameId: "evt-r-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: {
				type: "event",
				id: "evt-r-1",
				sequence: 2,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 2 },
				emittedAt: "now",
				body: { type: "agent_end", messages: 5 },
			},
		});
		expect(journal.lastReceivedEventSequence).toBe(2);
		expect(journal.lastSentEventSequence).toBe(1);
	});
});

describe("replay directional (sent vs received)", () => {
	it("returns complete replay when cursor is current", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });
		const cursor: RemoteHostEventCursor = {
			hostId: "sandbox-1",
			generation: "gen-1",
			sessionId: "sess-1",
			sequence: 5,
		};
		expect(journal.getReplayEntries(cursor)).toMatchObject({ status: "complete", entries: [] });
	});

	it("reports hostId mismatch as unavailable", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });
		const cursor: RemoteHostEventCursor = {
			hostId: "sandbox-2",
			generation: "sandbox-2",
			sessionId: "sess-1",
			sequence: 1,
		};
		expect(journal.getReplayEntries(cursor)).toMatchObject({
			status: "unavailable",
			reason: "host_identity_mismatch",
		});
	});
	it("reports hostId mismatch even when generation happens to match", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });
		const cursor: RemoteHostEventCursor = {
			hostId: "sandbox-2",
			generation: "gen-1",
			sessionId: "sess-1",
			sequence: 1,
		};
		expect(journal.getReplayEntries(cursor)).toMatchObject({
			status: "unavailable",
			reason: "host_identity_mismatch",
		});
	});

	it("reports generation mismatch as unavailable even when hostId matches", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });
		const cursor: RemoteHostEventCursor = {
			hostId: "sandbox-1",
			generation: "different-gen",
			sessionId: "sess-1",
			sequence: 1,
		};
		expect(journal.getReplayEntries(cursor)).toMatchObject({ status: "unavailable", reason: "generation_changed" });
	});

	it("reports BOTH hostId and generation mismatch as host_identity_mismatch", () => {
		const journal = j({ hostId: "sandbox-1", generation: "gen-1" });
		const cursor: RemoteHostEventCursor = {
			hostId: "other-host",
			generation: "other-gen",
			sessionId: "sess-1",
			sequence: 1,
		};
		expect(journal.getReplayEntries(cursor)).toMatchObject({
			status: "unavailable",
			reason: "host_identity_mismatch",
		});
	});

	it("returns sent events after the resume cursor with default direction=sent", () => {
		const journal = j({ hostId: "s", generation: "g" });

		for (let i = 1; i <= 5; i++) {
			journal.recordSent({
				type: "frame",
				frameId: `evt-${i}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
				frame: {
					type: "event",
					id: `evt-${i}`,
					sequence: i,
					cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: i },
					emittedAt: `2026-01-01T00:00:00.${String(i).padStart(3, "0")}Z`,
					body: { type: "agent_start" },
				},
			});
		}

		const cursor: RemoteHostEventCursor = { hostId: "s", generation: "g", sessionId: "sess", sequence: 2 };
		const result = journal.getReplayEntries(cursor);
		expect(result.status).toBe("complete");
		expect(result.entries).toHaveLength(3);
		expect(result.entries[0].eventSequence).toBe(3);
		expect(result.entries[1].eventSequence).toBe(4);
		expect(result.entries[2].eventSequence).toBe(5);
	});

	it("filters received events out of sent-direction replay", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordSent({
			type: "frame",
			frameId: "evt-s-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "evt-s-1",
				sequence: 1,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		journal.recordReceived({
			type: "frame",
			frameId: "evt-r-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "evt-r-2",
				sequence: 2,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 2 },
				emittedAt: "now",
				body: { type: "agent_end", messages: 3 },
			},
		});

		// Sent direction: should NOT include the received event (seq 2)
		const cursor: RemoteHostEventCursor = { hostId: "s", generation: "g", sessionId: "sess", sequence: 0 };
		const sentResult = journal.getReplayEntries(cursor, 500, "sent");
		expect(sentResult.entries).toHaveLength(1);
		expect(sentResult.entries[0].type).toBe("sent");

		// Received direction: should NOT include the sent event (seq 1)
		const recvResult = journal.getReplayEntries(cursor, 500, "received");
		expect(recvResult.entries).toHaveLength(1);
		expect(recvResult.entries[0].type).toBe("received");

		// Both direction: should include both
		const bothResult = journal.getReplayEntries(cursor, 500, "both");
		expect(bothResult.entries).toHaveLength(2);
	});

	it("reports partial replay when sent events have gaps (direction=sent)", () => {
		const journal = j({ hostId: "s", generation: "g" });

		for (const seq of [1, 2, 4]) {
			journal.recordSent({
				type: "frame",
				frameId: `evt-${seq}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: new Date().toISOString(),
				frame: {
					type: "event",
					id: `evt-${seq}`,
					sequence: seq,
					cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: seq },
					emittedAt: new Date().toISOString(),
					body: { type: "agent_start" },
				},
			});
		}

		const cursor: RemoteHostEventCursor = { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 };
		const result = journal.getReplayEntries(cursor, 500, "sent");
		expect(result.status).toBe("partial");
		expect(result.reason).toBe("event_sequence_gap");
	});

	it("sent-direction replay does not break when received events fill the gap", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordSent({
			type: "frame",
			frameId: "s-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "s-1",
				sequence: 1,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});
		// Received event at seq 2 (does not fill sent gap at seq 3)
		journal.recordReceived({
			type: "frame",
			frameId: "r-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "r-2",
				sequence: 2,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 2 },
				emittedAt: "now",
				body: { type: "agent_end", messages: 1 },
			},
		});
		// Sent event at seq 4 (gap in sent: seq 3 missing)
		journal.recordSent({
			type: "frame",
			frameId: "s-4",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "event",
				id: "s-4",
				sequence: 4,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 4 },
				emittedAt: "now",
				body: { type: "agent_start" },
			},
		});

		const cursor: RemoteHostEventCursor = { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 };
		const sentResult = journal.getReplayEntries(cursor, 500, "sent");
		expect(sentResult.status).toBe("partial");
		expect(sentResult.reason).toBe("event_sequence_gap");

		const recvResult = journal.getReplayEntries(cursor, 500, "received");
		expect(recvResult.status).toBe("complete");
		expect(recvResult.entries).toHaveLength(1);
	});

	it("filters replay to sent frames only via getReplaySentFrames", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordSent({
			type: "frame",
			frameId: "evt-s-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: {
				type: "event",
				id: "evt-s-1",
				sequence: 1,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 1 },
				emittedAt: "2026-01-01T00:00:00.000Z",
				body: { type: "agent_start" },
			},
		});

		journal.recordReceived({
			type: "frame",
			frameId: "evt-r-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: {
				type: "event",
				id: "evt-r-1",
				sequence: 100,
				cursor: { hostId: "s", generation: "g", sessionId: "sess", sequence: 100 },
				emittedAt: "2026-01-01T00:00:00.001Z",
				body: { type: "agent_end", messages: 3 },
			},
		});

		const cursor: RemoteHostEventCursor = { hostId: "s", generation: "g", sessionId: "sess", sequence: 0 };
		const result = journal.getReplaySentFrames(cursor);
		expect(result.frames).toHaveLength(1);
		expect(result.frames[0].type).toBe("event");
		if (result.frames[0].type === "event") {
			expect(result.frames[0].sequence).toBe(1);
		}
	});
});

describe("journal dedup and replay integration", () => {
	it("handles duplicate IDs gracefully across journal operations", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordReceived({
			type: "frame",
			frameId: "h-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});
		expect(journal.dedupCount).toBe(1);

		const duplicate = journal.recordReceived({
			type: "frame",
			frameId: "h-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});
		expect(duplicate.isDuplicate).toBe(true);
		expect(journal.dedupCount).toBe(1);

		const entries = journal.readEntries(1);
		expect(entries).toHaveLength(2);
	});

	it("resets correctly for a fresh connection", () => {
		const journal = j({ hostId: "s", generation: "g" });

		journal.recordReceived({
			type: "frame",
			frameId: "f-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: new Date().toISOString(),
			frame: { type: "health", healthSeq: 1, status: "connected" },
		});
		expect(journal.dedupCount).toBe(1);

		journal.reset();
		expect(journal.dedupCount).toBe(0);
		expect(journal.lastReceivedEventSequence).toBe(0);
		expect(journal.lastSentEventSequence).toBe(0);
		expect(journal.readEntries(1)).toHaveLength(0);
	});
});

describe("incompatible versions", () => {
	it("rejects frames with wrong protocol name at envelope validation", () => {
		const frame: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.daemon", version: 1 },
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		expect(validateRemoteHostFrame(frame)).toMatchObject({ code: "UNKNOWN_PROTOCOL" });
	});

	it("rejects mismatched buildId, daemonProtocolVersion, and daemonSchemaRevision", () => {
		const local: RemoteHostBuildIdentity = TEST_BUILD;
		const mismatchedBuild: RemoteHostBuildIdentity = { ...local, buildId: "other" };
		const mismatchedProtocol: RemoteHostBuildIdentity = { ...local, daemonProtocolVersion: 6 };
		const mismatchedSchema: RemoteHostBuildIdentity = { ...local, daemonSchemaRevision: 99 };

		expect(isRemoteHostBuildCompatible(local, mismatchedBuild)).toBe(false);
		expect(isRemoteHostBuildCompatible(local, mismatchedProtocol)).toBe(false);
		expect(isRemoteHostBuildCompatible(local, mismatchedSchema)).toBe(false);
	});

	it("rejects frames with missing or invalid protocol version field", () => {
		const frameNoVersion: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host" },
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		expect(validateRemoteHostFrame(frameNoVersion)).toMatchObject({ code: "INVALID_PROTOCOL_VERSION" });

		const frameStrVersion: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: "v1" },
			sentAt: "now",
			frame: { type: "health", healthSeq: 1, status: "connected" },
		};
		expect(validateRemoteHostFrame(frameStrVersion)).toMatchObject({ code: "INVALID_PROTOCOL_VERSION" });
	});
});

describe("link health with closed state union", () => {
	it("accepts all link status values", () => {
		const statuses = ["connecting", "connected", "reconnecting", "unreachable", "closed"] as const;
		for (const status of statuses) {
			const frame: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId: `health-${status}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "2026-01-01T00:00:00.000Z",
				frame: { type: "health", healthSeq: 1, status },
			};
			expect(validateRemoteHostFrame(frame)).toBeUndefined();
		}
	});
});

describe("acknowledgements", () => {
	it("creates ack frames with all status values", () => {
		for (const status of ["delivered", "replayed", "rejected"] as const) {
			const frame: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId: `ack-${status}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: {
					type: "ack",
					ackId: `ack-${status}`,
					acknowledges: "evt-42",
					status,
					rejectReason: status === "rejected" ? "bad" : undefined,
				},
			};
			expect(validateRemoteHostFrame(frame)).toBeUndefined();
		}
	});
});

describe("agent messages", () => {
	it("creates agent message frames that pass validation", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "msg-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: {
				type: "agent_message",
				id: "msg-1",
				fromActiveSessionId: "session-a",
				targetActiveSessionId: "session-b",
				message: "hello",
				deliveryMode: "direct",
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});
});

describe("provider proxy frames with JsonValue", () => {
	it("creates model call request frames that pass validation", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "proxy-1",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.000Z",
			frame: {
				type: "provider_proxy",
				proxyType: "model_call_request",
				callId: "call-1",
				provider: "anthropic",
				model: "claude-sonnet-4",
				messages: [{ role: "user", content: "hello" }],
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("creates model call chunk frames that pass validation", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "proxy-2",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.001Z",
			frame: {
				type: "provider_proxy",
				proxyType: "model_call_chunk",
				callId: "call-1",
				index: 0,
				delta: { type: "text", text: "Hello" },
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("creates model call complete frames that pass validation", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "proxy-3",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "2026-01-01T00:00:00.002Z",
			frame: {
				type: "provider_proxy",
				proxyType: "model_call_complete",
				callId: "call-1",
				result: { content: "final answer" },
				usage: { inputTokens: 50, outputTokens: 100 },
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("creates model call error and cancel frames that pass validation", () => {
		const errFrame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "proxy-4",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "provider_proxy",
				proxyType: "model_call_error",
				callId: "call-1",
				error: "rate limit exceeded",
			},
		};
		expect(validateRemoteHostFrame(errFrame)).toBeUndefined();

		const cancelFrame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "proxy-5",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "provider_proxy", proxyType: "model_call_cancel", callId: "call-1" },
		};
		expect(validateRemoteHostFrame(cancelFrame)).toBeUndefined();
	});
});

describe("command frames with opaque references", () => {
	it("creates create_session with workspaceId", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "c-create",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: { type: "command", commandId: "c-create", body: { type: "create_session", workspaceId: "ws-abc-123" } },
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("creates sync_workspace with artifact reference", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "c-sync",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "command",
				commandId: "c-sync",
				body: { type: "sync_workspace", artifact: { workspaceId: "ws-1", changesetId: "cs-2" } },
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});

	it("creates all command types that pass envelope validation", () => {
		const commands: RemoteHostFrameEnvelope[] = [
			{
				type: "frame",
				frameId: "c-1",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-1", body: { type: "create_session", workspaceId: "ws-1" } },
			},
			{
				type: "frame",
				frameId: "c-2",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-2", body: { type: "destroy_session" } },
			},
			{
				type: "frame",
				frameId: "c-3",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-3", body: { type: "prompt", message: "do x" } },
			},
			{
				type: "frame",
				frameId: "c-4",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-4", body: { type: "abort" } },
			},
			{
				type: "frame",
				frameId: "c-5",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-5", body: { type: "execute_bash", command: "ls" } },
			},
			{
				type: "frame",
				frameId: "c-6",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-6", body: { type: "compact" } },
			},
			{
				type: "frame",
				frameId: "c-7",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-7", body: { type: "checkpoint" } },
			},
			{
				type: "frame",
				frameId: "c-8",
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: { type: "command", commandId: "c-8", body: { type: "shutdown" } },
			},
		];
		for (const cmd of commands) {
			expect(validateRemoteHostFrame(cmd)).toBeUndefined();
		}
	});
});

describe("session state (activity only, separate from connectivity)", () => {
	it("accepts session_state event with all valid activity states", () => {
		const states = ["running", "idle", "inactive"] as const;
		for (const state of states) {
			const frame: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId: `state-${state}`,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: "now",
				frame: {
					type: "event",
					id: `state-${state}`,
					sequence: 1,
					cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 },
					emittedAt: "now",
					body: { type: "session_state", state },
				},
			};
			expect(validateRemoteHostFrame(frame)).toBeUndefined();
		}
	});
});

describe("JsonValue does not include undefined", () => {
	it("serializes JsonValue objects without undefined values (JSON silently drops them)", () => {
		// Demonstrate that a {[key:string]:JsonValue} type excludes undefined.
		const obj: Record<string, unknown> = { a: 1, b: undefined, c: null };
		const serialized = JSON.stringify(obj);
		expect(serialized).not.toContain("undefined");
		expect(serialized).toBe('{"a":1,"c":null}');
	});

	it("accepts deeply nested JsonValue structures", () => {
		const frame: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId: "nested",
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: "now",
			frame: {
				type: "provider_proxy",
				proxyType: "model_call_request",
				callId: "c-1",
				provider: "test",
				model: "test",
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
					{ role: "assistant", content: [{ type: "text", text: "hi" }] },
				],
			},
		};
		expect(validateRemoteHostFrame(frame)).toBeUndefined();
	});
});
