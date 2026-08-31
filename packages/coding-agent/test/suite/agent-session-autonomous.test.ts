import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	addAutonomousUsage,
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	nextAutonomousContinuation,
	shouldAutonomouslyContinue,
} from "../../src/core/autonomous.js";
import type { AgentCronJob } from "../../src/core/cron-jobs.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";

function isProcessRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (isProcessRunning(pid) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	return !isProcessRunning(pid);
}

async function waitForPidFile(path: string, timeoutMs = 2000): Promise<number> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path) && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 25));
	}
	if (!existsSync(path)) {
		throw new Error(`Timed out waiting for process ID file: ${path}`);
	}
	return Number.parseInt(readFileSync(path, "utf8"), 10);
}

describe("AgentSession autonomous mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects a host-side continuation when the assistant asks the user for help", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Which package manager should I use?"),
			fauxAssistantMessage("I inspected the repo and used npm."),
		]);

		await harness.session.prompt("fix the project");

		expect(getAssistantTexts(harness)).toEqual([
			"Which package manager should I use?",
			"I inspected the repo and used npm.",
		]);
		expect(getUserTexts(harness)).toEqual(["fix the project", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("continues through a claimed external blocker instead of trusting prose", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Blocked: this requires an API key credential from the user."),
			fauxAssistantMessage(
				"I will inspect the environment and verify whether the credential is actually unavailable.",
			),
		]);

		await harness.session.prompt("run the private eval");

		expect(getUserTexts(harness)).toEqual(["run the private eval", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("stops after the configured autonomous continuation limit", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Can you confirm the test command?"),
			fauxAssistantMessage("Can you confirm whether to run lint too?"),
		]);

		await harness.session.prompt("make the change");

		expect(getAssistantTexts(harness)).toEqual([
			"Can you confirm the test command?",
			"Can you confirm whether to run lint too?",
		]);
		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("does not count failed assistant messages against autonomous usage limits", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxTurns: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("failed", { stopReason: "error", errorMessage: "provider failed" })]);

		await harness.session.prompt("try once");

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			turnsUsed: 0,
			tokensUsed: 0,
			continuationsUsed: 0,
		});
	});

	it("counts aborted assistant messages against autonomous usage limits", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxTurns: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("aborted", { stopReason: "aborted" })]);

		await harness.session.prompt("try once");

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			turnsUsed: 1,
			continuationsUsed: 0,
		});
	});

	it("supports /autonomous on and off without calling the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on");
		await harness.session.prompt("/autonomous off");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		const statusMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "autonomous_status",
		);
		expect(statusMessages).toHaveLength(2);
	});

	it("continues when the assistant tries to finish without terminal evidence", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("I will collect concrete evidence.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("continues after a git worktree change instead of letting the agent self-terminate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		execFileSync("git", ["init"], { cwd: harness.tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: harness.tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: harness.tempDir });
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "before\n");
		execFileSync("git", ["add", "file.txt"], { cwd: harness.tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: harness.tempDir,
			stdio: "ignore",
		});
		await harness.session.prompt("/autonomous on");
		writeFileSync(path, "after\n");
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Continuing until the evaluator stops me."),
		]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)[0]).toBe("make the change");
		expect(getUserTexts(harness).slice(1)).toContain(DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBeGreaterThan(0);
	});

	it("runs autonomous gates before applying usage limits", async () => {
		const state = createAutonomousRuntimeState({
			enabled: true,
			maxTurns: 1,
			gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
		});
		state.turnsUsed = 1;
		state.lastGateFailure = {
			command: "stale gate",
			attempt: 1,
			exitText: "exited 1",
			output: "stale failure",
		};

		expect(
			await shouldAutonomouslyContinue(state, fauxAssistantMessage("Done."), { cwd: process.cwd() }),
		).toMatchObject({
			shouldContinue: false,
			reason: "not_needed",
		});
		expect(state.lastGateFailure).toBeUndefined();
	});

	it("lets passing autonomous gates complete the run under verifier control", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change"]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("feeds failing autonomous gate output back into the session", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: {
					commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
					maxRetries: 2,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("I will fix the gate failure.")]);

		await harness.session.prompt("make the change");

		const users = getUserTexts(harness);
		expect(users[1]).toContain("Autonomous quality gate failed");
		expect(users[1]).toContain("gate failed");
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("suppresses autonomous continuation injection for host-driven gate prompts", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: {
					commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
					maxRetries: 2,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Still failing.")]);

		harness.session.recordHostAutonomousContinuation();
		await harness.session.prompt("host gate follow-up", {
			internalPrompt: true,
			suppressAutonomousContinuation: true,
		});

		expect(getUserTexts(harness)).toEqual(["host gate follow-up"]);
		expect(getAssistantTexts(harness)).toEqual(["Still failing."]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("suppresses autonomous continuation injection for queued host-driven prompts", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 2,
				gates: {
					commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
					maxRetries: 2,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Still failing.")]);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();
		const heartbeatJob = {
			id: "heartbeat-test",
			status: "active",
			activeSessionId: "active-test",
			sessionId: harness.session.sessionId,
			sessionFile: harness.session.sessionFile ?? "session.jsonl",
			cwd: harness.tempDir,
			prompt: "host gate follow-up",
			schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			runCount: 0,
		} satisfies AgentCronJob;

		await harness.session.promptHeartbeat(heartbeatJob, {
			queueIfBusy: true,
			streamingBehavior: "followUp",
			suppressAutonomousContinuation: true,
		});
		sessionInternals._compactionAbortController = undefined;
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await vi.waitFor(() => expect(harness.session.queuedActionCount).toBe(0));
		await harness.session.waitForSessionInputIdle();

		expect(getAssistantTexts(harness)).toEqual(["Still failing."]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("advances retry budget without rerunning a failed autonomous gate until the workspace changes", async () => {
		const tempDir = join(process.cwd(), `.tmp-autonomous-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		execFileSync("mkdir", ["-p", join(tempDir, "verification")]);
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		writeFileSync(join(tempDir, "src.rs"), "initial\n");
		execFileSync("git", ["add", "src.rs"], { cwd: tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		try {
			const counter = join(tempDir, "verification", "public_feedback_scores.jsonl");
			const gate = `${process.execPath} -e "const fs=require('fs'); const p='${counter}'; const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(/\\n/).filter(Boolean).length:0; fs.appendFileSync(p,JSON.stringify({run:n+1,score:0})+'\\n'); process.exit(1);"`;
			const state = createAutonomousRuntimeState(
				{ enabled: true, maxContinuations: 3, gates: { commands: [gate], maxRetries: 3 } },
				{ cwd: tempDir },
			);

			const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			writeFileSync(join(tempDir, "Cargo.lock"), "generated lockfile\n");
			const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: tempDir });

			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(getMessageText(second)).toContain("workspace has not changed");
			expect(getMessageText(second)).toContain("Edit source files");
			expect(readFileSync(counter, "utf8").trim().split(/\n/)).toHaveLength(1);
			expect(state.gateAttempts[gate]).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reruns a failed autonomous gate when untracked file contents change", async () => {
		const tempDir = join(
			process.cwd(),
			`.tmp-autonomous-untracked-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		execFileSync("mkdir", ["-p", tempDir]);
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		writeFileSync(join(tempDir, "src.rs"), "initial\n");
		execFileSync("git", ["add", "src.rs"], { cwd: tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		try {
			const candidate = join(tempDir, "candidate.txt");
			writeFileSync(candidate, "bad\n");
			const gate = `${process.execPath} -e "const fs=require('fs'); process.exit(fs.readFileSync('candidate.txt','utf8').trim()==='good'?0:1)"`;
			const state = createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 3,
				gates: { commands: [gate], maxRetries: 3 },
			});

			const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			writeFileSync(candidate, "good\n");
			const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), {
				cwd: tempDir,
			});

			expect(first).toBeDefined();
			expect(second).toBeUndefined();
			expect(state.lastGateFailure).toBeUndefined();
			expect(state.gateAttempts[gate]).toBe(0);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("bounds captured autonomous gate output", async () => {
		const gate = `${process.execPath} -e "process.stdout.write('x'.repeat(20000)); process.exit(1)"`;
		const state = createAutonomousRuntimeState({
			enabled: true,
			maxContinuations: 1,
			gates: { commands: [gate], maxRetries: 1 },
		});

		await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: process.cwd() });

		expect(state.lastGateFailure?.output).toContain("... [truncated]");
		expect(state.lastGateFailure?.output.length).toBeLessThan(6100);
	});

	it("terminates the autonomous gate process tree when the timeout expires", async () => {
		const tempDir = join(
			process.cwd(),
			`.tmp-autonomous-process-tree-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		execFileSync("mkdir", ["-p", tempDir]);
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		const pidFile = join(tempDir, "descendant.pid");
		const script = join(tempDir, "gate.cjs");
		writeFileSync(
			script,
			`const { spawn } = require("node:child_process");\n` +
				`const { writeFileSync } = require("node:fs");\n` +
				`const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });\n` +
				`writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
				`setTimeout(() => {}, 60000);\n`,
		);
		let descendantPid: number | undefined;
		try {
			const state = createAutonomousRuntimeState({
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [`${process.execPath} gate.cjs`], maxRetries: 1, timeoutMs: 250 },
			});
			const startedAt = Date.now();

			await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			descendantPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);

			expect(Date.now() - startedAt).toBeLessThan(3000);
			expect(state.lastGateFailure?.exitText).toBe("timed out");
			expect(await waitForProcessExit(descendantPid)).toBe(true);
		} finally {
			if (descendantPid && isProcessRunning(descendantPid)) {
				process.kill(descendantPid, "SIGKILL");
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("terminates an autonomous gate without mutating retry state when the session is aborted", async () => {
		const gate = `${process.execPath} -e "const fs=require('fs'); fs.writeFileSync('gate.pid', String(process.pid)); setTimeout(() => {}, 60000)"`;
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [gate], maxRetries: 1 },
			},
		});
		harnesses.push(harness);
		execFileSync("git", ["init"], { cwd: harness.tempDir, stdio: "ignore" });
		const pidFile = join(harness.tempDir, "gate.pid");
		let gatePid: number | undefined;
		try {
			harness.setResponses([fauxAssistantMessage("Done.")]);

			const prompt = harness.session.prompt("make the change");
			gatePid = await waitForPidFile(pidFile);
			await harness.session.abort();
			await prompt;

			expect(await waitForProcessExit(gatePid)).toBe(true);
			expect(harness.session.getAutonomousStatus()).toMatchObject({
				continuationsUsed: 0,
				gateAttempts: {},
				lastGateFailure: undefined,
			});
		} finally {
			if (gatePid && isProcessRunning(gatePid)) {
				process.kill(gatePid, "SIGKILL");
			}
		}
	});

	it("stops autonomous continuation once gate retries are exhausted", async () => {
		const state = createAutonomousRuntimeState({
			enabled: true,
			maxContinuations: 5,
			gates: { commands: [`${process.execPath} -e "process.exit(1)"`], maxRetries: 1 },
		});

		const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: process.cwd() });
		const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), {
			cwd: process.cwd(),
		});

		expect(first).toBeDefined();
		expect(second).toBeUndefined();
		expect(state.continuationsUsed).toBe(1);
	});

	it("records the post-failure worktree snapshot for gate rerun suppression", async () => {
		const tempDir = join(
			process.cwd(),
			`.tmp-autonomous-post-snapshot-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		execFileSync("mkdir", ["-p", tempDir]);
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		writeFileSync(join(tempDir, "src.rs"), "initial\n");
		execFileSync("git", ["add", "src.rs"], { cwd: tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		try {
			const generated = join(tempDir, "generated.txt");
			const gate = `${process.execPath} -e "const fs=require('fs'); fs.appendFileSync('${generated}', 'run\\n'); process.exit(1);"`;
			const state = createAutonomousRuntimeState(
				{ enabled: true, maxContinuations: 3, gates: { commands: [gate], maxRetries: 3 } },
				{ cwd: tempDir },
			);

			const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: tempDir });

			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(getMessageText(second)).toContain("workspace has not changed");
			expect(readFileSync(generated, "utf8").trim().split(/\n/)).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count cache-read tokens against the autonomous token budget", async () => {
		const state = createAutonomousRuntimeState({ enabled: true, maxTokens: 10 });

		addAutonomousUsage(state, {
			input: 2,
			output: 3,
			cacheRead: 1_000,
			cacheWrite: 4,
			totalTokens: 1_009,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		expect(state.tokensUsed).toBe(9);
		expect(await shouldAutonomouslyContinue(state, fauxAssistantMessage("Done."))).toMatchObject({
			shouldContinue: true,
		});
	});

	it("does not use assistant prose as terminal blocker evidence", async () => {
		const state = createAutonomousRuntimeState({ enabled: true });

		expect(
			await shouldAutonomouslyContinue(state, fauxAssistantMessage("I'm blocked. What should I try next?")),
		).toMatchObject({
			shouldContinue: true,
			reason: "missing_terminal_evidence",
		});
		expect(
			await shouldAutonomouslyContinue(
				state,
				fauxAssistantMessage("Blocked: this requires OAuth login from the user."),
			),
		).toMatchObject({
			shouldContinue: true,
			reason: "missing_terminal_evidence",
		});
	});
});
