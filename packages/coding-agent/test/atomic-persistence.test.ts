import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
