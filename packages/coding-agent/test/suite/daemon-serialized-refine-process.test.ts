/**
 * Real-process daemon-backed test for serializedRefine propagation.
 *
 * Spawns the actual CLI (`pi --mode json`) which goes through:
 * client -> unix socket -> daemon supervisor -> owned worker -> AgentSession.
 *
 * Uses the existing 4685 CLI/daemon and daemon-supervisor process fixtures.
 * Does NOT use private AgentDaemon.createRuntime or createHarness.
 *
 * This single test proves:
 *   - The production daemon-launch env scrub strips inherited
 *     PRIME_AGENT_INTERNAL_DAEMON_WORKER=1 so the auto-spawned supervisor
 *     starts in supervisor mode (not worker mode) and sends daemon_hello.
 *   - serializedRefine=true (derived from appMode="json") crosses the real
 *     socket/process and arrives at the owned worker.
 *   - refine_complete fires before agent_end (by seq), proving the
 *     serialized checkpoint is applied at shouldStopAfterTurn in the real
 *     worker before the agent loop terminates.
 *   - The exact model ("faux/faux") supplied via --model arrives at the
 *     worker extension context.
 *   - --goal "Process proof goal" --goal-token-budget 1 seeds an initial
 *     goal that is persisted to the session JSONL before the first message,
 *     then becomes budget_limited from the first assistant response usage
 *     (withUsageEstimate produces positive input/output) so the agent does
 *     not auto-continue.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../../src/core/orphan-process-journal.js";
import { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../../src/core/session-lease.js";
import { DaemonClient } from "../../src/modes/daemon/daemon-client.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
} from "../../src/modes/daemon/daemon-worker-protocol.js";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../../tsconfig.json");
const fauxRefineExtensionPath = resolve(__dirname, "../fixtures/eng-4685-faux-refine-extension.ts");
const eventOrderExtensionPath = resolve(__dirname, "../fixtures/eng-4685-event-order-extension.ts");
const children = new Set<ChildProcess>();
const daemonSockets = new Set<string>();
const tempRoots = new Set<string>();

afterEach(async () => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
	children.clear();
	for (const socketPath of daemonSockets) {
		const client = new DaemonClient(socketPath);
		try {
			await client.connect(500);
			await client.request({ type: "shutdown" }, 5000);
		} catch {
			// The process may have exited before publishing its socket.
		} finally {
			client.close();
		}
		for (let attempt = 0; attempt < 50 && existsSync(socketPath); attempt++) {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		}
	}
	daemonSockets.clear();
	for (const root of tempRoots) {
		rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
	tempRoots.clear();
});

async function runCli(
	args: string[],
	options: { agentDir: string; stdin?: string; environment?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: repoTsconfigPath,
			[ENV_AGENT_DIR]: options.agentDir,
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "0",
			PRIME_AGENT_KERNEL_FORKSERVER: "0",
			RLM_DEPTH: "0",
			// The test deliberately RE-INJECTS the worker role env var
			// (via options.environment, applied last) to prove the
			// production daemon-launch.ts env scrub removes it before
			// spawning the daemon supervisor.
			[DAEMON_WORKER_ROLE_ENV]: undefined,
			[DAEMON_WORKER_TOKEN_ENV]: undefined,
			[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV]: undefined,
			[DAEMON_WORKER_RECOVERY_JOURNAL_ENV]: undefined,
			[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV]: undefined,
			[ORPHAN_PROCESS_JOURNAL_ENV]: undefined,
			[SESSION_LEASES_ENABLED_ENV]: undefined,
			[SESSION_LEASE_OWNER_ID_ENV]: undefined,
			...options.environment,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	children.add(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdin?.end(options.stdin ?? "");
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`CLI timed out\n${stderr}`));
		}, 120_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal: signal as NodeJS.Signals | null });
		});
	});
	children.delete(child);
	return { ...exit, stdout, stderr };
}

interface EventLogEntry {
	seq: number;
	type: string;
	[key: string]: unknown;
}

function readEventLog(path: string): EventLogEntry[] {
	if (!existsSync(path)) return [];
	const content = readFileSync(path, "utf8").trim();
	if (!content) return [];
	return content
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as EventLogEntry);
}

function writeAutoRefineSettings(agentDir: string): void {
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } }),
	);
}

describe("Real-process serializedRefine — JSON mode", () => {
	it("daemon supervisor scrubs inherited worker env, checkpoint applies refine_complete before agent_end", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-process-json-refine-"));
		tempRoots.add(root);
		const agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		const socketPath = join(root, "daemon.sock");
		daemonSockets.add(socketPath);
		const eventLogPath = join(root, "events.jsonl");

		writeAutoRefineSettings(agentDir);

		// Deliberately re-inject the worker role env var AFTER the test
		// defaults so that the only thing preventing the daemon from
		// starting in worker mode is the production env scrub in
		// daemon-launch.ts ensureDaemonRunning().
		const result = await runCli(
			[
				"--mode",
				"json",
				"--daemon-socket",
				socketPath,
				"--model",
				"faux/faux",
				"--extension",
				fauxRefineExtensionPath,
				"--extension",
				eventOrderExtensionPath,
				"--no-tools",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--goal",
				"Process proof goal",
				"--goal-token-budget",
				"1",
				"Say hello",
			],
			{
				agentDir,
				environment: {
					PRIME_AGENT_TEST_EVENT_LOG: eventLogPath,
					[DAEMON_WORKER_ROLE_ENV]: "1",
				},
			},
		);

		// Clean exit — the production env scrub allowed the supervisor
		// to start correctly despite the inherited worker role env var.
		expect(result).toMatchObject({ code: 0, signal: null });
		expect(result.stderr).not.toContain("Timed out waiting for daemon");

		// Daemon socket exists — the daemon path was used.
		expect(existsSync(socketPath)).toBe(true);

		// Read the event log recorded by the extension in the real worker.
		const events = readEventLog(eventLogPath);
		expect(events.length).toBeGreaterThanOrEqual(3);

		// agent_start fired with the exact model from --model.
		const agentStart = events.find((e) => e.type === "agent_start");
		expect(agentStart).toBeDefined();
		expect(agentStart!.modelId).toBe("faux");
		expect(agentStart!.modelProvider).toBe("faux");

		// refine_complete fired — the serialized checkpoint applied
		// the refinement in the real owned worker.
		const refineComplete = events.find((e) => e.type === "refine_complete");
		expect(refineComplete).toBeDefined();
		expect(refineComplete!.id).toMatch(/^refine_/);
		expect(refineComplete!.appliedEdits).toBe(0);

		// agent_end fired — the agent loop terminated.
		const agentEnd = events.find((e) => e.type === "agent_end");
		expect(agentEnd).toBeDefined();

		// CRITICAL: refine_complete must precede agent_end (by seq).
		// This proves the serialized checkpoint was applied at the
		// shouldStopAfterTurn boundary BEFORE the agent loop emitted
		// agent_end — i.e. the refinement was applied in-process, not
		// deferred to a post-exit drain.
		expect(refineComplete!.seq).toBeLessThan(agentEnd!.seq);

		// ----------------------------------------------------------------
		// Goal persistence proof: recursively find the actual session JSONL
		// under AGENT_DIR, parse it, and assert the initial goal state
		// custom entry precedes the first message entry and has the exact
		// objective/budget from --goal/--goal-token-budget.
		// ----------------------------------------------------------------
		interface JsonlEntry {
			type: string;
			customType?: string;
			data?: Record<string, unknown>;
			message?: { role: string; usage?: { input?: number; output?: number } };
		}

		function findSessionJsonl(dir: string): string | undefined {
			for (const name of readdirSync(dir)) {
				const fullPath = join(dir, name);
				if (name.endsWith(".jsonl")) {
					// Validate this is a session JSONL, not a daemon recovery
					// or orphan journal: the first non-empty line must have
					// type === "session".
					try {
						const raw = readFileSync(fullPath, "utf8").trim().split("\n")[0];
						if (raw) {
							const first = JSON.parse(raw) as { type?: string };
							if (first.type === "session") return fullPath;
						}
					} catch {
						// not valid JSON, skip
					}
					continue;
				}
				try {
					readdirSync(fullPath);
					const found = findSessionJsonl(fullPath);
					if (found) return found;
				} catch {
					// not a directory
				}
			}
			return undefined;
		}

		const sessionJsonlPath = findSessionJsonl(join(agentDir, "sessions"));
		expect(sessionJsonlPath).toBeDefined();

		const jsonlContent = readFileSync(sessionJsonlPath!, "utf8");
		const jsonlEntries: JsonlEntry[] = jsonlContent
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as JsonlEntry);

		// Find the first thread_goal_state custom entry.
		const goalEntries = jsonlEntries.filter((e) => e.type === "custom" && e.customType === "thread_goal_state");
		expect(goalEntries.length).toBeGreaterThanOrEqual(1);

		const firstGoalEntry = goalEntries[0]!;
		const goalData = firstGoalEntry.data!;
		expect(goalData.objective).toBe("Process proof goal");
		expect(goalData.tokenBudget).toBe(1);
		expect(goalData.status).toBe("active");

		// Find the index of the first goal entry and first message entry.
		const firstGoalIndex = jsonlEntries.indexOf(firstGoalEntry);
		const firstMessageIndex = jsonlEntries.findIndex((e) => e.type === "message");
		expect(firstMessageIndex).toBeGreaterThan(-1);

		// CRITICAL: The initial goal state must be persisted BEFORE the
		// first message entry. This proves the goal was seeded at session
		// creation (before any model interaction) via flushNow.
		expect(firstGoalIndex).toBeLessThan(firstMessageIndex);

		// The first assistant message must have positive usage (input > 0
		// and output > 0) produced by withUsageEstimate, which means the
		// goal accounting will consume real tokens and reach the budget.
		const assistantMessages = jsonlEntries.filter((e) => e.type === "message" && e.message?.role === "assistant");
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
		const firstAssistant = assistantMessages[0]!;
		expect(firstAssistant.message!.usage!.input!).toBeGreaterThan(0);
		expect(firstAssistant.message!.usage!.output!).toBeGreaterThan(0);

		// A budget_limited goal state entry must exist AFTER the first
		// message, proving the goal consumed real usage and stopped the
		// agent from auto-continuing.
		const budgetLimitedEntries = goalEntries.filter(
			(e) => (e.data as Record<string, unknown>)?.status === "budget_limited",
		);
		expect(budgetLimitedEntries.length).toBeGreaterThanOrEqual(1);
		const budgetLimitedIndex = jsonlEntries.indexOf(budgetLimitedEntries[0]!);
		expect(budgetLimitedIndex).toBeGreaterThan(firstMessageIndex);
	}, 120_000);
});
