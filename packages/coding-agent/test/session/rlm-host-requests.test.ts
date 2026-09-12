import { getModel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	createRlmDeleteSubagentHostHandler,
	createRlmRunHostHandler,
} from "../../src/session/children/host-requests.js";
import type { RlmRunRequest, RlmSubagentRegistryEntry } from "../../src/session/children/runtime-contracts.js";
import {
	createAsyncBashCompletionHostHandler,
	createAsyncBashConsumedHostHandler,
} from "../../src/session/input/bash-host-requests.js";
import {
	createRlmFindModelsHostHandler,
	DEFAULT_RLM_MODEL_SEARCH_LIMIT,
	findRlmModelMatches,
	MAX_RLM_MODEL_SEARCH_LIMIT,
} from "../../src/session/models/model-search.js";

describe("child host request ownership", () => {
	it("retains validation, kwargs identity, spawning source, and result identity", async () => {
		const result = { rlm_child_id: "child-1" };
		const run = vi.fn(async (_request: RlmRunRequest) => result);
		const handler = createRlmRunHostHandler(run);
		await expect(handler({ prompt: null })).rejects.toThrow("rlm.spawn prompt must be a string");
		expect(run).not.toHaveBeenCalled();
		const kwargs = { name: "worker", model: "provider/model" };
		expect(await handler({ prompt: "work", kwargs, cellSourceCode: "spawn()" })).toBe(result);
		expect(run).toHaveBeenLastCalledWith({ prompt: "work", kwargs, cellSourceCode: "spawn()" });
		expect(run.mock.calls[0]?.[0]?.kwargs).toBe(kwargs);
		await handler({ prompt: "", kwargs: [], cellSourceCode: 123 });
		expect(run).toHaveBeenLastCalledWith({ prompt: "", kwargs: {}, cellSourceCode: undefined });
	});

	it("retains optional deletion outcomes and validates before dispatch", async () => {
		const subagent: RlmSubagentRegistryEntry = {
			rlm_child_id: "child",
			active_session_id: null,
			session_id: "saved",
			session_name: "worker",
			session_dir: "/tmp/worker",
			status: "completed",
		};
		const remove = vi.fn(async (_target: string) => ({ subagent }));
		const handler = createRlmDeleteSubagentHostHandler(remove);
		await expect(handler({ target: " " })).rejects.toThrow("rlm.delete_subagent target must be a non-empty string");
		expect(remove).not.toHaveBeenCalled();
		expect(await handler({ target: " worker " })).toEqual({ subagent });
		expect(remove).toHaveBeenCalledExactlyOnceWith("worker");
		expect(
			await createRlmDeleteSubagentHostHandler(async () => ({ subagent, outcome: "skipped_running" }))({
				target: "worker",
			}),
		).toEqual({ subagent, outcome: "skipped_running" });
	});
});

describe("bash input host request ownership", () => {
	it.each([
		[{ pid: 0, command: "echo", exitCode: 0 }, "pid"],
		[{ pid: 1.5, command: "echo", exitCode: 0 }, "pid"],
		[{ pid: 1, command: "", exitCode: 0 }, "command"],
		[{ pid: 1, command: "echo", exitCode: 0.5 }, "exitCode"],
	])("rejects invalid completion data before notifying input", async (payload, field) => {
		const notify = vi.fn();
		await expect(createAsyncBashCompletionHostHandler(notify)(payload)).rejects.toThrow(`bash.completed ${field}`);
		expect(notify).not.toHaveBeenCalled();
	});

	it("awaits completion and propagates consumption callback failures", async () => {
		let finish!: () => void;
		const complete = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const payload = { pid: 12, command: "echo", exitCode: -1 };
		let settled = false;
		const pending = Promise.resolve(createAsyncBashCompletionHostHandler(complete)(payload)).then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		finish();
		await expect(pending).resolves.toEqual({});
		expect(complete).toHaveBeenCalledExactlyOnceWith(payload);
		const failure = new Error("withdraw failed");
		const consume = vi.fn(async () => {
			throw failure;
		});
		const handler = createAsyncBashConsumedHostHandler(consume);
		await expect(handler({ pid: -1, command: "echo" })).rejects.toThrow("bash.consumed pid");
		await expect(handler({ pid: 12, command: "" })).rejects.toThrow("bash.consumed command");
		await expect(handler(payload)).rejects.toBe(failure);
		expect(consume).toHaveBeenCalledExactlyOnceWith({ pid: 12, command: "echo" });
	});
});

describe("model search ownership", () => {
	it("retains bounds, defaults, query identity, and result identity", async () => {
		const models = [{ provider: "p", id: "m", name: "model", selector: "p/m" }];
		const search = vi.fn(() => ({ models }));
		const handler = createRlmFindModelsHostHandler(search);
		await expect(handler({ query: 1 })).rejects.toThrow("query must be a string");
		for (const limit of [0, 1.5, MAX_RLM_MODEL_SEARCH_LIMIT + 1, null])
			await expect(handler({ query: "", limit })).rejects.toThrow("limit must be an integer");
		expect(search).not.toHaveBeenCalled();
		expect((await handler({ query: " Model " })).models).toBe(models);
		expect(search).toHaveBeenCalledExactlyOnceWith(" Model ", DEFAULT_RLM_MODEL_SEARCH_LIMIT);
	});

	it("ranks normalized exact, prefix, and partial matches and resolves ties by selector", () => {
		const base = getModel("anthropic", "claude-sonnet-4-5");
		const models = [
			{ ...base, provider: "z", id: "prefix-code", name: "Prefix" },
			{ ...base, provider: "p", id: "code-next", name: "Next" },
			{ ...base, provider: "p", id: "code", name: "Exact" },
			{ ...base, provider: "a", id: "prefix-code", name: "Prefix" },
		];
		expect(findRlmModelMatches(" C-O_D E ", models, 4).map((m) => m.selector)).toEqual([
			"p/code",
			"p/code-next",
			"a/prefix-code",
			"z/prefix-code",
		]);
		expect(findRlmModelMatches("code", models, 1).map((m) => m.selector)).toEqual(["p/code"]);
		expect(findRlmModelMatches("missing", models, 8)).toEqual([]);
	});
});
