import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	formatFileOperations,
} from "../src/core/compaction/utils.js";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "toolUse",
		timestamp: 0,
	};
}

function toolResult(details: unknown, toolName = "ipython"): ToolResultMessage {
	return { role: "toolResult", toolCallId: "call-1", toolName, content: [], details, isError: false, timestamp: 0 };
}

function toolCall(name: string, args: Record<string, unknown>) {
	return { type: "toolCall", id: "call-1", name, arguments: args } as const;
}

describe("compaction file-op extraction", () => {
	it("records native edit tool calls", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(assistant([toolCall("edit", { path: "src/native-edit.ts" })]) as never, fileOps);
		expect([...fileOps.edited]).toEqual(["src/native-edit.ts"]);
	});

	it("records kernel-reported edits from ipython tool results", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			toolResult({
				status: "ok",
				diffs: [
					{ path: "pkg/a.ts", oldStr: "x", newStr: "y" },
					{ path: "pkg/b.ts", oldStr: "x", newStr: "y" },
				],
			}) as never,
			fileOps,
		);
		expect([...fileOps.edited]).toEqual(["pkg/a.ts", "pkg/b.ts"]);
	});

	it("ignores non-ipython tool results and malformed diff payloads", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(toolResult({ diffs: [{ path: "pkg/c.ts" }] }, "bash") as never, fileOps);
		extractFileOpsFromMessage(toolResult({ diffs: "not-an-array" }) as never, fileOps);
		extractFileOpsFromMessage(toolResult({ diffs: [{ noPath: true }, { path: 42 }, null] }) as never, fileOps);
		extractFileOpsFromMessage(toolResult(undefined) as never, fileOps);
		expect(fileOps.edited.size).toBe(0);
	});

	it("feeds kernel edits into modified-files for summaries", () => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(
			toolResult({ diffs: [{ path: "src/kernel-edit.ts", oldStr: "a", newStr: "b" }] }) as never,
			fileOps,
		);
		const { readFiles, modifiedFiles } = computeFileLists(fileOps);
		expect(readFiles).toEqual([]);
		expect(modifiedFiles).toEqual(["src/kernel-edit.ts"]);
		expect(formatFileOperations(readFiles, modifiedFiles)).toContain(
			"<modified-files>\nsrc/kernel-edit.ts\n</modified-files>",
		);
	});
});
