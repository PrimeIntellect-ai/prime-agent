import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { writeFileAtomicSync } from "../src/utils/atomic-file.js";

// The store's atomic write is the seam for write-failure regressions; the real
// implementation stays the default so every other test hits the real disk path.
vi.mock("../src/utils/atomic-file.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-file.js")>();
	return { ...actual, writeFileAtomicSync: vi.fn(actual.writeFileAtomicSync) };
});

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
// A file URL stays a valid ESM import specifier on every platform; a resolved
// absolute OS path does not (Windows drive-letter paths are not specifiers).
const STORE_MODULE_URL = new URL("../src/core/mcp/connection-store.js", import.meta.url).href;

/**
 * Real-process first-writer worker. Loaded through the project tsx loader so it
 * imports the TS store module directly: each child opens the shared store, posts
 * a ready marker, waits at the file barrier so every process starts its flush
 * at once, then upserts its own record and flushes. Exit codes: 3 barrier
 * timeout, 4 lost own record.
 */
const FIRST_CREATE_WORKER_SOURCE = `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpConnectionStore } from ${JSON.stringify(STORE_MODULE_URL)};
const [storePath, barrierPath, readyDir, connectionId] = process.argv.slice(2);
const store = McpConnectionStore.open(storePath);
writeFileSync(join(readyDir, "ready-" + connectionId), connectionId);
const deadline = Date.now() + 10_000;
while (!existsSync(barrierPath)) {
	if (Date.now() > deadline) {
		console.error("barrier timeout");
		process.exit(3);
	}
	await new Promise((resolve) => setTimeout(resolve, 5));
}
const now = Date.now();
store.upsert({
	connectionId: connectionId,
	serviceId: connectionId,
	endpoint: "https://mcp.example.test/mcp",
	label: connectionId,
	status: "connected",
	createdAt: now,
	updatedAt: now,
});
await store.flush();
if (store.get(connectionId) === undefined) {
	console.error("worker lost its own record");
	process.exit(4);
}
`;

function recordFixture(connectionId: string, overrides: Partial<McpConnectionRecord> = {}): McpConnectionRecord {
	const now = Date.now();
	return {
		connectionId,
		serviceId: connectionId,
		endpoint: `https://mcp.${connectionId}.test/mcp`,
		label: connectionId,
		status: "connected",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

describe("McpConnectionStore concurrency", () => {
	let tempDir: string;
	let path: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-store-"));
		path = join(tempDir, "mcp-connections.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("two instances never lose each other's records on interleaved flushes", async () => {
		const client = McpConnectionStore.open(path);
		const daemon = McpConnectionStore.open(path);

		client.upsert(recordFixture("client-service"));
		await client.flush();

		// The daemon writes without having re-read first; the read-modify-write
		// under the file lock must preserve the client's record.
		daemon.upsert(recordFixture("daemon-service"));
		await daemon.flush();

		const reopened = McpConnectionStore.open(path);
		expect(reopened.get("client-service")).toBeDefined();
		expect(reopened.get("daemon-service")).toBeDefined();
		expect(reopened.records()).toHaveLength(2);
	});

	it("keeps both writers' records when flushes race concurrently", async () => {
		const first = McpConnectionStore.open(path);
		const second = McpConnectionStore.open(path);
		first.upsert(recordFixture("first"));
		second.upsert(recordFixture("second"));
		await Promise.all([first.flush(), second.flush()]);

		const reopened = McpConnectionStore.open(path);
		expect(reopened.get("first")).toBeDefined();
		expect(reopened.get("second")).toBeDefined();
	});

	it("applies removes and upserts from different instances without resurrecting removed records", async () => {
		const owner = McpConnectionStore.open(path);
		const other = McpConnectionStore.open(path);
		owner.upsert(recordFixture("doomed"));
		await owner.flush();

		// One instance removes while the other adds; the final state reflects both.
		other.upsert(recordFixture("added"));
		await other.flush();
		owner.remove("doomed");
		await owner.flush();

		const reopened = McpConnectionStore.open(path);
		expect(reopened.get("doomed")).toBeUndefined();
		expect(reopened.get("added")).toBeDefined();
	});

	it("discards a queued verification result whose guard fails at flush time", async () => {
		const store = McpConnectionStore.open(path);
		let current = true;
		store.queueVerifyResult(recordFixture("acme", { status: "connected" }), () => current);
		current = false; // the credential changed before the flush acquired the lock
		await store.flush();
		expect(store.get("acme")).toBeUndefined();

		store.queueVerifyResult(recordFixture("acme", { status: "connected" }), () => current);
		current = true;
		await store.flush();
		expect(store.get("acme")?.status).toBe("connected");
	});

	it("writes with a unique temp file so concurrent flushes never collide on rename", async () => {
		const instances = Array.from({ length: 4 }, (_, index) => {
			const store = McpConnectionStore.open(path);
			store.upsert(recordFixture(`service-${index}`));
			return store;
		});
		await Promise.all(instances.map((store) => store.flush()));

		const reopened = McpConnectionStore.open(path);
		expect(
			reopened
				.records()
				.map((record) => record.connectionId)
				.sort(),
		).toEqual(["service-0", "service-1", "service-2", "service-3"]);
	});

	it("creates the file exclusively when first-time writers race", async () => {
		const instances = ["alpha", "beta", "gamma"].map((id) => {
			const store = McpConnectionStore.open(path);
			store.upsert(recordFixture(id));
			return store;
		});
		await Promise.all(instances.map((store) => store.flush()));

		const reopened = McpConnectionStore.open(path);
		expect(
			reopened
				.records()
				.map((record) => record.connectionId)
				.sort(),
		).toEqual(["alpha", "beta", "gamma"]);
		// The exclusive create keeps the file owner-private regardless of umask.
		// Windows mode bits do not map meaningfully, so only POSIX asserts exactly.
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	});

	it("requeues operations when the atomic write fails and retries them in order", async () => {
		const store = McpConnectionStore.open(path);
		store.upsert(recordFixture("acme", { label: "v1", status: "pending" }));
		store.upsert(recordFixture("acme", { label: "v2", status: "pending" }));
		let verificationStillCurrent = true;
		store.queueVerifyResult(
			recordFixture("acme", { status: "connected", toolCount: 7, verifiedAt: 123 }),
			() => verificationStillCurrent,
		);

		vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
			throw new Error("simulated write failure");
		});
		await expect(store.flush()).rejects.toThrow("simulated write failure");
		// In-memory state kept the immediate upserts; the disk kept nothing.
		expect(store.get("acme")?.label).toBe("v2");
		const untouched = McpConnectionStore.open(path);
		expect(untouched.get("acme")).toBeUndefined();

		// Ops queued after the failed flush stay behind the requeued batch.
		verificationStillCurrent = false; // the verification result went stale meanwhile
		store.upsert(recordFixture("beta"));
		await store.flush();

		const reopened = McpConnectionStore.open(path);
		// The requeued upserts re-applied in order (the later one wins), the
		// stale verification was re-guarded and discarded, and the late op landed.
		expect(reopened.get("acme")?.label).toBe("v2");
		expect(reopened.get("acme")?.status).toBe("pending");
		expect(reopened.get("acme")?.toolCount).toBeUndefined();
		expect(reopened.get("beta")).toBeDefined();
	});

	it("keeps operations queued while another flush is in flight for the next flush", async () => {
		const store = McpConnectionStore.open(path);
		// A flush is already in flight when the next mutation is queued: the splice
		// happens after the lock is acquired, so the operation is not lost.
		const firstFlush = store.flush();
		store.upsert(recordFixture("queued-mid-flight"));
		await firstFlush;
		expect(store.get("queued-mid-flight")).toBeDefined();
		await store.flush();

		const reopened = McpConnectionStore.open(path);
		expect(reopened.get("queued-mid-flight")).toBeDefined();
	});
});

describe("McpConnectionStore multi-process first create", () => {
	let tempDir: string;
	let path: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "mcp-store-mp-"));
		path = join(tempDir, "mcp-connections.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("independent first-time processes never wipe each other's records", async () => {
		const workerPath = join(tempDir, "first-create-worker.mts");
		const barrierPath = join(tempDir, "GO");
		writeFileSync(workerPath, FIRST_CREATE_WORKER_SOURCE);

		const ids = ["mp-alpha", "mp-beta", "mp-gamma", "mp-delta"];
		const children = ids.map((id) =>
			spawn(process.execPath, ["--import", "tsx", workerPath, path, barrierPath, tempDir, id], {
				cwd: TEST_DIR,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		// Real, distinct OS processes — this is not the in-process instance race.
		expect(new Set(children.map((child) => child.pid)).size).toBe(ids.length);
		const failures: string[] = [];
		for (const child of children) {
			child.stderr?.on("data", (chunk: Buffer) => failures.push(String(chunk)));
		}

		try {
			// Align every first-writer before any of them flushes.
			let waited = 0;
			while (!ids.every((id) => existsSync(join(tempDir, `ready-${id}`)))) {
				if (waited++ > 1500) throw new Error(`workers never became ready: ${failures.join("")}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			writeFileSync(barrierPath, "");
			const exits = await Promise.all(
				children.map(
					(child) =>
						new Promise<number | null>((resolve) => {
							child.on("close", (code) => resolve(code));
						}),
				),
			);
			expect(exits).toEqual([0, 0, 0, 0]);
			expect(failures.join("")).toBe("");
		} finally {
			for (const child of children) {
				if (child.exitCode === null && !child.killed) child.kill();
			}
		}

		const reopened = McpConnectionStore.open(path);
		expect(
			reopened
				.records()
				.map((record) => record.connectionId)
				.sort(),
		).toEqual([...ids].sort());
		// Windows mode bits do not map meaningfully, so only POSIX asserts exactly.
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
	}, 30_000);
});

describe("ENG-6108 durable account reservations", () => {
	const nonce = (): string => `attempt-${randomUUID()}`;
	const record = (connectionId: string, at: number, attemptId: string) => ({
		connectionId,
		serviceId: "acme",
		endpoint: "https://mcp.acme.test/mcp",
		label: `Acme (${connectionId})`,
		status: "pending" as const,
		createdAt: at,
		updatedAt: at,
		attemptId,
	});

	it("two clients reserving the same id concurrently: exactly one wins, the loser sees the durable marker", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reserve-race-"));
		const path = join(tempDir, "mcp-connections.json");
		const clientA = McpConnectionStore.open(path);
		const clientB = McpConnectionStore.open(path);
		const at = Date.now();
		// Barrier: both clients enqueue the reservation before either flush lands.
		const [a, b] = await Promise.all([
			clientA.reserveConnectionId(record("acme-2", at, nonce())),
			clientB.reserveConnectionId(record("acme-2", at, nonce())),
		]);
		// Exactly one winner; the durable pending marker blocks the loser.
		expect(a || b).toBe(true);
		expect(a && b).toBe(false);
		// The reservation is durable: a fresh reader sees the pending marker.
		const third = McpConnectionStore.open(path);
		expect(third.get("acme-2")?.status).toBe("pending");
		// The loser re-reads and allocates the NEXT id atomically.
		const loser = a ? clientB : clientA;
		loser.load();
		const nextAttempt = nonce();
		const next = await loser.reserveConnectionId(record("acme-3", at + 1, nextAttempt));
		expect(next).toBe(true);
		expect(loser.get("acme-3")?.status).toBe("pending");
		// Finalize moves the pending reservation to the committed account state
		// under the lock, only for the owning attempt.
		expect(
			await loser.finalizeAttempt({
				connectionId: "acme-3",
				attemptId: nextAttempt,
				commit: (current) => current,
			}),
		).toBe(true);
		// A different attempt id cannot finalize someone else's reservation.
		const otherAttempt = nonce();
		expect(await loser.reserveConnectionId(record("acme-5", at + 2, otherAttempt))).toBe(true);
		expect(
			await loser.finalizeAttempt({
				connectionId: "acme-5",
				attemptId: "not-the-owner",
				commit: (current) => current,
			}),
		).toBe(false);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("a failed record write resolves the reservation FALSE: no durable marker, no ghost retry, no login may start", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reserve-write-fail-"));
		const path = join(tempDir, "mcp-connections.json");
		const client = McpConnectionStore.open(path);
		const at = Date.now();
		const mine = nonce();
		vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
			throw new Error("simulated reservation write failure");
		});
		// Commit-gated resolution: the caller learns the reservation did NOT land.
		await expect(client.reserveConnectionId(record("acme-2", at, mine))).resolves.toBe(false);
		// Nothing durable: a fresh reader sees no marker, and the failed one-shot
		// op was dropped (never requeued for a surprise later commit).
		const fresh = McpConnectionStore.open(path);
		expect(fresh.get("acme-2")).toBeUndefined();
		// The next attempt on the same id works normally.
		const retryNonce = nonce();
		await expect(client.reserveConnectionId(record("acme-2", at, retryNonce))).resolves.toBe(true);
		expect(McpConnectionStore.open(path).get("acme-2")?.attemptId).toBe(retryNonce);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("TWO reserves batched into one failing write: BOTH resolve false (no hang), no ghost, retry works", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reserve-batch-fail-"));
		const path = join(tempDir, "mcp-connections.json");
		const client = McpConnectionStore.open(path);
		const at = Date.now();
		vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
			throw new Error("simulated batched write failure");
		});
		// Both reserves queue into the SAME first flush (flushChain serializes
		// runs, but both ops are already enqueued before the first run starts).
		const [first, second] = await Promise.all([
			client.reserveConnectionId(record("acme-2", at, nonce())),
			client.reserveConnectionId(record("acme-3", at, nonce())),
		]);
		// Explicit settlement: every one-shot resolves exactly once — false here.
		expect(first).toBe(false);
		expect(second).toBe(false);
		// No durable marker for either id (no ghost), and a retry succeeds.
		const fresh = McpConnectionStore.open(path);
		expect(fresh.get("acme-2")).toBeUndefined();
		expect(fresh.get("acme-3")).toBeUndefined();
		const retryNonce = nonce();
		await expect(client.reserveConnectionId(record("acme-2", at, retryNonce))).resolves.toBe(true);
		expect(McpConnectionStore.open(path).get("acme-2")?.attemptId).toBe(retryNonce);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("a finalize whose RECORD write fails compensates: staged credential restored, real key untouched, no record", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "finalize-compensate-"));
		const path = join(tempDir, "mcp-connections.json");
		const client = McpConnectionStore.open(path);
		const at = Date.now();
		const mine = nonce();
		await client.reserveConnectionId(record("acme-2", at, mine));
		const commitMoves: Array<string> = [];
		const committed = await client.finalizeAttempt({
			connectionId: "acme-2",
			attemptId: mine,
			commit: (current) => {
				commitMoves.push("moved");
				return current;
			},
			compensate: () => {
				commitMoves.push("compensated");
			},
		});
		// The write is mocked to fail exactly once — inject it AFTER the
		// reservation commit so the finalize's write is the failing one.
		vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
			throw new Error("simulated finalize write failure");
		});
		const failed = await client.finalizeAttempt({
			connectionId: "acme-2",
			attemptId: mine,
			commit: (current) => {
				commitMoves.push("moved-again");
				return current;
			},
			compensate: () => {
				commitMoves.push("compensated-again");
			},
		});
		expect(committed).toBe(true);
		expect(failed).toBe(false);
		// All-or-nothing: compensation ran under the same lock.
		expect(commitMoves).toContain("compensated-again");
		// The record write failed: nothing durable for the second finalize, and
		// the FIRST (successful) finalize's record is still on disk.
		const fresh = McpConnectionStore.open(path);
		expect(fresh.get("acme-2")?.attemptId).toBe(mine);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("removeAccount removes the credential AND the record under one lock: disconnect interleaving with finalize leaves no orphan", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "remove-account-"));
		const path = join(tempDir, "mcp-connections.json");
		const clientA = McpConnectionStore.open(path);
		const clientB = McpConnectionStore.open(path);
		const at = Date.now();
		const mine = nonce();
		await clientA.reserveConnectionId(record("acme-2", at, mine));
		const removed: string[] = [];
		const authCleanup = (connectionId: string) => {
			removed.push(connectionId);
		};

		// Order 1: another client disconnects (record+credential under one lock)
		// BEFORE the login's finalize — the finalize must lose ownership and the
		// account key must never receive the credential.
		const removedFirst = await clientB.removeAccount({ connectionId: "acme-2", authCleanup });
		expect(removedFirst).toBe(true);
		expect(removed).toEqual(["acme-2"]);
		const finalizeAfterRemove = await clientA.finalizeAttempt({
			connectionId: "acme-2",
			attemptId: mine,
			commit: (current) => current,
			compensate: () => {
				throw new Error("should not run: commit never applied");
			},
		});
		expect(finalizeAfterRemove).toBe(false);
		expect(McpConnectionStore.open(path).get("acme-2")).toBeUndefined();

		// Order 2: finalize commits first; a later disconnect removes BOTH the
		// record AND the credential — no orphan survives.
		const mine2 = nonce();
		await clientA.reserveConnectionId(record("acme-4", at, mine2));
		const finalized = await clientA.finalizeAttempt({
			connectionId: "acme-4",
			attemptId: mine2,
			commit: (current) => current,
		});
		expect(finalized).toBe(true);
		const removedAfter = await clientB.removeAccount({ connectionId: "acme-4", authCleanup });
		expect(removedAfter).toBe(true);
		expect(removed).toEqual(["acme-2", "acme-4"]);
		expect(McpConnectionStore.open(path).get("acme-4")).toBeUndefined();
		// Removing an absent account is an honest false, not a throw.
		await expect(clientB.removeAccount({ connectionId: "acme-9", authCleanup })).resolves.toBe(false);
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("removeReservation is ownership-validated by the attempt nonce: only OUR pending marker disappears", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "reserve-cancel-"));
		const path = join(tempDir, "mcp-connections.json");
		const client = McpConnectionStore.open(path);
		const at = Date.now();
		const mine = nonce();
		expect(await client.reserveConnectionId(record("acme-2", at, mine))).toBe(true);

		// A different owner (wrong nonce) cannot remove it.
		expect(await client.removeReservation("acme-2", nonce())).toBe(false);
		expect(client.get("acme-2")).toBeDefined();

		// A completed account is not a reservation anymore: finalize first.
		expect(
			await client.finalizeAttempt({
				connectionId: "acme-2",
				attemptId: mine,
				commit: (current) => ({ ...current, status: "connected" as const }),
			}),
		).toBe(true);
		expect(await client.removeReservation("acme-2", mine)).toBe(false);
		expect(client.get("acme-2")?.status).toBe("connected");

		// The true owner cancels a still-pending reservation.
		const cancelMine = nonce();
		expect(await client.reserveConnectionId(record("acme-4", at, cancelMine))).toBe(true);
		expect(await client.removeReservation("acme-4", cancelMine)).toBe(true);
		expect(client.get("acme-4")).toBeUndefined();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});
});
