import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isAgentSessionMessage } from "../../../src/core/agent-messages.js";
import { createDeferred, type HostRequestHandlers } from "../../../src/core/kernel/index.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
	createAsyncBashCompletionMessage,
} from "../../../src/core/messages.js";
import { InjectedPromptMessageComponent } from "../../../src/modes/interactive/components/injected-prompt-message.js";
import { formatQueuedMessagePreview } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

interface KernelSession {
	_createKernelHostHandlers(): HostRequestHandlers;
}

const completion = { pid: 42, command: "npm test", exitCode: 0 };

function completeShell(harness: Harness) {
	return (harness.session as unknown as KernelSession)._createKernelHostHandlers()["bash.completed"]!(completion);
}

function shellMessages(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	);
}

describe("#2068 shell message steering", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("consumes shell steering at the next tool boundary without waiting for the run to become idle", async () => {
		const started = createDeferred<void>();
		const release = createDeferred<void>();
		const order: string[] = [];
		let consumed = { streaming: false, completedRuns: -1, text: "" };
		const tool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Hold the current tool until released",
			parameters: Type.Object({}),
			execute: async () => {
				order.push("tool-start");
				started.resolve();
				await release.promise;
				order.push("tool-end");
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				consumed = {
					streaming: harness.session.isStreaming,
					completedRuns: harness.eventsOfType("agent_end").length,
					text: getMessageText(context.messages.at(-1)),
				};
				order.push("shell-consumed");
				return fauxAssistantMessage("Inspected the shell result.");
			},
		]);
		const original = harness.session.prompt("Continue working.");
		try {
			await started.promise;
			await expect(completeShell(harness)).resolves.toEqual({});
			order.push("shell-queued");
			expect(order).toEqual(["tool-start", "shell-queued"]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.getSteeringMessages()).toHaveLength(1);
			const queued = harness.session.getSessionActionRecoverySnapshot().actions;
			expect(queued).toContainEqual(expect.objectContaining({ delivery: "next_turn_boundary" }));
			const preview = harness.session.getSteeringMessagePreviews()[0]!;
			expect(preview).toBe("Shell message received: pid 42, exit 0");
			expect(formatQueuedMessagePreview(preview, "Steering")).toBe(preview);
		} finally {
			release.resolve();
			await original;
		}
		await harness.session.waitForIdle();
		expect(order).toEqual(["tool-start", "shell-queued", "tool-end", "shell-consumed"]);
		expect(consumed).toMatchObject({ streaming: true, completedRuns: 1 });
		expect(harness.eventsOfType("agent_end")[0]!.messages.filter((message) => message.role === "assistant")).toEqual([
			expect.objectContaining({ stopReason: "toolUse" }),
		]);
		expect(consumed.text).toBe('[bash-done pid:42 exit:0]\n\nCommand: "npm test"');
		expect(shellMessages(harness)).toHaveLength(1);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});

	it("resumes an idle session once while retaining the distinct shell message identity", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		let requests = 0;
		harness.setResponses([
			(context) => {
				requests++;
				expect(getMessageText(context.messages.at(-1))).toContain("Source: bash");
				return fauxAssistantMessage("Inspected the shell result.");
			},
		]);
		await completeShell(harness);
		await harness.session.waitForIdle();
		expect(requests).toBe(1);
		expect(shellMessages(harness)).toHaveLength(1);
		expect(isAgentSessionMessage(shellMessages(harness)[0]!)).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("renders shell-specific queue and transcript labels without generic delivery prefixes", () => {
		const message = createAsyncBashCompletionMessage(completion);
		const preview = `${ASYNC_BASH_COMPLETION_PREVIEW_LABEL}: pid 42, exit 0`;
		for (const delivery of ["Steering", "Follow-up"] as const) {
			expect(formatQueuedMessagePreview(preview, delivery)).toBe(preview);
		}
		const component = new InjectedPromptMessageComponent(message);
		const render = () =>
			component
				.render(120)
				.join("\n")
				.replace(/\u001b\[[0-9;]*m/g, "");
		expect(render()).toContain("◆ Shell message received · pid 42 · exit 0");
		expect(render()).not.toMatch(/Follow-up:|Steering:|Agent message received/);
		component.setExpanded(true);
		expect(render()).toContain("[bash-done pid:42 exit:0]");
		expect(render()).toContain("npm test");
		expect(render()).not.toContain("Inspect the saved BashHandle");
	});
});
