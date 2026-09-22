import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { CreateAgentSessionOptions } from "../src/core/sdk.js";
import {
	type DaemonInteractiveSessionManagerDecision,
	daemonServerDefaultSessionConfig,
	findActiveDaemonSessionSummaryForSessionFile,
	type InteractiveDaemonStartupDecision,
	isClientOwnedDaemonSession,
	parseAgentsViewCommand,
	resolveActiveSessionLookupFailure,
	resolveRuntimeSessionOptions,
	shouldEnsureDaemonBeforeActiveSessionLookup,
	shouldEnsureInteractiveDaemonForStartup,
	shouldOpenAgentsViewForDaemonInteractive,
	shouldRejectNonInteractiveAttach,
	shouldRejectNonInteractiveBareResume,
	shouldUseDaemonClient,
	shouldUseDaemonClientRuntime,
	shouldUseDaemonInteractive,
	shouldUseEphemeralSessionManagerForDaemonInteractive,
} from "../src/main.js";
import { DaemonSessionRecoveringError } from "../src/modes/daemon/daemon-errors.js";
import type { SessionSummary } from "../src/modes/index.js";

describe("interactive startup routing", () => {
	test.each([
		["acp", false, false],
		["acp", true, true],
		["rpc", false, true],
		["print", false, true],
	] as const)("classifies %s noSession=%s ownership", (appMode, noSession, expected) => {
		expect(isClientOwnedDaemonSession(appMode, noSession)).toBe(expected);
	});

	test.each([
		["interactive client", { appMode: "interactive", startupBenchmark: false }, true],
		["print client", { appMode: "print", startupBenchmark: false }, true],
		["json client", { appMode: "json", startupBenchmark: false }, true],
		["rpc client", { appMode: "rpc", startupBenchmark: false }, true],
		["--no-session", { appMode: "interactive", startupBenchmark: false, noSession: true }, true],
		["daemon process", { appMode: "daemon", startupBenchmark: false }, false],
		["startup benchmark", { appMode: "interactive", startupBenchmark: true }, false],
		["help", { appMode: "interactive", startupBenchmark: false, help: true }, false],
		["model listing", { appMode: "interactive", startupBenchmark: false, listModels: true }, false],
	] satisfies Array<[string, InteractiveDaemonStartupDecision, boolean]>)(
		"routes %s to the daemon client runtime: %s",
		(_label, decision, expected) => {
			expect(shouldUseDaemonClient(decision)).toBe(expected);
		},
	);

	test("keeps process-local extension factories and rollback workers in process", () => {
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "print",
				startupBenchmark: false,
				hasProcessLocalExtensionFactories: true,
			}),
		).toBe(false);
		expect(
			shouldUseDaemonClientRuntime({
				appMode: "rpc",
				startupBenchmark: false,
				ownedSessionWorker: true,
			}),
		).toBe(false);
	});

	test.each([
		["normal interactive startup", { appMode: "interactive", startupBenchmark: false }, true],
		["print mode", { appMode: "print", startupBenchmark: false }, false],
		["json mode", { appMode: "json", startupBenchmark: false }, false],
		["rpc mode", { appMode: "rpc", startupBenchmark: false }, false],
		["daemon mode", { appMode: "daemon", startupBenchmark: false }, false],
		["startup benchmark", { appMode: "interactive", startupBenchmark: true }, false],
		["--no-session", { appMode: "interactive", startupBenchmark: false, noSession: true }, false],
		["--list-models", { appMode: "interactive", startupBenchmark: false, listModels: true }, false],
		["--list-models search", { appMode: "interactive", startupBenchmark: false, listModels: "claude" }, false],
	] satisfies Array<[string, InteractiveDaemonStartupDecision, boolean]>)(
		"uses daemon-backed interactive mode for %s: %s",
		(_label, decision, expected) => {
			expect(shouldUseDaemonInteractive(decision)).toBe(expected);
		},
	);

	test("rejects interactive-only selectors before non-interactive startup", () => {
		expect(shouldRejectNonInteractiveAttach("worker", "print")).toBe(true);
		expect(shouldRejectNonInteractiveAttach("worker", "interactive")).toBe(false);
		expect(shouldRejectNonInteractiveAttach(undefined, "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "print")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume(true, "rpc")).toBe(true);
		expect(shouldRejectNonInteractiveBareResume("session-id", "print")).toBe(false);
		expect(shouldRejectNonInteractiveBareResume(true, "interactive")).toBe(false);
	});

	test("does not start the daemon for attach", () => {
		expect(shouldEnsureInteractiveDaemonForStartup(true, undefined)).toBe(true);
		expect(shouldEnsureInteractiveDaemonForStartup(true, "worker")).toBe(false);
		expect(shouldEnsureInteractiveDaemonForStartup(false, undefined)).toBe(false);
	});
});

describe("daemon-backed interactive session manager routing", () => {
	test.each([
		["default daemon-backed startup", { useDaemonInteractive: true, needsOnboarding: false }, false],
		[
			"an explicit agents view request",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true },
			true,
		],
		["bare --resume", { useDaemonInteractive: true, needsOnboarding: false, resume: true }, true],
		["bare --resume during onboarding", { useDaemonInteractive: true, needsOnboarding: true, resume: true }, true],
		[
			"the non-daemon interactive path",
			{ useDaemonInteractive: false, needsOnboarding: false, explicitAgentsView: true },
			false,
		],
		["pending onboarding", { useDaemonInteractive: true, needsOnboarding: true, explicitAgentsView: true }, false],
		[
			"a resume selector",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, resume: "active-1" },
			false,
		],
		[
			"continue recent",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, continue: true },
			false,
		],
		[
			"fork",
			{ useDaemonInteractive: true, needsOnboarding: false, explicitAgentsView: true, fork: "source-session-id" },
			false,
		],
	] satisfies Array<[string, Parameters<typeof shouldOpenAgentsViewForDaemonInteractive>[0], boolean]>)(
		"opens the agents view for %s: %s",
		(_label, decision, expected) => {
			expect(shouldOpenAgentsViewForDaemonInteractive(decision)).toBe(expected);
		},
	);

	test("ensures daemon is available before probing non-path session selectors", () => {
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "active-1",
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
			}),
		).toBe(false);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: true,
				resumeSelector: "/tmp/session.jsonl",
				explicitAttach: true,
			}),
		).toBe(true);
		expect(
			shouldEnsureDaemonBeforeActiveSessionLookup({
				useDaemonInteractive: false,
				resumeSelector: "active-1",
			}),
		).toBe(false);
	});

	test.each([
		["a fresh daemon-owned session", {}, true],
		["bare --resume", { resume: true }, true],
		["an active daemon attach", { hasActiveDaemonSession: true }, false],
		["an explicit saved session", { resume: "saved-session-id" }, false],
		["continue recent", { continue: true }, false],
		["fork", { fork: "source-session-id" }, false],
	] satisfies Array<[string, DaemonInteractiveSessionManagerDecision, boolean]>)(
		"uses an ephemeral local session manager for %s: %s",
		(_label, decision, expected) => {
			expect(shouldUseEphemeralSessionManagerForDaemonInteractive(decision)).toBe(expected);
		},
	);

	test("finds an active daemon session by resolved session file", () => {
		const inactiveSummary = makeSessionSummary({
			id: "saved-1",
			activeSessionId: undefined,
			sessionFile: "/tmp/project/session.jsonl",
		});
		const activeSummary = makeSessionSummary({
			id: "active-1",
			activeSessionId: "active-1",
			sessionFile: "/tmp/project/session.jsonl",
		});

		expect(
			findActiveDaemonSessionSummaryForSessionFile(
				[inactiveSummary, activeSummary],
				"/tmp/project/../project/session.jsonl",
			),
		).toBe(activeSummary);
	});

	test("finds an active daemon session through a symlinked resume path", () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-resume-"));
		try {
			const sessionFile = join(directory, "session.jsonl");
			const symlink = join(directory, "session-link.jsonl");
			writeFileSync(sessionFile, "");
			symlinkSync(sessionFile, symlink);
			const activeSummary = makeSessionSummary({
				id: "active-1",
				activeSessionId: "active-1",
				sessionFile,
			});

			expect(findActiveDaemonSessionSummaryForSessionFile([activeSummary], symlink)).toBe(activeSummary);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("agents view command parsing", () => {
	test.each([
		{ args: ["agents"], explicitAgentsView: true, rest: [] as string[] },
		{ args: ["manage", "--verbose"], explicitAgentsView: false, rest: ["manage", "--verbose"] },
		{ args: ["fix the agents view"], explicitAgentsView: false, rest: ["fix the agents view"] },
		{ args: ["--verbose", "agents"], explicitAgentsView: false, rest: ["--verbose", "agents"] },
	])("parses $args", ({ args, explicitAgentsView, rest }) => {
		expect(parseAgentsViewCommand(args)).toEqual({ explicitAgentsView, args: rest });
	});
});

describe("runtime session option resolution", () => {
	test("keeps verifier goals per session instead of in the daemon fallback", () => {
		const headlessCreateConfig = {
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: { objective: "solve the verifier task", tokenBudget: 100_000 },
		};

		const daemonFallback = daemonServerDefaultSessionConfig(headlessCreateConfig);
		expect(daemonFallback).toEqual({
			cwd: "/repo",
			serializedRefine: true,
			initialGoal: undefined,
		});
		expect(
			mergeAgentSessionRuntimeConfig(daemonFallback, {
				initialGoal: headlessCreateConfig.initialGoal,
			}),
		).toMatchObject({ initialGoal: headlessCreateConfig.initialGoal });
	});

	test("preserves daemon-provided RLM heartbeat controller when creating sessions", () => {
		const preparedModel = { id: "prepared-model" } as unknown as CreateAgentSessionOptions["model"];
		const runtimeModel = { id: "runtime-model" } as unknown as CreateAgentSessionOptions["model"];
		const rlmHeartbeatController: NonNullable<CreateAgentSessionOptions["rlmHeartbeatController"]> = {
			listRlmHeartbeats: () => [],
			createRlmHeartbeat: () => {
				throw new Error("not used");
			},
			updateRlmHeartbeat: () => undefined,
			deleteRlmHeartbeat: () => undefined,
		};

		const resolved = resolveRuntimeSessionOptions(
			{
				model: preparedModel,
				tools: ["ipython"],
				customTools: [],
			},
			{
				model: runtimeModel,
				rlmHeartbeatController,
				rlmDepth: 1,
				rlmSessionDir: "/tmp/rlm-session",
			},
		);

		expect(resolved).toMatchObject({
			model: runtimeModel,
			tools: ["ipython"],
			customTools: [],
			rlmHeartbeatController,
			rlmDepth: 1,
			rlmSessionDir: "/tmp/rlm-session",
		});
	});

	test("forwards child lineage - parent agent, semantic parent and spawn request - to the child session", () => {
		const resolved = resolveRuntimeSessionOptions(
			{},
			{
				rlmDepth: 1,
				rlmParentAgent: "parent-worker",
				semanticParentSessionId: "parent-session-id",
				semanticSpawnedByRequestId: "a".repeat(32),
			},
		);

		expect(resolved.rlmParentAgent).toBe("parent-worker");
		expect(resolved.semanticParentSessionId).toBe("parent-session-id");
		expect(resolved.semanticSpawnedByRequestId).toBe("a".repeat(32));
	});

	test.each([
		{ name: "a top-level runtime session", rlmDepth: undefined, enabled: true },
		{ name: "a subagent runtime session", rlmDepth: 1, enabled: false },
	])("deep-merges autonomous overrides for $name", ({ rlmDepth, enabled }) => {
		const resolved = resolveRuntimeSessionOptions(
			{
				autonomous: {
					enabled: true,
					maxTurns: 20,
					gates: { commands: ["npm test"], maxRetries: 3 },
				},
			},
			{
				...(rlmDepth === undefined ? {} : { rlmDepth }),
				autonomous: {
					maxContinuations: 5,
					gates: { timeoutMs: 1000 },
				},
			},
		);

		expect(resolved.autonomous).toEqual({
			enabled,
			maxTurns: 20,
			maxContinuations: 5,
			gates: { commands: ["npm test"], maxRetries: 3, timeoutMs: 1000 },
		});
	});

	test("classifies active-session lookup failures: recovering is typed, unknown falls back", () => {
		const recovering = resolveActiveSessionLookupFailure({
			type: "response",
			command: "get_state",
			success: false,
			error: "Active session active-gap is recovering; retry shortly",
			errorInfo: { code: "session_recovering", activeSessionId: "active-gap" },
		});
		expect(recovering).toBeInstanceOf(DaemonSessionRecoveringError);
		expect((recovering as DaemonSessionRecoveringError).activeSessionId).toBe("active-gap");
		expect(
			resolveActiveSessionLookupFailure({
				type: "response",
				command: "get_state",
				success: false,
				error: "Unknown active session: active-gap",
			}),
		).toBeUndefined();
		expect(
			resolveActiveSessionLookupFailure({
				type: "response",
				command: "get_state",
				success: false,
				error: "socket closed",
			}),
		).toBeInstanceOf(Error);
	});
});

function makeSessionSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "session-1",
		lifecycle: "draft",
		activity: "idle",
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
		isSessionActive: overrides.isSessionActive ?? false,
	};
}
