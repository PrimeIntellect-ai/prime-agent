import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { ActionStore, SessionAction } from "../src/core/session-action-store.js";
import { transitionSessionAction } from "../src/core/session-action-store.js";
import { createHarness, type Harness } from "./suite/harness.js";

type Internals = {
	_actionStore: ActionStore<SessionAction>;
	_extensionRunner: ExtensionRunner;
	_scheduleSessionInputPump(): void;
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
