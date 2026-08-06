import { describe, expect, it, vi } from "vitest";

import type { AgentSessionMessagePayload } from "../src/core/agent-messages.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";

type MailboxEntry = {
	type: "custom_message";
	customType: string;
	content: string;
	display: boolean;
	details: unknown;
};

function mailboxManager(onAppend?: (entry: MailboxEntry) => void) {
	const entries: MailboxEntry[] = [];
	return {
		entries,
		getEntries: () => [...entries],
		appendCustomMessageEntryWithRollback: (
			customType: string,
			content: string,
			display: boolean,
			details: unknown,
		) => {
			const entry = { type: "custom_message" as const, customType, content, display, details };
			entries.push(entry);
			onAppend?.(entry);
			return `entry-${entries.length}`;
		},
	};
}

function state(
	activeSessionId: string,
	manager: ReturnType<typeof mailboxManager>,
	prompt: (message: string) => Promise<void> = async () => {},
) {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: {
			cwd: "/tmp",
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: `session-${activeSessionId}`,
				sessionName: activeSessionId,
				runtimeKind: "top-level",
				rlmDepth: 0,
				isStreaming: false,
				isCompacting: false,
				isRetrying: false,
				isBashRunning: false,
				unfinishedActionCount: 0,
				sessionManager: manager,
				acceptAgentMessagePrompt: async (message: string, options: { preflightResult?: (ok: boolean) => void }) => {
					options.preflightResult?.(true);
					await prompt(message);
				},
			},
		},
	} as unknown as ActiveSessionState;
}

function daemonFixture(targetManager = mailboxManager()) {
	const daemon = new AgentDaemon("/tmp/prime-agent-mailbox-test.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-mailbox-test", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	const source = state("source", mailboxManager());
	const targetPrompt = vi.fn(async (_message: string) => {});
	const target = state("target", targetManager, targetPrompt);
	const internals = daemon as unknown as {
		sessions: Map<string, ActiveSessionState>;
		sendAgentSessionMessage(options: {
			targetSelector: string;
			message: string;
			fromState?: ActiveSessionState;
			sender?: { sessionId: string; sessionName: string };
			id?: string;
			replyTo?: string;
			origin: "agent" | "cli";
		}): Promise<Record<string, unknown>>;
		createAgentMessageController(getState: () => ActiveSessionState): {
			inboxAgentMessages(input: { limit: number; consume?: boolean; sender?: string; replyTo?: string }): Promise<{
				messages: AgentSessionMessagePayload[];
			}>;
			waitForAgentMessage(
				input: { timeoutMs: number; sender?: string; replyTo?: string },
				signal?: AbortSignal,
			): Promise<{ message?: AgentSessionMessagePayload }>;
		};
		agentMessageWaiters: Map<string, unknown[]>;
		cancelAgentMessageWaiters(activeSessionId: string, reason: string): void;
	};
	internals.sessions.set(source.activeSessionId, source);
	internals.sessions.set(target.activeSessionId, target);
	return { internals, source, target, targetPrompt, targetManager };
}

describe("durable family mailbox", () => {
	it("appends acceptance before delivery and makes stable-ID retry idempotent", async () => {
		const order: string[] = [];
		const manager = mailboxManager(() => order.push("append"));
		const fixture = daemonFixture(manager);
		fixture.targetPrompt.mockImplementation(async (_message: string) => {
			order.push("prompt");
		});
		const options = {
			targetSelector: fixture.target.activeSessionId,
			message: "hello",
			sender: { sessionId: "sender", sessionName: "Sender" },
			id: "agentmsg-stable",
			origin: "cli" as const,
		};
		const first = await fixture.internals.sendAgentSessionMessage(options);
		const retry = await fixture.internals.sendAgentSessionMessage({
			...options,
			message: "conflicting retry",
			replyTo: "different-message",
		});
		expect(order).toEqual(["append", "prompt", "append"]);
		expect(first).toMatchObject({ acceptedAt: expect.any(String), targetSequence: 1, handoff: "context" });
		expect(retry).toMatchObject({ targetSequence: 1, handoff: "retry" });
		expect(retry.replyTo).toBeUndefined();
		expect(fixture.targetPrompt).toHaveBeenCalledOnce();
		expect(manager.entries[0]).toMatchObject({ customType: "agent_message.accepted", display: false });
	});

	it("resumes accepted delivery after a failed prompt preflight", async () => {
		const fixture = daemonFixture();
		const session = fixture.target.runtime.session as unknown as {
			acceptAgentMessagePrompt: (
				message: string,
				options: { preflightResult?: (ok: boolean) => void },
			) => Promise<void>;
		};
		let attempts = 0;
		session.acceptAgentMessagePrompt = async (_message, options) => {
			attempts += 1;
			options.preflightResult?.(attempts > 1);
		};
		const options = {
			targetSelector: fixture.target.activeSessionId,
			message: "original",
			id: "agentmsg-preflight-retry",
			origin: "cli" as const,
		};
		await expect(fixture.internals.sendAgentSessionMessage(options)).rejects.toThrow("was not accepted");
		await expect(
			fixture.internals.sendAgentSessionMessage({ ...options, message: "conflicting retry" }),
		).resolves.toMatchObject({ message: "original", targetSequence: 1, handoff: "context" });
		expect(attempts).toBe(2);
		expect(
			fixture.targetManager.entries.filter((entry) => entry.customType === "agent_message.accepted"),
		).toHaveLength(1);
	});

	it("resumes accepted delivery when a busy queue initially refuses the message", async () => {
		const fixture = daemonFixture();
		const queueAgentMessagePrompt = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
		const session = fixture.target.runtime.session as unknown as {
			isStreaming: boolean;
			queueAgentMessagePrompt: typeof queueAgentMessagePrompt;
		};
		session.isStreaming = true;
		session.queueAgentMessagePrompt = queueAgentMessagePrompt;
		const options = {
			targetSelector: fixture.target.activeSessionId,
			message: "original",
			id: "agentmsg-queue-retry",
			origin: "cli" as const,
		};
		await expect(fixture.internals.sendAgentSessionMessage(options)).rejects.toThrow("was not queued");
		await expect(
			fixture.internals.sendAgentSessionMessage({ ...options, message: "conflicting retry" }),
		).resolves.toMatchObject({ message: "original", targetSequence: 1, handoff: "queue" });
		expect(queueAgentMessagePrompt).toHaveBeenCalledTimes(2);
		expect(
			fixture.targetManager.entries.filter((entry) => entry.customType === "agent_message.accepted"),
		).toHaveLength(1);
	});

	it("assigns target sequences in concurrent acceptance order", async () => {
		const fixture = daemonFixture();
		const [first, second] = await Promise.all([
			fixture.internals.sendAgentSessionMessage({
				targetSelector: fixture.target.activeSessionId,
				message: "first",
				id: "agentmsg-first",
				origin: "cli",
			}),
			fixture.internals.sendAgentSessionMessage({
				targetSelector: fixture.target.activeSessionId,
				message: "second",
				id: "agentmsg-second",
				origin: "cli",
			}),
		]);
		expect([first.targetSequence, second.targetSequence]).toEqual([1, 2]);
		const controller = fixture.internals.createAgentMessageController(() => fixture.target);
		await expect(controller.inboxAgentMessages({ limit: 20 })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-first" }, { id: "agentmsg-second" }],
		});
	});

	it("peeks and consumes bounded oldest-first rows with reply filters", async () => {
		const fixture = daemonFixture();
		for (const [id, replyTo] of [
			["one", undefined],
			["two", "question"],
			["three", "question"],
		] as const) {
			await fixture.internals.sendAgentSessionMessage({
				targetSelector: fixture.target.activeSessionId,
				message: id,
				sender: { sessionId: "sender", sessionName: "Sender" },
				id: `agentmsg-${id}`,
				replyTo,
				origin: "cli",
			});
		}
		const controller = fixture.internals.createAgentMessageController(() => fixture.target);
		await expect(controller.inboxAgentMessages({ limit: 1, replyTo: "question" })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-two", sequence: 2 }],
		});
		await expect(controller.inboxAgentMessages({ limit: 2, consume: true })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-one" }, { id: "agentmsg-two" }],
		});
		await expect(controller.inboxAgentMessages({ limit: 20 })).resolves.toMatchObject({
			messages: [{ id: "agentmsg-three" }],
		});
		expect(
			fixture.targetManager.entries.filter((entry) => entry.customType === "agent_message.consumed"),
		).toHaveLength(2);
	});

	it("installs the waiter before append and claims delivery before prompt injection", async () => {
		const fixture = daemonFixture();
		const controller = fixture.internals.createAgentMessageController(() => fixture.target);
		const waiting = controller.waitForAgentMessage({ timeoutMs: 1000, replyTo: "question" });
		await Promise.resolve();
		const receipt = await fixture.internals.sendAgentSessionMessage({
			targetSelector: fixture.target.activeSessionId,
			message: "answer",
			sender: { sessionId: "sender", sessionName: "Sender" },
			id: "agentmsg-answer",
			replyTo: "question",
			origin: "cli",
		});
		await expect(waiting).resolves.toMatchObject({ message: { id: "agentmsg-answer" } });
		expect(receipt).toMatchObject({ handoff: "waiter" });
		expect(fixture.targetPrompt).not.toHaveBeenCalled();
	});

	it("removes waiters on timeout, cancellation, and teardown", async () => {
		const fixture = daemonFixture();
		const controller = fixture.internals.createAgentMessageController(() => fixture.target);
		await expect(controller.waitForAgentMessage({ timeoutMs: 1 })).resolves.toEqual({});
		const abort = new AbortController();
		const cancelled = controller.waitForAgentMessage({ timeoutMs: 1000 }, abort.signal);
		await Promise.resolve();
		abort.abort();
		await expect(cancelled).rejects.toThrow("cancelled");
		const tornDown = controller.waitForAgentMessage({ timeoutMs: 1000 });
		await vi.waitFor(() =>
			expect(fixture.internals.agentMessageWaiters.get(fixture.target.activeSessionId)).toHaveLength(1),
		);
		fixture.internals.cancelAgentMessageWaiters(fixture.target.activeSessionId, "daemon shutdown");
		await expect(tornDown).rejects.toThrow("daemon shutdown");
	});
});
