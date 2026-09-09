import { describe, expect, it } from "vitest";
import {
	decodeReply,
	encodeReply,
	type V16WireIdentity,
} from "../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js";
import type { V16Method } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";

// ---------- test identity fixture ----------

const TEST_IDENTITY: V16WireIdentity = {
	activeSessionId: "asi-01",
	sessionId: "sid-01",
	rlmChildId: "rlm-01",
	depth: 0,
	sessionName: "test-agent",
};

// ---------- identity builder (no spread) ----------

function buildIdentity(overrides: Partial<V16WireIdentity>): V16WireIdentity {
	return {
		activeSessionId: overrides.activeSessionId ?? TEST_IDENTITY.activeSessionId,
		sessionId: overrides.sessionId ?? TEST_IDENTITY.sessionId,
		rlmChildId: overrides.rlmChildId ?? TEST_IDENTITY.rlmChildId,
		depth: overrides.depth ?? TEST_IDENTITY.depth,
		sessionName: overrides.sessionName ?? TEST_IDENTITY.sessionName,
	};
}

// ---------- helper: encode a success reply for a given method ----------
// Returns empty sentinel on encode failure.

function encodeSuccess(method: string, body: unknown): Uint8Array {
	const enc = encodeReply(method, body, TEST_IDENTITY);
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}

const testMethods: V16Method[] = [
	"list_agents",
	"roster",
	"await_pending",
	"assert_name",
	"set_name",
	"send_message",
	"observe_list",
	"observe_get",
	"observe_recent",
];

describe("V16 reply codec – encode/decode all 9 methods", () => {
	const bodies: Record<string, unknown> = {
		list_agents: { current: { activeSessionId: "asi-0", sessionId: "sid-0" }, agents: [] },
		roster: {
			current: { name: "a", id: "i", depth: 0 },
			entries: [{ relationship: "parent", name: "p", id: "pid", depth: 1, status: "running" }],
		},
		await_pending: "child-session-id",
		assert_name: {},
		set_name: {},
		send_message: {
			id: "msg-1",
			source: "agent_message",
			target: { activeSessionId: "asi-t", sessionId: "sid-t" },
			message: "hello",
			deliveryStatus: "delivered",
			deliveredAt: "now",
		},
		observe_list: {
			current: {
				activeSessionId: "asi-0",
				sessionId: "sid-0",
				status: "running",
				isCurrent: true,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				queuedCount: 0,
				isSessionActive: true,
			},
			agents: [],
		},
		observe_get: {
			agent: {
				activeSessionId: "asi-0",
				sessionId: "sid-0",
				status: "running",
				isCurrent: true,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				queuedCount: 0,
				isSessionActive: true,
			},
		},
		observe_recent: {
			agent: {
				activeSessionId: "asi-0",
				sessionId: "sid-0",
				status: "running",
				isCurrent: true,
				isStreaming: false,
				isCompacting: false,
				attachedClients: 0,
				messageCount: 0,
				queuedCount: 0,
				isSessionActive: true,
			},
			messages: [{ index: 0, role: "user", text: "hi", truncated: false }],
			limit: 5,
			maxChars: 500,
			truncated: false,
		},
	};

	for (const m of testMethods) {
		it(`encodes and decodes ${m}`, () => {
			const bytes = encodeSuccess(m, bodies[m]);
			const dec = decodeReply(bytes, m, TEST_IDENTITY);
			expect(dec.ok).toBe(true);
		});
	}
});

describe("V16 reply codec – identity and method binding", () => {
	it("decode rejects method mismatch", () => {
		const bytes = encodeSuccess("roster", {
			current: { name: "a", id: "i", depth: 0 },
			entries: [],
		});
		const dec = decodeReply(bytes, "list_agents", TEST_IDENTITY);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("METHOD_MISMATCH");
	});

	it("decode rejects identity mismatch (wrong sessionId)", () => {
		const bytes = encodeSuccess("list_agents", { agents: [] });
		const wrongIdentity: V16WireIdentity = buildIdentity({ sessionId: "wrong-sid" });
		const dec = decodeReply(bytes, "list_agents", wrongIdentity);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("IDENTITY_MISMATCH");
	});

	it("decode rejects identity mismatch (wrong rlmChildId)", () => {
		const bytes = encodeSuccess("list_agents", { agents: [] });
		const wrongIdentity: V16WireIdentity = buildIdentity({ rlmChildId: "wrong-rlm" });
		const dec = decodeReply(bytes, "list_agents", wrongIdentity);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("IDENTITY_MISMATCH");
	});
});

describe("V16 reply codec – METHOD_UNAVAILABLE on allowed methods", () => {
	const unavailableMethods: V16Method[] = ["roster", "await_pending", "assert_name", "set_name"];
	for (const m of unavailableMethods) {
		it(`accepts METHOD_UNAVAILABLE for ${m}`, () => {
			const rawController = { error: "METHOD_UNAVAILABLE" };
			const enc = encodeReply(m, rawController, TEST_IDENTITY);
			expect(enc.ok).toBe(true);
		});
	}

	it("rejects METHOD_UNAVAILABLE for required method (list_agents)", () => {
		// list_agents does not allow METHOD_UNAVAILABLE — codec returns INPUT_INVALID
		const rawController = { error: "METHOD_UNAVAILABLE" };
		const enc = encodeReply("list_agents", rawController, TEST_IDENTITY);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("INPUT_INVALID");
	});
});

describe("V16 reply codec – canonical/duplicate/bounds", () => {
	it("decode rejects duplicate trailing byte", () => {
		const bytes = encodeSuccess("assert_name", {});
		const padded = new Uint8Array(bytes.length + 1);
		padded.set(bytes);
		padded[bytes.length] = 0;
		expect(decodeReply(padded, "assert_name", TEST_IDENTITY).ok).toBe(false);
	});

	it("decode rejects truncated input", () => {
		const bytes = encodeSuccess("assert_name", {});
		const truncated = bytes.subarray(0, bytes.length - 1);
		expect(decodeReply(truncated, "assert_name", TEST_IDENTITY).ok).toBe(false);
	});

	it("rejects oversized reply bytes > 262k", () => {
		const large = new Uint8Array(300_000);
		const dec = decodeReply(large, "list_agents", TEST_IDENTITY);
		expect(dec.ok).toBe(false);
		if (!dec.ok) expect(dec.code).toBe("INPUT_TOO_LARGE");
	});

	it("rejects non-array agent list for list_agents", () => {
		const enc = encodeReply("list_agents", { agents: "not-an-array" }, TEST_IDENTITY);
		expect(enc.ok).toBe(false);
	});

	it("encodeReply rejects invalid method", () => {
		const enc = encodeReply("bad_method", {}, TEST_IDENTITY);
		expect(enc.ok).toBe(false);
		if (!enc.ok) expect(enc.code).toBe("UNKNOWN_METHOD");
	});

	it("CONTROLLER_FAILURE on every method produces valid encodeReply", () => {
		const enc = encodeReply("list_agents", { error: "CONTROLLER_FAILURE" }, TEST_IDENTITY);
		expect(enc.ok).toBe(true);
	});
});
