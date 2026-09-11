import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellEnv } from "../src/utils/shell.js";

const GUARD_VARS: Record<string, string> = {
	GIT_EDITOR: "true",
	GIT_TERMINAL_PROMPTS: "0",
	EDITOR: "true",
	VISUAL: "true",
	PAGER: "cat",
	GIT_PAGER: "cat",
	DEBIAN_FRONTEND: "noninteractive",
};

const KEPT = ["GIT_EDITOR", "GIT_TERMINAL_PROMPTS", "EDITOR", "VISUAL", "PAGER", "GIT_PAGER", "DEBIAN_FRONTEND"];

describe("getShellEnv", () => {
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of KEPT) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of KEPT) {
			const value = saved[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("sets non-interactive defaults for agent-spawned shells", () => {
		const env = getShellEnv();
		for (const [key, value] of Object.entries(GUARD_VARS)) {
			expect(env[key]).toBe(value);
		}
	});

	it("overrides inherited terminal settings instead of honoring them", () => {
		process.env.EDITOR = "vim";
		process.env.PAGER = "less";
		const env = getShellEnv();
		// stdin is never a TTY for agent shells, so an inherited EDITOR/PAGER is
		// exactly the hang this guard prevents; it must be replaced, not kept.
		expect(env.EDITOR).toBe("true");
		expect(env.PAGER).toBe("cat");
	});

	it("keeps unrelated inherited variables intact", () => {
		process.env.PRIME_AGENT_SHELL_ENV_TEST = "sentinel";
		const env = getShellEnv();
		expect(env.PRIME_AGENT_SHELL_ENV_TEST).toBe("sentinel");
		delete process.env.PRIME_AGENT_SHELL_ENV_TEST;
	});
});
