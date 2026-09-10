import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { buildConversationComponents } from "../src/modes/interactive/components/conversation-components.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
} from "../src/modes/interactive/components/tool-execution.js";
import {
	formatToolRunGroupHeader,
	ToolRunGroupComponent,
	ToolRunGrouper,
} from "../src/modes/interactive/components/tool-run-group.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const uiStub: TUI = { requestRender: () => {} } as unknown as TUI;
const cwd = "/tmp";

function createToolResult(toolCallId: string, toolName: string, output: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: output }],
		isError: false,
		timestamp: Date.now(),
	};
}

const userMessage: AgentMessage = { role: "user", content: "run the cells", timestamp: 1 };

/** Components from a reload-style build of the persisted message list. */
function reloadBuild(messages: readonly AgentMessage[]): Component[] {
	return buildConversationComponents(messages, {
		ui: uiStub,
		cwd,
		toolOptions: {},
		getToolDefinition: () => undefined,
		hideThinkingBlock: true,
	});
}

function groupsOf(components: readonly Component[]): ToolRunGroupComponent[] {
	return components.filter(
		(component): component is ToolRunGroupComponent => component instanceof ToolRunGroupComponent,
	);
}

function render(component: Component | undefined): string {
	if (!component) {
		return "";
	}
	return stripAnsi(component.render(120).join("\n")).replace(/\d+\.\ds/g, "<duration>");
}

interface StreamingFeed {
	components: Component[];
	grouper: ToolRunGrouper;
	tools: Map<string, ToolExecutionComponent>;
}

function createStreamingFeed(): StreamingFeed {
	const components: Component[] = [];
	return {
		components,
		grouper: new ToolRunGrouper((component) => {
			components.push(component);
		}),
		tools: new Map(),
	};
}

/**
 * Deliver one message the way interactive-mode streams it: assistant messages
 * arrive as cumulative content updates, tool calls mount through the grouper,
 * and a turn-ending message closes the segment exactly like message_end.
 */
async function deliverStreamingMessage(feed: StreamingFeed, message: AgentMessage): Promise<void> {
	if (message.role === "assistant") {
		for (let end = 1; end <= message.content.length; end++) {
			const partial: AssistantMessage = { ...message, content: message.content.slice(0, end) };
			for (const content of partial.content) {
				if (content.type === "text" && content.text.trim().length > 0) {
					feed.grouper.noteAssistantText();
				} else if (content.type === "toolCall" && !feed.tools.has(content.id)) {
					const component = new ToolExecutionComponent(
						content.name,
						content.id,
						content.arguments,
						{},
						undefined,
						uiStub,
						cwd,
					);
					selectLatestToolExpandHint(feed.components, component);
					feed.grouper.mountToolExecution(component);
					feed.tools.set(content.id, component);
				}
			}
		}
		if (message.stopReason !== "toolUse") {
			feed.grouper.close();
		}
	} else if (message.role === "toolResult") {
		feed.tools.get(message.toolCallId)?.updateResult(message);
	} else if (message.role === "user") {
		feed.grouper.noteConversationRow();
	}
}

/** Replay a full message list as a live stream, closing the segment at turn end. */
async function streamFeed(messages: readonly AgentMessage[]): Promise<StreamingFeed> {
	const feed = createStreamingFeed();
	for (const message of messages) {
		await deliverStreamingMessage(feed, message);
	}
	feed.grouper.close();
	return feed;
}

describe("tool run groups", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("formats digit counts and flips to ran when complete", () => {
		expect(formatToolRunGroupHeader({ bash: 1, ipython: 0 }, false)).toBe("Running 1 shell command");
		expect(formatToolRunGroupHeader({ bash: 2, ipython: 0 }, false)).toBe("Running 2 shell commands");
		expect(formatToolRunGroupHeader({ bash: 0, ipython: 1 }, false)).toBe("Running 1 Python cell");
		expect(formatToolRunGroupHeader({ bash: 0, ipython: 3 }, false)).toBe("Running 3 Python cells");
		expect(formatToolRunGroupHeader({ bash: 2, ipython: 1 }, false)).toBe("Running 2 shell commands · 1 Python cell");
		expect(formatToolRunGroupHeader({ bash: 1, ipython: 0 }, true)).toBe("Ran 1 shell command");
		expect(formatToolRunGroupHeader({ bash: 0, ipython: 3 }, true)).toBe("Ran 3 Python cells");
		expect(formatToolRunGroupHeader({ bash: 2, ipython: 1 }, true)).toBe("Ran 2 shell commands · 1 Python cell");
	});

	it("increments the same group and settles on ran as consecutive cells stream in", async () => {
		const feed = createStreamingFeed();
		const group = (): ToolRunGroupComponent | undefined => groupsOf(feed.components)[0];

		await deliverStreamingMessage(feed, userMessage);
		await deliverStreamingMessage(
			feed,
			fauxAssistantMessage(fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-a" }), {
				stopReason: "toolUse",
			}),
		);
		expect(feed.components).toHaveLength(1);
		expect(render(group())).toContain("Running 1 Python cell");

		await deliverStreamingMessage(
			feed,
			fauxAssistantMessage(fauxToolCall("ipython", { code: "y = 2" }, { id: "cell-b" }), {
				stopReason: "toolUse",
			}),
		);
		expect(feed.components).toHaveLength(1);
		expect(render(group())).toContain("Running 2 Python cells");

		await deliverStreamingMessage(feed, createToolResult("cell-a", "ipython", "ok"));
		await deliverStreamingMessage(feed, createToolResult("cell-b", "ipython", "ok"));
		await deliverStreamingMessage(
			feed,
			fauxAssistantMessage(fauxToolCall("ipython", { code: "z = 3" }, { id: "cell-c" }), {
				stopReason: "toolUse",
			}),
		);
		expect(feed.components).toHaveLength(1);
		const finalGroup = group();
		if (!finalGroup) throw new Error("Expected a run group");
		expect(finalGroup.getToolComponents()).toHaveLength(3);
		expect(render(finalGroup)).toContain("Running 3 Python cells");

		await deliverStreamingMessage(feed, createToolResult("cell-c", "ipython", "ok"));
		expect(render(group())).toContain("Ran 3 Python cells");
	});

	it("mounts the group the moment the tool call starts streaming", async () => {
		const feed = createStreamingFeed();
		// toolcall_start delivers the block with the name but empty arguments.
		const cell = fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-partial" });
		const startMessage = fauxAssistantMessage({ ...cell, arguments: {} }, { stopReason: "toolUse" });

		await deliverStreamingMessage(feed, userMessage);
		await deliverStreamingMessage(feed, startMessage);

		const groups = groupsOf(feed.components);
		expect(groups).toHaveLength(1);
		expect(render(groups[0])).toContain("Running 1 Python cell");
		// The nested row renders immediately with the partial state.
		expect(render(groups[0])).toContain("waiting for code");
	});

	it("renders the identical grouping from the persisted sequence", async () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-a" }),
					fauxToolCall("ipython", { code: "y = 2" }, { id: "cell-b" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-a", "ipython", "ok"),
			createToolResult("cell-b", "ipython", "ok"),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "z = 3" }, { id: "cell-c" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-c", "ipython", "ok"),
		];

		const feed = await streamFeed(messages);
		const reloaded = reloadBuild(messages);

		const streamedGroups = groupsOf(feed.components);
		const reloadedGroups = groupsOf(reloaded);
		expect(streamedGroups).toHaveLength(1);
		expect(reloadedGroups).toHaveLength(1);
		const streamedGroup = streamedGroups[0];
		const reloadedGroup = reloadedGroups[0];
		if (!streamedGroup || !reloadedGroup) throw new Error("Expected run groups");
		expect(render(streamedGroup)).toBe(render(reloadedGroup));
		expect(streamedGroup.getToolComponents()).toHaveLength(reloadedGroup.getToolComponents().length);
	});

	it("splits segments at text output and crosses past thinking-only messages", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxThinking("First cell next."),
					fauxText("Rendering the first frame."),
					fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-a" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-a", "ipython", "ok"),
			fauxAssistantMessage(
				[
					fauxText("A spinning torus. Now a second pass."),
					fauxToolCall("ipython", { code: "y = 2" }, { id: "cell-b" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-b", "ipython", "ok"),
			fauxAssistantMessage(
				[fauxThinking("One more."), fauxToolCall("ipython", { code: "z = 3" }, { id: "cell-c" })],
				{
					stopReason: "toolUse",
				},
			),
			createToolResult("cell-c", "ipython", "ok"),
		];

		const components = reloadBuild(messages);
		const groups = groupsOf(components);
		// Text output between tool calls starts a fresh segment; the
		// thinking-only follow-up never breaks one.
		expect(groups).toHaveLength(2);
		expect(render(groups[0])).toContain("Ran 1 Python cell");
		expect(render(groups[1])).toContain("Ran 2 Python cells");
		// The notes render as assistant text, each above the group it precedes.
		const noteIndex = components.findIndex((component) => render(component).includes("A spinning torus."));
		expect(noteIndex).toBeGreaterThan(-1);
		expect(components.indexOf(groups[0])).toBeLessThan(noteIndex);
		expect(noteIndex).toBeLessThan(components.indexOf(groups[1]));
	});

	it("resets the segment at the model's text output", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(fauxToolCall("ipython", { code: "a = 1" }, { id: "cell-a" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-a", "ipython", "ok"),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "b = 2" }, { id: "cell-b" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-b", "ipython", "ok"),
			fauxAssistantMessage("Checking the values.", { stopReason: "stop" }),
			fauxAssistantMessage(fauxToolCall("ipython", { code: "c = 3" }, { id: "cell-c" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-c", "ipython", "ok"),
		];

		const groups = groupsOf(reloadBuild(messages));
		expect(groups).toHaveLength(2);
		expect(render(groups[0])).toContain("Ran 2 Python cells");
		expect(render(groups[1])).toContain("Ran 1 Python cell");
	});

	it("renders every cell in interleaved text runs with single blank separators", async () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxThinking("Planning."),
					fauxText("The worker flagged a concern — verifying now:"),
					fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-a" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-a", "ipython", "ok"),
			fauxAssistantMessage(
				[
					fauxThinking("Digging deeper."),
					fauxText("Found it — cleaning the environment:"),
					fauxToolCall("ipython", { code: "y = 2" }, { id: "cell-b" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-b", "ipython", "ok"),
			fauxAssistantMessage(
				[fauxThinking("One more check."), fauxToolCall("ipython", { code: "z = 3" }, { id: "cell-c" })],
				{ stopReason: "toolUse" },
			),
			createToolResult("cell-c", "ipython", "ok"),
			fauxAssistantMessage("All clean — 214/214 verified.", { stopReason: "stop" }),
		];

		const components = reloadBuild(messages);
		const groups = groupsOf(components);
		// Each narration text starts a fresh segment; the thinking-only
		// follow-up joins the open group.
		expect(groups).toHaveLength(2);
		expect(render(groups[0])).toContain("Ran 1 Python cell");
		expect(render(groups[1])).toContain("Ran 2 Python cells");
		// Every cell renders — no swallowed rows.
		const renderedCells = [render(groups[0]), render(groups[1])].join("\n");
		for (const code of ["x = 1", "y = 2", "z = 3"]) {
			expect(renderedCells).toContain(code);
		}
		// Chronology: each narration text renders above the group it precedes,
		// and the final answer renders after the last group.
		const indexOfText = (needle: string): number =>
			components.findIndex((component) => render(component).includes(needle));
		expect(indexOfText("verifying now:")).toBeLessThan(components.indexOf(groups[0]));
		expect(indexOfText("cleaning the environment")).toBeGreaterThan(components.indexOf(groups[0]));
		expect(indexOfText("cleaning the environment")).toBeLessThan(components.indexOf(groups[1]));
		expect(indexOfText("214/214 verified")).toBeGreaterThan(components.indexOf(groups[1]));
		// Spacing: exactly one blank line between the rendered blocks around
		// each group (empty-rendering hidden-thinking messages contribute no
		// lines, matching the chat container).
		const lines = components
			.map((component) => render(component))
			.filter((text) => text.length > 0)
			.join("\n")
			.split("\n");
		const groupHeader = lines.findIndex((line) => line.includes("Ran 1 Python cell"));
		expect(lines[groupHeader - 1]).toBe("");
		expect(lines[groupHeader - 2].trim()).toContain("verifying now:");
		const answerLine = lines.findIndex((line) => line.includes("214/214 verified"));
		expect(lines[answerLine - 1]).toBe("");
		expect(lines[answerLine - 2].trim()).toContain("z = 3");
		// The streaming derivation groups identically for the same shape.
		const feed = await streamFeed(messages);
		const streamedGroups = groupsOf(feed.components);
		expect(streamedGroups).toHaveLength(2);
		expect(render(streamedGroups[0])).toBe(render(groups[0]));
		expect(render(streamedGroups[1])).toBe(render(groups[1]));
	});

	it("combines both types in one group header", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "npm test" }, { id: "cmd-a" }),
					fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-b" }),
					fauxToolCall("bash", { command: "git status" }, { id: "cmd-c" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cmd-a", "bash", "tests passed"),
			createToolResult("cell-b", "ipython", "ok"),
			createToolResult("cmd-c", "bash", "clean"),
		];

		const groups = groupsOf(reloadBuild(messages));
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (!group) throw new Error("Expected a run group");
		expect(render(group)).toContain("Ran 2 shell commands · 1 Python cell");
		expect(group.getToolComponents()).toHaveLength(3);
	});

	it("nests the dim previews under the gutter", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "npm test" }, { id: "cmd-a" }),
					fauxToolCall("ipython", { code: "x = 1" }, { id: "cell-b" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cmd-a", "bash", "tests passed"),
			createToolResult("cell-b", "ipython", "ok"),
		];

		const groups = groupsOf(reloadBuild(messages));
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (!group) throw new Error("Expected a run group");
		const raw = group.render(120).join("\n");
		expect(raw).toContain(theme.fg("dim", "╰─"));
		expect(raw).toContain(theme.fg("dim", "$ npm test"));
		expect(raw).toContain(theme.fg("muted", "python"));
		expect(raw).toContain(theme.fg("dim", "x = 1"));
		// Collapsed groups show the dim summaries, not the full output.
		expect(render(group)).not.toContain("tests passed");
	});

	it("expands to the full per-cell rendering through the existing machinery", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(fauxToolCall("bash", { command: "npm test" }, { id: "cmd-a" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cmd-a", "bash", "tests passed"),
		];

		const groups = groupsOf(reloadBuild(messages));
		expect(groups).toHaveLength(1);
		const group = groups[0];
		if (!group) throw new Error("Expected a run group");

		group.setExpanded(true);
		const expanded = group.render(120).map(stripAnsi);
		expect(expanded.join("\n")).toContain("tests passed");
		expect(expanded[1]).toContain("╰─");

		group.setExpanded(false);
		expect(render(group)).not.toContain("tests passed");
	});

	it("mounts non-groupable tools directly and closes the segment", () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: "ls" }, { id: "cmd-a" }),
					fauxToolCall("edit", { path: "src/a.ts", oldStr: "a", newStr: "b" }, { id: "edit-b" }),
					fauxToolCall("bash", { command: "pwd" }, { id: "cmd-c" }),
				],
				{ stopReason: "toolUse" },
			),
			createToolResult("cmd-a", "bash", "src"),
			createToolResult("edit-b", "edit", "Edited src/a.ts"),
			createToolResult("cmd-c", "bash", cwd),
		];

		const components = reloadBuild(messages);
		const groups = groupsOf(components);
		const directTools = components.filter(
			(component): component is ToolExecutionComponent => component instanceof ToolExecutionComponent,
		);
		expect(groups).toHaveLength(2);
		expect(directTools).toHaveLength(1);
		expect(render(groups[0])).toContain("Ran 1 shell command");
		expect(render(groups[1])).toContain("Ran 1 shell command");
		expect(directTools[0]?.render(120).join("\n")).toContain(theme.fg("toolTitle", "edit"));
	});

	it("resets the segment when the user sends a message", async () => {
		const messages: AgentMessage[] = [
			userMessage,
			fauxAssistantMessage(fauxToolCall("ipython", { code: "a = 1" }, { id: "cell-a" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-a", "ipython", "ok"),
			{ role: "user", content: "and now?", timestamp: 2 },
			fauxAssistantMessage(fauxToolCall("ipython", { code: "b = 2" }, { id: "cell-b" }), {
				stopReason: "toolUse",
			}),
			createToolResult("cell-b", "ipython", "ok"),
		];

		const feed = await streamFeed(messages);
		const reloaded = reloadBuild(messages);

		expect(groupsOf(feed.components)).toHaveLength(2);
		expect(groupsOf(reloaded)).toHaveLength(2);
	});
});
