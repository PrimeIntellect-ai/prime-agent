import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type CustomMessage,
	PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
	type PythonSkillsUnavailableDetails,
} from "../../../src/core/messages.js";
import type { UnavailablePythonSkills } from "../../../src/core/tools/ipython.js";
import {
	InjectedPromptMessageComponent,
	isInjectedPromptMessage,
} from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { conversationMessages, createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

type SkillsUnavailableHost = {
	_onPythonSkillsUnavailable(errors: UnavailablePythonSkills): void;
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: InjectedPromptMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("Python skills unavailable message", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterAll(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("queues the unavailable-skill report as next-turn context the model sees", async () => {
		let releaseToolExecution = () => {};
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
		let providerSawUnavailableSkills = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				providerSawUnavailableSkills = context.messages.some((message) =>
					getMessageText(message).includes(
						"These installed Python skill modules failed to import into the Python kernel",
					),
				);
				return fauxAssistantMessage("queued turn complete");
			},
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const firstPrompt = harness.session.prompt("start");
		await toolStarted;
		(harness.session as unknown as SkillsUnavailableHost)._onPythonSkillsUnavailable({
			websearch: "No module named 'websearch'",
		});
		await harness.session.prompt("continue", { streamingBehavior: "followUp" });

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		const prefixMessages =
			queued?.payload.kind === "turn"
				? queued.payload.records.filter((record) => record.role === "prefix").map((record) => record.message)
				: [];
		expect(prefixMessages).toHaveLength(1);
		expect(prefixMessages[0]).toMatchObject({
			role: "custom",
			customType: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
			display: true,
			details: { skills: ["websearch"] },
		});
		const noticeText = getMessageText(prefixMessages[0]);
		expect(noticeText).toContain("[python-skills-unavailable]");
		expect(noticeText).toContain(
			"These installed Python skill modules failed to import into the Python kernel, so calling them raises an error:",
		);
		expect(noticeText).toContain("- websearch: No module named 'websearch'");
		expect(noticeText).toContain("uv pip install");

		releaseToolExecution();
		await firstPrompt;

		expect(providerSawUnavailableSkills).toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", "continue"]);
		const unavailableMessage = harness.session.messages.find(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
		);
		if (!unavailableMessage || !isInjectedPromptMessage(unavailableMessage)) {
			throw new Error("Expected an injected Python skills unavailable message");
		}

		// The TUI shows a collapsed status line, not the full report, unless expanded.
		const component = new InjectedPromptMessageComponent(unavailableMessage);
		expect(render(component)).toContain("Python skills unavailable");
		expect(render(component)).not.toContain("No module named");
		component.setExpanded(true);
		expect(render(component)).toContain("No module named 'websearch'");
		expect(render(component)).not.toContain("python_skills_unavailable");
	});

	it("lists every failed skill with its import error", () => {
		const message: CustomMessage<PythonSkillsUnavailableDetails> = {
			role: "custom",
			customType: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
			content: "[python-skills-unavailable]\n\n- one: first error\n- two: second error",
			display: true,
			details: { skills: ["one", "two"] },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);
		component.setExpanded(true);

		expect(render(component)).toContain("one: first error");
		expect(render(component)).toContain("two: second error");
	});

	it("keeps the queued report until a turn delivers it", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.sendCustomMessage(
			{
				customType: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
				content: "skills unavailable",
				display: true,
				details: { skills: ["gone"] },
			},
			{ deliverAs: "nextTurn" },
		);

		expect(conversationMessages(harness.session)).toEqual([]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);

		await harness.session.prompt("go");
		const delivered = conversationMessages(harness.session).find(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
		);
		expect(delivered).toMatchObject({
			customType: PYTHON_SKILLS_UNAVAILABLE_CUSTOM_TYPE,
			content: "skills unavailable",
		});
	});
});
