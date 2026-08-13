import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	DAEMON_CATALOG_START_TIMEOUT_MS,
	listSavedSessionSiblings,
	resolveCatalogSessionMatch,
} from "../src/modes/daemon/daemon-catalog-process.js";

function session(id: string, name: string | undefined, path: string): SessionInfo {
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

describe("daemon catalog process", () => {
	it("allows a cold catalog more than five seconds to become ready", () => {
		expect(DAEMON_CATALOG_START_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
	});
});

describe("daemon catalog selector resolution", () => {
	it("reads only a saved child's persisted sibling set", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const first = SessionManager.create(root, join(root, "first"));
		first.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const second = SessionManager.create(root, join(root, "second"));
		second.newSession({ parentSession: parent.getSessionFile(), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("resolves relative parent headers from each child session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-catalog-relative-siblings-"));
		const sessionDir = join(root, "sessions");
		const parent = SessionManager.create(root, sessionDir);
		parent.newSession();
		parent.appendSessionInfo("parent");
		const parentFile = parent.getSessionFile()!;
		const firstDir = join(root, "first");
		const first = SessionManager.create(root, firstDir);
		first.newSession({ parentSession: relative(firstDir, parentFile), rlmDepth: 1 });
		first.appendSessionInfo("first");
		const secondDir = join(root, "second");
		const second = SessionManager.create(root, secondDir);
		second.newSession({ parentSession: relative(secondDir, parentFile), rlmDepth: 1 });
		second.appendSessionInfo("second");
		const registry = join(dirname(sessionDir), "session-artifacts", parent.getSessionId(), "rlm-subagents.jsonl");
		mkdirSync(dirname(registry), { recursive: true });
		writeFileSync(
			registry,
			[
				{ type: "rlm_subagent", childId: "first", sessionFile: first.getSessionFile(), status: "completed" },
				{ type: "rlm_subagent", childId: "second", sessionFile: second.getSessionFile(), status: "completed" },
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n"),
		);

		await expect(listSavedSessionSiblings(first.getSessionFile()!)).resolves.toEqual([
			expect.objectContaining({ id: first.getSessionId(), name: "first" }),
			expect.objectContaining({ id: second.getSessionId(), name: "second" }),
		]);
	});

	it("treats an exact name colliding with another session id prefix as ambiguous", () => {
		const sessions = [
			session("named-session-id", "target", "/tmp/by-name.jsonl"),
			session("target-prefix-id", "other", "/tmp/by-prefix.jsonl"),
		];

		expect(() => resolveCatalogSessionMatch(sessions, "target")).toThrow('Ambiguous session selector "target"');
	});
});
