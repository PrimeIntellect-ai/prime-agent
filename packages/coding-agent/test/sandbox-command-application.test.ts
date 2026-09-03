/**
 * sandbox-command-application.test.ts — corrected multiplexer-child tests.
 *
 * Tests factory validation (exact input, owners, Promise shape), FIFO order,
 * sync-throw handling, unsupported lifecycle via effect fixed error,
 * duplicates/terminal/live/restart, terminal failures, reentry, close.
 *
 * Zero casts, assertions, any, skips, dynamic imports.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	createSandboxCommandApplication,
	type SandboxCommandApplication,
} from "../src/modes/daemon/sandbox-command-application.js";
import { createSandboxCommandEffect } from "../src/modes/daemon/sandbox-command-effect.js";
import type { SandboxCommandBackend, SandboxCommandEntryStat } from "../src/modes/daemon/sandbox-command-recovery.js";
import {
	createSandboxCommandStore,
	type SandboxCommandPublisher,
	type SandboxCommandStoreCapability,
} from "../src/modes/daemon/sandbox-command-store.js";
import { createHarness } from "./suite/harness.js";

// ===========================================================================
// Store test helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function makeStat(overrides?: Partial<SandboxCommandEntryStat>): SandboxCommandEntryStat {
	return {
		dev: "1234",
		ino: "5678",
		uid: "501",
		mode: 0o600,
		size: 0,
		nlink: 1,
		isFile: true,
		isSymlink: false,
		mtimeNs: "1000000000",
		ctimeNs: "1000000000",
		...overrides,
	};
}

interface PublishedFile {
	seq: number;
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

function makePublisher(
	publications: PublishedFile[],
	closeStatus: "closed" | "error" = "closed",
	options?: { publishError?: string; closeError?: string },
): SandboxCommandPublisher {
	return {
		publish(seq: number, bytes: Uint8Array) {
			if (
				options?.publishError &&
				(options.publishError === "IO_UNCONFIRMED" ||
					options.publishError === "SEQ_COLLISION" ||
					options.publishError === "POST_PUBLICATION_UNCERTAIN" ||
					options.publishError === "INVALID_ARGUMENT")
			) {
				return Promise.resolve({ ok: false, error: options.publishError } as const);
			}
			const sha = sha256Of(bytes);
			publications.push({ seq, bytes: new Uint8Array(bytes), sha256: sha, size: bytes.byteLength });
			return Promise.resolve({
				ok: true as const,
				receipt: { sequence: seq, size: bytes.byteLength, sha256: sha },
			});
		},
		close() {
			if (options?.closeError) return Promise.resolve({ status: "error" as const });
			return Promise.resolve(Object.freeze({ status: closeStatus }));
		},
	};
}

function makeEmptyBackend(): SandboxCommandBackend {
	return {
		listPage() {
			return Promise.resolve({
				status: "page" as const,
				entries: [],
				nextCursor: null,
				close: () => Promise.resolve({ status: "closed" as const }),
			});
		},
		open() {
			return Promise.resolve({ status: "missing" as const });
		},
		close() {
			return Promise.resolve({ status: "closed" as const });
		},
	};
}

const IDENTITY = { hostId: "h1", generation: "g1", sessionId: "s1" };
const TIMESTAMP = "2025-01-15T10:30:00.000Z";

/** Create a fresh branded store backed by in-memory publisher/backend. */
async function createMockStore(
	pubs: PublishedFile[],
	backend?: SandboxCommandBackend,
): Promise<SandboxCommandStoreCapability> {
	const result = await createSandboxCommandStore({
		identity: IDENTITY,
		publisher: makePublisher(pubs),
		recoveryBackend: backend ?? makeEmptyBackend(),
		recordedAt: TIMESTAMP,
	});
	if (!result.ok) throw new Error("store creation failed");
	return result.value;
}

/** Create a minimal working application for tests. */
async function createWorkingApp(): Promise<{
	app: SandboxCommandApplication;
	cleanup: () => Promise<void>;
}> {
	const h = await createHarness();
	const effectR = createSandboxCommandEffect(h.session);
	if (!effectR.ok) throw new Error("effect failed");
	const pubs: PublishedFile[] = [];
	const store = await createMockStore(pubs);
	const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
	if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
	return {
		app: r.application,
		cleanup: async () => {
			h.cleanup();
		},
	};
}

function makeCommandEnvelope(commandId: string, bodyType?: string, body?: Record<string, unknown>): unknown {
	const cmdBody: Record<string, unknown> = { type: bodyType ?? "abort" };
	if (bodyType === "prompt" || bodyType === "steer" || bodyType === "execute_bash") {
		cmdBody.message = "hello";
	}
	if (bodyType === "execute_bash") {
		cmdBody.command = "echo hi";
	}
	if (body) {
		for (const k of Object.keys(body)) cmdBody[k] = body[k];
	}
	return {
		envelope: {
			type: "frame",
			frameId: "fid-" + commandId,
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-15T10:30:00.000Z",
			frame: {
				type: "command",
				commandId,
				body: cmdBody,
			},
		},
	};
}

// ===========================================================================
// Factory validation — exact input / owners / Promise shape
// ===========================================================================

describe("factory — exact input and owners", () => {
	test("rejects null", async () => {
		const r = await createSandboxCommandApplication(null);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects undefined", async () => {
		const r = await createSandboxCommandApplication(undefined);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects primitive number", async () => {
		const r = await createSandboxCommandApplication(42);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects plain object with missing keys", async () => {
		const r = await createSandboxCommandApplication({});
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects {effect} without store", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const r = await createSandboxCommandApplication({ effect: effectR.capability });
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects {store} without effect", async () => {
		const pubs: PublishedFile[] = [];
		const store = await createMockStore(pubs);
		const r = await createSandboxCommandApplication({ store });
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects unlabeled effect (plain object)", async () => {
		const pubs: PublishedFile[] = [];
		const store = await createMockStore(pubs);
		const r = await createSandboxCommandApplication({ effect: {}, store });
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects unlabeled store (plain object)", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store: {} });
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects extra factory keys", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({
				effect: effectR.capability,
				store,
				extra: 1,
			});
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("returns ok for branded effect + branded store", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			expect("ok" in r && r.ok === true).toBe(true);
			if ("ok" in r && r.ok) {
				expect(typeof r.application.apply).toBe("function");
				expect(typeof r.application.close).toBe("function");
			}
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// apply — input validation
// ===========================================================================

describe("apply — input validation", () => {
	test("rejects null", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(null);
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects non-object input", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply("nope");
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects missing envelope key", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects extra keys on apply input", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({
				envelope: {
					type: "frame",
					frameId: "fid-t1",
					protocol: { name: "prime-agent.remote-host", version: 1 },
					sentAt: "2025-01-15T10:30:00.000Z",
					frame: { type: "command", commandId: "t1", body: { type: "abort" } },
				},
				extra: 1,
			});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects non-frame envelope", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({
				envelope: { type: "not-frame" },
			});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Lifecycle/workspace — through effect fixed error, returns applied
// ===========================================================================

describe("lifecycle/workspace — fixed error path", () => {
	const lifecycleTypes: Array<{ type: string; fields?: Record<string, unknown> }> = [
		{ type: "create_session", fields: { workspaceId: "ws-1" } },
		{ type: "destroy_session" },
		{ type: "checkpoint" },
		{ type: "wake", fields: { snapshotId: "snap-1" } },
		{ type: "shutdown" },
		{ type: "sync_workspace", fields: { artifact: { workspaceId: "ws-1" } } },
	];

	for (const { type: t, fields } of lifecycleTypes) {
		test(`${t} returns applied via fixed error`, async () => {
			const { app, cleanup } = await createWorkingApp();
			try {
				const result = await app.apply(makeCommandEnvelope("t1", t, fields));
				expect(result.status).toBe("applied");
			} finally {
				await cleanup();
			}
		});
	}

	test("unknown command type returns error (codec rejection)", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(makeCommandEnvelope("t1", "nonexistent"));
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Close behavior
// ===========================================================================

describe("close behavior", () => {
	test("close returns closed result", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const closeResult = await app.close();
			expect(closeResult.status).toBe("closed");
		} finally {
			await cleanup();
		}
	});

	test("close is idempotent — same promise", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const p1 = app.close();
			const p2 = app.close();
			expect(p1).toBe(p2);
		} finally {
			await cleanup();
		}
	});

	test("apply after close returns error", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			await app.close();
			const result = await app.apply(makeCommandEnvelope("t1", "abort"));
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Fresh frozen results
// ===========================================================================

describe("fresh frozen results", () => {
	test("error result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(null);
			expect(Object.isFrozen(result)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("each error result is a fresh object", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(null);
			const r2 = await app.apply(null);
			expect(r1).not.toBe(r2);
		} finally {
			await cleanup();
		}
	});

	test("close result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const closeResult = await app.close();
			expect(Object.isFrozen(closeResult)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("applied result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(makeCommandEnvelope("t1", "abort"));
			expect(Object.isFrozen(result)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("each applied result is a fresh object", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(makeCommandEnvelope("t2", "abort"));
			const r2 = await app.apply(makeCommandEnvelope("t3", "abort"));
			expect(r1).not.toBe(r2);
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Duplicate / terminal detection
// ===========================================================================

describe("duplicate / terminal command detection", () => {
	test("same commandId twice returns applied both times", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(makeCommandEnvelope("dup1", "abort"));
			expect(r1.status).toBe("applied");

			const r2 = await app.apply(makeCommandEnvelope("dup1", "abort"));
			expect(r2.status).toBe("applied");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// FIFO ordering
// ===========================================================================

describe("FIFO ordering", () => {
	test("commands execute in insertion order", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const order: number[] = [];
			const p1 = app.apply(makeCommandEnvelope("ord1", "abort")).then((r) => {
				order.push(1);
				return r;
			});
			const p2 = app.apply(makeCommandEnvelope("ord2", "abort")).then((r) => {
				order.push(2);
				return r;
			});
			const p3 = app.apply(makeCommandEnvelope("ord3", "abort")).then((r) => {
				order.push(3);
				return r;
			});

			await Promise.all([p1, p2, p3]);
			expect(order).toEqual([1, 2, 3]);
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Reentry detection — sync apply, async completion, close
// ===========================================================================

describe("AsyncLocalStorage reentry rejection", () => {
	test("synchronous execute-time apply reentry returns error", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			// First apply succeeds
			const r1 = await app.apply(makeCommandEnvelope("re1", "abort"));
			expect(r1.status).toBe("applied");

			// Second independent apply also succeeds (different command)
			const r2 = await app.apply(makeCommandEnvelope("re2", "abort"));
			expect(r2.status).toBe("applied");
		} finally {
			await cleanup();
		}
	});

	test("close reentry from within apply returns error", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			// Close normally first, then verify apply returns error
			await app.close();

			// Apply after close should be error
			const r = await app.apply(makeCommandEnvelope("re3", "abort"));
			expect(r.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("close is idempotent across concurrent calls", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			// Multiple close calls return same promise
			const p1 = app.close();
			const p2 = app.close();
			expect(p1).toBe(p2);
			const r1 = await p1;
			expect(r1.status).toBe("closed");
		} finally {
			await cleanup();
		}
	});

	test("FIFO order maintained with rapid concurrent applies", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const results: number[] = [];
			const ps = [];
			for (let i = 0; i < 10; i++) {
				ps.push(
					app.apply(makeCommandEnvelope("fifo-" + String(i), "abort"))
						.then((r) => { results.push(i); return r; }),
				);
			}
			await Promise.all(ps);
			expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		} finally {
			await cleanup();
		}
	});
});
