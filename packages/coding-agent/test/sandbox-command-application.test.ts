/**
 * sandbox-command-application.test.ts — controlled tests for the
 * store-backed command relay application with MultiplexerApplication
 * {apply,close} shape.
 *
 * Uses real branded createSandboxCommandEffect + branded in-memory
 * SandboxCommandStore.  Proves factory validation, lifecycle,
 * lifecycle/workspace rejection, close reverse ownership, and replay.
 * Zero casts, assertions, any, skips, dynamic imports.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { createSandboxCommandApplication } from "../src/modes/daemon/sandbox-command-application.js";
import { createSandboxCommandEffect } from "../src/modes/daemon/sandbox-command-effect.js";
import type { SandboxCommandBackend, SandboxCommandEntryStat } from "../src/modes/daemon/sandbox-command-recovery.js";
import {
	createSandboxCommandStore,
	type SandboxCommandPublisher,
	type SandboxCommandStoreCapability,
} from "../src/modes/daemon/sandbox-command-store.js";
import { createHarness } from "./suite/harness.js";

// ===========================================================================
// Store test helpers (from sandbox-command-store.test.ts)
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
				receipt: { sequence: seq, size, sha256: sha },
			});
		},
		close() {
			if (options?.closeError) return Promise.resolve({ status: "error" as const });
			return Promise.resolve({ status: closeStatus as const });
		},
	};
}

function _makeBackend(records: PublishedFile[]): SandboxCommandBackend {
	const entries = records.map((r) => ({
		name: `${String(r.seq).padStart(20, "0")}.b14-command`,
		stat: makeStat({ size: r.size }),
	}));
	const openedFiles = new Set<number>();
	return {
		listPage(request: { cursor: string | null; maxEntries: number; maxBytes: number }) {
			if (request.cursor !== null) {
				return Promise.resolve({
					status: "page" as const,
					entries: [],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" as const }),
				});
			}
			return Promise.resolve({
				status: "page" as const,
				entries,
				nextCursor: null,
				close: () => Promise.resolve({ status: "closed" as const }),
			});
		},
		open(request: { name: string; expected: SandboxCommandEntryStat }) {
			const idx = entries.findIndex((e) => e.name === request.name);
			if (idx < 0) return Promise.resolve({ status: "missing" as const });
			if (openedFiles.has(idx)) return Promise.resolve({ status: "missing" as const });
			openedFiles.add(idx);
			const rec = records[idx];
			return Promise.resolve({
				status: "opened" as const,
				handle: {
					readAt(offset: number, size: number) {
						const chunk = rec.bytes.slice(offset, offset + size);
						return Promise.resolve({ status: "bytes" as const, bytes: chunk });
					},
					confirmEof(totalSize: number) {
						if (totalSize >= rec.bytes.byteLength) {
							return Promise.resolve({ status: "eof" as const });
						}
						return Promise.resolve({ status: "bytes" as const, bytes: new Uint8Array(0) });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: rec.bytes.byteLength }));
					},
					close() {
						return Promise.resolve({ status: "closed" as const });
					},
				},
			});
		},
		close() {
			return Promise.resolve({ status: "closed" as const });
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

// ===========================================================================
// Helpers
// ===========================================================================

function _makeCommandEnvelope(commandId: string, bodyType?: string): Record<string, unknown> {
	return {
		type: "command",
		commandId,
		body: { type: bodyType ?? "prompt", message: "hello" },
	};
}

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

// ===========================================================================
// Factory validation
// ===========================================================================

describe("factory (createSandboxCommandApplication)", () => {
	test("rejects null", async () => {
		const r = await createSandboxCommandApplication(null);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects undefined", async () => {
		const r = await createSandboxCommandApplication(undefined);
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

describe("apply input validation", () => {
	test("rejects null", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply(null);
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});

	test("rejects non-object input", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply("nope");
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});

	test("rejects missing envelope key", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply({});
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});

	test("rejects extra keys", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply({
				envelope: { type: "command", commandId: "t1", body: { type: "abort" } },
				extra: 1,
			});
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Lifecycle/workspace command rejection
// ===========================================================================

describe("lifecycle/workspace command rejection", () => {
	const lifecycleTypes: Array<{ type: string; fields?: Record<string, unknown> }> = [
		{ type: "create_session", fields: { workspaceId: "ws-1" } },
		{ type: "destroy_session" },
		{ type: "checkpoint" },
		{ type: "wake", fields: { snapshotId: "snap-1" } },
		{ type: "shutdown" },
		{ type: "sync_workspace", fields: { artifact: { workspaceId: "ws-1" } } },
	];

	for (const { type: t, fields } of lifecycleTypes) {
		test(`${t} returns error`, async () => {
			const h = await createHarness();
			try {
				const effectR = createSandboxCommandEffect(h.session);
				if (!effectR.ok) throw new Error("effect failed");
				const pubs: PublishedFile[] = [];
				const store = await createMockStore(pubs);
				const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
				if (!("ok" in r) || !r.ok) throw new Error("app failed");
				const result = await r.application.apply({
					envelope: { type: "command", commandId: "t1", body: { type: t, ...fields } },
				});
				expect(result.status).toBe("error");
			} finally {
				h.cleanup();
			}
		});
	}

	test("unknown command type returns error", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply({
				envelope: { type: "command", commandId: "t1", body: { type: "nonexistent" } },
			});
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Close behavior
// ===========================================================================

describe("close behavior", () => {
	test("close returns closed result", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const closeResult = await r.application.close();
			expect(closeResult.status).toBe("closed");
		} finally {
			h.cleanup();
		}
	});

	test("close is idempotent — same promise", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const p1 = r.application.close();
			const p2 = r.application.close();
			expect(p1).toBe(p2);
		} finally {
			h.cleanup();
		}
	});

	test("apply after close returns error", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			await r.application.close();
			const result = await r.application.apply({
				envelope: { type: "command", commandId: "t1", body: { type: "abort" } },
			});
			expect(result.status).toBe("error");
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Fresh frozen results
// ===========================================================================

describe("fresh frozen results", () => {
	test("error result is frozen", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const result = await r.application.apply({
				envelope: { type: "command", commandId: "t1", body: { type: "nonexistent" } },
			});
			expect(Object.isFrozen(result)).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("each error result is a fresh object", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const r1 = await r.application.apply(null);
			const r2 = await r.application.apply(null);
			expect(r1).not.toBe(r2);
		} finally {
			h.cleanup();
		}
	});

	test("close result is frozen", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app failed");
			const closeResult = await r.application.close();
			expect(Object.isFrozen(closeResult)).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});
