import { describe, expect, it } from "vitest";
import {
	buildKernelEnv,
	collectCredentialDigests,
	credentialDigest,
	droppedCredentialEnvNames,
	isCredentialEnvName,
} from "../src/core/kernel/kernel-env.js";

// ENG-5342: the kernel used to inherit the whole host environment, so provider
// keys were readable from any cell and ended up in the state snapshot.
describe("buildKernelEnv", () => {
	const host: NodeJS.ProcessEnv = {
		PATH: "/usr/bin:/bin",
		HOME: "/home/tester",
		LANG: "en_US.UTF-8",
		LC_ALL: "C.UTF-8",
		TMPDIR: "/tmp",
		TERM: "xterm-256color",
		RLM_MAX_DEPTH: "3",
		PRIME_AGENT_KERNEL_VENV: "/home/tester/.prime/agent/kernel-venv",
		PYTHONPATH: "/opt/lib",
		PRIME_TEAM_ID: "team-123",
		PRIME_API_KEY: "sk-synthetic-prime-5342",
		OPENAI_API_KEY: "sk-synthetic-openai-5342",
		ANTHROPIC_OAUTH_TOKEN: "oauth-synthetic-5342",
		AWS_SECRET_ACCESS_KEY: "aws-synthetic-secret-5342",
		PRIME_AGENT_TRACES_API_KEY: "traces-synthetic-5342",
		MY_SERVICE_TOKEN: "custom-synthetic-token-5342",
		DATABASE_URL: "postgres://localhost/app",
		NPM_TOKEN: "npm-synthetic-token",
	};

	it("keeps the runtime and shell essentials and drops everything else", () => {
		const env = buildKernelEnv(host, {}, { platform: "linux" });
		expect(env).toMatchObject({
			PATH: "/usr/bin:/bin",
			HOME: "/home/tester",
			LANG: "en_US.UTF-8",
			LC_ALL: "C.UTF-8",
			TMPDIR: "/tmp",
			TERM: "xterm-256color",
			RLM_MAX_DEPTH: "3",
			PRIME_AGENT_KERNEL_VENV: "/home/tester/.prime/agent/kernel-venv",
			PYTHONPATH: "/opt/lib",
			PRIME_TEAM_ID: "team-123",
		});
		expect(env).not.toHaveProperty("DATABASE_URL");
	});

	it("never passes provider or ambient credentials, even under an allowlisted prefix", () => {
		const env = buildKernelEnv(host, {}, { platform: "linux" });
		for (const name of [
			"PRIME_API_KEY",
			"OPENAI_API_KEY",
			"ANTHROPIC_OAUTH_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"PRIME_AGENT_TRACES_API_KEY",
			"MY_SERVICE_TOKEN",
			"NPM_TOKEN",
		]) {
			expect(env, name).not.toHaveProperty(name);
		}
	});

	it("layers the session's injected variables verbatim on top", () => {
		const env = buildKernelEnv(
			host,
			{ RLM_DEPTH: "1", PRIME_AGENT_BASH_SHELL: "/bin/bash", SERPER_API_KEY: "serper-synthetic-5342" },
			{ platform: "linux" },
		);
		expect(env.RLM_DEPTH).toBe("1");
		expect(env.PRIME_AGENT_BASH_SHELL).toBe("/bin/bash");
		expect(env.SERPER_API_KEY).toBe("serper-synthetic-5342");
	});

	it("honours passthrough names and PREFIX* globs, including credential names the user opted in", () => {
		const env = buildKernelEnv(
			host,
			{},
			{ platform: "linux", passthrough: ["DATABASE_URL", "PRIME_API_KEY", "NPM_*"] },
		);
		expect(env.DATABASE_URL).toBe("postgres://localhost/app");
		expect(env.PRIME_API_KEY).toBe("sk-synthetic-prime-5342");
		expect(env.NPM_TOKEN).toBe("npm-synthetic-token");
		expect(env).not.toHaveProperty("OPENAI_API_KEY");
	});

	it("matches names case-insensitively on Windows", () => {
		const env = buildKernelEnv(
			{ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe", Openai_Api_Key: "x".repeat(20) },
			{},
			{ platform: "win32" },
		);
		expect(env).toMatchObject({ Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "cmd.exe" });
		expect(env).not.toHaveProperty("Openai_Api_Key");
	});

	it("reports which credential names were dropped", () => {
		expect(droppedCredentialEnvNames(host, { platform: "linux" })).toEqual([
			"ANTHROPIC_OAUTH_TOKEN",
			"AWS_SECRET_ACCESS_KEY",
			"MY_SERVICE_TOKEN",
			"NPM_TOKEN",
			"OPENAI_API_KEY",
			"PRIME_AGENT_TRACES_API_KEY",
			"PRIME_API_KEY",
		]);
		expect(droppedCredentialEnvNames(host, { platform: "linux", passthrough: ["PRIME_API_KEY"] })).not.toContain(
			"PRIME_API_KEY",
		);
	});
});

describe("isCredentialEnvName", () => {
	it("recognises the documented provider variables and generic credential shapes", () => {
		for (const name of ["PRIME_API_KEY", "GH_TOKEN", "HF_TOKEN", "AWS_SESSION_TOKEN", "FOO_SECRET", "DB_PASSWORD"]) {
			expect(isCredentialEnvName(name), name).toBe(true);
		}
		for (const name of ["PATH", "HOME", "RLM_SESSION_DIR", "PRIME_TEAM_ID", "GIT_SSH_COMMAND", "TERM_PROGRAM"]) {
			expect(isCredentialEnvName(name), name).toBe(false);
		}
	});
});

describe("collectCredentialDigests", () => {
	it("hashes credential values (and their trimmed form) and ignores short or non-credential values", () => {
		const digests = collectCredentialDigests({
			PRIME_API_KEY: " sk-synthetic-prime-5342\n",
			PATH: "/usr/bin",
			SHORT_TOKEN: "abc",
		});
		expect(digests).toEqual(
			[credentialDigest(" sk-synthetic-prime-5342\n"), credentialDigest("sk-synthetic-prime-5342")].sort(),
		);
		expect(digests).not.toContain(credentialDigest("/usr/bin"));
		expect(digests).not.toContain(credentialDigest("abc"));
	});

	it("produces lowercase sha256 hex digests, as the runtime expects", () => {
		expect(credentialDigest("sk-synthetic-prime-5342")).toMatch(/^[0-9a-f]{64}$/);
	});
});
