import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";
import { writeFileAtomicSync } from "../src/utils/atomic-file.js";

// The store's atomic write is the seam for write-failure regressions; the real
// implementation stays the default so every other test hits the real disk path.
vi.mock("../src/utils/atomic-file.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/atomic-file.js")>();
	return { ...actual, writeFileAtomicSync: vi.fn(actual.writeFileAtomicSync) };
});

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
		expect(statSync(path).mode & 0o777).toBe(0o600);
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
