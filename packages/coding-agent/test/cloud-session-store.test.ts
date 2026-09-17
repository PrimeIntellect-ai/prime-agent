import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CLOUD_SESSION_RECORD_MAX_BYTES,
	CLOUD_SESSION_RECORD_VERSION,
	type CloudSessionRecord,
	CloudSessionStore,
	CloudSessionStoreError,
	cloudSessionRecordProblem,
} from "../src/core/cloud/cloud-session-store.js";
import { cloudCursor } from "../src/core/cloud/protocol.js";

const RESIDENT = "11111111-2222-3333-4444-555555555555";
const RESIDENT2 = "aaaa1111-2222-3333-4444-555555555555";

describe("CloudSessionStore", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createDirectory(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-cloud-session-store-"));
		roots.push(root);
		return join(root, "cloud-sessions");
	}

	function createSession(store: CloudSessionStore, sessionId = `sess_${randomUUID()}`): CloudSessionRecord {
		return store.create({ sessionId, residentProcessUuid: RESIDENT });
	}

	function recordPath(directory: string, sessionId: string): string {
		return join(directory, `${sessionId}.json`);
	}

	function expectCode(call: () => unknown, code: CloudSessionStoreError["code"]): CloudSessionStoreError {
		try {
			call();
		} catch (error) {
			expect(error).toBeInstanceOf(CloudSessionStoreError);
			expect((error as CloudSessionStoreError).code).toBe(code);
			return error as CloudSessionStoreError;
		}
		throw new Error("expected the call to throw");
	}

	it("allocates identity before compute and persists the record durably", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const record = store.create({ residentProcessUuid: RESIDENT });

		expect(record.version).toBe(CLOUD_SESSION_RECORD_VERSION);
		expect(record.sessionId).toMatch(/^sess_[0-9a-f-]{36}$/);
		expect(record.generation).toBe(1);
		expect(record.residentProcessUuid).toBe(RESIDENT);
		expect(record.desiredLifecycle).toBe("provisioning");
		expect(record.observedLifecycle).toBe("provisioning");
		expect(record.eventCursor).toEqual({ generation: 1, sequence: 0 });
		expect(record.ackCursor).toEqual({ generation: 1, sequence: 0 });
		expect(record.cleanupState).toBe("none");
		expect(record.resultImportState).toBe("pending");
		expect(record.createdAt).toBe(record.updatedAt);

		// The record is on disk the moment create returns, private to the owner.
		const path = recordPath(directory, record.sessionId);
		const stats = statSync(path);
		expect(stats.mode & 0o777).toBe(0o600);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		const persisted = JSON.parse(readFileSync(path, "utf8"));
		expect(cloudSessionRecordProblem(persisted)).toBeUndefined();
		expect(persisted).toEqual(JSON.parse(JSON.stringify(record)));
	});

	it("accepts a preallocated id and parent, and never creates over an existing session", () => {
		const store = new CloudSessionStore(createDirectory());
		const record = store.create({
			sessionId: "sess_preallocated-1",
			parentSessionId: "parent-session-1",
			residentProcessUuid: RESIDENT,
		});
		expect(record.sessionId).toBe("sess_preallocated-1");
		expect(record.parentSessionId).toBe("parent-session-1");

		const conflict = expectCode(
			() => store.create({ sessionId: "sess_preallocated-1", residentProcessUuid: RESIDENT }),
			"conflict",
		);
		expect(conflict.message).toContain("already exists");
		// The conflicting create did not touch the existing record.
		expect(store.get("sess_preallocated-1")).toEqual(record);
	});

	it("rejects invalid create inputs without writing a file", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		expectCode(() => store.create({ sessionId: "../escape", residentProcessUuid: RESIDENT }), "invalid");
		expectCode(() => store.create({ sessionId: "no-prefix", residentProcessUuid: RESIDENT }), "invalid");
		expectCode(
			() => store.create({ sessionId: "sess_ok", parentSessionId: "", residentProcessUuid: RESIDENT }),
			"invalid",
		);
		expectCode(() => store.create({ sessionId: "sess_ok", residentProcessUuid: "not-a-uuid" }), "invalid");
		expectCode(() => store.create({ sessionId: "sess_ok", residentProcessUuid: "" }), "invalid");
		expect(readdirSync(directory)).toEqual([]);
	});

	it("round-trips every field across a restart", () => {
		const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const sessionId = `sess_${randomUUID()}`;
		store.create({ sessionId, parentSessionId: "parent-1", residentProcessUuid: RESIDENT });
		store.setCreateIdempotencyKey(sessionId, "key-123");
		store.setSandbox(sessionId, "sbx-abc-1", "PROVISIONING");
		store.setBaseline(sessionId, {
			repoRoot: "/tmp/repo",
			headCommit: "0123456789abcdef0123456789abcdef01234567",
			manifestDigest: `sha256:${"a".repeat(64)}`,
		});
		store.setSandbox(sessionId, "sbx-abc-1", "RUNNING");
		store.setDeadline(sessionId, deadline);
		store.setDesiredLifecycle(sessionId, "running");
		store.setObservedLifecycle(sessionId, "running");
		store.recordAttachment(sessionId, RESIDENT2);
		store.advanceEventCursor(sessionId, cloudCursor(1, 42));
		store.advanceAckCursor(sessionId, cloudCursor(1, 40));
		store.setLastError(sessionId, "mirrored with one gap");
		store.setCleanupState(sessionId, "pending");
		store.setResultImportState(sessionId, "available");
		const live = store.get(sessionId);

		const restarted = new CloudSessionStore(directory);
		const restored = restarted.get(sessionId);
		expect(restored).toEqual(live);
		expect(restored?.sandboxId).toBe("sbx-abc-1");
		expect(restored?.sandboxStatus).toBe("RUNNING");
		expect(restored?.baseline).toEqual({
			repoRoot: "/tmp/repo",
			headCommit: "0123456789abcdef0123456789abcdef01234567",
			manifestDigest: `sha256:${"a".repeat(64)}`,
		});
		expect(restored?.deadlineAt).toBe(deadline);
		expect(restored?.eventCursor).toEqual({ generation: 1, sequence: 42 });
		expect(restored?.ackCursor).toEqual({ generation: 1, sequence: 40 });
		expect(restored?.lastError).toBe("mirrored with one gap");
		expect(restored?.cleanupState).toBe("pending");
		expect(restored?.resultImportState).toBe("available");
		expect(restored?.createdAt).toBe(live?.createdAt);
		expect(
			cloudSessionRecordProblem(JSON.parse(readFileSync(recordPath(directory, sessionId), "utf8"))),
		).toBeUndefined();
	});

	it("treats repeated identical updates as no-ops that never rewrite the file", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const { sessionId } = createSession(store);

		store.setSandbox(sessionId, "sbx-1", "RUNNING");
		const before = readFileSync(recordPath(directory, sessionId), "utf8");
		const afterSandbox = store.setSandbox(sessionId, "sbx-1", "RUNNING");
		expect(readFileSync(recordPath(directory, sessionId), "utf8")).toBe(before);
		expect(afterSandbox.updatedAt).toBe(JSON.parse(before).updatedAt);

		store.advanceEventCursor(sessionId, cloudCursor(1, 7));
		const withCursor = readFileSync(recordPath(directory, sessionId), "utf8");
		store.advanceEventCursor(sessionId, cloudCursor(1, 7));
		store.advanceAckCursor(sessionId, cloudCursor(1, 7));
		store.advanceAckCursor(sessionId, cloudCursor(1, 7));
		store.setDesiredLifecycle(sessionId, "running");
		store.setDesiredLifecycle(sessionId, "running");
		store.recordAttachment(sessionId, RESIDENT2);
		store.recordAttachment(sessionId, RESIDENT2);
		store.setLastError(sessionId, "boom");
		store.setLastError(sessionId, "boom");
		expect(readFileSync(recordPath(directory, sessionId), "utf8")).not.toBe(withCursor);
		const settled = readFileSync(recordPath(directory, sessionId), "utf8");
		store.setSandbox(sessionId, "sbx-1", "RUNNING");
		store.setDesiredLifecycle(sessionId, "running");
		store.recordAttachment(sessionId, RESIDENT2);
		store.setLastError(sessionId, "boom");
		store.advanceEventCursor(sessionId, cloudCursor(1, 7));
		store.advanceAckCursor(sessionId, cloudCursor(1, 7));
		store.setObservedLifecycle(sessionId, "provisioning"); // same value, still a no-op
		expect(readFileSync(recordPath(directory, sessionId), "utf8")).toBe(settled);
	});

	it("holds sandbox identity, create key, baseline, and deadline immutably", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setSandbox(sessionId, "sbx-1", "RUNNING");
		expectCode(() => store.setSandbox(sessionId, "sbx-other", "RUNNING"), "conflict");

		store.setCreateIdempotencyKey(sessionId, "key-1");
		expectCode(() => store.setCreateIdempotencyKey(sessionId, "key-2"), "conflict");

		store.setBaseline(sessionId, {
			repoRoot: "/repo",
			headCommit: null,
			manifestDigest: `sha256:${"b".repeat(64)}`,
		});
		expectCode(
			() =>
				store.setBaseline(sessionId, {
					repoRoot: "/repo",
					headCommit: "0123456789abcdef0123456789abcdef01234567",
					manifestDigest: `sha256:${"b".repeat(64)}`,
				}),
			"conflict",
		);
		expectCode(
			() =>
				store.setBaseline(sessionId, {
					repoRoot: "/repo",
					headCommit: null,
					manifestDigest: `sha256:${"c".repeat(64)}`,
				}),
			"conflict",
		);

		const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		store.setDeadline(sessionId, deadline);
		expectCode(() => store.setDeadline(sessionId, new Date(Date.now() + 90 * 60 * 1000).toISOString()), "conflict");
		expectCode(() => store.setDeadline(sessionId, "not-a-date"), "invalid");
	});

	it("moves cursors forward only, acks behind the event cursor, and fences stale generations", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.advanceEventCursor(sessionId, cloudCursor(1, 5));
		expect(store.get(sessionId)?.eventCursor).toEqual({ generation: 1, sequence: 5 });
		expectCode(() => store.advanceEventCursor(sessionId, cloudCursor(1, 4)), "invalid");
		expectCode(() => store.advanceEventCursor(sessionId, cloudCursor(2, 6)), "conflict");
		expectCode(() => store.advanceEventCursor(sessionId, { generation: 0, sequence: 6 }), "invalid");

		expectCode(() => store.advanceAckCursor(sessionId, cloudCursor(1, 6)), "invalid");
		store.advanceAckCursor(sessionId, cloudCursor(1, 5));
		expectCode(() => store.advanceAckCursor(sessionId, cloudCursor(1, 4)), "invalid");
		expect(store.get(sessionId)?.ackCursor).toEqual({ generation: 1, sequence: 5 });
	});

	it("fences a new generation and restarts per-incarnation identity", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);
		store.setSandbox(sessionId, "sbx-1", "RUNNING");
		store.setCreateIdempotencyKey(sessionId, "key-1");
		store.setDeadline(sessionId, new Date(Date.now() + 60 * 60 * 1000).toISOString());
		store.recordAttachment(sessionId, RESIDENT2);
		store.setDesiredLifecycle(sessionId, "running");
		store.advanceEventCursor(sessionId, cloudCursor(1, 20));
		store.advanceAckCursor(sessionId, cloudCursor(1, 20));

		const next = store.nextGeneration(sessionId, RESIDENT);
		expect(next.generation).toBe(2);
		expect(next.residentProcessUuid).toBe(RESIDENT);
		expect(next.eventCursor).toEqual({ generation: 2, sequence: 0 });
		expect(next.ackCursor).toEqual({ generation: 2, sequence: 0 });
		expect(next.sandboxId).toBeUndefined();
		expect(next.sandboxStatus).toBeUndefined();
		expect(next.createIdempotencyKey).toBeUndefined();
		expect(next.deadlineAt).toBeUndefined();
		expect(next.attachmentUuid).toBeUndefined();
		expect(next.desiredLifecycle).toBe("provisioning");
		expect(next.observedLifecycle).toBe("provisioning");

		// A stale writer from generation 1 is fenced off, never folded in.
		expectCode(() => store.advanceEventCursor(sessionId, cloudCursor(1, 21)), "conflict");
		expectCode(() => store.advanceAckCursor(sessionId, cloudCursor(1, 21)), "conflict");
		store.advanceEventCursor(sessionId, cloudCursor(2, 1));
		expect(store.get(sessionId)?.eventCursor).toEqual({ generation: 2, sequence: 1 });

		// The new incarnation provisions a fresh sandbox identity.
		store.setSandbox(sessionId, "sbx-2", "PROVISIONING");
		store.setDeadline(sessionId, new Date(Date.now() + 120 * 60 * 1000).toISOString());
		expect(store.get(sessionId)?.sandboxId).toBe("sbx-2");
	});

	it("advances the desired lifecycle monotonically", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setDesiredLifecycle(sessionId, "running");
		store.setDesiredLifecycle(sessionId, "stopping");
		store.setDesiredLifecycle(sessionId, "deleted");
		expect(store.get(sessionId)?.desiredLifecycle).toBe("deleted");
		expectCode(() => store.setDesiredLifecycle(sessionId, "running"), "invalid");

		const second = createSession(store);
		store.setDesiredLifecycle(second.sessionId, "running");
		expectCode(() => store.setDesiredLifecycle(second.sessionId, "provisioning"), "invalid");
		// Stopping directly from provisioning (cancel during provisioning) is allowed.
		store.setDesiredLifecycle(second.sessionId, "stopping");
		expect(store.get(second.sessionId)?.desiredLifecycle).toBe("stopping");
	});

	it("observes lifecycle transitions without regressing to provisioning", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setObservedLifecycle(sessionId, "running");
		expectCode(() => store.setObservedLifecycle(sessionId, "provisioning"), "invalid");
		store.setObservedLifecycle(sessionId, "lost");
		store.setObservedLifecycle(sessionId, "deleted");
		expectCode(() => store.setObservedLifecycle(sessionId, "running"), "invalid");
	});

	it("sequences cleanup behind result import and keeps both inspectable", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setCleanupState(sessionId, "pending");
		store.setCleanupState(sessionId, "importing");
		store.setCleanupState(sessionId, "imported");
		store.setCleanupState(sessionId, "releasing");
		store.setCleanupState(sessionId, "released");
		expectCode(() => store.setCleanupState(sessionId, "pending"), "invalid");

		const second = createSession(store);
		expectCode(() => store.setCleanupState(second.sessionId, "failed"), "invalid"); // no intent yet
		store.setCleanupState(second.sessionId, "pending");
		store.setCleanupState(second.sessionId, "failed");
		store.setCleanupState(second.sessionId, "releasing"); // retry from failure
		store.setCleanupState(second.sessionId, "failed");
		expectCode(() => store.setCleanupState(second.sessionId, "pending"), "invalid"); // no regression on retry
		store.setCleanupState(second.sessionId, "released");
		expectCode(() => store.setCleanupState(second.sessionId, "pending"), "invalid");
	});

	it("tracks result import through review with terminal states", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setResultImportState(sessionId, "available");
		store.setResultImportState(sessionId, "failed");
		store.setResultImportState(sessionId, "reviewed"); // retry resumes past failure
		store.setResultImportState(sessionId, "imported");
		expectCode(() => store.setResultImportState(sessionId, "reviewed"), "invalid");

		const second = createSession(store);
		store.setResultImportState(second.sessionId, "available");
		store.setResultImportState(second.sessionId, "skipped");
		expectCode(() => store.setResultImportState(second.sessionId, "imported"), "invalid");

		const third = createSession(store);
		store.setResultImportState(third.sessionId, "failed"); // a lost sandbox can end the import
		store.setResultImportState(third.sessionId, "available");
		expectCode(() => store.setResultImportState(third.sessionId, "pending"), "invalid");
	});

	it("records, replaces, and clears the last error with a bound", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);

		store.setLastError(sessionId, "first failure");
		expect(store.get(sessionId)?.lastError).toBe("first failure");
		store.setLastError(sessionId, "second failure");
		expect(store.get(sessionId)?.lastError).toBe("second failure");
		store.setLastError(sessionId);
		expect(store.get(sessionId)?.lastError).toBeUndefined();
		expectCode(() => store.setLastError(sessionId, "x".repeat(2049)), "invalid");
		expectCode(() => store.setLastError(sessionId, ""), "invalid");
	});

	it("quarantines malformed records and fails closed on read", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const good = createSession(store);
		const path = recordPath(directory, "sess_broken");

		writeFileSync(path, "{ this is not json", { mode: 0o600 });
		const error = expectCode(() => store.get("sess_broken"), "corrupt");
		expect(error.message).toContain("quarantined");
		// The quarantined file keeps the original bytes and the private mode.
		const [quarantineName] = readdirSync(directory).filter((entry) => entry.endsWith(".quarantine"));
		expect(readFileSync(join(directory, quarantineName), "utf8")).toBe("{ this is not json");
		expect(statSync(join(directory, quarantineName)).mode & 0o777).toBe(0o600);
		// The malformed record is gone from the store; other records are intact.
		expect(store.get("sess_broken")).toBeUndefined();
		expect(store.get(good.sessionId)?.sessionId).toBe(good.sessionId);
		expect(store.list().map((record) => record.sessionId)).toEqual([good.sessionId]);
		// Recreating over a quarantined session is explicit and possible.
		expect(store.create({ sessionId: "sess_broken", residentProcessUuid: RESIDENT }).sessionId).toBe("sess_broken");
	});

	it("quarantines schema-invalid and invariant-violating records", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const base = createSession(store, "sess_schema");

		const cases: Array<[string, unknown]> = [
			["wrong version", { ...base, version: 99 }],
			["unknown field", { ...base, extra: true }],
			["missing field", { ...base, generation: undefined }],
			["stale cursor generation", { ...base, eventCursor: { generation: 2, sequence: 1 } }],
			[
				"ack past event",
				{ ...base, eventCursor: { generation: 1, sequence: 3 }, ackCursor: { generation: 1, sequence: 4 } },
			],
			["bad sandbox id", { ...base, sandboxId: "../escape" }],
			["bad status", { ...base, sandboxStatus: "VAPORIZED" }],
			["bad uuid", { ...base, residentProcessUuid: "not-a-uuid" }],
			["bad digest", { ...base, baseline: { repoRoot: "/r", headCommit: null, manifestDigest: "md5:zz" } }],
			["bad timestamp", { ...base, deadlineAt: "yesterday" }],
			["non-object", [1, 2, 3]],
		];
		for (const [_label, value] of cases) {
			const path = recordPath(directory, "sess_schema");
			writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
			expectCode(() => store.get("sess_schema"), "corrupt");
			expect(readdirSync(directory).some((entry) => entry.endsWith(".quarantine"))).toBe(true);
		}

		// Oversized files are quarantined too.
		const path = recordPath(directory, "sess_schema");
		writeFileSync(
			path,
			`${"x".repeat(CLOUD_SESSION_RECORD_MAX_BYTES)}
`,
			{ mode: 0o600 },
		);
		expectCode(() => store.get("sess_schema"), "corrupt");
	});

	it("fails closed when listing hits a malformed record, then recovers", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const first = createSession(store, "sess_a");
		const second = createSession(store, "sess_b");
		writeFileSync(recordPath(directory, "sess_c"), "null", { mode: 0o600 });

		expectCode(() => store.list(), "corrupt");
		// The first list call quarantined the malformed record; the next one works.
		const records = store.list();
		expect(records.map((record) => record.sessionId)).toEqual([first.sessionId, second.sessionId]);
	});

	it("refuses to persist an invalid record and never writes it", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const { sessionId } = createSession(store);
		// A deadline before createdAt cannot be persisted.
		expectCode(() => store.setDeadline(sessionId, "2000-01-01T00:00:00.000Z"), "invalid");
		expect(store.get(sessionId)?.deadlineAt).toBeUndefined();
	});

	it("fails closed for updates and lookups of unknown sessions", () => {
		const store = new CloudSessionStore(createDirectory());
		expect(store.get("sess_missing")).toBeUndefined();
		expectCode(() => store.setDesiredLifecycle("sess_missing", "running"), "not_found");
		expectCode(() => store.advanceEventCursor("sess_missing", cloudCursor(1, 1)), "not_found");
		expectCode(() => store.setLastError("sess_missing", "boom"), "not_found");
		expectCode(() => store.setDesiredLifecycle("bad id", "running"), "invalid");
	});

	it("returns defensive copies, never live state", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const record = createSession(store);
		record.desiredLifecycle = "deleted";
		record.eventCursor = { generation: 9, sequence: 9 };
		const fresh = store.get(record.sessionId);
		expect(fresh?.desiredLifecycle).toBe("provisioning");
		expect(fresh?.eventCursor).toEqual({ generation: 1, sequence: 0 });
		expect(JSON.parse(readFileSync(recordPath(directory, record.sessionId), "utf8")).desiredLifecycle).toBe(
			"provisioning",
		);
	});

	it("leaves no temporary files behind", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const { sessionId } = createSession(store);
		for (let index = 1; index <= 25; index++) {
			store.advanceEventCursor(sessionId, cloudCursor(1, index));
		}
		const entries = readdirSync(directory);
		expect(entries).toEqual([`${sessionId}.json`]);
	});

	it("deletes a record explicitly and reports absence", () => {
		const store = new CloudSessionStore(createDirectory());
		const { sessionId } = createSession(store);
		expect(store.delete(sessionId)).toBe(true);
		expect(store.get(sessionId)).toBeUndefined();
		expect(store.delete(sessionId)).toBe(false);
		// Deleting does not resurrect: a new create for the same id is allowed.
		expect(store.create({ sessionId, residentProcessUuid: RESIDENT }).generation).toBe(1);
	});

	it("preserves the private mode on records rewritten over permissive files", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const { sessionId } = createSession(store);
		const path = recordPath(directory, sessionId);
		chmodSync(path, 0o666);
		store.setDesiredLifecycle(sessionId, "running");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("records a Prime Tunnel registration once and marks its release terminal", () => {
		const directory = createDirectory();
		const store = new CloudSessionStore(directory);
		const { sessionId } = createSession(store);
		const tunnel = {
			tunnelId: "tun_abc123",
			url: "https://tun-abc123.tunnels.example.com",
			hostname: "tun-abc123.tunnels.example.com",
			httpUser: "prime-agent",
			expiresAt: "2027-01-01T00:00:00.000Z",
			registeredAt: "2026-09-16T00:00:00.000Z",
		};
		const updated = store.setTunnel(sessionId, tunnel);
		expect(updated.tunnel).toEqual(tunnel);
		expect(updated.tunnelState).toBe("released" === updated.tunnelState ? "registered" : "registered");
		// Idempotent re-registration of the same tunnel is a no-op.
		expect(store.setTunnel(sessionId, tunnel).updatedAt).toBe(updated.updatedAt);
		// A different tunnel is a conflict until the previous one is released.
		expectCode(
			() =>
				store.setTunnel(sessionId, {
					...tunnel,
					tunnelId: "tun_other",
					url: "https://tun-other.tunnels.example.com",
					hostname: "tun-other.tunnels.example.com",
				}),
			"conflict",
		);
		const released = store.setTunnelState(sessionId, "released");
		expect(released.tunnelState).toBe("released");
		expectCode(() => store.setTunnelState(sessionId, "registered"), "conflict");
		// After release, a fresh registration replaces the tunnel.
		store.setTunnel(sessionId, { ...tunnel, tunnelId: "tun_other" });
		expect(store.get(sessionId)?.tunnel?.tunnelId).toBe("tun_other");
		// Validation fails closed on malformed tunnel records.
		expect(cloudSessionRecordProblem({ ...store.get(sessionId), tunnel: { tunnelId: "bad id" } })).toContain(
			"record.tunnel",
		);
		expectCode(() => store.setTunnel(sessionId, { ...tunnel, url: "" }), "invalid");
		// Old records without tunnel fields still validate.
		const legacy = { ...store.get(sessionId) } as Record<string, unknown>;
		delete legacy.tunnel;
		delete legacy.tunnelState;
		expect(cloudSessionRecordProblem(legacy)).toBeUndefined();
	});
});
