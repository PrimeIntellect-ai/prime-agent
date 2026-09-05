import { describe, expect, it } from "vitest";
import { createOrderedTargetInboxApplication } from "../src/modes/daemon/ordered-target-inbox-application.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function realDigest(envelope: Record<string, unknown>): string {
	const env = envelope.envelope as Record<string, unknown>;
	const frame = env.frame as Record<string, unknown>;
	const plain: Record<string, unknown> = {};
	for (const key of Object.keys(frame)) {
		plain[key] = (frame as Record<string, unknown>)[key];
	}
	const result = canonicalDigest(plain);
	if (!result.ok) return "0".repeat(64);
	return result.value;
}

function makeAdmitSuccess(
	envelope: Record<string, unknown>,
	overrides?: Readonly<{
		sequence?: number;
		size?: number;
		sha256?: string;
		frameId?: string;
		semanticId?: string;
		semanticDigest?: string;
		relationship?: string;
	}>,
): () => Promise<unknown> {
	const env = envelope.envelope as Record<string, unknown>;
	const frame = env.frame as Record<string, unknown>;
	const defaultFrameId = env.frameId as string;
	const defaultMessageId = frame.id as string;
	const computedDigest = realDigest(envelope);
	return () =>
		Promise.resolve(
			Object.freeze({
				ok: true,
				value: Object.freeze({
					allowed: true,
					relationship: Object.freeze({
						fromRelationship: overrides?.relationship ?? "parent",
					}),
					receipt: Object.freeze({
						status: "queued",
						receipt: Object.freeze({
							sequence: overrides?.sequence ?? 1,
							size: overrides?.size ?? 42,
							sha256: overrides?.sha256 ?? "a".repeat(64),
						}),
						frameId: overrides?.frameId ?? defaultFrameId,
						semanticId: overrides?.semanticId ?? defaultMessageId,
						semanticDigest: overrides?.semanticDigest ?? computedDigest,
					}),
				}),
			}),
		);
}

function makeEnvelope(
	overrides?: Readonly<{
		frameId?: string;
		messageId?: string;
		from?: string;
		target?: string;
		message?: string;
	}>,
): Record<string, unknown> {
	const frameId = overrides?.frameId ?? "tf-1";
	const messageId = overrides?.messageId ?? "agentmsg_test1";
	return Object.freeze({
		envelope: Object.freeze({
			type: "frame",
			frameId,
			protocol: Object.freeze({ name: "prime-agent.remote-host", version: 1 }),
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: Object.freeze({
				type: "agent_message",
				id: messageId,
				fromActiveSessionId: overrides?.from ?? "parent-1",
				targetActiveSessionId: overrides?.target ?? "child-1",
				message: overrides?.message ?? "hello",
			}),
		}),
	});
}

function makePreauth(
	overrides?: Readonly<{
		authorizeAdmit?: (raw: unknown) => Promise<unknown>;
		dispatchPending?: () => Promise<unknown>;
		close?: () => Promise<unknown>;
	}>,
): Record<string, unknown> {
	return Object.freeze({
		authorizeAdmit: overrides?.authorizeAdmit ?? makeAdmitSuccess(makeEnvelope()),
		dispatchPending: overrides?.dispatchPending ?? (async () => Object.freeze({ ok: true, value: undefined })),
		close: overrides?.close ?? (async () => Object.freeze({ ok: true, value: undefined })),
	});
}

// ===========================================================================
// Factory
// ===========================================================================

describe("createOrderedTargetInboxApplication factory", () => {
	it("creates with valid PreAuthorizedInbox", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof result.application.apply).toBe("function");
		expect(typeof result.application.close).toBe("function");
		expect(typeof result.retry.dispatchPending).toBe("function");
		expect(result.application).not.toBe(result.retry);
		expect((result.retry as unknown as Record<string, unknown>).close).toBeUndefined();
		await result.application.close();
	});

	it("rejects missing preAuthorizedInbox key", async () => {
		const result = await createOrderedTargetInboxApplication(Object.freeze({}));
		expect(result.ok).toBe(false);
	});

	it("rejects extra factory keys", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(
			Object.freeze({ preAuthorizedInbox: preauth, extra: true }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects non-Object.prototype preAuthorizedInbox (null proto)", async () => {
		const ps = makePreauth();
		const inner = Object.assign(Object.create(null), {
			authorizeAdmit: ps.authorizeAdmit,
			dispatchPending: ps.dispatchPending,
			close: ps.close,
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: inner }));
		expect(result.ok).toBe(false);
	});

	it("reports cleanup uncertainty for a Proxy preAuthorizedInbox", async () => {
		const preauth = makePreauth();
		const proxy = new Proxy(preauth, {});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: proxy }));
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("reports cleanup uncertainty for a Proxy outer input", async () => {
		const outer = new Proxy({ preAuthorizedInbox: makePreauth() }, {});
		const result = await createOrderedTargetInboxApplication(outer);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("does not invoke an outer preAuthorizedInbox accessor", async () => {
		let invoked = false;
		const outer: Record<string, unknown> = {};
		Object.defineProperty(outer, "preAuthorizedInbox", {
			enumerable: true,
			get: (): unknown => {
				invoked = true;
				return makePreauth();
			},
		});
		const result = await createOrderedTargetInboxApplication(outer);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(invoked).toBe(false);
	});

	it("rejects preAuthorizedInbox with extra own property", async () => {
		const preauth: Record<string, unknown> = {
			authorizeAdmit: makeAdmitSuccess(makeEnvelope()),
			dispatchPending: async () => Object.freeze({ ok: true, value: undefined }),
			close: async () => Object.freeze({ ok: true, value: undefined }),
			extra: true,
		};
		const result = await createOrderedTargetInboxApplication(
			Object.freeze({ preAuthorizedInbox: Object.freeze(preauth) }),
		);
		expect(result.ok).toBe(false);
	});

	it("acquires close on factory rejection", async () => {
		let closed = false;
		const preauth = makePreauth({
			close: async () => {
				closed = true;
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(
			Object.freeze({ preAuthorizedInbox: preauth, extra: true }),
		);
		expect(result.ok).toBe(false);
		expect(closed).toBe(true);
	});

	it("close uncertainty dominates factory rejection", async () => {
		const preauth = makePreauth({
			close: async () => Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) }),
		});
		const result = await createOrderedTargetInboxApplication(
			Object.freeze({ preAuthorizedInbox: preauth, extra: true }),
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// Apply
// ===========================================================================

describe("apply", () => {
	it("accepts valid agent_message and returns applied", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "applied" });
		await app.close();
	});

	it("poisons on non-object apply input (null)", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(null)).toEqual({ status: "error" });
		// Poisoned - subsequent calls also error
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons on apply input with extra keys", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(Object.freeze({ envelope: makeEnvelope().envelope, extra: true }))).toEqual({
			status: "error",
		});
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons on non-agent_message frame (health)", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const health = Object.freeze({
			envelope: Object.freeze({
				type: "frame",
				frameId: "hf-1",
				protocol: Object.freeze({ name: "prime-agent.remote-host", version: 1 }),
				sentAt: "2025-01-01T00:00:00.000Z",
				frame: Object.freeze({ type: "health", healthSeq: 1, status: "connected" }),
			}),
		});
		expect(await app.apply(health)).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons on non-frame envelope", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(Object.freeze({ envelope: "not-an-envelope" }))).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons on structured authorize failure (any code)", async () => {
		const preauth = makePreauth({
			authorizeAdmit: async () => Object.freeze({ ok: false, error: Object.freeze({ code: "UNAUTHORIZED" }) }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons on authorize timeout (non-native promise resolves to invalid)", async () => {
		const preauth = makePreauth({
			authorizeAdmit: async () => Promise.resolve({ invalid: true }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons when auth returns non-native promise", async () => {
		const preauth = makePreauth({
			authorizeAdmit: () => Object.create(Promise.prototype),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons on frameId mismatch in receipt", async () => {
		const preauth = makePreauth({
			authorizeAdmit: makeAdmitSuccess(makeEnvelope(), { frameId: "wrong" }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons on semanticId mismatch in receipt", async () => {
		const preauth = makePreauth({
			authorizeAdmit: makeAdmitSuccess(makeEnvelope(), { semanticId: "wrong" }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons on digest mismatch", async () => {
		const preauth = makePreauth({
			authorizeAdmit: makeAdmitSuccess(makeEnvelope(), { semanticDigest: "b".repeat(64) }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons on invalid relationship enum", async () => {
		const preauth = makePreauth({
			authorizeAdmit: async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "unknown" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: "b".repeat(64),
						}),
					}),
				}),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("poisons when authorizeAdmit throws synchronously", async () => {
		const preauth = makePreauth({
			authorizeAdmit: () => {
				throw new Error("sync");
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(await app.apply(makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" }))).toEqual({
			status: "error",
		});
		await app.close();
	});

	it("serializes concurrent apply calls", async () => {
		const order: number[] = [];
		const env1 = makeEnvelope();
		const env2 = makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_test2" });
		const d1 = realDigest(env1);
		const d2 = realDigest(env2);
		const preauth = makePreauth({
			authorizeAdmit: async (_raw: unknown) => {
				const rawEnv = (_raw as { envelope: Record<string, unknown> }).envelope;
				const eid = rawEnv.frameId as string;
				order.push(eid === "tf-1" ? 0 : 1);
				const digest = eid === "tf-1" ? d1 : d2;
				const mid = eid === "tf-1" ? "agentmsg_test1" : "agentmsg_test2";
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: eid,
							semanticId: mid,
							semanticDigest: digest,
						}),
					}),
				});
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const p1 = app.apply(env1);
		const p2 = app.apply(env2);
		expect(await p1).toEqual({ status: "applied" });
		expect(await p2).toEqual({ status: "applied" });
		expect(order).toEqual([0, 1]);
		await app.close();
	});
});

// ===========================================================================
// Close
// ===========================================================================

describe("close", () => {
	it("returns closed on success", async () => {
		let closeCalled = false;
		const preauth = makePreauth({
			close: async () => {
				closeCalled = true;
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.close()).toEqual({ status: "closed" });
		expect(closeCalled).toBe(true);
	});

	it("returns error when underlying close returns AuthorizerResult error", async () => {
		const preauth = makePreauth({
			close: async () => Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.close()).toEqual({ status: "error" });
	});

	it("returns error when underlying close returns {status:closed} (wrong protocol)", async () => {
		const preauth = makePreauth({
			close: async () => Object.freeze({ status: "closed" }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		// {status:closed} does not match AuthorizerResult protocol, so close returns error
		expect(await app.close()).toEqual({ status: "error" });
	});

	it("returns error when underlying close throws", async () => {
		const preauth = makePreauth({
			close: async () => {
				throw new Error("fail");
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.close()).toEqual({ status: "error" });
	});

	it("latches: multiple close calls return same promise", async () => {
		let callCount = 0;
		const preauth = makePreauth({
			close: async () => {
				callCount++;
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const first = app.close();
		const second = app.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		expect(callCount).toBe(1);
	});

	it("drains pending apply before closing", async () => {
		const order: string[] = [];
		const env = makeEnvelope();
		const digest = realDigest(env);
		const preauth = makePreauth({
			authorizeAdmit: async () => {
				order.push("apply-done");
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: digest,
						}),
					}),
				});
			},
			close: async () => {
				order.push("close-done");
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const applyP = app.apply(env);
		await Promise.resolve();
		const closeP = app.close();
		// Apply after close returns error immediately
		expect(await app.apply(makeEnvelope({ frameId: "late", messageId: "late-msg" }))).toEqual({ status: "error" });
		expect(await applyP).toEqual({ status: "applied" });
		expect(await closeP).toEqual({ status: "closed" });
		expect(order).toEqual(["apply-done", "close-done"]);
	});

	it("serializes close with retry dispatchPending", async () => {
		const order: string[] = [];
		const preauth = makePreauth({
			dispatchPending: async () => {
				order.push("dispatch");
				return Object.freeze({ ok: true, value: undefined });
			},
			close: async () => {
				order.push("close");
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		const app = result.application;
		const dp = retry.dispatchPending();
		const cp = app.close();
		expect(await dp).toEqual({ ok: true, value: undefined });
		expect(await cp).toEqual({ status: "closed" });
		expect(order).toEqual(["dispatch", "close"]);
	});
});

// ===========================================================================
// retry.dispatchPending
// ===========================================================================

describe("retry.dispatchPending", () => {
	it("returns ok on success", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		expect(await retry.dispatchPending()).toEqual({ ok: true, value: undefined });
		await result.application.close();
	});

	it("returns CLOSED after application close", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		await result.application.close();
		expect(await retry.dispatchPending()).toEqual({
			ok: false,
			error: { code: "CLOSED" },
		});
	});

	it("returns POISONED after apply poison", async () => {
		const preauth = makePreauth({
			authorizeAdmit: async () => Object.freeze({ notOk: true }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const retry = result.retry;
		await app.apply(makeEnvelope());
		const r = await retry.dispatchPending();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("POISONED");
		await app.close();
	});

	it("returns POISONED on dispatch returning invalid value", async () => {
		const preauth = makePreauth({
			dispatchPending: async () => Promise.resolve({ invalid: true }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		const r = await retry.dispatchPending().catch(() => ({ ok: false, error: { code: "POISONED" } }));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("POISONED");
		const r2 = await retry.dispatchPending().catch(() => ({ ok: false, error: { code: "POISONED" } }));
		expect(r2.ok).toBe(false);
		if (!r2.ok) expect(r2.error.code).toBe("POISONED");
		await result.application.close();
	});

	it("handles structured dispatch failure (non-poisoning code)", async () => {
		const preauth = makePreauth({
			dispatchPending: async () => Object.freeze({ ok: false, error: Object.freeze({ code: "NOT_FOUND" }) }),
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		const r = await retry.dispatchPending();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("POISONED");
		await result.application.close();
	});

	it("handles dispatch sync throw as POISONED", async () => {
		const preauth = makePreauth({
			dispatchPending: () => {
				throw new Error("sync");
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const retry = result.retry;
		const r = await retry.dispatchPending();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("POISONED");
		await result.application.close();
	});

	it("serializes with concurrent apply", async () => {
		const order: string[] = [];
		const env = makeEnvelope();
		const digest = realDigest(env);
		const gate: { resolve: (() => void) | null } = { resolve: null };
		const preauth = makePreauth({
			authorizeAdmit: async () => {
				order.push("apply-start");
				const release = new Promise<void>((r) => {
					gate.resolve = r;
				});
				await release;
				order.push("apply-end");
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: digest,
						}),
					}),
				});
			},
			dispatchPending: async () => {
				order.push("dispatch");
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const retry = result.retry;
		const ap = app.apply(env);
		await Promise.resolve();
		const dp = retry.dispatchPending();
		await Promise.resolve();
		expect(order).toEqual(["apply-start"]);
		gate.resolve?.();
		expect(await ap).toEqual({ status: "applied" });
		expect(await dp).toEqual({ ok: true, value: undefined });
		expect(order).toEqual(["apply-start", "apply-end", "dispatch"]);
		await app.close();
	});
});

// ===========================================================================
// Hostile input
// ===========================================================================

describe("hostile input", () => {
	it("does not invoke hostile apply accessors", async () => {
		const preauth = makePreauth();
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		let invoked = false;
		const hostile = Object.defineProperty({}, "envelope", {
			enumerable: true,
			get() {
				invoked = true;
				return makeEnvelope().envelope;
			},
		});
		expect(await app.apply(hostile)).toEqual({ status: "error" });
		expect(invoked).toBe(false);
		await app.close();
	});

	it("does not invoke preAuthorizedInbox accessors at factory time", async () => {
		let authAccess = false;
		let dispAccess = false;
		let closeAccess = false;
		const preauth: Record<string, unknown> = {};
		Object.defineProperty(preauth, "authorizeAdmit", {
			enumerable: true,
			get() {
				authAccess = true;
				return makeAdmitSuccess(makeEnvelope());
			},
		});
		Object.defineProperty(preauth, "dispatchPending", {
			enumerable: true,
			get() {
				dispAccess = true;
				return async () => Object.freeze({ ok: true, value: undefined });
			},
		});
		Object.defineProperty(preauth, "close", {
			enumerable: true,
			get() {
				closeAccess = true;
				return async () => Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(
			Object.freeze({ preAuthorizedInbox: Object.freeze(preauth) }),
		);
		expect(result.ok).toBe(false);
		expect(authAccess).toBe(false);
		expect(dispAccess).toBe(false);
		expect(closeAccess).toBe(false);
	});

	it("rejects Proxy-wrapped authorizeAdmit function", async () => {
		const authorizeAdmit = new Proxy(
			async () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: "b".repeat(64),
						}),
					}),
				}),
			{},
		);
		const preauth = makePreauth({ authorizeAdmit });
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// Reentrancy
// ===========================================================================

describe("reentrancy", () => {
	it("apply from inside authorizeAdmit callback poisons and returns error", async () => {
		const reentrantCalls: string[] = [];
		let capturedApp: any;
		const preauth = makePreauth({
			authorizeAdmit: async (_raw: unknown) => {
				const app = capturedApp;
				const r = await app.apply(makeEnvelope({ frameId: "reentrant" }));
				reentrantCalls.push(JSON.stringify(r));
				// Return a valid result anyway
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: "b".repeat(64),
						}),
					}),
				});
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		capturedApp = result.application;
		expect(await capturedApp.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(reentrantCalls.length).toBeGreaterThan(0);
		// Poisoned; subsequent calls also error
		expect(await capturedApp.apply(makeEnvelope({ frameId: "tf-3" }))).toEqual({ status: "error" });
		await capturedApp.close();
	});

	it("dispatch from inside authorizeAdmit callback poisons", async () => {
		let reentrantResult: unknown;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let capturedRetry: any;
		const preauth = makePreauth({
			authorizeAdmit: async () => {
				reentrantResult = await capturedRetry.dispatchPending();
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: "b".repeat(64),
						}),
					}),
				});
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Capture retry before calling apply
		capturedRetry = result.retry;
		expect(await result.application.apply(makeEnvelope())).toEqual({ status: "error" });
		expect(reentrantResult).toBeDefined();
		const rr = reentrantResult as { ok: boolean; error?: { code: string } };
		expect(rr.ok).toBe(false);
		if (!rr.ok) expect(rr.error?.code).toBe("POISONED");
		await result.application.close();
	});

	it("close from inside authorizeAdmit callback: single close call, later join", async () => {
		let underlyingCloseCalls = 0;
		let reentrantCloseResult: unknown;
		let capturedApp: any;
		const preauth = makePreauth({
			authorizeAdmit: async () => {
				reentrantCloseResult = await capturedApp.close();
				// Return a value that causes poison through invalid digest
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						allowed: true,
						relationship: Object.freeze({ fromRelationship: "parent" }),
						receipt: Object.freeze({
							status: "queued",
							receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
							frameId: "tf-1",
							semanticId: "agentmsg_test1",
							semanticDigest: "b".repeat(64),
						}),
					}),
				});
			},
			close: async () => {
				underlyingCloseCalls++;
				return Object.freeze({ ok: true, value: undefined });
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		capturedApp = result.application;
		// Outer apply gets error because reentrant close poisoned
		expect(await capturedApp.apply(makeEnvelope())).toEqual({ status: "error" });
		// Reentrant close returned immediate error
		expect(reentrantCloseResult).toEqual({ status: "error" });
		// Underlying close called exactly once (from the scheduled close promise)
		expect(underlyingCloseCalls).toBe(1);
		// Later external close joins the stored shared closePromise
		const laterClose = await capturedApp.close();
		expect(laterClose).toEqual({ status: "closed" });
		// Underlying close still called exactly once
		expect(underlyingCloseCalls).toBe(1);
	});
});

// ===========================================================================
// types.isPromise subclass / wrong proto
// ===========================================================================

describe("isNativePromise guards", () => {
	it("rejects Promise subclass as non-native promise", async () => {
		class MyPromise<T> extends Promise<T> {}
		const preauth = makePreauth({
			authorizeAdmit: () => {
				const p = new MyPromise<unknown>((resolve) => {
					resolve(
						Object.freeze({
							ok: true,
							value: Object.freeze({
								allowed: true,
								relationship: Object.freeze({ fromRelationship: "parent" }),
								receipt: Object.freeze({
									status: "queued",
									receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
									frameId: "tf-1",
									semanticId: "agentmsg_test1",
									semanticDigest: "b".repeat(64),
								}),
							}),
						}),
					);
				});
				return p;
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});

	it("rejects promise-like with extra own properties", async () => {
		const preauth = makePreauth({
			authorizeAdmit: () => {
				const p = Promise.resolve(
					Object.freeze({
						ok: true,
						value: Object.freeze({
							allowed: true,
							relationship: Object.freeze({ fromRelationship: "parent" }),
							receipt: Object.freeze({
								status: "queued",
								receipt: Object.freeze({ sequence: 1, size: 42, sha256: "a".repeat(64) }),
								frameId: "tf-1",
								semanticId: "agentmsg_test1",
								semanticDigest: "b".repeat(64),
							}),
						}),
					}),
				);
				Object.defineProperty(p, "extra", { value: true, enumerable: true });
				return p;
			},
		});
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(makeEnvelope())).toEqual({ status: "error" });
		await app.close();
	});
});

// ===========================================================================
// Preliminary outer close acquisition
// ===========================================================================

describe("preliminary outer close acquisition", () => {
	it("acquires close from symbol-containing outer object then fails", async () => {
		const preauth = makePreauth();
		const outer: Record<string, unknown> = { preAuthorizedInbox: preauth };
		Object.defineProperty(outer, Symbol("extra"), { value: true, enumerable: true });
		const result = await createOrderedTargetInboxApplication(Object.freeze(outer));
		expect(result.ok).toBe(false);
	});

	it("acquires close from null-prototype outer object then fails", async () => {
		const preauth = makePreauth();
		const outer = Object.assign(Object.create(null), { preAuthorizedInbox: preauth });
		const result = await createOrderedTargetInboxApplication(outer);
		expect(result.ok).toBe(false);
	});

	it("acquires close from custom-prototype outer object then fails", async () => {
		const inner = makePreauth();
		const outer = Object.assign(Object.create({ preAuthorizedInbox: inner }), {
			preAuthorizedInbox: inner,
		});
		const result = await createOrderedTargetInboxApplication(outer);
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// Cross-transport / replay receipts
// ===========================================================================

describe("replay and cross-transport receipts", () => {
	it("accepts same semantic message from different transport frameIds", async () => {
		const env1 = makeEnvelope({ messageId: "agentmsg_same" });
		const env2 = makeEnvelope({ frameId: "tf-2", messageId: "agentmsg_same" });
		const preauth = makePreauth({ authorizeAdmit: makeAdmitSuccess(env1) });
		const result = await createOrderedTargetInboxApplication(Object.freeze({ preAuthorizedInbox: preauth }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply(env1)).toEqual({ status: "applied" });
		// env2 has frameId "tf-2" but preauth returns receipt with frameId "tf-1" -> poison
		expect(await app.apply(env2)).toEqual({ status: "error" });
		await app.close();
	});
});
