import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type RlmSubagentDisplayEntry,
	readRlmSubagentDisplayEntry,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "../src/modes/daemon/rlm-subagent-display.js";

const renameBehavior = vi.hoisted(() => ({
	failuresRemaining: 0,
	errorCode: "EPERM" as string,
}));

vi.mock("node:fs", () => {
	const actual = require("node:fs");
	return {
		...actual,
		renameSync: (oldPath: string, newPath: string) => {
			if (renameBehavior.failuresRemaining > 0) {
				renameBehavior.failuresRemaining -= 1;
				const error = new Error(`simulated ${renameBehavior.errorCode} on rename`) as NodeJS.ErrnoException;
				error.code = renameBehavior.errorCode;
				throw error;
			}
			return actual.renameSync(oldPath, newPath);
		},
	};
});

let originalPlatform: string;
function stubWin32() {
	originalPlatform = process.platform;
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
}
function restorePlatform() {
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}

function makeEntry(sessionDir: string, overrides: Partial<RlmSubagentDisplayEntry> = {}): RlmSubagentDisplayEntry {
	return {
		type: "rlm_subagent",
		childId: "sub-1234abcd",
		sessionName: "worker",
		sessionDir,
		sessionFile: join(sessionDir, "01a0-child.jsonl"),
		rlmMaxDepth: 4,
		rlmParentNodeId: "sub-1234abcd",
		prompt: "do the work",
		spawnCode: "await rlm('do the work')",
		model: { provider: "test", modelId: "model" },
		status: "running",
		createdAt: 1,
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("rlm subagent display files: Windows rename resilience", () => {
	afterEach(() => {
		renameBehavior.failuresRemaining = 0;
		restorePlatform();
	});

	it("retries a transient Windows EPERM rename with bounded backoff and writes the entry", async () => {
		stubWin32();
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-retry-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			renameBehavior.failuresRemaining = 2;
			renameBehavior.errorCode = "EPERM";
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(makeEntry(sessionDir));
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries transient EBUSY and EACCES renames the same bounded way", async () => {
		stubWin32();
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-retry-busy-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			renameBehavior.failuresRemaining = 3;
			renameBehavior.errorCode = "EBUSY";
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(makeEntry(sessionDir));

			const sessionDir2 = join(tempDir, "sub-eacc");
			renameBehavior.failuresRemaining = 1;
			renameBehavior.errorCode = "EACCES";
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir2));
			await expect(readRlmSubagentDisplayEntry(sessionDir2)).resolves.toEqual(makeEntry(sessionDir2));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("fails closed when rename stays blocked, leaving the existing destination intact", async () => {
		stubWin32();
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-failclosed-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(makeEntry(sessionDir));

			renameBehavior.failuresRemaining = 100;
			renameBehavior.errorCode = "EPERM";
			expect(() =>
				writeRlmSubagentDisplayEntry(
					makeEntry(sessionDir, { status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" }),
				),
			).toThrow(/EPERM/);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(makeEntry(sessionDir));
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("propagates non-transient rename failures and cleans up the temp file", async () => {
		stubWin32();
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-nontransient-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			mkdirSync(sessionDir, { recursive: true });
			renameBehavior.failuresRemaining = 1;
			renameBehavior.errorCode = "ENOSPC";
			expect(() => writeRlmSubagentDisplayEntry(makeEntry(sessionDir))).toThrow(/ENOSPC/);
			expect(readdirSync(sessionDir)).toEqual([]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("rlm subagent display files: deletion lifecycle authority", () => {
	it("does not resurrect a deleted tombstone with a later running or completed write", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-tombstone-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const deleted = makeEntry(sessionDir, { status: "deleted", updatedAt: "2026-01-01T00:00:01.000Z" });
			writeRlmSubagentDisplayEntry(deleted);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ status: "deleted" });

			expect(
				writeRlmSubagentDisplayEntry(
					makeEntry(sessionDir, { status: "completed", updatedAt: "2026-01-01T00:00:02.000Z" }),
				),
			).toBe(false);
			expect(
				writeRlmSubagentDisplayEntry(
					makeEntry(sessionDir, { status: "running", updatedAt: "2026-01-01T00:00:03.000Z" }),
				),
			).toBe(false);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ status: "deleted" });
			expect(writeRlmSubagentDisplayEntry(deleted)).toBe(true);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({ status: "deleted" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("replaces malformed display metadata atomically", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-tombstone-torn-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status: "deleted" }));
			writeFileSync(rlmSubagentDisplayPath(sessionDir), "{torn json");
			expect(writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status: "completed" }))).toBe(true);
			const raw = readFileSync(rlmSubagentDisplayPath(sessionDir), "utf8");
			expect(raw).toContain('"status":"completed"');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
