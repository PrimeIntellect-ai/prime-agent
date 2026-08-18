import { describe, expect, it } from "vitest";
import { PUBLIC_COMMAND_NAMES } from "../src/cli/command-registry.js";
import {
	classifyOwnedSessionWorkerInvocation,
	createOwnedWorkerLaunchSpec,
	createRpcRecoveryArgs,
	isOwnedSessionWorkerProcess,
} from "../src/cli/owned-session-worker.js";

describe("owned session worker CLI routing", () => {
	it("leaves resident interactive and non-session operations in the frontend", () => {
		expect(classifyOwnedSessionWorkerInvocation([], true, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--mode", "daemon"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--help"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--version"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--list-models"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["--export", "session.jsonl"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["help"], false, {})).toBeUndefined();
		expect(classifyOwnedSessionWorkerInvocation(["help", "me", "fix", "this"], false, {})).toBe("print");
		expect(classifyOwnedSessionWorkerInvocation(["daemon", "list"], false, {})).toBeUndefined();
		for (const command of PUBLIC_COMMAND_NAMES) {
			expect(classifyOwnedSessionWorkerInvocation([command], false, {})).toBeUndefined();
		}
	});

	it("does not recursively route an owned worker", () => {
		expect(isOwnedSessionWorkerProcess({ PRIME_AGENT_INTERNAL_OWNED_WORKER: "1" })).toBe(true);
		expect(isOwnedSessionWorkerProcess({})).toBe(false);
		expect(
			classifyOwnedSessionWorkerInvocation(["--mode", "rpc"], true, {
				PRIME_AGENT_INTERNAL_OWNED_WORKER: "1",
			}),
		).toBeUndefined();
	});

	it("preserves the current runtime flags and CLI entrypoint", () => {
		expect(createOwnedWorkerLaunchSpec(["--mode", "rpc"], "/node", ["--loader", "tsx"], "/cli.ts")).toEqual({
			command: "/node",
			args: ["--loader", "tsx", "/cli.ts", "--mode", "rpc"],
		});
	});

	it("restarts RPC against the exact persisted session without changing public flags", () => {
		expect(
			createRpcRecoveryArgs(
				["--mode", "rpc", "--continue", "--resume", "/old.jsonl", "--model", "openai/gpt-5"],
				"/current.jsonl",
			),
		).toEqual(["--mode", "rpc", "--model", "openai/gpt-5", "--resume", "/current.jsonl"]);
	});
});
