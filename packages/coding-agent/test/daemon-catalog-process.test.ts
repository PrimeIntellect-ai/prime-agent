import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acquireSessionLease,
	canonicalSessionPath,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../src/core/session-lease.js";
import { type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import {
	type CatalogRecoveryAuthority,
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

function createCatalogFixtureSession(
	calls: Array<{ id: string; name: string }> = [{ id: "bash-1", name: "bash" }],
	operationId = randomUUID(),
): { sessionFile: string; authority: CatalogRecoveryAuthority; session: SessionManager } {
	const root = mkdtempSync(join(tmpdir(), "prime-catalog-mark-interrupted-"));
	catalogTempDirs.push(root);
	const sessionDir = join(root, "sessions");
	const session = SessionManager.create(root, sessionDir);
	session.appendMessage({ role: "user", content: "run tools", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		content: [
			{ type: "text", text: "calling" },
			...calls.map((call) => ({ type: "toolCall" as const, ...call, arguments: {} })),
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
	if (!sessionFile) throw new Error("Fixture session did not persist");
	const snapshot = session.captureExactRecoveryAuthority("active-1", operationId);
	return {
		sessionFile,
		session,
		authority: {
			...snapshot,
			operationId,
			activeSessionId: "active-1",
			sessionFile: canonicalSessionPath(sessionFile),
			agentDir: root,
		},
	};
}

function recoveryMarkers(sessionFile: string): Array<{ details?: unknown }> {
	return SessionManager.open(sessionFile)
		.getEntries()
		.filter(
			(entry): entry is typeof entry & { type: "custom_message" } =>
				entry.type === "custom_message" && entry.customType === "prime-agent.worker_recovery",
		);
}

describe("daemon catalog mark_interrupted", () => {
	it("applies the exact authority and persists synthetic results before one marker", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession();

		await expect(markSessionInterrupted(authority, ["tool_execution"])).resolves.toEqual({ status: "applied" });

		const reopened = SessionManager.open(sessionFile);
		const context = reopened.buildSessionContext().messages;
		expect(context.map((message) => message.role)).toEqual(["user", "assistant", "toolResult", "custom"]);
		expect(context[2]).toMatchObject({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: true,
			details: {
				recovery: { operationId: authority.operationId, assistantEntryId: authority.assistantEntryId },
			},
		});
		const text = (readPersistedToolResults(sessionFile)[0]!.content[0] as { text: string }).text;
		expect(text).toContain("whether the tool executed");
		expect(text).toContain("external side effects are unknown");
		const markers = recoveryMarkers(sessionFile);
		expect(markers).toHaveLength(1);
		expect(markers[0]).toMatchObject({
			details: {
				operationId: authority.operationId,
				activeSessionId: "active-1",
				operations: ["tool_execution"],
				authority,
			},
		});
	});

	it("deduplicates response-loss replay globally by operationId", async () => {
		const { sessionFile, authority, session } = createCatalogFixtureSession();
		await markSessionInterrupted(authority, ["tool_execution"]);
		// Move to another branch after the committed marker. Global marker lookup
		// must still win before active-branch authority validation.
		session.branch(session.getBranch()[0]!.id);
		session.appendMessage({ role: "user", content: "new branch", timestamp: 3 });

		await expect(markSessionInterrupted(authority, ["tool_execution"])).resolves.toEqual({
			status: "already_applied",
		});
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(recoveryMarkers(sessionFile)).toHaveLength(1);
	});

	it("serializes concurrent duplicate requests to one result and one marker", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession();

		const results = await Promise.all([
			markSessionInterrupted(authority, ["tool_execution"]),
			markSessionInterrupted(authority, ["tool_execution"]),
		]);

		expect(results).toEqual([{ status: "applied" }, { status: "already_applied" }]);
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(recoveryMarkers(sessionFile)).toHaveLength(1);
	});

	it("returns stale without writes after the session advances or generation changes", async () => {
		for (const mismatch of ["advance", "generation"] as const) {
			const { sessionFile, authority, session } = createCatalogFixtureSession();
			const request = mismatch === "generation" ? { ...authority, sessionId: "replaced-generation" } : authority;
			if (mismatch === "advance") {
				session.appendMessage({ role: "user", content: "newer work", timestamp: 3 });
			}
			const before = readFileSync(sessionFile);

			await expect(markSessionInterrupted(request, ["tool_execution"])).resolves.toMatchObject({
				status: "stale",
			});
			expect(readFileSync(sessionFile)).toEqual(before);
		}
	});

	it("classifies a normal live lease owner as stale without opening or writing", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession();
		const lease = acquireSessionLease(sessionFile, authority.agentDir, {
			...process.env,
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "live-active-session",
		});
		if (!lease) throw new Error("Fixture lease was not enabled");
		const before = readFileSync(sessionFile);
		try {
			await expect(markSessionInterrupted(authority, ["tool_execution"])).resolves.toEqual({
				status: "stale",
				reason: "live_session_owner",
			});
			expect(readFileSync(sessionFile)).toEqual(before);
		} finally {
			lease.release();
		}
	});

	it("treats another recovery lease owner as a retryable request failure", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession();
		const lease = acquireSessionLease(sessionFile, authority.agentDir, {
			...process.env,
			[SESSION_LEASES_ENABLED_ENV]: "1",
			[SESSION_LEASE_OWNER_ID_ENV]: "worker-recovery:other-operation",
		});
		if (!lease) throw new Error("Fixture lease was not enabled");
		const before = readFileSync(sessionFile);
		try {
			await expect(markSessionInterrupted(authority, ["tool_execution"])).rejects.toThrow(
				"Concurrent recovery owns the session lease",
			);
			expect(readFileSync(sessionFile)).toEqual(before);
		} finally {
			lease.release();
		}
	});

	it("resumes an operation-owned partial result suffix after persistence failure", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession([
			{ id: "bash-1", name: "bash" },
			{ id: "edit-1", name: "edit" },
		]);
		const append = SessionManager.prototype.appendMessageWithRollback;
		let attempts = 0;
		const spy = vi.spyOn(SessionManager.prototype, "appendMessageWithRollback").mockImplementation(function (
			this: SessionManager,
			message,
		) {
			attempts++;
			if (attempts === 2) throw new Error("disk full");
			return append.call(this, message);
		});
		try {
			await expect(markSessionInterrupted(authority, ["tool_execution"])).rejects.toThrow("disk full");
		} finally {
			spy.mockRestore();
		}
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(recoveryMarkers(sessionFile)).toHaveLength(0);

		await expect(markSessionInterrupted(authority, ["tool_execution"])).resolves.toEqual({ status: "applied" });
		expect(readPersistedToolResults(sessionFile).map((result) => result.toolCallId)).toEqual(["bash-1", "edit-1"]);
		expect(recoveryMarkers(sessionFile)).toHaveLength(1);
	});

	it("retries a failed marker append without duplicating persisted results", async () => {
		const { sessionFile, authority } = createCatalogFixtureSession();
		const spy = vi
			.spyOn(SessionManager.prototype, "appendCustomMessageEntryWithRollback")
			.mockImplementationOnce(() => {
				throw new Error("marker write failed");
			});
		try {
			await expect(markSessionInterrupted(authority, ["tool_execution"])).rejects.toThrow("marker write failed");
		} finally {
			spy.mockRestore();
		}
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(recoveryMarkers(sessionFile)).toHaveLength(0);

		await expect(markSessionInterrupted(authority, ["tool_execution"])).resolves.toEqual({ status: "applied" });
		expect(readPersistedToolResults(sessionFile)).toHaveLength(1);
		expect(recoveryMarkers(sessionFile)).toHaveLength(1);
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
