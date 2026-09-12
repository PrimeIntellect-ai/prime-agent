import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { ActionStore, transitionSessionAction } from "../../src/core/session-action-store.js";
import { SessionInputDispatcher, type SessionInputDispatcherHost } from "../../src/session/input-dispatcher.js";
import {
	createDeliveryRecord,
	createPreparedTurnAction,
	DeferredSessionInputError,
	primaryDeliveryRecord,
	type QueuedSessionAction,
} from "../../src/session/prepared-actions.js";
import { createTurnExecutionPolicy } from "../../src/session/turn-preparation.js";

function createFixture() {
	const actions = new ActionStore<QueuedSessionAction>();
	const state = { epoch: 0, busy: false, transcript: [] as AgentMessage[] };
	const host = {
		isDisposed: () => false,
		getEpoch: () => state.epoch,
		getActivity: () => ({
			lowerAgentRun: false,
			compaction: false,
			retry: false,
			bash: state.busy,
			refinementApply: false,
			branchMutation: false,
			schedulerPauseCount: 0,
			disposing: false,
		}),
		isBusy: () => state.busy,
		isHandoffDeferred: (epoch: number) => epoch !== state.epoch || state.busy,
		getDeliveryMode: () => "all" as const,
		waitForAgentIdle: vi.fn(async () => {}),
		hasCancelledDispatchCapture: () => false,
		getEventQueue: () => Promise.resolve(),
		waitForRefinement: vi.fn(async () => {}),
		getTranscript: () => state.transcript,
		startTurns: vi.fn(async (batch: QueuedSessionAction[], _epoch: number) => {
			for (const action of batch) {
				transitionSessionAction(action, { state: "committing" });
				state.transcript.push(primaryDeliveryRecord(action).message);
				actions.ticketFor(action).settleDelivered({ status: "delivered" });
			}
		}),
		executeCommand: vi.fn(async () => {}),
		settleAgentMessage: vi.fn(),
		releaseTurn: vi.fn(),
		notifyCheckpoints: vi.fn(),
		emitQueueUpdate: vi.fn(),
		surfaceError: vi.fn(),
		schedule: vi.fn(),
	} satisfies SessionInputDispatcherHost;
	const dispatcher = new SessionInputDispatcher(actions, host);
	const enqueue = (text: string, options: Parameters<typeof createPreparedTurnAction>[3] = {}) => {
		const action = createPreparedTurnAction("followUp", text, undefined, options);
		actions.enqueue(action);
		return action;
	};
	return { actions, state, host, dispatcher, enqueue };
}

describe("session input dispatch", () => {
	it("batches only adjacent turns with matching execution policies", async () => {
		const { enqueue, dispatcher, host, actions } = createFixture();
		const first = enqueue("first");
		const second = enqueue("second");
		const direct = enqueue("direct", { executionPolicy: createTurnExecutionPolicy("directPrompt") });
		const last = enqueue("last");
		const completions = [first, second, direct, last].map((action) => actions.ticketFor(action).ticket.completed);

		await dispatcher.run(0);
		await Promise.all(completions);

		expect(host.startTurns.mock.calls.map(([batch]) => batch.map((action) => action.payload.text))).toEqual([
			["first", "second"],
			["direct"],
			["last"],
		]);
		expect(actions.ownedActions()).toEqual([]);
	});

	it("dispatches a preselected turn separately even in all mode", async () => {
		const { enqueue, dispatcher, host, actions } = createFixture();
		const first = enqueue("already selected");
		actions.selectFirst();
		const second = enqueue("queued later");

		await dispatcher.run(0);

		expect(host.startTurns.mock.calls.map(([batch]) => batch)).toEqual([[first], [second]]);
	});

	it("rolls selection back when the epoch changes while waiting for the agent", async () => {
		const { enqueue, dispatcher, host, actions, state } = createFixture();
		const action = enqueue("selected before pause");
		actions.selectFirst();
		let release = () => {};
		host.waitForAgentIdle.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);

		const dispatch = dispatcher.run(0);
		state.epoch++;
		release();
		await dispatch;

		expect(action.lifecycle.state).toBe("queued");
		expect(host.startTurns).not.toHaveBeenCalled();
		expect(host.notifyCheckpoints).toHaveBeenCalledOnce();
		expect(host.emitQueueUpdate).toHaveBeenCalledOnce();
		expect(host.schedule).not.toHaveBeenCalled();
	});

	it("requeues an undelivered primary without replaying its durable prefix", async () => {
		const { enqueue, dispatcher, host, actions, state } = createFixture();
		const prefix = {
			role: "custom" as const,
			customType: "prefix",
			content: "context",
			display: false,
			timestamp: 1,
		};
		const action = enqueue("retry delivery", { prefixMessages: [prefix] });
		if (action.payload.kind !== "turn") throw new Error("Expected turn");
		const durablePrefix = action.payload.records[0].message;
		const nextTurn = createDeliveryRecord(action.id, "next_turn", { ...prefix, customType: "next-turn" });
		action.payload.records.splice(1, 0, nextTurn);
		host.startTurns.mockImplementationOnce(async () => {
			transitionSessionAction(action, { state: "committing" });
			state.transcript.push(durablePrefix);
			state.epoch++;
			throw new DeferredSessionInputError("paused at handoff");
		});
		const completed = actions.ticketFor(action).ticket.completed;

		await dispatcher.run(0);

		expect(action.lifecycle.state).toBe("queued");
		expect(action.payload.records.map((record) => record.role)).toEqual(["primary"]);
		expect(host.releaseTurn).not.toHaveBeenCalled();
		expect(host.surfaceError).not.toHaveBeenCalled();
		expect(host.schedule).not.toHaveBeenCalled();

		await dispatcher.run(state.epoch);
		await completed;
		expect(state.transcript.filter((message) => message === durablePrefix)).toHaveLength(1);
		expect(state.transcript.filter((message) => message === primaryDeliveryRecord(action).message)).toHaveLength(1);
	});

	it("preserves completed delivery while rejecting completion after a partial batch failure", async () => {
		const { enqueue, dispatcher, host, actions, state } = createFixture();
		const first = enqueue("delivered", { agentMessageId: "first" });
		const second = enqueue("not delivered", { agentMessageId: "second" });
		const firstTicket = actions.ticketFor(first).ticket;
		const secondTicket = actions.ticketFor(second).ticket;
		const failure = new Error("dispatch failed");
		host.startTurns.mockImplementationOnce(async (batch) => {
			for (const action of batch) transitionSessionAction(action, { state: "committing" });
			state.transcript.push(primaryDeliveryRecord(first).message);
			actions.ticketFor(first).settleDelivered({ status: "delivered" });
			throw failure;
		});

		await dispatcher.run(0);

		await expect(firstTicket.delivered).resolves.toEqual({ status: "delivered" });
		await expect(secondTicket.delivered).rejects.toBe(failure);
		await expect(firstTicket.completed).rejects.toBe(failure);
		await expect(secondTicket.completed).rejects.toBe(failure);
		expect(host.settleAgentMessage.mock.calls).toEqual([
			["first", "completion", failure],
			["second", "delivery", failure],
			["second", "completion", failure],
		]);
		expect(host.surfaceError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(actions.ownedActions()).toEqual([]);
	});

	it.each([false, true])(
		"retains cancelled work only when capturing late dispatch messages: %s",
		async (capturing) => {
			const { enqueue, dispatcher, host, actions } = createFixture();
			const action = enqueue("cancelled");
			host.startTurns.mockImplementationOnce(async () => {
				if (action.payload.kind !== "turn") throw new Error("Expected turn");
				if (capturing) action.payload.captureRunMessages = new Set();
				transitionSessionAction(action, { state: "cancelled" });
			});

			await dispatcher.run(0);

			expect(actions.ownedActions()).toEqual(capturing ? [action] : []);
			expect(host.releaseTurn.mock.calls).toEqual(capturing ? [] : [[action.id]]);
		},
	);

	it("surfaces a preparation error once and preserves queued work when runtime becomes busy", async () => {
		const { enqueue, dispatcher, host, state } = createFixture();
		const action = enqueue("deferred by shell");
		const failure = new Error("preparation failed while busy");
		host.startTurns.mockImplementationOnce(async () => {
			state.busy = true;
			throw failure;
		});

		await dispatcher.run(0);

		expect(action.lifecycle.state).toBe("queued");
		expect(host.surfaceError).toHaveBeenCalledExactlyOnceWith(failure);
		expect(host.schedule).not.toHaveBeenCalled();
		expect(host.releaseTurn).not.toHaveBeenCalled();
	});
});
