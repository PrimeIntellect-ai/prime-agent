import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	listSavedSessionSiblings,
	markSessionInterrupted,
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

const catalogTempDirs: string[] = [];

afterEach(() => {
	for (const directory of catalogTempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createCatalogFixtureSession(): { sessionFile: string } {
	const root = mkdtempSync(join(tmpdir(), "prime-catalog-mark-interrupted-"));
	catalogTempDirs.push(root);
	const sessionDir = join(root, "sessions");
	const session = SessionManager.create(root, sessionDir);
	session.appendMessage({ role: "user", content: "run tools", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "calling" },
			{ type: "toolCall", id: "bash-1", name: "bash", arguments: {} },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	});
	const sessionFile = session.getSessionFile();
	if (!sessionFile) {
		throw new Error("Fixture session did not persist");
	}
	return { sessionFile };
}

describe("daemon catalog mark_interrupted", () => {
	it("persists synthetic tool results before the worker recovery marker", () => {
		const { sessionFile } = createCatalogFixtureSession();

		markSessionInterrupted(sessionFile, "active-1", ["tool_execution"]);

		const reopened = SessionManager.open(sessionFile);
		const context = reopened.buildSessionContext().messages;
		expect(context.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
		expect(context[1]).toMatchObject({
			role: "assistant",
			content: [
				{ type: "text", text: "calling" },
				{ type: "toolCall", id: "bash-1", name: "bash" },
			],
		});
		expect(context[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: true,
		});
		expect(context[3]).toMatchObject({
			role: "custom",
			customType: "prime-agent.worker_recovery",
			details: { activeSessionId: "active-1", operations: ["tool_execution"] },
		});
	});

	it("appends an isError toolResult preserving the interrupted tool identity", () => {
		const { sessionFile } = createCatalogFixtureSession();

		markSessionInterrupted(sessionFile, "active-1", ["tool_execution"]);

		const toolResults = readPersistedToolResults(sessionFile);
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0]).toMatchObject({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: true,
		});
		const text = (toolResults[0]!.content[0] as { text: string }).text;
		expect(text).toContain("whether the tool executed");
		expect(text).toContain("external side effects are unknown");
		expect(text).toContain("was not replayed by recovery");
		expect(text).toContain("Inspect external side effects before retrying");
	});

	it("persists neither a synthetic result nor a marker when closing tool calls cannot persist", () => {
		const { sessionFile } = createCatalogFixtureSession();
		const spy = vi.spyOn(SessionManager.prototype, "appendMessageWithRollback").mockImplementation(() => {
			throw new Error("disk full");
		});
		try {
			expect(() => markSessionInterrupted(sessionFile, "active-1", ["tool_execution"])).toThrow("disk full");
		} finally {
			spy.mockRestore();
		}
		const contents = readFileSync(sessionFile, "utf8");
		expect(contents).not.toContain("prime-agent.worker_recovery");
		expect(contents).not.toContain("toolResult");
		expect(contents).not.toContain("unknown");
	});

	it("resumes partial persistence: a failed marker append keeps the result, retry adds only the marker", () => {
		const { sessionFile } = createCatalogFixtureSession();
		const spy = vi
			.spyOn(SessionManager.prototype, "appendCustomMessageEntryWithRollback")
			.mockImplementationOnce(() => {
				throw new Error("marker write failed");
			});
		try {
			expect(() => markSessionInterrupted(sessionFile, "active-1", ["tool_execution"])).toThrow(
				"marker write failed",
			);
		} finally {
			spy.mockRestore();
		}

		// The synthetic result was persisted before the marker append failed.
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(readFileSync(sessionFile, "utf8")).not.toContain("prime-agent.worker_recovery");

		// Retrying recovery is resumable: no duplicate result, marker appended once.
		markSessionInterrupted(sessionFile, "active-1", ["tool_execution"]);
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		const reopened = SessionManager.open(sessionFile);
		const context = reopened.buildSessionContext().messages;
		expect(context.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
		expect(context[3]).toMatchObject({
			role: "custom",
			customType: "prime-agent.worker_recovery",
			details: { activeSessionId: "active-1", operations: ["tool_execution"] },
		});
	});
});

function readPersistedToolResults(sessionFile: string): ToolResultMessage[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; message?: unknown })
		.filter((entry) => entry.type === "message")
		.map((entry) => entry.message as ToolResultMessage)
		.filter((message) => message.role === "toolResult");
}
