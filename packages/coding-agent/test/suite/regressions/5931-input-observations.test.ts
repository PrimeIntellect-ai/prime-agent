import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryProperties } from "../../../src/core/telemetry.js";
import {
	clearTelemetryInputs,
	subscribeTelemetryInputs,
	type TelemetryInputObservation,
} from "../../../src/core/telemetry-input.js";
import { TelemetryJourneys } from "../../../src/core/telemetry-journeys.js";
import { createHarness, getUserTexts, type Harness } from "../harness.js";

const FIRST = "10000000-0000-4000-8000-000000000001";
const SECOND = "10000000-0000-4000-8000-000000000002";
const CLIENT = "10000000-0000-4000-8000-000000000003";

describe("ENG-5931 actual session input observation", () => {
	const harnesses: Harness[] = [];
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) cleanup();
		vi.unstubAllEnvs();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	async function observedSession(withConfiguredAuth = true) {
		const harness = await createHarness({ withConfiguredAuth });
		harnesses.push(harness);
		const observations: TelemetryInputObservation[] = [];
		let clock = 10;
		let enabled = true;
		cleanups.push(
			subscribeTelemetryInputs(harness.session, (observation) => observations.push(observation), {
				isEnabled: () => enabled,
				now: () => ++clock,
			}),
		);
		return {
			harness,
			observations,
			disable: () => {
				enabled = false;
				clearTelemetryInputs(harness.session);
			},
			enable: () => {
				enabled = true;
			},
		};
	}

	it("separates queued acceptance from delivery and sees cancellation without a provider call", async () => {
		const { harness, observations } = await observedSession();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				await held;
				return fauxAssistantMessage("finished");
			},
		]);
		const first = harness.session.prompt("private first prompt", {
			telemetryInput: { inputId: FIRST, clientSessionId: CLIENT },
		});
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		await harness.session.prompt("private queued prompt", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			telemetryInput: {
				inputId: SECOND,
				clientSessionId: CLIENT,
				recoveryAction: "credentials_updated",
				setupContext: {
					providerCategory: "prime",
					modelCategory: "gpt",
					authSource: "prime_cli",
					teamScope: "personal",
					endpointCategory: "default",
				},
				uiContext: {
					providerCategory: "prime",
					modelCategory: "gpt",
					authSource: "environment",
					teamScope: "team",
					endpointCategory: "custom",
				},
			},
		});
		const queued = observations.filter((observation) => observation.input.inputId === SECOND);
		expect(queued.map((observation) => observation.action?.state ?? observation.type)).toEqual([
			"received",
			"queued",
			"settled",
		]);
		expect(queued[1]?.input).toMatchObject({
			recoveryAction: "credentials_updated",
			setupContext: { teamScope: "personal" },
			uiContext: { authSource: "environment" },
		});
		harness.session.clearQueue();
		expect(observations.at(-1)).toMatchObject({
			input: { inputId: SECOND },
			action: { state: "cancelled", previousState: "queued" },
		});
		release();
		await first;
		expect(harness.faux.state.callCount).toBe(1);
		expect(getUserTexts(harness)).toEqual(["private first prompt"]);
		expect(
			observations
				.filter((observation) => observation.input.inputId === FIRST && observation.action)
				.map((observation) => observation.action?.state),
		).toEqual(["queued", "selected", "preparing", "committing", "running", "completed"]);
		expect(JSON.stringify(observations)).not.toContain("private");
	});

	it("observes a failure before inference and preserves the original rejection", async () => {
		const { harness, observations } = await observedSession(false);
		await expect(
			harness.session.prompt("private rejected prompt", { telemetryInput: { inputId: FIRST } }),
		).rejects.toThrow();
		expect(harness.faux.state.callCount).toBe(0);
		expect(observations[0]).toMatchObject({ type: "received", input: { inputId: FIRST } });
		expect(observations.at(-1)).toMatchObject({
			type: "settled",
			input: { inputId: FIRST },
			error: expect.any(Error),
		});
		expect(observations.some((observation) => observation.action?.state === "committing")).toBe(false);
	});

	it("does not emit late lifecycle data after opt-out and re-enable", async () => {
		const { harness, observations, disable, enable } = await observedSession();
		let release = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.setResponses([
			async () => {
				await held;
				return fauxAssistantMessage("finished");
			},
		]);
		const first = harness.session.prompt("before opt out", { telemetryInput: { inputId: FIRST } });
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(1));
		disable();
		await harness.session.prompt("while opted out", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			telemetryInput: { inputId: SECOND },
		});
		const count = observations.length;
		enable();
		harness.session.clearQueue();
		release();
		await first;
		expect(observations).toHaveLength(count);
		expect(harness.faux.state.callCount).toBe(1);
	});
	it.each(["frame", "admission"])(
		"keeps UI timing accurate when %s arrives first and honors opt-out",
		async (first) => {
			vi.stubEnv("PI_OFFLINE", "0");
			vi.stubEnv("DO_NOT_TRACK", "0");
			vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
			const harness = await createHarness();
			harnesses.push(harness);
			const { settingsManager } = harness;
			const events: TelemetryProperties[] = [];
			let now = 100;
			const journeys = new TelemetryJourneys({
				agentDir: harness.tempDir,
				settingsManager,
				now: () => now,
				sink: { capture: (_name, properties) => events.push(properties), flush: async () => {} },
			});
			cleanups.push(() => journeys.dispose());
			const input = journeys.beginInput();
			now = 140;
			if (first === "frame") input.firstStatus();
			else input.admission("completed");
			expect(input.statusPending).toBe(true);
			now = 180;
			if (first === "frame") input.admission("completed");
			else input.firstStatus();
			input.firstStatus();
			expect(input.statusPending).toBe(false);
			expect(events.filter(({ stage }) => stage === "first_status")).toEqual([
				expect.objectContaining({ duration_ms: first === "frame" ? 40 : 80, outcome: "success" }),
			]);
			journeys.beginCancellation()("completed");
			expect(events.at(-1)).toMatchObject({ stage: "cancellation_to_idle", outcome: "success" });
			const cancel = journeys.beginCancellation();
			const pending = journeys.beginInput();
			settingsManager.setTelemetryEnabled(false);
			settingsManager.setTelemetryEnabled(true);
			const count = events.length;
			pending.admission("completed");
			pending.firstStatus();
			cancel("completed");
			expect(events).toHaveLength(count);
		},
	);
});
