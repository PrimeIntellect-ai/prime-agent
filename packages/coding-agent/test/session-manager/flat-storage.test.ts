import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSessionInfo, SessionManager } from "../../src/core/session-manager.js";
import { resolveSessionPath, SessionSelectorNotFoundError } from "../../src/core/session-resolver.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager flat storage", () => {
	it("stores sessions directly in the session root and filters current-cwd lists", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-flat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const cwdA = join(tempDir, "project-a");
			const cwdB = join(tempDir, "project-b");
			const sessionA = createPersistedSession(cwdA, sessionDir, "a");
			const sessionB = createPersistedSession(cwdB, sessionDir, "b");

			const files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
			expect(files).toHaveLength(2);
			expect(files.some((file) => file.startsWith("--"))).toBe(false);
			expect(new Set(files)).toEqual(
				new Set([`${sessionA.getSessionId()}.jsonl`, `${sessionB.getSessionId()}.jsonl`]),
			);

			const currentSessions = await SessionManager.list(cwdA, sessionDir);
			expect(currentSessions.map((session) => session.id)).toEqual([sessionA.getSessionId()]);

			const allSessions = await SessionManager.listAll(undefined, sessionDir);
			expect(new Set(allSessions.map((session) => session.id))).toEqual(
				new Set([sessionA.getSessionId(), sessionB.getSessionId()]),
			);

			const continued = SessionManager.continueRecent(cwdA, sessionDir);
			expect(continued.getSessionId()).toBe(sessionA.getSessionId());

			expect(sessionA.getSessionArtifactDir()).toBe(join(tempDir, "session-artifacts", sessionA.getSessionId()));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists sessions without loading large message bodies into search text", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-list-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const cwd = join(tempDir, "project");
			const session = SessionManager.create(cwd, sessionDir);
			session.appendSessionInfo("large history");
			session.appendSessionState({ status: "active" });
			session.appendMessage(userMsg("small prompt"));
			session.appendMessage(assistantMsg("x".repeat(2 * 1024 * 1024)));

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].id).toBe(session.getSessionId());
			expect(sessions[0].name).toBe("large history");
			expect(sessions[0].state).toEqual({ status: "active" });
			expect(sessions[0].messageCount).toBe(2);
			expect(sessions[0].firstMessage).toBe("small prompt");
			expect(sessions[0].allMessagesText).toBe("small prompt");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves list metadata from oversized user message rows", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-user-list-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionFile = join(sessionDir, "large-user.jsonl");
			const largeText = "y".repeat(2 * 1024 * 1024);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "large-user",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: join(tempDir, "project"),
				})}\n${JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-02T00:00:00.000Z",
					message: {
						role: "user",
						content: largeText,
						timestamp: 1,
					},
				})}\n`,
			);

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].messageCount).toBe(1);
			expect(sessions[0].firstMessage).toBe("y".repeat(256));
			expect(sessions[0].allMessagesText).toBe("");
			expect(sessions[0].modified.toISOString()).toBe("2026-01-02T00:00:00.000Z");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hides event-only sessions from listings but keeps them resolvable by ID", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-event-only-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const cwd = join(tempDir, "project");
			const otherCwd = join(tempDir, "elsewhere");
			const hiddenFile = writeRawSession(sessionDir, "ee0000ff1111", cwd, [
				sessionStateEntry("state-1"),
				messageEntry({ role: "toolResult", content: "tool output" }),
			]);
			writeRawSession(sessionDir, "aaa111bbb222", cwd, [messageEntry({ role: "user", content: "hello" })]);
			writeRawSession(sessionDir, "ccc333ddd444", cwd, [messageEntry({ role: "assistant", content: "hi" })]);

			const listedFromCallback: string[] = [];
			const allSessions = await SessionManager.listAll(
				{ onSession: (session) => listedFromCallback.push(session.id) },
				sessionDir,
			);
			expect(new Set(allSessions.map((session) => session.id))).toEqual(new Set(["aaa111bbb222", "ccc333ddd444"]));
			expect(listedFromCallback.sort()).toEqual(["aaa111bbb222", "ccc333ddd444"]);

			const localListed: string[] = [];
			const localSessions = await SessionManager.list(cwd, sessionDir, {
				onSession: (session) => localListed.push(session.id),
			});
			expect(localSessions.map((session) => session.id).sort()).toEqual(["aaa111bbb222", "ccc333ddd444"]);
			expect(localListed.sort()).toEqual(["aaa111bbb222", "ccc333ddd444"]);

			const hiddenInfo = await readSessionInfo(hiddenFile);
			expect(hiddenInfo?.id).toBe("ee0000ff1111");
			expect(hiddenInfo?.conversationMessageCount).toBe(0);

			expect(await resolveSessionPath("ee0000ff1111", cwd, sessionDir)).toEqual({
				type: "local",
				path: hiddenFile,
			});
			expect(await resolveSessionPath("ee0000ff1111", otherCwd, sessionDir)).toEqual({
				type: "global",
				path: hiddenFile,
				cwd,
			});
			expect(await resolveSessionPath("ee00", cwd, sessionDir)).toEqual({ type: "local", path: hiddenFile });

			unlinkSync(hiddenFile);
			expect(existsSync(hiddenFile)).toBe(false);
			expect(await readSessionInfo(hiddenFile)).toBeNull();
			const remaining = await SessionManager.listAll(undefined, sessionDir);
			expect(new Set(remaining.map((session) => session.id))).toEqual(new Set(["aaa111bbb222", "ccc333ddd444"]));
			await expect(resolveSessionPath("ee0000ff1111", cwd, sessionDir)).rejects.toBeInstanceOf(
				SessionSelectorNotFoundError,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("counts oversized user and assistant rows as conversation messages and oversized tool results as none", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-oversized-conv-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const cwd = join(tempDir, "project");
			const largeText = "z".repeat(2 * 1024 * 1024);
			const userFile = writeRawSession(sessionDir, "uu1111aa2233", cwd, [
				messageEntry({ role: "user", content: largeText, timestamp: 1 }),
			]);
			const assistantFile = writeRawSession(sessionDir, "as4444bb5566", cwd, [
				messageEntry({ role: "assistant", content: largeText, timestamp: 2 }),
			]);
			const toolFile = writeRawSession(sessionDir, "tt7777cc8899", cwd, [
				messageEntry({ role: "toolResult", content: largeText }),
			]);

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(new Set(sessions.map((session) => session.id))).toEqual(new Set(["uu1111aa2233", "as4444bb5566"]));

			const userInfo = await readSessionInfo(userFile);
			expect(userInfo?.messageCount).toBe(1);
			expect(userInfo?.conversationMessageCount).toBe(1);
			const assistantInfo = await readSessionInfo(assistantFile);
			expect(assistantInfo?.messageCount).toBe(1);
			expect(assistantInfo?.conversationMessageCount).toBe(1);
			const toolInfo = await readSessionInfo(toolFile);
			expect(toolInfo?.messageCount).toBe(1);
			expect(toolInfo?.conversationMessageCount).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores oversized non-conversation rows when computing modified time", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-large-tool-list-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });
			const sessionFile = join(sessionDir, "large-tool.jsonl");
			const largeText = "z".repeat(2 * 1024 * 1024);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({
					type: "session",
					id: "large-tool",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: join(tempDir, "project"),
				})}\n${JSON.stringify({
					type: "message",
					id: "message-1",
					parentId: null,
					timestamp: "2026-01-02T00:00:00.000Z",
					message: {
						role: "user",
						content: "small prompt",
					},
				})}\n${JSON.stringify({
					type: "message",
					id: "message-2",
					parentId: "message-1",
					timestamp: "2026-01-03T00:00:00.000Z",
					message: {
						role: "toolResult",
						content: largeText,
					},
				})}\n`,
			);

			const sessions = await SessionManager.listAll(undefined, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0].messageCount).toBe(2);
			expect(sessions[0].firstMessage).toBe("small prompt");
			expect(sessions[0].allMessagesText).toBe("small prompt");
			expect(sessions[0].modified.toISOString()).toBe("2026-01-02T00:00:00.000Z");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

function writeRawSession(sessionDir: string, id: string, cwd: string, entries: object[]): string {
	const lines = [
		JSON.stringify({
			type: "session",
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		}),
		...entries.map((entry) => JSON.stringify(entry)),
	];
	const file = join(sessionDir, `${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

function messageEntry(options: { role: string; content: string; timestamp?: number }): object {
	return {
		type: "message",
		id: `message-${messageEntryCounter++}`,
		parentId: null,
		timestamp: "2026-01-02T00:00:00.000Z",
		message: options,
	};
}

let messageEntryCounter = 1;

function sessionStateEntry(id: string): object {
	return {
		type: "session_state",
		id,
		parentId: null,
		timestamp: "2026-01-02T00:00:00.000Z",
		state: { status: "active" },
	};
}

function createPersistedSession(cwd: string, sessionDir: string, text: string): SessionManager {
	const session = SessionManager.create(cwd, sessionDir);
	session.appendMessage(userMsg(text));
	session.appendMessage(assistantMsg(text));
	return session;
}
