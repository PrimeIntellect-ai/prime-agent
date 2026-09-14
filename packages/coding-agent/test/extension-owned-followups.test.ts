import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ActionStore, SessionAction } from "../src/core/session-action-store.js";
import { transitionSessionAction } from "../src/core/session-action-store.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";
import { withStreaming } from "./suite/scheduling.js";

type Internals = {
	_actionStore: ActionStore<SessionAction>;
	_extensionRunner: ExtensionRunner;
	_scheduleSessionInputPump(): void;
	_emitQueueUpdate(): void;
};

function setupApis(count = 1) {
	const apis: ExtensionAPI[] = [];
	return {
		apis,
		factories: Array.from({ length: count }, () => (pi: ExtensionAPI) => {
			apis.push(pi);
		}),
	};
}

function setActionState(action: SessionAction, state: "queued" | "selected" | "preparing" | "committing"): void {
	if (action.lifecycle.state === "selected" && state === "queued")
		transitionSessionAction(action, { state: "queued" });
	if (action.lifecycle.state === "queued" && state !== "queued")
		transitionSessionAction(action, { state: "selected" });
	if (action.lifecycle.state === "selected" && (state === "preparing" || state === "committing"))
		transitionSessionAction(action, { state: "preparing" });
	if (action.lifecycle.state === "preparing" && state === "committing")
		transitionSessionAction(action, { state: "committing" });
}

function holdPump(harness: Harness): { internals: Internals; restore(): void } {
	const internals = harness.session as unknown as Internals;
	const spy = vi.spyOn(internals, "_scheduleSessionInputPump").mockImplementation(() => {});
	return { internals, restore: () => spy.mockRestore() };
}

describe("extension-owned keyed follow-ups", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("coalesces per owner and cannot cancel another extension or user follow-up", async () => {
		const setup = setupApis(2);
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const first = await setup.apis[0]!.queueFollowUp("same", "owner one");
		expect(await setup.apis[0]!.queueFollowUp("same", "replacement")).toEqual({
			actionId: first.actionId,
			disposition: "coalesced",
		});
		await setup.apis[1]!.queueFollowUp("same", "owner two");
		await harness.session.followUp("user", undefined, { queueKey: "same" });
		expect(setup.apis[0]!.cancelFollowUp("same")).toBe(true);
		expect(harness.session.getFollowUpMessages()).toEqual(["owner two", "user"]);
		held.restore();
		harness.session.clearQueue();
	});

	it("does not let a coalesced caller's signal cancel the existing admission", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const first = await setup.apis[0]!.queueFollowUp("goal", "original");
		const controller = new AbortController();
		expect(await setup.apis[0]!.queueFollowUp("goal", "duplicate", { signal: controller.signal })).toEqual({
			actionId: first.actionId,
			disposition: "coalesced",
		});
		controller.abort();
		expect(held.internals._actionStore.unfinishedActions().map((action) => action.payload.text)).toEqual([
			"original",
		]);
		held.restore();
		harness.session.clearQueue();
	});

	it("rejects abort before admission and cancels abort after admission", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const stale = new AbortController();
		stale.abort();
		await expect(setup.apis[0]!.queueFollowUp("stale", "never", { signal: stale.signal })).rejects.toMatchObject({
			name: "PromptAdmissionCancelledError",
		});
		const live = new AbortController();
		await setup.apis[0]!.queueFollowUp("live", "cancel me", { signal: live.signal });
		live.abort();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		held.restore();
	});

	it("settles cancelled tickets without an unhandled rejection", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listener);
		try {
			const controller = new AbortController();
			await setup.apis[0]!.queueFollowUp("goal", "continue", { signal: controller.signal });
			controller.abort();
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
			held.restore();
		}
	});

	it("removes its abort listener when a cancelled ticket settles", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		await setup.apis[0]!.queueFollowUp("goal", "continue", { signal: controller.signal });
		expect(setup.apis[0]!.cancelFollowUp("goal")).toBe(true);
		await vi.waitFor(() => expect(remove).toHaveBeenCalledWith("abort", expect.any(Function)));
		held.restore();
	});

	it("abort during preparation cancels the not-started action", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		const controller = new AbortController();
		await setup.apis[0]!.queueFollowUp("goal", "continue", { signal: controller.signal });
		const action = held.internals._actionStore.unfinishedActions()[0]!;
		setActionState(action, "preparing");
		controller.abort();
		expect(action.lifecycle.state).toBe("cancelled");
		held.restore();
	});

	it.each(["queued", "selected", "preparing", "committing"] as const)(
		"cancels a not-started %s action",
		async (state) => {
			const setup = setupApis();
			const harness = await createHarness({ extensionFactories: setup.factories });
			harnesses.push(harness);
			const held = holdPump(harness);
			await setup.apis[0]!.queueFollowUp("goal", "continue");
			const action = held.internals._actionStore.unfinishedActions()[0]!;
			setActionState(action, state);
			expect(setup.apis[0]!.cancelFollowUp("goal")).toBe(true);
			expect(action.lifecycle.state).toBe("cancelled");
			held.restore();
		},
	);

	it("marks an entire handed-off batch started before publishing committing", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		harness.session.setFollowUpMode("all");
		harness.setResponses([fauxAssistantMessage("done")]);
		const held = holdPump(harness);
		withStreaming(harness, true);
		await setup.apis[0]!.queueFollowUp("one", "first");
		await setup.apis[0]!.queueFollowUp("two", "second");
		withStreaming(harness, false);
		let cancellationAtHandoff: boolean | undefined;
		const emit = held.internals._emitQueueUpdate.bind(held.internals);
		vi.spyOn(held.internals, "_emitQueueUpdate").mockImplementation(() => {
			const actions = held.internals._actionStore.unfinishedActions();
			if (
				cancellationAtHandoff === undefined &&
				actions.length === 2 &&
				actions.every((action) => action.lifecycle.state === "committing")
			) {
				cancellationAtHandoff = setup.apis[0]!.cancelFollowUp("two");
			}
			emit();
		});
		held.restore();
		held.internals._scheduleSessionInputPump();
		await harness.session.waitForIdle();
		expect(cancellationAtHandoff).toBe(false);
		expect(getUserTexts(harness)).toEqual(["first", "second"]);
	});

	it.each(["committing", "running"] as const)("cannot cancel a started %s action", async (state) => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		await setup.apis[0]!.queueFollowUp("goal", "continue");
		const action = held.internals._actionStore.unfinishedActions()[0]!;
		setActionState(action, "committing");
		if (action.payload.kind === "turn") action.payload.records[0]!.started = true;
		if (state === "running") transitionSessionAction(action, { state: "running", execution: "agent_turn" });
		expect(setup.apis[0]!.cancelFollowUp("goal")).toBe(false);
		expect(action.lifecycle.state).toBe(state);
		held.restore();
	});

	it("session disposal cancels extension-owned pending work", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		await setup.apis[0]!.queueFollowUp("goal", "continue");
		harness.session.dispose();
		expect(held.internals._actionStore.unfinishedActions()).toEqual([]);
		held.restore();
	});

	it("runner invalidation cancels extension-owned pending work", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		await setup.apis[0]!.queueFollowUp("goal", "continue");
		held.internals._extensionRunner.invalidate();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		held.restore();
	});

	it("reload disposes the old extension and cancels its pending work", async () => {
		const setup = setupApis();
		const harness = await createHarness({ extensionFactories: setup.factories });
		harnesses.push(harness);
		const held = holdPump(harness);
		await setup.apis[0]!.queueFollowUp("goal", "continue");
		await harness.session.reload();
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		held.restore();
	});

	it("recovery snapshot excludes owner and restored action is not cancellable by extension", async () => {
		const sourceSetup = setupApis();
		const source = await createHarness({ extensionFactories: sourceSetup.factories });
		harnesses.push(source);
		const heldSource = holdPump(source);
		await sourceSetup.apis[0]!.queueFollowUp("goal", "continue");
		setActionState(heldSource.internals._actionStore.unfinishedActions()[0]!, "queued");
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		expect(snapshot.actions[0]).not.toHaveProperty("extensionOwner");

		const targetSetup = setupApis();
		const target = await createHarness({ extensionFactories: targetSetup.factories });
		harnesses.push(target);
		const heldTarget = holdPump(target);
		await target.session.restoreSessionActions(snapshot);
		expect(targetSetup.apis[0]!.cancelFollowUp("goal")).toBe(false);
		expect(target.session.getFollowUpMessages()).toEqual(["continue"]);
		heldSource.restore();
		heldTarget.restore();
		source.session.clearQueue();
		target.session.clearQueue();
	});
});
