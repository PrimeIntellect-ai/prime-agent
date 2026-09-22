import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { type AgentCronJob, shouldDeferHeartbeatCronJob } from "../../src/core/cron-jobs.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "../../src/core/kernel/index.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	type CustomMessage,
	createSessionSlashCommandMessage,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
} from "../../src/core/messages.js";
import { getLocalHarnessStateDir, loadHarnessState, type RefinementResult } from "../../src/core/refinement/index.js";
import type { ActionStore, SessionAction } from "../../src/core/session-action-store.js";
import { parseSessionSlashCommand } from "../../src/core/slash-commands.js";
import type { BashOperations } from "../../src/core/tools/bash.js";
import {
	conversationMessages,
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
} from "./harness.js";
import { createDeferred, createWaitingHarness, gatedHook, withStreaming } from "./scheduling.js";

type SteeringStopInternals = {
	_steeringStopPending: boolean;
};

type CommitFenceInternals = {
	_actionStore: ActionStore<SessionAction>;
	_acquireSessionActionCommitFence(signal?: AbortSignal): Promise<{ release(): void }>;
	_promptInjectedMessage(
		text: string,
		message: {
			role: "custom";
			customType: string;
			content: string;
			display: boolean;
			details: Record<string, never>;
			timestamp: number;
		},
		options?: { returnAfterAccepted?: boolean },
	): Promise<void>;
};

function fenceInternals(harness: Harness): CommitFenceInternals {
	return harness.session as unknown as CommitFenceInternals;
}

function emptyRefinementResult(): RefinementResult {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

function refinePlanJson(summary: string, edits: unknown[] = []): string {
	return JSON.stringify({
		summary,
		rationale: `${summary} rationale`,
		expectedOutcome: `${summary} outcome`,
		edits,
	});
}

function createAutoRefineHarness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	return createHarness({ ...options, persistSession: true });
}

function heartbeatJob(): AgentCronJob {
	return {
		id: "heartbeat-test",
		status: "active",
		source: "heartbeat",
		activeSessionId: "active-test",
		sessionId: "session-test",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "check progress",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		nextRunAt: "2026-01-01T00:05:00.000Z",
		runCount: 0,
	};
}

function agentPromptText(id: string, body: string): string {
	return `Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: ${id}\n\n${body}`;
}

function agentMessagePayload(id: string, message: string, sessionId: string): AgentSessionMessagePayload {
	return {
		id,
		source: AGENT_MESSAGE_SOURCE,
		message,
		target: { activeSessionId: "target", sessionId },
	};
}

function cronJob(sessionId: string): AgentCronJob {
	const now = new Date().toISOString();
	return {
		id: "cron-overlap",
		status: "active",
		source: "cron",
		activeSessionId: "active-1",
		sessionId,
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "cron prompt",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: now,
		updatedAt: now,
		runCount: 0,
	};
}

type ActionKind = "turn" | "command";

function deliveredCount(harness: Harness, kind: ActionKind, text: string): number {
	if (kind === "turn") return getUserTexts(harness).filter((candidate) => candidate === text).length;
	return harness.session.messages.filter((message) => getMessageText(message) === text).length;
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function createContextMessage(content: string): CustomMessage {
	return {
		role: "custom",
		customType: "action-order-context",
		content,
		display: false,
		timestamp: Date.now(),
	};
}
describe("AgentSession queue characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs input handlers before deciding whether busy submissions enter a queue", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) =>
						event.text === "handled"
							? { action: "handled" }
							: { action: "transform", text: `transformed:${event.text}` },
					);
				},
			],
		});
		harnesses.push(harness);
		withStreaming(harness, true);

		await harness.session.prompt("queued", { streamingBehavior: "followUp" });
		await harness.session.prompt("handled", { streamingBehavior: "followUp" });

		expect(harness.session.getFollowUpMessages()).toEqual(["transformed:queued"]);
		expect(harness.session.queuedActionCount).toBe(1);
		withStreaming(harness, false);
		expect(harness.session.clearQueue()).toEqual({ steering: [], followUp: ["transformed:queued"] });
	});

	it("gives nextTurn delivery precedence over triggerTurn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.sendCustomMessage(
			{ customType: "precedence", content: "context only", display: true },
			{ triggerTurn: true, deliverAs: "nextTurn" },
		);

		expect(conversationMessages(harness.session)).toEqual([]);
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.session.prompt("consume context");
		expect(conversationMessages(harness.session).map((message) => message.role)).toEqual([
			"custom",
			"user",
			"assistant",
		]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores normalized payloads without interception, parsing, or an idle wake", async () => {
		let inputHandlerRuns = 0;
		let extensionCommandRuns = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async () => {
						inputHandlerRuns++;
						return { action: "transform", text: "rewritten" };
					});
					pi.registerCommand("literal", {
						description: "must stay literal",
						handler: async () => {
							extensionCommandRuns++;
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("steer done"), fauxAssistantMessage("follow-up done")]);

		await harness.session.restoreFollowUpMessage("/compact");
		await harness.session.restoreSteeringMessage("/literal keep text");
		await Promise.resolve();

		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
		expect(harness.session.getSteeringMessages()).toEqual(["/literal keep text"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["/compact"]);
		expect(conversationMessages(harness.session)).toEqual([]);

		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["/literal keep text", "/compact"]);
		expect(inputHandlerRuns).toBe(0);
		expect(extensionCommandRuns).toBe(0);
	});

	it("queueIfBusy enqueues behind pending work instead of draining it first", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		withStreaming(harness, true);
		await harness.session.followUp("already queued", undefined, { queueKey: "existing" });
		withStreaming(harness, false);

		let queuedAtPreflight: boolean | undefined;
		await harness.session.prompt("respects the queue", {
			queueIfBusy: true,
			streamingBehavior: "followUp",
			preflightResult: (_success, queued) => {
				queuedAtPreflight ??= queued;
			},
		});
		await harness.session.waitForIdle();

		expect(queuedAtPreflight).toBe(true);
		expect(getUserTexts(harness)).toEqual(["already queued", "respects the queue"]);
	});

	it.each(["queued", "preparing"] as const)(
		"keeps a coalesced duplicate with its $phase agent-message owner",
		async (phase) => {
			const prepared = createDeferred<void>();
			const releasePreparation = createDeferred<void>();
			const harness = await createHarness({
				extensionFactories:
					phase === "preparing"
						? [
								(pi) => {
									pi.on("before_agent_start", async () => {
										prepared.resolve();
										await releasePreparation.promise;
									});
								},
							]
						: [],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("accepted done")]);
			const pause = phase === "queued" ? harness.session.acquireQueuedWorkPause() : undefined;
			const id = `agentmsg_${phase}_coalesced_owner`;
			withStreaming(harness, true);
			const earlyDelivery = harness.session.waitForAgentMessagePromptDelivery(id);
			const admissionCompleted = createDeferred();

			const completion = harness.session.promptAndWait("accepted", {
				streamingBehavior: "followUp",
				followUpQueueKey: "same",
				agentMessageId: id,
				resumeIfIdle: true,
				preflightResult: (accepted, queued) => {
					if (phase === "queued") {
						expect({ accepted, queued }).toEqual({ accepted: true, queued: true });
						admissionCompleted.resolve();
					}
				},
			});
			if (phase === "queued") {
				await admissionCompleted.promise;
				expect(harness.session.getFollowUpMessages()).toEqual(["accepted"]);
			} else {
				withStreaming(harness, false);
				await prepared.promise;
				expect(harness.session.getFollowUpMessages()).toEqual([]);
			}
			await expect(
				harness.session.restoreFollowUpMessage("duplicate", undefined, { queueKey: "same", agentMessageId: id }),
			).resolves.toBe(false);

			withStreaming(harness, false);
			pause?.release();
			releasePreparation.resolve();
			await expect(earlyDelivery).resolves.toBeUndefined();
			await expect(completion).resolves.toBeUndefined();
			expect(getUserTexts(harness)).toEqual(["accepted"]);
		},
	);

	it("throws when queueing an extension command", async () => {
		const queue = (harness: Harness) => harness.session.steer("/testcmd queued");
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async () => {},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(queue(harness)).rejects.toThrow(
			'Extension command "/testcmd" cannot be queued. Use prompt() or execute the command when not streaming.',
		);
	});

	it("resolves pre-registered queued and direct agent-message delivery waiters once prompts start", async () => {
		const blocked = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_start", async () => blocked.promise);
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		withStreaming(harness, true);
		const queuedDelivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_sync");
		await harness.session.followUp("agent message", undefined, {
			agentMessageId: "agentmsg_sync",
			resumeIfIdle: true,
		});
		withStreaming(harness, false);

		// Queued delivery resolves on message_start, before the gated turn completes.
		await expect(queuedDelivery).resolves.toBeUndefined();
		blocked.resolve();
		await harness.session.waitForIdle();

		harness.setResponses([fauxAssistantMessage("direct reply")]);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_direct");
		await harness.session.acceptAgentMessagePrompt(agentPromptText("agentmsg_direct", "direct delivery"));
		await expect(delivery).resolves.toBeUndefined();
	});

	it.each([
		{
			action: "refine",
			run: (harness: Harness) => harness.session.refine({}, { skipAbort: true }),
		},
		{
			action: "compact",
			run: (harness: Harness) => harness.session.compact(undefined, { skipAbort: true }),
		},
	])("rejects skip-abort $action while a turn is active", async ({ action, run }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);

		await expect(run(harness)).rejects.toThrow(`Cannot ${action} without aborting while the agent is running.`);
	});

	it.each(["during admission", "before the call"] as const)(
		"rejects a trigger-turn action when the session is disposed %s",
		async (phase) => {
			const harness = await createHarness();
			harnesses.push(harness);
			const pause = phase === "during admission" ? harness.session.acquireQueuedWorkPause() : undefined;
			const release = pause ? vi.spyOn(pause, "release") : undefined;
			const prompt = vi.spyOn(harness.session.agent, "prompt");
			if (phase === "before the call") harness.session.dispose();

			const trigger = harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			);
			const rejection = expect(trigger).rejects.toThrow("session is disposing or disposed");
			if (phase === "during admission") {
				await yieldToEventLoop();
				harness.session.dispose();
			}
			await rejection;

			expect(prompt).not.toHaveBeenCalled();
			if (release) expect(release).not.toHaveBeenCalled();
		},
	);

	it("enforces the agent message queue cap inside core admission and restores the snapshot", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const accept = (index: number) => {
			const payload = agentMessagePayload(`agentmsg-${index}`, `message ${index}`, harness.session.sessionId);
			return harness.session.queueAgentMessagePrompt(
				createAgentSessionMessagePrompt(payload),
				"steer",
				createAgentSessionMessage(payload),
			);
		};

		for (let index = 0; index < 20; index++) {
			await accept(index);
		}
		await expect(accept(20)).rejects.toThrow("Target session has too many pending messages");
		expect(harness.session.unfinishedActionCount).toBe(20);
		const snapshot = harness.session.getSessionActionRecoverySnapshot();
		harness.session.dispose();
		pause.release();

		const restored = await createHarness();
		harnesses.push(restored);
		const restoredPause = restored.session.acquireQueuedWorkPause();
		await expect(restored.session.restoreSessionActions(snapshot)).resolves.toBe(20);
		expect(restored.session.unfinishedActionCount).toBe(20);
		restored.session.dispose();
		restoredPause.release();
	});

	it("serializes an agent message behind cron admission", async () => {
		const hook = gatedHook();
		const harness = await createHarness({ extensionFactories: [hook.factory] });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("cron done"), fauxAssistantMessage("steering done")]);
		const cronTurn = harness.session.promptHeartbeat(cronJob(harness.session.sessionId), {
			streamingBehavior: "followUp",
			source: "rpc",
		});
		await hook.reached;

		let queued: boolean | undefined;
		await harness.session.acceptAgentMessagePrompt("message during cron admission", {
			queueIfBusy: true,
			streamingBehavior: "steer",
			preflightResult: (accepted, didQueue) => {
				expect(accepted).toBe(true);
				queued = didQueue;
			},
		});

		expect(queued).toBe(true);
		expect(harness.session.getSessionActionSnapshot().steering).toContain("message during cron admission");
		hook.release();
		await cronTurn;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toContain("message during cron admission");
	});

	it("keeps a second one-at-a-time input queued when both use the same message object", async () => {
		const firstResponse = createDeferred();
		const firstProviderStarted = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.setFollowUpMode("one-at-a-time");
		harness.setResponses([
			async () => {
				firstProviderStarted.resolve();
				await firstResponse.promise;
				return fauxAssistantMessage("first done");
			},
			fauxAssistantMessage("second done"),
		]);
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_same_object",
			source: AGENT_MESSAGE_SOURCE,
			message: "same object",
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		};
		const message = createAgentSessionMessage(payload);
		const prompt = createAgentSessionMessagePrompt(payload);
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		await harness.session.queueAgentMessagePrompt(prompt, "followUp", message);
		pause.release();

		await firstProviderStarted.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual([prompt]);
		firstResponse.resolve();
		await harness.session.waitForIdle();

		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.messages.filter((item) => item === message)).toHaveLength(2);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	});

	it("rejects queued command delivery and completion when the invocation append fails", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(() => {
			throw new Error("durable invocation append failed");
		});
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_command_append_failed";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		const completion = harness.session.promptAndWait("/autonomous status", { agentMessageId: id });

		pause.release();
		await expect(delivery).rejects.toThrow("durable invocation append failed");
		await expect(completion).rejects.toThrow("durable invocation append failed");

		// The failed append must roll back fully: no live-only command message and
		// no unsaved leaf, so later durable entries persist cleanly.
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType.startsWith("session_slash_command"),
			),
		).toBe(false);
		expect(
			harness.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "session_slash_command"),
		).toBe(false);
		const followUpEntryId = harness.sessionManager.appendCustomMessageEntry("post-failure", "still writable", false);
		expect(harness.sessionManager.getBranch().at(-1)?.id).toBe(followUpEntryId);
	});

	it.each<{ name: string; delivered?: string[]; arm: (harness: Harness) => Promise<() => void> }>([
		{
			name: "paused",
			arm: async (harness: Harness) => {
				const pause = harness.session.acquireQueuedWorkPause();
				await harness.session.followUp("queued input", undefined, { resumeIfIdle: true });
				return () => pause.release();
			},
		},
		{
			name: "suspended after abort",
			arm: async (harness: Harness) => {
				await harness.session.followUp("queued input");
				harness.session.requestAbort();
				return () => {
					harness.session.resumeQueuedWork();
				};
			},
		},
		{
			name: "suspended after abort and cleared",
			delivered: [],
			arm: async (harness: Harness) => {
				await harness.session.followUp("queued input");
				harness.session.requestAbort();
				return () => {
					expect(harness.session.clearQueue().followUp).toEqual(["queued input"]);
				};
			},
		},
	])("waitForIdle parks while queued work is $name", async ({ arm, delivered = ["queued input"] }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		const release = await arm(harness);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued input"]);
		const originalWaitForIdle = harness.session.agent.waitForIdle.bind(harness.session.agent);
		let waitCalls = 0;
		vi.spyOn(harness.session.agent, "waitForIdle").mockImplementation(async () => {
			waitCalls++;
			await originalWaitForIdle();
		});
		const checkpointWaiters = (harness.session as unknown as { _sessionInputCheckpointWaiters: Set<() => void> })
			._sessionInputCheckpointWaiters;
		const waitParked = createDeferred();
		const originalAdd = checkpointWaiters.add.bind(checkpointWaiters);
		const addWaiter = vi.spyOn(checkpointWaiters, "add").mockImplementation((waiter) => {
			waitParked.resolve();
			return originalAdd(waiter);
		});
		const waiting = harness.session.waitForIdle().then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		try {
			await waitParked.promise;
			expect(waitCalls).toBe(0);
			expect(harness.session.getFollowUpMessages()).toEqual(["queued input"]);
		} finally {
			addWaiter.mockRestore();
			release();
		}
		expect(await waiting).toEqual({ ok: true });
		expect(getUserTexts(harness)).toEqual(delivered);
	});

	it("admits a resumeIfIdle follow-up after abort suspends queued work", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("queued done"), fauxAssistantMessage("wake done")]);
		await harness.session.followUp("queued before abort");
		await harness.session.abort();

		await expect(harness.session.followUp("wake after abort", undefined, { resumeIfIdle: true })).resolves.toBe(true);
		await harness.session.waitForIdle();

		expect(getUserTexts(harness)).toEqual(["queued before abort", "wake after abort"]);
	});

	it("resumes an explicit custom trigger after an ordinary abort", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("trigger resumed")]);
		harness.session.requestAbort();

		await harness.session.sendCustomMessage(
			{ customType: "trigger", content: "resume after abort", display: false },
			{ triggerTurn: true },
		);
		await harness.session.waitForIdle();
		expect(
			harness.session.messages.filter((message) => message.role === "custom").map((message) => message.content),
		).toContain("resume after abort");
	});

	it("rejects all new session actions while an input admission pause is held", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireSessionInputPause();
		await expect(harness.session.prompt("blocked prompt")).rejects.toThrow("input admission is paused");
		await expect(harness.session.followUp("blocked follow-up")).rejects.toThrow("input admission is paused");

		pause.release();
		harness.setResponses([fauxAssistantMessage("resumed")]);
		await harness.session.prompt("allowed prompt");
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["allowed prompt"]);
	});

	it.each([
		{
			name: "an explicit user prompt",
			resume: async (harness: Harness) => {
				harness.setResponses([fauxAssistantMessage("user turn done")]);
				await harness.session.prompt("explicit user resume");
			},
			userTexts: ["explicit user resume"],
		},
		{
			name: "resumeQueuedWork",
			resume: async (harness: Harness) => {
				harness.session.resumeQueuedWork();
				await Promise.resolve();
			},
			userTexts: [] as string[],
		},
	])("does not admit a late agent message across an abort and $name", async ({ resume, userTexts }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.requestAbort();
		const lateAgentMessage = harness.session.acceptAgentMessagePrompt(
			agentPromptText("agentmsg_after_abort", "late child result"),
		);
		const lateRejection = expect(lateAgentMessage).rejects.toThrow("queued session input is suspended");
		await lateRejection;

		await resume(harness);
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(userTexts);
	});

	it("restores next-turn context from cancelled actions in action order", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstPrompt = agentPromptText("agentmsg_restore_first", "first");
		const secondPrompt = agentPromptText("agentmsg_restore_second", "second");
		withStreaming(harness, true);
		await parkNextTurn(harness, "context A");
		await harness.session.queueAgentMessagePrompt(firstPrompt, "followUp");
		await parkNextTurn(harness, "context B");
		await harness.session.queueAgentMessagePrompt(secondPrompt, "followUp");

		expect(harness.session.clearQueue().followUp).toEqual([firstPrompt, secondPrompt]);
		expect(harness.session.getPendingNextTurnMessageSnapshots().map(getMessageText)).toEqual([
			"context A",
			"context B",
		]);
		withStreaming(harness, false);
	});

	it("delivers next-turn context when the first preparing turn is cancelled", async () => {
		const firstPrompt = agentPromptText("agentmsg_cancel_first", "cancelled");
		let cancelFirst: (() => void) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						cancelFirst?.();
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		let cleared: { steering: string[]; followUp: string[] } | undefined;
		cancelFirst = () => {
			cleared = harness.session.clearQueuedUserMessagesMatching((text) => text === firstPrompt);
		};
		let sawNextTurnContext = false;
		harness.setResponses([
			(context) => {
				sawNextTurnContext = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "carry this",
				);
				return fauxAssistantMessage("done");
			},
		]);

		const pause = harness.session.acquireQueuedWorkPause();
		await parkNextTurn(harness, "carry this");
		await harness.session.queueAgentMessagePrompt(firstPrompt, "followUp");
		// Both inputs stay in one priority class so the agent message keeps the batch anchor.
		await harness.session.followUp("surviving", undefined, { priority: "background" });
		pause.release();
		await harness.session.waitForIdle();

		expect(cleared).toEqual({ steering: [], followUp: [firstPrompt] });
		expect(sawNextTurnContext).toBe(true);
		expect(getUserTexts(harness)).toEqual(["surviving"]);
	});
});

describe("AgentSession action commit-fence races", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each([
		...["turn", "command"].flatMap((kind) =>
			(["pause", "clear", "restart", "dispose"] as const).map((interruption) => ({
				kind: kind as ActionKind,
				interruption,
			})),
		),
	])("settles a $kind with the $interruption commit-fence outcome", async ({ kind, interruption }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		if (kind === "turn") harness.setResponses([fauxAssistantMessage("done")]);
		const text = kind === "turn" ? "commit-fence turn" : "/autonomous status";
		const reached = createDeferred();
		const releaseFence = createDeferred();
		const internals = fenceInternals(harness);
		const acquireFence = internals._acquireSessionActionCommitFence.bind(internals);
		internals._acquireSessionActionCommitFence = async () => {
			if (internals._actionStore.unfinishedActions().length === 0) return acquireFence();
			reached.resolve();
			await releaseFence.promise;
			return acquireFence();
		};

		let completion: Promise<void>;
		if (kind === "turn") {
			expect(await harness.session.followUp(text, undefined, { resumeIfIdle: true })).toBe(true);
			const action = internals._actionStore.unfinishedActions()[0];
			if (!action) throw new Error("Expected an owned turn action");
			completion = internals._actionStore.ticketFor(action).ticket.completed;
		} else {
			completion = harness.session.promptAndWait(text);
		}
		const outcome = completion.then(
			() => ({ status: "resolved" as const }),
			(error: unknown) => ({ status: "rejected" as const, error }),
		);
		await reached.promise;

		let pause: { release(): void } | undefined;
		if (interruption === "pause") pause = harness.session.acquireQueuedWorkPause();
		else if (interruption === "clear") {
			expect(harness.session.clearQueue().followUp).toEqual([text]);
		} else if (interruption === "restart") harness.session.abortForUpdateRestart();
		else harness.session.dispose();
		releaseFence.resolve();

		if (interruption === "pause" || interruption === "restart") {
			await harness.session.waitForSessionInputCheckpoint();
			expect(deliveredCount(harness, kind, text)).toBe(0);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(1);
			if (interruption === "pause") pause?.release();
			else harness.session.resumeQueuedWork();
			expect(await outcome).toEqual({ status: "resolved" });
			await harness.session.waitForIdle();
			expect(deliveredCount(harness, kind, text)).toBe(1);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		} else {
			const settled = await outcome;
			expect(settled.status).toBe("rejected");
			if (settled.status !== "rejected") throw new Error("Expected terminal interruption to reject");
			expect(settled.error).toEqual(
				expect.objectContaining({
					message:
						interruption === "clear"
							? "Queued agent message was cleared before delivery."
							: kind === "command"
								? "Session disposed before prompt completion."
								: "Session disposed before prompt delivery.",
				}),
			);
			expect(deliveredCount(harness, kind, text)).toBe(0);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		}
	});

	it.each([
		{
			name: "commit fence",
			hold: async (harness: Harness) => {
				const fence = await fenceInternals(harness)._acquireSessionActionCommitFence();
				return () => fence.release();
			},
		},
		{
			name: "queued-work pause",
			hold: async (harness: Harness) => {
				const pause = harness.session.acquireQueuedWorkPause();
				return () => pause.release();
			},
		},
	])("cancels an admission-blocked prompt held by the $name without leaking the fence", async ({ hold }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const release = await hold(harness);
		const controller = new AbortController();
		const prompt = harness.session.promptUntilAccepted("blocked prompt", { signal: controller.signal });
		await yieldToEventLoop();

		controller.abort();
		await expect(prompt).rejects.toMatchObject({
			name: "PromptAdmissionCancelledError",
			message: "Prompt admission was cancelled.",
		});

		const nextFencePromise = fenceInternals(harness)._acquireSessionActionCommitFence();
		release();
		const nextFence = await nextFencePromise;
		nextFence.release();
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("rejects an agent message when clear wins core admission", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const fence = await fenceInternals(harness)._acquireSessionActionCommitFence();
		const payload = agentMessagePayload("agentmsg_clear_race", "clear race", harness.session.sessionId);
		const accepted = harness.session.acceptAgentMessagePrompt(createAgentSessionMessagePrompt(payload), {
			customMessage: createAgentSessionMessage(payload),
			queueIfBusy: true,
			streamingBehavior: "steer",
		});
		await Promise.resolve();

		harness.session.clearQueuedAgentMessages();
		fence.release();

		await expect(accepted).rejects.toThrow("Agent message was cleared before admission");
		expect(harness.session.unfinishedActionCount).toBe(0);
	});

	it("rejects a prompt waiting behind tree navigation when the session is disposed", async () => {
		const treeHookReached = createDeferred();
		const treeHookGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						treeHookReached.resolve();
						await treeHookGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		await harness.session.prompt("two");

		const navigation = harness.session.navigateTree(target!.id, { summarize: false });
		await treeHookReached.promise;
		const prompt = harness.session.prompt("blocked prompt");

		harness.session.dispose();
		try {
			await expect(prompt).rejects.toThrow(
				"Cannot admit a session action because the session is disposing or disposed.",
			);
		} finally {
			treeHookGate.resolve();
		}
		await expect(navigation).resolves.toMatchObject({ cancelled: false });
	});

	it("preserves pause-held arrival order between injected and ordinary prompts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const internals = fenceInternals(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const injectedMessage = {
			role: "custom" as const,
			customType: "injected-order-probe",
			content: "earlier injected prompt",
			display: true,
			details: {},
			timestamp: Date.now(),
		};

		const injected = internals._promptInjectedMessage("earlier injected prompt", injectedMessage, {
			returnAfterAccepted: true,
		});
		const ordinary = harness.session.promptUntilAccepted("later ordinary prompt");
		await yieldToEventLoop();
		pause.release();
		await Promise.all([injected, ordinary]);
		await harness.session.waitForIdle();

		expect(
			harness.session.messages
				.map((message) => getMessageText(message))
				.filter((text) => text === "earlier injected prompt" || text === "later ordinary prompt"),
		).toEqual(["earlier injected prompt", "later ordinary prompt"]);
	});

	it("keeps each prefix with its primary when dispatching an all-mode batch", async () => {
		const deliveredMessages: string[] = [];
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				deliveredMessages.push(
					...context.messages.map(getMessageText).filter((text) => !text.startsWith("[harness-digest]")),
				);
				return fauxAssistantMessage("done");
			},
		]);
		harness.session.setFollowUpMode("all");
		await harness.session.restoreFollowUpMessage("primary A", undefined, {
			prefixMessages: [createContextMessage("prefix A")],
		});
		await harness.session.restoreFollowUpMessage("primary B", undefined, {
			prefixMessages: [createContextMessage("prefix B")],
		});
		await harness.session.sendCustomMessage(
			{ customType: "shared-next-turn", content: "shared next turn", display: false },
			{ deliverAs: "nextTurn" },
		);

		harness.session.resumeQueuedWork();
		await harness.session.waitForIdle();

		expect(deliveredMessages).toEqual(["prefix A", "shared next turn", "primary A", "prefix B", "primary B"]);
	});
});

describe("AgentSession scheduler scenarios", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("S1: delivers mid-run steering, follow-up, command, and custom inputs in order", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const waiting = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
				},
			],
		});
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");

		const countsAtUserMessageStart: Array<{ text: string; pending: number }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "user") {
				countsAtUserMessageStart.push({
					text: getMessageText(event.message),
					pending: harness.session.queuedActionCount,
				});
			}
		});

		let batchedUsers: string[] | undefined;
		let batchSawImage = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				const sawSteer = context.messages.some(
					(message) => message.role === "user" && getMessageText(message) === "s1",
				);
				return fauxAssistantMessage(sawSteer ? "handled s1" : "missing s1");
			},
			(context) => {
				const sawCustom = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "steer custom"),
				);
				return fauxAssistantMessage(sawCustom ? "handled steer custom" : "missing steer custom");
			},
			fauxAssistantMessage("handled extension steer"),
			fauxAssistantMessage("f1 done"),
			(context) => {
				batchedUsers = context.messages
					.filter((message) => message.role === "user")
					.map((message) => getMessageText(message));
				batchSawImage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "image" && part.data === "image-data"),
				);
				return fauxAssistantMessage("f2 batch done");
			},
		]);

		// Phase 1: queue all input kinds while the run is gated.
		await waitForToolStart;
		await harness.session.steer("s1");
		await harness.session.sendCustomMessage(
			{ customType: "queue-test", content: "steer custom", display: true, details: {} },
			{ deliverAs: "steer" },
		);
		expect(extensionApi).toBeDefined();
		extensionApi?.sendUserMessage("extension steer", { deliverAs: "steer" });
		await harness.session.followUp("f1");
		await harness.session.prompt("/autonomous status", { streamingBehavior: "followUp" });
		await harness.session.followUp("f2");
		await harness.session.sendCustomMessage(
			{
				customType: "queue-test-follow-up",
				content: [
					{ type: "text", text: "follow-up custom" },
					{ type: "image", data: "image-data", mimeType: "image/png" },
				],
				display: true,
				details: {},
			},
			{ deliverAs: "followUp" },
		);

		// Phase 2: queued work stays in session queues, not Agent queues.
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		const pendingAfterQueueing = harness.session.queuedActionCount;
		expect(pendingAfterQueueing).toBeGreaterThan(0);
		expect(harness.session.getFollowUpMessages()).toContain("f1");
		expect(harness.session.getFollowUpMessages()).toContain("f2");

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();

		// Phase 3: steering inside the run, follow-ups after it, f2 + custom batched (all mode).
		expect(getAssistantTexts(harness)).toEqual([
			"",
			"handled s1",
			"handled steer custom",
			"handled extension steer",
			"f1 done",
			"f2 batch done",
		]);
		expect(getUserTexts(harness)).toEqual(["start", "s1", "extension steer", "f1", "f2"]);
		expect(batchedUsers).toContain("f2");
		expect(batchedUsers).toContain("follow-up custom");
		expect(batchSawImage).toBe(true);

		// Phase 4: the command is a durable hard boundary between f1 and f2.
		const rows = harness.session.messages.map((message) =>
			message.role === "custom" ? `custom:${message.customType}` : `${message.role}`,
		);
		const userTexts = harness.session.messages.map((message) =>
			message.role === "user" ? getMessageText(message) : undefined,
		);
		const f1Index = userTexts.indexOf("f1");
		const f2Index = userTexts.indexOf("f2");
		const commandIndex = rows.indexOf("custom:session_slash_command");
		expect(commandIndex).toBeGreaterThan(f1Index);
		expect(commandIndex).toBeLessThan(f2Index);
		expect(rows).toContain("custom:autonomous_status");
		expect(rows).toContain("custom:queue-test");
		expect(rows).toContain("custom:queue-test-follow-up");

		// Phase 5: every queued input left the pending count before its message_start.
		expect(harness.session.queuedActionCount).toBe(0);
		const queuedStarts = countsAtUserMessageStart.filter((entry) => entry.text !== "start");
		expect(queuedStarts.length).toBeGreaterThan(0);
		for (const entry of queuedStarts) {
			expect(entry.pending).toBeLessThan(pendingAfterQueueing);
		}
		for (let i = 1; i < queuedStarts.length; i++) {
			expect(queuedStarts[i]!.pending).toBeLessThanOrEqual(queuedStarts[i - 1]!.pending);
		}
	});

	it("S2: edits queued work mid-run with coalescing, removal APIs, and steering-stop reconciliation", async () => {
		const waiting = await createWaitingHarness();
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = waiting;
		harnesses.push(harness);
		const internals = harness.session as unknown as SteeringStopInternals;
		const agentPrompt = agentPromptText("agentmsg_s2_clear", "clear me");
		const followUpAgentPrompt = agentPromptText("agentmsg_s2_follow", "clear me too");
		const removedInputs = new Set(["first", "second", "same heartbeat", agentPrompt, followUpAgentPrompt]);
		let continuationRemovedInputs: string[] = [];
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			(context) => {
				continuationRemovedInputs = context.messages
					.filter((message) => message.role === "user")
					.map(getMessageText)
					.filter((text) => removedInputs.has(text));
				return fauxAssistantMessage("continued clean");
			},
			fauxAssistantMessage("keep me done"),
			fauxAssistantMessage("spoof done"),
		]);
		await waitForToolStart;

		// Phase 1: keyed follow-ups coalesce per key.
		const preflights: boolean[] = [];
		await harness.session.prompt("same heartbeat", { streamingBehavior: "followUp", followUpQueueKey: "hb:one" });
		await harness.session.prompt("same heartbeat", { streamingBehavior: "followUp", followUpQueueKey: "hb:two" });
		await harness.session.prompt("same heartbeat", {
			streamingBehavior: "followUp",
			followUpQueueKey: "hb:two",
			preflightResult: (didSucceed: boolean) => preflights.push(didSucceed),
		});
		expect(preflights).toEqual([false]);
		expect(harness.session.getFollowUpMessages()).toEqual(["same heartbeat", "same heartbeat"]);
		await harness.session.followUp("keep me", undefined, { queueKey: "hb:keep" });

		// Phase 2: steering never coalesces.
		await harness.session.steer("first", undefined, { queueKey: "same-steer" });
		await harness.session.steer("second", undefined, { queueKey: "same-steer" });
		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
		expect(internals._steeringStopPending).toBe(true);
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_s2_clear");
		await harness.session.queueAgentMessagePrompt(agentPrompt, "steer");

		// Phase 3: keyed duplicates reject both agent-message outcome legs.
		const dupDelivery = expect(harness.session.waitForAgentMessagePromptDelivery("agentmsg_s2_dup")).rejects.toThrow(
			"equivalent follow-up is already pending",
		);
		await expect(
			harness.session.promptAndWait("another duplicate", {
				streamingBehavior: "followUp",
				followUpQueueKey: "hb:two",
				agentMessageId: "agentmsg_s2_dup",
			}),
		).rejects.toThrow("equivalent follow-up is already pending");
		await dupDelivery;
		await expect(
			harness.session.restoreFollowUpMessage("restored duplicate", undefined, {
				queueKey: "hb:two",
				agentMessageId: "agentmsg_s2_restored",
			}),
		).resolves.toBe(false);

		// Phase 4: removal APIs.
		expect(harness.session.removeQueuedFollowUp("hb:one")).toBe(true);
		expect(harness.session.removeQueuedFollowUp("hb:one")).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["same heartbeat", "keep me"]);
		await harness.session.queueAgentMessagePrompt(followUpAgentPrompt, "followUp");
		const spoofedPlain = agentPromptText("agentmsg_spoof", "ordinary user text");
		await harness.session.followUp(spoofedPlain);
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [agentPrompt],
			followUp: [followUpAgentPrompt],
		});
		await expect(delivery).rejects.toThrow("cleared before delivery");

		// Phase 5: steering-stop reconciliation.
		expect(harness.session.getSteeringMessages()).toEqual(["first", "second"]);
		expect(internals._steeringStopPending).toBe(true);
		expect(harness.session.removeQueuedFollowUp("same-steer")).toBe(true);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(internals._steeringStopPending).toBe(false);
		expect(harness.session.removeQueuedFollowUp("hb:two")).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me", spoofedPlain]);
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text === spoofedPlain)).toEqual({
			steering: [],
			followUp: [],
		});
		expect(harness.session.getFollowUpMessages()).toEqual(["keep me", spoofedPlain]);

		// Phase 6: the run continues without any removed input.
		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(continuationRemovedInputs).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["start", "keep me", spoofedPlain]);
		expect(getAssistantTexts(harness)).toEqual(["", "continued clean", "keep me done", "spoof done"]);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("S3: pause-lease preparation journey with anchor re-preparation and direct handoff", async () => {
		const firstPreparation = createDeferred();
		const prepared: string[] = [];
		const directGate = gatedHook({ prompt: "direct" });
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => {
						if (event.prompt === "direct") return;
						prepared.push(event.prompt);
						if (prepared.length === 1) await firstPreparation.promise;
						return { systemPrompt: `${event.systemPrompt}\nprepared:${event.prompt}` };
					});
				},
				directGate.factory,
			],
		});
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		const responseGate = createDeferred();
		let providerSystemPrompt = "";
		harness.setResponses([
			async (context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				await responseGate.promise;
				return fauxAssistantMessage("remaining response");
			},
			fauxAssistantMessage("direct done"),
			fauxAssistantMessage("late queued done"),
		]);

		// Phase 1: a pause lease holds queued work.
		const removedAgentMessage = agentPromptText("agentmsg_remove", "remove");
		const keptAgentMessage = agentPromptText("agentmsg_keep", "keep");
		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("ordinary");
		await harness.session.queueAgentMessagePrompt(removedAgentMessage, "followUp", undefined);
		await harness.session.queueAgentMessagePrompt(keptAgentMessage, "followUp", undefined);
		await harness.session.followUp("last anchor", undefined, {
			queueKey: "heartbeat:one",
			// A heartbeat follow-up is machine input, so it queues behind the agent messages.
			priority: "background",
		});
		expect(prepared).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);

		// Phase 2: release starts preparation with the last message as batch anchor.
		pause.release();
		await vi.waitFor(() => expect(prepared).toEqual(["last anchor"]));

		// Phase 3: removals during preparation re-prepare around the new anchor.
		expect(harness.session.clearQueuedUserMessagesMatching((text) => text === removedAgentMessage)).toEqual({
			steering: [],
			followUp: [removedAgentMessage],
		});
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(true);
		firstPreparation.resolve();
		await vi.waitFor(() => expect(providerSystemPrompt).not.toBe(""));
		expect(harness.session.removeQueuedFollowUp("heartbeat:one")).toBe(false);
		expect(prepared).toEqual(["last anchor", keptAgentMessage]);
		expect(providerSystemPrompt).toContain(`prepared:${keptAgentMessage}`);
		expect(providerSystemPrompt).not.toContain("prepared:last anchor");
		responseGate.resolve();
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage]);

		// Phase 4: a direct prompt blocks queued work admitted behind it.
		const direct = harness.session.prompt("direct");
		await directGate.reached;
		await harness.session.followUp("late queued", undefined, { resumeIfIdle: true });
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage]);
		directGate.release();
		await direct;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["ordinary", keptAgentMessage, "direct", "late queued"]);
	});

	it("S4: restart abort snapshots queued work and restores it, envelopes as commands", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let providerCalls = 0;
		const firstGate = createDeferred();
		harness.setResponses([
			async () => {
				await firstGate.promise;
				return fauxAssistantMessage("first done");
			},
			() => {
				providerCalls++;
				return fauxAssistantMessage("must not run");
			},
		]);

		// Phase 1: queue a follow-up, a command with images, and an agent-message prompt mid-run.
		const first = harness.session.prompt("first");
		await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
		await harness.session.followUp("queued for restart");
		const image = { type: "image" as const, mimeType: "image/png", data: "image-data" };
		await harness.session.prompt("/goal inspect image", { streamingBehavior: "followUp", images: [image] });
		const agentPrompt = agentPromptText("agentmsg_abort", "survive the abort");
		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_abort");
		await harness.session.queueAgentMessagePrompt(agentPrompt, "followUp");
		let deliverySettled = false;
		void delivery.then(
			() => {
				deliverySettled = true;
			},
			() => {
				deliverySettled = true;
			},
		);

		// Phase 2: abortForUpdateRestart suspends the queue without starting a new turn.
		harness.session.abortForUpdateRestart();
		firstGate.resolve();
		await first.catch(() => undefined);
		await harness.session.agent.waitForIdle();
		await harness.session.waitForSessionInputIdle();
		expect(providerCalls).toBe(0);
		expect(harness.session.getFollowUpMessages()).toEqual(["queued for restart", "/goal inspect image", agentPrompt]);
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ text: "queued for restart" }) }),
			expect.objectContaining({
				payload: expect.objectContaining({ text: "/goal inspect image", images: [image] }),
			}),
			expect.objectContaining({
				agentMessageId: "agentmsg_abort",
				payload: expect.objectContaining({ text: agentPrompt }),
			}),
		]);
		expect(deliverySettled).toBe(false);

		// Phase 3: while suspended, triggerTurn rejects promptly.
		const agentPromptSpy = vi.spyOn(harness.session.agent, "prompt");
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "trigger", content: "trigger", display: false },
				{ triggerTurn: true },
			),
		).rejects.toThrow("queued session input is suspended");
		expect(agentPromptSpy).not.toHaveBeenCalled();

		// Phase 4: restore an envelope command and a literal slash message, then resume.
		const command = parseSessionSlashCommand("/autonomous status");
		expect(command).toBeDefined();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			agentMessageId: "agentmsg_restored_command",
			customMessage: createSessionSlashCommandMessage(command!),
		});
		const mismatchedCommand = parseSessionSlashCommand("/autonomous on");
		expect(mismatchedCommand).toBeDefined();
		await harness.session.restoreFollowUpMessage(command!.text, undefined, {
			customMessage: createSessionSlashCommandMessage(mismatchedCommand!),
		});
		await harness.session.restoreFollowUpMessage("/autonomous off", undefined, {
			customMessage: {
				role: "custom",
				customType: "restored-literal",
				content: "/autonomous off",
				display: true,
				timestamp: Date.now(),
			},
		});
		harness.setResponses([
			fauxAssistantMessage("queued handled"),
			fauxAssistantMessage("agent prompt handled"),
			fauxAssistantMessage("literal handled"),
		]);
		expect(harness.session.resumeQueuedWork()).toBe(true);
		await harness.session.waitForIdle();

		// Phase 5: envelope ran as a command, the literal stayed literal, delivery settled.
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(
			harness.session.messages.filter(
				(message) =>
					message.role === "custom" &&
					message.customType === "session_slash_command" &&
					(message.details as { command?: { text?: string } } | undefined)?.command?.text === command!.text,
			),
		).toHaveLength(1);
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "restored-literal",
			),
		).toBe(true);
		await expect(delivery).resolves.toBeUndefined();
		expect(getUserTexts(harness)).toContain("queued for restart");
		expect(getUserTexts(harness)).toContain(agentPrompt);
		expect(harness.session.queuedActionCount).toBe(0);
	});

	it("S5: settles queued command delivery before gated completion and rejects completion on failure", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		// Phase 1: delivery settles at the durable append, completion stays gated.
		const started = createDeferred<void>();
		const release = createDeferred<void>();
		vi.spyOn(harness.session, "refine")
			.mockImplementationOnce(async () => {
				started.resolve();
				await release.promise;
				return emptyRefinementResult();
			})
			.mockRejectedValueOnce(new Error("refine execution failed"));
		const pause = harness.session.acquireQueuedWorkPause();
		const id = "agentmsg_gated_command";
		const delivery = harness.session.waitForAgentMessagePromptDelivery(id);
		let completionSettled = false;
		const completion = harness.session.promptAndWait("/refine --local", { agentMessageId: id }).finally(() => {
			completionSettled = true;
		});
		pause.release();
		await started.promise;
		await expect(delivery).resolves.toBeUndefined();
		expect(completionSettled).toBe(false);
		release.resolve();
		await expect(completion).resolves.toBeUndefined();

		// Phase 2: execution failure is delivered but rejects completion.
		const failedPause = harness.session.acquireQueuedWorkPause();
		const failedId = "agentmsg_failed_command";
		const failedDelivery = harness.session.waitForAgentMessagePromptDelivery(failedId);
		const failedCompletion = harness.session.promptAndWait("/refine --local", { agentMessageId: failedId });
		failedPause.release();
		await expect(failedDelivery).resolves.toBeUndefined();
		await expect(failedCompletion).rejects.toThrow("refine execution failed");
	});

	it("S6: auto-refine reviews after real turns, defers while busy, and drops reviews on navigation", async () => {
		const review2Gate = createDeferred();
		const review3Gate = createDeferred();
		const reviewer = vi.fn(
			async (context: { reason: string; turnsSinceLastReview: number }, _signal?: AbortSignal) => {
				if (reviewer.mock.calls.length === 2) await review2Gate.promise;
				if (reviewer.mock.calls.length === 3) await review3Gate.promise;
				return { shouldRefine: true, rationale: "durable lesson", instructions: `lesson ${context.reason}` };
			},
		);
		const harness = await createAutoRefineHarness({
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		const previousAgentDir = process.env.PRIME_AGENT_CODING_AGENT_DIR;
		process.env.PRIME_AGENT_CODING_AGENT_DIR = `${harness.tempDir}/agent`;
		try {
			const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir())!;
			const memoryIds = () => {
				try {
					return Object.keys(loadHarnessState(localDir, "local").entries.memory ?? {});
				} catch {
					return [];
				}
			};
			const busyGate = createDeferred();
			harness.setResponses([
				fauxAssistantMessage("first done"),
				fauxAssistantMessage(
					refinePlanJson("First auto refine", [
						{ action: "create", kind: "memory", id: "auto_one", title: "One", content: "First lesson." },
					]),
				),
				fauxAssistantMessage("second done"),
				async () => {
					await busyGate.promise;
					return fauxAssistantMessage("busy done");
				},
				fauxAssistantMessage(
					refinePlanJson("Second auto refine", [
						{ action: "create", kind: "memory", id: "auto_two", title: "Two", content: "Second lesson." },
					]),
				),
				fauxAssistantMessage("fourth done"),
			]);

			// Phase 1: interval review approves and the refine applies durably.
			await harness.session.prompt("first");
			await vi.waitFor(() => expect(memoryIds()).toContain("auto_one"));
			expect(reviewer).toHaveBeenCalledTimes(1);
			expect(reviewer.mock.calls[0]![0]).toEqual({ reason: "turn_interval", turnsSinceLastReview: 1 });

			// Phase 2: review resolves while busy -> refine defers.
			await harness.session.prompt("second");
			await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(2));
			const busyPrompt = harness.session.prompt("busy");
			await vi.waitFor(() => expect(harness.session.isStreaming).toBe(true));
			review2Gate.resolve();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(memoryIds()).not.toContain("auto_two");

			// Phase 3: the pending review executes at idle without a second review.
			busyGate.resolve();
			await busyPrompt;
			await vi.waitFor(() => expect(memoryIds()).toContain("auto_two"));
			expect(reviewer).toHaveBeenCalledTimes(2);

			// Phase 4: branch navigation discards the in-flight review.
			await harness.session.prompt("fourth");
			await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(3));
			const target = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "user");
			expect(target).toBeDefined();
			const navigation = harness.session.navigateTree(target!.id, { summarize: false });
			review3Gate.resolve();
			await navigation;
			await harness.session.waitForIdle();
			expect(memoryIds()).toEqual(["auto_one", "auto_two"]);
			expect(harness.getPendingResponseCount()).toBe(0);
		} finally {
			if (previousAgentDir === undefined) {
				delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
			} else {
				process.env.PRIME_AGENT_CODING_AGENT_DIR = previousAgentDir;
			}
		}
	});

	it("waitForIdle parks instead of microtask-spinning while a running bash blocks queued input", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session;
		let releaseBash!: () => void;
		const gate = new Promise<{ exitCode: number | null }>((resolve) => {
			releaseBash = () => resolve({ exitCode: 0 });
		});
		const operations: BashOperations = { exec: async () => await gate };
		const bashPromise = session.executeBash("blocked", undefined, { operations });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(session.isBashRunning).toBe(true);

		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const firstPrompt = session.prompt("queued while bash runs");
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Count pump scheduling from the idle wait. Unfixed, the wait loop respun the
		// blocked pump purely in microtasks, so the setImmediate below never fired and
		// only the 200th reschedule (the escape hatch) released the gate.
		const internals = session as unknown as { _scheduleSessionInputPump(): void };
		const originalSchedule = internals._scheduleSessionInputPump.bind(session);
		let scheduleCount = 0;
		let secondPrompt: Promise<void> | undefined;
		internals._scheduleSessionInputPump = () => {
			scheduleCount++;
			if (scheduleCount === 200) releaseBash();
			originalSchedule();
		};

		const idle = session.waitForIdle();
		setImmediate(() => {
			// An arrival during the park must not be lost once the busy state clears.
			secondPrompt = session.prompt("queued during park");
			secondPrompt.catch(() => undefined);
			releaseBash();
		});
		await idle;
		await bashPromise;
		await firstPrompt;
		await secondPrompt;

		expect(scheduleCount).toBeLessThan(200);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	});
});

type LateSentAgentMessageHost = {
	_recordLateIpythonSentAgentMessage: (toolCallId: string, message: KernelSentAgentMessage) => void;
	_agentEventQueue: Promise<void>;
	_lateIpythonSentAgentMessages: Map<string, KernelSentAgentMessage[]>;
	_restoreLateIpythonSentAgentMessages: () => void;
};

type KernelHostSession = {
	_createKernelHostHandlers(): HostRequestHandlers;
};

type StateRestoreHost = {
	_onIpythonStateRestored(result: { restored: string[]; failed: string[]; path: string }): void;
};

const HEARTBEAT_MARKED_PROMPT = "[heartbeat: every 5m run#0]\n\ncheck progress";

const shellCompletion = { pid: 42, command: "npm test", exitCode: 0 };

function kernelHandlers(harness: Harness): HostRequestHandlers {
	return (harness.session as unknown as KernelHostSession)._createKernelHostHandlers();
}

function completeShell(harness: Harness): Promise<unknown> {
	return kernelHandlers(harness)["bash.completed"]!(shellCompletion) as Promise<unknown>;
}

function readShellResult(harness: Harness, command = shellCompletion.command): Promise<unknown> {
	return kernelHandlers(harness)["bash.consumed"]!({ pid: shellCompletion.pid, command }) as Promise<unknown>;
}

function parkNextTurn(harness: Harness, content: string): Promise<void> {
	return harness.session.sendCustomMessage(
		{ customType: "next-turn", content, display: true, details: {} },
		{ deliverAs: "nextTurn" },
	);
}

function shellMessages(harness: Harness): unknown[] {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	);
}

describe("AgentSession queue regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("ENG-5991: interrupt delivers every queued steering message in one new turn and stays abort-only at the edges", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("queued handled"),
			fauxAssistantMessage("injected handled"),
			fauxAssistantMessage("later handled"),
		]);
		await waitForToolStart;
		await harness.session.steer("first");
		await completeShell(harness);
		await harness.session.steer("second");
		expect(harness.session.abortAndSendQueued()).toBe(true);
		await harness.session.steer("later", undefined, { priority: "background" });
		releaseToolExecution();
		await Promise.all([promptPromise, harness.session.waitForIdle()]);
		expect(getUserTexts(harness)).toEqual(["start", "first", "second", "later"]);
		expect(getAssistantTexts(harness)).toEqual(["", "queued handled", "injected handled", "later handled"]);
		expect(harness.session.steeringMode).toBe("one-at-a-time");
		await harness.session.followUp("follow-up boundary");
		expect(harness.session.abortAndSendQueued()).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual(["follow-up boundary"]);
		harness.session.clearQueue();
		harness.session.resumeQueuedWork();
		await harness.session.steer("queued for restart");
		harness.session.abortForUpdateRestart();
		expect(harness.session.abortAndSendQueued()).toBe(false);
		expect(harness.session.getSteeringMessages()).toEqual(["queued for restart"]);
		await expect(
			harness.session.sendCustomMessage({ customType: "g", content: "t", display: false }, { triggerTurn: true }),
		).rejects.toThrow("queued session input is suspended");
	});

	it("ENG-4531: persists sent agent messages that arrive after their Python cell completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "ipython_4531",
			toolName: "ipython",
			content: [{ type: "text", text: "" }],
			details: { status: "ok" },
			isError: false,
			timestamp: Date.now(),
		};
		harness.session.sessionManager.appendMessage(
			fauxAssistantMessage(fauxToolCall("ipython", { code: "background_send" }), { stopReason: "toolUse" }),
		);
		harness.session.sessionManager.appendMessage(toolResult);
		harness.session.agent.state.messages.push(toolResult);
		const lateMessage = {
			id: "agentmsg_late_4531",
			message: "Background review finished.",
			deliveryStatus: "delivered" as const,
			target: { activeSessionId: "worker-active", sessionId: "worker-session", sessionName: "Worker" },
		};
		const events: string[] = [];
		const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
		const host = harness.session as unknown as LateSentAgentMessageHost;

		host._recordLateIpythonSentAgentMessage(toolResult.toolCallId, lateMessage);
		await host._agentEventQueue;
		unsubscribe();

		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });
		expect(
			harness.session.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom" && entry.customType === "ipython_sent_agent_message"),
		).toBe(true);
		expect(events).toContain("ipython_sent_agent_message");
		expect(
			harness.session
				.buildSessionContext()
				.messages.find(
					(message): message is ToolResultMessage =>
						message.role === "toolResult" && message.toolCallId === toolResult.toolCallId,
				)?.details,
		).toMatchObject({ sentAgentMessages: [lateMessage] });

		// A rebuilt transcript re-attaches the receipt; receipts for abandoned branches are dropped.
		toolResult.details = { status: "ok" };
		host._restoreLateIpythonSentAgentMessages();
		expect(toolResult.details).toMatchObject({ sentAgentMessages: [lateMessage] });
		host._lateIpythonSentAgentMessages.set("ipython_other_branch", [
			{
				id: "agentmsg_other_branch",
				message: "Stale branch receipt.",
				deliveryStatus: "delivered",
				target: { activeSessionId: "other", sessionId: "other-session" },
			},
		]);
		host._restoreLateIpythonSentAgentMessages();
		expect(host._lateIpythonSentAgentMessages.has("ipython_other_branch")).toBe(false);
	});

	it("ENG-4531: preserves the custom message when direct delivery races with active work", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Original turn complete."),
			fauxAssistantMessage("Agent message handled."),
		]);
		await waitForToolStart;
		const payload: AgentSessionMessagePayload = {
			id: "agentmsg_4531",
			source: AGENT_MESSAGE_SOURCE,
			message: "Queue behind the active turn.",
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		};

		await harness.session.acceptAgentMessagePrompt(createAgentSessionMessagePrompt(payload), {
			customMessage: createAgentSessionMessage(payload),
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});

		const queued = harness.session.getSessionActionRecoverySnapshot().actions[0];
		expect(queued?.payload.kind === "turn" ? queued.payload.customMessage : undefined).toMatchObject({
			customType: "agent_message",
			details: { message: "Queue behind the active turn." },
		});
		releaseToolExecution();
		await promptPromise;
		await harness.session.agent.waitForIdle();
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "agent_message",
			),
		).toBe(true);
	});

	it("ENG-4482: orders a heartbeat after an earlier prompt with a slow input handler", async () => {
		const inputReached = createDeferred();
		const inputGate = createDeferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text !== "ordinary first") return;
						inputReached.resolve();
						await inputGate.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const providerOrder: string[] = [];
		harness.setResponses([
			(context) => {
				providerOrder.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("first done");
			},
			(context) => {
				providerOrder.push(getMessageText(context.messages.at(-1)));
				return fauxAssistantMessage("heartbeat done");
			},
		]);

		const ordinary = harness.session.prompt("ordinary first");
		await inputReached.promise;
		const heartbeat = harness.session.promptHeartbeat(heartbeatJob());
		inputGate.resolve();
		await Promise.all([ordinary, heartbeat]);
		await harness.session.waitForIdle();

		expect(providerOrder).toEqual(["ordinary first", HEARTBEAT_MARKED_PROMPT]);
	});

	it("ENG-4482: waits for a queued-work pause before admitting a streaming heartbeat", async () => {
		const started = createDeferred();
		const turnGate = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([
			async () => {
				started.resolve();
				await turnGate.promise;
				return fauxAssistantMessage("original done");
			},
			fauxAssistantMessage("heartbeat done"),
		]);

		const originalTurn = harness.session.prompt("start");
		await started.promise;
		const pause = harness.session.acquireQueuedWorkPause();
		const checkpointWaiters = (harness.session as unknown as { _sessionInputCheckpointWaiters: Set<() => void> })
			._sessionInputCheckpointWaiters;
		const admissionBlocked = createDeferred();
		const originalAdd = checkpointWaiters.add.bind(checkpointWaiters);
		const addWaiter = vi.spyOn(checkpointWaiters, "add").mockImplementation((waiter) => {
			admissionBlocked.resolve();
			return originalAdd(waiter);
		});
		const heartbeat = harness.session.promptHeartbeat(heartbeatJob(), { streamingBehavior: "followUp" });
		await admissionBlocked.promise;
		addWaiter.mockRestore();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);

		pause.release();
		await heartbeat;
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(1);
		turnGate.resolve();
		await originalTurn;
		await harness.session.waitForIdle();
		expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
	});

	it("ENG-4482: preserves next-turn context order across queued heartbeat admission", async () => {
		const started = createDeferred();
		const turnGate = createDeferred();
		const harness = await createHarness();
		harnesses.push(harness);
		let deliveredOrder: string[] = [];
		harness.setResponses([
			async () => {
				started.resolve();
				await turnGate.promise;
				return fauxAssistantMessage("original turn complete");
			},
			(context) => {
				deliveredOrder = context.messages
					.map(getMessageText)
					.filter((text) => ["context A", "context B", HEARTBEAT_MARKED_PROMPT].includes(text));
				return fauxAssistantMessage("heartbeat handled");
			},
		]);

		const originalTurn = harness.session.prompt("start");
		await started.promise;
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.unfinishedActionCount).toBe(1);
		expect(harness.session.hasPendingSessionWork).toBe(false);
		expect(shouldDeferHeartbeatCronJob(heartbeatJob(), harness.session)).toBe(false);
		await parkNextTurn(harness, "context A");
		await harness.session.promptHeartbeat(heartbeatJob(), { streamingBehavior: "followUp" });
		await parkNextTurn(harness, "context B");
		turnGate.resolve();
		await originalTurn;
		await harness.session.waitForIdle();

		expect(deliveredOrder).toEqual(["context A", "context B", HEARTBEAT_MARKED_PROMPT]);
	});

	it.each([
		{
			behavior: "followUp" as const,
			queued: (harness: Harness) => harness.session.clearQueue(),
			expected: { steering: [], followUp: [HEARTBEAT_MARKED_PROMPT] },
		},
		{
			behavior: "steer" as const,
			queued: (harness: Harness) => {
				expect(harness.session.removeQueuedFollowUp("heartbeat:heartbeat-test")).toBe(true);
				return { steering: [], followUp: [] };
			},
			expected: { steering: [], followUp: [] },
		},
	])("ENG-4482: removes a queued $behavior heartbeat prompt by queue key", async ({ behavior, queued, expected }) => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
		]);
		await waitForToolStart;
		await harness.session.promptHeartbeat(heartbeatJob(), { streamingBehavior: behavior });

		expect(harness.session.queuedActionCount).toBe(1);
		expect(queued(harness)).toEqual(expected);
		expect(harness.session.queuedActionCount).toBe(0);

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toEqual(["start"]);
	});

	it("ENG-4530: retries only undelivered input after partial scheduler delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: "restore context",
				display: true,
				details: { restored: true },
			},
			{ deliverAs: "nextTurn" },
		);
		withStreaming(harness, true);
		await harness.session.prompt("queued prompt", { streamingBehavior: "followUp" });
		withStreaming(harness, false);
		vi.spyOn(harness.session.agent, "prompt").mockImplementationOnce(async (messages) => {
			const batch = Array.isArray(messages) ? messages : [messages];
			harness.session.agent.state.messages.push(batch[0]);
			harness.session.acquireQueuedWorkPause();
			throw new Error("partial delivery failed");
		});

		harness.session.resumeQueuedWork();
		await harness.session.waitForSessionInputIdle();

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		expect(queued).toBeDefined();
		expect(queued?.payload).toMatchObject({ kind: "turn", text: "queued prompt" });
		if (!queued || queued.payload.kind !== "turn") throw new Error("Expected an undelivered turn action");
		expect(queued.payload.records.filter((record) => record.role === "prefix")).toEqual([]);
		expect(conversationMessages(harness.session)).toEqual([
			expect.objectContaining({ customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE }),
		]);
	});

	it("ENG-4530: queues restore context as a prefix record on the next queued turn", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		let providerSawRestoreContext = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("original turn complete"),
			(context) => {
				providerSawRestoreContext = context.messages.some((message) =>
					getMessageText(message).includes("These names are available again: alpha, beta."),
				);
				return fauxAssistantMessage("queued turn complete");
			},
		]);
		await waitForToolStart;
		(harness.session as unknown as StateRestoreHost)._onIpythonStateRestored({
			restored: ["alpha", "beta"],
			failed: [],
			path: "/tmp/kernel-state.dill",
		});
		await harness.session.prompt("stop the heartbeat", { streamingBehavior: "followUp" });

		const [queued] = harness.session.getSessionActionRecoverySnapshot().actions;
		const prefixMessages =
			queued?.payload.kind === "turn"
				? queued.payload.records.filter((record) => record.role === "prefix").map((record) => record.message)
				: [];
		expect(prefixMessages).toHaveLength(1);
		expect(prefixMessages[0]).toMatchObject({
			role: "custom",
			customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
			display: true,
			details: { restored: true },
		});

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();

		expect(providerSawRestoreContext).toBe(true);
		expect(getUserTexts(harness)).toEqual(["start", "stop the heartbeat"]);
	});

	it("#2068: consumes shell steering at the next tool boundary without waiting for idle", async () => {
		const started = createDeferred();
		const release = createDeferred();
		const order: string[] = [];
		let consumed = { streaming: false, completedRuns: -1, text: "" };
		const tool: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Hold the current tool until released",
			parameters: Type.Object({}),
			execute: async () => {
				order.push("tool-start");
				started.resolve();
				await release.promise;
				order.push("tool-end");
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
			(context) => {
				consumed = {
					streaming: harness.session.isStreaming,
					completedRuns: harness.eventsOfType("agent_end").length,
					text: getMessageText(context.messages.at(-1)),
				};
				order.push("shell-consumed");
				return fauxAssistantMessage("Inspected the shell result.");
			},
		]);
		const original = harness.session.prompt("Continue working.");
		try {
			await started.promise;
			await expect(completeShell(harness)).resolves.toEqual({});
			order.push("shell-queued");
			expect(order).toEqual(["tool-start", "shell-queued"]);
			expect(harness.session.getFollowUpMessages()).toEqual([]);
			expect(harness.session.getSteeringMessages()).toHaveLength(1);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toContainEqual(
				expect.objectContaining({ delivery: "next_turn_boundary" }),
			);
		} finally {
			release.resolve();
			await original;
		}
		await harness.session.waitForIdle();

		expect(order).toEqual(["tool-start", "shell-queued", "tool-end", "shell-consumed"]);
		expect(consumed).toMatchObject({ streaming: true, completedRuns: 1 });
		expect(consumed.text).toBe('[bash-done pid:42 exit:0]\n\nCommand: "npm test"');
		expect(shellMessages(harness)).toHaveLength(1);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});
	it("#2068: re-parks pending next-turn messages a withdrawn notice captured as prefixes", async () => {
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness();
		harnesses.push(harness);
		let providerSawParkedContext = false;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("Finished the original work."),
			(context) => {
				providerSawParkedContext = context.messages.some((message) => getMessageText(message) === "carry this");
				return fauxAssistantMessage("Follow-up turn complete.");
			},
		]);
		await waitForToolStart;
		// A parked next-turn message waits for the next turn; the queued notice
		// captures it as a prefix record while it waits in the steering lane.
		await parkNextTurn(harness, "carry this");
		await completeShell(harness);
		const [notice] = harness.session.getSessionActionRecoverySnapshot().actions;
		const prefixes =
			notice?.payload.kind === "turn" ? notice.payload.records.filter((record) => record.role === "prefix") : [];
		expect(prefixes.map((record) => getMessageText(record.message))).toEqual(["carry this"]);
		expect(harness.session.getSteeringMessages()).toHaveLength(1);
		// pids are reused across handles, so another command must not withdraw this notice.
		await readShellResult(harness, "other command");
		expect(harness.session.getSteeringMessages()).toHaveLength(1);
		// pid reuse can queue an identical key twice; one read withdraws one notice.
		await completeShell(harness);
		expect(harness.session.getSteeringMessages()).toHaveLength(2);
		await readShellResult(harness);
		expect(harness.session.getSteeringMessages()).toHaveLength(1);
		await readShellResult(harness);
		expect(harness.session.getSteeringMessages()).toEqual([]);
		// Withdrawing the notice hands its captured prefix records back to the next turn.
		expect(harness.session.getPendingNextTurnMessageSnapshots().map(getMessageText)).toEqual(["carry this"]);

		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();
		expect(shellMessages(harness)).toEqual([]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		await harness.session.prompt("next turn");
		await harness.session.waitForIdle();
		expect(providerSawParkedContext).toBe(true);
	});

	it("#2023: keeps extension-origin queued slash-command text out of command dispatch", async () => {
		let extensionApi: ExtensionAPI | undefined;
		const commandRuns: string[] = [];
		const { harness, waitForToolStart, promptPromise, releaseToolExecution } = await createWaitingHarness({
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("first turn complete"),
			fauxAssistantMessage("queued follow-up handled by model"),
		]);
		await waitForToolStart;

		extensionApi?.sendUserMessage("/testcmd queued", { deliverAs: "followUp" });
		releaseToolExecution();
		await promptPromise;
		await harness.session.waitForIdle();

		expect(commandRuns).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["start", "/testcmd queued"]);
		expect(getAssistantTexts(harness)).toContain("queued follow-up handled by model");
	});

	it.each([
		{
			kind: "steering",
			queue: (harness: Harness) => harness.session.steer("stop heartbeat", undefined, { resumeIfIdle: true }),
		},
		{
			kind: "follow-up",
			queue: (harness: Harness) => harness.session.followUp("continue after end", undefined, { resumeIfIdle: true }),
		},
	])("ENG-4653: starts a new turn for $kind queued from agent_end", async ({ kind, queue }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		const secondTurnStarted = createDeferred();
		harness.setResponses([
			fauxAssistantMessage("first turn complete"),
			() => {
				secondTurnStarted.resolve();
				return fauxAssistantMessage("second turn");
			},
		]);
		let queued = false;
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			await queue(harness);
		});

		await harness.session.prompt("start");
		await secondTurnStarted.promise;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.queuedActionCount).toBe(0);
		unsubscribe();

		expect(getUserTexts(harness)).toEqual(["start", kind === "steering" ? "stop heartbeat" : "continue after end"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});

	it("ENG-4653: starts a turn for an explicit steering message accepted while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const turnStarted = createDeferred();
		harness.setResponses([
			() => {
				turnStarted.resolve();
				return fauxAssistantMessage("idle steering handled");
			},
		]);

		await harness.session.steer("recover stale routing", undefined, { resumeIfIdle: true });
		await turnStarted.promise;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.queuedActionCount).toBe(0);

		expect(getUserTexts(harness)).toEqual(["recover stale routing"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});
});
