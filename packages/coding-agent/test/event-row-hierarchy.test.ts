import { setKeybindings } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSessionMessage } from "../src/core/agent-messages.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AgentMessageComponent } from "../src/modes/interactive/components/agent-message.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

/**
 * Conversation event rows keep the leading label colored and render the
 * trailing detail (participants, previews, commands) in the dim tone.
 */
describe("conversation event row hierarchy", () => {
	let previousColorTerm: string | undefined;

	beforeAll(() => {
		previousColorTerm = process.env.COLORTERM;
		process.env.COLORTERM = "truecolor";
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterAll(() => {
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
	});

	function createTuiStub(): any {
		return {
			terminal: {
				get columns() {
					return 100;
				},
				get rows() {
					return 30;
				},
			},
			addInterval: () => ({ dispose: () => {} }),
			removeInterval: () => {},
			requestRender: () => {},
		};
	}

	it("dims the participant and preview after the agent message label", () => {
		const message: AgentSessionMessage = {
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

		const raw = new AgentMessageComponent(message, undefined, {}).render(100).join("\n");

		expect(raw).toContain(theme.fg("muted", "Agent message received"));
		expect(raw).toContain(theme.fg("dim", "from parent Planner"));
		expect(raw).toContain(theme.fg("dim", "Review shard seven."));
	});

	it("dims the bash tool command on the call row", () => {
		const tool = new ToolExecutionComponent(
			"bash",
			"t1",
			{ command: "npm test" },
			{},
			undefined,
			createTuiStub(),
			"/tmp",
		);
		tool.markExecutionStarted();
		tool.setArgsComplete();

		const raw = tool.render(100).join("\n");

		expect(raw).toContain(theme.fg("dim", "$ npm test"));
	});

	it("keeps the edit label and dims the path on the call row", () => {
		const tool = new ToolExecutionComponent(
			"edit",
			"t2",
			{ path: "src/foo.ts", oldStr: "a", newStr: "b" },
			{},
			undefined,
			createTuiStub(),
			"/tmp",
		);
		tool.markExecutionStarted();
		tool.setArgsComplete();

		const raw = tool.render(100).join("\n");

		expect(raw).toContain(theme.fg("toolTitle", "edit"));
		expect(raw).toContain(theme.fg("dim", "src/foo.ts"));
	});
});
