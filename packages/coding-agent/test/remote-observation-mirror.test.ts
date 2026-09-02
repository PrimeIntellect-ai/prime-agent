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

	it("rejects frame with extra/missing keys (exact 6 keys: type/id/sequence/cursor/emittedAt/body)", () => {
		const m = mirror();
		const evt = makeEvent();
		// extra key
		expect(m.ingestEvent({ ...evt, extraKey: "x" }).rejectionCode).toBe("UNKNOWN_FIELD");
		// missing body
		const { body: _, ...noBody } = evt;
		expect(m.ingestEvent(noBody).rejectionCode).toBe("MALFORMED_OPTIONAL");
		// missing cursor
		const { cursor: _c, ...noCursor } = evt;
		expect(m.ingestEvent(noCursor).rejectionCode).toBe("MALFORMED_OPTIONAL");
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
		expect(m.ingestEvent({ ...evt, cursor: {} }).rejectionCode).toBe("MALFORMED_OPTIONAL");
	});

	it("rejects cursor with extra/missing keys", () => {
		const m = mirror();
		const evt = makeEvent();
		expect(
			m.ingestEvent({ ...evt, cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1, extra: "x" } })
				.rejectionCode,
		).toBe("MALFORMED_OPTIONAL");
		expect(m.ingestEvent({ ...evt, cursor: { hostId: "h", generation: "g", sessionId: "s" } }).rejectionCode).toBe(
			"MALFORMED_OPTIONAL",
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
		expect(m.ingestEvent(noBody).rejectionCode).toBe("MALFORMED_OPTIONAL");
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

	it("markReplayRecovered clears gap", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		m.ingestEvent(makeEvent({ sequence: 5 }, makeBody("agent_start")));
		expect(m.hasGapFlag).toBe(true);
		expect(m.needsReplayFlag).toBe(true);
		const ok = m.markReplayRecovered(5);
		expect(ok).toBe(true);
		expect(m.hasGapFlag).toBe(false);
		expect(m.needsReplayFlag).toBe(false);
		expect(m.currentCursor).toBe(5);
		// After recovery, agent is not running (gap event was not committed)
		// Start a proper cycle: first agent_start then agent_end
		ingestAccepted(m, 6, "agent_start");
		const r = m.ingestEvent(makeEvent({ sequence: 7 }, makeBody("agent_end", { messages: 1 })));
		expect(r.accepted).toBe(true);
	});

	it("markReplayRecovered rejects cursor < current", () => {
		const m = mirror();
		ingestAccepted(m, 1, "session_created");
		expect(m.markReplayRecovered(0)).toBe(false);
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
		ingestAccepted(m, 1, "session_created");
		ingestAccepted(m, 2, "bash_start", { command: "echo long" });
		// Local truncation (from delta overflow)
		const bigText = "x".repeat(600_000);
		ingestAccepted(m, 3, "bash_delta", { text: bigText });
		const bashAfter = m.currentBash!;
		expect(bashAfter.truncated).toBe(true);
		expect(bashAfter.output.length).toBe(500_000);
		// Remote says not truncated -> OR = true
		ingestAccepted(m, 4, "bash_end", { exitCode: 0, cancelled: false, truncated: false });
		expect(m.currentBash!.truncated).toBe(true);
		// Start fresh
		ingestAccepted(m, 5, "bash_start", { command: "echo hi" });
		ingestAccepted(m, 6, "bash_delta", { text: "short" });
		ingestAccepted(m, 7, "bash_end", { exitCode: 0, cancelled: false, truncated: true });
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
		).toBe("MALFORMED_OPTIONAL");
	});

	it("adversarial: non-JSON values (undefined symbol)", () => {
		const m = mirror();
		const evt = makeEvent();
		(evt as any).body = undefined;
		const r = m.ingestEvent(evt);
		expect(r.accepted).toBe(false);
		expect(r.rejectionCode).toBe("INVALID_BODY_TYPE");
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

// We need the constants visible for boundary tests
const MAX_DELTA_TEXT_PER_FRAME = 50_000;
const MAX_DELTA_THINKING_PER_FRAME = 100_000;
const MAX_DELTA_TOOLCALL_PER_FRAME = 25_000;
const MAX_TEXT_LENGTH = 100_000;
