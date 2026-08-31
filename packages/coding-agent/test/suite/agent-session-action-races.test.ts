import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomMessage } from "../../src/core/messages.js";
import type { ActionStore, SessionAction } from "../../src/core/session-action-store.js";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.js";
import { createDeferred } from "./scheduling.js";

type ActionKind = "turn" | "command";

interface CommitFenceInternals {
	_actionStore: ActionStore<SessionAction>;
	_pendingSessionActionFenceWaiters: number;
	_refineInFlight?: Promise<void>;
	_scheduleSessionInputPump(): void;
	_acquireDirectTurnAdmissionFence(signal?: AbortSignal): Promise<{ release(): void }>;
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
}

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

describe("AgentSession action commit-fence races", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it.each([
		...["turn", "command"].flatMap((kind) =>
			(["pause", "clear", "restart", "dispose"] as const).map((interruption) => ({
				kind: kind as ActionKind,
				interruption,
			})),
		),
	])("settles one $kind exactly once when $interruption wins the commit fence", async ({ kind, interruption }) => {
		const harness = await createHarness();
		harnesses.push(harness);
		if (kind === "turn") harness.setResponses([fauxAssistantMessage("done")]);
		const text = kind === "turn" ? "commit-fence turn" : "/autonomous status";
		const reached = createDeferred();
		const releaseFence = createDeferred();
		const internals = harness.session as unknown as CommitFenceInternals;
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
		let settlementCount = 0;
		const outcome = completion.then(
			() => {
				settlementCount++;
				return "resolved" as const;
			},
			() => {
				settlementCount++;
				return "rejected" as const;
			},
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
			expect(await outcome).toBe("resolved");
			await harness.session.waitForIdle();
			expect(deliveredCount(harness, kind, text)).toBe(1);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		} else {
			expect(await outcome).toBe("rejected");
			expect(deliveredCount(harness, kind, text)).toBe(0);
			expect(harness.session.getSessionActionRecoverySnapshot().actions).toHaveLength(0);
		}
		await Promise.resolve();
		expect(settlementCount).toBe(1);
	});

	it("reports a queued commit-fence waiter while its predecessor releases", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const heldFence = await internals._acquireSessionActionCommitFence();
		const nextFencePromise = internals._acquireSessionActionCommitFence();
		await vi.waitFor(() => expect(internals._pendingSessionActionFenceWaiters).toBe(1));

		heldFence.release();
		expect(harness.session.hasPendingAdmissionWaiters).toBe(true);

		const nextFence = await nextFencePromise;
		expect(harness.session.hasPendingAdmissionWaiters).toBe(true);
		nextFence.release();
		expect(harness.session.hasPendingAdmissionWaiters).toBe(false);
	});

	it("aborts a prompt waiting for the commit fence without leaking the fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const heldFence = await internals._acquireSessionActionCommitFence();
		const controller = new AbortController();
		const prompt = harness.session.prompt("blocked prompt", { signal: controller.signal });
		let promptSettled = false;
		let promptError: unknown;
		void prompt.then(
			() => {
				promptSettled = true;
			},
			(error: unknown) => {
				promptSettled = true;
				promptError = error;
			},
		);

		controller.abort();
		await vi.waitFor(() => {
			expect(promptSettled).toBe(true);
			expect(promptError).toMatchObject({
				name: "PromptAdmissionCancelledError",
				message: "Prompt admission was cancelled.",
			});
		});

		const nextFencePromise = internals._acquireSessionActionCommitFence();
		heldFence.release();
		const nextFence = await nextFencePromise;
		nextFence.release();
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

	it("does not restart a session command cancelled while waiting for the commit fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const schedule = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {});
		const text = "/autonomous status";
		const completion = harness.session.promptAndWait(text);
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()).toHaveLength(1));
		const heldFence = await internals._acquireSessionActionCommitFence();

		schedule.mockRestore();
		internals._scheduleSessionInputPump();
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()[0]?.lifecycle.state).toBe("selected"));
		const rejection = expect(completion).rejects.toThrow("cleared before delivery");
		expect(harness.session.clearQueue().followUp).toEqual([text]);
		heldFence.release();

		await rejection;
		await harness.session.waitForSessionInputIdle();
		expect(internals._actionStore.unfinishedActions()).toEqual([]);
	});

	it("rechecks refinement before running a command parked on the commit fence", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		const schedule = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {});
		const command = harness.session.promptAndWait("/autonomous status");
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()).toHaveLength(1));
		const heldFence = await internals._acquireSessionActionCommitFence();
		schedule.mockRestore();
		internals._scheduleSessionInputPump();
		await vi.waitFor(() => expect(internals._actionStore.unfinishedActions()[0]?.lifecycle.state).toBe("selected"));

		const refineGate = createDeferred();
		const refineInFlight = refineGate.promise.finally(() => {
			if (internals._refineInFlight === refineInFlight) internals._refineInFlight = undefined;
		});
		internals._refineInFlight = refineInFlight;
		heldFence.release();
		await yieldToEventLoop();

		expect(internals._actionStore.unfinishedActions()[0]?.lifecycle.state).toBe("selected");
		expect(harness.session.messages).toEqual([]);

		refineGate.resolve();
		await command;
		expect(internals._actionStore.unfinishedActions()).toEqual([]);
	});

	it("releases the direct-turn fence when suspension wins after acquisition", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const internals = harness.session as unknown as CommitFenceInternals;
		await harness.session.followUp("queued work");

		const admission = internals._acquireDirectTurnAdmissionFence();
		harness.session.requestAbort();
		await expect(admission).rejects.toThrow("Cannot admit a session action while queued session input is suspended.");

		let nextFence: { release(): void } | undefined;
		let nextError: unknown;
		void internals._acquireSessionActionCommitFence().then(
			(fence) => {
				nextFence = fence;
			},
			(error: unknown) => {
				nextError = error;
			},
		);
		await yieldToEventLoop();
		expect(nextError).toBeUndefined();
		expect(nextFence).toBeDefined();
		nextFence?.release();
	});

	it("preserves pause-held arrival order between injected and ordinary prompts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const internals = harness.session as unknown as CommitFenceInternals;
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
				deliveredMessages.push(...context.messages.map(getMessageText));
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

	it("cancels an ordinary prompt while queued work is paused", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const pause = harness.session.acquireQueuedWorkPause();
		const controller = new AbortController();
		const prompt = harness.session.promptUntilAccepted("cancel during pause", { signal: controller.signal });
		await yieldToEventLoop();

		controller.abort();
		await expect(prompt).rejects.toMatchObject({
			name: "PromptAdmissionCancelledError",
			message: "Prompt admission was cancelled.",
		});
		pause.release();
		expect(getUserTexts(harness)).toEqual([]);
	});

	it("admits a reentrant prompt from a navigation hook without waiting on its own pause", async () => {
		let promptFromHook: (() => Promise<void>) | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						if (!promptFromHook) throw new Error("Expected prompt hook to be initialized");
						await promptFromHook();
					});
				},
			],
		});
		harnesses.push(harness);
		promptFromHook = () => harness.session.promptUntilAccepted("prompt from navigation hook");
		harness.setResponses([
			fauxAssistantMessage("one done"),
			fauxAssistantMessage("two done"),
			fauxAssistantMessage("hook done"),
		]);
		await harness.session.prompt("one");
		const target = harness.sessionManager.getEntries().find((entry) => entry.type === "message");
		expect(target).toBeDefined();
		await harness.session.prompt("two");

		await harness.session.navigateTree(target!.id, { summarize: false });
		await harness.session.waitForIdle();
		expect(getUserTexts(harness)).toContain("prompt from navigation hook");
	});
});
