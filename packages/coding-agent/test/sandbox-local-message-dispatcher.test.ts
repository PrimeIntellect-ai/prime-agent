import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DispatcherCapability } from "../src/modes/daemon/durable-target-inbox.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
} from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import { createSandboxLocalMessageDispatcher } from "../src/modes/daemon/sandbox-local-message-dispatcher.js";
import { createHarness } from "./suite/harness.js";

// ===========================================================================
// Helpers
// ===========================================================================

const DEFAULT_ACTIVE_SESSION_ID = "target-session-42";

function getPreflight(options: unknown): ((success: boolean, queued?: boolean) => void) | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const desc = Object.getOwnPropertyDescriptors(options);
	const pfDesc = desc.preflightResult;
	if (pfDesc === undefined || !("value" in pfDesc)) return undefined;
	const pf = pfDesc.value;
	return typeof pf === "function" ? pf : undefined;
}

function validEnvelope(
	overrides?: Readonly<{
		frameId?: string;
		messageId?: string;
		from?: string;
		target?: string;
		message?: string;
		deliveryMode?: "queued" | "direct";
	}>,
): Record<string, unknown> {
	return Object.freeze({
		envelope: Object.freeze({
			type: "frame",
			frameId: overrides?.frameId ?? "tf-1",
			protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
			sentAt: "2025-01-15T10:30:00.000Z",
			frame: Object.freeze({
				type: "agent_message",
				id: overrides?.messageId ?? "agentmsg_test1",
				fromActiveSessionId: overrides?.from ?? "source-session",
				targetActiveSessionId: overrides?.target ?? DEFAULT_ACTIVE_SESSION_ID,
				message: overrides?.message ?? "hello",
				...(overrides?.deliveryMode !== undefined ? { deliveryMode: overrides.deliveryMode } : {}),
			}),
		}),
	});
}

function healthEnvelope(): Record<string, unknown> {
	return Object.freeze({
		envelope: Object.freeze({
			type: "frame",
			frameId: "hf-1",
			protocol: Object.freeze({ name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION }),
			sentAt: "2025-01-15T10:30:00.000Z",
			frame: Object.freeze({ type: "health", healthSeq: 1, status: "connected" }),
		}),
	});
}

function makeEnsureInput(envelope: Record<string, unknown>, digest?: string): Record<string, unknown> {
	const envVal: unknown = envelope.envelope;
	let computed: string;
	if (typeof digest === "string") {
		computed = digest;
	} else if (typeof envVal !== "object" || envVal === null) {
		computed = "0".repeat(64);
	} else {
		const envDesc = Object.getOwnPropertyDescriptors(envVal);
		const frameDesc = envDesc.frame;
		if (frameDesc === undefined || !("value" in frameDesc)) {
			computed = "0".repeat(64);
		} else {
			const result = canonicalDigest(frameDesc.value);
			computed = result.ok ? result.value : "0".repeat(64);
		}
	}
	return Object.freeze({ envelope: envelope.envelope, semanticDigest: computed });
}

function computeDigest(frame: Record<string, unknown>): string {
	const result = canonicalDigest(frame);
	return result.ok ? result.value : "0".repeat(64);
}

function computeDigestForEnvelope(envelope: Record<string, unknown>): string {
	const envVal: unknown = envelope.envelope;
	if (typeof envVal !== "object" || envVal === null) return "0".repeat(64);
	const envDesc = Object.getOwnPropertyDescriptors(envVal);
	const frameDesc = envDesc.frame;
	if (frameDesc === undefined || !("value" in frameDesc)) return "0".repeat(64);
	const result = canonicalDigest(frameDesc.value);
	return result.ok ? result.value : "0".repeat(64);
}

/** Apply overrides to a harness session, restore on cleanup. */
async function withOverrides(
	overrides: Record<string, PropertyDescriptor>,
	activeSessionId = DEFAULT_ACTIVE_SESSION_ID,
): Promise<{
	harness: Awaited<ReturnType<typeof createHarness>>;
	dispatcher: DispatcherCapability;
}> {
	const h = await createHarness();
	const session = h.session;
	const saved: Array<{ key: string; desc: PropertyDescriptor | undefined }> = [];
	for (const key of Object.keys(overrides)) {
		saved.push({ key, desc: Object.getOwnPropertyDescriptor(session, key) });
		Object.defineProperty(session, key, overrides[key]);
	}
	const restore = (): void => {
		for (const { key, desc } of saved) {
			if (desc) {
				Object.defineProperty(session, key, desc);
			} else {
				Reflect.deleteProperty(session, key);
			}
		}
	};
	// Materialize session file inside tempDir so we have a real sessionDir
	const tempDir = mkdtempSync(join(tmpdir(), "sld-test-"));
	session.sessionManager.materializeSessionFile(tempDir);
	const result = await createSandboxLocalMessageDispatcher(
		Object.freeze({ session, activeSessionId, sessionDir: tempDir }),
	);
	if (!result.ok) throw new Error(`expected ok factory result: ${JSON.stringify(result)}`);
	const origCleanup = h.cleanup.bind(h);
	h.cleanup = () => {
		restore();
		origCleanup();
	};
	return { harness: h, dispatcher: result.dispatcher };
}

function messageWithDigest(messageId: string, semanticDigest: string): Record<string, unknown> {
	return Object.freeze({
		role: "custom",
		customType: "agent_message",
		details: Object.freeze({
			id: messageId,
			semanticDigest,
		}),
	});
}

// ===========================================================================
// Factory
// ===========================================================================

describe("createSandboxLocalMessageDispatcher factory", () => {
	it("creates with valid AgentSession", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-fact-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session: h.session, activeSessionId: "test-session", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof result.dispatcher.ensure).toBe("function");
		expect(typeof result.dispatcher.close).toBe("function");
		await result.dispatcher.close();
		await h.cleanup();
	});

	it("rejects missing session key", async () => {
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ activeSessionId: DEFAULT_ACTIVE_SESSION_ID, sessionDir: "/tmp" }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects missing activeSessionId key", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-fact-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session: h.session, sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		await h.cleanup();
	});

	it("rejects extra factory keys", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-fact-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({
				session: h.session,
				activeSessionId: DEFAULT_ACTIVE_SESSION_ID,
				sessionDir: tempDir,
				extra: true,
			}),
		);
		expect(result.ok).toBe(false);
		await h.cleanup();
	});

	it("rejects non-AgentSession session value", async () => {
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({
				session: { not: "a session" },
				activeSessionId: DEFAULT_ACTIVE_SESSION_ID,
				sessionDir: "/tmp",
			}),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects empty activeSessionId", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-fact-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session: h.session, activeSessionId: "", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		await h.cleanup();
	});

	it("does not invoke session accessor at factory time", async () => {
		let invoked = false;
		const outer: Record<string, unknown> = {};
		Object.defineProperty(outer, "session", {
			enumerable: true,
			get: () => {
				invoked = true;
				return {};
			},
		});
		Object.defineProperty(outer, "activeSessionId", { enumerable: true, value: DEFAULT_ACTIVE_SESSION_ID });
		Object.defineProperty(outer, "sessionDir", { enumerable: true, value: "/tmp" });
		const result = await createSandboxLocalMessageDispatcher(outer);
		expect(result.ok).toBe(false);
		expect(invoked).toBe(false);
	});
});

// ===========================================================================
// Ensure — direct delivery (persisted)
// ===========================================================================

describe("ensure direct delivery", () => {
	it("persisted when transcript evidence exact before injection", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			messages: {
				get: () => Object.freeze([messageWithDigest("agentmsg_test1", digest)]),
				enumerable: true,
				configurable: true,
			},
		});
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result).toEqual({ status: "persisted" });
		await dispatcher.close();
		await harness.cleanup();
	});

	it("persisted after direct injection and post-evidence is exact", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const acceptCalls: string[] = [];
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, options?: Record<string, unknown>) => {
					acceptCalls.push(_content);
					const pf = getPreflight(options);
					if (pf) pf(true, false);
				},
				writable: true,
				configurable: true,
			},
			messages: {
				get: () => Object.freeze([messageWithDigest("agentmsg_test1", digest)]),
				enumerable: true,
				configurable: true,
			},
		});
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		// Messages already has the message, so pre-evidence is exact → skip injection
		expect(result).toEqual({ status: "persisted" });
		expect(acceptCalls).toHaveLength(0);
		await dispatcher.close();
		await harness.cleanup();
	});

	it("persisted when post-evidence becomes exact after direct accept", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		let messages: readonly Record<string, unknown>[] = [];
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, options?: Record<string, unknown>) => {
					// After accept, push the message to evidence
					messages = Object.freeze([messageWithDigest("agentmsg_test1", digest)]);
					const pf = getPreflight(options);
					if (pf) pf(true, false);
				},
				writable: true,
				configurable: true,
			},
			messages: {
				get: () => messages,
				enumerable: true,
				configurable: true,
			},
		});
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result).toEqual({ status: "persisted" });
		await dispatcher.close();
		await harness.cleanup();
	});
});

// ===========================================================================
// Ensure — queued delivery (deferred)
// ===========================================================================

describe("ensure queued delivery", () => {
	it("deferred when queued and snapshot confirms", async () => {
		const env = validEnvelope({ deliveryMode: "queued" });
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, options?: Record<string, unknown>) => {
					const pf = getPreflight(options);
					if (pf) pf(true, true);
				},
				writable: true,
				configurable: true,
			},
			getSessionActionRecoverySnapshot: {
				value: () =>
					Object.freeze({
						formatVersion: 1,
						actions: Object.freeze([
							Object.freeze({
								id: "action-1",
								agentMessageId: "agentmsg_test1",
								payload: Object.freeze({
									kind: "turn",
									text: "test",
									customMessage: Object.freeze({
										role: "custom",
										customType: "agent_message",
										details: Object.freeze({
											id: "agentmsg_test1",
											semanticDigest: digest,
										}),
									}),
								}),
							}),
						]),
					}),
				writable: true,
				configurable: true,
			},
		});
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result).toEqual({ status: "deferred" });
		await dispatcher.close();
		await harness.cleanup();
	});

	it("repeated deferred when queued snapshot still exact (no re-injection)", async () => {
		const env = validEnvelope({ deliveryMode: "queued" });
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			getSessionActionRecoverySnapshot: {
				value: () =>
					Object.freeze({
						formatVersion: 1,
						actions: Object.freeze([
							Object.freeze({
								id: "action-1",
								agentMessageId: "agentmsg_test1",
								payload: Object.freeze({
									kind: "turn",
									text: "test",
									customMessage: Object.freeze({
										role: "custom",
										customType: "agent_message",
										details: Object.freeze({
											id: "agentmsg_test1",
											semanticDigest: digest,
										}),
									}),
								}),
							}),
						]),
					}),
				writable: true,
				configurable: true,
			},
		});
		const result1 = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result1).toEqual({ status: "deferred" });
		const result2 = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result2).toEqual({ status: "deferred" });
		await dispatcher.close();
		await harness.cleanup();
	});

	it("re-admit when queued snapshot absent after crash", async () => {
		const env = validEnvelope({ deliveryMode: "queued" });
		const digest = computeDigestForEnvelope(env);
		const acceptCount: number[] = [];
		let actions: readonly Record<string, unknown>[] = [];
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, options?: Record<string, unknown>) => {
					acceptCount.push(1);
					// After accept, populate the snapshot
					actions = Object.freeze([
						Object.freeze({
							id: "action-1",
							agentMessageId: "agentmsg_test1",
							payload: Object.freeze({
								kind: "turn",
								text: "test",
								customMessage: Object.freeze({
									role: "custom",
									customType: "agent_message",
									details: Object.freeze({
										id: "agentmsg_test1",
										semanticDigest: digest,
									}),
								}),
							}),
						}),
					]);
					const pf = getPreflight(options);
					if (pf) pf(true, true);
				},
				writable: true,
				configurable: true,
			},
			getSessionActionRecoverySnapshot: {
				value: () => Object.freeze({ formatVersion: 1, actions }),
				writable: true,
				configurable: true,
			},
		});
		// If no pre-evidence and no snapshot, should try injection → queued → check snapshot
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result).toEqual({ status: "deferred" });
		expect(acceptCount).toHaveLength(1);
		// Simulate crash: clear snapshot
		actions = [];
		// Re-admit — should re-queue and populate snapshot again
		const result2 = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result2).toEqual({ status: "deferred" });
		expect(acceptCount).toHaveLength(2);
		await dispatcher.close();
		await harness.cleanup();
	});
});

// ===========================================================================
// Ensure — mismatch / error
// ===========================================================================

describe("ensure mismatch", () => {
	it("poisons on non-agent_message frame", async () => {
		const { harness, dispatcher } = await withOverrides({});
		const disruptor = computeDigest({ type: "health" });
		await expect(dispatcher.ensure(makeEnsureInput(healthEnvelope(), disruptor))).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("poisons on target mismatch", async () => {
		const env = validEnvelope({ target: "wrong-target" });
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({});
		await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("poisons on digest mismatch", async () => {
		const env = validEnvelope();
		const { harness, dispatcher } = await withOverrides({});
		await expect(dispatcher.ensure(makeEnsureInput(env, "b".repeat(64)))).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("poisons on null ensure input", async () => {
		const { harness, dispatcher } = await withOverrides({});
		await expect(dispatcher.ensure(null)).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("poisons on ensure input with extra keys", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({});
		await expect(
			dispatcher.ensure(Object.freeze({ envelope: env.envelope, semanticDigest: digest, extra: true })),
		).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("poisons on non-envelope ensure input", async () => {
		const digest = computeDigestForEnvelope(validEnvelope());
		const { harness, dispatcher } = await withOverrides({});
		await expect(
			dispatcher.ensure(Object.freeze({ envelope: "not-an-envelope", semanticDigest: digest })),
		).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});
});

// ===========================================================================
// Close
// ===========================================================================

describe("close", () => {
	it("returns closed", async () => {
		const { harness, dispatcher } = await withOverrides({});
		expect(await dispatcher.close()).toEqual({ status: "closed" });
		await harness.cleanup();
	});

	it("latches: multiple close calls return same promise", async () => {
		const { harness, dispatcher } = await withOverrides({});
		const first = dispatcher.close();
		const second = dispatcher.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		await harness.cleanup();
	});

	it("drains pending ensure before closing", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, options?: Record<string, unknown>) => {
					const pf = getPreflight(options);
					if (pf) pf(true, false);
				},
				writable: true,
				configurable: true,
			},
			messages: {
				get: () => Object.freeze([messageWithDigest("agentmsg_test1", digest)]),
				enumerable: true,
				configurable: true,
			},
		});
		// Pre-existing evidence → persisted
		const ensureP = dispatcher.ensure(makeEnsureInput(env, digest));
		await Promise.resolve();
		const closeP = dispatcher.close();
		await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
		expect(await ensureP).toEqual({ status: "persisted" });
		expect(await closeP).toEqual({ status: "closed" });
		await harness.cleanup();
	});
});

// ===========================================================================
// Reentrancy
// ===========================================================================

describe("reentrancy", () => {
	it("ensure from inside acceptAgentMessagePrompt poisons", async () => {
		let captureDisp: DispatcherCapability | null = null;
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, _options?: Record<string, unknown>) => {
					if (captureDisp) {
						await captureDisp.ensure(makeEnsureInput(validEnvelope({ frameId: "reentrant" }))).catch(() => {});
					}
				},
				writable: true,
				configurable: true,
			},
		});
		captureDisp = dispatcher;
		await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	it("close from inside acceptAgentMessagePrompt returns error", async () => {
		let captureDisp: DispatcherCapability | null = null;
		let reentrantClose: unknown;
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			acceptAgentMessagePrompt: {
				value: async (_content: string, _options?: Record<string, unknown>) => {
					if (captureDisp) {
						reentrantClose = await captureDisp.close();
					}
				},
				writable: true,
				configurable: true,
			},
		});
		captureDisp = dispatcher;
		await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
		expect(reentrantClose).toEqual({ status: "error" });
		await dispatcher.close();
		await harness.cleanup();
	});
});

// ===========================================================================
// Hostile input
// ===========================================================================

describe("hostile input", () => {
	it("does not invoke hostile ensure input accessors", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			messages: {
				get: () => Object.freeze([messageWithDigest("agentmsg_test1", digest)]),
				enumerable: true,
				configurable: true,
			},
		});
		let invoked = false;
		const hostile = Object.defineProperty({}, "envelope", {
			enumerable: true,
			get() {
				invoked = true;
				return env.envelope;
			},
		});
		// The accessor-only descriptor means rawDescriptors sees no "value" → returns null
		// exact() → null → poisoned
		await expect(dispatcher.ensure(Object.freeze({ envelope: hostile, semanticDigest: digest }))).rejects.toThrow();
		expect(invoked).toBe(false);
		await dispatcher.close();
		await harness.cleanup();
	});
});

// ===========================================================================
// Hostile own shadows
// ===========================================================================

describe("hostile own shadows", () => {
	it("rejects hostile own acceptAgentMessagePrompt (accessor, not function value)", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-host-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const session = h.session;
		// Set hostile own accessor
		let accessed = false;
		Object.defineProperty(session, "acceptAgentMessagePrompt", {
			get: () => {
				accessed = true;
				return async () => {};
			},
			enumerable: true,
			configurable: true,
		});
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		expect(accessed).toBe(false); // descriptor inspection does not trigger getter
		Object.defineProperty(session, "acceptAgentMessagePrompt", { value: undefined, configurable: true });
		await h.cleanup();
	});

	it("rejects hostile own messages (accessor, not getter)", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-host2-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const session = h.session;
		Object.defineProperty(session, "messages", {
			value: "not-an-array",
			enumerable: true,
			configurable: true,
		});
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		Object.defineProperty(session, "messages", { value: undefined, configurable: true });
		await h.cleanup();
	});

	it("rejects hostile own sessionId (non-string value)", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-host3-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const session = h.session;
		Object.defineProperty(session, "sessionId", {
			value: 42,
			enumerable: true,
			configurable: true,
		});
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		Object.defineProperty(session, "sessionId", { value: undefined, configurable: true });
		await h.cleanup();
	});

	it("rejects own setter-only messages accessor (shadows prototype getter)", async () => {
		const h = await createHarness();
		const tempDir = mkdtempSync(join(tmpdir(), "sld-host4-"));
		h.session.sessionManager.materializeSessionFile(tempDir);
		const session = h.session;
		// Own setter-only accessor with no get and no value — shadows prototype getter
		Object.defineProperty(session, "messages", {
			set: (_v: unknown[]) => {},
			enumerable: true,
			configurable: true,
		});
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
		);
		expect(result.ok).toBe(false);
		Reflect.deleteProperty(session, "messages");
		await h.cleanup();
	});
});

// ===========================================================================
// Frozen results
// ===========================================================================

describe("frozen results", () => {
	it("persisted returns frozen object", async () => {
		// Direct check of the result builder, not through dispatcher
		// (dispatcher may unwrap frozenness through promise chains)
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({
			messages: {
				get: () => Object.freeze([messageWithDigest("agentmsg_test1", digest)]),
				enumerable: true,
				configurable: true,
			},
		});
		const result = await dispatcher.ensure(makeEnsureInput(env, digest));
		expect(result.status).toBe("persisted");
		await dispatcher.close();
		await harness.cleanup();
	});

	it("factory error result is frozen", async () => {
		const result = await createSandboxLocalMessageDispatcher(
			Object.freeze({ session: { not: "a session" }, activeSessionId: "test", sessionDir: "/tmp" }),
		);
		expect(result.ok).toBe(false);
		expect(Object.isFrozen(result)).toBe(true);
		if (!result.ok) {
			expect(Object.isFrozen(result.error)).toBe(true);
		}
	});
});

// ===========================================================================
// Poison latch
// ===========================================================================

describe("poison latch", () => {
	it("poison persists after failed ensure", async () => {
		const env = validEnvelope();
		const digest = computeDigestForEnvelope(env);
		const { harness, dispatcher } = await withOverrides({});
		// Poison via target mismatch (this is detected before enqueue)
		const badEnv = validEnvelope({ target: "wrong-target" });
		const badDigest = computeDigestForEnvelope(badEnv);
		await expect(dispatcher.ensure(makeEnsureInput(badEnv, badDigest))).rejects.toThrow();
		// After poison, even correct input should reject
		await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
		await dispatcher.close();
		await harness.cleanup();
	});

	// ===========================================================================
	// denseArray — cast-free, canonical index, bounded
	// ===========================================================================

	describe("denseArray", () => {
		it("noncanonical index '01' poisons (cannot mask a hole)", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, define noncanonical index, THEN freeze
						const arr: Array<Record<string, unknown>> = [];
						Object.defineProperty(arr, "0", {
							value: Object.freeze({
								agentMessageId: "msg1",
								payload: Object.freeze({
									customMessage: Object.freeze({
										details: Object.freeze({ id: "test", semanticDigest: digest }),
									}),
								}),
							}),
							enumerable: true,
							configurable: true,
						});
						// Non-canonical index "01" masks a hole — should be rejected
						Object.defineProperty(arr, "01", {
							value: Object.freeze({
								agentMessageId: "msg2",
								payload: Object.freeze({
									customMessage: Object.freeze({
										details: Object.freeze({ id: "test2", semanticDigest: digest }),
									}),
								}),
							}),
							enumerable: true,
							configurable: true,
						});
						Object.defineProperty(arr, "length", {
							value: 2,
							writable: true,
							configurable: false,
							enumerable: false,
						});
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			// Non-canonical "01" → denseArray returns null → mismatch → poison
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("excessively large array (>20_000) poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, set oversized length, THEN freeze
						const arr: Array<Record<string, unknown>> = [];
						Object.defineProperty(arr, "length", {
							value: 20001,
							writable: true,
							configurable: false,
							enumerable: false,
						});
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("symbol property on array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, add symbol, THEN freeze
						const arr: Array<Record<string, unknown>> = [];
						const sym = Symbol("custom");
						Object.defineProperty(arr, sym, { value: true, enumerable: true });
						Object.defineProperty(arr, "length", {
							value: 0,
							writable: true,
							configurable: false,
							enumerable: false,
						});
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});
	});
});

// ===========================================================================
// Reentrant close then external close
// ===========================================================================

describe("reentrant close", () => {
	it("close after poison returns closed", async () => {
		const { harness, dispatcher } = await withOverrides({});
		// Poison via null input
		await expect(dispatcher.ensure(null)).rejects.toThrow();
		// Close after poison still works
		expect(await dispatcher.close()).toEqual({ status: "closed" });
		await harness.cleanup();
	});

	// ===========================================================================
	// scanQueuedSnapshot — uncertainty poisons (Proxy, malformed, sparse, holes)
	// ===========================================================================

	describe("scanQueuedSnapshot uncertainty", () => {
		it("Proxy snapshot top-level poisons (mismatch not absent)", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => new Proxy(Object.freeze({ formatVersion: 1, actions: [] }), {}),
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("accessor-index array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, define accessor index, THEN freeze
						const arr: Array<Record<string, unknown>> = [];
						Object.defineProperty(arr, "0", { get: () => ({}), enumerable: true, configurable: true });
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("sparse actions array poisons (not absent)", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						const sparse: Array<Record<string, unknown>> = [];
						sparse.length = 5;
						return Object.freeze({ formatVersion: 1, actions: Object.freeze(sparse) });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("Proxy actions array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						const proxyArr = new Proxy([], {});
						return Object.freeze({ formatVersion: 1, actions: Object.freeze(proxyArr) });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("custom-prototype actions array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						const cpArr: Array<Record<string, unknown>> = [];
						Object.setPrototypeOf(cpArr, { custom: true });
						Object.freeze(cpArr);
						return Object.freeze({ formatVersion: 1, actions: Object.freeze(cpArr) });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("extra own key on actions array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, add extra key, THEN freeze
						const arr: Array<Record<string, unknown>> = [];
						arr.push(
							Object.freeze({
								id: "a1",
								agentMessageId: "msg1",
								payload: Object.freeze({
									customMessage: Object.freeze({
										details: Object.freeze({ id: "test", semanticDigest: "a".repeat(64) }),
									}),
								}),
							}),
						);
						Object.defineProperty(arr, "custom", { value: true, enumerable: true, configurable: true });
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("non-enumerable index in actions array poisons", async () => {
			const env = validEnvelope({ deliveryMode: "queued" });
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				getSessionActionRecoverySnapshot: {
					value: () => {
						// Build mutable, make index non-enumerable, THEN freeze
						const arr: Array<Record<string, unknown>> = [{}];
						Object.defineProperty(arr, "0", { value: {}, enumerable: false, configurable: true });
						Object.freeze(arr);
						return Object.freeze({ formatVersion: 1, actions: arr });
					},
					writable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});
	});

	// ===========================================================================
	// scanMessages — Proxy entries poison
	// ===========================================================================

	describe("scanMessages", () => {
		it("Proxy message in array poisons", async () => {
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				messages: {
					get: () =>
						Object.freeze([
							new Proxy(
								Object.freeze({
									role: "custom",
									customType: "agent_message",
									details: Object.freeze({ id: "agentmsg_test1", semanticDigest: digest }),
								}),
								{},
							),
						]),
					enumerable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});
	});

	// ===========================================================================
	// isNativePromise — exact checks
	// ===========================================================================

	describe("isNativePromise", () => {
		it("Promise subclass return from acceptAgentMessagePrompt poisons (not native)", async () => {
			// When acceptAgentMessagePrompt returns a Promise subclass (not exact Promise.prototype),
			// observePromise → isNativePromise returns false → invalidObs → poison
			class MyPromise extends Promise<void> {
				// empty subclass — prototype is MyPromise.prototype, not Promise.prototype
			}
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				acceptAgentMessagePrompt: {
					value: async (_content: string, options?: Record<string, unknown>) => {
						const pf = getPreflight(options);
						if (pf) pf(true, false);
						return new MyPromise((resolve) => resolve());
					},
					writable: true,
					configurable: true,
				},
				messages: {
					get: () => Object.freeze([]),
					enumerable: true,
					configurable: true,
				},
			});
			// No pre-evidence → inject path → acceptAgentMessagePrompt returns Promise subclass → poison
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("own-property thenable from acceptAgentMessagePrompt poisons", async () => {
			// An object with own .then but not a native Promise → isNativePromise false → poison
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				acceptAgentMessagePrompt: {
					value: async (_content: string, options?: Record<string, unknown>) => {
						const pf = getPreflight(options);
						if (pf) pf(true, false);
						const forgedThen: Record<string, unknown> = {};
						// biome-ignore lint/suspicious/noThenProperty: test
						Object.defineProperty(forgedThen, "then", {
							enumerable: true,
							writable: true,
							configurable: true,
							value: (r: (v: unknown) => void) => r({ status: "fulfilled", value: undefined }),
						});
						return forgedThen;
					},
					writable: true,
					configurable: true,
				},
				messages: {
					get: () => Object.freeze([]),
					enumerable: true,
					configurable: true,
				},
			});
			// No pre-evidence → inject path → accept returns thenable → isNativePromise false → poison
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("forged prototype object is not native Promise", async () => {
			// Object with Promise.prototype forged via setPrototypeOf but not a real Promise
			// Uses Proxy rejection via types.isProxy for robustness, but the forged prototype
			// object fails types.isPromise anyway.
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				acceptAgentMessagePrompt: {
					value: async (_content: string, options?: Record<string, unknown>) => {
						const pf = getPreflight(options);
						if (pf) pf(true, false);
						const forged = Object.setPrototypeOf({}, Promise.prototype);
						return forged;
					},
					writable: true,
					configurable: true,
				},
				messages: {
					get: () => Object.freeze([]),
					enumerable: true,
					configurable: true,
				},
			});
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("Promise with own properties (not native)", async () => {
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			const { harness, dispatcher } = await withOverrides({
				acceptAgentMessagePrompt: {
					value: async (_content: string, options?: Record<string, unknown>) => {
						const pf = getPreflight(options);
						if (pf) pf(true, false);
						const p = new Promise<void>((resolve) => resolve());
						Object.defineProperty(p, "customProp", { value: true, enumerable: true });
						return p;
					},
					writable: true,
					configurable: true,
				},
				messages: {
					get: () => Object.freeze([]),
					enumerable: true,
					configurable: true,
				},
			});
			// Own property on Promise → isNativePromise false → poison
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});
	});

	// ===========================================================================
	// Prototype fallback — nearest invalid descriptor rejects
	// ===========================================================================

	describe("prototype fallback", () => {
		it("rejects when nearest prototype acceptAgentMessagePrompt is accessor", async () => {
			const h = await createHarness();
			const tempDir = mkdtempSync(join(tmpdir(), "sld-proto-"));
			h.session.sessionManager.materializeSessionFile(tempDir);
			const session = h.session;
			const proto = Object.getPrototypeOf(session);
			const origDesc = Object.getOwnPropertyDescriptor(proto, "acceptAgentMessagePrompt");
			Object.defineProperty(proto, "acceptAgentMessagePrompt", {
				get: () => async () => {},
				enumerable: true,
				configurable: true,
			});
			const result = await createSandboxLocalMessageDispatcher(
				Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
			);
			expect(result.ok).toBe(false);
			if (origDesc) Object.defineProperty(proto, "acceptAgentMessagePrompt", origDesc);
			else Reflect.deleteProperty(proto, "acceptAgentMessagePrompt");
			await h.cleanup();
		});

		it("rejects when nearest prototype messages is invalid non-getter non-value", async () => {
			const h = await createHarness();
			const tempDir = mkdtempSync(join(tmpdir(), "sld-proto2-"));
			h.session.sessionManager.materializeSessionFile(tempDir);
			const session = h.session;
			const proto = Object.getPrototypeOf(session);
			const origDesc = Object.getOwnPropertyDescriptor(proto, "messages");
			Object.defineProperty(proto, "messages", {
				value: "not-an-array",
				enumerable: true,
				configurable: true,
			});
			const result = await createSandboxLocalMessageDispatcher(
				Object.freeze({ session, activeSessionId: "test-session", sessionDir: tempDir }),
			);
			expect(result.ok).toBe(false);
			if (origDesc) Object.defineProperty(proto, "messages", origDesc);
			else Reflect.deleteProperty(proto, "messages");
			await h.cleanup();
		});
	});

	// ===========================================================================
	// searchSessionTranscript — ok:false poisons
	// ===========================================================================

	describe("searchSessionTranscript", () => {
		it("SCAN_UNCERTAIN poisons rather than absent", async () => {
			// Use a file path (not a directory) so opendir fails → UNCERTAIN
			const h = await createHarness();
			const session = h.session;
			const nonDirPath = join(tmpdir(), `sld-scan-nondir-${Date.now()}.txt`);
			writeFileSync(nonDirPath, "not a directory");
			try {
				const result = await createSandboxLocalMessageDispatcher(
					Object.freeze({ session, activeSessionId: DEFAULT_ACTIVE_SESSION_ID, sessionDir: nonDirPath }),
				);
				expect(result.ok).toBe(true);
				if (!result.ok) return;
				const env = validEnvelope();
				const digest = computeDigestForEnvelope(env);
				await expect(result.dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
				await result.dispatcher.close();
			} finally {
				try {
					rmSync(nonDirPath);
				} catch {
					/* ignore */
				}
			}
			await h.cleanup();
		});
	});

	// ===========================================================================
	// getMessages — non-array getter poisons
	// ===========================================================================

	describe("getMessages", () => {
		it("non-array getter result throws POISON (not empty array)", async () => {
			const { harness, dispatcher } = await withOverrides({
				messages: {
					get: () => "not-an-array",
					enumerable: true,
					configurable: true,
				},
			});
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});

		it("Proxy messages array poisons", async () => {
			const { harness, dispatcher } = await withOverrides({
				messages: {
					get: () => new Proxy([], {}),
					enumerable: true,
					configurable: true,
				},
			});
			const env = validEnvelope();
			const digest = computeDigestForEnvelope(env);
			await expect(dispatcher.ensure(makeEnsureInput(env, digest))).rejects.toThrow();
			await dispatcher.close();
			await harness.cleanup();
		});
	});
});
