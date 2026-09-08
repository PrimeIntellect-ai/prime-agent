import { describe, expect, it } from "vitest";
import type { TelemetryInputMetadata, TelemetryInputObservation } from "../src/core/telemetry-input.js";
import { TelemetryInputTracker } from "../src/core/telemetry-input-tracker.js";
import type { TelemetryProperties } from "../src/core/telemetry-schema.js";

const input: TelemetryInputMetadata = { inputId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
function setup() {
	const events: Array<{ name: string; properties: TelemetryProperties }> = [];
	const errors: unknown[] = [];
	const tracker = new TelemetryInputTracker({
		capture: (name, properties) => events.push({ name, properties }),
		onError: (error) => errors.push(error),
	});
	const action = (state: NonNullable<TelemetryInputObservation["action"]>["state"], at: number, metadata = input) =>
		tracker.observe({
			type: "action",
			input: metadata,
			at,
			action: { id: "local-only", kind: "turn", state, delivery: "when_run_idle", queueVisible: true },
		});
	return { tracker, events, errors, action };
}

describe("worker input timing", () => {
	it("associates coalesced inputs with one run while retaining the first primary input", () => {
		const { tracker, action, events } = setup();
		const second = { inputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
		action("committing", 10);
		action("committing", 20, second);
		expect(tracker.attachRun("coalesced-run", 30)?.metadata.inputId).toBe(input.inputId);
		const timings = events.filter((event) => event.properties.stage === "input_to_run");
		expect(timings.map((event) => [event.properties.input_id, event.properties.duration_ms])).toEqual([
			[input.inputId, 20],
			[second.inputId, 10],
		]);
		expect(timings.every((event) => event.properties.run_id === "coalesced-run")).toBe(true);
		expect(tracker.attachRun("later-run", 40)).toBeUndefined();
	});
	it("separates queue and preparation intervals and does not finish an early-returned queued prompt", () => {
		const { tracker, action, events } = setup();
		tracker.observe({ type: "received", input, at: 100 });
		action("queued", 100);
		tracker.observe({ type: "settled", input, at: 101 });
		expect(events.some((event) => event.properties.stage === "terminal")).toBe(false);
		action("selected", 150);
		action("preparing", 160);
		action("committing", 175);
		const run = tracker.attachRun("run-id", 180);
		action("running", 181);
		action("completed", 200);
		expect(run).toMatchObject({ queueWaitMs: 50, preparationMs: 25, inputToRunMs: 80, runId: "run-id" });
		expect(
			events
				.filter((event) => event.name === "agent timing")
				.map((event) => [event.properties.stage, event.properties.duration_ms]),
		).toEqual([
			["queue_wait", 50],
			["local_preparation", 25],
			["input_to_run", 80],
		]);
		expect(tracker.attachRun("unrelated-run", 250)).toBeUndefined();
		expect(JSON.stringify(events)).not.toContain("local-only");
	});
	it("accumulates disjoint preparation and queue intervals after rollback", () => {
		const { tracker, action } = setup();
		action("queued", 0);
		action("selected", 10);
		action("queued", 20);
		action("preparing", 40);
		action("committing", 60);
		expect(tracker.attachRun("run-id", 65)).toMatchObject({ queueWaitMs: 30, preparationMs: 30, inputToRunMs: 65 });
	});
	it("records cancellation once without creating a run", () => {
		const { tracker, action, events } = setup();
		action("queued", 0);
		action("cancelled", 20);
		tracker.observe({ type: "settled", input, at: 21 });
		action("cancelled", 22);
		expect(events.filter((event) => event.properties.stage === "terminal")).toEqual([
			expect.objectContaining({ properties: expect.objectContaining({ outcome: "cancelled", duration_ms: 20 }) }),
		]);
		expect(tracker.attachRun("run-id", 25)).toBeUndefined();
	});
	it("captures admission failures before an action exists and no-run commands separately", () => {
		const { tracker, events, errors } = setup();
		const error = new Error("No model configured");
		tracker.observe({ type: "received", input, at: 10 });
		tracker.observe({ type: "settled", input, at: 25, error });
		expect(errors).toEqual([error]);
		expect(events.at(-1)?.properties).toMatchObject({
			stage: "time_to_error",
			timing_origin: "worker_action",
			duration_ms: 15,
		});
		const other = { inputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
		tracker.observe({ type: "received", input: other, at: 30 });
		tracker.observe({ type: "settled", input: other, at: 31 });
		expect(events.at(-1)?.properties).toMatchObject({ outcome: "no_run" });
	});
	it("does not attach an unrelated queued input or retain associations across opt-out", () => {
		const { tracker, action } = setup();
		action("committing", 0);
		action("queued", 1, { inputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
		expect(tracker.attachRun("run-id", 5)?.metadata.inputId).toBe(input.inputId);
		expect(tracker.attachRun("second-run", 6)).toBeUndefined();
		action("committing", 10, { inputId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
		tracker.clear();
		expect(tracker.attachRun("after-opt-out", 11)).toBeUndefined();
	});
});
