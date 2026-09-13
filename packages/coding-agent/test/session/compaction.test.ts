import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.js";
import { SessionCompaction, type SessionCompactionHost } from "../../src/session/compaction.js";
import { CompactionSkippedError } from "../../src/session/compaction-execution.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

const providers: ReturnType<typeof registerFauxProvider>[] = [];

function setup() {
	const provider = registerFauxProvider();
	providers.push(provider);
	const store = SessionManager.inMemory();
	const messages: AgentMessage[] = [];
	const order: string[] = [];
	const result = { summary: "summary", firstKeptEntryId: "kept", tokensBefore: 1000 };
	const host = {
		getSettings: vi.fn(() => ({ enabled: false, reserveTokens: 100, keepRecentTokens: 10 })),
		runAutomatic: vi.fn<SessionCompactionHost["runAutomatic"]>(async () => false),
		queueGoalContinuation: vi.fn(() => false),
		queueAutonomousContinuation: vi.fn<SessionCompactionHost["queueAutonomousContinuation"]>(async () => undefined),
		beginRefinementAbort: vi.fn<SessionCompactionHost["beginRefinementAbort"]>(() => undefined),
		getModel: vi.fn<SessionCompactionHost["getModel"]>(() => provider.getModel()),
		isStreaming: vi.fn(() => false),
		getRequiredAuth: vi.fn<SessionCompactionHost["getRequiredAuth"]>(async () => ({ apiKey: "faux" })),
		getAuth: vi.fn<SessionCompactionHost["getAuth"]>(async () => ({ ok: true, apiKey: "faux" })),
		perform: vi.fn<SessionCompactionHost["perform"]>(async () => result),
		disconnect: vi.fn(() => {
			order.push("disconnect");
		}),
		reconnect: vi.fn(() => {
			order.push("reconnect");
		}),
		abortSession: vi.fn(async () => {
			order.push("abort");
		}),
		getContinuationState: vi.fn(() => ({ scheduled: true, continueAfterSessionInput: true })),
		afterManualCompaction: vi.fn<SessionCompactionHost["afterManualCompaction"]>(() => {
			order.push("resume");
		}),
		getMessages: () => messages,
		replaceMessages: vi.fn<SessionCompactionHost["replaceMessages"]>(),
		hasAgentQueuedMessages: vi.fn(() => false),
		hasPendingSessionWork: vi.fn(() => false),
		scheduleContinuation: vi.fn<SessionCompactionHost["scheduleContinuation"]>(),
		scheduleRefinement: vi.fn<SessionCompactionHost["scheduleRefinement"]>(),
		takeThresholdAutonomousMessages: vi.fn(() => []),
		getThresholdGoalContinuation: vi.fn<SessionCompactionHost["getThresholdGoalContinuation"]>(() => undefined),
		clearAutonomousContinuations: vi.fn<SessionCompactionHost["clearAutonomousContinuations"]>(),
		clearGoalContinuation: vi.fn<SessionCompactionHost["clearGoalContinuation"]>(),
		getSessionStore: () => store,
		retainUnpersistedOutcome: vi.fn<SessionCompactionHost["retainUnpersistedOutcome"]>(),
		emit: vi.fn<SessionCompactionHost["emit"]>((event) => {
			order.push(event.type);
		}),
		notifyCheckpoints: vi.fn(() => {
			order.push("checkpoint");
		}),
		scheduleInput: vi.fn(() => {
			order.push("input");
		}),
	} satisfies SessionCompactionHost;
	return { compaction: new SessionCompaction(host), host, order, result, provider };
}

afterEach(() => {
	while (providers.length) providers.pop()?.unregister();
	vi.restoreAllMocks();
});

describe("SessionCompaction boundaries", () => {
	it("waits for abort before starting, then reconnects and releases waiters before resuming", async () => {
		const { compaction, host, order, result } = setup();
		const aborted = deferred<void>();
		const performed = deferred<typeof result>();
		host.abortSession.mockReturnValue(aborted.promise);
		host.perform.mockReturnValue(performed.promise);
		compaction.request("pending instructions");
		const pending = compaction.compact("manual instructions");
		expect(compaction.operation).toBeUndefined();
		expect(host.emit).not.toHaveBeenCalled();
		aborted.resolve();
		await Promise.resolve();
		const operation = compaction.operation;
		expect(operation).toBeInstanceOf(Promise);
		expect(compaction.isRunning).toBe(true);
		await Promise.resolve();
		host.afterManualCompaction.mockImplementation((signal, scheduled, continueAfterInput) => {
			expect(compaction.operation).toBeUndefined();
			expect(compaction.isRunning).toBe(false);
			expect([signal.aborted, scheduled, continueAfterInput]).toEqual([false, true, true]);
			order.push("resume");
		});
		performed.resolve(result);
		expect(await pending).toBe(result);
		await operation;
		expect(compaction.hasPendingRequest).toBe(false);
		expect(order).toEqual([
			"disconnect",
			"compaction_start",
			"compaction_end",
			"reconnect",
			"checkpoint",
			"input",
			"resume",
		]);
	});

	it.each([new CompactionSkippedError("too short"), new Error("write failed")])(
		"retains a pending request and releases manual waiters after %s",
		async (error) => {
			const { compaction, host } = setup();
			compaction.request();
			host.perform.mockRejectedValue(error);
			const pending = compaction.compact(undefined, { skipAbort: true });
			const operation = compaction.operation;
			await expect(pending).rejects.toBe(error);
			await operation;
			expect(compaction.operation).toBeUndefined();
			expect(compaction.hasPendingRequest).toBe(true);
			expect(host.reconnect).toHaveBeenCalledOnce();
			expect(host.afterManualCompaction).not.toHaveBeenCalled();
		},
	);

	it("consumes requests before automatic start and reads the current model after authentication", async () => {
		const { compaction, host, provider } = setup();
		const authentication = deferred<Awaited<ReturnType<SessionCompactionHost["getAuth"]>>>();
		host.getAuth.mockReturnValue(authentication.promise);
		host.emit.mockImplementation((event) => {
			if (event.type !== "compaction_start") return;
			expect(compaction.hasPendingRequest).toBe(false);
			expect(compaction.isRunning).toBe(false);
			expect(event.customInstructions).toBe("keep decisions");
		});
		compaction.request("keep decisions");
		const pending = compaction.runAutomatic("requested", false);
		const nextModel = { ...provider.getModel(), id: "next-model" };
		host.getModel.mockReturnValue(nextModel);
		authentication.resolve({ ok: true, apiKey: "faux", headers: { "x-test": "auth" } });
		await pending;
		expect(host.perform).toHaveBeenCalledWith(
			expect.objectContaining({
				model: nextModel,
				apiKey: "faux",
				headers: { "x-test": "auth" },
				customInstructions: "keep decisions",
			}),
		);
	});

	it.each(["threshold", "requested", "overflow"] as const)(
		"handles queued work after %s failure without repeating an overflowing request",
		async (reason) => {
			const { compaction, host } = setup();
			host.hasPendingSessionWork.mockReturnValue(true);
			host.perform.mockRejectedValue(new Error("summary failed"));
			await compaction.runAutomatic(reason, reason === "overflow");
			expect(host.scheduleContinuation).toHaveBeenCalledTimes(reason === "overflow" ? 0 : 1);
			expect(host.emit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "compaction_end", reason, willRetry: false }),
			);
			expect(compaction.operation).toBeUndefined();
		},
	);

	it("cancels active automatic work and withdraws its goal continuation without resuming", async () => {
		const { compaction, host } = setup();
		const entered = deferred<AbortSignal>();
		const goalMessage = fauxAssistantMessage("queued goal");
		host.getThresholdGoalContinuation.mockReturnValue(goalMessage);
		host.perform.mockImplementation(
			({ signal }) =>
				new Promise((_resolve, reject) => {
					entered.resolve(signal);
					signal.addEventListener("abort", () => reject(new Error("Compaction cancelled")), { once: true });
				}),
		);
		compaction.requestContinuation();
		const pending = compaction.runAutomatic("threshold", false);
		const signal = await entered.promise;
		compaction.abortAutomatic();
		expect(signal.aborted).toBe(true);
		await pending;
		expect(host.clearGoalContinuation).toHaveBeenCalledExactlyOnceWith(goalMessage);
		expect(host.scheduleContinuation).not.toHaveBeenCalled();
		expect(host.emit).toHaveBeenCalledWith(
			expect.objectContaining({ type: "compaction_end", aborted: true, errorMessage: undefined }),
		);
		expect(compaction.isRunning).toBe(false);
	});

	it("keeps the newer operation visible when an older manual compaction settles", async () => {
		const { compaction, host, result } = setup();
		const first = deferred<typeof result>();
		const second = deferred<typeof result>();
		host.perform.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const firstRun = compaction.compact(undefined, { skipAbort: true });
		await Promise.resolve();
		const secondRun = compaction.compact(undefined, { skipAbort: true });
		await Promise.resolve();
		const operation = compaction.operation;
		first.resolve(result);
		await firstRun;
		expect(compaction.operation).toBe(operation);
		second.resolve(result);
		await secondRun;
		await operation;
		expect(compaction.operation).toBeUndefined();
	});

	it("does not add an await to aborted-turn checks when no refinement plan needs cleanup", async () => {
		const { compaction, host } = setup();
		compaction.request();
		const pending = compaction.check(fauxAssistantMessage("", { stopReason: "aborted" }), false);
		expect(compaction.hasPendingRequest).toBe(false);
		expect(host.getSettings).toHaveBeenCalledOnce();
		await pending;
	});

	it("waits for an aborted refinement plan before proceeding with pre-prompt checks", async () => {
		const { compaction, host } = setup();
		const plan = deferred<void>();
		const finish = vi.fn();
		host.beginRefinementAbort.mockReturnValue({ promise: plan.promise, finish });
		const pending = compaction.check(fauxAssistantMessage("", { stopReason: "aborted" }), false);
		expect(host.getSettings).not.toHaveBeenCalled();
		plan.reject(new Error("plan aborted"));
		await pending;
		expect(finish).toHaveBeenCalledOnce();
		expect(host.getSettings).toHaveBeenCalledOnce();
	});
});
