import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RestoreResult } from "../../../src/core/kernel/state-snapshot.js";
import {
	type CustomMessage,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	type IpythonStateRestoredDetails,
} from "../../../src/core/messages.js";
import {
	InjectedPromptMessageComponent,
	isInjectedPromptMessage,
} from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.js";

type StateRestoreHost = {
	_onIpythonStateRestored(result: RestoreResult): void;
};

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function render(component: InjectedPromptMessageComponent): string {
	return stripAnsi(component.render(120).join("\n"));
}

describe("ENG-4530 IPython state restore message", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("preserves restore context as a custom message when the next prompt is queued", async () => {
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
		let providerSawRestoreContext = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				providerSawRestoreContext = context.messages.some((message) =>
					getMessageText(message).includes("These names are available again: alpha, beta."),
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
		(harness.session as unknown as StateRestoreHost)._onIpythonStateRestored({
			restored: ["alpha", "beta"],
			failed: [],
			path: "/tmp/kernel-state.dill",
		});
		await harness.session.prompt("stop the heartbeat", { streamingBehavior: "followUp" });

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(queued?.payload.kind === "turn" ? queued.payload.content : undefined).toEqual([
			{ type: "text", text: "stop the heartbeat" },
		]);
		const prefixMessages =
			queued?.payload.kind === "turn"
				? queued.payload.records.filter((record) => record.role === "prefix").map((record) => record.message)
				: [];
		expect(prefixMessages).toHaveLength(1);
		expect(prefixMessages[0]).toMatchObject({
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			display: true,
			details: { restored: true },
		});

		releaseToolExecution();
		await firstPrompt;

		expect(providerSawRestoreContext).toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", "stop the heartbeat"]);
		const restoreMessage = harness.session.messages.find(
			(message): message is CustomMessage =>
				message.role === "custom" && message.customType === IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
		);
		if (!restoreMessage || !isInjectedPromptMessage(restoreMessage)) {
			throw new Error("Expected an injected IPython restore message");
		}

		const component = new InjectedPromptMessageComponent(restoreMessage);
		expect(render(component)).toContain("◆ Restored IPython kernel state");
		expect(render(component)).not.toContain("alpha");
		component.setExpanded(true);
		expect(render(component)).toContain("◆ Restored IPython kernel state");
		expect(render(component)).not.toContain("ipython_state_restored");
		expect(render(component)).not.toContain("alpha");
	});

	it("retries only undelivered input after partial scheduler delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: "restore context",
				display: true,
				details: { restored: true },
			},
			{ deliverAs: "nextTurn" },
		);
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		await harness.session.prompt("queued prompt", { streamingBehavior: "followUp" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;
		vi.spyOn(harness.session.agent, "prompt").mockImplementationOnce(async (messages) => {
			const batch = Array.isArray(messages) ? messages : [messages];
			harness.session.agent.state.messages.push(batch[0]);
			harness.session.acquireQueuedWorkPause();
			throw new Error("partial delivery failed");
		});

		harness.session.resumeQueuedWork();
		await harness.session.waitForSessionInputIdle();

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(queued?.payload).toMatchObject({ text: "queued prompt" });
		expect(
			queued?.payload.kind === "turn" ? queued.payload.records.filter((record) => record.role === "prefix") : [],
		).toEqual([]);
		expect(harness.session.messages).toEqual([
			expect.objectContaining({ customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE }),
		]);
	});

	it("shows an accurate fixed label when restoration starts a fresh kernel", () => {
		const message: CustomMessage<IpythonStateRestoredDetails> = {
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			content: "restore details",
			display: true,
			details: { restored: false },
			timestamp: Date.now(),
		};
		const component = new InjectedPromptMessageComponent(message);

		expect(render(component)).toContain("◆ Started fresh IPython kernel");
		component.setExpanded(true);
		expect(render(component)).not.toContain("restore details");
	});
});
