import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../src/core/session-manager.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { createActiveSessionId, resolveActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { resolveCatalogSessionMatch } from "../src/modes/daemon/daemon-catalog-process.js";
import { resolveDaemonSessionPath } from "../src/modes/daemon/daemon-mode.js";
import { matchesSessionIdSuffix } from "../src/modes/daemon/daemon-session-id.js";

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
	// Wrong resolution deletes or resumes the wrong session, so every selector shape is pinned here.
	it.each([
		{
			name: "raises when a prefix matches multiple saved sessions",
			ids: ["abc111", "abc222"],
			selector: "abc",
			expected: /Ambiguous saved session "abc"/,
		},
		{
			name: "raises when a suffix matches multiple saved sessions",
			ids: ["019e71ec-e08a-75a9-b573-aaaaaaaaaaaa", "029e71ec-e08a-75a9-b573-aaaaaaaaaaaa"],
			selector: "aaaaaaaaaaaa",
			expected: /Ambiguous saved session "aaaaaaaaaaaa"/,
		},
		{
			name: "resolves the normalized suffix shown by the session list",
			ids: ["019e71ec-e08a-75a9-b573-aaaaaaaaaaaa"],
			selector: "AAAAAA-AAAAAA",
			expected: 0,
		},
		{
			name: "prefers an exact normalized ID over prefix and suffix matches",
			ids: ["abcd", "abcd1", "1abcd"],
			selector: "AB-CD",
			expected: 0,
		},
	])("$name", async ({ ids, selector, expected }) => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-session-id-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const paths = ids.map((id) => createSavedSession(cwd, sessionDir, id));

			const resolving = resolveDaemonSessionPath(selector, cwd, sessionDir);
			if (typeof expected === "number") {
				await expect(resolving).resolves.toBe(paths[expected]);
			} else {
				await expect(resolving).rejects.toThrow(expected);
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("resolveCatalogSessionMatch", () => {
	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			catalogSession("named-session-id", "target", "/tmp/by-name.jsonl"),
			catalogSession("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
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

function catalogSession(id: string, name: string | undefined, path: string): SessionInfo {
	return {
		id,
		name,
		path,
		cwd: "/tmp/project",
		rlmDepth: 0,
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
	};
}
