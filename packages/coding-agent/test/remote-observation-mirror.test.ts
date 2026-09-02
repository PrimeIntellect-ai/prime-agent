import { describe, expect, it } from "vitest";
import type { RemoteHostEventSequence } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { RemoteObservationMirror } from "../src/modes/daemon/remote-observation-mirror.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides?: Record<string, unknown>, bodyOverrides?: Record<string, unknown>) {
	const seq = (overrides?.sequence ?? 1) as RemoteHostEventSequence;
	// Default body when no bodyOverrides: session_created
	const body = bodyOverrides
		? { ...bodyOverrides }
		: { type: "session_created", sessionId: "sess-1", workspaceId: "ws-1" };
	return {
		type: "event",
		id: "evt-1",
		sequence: seq,
		cursor: {
			hostId: "host-1",
			generation: "gen-1",
			sessionId: "sess-1",
			sequence: seq,
		},
		emittedAt: "2025-01-01T00:00:00.000Z",
		body,
		...overrides,
	};
}

function makeBody(type: string, overrides?: Record<string, unknown>) {
	switch (type) {
		case "session_created":
			return { type, sessionId: "sess-1", workspaceId: "ws-1", ...overrides };
		case "session_destroyed":
			return { type, ...overrides };
		case "agent_start":
			return { type, ...overrides };
		case "agent_end":
			return { type, messages: 1, ...overrides };
		case "agent_text_delta":
			return { type, index: 0, text: "hello", ...overrides };
		case "agent_thinking_delta":
			return { type, index: 0, text: "thinking", ...overrides };
		case "agent_toolcall_delta":
			return { type, index: 0, text: "tool", ...overrides };
		case "bash_start":
			return { type, command: "ls", ...overrides };
		case "bash_delta":
			return { type, text: "output", ...overrides };
		case "bash_end":
			return { type, exitCode: 0, cancelled: false, truncated: false, ...overrides };
		case "compact_start":
			return { type, ...overrides };
		case "compact_end":
			return { type, keptMessages: 10, ...overrides };
		case "compact_failed":
			return { type, error: "oom", ...overrides };
		case "error":
			return { type, code: "INTERNAL_ERROR", message: "oops", ...overrides };
		case "checkpoint_start":
			return { type, ...overrides };
		case "checkpoint_complete":
			return { type, snapshotId: "snap-1", ...overrides };
		case "checkpoint_failed":
			return { type, error: "snapshot full", ...overrides };
		case "session_state":
			return { type, state: "running", ...overrides };
	}
	return { type, ...overrides };
}

function mirror() {
	return new RemoteObservationMirror({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
}

function ingestAccepted(
	m: RemoteObservationMirror,
	seq: number,
	bodyType: string,
	bodyOverrides?: Record<string, unknown>,
	evtOverrides?: Record<string, unknown>,
) {
	const evt = makeEvent({ sequence: seq, ...evtOverrides }, makeBody(bodyType, bodyOverrides));
	const r = m.ingestEvent(evt);
	if (!r.accepted) throw new Error(`Expected accepted, got ${r.rejectionCode}`);
	return r;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B11-a: RemoteObservationMirror", () => {
	// ---- Frame structure validation ----

	it("rejects null/undefined/non-object", () => {
		const m = mirror();
		expect(m.ingestEvent(null).accepted).toBe(false);
		expect(m.ingestEvent(undefined).accepted).toBe(false);
		expect(m.ingestEvent("string").accepted).toBe(false);
		expect(m.ingestEvent(42).accepted).toBe(false);
	});

	it("rejects frame with extra/missing keys (exactObjectKeys guard)", () => {
		const m = mirror();
		const evt = makeEvent();
		// extra key → exactObjectKeys rejects
		expect(m.ingestEvent({ ...evt, extraKey: "x" }).rejectionCode).toBe("NOT_AN_OBJECT");
		// missing body
		const { body: _, ...noBody } = evt;
		expect(m.ingestEvent(noBody).rejectionCode).toBe("NOT_AN_OBJECT");
		// missing cursor
		const { cursor: _c, ...noCursor } = evt;
		expect(m.ingestEvent(noCursor).rejectionCode).toBe("NOT_AN_OBJECT");
	});

	it("rejects wrong type field", () => {
		const m = mirror();
		expect(m.ingestEvent({ ...makeEvent(), type: "not_event" }).rejectionCode).toBe("INVALID_TYPE");
	});

	it("rejects invalid id", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(m.ingestEvent({ ...evt, id: "" }).rejectionCode).toBe("INVALID_ID");
		expect(m.ingestEvent({ ...evt, id: "a".repeat(129) }).rejectionCode).toBe("INVALID_ID");
	});

	it("rejects invalid sequence (negative, zero, non-integer, too large)", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(m.ingestEvent({ ...evt, sequence: -1 }).rejectionCode).toBe("INVALID_SEQUENCE");
		expect(m.ingestEvent({ ...evt, sequence: 0 }).rejectionCode).toBe("INVALID_SEQUENCE");
		expect(m.ingestEvent({ ...evt, sequence: 1.5 }).rejectionCode).toBe("INVALID_SEQUENCE");
		expect(m.ingestEvent({ ...evt, sequence: Number.MAX_SAFE_INTEGER + 1 }).rejectionCode).toBe("INVALID_SEQUENCE");
	});

	it("rejects invalid cursor structure", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(m.ingestEvent({ ...evt, cursor: null }).rejectionCode).toBe("INVALID_CURSOR_TYPE");
		expect(m.ingestEvent({ ...evt, cursor: "string" }).rejectionCode).toBe("INVALID_CURSOR_TYPE");
		expect(m.ingestEvent({ ...evt, cursor: {} }).rejectionCode).toBe("INVALID_CURSOR_TYPE");
	});

	it("rejects cursor with extra/missing keys", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(
			m.ingestEvent({ ...evt, cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1, extra: "x" } })
				.rejectionCode,
		).toBe("INVALID_CURSOR_TYPE");
		expect(m.ingestEvent({ ...evt, cursor: { hostId: "h", generation: "g", sessionId: "s" } }).rejectionCode).toBe(
			"INVALID_CURSOR_TYPE",
		);
	});

	it("rejects cursor identity mismatch", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(
			m.ingestEvent({
				...evt,
				cursor: { hostId: "wrong", generation: "gen-1", sessionId: "sess-1", sequence: evt.sequence },
			}).rejectionCode,
		).toBe("IDENTITY_MISMATCH");
		expect(
			m.ingestEvent({
				...evt,
				cursor: { hostId: "host-1", generation: "wrong", sessionId: "sess-1", sequence: evt.sequence },
			}).rejectionCode,
		).toBe("IDENTITY_MISMATCH");
		expect(
			m.ingestEvent({
				...evt,
				cursor: { hostId: "host-1", generation: "gen-1", sessionId: "wrong", sequence: evt.sequence },
			}).rejectionCode,
		).toBe("IDENTITY_MISMATCH");
	});

	it("rejects cursor sequence != frame sequence", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(
			m.ingestEvent({
				...evt,
				sequence: 1,
				cursor: { hostId: "host-1", generation: "gen-1", sessionId: "sess-1", sequence: 99 },
			}).rejectionCode,
		).toBe("CURSOR_MISMATCH");
	});

	it("rejects invalid emittedAt (not ISO, empty, too long)", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(m.ingestEvent({ ...evt, emittedAt: "" }).rejectionCode).toBe("INVALID_EMITTED_AT");
		expect(m.ingestEvent({ ...evt, emittedAt: "not-a-date" }).rejectionCode).toBe("INVALID_EMITTED_AT");
		expect(m.ingestEvent({ ...evt, emittedAt: "2025-01-01T00:00:00.000Z".padEnd(70, "x") }).rejectionCode).toBe(
			"INVALID_EMITTED_AT",
		);
		// Valid forms
		expect(m.ingestEvent({ ...evt, emittedAt: "2025-01-01T00:00:00.000Z" }).accepted).toBe(true);
	});

	// ---- Body validation ----

	it("rejects missing body", () => {
		const m = mirror();
		const evt = makeEvent();
		const { body: _b, ...noBody } = evt;
		expect(m.ingestEvent(noBody).rejectionCode).toBe("NOT_AN_OBJECT");
	});

	it("rejects body with unknown type", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({}, { type: "unknown_type", foo: "bar" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
	});

	it("rejects body with extra keys", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({}, { type: "agent_start", extra: "x" })).rejectionCode).toBe("INVALID_BODY_TYPE");
	});

	it("rejects body with missing required keys", () => {
		const m = mirror();
		// agent_end requires messages
		expect(m.ingestEvent(makeEvent({}, { type: "agent_end" })).rejectionCode).toBe("INVALID_BODY_TYPE");
		// bash_start requires command
		expect(m.ingestEvent(makeEvent({}, { type: "bash_start" })).rejectionCode).toBe("INVALID_BODY_TYPE");
	});

	it("session_created requires sessionId and workspaceId", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({}, { type: "session_created" })).rejectionCode).toBe("INVALID_BODY_TYPE");
		expect(m.ingestEvent(makeEvent({}, { type: "session_created", sessionId: "s" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
		expect(m.ingestEvent(makeEvent({}, { type: "session_created", workspaceId: "w" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
		expect(m.ingestEvent(makeEvent({}, { type: "session_created", sessionId: "s", workspaceId: "w" })).accepted).toBe(
			true,
		);
	});

	it("compact_failed/checkpoint_failed require error field but discard its value", () => {
		const m = mirror();
		// Must have error key
		expect(m.ingestEvent(makeEvent({ sequence: 1 }, { type: "compact_failed" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
		expect(m.ingestEvent(makeEvent({ sequence: 2 }, { type: "checkpoint_failed" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
		// With error field present but non-string
		expect(m.ingestEvent(makeEvent({ sequence: 3 }, { type: "compact_failed", error: 42 })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
	});

	// ---- Error code mapping ----

	it("maps event error codes to closed allowlist or UNKNOWN", () => {
		const m = mirror();
		const knownCodes = [
			"INTERNAL_ERROR",
			"UNKNOWN_COMMAND",
			"INVALID_SESSION",
			"SESSION_DESTROYED",
			"SESSION_TIMEOUT",
			"COMPACT_FAILED",
			"CHECKPOINT_FAILED",
			"BASH_FAILED",
			"RESOURCE_EXHAUSTED",
			"UNAUTHORIZED",
			"PROTOCOL_ERROR",
			"BUILD_MISMATCH",
			"CAPABILITY_MISMATCH",
			"UNKNOWN",
		];
		// Accept session_created first
		ingestAccepted(m, 1, "session_created");
		let seq = 2;
		for (const code of knownCodes) {
			const r = m.ingestEvent(makeEvent({ sequence: seq }, makeBody("error", { code, message: "x" })));
			expect(r.accepted).toBe(true);
			seq++;
		}
		// Unknown code -> UNKNOWN mapping, still accepted
		const r = m.ingestEvent(
			makeEvent({ sequence: seq }, makeBody("error", { code: "SOME_RANDOM_ERROR", message: "secret" })),
		);
		expect(r.accepted).toBe(true);
	});

	it("rejects error with empty code", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		expect(
			m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("error", { code: "", message: "x" }))).rejectionCode,
		).toBe("INVALID_BODY_TYPE");
	});

	// ---- Sequence / gap handling ----

	it("accepts sequential events in order", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({ sequence: 1 })).accepted).toBe(true);
		expect(m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_start"))).accepted).toBe(true);
		expect(m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("agent_end", { messages: 1 }))).accepted).toBe(true);
	});

	it("duplicate/old sequence is stable no-op (no mutation)", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const state1 = m.captureCoreState();
		// Try same seq again
		const r = m.ingestEvent(makeEvent({ sequence: 1 }));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe(undefined);
		const state2 = m.captureCoreState();
		expect(state2.cursor).toBe(state1.cursor);
		// Try older seq
		const r3 = m.ingestEvent(makeEvent({ sequence: 0 }));
		expect(r3.accepted).toBe(false);
		const state3 = m.captureCoreState();
		expect(state3.cursor).toBe(1);
	});

	it("valid future event sets hasGap/needsReplay without cursor/content mutation", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// Future seq 5 (gap)
		const r = m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
		expect(r.accepted).toBe(false);
		expect(r.hasGap).toBe(true);
		expect(r.needsReplay).toBe(true);
		expect(r.rejectionCode).toBe("GAP_DETECTED");
		const stateAfter = m.captureCoreState();
		// Cursor did NOT advance
		expect(stateAfter.cursor).toBe(1);
		// Gap flags are set
		expect(stateAfter.hasGap).toBe(true);
		expect(stateAfter.needsReplay).toBe(true);
		// No body content was committed
		expect(stateAfter.agentRunning).toBe(false);
	});

	it("malformed future frame does NOT set gap", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const r = m.ingestEvent({ type: "event", id: "evt-2", sequence: 5, cursor: "invalid" });
		// Should reject at cursor validation stage, before gap
		expect(r.accepted).toBe(false);
		expect(r.hasGap).toBe(false);
		expect(r.needsReplay).toBe(false);
	});

	it("once gap set, subsequent in-order data is rejected until markReplayRecovered", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// Create gap -> seq 5
		m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
		expect(m.hasGapFlag).toBe(true);
		// Seq 2 (in order but behind gap-start 5) should be rejected
		const r = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_start")));
		expect(r.accepted).toBe(false);
		expect(r.hasGap).toBe(true);
		expect(r.needsReplay).toBe(true);
		// No silent clear
		expect(m.hasGapFlag).toBe(true);
	});

	it("markReplayRecovered clears gap (requires cursor===current, no jump)", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
		expect(m.hasGapFlag).toBe(true);
		expect(m.needsReplayFlag).toBe(true);
		// Must recover at current cursor (1), not jump
		expect(m.markReplayRecovered(5)).toBe(false);
		expect(m.markReplayRecovered(1)).toBe(true);
		expect(m.hasGapFlag).toBe(false);
		expect(m.needsReplayFlag).toBe(false);
		expect(m.currentCursor).toBe(1);
		// Now seq 2 should be accepted
		ingestAccepted(m, 2, "agent_start");
		const r = m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("agent_end", { messages: 1 })));
		expect(r.accepted).toBe(true);
	});

	it("gap-at-start recovery via markReplayRecovered(0) then seq 1", () => {
		const m = new RemoteObservationMirror({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
		// First observed event is future seq 2 at cursor 0
		m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("session_created")));
		expect(m.hasGapFlag).toBe(true);
		expect(m.currentCursor).toBe(0);
		// Recover at cursor 0
		expect(m.markReplayRecovered(0)).toBe(true);
		expect(m.hasGapFlag).toBe(false);
		expect(m.needsReplayFlag).toBe(false);
		expect(m.currentCursor).toBe(0);
		// Now seq 1 should be accepted
		const r = m.ingestEvent(makeEvent({ sequence: 1 }, makeBody("session_created")));
		expect(r.accepted).toBe(true);
	});

	it("markReplayRecovered rejects cursor !== current", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		expect(m.markReplayRecovered(0)).toBe(false);
		expect(m.markReplayRecovered(2)).toBe(false);
		expect(m.markReplayRecovered(1)).toBe(true);
	});

	// ---- Transcript records ----

	it("transcript indexed by message index, new index must equal nextMessageIndex", () => {
		const m = mirror();
		// Record 0
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hello" });
		expect(m.currentNextMessageIndex).toBe(1);
		// Record 1
		ingestAccepted(m, 4, "agent_text_delta", { index: 1, text: "world" });
		expect(m.currentNextMessageIndex).toBe(2);
		// Trying to skip index (jump to 3) should fail
		const r = m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_text_delta", { index: 3, text: "jump" })));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("GAP_DETECTED");
		expect(r.hasGap).toBe(true);
		expect(r.needsReplay).toBe(true);
		expect(m.hasGapFlag).toBe(true);
		expect(m.needsReplayFlag).toBe(true);
	});

	it("existing delta updates existing record by index", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_text_delta", { index: 0, text: "hello" });
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: " world" });
		const rec = m.getRecord(0);
		expect(rec?.text).toBe("hello world");
	});

	it("first delta must be index 0", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const r = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_text_delta", { index: 5, text: "hello" })));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("GAP_DETECTED");
	});

	it("after eviction, older missing index signals replay (gap)", () => {
		const m = new RemoteObservationMirror({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
		ingestAccepted(m, 1, "session_created");
		// Fill up to MAX_TRANSCRIPT_RECORDS (200) messages
		for (let i = 0; i < 200; i++) {
			ingestAccepted(m, 2 + i, "agent_text_delta", { index: i, text: "msg" });
		}
		// Now we have records 0..199. nextMsgIdx = 200.
		// If we try to write index 0 again, that's fine (existing).
		// If we try index 0 - MAX_TRANSCRIPT_RECORDS = negative, handled differently
		// Index 50 is still within range
		ingestAccepted(m, 202, "agent_text_delta", { index: 50, text: " updated" });
		expect(m.getRecord(50)?.text).toBe("msg updated");
	});

	// ---- State transitions ----

	it("agent_start only when not running", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		expect(m.agentRunningVal).toBe(true);
		// Second agent_start rejected
		const r = m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("agent_start")));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("INVALID_SESSION_STATE");
	});

	it("agent_end only when running and count coherent", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// agent_end without start rejected (no cursor advance)
		const r1 = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_end", { messages: 1 })));
		expect(r1.accepted).toBe(false);
		expect(r1.rejectionCode).toBe("INVALID_SESSION_STATE");
		// Reuse same seq (cursor still 1, so 2 > 1 = in order)
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_end", { messages: 1 });
		expect(m.agentRunningVal).toBe(false);
		expect(m.msgCountVal).toBe(1);
	});

	it("bash_start allowed initially or after prior finished (replace)", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "bash_start", { command: "ls" });
		expect(m.currentBash).not.toBeNull();
		// Second bash_start without finishing first is rejected
		// Cursor stays at 2
		const r = m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("bash_start", { command: "pwd" })));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("INVALID_BASH_STATE");
		// Finish first bash (reuse seq 3 since cursor didn't advance)
		ingestAccepted(m, 3, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
		// Start new one
		ingestAccepted(m, 4, "bash_start", { command: "pwd" });
		expect(m.currentBash?.command).toBe("pwd");
	});

	it("bash_delta/end only active unfinished bash", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// bash_delta without bash_start
		expect(m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("bash_delta", { text: "x" }))).rejectionCode).toBe(
			"INVALID_BASH_STATE",
		);
		// bash_end without bash_start (reuse seq 2 since cursor didn't advance)
		expect(
			m.ingestEvent(
				makeEvent({ sequence: 2 }, makeBody("bash_end", { exitCode: 0, cancelled: false, truncated: false })),
			).rejectionCode,
		).toBe("INVALID_BASH_STATE");
	});

	it("bash_end preserves local truncation OR remote truncation", () => {
		const m = mirror();
		const chunkSz = 50_000;
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "bash_start", { command: "echo long" });
		// 10 chunks of 50k = 500k (exactly MAX_BASH_OUT, not >)
		for (let i = 0; i < 10; i++) {
			ingestAccepted(m, 3 + i, "bash_delta", { text: "x".repeat(chunkSz) });
		}
		// 11th chunk of 1 byte overflows 500k bound
		ingestAccepted(m, 13, "bash_delta", { text: "y" });
		const bashAfter = m.currentBash!;
		expect(bashAfter.truncated).toBe(true);
		expect(bashAfter.output.length).toBe(500_000);
		// Remote says not truncated -> OR = true
		ingestAccepted(m, 14, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
		expect(m.currentBash!.truncated).toBe(true);
		// Start fresh — remote truncation
		ingestAccepted(m, 15, "bash_start", { command: "echo hi" });
		ingestAccepted(m, 16, "bash_delta", { text: "short" });
		ingestAccepted(m, 17, "bash_end", { exitCode: 0, cancelled: false, truncated: true });
		expect(m.currentBash!.truncated).toBe(true);
	});

	it("compact/checkpoint start only inactive; terminal only active", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "compact_start");
		expect(m.compactingVal).toBe(true);
		// Second compact_start rejected (cursor stays 2)
		expect(m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("compact_start"))).rejectionCode).toBe(
			"INVALID_COMPACT_STATE",
		);
		// compact_end (reuse seq 3 since cursor didn't advance)
		ingestAccepted(m, 3, "compact_end", { keptMessages: 5 });
		expect(m.compactingVal).toBe(false);
		// compact_end without compacting now (cursor=3, use seq 4)
		expect(
			m.ingestEvent(makeEvent({ sequence: 4 }, makeBody("compact_end", { keptMessages: 10 }))).rejectionCode,
		).toBe("INVALID_COMPACT_STATE");
		// checkpoint (cursor still 3, use seq 4 again... no, seq 4 was rejected but cursor still 3)
		// Actually cursor=3 after compact_end. Seq 4 was rejected (cursor stays 3). Use seq 4 again.
		ingestAccepted(m, 4, "checkpoint_start");
		expect(m.checkpointingVal).toBe(true);
		// Second checkpoint_start rejected
		expect(m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("checkpoint_start"))).rejectionCode).toBe(
			"INVALID_CHECKPOINT_STATE",
		);
		// checkpoint_complete (cursor stays 4, use seq 5)
		ingestAccepted(m, 5, "checkpoint_complete", { snapshotId: "snap-1" });
		expect(m.checkpointingVal).toBe(false);
		// checkpoint_complete without checkpointing (cursor=5, use seq 6)
		expect(
			m.ingestEvent(makeEvent({ sequence: 6 }, makeBody("checkpoint_complete", { snapshotId: "snap-2" })))
				.rejectionCode,
		).toBe("INVALID_CHECKPOINT_STATE");
		// compact_failed only when compacting (cursor still 5, use seq 6 again)
		ingestAccepted(m, 6, "compact_start");
		ingestAccepted(m, 7, "compact_failed", { error: "oom" });
		expect(m.compactingVal).toBe(false);
		// checkpoint_failed only when checkpointing
		ingestAccepted(m, 8, "checkpoint_start");
		ingestAccepted(m, 9, "checkpoint_failed", { error: "disk full" });
		expect(m.checkpointingVal).toBe(false);
	});

	// ---- Truncation boundaries ----

	it("bounded per-frame text/thinking/tool strings before allocating concat", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// Per-frame text limit
		const bigText = "x".repeat(MAX_DELTA_TEXT_PER_FRAME + 1);
		const r = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_text_delta", { index: 0, text: bigText })));
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
		// Per-frame thinking limit
		const bigThink = "x".repeat(MAX_DELTA_THINKING_PER_FRAME + 1);
		const r2 = m.ingestEvent(
			makeEvent({ sequence: 3 }, makeBody("agent_thinking_delta", { index: 0, text: bigThink })),
		);
		expect(r2.accepted).toBe(false);
		expect(r2.rejectionCode).toBe("INVALID_BODY_TYPE");
		// Per-frame toolcall limit
		const bigTool = "x".repeat(MAX_DELTA_TOOLCALL_PER_FRAME + 1);
		const r3 = m.ingestEvent(
			makeEvent({ sequence: 4 }, makeBody("agent_toolcall_delta", { index: 0, text: bigTool })),
		);
		expect(r3.accepted).toBe(false);
		expect(r3.rejectionCode).toBe("INVALID_BODY_TYPE");
	});

	it("aggregate text/thinking/tool bound before concat; preserves truncation forever", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		// Fill text to near max via multiple deltas (each bounded by per-frame limit)
		const firstChunk = "x".repeat(MAX_DELTA_TEXT_PER_FRAME); // 50000
		ingestAccepted(m, 2, "agent_text_delta", { index: 0, text: firstChunk });
		let rec = m.getRecord(0)!;
		expect(rec.textTruncated).toBe(false);
		expect(rec.text.length).toBe(MAX_DELTA_TEXT_PER_FRAME);
		// Second chunk
		const secondChunk = "x".repeat(MAX_DELTA_TEXT_PER_FRAME - 1); // 49999 -> 99999
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: secondChunk });
		rec = m.getRecord(0)!;
		expect(rec.textTruncated).toBe(false);
		expect(rec.text.length).toBe(MAX_DELTA_TEXT_PER_FRAME * 2 - 1); // 99999
		// One more delta overflows
		ingestAccepted(m, 4, "agent_text_delta", { index: 0, text: "yy" });
		rec = m.getRecord(0)!;
		expect(rec.textTruncated).toBe(true);
		expect(rec.text.length).toBe(MAX_TEXT_LENGTH);
		// Subsequent deltas keep truncation flag
		ingestAccepted(m, 5, "agent_text_delta", { index: 0, text: "z" });
		rec = m.getRecord(0)!;
		expect(rec.textTruncated).toBe(true);
		expect(rec.text.length).toBe(MAX_TEXT_LENGTH);
	});

	// ---- Recap ----

	it("recap ring records accepted events in order", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hi" });
		ingestAccepted(m, 4, "agent_end", { messages: 1 });
		const recap = m.recapEntries;
		expect(recap.length).toBe(4);
		expect(recap[0].eventSequence).toBe(1);
		expect(recap[0].type).toBe("session_created");
		expect(recap[2].messageIndex).toBe(0);
	});

	it("getRecapDelta gives exact retained boundary/gap", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_end", { messages: 1 });
		const delta0 = m.getRecapDelta(0);
		expect(delta0.entries.length).toBe(3);
		expect(delta0.signalGap).toBe(false);
		const delta1 = m.getRecapDelta(1);
		expect(delta1.entries.length).toBe(2);
		const delta3 = m.getRecapDelta(3);
		expect(delta3.entries.length).toBe(0);
		expect(delta3.signalGap).toBe(false);
	});

	it("getRecapDelta signals gap on invalid input", () => {
		const m = mirror();
		expect(m.getRecapDelta(-1).signalGap).toBe(true);
		expect(m.getRecapDelta(1.5).signalGap).toBe(true);
	});

	// ---- Getters return deep frozen / cloned data ----

	it("getters return immutable snapshots", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const activity = m.currentActivity;
		expect(Object.isFrozen(activity)).toBe(true);
		const bash = m.currentBash;
		expect(bash).toBeNull();
	});

	it("captureCoreState is deeply frozen", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_text_delta", { index: 0, text: "hi" });
		const cs = m.captureCoreState();
		expect(Object.isFrozen(cs)).toBe(true);
		expect(Object.isFrozen(cs.records)).toBe(true);
		if (cs.records.length > 0) {
			expect(Object.isFrozen(cs.records[0])).toBe(true);
		}
		expect(Object.isFrozen(cs.recap)).toBe(true);
		expect(Object.isFrozen(cs.bash) || cs.bash === null).toBe(true);
	});

	it("captureCoreState includes all state/truncation flags/timestamps and identity/cursor/gap", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hello" });
		ingestAccepted(m, 4, "agent_end", { messages: 1 });
		ingestAccepted(m, 5, "bash_start", { command: "ls" });
		ingestAccepted(m, 6, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
		const cs = m.captureCoreState();
		expect(cs.hostId).toBe("host-1");
		expect(cs.generation).toBe("gen-1");
		expect(cs.sessionId).toBe("sess-1");
		expect(cs.cursor).toBe(6);
		expect(typeof cs.cursorTimestamp).toBe("string");
		expect(cs.hasGap).toBe(false);
		expect(cs.needsReplay).toBe(false);
		expect(cs.nextMessageIndex).toBe(1);
		expect(cs.agentRunning).toBe(false);
		expect(cs.messageCount).toBe(1);
		expect(cs.compacting).toBe(false);
		expect(cs.checkpointing).toBe(false);
		expect(cs.bash).not.toBeNull();
		expect(cs.records.length).toBe(1);
		expect(cs.records[0].textTruncated).toBe(false);
	});

	// ---- Constructor with initialNextIndex ----

	it("constructor accepts initialNextIndex, default 0", () => {
		const m1 = new RemoteObservationMirror({ hostId: "h", generation: "g", sessionId: "s" });
		expect(m1.currentNextMessageIndex).toBe(0);
		const m2 = new RemoteObservationMirror({ hostId: "h", generation: "g", sessionId: "s", initialNextIndex: 42 });
		expect(m2.currentNextMessageIndex).toBe(42);
	});

	it("constructor rejects invalid identity", () => {
		expect(() => new RemoteObservationMirror({ hostId: "", generation: "g", sessionId: "s" })).toThrow();
		expect(() => new RemoteObservationMirror({ hostId: "h".repeat(129), generation: "g", sessionId: "s" })).toThrow();
	});

	// ---- Adversarial mutation tests ----

	it("adversarial: prototype pollution on frame", () => {
		const m = mirror();
		const evt: Record<string, unknown> = makeEvent();
		Object.setPrototypeOf(evt, { malicious: true });
		const r = m.ingestEvent(evt);
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("NOT_AN_OBJECT");
	});

	it("adversarial: prototype pollution on body", () => {
		const m = mirror();
		const evt: Record<string, unknown> = makeEvent();
		const body = evt.body as Record<string, unknown>;
		Object.setPrototypeOf(body, { malicious: true });
		const r = m.ingestEvent(evt);
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
	});

	it("adversarial: extra body fields", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({}, { type: "agent_start", malicious: "x" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
	});

	it("adversarial: extra cursor fields", () => {
		const m = mirror();
		expect(
			m.ingestEvent(makeEvent({ cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1, extra: "x" } }))
				.rejectionCode,
		).toBe("INVALID_CURSOR_TYPE");
	});

	it("adversarial: non-JSON values (undefined symbol)", () => {
		const m = mirror();
		const evt = makeEvent();
		(evt as any).body = undefined;
		const r = m.ingestEvent(evt);
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("NOT_AN_OBJECT");
	});

	it("adversarial: mutated enum body fields", () => {
		const m = mirror();
		// State must be valid enum
		expect(m.ingestEvent(makeEvent({ sequence: 1 }, { type: "session_state", state: "invalid" })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
		// Reuse seq 1 since cursor didn't advance
		expect(m.ingestEvent(makeEvent({ sequence: 1 }, { type: "session_state", state: "running" })).accepted).toBe(
			true,
		);
	});

	it("adversarial: every type coercion attempt", () => {
		const m = mirror();
		const evt = makeEvent();
		// String where number expected
		expect(m.ingestEvent({ ...evt, sequence: "1" }).rejectionCode).toBe("INVALID_SEQUENCE");
		// Number where string expected
		expect(m.ingestEvent({ ...evt, id: 123 }).rejectionCode).toBe("INVALID_ID");
		// Object where string expected
		expect(m.ingestEvent({ ...evt, emittedAt: {} }).rejectionCode).toBe("INVALID_EMITTED_AT");
	});

	it("adversarial: falsy values misuse", () => {
		const m = mirror();
		expect(m.ingestEvent(makeEvent({ sequence: 1 }, { type: "agent_start", extra: false })).rejectionCode).toBe(
			"INVALID_BODY_TYPE",
		);
	});

	// ---- Complex scenarios ----

	it("session_destroyed gates later activity", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "session_destroyed", { reason: "done" });
		// This protocol allows events after destroy; they'd just be processed
		// The spec says "Session destroy gates later activity if protocol semantics establish that"
		// For now, we accept them (relay decides what to do)
		ingestAccepted(m, 3, "session_created");
	});

	it("multiple text deltas to record 0 accumulate", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_text_delta", { index: 0, text: "a" });
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "b" });
		ingestAccepted(m, 4, "agent_text_delta", { index: 0, text: "c" });
		expect(m.getRecord(0)?.text).toBe("abc");
	});

	it("second bash lifecycles work", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "bash_start", { command: "first" });
		ingestAccepted(m, 3, "bash_delta", { text: "out1" });
		ingestAccepted(m, 4, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
		ingestAccepted(m, 5, "bash_start", { command: "second" });
		ingestAccepted(m, 6, "bash_delta", { text: "out2" });
		ingestAccepted(m, 7, "bash_end", { exitCode: 1, cancelled: true, truncated: false });
		expect(m.currentBash?.command).toBe("second");
		expect(m.currentBash?.exitCode).toBe(1);
		expect(m.currentBash?.cancelled).toBe(true);
	});

	it("session_state changes tracked", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "session_state", { state: "running" });
		expect(m.sessionStateVal).toBe("running");
		ingestAccepted(m, 3, "session_state", { state: "idle" });
		expect(m.sessionStateVal).toBe("idle");
		ingestAccepted(m, 4, "session_state", { state: "inactive" });
		expect(m.sessionStateVal).toBe("inactive");
	});
});

it("validates full body even while gap-gated", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	// Gap at seq 5
	m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
	expect(m.hasGapFlag).toBe(true);
	// In-order seq 2 with malformed body should report structural error (not just gap)
	const r = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("bad_type")));
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
	expect(r.hasGap).toBe(true);
	expect(r.needsReplay).toBe(true);
});

it("accessor property on frame is rejected", () => {
	const m = mirror();
	const evt = makeEvent() as Record<string, unknown>;
	// An otherwise-valid frame is accepted
	expect(m.ingestEvent(makeEvent())).toHaveProperty("accepted", true);
	// Same frame with an accessor property is rejected
	Object.defineProperty(evt, "malicious", { get: () => "x", enumerable: true });
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("NOT_AN_OBJECT");
});

it("accessor property on cursor is rejected", () => {
	const m = mirror();
	const evt = makeEvent();
	const cursor = { hostId: "host-1", generation: "gen-1", sessionId: "sess-1", sequence: 1 };
	Object.defineProperty(cursor, "malicious", { get: () => "x", enumerable: true });
	evt.cursor = cursor;
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_CURSOR_TYPE");
});

it("symbol key on frame is rejected (exactObjectKeys checks getOwnPropertySymbols)", () => {
	const m = mirror();
	// Otherwise-valid frame is accepted
	expect(m.ingestEvent(makeEvent())).toHaveProperty("accepted", true);
	// With a symbol key, it should now be rejected
	const evt = makeEvent() as Record<string, unknown>;
	Object.defineProperty(evt, Symbol("hidden"), { value: "x", enumerable: true });
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("NOT_AN_OBJECT");
});

it("own-undefined optional body field is rejected", () => {
	const m = mirror();
	// session_destroyed with reason explicitly undefined
	const body = { type: "session_destroyed", reason: undefined };
	const evt = makeEvent({ sequence: 1 }, body);
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("initialNextIndex empty record map accepts only d.index===nextMsgIdx", () => {
	const m = new RemoteObservationMirror({
		hostId: "host-1",
		generation: "gen-1",
		sessionId: "sess-1",
		initialNextIndex: 42,
	});
	ingestAccepted(m, 1, "session_created");
	// Index 0 should be rejected (empty map, nextMsgIdx=42) — cursor stays 1
	const r1 = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_text_delta", { index: 0, text: "hi" })));
	expect(r1.accepted).toBe(false);
	expect(r1.rejectionCode).toBe("GAP_DETECTED");
	// Clear gap before trying valid index
	expect(m.markReplayRecovered(1)).toBe(true);
	// Index 42 should be accepted (reuse seq 2 since cursor didn't advance)
	const r2 = m.ingestEvent(makeEvent({ sequence: 2 }, makeBody("agent_text_delta", { index: 42, text: "hi" })));
	expect(r2.accepted).toBe(true);
	expect(m.currentNextMessageIndex).toBe(43);
});

it("unsafe integers rejected for all numeric fields", () => {
	const m = mirror();
	// Agent_end with unsafe messages count
	const r1 = m.ingestEvent(
		makeEvent({ sequence: 1 }, makeBody("agent_end", { messages: Number.MAX_SAFE_INTEGER + 1 })),
	);
	expect(r1.accepted).toBe(false);
	expect(r1.rejectionCode).toBe("INVALID_BODY_TYPE");
	// Sequence must be safe positive
	const r2 = m.ingestEvent({ ...makeEvent(), sequence: Number.MAX_SAFE_INTEGER + 1 });
	expect(r2.accepted).toBe(false);
	expect(r2.rejectionCode).toBe("INVALID_SEQUENCE");
	// bash_end exitCode must be safe integer (negative allowed)
	ingestAccepted(m, 1, "session_created");
	ingestAccepted(m, 2, "bash_start", { command: "fail" });
	ingestAccepted(m, 3, "bash_end", { exitCode: -1, cancelled: false, truncated: false });
	expect(m.currentBash?.exitCode).toBe(-1);
	// exitCode unsafe rejected
	ingestAccepted(m, 4, "bash_start", { command: "bad" });
	const r3 = m.ingestEvent(
		makeEvent({ sequence: 5 }, makeBody("bash_end", { exitCode: 1.5, cancelled: false, truncated: false })),
	);
	expect(r3.accepted).toBe(false);
	expect(r3.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("huge raw error message bounded before discard", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	// Error message > 512 chars → rejected
	const r = m.ingestEvent(
		makeEvent({ sequence: 2 }, makeBody("error", { code: "INTERNAL_ERROR", message: "x".repeat(600) })),
	);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("huge compact_failed/checkpoint_failed error bounded before discard", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	ingestAccepted(m, 2, "compact_start");
	// error > 512 chars → rejected
	const r = m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("compact_failed", { error: "x".repeat(600) })));
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("huge bash_delta per frame rejected", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	ingestAccepted(m, 2, "bash_start", { command: "big" });
	const r = m.ingestEvent(makeEvent({ sequence: 3 }, makeBody("bash_delta", { text: "x".repeat(50_001) })));
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("gap recovery cannot jump cursor", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
	// Cannot jump to 5; cursor is still 1
	expect(m.markReplayRecovered(5)).toBe(false);
	expect(m.markReplayRecovered(1)).toBe(true);
});

it("runtime immutability of identity, currentBash, recapEntries", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	ingestAccepted(m, 2, "bash_start", { command: "immutable" });
	ingestAccepted(m, 3, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
	// identity is frozen
	const id = m.identity;
	expect(Object.isFrozen(id)).toBe(true);
	// currentBash is frozen
	const bash = m.currentBash!;
	expect(Object.isFrozen(bash)).toBe(true);
	// recapEntries each frozen
	const recap = m.recapEntries;
	expect(recap.length).toBe(3);
	for (const e of recap) expect(Object.isFrozen(e)).toBe(true);
});

it("lastFailureMarker stored for error/compact_failed/checkpoint_failed", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	expect(m.lastFailureValue).toEqual({ type: "none" });
	// error sets marker with code
	ingestAccepted(m, 2, "error", { code: "INTERNAL_ERROR", message: "x" });
	expect(m.lastFailureValue).toEqual({ type: "error", code: "INTERNAL_ERROR" });
	// compact_failed sets marker
	ingestAccepted(m, 3, "compact_start");
	ingestAccepted(m, 4, "compact_failed", { error: "oom" });
	expect(m.lastFailureValue).toEqual({ type: "compact_failed" });
	// checkpoint_failed
	ingestAccepted(m, 5, "checkpoint_start");
	ingestAccepted(m, 6, "checkpoint_failed", { error: "disk" });
	expect(m.lastFailureValue).toEqual({ type: "checkpoint_failed" });
	// Non-failure events preserve the marker (only session_created resets)
	ingestAccepted(m, 7, "bash_start", { command: "ls" });
	expect(m.lastFailureValue).toEqual({ type: "checkpoint_failed" });
	expect(Object.isFrozen(m.lastFailureValue)).toBe(true);
});

it("validates IDs with safe grammar (not just length)", () => {
	const m = mirror();
	// ID with spaces rejected
	const evt = makeEvent();
	const r = m.ingestEvent({ ...evt, id: "has space" });
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_ID");
});

it("non-plain-object for body fields is rejected", () => {
	const m = mirror();
	// session_created where body field is an Error instance
	const evt = makeEvent({}, { type: "session_created", sessionId: "s", workspaceId: new String("w") });
	// new String("w") is object but not plain; exactKeys checks proto
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
});

it("nonenumerable extra property on frame is rejected (exactObjectKeys checks getOwnPropertyNames)", () => {
	const m = mirror();
	// Otherwise-valid frame is accepted
	expect(m.ingestEvent(makeEvent())).toHaveProperty("accepted", true);
	// With non-enumerable property, rejected
	const evt = makeEvent() as Record<string, unknown>;
	Object.defineProperty(evt, "hidden", { value: "x", enumerable: false });
	const r = m.ingestEvent(evt);
	expect(r.accepted).toBe(false);
	expect(r.rejectionCode).toBe("NOT_AN_OBJECT");
});

it("canonical timestamp roundtrip", () => {
	const m = mirror();
	// Test with project-approved Z-suffixed form
	const r1 = m.ingestEvent(makeEvent({ sequence: 1, emittedAt: "2025-01-01T00:00:00.000Z" }));
	expect(r1.accepted).toBe(true);
	// Roundtrip: re-serialize toISOString must match
	const ts = new Date();
	const iso = ts.toISOString();
	const r2 = m.ingestEvent(makeEvent({ sequence: 2, emittedAt: iso }));
	expect(r2.accepted).toBe(true);
	// Timezone offset (+05:30) should be rejected — only Z suffix allowed
	const r3 = m.ingestEvent(makeEvent({ sequence: 3, emittedAt: "2025-06-15T12:30:45.123+05:30" }));
	expect(r3.accepted).toBe(false);
	expect(r3.rejectionCode).toBe("INVALID_EMITTED_AT");
	// Without timezone (lenient) should be rejected
	const r4 = m.ingestEvent(makeEvent({ sequence: 3, emittedAt: "2025-01-01T00:00:00" }));
	expect(r4.accepted).toBe(false);
	expect(r4.rejectionCode).toBe("INVALID_EMITTED_AT");
	// Valid Z-suffixed form (reuse seq 3 since r3/r4 were rejected)
	const r5 = m.ingestEvent(makeEvent({ sequence: 3, emittedAt: "2025-01-01T00:00:01.000Z" }));
	expect(r5.accepted).toBe(true);
});

it("negative exitCode is a safe integer but reject unsafe int", () => {
	const m = mirror();
	ingestAccepted(m, 1, "session_created");
	ingestAccepted(m, 2, "bash_start", { command: "fail" });
	ingestAccepted(m, 3, "bash_end", { exitCode: -2, cancelled: false, truncated: false });
	expect(m.currentBash?.exitCode).toBe(-2);
});

// We need the constants visible for boundary tests
const MAX_DELTA_TEXT_PER_FRAME = 50_000;
const MAX_DELTA_THINKING_PER_FRAME = 100_000;
const MAX_DELTA_TOOLCALL_PER_FRAME = 25_000;
const MAX_TEXT_LENGTH = 100_000;

// ===========================================================================
// B11-b: RemoteObservationSnapshotV1 codec — capture/restore tests
// ===========================================================================

import { KNOWN_ERR_CODES } from "../src/modes/daemon/remote-observation-mirror.js";
import {
	decodeRemoteObservationSnapshotV1,
	type RemoteObservationSnapshotV1,
	type SnapshotRejectionCode,
} from "../src/modes/daemon/remote-observation-snapshot.js";

const IDENTITY = { hostId: "host-1", generation: "gen-1", sessionId: "sess-1" } as const;

function makeSnapshot(overrides?: Partial<RemoteObservationSnapshotV1>): RemoteObservationSnapshotV1 {
	return {
		version: "1" as const,
		hostId: "host-1",
		generation: "gen-1",
		sessionId: "sess-1",
		capturedAt: "2025-01-01T00:00:00.000Z",
		cursor: 10,
		cursorTimestamp: "2025-01-01T00:00:00.000Z",
		hasGap: false,
		needsReplay: false,
		nextMessageIndex: 2,
		records: [
			{
				index: 0,
				text: "hello",
				thinking: "hmm",
				toolCallText: "tool",
				emittedAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				textTruncated: false,
				thinkingTruncated: false,
				toolCallTruncated: false,
			},
			{
				index: 1,
				text: "world",
				thinking: "",
				toolCallText: "",
				emittedAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
				textTruncated: false,
				thinkingTruncated: false,
				toolCallTruncated: false,
			},
		],
		messageCount: 5,
		agentRunning: false,
		sessionState: "running",
		compacting: false,
		checkpointing: false,
		bash: null,
		recap: [
			{ eventSequence: 1, type: "session_created" },
			{ eventSequence: 2, type: "session_created" },
			{ eventSequence: 3, type: "session_created" },
			{ eventSequence: 4, type: "session_created" },
			{ eventSequence: 5, type: "session_created" },
			{ eventSequence: 6, type: "session_created" },
			{ eventSequence: 7, type: "session_created" },
			{ eventSequence: 8, type: "session_created" },
			{ eventSequence: 9, type: "session_created" },
			{ eventSequence: 10, type: "session_created" },
		],
		lastFailure: { type: "none" },
		...overrides,
	};
}

function decodeOk(raw: unknown): RemoteObservationSnapshotV1 {
	const r = decodeRemoteObservationSnapshotV1(raw, IDENTITY);
	if (!r.success) throw new Error(`Expected success, got ${r.code}`);
	return r.value;
}

function decodeFail(raw: unknown, expectedCode: SnapshotRejectionCode): void {
	const r = decodeRemoteObservationSnapshotV1(raw, IDENTITY);
	if (r.success) throw new Error("Expected failure, got success");
	expect((r as { code: SnapshotRejectionCode }).code).toBe(expectedCode);
}

describe("B11-b: RemoteObservationSnapshotV1 codec", () => {
	// ---- JSON roundtrip ----
	it("roundtrips through JSON.parse/stringify", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hello" });
		ingestAccepted(m, 4, "agent_end", { messages: 1 });

		const snap = m.captureSnapshot();
		const json = JSON.stringify(snap);
		const parsed = JSON.parse(json);
		const decoded = decodeOk(parsed);

		expect(decoded.version).toBe("1");
		expect(decoded.hostId).toBe("host-1");
		expect(decoded.generation).toBe("gen-1");
		expect(decoded.sessionId).toBe("sess-1");
		expect(typeof decoded.capturedAt).toBe("string");
		expect(decoded.cursor).toBe(4);
		expect(decoded.hasGap).toBe(false);
		expect(decoded.needsReplay).toBe(false);
		expect(decoded.nextMessageIndex).toBe(1);
		expect(decoded.records.length).toBe(1);
		expect(decoded.records[0].text).toBe("hello");
		expect(decoded.lastFailure).toEqual({ type: "none" });

		// Verify deep freeze
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded.records)).toBe(true);
		expect(Object.isFrozen(decoded.records[0])).toBe(true);
	});

	it("captureSnapshot returns version 1 and valid capturedAt", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const snap = m.captureSnapshot();
		expect(snap.version).toBe("1");
		expect(snap.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	// ---- initialNextIndex 42 roundtrip (messageCount independent) ----
	it("roundtrips initialNextIndex=42 with messageCount=0 (independent counters)", () => {
		const m = new RemoteObservationMirror({
			hostId: "host-1",
			generation: "gen-1",
			sessionId: "sess-1",
			initialNextIndex: 42,
		});
		ingestAccepted(m, 1, "session_created");
		const snap = m.captureSnapshot();
		expect(snap.nextMessageIndex).toBe(42);
		expect(snap.messageCount).toBe(0);
		expect(snap.records.length).toBe(0);
		expect(snap.cursor).toBe(1);

		// Roundtrip
		const json = JSON.stringify(snap);
		const decoded = decodeOk(JSON.parse(json));
		expect(decoded.nextMessageIndex).toBe(42);
		expect(decoded.messageCount).toBe(0);
		expect(decoded.records.length).toBe(0);

		// Restore and verify
		const restored = RemoteObservationMirror.fromSnapshot(JSON.parse(json), IDENTITY);
		expect(restored.success).toBe(true);
		if (!restored.success) return;
		expect(restored.mirror.currentNextMessageIndex).toBe(42);
		expect(restored.mirror.msgCountVal).toBe(0);
		expect(restored.mirror.currentCursor).toBe(1);
		expect(restored.mirror.transcriptRecordCount).toBe(0);
	});

	// ---- Identity mismatch ----
	it("rejects identity mismatch (hostId)", () => {
		decodeFail({ ...makeSnapshot(), hostId: "wrong" }, "IDENTITY_MISMATCH");
	});
	it("rejects identity mismatch (generation)", () => {
		decodeFail({ ...makeSnapshot(), generation: "wrong" }, "IDENTITY_MISMATCH");
	});
	it("rejects identity mismatch (sessionId)", () => {
		decodeFail({ ...makeSnapshot(), sessionId: "wrong" }, "IDENTITY_MISMATCH");
	});
	it("rejects invalid expectedIdentity", () => {
		const r = decodeRemoteObservationSnapshotV1(makeSnapshot(), { hostId: "", generation: "g", sessionId: "s" });
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.code).toBe("INVALID_IDENTITY");
	});

	// ---- Key/type validation ----
	it("rejects missing version", () => {
		const raw = { ...makeSnapshot() };
		delete (raw as Record<string, unknown>).version;
		decodeFail(raw, "MISSING_VERSION");
	});
	it("rejects wrong version literal", () => {
		decodeFail({ ...makeSnapshot(), version: "2" }, "INVALID_VERSION");
	});
	it("rejects null value", () => {
		decodeFail(null, "NOT_AN_OBJECT");
	});
	it("rejects non-object value", () => {
		decodeFail("string", "NOT_AN_OBJECT");
	});
	it("rejects extra top-level key", () => {
		decodeFail({ ...makeSnapshot(), extraKey: "x" }, "UNKNOWN_FIELD");
	});
	it("rejects missing required key (bash is now required)", () => {
		const raw = { ...makeSnapshot() };
		delete (raw as Record<string, unknown>).bash;
		decodeFail(raw, "UNKNOWN_FIELD");
	});
	it("rejects invalid hostId grammar", () => {
		decodeFail({ ...makeSnapshot(), hostId: "has space" }, "INVALID_ID");
	});

	// ---- Timestamps ----
	it("rejects non-canonical capturedAt", () => {
		decodeFail({ ...makeSnapshot(), capturedAt: "2025-01-01T00:00:00.000+00:00" }, "INVALID_CAPTURED_AT");
	});
	it("accepts cursor 0 with empty cursorTimestamp, no records", () => {
		const r = decodeOk({ ...makeSnapshot(), cursor: 0, cursorTimestamp: "", records: [], recap: [] });
		expect(r.cursor).toBe(0);
		expect(r.cursorTimestamp).toBe("");
	});
	it("rejects cursorTimestamp > capturedAt", () => {
		decodeFail(
			{ ...makeSnapshot(), capturedAt: "2025-01-01T00:00:00.000Z", cursorTimestamp: "2025-01-02T00:00:00.000Z" },
			"INVALID_TIMESTAMP_ORDER",
		);
	});

	// ---- Gap invariant ----
	it("rejects hasGap !== needsReplay", () => {
		decodeFail({ ...makeSnapshot(), hasGap: true, needsReplay: false }, "INVALID_GAP_INVARIANT");
	});
	it("accepts hasGap === needsReplay (both true)", () => {
		decodeOk({ ...makeSnapshot(), hasGap: true, needsReplay: true });
	});

	// ---- Records ----
	it("rejects non-plain-array records", () => {
		decodeFail({ ...makeSnapshot(), records: "not-array" }, "INVALID_RECORD_STRUCTURE");
	});
	it("rejects sparse records array", () => {
		const sparse = makeSnapshot().records.slice();
		(sparse as any)[5] = sparse[0];
		// Shared jsonPreflight catches sparse arrays before structural validation
		decodeFail({ ...makeSnapshot(), records: sparse }, "OVERFLOW_BYTES");
	});
	it("rejects record with extra key", () => {
		const recs = [makeSnapshot().records[0]];
		(recs[0] as any).extra = "x";
		decodeFail({ ...makeSnapshot(), records: recs }, "INVALID_RECORD_STRUCTURE");
	});
	it("rejects record index < nextMessageIndex - records.length (non-contiguous)", () => {
		// records=[0,2], expectedFirst = 2-2=0, but index 2 != index 0 + 1
		const recs = [
			{ ...makeSnapshot().records[0], index: 0 },
			{ ...makeSnapshot().records[0], index: 2 },
		];
		decodeFail({ ...makeSnapshot(), nextMessageIndex: 2, records: recs }, "INVALID_RECORD_INDEX");
	});
	it("rejects non-contiguous suffix (first != nextMessageIndex - records.length)", () => {
		// expectedFirst = 5 - 1 = 4, but index is 0
		const recs = [{ ...makeSnapshot().records[0], index: 0 }];
		decodeFail({ ...makeSnapshot(), nextMessageIndex: 5, records: recs }, "INVALID_RECORD_INDEX");
	});
	it("rejects record count > 200", () => {
		const recs = Array.from({ length: 201 }, (_, i) => ({
			index: i,
			text: "",
			thinking: "",
			toolCallText: "",
			emittedAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			textTruncated: false,
			thinkingTruncated: false,
			toolCallTruncated: false,
		}));
		decodeFail({ ...makeSnapshot(), nextMessageIndex: 201, records: recs, recap: [] }, "INVALID_RECORD_COUNT");
	});

	// ---- Recap ----
	it("rejects recap count > 100", () => {
		const recap = Array.from({ length: 101 }, (_, i) => ({
			eventSequence: i + 1,
			type: "session_created" as const,
		}));
		decodeFail({ ...makeSnapshot(), cursor: 101, records: [], nextMessageIndex: 0, recap }, "INVALID_RECAP_COUNT");
	});
	it("rejects recap not strictly increasing", () => {
		const recap = [
			{ eventSequence: 2, type: "session_created" as const },
			{ eventSequence: 1, type: "session_created" as const },
		];
		decodeFail({ ...makeSnapshot(), cursor: 2, records: [], nextMessageIndex: 0, recap }, "INVALID_RECAP_SEQUENCE");
	});
	it("rejects unknown recap type", () => {
		const recap = [{ eventSequence: 1, type: "unknown_type" }];
		decodeFail({ ...makeSnapshot(), cursor: 1, records: [], nextMessageIndex: 0, recap }, "INVALID_RECAP_TYPE");
	});
	it("rejects recap messageIndex missing for agent delta type", () => {
		const recap = [{ eventSequence: 1, type: "agent_text_delta" }];
		decodeFail(
			{ ...makeSnapshot(), cursor: 1, records: [], nextMessageIndex: 5, recap },
			"INVALID_RECAP_MESSAGE_INDEX",
		);
	});
	it("rejects recap messageIndex present for non-delta type", () => {
		const recap = [{ eventSequence: 1, type: "session_created", messageIndex: 0 }];
		decodeFail(
			{ ...makeSnapshot(), cursor: 1, records: [], nextMessageIndex: 5, recap },
			"INVALID_RECAP_MESSAGE_INDEX",
		);
	});
	it("accepts recap with exact messageIndex for agent_text_delta", () => {
		const recap = [{ eventSequence: 1, type: "agent_text_delta", messageIndex: 0 }];
		const r = decodeOk({
			...makeSnapshot(),
			cursor: 1,
			records: [{ ...makeSnapshot().records[0], index: 0 }],
			nextMessageIndex: 1,
			recap,
		});
		expect(r.recap.length).toBe(1);
		expect(r.recap[0].messageIndex).toBe(0);
	});

	// ---- Last failure ----
	it("rejects lastFailure with extra key", () => {
		decodeFail({ ...makeSnapshot(), lastFailure: { type: "none", extra: "x" } }, "INVALID_LAST_FAILURE");
	});
	it("accepts lastFailure error with known code", () => {
		decodeOk({ ...makeSnapshot(), lastFailure: { type: "error", code: "INTERNAL_ERROR" } });
	});
	it("rejects lastFailure error with unknown code", () => {
		decodeFail(
			{ ...makeSnapshot(), lastFailure: { type: "error", code: "INVALID_CODE_XYZ" } },
			"INVALID_LAST_FAILURE_CODE",
		);
	});
	it("rejects lastFailure error with empty code", () => {
		decodeFail({ ...makeSnapshot(), lastFailure: { type: "error", code: "" } }, "INVALID_LAST_FAILURE");
	});
	it("accepts all four lastFailure variants", () => {
		decodeOk({ ...makeSnapshot(), lastFailure: { type: "none" } });
		decodeOk({ ...makeSnapshot(), lastFailure: { type: "error", code: "BASH_FAILED" } });
		decodeOk({ ...makeSnapshot(), lastFailure: { type: "compact_failed" } });
		decodeOk({ ...makeSnapshot(), lastFailure: { type: "checkpoint_failed" } });
	});

	// ---- Bash ----
	it("rejects bash with missing required keys", () => {
		decodeFail({ ...makeSnapshot(), bash: { command: "ls", output: "", exitCode: 0 } }, "INVALID_BASH_STRUCTURE");
	});
	it("rejects bash with extra key", () => {
		decodeFail(
			{
				...makeSnapshot(),
				bash: { command: "ls", output: "", exitCode: null, cancelled: false, truncated: false, extra: "x" },
			},
			"INVALID_BASH_STRUCTURE",
		);
	});
	it("accepts bash null or valid", () => {
		decodeOk({ ...makeSnapshot(), bash: null });
		decodeOk({
			...makeSnapshot(),
			bash: { command: "ls", output: "", exitCode: null, cancelled: false, truncated: false },
		});
	});
	it("accepts agentRunning with bash running (exitCode=null)", () => {
		decodeOk({
			...makeSnapshot(),
			agentRunning: true,
			bash: { command: "ls", output: "", exitCode: null, cancelled: false, truncated: false },
		});
	});

	// ---- Compact/checkpoint mutual exclusion ----
	it("rejects compacting and checkpointing both true", () => {
		decodeFail({ ...makeSnapshot(), compacting: true, checkpointing: true }, "INVALID_ACTIVITY_STATE");
	});

	// ---- Accessor/rejection tests ----
	it("rejects input with accessor property", () => {
		const raw: Record<string, unknown> = { ...makeSnapshot() };
		Object.defineProperty(raw, "malicious", { get: () => "x", enumerable: true });
		decodeFail(raw, "OVERFLOW_BYTES");
	});
	it("rejects input with symbol key", () => {
		const raw: Record<string, unknown> = { ...makeSnapshot() };
		Object.defineProperty(raw, Symbol("hidden"), { value: "x", enumerable: true });
		decodeFail(raw, "OVERFLOW_BYTES");
	});
	it("rejects input with non-plain prototype", () => {
		const raw: Record<string, unknown> = { ...makeSnapshot() };
		Object.setPrototypeOf(raw, { malicious: true });
		decodeFail(raw, "OVERFLOW_BYTES");
	});

	// ---- Plain array edge cases ----
	it("rejects array with own foo key", () => {
		const arr: unknown[] = [...makeSnapshot().records];
		(arr as any).foo = "bar";
		decodeFail({ ...makeSnapshot(), records: arr }, "INVALID_RECORD_STRUCTURE");
	});
	it("rejects array with own-undefined element", () => {
		const arr: unknown[] = [...makeSnapshot().records];
		Object.defineProperty(arr, 0, { value: undefined, enumerable: true, configurable: true, writable: true });
		decodeFail({ ...makeSnapshot(), records: arr }, "OVERFLOW_BYTES");
	});
	it("rejects array with nonenumerable numeric element", () => {
		const arr: unknown[] = [...makeSnapshot().records];
		Object.defineProperty(arr, 0, { value: arr[0], enumerable: false });
		decodeFail({ ...makeSnapshot(), records: arr }, "INVALID_RECORD_STRUCTURE");
	});

	// ---- String overflow ----
	it("rejects record text over 100k chars", () => {
		const recs = [makeSnapshot().records[0]];
		recs[0] = { ...recs[0], text: "x".repeat(100_001) };
		decodeFail({ ...makeSnapshot(), nextMessageIndex: 1, records: recs }, "STRING_OVERFLOW");
	});

	// ---- Cross-field safe integer ----
	it("rejects non-safe-integer cursor", () => {
		decodeFail({ ...makeSnapshot(), cursor: Number.MAX_SAFE_INTEGER + 1 }, "INVALID_CURSOR");
	});
	it("rejects negative nextMessageIndex", () => {
		decodeFail({ ...makeSnapshot(), nextMessageIndex: -1 }, "INVALID_NEXT_MESSAGE_INDEX");
	});

	// ---- Nonzero next index with empty retained window ----
	it("accepts nonzero nextMessageIndex with empty records (retained window evicted)", () => {
		const r = decodeOk({ ...makeSnapshot(), nextMessageIndex: 10, records: [] });
		expect(r.nextMessageIndex).toBe(10);
		expect(r.records.length).toBe(0);
	});

	// ---- Budget tests ----
	it("accepts exactly 200 record snapshot (306 containers, within budget)", () => {
		const records = Array.from({ length: 200 }, (_, i) => ({
			index: i,
			text: "x",
			thinking: "",
			toolCallText: "",
			emittedAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			textTruncated: false,
			thinkingTruncated: false,
			toolCallTruncated: false,
		}));
		const recap = Array.from({ length: 100 }, (_, i) => ({
			eventSequence: i + 1,
			type: "session_created" as const,
		}));
		const r = decodeRemoteObservationSnapshotV1(
			{ ...makeSnapshot(), nextMessageIndex: 200, records, cursor: 100, recap },
			IDENTITY,
		);
		expect(r.success).toBe(true);
	});
	it("rejects 2001+ container objects (breadth overflow)", () => {
		const records = Array.from({ length: 2001 }, () => ({}));
		decodeFail({ ...makeSnapshot(), records, nextMessageIndex: 0, recap: [] }, "OVERFLOW_NODES");
	});
	it("rejects deeply nested object (depth overflow)", () => {
		const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } };
		decodeFail(
			{
				...makeSnapshot(),
				records: [
					{
						index: 0,
						text: deep as any,
						thinking: "",
						toolCallText: "",
						emittedAt: "2025-01-01T00:00:00.000Z",
						updatedAt: "2025-01-01T00:00:00.000Z",
						textTruncated: false,
						thinkingTruncated: false,
						toolCallTruncated: false,
					},
				],
				nextMessageIndex: 1,
				recap: [],
			},
			"OVERFLOW_DEPTH",
		);
	});
	it("rejects cyclic reference (caught by shared jsonPreflight as overflow)", () => {
		const raw: Record<string, unknown> = { ...makeSnapshot(), records: [], recap: [] };
		raw.cycle = raw;
		decodeFail(raw, "OVERFLOW_BYTES");
	});
	it("rejects byte overflow (200 records x 100KB text = 20MB > 1 MiB)", () => {
		const records = Array.from({ length: 200 }, (_, i) => ({
			index: i,
			text: "x".repeat(100_000),
			thinking: "",
			toolCallText: "",
			emittedAt: "2025-01-01T00:00:00.000Z",
			updatedAt: "2025-01-01T00:00:00.000Z",
			textTruncated: false,
			thinkingTruncated: false,
			toolCallTruncated: false,
		}));
		const recap = Array.from({ length: 100 }, (_, i) => ({
			eventSequence: i + 1,
			type: "session_created" as const,
		}));
		decodeFail({ ...makeSnapshot(), nextMessageIndex: 200, records, cursor: 100, recap }, "OVERFLOW_BYTES");
	});

	// ---- Session state ----
	it("rejects invalid sessionState", () => {
		decodeFail({ ...makeSnapshot(), sessionState: "invalid" }, "INVALID_SESSION_STATE");
	});
	it("accepts null sessionState", () => {
		decodeOk({ ...makeSnapshot(), sessionState: null });
	});
});

describe("B11-b: RemoteObservationMirror.fromSnapshot restore", () => {
	it("fromSnapshot roundtrips through captureSnapshot", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hello" });
		ingestAccepted(m, 4, "agent_end", { messages: 1 });
		ingestAccepted(m, 5, "bash_start", { command: "ls" });
		ingestAccepted(m, 6, "bash_delta", { text: "file1\nfile2\n" });
		ingestAccepted(m, 7, "bash_end", { exitCode: 0, cancelled: false, truncated: false });

		const snap = m.captureSnapshot();
		const json = JSON.stringify(snap);
		const parsed = JSON.parse(json);

		const restored = RemoteObservationMirror.fromSnapshot(parsed, IDENTITY);
		expect(restored.success).toBe(true);
		if (!restored.success) return;
		const m2 = restored.mirror;

		expect(m2.identity).toEqual({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
		expect(m2.currentCursor).toBe(7);
		expect(m2.getRecord(0)?.text).toBe("hello");
		expect(m2.currentNextMessageIndex).toBe(1);
		expect(m2.currentBash?.command).toBe("ls");
		expect(m2.currentBash?.exitCode).toBe(0);
		expect(m2.agentRunningVal).toBe(false);
		expect(m2.msgCountVal).toBe(1);
		expect(m2.recapEntries.length).toBe(7);
		expect(m2.hasGapFlag).toBe(false);
		expect(m2.lastFailureValue).toEqual({ type: "none" });
	});

	it("fromSnapshot restores gap flags", () => {
		const snap = { ...makeSnapshot(), hasGap: true, needsReplay: true };
		const parsed = JSON.parse(JSON.stringify(snap));
		const restored = RemoteObservationMirror.fromSnapshot(parsed, IDENTITY);
		expect(restored.success).toBe(true);
		if (!restored.success) return;
		expect(restored.mirror.hasGapFlag).toBe(true);
		expect(restored.mirror.needsReplayFlag).toBe(true);
	});

	it("fromSnapshot restores lastFailure markers with known error codes", () => {
		const snap1 = { ...makeSnapshot(), lastFailure: { type: "error", code: "BASH_FAILED" } };
		const r1 = RemoteObservationMirror.fromSnapshot(JSON.parse(JSON.stringify(snap1)), IDENTITY);
		expect(r1.success).toBe(true);
		if (!r1.success) return;
		expect(r1.mirror.lastFailureValue).toEqual({ type: "error", code: "BASH_FAILED" });

		const snap2 = { ...makeSnapshot(), lastFailure: { type: "compact_failed" } };
		const r2 = RemoteObservationMirror.fromSnapshot(JSON.parse(JSON.stringify(snap2)), IDENTITY);
		expect(r2.success).toBe(true);
		if (!r2.success) return;
		expect(r2.mirror.lastFailureValue).toEqual({ type: "compact_failed" });
	});

	it("fromSnapshot rejects identity mismatch", () => {
		const snap = { ...makeSnapshot(), hostId: "wrong" };
		const r = RemoteObservationMirror.fromSnapshot(snap, IDENTITY);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.code).toBe("IDENTITY_MISMATCH");
	});

	it("fromSnapshot rejects corrupt input", () => {
		const r = RemoteObservationMirror.fromSnapshot(null, IDENTITY);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.code).toBe("NOT_AN_OBJECT");
	});

	it("fromSnapshot restores truncated records", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		for (let i = 0; i < 2; i++) {
			ingestAccepted(m, 3 + i, "agent_text_delta", { index: 0, text: "x".repeat(50_000) });
		}
		ingestAccepted(m, 5, "agent_text_delta", { index: 0, text: "y" });
		ingestAccepted(m, 6, "agent_end", { messages: 1 });
		const snap = m.captureSnapshot();
		expect(snap.records[0].textTruncated).toBe(true);
		expect(snap.records[0].text.length).toBe(100_000);

		const parsed = JSON.parse(JSON.stringify(snap));
		const restored = RemoteObservationMirror.fromSnapshot(parsed, IDENTITY);
		if (!restored.success) throw new Error(`fromSnapshot failed: ${restored.code}`);
		expect(restored.mirror.getRecord(0)?.textTruncated).toBe(true);
		expect(restored.mirror.getRecord(0)?.text.length).toBe(100_000);
	});

	it("fromSnapshot restores agent running with bash running (exitCode=null)", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "bash_start", { command: "sleep" });
		// Agent is running while bash is running (exitCode=null)
		const snap = m.captureSnapshot();
		expect(snap.agentRunning).toBe(true);
		expect(snap.bash).not.toBeNull();
		expect(snap.bash!.exitCode).toBeNull();

		const parsed = JSON.parse(JSON.stringify(snap));
		const restored = RemoteObservationMirror.fromSnapshot(parsed, IDENTITY);
		if (!restored.success) throw new Error(`fromSnapshot failed: ${restored.code}`);
		expect(restored.mirror.agentRunningVal).toBe(true);
		expect(restored.mirror.currentBash?.exitCode).toBeNull();
	});

	it("fromSnapshot does not alias input arrays", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "agent_start");
		ingestAccepted(m, 3, "agent_text_delta", { index: 0, text: "hi" });
		ingestAccepted(m, 4, "agent_end", { messages: 1 });
		const snap = m.captureSnapshot();
		const json = JSON.parse(JSON.stringify(snap));
		const restored = RemoteObservationMirror.fromSnapshot(json, IDENTITY);
		if (!restored.success) throw new Error(`fromSnapshot failed: ${restored.code}`);
		// Mutating the input should not affect the restored mirror
		json.records[0].text = "mutated";
		expect(restored.mirror.getRecord(0)?.text).toBe("hi");
	});

	it("fromSnapshot restores empty mirror (no events)", () => {
		const m = mirror();
		const snap = m.captureSnapshot();
		const json = JSON.stringify(snap);
		const parsed = JSON.parse(json);
		const restored = RemoteObservationMirror.fromSnapshot(parsed, IDENTITY);
		expect(restored.success).toBe(true);
		if (!restored.success) return;
		expect(restored.mirror.currentCursor).toBe(0);
		expect(restored.mirror.currentNextMessageIndex).toBe(0);
		expect(restored.mirror.transcriptRecordCount).toBe(0);
		expect(restored.mirror.recapEntries.length).toBe(0);
	});
});

describe("B11-b: sessionState and bash null roundtrip", () => {
	it("captures and restores sessionState null", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const snap = m.captureSnapshot();
		expect(snap.sessionState).toBeNull();
		const json = JSON.parse(JSON.stringify(snap));
		const decoded = decodeOk(json);
		expect(decoded.sessionState).toBeNull();
	});
	it("captures and restores bash null", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		const snap = m.captureSnapshot();
		expect(snap.bash).toBeNull();
		const json = JSON.parse(JSON.stringify(snap));
		const decoded = decodeOk(json);
		expect(decoded.bash).toBeNull();
	});
	it("exported KNOWN_ERR_CODES includes expected codes", () => {
		expect(KNOWN_ERR_CODES.has("INTERNAL_ERROR")).toBe(true);
		expect(KNOWN_ERR_CODES.has("BASH_FAILED")).toBe(true);
		expect(KNOWN_ERR_CODES.has("UNKNOWN")).toBe(true);
		expect(KNOWN_ERR_CODES.has("INVALID" as any)).toBe(false);
	});
});
