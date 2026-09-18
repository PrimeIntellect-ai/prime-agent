import { describe, expect, it, vi } from "vitest";
import { startsAgentRun } from "../src/core/agent-messages.js";
import { convertToLlm, createSwarmProgressMessage, SWARM_PROGRESS_NOTICE_CUSTOM_TYPE } from "../src/core/messages.js";
import { createSwarmProgressHostHandler } from "../src/core/rlm-runtime.js";

describe("swarm progress", () => {
	it("creates a bracket-grammar milestone notice and keeps it model-visible", () => {
		const message = createSwarmProgressMessage({
			runId: "run-1",
			kind: "budget_exceeded",
			detail: "run budget_ms 600000 exceeded after 612000ms",
		});

		expect(message.customType).toBe(SWARM_PROGRESS_NOTICE_CUSTOM_TYPE);
		expect(message.content).toBe(
			"[swarm-progress run:run-1] budget-exceeded: run budget_ms 600000 exceeded after 612000ms",
		);
		expect(convertToLlm([message])).toEqual([
			{
				role: "user",
				content: [{ type: "text", text: message.content }],
				timestamp: message.timestamp,
			},
		]);
	});

	it("renders the finished, failed, and paused milestone kinds verbatim", () => {
		expect(createSwarmProgressMessage({ runId: "r", kind: "finished", detail: "all 3 nodes done" }).content).toBe(
			"[swarm-progress run:r] finished: all 3 nodes done",
		);
		expect(createSwarmProgressMessage({ runId: "r", kind: "failed", detail: "node review failed" }).content).toBe(
			"[swarm-progress run:r] failed: node review failed",
		);
		expect(
			createSwarmProgressMessage({ runId: "r", kind: "paused", detail: "escalate: awaiting resume" }).content,
		).toBe("[swarm-progress run:r] paused: escalate: awaiting resume");
	});

	it("starts a new agent run for a swarm milestone follow-up", () => {
		const message = createSwarmProgressMessage({ runId: "r", kind: "finished", detail: "done" });
		expect(startsAgentRun(message)).toBe(true);
	});

	it("validates and forwards kernel milestone payloads", async () => {
		const milestone = vi.fn();
		const handler = createSwarmProgressHostHandler(milestone);
		const payload = { run_id: " run-1 ", kind: "paused", node: "review", detail: "node review failed" };

		await expect(handler(payload)).resolves.toEqual({});
		expect(milestone).toHaveBeenCalledWith({
			runId: "run-1",
			kind: "paused",
			node: "review",
			detail: "node review failed",
		});
	});

	it("omits the node field when the kernel does not provide one", async () => {
		const milestone = vi.fn();
		const handler = createSwarmProgressHostHandler(milestone);

		await handler({ run_id: "run-1", kind: "finished", detail: "all nodes done" });
		expect(milestone).toHaveBeenCalledWith({ runId: "run-1", kind: "finished", detail: "all nodes done" });
	});

	it.each([
		[{ kind: "finished", detail: "done" }, "run_id must be a non-empty string"],
		[{ run_id: "", kind: "finished", detail: "done" }, "run_id must be a non-empty string"],
		[{ run_id: "r", kind: "weird", detail: "done" }, "kind must be one of"],
		[{ run_id: "r", kind: "finished" }, "detail must be a non-empty string"],
		[{ run_id: "r", kind: "finished", detail: "  " }, "detail must be a non-empty string"],
		[{ run_id: "r", kind: "finished", detail: "done", node: 5 }, "node must be a string when provided"],
		[{ run_id: "r", kind: "finished", detail: "done", node: "" }, "node must be a non-empty string"],
	])("rejects an invalid payload %#", async (payload, error) => {
		const handler = createSwarmProgressHostHandler(() => undefined);
		await expect(handler(payload)).rejects.toThrow(error);
	});
});
