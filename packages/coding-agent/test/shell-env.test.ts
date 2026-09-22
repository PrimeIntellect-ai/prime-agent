import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getShellEnv } from "../src/utils/shell.js";

const GUARD_VARS: Record<string, string> = {
	GIT_EDITOR: "true",
	GIT_SEQUENCE_EDITOR: "true",
	GIT_TERMINAL_PROMPTS: "0",
	GIT_ASKPASS: "true",
	SSH_ASKPASS_REQUIRE: "never",
	EDITOR: "true",
	VISUAL: "true",
	PAGER: "cat",
	GIT_PAGER: "cat",
	DEBIAN_FRONTEND: "noninteractive",
};

const KEPT = [
	"GIT_EDITOR",
	"GIT_SEQUENCE_EDITOR",
	"GIT_TERMINAL_PROMPTS",
	"GIT_ASKPASS",
	"SSH_ASKPASS_REQUIRE",
	"EDITOR",
	"VISUAL",
	"PAGER",
	"GIT_PAGER",
	"DEBIAN_FRONTEND",
];

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
		process.env.GIT_SEQUENCE_EDITOR = "vim";
		const env = getShellEnv();
		// stdin is never a TTY for agent shells, so an inherited EDITOR/PAGER is
		// exactly the hang this guard prevents; it must be replaced, not kept.
		expect(env.EDITOR).toBe("true");
		expect(env.PAGER).toBe("cat");
		// GIT_SEQUENCE_EDITOR outranks GIT_EDITOR for `git rebase -i`, so an
		// inherited value would still hang the interactive todo editor.
		expect(env.GIT_SEQUENCE_EDITOR).toBe("true");
	});

	it("keeps unrelated inherited variables intact", () => {
		process.env.PRIME_AGENT_SHELL_ENV_TEST = "sentinel";
		const env = getShellEnv();
		expect(env.PRIME_AGENT_SHELL_ENV_TEST).toBe("sentinel");
		delete process.env.PRIME_AGENT_SHELL_ENV_TEST;
	});
});
