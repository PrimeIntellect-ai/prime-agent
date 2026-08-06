import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { ClaudeCodeFamilyMailbox } from "../src/core/claude-code-coordination.js";
import { CLAUDE_CODE_FAMILY_TOOL_NAMES } from "../src/core/claude-code-coordination.js";
import type { ClaudeCodeEvent, ClaudeCodeQuery, StartClaudeCodeQuery } from "../src/core/claude-code-sdk.js";
import { createHarness } from "./suite/harness.js";

class DeferredEvents implements AsyncIterable<ClaudeCodeEvent> {
	private readonly queue: ClaudeCodeEvent[] = [];
	private waiter: ((result: IteratorResult<ClaudeCodeEvent>) => void) | undefined;
	private ended = false;

	push(event: ClaudeCodeEvent): void {
		const waiter = this.waiter;
		if (waiter) {
			this.waiter = undefined;
			waiter({ done: false, value: event });
		} else {
			this.queue.push(event);
		}
	}

	end(): void {
		this.ended = true;
		const waiter = this.waiter;
		this.waiter = undefined;
		waiter?.({ done: true, value: undefined });
	}

	[Symbol.asyncIterator](): AsyncIterator<ClaudeCodeEvent> {
		return {
			next: () => {
				const event = this.queue.shift();
				if (event) return Promise.resolve({ done: false, value: event });
				if (this.ended) return Promise.resolve({ done: true, value: undefined });
				return new Promise((resolve) => {
					this.waiter = resolve;
				});
			},
		};
	}
}

const usage = {
	input: 12,
	output: 5,
	cacheRead: 3,
	cacheWrite: 1,
	totalTokens: 21,
	cost: 0.04,
	requests: 1,
};

function deferredQuery() {
	const events = new DeferredEvents();
	const close = vi.fn(() => events.end());
	let release!: (query: ClaudeCodeQuery) => void;
	let input: AsyncIterator<string> | undefined;
	let request: Parameters<StartClaudeCodeQuery>[0] | undefined;
	const pending = new Promise<ClaudeCodeQuery>((resolve) => {
		release = resolve;
	});
	const start: StartClaudeCodeQuery = vi.fn(async (nextRequest) => {
		request = nextRequest;
		input = nextRequest.prompt[Symbol.asyncIterator]();
		return pending;
	});
	return {
		events,
		close,
		release: () => release({ events, close }),
		start,
		request: () => request,
		input: () => {
			if (!input) throw new Error("query input was not created");
			return input;
		},
	};
}

describe("Claude Code RLM admission", () => {
	it("admits immediately, bypasses native model lookup, and retains a completed registry row", async () => {
		const query = deferredQuery();
		const harness = await createHarness({
			provider: "faux-claude-rlm",
			settings: {
				claudeCode: { executable: "/configured/claude" },
				modelRoles: { claude: "claude-code/claude-opus-4-7:high" },
			},
			startClaudeCodeQuery: query.start,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		try {
			harness.setResponses([fauxAssistantMessage("parent ready")]);
			await harness.session.prompt("prepare delegation");
			const parentAssistant = [...harness.session.messages]
				.reverse()
				.find((message) => message.role === "assistant");
			if (!parentAssistant || parentAssistant.role !== "assistant") throw new Error("missing parent assistant");
			const parentContextTokens = parentAssistant.usage.totalTokens;
			const parentCost = parentAssistant.usage.cost.total;
			const discovery = await harness.session.findRlmModels("claude", 8);
			expect(discovery.models).toContainEqual(
				expect.objectContaining({
					selector: "@claude",
					concreteSelector: "claude-code/claude-opus-4-7",
					runtime: "claude-code",
					available: true,
					effort: "high",
				}),
			);
			const handle = await harness.session.runRlmChild("inspect the runtime", {
				name: "claude-worker",
				model: "@claude",
			});
			expect(handle).toMatchObject({
				name: "claude-worker",
				model: "claude-code/claude-opus-4-7",
			});
			expect(query.start).toHaveBeenCalledOnce();
			expect(query.request()).toMatchObject({
				allowedTools: expect.arrayContaining(["Read", "Edit", ...CLAUDE_CODE_FAMILY_TOOL_NAMES]),
				disallowedTools: ["Agent", "Task", "SendMessage"],
				mcpServers: { prime: { type: "sdk", name: "prime" } },
			});
			await expect(query.input().next()).resolves.toMatchObject({
				done: false,
				value: expect.stringContaining("inspect the runtime"),
			});
			await expect(harness.session.listRlmSubagents()).resolves.toMatchObject({
				subagents: [{ rlm_child_id: handle.rlm_child_id, status: "running", session_id: null }],
			});

			query.release();
			query.events.push({
				kind: "init",
				model: "claude-opus-4-7",
				tools: ["Read", "Edit", ...CLAUDE_CODE_FAMILY_TOOL_NAMES],
				version: "1.0",
				sessionId: "claude-session-1",
			});
			query.events.push({ kind: "assistant", text: "working", usage });
			query.events.push({ kind: "result", isError: false, text: "finished", usage });
			await vi.waitFor(async () => {
				await expect(harness.session.listRlmSubagents()).resolves.toMatchObject({
					subagents: [
						{
							rlm_child_id: handle.rlm_child_id,
							session_id: "claude-session-1",
							status: "completed",
						},
					],
				});
			});
			expect(parentAssistant.usage.totalTokens).toBe(parentContextTokens);
			expect(parentAssistant.usage.cost.total).toBeCloseTo(parentCost + usage.cost);
			expect(
				harness.sessionManager
					.getEntries()
					.some((entry) => entry.type === "child_usage_attributed" && entry.origin === "spawn_task"),
			).toBe(true);
			expect(query.close).not.toHaveBeenCalled();
			await expect(harness.session.deliverRlmChildInput(handle.rlm_child_id, "one follow-up")).resolves.toBe(
				"woken",
			);
			await expect(query.input().next()).resolves.toEqual({ done: false, value: "one follow-up" });
			await expect(harness.session.listRlmSubagents()).resolves.toMatchObject({
				subagents: [{ status: "running" }],
			});
			query.events.push({ kind: "result", isError: false, text: "follow-up finished", usage });
			await vi.waitFor(async () =>
				expect((await harness.session.listRlmSubagents()).subagents[0]).toMatchObject({
					status: "completed",
				}),
			);
			await expect(harness.session.deleteRlmSubagent(handle.rlm_child_id)).resolves.toMatchObject({
				subagent: { rlm_child_id: handle.rlm_child_id, status: "completed" },
			});
			expect(query.close).toHaveBeenCalledOnce();
			await expect(harness.session.listRlmSubagents()).resolves.toEqual({ subagents: [] });
		} finally {
			harness.cleanup();
		}
	});

	it("routes durable parent follow-up and correlated Claude replies through one family adapter", async () => {
		const query = deferredQuery();
		const sendExternalChildAgentMessage = vi.fn(async (input) => ({
			id: input.id ?? "generated",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			from: { activeSessionId: input.childId, sessionId: input.childSessionId, sessionName: input.childName },
			message: input.message,
			deliveryStatus: "queued" as const,
			replyTo: input.replyTo,
		}));
		const controller: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "parent-active", sessionId: "parent-session", sessionName: "Parent" },
				agents: [],
			}),
			roster: () => ({
				current: { id: "parent-session", name: "Parent", depth: 0 },
				entries: [],
			}),
			sendAgentMessage: async () => {
				throw new Error("native send should not handle the external child");
			},
			sendExternalChildAgentMessage,
		};
		const harness = await createHarness({
			provider: "faux-claude-family",
			settings: { claudeCode: { executable: "/configured/claude" } },
			startClaudeCodeQuery: query.start,
			agentMessageController: controller,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		try {
			const handle = await harness.session.runRlmChild("coordinate with family", {
				name: "claude-family-worker",
				model: "claude-code/claude-opus-4-7",
			});
			await query.input().next();
			query.release();
			query.events.push({
				kind: "init",
				model: "claude-opus-4-7",
				tools: [...CLAUDE_CODE_FAMILY_TOOL_NAMES],
				version: "1.0",
				sessionId: "claude-family-session",
			});
			query.events.push({ kind: "result", isError: false, text: "initial done", usage });
			await vi.waitFor(async () =>
				expect((await harness.session.listRlmSubagents()).subagents[0]?.status).toBe("completed"),
			);

			const sessionInternals = harness.session as unknown as {
				_agentMessageRosterWithExternalChildren(): Promise<{
					entries: Array<{ id: string; relationship: string }>;
				}>;
				_receiveExternalRlmChildMessage(
					target: string,
					input: { message: string; id?: string; replyTo?: string },
				): Promise<Record<string, unknown>>;
			};
			await expect(sessionInternals._agentMessageRosterWithExternalChildren()).resolves.toMatchObject({
				entries: [{ id: handle.rlm_child_id, relationship: "child" }],
			});
			await expect(
				sessionInternals._receiveExternalRlmChildMessage(handle.rlm_child_id, {
					message: "parent follow-up",
					id: "agentmsg-parent-follow-up",
					replyTo: "agentmsg-claude-result",
				}),
			).resolves.toMatchObject({
				id: "agentmsg-parent-follow-up",
				replyTo: "agentmsg-claude-result",
				targetSequence: 1,
				deliveryStatus: "delivered",
			});
			await expect(query.input().next()).resolves.toEqual({ done: false, value: "parent follow-up" });

			const internal = harness.session as unknown as {
				_activeRlmChildRuns: Map<string, { familyMailbox?: ClaudeCodeFamilyMailbox }>;
			};
			const mailbox = internal._activeRlmChildRuns.get(handle.rlm_child_id)?.familyMailbox;
			if (!mailbox) throw new Error("missing Claude family mailbox");
			await expect(
				mailbox.send({
					receiverRole: "parent",
					message: "Claude reply",
					id: "agentmsg-claude-result",
					replyTo: "agentmsg-parent-follow-up",
				}),
			).resolves.toMatchObject({ id: "agentmsg-claude-result", replyTo: "agentmsg-parent-follow-up" });
			expect(sendExternalChildAgentMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					childId: handle.rlm_child_id,
					childSessionId: "claude-family-session",
					target: "parent-session",
					id: "agentmsg-claude-result",
					replyTo: "agentmsg-parent-follow-up",
				}),
			);
			await expect(
				mailbox.send({ receiverRole: "sibling", receiverName: "outside-family", message: "blocked" }),
			).rejects.toThrow("No sibling matches");
		} finally {
			harness.cleanup();
		}
	});

	it("admits before startup failure and projects an error registry row", async () => {
		const start: StartClaudeCodeQuery = vi.fn(async () => {
			throw new Error("SDK startup failed");
		});
		const harness = await createHarness({
			provider: "faux-claude-startup-error",
			settings: { claudeCode: { executable: "/configured/claude" } },
			startClaudeCodeQuery: start,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		try {
			const handle = await harness.session.runRlmChild("fail after admission", {
				model: "claude-code/claude-opus-4-7",
			});
			expect(handle.model).toBe("claude-code/claude-opus-4-7");
			await vi.waitFor(async () =>
				expect((await harness.session.listRlmSubagents()).subagents[0]).toMatchObject({
					rlm_child_id: handle.rlm_child_id,
					status: "error",
				}),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects unavailable Claude selectors without starting a query", async () => {
		const start = vi.fn<StartClaudeCodeQuery>();
		const harness = await createHarness({
			provider: "faux-claude-unavailable",
			startClaudeCodeQuery: start,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		try {
			await expect(
				harness.session.runRlmChild("must not start", { model: "claude-code/claude-opus-4-7" }),
			).rejects.toThrow("no configured Claude Code executable");
			expect(start).not.toHaveBeenCalled();
			await expect(harness.session.listRlmSubagents()).resolves.toEqual({ subagents: [] });
		} finally {
			harness.cleanup();
		}
	});

	it("closes a query created after deletion races blocked startup", async () => {
		const query = deferredQuery();
		const harness = await createHarness({
			provider: "faux-claude-delete",
			settings: { claudeCode: { executable: "/configured/claude" } },
			startClaudeCodeQuery: query.start,
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		try {
			const handle = await harness.session.runRlmChild("delete during startup", {
				model: "claude-code/claude-sonnet-4-6:medium",
			});
			await expect(harness.session.deleteRlmSubagent(handle.rlm_child_id)).resolves.toMatchObject({
				subagent: { rlm_child_id: handle.rlm_child_id },
			});
			await expect(harness.session.listRlmSubagents()).resolves.toEqual({ subagents: [] });
			query.release();
			await vi.waitFor(() => expect(query.close).toHaveBeenCalledOnce());
		} finally {
			harness.cleanup();
		}
	});

	it("closes a retained completed query when the parent is disposed", async () => {
		const events = new DeferredEvents();
		const close = vi.fn(() => events.end());
		const harness = await createHarness({
			provider: "faux-claude-dispose",
			settings: { claudeCode: { executable: "/configured/claude" } },
			startClaudeCodeQuery: async () => ({ events, close }),
			rlmDepth: 0,
			rlmMaxDepth: 1,
		});
		const handle = await harness.session.runRlmChild("complete before parent disposal", {
			model: "claude-code/claude-haiku-4-5",
		});
		events.push({
			kind: "init",
			model: "claude-haiku-4-5",
			tools: ["Read", ...CLAUDE_CODE_FAMILY_TOOL_NAMES],
			version: "1.0",
			sessionId: "claude-session-dispose",
		});
		events.push({ kind: "result", isError: false, text: "done", usage });
		await vi.waitFor(async () =>
			expect((await harness.session.listRlmSubagents()).subagents[0]).toMatchObject({
				rlm_child_id: handle.rlm_child_id,
				status: "completed",
			}),
		);
		harness.session.dispose();
		harness.session.dispose();
		expect(close).toHaveBeenCalledOnce();
		harness.cleanup();
	});
});
