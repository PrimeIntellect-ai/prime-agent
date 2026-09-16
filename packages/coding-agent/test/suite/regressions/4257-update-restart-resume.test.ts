import { fauxAssistantMessage, type TextContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionActionRecoverySnapshot } from "../../../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { AgentCronJobStore, type AgentCronScheduler } from "../../../src/core/cron-jobs.js";
import type { CustomMessage } from "../../../src/core/messages.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { createHarness, getUserTexts, type Harness } from "../harness.js";

type AgentDaemonRestoreInternals = {
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	cronScheduler: AgentCronScheduler;
	registerCronStoreForState(state: ActiveSessionState): void;
	rebindCronJobsToState(state: ActiveSessionState): void;
	handleLine(client: DaemonSocketClient, line: string): Promise<void>;
};

const TOP_LEVEL = { kind: "top-level", createdAt: 0 } as const;

function createState(harness: Harness, activeSessionId: string): ActiveSessionState {
	const runtime = {
		session: harness.session,
		metadata: { ...TOP_LEVEL, createdAt: Date.now() },
		cwd: harness.tempDir,
		runtimeConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		diagnostics: [],
		dispose: async () => {},
	} as unknown as AgentSessionRuntime;
	return {
		activeSessionId,
		runtime,
		clients: new Set(),
		pendingAttaches: 0,
		extensionUiRequests: new Map(),
		eventGeneration: `generation-${activeSessionId}`,
		lastEventSequence: 0,
	};
}

function createDaemonInternals(
	harness: Harness,
	options: { worker?: { restoreActiveSessionId: string } } = {},
): AgentDaemonRestoreInternals {
	const daemon = new AgentDaemon(`${harness.tempDir}/daemon.sock`, {
		defaultSessionConfig: { cwd: harness.tempDir, agentDir: harness.tempDir },
		...(options.worker
			? {
					worker: {
						authenticationToken: "test-token",
						restoreActiveSessionId: options.worker.restoreActiveSessionId,
					},
				}
			: {}),
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	return daemon as unknown as AgentDaemonRestoreInternals;
}

function createWriteClient(writes: string[], attached: string[]): DaemonSocketClient {
	return {
		id: "client-1",
		socket: {
			destroyed: false,
			write: vi.fn((chunk: string) => {
				writes.push(chunk);
				return true;
			}),
		} as unknown as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set(attached),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	} as DaemonSocketClient;
}

function createCustomMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "prime-agent.test",
		content,
		display: false,
		timestamp: Date.now(),
	};
}

/** A daemon with one attached session, wired to a recording socket client. */
function attachDaemon(harness: Harness): {
	send(command: Record<string, unknown>): Promise<void>;
	responses(): unknown[];
} {
	const internals = createDaemonInternals(harness);
	internals.sessions.set("active-1", createState(harness, "active-1"));
	const writes: string[] = [];
	const client = createWriteClient(writes, ["active-1"]);
	return {
		send: (command) =>
			internals.handleLine(
				client,
				JSON.stringify({ activeSessionId: "active-1", expandPromptTemplates: false, ...command }),
			),
		responses: () =>
			writes
				.join("")
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line)),
	};
}

describe("update restart queue recovery over the daemon RPC boundary (issue #4257)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function newHarness(): Promise<Harness> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		return harness;
	}

	it("restores queued actions through the public recovery API with stable ids and FIFO", async () => {
		const source = await newHarness();
		const target = await newHarness();
		await source.session.restoreSteeringMessage("steering one");
		await source.session.restoreSteeringMessage("steering two");
		await source.session.restoreFollowUpMessage("follow-up one", undefined, { queueKey: "job-1" });

		const snapshot = source.session.getSessionActionRecoverySnapshot();
		await target.session.restoreSessionActions(snapshot);

		expect(target.session.getSessionActionRecoverySnapshot()).toEqual(snapshot);
		expect(target.session.getSteeringMessages()).toEqual(["steering one", "steering two"]);
		expect(target.session.getFollowUpMessages()).toEqual(["follow-up one"]);
		await expect(
			target.session.restoreSessionActions({
				formatVersion: 2,
				actions: [],
			} as unknown as SessionActionRecoverySnapshot),
		).rejects.toThrow("Unsupported session action recovery format version: 2");
	});

	it("rejects duplicate recovered action ids without partial admission", async () => {
		const source = await newHarness();
		const target = await newHarness();
		await source.session.restoreFollowUpMessage("follow-up");
		const action = source.session.getSessionActionRecoverySnapshot().actions[0]!;

		await expect(
			target.session.restoreSessionActions({ formatVersion: 1, actions: [action, action] }),
		).rejects.toThrow(`Duplicate session action id: ${action.id}`);
		expect(target.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("accepts restore_next_turn through daemon command parsing", async () => {
		const harness = await newHarness();
		const daemon = attachDaemon(harness);
		const restoredMessage = createCustomMessage("restored next turn");

		await daemon.send({ id: "restore-1", type: "restore_next_turn", messages: [restoredMessage] });

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "restore-1", command: "restore_next_turn", success: true }),
		]);
		expect(harness.session.getPendingNextTurnMessageSnapshots()).toEqual([restoredMessage]);
	});

	it("accepts restored prompt content through daemon command parsing", async () => {
		const harness = await newHarness();
		harness.setResponses([fauxAssistantMessage("accepted restored prompt")]);
		const daemon = attachDaemon(harness);
		const promptContent: TextContent[] = [
			{ type: "text", text: "accepted prefix" },
			{ type: "text", text: "accepted work" },
		];

		await daemon.send({
			id: "prompt-1",
			type: "prompt",
			message: "accepted work",
			content: promptContent,
			agentMessageId: "agentmsg_accepted",
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "prompt-1", command: "prompt", success: true }),
		]);
		expect(harness.session.messages.find((message) => message.role === "user")?.content).toEqual(promptContent);
	});

	it("restores agent-message ids and reports deduped follow-ups", async () => {
		const harness = await newHarness();
		const daemon = attachDaemon(harness);
		const restoredSteerContent: TextContent[] = [
			{ type: "text", text: "restored steer context" },
			{ type: "text", text: "restored steer" },
		];
		const restoredFollowUpContent: TextContent[] = [
			{ type: "text", text: "restored follow-up context" },
			{ type: "text", text: "restored follow-up" },
		];
		await harness.session.restoreFollowUpMessage("existing", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_existing",
		});

		await daemon.send({
			id: "steer-1",
			type: "steer",
			message: "restored steer",
			content: restoredSteerContent,
			queueKey: "heartbeat:steer",
			agentMessageId: "agentmsg_restored_steer",
			prefixMessages: [createCustomMessage("restored custom prefix")],
		});
		// Same queueKey as the pre-existing follow-up: must be reported deduped.
		await daemon.send({
			id: "follow-up-1",
			type: "follow_up",
			message: "duplicate",
			queueKey: "heartbeat:job-1",
			agentMessageId: "agentmsg_duplicate",
		});
		await daemon.send({
			id: "follow-up-2",
			type: "follow_up",
			message: "restored follow-up",
			content: restoredFollowUpContent,
			queueKey: "heartbeat:job-2",
			agentMessageId: "agentmsg_restored_followup",
		});

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true, data: { queued: false } }),
			expect.objectContaining({ id: "follow-up-2", command: "follow_up", success: true, data: { queued: true } }),
		]);
		const recovery = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(recovery.filter((action) => action.delivery === "next_turn_boundary")).toEqual([
			expect.objectContaining({
				queueKey: "heartbeat:steer",
				agentMessageId: "agentmsg_restored_steer",
				payload: expect.objectContaining({ kind: "turn", text: "restored steer", content: restoredSteerContent }),
			}),
		]);
		expect(recovery.filter((action) => action.delivery === "when_run_idle")).toEqual([
			expect.objectContaining({
				agentMessageId: "agentmsg_existing",
				payload: expect.objectContaining({ text: "existing" }),
			}),
			expect.objectContaining({
				agentMessageId: "agentmsg_restored_followup",
				payload: expect.objectContaining({ text: "restored follow-up", content: restoredFollowUpContent }),
			}),
		]);
	});

	it("resumes restored queues without promoting steering messages to prompts", async () => {
		const harness = await newHarness();
		harness.setResponses([
			fauxAssistantMessage("seed response"),
			fauxAssistantMessage("handled steer 1"),
			fauxAssistantMessage("handled steer 2"),
			fauxAssistantMessage("handled follow-up"),
		]);
		await harness.session.prompt("start");
		const daemon = attachDaemon(harness);

		await daemon.send({ id: "steer-1", type: "steer", message: "restored steer 1" });
		await daemon.send({ id: "steer-2", type: "steer", message: "restored steer 2" });
		await daemon.send({ id: "follow-up-1", type: "follow_up", message: "restored follow-up" });
		await daemon.send({ id: "resume-1", type: "resume_queue" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "steer-2", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["start", "restored steer 1", "restored steer 2", "restored follow-up"]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("drains restored queues when a continuation prompt resumes interrupted work", async () => {
		const harness = await newHarness();
		harness.setResponses([fauxAssistantMessage("handled continuation"), fauxAssistantMessage("handled follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));
		const daemon = attachDaemon(harness);

		await daemon.send({ id: "steer-1", type: "steer", message: "restored steer" });
		await daemon.send({ id: "follow-up-1", type: "follow_up", message: "restored follow-up" });
		await daemon.send({ id: "prompt-1", type: "prompt", message: "continue interrupted work" });

		await vi.waitFor(() =>
			expect(getUserTexts(harness)).toEqual(["restored steer", "restored follow-up", "continue interrupted work"]),
		);
		await harness.session.waitForSessionInputIdle();

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "steer-1", command: "steer", success: true }),
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "prompt-1", command: "prompt", success: true }),
		]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("resumes restored queues after an update marker without prior transcript messages", async () => {
		const harness = await newHarness();
		harness.setResponses([fauxAssistantMessage("handled restored follow-up")]);
		harness.session.agent.state.messages.push(createCustomMessage("update interrupted"));
		const daemon = attachDaemon(harness);

		await daemon.send({ id: "follow-up-1", type: "follow_up", message: "restored follow-up" });
		await daemon.send({ id: "resume-1", type: "resume_queue" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		await harness.session.agent.waitForIdle();

		expect(daemon.responses()).toEqual([
			expect.objectContaining({ id: "follow-up-1", command: "follow_up", success: true }),
			expect.objectContaining({ id: "resume-1", command: "resume_queue", success: true }),
		]);
		expect(getUserTexts(harness)).toEqual(["restored follow-up"]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
	});

	it("reports resume_queue failure when no work can resume", async () => {
		const harness = await newHarness();
		const daemon = attachDaemon(harness);

		await daemon.send({ id: "resume-1", type: "resume_queue" });
		await Promise.resolve();

		const [response] = daemon.responses();
		expect(response).toMatchObject({ id: "resume-1", command: "resume_queue", success: false });
		expect(JSON.stringify(response)).toContain("No queued work to resume");
	});

	// Folded in from the deleted 4657 one-off regression file.
	it("runs an overdue heartbeat after an unchanged worker session is restored (issue #4657)", async () => {
		const harness = await newHarness();
		harness.setResponses([fauxAssistantMessage("heartbeat recovered")]);
		const sessionFile = harness.session.sessionFile;
		const artifactDir = harness.sessionManager.getSessionArtifactDir();
		if (!sessionFile || !artifactDir) {
			throw new Error("Test session was not persisted");
		}

		const activeSessionId = "restored-active";
		const persistedStore = AgentCronJobStore.forSessionArtifacts();
		persistedStore.registerSessionArtifact(harness.session.sessionId, artifactDir);
		const heartbeat = persistedStore.createHeartbeat({
			activeSessionId,
			sessionId: harness.session.sessionId,
			sessionFile,
			cwd: harness.tempDir,
			scheduleText: "every 10s",
			prompt: "continue after the update",
			now: new Date(Date.now() - 20_000),
		});

		const internals = createDaemonInternals(harness, { worker: { restoreActiveSessionId: activeSessionId } });
		const state = createState(harness, activeSessionId);
		internals.sessions.set(activeSessionId, state);
		vi.useFakeTimers();
		internals.cronScheduler.start();
		try {
			internals.registerCronStoreForState(state);
			internals.rebindCronJobsToState(state);
			await internals.cronScheduler.runDue();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)?.runCount).toBe(1);

			const recovered = internals.cronStore.list().find((job) => job.id === heartbeat.id);
			expect(recovered).toMatchObject({ status: "active", runCount: 1, prompt: "continue after the update" });
			expect(Date.parse(recovered?.nextRunAt ?? "")).toBeGreaterThan(Date.now());
		} finally {
			internals.cronScheduler.stop();
			vi.useRealTimers();
		}
	});
});
