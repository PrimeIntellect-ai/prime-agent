import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDurableObservationApplication } from "../src/modes/daemon/durable-observation-application.js";
import type { DurableObservationIdentity } from "../src/modes/daemon/durable-observation-record-codec.js";
import { createNodeDurableObservationBackend } from "../src/modes/daemon/node-durable-observation-backend.js";
import type { RemoteHostEventFrame, RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_INFO } from "../src/modes/daemon/remote-agent-host-protocol.js";

const identity = Object.freeze({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

async function directory(): Promise<Readonly<{ root: string; path: string }>> {
	const raw = await mkdtemp(join(tmpdir(), "prime-observation-"));
	const root = await realpath(raw);
	roots.push(root);
	return Object.freeze({ root, path: join(root, "records") });
}

function envelope(sequence: number): RemoteHostFrameEnvelope {
	const frame: RemoteHostEventFrame = Object.freeze({
		type: "event",
		id: `event-${sequence}`,
		sequence,
		cursor: Object.freeze({ ...identity, sequence }),
		emittedAt: `2025-01-01T00:00:0${sequence}.000Z`,
		body: Object.freeze(
			sequence === 1
				? { type: "session_created", sessionId: "sess-1", workspaceId: "workspace-1" }
				: { type: "agent_start" },
		),
	});
	return Object.freeze({
		type: "frame",
		frameId: `frame-${sequence}`,
		protocol: Object.freeze({ ...REMOTE_HOST_PROTOCOL_INFO }),
		sentAt: frame.emittedAt,
		frame,
	});
}

async function create(path: string, value: Readonly<DurableObservationIdentity> = identity) {
	return await createNodeDurableObservationBackend(Object.freeze({ directoryPath: path, identity: value }));
}

describe("node durable observation backend", () => {
	it("creates an identity-bound journal, persists events, and recovers the exact snapshot after restart", async () => {
		const location = await directory();
		const firstBackend = await create(location.path);
		expect(firstBackend.ok).toBe(true);
		if (!firstBackend.ok) return;
		const first = await createDurableObservationApplication(
			Object.freeze({ backend: firstBackend.backend, identity }),
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(await first.application.apply(Object.freeze({ envelope: envelope(1) }))).toEqual({ status: "applied" });
		const expected = first.view.snapshot();
		expect(await first.application.close()).toEqual({ status: "closed" });
		const names = (await readdir(location.path)).sort();
		expect(names).toEqual([
			"00000000000000000001.b11-observation",
			"00000000000000000002.b11-observation",
			"identity.json",
		]);
		expect((await stat(location.path)).mode & 0o777).toBe(0o700);
		for (const name of names) expect((await stat(join(location.path, name))).mode & 0o777).toBe(0o600);
		const secondBackend = await create(location.path);
		expect(secondBackend.ok).toBe(true);
		if (!secondBackend.ok) return;
		const second = await createDurableObservationApplication(
			Object.freeze({ backend: secondBackend.backend, identity }),
		);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.view.snapshot()).toEqual(expected);
		expect(await second.application.close()).toEqual({ status: "closed" });
	});

	it("rejects reopening a directory with a different durable identity", async () => {
		const location = await directory();
		const first = await create(location.path);
		if (!first.ok) throw new Error("create failed");
		expect(await first.backend.close()).toEqual({ status: "closed" });
		expect(await create(location.path, Object.freeze({ ...identity, generation: "gen-2" }))).toEqual({
			ok: false,
			error: { code: "IDENTITY_MISMATCH" },
		});
	});

	it("rejects a sequence gap before exposing a backend", async () => {
		const location = await directory();
		const backend = await create(location.path);
		if (!backend.ok) throw new Error("create failed");
		const app = await createDurableObservationApplication(Object.freeze({ backend: backend.backend, identity }));
		if (!app.ok) throw new Error("application failed");
		expect((await app.application.apply(Object.freeze({ envelope: envelope(1) }))).status).toBe("applied");
		expect((await app.application.close()).status).toBe("closed");
		await rename(
			join(location.path, "00000000000000000002.b11-observation"),
			join(location.path, "00000000000000000003.b11-observation"),
		);
		expect(await create(location.path)).toEqual({ ok: false, error: { code: "DIRECTORY_UNSAFE" } });
	});

	it("lets canonical recovery reject tampered record bytes", async () => {
		const location = await directory();
		const backend = await create(location.path);
		if (!backend.ok) throw new Error("create failed");
		const app = await createDurableObservationApplication(Object.freeze({ backend: backend.backend, identity }));
		if (!app.ok) throw new Error("application failed");
		expect((await app.application.apply(Object.freeze({ envelope: envelope(1) }))).status).toBe("applied");
		expect((await app.application.close()).status).toBe("closed");
		const path = join(location.path, "00000000000000000001.b11-observation");
		const bytes = await readFile(path);
		bytes[10] ^= 1;
		await writeFile(path, bytes, { mode: 0o600 });
		await chmod(path, 0o600);
		const reopened = await create(location.path);
		if (!reopened.ok) throw new Error("reopen failed");
		expect(await createDurableObservationApplication(Object.freeze({ backend: reopened.backend, identity }))).toEqual(
			{ ok: false, error: { code: "RECOVERY_CORRUPT" } },
		);
	});

	it("rejects symlinked record entries", async () => {
		const location = await directory();
		const backend = await create(location.path);
		if (!backend.ok) throw new Error("create failed");
		expect((await backend.backend.close()).status).toBe("closed");
		await symlink(join(location.path, "identity.json"), join(location.path, "00000000000000000001.b11-observation"));
		expect(await create(location.path)).toEqual({ ok: false, error: { code: "DIRECTORY_UNSAFE" } });
	});

	it("paginates by byte limit and preserves strict pending-applied sequence", async () => {
		const location = await directory();
		const first = await create(location.path);
		if (!first.ok) throw new Error("create failed");
		const empty = (await first.backend.recoverPage(
			Object.freeze({ cursor: null, maxCount: 64, maxBytes: 16 * 1024 * 1024 }),
		)) as {
			owner: { close(): Promise<unknown> };
		};
		await empty.owner.close();
		for (const [state, method] of [
			["pending", first.backend.publishPending],
			["applied", first.backend.publishApplied],
		] as const) {
			const bytes = new Uint8Array([1, 2, 3]);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			expect(
				await method(Object.freeze({ bytes, observationId: "a".repeat(64), sha256, size: 3, state })),
			).toMatchObject({ status: "persisted", state });
			expect([...bytes]).toEqual([0, 0, 0]);
		}
		expect((await first.backend.close()).status).toBe("closed");
		const second = await create(location.path);
		if (!second.ok) throw new Error("reopen failed");
		const page1 = (await second.backend.recoverPage(Object.freeze({ cursor: null, maxCount: 64, maxBytes: 4 }))) as {
			entries: readonly unknown[];
			nextCursor: number | null;
			owner: { close(): Promise<unknown> };
		};
		expect(page1.entries).toHaveLength(1);
		expect(page1.nextCursor).toBe(1);
		await page1.owner.close();
		const page2 = (await second.backend.recoverPage(Object.freeze({ cursor: 1, maxCount: 64, maxBytes: 4 }))) as {
			entries: readonly unknown[];
			nextCursor: number | null;
			owner: { close(): Promise<unknown> };
		};
		expect(page2.entries).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
		await page2.owner.close();
		expect((await second.backend.close()).status).toBe("closed");
	});

	it("rejects aliased publication-byte ownership without racing the first owner", async () => {
		const location = await directory();
		const created = await create(location.path);
		if (!created.ok) throw new Error("create failed");
		const empty = (await created.backend.recoverPage(
			Object.freeze({ cursor: null, maxCount: 64, maxBytes: 16 * 1024 * 1024 }),
		)) as {
			owner: { close(): Promise<unknown> };
		};
		await empty.owner.close();
		const bytes = new Uint8Array([1, 2, 3]);
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		const request = Object.freeze({ bytes, observationId: "a".repeat(64), sha256, size: 3, state: "pending" });
		const first = created.backend.publishPending(request);
		const alias = created.backend.publishPending(request);
		expect(await first).toMatchObject({ status: "persisted" });
		expect(await alias).toMatchObject({ status: "error" });
		expect([...bytes]).toEqual([0, 0, 0]);
		expect((await created.backend.close()).status).toBe("closed");
	});

	it("detects identity-file mutation after backend acquisition", async () => {
		const location = await directory();
		const created = await create(location.path);
		if (!created.ok) throw new Error("create failed");
		await writeFile(join(location.path, "identity.json"), "mutated", { mode: 0o600 });
		await chmod(join(location.path, "identity.json"), 0o600);
		expect(await createDurableObservationApplication(Object.freeze({ backend: created.backend, identity }))).toEqual({
			ok: false,
			error: { code: "RECOVERY_UNCERTAIN" },
		});
	});

	it("owns invalid publication bytes and returns one shared page-owner close promise", async () => {
		const location = await directory();
		const created = await create(location.path);
		if (!created.ok) throw new Error("create failed");
		const page = (await created.backend.recoverPage(
			Object.freeze({ cursor: null, maxCount: 64, maxBytes: 8 * 1024 * 1024 }),
		)) as {
			status: string;
			owner: { close(): Promise<unknown> };
		};
		expect(page.status).toBe("page");
		const first = page.owner.close();
		expect(page.owner.close()).toBe(first);
		expect(await first).toEqual({ status: "closed" });
		const bytes = new Uint8Array([1, 2, 3]);
		const result = await created.backend.publishApplied(
			Object.freeze({
				bytes,
				observationId: "a".repeat(64),
				sha256: "b".repeat(64),
				size: 3,
				state: "applied",
			}),
		);
		expect(result).toMatchObject({ status: "error" });
		expect([...bytes]).toEqual([0, 0, 0]);
		expect(await created.backend.close()).toEqual({ status: "closed" });
	});
});
