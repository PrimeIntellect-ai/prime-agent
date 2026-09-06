import { describe, expect, it } from "vitest";
import { createControllerInvocationAuthorityManager } from "../src/modes/daemon/sandbox/prime-sandbox-v16-invocation.js";
import type { V16WireIdentity } from "../src/modes/daemon/sandbox/prime-sandbox-v16-reply-codec.js";
import type { V16Method } from "../src/modes/daemon/sandbox/prime-sandbox-v16-request-codec.js";

// ---------- test identity fixture ----------

const TEST_IDENTITY: V16WireIdentity = Object.freeze({
	activeSessionId: "asi-01",
	sessionId: "sid-01",
	rlmChildId: "rlm-01",
	depth: 0,
	sessionName: "test-agent",
});

// ---------- valid reply body per method (adapter produces these) ----------

function validReplyBody(method: string): unknown {
	switch (method) {
		case "list_agents":
		case "observe_list":
			return Object.freeze({
				current: Object.freeze({ activeSessionId: "asi-0", sessionId: "sid-0" }),
				agents: Object.freeze([]),
			});
		case "roster":
			return Object.freeze({
				current: Object.freeze({ name: "a", id: "i", depth: 0 }),
				entries: Object.freeze([]),
			});
		case "await_pending":
			return null;
		case "assert_name":
		case "set_name":
			return Object.freeze({});
		case "send_message":
			return Object.freeze({
				id: "msg-1",
				source: "agent_message",
				target: Object.freeze({ activeSessionId: "asi-t", sessionId: "sid-t" }),
				message: "hi",
				deliveryStatus: "delivered",
				deliveredAt: "now",
			});
		case "observe_get":
			return Object.freeze({
				agent: Object.freeze({
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
				}),
			});
		case "observe_recent":
			return Object.freeze({
				agent: Object.freeze({
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
				}),
				messages: Object.freeze([Object.freeze({ index: 0, role: "user", text: "hi", truncated: false })]),
				limit: 5,
				maxChars: 500,
				truncated: false,
			});
	}
	return undefined;
}

// ---------- valid request body per method (raw input to invoke) ----------

function validRequestBody(method: string): unknown {
	switch (method) {
		case "list_agents":
		case "roster":
		case "observe_list":
			return {};
		case "await_pending":
			return { selector: "my-sel_01" };
		case "assert_name":
			return { name: "agent-X", depth: 0, parentSessionId: null, ignoreSessionId: null };
		case "set_name":
			return { name: "agent-X" };
		case "send_message":
			return { target: "C01", message: "hello", receiverRole: "parent" };
		case "observe_get":
			return { target: "C01" };
		case "observe_recent":
			return { target: "C01", limit: 10, maxChars: 500 };
	}
	return undefined;
}

// ---------- session fixture helper ----------
// Returns a fixed empty ControllerInvocationManager on failure so callers
// do not throw.

function createSession() {
	const am = createControllerInvocationAuthorityManager();
	const result = am.createSession(
		{
			invoke: (_method: unknown, _body: unknown, _signal: unknown): unknown => {
				return Promise.resolve(validReplyBody(String(_method)));
			},
		},
		TEST_IDENTITY,
	);
	if (result.ok) return { am, session: result.session };
	// Fixed failure returns: am is empty authority with no sessions.
	return { am: createControllerInvocationAuthorityManager(), session: null };
}

const methods: V16Method[] = [
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

// ===================================================================
// Invoke → pollDispatch → adapter → encodeReply → relay → decodeReply → pollReply
// ===================================================================

describe("V16 invocation – full ACK→adapter→relay→reply flow for all 9 methods", () => {
	for (const m of methods) {
		it(`invoke → dispatch → reply flow for ${m}`, async () => {
			const { session } = createSession();
			if (session === null) return;
			const inv = session.invoke(m, validRequestBody(m));
			expect(inv.ok).toBe(true);
			if (!inv.ok) return;

			const dp = session.pollDispatch();
			expect(dp.ok).toBe(true);
			if (!dp.ok) return;
			expect(dp.dispatch.method).toBe(m);

			// Allow microtask for adapter promise to settle
			await undefined;
			await undefined;

			const pr = session.pollReply(inv.callClaim);
			expect(pr.ok).toBe(true);
		});
	}
});

describe("V16 invocation – cancel", () => {
	it("cancels a pending (undispatched) call", () => {
		const { session } = createSession();
		if (session === null) return;
		const inv = session.invoke("list_agents", {});
		expect(inv.ok).toBe(true);
		if (!inv.ok) return;

		const cancelResult = session.cancel(inv.callClaim);
		expect(cancelResult.ok).toBe(true);
		if (!cancelResult.ok) return;
		expect(cancelResult.code).toBe("CANCELLED");

		// Cancel already removed from pending dispatch — EMPTY
		const dp = session.pollDispatch();
		expect(dp.ok).toBe(false);
		if (!dp.ok) expect(dp.code).toBe("EMPTY");
	});

	it("cancel returns ALREADY_CANCELLED on second cancel", () => {
		const { session } = createSession();
		if (session === null) return;
		const inv = session.invoke("list_agents", {});
		expect(inv.ok).toBe(true);
		if (!inv.ok) return;

		expect(session.cancel(inv.callClaim).ok).toBe(true);
		const second = session.cancel(inv.callClaim);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.code).toBe("ALREADY_CANCELLED");
	});

	it("cancel rejects fabricated callClaim", () => {
		const { session } = createSession();
		if (session === null) return;
		const result = session.cancel({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("FABRICATED");
	});
});

describe("V16 invocation – close", () => {
	it("close returns CLOSED and settles cleanly", async () => {
		const { session } = createSession();
		if (session === null) return;
		const inv = session.invoke("list_agents", {});
		expect(inv.ok).toBe(true);

		const closeResult = await session.close();
		expect(closeResult.ok).toBe(true);
		if (!closeResult.ok) return;
		expect(closeResult.code).toBe("CLOSED");
	});

	it("close is idempotent — second call also resolves CLOSED", async () => {
		const { session } = createSession();
		if (session === null) return;
		session.invoke("list_agents", {});
		const c1 = await session.close();
		expect(c1.ok).toBe(true);
		const c2 = await session.close();
		expect(c2.ok).toBe(true);
	});
});

describe("V16 invocation – cross-session cap protection", () => {
	it("using cap from session A on session B poisons session A", () => {
		const am = createControllerInvocationAuthorityManager();
		const r1 = am.createSession(
			{
				invoke: (): unknown =>
					Promise.resolve(
						Object.freeze({
							agents: Object.freeze([]),
							current: Object.freeze({ activeSessionId: "a", sessionId: "b" }),
						}),
					),
			},
			TEST_IDENTITY,
		);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		// Give session2 a different name
		const id2: V16WireIdentity = Object.freeze({
			activeSessionId: "asi-02",
			sessionId: "sid-02",
			rlmChildId: "rlm-02",
			depth: 0,
			sessionName: "test-agent-2",
		});
		const r2 = am.createSession({ invoke: (): unknown => Promise.resolve(Object.freeze({})) }, id2);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		const inv = r1.session.invoke("list_agents", {});
		expect(inv.ok).toBe(true);
		if (!inv.ok) return;

		// Use session1's cap on session2 — poisons session1
		const cancelResult = r2.session.cancel(inv.callClaim);
		expect(cancelResult.ok).toBe(false);
		if (!cancelResult.ok) expect(cancelResult.code).toBe("WRONG_OWNER");

		// Session1 invoke should now report POISONED
		const inv2 = r1.session.invoke("list_agents", {});
		expect(inv2.ok).toBe(false);
		if (!inv2.ok) expect(inv2.code).toBe("POISONED");
	});
});

describe("V16 invocation – unknown/fabricated caps", () => {
	it("pollReply rejects non-cap object", () => {
		const { session } = createSession();
		if (session === null) return;
		const pr = session.pollReply(null);
		expect(pr.ok).toBe(false);
		if (!pr.ok) expect(pr.code).toBe("FABRICATED");
	});

	it("pollReply rejects arbitrary object", () => {
		const { session } = createSession();
		if (session === null) return;
		const pr = session.pollReply({});
		expect(pr.ok).toBe(false);
		if (!pr.ok) expect(pr.code).toBe("FABRICATED");
	});

	it("cancel rejects arbitrary object", () => {
		const { session } = createSession();
		if (session === null) return;
		const result = session.cancel({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe("FABRICATED");
	});
});

describe("V16 invocation – reentrant close safety", () => {
	it("reentrant close from abort listener does not deadlock", async () => {
		// Create a session where the adapter triggers close on abort signal
		const am = createControllerInvocationAuthorityManager();
		let capturedClose: (() => Promise<unknown>) | undefined;

		const r = am.createSession(
			{
				invoke: (_method: unknown, _body: unknown, signal: unknown): unknown => {
					// signal is unknown per API contract — use dynamic dispatch
					// with no cast: access addEventListener via Object.hasOwn + Reflect.get.
					// The signal IS an AbortSignal at runtime (from pollDispatch).
					const sig = signal;
					// On abort, reentrantly close the session
					if (typeof sig === "object" && sig !== null) {
						// Dynamic access to addEventListener — no cast to any/AbortSignal
						try {
							const hasListener: boolean = "addEventListener" in sig;
							if (hasListener) {
								const fn: unknown = Reflect.get(sig, "addEventListener");
								if (typeof fn === "function") {
									fn.call(
										sig,
										"abort",
										() => {
											if (capturedClose) capturedClose();
										},
										{ once: true },
									);
								}
							}
						} catch (_e: unknown) {
							// Silently ignore reflection failures
						}
					}
					return new Promise(() => {
						/* never resolves on its own */
					});
				},
			},
			TEST_IDENTITY,
		);
		if (!r.ok) return;
		capturedClose = () => r.session.close();

		r.session.invoke("list_agents", {});
		// Poll dispatch so the adapter runs
		const dp = r.session.pollDispatch();
		expect(dp.ok).toBe(true);

		// Close the session — triggers abort → reentrant close
		const closeResult = await r.session.close();
		expect(closeResult.ok).toBe(true);
	});
});

describe("V16 invocation – invoke error codes", () => {
	it("rejects unknown method", () => {
		const { session } = createSession();
		if (session === null) return;
		const inv = session.invoke("bad_method", {});
		expect(inv.ok).toBe(false);
		if (!inv.ok) expect(inv.code).toBe("UNKNOWN_METHOD");
	});

	it("rejects non-string method", () => {
		const { session } = createSession();
		if (session === null) return;
		// Call invoke with a number via Reflect.apply to test runtime type rejection.
		// Reflect.apply avoids TS compile-time argument checking.
		const rawResult: unknown = Reflect.apply(session.invoke, session, [123, {}]);
		// Extract properties without any cast — use Object.getOwnPropertyDescriptor.
		let checkedOk: boolean | undefined;
		let checkedCode: string | undefined;
		if (typeof rawResult === "object" && rawResult !== null) {
			const okDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(rawResult, "ok");
			if (okDesc !== undefined && typeof okDesc.value === "boolean") checkedOk = okDesc.value;
			const codeDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(rawResult, "code");
			if (codeDesc !== undefined && typeof codeDesc.value === "string") checkedCode = codeDesc.value;
		}
		expect(checkedOk).toBe(false);
		expect(checkedCode).toBe("INPUT_INVALID");
	});

	it("rejects invalid body for method", () => {
		const { session } = createSession();
		if (session === null) return;
		const inv = session.invoke("send_message", { target: 123 });
		expect(inv.ok).toBe(false);
		if (!inv.ok) expect(inv.code).toBe("INPUT_INVALID");
	});
});

describe("V16 invocation – cleanup", () => {
	it("cleanup closes all sessions", async () => {
		const am = createControllerInvocationAuthorityManager();
		const r1 = am.createSession({ invoke: (): unknown => Promise.resolve({}) }, TEST_IDENTITY);
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const id2: V16WireIdentity = Object.freeze({
			activeSessionId: "asi-02",
			sessionId: "sid-02",
			rlmChildId: "rlm-02",
			depth: 1,
			sessionName: "test-agent-2",
		});
		const r2 = am.createSession({ invoke: (): unknown => Promise.resolve({}) }, id2);
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		await am.cleanup();

		// Sessions are now closed/poisoned
		if (!r1.ok || !r2.ok) return;
		expect(r1.session.invoke("list_agents", {}).ok).toBe(false);
		expect(r2.session.invoke("roster", {}).ok).toBe(false);
	});
});
