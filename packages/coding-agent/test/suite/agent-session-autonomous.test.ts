import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	addAutonomousUsage,
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	isUnlimitedAutonomousLimit,
	nextAutonomousContinuation,
	shouldAutonomouslyContinue,
	UNLIMITED_AUTONOMOUS_LIMIT,
} from "../../src/core/autonomous.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";

const CONTINUATION = `[autonomous-continuation]\n\n${DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT}`;

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

function initGitRepo(dir: string, options?: { commitFile?: string }): void {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir });
	if (options?.commitFile) {
		writeFileSync(join(dir, options.commitFile), "initial\n");
		execFileSync("git", ["add", options.commitFile], { cwd: dir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: dir,
			stdio: "ignore",
		});
	}
}

function scratchRepo(label: string, options?: { commitFile?: string }): string {
	const dir = join(process.cwd(), `.tmp-autonomous-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	initGitRepo(dir, options);
	return dir;
}

describe("AgentSession autonomous mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([
		["a question to the user", "Which package manager should I use?"],
		["a claimed external blocker", "Blocked: this requires an API key credential from the user."],
		["a bare completion claim without evidence", "Done."],
	])("injects a host-side continuation for %s", async (_name, firstResponse) => {
		const harness = await createHarness({ autonomous: { enabled: true, maxContinuations: 1 } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(firstResponse), fauxAssistantMessage("I verified it myself.")]);

		await harness.session.prompt("fix the project");

		expect(getUserTexts(harness)).toEqual(["fix the project", CONTINUATION]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it.each([
		["a mid-run question", "I'm blocked. What should I try next?"],
		["a claimed credential blocker", "Blocked: this requires OAuth login from the user."],
	])("does not accept assistant prose as terminal evidence for %s", async (_name, text) => {
		const state = createAutonomousRuntimeState({ enabled: true });

		expect(await shouldAutonomouslyContinue(state, fauxAssistantMessage(text))).toMatchObject({
			shouldContinue: true,
			reason: "missing_terminal_evidence",
		});
	});

	it("continues after a git worktree change instead of letting the agent self-terminate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		initGitRepo(harness.tempDir, { commitFile: "file.txt" });
		await harness.session.prompt("/autonomous on");
		writeFileSync(join(harness.tempDir, "file.txt"), "after\n");
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Continuing until the evaluator stops me."),
		]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)[0]).toBe("make the change");
		expect(getUserTexts(harness).slice(1)).toContain(CONTINUATION);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBeGreaterThan(0);
	});

	it("stops after the configured autonomous continuation limit", async () => {
		const harness = await createHarness({ autonomous: { enabled: true, maxContinuations: 1 } });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Can you confirm the test command?"),
			fauxAssistantMessage("Can you confirm whether to run lint too?"),
		]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change", CONTINUATION]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it.each([
		["does not count failed assistant messages", { stopReason: "error", errorMessage: "provider failed" }, 0],
		["counts aborted assistant messages", { stopReason: "aborted" }, 1],
	] as const)("%s against autonomous usage limits", async (_name, messageOptions, turnsUsed) => {
		const harness = await createHarness({ autonomous: { enabled: true, maxTurns: 1 } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("stopped", messageOptions)]);

		await harness.session.prompt("try once");

		expect(harness.session.getAutonomousStatus()).toMatchObject({ turnsUsed, continuationsUsed: 0 });
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

	it("toggles autonomous mode without calling the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on");
		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
		await harness.session.prompt("/autonomous off");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it.each([
		[
			"long budget flags",
			"/autonomous on --max-continuations 5 --max-turns 25 --max-tokens 250000 --timeout-ms 600000",
			{ maxContinuations: 5, maxTurns: 25, maxTokens: 250_000, timeoutMs: 600_000 },
		],
		[
			"digit separators",
			"/autonomous on --max-tokens 100,000,000,000 --max-continuations 1_000 --max-turns 10,000 --timeout-ms 3,600,000",
			{ maxContinuations: 1_000, maxTurns: 10_000, maxTokens: 100_000_000_000, timeoutMs: 3_600_000 },
		],
		[
			"unlimited values",
			"/autonomous on --max-continuations unlimited --max-turns unlimited --max-tokens unlimited --timeout-ms unlimited",
			{
				maxContinuations: UNLIMITED_AUTONOMOUS_LIMIT,
				maxTurns: UNLIMITED_AUTONOMOUS_LIMIT,
				maxTokens: UNLIMITED_AUTONOMOUS_LIMIT,
				timeoutMs: UNLIMITED_AUTONOMOUS_LIMIT,
			},
		],
		[
			"a single named budget that lifts the unnamed ones",
			"/autonomous on --max-tokens 100,000",
			{
				maxContinuations: UNLIMITED_AUTONOMOUS_LIMIT,
				maxTurns: UNLIMITED_AUTONOMOUS_LIMIT,
				maxTokens: 100_000,
				timeoutMs: UNLIMITED_AUTONOMOUS_LIMIT,
			},
		],
		[
			"no budget flags at all",
			'/autonomous on --gate "npm run lint" --gate "npm test"',
			{ maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000 },
		],
	])("parses %s into run limits", async (_name, input, limits) => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt(input);

		expect(harness.session.getAutonomousStatus().limits).toEqual(limits);
	});

	it("accepts CLI gate flag spellings, inline values, and repeated gates", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt(
			'/autonomous on --autonomous-max-continuations=7 --autonomous-gate "npm test" --autonomous-gate-retries=2 --autonomous-gate-timeout-ms 45000 --gate "npm run lint" --subagent-keep-alive-ms 250',
		);

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			limits: { maxContinuations: 7 },
			subagentKeepAliveMs: 250,
			gates: { commands: ["npm test", "npm run lint"], maxRetries: 2, timeoutMs: 45_000 },
		});
	});

	it.each([
		[
			"persisted settings when no run-level limits are set",
			{ settings: { autonomous: { maxContinuations: 100, maxTurns: "unlimited", maxTokens: 1_000_000 } } },
			{
				maxContinuations: 100,
				maxTurns: UNLIMITED_AUTONOMOUS_LIMIT,
				maxTokens: 1_000_000,
				timeoutMs: 30 * 60 * 1000,
			},
		],
		[
			"explicit run-level limits ahead of persisted settings",
			{
				settings: { autonomous: { maxContinuations: 100, maxTokens: 1_000_000 } },
				autonomous: { enabled: true, maxContinuations: 2, maxTokens: 20_000 },
			},
			{ maxContinuations: 2, maxTokens: 20_000 },
		],
		[
			"built-in defaults for invalid persisted limits",
			{ settings: { autonomous: { maxContinuations: -3, maxTurns: 0.5, maxTokens: 0.5 } } },
			{ maxContinuations: 3, maxTurns: 12, maxTokens: 80_000 },
		],
	] as const)("seeds limits from %s", async (_name, options, limits) => {
		const harness = await createHarness(options);
		harnesses.push(harness);

		expect(harness.session.getAutonomousStatus().limits).toMatchObject(limits);
	});

	it("keeps settings-derived limits when enabling autonomous mode without budget flags", async () => {
		const harness = await createHarness({ settings: { autonomous: { maxContinuations: 100 } } });
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on");

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			limits: { maxContinuations: 100 },
		});
	});

	it("rejects invalid budget flags without enabling autonomous mode", async () => {
		const inputs = [
			"/autonomous on --max-continuations 0",
			"/autonomous on --max-continuations",
			"/autonomous on --speed 10",
			"/autonomous on --gate-retries unlimited",
			"/autonomous on --subagent-keep-alive-ms 3000000000",
			"/autonomous on --subagent-keep-alive-ms -5",
			"/autonomous off --max-continuations 2",
		];
		const harness = await createHarness();
		harnesses.push(harness);

		for (const input of inputs) {
			await harness.session.prompt(input);
		}

		expect(
			harness.session.messages.filter(
				(message) => message.role === "custom" && message.customType === "session_slash_command_result",
			),
		).toHaveLength(inputs.length);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
	});

	it("continues past the default three when the continuation budget is raised or unlimited", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses(
			Array.from({ length: 8 }, (_, index) => fauxAssistantMessage(`Question ${index + 1}: what next?`)),
		);

		await harness.session.prompt("/autonomous on --max-continuations 5");
		await harness.session.prompt("make the change");

		expect(harness.session.getAutonomousStatus()).toMatchObject({
			continuationsUsed: 5,
			limits: { maxContinuations: 5 },
		});

		const unlimited = await createHarness();
		harnesses.push(unlimited);
		unlimited.setResponses(
			Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`Question ${index + 1}: what next?`)),
		);

		await unlimited.session.prompt("/autonomous on --max-continuations unlimited --max-turns unlimited");
		await unlimited.session.prompt("make the change");

		const status = unlimited.session.getAutonomousStatus();
		expect(isUnlimitedAutonomousLimit(status.limits.maxContinuations)).toBe(true);
		expect(status.continuationsUsed).toBe(6);
	});

	it("runs autonomous gates before applying usage limits", async () => {
		const state = createAutonomousRuntimeState({
			enabled: true,
			maxTurns: 1,
			gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
		});
		state.turnsUsed = 1;
		state.lastGateFailure = { command: "stale gate", attempt: 1, exitText: "exited 1", output: "stale failure" };

		expect(
			await shouldAutonomouslyContinue(state, fauxAssistantMessage("Done."), { cwd: process.cwd() }),
		).toMatchObject({ shouldContinue: false, reason: "not_needed" });
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

		expect(getUserTexts(harness)[1].startsWith("[autonomous-continuation: gate-failed]")).toBe(true);
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

	it("advances retry budget without rerunning a failed autonomous gate until the workspace changes", async () => {
		const tempDir = scratchRepo("gate", { commitFile: "src.rs" });
		mkdirSync(join(tempDir, "verification"), { recursive: true });
		try {
			const counter = join(tempDir, "verification", "public_feedback_scores.jsonl");
			const gate = `${process.execPath} -e "const fs=require('fs'); const p='${counter}'; const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(/\\n/).filter(Boolean).length:0; fs.appendFileSync(p,JSON.stringify({run:n+1,score:0})+'\\n'); process.exit(1);"`;
			const state = createAutonomousRuntimeState(
				{ enabled: true, maxContinuations: 3, gates: { commands: [gate], maxRetries: 3 } },
				{ cwd: tempDir },
			);

			const first = await nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			// A generated lockfile must not count as workspace progress.
			writeFileSync(join(tempDir, "Cargo.lock"), "generated lockfile\n");
			const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: tempDir });

			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(getMessageText(second)).toContain("workspace has not changed");
			expect(readFileSync(counter, "utf8").trim().split(/\n/)).toHaveLength(1);
			expect(state.gateAttempts[gate]).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("records the post-failure worktree snapshot so gate-written files do not trigger a rerun", async () => {
		const tempDir = scratchRepo("post-snapshot", { commitFile: "src.rs" });
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

	it("reruns a failed autonomous gate when untracked file contents change", async () => {
		const tempDir = scratchRepo("untracked", { commitFile: "src.rs" });
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
			const second = await nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: tempDir });

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

	it("terminates the autonomous gate process tree when the timeout expires", async () => {
		const tempDir = scratchRepo("process-tree");
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
			autonomous: { enabled: true, maxContinuations: 1, gates: { commands: [gate], maxRetries: 1 } },
		});
		harnesses.push(harness);
		initGitRepo(harness.tempDir);
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
});

describe("AgentSession autonomous continuations vs subagents", () => {
	const harnesses: Harness[] = [];
	let childGate: { promise: Promise<void>; resolve: () => void } | undefined;

	function createGate(): { promise: Promise<void>; resolve: () => void } {
		let resolve!: () => void;
		const promise = new Promise<void>((settle) => {
			resolve = settle;
		});
		return { promise, resolve };
	}

	afterEach(() => {
		childGate?.resolve();
		childGate = undefined;
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createGatedChildParent(options: {
		keepAliveMs?: number;
		maxContinuations?: number;
	}): Promise<Harness> {
		childGate = createGate();
		const child = await createHarness({});
		harnesses.push(child);
		child.setResponses([
			async () => {
				await childGate!.promise;
				return fauxAssistantMessage("child result");
			},
		]);
		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			autonomous: {
				enabled: true,
				maxContinuations: options.maxContinuations ?? 1,
				subagentKeepAliveMs: options.keepAliveMs,
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(parent);
		return parent;
	}

	it("holds the timer continuation while a subagent runs and resumes it at settlement", async () => {
		const parent = await createGatedChildParent({});
		parent.setResponses([
			fauxAssistantMessage("delegated to the child; waiting"),
			fauxAssistantMessage("read the child exit notice"),
			fauxAssistantMessage("parent resumed and continued"),
		]);

		await parent.session.runRlmChild("child task", { name: "worker" });
		await expect.poll(() => parent.session.hasRunningRlmChildren()).toBe(true);

		await parent.session.prompt("kick off");

		// Held while the child runs: no continuation turn, budget untouched.
		expect(getUserTexts(parent)).toEqual(["kick off"]);
		expect(parent.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 0 });

		childGate!.resolve();

		// The exit notice delivers first; the owed continuation wakes the idle
		// parent and is counted once.
		await expect
			.poll(() => getAssistantTexts(parent))
			.toEqual(["delegated to the child; waiting", "read the child exit notice", "parent resumed and continued"]);
		expect(getUserTexts(parent)).toEqual(["kick off", expect.stringContaining("[autonomous-continuation]")]);
		expect(parent.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 1 });
		expect(parent.session.hasRunningRlmChildren()).toBe(false);
	});

	it("disarms a pending keep-alive when the valve is disabled mid-hold", async () => {
		const parent = await createGatedChildParent({ keepAliveMs: 25, maxContinuations: 2 });
		parent.setResponses([fauxAssistantMessage("delegated to the child; waiting")]);

		await parent.session.runRlmChild("child task", { name: "worker" });
		await expect.poll(() => parent.session.hasRunningRlmChildren()).toBe(true);

		await parent.session.prompt("kick off");
		expect(getUserTexts(parent)).toEqual(["kick off"]);

		await parent.session.prompt("/autonomous on --subagent-keep-alive-ms 0");

		// The previously armed 25 ms window is gone; no keep-alive turn fires.
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(getAssistantTexts(parent)).toEqual(["delegated to the child; waiting"]);
		expect(getUserTexts(parent)).toEqual(["kick off"]);
		expect(parent.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 0 });
		expect(parent.session.hasRunningRlmChildren()).toBe(true);
	});

	it("fires one keep-alive continuation while a subagent stays active past the window", async () => {
		const parent = await createGatedChildParent({ keepAliveMs: 25, maxContinuations: 2 });
		parent.setResponses([
			fauxAssistantMessage("delegated to the child; waiting"),
			fauxAssistantMessage("checked on the still-running child"),
		]);

		await parent.session.runRlmChild("child task", { name: "worker" });
		await expect.poll(() => parent.session.hasRunningRlmChildren()).toBe(true);

		await parent.session.prompt("kick off");
		expect(getUserTexts(parent)).toEqual(["kick off"]);
		expect(parent.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 0 });

		await expect
			.poll(() => getAssistantTexts(parent), { timeout: 5_000 })
			.toEqual(["delegated to the child; waiting", "checked on the still-running child"]);

		const userTexts = getUserTexts(parent);
		expect(userTexts[1]).toContain("[autonomous-continuation: subagent-keep-alive]");
		expect(parent.session.getAutonomousStatus()).toMatchObject({ continuationsUsed: 1 });
		expect(parent.session.hasRunningRlmChildren()).toBe(true);
	});
});
