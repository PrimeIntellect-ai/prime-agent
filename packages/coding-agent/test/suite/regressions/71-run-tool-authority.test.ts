import { existsSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
	type AgentRunToolAuthorizationRequest,
	createAgentRunToolAuthorityScope,
} from "../../../src/core/run-tool-authority.js";
import { createHarness, type Harness } from "../harness.js";

function latestUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function countingTool(executions: Array<{ value: number }>): AgentTool {
	return {
		name: "counting_tool",
		label: "Counting tool",
		description: "Record a numeric value",
		parameters: Type.Object({ value: Type.Number() }),
		execute: async (_toolCallId, args) => {
			executions.push(args as { value: number });
			return { content: [{ type: "text", text: "recorded" }], details: {} };
		},
	};
}

describe("issue 71 run-scoped tool authority", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("denies a validated root tool call with exact run context before execution", async () => {
		const executions: Array<{ value: number }> = [];
		const harness = await createHarness({ tools: [countingTool(executions)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("counting_tool", { value: 7 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const runContext = { interactionId: "interaction-root" };
		const requests: AgentRunToolAuthorizationRequest[] = [];
		const scope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize(request) {
				requests.push(request);
				return { decision: "deny", reason: "host denied root tool" };
			},
		});

		await harness.session.promptAndWait("root denial", { runContext, toolAuthorityScope: scope });

		expect(executions).toEqual([]);
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({
			toolName: "counting_tool",
			args: { value: 7 },
			context: { runContext, recursionDepth: 0 },
		});
		expect(requests[0]?.context.executionId).toEqual(expect.any(String));
		expect(Object.isFrozen(requests[0]?.args)).toBe(true);
		await expect(harness.session.promptAndWait("cannot reuse", { toolAuthorityScope: scope })).rejects.toThrow(
			"revoked",
		);
	});

	it("inherits the same authority into a recursive child and denies before child execution", async () => {
		const harness = await createHarness({ rlmMaxDepth: 1 });
		harnesses.push(harness);
		const marker = `${harness.tempDir}/child-tool-ran`;
		let childAuthorizationObserved!: () => void;
		const childAuthorization = new Promise<void>((resolve) => {
			childAuthorizationObserved = resolve;
		});
		const response = async (context: Context) => {
			const child = latestUserText(context).includes("[task from parent]");
			const hasToolResult = context.messages.some((message) => message.role === "toolResult");
			if (child && !hasToolResult) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", { code: `from pathlib import Path\nPath(${JSON.stringify(marker)}).touch()` }),
					{ stopReason: "toolUse" },
				);
			}
			if (child) return fauxAssistantMessage("child done");
			if (!hasToolResult) {
				return fauxAssistantMessage(
					fauxToolCall("ipython", { code: 'await rlm("child task", name="authority-child")' }),
					{ stopReason: "toolUse" },
				);
			}
			await childAuthorization;
			return fauxAssistantMessage("root done");
		};
		harness.setResponses([response, response, response, response]);
		const requests: AgentRunToolAuthorizationRequest[] = [];
		const scope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize(request) {
				requests.push(request);
				if (request.context.recursionDepth === 1) {
					childAuthorizationObserved();
					return { decision: "deny", reason: "child tool denied" };
				}
				return { decision: "allow" };
			},
		});

		await harness.session.promptAndWait("spawn child", {
			runContext: { interactionId: "interaction-child" },
			toolAuthorityScope: scope,
		});
		await vi.waitFor(() => expect(requests.some((request) => request.context.recursionDepth === 1)).toBe(true));
		expect(requests.map((request) => [request.toolName, request.context.recursionDepth])).toContainEqual([
			"ipython",
			1,
		]);
		expect(existsSync(marker)).toBe(false);
	});

	it("awaits host approval and aborts a pending authorization on cancellation", async () => {
		const executions: Array<{ value: number }> = [];
		const harness = await createHarness({ tools: [countingTool(executions)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("counting_tool", { value: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("approved"),
		]);
		let releaseApproval!: () => void;
		const approval = new Promise<void>((resolve) => {
			releaseApproval = resolve;
		});
		let approvalRequested!: () => void;
		const requested = new Promise<void>((resolve) => {
			approvalRequested = resolve;
		});
		const approvedScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			async authorize() {
				approvalRequested();
				await approval;
				return { decision: "allow" };
			},
		});
		const approvedRun = harness.session.promptAndWait("wait for approval", {
			toolAuthorityScope: approvedScope,
		});
		await requested;
		expect(executions).toEqual([]);
		releaseApproval();
		await approvedRun;
		expect(executions).toEqual([{ value: 1 }]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("counting_tool", { value: 2 }), { stopReason: "toolUse" }),
		]);
		let cancellationSignal: AbortSignal | undefined;
		let cancellationRequested!: () => void;
		const cancellationStarted = new Promise<void>((resolve) => {
			cancellationRequested = resolve;
		});
		const cancelledScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize(request) {
				cancellationSignal = request.context.signal;
				cancellationRequested();
				return new Promise(() => {});
			},
		});
		const cancelledRun = harness.session.promptAndWait("cancel approval", {
			toolAuthorityScope: cancelledScope,
		});
		await cancellationStarted;
		await harness.session.abort();
		await Promise.allSettled([cancelledRun]);
		expect(cancellationSignal?.aborted).toBe(true);
		expect(executions).toEqual([{ value: 1 }]);
		await expect(
			harness.session.promptAndWait("cannot reuse cancelled", { toolAuthorityScope: cancelledScope }),
		).rejects.toThrow("revoked");
	});

	it("allows Full to omit authority and a later run in the same session to be narrower", async () => {
		const executions: Array<{ value: number }> = [];
		const harness = await createHarness({ tools: [countingTool(executions)] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("counting_tool", { value: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("full done"),
		]);
		await harness.session.promptAndWait("full run");
		expect(executions).toEqual([{ value: 1 }]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("counting_tool", { value: 2 }), { stopReason: "toolUse" }),
			fauxAssistantMessage("narrow done"),
		]);
		const narrowScope = createAgentRunToolAuthorityScope({
			version: AGENT_RUN_TOOL_AUTHORITY_SCOPE_VERSION,
			authorize: () => ({ decision: "deny", reason: "narrow run denies tools" }),
		});
		await harness.session.promptAndWait("narrow run", { toolAuthorityScope: narrowScope });
		expect(executions).toEqual([{ value: 1 }]);
	});
});
