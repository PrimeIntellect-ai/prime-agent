import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	createSessionTranscriptDispatcher,
	type DispatcherCapability,
} from "../src/modes/daemon/session-transcript-dispatcher.js";

async function createDisp(ctx: Record<string, unknown>): Promise<DispatcherCapability> {
	const r = await createSessionTranscriptDispatcher(ctx);
	if (!r.ok) throw new Error("create dispatcher failed");
	return r.value;
}

function _sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function makeEnvelope(
	frameId: string,
	agentId: string,
	sentAt: string,
	message: string,
	fromActiveSessionId = "parent-1",
	targetActiveSessionId = "child-1",
): Record<string, unknown> {
	return Object.freeze({
		type: "frame",
		frameId,
		protocol: Object.freeze({ name: "prime-agent.remote-host", version: 1 }),
		sentAt,
		frame: Object.freeze({
			type: "agent_message",
			id: agentId,
			fromActiveSessionId,
			targetActiveSessionId,
			message,
		}),
	});
}

function makeContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const defaults: Record<string, unknown> = {
		resolveSession: async () => undefined,
		getActiveSession: () => undefined,
		acceptAgentMessage: async () => Object.freeze({ status: "delivered" }),
		searchTranscript: async (): Promise<string> => "absent",
		close: async () => Object.freeze({ status: "closed" }),
	};
	return Object.freeze({ ...defaults, ...overrides });
}

function makeFreshEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const base: Record<string, unknown> = {
		envelope: makeEnvelope("tf-1", "agentmsg_abc123", "2025-01-01T00:00:00.000Z", "hello"),
		semanticDigest: "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030",
	};
	return Object.freeze({ ...base, ...overrides });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SessionTranscriptDispatcher", () => {
	it("persisted when exact message ID + digest in memory", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: id === "parent-1" ? 0 : 1,
				});
			},
			getActiveSession: () =>
				Object.freeze({
					messages: Object.freeze([
						Object.freeze({
							role: "custom",
							customType: "agent_message",
							details: Object.freeze({ id: "agentmsg_abc123", semanticDigest: CORRECT }),
						}),
					]),
				}),
		});
		const disp = await createDisp(ctx);
		const result = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(result.status).toBe("persisted");
		await disp.close();
	});

	it("poisons on mismatched digest in memory", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: id === "parent-1" ? 0 : 1,
				});
			},
			getActiveSession: () =>
				Object.freeze({
					messages: Object.freeze([
						Object.freeze({
							role: "custom",
							customType: "agent_message",
							details: Object.freeze({ id: "agentmsg_abc123", semanticDigest: "a".repeat(64) }),
						}),
					]),
				}),
		});
		const disp = await createDisp(ctx);
		// Non-enumerable digest throws from scanMessages, not MISMATCH
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});

	it("poisons on missing digest in memory", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: id === "parent-1" ? 0 : 1,
				});
			},
			getActiveSession: () =>
				Object.freeze({
					messages: Object.freeze([
						Object.freeze({
							role: "custom",
							customType: "agent_message",
							details: Object.freeze({ id: "agentmsg_abc123" }),
						}),
					]),
				}),
		});
		const disp = await createDisp(ctx);
		// Non-enumerable digest throws from scanMessages, not MISMATCH
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});

	it("persisted on on-disk exact match", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
					});
				if (id === "parent-1")
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
					});
				return Object.freeze({ activeSessionId: id, sessionId: "sess", sessionDir: "/d", rlmDepth: 1 });
			},
			getActiveSession: () => undefined,
			searchTranscript: async () => "exact",
		});
		const disp = await createDisp(ctx);
		const result = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(result.status).toBe("persisted");
		await disp.close();
	});

	it("poisons on on-disk mismatch", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
					});
				if (id === "parent-1")
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
					});
				return Object.freeze({ activeSessionId: id, sessionId: "sess", sessionDir: "/d", rlmDepth: 1 });
			},
			getActiveSession: () => undefined,
			searchTranscript: async () => "mismatch",
		});
		const disp = await createDisp(ctx);
		// Non-enumerable digest throws from scanMessages, not MISMATCH
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});

	it("mismatch dominates exact (disk mismatch + memory exact)", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
					});
				if (id === "parent-1")
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
					});
				return Object.freeze({ activeSessionId: id, sessionId: "sess", sessionDir: "/d", rlmDepth: 1 });
			},
			getActiveSession: () =>
				Object.freeze({
					messages: Object.freeze([
						Object.freeze({
							role: "custom",
							customType: "agent_message",
							details: Object.freeze({ id: "agentmsg_abc123", semanticDigest: CORRECT }),
						}),
					]),
				}),
			searchTranscript: async () => "mismatch",
		});
		const disp = await createDisp(ctx);
		// Non-enumerable digest throws from scanMessages, not MISMATCH
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});

	it("poisons on unresolvable target", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async () => undefined,
			getActiveSession: () => undefined,
		});
		const disp = await createDisp(ctx);
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow("UNKNOWN_TARGET");
		await disp.close();
	});

	it("deferred only for queued injection", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
					});
				if (id === "parent-1")
					return Object.freeze({
						activeSessionId: "parent-1",
						sessionId: "sess-p",
						sessionDir: "/d/p",
						rlmDepth: 0,
					});
				return undefined;
			},
			getActiveSession: () => undefined,
			acceptAgentMessage: async () => Object.freeze({ status: "queued" }),
			searchTranscript: async () => "absent",
		});
		const disp = await createDisp(ctx);
		const result = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(result.status).toBe("deferred");
		await disp.close();
	});

	it("idempotent", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const messages: unknown[] = [
			Object.freeze({
				role: "custom",
				customType: "agent_message",
				details: Object.freeze({ id: "agentmsg_abc123", semanticDigest: CORRECT }),
			}),
		];
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: id === "parent-1" ? 0 : 1,
				});
			},
			getActiveSession: () => Object.freeze({ messages }),
		});
		const disp = await createDisp(ctx);
		const r1 = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(r1.status).toBe("persisted");
		const r2 = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(r2.status).toBe("persisted");
		await disp.close();
	});

	it("poisons on input digest mismatch", async () => {
		const ctx = makeContext({
			resolveSession: async (id: string) =>
				Object.freeze({ activeSessionId: id, sessionId: "s", sessionDir: "/d", rlmDepth: 1 }),
		});
		const disp = await createDisp(ctx);
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: "a".repeat(64) }))).rejects.toThrow();
		await disp.close();
	});

	it("close is idempotent", async () => {
		const ctx = makeContext();
		const disp = await createDisp(ctx);
		const r1 = await disp.close();
		const r2 = await disp.close();
		expect(r1.status).toBe("closed");
		expect(r2.status).toBe("closed");
	});

	it("close returns error on context close fail", async () => {
		const ctx = makeContext({
			close: async () => {
				throw new Error("fail");
			},
		});
		const disp = await createDisp(ctx);
		const r = await disp.close();
		expect(r.status).toBe("error");
	});

	it("factory returns error on invalid context", async () => {
		const r = await createSessionTranscriptDispatcher("bad" as unknown as Record<string, unknown>);
		expect(r.ok).toBe(false);
	});

	it("rejects proxy input", async () => {
		const ctx = makeContext({
			resolveSession: async (id: string) =>
				Object.freeze({ activeSessionId: id, sessionId: "s", sessionDir: "/d", rlmDepth: 1 }),
		});
		const disp = await createDisp(ctx);
		const proxy = new Proxy(makeFreshEnvelope(), {});
		await expect(disp.ensure(proxy)).rejects.toThrow();
		await disp.close();
	});

	it("rejects extra keys input", async () => {
		const ctx = makeContext({
			resolveSession: async (id: string) =>
				Object.freeze({ activeSessionId: id, sessionId: "s", sessionDir: "/d", rlmDepth: 1 }),
		});
		const disp = await createDisp(ctx);
		const input = Object.freeze({
			envelope: makeEnvelope("tf-1", "agentmsg_abc123", "2025-01-01T00:00:00.000Z", "hello"),
			semanticDigest: "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030",
			extraKey: "bad",
		});
		await expect(disp.ensure(input)).rejects.toThrow();
		await disp.close();
	});

	it("ensure after close call rejects before tail settles", async () => {
		const ctx = makeContext();
		// Make operation tail slow so close() is called while operations are pending
		const disp = await createDisp(ctx);
		// Call close() - sets closed=true synchronously
		const closePromise = disp.close();
		// ensure() after close() should reject immediately even before tail settles
		await expect(disp.ensure(makeFreshEnvelope())).rejects.toThrow("CLOSED");
		await closePromise;
	});

	it("factory creates then close succeeds", async () => {
		const ctx = makeContext();
		const r = await createSessionTranscriptDispatcher(ctx);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const c = await r.value.close();
		expect(c.status).toBe("closed");
	});

	// ---- Additional hostile/dispatcher-specific tests ----
	it("rejects null factory input", async () => {
		const r = await createSessionTranscriptDispatcher(null);
		expect(r.ok).toBe(false);
	});

	it("rejects proxy factory input", async () => {
		const ctx = makeContext();
		const proxy = new Proxy(ctx, {});
		const r = await createSessionTranscriptDispatcher(proxy);
		expect(r.ok).toBe(false);
	});

	it("poisons on stale sender activeSessionId", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				// Target is fine, sender returns wrong id
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d/c",
						rlmDepth: 1,
						parentSessionPath: "/d/p",
					});
				return Object.freeze({ activeSessionId: "different-id", sessionId: "sess", sessionDir: "/d", rlmDepth: 0 });
			},
			getActiveSession: () => undefined,
		});
		const disp = await createDisp(ctx);
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow("STALE_SENDER");
		await disp.close();
	});

	it("poisons on disk reject even if memory is exact", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: 0,
				});
			},
			getActiveSession: () =>
				Object.freeze({
					messages: Object.freeze([
						Object.freeze({
							role: "custom",
							customType: "agent_message",
							details: Object.freeze({ id: "agentmsg_abc123", semanticDigest: CORRECT }),
						}),
					]),
				}),
			searchTranscript: async () => {
				throw new Error("disk crash");
			},
		});
		const disp = await createDisp(ctx);
		// Memory is exact but disk crashed — should poison
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});

	it("absent memory + disk exact after injection returns persisted", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		let searchCalls = 0;
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: 0,
				});
			},
			getActiveSession: () => undefined,
			acceptAgentMessage: async () => Object.freeze({ status: "delivered" }),
			searchTranscript: async () => {
				searchCalls++;
				return searchCalls > 1 ? "exact" : "absent";
			},
		});
		const disp = await createDisp(ctx);
		const result = await disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }));
		expect(result.status).toBe("persisted");
		await disp.close();
	});

	it("non-enumerable matching digest causes poison", async () => {
		const CORRECT = "7201f604e004f380460e73c8af7faec788856163c3c8db20dbd87ee71f2d9030";
		const msgObj = {};
		Object.defineProperty(msgObj, "role", { value: "custom", enumerable: true });
		Object.defineProperty(msgObj, "customType", { value: "agent_message", enumerable: true });
		const details = {};
		Object.defineProperty(details, "id", { value: "agentmsg_abc123", enumerable: true });
		Object.defineProperty(details, "semanticDigest", { value: CORRECT, enumerable: false }); // Non-enumerable
		Object.defineProperty(msgObj, "details", { value: details, enumerable: true });
		const messages = [msgObj];
		const ctx = makeContext({
			resolveSession: async (id: string) => {
				if (id === "child-1")
					return Object.freeze({
						activeSessionId: "child-1",
						sessionId: "sess-c",
						sessionDir: "/d",
						rlmDepth: 1,
						parentSessionPath: "/d",
					});
				return Object.freeze({
					activeSessionId: id,
					sessionId: id,
					sessionDir: "/d",
					rlmDepth: 0,
				});
			},
			getActiveSession: () => Object.freeze({ messages }),
		});
		const disp = await createDisp(ctx);
		// Non-enumerable semanticDigest should cause mismatch
		// Non-enumerable digest throws from scanMessages, not MISMATCH
		await expect(disp.ensure(makeFreshEnvelope({ semanticDigest: CORRECT }))).rejects.toThrow();
		await disp.close();
	});
});
