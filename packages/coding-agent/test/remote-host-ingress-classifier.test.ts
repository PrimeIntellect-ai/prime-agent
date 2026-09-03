/**
 * Tests for remote-host ingress classifier.
 *
 * Covers every frame subtype (handshake, handshake_ack, command, event,
 * ack, agent_message, provider_proxy [5 subtypes], health, error) on
 * both home and sandbox sides, plus hostile envelopes.
 *
 * No ACK generation, relay call, error reflection, or journal mutation.
 */

import { describe, expect, it } from "vitest";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { classifyIngress, type IngressClassification } from "../src/modes/daemon/remote-host-ingress-classifier.js";

// ===========================================================================
// Helpers
// ===========================================================================

const TS = "2025-01-01T00:00:00.000Z";

function makeEnvelope(frame: unknown, overrides?: Record<string, unknown>): Record<string, unknown> {
	return {
		type: "frame",
		frameId: "f-test-001",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: TS,
		frame,
		...overrides,
	};
}

// ===========================================================================
// Helpers to classify and unwrap
// ===========================================================================

function classifyHome(raw: unknown): IngressClassification {
	return classifyIngress("home", raw);
}

function classifySandbox(raw: unknown): IngressClassification {
	return classifyIngress("sandbox", raw);
}

function expectRelay(result: IngressClassification): void {
	expect(result).toHaveProperty("category", "relay");
	expect(result).toHaveProperty("action", "receive");
}

function expectControl(result: IngressClassification): void {
	expect(result).toHaveProperty("category", "control");
}

function expectInvalidDirection(result: IngressClassification): void {
	expect(result).toHaveProperty("category", "invalid-direction");
	expect(result).not.toHaveProperty("envelope");
}

function expectCodecError(result: IngressClassification): void {
	expect(result).toHaveProperty("category", "codec-error");
	expect(result).not.toHaveProperty("envelope");
}

// ===========================================================================
// Tests
// ===========================================================================

// ---- Handshake ----

describe("handshake frames", () => {
	const handshake: Record<string, unknown> = {
		type: "handshake",
		direction: "host_to_home",
		hostId: "host-abc",
		generation: "gen-001",
		capabilities: ["session_commands", "sequenced_events"],
		runtime: { buildId: "b1", daemonProtocolVersion: 1, daemonSchemaRevision: 1 },
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
	};

	const env = makeEnvelope(handshake);

	it("classifies handshake as control on home side", () => {
		const r = classifyHome(env);
		expectControl(r);
		if (r.category === "control") {
			expect(r.envelope.frame.type).toBe("handshake");
		}
	});

	it("classifies handshake as control on sandbox side", () => {
		const r = classifySandbox(env);
		expectControl(r);
		if (r.category === "control") {
			expect(r.envelope.frame.type).toBe("handshake");
		}
	});

	it("classifies handshake_ack as control on home side", () => {
		const env2 = makeEnvelope({
			type: "handshake_ack",
			hostId: "host-abc",
			sessionId: "sess-001",
			protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
			accepted: true,
			capabilities: ["session_commands"],
			linkId: "link-001",
			remoteBuildIdentity: { buildId: "b1", daemonProtocolVersion: 1, daemonSchemaRevision: 1 },
		});
		const r = classifyHome(env2);
		expectControl(r);
	});

	it("classifies handshake_ack as control on sandbox side", () => {
		const env2 = makeEnvelope({
			type: "handshake_ack",
			hostId: "host-abc",
			sessionId: "sess-001",
			protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
			accepted: true,
			capabilities: ["session_commands"],
			linkId: "link-001",
			remoteBuildIdentity: { buildId: "b1", daemonProtocolVersion: 1, daemonSchemaRevision: 1 },
		});
		const r = classifySandbox(env2);
		expectControl(r);
	});
});

// ---- Health ----

describe("health frames", () => {
	it("classifies health as control on home side", () => {
		const env = makeEnvelope({ type: "health", healthSeq: 1, status: "connected" });
		const r = classifyHome(env);
		expectControl(r);
	});

	it("classifies health as control on sandbox side", () => {
		const env = makeEnvelope({ type: "health", healthSeq: 1, status: "connected" });
		const r = classifySandbox(env);
		expectControl(r);
	});
});

// ---- Error ----

describe("error frames", () => {
	it("classifies error as control on home side", () => {
		const env = makeEnvelope({ type: "error", code: "ERR", message: "test error" });
		const r = classifyHome(env);
		expectControl(r);
	});

	it("classifies error as control on sandbox side", () => {
		const env = makeEnvelope({ type: "error", code: "ERR", message: "test error" });
		const r = classifySandbox(env);
		expectControl(r);
	});
});

// ---- ACK (relay.receive) ----

describe("ack frames — relay.receive", () => {
	const ackFrame = { type: "ack", ackId: "ack-001", acknowledges: "f-000", status: "delivered" };

	it("classifies ack as relay.receive on home side", () => {
		const env = makeEnvelope(ackFrame);
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("classifies ack as relay.receive on sandbox side", () => {
		const env = makeEnvelope(ackFrame);
		const r = classifySandbox(env);
		expectRelay(r);
	});

	it("preserves envelope on relay.receive", () => {
		const env = makeEnvelope(ackFrame, { frameId: "f-test-relay" });
		const r = classifyHome(env);
		if (r.category === "relay") {
			expect(r.envelope.frameId).toBe("f-test-relay");
		}
	});
});

// ---- Event (home only) ----

describe("event frames — home accepts as relay.receive, sandbox rejects", () => {
	const eventFrame: Record<string, unknown> = {
		type: "event",
		id: "evt-001",
		sequence: 1,
		cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 },
		emittedAt: TS,
		body: { type: "session_created", sessionId: "sess-001", workspaceId: "ws-001" },
	};

	it("classifies event as relay.receive on home side", () => {
		const env = makeEnvelope(eventFrame);
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("classifies event as invalid-direction on sandbox side", () => {
		const env = makeEnvelope(eventFrame);
		const r = classifySandbox(env);
		expectInvalidDirection(r);
	});
});

// ---- Command (sandbox only) ----

describe("command frames — sandbox accepts as relay.receive, home rejects", () => {
	const commandFrame: Record<string, unknown> = {
		type: "command",
		commandId: "cmd-001",
		body: { type: "create_session", workspaceId: "ws-001" },
	};

	it("classifies command as relay.receive on sandbox side", () => {
		const env = makeEnvelope(commandFrame);
		const r = classifySandbox(env);
		expectRelay(r);
	});

	it("classifies command as invalid-direction on home side", () => {
		const env = makeEnvelope(commandFrame);
		const r = classifyHome(env);
		expectInvalidDirection(r);
	});
});

// ---- AgentMessage (both sides) ----

describe("agent_message frames — both sides accept as relay.receive", () => {
	const agentMsgFrame: Record<string, unknown> = {
		type: "agent_message",
		id: "am-001",
		fromActiveSessionId: "sess-a",
		targetActiveSessionId: "sess-b",
		message: "hello",
		deliveryMode: "direct",
	};

	it("classifies agent_message as relay.receive on home side", () => {
		const env = makeEnvelope(agentMsgFrame);
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("classifies agent_message as relay.receive on sandbox side", () => {
		const env = makeEnvelope(agentMsgFrame);
		const r = classifySandbox(env);
		expectRelay(r);
	});
});

// ---- ProviderProxy (home: request/cancel only; sandbox: chunk/complete/error only) ----

describe("provider_proxy request/cancel — home accepts, sandbox rejects", () => {
	it("home accepts model_call_request as relay.receive", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-001",
			provider: "anthropic",
			model: "claude-3",
			messages: [{ role: "user", content: "hi" }],
		});
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("sandbox rejects model_call_request (invalid-direction)", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-001",
			provider: "anthropic",
			model: "claude-3",
			messages: [{ role: "user", content: "hi" }],
		});
		const r = classifySandbox(env);
		expectInvalidDirection(r);
	});

	it("home accepts model_call_cancel as relay.receive", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_cancel",
			callId: "call-001",
		});
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("sandbox rejects model_call_cancel (invalid-direction)", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_cancel",
			callId: "call-001",
		});
		const r = classifySandbox(env);
		expectInvalidDirection(r);
	});
});

describe("provider_proxy chunk/complete/error — sandbox accepts, home rejects", () => {
	it("sandbox accepts model_call_chunk as relay.receive", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_chunk",
			callId: "call-001",
			index: 0,
			delta: { text: "hello" },
		});
		const r = classifySandbox(env);
		expectRelay(r);
	});

	it("home rejects model_call_chunk (invalid-direction)", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_chunk",
			callId: "call-001",
			index: 0,
			delta: { text: "hello" },
		});
		const r = classifyHome(env);
		expectInvalidDirection(r);
	});

	it("sandbox accepts model_call_complete as relay.receive", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-001",
			result: { text: "done" },
		});
		const r = classifySandbox(env);
		expectRelay(r);
	});

	it("home rejects model_call_complete (invalid-direction)", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-001",
			result: { text: "done" },
		});
		const r = classifyHome(env);
		expectInvalidDirection(r);
	});

	it("sandbox accepts model_call_error as relay.receive", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_error",
			callId: "call-001",
			error: "something went wrong",
		});
		const r = classifySandbox(env);
		expectRelay(r);
	});

	it("home rejects model_call_error (invalid-direction)", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_error",
			callId: "call-001",
			error: "something went wrong",
		});
		const r = classifyHome(env);
		expectInvalidDirection(r);
	});
});

// ---- Codec validation errors ----

describe("codec validation — envelope errors", () => {
	it("rejects null input", () => {
		const r = classifyHome(null);
		expectCodecError(r);
	});

	it("rejects undefined input", () => {
		const r = classifyHome(undefined);
		expectCodecError(r);
	});

	it("rejects number input", () => {
		const r = classifyHome(42);
		expectCodecError(r);
	});

	it("rejects string input", () => {
		const r = classifyHome("not-an-envelope");
		expectCodecError(r);
	});

	it("rejects array input", () => {
		const r = classifyHome([1, 2, 3]);
		expectCodecError(r);
	});

	it("rejects envelope with missing type field", () => {
		const r = classifyHome({ frameId: "f-001", protocol: {}, sentAt: TS, frame: {} });
		expectCodecError(r);
	});

	it("rejects envelope with wrong type field", () => {
		const r = classifyHome({ type: "not-frame", frameId: "f-001", protocol: {}, sentAt: TS, frame: {} });
		expectCodecError(r);
	});

	it("rejects envelope with missing frameId", () => {
		const r = classifyHome({
			type: "frame",
			protocol: {},
			sentAt: TS,
			frame: { type: "ack", ackId: "a", acknowledges: "b", status: "delivered" },
		});
		expectCodecError(r);
	});

	it("rejects envelope with missing protocol", () => {
		const r = classifyHome({
			type: "frame",
			frameId: "f-001",
			sentAt: TS,
			frame: { type: "ack", ackId: "a", acknowledges: "b", status: "delivered" },
		});
		expectCodecError(r);
	});

	it("rejects envelope with wrong protocol name", () => {
		const r = classifyHome(
			makeEnvelope(
				{ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" },
				{ protocol: { name: "wrong", version: 1 } },
			),
		);
		expectCodecError(r);
	});

	it("rejects envelope with invalid sentAt", () => {
		const r = classifyHome(
			makeEnvelope(
				{ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" },
				{ sentAt: "not-a-timestamp" },
			),
		);
		expectCodecError(r);
	});

	it("rejects envelope with missing frame", () => {
		const r = classifyHome({
			type: "frame",
			frameId: "f-001",
			protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
			sentAt: TS,
		});
		expectCodecError(r);
	});

	it("rejects envelope with unknown envelope field", () => {
		const env: Record<string, unknown> = makeEnvelope({
			type: "ack",
			ackId: "a",
			acknowledges: "b",
			status: "delivered",
		});
		env.unknownField = "should-be-rejected";
		const r = classifyHome(env);
		expectCodecError(r);
	});
});

describe("codec validation — frame errors", () => {
	it("rejects frame with unknown type string", () => {
		const env = makeEnvelope({ type: "nonexistent_frame_type" });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("rejects frame with missing type field", () => {
		const env = makeEnvelope({ ackId: "a", acknowledges: "b", status: "delivered" });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("rejects malformed ack frame", () => {
		const env = makeEnvelope({ type: "ack", ackId: "", acknowledges: "b", status: "delivered" });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("rejects handshake with missing fields", () => {
		const env = makeEnvelope({ type: "handshake", direction: "host_to_home" });
		const r = classifyHome(env);
		expectCodecError(r);
	});
});

// ---- Result frozenness ----

describe("result integrity — deeply frozen, no mutation", () => {
	it("returns a frozen result object", () => {
		const env = makeEnvelope({ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" });
		const r = classifyHome(env);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("envelope inside result is frozen", () => {
		const env = makeEnvelope({ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" });
		const r = classifyHome(env);
		if (r.category === "relay") {
			expect(Object.isFrozen(r.envelope)).toBe(true);
			expect(Object.isFrozen(r.envelope.frame)).toBe(true);
		}
	});

	it("codec error result is frozen", () => {
		const r = classifyHome(null);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("invalid-direction result is frozen", () => {
		const eventFrame: Record<string, unknown> = {
			type: "event",
			id: "evt-001",
			sequence: 1,
			cursor: { hostId: "h", generation: "g", sessionId: "s", sequence: 1 },
			emittedAt: TS,
			body: { type: "session_created", sessionId: "sess-001", workspaceId: "ws-001" },
		};
		const r = classifySandbox(makeEnvelope(eventFrame));
		expect(Object.isFrozen(r)).toBe(true);
	});
});

// ---- Hostile envelope shapes ----

describe("hostile envelopes", () => {
	it("rejects empty object", () => {
		const r = classifyHome({});
		expectCodecError(r);
	});

	it("rejects object with prototype pollution attempt", () => {
		const raw = JSON.parse(
			`{"type":"frame","frameId":"f-001","protocol":{"name":"${REMOTE_HOST_PROTOCOL_NAME}","version":${REMOTE_HOST_PROTOCOL_VERSION}},"sentAt":"${TS}","frame":{"type":"ack","ackId":"a","acknowledges":"b","status":"delivered"},"__proto__":{"polluted":1}}`,
		);
		const r = classifyHome(raw);
		expectCodecError(r);
	});

	it("rejects envelope with symbol keys (via codec)", () => {
		const env = makeEnvelope({ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" });
		const sym = Symbol("hidden");
		Object.defineProperty(env, sym, { value: "evil", enumerable: true });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("rejects nested prototype override", () => {
		const raw = JSON.parse(
			`{"type":"frame","frameId":"f-001","protocol":{"name":"${REMOTE_HOST_PROTOCOL_NAME}","version":${REMOTE_HOST_PROTOCOL_VERSION}},"sentAt":"${TS}","frame":{"type":"ack","ackId":"a","acknowledges":"b","status":"delivered"},"constructor":{"prototype":{"polluted":1}}}`,
		);
		const r = classifyHome(raw);
		expectCodecError(r);
	});

	it("rejects envelope with non-enumerable property", () => {
		const env = makeEnvelope({ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" });
		Object.defineProperty(env, "hidden", { value: "evil", enumerable: false });
		const r = classifyHome(env);
		expectCodecError(r);
	});
});

// ---- Edge cases ----

describe("edge cases", () => {
	it("handles very small valid ack", () => {
		const env = makeEnvelope({ type: "ack", ackId: "x", acknowledges: "y", status: "delivered" });
		const r = classifyHome(env);
		expectRelay(r);
	});

	it("both sides accept as relay.receive (identical agent_message frame)", () => {
		const am = {
			type: "agent_message",
			id: "am-001",
			fromActiveSessionId: "a",
			targetActiveSessionId: "b",
			message: "test",
		};
		const env = makeEnvelope(am);
		const r1 = classifyHome(env);
		const r2 = classifySandbox(env);
		expectRelay(r1);
		expectRelay(r2);
	});

	it("preserves envelope identity across classification (same fields)", () => {
		const env = makeEnvelope({ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" });
		const r = classifyHome(env);
		if (r.category === "relay") {
			expect(r.envelope.frameId).toBe("f-test-001");
			expect(r.envelope.frame.type).toBe("ack");
		}
	});

	it("handles oversized frameId that fails checkId", () => {
		const longId = "x".repeat(200);
		const env = makeEnvelope(
			{ type: "ack", ackId: "a", acknowledges: "b", status: "delivered" },
			{ frameId: longId },
		);
		const r = classifyHome(env);
		expectCodecError(r);
	});
});

// ---- Provider proxy subtype boundaries ----

describe("provider proxy subtype boundary tests", () => {
	it("home rejects provider_proxy with no proxyType", () => {
		const env = makeEnvelope({ type: "provider_proxy", callId: "call-001" });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("rejects provider_proxy with empty callId", () => {
		const env = makeEnvelope({
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "",
			provider: "a",
			model: "b",
			messages: [],
		});
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("home rejects provider_proxy with unknown proxyType", () => {
		const env = makeEnvelope({ type: "provider_proxy", proxyType: "invalid_type", callId: "call-001" });
		const r = classifyHome(env);
		expectCodecError(r);
	});

	it("sandbox rejects provider_proxy with unknown proxyType", () => {
		const env = makeEnvelope({ type: "provider_proxy", proxyType: "invalid_type", callId: "call-001" });
		const r = classifySandbox(env);
		expectCodecError(r);
	});
});
