import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ExactRecoveryAuthority,
	type ExactRecoverySnapshot,
	type ExactRecoveryStatus,
	SessionManager,
	type SessionMessageEntry,
} from "../../src/core/session-manager.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createSession(): SessionManager {
	const root = mkdtempSync(join(tmpdir(), "prime-interrupted-tool-results-"));
	roots.push(root);
	return SessionManager.create(join(root, "project"), join(root, "sessions"));
}

function toolCall(id: string, name: string): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name, arguments: {} };
}

function assistantTurn(...calls: ReturnType<typeof toolCall>[]): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "calling tools" }, ...calls],
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
		timestamp: Date.now(),
	};
}

function toolResult(callId: string, name: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function toolResultEntries(session: SessionManager): SessionMessageEntry[] {
	return session
		.getBranch()
		.filter((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message.role === "toolResult");
}

describe("SessionManager interrupted tool-call recovery", () => {
	it("closes every unresolved tool call in the latest assistant turn with an isError toolResult", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit")));

		const closed = session.closeUnresolvedToolCalls();

		expect(closed).toBe(2);
		const results = toolResultEntries(session);
		expect(results).toHaveLength(2);
		expect(results[0]!.message).toMatchObject({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: true,
		});
		expect(results[1]!.message).toMatchObject({
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: true,
		});
		const text = results
			.map((entry) => ((entry.message as ToolResultMessage).content[0] as { text: string }).text)
			.join(" ");
		expect(text).toContain("whether the tool executed");
		expect(text).toContain("its result, and any external side effects are unknown");
		expect(text).toContain("was not replayed by recovery");
		expect(text).toContain("Inspect external side effects before retrying");
	});

	it("persists rollback-capable appends and returns no-op on repeat invocation", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");

		const first = session.closeUnresolvedToolCalls();
		expect(first).toBe(1);

		const reopened = SessionManager.open(sessionFile);
		expect(toolResultEntries(reopened)).toHaveLength(1);
		expect(reopened.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(reopened)).toHaveLength(1);
	});

	it("resumes after a later synthetic-result append fails", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const append = session.appendMessageWithRollback.bind(session);
		let attempts = 0;
		const spy = vi.spyOn(session, "appendMessageWithRollback").mockImplementation((message) => {
			attempts++;
			if (attempts === 2) throw new Error("disk full");
			return append(message);
		});

		expect(() => session.closeUnresolvedToolCalls()).toThrow("disk full");
		spy.mockRestore();
		const partiallyRecovered = SessionManager.open(sessionFile);
		expect(toolResultEntries(partiallyRecovered)).toHaveLength(1);
		expect(partiallyRecovered.closeUnresolvedToolCalls()).toBe(1);
		expect(toolResultEntries(SessionManager.open(sessionFile))).toHaveLength(2);
	});

	it("leaves already-resolved tool calls untouched", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		session.appendMessage(toolResult("bash-1", "bash"));

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(session)).toHaveLength(1);
	});

	it("closes only the unresolved subset of a partially resolved turn", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit")));
		session.appendMessage(toolResult("bash-1", "bash"));

		const closed = session.closeUnresolvedToolCalls();

		expect(closed).toBe(1);
		const results = toolResultEntries(session);
		expect(results).toHaveLength(2);
		expect(results[1]!.message).toMatchObject({ toolCallId: "edit-1", toolName: "edit", isError: true });
	});

	it("is a no-op when the active branch has no open tool calls", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "plain", timestamp: Date.now() });
		session.appendMessage(assistantTurn());

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(session.getBranch()).toHaveLength(2);
	});

	it("ignores unresolved tool calls on an inactive sibling branch", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		const toolTurnId = session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		session.branch(session.getBranch()[0]!.id);
		session.appendMessage({ role: "user", content: "different path", timestamp: Date.now() });

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(session)).toHaveLength(0);
		const onSibling = session.getEntry(toolTurnId);
		expect(onSibling).toBeDefined();
	});

	it("does not reach back to an older dangling tool call when a later plain assistant turn exists", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("older-1", "bash")));
		session.appendMessage(assistantTurn());

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(session)).toHaveLength(0);
	});

	it("skips malformed later assistant content instead of reaching back to an older turn", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("older-1", "bash")));
		session.appendMessage(
			assistantTurn(
				null as unknown as AssistantMessage["content"][number],
				{ type: "toolCall", id: "malformed-1", arguments: {} } as unknown as AssistantMessage["content"][number],
				{ type: "toolCall", name: "edit" } as unknown as AssistantMessage["content"][number],
			),
		);

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(session)).toHaveLength(0);
	});

	it("does not close calls when the latest assistant message is not a toolUse turn", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage({
			...assistantTurn(toolCall("bash-1", "bash")),
			stopReason: "stop",
		});

		expect(session.closeUnresolvedToolCalls()).toBe(0);
		expect(toolResultEntries(session)).toHaveLength(0);
	});
});

function buildAuthority(
	session: SessionManager,
	operationId: string = "op-1",
	activeSessionId: string = "active-1",
): ExactRecoveryAuthority {
	const snapshot = session.captureExactRecoveryAuthority(activeSessionId, operationId);
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Fixture session did not persist");
	return {
		sessionId: snapshot.sessionId,
		headEntryId: snapshot.headEntryId,
		assistantEntryId: snapshot.assistantEntryId,
		toolCalls: snapshot.toolCalls,
		lineageDigest: snapshot.lineageDigest,
		operationId,
		activeSessionId,
		sessionFile,
	};
}

function syntheticResult(
	toolCallId: string,
	toolName: string,
	operationId: string,
	assistantEntryId: string | null,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "interrupted" }],
		isError: true,
		timestamp: Date.now(),
		details: { recovery: { operationId, assistantEntryId } },
	};
}

function expectStaleWithoutWrite(result: ExactRecoveryStatus, before: number, sessionFile: string): void {
	expect(result.status).toBe("stale");
	expect(readFileSync(sessionFile).length).toBe(before);
}

describe("SessionManager exact-authority recovery", () => {
	it("captures an exact authority from one active-branch view", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));

		const snapshot: ExactRecoverySnapshot = session.captureExactRecoveryAuthority("active-9", "op-7");

		expect(snapshot.sessionId).toBe(session.getSessionId());
		expect(snapshot.headEntryId).toBe(assistantId);
		expect(snapshot.assistantEntryId).toBe(assistantId);
		expect(snapshot.toolCalls).toEqual([{ id: "bash-1", name: "bash" }]);
		expect(snapshot.lineageDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("produces a deterministic lineageDigest for the same branch", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));

		const first = session.captureExactRecoveryAuthority("active-1", "op-1");
		const second = session.captureExactRecoveryAuthority("active-1", "op-1");

		expect(first.lineageDigest).toBe(second.lineageDigest);
		// Capture ignores the operationId argument: the snapshot is branch-derived only.
		const third = session.captureExactRecoveryAuthority("active-1", "op-DIFFERENT");
		expect(third.lineageDigest).toBe(first.lineageDigest);
		expect(third.sessionId).toBe(first.sessionId);
		expect(third.headEntryId).toBe(first.headEntryId);
		expect(third.assistantEntryId).toBe(first.assistantEntryId);
		expect(third.toolCalls).toEqual(first.toolCalls);
	});

	it("changes the lineageDigest when the branch advances", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));

		const before = session.captureExactRecoveryAuthority("active-1", "op-1");
		session.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		const after = session.captureExactRecoveryAuthority("active-1", "op-1");

		expect(after.lineageDigest).not.toBe(before.lineageDigest);
		expect(after.headEntryId).not.toBe(before.headEntryId);
	});

	it("closes every journaled tool call when the authority matches", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit")));

		const result = session.closeUnresolvedToolCallsWithAuthority(buildAuthority(session));

		expect(result.status).toBe("applied");
		if (result.status === "applied") {
			expect(result.closed).toBe(2);
		}
		const results = toolResultEntries(session);
		expect(results).toHaveLength(2);
		expect(results[0]!.message).toMatchObject({
			role: "toolResult",
			toolCallId: "bash-1",
			toolName: "bash",
			isError: true,
		});
		expect(results[1]!.message).toMatchObject({
			role: "toolResult",
			toolCallId: "edit-1",
			toolName: "edit",
			isError: true,
		});
		const text = results
			.map((entry) => ((entry.message as ToolResultMessage).content[0] as { text: string }).text)
			.join(" ");
		expect(text).toContain("whether the tool executed");
		expect(text).toContain("Inspect external side effects");
	});

	it("tags each synthetic result with operationId and assistantEntryId metadata", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));

		const result = session.closeUnresolvedToolCallsWithAuthority(buildAuthority(session, "op-42"));

		expect(result.status).toBe("applied");
		const results = toolResultEntries(session);
		expect(results).toHaveLength(1);
		const details = (results[0]!.message as ToolResultMessage).details as
			| { recovery?: { operationId?: string; assistantEntryId?: string | null } }
			| undefined;
		expect(details?.recovery?.operationId).toBe("op-42");
		expect(details?.recovery?.assistantEntryId).toBe(assistantId);
	});

	it("returns stale for a generation mismatch without writing", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority({
			...buildAuthority(session),
			sessionId: "different-generation",
		});

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale for a head mismatch without writing", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const authority = buildAuthority(session);
		session.appendMessage({ role: "user", content: "second turn", timestamp: Date.now() });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale for an assistantEntryId mismatch without writing", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority({
			...buildAuthority(session),
			assistantEntryId: "missing-assistant-id",
		});

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale for a lineageDigest mismatch without writing", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority({
			...buildAuthority(session),
			lineageDigest: "f".repeat(64),
		});

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale for a toolCalls mismatch without writing", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority({
			...buildAuthority(session),
			toolCalls: [{ id: "wrong-1", name: "bash" }],
		});

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale when the active branch is not the captured branch", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const authority = buildAuthority(session);
		const userEntry = session.getBranch()[0]!;
		session.branch(userEntry.id);
		session.appendMessage({ role: "user", content: "different path", timestamp: Date.now() });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale when a non-recovery entry appears after the assistant entry", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const authority = buildAuthority(session);
		session.appendMessage({ role: "user", content: "newer user turn", timestamp: Date.now() });
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("returns stale when a foreign synthetic result appears after the assistant entry", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const authority = buildAuthority(session, "op-1");
		session.appendMessage(syntheticResult("bash-1", "bash", "op-OTHER", assistantId));
		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;

		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		expectStaleWithoutWrite(result, before, sessionFile);
	});

	it("resumes an operation-owned partial suffix without duplicating existing synthetic results", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		const assistantId = session.appendMessage(assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit")));
		const authority = buildAuthority(session, "op-99");
		session.appendMessage(syntheticResult("bash-1", "bash", "op-99", assistantId));

		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		expect(result.status).toBe("applied");
		if (result.status === "applied") {
			expect(result.closed).toBe(1);
		}
		const results = toolResultEntries(session);
		expect(results).toHaveLength(2);
		expect(results.map((entry) => (entry.message as ToolResultMessage).toolCallId)).toEqual(["bash-1", "edit-1"]);
	});

	it("returns already_applied when every journaled tool call is already in the suffix", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(assistantTurn(toolCall("bash-1", "bash")));
		const authority = buildAuthority(session);

		const first = session.closeUnresolvedToolCallsWithAuthority(authority);
		const second = session.closeUnresolvedToolCallsWithAuthority(authority);

		expect(first.status).toBe("applied");
		expect(second.status).toBe("already_applied");
		expect(toolResultEntries(session)).toHaveLength(1);
	});

	it("closes the journaled tool call even when the assistant stopReason is not 'toolUse'", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage({
			...assistantTurn(toolCall("bash-1", "bash")),
			stopReason: "stop",
		});

		const result = session.closeUnresolvedToolCallsWithAuthority(buildAuthority(session));

		expect(result.status).toBe("applied");
		if (result.status === "applied") {
			expect(result.closed).toBe(1);
		}
	});

	it("only appends the journaled tool call IDs, never extras from the assistant content", () => {
		const session = createSession();
		session.appendMessage({ role: "user", content: "run tools", timestamp: Date.now() });
		session.appendMessage(
			assistantTurn(toolCall("bash-1", "bash"), toolCall("edit-1", "edit"), toolCall("read-1", "read")),
		);

		const base = buildAuthority(session);
		const authority: ExactRecoveryAuthority = {
			...base,
			toolCalls: [{ id: "bash-1", name: "bash" }],
		};
		const result = session.closeUnresolvedToolCallsWithAuthority(authority);

		const sessionFile = session.getSessionFile();
		if (!sessionFile) throw new Error("Fixture session did not persist");
		const before = readFileSync(sessionFile).length;
		// Mismatched declaration → no writes.
		expectStaleWithoutWrite(result, before, sessionFile);
	});
});
