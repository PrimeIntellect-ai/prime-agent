import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";

const sessionFactory = vi.hoisted(() => vi.fn());

vi.mock("../src/core/sdk.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/sdk.js")>();
	return { ...actual, createAgentSession: sessionFactory };
});

import { WorkflowSubagentRunner } from "../src/core/workflows/agent-runner.js";

interface FakeSessionOptions {
	messages?: AssistantMessage[];
	onPrompt?: (sessionOptions: CreateAgentSessionOptions) => Promise<void> | void;
}

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "test",
		model: "test-model",
		usage: {
			input: 2,
			output: 3,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 5,
			cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function installSession({ messages = [makeAssistant("done")], onPrompt }: FakeSessionOptions = {}) {
	const session = {
		messages,
		prompt: vi.fn(async () => {
			const options = sessionFactory.mock.calls.at(-1)?.[0] as CreateAgentSessionOptions;
			await onPrompt?.(options);
		}),
		abort: vi.fn(async () => undefined),
		disposeAsync: vi.fn(async () => undefined),
	};
	sessionFactory.mockResolvedValue({ session, extensionsResult: { extensions: [], errors: [] } });
	return session;
}

function createRunner() {
	return new WorkflowSubagentRunner({
		cwd: process.cwd(),
		agentDir: process.cwd(),
		modelRegistry: {
			getAvailable: () => [],
		} as unknown as NonNullable<CreateAgentSessionOptions["modelRegistry"]>,
	});
}

describe("WorkflowSubagentRunner", () => {
	beforeEach(() => sessionFactory.mockReset());
	afterEach(() => vi.useRealTimers());

	it("returns the last assistant text and aggregates usage", async () => {
		const session = installSession({ messages: [makeAssistant("first"), makeAssistant("final")] });
		const result = await createRunner().run("inspect files", { label: "inspection" });

		expect(result).toEqual({
			result: "final",
			usage: { input: 4, output: 6, totalTokens: 10, cost: 0.6 },
		});
		expect(session.prompt).toHaveBeenCalledWith(expect.stringContaining("inspect files"));
		expect(session.disposeAsync).toHaveBeenCalledOnce();
		const options = sessionFactory.mock.calls[0]?.[0] as CreateAgentSessionOptions;
		expect(options.tools).toEqual(["ipython"]);
		expect(options.rlmMaxDepth).toBe(0);
	});

	it("captures schema-validated output through a terminating tool", async () => {
		installSession({
			onPrompt: async (options) => {
				const outputTool = options.customTools?.[0];
				expect(outputTool?.name).toBe("workflow_output");
				await outputTool?.execute("call", { files: ["a.ts"] }, undefined, undefined, undefined as never);
			},
		});
		const schema = {
			type: "object",
			required: ["files"],
			properties: { files: { type: "array", items: { type: "string" } } },
		};
		const result = await createRunner().run("list files", { label: "inventory", schema });

		expect(result.result).toEqual({ files: ["a.ts"] });
		const options = sessionFactory.mock.calls[0]?.[0] as CreateAgentSessionOptions;
		expect(options.tools).toEqual(["ipython", "workflow_output"]);
	});

	it("fails closed when structured output was not submitted", async () => {
		installSession();
		await expect(
			createRunner().run("list files", { label: "inventory", schema: { type: "object" } }),
		).rejects.toThrow("without calling workflow_output");
	});

	it("rejects unavailable model selectors before creating a session", async () => {
		installSession();
		await expect(createRunner().run("inspect", { label: "inspection", model: "missing/model" })).rejects.toThrow(
			'workflow model "missing/model" is not available',
		);
		expect(sessionFactory).not.toHaveBeenCalled();
	});

	it("aborts the child session on timeout", async () => {
		vi.useFakeTimers();
		const session = installSession({
			onPrompt: () => new Promise((resolve) => setTimeout(resolve, 100)),
		});
		const pending = createRunner().run("slow", { label: "slow", timeoutMs: 10 });
		const assertion = expect(pending).rejects.toThrow("timed out");
		await vi.advanceTimersByTimeAsync(100);
		await assertion;
		expect(session.abort).toHaveBeenCalledOnce();
	});

	it("applies explicit effort and inherits the parent tool allowlist", async () => {
		installSession();
		const runner = new WorkflowSubagentRunner({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			thinkingLevel: "medium",
			activeToolNames: [],
			modelRegistry: { getAvailable: () => [] } as unknown as NonNullable<
				CreateAgentSessionOptions["modelRegistry"]
			>,
		});
		const result = await runner.run("inspect", { label: "inspection", effort: "high" });
		expect(result.effort).toBe("high");
		const options = sessionFactory.mock.calls[0]?.[0] as CreateAgentSessionOptions;
		expect(options.thinkingLevel).toBe("high");
		expect(options.tools).toEqual([]);
	});

	it("fails closed for isolation and agent types that are not implemented", async () => {
		installSession();
		await expect(createRunner().run("inspect", { label: "inspection", isolation: "worktree" })).rejects.toThrow(
			"not available",
		);
		await expect(createRunner().run("inspect", { label: "inspection", agentType: "reviewer" })).rejects.toThrow(
			"not available",
		);
		expect(sessionFactory).not.toHaveBeenCalled();
	});
});
