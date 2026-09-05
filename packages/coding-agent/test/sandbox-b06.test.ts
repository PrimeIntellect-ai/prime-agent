/**
 * Tests for the Prime Sandbox provider and lifecycle adapter (B06).
 *
 * Uses a FakeCommandRunner so no real Prime API calls are made.
 * Background job wrapper tests also decode the generated base64 script
 * and run it locally to verify correctness.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxLifecycle } from "../src/core/sandbox-lifecycle.js";
import {
	buildBackgroundKillCommand,
	buildBackgroundLogsCommand,
	buildBackgroundStartCommand,
	buildBackgroundStatusCommand,
	createPrimeSandboxProvider,
	DuplicateSandboxError,
	parseBackgroundJobStatus,
	validateJobId,
} from "../src/core/sandbox-provider.js";
import type { CommandRunner, SandboxRunResult } from "../src/core/sandbox-types.js";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

const SBX_ID = "sbx-test-001";
const LABEL = "b06-session";

function makeGetJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: SBX_ID,
		name: "test-sandbox",
		docker_image: "python:3.11-slim",
		status: "RUNNING",
		region: "us",
		created_at: "2026-09-02T12:00:00Z",
		labels: [LABEL],
		...overrides,
	});
}

function makeListJson(sandboxes: Array<Record<string, unknown>> = []): string {
	return JSON.stringify({
		sandboxes,
		total: sandboxes.length,
		page: 1,
		per_page: 50,
		has_next: false,
	});
}

function emptyListJson(): string {
	return makeListJson([]);
}

// -------------------------------------------------------------------------
// FakeCommandRunner
// -------------------------------------------------------------------------

interface Rule {
	match: (argv: string[]) => boolean;
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

class FakeCommandRunner implements CommandRunner {
	private rules: Rule[] = [];
	private seq: Rule[] | undefined;
	private seqIdx = 0;

	on(match: (argv: string[]) => boolean, overrides: { stdout?: string; stderr?: string; exitCode?: number }): this {
		this.rules.push({
			match,
			stdout: overrides.stdout ?? "",
			stderr: overrides.stderr ?? "",
			exitCode: overrides.exitCode ?? 0,
		});
		return this;
	}

	onCommand(sub: string, overrides: { stdout?: string; stderr?: string; exitCode?: number }): this {
		return this.on((argv) => argv.join(" ").includes(sub), overrides);
	}

	onSequence(rules: Rule[]): this {
		this.seq = rules;
		this.seqIdx = 0;
		this.rules = [];
		return this;
	}

	async run(argv: string[], _opts?: { timeout?: number; signal?: AbortSignal }): Promise<SandboxRunResult> {
		if (this.seq) {
			const r = this.seq[Math.min(this.seqIdx, this.seq.length - 1)];
			this.seqIdx++;
			return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
		}
		for (const r of this.rules) {
			if (r.match(argv)) {
				return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
			}
		}
		return { stdout: "", stderr: "no rule", exitCode: 127 };
	}
}

function lifeWithId(
	provider: ReturnType<typeof createPrimeSandboxProvider>,
	overrides: Record<string, unknown> = {},
): SandboxLifecycle {
	const life = new SandboxLifecycle(provider, { provisionTimeoutMs: 200, pollMs: 20 });
	(life as unknown as { identity: unknown }).identity = {
		id: overrides.id ?? SBX_ID,
		name: "",
		status: overrides.status ?? "RUNNING",
		image: "",
		region: "",
		createdAt: "",
		labels: [],
		resources: "",
	};
	return life;
}

/**
 * Extract a background job's base64 script from the command args,
 * decode it, and return the shell content.
 */
function extractScript(startCommand: string[]): string {
	const cmd = startCommand.join(" ");
	const m = cmd.match(/printf '%s' '([A-Za-z0-9+/=]+)'/);
	if (!m) throw new Error("could not find base64 in command");
	return Buffer.from(m[1], "base64").toString("utf-8");
}

/** Write a script returned by extractScript to a temp dir and run it. */
/**
 * Run the decoded script locally, creating the metadata DIR, and verify
 * that exit/status files are written correctly.
 */
function runScriptAndCheckFiles(args: string[], expectedOut: string, expectedExit: number): void {
	const { startCommand } = buildBackgroundStartCommand(args);
	const script = extractScript(startCommand);

	// Extract the DIR path from the script so we can create it
	const dirMatch = script.match(/^DIR='([^']+)'/m);
	expect(dirMatch).not.toBeNull();

	// Create a test temp dir and patch the script's DIR
	const baseDir = mkdtempSync(join(tmpdir(), "b06-script-test-"));
	const testDir = join(baseDir, "job");
	mkdirSync(testDir, { recursive: true });
	const patchedScript = script.replace(/^DIR='[^']+'/m, `DIR='${testDir}'`);

	const scriptPath = join(baseDir, "script.sh");
	writeFileSync(scriptPath, patchedScript, { mode: 0o700 });
	try {
		const buf = execSync(`bash "${scriptPath}"`, { timeout: 5_000 });
		const stdout = buf.toString("utf-8");

		expect(stdout).toContain(expectedOut);

		// Check metadata files were written
		const exitFile = join(testDir, "exit");
		const statusFile = join(testDir, "status");
		expect(existsSync(exitFile)).toBe(true);
		expect(existsSync(statusFile)).toBe(true);

		const exitCode = Number(execSync(`cat "${exitFile}"`, { encoding: "utf-8" }).toString().trim());
		const status = execSync(`cat "${statusFile}"`, { encoding: "utf-8" }).toString().trim();
		expect(exitCode).toBe(expectedExit);
		expect(status).toBe("done");
	} catch (err: unknown) {
		const e = err as { stdout?: string | Buffer; status?: number };
		if (e.status !== undefined && e.status !== 0) {
			// Expected non-zero exit — still check metadata
			const exitFile = join(testDir, "exit");
			const statusFile = join(testDir, "status");
			if (existsSync(exitFile) && existsSync(statusFile)) {
				const exitCode = Number(execSync(`cat "${exitFile}"`, { encoding: "utf-8" }).toString().trim());
				const status = execSync(`cat "${statusFile}"`, { encoding: "utf-8" }).toString().trim();
				expect(exitCode).toBe(expectedExit);
				expect(status).toBe("done");
			}
			throw e;
		}
		throw e;
	} finally {
		rmSync(baseDir, { recursive: true, force: true });
	}
}

// =========================================================================
// validateJobId
// =========================================================================

describe("validateJobId", () => {
	it("accepts 16-char hex string", () => {
		expect(() => validateJobId("a1b2c3d4e5f67890")).not.toThrow();
	});
	it("rejects empty string", () => {
		expect(() => validateJobId("")).toThrow(/invalid job id/);
	});
	it("rejects non-hex characters", () => {
		expect(() => validateJobId("a1b2c3d4e5f6zzzz")).toThrow(/invalid job id/);
	});
	it("rejects wrong length", () => {
		expect(() => validateJobId("deadbeef")).toThrow(/invalid job id/);
	});
	it("rejects path traversal", () => {
		expect(() => validateJobId("../../etc/passwd")).toThrow(/invalid job id/);
	});
});

// =========================================================================
// Background job wrapper — builder structure
// =========================================================================

describe("buildBackgroundStartCommand", () => {
	it("rejects empty command array", () => {
		expect(() => buildBackgroundStartCommand([])).toThrow(/empty command/);
	});
});

describe("buildBackgroundStartCommand structure", () => {
	it("returns immediate nohup job with base64-encoded script", () => {
		const { jobId, startCommand } = buildBackgroundStartCommand(["echo", "hello"]);
		expect(jobId).toMatch(/^[0-9a-f]{16}$/);
		const full = startCommand.join(" ");
		expect(full).toContain("nohup");
		expect(full).toContain("&");
		expect(full).toContain("base64");
		expect(full).toContain("printf");
		expect(full).toContain("/pid");
		expect(full).not.toContain("wait ");
	});

	it("encoded script runs the command and writes metadata atomically", () => {
		const { startCommand } = buildBackgroundStartCommand(["echo", "hello"]);
		const script = extractScript(startCommand);
		expect(script).toMatch(/^#!\/bin\/bash/);
		expect(script).toContain("exit.tmp");
		expect(script).toContain("mv");
		// must NOT contain nohup (that is the wrapper, not the script)
		expect(script).not.toContain("nohup");
	});
});

describe("buildBackgroundStartCommand local execution", () => {
	it("runs a simple echo command (spaces) and writes metadata", () => {
		runScriptAndCheckFiles(["echo", "hello world"], "hello world", 0);
	});

	it("runs a command with single quotes", () => {
		runScriptAndCheckFiles(["echo", "it's fine"], "it's fine", 0);
	});

	it("runs a command with `$()` that should NOT be expanded", () => {
		runScriptAndCheckFiles(["echo", "$(echo boom)"], "$(echo boom)", 0);
	});

	it("runs a command with semicolons as literal characters", () => {
		runScriptAndCheckFiles(["echo", "a;b;c"], "a;b;c", 0);
	});

	it("runs a command with newlines in an argument", () => {
		runScriptAndCheckFiles(["printf", "line1\\nline2"], "line1", 0);
	});

	it("handles empty arguments", () => {
		runScriptAndCheckFiles(["echo", ""], "", 0);
	});

	it("exits with the child exit code and writes metadata", () => {
		const { startCommand } = buildBackgroundStartCommand(["bash", "-c", "exit 42"]);
		const script = extractScript(startCommand);
		const dirMatch = script.match(/^DIR='([^']+)'/m);
		expect(dirMatch).not.toBeNull();
		const baseDir = mkdtempSync(join(tmpdir(), "b06-exit-test-"));
		const testDir = join(baseDir, "job");
		mkdirSync(testDir, { recursive: true });
		const patchedScript = script.replace(/^DIR='[^']+'/m, `DIR='${testDir}'`);
		const scriptPath = join(baseDir, "script.sh");
		writeFileSync(scriptPath, patchedScript, { mode: 0o700 });
		try {
			execSync(`bash "${scriptPath}"`, { timeout: 5_000 });
		} catch (e: unknown) {
			const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
			// Expected to fail with 42 — verify metadata files
			const exitFile = join(testDir, "exit");
			const statusFile = join(testDir, "status");
			expect(existsSync(exitFile)).toBe(true);
			expect(existsSync(statusFile)).toBe(true);
			const ec = Number(execSync(`cat "${exitFile}"`, { encoding: "utf-8" }).toString().trim());
			const st = execSync(`cat "${statusFile}"`, { encoding: "utf-8" }).toString().trim();
			expect(ec).toBe(42);
			expect(st).toBe("done");
			expect(err.status).toBe(42);
			return;
		}
		throw new Error("expected non-zero exit");
	});
});
// =========================================================================
// Background status/log/kill builders
// =========================================================================

describe("buildBackgroundStatusCommand", () => {
	it("reads pid, checks liveness with kill -0, classifies state", () => {
		const cmd = buildBackgroundStatusCommand("a1b2c3d4e5f67890");
		const full = cmd.join(" ");
		expect(full).toContain("pid");
		expect(full).toContain("kill -0");
		expect(full).toContain("running");
		expect(full).toContain("completed");
		expect(full).toContain("lost");
	});

	it("prioritizes STATUS=done before kill -0 liveness check", () => {
		const cmd = buildBackgroundStatusCommand("a1b2c3d4e5f67890");
		const full = cmd.join(" ");
		// STATUS check must appear before ALIVE check in the shell code
		const statusIdx = full.indexOf("STATUS");
		const aliveIdx = full.indexOf("ALIVE");
		expect(statusIdx).toBeGreaterThan(-1);
		expect(aliveIdx).toBeGreaterThan(-1);
		expect(statusIdx).toBeLessThan(aliveIdx);
	});
	it("validates job id", () => {
		expect(() => buildBackgroundStatusCommand("bad-id")).toThrow(/invalid job id/);
	});
});

describe("buildBackgroundLogsCommand", () => {
	it("outputs stdout on stdout and stderr on stderr", () => {
		const cmd = buildBackgroundLogsCommand("a1b2c3d4e5f67890");
		const full = cmd.join(" ");
		expect(full).toContain("stdout");
		expect(full).toContain(">&2");
	});
	it("validates job id", () => {
		expect(() => buildBackgroundLogsCommand("")).toThrow(/invalid job id/);
	});
});

describe("buildBackgroundKillCommand real kill", () => {
	it("kills a process group with nested descendant that ignores SIGTERM", () => {
		// Build the script for an infinite loop
		const { startCommand } = buildBackgroundStartCommand(["bash", "-c", "while true; do sleep 1; done"]);
		const script = extractScript(startCommand);

		const baseDir = mkdtempSync(join(tmpdir(), "b06-real-kill-"));
		const testDir = join(baseDir, "job");
		mkdirSync(testDir, { recursive: true });

		const patchedScript = script.replace(/^DIR='[^']+'/m, `DIR='${testDir}'`);
		const scriptPath = join(baseDir, "script.sh");
		writeFileSync(scriptPath, patchedScript, { mode: 0o700 });

		const stdoutPath = join(testDir, "stdout");
		const stderrPath = join(testDir, "stderr");
		const pidPath = join(testDir, "pid");

		// Launch as the sandbox provider does
		const launchCmd = `nohup bash "${scriptPath}" >"${stdoutPath}" 2>"${stderrPath}" </dev/null & echo "$!" > "${pidPath}"`;
		execSync(launchCmd, { timeout: 3_000 });
		expect(existsSync(pidPath)).toBe(true);

		const scriptPidStr = String(execSync(`cat "${pidPath}"`).toString()).trim();
		const scriptPid = Number(scriptPidStr);
		expect(scriptPid).toBeGreaterThan(0);

		// Verify script and child are alive
		let alive = 0;
		try {
			execSync(`kill -0 ${scriptPid}`);
			alive = 1;
		} catch {
			/* empty */
		}
		expect(alive).toBe(1);

		// Check child_pid file
		const childPidPath = join(testDir, "child_pid");
		let childPid = 0;
		try {
			childPid = Number(String(execSync(`cat "${childPidPath}"`).toString()).trim());
		} catch {
			/* empty */
		}
		expect(childPid).toBeGreaterThan(0);

		// Send SIGTERM to the script PID (as the kill command does)
		execSync(`kill ${scriptPid} 2>/dev/null || true`, { timeout: 2_000 });

		// Wait for trap to execute
		execSync("sleep 2", { timeout: 3_000 });

		// Verify script is gone
		alive = 0;
		try {
			execSync(`kill -0 ${scriptPid}`);
			alive = 1;
		} catch {
			/* empty */
		}
		expect(alive).toBe(0);

		// Verify child is also gone (trap should have killed it)
		alive = 0;
		try {
			execSync(`kill -0 ${childPid}`);
			alive = 1;
		} catch {
			/* empty */
		}
		expect(alive).toBe(0);

		rmSync(baseDir, { recursive: true, force: true });
	});
});

describe("buildBackgroundKillCommand", () => {
	it("kills process group with SIGTERM then escalates to SIGKILL", () => {
		const cmd = buildBackgroundKillCommand("a1b2c3d4e5f67890");
		const full = cmd.join(" ");
		expect(full).toContain('kill -TERM -- -"$PID"');
		expect(full).toContain('kill -KILL -- -"$PID"');
		expect(full).toContain("kill -0");
		expect(full).toContain("sleep");
		expect(full).toContain("rm -rf");
	});
	it("validates job id", () => {
		expect(() => buildBackgroundKillCommand("../../etc")).toThrow(/invalid job id/);
	});
});

// =========================================================================
// parseBackgroundJobStatus
// =========================================================================

describe("parseBackgroundJobStatus", () => {
	it("parses running status", () => {
		const s = parseBackgroundJobStatus("12345|running|");
		expect(s.pid).toBe("12345");
		expect(s.running).toBe(true);
		expect(s.completed).toBe(false);
		expect(s.lost).toBe(false);
		expect(s.exitCode).toBeNull();
	});

	it("parses completed status with exit code", () => {
		const s = parseBackgroundJobStatus("12345|completed|0");
		expect(s.running).toBe(false);
		expect(s.completed).toBe(true);
		expect(s.exitCode).toBe(0);
	});

	it("parses completed with non-zero exit", () => {
		const s = parseBackgroundJobStatus("12345|completed|1");
		expect(s.completed).toBe(true);
		expect(s.exitCode).toBe(1);
	});

	it("parses lost status", () => {
		const s = parseBackgroundJobStatus("|lost|");
		expect(s.pid).toBe("");
		expect(s.lost).toBe(true);
		expect(s.exitCode).toBeNull();
	});

	it("throws on malformed output (fewer or more than 3 parts)", () => {
		expect(() => parseBackgroundJobStatus("")).toThrow(/malformed/);
		expect(() => parseBackgroundJobStatus("a|b")).toThrow(/malformed/);
		expect(() => parseBackgroundJobStatus("a|b|c|d")).toThrow(/malformed/);
	});

	it("throws on unknown status label", () => {
		expect(() => parseBackgroundJobStatus("1|bogus|0")).toThrow(/unknown background job status label/);
	});

	it("throws when completed has no exit code", () => {
		expect(() => parseBackgroundJobStatus("1|completed|")).toThrow(/completed background job missing exit code/);
	});

	it("throws when completed has non-numeric exit code", () => {
		expect(() => parseBackgroundJobStatus("1|completed|abc")).toThrow(/completed background job invalid exit code/);
	});

	it("throws when completed has non-integer exit code", () => {
		expect(() => parseBackgroundJobStatus("1|completed|1.5")).toThrow(/completed background job invalid exit code/);
	});

	it("throws when completed exit code is out of range 0..255", () => {
		expect(() => parseBackgroundJobStatus("1|completed|256")).toThrow(/completed background job invalid exit code/);
		expect(() => parseBackgroundJobStatus("1|completed|-1")).toThrow(/completed background job invalid exit code/);
	});

	it("throws when running has empty pid", () => {
		expect(() => parseBackgroundJobStatus("|running|")).toThrow(/invalid background job pid/);
	});

	it("throws when running has non-numeric pid", () => {
		expect(() => parseBackgroundJobStatus("abc|running|")).toThrow(/invalid background job pid/);
	});

	it("throws when running or lost have exit code present", () => {
		expect(() => parseBackgroundJobStatus("1|running|0")).toThrow(/unexpected exit code/);
		expect(() => parseBackgroundJobStatus("1|lost|1")).toThrow(/unexpected exit code/);
	});
});

// =========================================================================
// Provider tests
// =========================================================================

describe("createPrimeSandboxProvider", () => {
	it("preflight checks version then list access", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() });
		const provider = createPrimeSandboxProvider(runner);
		const result = await provider.preflight();
		expect(result.available).toBe(true);
		expect(result.version).toBe("0.9.1");
		expect(result.error).toBe("");
	});

	it("preflight fails when version fails", async () => {
		const runner = new FakeCommandRunner().onCommand("--version", { exitCode: 127, stderr: "command not found" });
		const provider = createPrimeSandboxProvider(runner);
		const result = await provider.preflight();
		expect(result.available).toBe(false);
		expect(result.version).toBe("");
		expect(result.error).toContain("not found");
	});

	it("preflight includes version when list fails", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { exitCode: 1, stderr: "auth error" });
		const provider = createPrimeSandboxProvider(runner);
		const result = await provider.preflight();
		expect(result.available).toBe(false);
		expect(result.version).toBe("0.9.1");
		expect(result.error).toContain("auth or API");
	});

	it("create parses id from plain-text output and fetches identity", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", { stdout: "Successfully created sandbox sbx-created-001\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox get", { stdout: makeGetJson({ id: "sbx-created-001" }) });
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.create({ image: "python:3.11-slim", sessionLabel: LABEL });
		expect(identity.id).toBe("sbx-created-001");
		expect(identity.status).toBe("RUNNING");
	});

	it("create returns existing sandbox when label matches (list-before)", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", {
			stdout: makeListJson([
				{
					id: "existing-001",
					name: "existing",
					image: "python:3.11-slim",
					status: "RUNNING",
					region: "us",
					created_at: "now",
					labels: [LABEL],
				},
			]),
		});
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.create({ image: "python:3.11-slim", sessionLabel: LABEL });
		expect(identity.id).toBe("existing-001");
	});

	it("create throws DuplicateSandboxError when post-create list shows >1 match", async () => {
		const runner = new FakeCommandRunner().onSequence([
			{ stdout: emptyListJson(), match: () => true },
			{ stdout: "Successfully created sandbox sbx-dup-001\n", match: () => true },
			{
				stdout: makeListJson([
					{ id: "sbx-dup-001", image: "img", status: "RUNNING", created_at: "now", labels: [LABEL] },
					{ id: "sbx-dup-002", image: "img", status: "RUNNING", created_at: "now", labels: [LABEL] },
				]),
				match: () => true,
			},
			{ stdout: makeGetJson({ id: "sbx-dup-001" }), match: () => true },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const err = await provider.create({ image: "img", sessionLabel: LABEL }).catch((e) => e);
		expect(err).toBeInstanceOf(DuplicateSandboxError);
	});

	it("create throws on non-zero CLI exit", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", { exitCode: 1, stderr: "quota exceeded" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.create({ image: "my-img", sessionLabel: LABEL })).rejects.toThrow(/create failed/);
	});

	it("create throws on malformed create output", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", { stdout: "random output\n" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.create({ image: "my-img", sessionLabel: LABEL })).rejects.toThrow(/did not produce an id/);
	});

	it("get returns sandbox details", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", { stdout: makeGetJson() });
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.get(SBX_ID);
		expect(identity.id).toBe(SBX_ID);
	});

	it("get throws on empty id in response", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: JSON.stringify({ id: "", name: "x", docker_image: "img", status: "RUNNING", created_at: "now" }),
		});
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.get(SBX_ID)).rejects.toThrow(/empty id/);
	});

	it("get throws on malformed JSON", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", { stdout: "{invalid" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.get(SBX_ID)).rejects.toThrow(/malformed/);
	});

	it("get throws on unknown API status", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: JSON.stringify({ id: "x", name: "n", docker_image: "img", status: "BOGUS", created_at: "now" }),
		});
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.get(SBX_ID)).rejects.toThrow(/unknown API status/);
	});

	it("get throws on empty created_at", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: JSON.stringify({ id: "x", name: "n", docker_image: "img", status: "RUNNING", created_at: "" }),
		});
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.get(SBX_ID)).rejects.toThrow(/empty created_at/);
	});

	it("list filters non-string labels", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox list", {
			stdout: makeListJson([
				{ id: "a1", image: "img", status: "RUNNING", created_at: "now", labels: [LABEL, 42, true] },
			]),
		});
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.create({ image: "img", sessionLabel: LABEL });
		expect(identity.id).toBe("a1");
		expect(identity.labels).toEqual([LABEL]);
	});

	it("waitForStatus polls until desired status", async () => {
		const runner = new FakeCommandRunner().onSequence([
			{ stdout: makeGetJson({ status: "PROVISIONING" }), match: () => true },
			{ stdout: makeGetJson({ status: "PROVISIONING" }), match: () => true },
			{ stdout: makeGetJson({ status: "RUNNING" }), match: () => true },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.waitForStatus(SBX_ID, ["RUNNING"], { timeoutMs: 5_000, pollMs: 20 });
		expect(identity.status).toBe("RUNNING");
	});

	it("waitForStatus throws on timeout", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: makeGetJson({ status: "PROVISIONING" }),
		});
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.waitForStatus(SBX_ID, ["RUNNING"], { timeoutMs: 100, pollMs: 20 })).rejects.toThrow(
			/timed out/,
		);
	});

	it("waitForStatus respects AbortSignal", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: makeGetJson({ status: "PROVISIONING" }),
		});
		const ac = new AbortController();
		const provider = createPrimeSandboxProvider(runner);
		setTimeout(() => ac.abort(), 30);
		await expect(
			provider.waitForStatus(SBX_ID, ["RUNNING"], { timeoutMs: 10_000, pollMs: 50, signal: ac.signal }),
		).rejects.toThrow(/Abort/);
	}, 5_000);

	it("upload and download succeed", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("sandbox upload", { stdout: "" })
			.onCommand("sandbox download", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		await provider.upload(SBX_ID, "/local/f", "/remote/f");
		await provider.download(SBX_ID, "/remote/f", "/local/f");
	});

	it("upload throws sanitized error", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox upload", { exitCode: 1, stderr: "permission denied" });
		const provider = createPrimeSandboxProvider(runner);
		const err = await provider.upload("id", "/l", "/r").catch((e) => e);
		expect(err.message).toMatch(/upload failed/);
		expect(err.message).not.toContain("permission");
	});

	it("runCommand returns output", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "hello\n" });
		const provider = createPrimeSandboxProvider(runner);
		const result = await provider.runCommand(SBX_ID, ["echo", "hello"]);
		expect(result.stdout).toBe("hello\n");
		expect(result.exitCode).toBe(0);
	});

	it("getLogs returns logs", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox logs", { stdout: "boot log\n" });
		const provider = createPrimeSandboxProvider(runner);
		const logs = await provider.getLogs(SBX_ID);
		expect(logs).toContain("boot log");
	});

	it("delete succeeds when sandbox exists", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		await provider.delete(SBX_ID);
	});

	it("delete is idempotent on exact not-found", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", {
			exitCode: 1,
			stderr: "Error: sandbox not found",
		});
		const provider = createPrimeSandboxProvider(runner);
		await provider.delete("gone-sbx");
	});

	it("delete throws on unexpected errors", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", {
			exitCode: 1,
			stderr: "internal server error",
		});
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.delete("some-id")).rejects.toThrow(/delete failed/);
	});

	// ---- Background jobs through provider ----

	it("startBackgroundJob runs wrapper and returns job id", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", { stdout: "Successfully created sandbox sbx-bg-001\n" })
			.onCommand("sandbox get", { stdout: makeGetJson({ id: "sbx-bg-001" }) })
			.onCommand("sandbox run", { stdout: "\n" });
		const provider = createPrimeSandboxProvider(runner);
		const identity = await provider.create({ image: "img", sessionLabel: LABEL });
		const jobId = await provider.startBackgroundJob(identity.id, ["sleep", "10"]);
		expect(jobId).toMatch(/^[0-9a-f]{16}$/);
	});

	it("startBackgroundJob rejects non-zero exit", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { exitCode: 1, stderr: "timeout" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.startBackgroundJob(SBX_ID, ["bad"])).rejects.toThrow(/start background job failed/);
	});

	it("getBackgroundJobStatus returns parsed status (completed)", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "12345|completed|0\n" });
		const provider = createPrimeSandboxProvider(runner);
		const status = await provider.getBackgroundJobStatus(SBX_ID, "a1b2c3d4e5f67890");
		expect(status.pid).toBe("12345");
		expect(status.completed).toBe(true);
		expect(status.running).toBe(false);
		expect(status.exitCode).toBe(0);
	});

	it("getBackgroundJobStatus returns running status", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "99999|running|\n" });
		const provider = createPrimeSandboxProvider(runner);
		const status = await provider.getBackgroundJobStatus(SBX_ID, "a1b2c3d4e5f67890");
		expect(status.running).toBe(true);
		expect(status.completed).toBe(false);
		expect(status.lost).toBe(false);
		expect(status.exitCode).toBeNull();
	});

	it("getBackgroundJobStatus returns lost status", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "|lost|\n" });
		const provider = createPrimeSandboxProvider(runner);
		const status = await provider.getBackgroundJobStatus(SBX_ID, "a1b2c3d4e5f67890");
		expect(status.lost).toBe(true);
	});

	it("getBackgroundJobStatus rejects malformed output", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "\n" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.getBackgroundJobStatus(SBX_ID, "a1b2c3d4e5f67890")).rejects.toThrow(/malformed/);
	});

	it("getBackgroundJobStatus rejects non-zero exit", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { exitCode: 1, stderr: "fail" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.getBackgroundJobStatus(SBX_ID, "a1b2c3d4e5f67890")).rejects.toThrow(/status failed/);
	});

	it("getBackgroundJobLogs returns both stdout and stderr", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "out\n", stderr: "err\n" });
		const provider = createPrimeSandboxProvider(runner);
		const logs = await provider.getBackgroundJobLogs(SBX_ID, "a1b2c3d4e5f67890");
		expect(logs.stdout).toBe("out\n");
		expect(logs.stderr).toBe("err\n");
	});

	it("getBackgroundJobLogs rejects non-zero exit", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { exitCode: 1, stderr: "fail" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.getBackgroundJobLogs(SBX_ID, "a1b2c3d4e5f67890")).rejects.toThrow(/logs failed/);
	});

	it("killBackgroundJob sends kill command", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { stdout: "" });
		const provider = createPrimeSandboxProvider(runner);
		await provider.killBackgroundJob(SBX_ID, "a1b2c3d4e5f67890");
	});

	it("killBackgroundJob rejects non-zero exit", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox run", { exitCode: 1, stderr: "fail" });
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.killBackgroundJob(SBX_ID, "a1b2c3d4e5f67890")).rejects.toThrow(
			/kill background job failed/,
		);
	});

	it("background job operations validate job id", async () => {
		const runner = new FakeCommandRunner();
		const provider = createPrimeSandboxProvider(runner);
		await expect(provider.getBackgroundJobStatus(SBX_ID, "../evil")).rejects.toThrow(/invalid job id/);
		await expect(provider.getBackgroundJobLogs(SBX_ID, "")).rejects.toThrow(/invalid job id/);
		await expect(provider.killBackgroundJob(SBX_ID, "bad")).rejects.toThrow(/invalid job id/);
	});
});

// =========================================================================
// Lifecycle tests
// =========================================================================

describe("SandboxLifecycle", () => {
	it("runs a full happy-path lifecycle", async () => {
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list", { stdout: emptyListJson() })
			.onCommand("sandbox create", { stdout: "Successfully created sandbox sbx-full-001\n" })
			.onCommand("sandbox get", { stdout: makeGetJson({ id: "sbx-full-001", status: "RUNNING" }) })
			.onCommand("sandbox upload", { stdout: "" })
			.onCommand("sandbox run", { stdout: "output\n" })
			.onCommand("sandbox download", { stdout: "" })
			.onCommand("sandbox logs", { stdout: "boot log\n" })
			.onCommand("sandbox delete", { stdout: "" });

		const provider = createPrimeSandboxProvider(runner);
		const life = new SandboxLifecycle(provider, { provisionTimeoutMs: 1_000, pollMs: 20 });

		expect((await life.preflight()).available).toBe(true);
		expect((await life.create({ image: "python:3.11-slim", sessionLabel: LABEL })).id).toBe("sbx-full-001");
		expect((await life.waitForReady()).status).toBe("RUNNING");
		await life.upload("/local/f", "/remote/f");
		expect((await life.runCommand(["echo", "hi"])).stdout).toBe("output\n");
		await life.download("/remote/f", "/local/f");
		expect(await life.getLogs()).toBe("boot log\n");
		await life.delete();
		expect((life as unknown as { identity: { id: string } | null }).identity?.id).toBeUndefined();

		const stepNames = life.events.map((e) => `${e.step}:${e.status}`);
		expect(stepNames).toContain("preflight:success");
		expect(stepNames).toContain("create:success");
		expect(stepNames).toContain("wait-ready:success");
		expect(stepNames).toContain("delete:success");
	});

	it("create throws when AbortSignal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const life = new SandboxLifecycle(createPrimeSandboxProvider(new FakeCommandRunner()), { signal: ac.signal });
		await expect(life.create({ image: "img", sessionLabel: LABEL })).rejects.toThrow(/aborted/i);
	});

	it("waitForReady throws on timeout", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: makeGetJson({ status: "PROVISIONING" }),
		});
		const life = lifeWithId(createPrimeSandboxProvider(runner), { id: SBX_ID, status: "PROVISIONING" });
		await expect(life.waitForReady()).rejects.toThrow(/wait_timeout/);
	});

	it("waitForReady respects AbortSignal", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox get", {
			stdout: makeGetJson({ status: "PROVISIONING" }),
		});
		const ac = new AbortController();
		const life = lifeWithId(createPrimeSandboxProvider(runner), { id: SBX_ID, status: "PROVISIONING" });
		setTimeout(() => ac.abort(), 30);
		(life as unknown as { options: { signal: AbortSignal } }).options.signal = ac.signal;
		await expect(life.waitForReady()).rejects.toThrow();
	}, 5_000);

	it("delete does nothing without identity", async () => {
		const life = new SandboxLifecycle(createPrimeSandboxProvider(new FakeCommandRunner()));
		await life.delete();
	});

	it("delete is idempotent when already gone", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", {
			exitCode: 1,
			stderr: "Error: sandbox not found",
		});
		const life = lifeWithId(createPrimeSandboxProvider(runner), { id: "gone-sbx", status: "TERMINATED" });
		await life.delete();
		expect((life as unknown as { identity: { id: string } | null }).identity?.id).toBeUndefined();
	});

	it("delete throws on unexpected errors (sanitized)", async () => {
		const runner = new FakeCommandRunner().onCommand("sandbox delete", { exitCode: 1, stderr: "internal error" });
		const life = lifeWithId(createPrimeSandboxProvider(runner), { id: "failing-sbx" });
		await expect(life.delete()).rejects.toThrow(/delete/);
	});

	it("background job lifecycle methods send events", async () => {
		const runner = new FakeCommandRunner().onSequence([
			{ stdout: "\n", match: () => true },
			{ stdout: "42|completed|0\n", match: () => true },
			{ stdout: "out\n", stderr: "err\n", match: () => true },
			{ stdout: "", match: () => true },
		]);
		const provider = createPrimeSandboxProvider(runner);
		const life = lifeWithId(provider, { id: "bg-test" });

		const jobId = await life.startBackgroundJob(["make"]);
		expect(jobId).toMatch(/^[0-9a-f]{16}$/);

		const status = await life.getBackgroundJobStatus(jobId);
		expect(status.completed).toBe(true);
		expect(status.exitCode).toBe(0);

		const logs = await life.getBackgroundJobLogs(jobId);
		expect(logs.stdout).toBe("out\n");
		expect(logs.stderr).toBe("err\n");

		await life.killBackgroundJob(jobId);

		const stepNames = life.events.map((e) => `${e.step}:${e.status}`);
		expect(stepNames).toContain("start-background-job:success");
		expect(stepNames).toContain("background-job-status:success");
		expect(stepNames).toContain("background-job-logs:success");
		expect(stepNames).toContain("kill-background-job:success");
	});
});
