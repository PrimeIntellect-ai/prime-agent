import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { createActiveSessionId, resolveActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { resolveDaemonSessionPath } from "../src/modes/daemon/daemon-mode.js";
import { formatSessionDisplayId, matchesSessionIdSuffix } from "../src/modes/daemon/daemon-session-id.js";

describe("formatSessionDisplayId", () => {
	it("compacts uuid-like session ids to the last 12 hex characters", () => {
		expect(formatSessionDisplayId("019e71ec-e08a-75a9-b573-fc10e9f8380f")).toBe("fc10e9f8380f");
	});

	it("leaves shorter active session ids unchanged", () => {
		expect(formatSessionDisplayId("1bce5c72")).toBe("1bce5c72");
	});
});

describe("matchesSessionIdSuffix", () => {
	it("matches suffixes with or without hyphens", () => {
		const sessionId = "019e71ec-e08a-75a9-b573-fc10e9f8380f";

		expect(matchesSessionIdSuffix(sessionId, "fc10e9f8380f")).toBe(true);
		expect(matchesSessionIdSuffix(sessionId, "e9-f8380f")).toBe(true);
	});
});

describe("resolveActiveSessionState", () => {
	it("retries generated active session ids that already exist", () => {
		const generatedIds: string[] = [];
		const existingIds = {
			has: (activeSessionId: string) => {
				generatedIds.push(activeSessionId);
				return generatedIds.length === 1;
			},
		};

		const activeSessionId = createActiveSessionId(existingIds);

		expect(generatedIds).toHaveLength(2);
		expect(activeSessionId).toBe(generatedIds[1]);
	});

	it("resolves unique active session id and session id suffixes", () => {
		const first = makeState("aaaabbbbcccc", "019e71ec-e08a-75a9-b573-fc10e9f8380f");
		const second = makeState("dddd11112222", "029e71ec-e08a-75a9-b573-abcdef123456");
		const sessions = makeSessionMap([first, second]);

		expect(resolveActiveSessionState(sessions, "bbbbcccc")).toBe(first);
		expect(resolveActiveSessionState(sessions, "fc10e9f8380f")).toBe(first);
	});

	it("raises when a suffix matches multiple active sessions", () => {
		const sessions = makeSessionMap([
			makeState("1bce5c72", "019e71ec-e08a-75a9-b573-fc10e9f8380f"),
			makeState("3f9caff0", "029e71ec-f08a-75a9-b573-fc10e9f8380f"),
		]);

		expect(() => resolveActiveSessionState(sessions, "e9f8380f")).toThrow(/Ambiguous active session "e9f8380f"/);
	});
});

describe("resolveDaemonSessionPath", () => {
	it("raises when a saved session prefix matches multiple sessions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-id-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			createSavedSession(cwd, sessionDir, "abc111");
			createSavedSession(cwd, sessionDir, "abc222");

			await expect(resolveDaemonSessionPath("abc", cwd, sessionDir)).rejects.toThrow(
				/Ambiguous saved session "abc"/,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves the normalized suffix shown by the session list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-id-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const sessionId = "019e71ec-e08a-75a9-b573-aaaaaaaaaaaa";
			const sessionPath = createSavedSession(cwd, sessionDir, sessionId);

			await expect(resolveDaemonSessionPath("AAAAAA-AAAAAA", cwd, sessionDir)).resolves.toBe(sessionPath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("raises when a saved session suffix matches multiple sessions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-id-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			createSavedSession(cwd, sessionDir, "019e71ec-e08a-75a9-b573-aaaaaaaaaaaa");
			createSavedSession(cwd, sessionDir, "029e71ec-e08a-75a9-b573-aaaaaaaaaaaa");

			await expect(resolveDaemonSessionPath("aaaaaaaaaaaa", cwd, sessionDir)).rejects.toThrow(
				/Ambiguous saved session "aaaaaaaaaaaa"/,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers an exact normalized ID over prefix and suffix matches", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-id-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const exactPath = createSavedSession(cwd, sessionDir, "abcd");
			createSavedSession(cwd, sessionDir, "abcd1");
			createSavedSession(cwd, sessionDir, "1abcd");

			await expect(resolveDaemonSessionPath("AB-CD", cwd, sessionDir)).resolves.toBe(exactPath);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

function makeSessionMap(states: ActiveSessionState[]): Map<string, ActiveSessionState> {
	return new Map(states.map((state) => [state.activeSessionId, state]));
}

function makeState(activeSessionId: string, sessionId: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		runtime: {
			session: {
				sessionId,
				sessionName: undefined,
			},
		},
	} as unknown as ActiveSessionState;
}

function createSavedSession(cwd: string, sessionDir: string, sessionId: string): string {
	const session = SessionManager.create(cwd, sessionDir);
	session.newSession({ id: sessionId });
	session.appendSessionState({ status: "archived" });
	return session.getSessionFile()!;
}
