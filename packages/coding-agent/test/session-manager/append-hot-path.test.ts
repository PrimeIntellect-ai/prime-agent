import {
	type appendFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	type writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type AppendFileSync = typeof appendFileSync;
type WriteSync = typeof writeSync;

const fsMocks = vi.hoisted(() => ({
	actualWriteSync: undefined as WriteSync | undefined,
	appendFileSync: vi.fn<AppendFileSync>(),
	writeSync: vi.fn<WriteSync>(),
}));

// Passthrough spies: real fs behavior everywhere, per-call interception for
// tests that pin write behavior (append call counting, short write counts).
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	fsMocks.actualWriteSync = actual.writeSync;
	fsMocks.appendFileSync.mockImplementation(actual.appendFileSync);
	fsMocks.writeSync.mockImplementation(actual.writeSync);
	return { ...actual, appendFileSync: fsMocks.appendFileSync, writeSync: fsMocks.writeSync };
});

import { loadEntriesFromFile, SessionManager } from "../../src/core/session-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-manager-append-"));
	tempDirs.push(dir);
	return dir;
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "openai-completions",
		provider: "openai",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function readLines(file: string): string[] {
	return readFileSync(file, "utf8").trim().split("\n");
}

describe("SessionManager append hot path", () => {
	it("suppresses pre-assistant appends and writes the full history on the first assistant message", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));

		mgr.appendMessage(userMsg("one"));
		mgr.appendCustomEntry("thread_goal_state", { active: true });

		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(false);

		mgr.appendMessage(assistantMsg("hi"));
		expect(existsSync(file)).toBe(true);

		const lines = readLines(file);
		expect(lines).toHaveLength(4); // header + user + custom + assistant
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[1]!).message.role).toBe("user");
		expect(JSON.parse(lines[2]!).customType).toBe("thread_goal_state");
		expect(JSON.parse(lines[3]!).message.role).toBe("assistant");
	});

	it("persists session_state before any assistant message while suppressing message appends", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));

		mgr.appendMessage(userMsg("one"));
		mgr.appendSessionState({ status: "archived" });
		const file = mgr.getSessionFile()!;
		expect(existsSync(file)).toBe(true);
		expect(readLines(file)).toHaveLength(3); // header + user + session_state

		mgr.appendMessage(userMsg("two"));
		expect(readLines(file)).toHaveLength(3); // still suppressed

		mgr.appendMessage(assistantMsg("hi"));
		const lines = readLines(file);
		expect(lines).toHaveLength(5); // full rewrite, in memory order
		expect(JSON.parse(lines[3]!).message.role).toBe("user");
		expect(JSON.parse(lines[4]!).message.role).toBe("assistant");
	});

	it("recomputes the guard flag when reopening an existing session file", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(assistantMsg("hi"));
		const file = mgr.getSessionFile()!;
		expect(readLines(file)).toHaveLength(2);

		const reopened = SessionManager.open(file);
		reopened.appendMessage(userMsg("after reopen"));

		// The reopened session must append (guard armed from the loaded
		// entries), not suppress: the file grows by exactly one line.
		const lines = readLines(file);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]!).type).toBe("session");
		expect(JSON.parse(lines[2]!).message.role).toBe("user");
	});

	it("re-arms the guard when branching to a path without an assistant message", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		const userId = mgr.appendMessage(userMsg("one"));
		mgr.appendMessage(assistantMsg("hi"));
		mgr.appendMessage(userMsg("three"));

		mgr.createBranchedSession(userId);
		const branchedFile = mgr.getSessionFile()!;
		expect(existsSync(branchedFile)).toBe(false); // no assistant on the branch path

		mgr.appendMessage(userMsg("post-branch"));
		expect(existsSync(branchedFile)).toBe(false); // guard re-armed: suppressed

		mgr.appendMessage(assistantMsg("first reply"));
		const lines = readLines(branchedFile);
		expect(lines).toHaveLength(4); // header + user + suppressed user + assistant
		expect(JSON.parse(lines[1]!).message.role).toBe("user");
		expect(JSON.parse(lines[3]!).message.role).toBe("assistant");
	});

	it("keeps appending after a rolled-back custom append when an assistant message exists", () => {
		const dir = createTempDir();
		const mgr = SessionManager.create(dir, join(dir, "sessions"));
		mgr.appendMessage(assistantMsg("hi"));
		const file = mgr.getSessionFile()!;
		expect(readLines(file)).toHaveLength(2);

		const internals = mgr as unknown as { _persist(entry: unknown): void };
		const originalPersist = internals._persist.bind(mgr);
		internals._persist = () => {
			throw new Error("append failed");
		};
		expect(() => mgr.appendCustomMessageEntryWithRollback("test.outcome", "details", false)).toThrow("append failed");
		internals._persist = originalPersist;

		// The rollback popped the failed custom entry and repaired the file;
		// the cached guard flag must still hold, so this message persists.
		mgr.appendMessage(userMsg("after rollback"));
		const lines = readLines(file);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[2]!).message.role).toBe("user");
	});

	it("forks a session through a single write descriptor", () => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({ type: "session", version: 3, id: "src", timestamp: "t", cwd: dir }),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				JSON.stringify({
					type: "git_state",
					id: "g1",
					parentId: "m1",
					timestamp: "t",
					git: { commit: "sourcesha", branch: "main" },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "g1",
					timestamp: "t",
					message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		fsMocks.appendFileSync.mockClear();
		const forked = SessionManager.forkFrom(sourcePath, dir, dir);
		expect(fsMocks.appendFileSync).not.toHaveBeenCalled();

		const entries = forked.getEntries();
		expect(entries.filter((e) => e.type === "git_state")).toHaveLength(0);
		expect(entries.find((e) => e.id === "m2")?.parentId).toBe("m1");
		expect(entries).toHaveLength(2);
		expect(loadEntriesFromFile(forked.getSessionFile()!).find((e) => e.type === "git_state")).toBeUndefined();
	});

	it("completes the fork when writeSync returns short counts", () => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({ type: "session", version: 3, id: "src", timestamp: "t", cwd: dir }),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "t",
					message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		// Inject a starving descriptor: at most 3 bytes land per buffer writeSync
		// call (one byte for the string form). The fork must loop until every
		// JSONL line is whole on disk instead of leaving a torn file that the
		// next reopen would treat as corrupt.
		let shortCounts = 0;
		const shortWrite = ((fd: number, data: Buffer | string, offset?: number, length?: number) => {
			if (typeof data === "string") {
				if (data.length > 1) shortCounts++;
				return fsMocks.actualWriteSync!(fd, data.slice(0, 1) as never);
			}
			const requested = length ?? data.byteLength - (offset ?? 0);
			const landed = Math.min(requested, 3);
			if (landed < requested) shortCounts++;
			return fsMocks.actualWriteSync!(fd, data, offset, landed);
		}) as unknown as WriteSync;
		fsMocks.writeSync.mockImplementation(shortWrite);
		try {
			const forked = SessionManager.forkFrom(sourcePath, dir, dir);
			const file = forked.getSessionFile()!;
			expect(shortCounts).toBeGreaterThan(0); // the mock really forced partial writes

			const lines = readLines(file);
			expect(lines).toHaveLength(3); // header + both messages, nothing torn
			expect(JSON.parse(lines[0]!).type).toBe("session");
			expect(JSON.parse(lines[1]!).message.role).toBe("user");
			expect(JSON.parse(lines[2]!).message.role).toBe("assistant");
			// A fresh reopen must load the completed fork intact (not repair it).
			const reopened = SessionManager.open(file);
			expect(reopened.getEntries().find((e) => e.id === "m2")?.parentId).toBe("m1");
		} finally {
			fsMocks.writeSync.mockImplementation(fsMocks.actualWriteSync!);
		}
	});

	it("keeps a forked pre-assistant session suppressed until its first assistant message", () => {
		const dir = createTempDir();
		const sourcePath = join(dir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({ type: "session", version: 3, id: "src", timestamp: "t", cwd: dir }),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "t",
					message: { role: "user", content: "hi", timestamp: 1 },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "t",
					message: { role: "user", content: "more", timestamp: 2 },
				}),
			].join("\n")}\n`,
		);

		const forked = SessionManager.forkFrom(sourcePath, dir, dir);
		const file = forked.getSessionFile()!;
		expect(readLines(file)).toHaveLength(3);

		forked.appendMessage(userMsg("post-fork"));
		expect(readLines(file)).toHaveLength(3); // guard armed from the forked entries

		forked.appendMessage(assistantMsg("hi"));
		const lines = readLines(file);
		expect(lines).toHaveLength(5);
		expect(JSON.parse(lines[4]!).message.role).toBe("assistant");
	});
});
