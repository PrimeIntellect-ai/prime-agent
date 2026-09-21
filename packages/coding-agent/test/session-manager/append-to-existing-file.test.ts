import { type appendFileSync, mkdtempSync, type readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type AppendFileSync = typeof appendFileSync;
type ReadFileSync = typeof readFileSync;

const fsMocks = vi.hoisted(() => ({ appendFileSync: vi.fn<AppendFileSync>(), readFileSync: vi.fn<ReadFileSync>() }));

// Passthrough spies: real fs behavior everywhere, with call counts on the two calls that tell a full parse (readFileSync) from an append.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
	fsMocks.readFileSync.mockImplementation(actual.readFileSync);
	return { ...actual, appendFileSync: fsMocks.appendFileSync, readFileSync: fsMocks.readFileSync };
});

import { appendCustomMessageToExistingFile, appendSessionInfoToExistingFile } from "../../src/core/session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix = "pi-session-append-"): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Header plus a chained user-message transcript, shaped like a real session file. */
function sessionLines(dir: string, options: { entries?: number; textBytes?: number } = {}): string[] {
	const count = options.entries ?? 4;
	const lines = [
		JSON.stringify({
			type: "session",
			version: 3,
			id: "fixture-session",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: dir,
		}),
	];
	let parentId: string | null = null;
	for (let i = 0; i < count; i++) {
		const id = `e${i}`;
		const timestamp = 1_767_225_600_000 + i;
		const text = options.textBytes !== undefined && i === count - 1 ? "x".repeat(options.textBytes) : `payload ${i}`;
		lines.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content: text, timestamp },
			}),
		);
		parentId = id;
	}
	return lines;
}

function writeSession(dir: string, name: string, lines: string[], terminate = true): string {
	const file = join(dir, name);
	writeFileSync(file, lines.join("\n") + (terminate ? "\n" : ""));
	return file;
}

function resetIo(): void {
	fsMocks.appendFileSync.mockClear();
	fsMocks.readFileSync.mockClear();
}

function rawFile(file: string): Buffer {
	return fsMocks.readFileSync(file) as unknown as Buffer;
}

/** The bytes appended to `file` since `before`, parsed as JSON. */
function appended(before: Buffer, file: string): Record<string, unknown> {
	const bytes = rawFile(file).subarray(before.length).toString("utf8");
	expect(bytes.endsWith("\n")).toBe(true);
	return JSON.parse(bytes.trim());
}

describe("append metadata to an existing session file", () => {
	it("appends a rename line without reading or parsing the whole transcript", () => {
		const dir = tempDir();
		const file = writeSession(dir, "rename-fast.jsonl", sessionLines(dir, { entries: 18_000 }));
		const before = rawFile(file);
		expect(before.length).toBeGreaterThan(1_000_000); // big enough that a full parse would show

		resetIo();
		appendSessionInfoToExistingFile(file, "  Renamed  ");

		expect(fsMocks.readFileSync).not.toHaveBeenCalled(); // no full-file read or parse
		expect(fsMocks.appendFileSync).toHaveBeenCalledTimes(1); // exactly one appended line
		expect(appended(before, file)).toMatchObject({ type: "session_info", name: "Renamed", parentId: "e17999" });
	});

	it("falls back to a full open whenever only a full open can place the entry", () => {
		// A v1 file: the open migrates it and assigns the ids an appended parentId chains to.
		const dir = tempDir();
		const file = writeSession(dir, "v1.jsonl", [
			JSON.stringify({ type: "session", id: "legacy", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir }),
			...sessionLines(dir, { entries: 2 }),
		]);
		resetIo();
		appendSessionInfoToExistingFile(file, "Renamed");
		expect(fsMocks.readFileSync).toHaveBeenCalled(); // the full open parsed the transcript
		const lines = rawFile(file).toString("utf8").trimEnd().split("\n");
		expect(JSON.parse(lines.at(-1)!)).toMatchObject({ type: "session_info", name: "Renamed" });
		expect(JSON.parse(lines[0]!).version).toBe(3); // the migration rewrote what it read

		// An oversized tail with no assistant entry: the window cannot resolve the leaf, and the fallback's live manager suppresses the notice.
		const noticeFile = writeSession(
			dir,
			"fallback-notice.jsonl",
			sessionLines(dir, { entries: 3, textBytes: 300_000 }),
		);
		const noticeBefore = rawFile(noticeFile);
		resetIo();
		appendCustomMessageToExistingFile(noticeFile, "prime-agent.worker_recovery", "worker interrupted", false, {
			activeSessionId: "active-1",
		});
		expect(fsMocks.readFileSync).toHaveBeenCalled(); // the tail window could not resolve the leaf
		expect(fsMocks.appendFileSync).not.toHaveBeenCalled();
		expect(rawFile(noticeFile).equals(noticeBefore)).toBe(true);
	});

	it("fails cleanly instead of recreating a missing or header-invalid session file", () => {
		const dir = tempDir();
		// No session header at all: the leading line is malformed and the rest are entries.
		const invalid = writeSession(dir, "invalid.jsonl", [
			"not json at all",
			...sessionLines(dir, { entries: 2 }).slice(1),
		]);
		const contents = rawFile(invalid).toString("utf8");

		resetIo();
		expect(() => appendSessionInfoToExistingFile(join(dir, "missing.jsonl"), "Renamed")).toThrow(
			/missing session file/,
		);
		expect(() => appendSessionInfoToExistingFile(invalid, "Renamed")).toThrow(/no valid session header/);
		expect(fsMocks.appendFileSync).not.toHaveBeenCalled(); // nothing created, appended, or rewritten
		expect(rawFile(invalid).toString("utf8")).toBe(contents);
	});
});
