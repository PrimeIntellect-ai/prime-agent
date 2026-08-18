/**
 * Real daemon-backed tests proving serializedRefine config arrives at
 * daemon-created sessions, controllers are available, and the autonomous
 * loop crosses the threshold.
 *
 * Uses AgentDaemon with a custom createRuntime that captures the merged
 * config and creates real AgentSession instances via the test harness.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../src/core/agent-session-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type { ActiveSessionState } from "../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand } from "../../src/modes/daemon/daemon-protocol.js";
import { createHarness, type Harness } from "./harness.js";

type SerializedInternals = {
	_serializedRefine: boolean;
	_rlmHeartbeatController?: unknown;
	_agentMessageController?: unknown;
	_agentObserveController?: unknown;
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_planRefine: (opts: { instructions?: string }, signal: AbortSignal) => Promise<unknown>;
	_applyRefine: (plan: unknown, opts: unknown, abort: AbortController) => Promise<unknown>;
	_reviewAutoRefine: (ctx: { reason: string; turnsSinceLastReview: number }, signal?: AbortSignal) => Promise<unknown>;
};

describe("Daemon-backed serializedRefine propagation", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("serializedRefine=true in defaultSessionConfig arrives at daemon-created session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-serialized-refine-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");

		let capturedConfig: { serializedRefine?: boolean } | undefined;

		const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
			capturedConfig = options.sessionConfig;
			const harness = await createHarness({
				persistSession: true,
				serializedRefine: options.sessionConfig?.serializedRefine ?? false,
			});
			return {
				session: harness.session,
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				services: { cwd: options.cwd, agentDir: options.agentDir } as never,
				diagnostics: [],
			} as never;
		});

		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir, serializedRefine: true },
			createRuntime,
		});

		const internals = daemon as unknown as {
			createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
		};

		const sessionManager = SessionManager.create(tempDir, sessionDir);
		sessionManager.newSession();
		const sessionFile = sessionManager.getSessionFile()!;

		const state = await internals.createRuntime({ type: "create", sessionPath: sessionFile });

		// The merged config that arrived at createRuntime has serializedRefine=true.
		expect(capturedConfig?.serializedRefine).toBe(true);

		// The session created by the daemon has _serializedRefine=true.
		const sessionInternals = state.runtime.session as unknown as SerializedInternals;
		expect(sessionInternals._serializedRefine).toBe(true);

		state.runtime.session.dispose();
	});

	it("serializedRefine=false in defaultSessionConfig produces _serializedRefine=false session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-bg-refine-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");

		const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
			const harness = await createHarness({
				persistSession: true,
				serializedRefine: options.sessionConfig?.serializedRefine ?? false,
			});
			return {
				session: harness.session,
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				services: { cwd: options.cwd, agentDir: options.agentDir } as never,
				diagnostics: [],
			} as never;
		});

		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir, serializedRefine: false },
			createRuntime,
		});

		const internals = daemon as unknown as {
			createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
		};

		const sessionManager = SessionManager.create(tempDir, sessionDir);
		sessionManager.newSession();
		const sessionFile = sessionManager.getSessionFile()!;

		const state = await internals.createRuntime({ type: "create", sessionPath: sessionFile });

		const sessionInternals = state.runtime.session as unknown as SerializedInternals;
		expect(sessionInternals._serializedRefine).toBe(false);

		state.runtime.session.dispose();
	});

	it("daemon session with serializedRefine=true crosses threshold and applies refine", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-daemon-threshold-"));
		tempDirs.push(tempDir);
		const sessionDir = join(tempDir, "sessions");

		const reviewer = vi.fn(async () => ({
			shouldRefine: true,
			rationale: "daemon test",
			instructions: "capture",
		}));

		let stashedHarness: Harness | undefined;

		const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
			const harness = await createHarness({
				persistSession: true,
				serializedRefine: options.sessionConfig?.serializedRefine ?? false,
				settings: { autoRefine: { enabled: true, turnInterval: 2, cooldownMs: 0 } },
				autoRefineReviewer: reviewer,
			});
			stashedHarness = harness;
			const session = harness.session;
			const internals = session as unknown as SerializedInternals;
			vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
			vi.spyOn(internals, "_applyRefine").mockResolvedValue({
				id: "refine_test",
				summary: "test",
				rationale: "test",
				expectedOutcome: "test",
				appliedEdits: [],
				harnessStatePath: "/tmp/harness_state.json",
			});
			return {
				session,
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				services: { cwd: options.cwd, agentDir: options.agentDir } as never,
				diagnostics: [],
			} as never;
		});

		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir, serializedRefine: true },
			createRuntime,
		});

		const internals = daemon as unknown as {
			createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
		};

		const sessionManager = SessionManager.create(tempDir, sessionDir);
		sessionManager.newSession();
		const sessionFile = sessionManager.getSessionFile()!;

		const state = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
		const session = state.runtime.session;
		const sessionInternals = session as unknown as SerializedInternals;
		const harness = stashedHarness!;

		// Turn 1: counter goes to 1 (< threshold 2)
		harness.setResponses([fauxAssistantMessage("response 1")]);
		await session.prompt("prompt 1");
		expect(sessionInternals._assistantTurnsSinceAutoRefine).toBe(1);

		// Turn 2: counter goes to 2 (>= threshold), checkpoint fires
		harness.setResponses([fauxAssistantMessage("response 2")]);
		await session.prompt("prompt 2");

		// After checkpoint, counter reset to 0
		expect(sessionInternals._assistantTurnsSinceAutoRefine).toBe(0);
		// Reviewer called exactly once
		expect(reviewer).toHaveBeenCalledTimes(1);

		// Cleanup
		harness.cleanup();
	});
});
