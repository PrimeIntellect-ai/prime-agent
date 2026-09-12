import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type McpConnectionRecord, McpConnectionStore } from "../src/core/mcp/connection-store.js";

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
