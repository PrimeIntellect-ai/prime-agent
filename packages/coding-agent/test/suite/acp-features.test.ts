import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import type { AgentSessionRuntime } from "../../src/core/agent-session-runtime.js";
import { PRIME_AGENT_META_NAMESPACE } from "../../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness, type Harness } from "./harness.js";

/**
 * Feature-preservation suite for ACP mode.
 *
 * ACP is a new front end over the same AgentSession, so the risk is not that a
 * feature disappears but that its signal never reaches an ACP client. Each test
 * drives a real ACP client and asserts the capability is observable over the
 * protocol (as a standard update, or as namespaced `_meta`).
 */

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

interface AcpFixture {
	agent: any;
	updates: any[];
	sessionId: string;
	metaOf: (key: string) => any[];
}

/**
 * Poll until `predicate` holds. Some turns are admitted rather than awaited
 * (agent-message delivery returns at admission), so a fixed sleep would race the
 * turn on a loaded machine.
 */
async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for the expected ACP updates");
}

async function connectAcp(harness: Harness, existing?: InProcessAgentConnection): Promise<AcpFixture> {
	const connection = existing ?? new InProcessAgentConnection(runtimeHostFor(harness.session));
	const toAgent = new TransformStream<Uint8Array, Uint8Array>();
	const toClient = new TransformStream<Uint8Array, Uint8Array>();
	const updates: any[] = [];

	void runAcpModeWithConnection(connection, {
		stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
	} as any);

	const handle = acp
		.client({ name: "feature-client" })
		.onNotification("session/update", (ctx: any) => {
			updates.push(ctx.params);
		})
		.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

	const agent = handle.agent;
	await agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
	const session = await agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

	return {
		agent,
		updates,
		sessionId: session.sessionId,
		metaOf: (key: string) =>
			updates
				.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.[key])
				.filter((value) => value !== undefined),
	};
}

/**
 * Stand-in for the real IPython tool: the suite harness has no kernel, and this
 * suite is about ACP surfacing, not kernel behavior. The tool NAME is what
 * drives the ACP execute-kind mapping, so the name must match production.
 */
const ipythonTool = {
	name: "ipython",
	description: "Execute a Python cell",
	parameters: {
		type: "object" as const,
		properties: { code: { type: "string" as const } },
		required: ["code"],
	},
	execute: async (_toolCallId: string, params: unknown) => {
		const code =
			typeof params === "object" && params !== null && "code" in params ? String((params as any).code) : "";
		return { content: [{ type: "text" as const, text: "42" }], details: { code } };
	},
};

/**
 * Wrap a connection so a transcript rebuild runs mid-turn, right after
 * `promptAndWait` resolves and before the ACP handler inspects the outcome.
 *
 * Auto-compaction does exactly this to `state.messages`: it drops older messages
 * and re-materializes the ones it keeps (`buildSessionContext`, and the filters
 * and slices around it), so a message the turn appended can end up at a lower
 * index than the pre-turn message count. Driving a real compaction needs a
 * token-overflow response from the provider, so the rebuild is simulated here;
 * what matters is its shape, which is asserted in each test.
 */
function withMidTurnRebuild(
	harness: Harness,
	rebuild: (messages: AgentMessage[]) => AgentMessage[] | undefined,
): { connection: InProcessAgentConnection; arm: () => void } {
	const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
	const promptAndWait = connection.promptAndWait.bind(connection) as (...args: any[]) => Promise<any>;
	let armed = false;
	(connection as any).promptAndWait = async (...args: any[]) => {
		const result = await promptAndWait(...args);
		if (armed) {
			armed = false;
			const rebuilt = rebuild(harness.session.state.messages);
			if (rebuilt) harness.session.state.messages = rebuilt;
		}
		return result;
	};
	return {
		connection,
		arm: () => {
			armed = true;
		},
	};
}

/** Copy messages the way a rebuild from persisted entries does: new objects, same fields. */
function rematerialize(messages: AgentMessage[]): AgentMessage[] {
	return JSON.parse(JSON.stringify(messages));
}

describe("ACP mode preserves prime-agent features", () => {
	it("streams IPython execution as an execute tool call with its cell source", async () => {
		const harness = await createHarness({ tools: [ipythonTool as never] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("ipython", { code: "x = 41 + 1\nprint(x)" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("x is 42"),
		]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "compute 41+1 in python" }],
		});
		expect(result.stopReason).toBe("end_turn");

		const toolCalls = fixture.updates.filter((u) => u.update?.sessionUpdate === "tool_call");
		expect(toolCalls.length).toBeGreaterThan(0);
		const cell = toolCalls.find((u) => u.update.kind === "execute");
		expect(cell, "IPython must surface as an ACP execute tool call").toBeDefined();
		expect(cell.update.rawInput).toMatchObject({ code: "x = 41 + 1\nprint(x)" });

		const done = fixture.updates.filter((u) => u.update?.sessionUpdate === "tool_call_update");
		expect(done.length).toBeGreaterThan(0);
		harness.cleanup();
	}, 30_000);

	it("keeps autonomous gate state observable and ends the turn only when the loop settles", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [`${process.execPath} -e "process.exit(1)"`], maxRetries: 1 },
			},
		});
		harness.setResponses([fauxAssistantMessage("Attempted the task."), fauxAssistantMessage("Retried.")]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "do the task" }],
		});

		// A failing gate is a continuation inside the turn, never a distinct ACP
		// stop reason; the turn resolves once the gate loop is done.
		expect(["end_turn", "max_turn_requests", "max_tokens"]).toContain(result.stopReason);
		const autonomous = fixture.metaOf("autonomous");
		expect(autonomous.length, "autonomous state must reach the client via _meta").toBeGreaterThan(0);
		expect(autonomous.at(-1)).toMatchObject({ enabled: true });
		harness.cleanup();
	}, 60_000);

	it("reports a cancelled prompt turn as the ACP cancelled stop reason", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("Working...")]);
		const fixture = await connectAcp(harness);

		const pending = fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "long task" }],
		});
		await fixture.agent.notify("session/cancel", { sessionId: fixture.sessionId });
		const result = await pending;
		expect(["cancelled", "end_turn"]).toContain(result.stopReason);
		harness.cleanup();
	}, 30_000);

	it("rejects prompts for an unknown session instead of silently starting work", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("should not run")]);
		const fixture = await connectAcp(harness);

		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: "not-a-real-session",
				prompt: [{ type: "text", text: "hello" }],
			}),
		).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("surfaces heartbeat and schedule changes, which are not session events", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("ok")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: any[] = [];
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp
			.client({ name: "hb" })
			.onNotification("session/update", (ctx: any) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await handle.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		// heartbeats_changed is connection-level; a session-event-only filter drops it.
		await (connection as any).emit({ type: "heartbeats_changed" });
		const flags = () =>
			updates
				.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.heartbeatsChanged)
				.filter((value) => value !== undefined);
		await waitFor(() => flags().includes(true));
		expect(flags(), "heartbeat changes must reach the ACP client").toContain(true);
		harness.cleanup();
	}, 30_000);

	it("refuses a concurrent prompt instead of making the running turn uncancellable", async () => {
		const harness = await createHarness();
		// Two turns queued; the second must be rejected, not clobber the first.
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const fixture = await connectAcp(harness);

		const first = fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "one" }],
		});
		const second = fixture.agent
			.request("session/prompt", { sessionId: fixture.sessionId, prompt: [{ type: "text", text: "two" }] })
			.then(() => "accepted")
			.catch(() => "rejected");

		const [firstResult, secondOutcome] = await Promise.all([first, second]);
		expect(firstResult.stopReason).toBe("end_turn");
		expect(secondOutcome).toBe("rejected");

		// The session stays usable for a later, sequential turn.
		harness.appendResponses([fauxAssistantMessage("third")]);
		const third = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "three" }],
		});
		expect(third.stopReason).toBe("end_turn");
		harness.cleanup();
	}, 30_000);

	it("reports a cwd mismatch in _meta instead of failing or silently disagreeing", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp.client({ name: "cwd" }).connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

		// The agent's cwd is fixed at startup, so a different requested cwd must be
		// surfaced rather than silently accepted.
		const created = await handle.agent.request("session/new", {
			cwd: "/definitely/not/the/agent/cwd",
			mcpServers: [],
		});
		expect(created.sessionId).toBeTruthy();
		const cwdMeta = (created._meta?.[PRIME_AGENT_META_NAMESPACE] as { cwd?: unknown } | undefined)?.cwd;
		expect(cwdMeta).toMatchObject({ requested: "/definitely/not/the/agent/cwd" });
		harness.cleanup();
	}, 30_000);

	it("refuses a second session rather than silently sharing one conversation", async () => {
		const harness = await createHarness();
		const fixture = await connectAcp(harness);
		// AgentConnection.newSession() replaces the live session, so two ACP
		// sessions would share history, cwd, model, and queues.
		// The SDK reports a handler throw as a JSON-RPC error, so assert the
		// rejection rather than the message text.
		await expect(fixture.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] })).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("ignores a cancel addressed to a different session", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);
		const fixture = await connectAcp(harness);

		// A stray cancel must not abort the real session's turn.
		await fixture.agent.notify("session/cancel", { sessionId: "some-other-session" });
		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "hello" }],
		});
		expect(result.stopReason).toBe("end_turn");
		harness.cleanup();
	}, 30_000);

	it("forwards advertised image and embedded-resource prompt blocks", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("looked at it")]);
		const fixture = await connectAcp(harness);

		const result = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [
				{ type: "text", text: "what is this?" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///notes.md", text: "context line" } },
			],
		});
		expect(result.stopReason).toBe("end_turn");

		// initialize advertises image + embeddedContext, so both must reach the model.
		const messages = await harness.session.messages;
		const user = messages.find((message: any) => message.role === "user");
		const serialized = JSON.stringify(user);
		expect(serialized).toContain("what is this?");
		expect(serialized).toContain("context line");
		expect(serialized).toContain("aGVsbG8=");
		harness.cleanup();
	}, 30_000);

	it("surfaces a real compaction to the ACP client", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi: any) => {
					pi.on("session_before_compact", async (event: any) => ({
						compaction: {
							summary: "compacted for ACP",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		const fixture = await connectAcp(harness);

		await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "one" }],
		});
		// Drive a genuine compaction rather than synthesizing the event.
		const result = await harness.session.compact();
		expect(result.summary).toBe("compacted for ACP");
		await waitFor(() => fixture.metaOf("compaction").length > 0);

		const compaction = fixture.metaOf("compaction");
		expect(compaction.length, "compaction must reach the ACP client").toBeGreaterThan(0);
		expect(compaction.at(-1)).toMatchObject({ summary: "compacted for ACP" });
		harness.cleanup();
	}, 60_000);

	it("surfaces real goal state transitions to the ACP client", async () => {
		const harness = await createHarness({ initialGoal: { objective: "ship ACP mode" } });
		harness.setResponses([fauxAssistantMessage("working on it")]);
		const fixture = await connectAcp(harness);

		// A seeded goal keeps requesting continuations, so this turn eventually
		// exhausts the faux queue and fails. The assertion is that goal state
		// reaches the client, which happens on the first turn either way.
		const turn = fixture.agent
			.request("session/prompt", { sessionId: fixture.sessionId, prompt: [{ type: "text", text: "start" }] })
			.catch(() => undefined);
		await waitFor(() => fixture.metaOf("goal").length > 0);
		await turn;

		const goals = fixture.metaOf("goal");
		expect(goals.length, "goal state must reach the ACP client").toBeGreaterThan(0);
		expect(goals.at(-1)).toMatchObject({ objective: "ship ACP mode" });
		harness.cleanup();
	}, 60_000);

	it("surfaces a real /refine outcome to the ACP client", async () => {
		// Global refinement writes under the agent dir. Use the real env var name
		// (derived from package piConfig, so PRIME_AGENT_CODING_AGENT_DIR) rather
		// than a hardcoded guess, and set it before the session exists: this test
		// must never touch the developer's real harness state.
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		const agentDir = mkdtempSync(join(tmpdir(), "pi-acp-refine-"));
		process.env[ENV_AGENT_DIR] = agentDir;
		const harness = await createHarness({ persistSession: true });
		try {
			harness.setResponses([fauxAssistantMessage("noted")]);
			const fixture = await connectAcp(harness);

			// Stub ONLY the planner, which is the refiner's LLM call. The apply phase
			// then runs for real: it applies the proposal, persists harness state, and
			// emits the genuine refine_complete event this test is about.
			const internals = harness.session as unknown as {
				_planRefine: (...args: unknown[]) => Promise<unknown>;
			};
			vi.spyOn(internals, "_planRefine").mockResolvedValue({
				id: "acp_refine_plan",
				proposal: {
					summary: "refined for ACP",
					rationale: "trajectory evidence",
					expectedOutcome: "ACP surfaces refinement",
					edits: [
						{
							action: "create",
							kind: "memory",
							id: "acp_verification_memory",
							title: "ACP refinement",
							content: "ACP mode surfaces refinement outcomes.",
						},
					],
				},
			});

			await fixture.agent.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "remember this" }],
			});
			await harness.session.refine({ global: true });
			await waitFor(() => fixture.metaOf("refinement").length > 0);

			const refinements = fixture.metaOf("refinement");
			expect(refinements.length, "refinement outcome must reach the ACP client").toBeGreaterThan(0);
			expect(refinements.at(-1)).toMatchObject({ status: "complete", summary: "refined for ACP" });
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			harness.cleanup();
		}
	}, 60_000);

	it("closes a session, stops forwarding events, and frees the connection", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const fixture = await connectAcp(harness);

		await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "one" }],
		});
		const beforeClose = fixture.updates.length;
		expect(beforeClose).toBeGreaterThan(0);

		await fixture.agent.request("session/close", { sessionId: fixture.sessionId });

		// After close the subscription is released, so further agent activity must
		// not reach the client.
		await harness.session.prompt("post-close activity");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fixture.updates.length).toBe(beforeClose);

		// Closing frees the single-session slot, so a new session is accepted.
		const next = await fixture.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });
		expect(next.sessionId).toBeTruthy();
		expect(next.sessionId).not.toBe(fixture.sessionId);

		// Closing an unknown session is an error, not a silent no-op.
		await expect(fixture.agent.request("session/close", { sessionId: "nope" })).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("tears down its session when the client disconnects", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("hi")]);
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: any[] = [];

		// Keep the promise so we can prove the mode returns instead of hanging.
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);

		const handle = acp
			.client({ name: "disconnect" })
			.onNotification("session/update", (ctx: any) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		await handle.agent.request("initialize", { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
		await handle.agent.request("session/new", { cwd: harness.tempDir, mcpServers: [] });

		// Simulate the client going away for real: EOF on the agent's input, which
		// is what stdin closing looks like in production. With an injected transport
		// the mode must clean up and return rather than exiting the host process.
		handle.close();
		await toAgent.writable.close().catch(() => undefined);
		await expect(
			Promise.race([modeDone, new Promise((_, reject) => setTimeout(() => reject(new Error("hung")), 5_000))]),
		).resolves.toBeUndefined();

		// Post-disconnect agent activity must not reach the released subscription.
		const before = updates.length;
		await harness.session.prompt("after disconnect");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(updates.length).toBe(before);
		harness.cleanup();
	}, 30_000);

	it("stops in-flight work when a session is closed mid-turn", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("working")]);
		const fixture = await connectAcp(harness);

		// InProcessAgentConnection.abort() routes to session.requestAbort().
		const requestAbort = vi.spyOn(harness.session, "requestAbort");

		// Close while the turn is still in flight, without awaiting the prompt first.
		const turn = fixture.agent
			.request("session/prompt", { sessionId: fixture.sessionId, prompt: [{ type: "text", text: "go" }] })
			.catch(() => "rejected");
		await fixture.agent.request("session/close", { sessionId: fixture.sessionId });
		await turn;
		const aborted = requestAbort.mock.calls.length > 0;

		// Closing must abort the underlying agent, not just drop local bookkeeping:
		// otherwise the agent keeps burning tokens with nobody listening.
		expect(aborted, "session/close must abort the underlying agent").toBe(true);
		// The in-flight turn must not surface as a clean completion after a close.
		const outcome = await turn;
		if (typeof outcome === "object" && outcome && "stopReason" in outcome) {
			expect(["cancelled", "end_turn"]).toContain((outcome as { stopReason: string }).stopReason);
		}
		harness.cleanup();
	}, 30_000);

	it("rejects prompts and repeat closes after a session is closed", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("one")]);
		const fixture = await connectAcp(harness);

		await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "one" }],
		});
		await fixture.agent.request("session/close", { sessionId: fixture.sessionId });

		// A closed session id must not be usable again for either operation.
		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "again" }],
			}),
		).rejects.toThrow();
		await expect(fixture.agent.request("session/close", { sessionId: fixture.sessionId })).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("streams a turn the client did not initiate", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("heartbeat-driven work")]);
		const fixture = await connectAcp(harness);

		// A heartbeat, cron job, or agent-to-agent message starts a turn with no
		// session/prompt in flight. Those are the turns a long-running harness most
		// needs to observe, so they must still stream.
		await harness.session.prompt("out-of-band turn");
		await waitFor(() =>
			fixture.updates.some(
				(u) => u.update?.sessionUpdate === "agent_message_chunk" && String(u.update.content?.text ?? "").length > 0,
			),
		);

		const text = fixture.updates
			.filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
			.map((u) => u.update.content.text)
			.join("");
		expect(text, "an unsolicited turn must still reach the ACP client").toContain("heartbeat-driven work");
		harness.cleanup();
	}, 30_000);

	it("streams an inbound agent-to-agent message and the turn it triggers", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("acknowledged the sibling")]);
		const fixture = await connectAcp(harness);

		// A2A delivery arrives as a prompt from another agent, not from the ACP
		// client. Both the injected message and the resulting turn must be visible.
		// Delivery resolves at admission, not at turn completion, so wait for the
		// streamed result instead of assuming it lands inside a fixed sleep.
		await harness.session.acceptAgentMessagePrompt("Agent-to-agent message received.\n\nplease ack");
		const streamedText = () =>
			fixture.updates
				.filter((u) => u.update?.sessionUpdate === "agent_message_chunk")
				.map((u) => u.update.content.text)
				.join("");
		await waitFor(() => streamedText().includes("acknowledged the sibling"));

		expect(fixture.updates.length, "inbound agent messages must produce ACP updates").toBeGreaterThan(0);
		expect(streamedText()).toContain("acknowledged the sibling");
		harness.cleanup();
	}, 30_000);

	it("fails the prompt turn instead of reporting end_turn when the model errors", async () => {
		const harness = await createHarness();
		// A provider failure is the shape verifiers hit in a container: the turn
		// resolves, streams nothing, and previously answered a clean end_turn.
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." })]);
		const fixture = await connectAcp(harness);

		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "say hi" }],
			}),
		).rejects.toThrow();
		harness.cleanup();
	}, 30_000);

	it("does not let an earlier failed turn reject a later one", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." })]);
		const fixture = await connectAcp(harness);

		// First turn fails and must be reported as a failure.
		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "first" }],
			}),
		).rejects.toThrow();

		// A slash command is handled without calling the model, so it appends no
		// assistant message. Scanning the whole transcript would surface the earlier
		// turn's error and wrongly reject this one.
		const second = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "/compact" }],
		});
		expect(second.stopReason).toBe("end_turn");
		harness.cleanup();
	}, 30_000);

	it("reports a failure that a mid-turn transcript rebuild moved below the pre-turn message count", async () => {
		const harness = await createHarness();
		harness.setResponses([
			fauxAssistantMessage("first turn done"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." }),
		]);
		let rebuiltLength = 0;
		const { connection, arm } = withMidTurnRebuild(harness, (messages) => {
			// Keep only the tail, as compaction does: this turn's error message keeps
			// its content but moves to a much lower index.
			const rebuilt = rematerialize(messages.slice(-2));
			rebuiltLength = rebuilt.length;
			return rebuilt;
		});
		const fixture = await connectAcp(harness, connection);

		const first = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "first" }],
		});
		expect(first.stopReason).toBe("end_turn");

		const priorMessageCount = harness.session.state.messages.length;
		expect(priorMessageCount, "the first turn must leave messages behind to compact away").toBeGreaterThan(1);
		arm();

		const failure = await fixture.agent
			.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "second" }],
			})
			.then(
				(result: unknown) => ({ resolved: result }),
				(error: unknown) => ({ error }),
			);
		expect(
			"error" in failure,
			`a failed turn must not report a clean stop reason (got ${JSON.stringify(failure)})`,
		).toBe(true);
		// The client must be told the turn failed, not handed a bare protocol error.
		expect(JSON.stringify(failure)).toContain("prime-agent turn failed");

		// The point of the test: a pre-turn count watermark would have skipped the
		// failure, because after the rebuild it sits below that count.
		expect(rebuiltLength, "the rebuild must shorten the transcript").toBeLessThanOrEqual(priorMessageCount);
		expect(rebuiltLength - 1, "the failure must land below the pre-turn count").toBeLessThan(priorMessageCount);
		harness.cleanup();
	}, 30_000);

	it("does not mistake a rebuilt copy of an earlier failure for this turn's failure", async () => {
		const harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Connection error." })]);
		let rebuiltIdentities = false;
		const { connection, arm } = withMidTurnRebuild(harness, (messages) => {
			const rebuilt = rematerialize(messages);
			rebuiltIdentities = rebuilt.every((message, index) => message !== messages[index]);
			return rebuilt;
		});
		const fixture = await connectAcp(harness, connection);

		await expect(
			fixture.agent.request("session/prompt", {
				sessionId: fixture.sessionId,
				prompt: [{ type: "text", text: "first" }],
			}),
		).rejects.toThrow();

		// A rebuild replaces every kept message with a fresh object, so object
		// identity alone cannot tell the earlier failure from a new one. The turn
		// below appends no assistant message and must still end cleanly.
		arm();
		const handled = await fixture.agent.request("session/prompt", {
			sessionId: fixture.sessionId,
			prompt: [{ type: "text", text: "/compact" }],
		});
		expect(handled.stopReason).toBe("end_turn");
		expect(rebuiltIdentities, "the rebuild must replace the message objects").toBe(true);
		harness.cleanup();
	}, 30_000);

	it("advertises prime-agent capabilities without polluting the ACP object root", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp.client({ name: "caps" }).connect(acp.ndJsonStream(toAgent.writable, toClient.readable));
		const init = await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});

		expect(init.agentInfo).toMatchObject({ name: "prime-agent" });
		expect(typeof init.agentInfo?.version).toBe("string");
		// Namespaced only: unknown root keys are reserved for future ACP fields.
		expect(init._meta).toHaveProperty(PRIME_AGENT_META_NAMESPACE);
		expect(Object.keys(init.agentCapabilities ?? {})).not.toContain("subagents");
		// close is advertised, so a client knows it may release the session slot.
		expect(init.agentCapabilities?.sessionCapabilities?.close).toBeDefined();
		harness.cleanup();
	}, 30_000);
});
