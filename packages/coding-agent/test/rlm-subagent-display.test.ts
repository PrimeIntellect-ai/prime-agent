import type fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type RlmSubagentDisplayEntry,
	readRlmSubagentDisplayEntry,
	rlmSubagentDisplayPath,
	writeRlmSubagentDisplayEntry,
} from "../src/modes/daemon/rlm-subagent-display.js";

const { readDisplayFile, renameDisplayFile } = vi.hoisted(() => ({
	readDisplayFile: vi.fn(),
	renameDisplayFile: vi.fn(),
}));
const __fs = createRequire(import.meta.url)("node:fs") as typeof fs;
vi.mock("node:fs", () => {
	const actual = __fs;
	return {
		...actual,
		readFileSync: readDisplayFile.mockImplementation(actual.readFileSync),
		renameSync: renameDisplayFile.mockImplementation(actual.renameSync),
	};
});

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

describe("rlm subagent display files", () => {
	it("round-trips an entry and replaces it atomically without temp-file residue", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			writeRlmSubagentDisplayEntry(entry);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);

			const updated = makeEntry(sessionDir, { status: "deleted", updatedAt: "2026-01-01T00:00:01.000Z" });
			writeRlmSubagentDisplayEntry(updated);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(updated);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps deletion authoritative over late running and completion writes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-deleted-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const deleted = makeEntry(sessionDir, { status: "deleted" });
			expect(writeRlmSubagentDisplayEntry(deleted)).toBe(true);
			for (const status of ["running", "completed"] as const) {
				expect(writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status }))).toBe(false);
				await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(deleted);
			}
			expect(writeRlmSubagentDisplayEntry(deleted)).toBe(true);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["EBUSY", "EPERM", "EACCES"])("preserves unreadable tombstones on %s", (code) => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-unreadable-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status: "deleted" }));
			const path = rlmSubagentDisplayPath(sessionDir);
			const contents = readFileSync(path, "utf8");
			for (const status of ["running", "completed"] as const) {
				const failure = Object.assign(new Error("display read blocked"), { code });
				readDisplayFile.mockImplementationOnce(() => {
					throw failure;
				});
				expect(() => writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status }))).toThrow(failure);
				expect(readFileSync(path, "utf8")).toBe(contents);
				expect(writeRlmSubagentDisplayEntry(makeEntry(sessionDir, { status }))).toBe(false);
			}
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves failed deletion writes intact and allows an explicit retry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-delete-retry-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const running = makeEntry(sessionDir);
			const deleted = makeEntry(sessionDir, { status: "deleted" });
			writeRlmSubagentDisplayEntry(running);
			const failure = Object.assign(new Error("rename failed"), { code: "EIO" });
			renameDisplayFile.mockImplementationOnce(() => {
				throw failure;
			});
			expect(() => writeRlmSubagentDisplayEntry(deleted)).toThrow(failure);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(running);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
			expect(writeRlmSubagentDisplayEntry(deleted)).toBe(true);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(deleted);
			expect(writeRlmSubagentDisplayEntry(running)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("replaces malformed display metadata without temp-file residue", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-repair-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			mkdirSync(sessionDir);
			writeFileSync(rlmSubagentDisplayPath(sessionDir), "{torn json");
			const entry = makeEntry(sessionDir, { status: "completed" });
			expect(writeRlmSubagentDisplayEntry(entry)).toBe(true);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toEqual(entry);
			expect(readdirSync(sessionDir)).toEqual(["rlm-subagent.json"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reads tolerantly: missing, malformed, and invalid files are undefined", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-tolerant-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), "{not json");
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ type: "rlm_subagent", childId: 42 }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();

			writeFileSync(
				rlmSubagentDisplayPath(sessionDir),
				JSON.stringify(makeEntry(sessionDir, { status: "exploded" as RlmSubagentDisplayEntry["status"] })),
			);
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("accepts unknown extra fields from newer writers", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-rlm-display-forward-"));
		try {
			const sessionDir = join(tempDir, "sub-1234abcd");
			const entry = makeEntry(sessionDir);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(rlmSubagentDisplayPath(sessionDir), JSON.stringify({ ...entry, futureField: true }));
			await expect(readRlmSubagentDisplayEntry(sessionDir)).resolves.toMatchObject({
				childId: entry.childId,
				status: "running",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
