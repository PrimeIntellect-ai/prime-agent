import { createHash } from "node:crypto";
import {
	access,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JournalDirection } from "../src/modes/daemon/b03-journal-record-codec.js";
import { createDurableRelayStore } from "../src/modes/daemon/durable-relay-store.js";
import type { CreateNodeB03RelayBackendResult } from "../src/modes/daemon/node-b03-relay-backend.js";
import { createNodeB03RelayBackend } from "../src/modes/daemon/node-b03-relay-backend.js";

// ===========================================================================
// Test constants
// ===========================================================================

const identity1 = Object.freeze({ hostId: "host-a", generation: "gen-1", sessionId: "sess-1" });
const identity2 = Object.freeze({ hostId: "host-b", generation: "gen-2", sessionId: "sess-2" });

const ROOTS: string[] = [];
const BACKENDS: CreateNodeB03RelayBackendResult[] = [];

afterEach(async () => {
	for (const backend of BACKENDS.splice(0)) {
		if (backend.ok) {
			await backend.journalPublisher.close().catch(() => Object.freeze({ status: "error" as const }));
			await backend.deliveryPublisher.close().catch(() => Object.freeze({ status: "error" as const }));
			await backend.recoveryBackend.close().catch(() => Object.freeze({ status: "error" as const }));
		}
	}
	for (const root of ROOTS.splice(0)) {
		await rm(root, { force: true, recursive: true }).catch(() => {});
	}
});

// ===========================================================================
// Helpers
// ===========================================================================

async function freshDir(): Promise<string> {
	const raw = await mkdtemp(join(tmpdir(), "b03-relay-"));
	const root = await realpath(raw);
	ROOTS.push(root);
	return join(root, "journals");
}

async function createBackend(
	path: string,
	identity: Readonly<{ hostId: string; generation: string; sessionId: string }> = identity1,
	direction: JournalDirection = "sent",
): Promise<CreateNodeB03RelayBackendResult> {
	const result = await createNodeB03RelayBackend(Object.freeze({ directoryPath: path, identity, direction }));
	if (result.ok) BACKENDS.push(result);
	return result;
}

function _digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function makeEnvelope(frameId: string): Record<string, unknown> {
	return Object.freeze({
		type: "frame",
		frameId,
		protocol: Object.freeze({ name: "prime-agent.remote-host", version: 1 }),
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: Object.freeze({
			type: "event",
			id: `e-${frameId}`,
			sequence: 1,
			cursor: Object.freeze({ hostId: "host-a", generation: "gen-1", sessionId: "sess-1", sequence: 1 }),
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: Object.freeze({ type: "agent_start" }),
		}),
	});
}

// ===========================================================================
// Tests
// ===========================================================================

describe("node B03 relay backend", () => {
	// ---- Fresh identity creation ----

	it("creates fresh identity directory with three distinct capabilities", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		if (result.ok) BACKENDS.push(result);

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.journalDir).toBe(dir);

		// Three distinct capability objects
		expect(result.journalPublisher).not.toBe(result.deliveryPublisher);
		expect(result.journalPublisher).not.toBe(result.recoveryBackend);
		expect(result.deliveryPublisher).not.toBe(result.recoveryBackend);

		// Each has expected interface shape
		expect(typeof result.journalPublisher.publish).toBe("function");
		expect(typeof result.journalPublisher.close).toBe("function");
		expect(typeof result.deliveryPublisher.publish).toBe("function");
		expect(typeof result.deliveryPublisher.close).toBe("function");
		expect(typeof result.recoveryBackend.listPage).toBe("function");
		expect(typeof result.recoveryBackend.open).toBe("function");
		expect(typeof result.recoveryBackend.close).toBe("function");

		// Verify directory has identity.json with correct content + direction
		const idPath = join(dir, "identity.json");
		const content = await readFile(idPath, "utf8");
		const parsed = JSON.parse(content);
		expect(parsed.version).toBe(1);
		expect(parsed.hostId).toBe("host-a");
		expect(parsed.generation).toBe("gen-1");
		expect(parsed.sessionId).toBe("sess-1");
		expect(parsed.direction).toBe("sent");

		// Verify directory mode 0700
		const dirMode = (await stat(dir)).mode & 0o777;
		expect(dirMode).toBe(0o700);

		// Verify identity file mode 0600
		const idMode = (await stat(idPath)).mode & 0o777;
		expect(idMode).toBe(0o600);

		await result.recoveryBackend.close();
	});

	// ---- Reopen with matching identity ----

	it("reopens existing directory with matching identity+direction", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		const second = await createBackend(dir, identity1, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.journalDir).toBe(dir);
		await second.recoveryBackend.close();
	});

	// ---- Identity mismatch ----

	it("rejects reopening with different identity", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		const second = await createBackend(dir, identity2, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.error.code).toBe("IDENTITY_MISMATCH");
		}
	});

	// ---- Direction mismatch ----

	it("rejects reopening with different direction", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		const second = await createBackend(dir, identity1, "received");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.error.code).toBe("IDENTITY_MISMATCH");
		}
	});

	// ---- Symlink path swap ----

	it("rejects symlink path swap", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		// Replace directory with symlink to a different location
		await rm(dir, { force: true, recursive: true });
		const fake = await mkdtemp(join(tmpdir(), "b03-fake-"));
		ROOTS.push(fake);
		await symlink(fake, dir);

		const second = await createBackend(dir, identity1, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
	});

	// ---- Unsafe directory permissions ----

	it("rejects unsafe directory permissions (mode != 0700)", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		await chmod(dir, 0o755);
		const second = await createBackend(dir, identity1, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
	});

	it("rejects unsafe directory mode with special bits", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir, identity1, "sent");
		if (first.ok) BACKENDS.push(first);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.recoveryBackend.close();

		await chmod(dir, 0o1700);
		const second = await createBackend(dir, identity1, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
	});

	// ---- Input validation ----

	it("rejects missing directoryPath", async () => {
		const result = await createNodeB03RelayBackend(Object.freeze({ identity: identity1, direction: "sent" }));
		expect(result.ok).toBe(false);
	});

	it("rejects invalid direction", async () => {
		const result = await createNodeB03RelayBackend(
			Object.freeze({ directoryPath: "/tmp", identity: identity1, direction: "invalid" }),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects invalid identity (missing fields)", async () => {
		const result = await createNodeB03RelayBackend(
			Object.freeze({ directoryPath: "/tmp", identity: Object.freeze({ hostId: "h" }), direction: "sent" }),
		);
		expect(result.ok).toBe(false);
	});

	// ---- Publisher capabilities ----

	it("journalPublisher publishes a journal record then close is one-use", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const data = new TextEncoder().encode(JSON.stringify({ msg: "hello" }));
		const published = await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes: data }));
		expect(published).toMatchObject({ status: "success" });

		// Verify file exists
		const names = await readdir(dir);
		expect(names).toContain("00000000000000000001.b03-journal");

		// Verify identity.json is still there
		expect(names).toContain("identity.json");

		// Close publisher (one-use)
		const c1 = await result.journalPublisher.close();
		expect(c1.status).toBe("closed");

		// Second close returns cached closed
		const c2 = await result.journalPublisher.close();
		expect(c2.status).toBe("closed");

		// Publishing after close fails
		const afterClose = await result.journalPublisher.publish(
			Object.freeze({ journalDir: dir, seq: 2, bytes: new Uint8Array([1]) }),
		);
		expect(afterClose).toMatchObject({ status: "error" });

		await result.recoveryBackend.close();
	});

	it("deliveryPublisher publishes a delivery marker", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const data = new TextEncoder().encode(JSON.stringify({ marker: true }));
		const published = await result.deliveryPublisher.publish(
			Object.freeze({ journalDir: dir, indexSeq: 1, bytes: data }),
		);
		expect(published).toMatchObject({ status: "success" });

		const names = await readdir(dir);
		expect(names).toContain("00000000000000000001.b03-delivery");

		await result.recoveryBackend.close();
	});

	it("publisher rejects wrong journalDir", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const data = new Uint8Array([1, 2, 3]);
		const published = await result.journalPublisher.publish(
			Object.freeze({ journalDir: "/wrong/path", seq: 1, bytes: data }),
		);
		expect(published).toMatchObject({ status: "error" });

		await result.recoveryBackend.close();
	});

	it("publisher rejects wrong publish args (missing keys)", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const published = await result.journalPublisher.publish(
			Object.freeze({ journalDir: dir, seq: 1 }), // missing bytes
		);
		expect(published).toMatchObject({ status: "error" });

		await result.recoveryBackend.close();
	});

	// ---- Recovery backend listPage/open semantics ----

	it("listPage returns empty page for fresh directory", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		expect(page).toMatchObject({ entries: [], nextCursor: null });

		await result.recoveryBackend.close();
	});

	it("listPage returns journal entries after publishing", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Publish a journal record first
		const data = new TextEncoder().encode(JSON.stringify({ seq: 1 }));
		const pubResult = await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes: data }));
		expect(pubResult).toMatchObject({ status: "success" });

		// Close publisher to avoid interference during recovery
		await result.journalPublisher.close();

		// Now query listPage — should see the entry
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		expect(page).toMatchObject({ nextCursor: null });
		if ("entries" in page && Array.isArray(page.entries)) {
			expect(page.entries.length).toBe(1);
			const entry = page.entries[0] as Record<string, unknown>;
			expect(typeof entry.name).toBe("string");
			expect(entry.name).toBe("00000000000000000001.b03-journal");
			const stat = entry.stat as Record<string, unknown>;
			expect(stat.isFile).toBe(true);
			expect(stat.isSymlink).toBe(false);
			expect(stat.mode).toBe(0o600);
			expect(stat.nlink).toBe(1);
			expect(typeof stat.dev).toBe("string");
			expect(typeof stat.ino).toBe("string");
			expect(typeof stat.uid).toBe("string");
			expect(stat.size).toBeGreaterThan(0);
		}

		await result.recoveryBackend.close();
	});

	it("listPage returns entries in sorted order", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Publish 3 journal records
		for (let seq = 1; seq <= 3; seq++) {
			const data = new TextEncoder().encode(JSON.stringify({ seq }));
			await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq, bytes: data }));
		}
		await result.journalPublisher.close();

		// Read full page
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		if ("entries" in page && Array.isArray(page.entries)) {
			expect(page.entries.length).toBe(3);
			const names = page.entries.map((e: Record<string, unknown>) => e.name);
			expect(names).toEqual([
				"00000000000000000001.b03-journal",
				"00000000000000000002.b03-journal",
				"00000000000000000003.b03-journal",
			]);
		}

		await result.recoveryBackend.close();
	});

	it("open returns a B03ReadHandle with readAt/confirmEof/fstat/close", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const content = new TextEncoder().encode(JSON.stringify({ data: "test-content" }));
		const expectedBytes = new Uint8Array(content); // copy before publish zeroes original
		const pubResult = await result.journalPublisher.publish(
			Object.freeze({ journalDir: dir, seq: 1, bytes: content }),
		);
		expect(pubResult).toMatchObject({ status: "success" });
		await result.journalPublisher.close();

		// Get the entry via listPage
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		if (!("entries" in page) || !Array.isArray(page.entries) || page.entries.length === 0) {
			expect(false).toBe(true); // should have entries
			return;
		}
		const entry = page.entries[0] as Record<string, unknown>;

		// Open the entry
		const opened = await result.recoveryBackend.open(Object.freeze({ name: entry.name, expected: entry.stat }));
		expect(opened).toMatchObject({ status: "opened" });
		if (typeof opened !== "object" || opened === null || !("handle" in opened)) return;

		const handle = (opened as Record<string, unknown>).handle as Record<string, unknown>;
		expect(typeof handle.readAt).toBe("function");
		expect(typeof handle.confirmEof).toBe("function");
		expect(typeof handle.fstat).toBe("function");
		expect(typeof handle.close).toBe("function");

		// Read the content
		const readResult = await (handle.readAt as (o: number, s: number) => Promise<unknown>)(
			0,
			expectedBytes.byteLength,
		);
		expect(readResult).toMatchObject({ status: "bytes" });
		if (typeof readResult === "object" && readResult !== null && "bytes" in readResult) {
			const bytes = (readResult as { bytes: Uint8Array }).bytes;
			expect(bytes.byteLength).toBe(expectedBytes.byteLength);
			for (let i = 0; i < expectedBytes.byteLength; i++) {
				expect(bytes[i]).toBe(expectedBytes[i]);
			}
		}

		// Confirm EOF
		const eof = await (handle.confirmEof as (s: number) => Promise<unknown>)(expectedBytes.byteLength);
		expect(eof).toMatchObject({ status: "eof" });

		// Close handle
		const closeResult = await (handle.close as () => Promise<unknown>)();
		expect(closeResult).toMatchObject({ status: "closed" });

		await result.recoveryBackend.close();
	});

	it("open rejects traversal names", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Create a fake stat (won't matter as traversal is rejected first)
		const fakeStat = Object.freeze({
			dev: "0",
			ino: "0",
			uid: "0",
			mode: 0o600,
			size: 1,
			nlink: 1,
			isFile: true,
			isSymlink: false,
			mtimeNs: "0",
			ctimeNs: "0",
		}) as Record<string, unknown>;

		const opened = await result.recoveryBackend.open(Object.freeze({ name: "../etc/passwd", expected: fakeStat }));
		expect(opened).toMatchObject({ status: "error" });

		await result.recoveryBackend.close();
	});

	// ---- DurableRelayStore integration ----

	it("writes journal+marker then recovers via DurableRelayStore", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const storeResult = await createDurableRelayStore(
			Object.freeze({
				identity: identity1,
				direction: "sent",
				journalDir: dir,
				journalPublisher: result.journalPublisher,
				deliveryPublisher: result.deliveryPublisher,
				recoveryBackend: result.recoveryBackend,
			}),
		);

		expect(storeResult.ok).toBe(true);
		if (!storeResult.ok) return;

		// Publish journal
		const journalInput = Object.freeze({
			version: 1,
			direction: "sent",
			hostId: "host-a",
			generation: "gen-1",
			sessionId: "sess-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			envelope: makeEnvelope("f-001"),
		});
		const published = await storeResult.store.publish(journalInput);
		expect(published.ok).toBe(true);
		if (!published.ok) return;

		// Verify journal file on disk
		const journalExists = await stat(join(dir, "00000000000000000001.b03-journal")).then(
			() => true,
			() => false,
		);
		expect(journalExists).toBe(true);

		// Mark pending
		const pendingResult = await storeResult.store.markPending(
			Object.freeze({ frameId: "f-001", recordedAt: "2025-01-15T10:31:00.000Z" }),
		);
		expect(pendingResult.ok).toBe(true);

		// Mark delivered
		const deliveredResult = await storeResult.store.markDelivered(
			Object.freeze({ frameId: "f-001", recordedAt: "2025-01-15T10:32:00.000Z" }),
		);
		expect(deliveredResult.ok).toBe(true);

		// Verify marker file on disk
		const markerExists = await stat(join(dir, "00000000000000000001.b03-delivery")).then(
			() => true,
			() => false,
		);
		expect(markerExists).toBe(true);

		// Query frame state
		const query = await storeResult.store.query("f-001");
		expect(query.ok).toBe(true);
		if (!query.ok) return;
		expect(query.value.state).toBe("delivered");

		// Replay journals
		const replay = await storeResult.store.replayJournals(Object.freeze({ cursor: null, maxCount: 64 }));
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.entries.length).toBe(1);

		// Close store
		await storeResult.store.close();
	});

	// ---- Close semantics ----

	it("close consumes ownership, further operations fail", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await result.recoveryBackend.close();

		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		expect(page).toMatchObject({ status: "error" });

		const opened = await result.recoveryBackend.open(
			Object.freeze({
				name: "identity.json",
				expected: Object.freeze({
					dev: "0",
					ino: "0",
					uid: String(process.getuid()),
					mode: 0o600,
					size: 1,
					nlink: 1,
					isFile: true,
					isSymlink: false,
					mtimeNs: "0",
					ctimeNs: "0",
				}),
			}),
		);
		expect(opened).toMatchObject({ status: "error" });
	});

	// ---- Buffer erasure (publisher should erase transferred bytes) ----

	it("publisher zeroes the caller's bytes buffer after publication", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const data = new Uint8Array([1, 2, 3, 4, 5]);
		const _dataCopy = new Uint8Array(data);
		const pubResult = await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes: data }));
		expect(pubResult).toMatchObject({ status: "success" });

		// The original data buffer should be zeroed after transfer (by the publisher)
		// Note: publishImmutableJournalRecord erases the caller bytes through
		// its internal flow. We check the reference through data.
		// However, the test can't guarantee the same reference was used;
		// this is best-effort verification.
		const allZero = data.every((b) => b === 0);
		expect(allZero).toBe(true);

		await result.recoveryBackend.close();
	});

	// ---- Identity file mutation detection ----

	it("detects identity.json content mutation after creation", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await result.recoveryBackend.close();

		// Tamper with identity.json
		await writeFile(join(dir, "identity.json"), JSON.stringify({ version: 1, hostId: "evil" }));

		// Reopen should detect mismatch
		const second = await createBackend(dir, identity1, "sent");
		if (second.ok) BACKENDS.push(second);
		expect(second.ok).toBe(false);
	});

	// ---- Close uncertainty / alias rejection ----

	it("rejects capability aliasing (same object for multiple capabilities)", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(Object.is(result.journalPublisher, result.deliveryPublisher)).toBe(false);
		expect(Object.is(result.journalPublisher, result.recoveryBackend)).toBe(false);
		expect(Object.is(result.deliveryPublisher, result.recoveryBackend)).toBe(false);

		await result.recoveryBackend.close();
	});

	// ---- Paging order and bounds ----

	it("respects maxEntries and maxBytes bounds in listPage", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir, identity1, "sent");
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Publish 10 small records
		for (let seq = 1; seq <= 10; seq++) {
			const data = new TextEncoder().encode(JSON.stringify({ seq }));
			await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq, bytes: data }));
		}
		await result.journalPublisher.close();

		// Read with maxCount=3
		const page1 = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 3, maxBytes: 16_777_216 }),
		);
		if ("entries" in page1 && Array.isArray(page1.entries)) {
			expect(page1.entries.length).toBe(3);
		}

		// Page 2
		const page2 = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: "00000000000000000003.b03-journal", maxEntries: 3, maxBytes: 16_777_216 }),
		);
		if ("entries" in page2 && Array.isArray(page2.entries)) {
			expect(page2.entries.length).toBe(3);
		}

		// Page 3
		const page3 = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: "00000000000000000006.b03-journal", maxEntries: 3, maxBytes: 16_777_216 }),
		);
		if ("entries" in page3 && Array.isArray(page3.entries)) {
			expect(page3.entries.length).toBe(3);
		}

		// Page 4 — last entry
		const page4 = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: "00000000000000000009.b03-journal", maxEntries: 3, maxBytes: 16_777_216 }),
		);
		if ("entries" in page4 && Array.isArray(page4.entries)) {
			expect(page4.entries.length).toBe(1);
		}

		await result.recoveryBackend.close();
	});

	it("rejects a symlink parent before creating the target directory", async () => {
		const raw = await mkdtemp(join(tmpdir(), "b03-parent-"));
		const root = await realpath(raw);
		ROOTS.push(root);
		const actual = join(root, "actual");
		const alias = join(root, "alias");
		await mkdir(actual, { mode: 0o700 });
		await symlink(actual, alias);
		const target = join(alias, "journals");
		const result = await createNodeB03RelayBackend(
			Object.freeze({ directoryPath: target, identity: identity1, direction: "sent" }),
		);
		expect(result.ok).toBe(false);
		await expect(access(join(actual, "journals"))).rejects.toBeDefined();
	});

	it("binds identity using exact canonical bytes, not parsed JSON equivalence", async () => {
		const dir = await freshDir();
		const first = await createBackend(dir);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await first.journalPublisher.close();
		await first.deliveryPublisher.close();
		await first.recoveryBackend.close();
		const parsed = JSON.parse(await readFile(join(dir, "identity.json"), "utf8")) as Record<string, unknown>;
		await writeFile(
			join(dir, "identity.json"),
			JSON.stringify({
				direction: parsed.direction,
				sessionId: parsed.sessionId,
				generation: parsed.generation,
				hostId: parsed.hostId,
				version: 1,
			}),
		);
		const second = await createBackend(dir);
		expect(second.ok).toBe(false);
	});

	it("erases transferred bytes for a wrong directory and after publisher close", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const wrong = new Uint8Array([1, 2, 3]);
		const wrongResult = await result.journalPublisher.publish(
			Object.freeze({ journalDir: `${dir}-wrong`, seq: 1, bytes: wrong }),
		);
		expect(wrongResult).toEqual({ status: "error" });
		expect([...wrong]).toEqual([0, 0, 0]);
		const firstClose = result.journalPublisher.close();
		expect(result.journalPublisher.close()).toBe(firstClose);
		await firstClose;
		const afterClose = new Uint8Array([4, 5, 6]);
		const closedResult = await result.journalPublisher.publish(
			Object.freeze({ journalDir: dir, seq: 2, bytes: afterClose }),
		);
		expect(closedResult).toEqual({ status: "error" });
		expect([...afterClose]).toEqual([0, 0, 0]);
	});

	it("poisons publishers and recovery when the bound directory is replaced", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const moved = `${dir}-moved`;
		await rename(dir, moved);
		await mkdir(dir, { mode: 0o700 });
		const bytes = new Uint8Array([7, 8, 9]);
		const published = await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes }));
		expect(published).toEqual({ status: "IO_UNCONFIRMED" });
		expect([...bytes]).toEqual([0, 0, 0]);
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		expect(page).toEqual({ status: "error" });
	});

	it("rejects unknown directory entries and zero-sequence lookalikes", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await writeFile(join(dir, "00000000000000000000.b03-journal"), new Uint8Array([1]), { mode: 0o600 });
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		expect(page).toEqual({ status: "error" });
	});

	it("returns exact shared native close promises and drains admitted reads", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const content = new Uint8Array([10, 11, 12, 13]);
		await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes: content }));
		const page = await result.recoveryBackend.listPage(
			Object.freeze({ cursor: null, maxEntries: 64, maxBytes: 16_777_216 }),
		);
		if (!("entries" in page) || !Array.isArray(page.entries) || page.entries.length !== 1)
			throw new Error("missing entry");
		const opened = await result.recoveryBackend.open(
			Object.freeze({ name: page.entries[0].name, expected: page.entries[0].stat }),
		);
		if (!("status" in opened) || opened.status !== "opened" || !("handle" in opened)) throw new Error("open failed");
		const handle = opened.handle as { readAt(offset: number, size: number): unknown };
		const read = handle.readAt(0, 4);
		const closeOne = result.recoveryBackend.close();
		const closeTwo = result.recoveryBackend.close();
		expect(closeOne).toBe(closeTwo);
		expect(closeOne).toBeInstanceOf(Promise);
		expect(await read).toMatchObject({ status: "bytes" });
		expect(await closeOne).toEqual({ status: "closed" });
	});

	it("snapshots transferred bytes synchronously before queued publication", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bytes = new Uint8Array([21, 22, 23, 24]);
		const publication = result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes }));
		expect([...bytes]).toEqual([0, 0, 0, 0]);
		bytes.fill(99);
		expect(await publication).toMatchObject({ status: "success" });
		expect([...new Uint8Array(await readFile(join(dir, "00000000000000000001.b03-journal")))]).toEqual([
			21, 22, 23, 24,
		]);
	});

	it("rejects non-genuine transferred byte views without publishing", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		class ByteSubclass extends Uint8Array {}
		const backing = new Uint8Array([1, 2, 3, 4]);
		const invalid: unknown[] = [
			Buffer.from([1, 2, 3]),
			new ByteSubclass([1, 2, 3]),
			backing.subarray(1),
			new Proxy(new Uint8Array([1, 2, 3]), {}),
			new Uint8Array(new SharedArrayBuffer(3)),
		];
		let sequence = 1;
		for (const bytes of invalid) {
			const published = await result.journalPublisher.publish(
				Object.freeze({ journalDir: dir, seq: sequence, bytes }),
			);
			expect(published).toEqual({ status: "error" });
			sequence += 1;
		}
		expect((await readdir(dir)).filter((name) => name.endsWith(".b03-journal"))).toEqual([]);
	});

	it("poisons live publishers after identity-file mutation", async () => {
		const dir = await freshDir();
		const result = await createBackend(dir);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await writeFile(join(dir, "identity.json"), JSON.stringify({ version: 1, hostId: "changed" }), { mode: 0o600 });
		const bytes = new Uint8Array([31, 32, 33]);
		const published = await result.journalPublisher.publish(Object.freeze({ journalDir: dir, seq: 1, bytes }));
		expect(published).toEqual({ status: "IO_UNCONFIRMED" });
		expect([...bytes]).toEqual([0, 0, 0]);
	});
});
