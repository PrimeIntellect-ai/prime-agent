import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signalProcessGroupOrProcess } from "../src/utils/child-process.js";

/**
 * A parent that spawns one long-lived child and records its pid, then waits.
 *
 * The child is `detached`, which is what makes this a real test of the tree
 * walk. Windows puts an ordinary child in a job object owned by its parent, so
 * it dies with the parent whether or not anything walks the tree; a detached
 * child leaves that job and survives a single-process kill. Detached
 * descendants are exactly what a crashed worker leaves behind.
 */
const PARENT_SCRIPT = `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
	detached: true,
	stdio: "ignore",
	windowsHide: true,
});
child.unref();
writeFileSync(process.argv[2], String(child.pid));
setInterval(() => {}, 1000);
`;

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but is not signalable by us — still alive.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return predicate();
}

/**
 * Windows only, because the contract differs by platform. A detached child
 * leaves its parent's process group on Unix too, so the group signal does not
 * reach it there either — that is the documented behavior of the Unix path and
 * this change does not touch it. On Windows the tree walk does reach it, which
 * is the whole point of the branch under test.
 */
describe.skipIf(process.platform !== "win32")("signalProcessGroupOrProcess on Windows", () => {
	const spawnedPids: number[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const pid of spawnedPids.splice(0)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already gone, which is the expected case.
			}
		}
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("terminates descendants, not just the named process", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-tree-kill-"));
		tempDirs.push(dir);
		const scriptPath = join(dir, "parent.cjs");
		const childPidPath = join(dir, "child.pid");
		writeFileSync(scriptPath, PARENT_SCRIPT);

		// Detached so the parent leads its own process group on Unix, which is what
		// the group signal needs. Windows has no groups and takes the tree walk.
		const parent = spawn(process.execPath, [scriptPath, childPidPath], {
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		});
		const parentPid = parent.pid;
		expect(parentPid).toBeTypeOf("number");
		if (parentPid === undefined) {
			throw new Error("parent did not start");
		}
		spawnedPids.push(parentPid);

		expect(
			await waitUntil(() => existsSync(childPidPath) && readFileSync(childPidPath, "utf8").length > 0, 15_000),
		).toBe(true);
		const childPid = Number(readFileSync(childPidPath, "utf8"));
		expect(Number.isInteger(childPid)).toBe(true);
		spawnedPids.push(childPid);
		expect(isAlive(childPid)).toBe(true);

		signalProcessGroupOrProcess(parentPid, "SIGKILL");

		expect(await waitUntil(() => !isAlive(parentPid), 15_000)).toBe(true);
		expect(await waitUntil(() => !isAlive(childPid), 15_000)).toBe(true);
	}, 60_000);
});
