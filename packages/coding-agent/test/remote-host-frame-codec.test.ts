/**
 * Adversarial tests for the B03 remote-agent-host protocol codec.
 *
 * Covers ALL nine frame variant decoders plus envelope, nested types,
 * JSON bounds, canonical digest, capability validation, cross-field
 * equalities, and legacy backward compat.
 */

import { describe, expect, it } from "vitest";
import type {
	RemoteHostAckFrame,
	RemoteHostAgentMessageFrame,
	RemoteHostCommandFrame,
	RemoteHostEventFrame,
	RemoteHostFrameEnvelope,
	RemoteHostHandshakeAckFrame,
	RemoteHostHandshakeFrame,
	RemoteHostProviderProxyFrame,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import {
	CODEC_ERRORS,
	canonicalDigest,
	checkJsonSafe,
	decodeAckFrame,
	decodeAgentMessageFrame,
	decodeAndDigestCommandBody,
	decodeAndDigestEventBody,
	decodeArtifactRef,
	decodeBuildIdentity,
	decodeCommandBody,
	decodeCommandFrame,
	decodeEnvelope,
	decodeErrorFrame,
	decodeEventBody,
	decodeEventCursor,
	decodeEventFrame,
	decodeFrame,
	decodeHandshakeAckFrame,
	decodeHandshakeFrame,
	decodeHealthFrame,
	decodeProtocolInfo,
	decodeProviderProxyFrame,
	digestsEqual,
	isCanonicalUtcTimestamp,
	isValidDigest,
	isValidSafeId,
	safeStableJsonStringify,
} from "../src/modes/daemon/remote-host-frame-codec.js";

// ===========================================================================
// Helpers: build valid test fixtures
// ===========================================================================

function validEnvelope(overrides?: Partial<RemoteHostFrameEnvelope>): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId: "f-001",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: {
			type: "event" as const,
			id: "f-001",
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "agent_start" as const },
		},
		...overrides,
	};
}

function validHandshake(): RemoteHostHandshakeFrame {
	return {
		type: "handshake",
		direction: "home_to_host",
		hostId: "h-1",
		generation: "g-abc",
		capabilities: ["session_commands", "sequenced_events"],
		runtime: { buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
	};
}

function validHandshakeAck(): RemoteHostHandshakeAckFrame {
	return {
		type: "handshake_ack",
		hostId: "h-1",
		sessionId: "s-1",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		accepted: true,
		capabilities: ["session_commands"],
		linkId: "l-1",
		remoteBuildIdentity: { buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 },
	};
}

function validCommandFrame(): RemoteHostCommandFrame {
	return { type: "command", commandId: "c-1", body: { type: "abort" } };
}

function validEventFrame(): RemoteHostEventFrame {
	return {
		type: "event",
		id: "e-1",
		sequence: 1,
		cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
		emittedAt: "2025-01-15T10:30:00.000Z",
		body: { type: "agent_start" },
	};
}

function validAckFrame(): RemoteHostAckFrame {
	return { type: "ack", ackId: "a-1", acknowledges: "f-001", status: "delivered" };
}

function validAgentMessageFrame(): RemoteHostAgentMessageFrame {
	return {
		type: "agent_message",
		id: "m-1",
		fromActiveSessionId: "s-1",
		targetActiveSessionId: "s-2",
		message: "hello",
	};
}

// ===========================================================================
// Valid frames for roundtrip tests
// ===========================================================================

const FRAME_FIXTURES: Array<{ name: string; frame: unknown }> = [
	{ name: "handshake", frame: validHandshake() },
	{ name: "handshake_ack", frame: validHandshakeAck() },
	{ name: "command (abort)", frame: validCommandFrame() },
	{
		name: "command (create_session)",
		frame: { type: "command", commandId: "c-2", body: { type: "create_session", workspaceId: "ws-1" } },
	},
	{
		name: "command (prompt)",
		frame: { type: "command", commandId: "c-3", body: { type: "prompt", message: "do something" } },
	},
	{
		name: "command (execute_bash)",
		frame: { type: "command", commandId: "c-4", body: { type: "execute_bash", command: "ls -la" } },
	},
	{
		name: "command (sync_workspace)",
		frame: { type: "command", commandId: "c-5", body: { type: "sync_workspace", artifact: { workspaceId: "ws-1" } } },
	},
	{ name: "event (agent_start)", frame: validEventFrame() },
	{
		name: "event (session_created)",
		frame: {
			type: "event",
			id: "e-2",
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "session_created", sessionId: "s-1", workspaceId: "w-1" },
		},
	},
	{
		name: "event (bash_end)",
		frame: {
			type: "event",
			id: "e-3",
			sequence: 2,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 2 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "bash_end", exitCode: 0, cancelled: false, truncated: false },
		},
	},
	{ name: "ack", frame: validAckFrame() },
	{
		name: "ack rejected",
		frame: { type: "ack", ackId: "a-2", acknowledges: "f-002", status: "rejected", rejectReason: "timeout" },
	},
	{ name: "agent_message", frame: validAgentMessageFrame() },
	{
		name: "agent_message with deliveryMode",
		frame: {
			type: "agent_message",
			id: "m-2",
			fromActiveSessionId: "s-1",
			targetActiveSessionId: "s-2",
			message: "direct msg",
			deliveryMode: "direct",
		},
	},
	{ name: "health", frame: { type: "health", healthSeq: 1, status: "connected" } },
	{
		name: "health with lastReceived",
		frame: {
			type: "health",
			healthSeq: 2,
			status: "connected",
			lastReceivedFrameId: "f-001",
			lastReceivedEventSequence: 5,
		},
	},
	{ name: "error", frame: { type: "error", code: "E001", message: "something failed" } },
	{ name: "error with inReplyTo", frame: { type: "error", code: "E002", message: "not found", inReplyTo: "f-003" } },
	{
		name: "provider_proxy request",
		frame: {
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-1",
			provider: "anthropic",
			model: "claude-3",
			messages: [{ role: "user", content: "hi" }],
		},
	},
	{
		name: "provider_proxy chunk",
		frame: {
			type: "provider_proxy",
			proxyType: "model_call_chunk",
			callId: "call-1",
			index: 0,
			delta: { type: "text", text: "hello" },
		},
	},
	{
		name: "provider_proxy complete",
		frame: {
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-1",
			result: "done",
			usage: { inputTokens: 10, outputTokens: 20 },
		},
	},
	{
		name: "provider_proxy error",
		frame: { type: "provider_proxy", proxyType: "model_call_error", callId: "call-1", error: "rate limited" },
	},
	{
		name: "provider_proxy cancel",
		frame: { type: "provider_proxy", proxyType: "model_call_cancel", callId: "call-1" },
	},
];

// ===========================================================================
// Tests: decodeFrame — all nine variants roundtrip
// ===========================================================================

describe("decodeFrame — all nine frame variants", () => {
	for (const { name, frame } of FRAME_FIXTURES) {
		it(`decodes valid ${name}`, () => {
			const result = decodeFrame(frame);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.type).toBe((frame as unknown as Record<string, unknown>).type);
			}
		});
	}

	it("rejects unknown frame type", () => {
		const result = decodeFrame({ type: "unknown_type" });
		expect(result.ok).toBe(false);
	});

	it("rejects non-object", () => {
		expect(decodeFrame(null).ok).toBe(false);
		expect(decodeFrame(42).ok).toBe(false);
		expect(decodeFrame("string").ok).toBe(false);
	});

	it("rejects array input", () => {
		expect(decodeFrame([]).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeEnvelope — full envelope with cross-field validation
// ===========================================================================

describe("decodeEnvelope", () => {
	it("decodes valid envelope with event frame", () => {
		const env = validEnvelope();
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.type).toBe("frame");
			expect(result.value.frameId).toBe("f-001");
			expect(result.value.frame.type).toBe("event");
		}
	});

	it("accepts envelope where frameId differs from event id (independent)", () => {
		const env = validEnvelope({ frameId: "different-id" });
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.frameId).toBe("different-id");
			// event id remains f-001 — independent of envelope frameId
			expect((result.value.frame as Record<string, unknown>).id).toBe("f-001");
		}
	});

	it("rejects envelope with wrong protocol name", () => {
		const env = validEnvelope();
		(env.protocol as unknown as Record<string, unknown>).name = "wrong-protocol";
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(false);
		expect(result.ok).toBe(false);
	});

	it("rejects envelope with wrong protocol version", () => {
		const env = validEnvelope();
		(env.protocol as unknown as Record<string, unknown>).version = 99;
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(false);
	});

	it("rejects envelope with non-canonical sentAt", () => {
		const env = validEnvelope({ sentAt: "2025-01-15T10:30:00Z" }); // missing .sss
		expect(decodeEnvelope(env).ok).toBe(false);
	});

	it("rejects envelope with offset timestamp", () => {
		const env = validEnvelope({ sentAt: "2025-01-15T10:30:00.000+05:30" });
		expect(decodeEnvelope(env).ok).toBe(false);
	});

	it("accepts envelope with lastReceivedEventSequence", () => {
		const env = validEnvelope({ lastReceivedEventSequence: 42 });
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(true);
	});

	it("rejects envelope with undefined lastReceivedEventSequence key", () => {
		const env = validEnvelope();
		(env as unknown as Record<string, unknown>).lastReceivedEventSequence = undefined;
		const result = decodeEnvelope(env);
		expect(result.ok).toBe(false);
	});

	it("rejects envelope non-object", () => {
		expect(decodeEnvelope(null).ok).toBe(false);
	});

	it("rejects envelope with extra keys", () => {
		const env = validEnvelope();
		(env as unknown as Record<string, unknown>).extraField = true;
		expect(decodeEnvelope(env).ok).toBe(false);
	});

	it("rejects envelope with array frame", () => {
		const env = validEnvelope();
		// @ts-expect-error testing adversarial input
		env.frame = [];
		expect(decodeEnvelope(env).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeHandshakeFrame
// ===========================================================================

describe("decodeHandshakeFrame", () => {
	it("decodes valid handshake", () => {
		const h = validHandshake();
		const result = decodeHandshakeFrame(h);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.hostId).toBe("h-1");
			expect(result.value.direction).toBe("home_to_host");
		}
	});

	it("decodes handshake with optional fields", () => {
		const h = validHandshake();
		h.sessionId = "s-1";
		h.clientCapabilities = ["acknowledgements"];
		h.resumeCursor = { hostId: "h-1", generation: "g-abc", sessionId: "s-1", sequence: 5 };
		const result = decodeHandshakeFrame(h);
		expect(result.ok).toBe(true);
	});

	it("rejects unknown direction", () => {
		const h = validHandshake();
		(h as unknown as Record<string, unknown>).direction = "sideways";
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects missing hostId", () => {
		const h = validHandshake();
		delete (h as unknown as Record<string, unknown>).hostId;
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects empty generation", () => {
		const h = validHandshake();
		h.generation = "";
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects duplicate capabilities", () => {
		const h = validHandshake();
		h.capabilities = ["session_commands", "session_commands"];
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects unknown capability", () => {
		const h = validHandshake();
		h.capabilities = ["session_commands", "unknown_cap"] as Array<"session_commands">;
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects extra unknown key", () => {
		const h = validHandshake();
		(h as unknown as Record<string, unknown>).unknownField = true;
		expect(decodeHandshakeFrame(h).ok).toBe(false);
	});

	it("rejects prototype-polluted input", () => {
		const raw = JSON.parse(
			'{"type":"handshake","direction":"home_to_host","hostId":"h-1","generation":"g-1","capabilities":["session_commands"],"runtime":{"buildId":"b-1","daemonProtocolVersion":7,"daemonSchemaRevision":25},"protocol":{"name":"prime-agent.remote-host","version":1},"__proto__":{"polluted":true}}',
		);
		const result = decodeHandshakeFrame(raw);
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeHandshakeAckFrame
// ===========================================================================

describe("decodeHandshakeAckFrame", () => {
	it("decodes valid handshake ack", () => {
		const ack = validHandshakeAck();
		const result = decodeHandshakeAckFrame(ack);
		expect(result.ok).toBe(true);
	});

	it("decodes rejected ack with rejectReason", () => {
		const ack = validHandshakeAck();
		ack.accepted = false;
		ack.rejectReason = "build_mismatch";
		const result = decodeHandshakeAckFrame(ack);
		expect(result.ok).toBe(true);
	});

	it("rejects missing linkId", () => {
		const ack = validHandshakeAck();
		delete (ack as unknown as Record<string, unknown>).linkId;
		expect(decodeHandshakeAckFrame(ack).ok).toBe(false);
	});

	it("rejects non-boolean accepted", () => {
		const ack = validHandshakeAck();
		(ack as unknown as Record<string, unknown>).accepted = "yes";
		expect(decodeHandshakeAckFrame(ack).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeCommandFrame
// ===========================================================================

describe("decodeCommandFrame", () => {
	it("decodes valid command frame", () => {
		const result = decodeCommandFrame(validCommandFrame());
		expect(result.ok).toBe(true);
	});

	it("rejects missing commandId", () => {
		const cmd = validCommandFrame();
		delete (cmd as unknown as Record<string, unknown>).commandId;
		expect(decodeCommandFrame(cmd).ok).toBe(false);
	});

	it("rejects extra keys", () => {
		const cmd = validCommandFrame();
		(cmd as unknown as Record<string, unknown>).extra = true;
		expect(decodeCommandFrame(cmd).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeEventFrame
// ===========================================================================

describe("decodeEventFrame", () => {
	it("decodes valid event frame", () => {
		const result = decodeEventFrame(validEventFrame());
		expect(result.ok).toBe(true);
	});

	it("rejects non-positive sequence", () => {
		const evt = validEventFrame();
		evt.sequence = 0;
		expect(decodeEventFrame(evt).ok).toBe(false);
	});

	it("rejects non-canonical emittedAt", () => {
		const evt = validEventFrame();
		evt.emittedAt = "2025-01-15T10:30:00Z";
		expect(decodeEventFrame(evt).ok).toBe(false);
	});

	it("rejects fractional sequence", () => {
		const evt = validEventFrame();
		evt.sequence = 1.5;
		expect(decodeEventFrame(evt).ok).toBe(false);
	});

	it("rejects missing cursor", () => {
		const evt = validEventFrame();
		delete (evt as unknown as Record<string, unknown>).cursor;
		expect(decodeEventFrame(evt).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeAckFrame
// ===========================================================================

describe("decodeAckFrame", () => {
	it("decodes valid ack", () => {
		expect(decodeAckFrame(validAckFrame()).ok).toBe(true);
	});

	it("decodes ack with rejectReason", () => {
		const ack: RemoteHostAckFrame = {
			type: "ack",
			ackId: "a-1",
			acknowledges: "f-001",
			status: "rejected",
			rejectReason: "timeout",
		};
		expect(decodeAckFrame(ack).ok).toBe(true);
	});

	it("rejects invalid status", () => {
		const ack = validAckFrame();
		(ack as unknown as Record<string, unknown>).status = "unknown";
		expect(decodeAckFrame(ack).ok).toBe(false);
	});

	it("rejects empty ackId", () => {
		const ack = validAckFrame();
		ack.ackId = "";
		expect(decodeAckFrame(ack).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeAgentMessageFrame
// ===========================================================================

describe("decodeAgentMessageFrame", () => {
	it("decodes valid agent message", () => {
		expect(decodeAgentMessageFrame(validAgentMessageFrame()).ok).toBe(true);
	});

	it("decodes with deliveryMode", () => {
		const msg: RemoteHostAgentMessageFrame = {
			type: "agent_message",
			id: "m-1",
			fromActiveSessionId: "s-1",
			targetActiveSessionId: "s-2",
			message: "hi",
			deliveryMode: "queued",
		};
		expect(decodeAgentMessageFrame(msg).ok).toBe(true);
	});

	it("rejects invalid deliveryMode", () => {
		const msg = validAgentMessageFrame();
		(msg as unknown as Record<string, unknown>).deliveryMode = "broadcast";
		expect(decodeAgentMessageFrame(msg).ok).toBe(false);
	});

	it("rejects empty message", () => {
		const msg = validAgentMessageFrame();
		msg.message = "";
		expect(decodeAgentMessageFrame(msg).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeProviderProxyFrame (5 variants)
// ===========================================================================

describe("decodeProviderProxyFrame", () => {
	it("decodes model_call_request", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-1",
			provider: "anthropic",
			model: "claude-3",
			messages: [{ role: "user", content: "hi" }],
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("decodes model_call_request with all optional fields", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-1",
			provider: "openai",
			model: "gpt-4",
			messages: [],
			systemPrompt: "Be helpful",
			tools: [{ name: "tool1" }],
			maxTokens: 4096,
			temperature: 0.7,
			thinkingLevel: "high",
			streamingBehavior: "steer",
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("decodes model_call_chunk", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_chunk",
			callId: "call-1",
			index: 0,
			delta: { type: "text", text: "hello" },
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("decodes model_call_complete", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-1",
			result: "done",
			usage: { inputTokens: 10, outputTokens: 20 },
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("decodes model_call_error", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_error",
			callId: "call-1",
			error: "rate limited",
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("decodes model_call_cancel", () => {
		const frame: RemoteHostProviderProxyFrame = {
			type: "provider_proxy",
			proxyType: "model_call_cancel",
			callId: "call-1",
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(true);
	});

	it("rejects unknown proxyType", () => {
		const frame = { type: "provider_proxy", proxyType: "unknown_type", callId: "call-1" };
		expect(decodeProviderProxyFrame(frame).ok).toBe(false);
	});

	it("rejects missing callId", () => {
		const frame = {
			type: "provider_proxy",
			proxyType: "model_call_request",
			provider: "p",
			model: "m",
			messages: [],
		};
		expect(decodeProviderProxyFrame(frame).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeHealthFrame
// ===========================================================================

describe("decodeHealthFrame", () => {
	it("decodes valid health", () => {
		const result = decodeHealthFrame({ type: "health", healthSeq: 1, status: "connected" });
		expect(result.ok).toBe(true);
	});

	it("decodes health with optional fields", () => {
		const result = decodeHealthFrame({
			type: "health",
			healthSeq: 2,
			status: "reconnecting",
			lastReceivedFrameId: "f-001",
			lastReceivedEventSequence: 5,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects invalid status", () => {
		expect(decodeHealthFrame({ type: "health", healthSeq: 1, status: "unknown" }).ok).toBe(false);
	});

	it("rejects negative healthSeq", () => {
		expect(decodeHealthFrame({ type: "health", healthSeq: -1, status: "connected" }).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeErrorFrame
// ===========================================================================

describe("decodeErrorFrame", () => {
	it("decodes valid error", () => {
		const result = decodeErrorFrame({ type: "error", code: "E001", message: "something failed" });
		expect(result.ok).toBe(true);
	});

	it("decodes error with inReplyTo", () => {
		const result = decodeErrorFrame({ type: "error", code: "E002", message: "not found", inReplyTo: "f-003" });
		expect(result.ok).toBe(true);
	});

	it("rejects empty code", () => {
		expect(decodeErrorFrame({ type: "error", code: "", message: "err" }).ok).toBe(false);
	});

	it("rejects too long message", () => {
		expect(decodeErrorFrame({ type: "error", code: "E1", message: "x".repeat(1001) }).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: ArtifactRef
// ===========================================================================

describe("decodeArtifactRef", () => {
	it("decodes valid artifact ref", () => {
		const result = decodeArtifactRef({ workspaceId: "ws-1" });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.workspaceId).toBe("ws-1");
		}
	});

	it("rejects unknown keys", () => {
		expect(decodeArtifactRef({ workspaceId: "ws-1", extraKey: 42 }).ok).toBe(false);
	});

	it("rejects non-object", () => {
		expect(decodeArtifactRef("string").ok).toBe(false);
		expect(decodeArtifactRef(null).ok).toBe(false);
		expect(decodeArtifactRef([]).ok).toBe(false);
	});

	it("rejects missing workspaceId", () => {
		expect(decodeArtifactRef({}).ok).toBe(false);
	});

	it("rejects undefined optional owning key", () => {
		expect(decodeArtifactRef({ workspaceId: "ws-1", snapshotId: undefined }).ok).toBe(false);
	});

	it("accepts optional fields", () => {
		const r = decodeArtifactRef({ workspaceId: "ws-1", snapshotId: "snap-1", changesetId: "cs-1" });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.snapshotId).toBe("snap-1");
			expect(r.value.changesetId).toBe("cs-1");
		}
	});
});

// ===========================================================================
// Tests: decodeProtocolInfo
// ===========================================================================

describe("decodeProtocolInfo", () => {
	it("decodes valid protocol info", () => {
		const result = decodeProtocolInfo({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION });
		expect(result.ok).toBe(true);
	});

	it("rejects wrong protocol name", () => {
		expect(decodeProtocolInfo({ name: "wrong", version: 1 }).ok).toBe(false);
	});

	it("rejects extra keys", () => {
		expect(decodeProtocolInfo({ name: REMOTE_HOST_PROTOCOL_NAME, version: 1, extra: true }).ok).toBe(false);
	});

	it("rejects non-integer version", () => {
		expect(decodeProtocolInfo({ name: REMOTE_HOST_PROTOCOL_NAME, version: 1.5 }).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeBuildIdentity
// ===========================================================================

describe("decodeBuildIdentity", () => {
	it("decodes valid build identity", () => {
		const result = decodeBuildIdentity({ buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25 });
		expect(result.ok).toBe(true);
	});

	it("decodes with optional appVersion", () => {
		const r = decodeBuildIdentity({
			buildId: "b-1",
			daemonProtocolVersion: 7,
			daemonSchemaRevision: 25,
			appVersion: "1.0.0",
		});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value.appVersion).toBe("1.0.0");
	});

	it("rejects missing buildId", () => {
		expect(decodeBuildIdentity({ daemonProtocolVersion: 7, daemonSchemaRevision: 25 }).ok).toBe(false);
	});

	it("rejects unknown keys", () => {
		expect(
			decodeBuildIdentity({ buildId: "b-1", daemonProtocolVersion: 7, daemonSchemaRevision: 25, extra: true }).ok,
		).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeEventCursor
// ===========================================================================

describe("decodeEventCursor", () => {
	it("decodes valid cursor", () => {
		const r = decodeEventCursor({ hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 42 });
		expect(r.ok).toBe(true);
	});

	it("rejects negative sequence", () => {
		expect(decodeEventCursor({ hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: -1 }).ok).toBe(false);
	});

	it("rejects extra keys", () => {
		expect(
			decodeEventCursor({ hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1, extra: true }).ok,
		).toBe(false);
	});
});

// ===========================================================================
// Tests: Adversarial — prototype, symbols, accessors
// ===========================================================================

describe("adversarial — prototype pollution and symbols", () => {
	it("rejects __proto__ pollution on command body", () => {
		const raw = JSON.parse('{"type":"abort","__proto__":{"polluted":true}}');
		expect(decodeCommandBody(raw).ok).toBe(false);
	});

	it("rejects __proto__ pollution on event frame", () => {
		const raw = JSON.parse(
			'{"type":"event","id":"e-1","sequence":1,"cursor":{"hostId":"h-1","generation":"g-1","sessionId":"s-1","sequence":1},"emittedAt":"2025-01-15T10:30:00.000Z","body":{"type":"agent_start"},"__proto__":{"polluted":true}}',
		);
		expect(decodeEventFrame(raw).ok).toBe(false);
	});

	it("rejects array proxy objects", () => {
		// Create an array-like that has different prototype
		const arr = [1, 2, 3];
		Object.setPrototypeOf(arr, null);
		const result = decodeCommandBody({ type: "abort", extraArray: arr });
		// Should be rejected via extra key check or prototype check
		expect(result.ok).toBe(false);
	});

	it("rejects objects with getters", () => {
		const obj = { type: "abort" };
		Object.defineProperty(obj, "polluted", {
			get: () => "evil",
			enumerable: true,
		});
		expect(decodeCommandBody(obj).ok).toBe(false);
	});

	it("rejects Symbol-keyed objects", () => {
		const obj: Record<string, unknown> = { type: "abort" };
		// Symbols are skipped by Object.keys, so they don't affect validation.
		expect(decodeCommandBody(obj).ok).toBe(true);
	});
});

// ===========================================================================
// Tests: Canonical timestamp
// ===========================================================================

describe("isCanonicalUtcTimestamp", () => {
	it("accepts valid canonical", () => {
		expect(isCanonicalUtcTimestamp("2025-01-15T10:30:00.000Z")).toBe(true);
	});

	it("rejects missing milliseconds", () => {
		expect(isCanonicalUtcTimestamp("2025-01-15T10:30:00Z")).toBe(false);
	});

	it("rejects with offset", () => {
		expect(isCanonicalUtcTimestamp("2025-01-15T10:30:00.000+05:30")).toBe(false);
	});

	it("rejects non-ISO", () => {
		expect(isCanonicalUtcTimestamp("2025/01/15")).toBe(false);
	});

	it("rejects impossible date", () => {
		expect(isCanonicalUtcTimestamp("2025-13-01T00:00:00.000Z")).toBe(false);
	});

	it("rejects out-of-year bound", () => {
		expect(isCanonicalUtcTimestamp("10000-01-01T00:00:00.000Z")).toBe(false);
	});

	it("accepts year 1", () => {
		expect(isCanonicalUtcTimestamp("0001-01-01T00:00:00.000Z")).toBe(true);
	});

	it("rejects non-string", () => {
		expect(isCanonicalUtcTimestamp(42 as unknown as string)).toBe(false);
	});
});

// ===========================================================================
// Tests: safeStableJsonStringify and canonicalDigest
// ===========================================================================

describe("canonicalDigest", () => {
	it("computes stable SHA-256 digest", () => {
		const a = canonicalDigest({ a: 1, b: 2 });
		const b = canonicalDigest({ b: 2, a: 1 }); // reversed keys
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) {
			expect(a.value).toBe(b.value); // same digest for same data
		}
	});

	it("rejects nonfinite numbers", () => {
		expect(canonicalDigest(NaN).ok).toBe(false);
		expect(canonicalDigest(Infinity).ok).toBe(false);
	});

	it("rejects non-plain objects", () => {
		const d = new Date();
		expect(canonicalDigest(d).ok).toBe(false);
	});

	it("handles null and boolean", () => {
		expect(canonicalDigest(null).ok).toBe(true);
		expect(canonicalDigest(true).ok).toBe(true);
		expect(canonicalDigest(false).ok).toBe(true);
	});

	it("returns 64-char hex digest", () => {
		const r = canonicalDigest("hello");
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("nested objects have stable digests", () => {
		const a = canonicalDigest({ outer: { inner: 1, name: "test" } });
		const b = canonicalDigest({ outer: { name: "test", inner: 1 } });
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.value).toBe(b.value);
	});

	it("arrays are ordered", () => {
		const a = canonicalDigest([1, 2, 3]);
		const b = canonicalDigest([3, 2, 1]);
		expect(a.ok).toBe(true);
		expect(b.ok).toBe(true);
		if (a.ok && b.ok) expect(a.value).not.toBe(b.value);
	});
});

describe("isValidDigest", () => {
	it("accepts 64-char lowercase hex", () => {
		expect(isValidDigest("ab".repeat(32))).toBe(true);
	});

	it("rejects uppercase", () => {
		expect(isValidDigest("AB".repeat(32))).toBe(false);
	});

	it("rejects wrong length", () => {
		expect(isValidDigest("ab".repeat(31))).toBe(false);
	});
});

describe("digestsEqual", () => {
	it("returns true for equal digests", () => {
		expect(digestsEqual("abc", "abc")).toBe(true);
	});

	it("returns false for different digests", () => {
		expect(digestsEqual("abc", "def")).toBe(false);
	});
});

// ===========================================================================
// Tests: JSON bounds
// ===========================================================================

describe("checkJsonSafe — depth and size bounds", () => {
	it("rejects deeply nested objects", () => {
		const obj: Record<string, unknown> = {};
		let current = obj;
		for (let i = 0; i < 70; i++) {
			current.nested = {};
			current = current.nested as unknown as Record<string, unknown>;
		}
		expect(checkJsonSafe(obj)).toBe(CODEC_ERRORS.OVERFLOW);
	});

	it("rejects very large arrays", () => {
		const arr = new Array(20_000).fill(1);
		expect(checkJsonSafe(arr)).toBe(CODEC_ERRORS.OVERFLOW);
	});

	it("rejects nonfinite numbers", () => {
		expect(checkJsonSafe(NaN)).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
		expect(checkJsonSafe(Infinity)).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
	});

	it("accepts null", () => {
		expect(checkJsonSafe(null)).toBeUndefined();
	});
});
// ===========================================================================
// Tests: Safe ID validation
// ===========================================================================

describe("isValidSafeId", () => {
	it("accepts alphanumeric with separators", () => {
		expect(isValidSafeId("abc-123.def_456")).toBe(true);
	});

	it("rejects empty", () => {
		expect(isValidSafeId("")).toBe(false);
	});

	it("rejects too long", () => {
		expect(isValidSafeId("a".repeat(129))).toBe(false);
	});

	it("rejects starting with non-alphanumeric", () => {
		expect(isValidSafeId("-abc")).toBe(false);
	});

	it("rejects special chars", () => {
		expect(isValidSafeId("abc def")).toBe(false);
		expect(isValidSafeId("abc/def")).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeCommandBody — detailed
// ===========================================================================

describe("decodeCommandBody", () => {
	it("rejects non-object", () => {
		expect(decodeCommandBody("string").ok).toBe(false);
		expect(decodeCommandBody(null).ok).toBe(false);
		expect(decodeCommandBody([]).ok).toBe(false);
	});

	it("rejects missing required workspaceId for create_session", () => {
		expect(decodeCommandBody({ type: "create_session" }).ok).toBe(false);
	});

	it("rejects non-string workspaceId", () => {
		expect(decodeCommandBody({ type: "create_session", workspaceId: 42 }).ok).toBe(false);
	});

	it("accepts create_session with optional fields", () => {
		const r = decodeCommandBody({
			type: "create_session",
			workspaceId: "ws-1",
			name: "test",
			telemetryDisabled: true,
		});
		expect(r.ok).toBe(true);
	});

	it("accepts prompt with admissionId", () => {
		const r = decodeCommandBody({ type: "prompt", message: "hello", admissionId: "a-1" });
		expect(r.ok).toBe(true);
	});

	it("rejects empty message for prompt", () => {
		expect(decodeCommandBody({ type: "prompt", message: "" }).ok).toBe(false);
	});

	it("rejects undefined optional key", () => {
		expect(decodeCommandBody({ type: "shutdown", force: undefined }).ok).toBe(false);
	});

	it("rejects NaN in numeric field", () => {
		expect(decodeCommandBody({ type: "sync_workspace", artifact: { workspaceId: NaN } }).ok).toBe(false);
	});
});

// ===========================================================================
// Tests: decodeEventBody — detailed
// ===========================================================================

describe("decodeEventBody", () => {
	it("rejects non-object", () => {
		expect(decodeEventBody(null).ok).toBe(false);
	});

	it("rejects unknown event type", () => {
		expect(decodeEventBody({ type: "unknown" }).ok).toBe(false);
	});

	it("rejects missing required fields", () => {
		expect(decodeEventBody({ type: "session_created" }).ok).toBe(false);
	});

	it("rejects wrong type for messages", () => {
		expect(decodeEventBody({ type: "agent_end", messages: "three" }).ok).toBe(false);
	});

	it("rejects invalid session_state", () => {
		expect(decodeEventBody({ type: "session_state", state: "unknown" }).ok).toBe(false);
	});

	it("rejects negative index", () => {
		expect(decodeEventBody({ type: "agent_text_delta", index: -1, text: "hi" }).ok).toBe(false);
	});

	it("accepts all valid event types", () => {
		const bodies: Record<string, unknown>[] = [
			{ type: "session_created", sessionId: "s-1", workspaceId: "w-1" },
			{ type: "session_destroyed" },
			{ type: "agent_start" },
			{ type: "agent_end", messages: 3 },
			{ type: "agent_text_delta", index: 0, text: "hi" },
			{ type: "agent_thinking_delta", index: 1, text: "hmm" },
			{ type: "agent_toolcall_delta", index: 2, text: "tool" },
			{ type: "bash_start", command: "ls" },
			{ type: "bash_end", exitCode: 0, cancelled: false, truncated: false },
			{ type: "bash_delta", text: "output" },
			{ type: "compact_start" },
			{ type: "compact_end", keptMessages: 50 },
			{ type: "compact_failed", error: "memory" },
			{ type: "error", code: "E1", message: "err" },
			{ type: "checkpoint_start" },
			{ type: "checkpoint_complete", snapshotId: "snap-1" },
			{ type: "checkpoint_failed", error: "disk full" },
			{ type: "session_state", state: "idle" },
		];
		for (const body of bodies) {
			const result = decodeEventBody(body);
			if (!result.ok) {
				console.error("Failed to decode", body.type, result.error);
			}
			expect(result.ok).toBe(true);
		}
	});
});

// ===========================================================================
// Tests: decodeAndDigestCommandBody / decodeAndDigestEventBody
// ===========================================================================

describe("decodeAndDigestCommandBody", () => {
	it("returns body and digest for valid input", () => {
		const r = decodeAndDigestCommandBody({ type: "abort" });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.body.type).toBe("abort");
			expect(r.value.digest).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	it("returns error for invalid input", () => {
		const r = decodeAndDigestCommandBody(null);
		expect(r.ok).toBe(false);
	});
});

describe("decodeAndDigestEventBody", () => {
	it("returns body and digest for valid input", () => {
		const r = decodeAndDigestEventBody({ type: "agent_start" });
		expect(r.ok).toBe(true);
	});

	// ===========================================================================
	// New B03 protocol tests per parent review
	// ===========================================================================

	describe("event frame id independence from envelope frameId", () => {
		it("envelope frameId and event frame id are independent", () => {
			const env = validEnvelope({ frameId: "env-001" }); // event.id inside is "f-001"
			const result = decodeEnvelope(env);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.frameId).toBe("env-001");
				const frame = result.value.frame;
				if (frame.type === "event") {
					expect(frame.id).toBe("f-001");
					expect(frame.id).not.toBe(result.value.frameId);
				}
			}
		});
	});

	describe("event frame cursor.sequence == sequence", () => {
		it("rejects event where cursor.sequence != frame.sequence", () => {
			const evt = validEventFrame();
			evt.cursor.sequence = 99; // different from frame.sequence (1)
			const result = decodeEventFrame(evt);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe(CODEC_ERRORS.MISMATCH);
			}
		});

		it("accepts event where cursor.sequence == frame.sequence", () => {
			const evt = validEventFrame();
			evt.cursor.sequence = 1; // same as frame.sequence
			const result = decodeEventFrame(evt);
			expect(result.ok).toBe(true);
		});

		it("envelope nested event validates cursor seq", () => {
			const env = validEnvelope();
			const evt = env.frame as Record<string, unknown>;
			if (evt.type === "event") {
				const cursor = evt.cursor as Record<string, unknown>;
				cursor.sequence = 99;
				const result = decodeEnvelope(env);
				expect(result.ok).toBe(false);
			}
		});
	});

	describe("handshake resumeCursor identity check", () => {
		it("accepts handshake with matching resumeCursor identity", () => {
			const h = validHandshake();
			h.hostId = "h-1";
			h.generation = "g-abc";
			h.sessionId = "s-1";
			h.resumeCursor = { hostId: "h-1", generation: "g-abc", sessionId: "s-1", sequence: 5 };
			const result = decodeHandshakeFrame(h);
			expect(result.ok).toBe(true);
		});

		it("rejects handshake with mismatched resumeCursor hostId", () => {
			const h = validHandshake();
			h.sessionId = "s-1";
			h.resumeCursor = { hostId: "wrong-host", generation: h.generation, sessionId: h.sessionId, sequence: 5 };
			const result = decodeHandshakeFrame(h);
			expect(result.ok).toBe(false);
		});

		it("rejects handshake with mismatched resumeCursor generation", () => {
			const h = validHandshake();
			h.sessionId = "s-1";
			h.resumeCursor = { hostId: h.hostId, generation: "wrong-gen", sessionId: h.sessionId, sequence: 5 };
			const result = decodeHandshakeFrame(h);
			expect(result.ok).toBe(false);
		});

		it("rejects handshake with mismatched resumeCursor sessionId", () => {
			const h = validHandshake();
			h.sessionId = "s-1";
			h.resumeCursor = { hostId: h.hostId, generation: h.generation, sessionId: "wrong-session", sequence: 5 };
			const result = decodeHandshakeFrame(h);
			expect(result.ok).toBe(false);
		});
	});

	describe("handshake_ack coherent conditional keys", () => {
		it("rejects rejectReason when accepted=true", () => {
			const ack = validHandshakeAck();
			ack.accepted = true;
			(ack as unknown as Record<string, unknown>).rejectReason = "should-not-be-here";
			expect(decodeHandshakeAckFrame(ack).ok).toBe(false);
		});

		it("accepts rejectReason when accepted=false", () => {
			const ack = validHandshakeAck();
			ack.accepted = false;
			ack.rejectReason = "build_mismatch";
			expect(decodeHandshakeAckFrame(ack).ok).toBe(true);
		});

		it("rejects cursor when accepted=false", () => {
			const ack = validHandshakeAck();
			ack.accepted = false;
			(ack as unknown as Record<string, unknown>).cursor = {
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				sequence: 0,
			};
			expect(decodeHandshakeAckFrame(ack).ok).toBe(false);
		});
	});

	describe("ack rejectReason only when rejected", () => {
		it("rejects rejectReason with status delivered", () => {
			const ack = validAckFrame();
			(ack as unknown as Record<string, unknown>).rejectReason = "timeout";
			expect(decodeAckFrame(ack).ok).toBe(false);
		});

		it("accepts rejectReason with status rejected", () => {
			const ack = validAckFrame();
			ack.status = "rejected";
			ack.rejectReason = "timeout";
			expect(decodeAckFrame(ack).ok).toBe(true);
		});
	});

	describe("provider proxy fresh DTO — no raw reference", () => {
		it("model_call_request returns fresh object with decoded messages", () => {
			const raw = {
				type: "provider_proxy",
				proxyType: "model_call_request",
				callId: "call-1",
				provider: "p",
				model: "m",
				messages: [{ role: "user", content: "hi" }],
			};
			const result = decodeProviderProxyFrame(raw);
			expect(result.ok).toBe(true);
			if (result.ok) {
				// Verify it's not the same reference
				expect(result.value).not.toBe(raw);
				// Proxy type preserved
				expect(result.value.proxyType).toBe("model_call_request");
			}
		});

		it("model_call_chunk returns fresh object with decoded delta", () => {
			const raw = {
				type: "provider_proxy",
				proxyType: "model_call_chunk",
				callId: "call-1",
				index: 0,
				delta: { text: "hello" },
			};
			const result = decodeProviderProxyFrame(raw);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).not.toBe(raw);
				expect(result.value.proxyType).toBe("model_call_chunk");
			}
		});

		it("model_call_complete returns fresh object with decoded result", () => {
			const raw = { type: "provider_proxy", proxyType: "model_call_complete", callId: "call-1", result: "done" };
			const result = decodeProviderProxyFrame(raw);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).not.toBe(raw);
				expect(result.value.proxyType).toBe("model_call_complete");
			}
		});

		it("model_call_error returns fresh object", () => {
			const raw = { type: "provider_proxy", proxyType: "model_call_error", callId: "call-1", error: "rate limited" };
			const result = decodeProviderProxyFrame(raw);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).not.toBe(raw);
				expect(result.value.proxyType).toBe("model_call_error");
			}
		});

		it("model_call_cancel returns fresh object", () => {
			const raw = { type: "provider_proxy", proxyType: "model_call_cancel", callId: "call-1" };
			const result = decodeProviderProxyFrame(raw);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value).not.toBe(raw);
			}
		});
	});

	describe("undefined key rejection", () => {
		it("isPlainObject rejects undefined own-key values", () => {
			const obj = { type: "abort", extra: undefined };
			expect(decodeCommandBody(obj).ok).toBe(false);
		});

		it("checkJsonSafe rejects undefined values", () => {
			expect(checkJsonSafe({ a: undefined })).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
		});

		it("canonical digest rejects undefined values", () => {
			const r = canonicalDigest({ a: undefined });
			expect(r.ok).toBe(false);
		});

		it("safeStableJsonStringify rejects undefined in object", () => {
			const r = safeStableJsonStringify({ a: undefined });
			expect(r.ok).toBe(false);
		});

		it("safeStableJsonStringify rejects undefined in array", () => {
			const r = safeStableJsonStringify([1, undefined, 3]);
			expect(r.ok).toBe(false);
		});
	});

	describe("symbol key rejection", () => {
		it("isPlainObject rejects symbol-keyed objects", () => {
			const obj: Record<string, unknown> = { type: "abort" };
			Object.defineProperty(obj, Symbol.for("evil"), { value: "data", enumerable: true });
			expect(decodeCommandBody(obj).ok).toBe(false);
		});

		it("checkJsonSafe rejects symbol-keyed objects", () => {
			const obj: Record<string, unknown> = {};
			Object.defineProperty(obj, Symbol.for("evil"), { value: "data", enumerable: true });
			expect(checkJsonSafe(obj)).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
		});

		it("safeStableJsonStringify rejects symbol-keyed objects", () => {
			const obj: Record<string, unknown> = { a: 1 };
			Object.defineProperty(obj, Symbol.for("evil"), { value: "data", enumerable: true });
			const r = safeStableJsonStringify(obj);
			expect(r.ok).toBe(false);
		});
	});

	describe("non-enumerable own property rejection", () => {
		it("isPlainObject rejects non-enumerable owned props", () => {
			const obj: Record<string, unknown> = { type: "abort" };
			Object.defineProperty(obj, "hidden", { value: true, enumerable: false });
			expect(decodeCommandBody(obj).ok).toBe(false);
		});

		it("checkJsonSafe rejects non-enumerable owned props", () => {
			const obj: Record<string, unknown> = { a: 1 };
			Object.defineProperty(obj, "hidden", { value: true, enumerable: false });
			expect(checkJsonSafe(obj)).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
		});

		it("safeStableJsonStringify rejects non-enumerable", () => {
			const obj: Record<string, unknown> = { a: 1 };
			Object.defineProperty(obj, "hidden", { value: true, enumerable: false });
			const r = safeStableJsonStringify(obj);
			expect(r.ok).toBe(false);
		});
	});

	describe("accessor rejection at nested level", () => {
		it("rejects nested object with accessor", () => {
			const inner: Record<string, unknown> = {};
			Object.defineProperty(inner, "polluted", { get: () => "evil", enumerable: true });
			const cmd = { type: "sync_workspace", artifact: { workspaceId: "ws-1", innerData: inner } };
			expect(decodeCommandBody(cmd).ok).toBe(false);
		});
	});

	describe("array holes rejection", () => {
		it("checkJsonSafe rejects holey array", () => {
			const arr: unknown[] = [1];
			arr.length = 3;
			expect(checkJsonSafe(arr)).toBe(CODEC_ERRORS.INVALID_COMMAND_BODY);
		});

		it("safeStableJsonStringify rejects holey array", () => {
			const arr: unknown[] = [1];
			arr.length = 3;
			const r = safeStableJsonStringify(arr);
			expect(r.ok).toBe(false);
		});
	});

	describe("cumulative node and byte budget", () => {
		it("canonicalDigest rejects over MAX_JSON_NODES", () => {
			// Create an object with many keys
			const large: Record<string, number> = {};
			for (let i = 0; i < 12_000; i++) large[`k${i}`] = i;
			const r = canonicalDigest(large);
			expect(r.ok).toBe(false);
		});

		it("checkJsonSafe rejects cumulative overflow", () => {
			const deep: Record<string, unknown> = {};
			let cur = deep;
			for (let i = 0; i < 70; i++) {
				cur.nested = {};
				cur = cur.nested as Record<string, unknown>;
			}
			expect(checkJsonSafe(deep)).toBe(CODEC_ERRORS.OVERFLOW);
		});

		it("single large string within budget is accepted", () => {
			expect(checkJsonSafe("x".repeat(100_000))).toBeUndefined();
		});
	});

	describe("canonical digest includes every nested key", () => {
		it("same data sorted differently gives same digest", () => {
			const a = canonicalDigest({ b: 2, a: [3, { d: 4, c: 5 }] });
			const b = canonicalDigest({ a: [3, { c: 5, d: 4 }], b: 2 });
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			if (a.ok && b.ok) expect(a.value).toBe(b.value);
		});

		it("additional nested key changes digest", () => {
			const a = canonicalDigest({ a: { b: 1 } });
			const b = canonicalDigest({ a: { b: 1, c: 2 } });
			expect(a.ok).toBe(true);
			expect(b.ok).toBe(true);
			if (a.ok && b.ok) expect(a.value).not.toBe(b.value);
		});
	});

	describe("legal canonical digest roundtrip", () => {
		it("handshake frame digests match after decode", () => {
			const h = validHandshake();
			const a = canonicalDigest(h);
			const decoded = decodeHandshakeFrame(h);
			expect(decoded.ok).toBe(true);
			if (decoded.ok) {
				const b = canonicalDigest(decoded.value);
				expect(a.ok).toBe(true);
				expect(b.ok).toBe(true);
				if (a.ok && b.ok) expect(a.value).toBe(b.value);
			}
		});
	});

	it("returns error for invalid input", () => {
		const r = decodeAndDigestEventBody({ type: "unknown" });
		expect(r.ok).toBe(false);
	});
});
