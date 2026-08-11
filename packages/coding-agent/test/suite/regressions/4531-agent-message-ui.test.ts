import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message, type ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyRelationship,
	type AgentSessionMessage,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
	formatAgentMessageParticipant,
	isAgentSessionMessage,
	isAgentSessionMessagePrompt,
} from "../../../src/core/agent-messages.js";
import type { KernelSentAgentMessage } from "../../../src/core/kernel/index.js";
import { AgentMessageComponent } from "../../../src/modes/interactive/components/agent-message.js";
import {
	buildConversationComponents,
	isCompactAgentMessageNeighbor,
} from "../../../src/modes/interactive/components/conversation-components.js";
import { IPythonCellComponent } from "../../../src/modes/interactive/components/ipython-cell.js";
import { formatQueuedMessagePreview, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

function createPayload(message: string): AgentSessionMessagePayload {
	return {
		id: "agentmsg_4531",
		source: AGENT_MESSAGE_SOURCE,
		message,
		from: {
			activeSessionId: "planner-active",
			sessionId: "planner-session",
			sessionName: "Planner",
		},
		target: {
			activeSessionId: "worker-active",
			sessionId: "worker-session",
			sessionName: "Worker",
		},
	};
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: AgentMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

type LateSentAgentMessageHost = {
	_recordLateIpythonSentAgentMessage: (toolCallId: string, message: KernelSentAgentMessage) => void;
	_agentEventQueue: Promise<void>;
	_lateIpythonSentAgentMessages: Map<string, KernelSentAgentMessage[]>;
	_restoreLateIpythonSentAgentMessages: () => void;
};

describe("ENG-4531 agent message UI", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("records delivered agent messages as custom transcript entries while preserving provider input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Review the benchmark notes.");
		const prompt = createAgentSessionMessagePrompt(payload);
		const message = createAgentSessionMessage(payload);
		let providerMessages: Message[] = [];
		harness.setResponses([
			(context) => {
				providerMessages = [...context.messages];
				return fauxAssistantMessage("Reviewed.");
			},
		]);

		await harness.session.acceptAgentMessagePrompt(prompt, { customMessage: message });
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: "agent_message",
			display: true,
		});
		expect(getMessageText(providerMessages.at(-1))).toBe(prompt);
		expect(providerMessages.at(-1)?.role).toBe("user");
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "agent_message"),
		).toBe(true);
	});

	it("leaves text-only agent envelopes as user messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const prompt = createAgentSessionMessagePrompt(createPayload("Previously persisted message."));
		harness.setResponses([fauxAssistantMessage("Handled.")]);

		await harness.session.acceptAgentMessagePrompt(prompt);
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([prompt]);
		expect(harness.session.messages[0]?.role).toBe("user");
	});

	it("preserves structured messages passed through the normal prompt path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Run the idle-session review.");
		const prompt = createAgentSessionMessagePrompt(payload);
		harness.setResponses([fauxAssistantMessage("Handled.")]);

		await harness.session.prompt(prompt, {
			expandPromptTemplates: false,
			customMessage: createAgentSessionMessage(payload),
		});
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.session.messages[0]).toMatchObject({
			role: "custom",
			customType: "agent_message",
			details: { id: "agentmsg_4531", message: "Run the idle-session review." },
		});
	});

	it("keeps queued agent messages structured and removable by message identity", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const payload = createPayload("Use shard seven.");
		const prompt = createAgentSessionMessagePrompt(payload);
		const message = createAgentSessionMessage(payload);

		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);

		expect(harness.session.getFollowUpMessagePreviews()).toEqual(["Agent message received: Use shard seven."]);
		const queued = harness.session.getSessionActionRecoverySnapshot().actions[0];
		expect(queued?.payload.kind === "turn" ? queued.payload.customMessage : undefined).toMatchObject({
			customType: "agent_message",
			details: { id: "agentmsg_4531", message: "Use shard seven." },
		});
		expect(harness.session.clearQueuedUserMessagesMatching(isAgentSessionMessagePrompt)).toEqual({
			steering: [],
			followUp: [prompt],
		});
	});

	it("does not add a second queue label to agent message previews", () => {
		expect(formatQueuedMessagePreview("Agent message received: Use shard seven.", "Follow-up")).toBe(
			"Agent message received: Use shard seven.",
		);
		expect(formatQueuedMessagePreview("Run the remaining checks.", "Steering")).toBe(
			"Steering: Run the remaining checks.",
		);
	});

	it("persists sent messages that arrive after their Python cell completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "ipython_4531",
			toolName: "ipython",
			content: [{ type: "text", text: "" }],
			details: { status: "ok" },
			isError: false,
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("ipython", { code: "background_send" }), { stopReason: "toolUse" }),
		);
		harness.session.sessionManager.appendMessage(toolResult);
		harness.session.agent.state.messages.push(toolResult);
		const lateMessage = {
			id: "agentmsg_late_4531",
			message: "Background review finished.",
			deliveryStatus: "delivered" as const,
			target: {
				activeSessionId: "worker-active",
				sessionId: "worker-session",
				sessionName: "Worker",
			},
		};
		const events: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
		const host = harness.session as unknown as LateSentAgentMessageHost;

		host._recordLateIpythonSentAgentMessage(toolResult.toolCallId, lateMessage);
		await host._agentEventQueue;
		unsubscribe();

		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "ipython_sent_agent_message"),
		).toBe(true);
		expect(events).toContain("ipython_sent_agent_message");
		expect(
			harness.session
				.buildSessionContext()
				.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolResult.toolCallId,
				)?.details,
		).toMatchObject({ sentAgentMessages: [lateMessage] });

		toolResult.details = { status: "ok" };
		host._restoreLateIpythonSentAgentMessages();
		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });

		toolResult.details = { status: "ok" };
		host._lateIpythonSentAgentMessages = new Map();
		host._restoreLateIpythonSentAgentMessages();
		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });

		host._lateIpythonSentAgentMessages.set("ipython_other_branch", [
			{
				id: "agentmsg_other_branch",
				message: "Stale branch receipt.",
				deliveryStatus: "delivered",
				target: { activeSessionId: "other", sessionId: "other-session" },
			},
		]);
		host._restoreLateIpythonSentAgentMessages();
		expect(host._lateIpythonSentAgentMessages.has("ipython_other_branch")).toBe(false);
	});

	it("preserves the custom message when direct delivery races with active work", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Original turn complete."),
			fauxAssistantMessage("Agent message handled."),
		]);
		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("Start work.");
		await sawToolStart;
		const payload = createPayload("Queue behind the active turn.");
		const prompt = createAgentSessionMessagePrompt(payload);

		await harness.session.acceptAgentMessagePrompt(prompt, {
			customMessage: createAgentSessionMessage(payload),
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});

		const queued = harness.session.getSessionActionRecoverySnapshot().actions[0];
		expect(queued?.payload.kind === "turn" ? queued.payload.customMessage : undefined).toMatchObject({
			customType: "agent_message",
			details: { message: "Queue behind the active turn." },
		});
		releaseToolExecution?.();
		await promptPromise;
		await harness.session.agent.waitForIdle();
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "agent_message",
			),
		).toBe(true);
	});

	it.each([
		["received", "parent", { sessionName: "Planner" }, "from parent Planner"],
		["received", "parent", {}, "from parent unknown"],
		["sent", "parent", { activeSessionId: "parent-active" }, "to parent parent-active"],
		["sent", "parent", {}, "to parent unknown"],
		["received", "sibling", { clientId: "sibling-client" }, "from sibling sibling-client"],
		["received", "sibling", {}, "from sibling unknown"],
		["sent", "sibling", { sessionId: "sibling-session" }, "to sibling sibling-session"],
		["sent", "sibling", {}, "to sibling unknown"],
		["received", "child", { sessionName: "Worker" }, "from child Worker"],
		["received", "child", {}, "from child unknown"],
		["sent", "child", { sessionName: "Worker" }, "to child Worker"],
		["sent", "child", {}, "to child unknown"],
		["received", undefined, { sessionName: "Legacy" }, "from Legacy"],
		["sent", undefined, {}, "to unknown"],
	] as const)("formats %s %s agent-message participants", (direction, role, endpoint, expected) => {
		expect(formatAgentMessageParticipant(direction, role as AgentFamilyRelationship | undefined, endpoint)).toBe(
			expected,
		);
	});

	it("classifies a spawn task as an agent message component", () => {
		const spawnMessage: AgentSessionMessage = {
			role: "custom",
			customType: "agent_message",
			content: "[task from parent]\n\nReview shard seven.",
			display: true,
			details: {
				id: "spawn:sub-worker",
				message: "Review shard seven.",
				from: { sessionId: "parent-session", sessionName: "Planner" },
				fromRelationship: "parent",
			},
			timestamp: 123,
		};

		const components = buildConversationComponents([spawnMessage], {
			ui: { requestRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		});

		expect(components).toHaveLength(1);
		expect(components[0]).toBeInstanceOf(AgentMessageComponent);
		expect(render(components[0] as AgentMessageComponent)).toContain("Agent message received · from parent Planner");
	});

	it("uses compact rebuilt spacing for agent messages next to messages and tool cells", () => {
		const first = createAgentSessionMessage(createPayload("First notification."));
		const second = createAgentSessionMessage({ ...createPayload("Second notification."), id: "agentmsg_4531_2" });
		const toolCall = fauxAssistantMessage(fauxToolCall("ipython", { code: "print('ready')" }), {
			stopReason: "toolUse",
		});
		const options = {
			ui: { requestRender: () => {} } as unknown as TUI,
			cwd: "/tmp",
			toolOptions: {},
			getToolDefinition: () => undefined,
		};

		expect(isCompactAgentMessageNeighbor(new IPythonCellComponent({ code: "print('direct')" }))).toBe(true);

		const adjacent = buildConversationComponents([first, second], options);
		expect(adjacent).toHaveLength(2);
		expect(adjacent[0]?.render(120)[0]).toBe("");
		expect(adjacent[1]?.render(120)[0]).not.toBe("");

		const toolThenMessage = buildConversationComponents([toolCall, second], options);
		expect(toolThenMessage.at(-1)?.render(120)[0]).not.toBe("");
		const messageThenTool = buildConversationComponents([first, toolCall], options);
		expect(messageThenTool.at(-1)?.render(120)[0]).not.toBe("");

		const userThenMessage = buildConversationComponents(
			[{ role: "user", content: "intervening prompt", timestamp: 123 }, second] as AgentMessage[],
			options,
		);
		expect(userThenMessage[1]?.render(120)[0]).toBe("");

		const assistantThenMessage = buildConversationComponents(
			[fauxAssistantMessage("intervening response"), second],
			options,
		);
		expect(assistantThenMessage[1]?.render(120)[0]).toBe("");
	});

	it("suppresses live spacing between agent messages and following tool activity", () => {
		const chatContainer = new Container();
		const mode = {
			chatContainer,
			toolOutputExpanded: false,
			getMarkdownThemeWithSettings: () => undefined,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const addMessage = (message: AgentMessage) =>
			Reflect.get(InteractiveMode.prototype, "addMessageToChat").call(mode, message);
		const first = createAgentSessionMessage(createPayload("First notification."));
		const second = createAgentSessionMessage({ ...createPayload("Second notification."), id: "agentmsg_4531_2" });

		addMessage(first);
		addMessage(second);
		expect(chatContainer.children[0]?.render(120)[0]).toBe("");
		expect(chatContainer.children[1]?.render(120)[0]).not.toBe("");

		addMessage(fauxAssistantMessage(fauxToolCall("ipython", { code: "print('live')" }), { stopReason: "toolUse" }));
		expect(chatContainer.children[2]?.render(120)[0]).not.toBe("");

		const toolComponents = buildConversationComponents(
			[fauxAssistantMessage(fauxToolCall("ipython", { code: "print('ready')" }), { stopReason: "toolUse" })],
			{
				ui: { requestRender: () => {} } as unknown as TUI,
				cwd: "/tmp",
				toolOptions: {},
				getToolDefinition: () => undefined,
			},
		);
		const toolComponent = toolComponents.at(-1);
		if (!toolComponent) throw new Error("Missing tool component");
		chatContainer.addChild(toolComponent);
		addMessage(second);
		expect(chatContainer.children[4]?.render(120)[0]).not.toBe("");

		chatContainer.addChild(new Container());
		addMessage(second);
		expect(chatContainer.children[6]?.render(120)[0]).toBe("");
	});

	it("renders persisted agent messages with a null sender", () => {
		const persistedMessage: AgentMessage = {
			role: "custom",
			customType: "agent_message",
			content: "Persisted message.",
			display: true,
			details: {
				id: "agentmsg_persisted",
				message: "Persisted message.",
				from: null,
			},
			timestamp: 123,
		};

		expect(isAgentSessionMessage(persistedMessage)).toBe(true);
		if (!isAgentSessionMessage(persistedMessage)) throw new Error("Expected an agent session message");
		expect(render(new AgentMessageComponent(persistedMessage))).toContain("Agent message received · from unknown");
	});

	it("renders relationship-aware sender labels with identifier fallbacks", () => {
		const parent = createAgentSessionMessage({ ...createPayload("From root."), fromRelationship: "parent" });
		const sibling = createAgentSessionMessage({
			...createPayload("From peer."),
			from: { sessionId: "peer-session", sessionName: "Peer" },
			fromRelationship: "sibling",
		});
		const childById = createAgentSessionMessage({
			...createPayload("From child."),
			from: { sessionId: "child-session" },
			fromRelationship: "child",
		});
		const unknownRelationship = createAgentSessionMessage({
			...createPayload("Legacy sender."),
			from: { sessionId: "legacy-session" },
		});

		expect(render(new AgentMessageComponent(parent))).toContain("Agent message received · from parent Planner");
		expect(render(new AgentMessageComponent(sibling))).toContain("Agent message received · from sibling Peer");
		expect(render(new AgentMessageComponent(childById))).toContain(
			"Agent message received · from child child-session",
		);
		expect(render(new AgentMessageComponent(unknownRelationship))).toContain(
			"Agent message received · from legacy-session",
		);
		const expanded = new AgentMessageComponent(sibling);
		expanded.setExpanded(true);
		expect(render(expanded)).toContain("Agent message received · from sibling Peer");
	});

	it("renders a compact row and an aligned multiline gutter when expanded", () => {
		const body = "Reply to your parent with exactly: hi\nThen wait for more work.";
		const component = new AgentMessageComponent(createAgentSessionMessage(createPayload(body)));
		const collapsed = render(component);

		expect(collapsed).toContain("◆ Agent message received · from Planner");
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("Then wait for more work.");

		component.setExpanded(true);
		const expanded = render(component);
		expect(expanded).toContain("to collapse");
		const expandedLines = expanded.split("\n");
		expect(expandedLines[1]?.trimEnd()).toMatch(/^ ◆ Agent message received · from Planner \(.*to collapse\)$/);
		expect(expandedLines.slice(2)).toEqual([
			" ╰─ Reply to your parent with exactly: hi",
			"    Then wait for more work.",
		]);
		expect(expanded).not.toContain("Source: agent_message");
		expect(expanded).not.toContain("Message id:");
	});

	it("renders sent messages beneath collapsed Python cells", () => {
		const component = new IPythonCellComponent({
			code: 'await agent_message.send("worker-active", "Review shard seven.")',
			executionStarted: true,
			details: {
				status: "ok",
				sentAgentMessages: [
					{
						id: "agentmsg_4531",
						message: "Review shard seven.",
						deliveryStatus: "queued",
						receiverRole: "child",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
					{
						id: "agentmsg_4531_delivered",
						message: "Continue with shard eight.",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		const lines = rendered.split("\n");
		expect(lines).toEqual([
			expect.stringContaining("python"),
			" ◆ Agent message queued · to child Worker · Review shard seven.",
			" ◆ Agent message sent · to parent Worker · Continue with shard eight.",
		]);
		expect(rendered).not.toContain("Agent message received");
	});

	it("expands sent messages to the message text without the receipt metadata", () => {
		const receipt =
			"{'id': 'agentmsg_4531_delivered',\n" +
			" 'source': 'agent_message',\n" +
			" 'target': {'activeSessionId': 'worker-active', 'sessionId': 'worker-session'},\n" +
			" 'message': 'Continue with shard eight.\\nThen report back.',\n" +
			" 'deliveryStatus': 'delivered',\n" +
			" 'deliveryMode': 'steer'}";
		const component = new IPythonCellComponent({
			code: 'await agent_message.send("Continue with shard eight.", receiver_role="parent")',
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			details: {
				status: "ok",
				result: receipt,
				sentAgentMessages: [
					{
						id: "agentmsg_4531_delivered",
						message: "Continue with shard eight.\nThen report back.",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		const lines = rendered.split("\n").filter((line) => line.trim().length > 0);
		expect(lines).toEqual([
			expect.stringContaining("python"),
			expect.stringContaining("await agent_message.send"),
			" ◆ Agent message sent · to parent Worker",
			" ╰─ Continue with shard eight.",
			"    Then report back.",
		]);
		expect(rendered).not.toContain("deliveryStatus");
		expect(rendered).not.toContain("agentmsg_4531_delivered");
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain("· Continue with shard eight.");
	});

	it("keeps broadcast receipt lists with failed deliveries visible next to sent messages", () => {
		const receipts =
			"{'receipts': [{'id': 'agentmsg_4531_broadcast',\n" +
			"   'deliveryStatus': 'delivered',\n" +
			"   'message': 'Status check.'},\n" +
			"  {'target': 'worker-two', 'error': 'session is inactive'}]}";
		const component = new IPythonCellComponent({
			code: 'await agent_message.send("all", "Status check.")',
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			details: {
				status: "ok",
				result: receipts,
				sentAgentMessages: [
					{
						id: "agentmsg_4531_broadcast",
						message: "Status check.",
						deliveryStatus: "delivered",
						receiverRole: "child",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain(" ◆ Agent message sent · to child Worker");
		expect(rendered).toContain("'error': 'session is inactive'");
	});

	it("keeps results that merely mention a sent-message id visible", () => {
		const component = new IPythonCellComponent({
			code: "record_reply()",
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			details: {
				status: "ok",
				result: "{'referenced_message': 'agentmsg_4531_ref', 'answer': 42}",
				sentAgentMessages: [
					{
						id: "agentmsg_4531_ref",
						message: "Ping.",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("'answer': 42");
	});

	it("keeps unrelated results visible next to sent messages", () => {
		const component = new IPythonCellComponent({
			code: 'await agent_message.send("Ping.", receiver_role="parent")\n"done"',
			executionStarted: true,
			argsComplete: true,
			expanded: true,
			details: {
				status: "ok",
				result: "'done'",
				sentAgentMessages: [
					{
						id: "agentmsg_4531_result",
						message: "Ping.",
						deliveryStatus: "delivered",
						receiverRole: "parent",
						target: {
							activeSessionId: "worker-active",
							sessionId: "worker-session",
							sessionName: "Worker",
						},
					},
				],
			},
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain(" ◆ Agent message sent · to parent Worker");
		expect(rendered).toContain(" ╰─ Ping.");
		expect(rendered).toContain("done");
	});
});
