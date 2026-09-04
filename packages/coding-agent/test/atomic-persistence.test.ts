import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
	type writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type WriteSync = typeof writeSync;
const shortWrites = vi.hoisted(() => ({ remaining: 0 }));
const rmFault = vi.hoisted(() => ({ error: undefined as Error | undefined }));
const linkSweep = vi.hoisted(() => ({ remaining: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		linkSync: ((existing: Parameters<typeof actual.linkSync>[0], created: Parameters<typeof actual.linkSync>[1]) => {
			if (linkSweep.remaining > 0) {
				linkSweep.remaining--;
				// A rival's sweep claims the candidate between write and publish.
				actual.rmSync(existing, { force: true });
			}
			return actual.linkSync(existing, created);
		}) as typeof actual.linkSync,
		rmSync: ((path: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
			if (rmFault.error && String(path).includes(".candidate-")) throw rmFault.error;
			return actual.rmSync(path, options);
		}) as typeof actual.rmSync,
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
	it("retries with a fresh candidate when a rival's sweep claims the first mid-publish", async () => {
		const dir = createTempDir();
		const lockPath = join(dir, "suspended.lock");
		linkSweep.remaining = 1;

		try {
			expect(await tryAcquireDirLock(lockPath, () => false)).toBe("acquired");
		} finally {
			linkSweep.remaining = 0;
		}
		expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
	});

	it("sweeps abandoned candidates on acquire while sparing fresh ones and the lock", async () => {
		const dir = createTempDir();
		const lockPath = join(dir, "swept.lock");
		const abandoned = join(dir, "swept.lock.candidate-1234-dead");
		const fresh = join(dir, "swept.lock.candidate-5678-mid-publish");
		writeFileSync(abandoned, "1234\n");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(abandoned, twoHoursAgo, twoHoursAgo);
		writeFileSync(fresh, "5678\n");

		expect(await tryAcquireDirLock(lockPath, () => false)).toBe("acquired");

		const names = readdirSync(dir).sort();
		expect(names).not.toContain("swept.lock.candidate-1234-dead");
		expect(names).toContain("swept.lock.candidate-5678-mid-publish");
		expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
	});

	it("reports held instead of reclaiming when the owner cannot be read", async () => {
		const dir = createTempDir();
		const lockDir = join(dir, "opaque.lock");
		// Legacy lock whose pid entry is a directory: every read fails non-ENOENT.
		mkdirSync(join(lockDir, "pid"), { recursive: true });

		expect(await tryAcquireDirLock(lockDir, () => false)).toBe("held");
		expect(readdirSync(dir)).toEqual(["opaque.lock"]);
	});

	it("keeps a settled acquisition when candidate cleanup fails", async () => {
		const dir = createTempDir();
		const lockPath = join(dir, "cleanup.lock");
		rmFault.error = new Error("EBUSY: held by scanner");

		try {
			expect(await tryAcquireDirLock(lockPath, () => false)).toBe("acquired");
		} finally {
			rmFault.error = undefined;
		}
		expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
	});

	it("publishes the lock as a file born with its owner and puts back a swapped file lock", async () => {
		const dir = createTempDir();
		const lockPath = join(dir, "file.lock");
		const alive = (ownerPid: number | undefined) => ownerPid === process.pid || ownerPid === 424242;

		expect(await tryAcquireDirLock(lockPath, alive)).toBe("acquired");
		expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
		expect(await tryAcquireDirLock(lockPath, alive)).toBe("held");

		// Stale file lock: dead owner content is reclaimed.
		writeFileSync(lockPath, "999999999\n");
		const swapped = await tryAcquireDirLock(lockPath, () => {
			// A rival replaces the lock while the staleness judgment runs.
			rmSync(lockPath, { force: true });
			writeFileSync(lockPath, "424242\n");
			return false;
		});
		expect(swapped).toBe("held");
		expect(readFileSync(lockPath, "utf8").trim()).toBe("424242");
	});

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

		// Cross-shape swap: a judged FILE lock replaced by a rival's legacy DIR must
		// be put back by the moved entry's actual type (link would fail on a dir).
		rmSync(lockDir, { recursive: true, force: true });
		writeFileSync(lockDir, "999999999\n");
		const crossType = await tryAcquireDirLock(lockDir, () => {
			rmSync(lockDir, { recursive: true, force: true });
			mkdirSync(lockDir);
			writeFileSync(join(lockDir, "pid"), "555555\n");
			return false;
		});
		expect(crossType).toBe("held");
		expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe("555555");
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
		expect(readFileSync(lockDir, "utf8").trim()).toBe(String(process.pid));

		// Every rival attempt against the live owner reports "held" and leaves the lock alone.
		const rivals = await Promise.all(Array.from({ length: 8 }, () => tryAcquireDirLock(lockDir, alive)));
		expect(rivals).toEqual(Array.from({ length: 8 }, () => "held"));
		expect(readFileSync(lockDir, "utf8").trim()).toBe(String(process.pid));
	});
});
