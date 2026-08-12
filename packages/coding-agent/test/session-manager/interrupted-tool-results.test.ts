import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager, type SessionMessageEntry } from "../../src/core/session-manager.js";

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
