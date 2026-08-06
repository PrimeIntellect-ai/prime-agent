import { describe, expect, it, vi } from "vitest";
import { projectAgentSessionMailbox } from "../src/core/agent-messages.js";
import {
	CLAUDE_CODE_MCP_SERVER_NAME,
	ClaudeCodeFamilyMailbox,
	createClaudeCodeFamilyMcpServer,
} from "../src/core/claude-code-coordination.js";

function harness(delivery: "queued" | "woken" = "queued") {
	const entries: unknown[] = [];
	const order: string[] = [];
	const deliver = vi.fn((_message: string) => {
		order.push("deliver");
		return delivery;
	});
	const send = vi.fn(async (input) => ({
		id: input.id ?? "sent-id",
		source: "agent_message" as const,
		target: { activeSessionId: "parent", sessionId: "parent" },
		message: input.message,
		deliveryStatus: "queued" as const,
	}));
	const mailbox = new ClaudeCodeFamilyMailbox({
		target: {
			activeSessionId: "claude-child",
			sessionId: "claude-child",
			sessionName: "Claude child",
			runtimeKind: "subagent",
		},
		storage: {
			read: () => entries,
			append: (customType, details) => {
				order.push(customType);
				entries.push({ type: "custom_message", customType, content: "", display: false, details });
			},
		},
		list: async () => ({
			current: { id: "claude-child", name: "Claude child", depth: 1 },
			entries: [{ relationship: "parent", id: "parent", name: "Parent", depth: 0, status: "running" }],
		}),
		send,
		deliver,
	});
	return { mailbox, entries, order, deliver, send };
}

describe("Claude Code family coordination", () => {
	it("persists before ordered busy delivery and makes stable retries idempotent", async () => {
		const fixture = harness("queued");
		const first = await fixture.mailbox.receive({
			id: "agentmsg-one",
			message: "one",
			replyTo: "question",
			from: { sessionId: "parent", sessionName: "Parent" },
			fromRelationship: "parent",
		});
		const second = await fixture.mailbox.receive({ id: "agentmsg-two", message: "two" });
		const retry = await fixture.mailbox.receive({
			id: "agentmsg-one",
			message: "conflicting retry",
			replyTo: "different",
		});
		expect(fixture.order.slice(0, 2)).toEqual(["agent_message.accepted", "deliver"]);
		expect(first).toMatchObject({ deliveryStatus: "queued", targetSequence: 1, handoff: "queue" });
		expect(second).toMatchObject({ deliveryStatus: "queued", targetSequence: 2 });
		expect(retry).toMatchObject({ targetSequence: 1, handoff: "retry", replyTo: "question" });
		expect(fixture.deliver).toHaveBeenCalledTimes(2);
		await expect(fixture.mailbox.inbox({ limit: 10 })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-one" }, { id: "agentmsg-two" }],
		});
		await expect(fixture.mailbox.inbox({ limit: 1, consume: true, replyTo: "question" })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-one" }],
		});
		await expect(fixture.mailbox.inbox({ limit: 10 })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-two" }],
		});
	});

	it("retries an accepted message when the first runtime handoff fails", async () => {
		const fixture = harness("queued");
		fixture.deliver.mockImplementationOnce(() => {
			throw new Error("input queue full");
		});
		await expect(fixture.mailbox.receive({ id: "agentmsg-resume", message: "original" })).rejects.toThrow(
			"input queue full",
		);
		await expect(
			fixture.mailbox.receive({ id: "agentmsg-resume", message: "conflicting retry" }),
		).resolves.toMatchObject({
			message: "original",
			targetSequence: 1,
			handoff: "queue",
		});
		expect(fixture.deliver).toHaveBeenCalledTimes(2);
		expect(
			fixture.entries.filter((entry) => (entry as { customType?: string }).customType === "agent_message.accepted"),
		).toHaveLength(1);
	});

	it("isolates message identity and consumption by target journal", async () => {
		const fixture = harness("queued");
		fixture.entries.push({
			type: "custom_message",
			customType: "agent_message.accepted",
			content: "",
			display: false,
			details: {
				envelope: {
					id: "agentmsg-shared",
					source: "agent_message",
					message: "for parent",
					target: { activeSessionId: "parent", sessionId: "parent" },
					acceptedAt: new Date().toISOString(),
					sequence: 1,
				},
			},
		});
		await expect(fixture.mailbox.receive({ id: "agentmsg-shared", message: "for Claude" })).resolves.toMatchObject({
			target: { sessionId: "claude-child" },
			targetSequence: 1,
		});
		expect(projectAgentSessionMailbox(fixture.entries, "parent")).toMatchObject([
			{ id: "agentmsg-shared", message: "for parent" },
		]);
		await expect(fixture.mailbox.inbox({ limit: 10, consume: true })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-shared", message: "for Claude" }],
		});
		expect(projectAgentSessionMailbox(fixture.entries, "parent")).toHaveLength(1);
	});

	it("registers wait before acceptance, consumes the match, and supports cancellation", async () => {
		const fixture = harness("woken");
		const waiting = fixture.mailbox.wait({ timeoutMs: 1000, replyTo: "question" });
		await Promise.resolve();
		const receipt = await fixture.mailbox.receive({
			id: "agentmsg-answer",
			message: "answer",
			replyTo: "question",
		});
		await expect(waiting).resolves.toMatchObject({ message: { id: "agentmsg-answer" } });
		expect(receipt).toMatchObject({ deliveryStatus: "delivered", handoff: "waiter" });
		expect(fixture.deliver).not.toHaveBeenCalled();
		await expect(fixture.mailbox.inbox({ limit: 10 })).resolves.toEqual({ messages: [] });

		const abort = new AbortController();
		const cancelled = fixture.mailbox.wait({ timeoutMs: 1000 }, abort.signal);
		await Promise.resolve();
		abort.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		const tornDown = fixture.mailbox.wait({ timeoutMs: 1000 });
		await Promise.resolve();
		fixture.mailbox.close("parent disposed");
		await expect(tornDown).rejects.toThrow("parent disposed");
	});

	it("creates one narrow in-process MCP server and preserves send correlation", async () => {
		const fixture = harness();
		const server = createClaudeCodeFamilyMcpServer(fixture.mailbox);
		expect(server).toMatchObject({ type: "sdk", name: CLAUDE_CODE_MCP_SERVER_NAME });
		await expect(
			fixture.mailbox.send({
				receiverRole: "parent",
				message: "finished",
				id: "agentmsg-result",
				replyTo: "agentmsg-question",
			}),
		).resolves.toMatchObject({ id: "agentmsg-result", message: "finished" });
		expect(fixture.send).toHaveBeenCalledWith({
			receiverRole: "parent",
			message: "finished",
			id: "agentmsg-result",
			replyTo: "agentmsg-question",
		});
	});
});
