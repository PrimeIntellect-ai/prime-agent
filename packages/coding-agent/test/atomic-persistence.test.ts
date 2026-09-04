import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, type writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type WriteSync = typeof writeSync;
const shortWrites = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: ((fd: number, data: NodeJS.ArrayBufferView | string, offset?: number, length?: number) => {
			if (shortWrites.remaining > 0 && typeof data === "string" && data.length > 1) {
				shortWrites.remaining--;
				return (actual.writeSync as WriteSync)(fd, data.slice(0, 1) as never);
			}
			if (shortWrites.remaining > 0 && typeof length === "number" && length > 1) {
				shortWrites.remaining--;
				return (actual.writeSync as WriteSync)(fd, data as NodeJS.ArrayBufferView, offset, 1);
			}
			return (actual.writeSync as WriteSync)(fd, data as never, offset as never, length as never);
		}) as WriteSync,
	};
});

import { writeFileAtomicSync } from "../src/utils/atomic-file.js";
import { tryAcquireDirLock } from "../src/utils/dir-lock.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "prime-atomic-persistence-"));
	tempDirs.push(dir);
	return dir;
}

describe("writeFileAtomicSync", () => {
	it("writes the complete payload even when the kernel returns short counts", () => {
		const dir = createTempDir();
		const path = join(dir, "short.json");
		shortWrites.remaining = 3;
		try {
			writeFileAtomicSync(path, JSON.stringify({ key: "value".repeat(10) }));
		} finally {
			shortWrites.remaining = 0;
		}
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ key: "value".repeat(10) });
	});

	it("leaves the destination untouched and no temp file behind when the write fails", () => {
		const dir = createTempDir();
		const path = join(dir, "state.json");
		writeFileSync(path, "previous");

		expect(() =>
			writeFileAtomicSync(path, "next", {
				beforeRename: () => {
					throw new Error("validation failed");
				},
			}),
		).toThrow("validation failed");

		expect(readFileSync(path, "utf8")).toBe("previous");
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("tryAcquireDirLock", () => {
	it("treats a garbage pid file as stale instead of trusting its numeric prefix", async () => {
		const dir = createTempDir();
		const lockDir = join(dir, "garbage.lock");
		mkdirSync(lockDir);
		writeFileSync(join(lockDir, "pid"), "123garbage\n");

		const alive = (ownerPid: number | undefined) => ownerPid === 123;
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("reclaimed");
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("acquired");
	});

	it("treats pid 0 in a lock as stale instead of probing the caller's own process group", async () => {
		const dir = createTempDir();
		const lockDir = join(dir, "zero.lock");
		mkdirSync(lockDir);
		writeFileSync(join(lockDir, "pid"), "0\n");

		const alive = (ownerPid: number | undefined) =>
			ownerPid === undefined ? false : process.kill(ownerPid, 0) !== undefined;
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("reclaimed");
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("acquired");
	});

	it("puts back a lock that changed owners between the staleness judgment and the reclaim", async () => {
		const dir = createTempDir();
		const lockDir = join(dir, "raced.lock");
		mkdirSync(lockDir);
		writeFileSync(join(lockDir, "pid"), "2147483647\n");

		const result = await tryAcquireDirLock(lockDir, () => {
			// The stale owner releases and a rival acquires while this judgment runs.
			rmSync(lockDir, { recursive: true, force: true });
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), "424242\n");
			return false;
		});

		expect(result).toBe("held");
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe("424242");
	});

	it("acquires over a stale lock without deleting a lock that changed owners", async () => {
		const dir = createTempDir();
		const lockDir = join(dir, "work.lock");
		// A stale lock: dead owner.
		mkdirSync(lockDir);
		writeFileSync(join(lockDir, "pid"), "2147483647\n");

		const alive = (ownerPid: number | undefined) => ownerPid === process.pid;
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("reclaimed");
		expect(await tryAcquireDirLock(lockDir, alive)).toBe("acquired");
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));

		// Every rival attempt against the live owner reports "held" and leaves the lock alone.
		const rivals = await Promise.all(Array.from({ length: 8 }, () => tryAcquireDirLock(lockDir, alive)));
		expect(rivals).toEqual(Array.from({ length: 8 }, () => "held"));
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
	});
});
