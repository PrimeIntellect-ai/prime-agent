import { describe, expect, it } from "vitest";
import { AgentMessageDigestController } from "../src/core/agent-message-digest-controller.js";

describe("agent message digest controller", () => {
	it("switches to digest on the first crossed trigger, from any trigger", () => {
		const controller = new AgentMessageDigestController();
		expect(
			controller.evaluate({ pending: 6, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" }),
		).toMatchObject({ mode: "digest", changed: true, reason: "pending-pressure" });

		const shareController = new AgentMessageDigestController();
		expect(
			shareController.evaluate({ pending: 0, ingestionShare: 0.25, ingestionTurnShare: null, currentMode: "push" }),
		).toMatchObject({ mode: "digest", changed: true, reason: "ingestion-context-share" });

		const turnController = new AgentMessageDigestController();
		expect(
			turnController.evaluate({
				pending: 0,
				ingestionShare: null,
				ingestionTurnShare: 0.4,
				currentMode: "push",
			}),
		).toMatchObject({ mode: "digest", changed: true, reason: "ingestion-turn-share" });
	});

	it("holds digest until every trigger relaxes below half its value (hysteresis)", () => {
		const controller = new AgentMessageDigestController();
		controller.evaluate({ pending: 6, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" });
		// EMA relaxes below 2.5 only after several quiet observations.
		expect(
			controller.evaluate({ pending: 1, ingestionShare: null, ingestionTurnShare: null, currentMode: "digest" }),
		).toMatchObject({ mode: "digest", changed: false });
		expect(
			controller.evaluate({ pending: 0, ingestionShare: 0.05, ingestionTurnShare: 0.1, currentMode: "digest" }),
		).toMatchObject({ mode: "digest", changed: false });
		expect(
			controller.evaluate({ pending: 0, ingestionShare: 0.05, ingestionTurnShare: 0.1, currentMode: "digest" }),
		).toMatchObject({ mode: "push", changed: true, reason: "recovered" });
	});

	it("never flaps on a single borderline observation", () => {
		const controller = new AgentMessageDigestController();
		controller.evaluate({ pending: 6, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" });
		// One borderline value keeps digest; the switch back needs ALL triggers below half.
		expect(
			controller.evaluate({ pending: 2, ingestionShare: 0.12, ingestionTurnShare: 0.2, currentMode: "digest" }),
		).toMatchObject({ mode: "digest", changed: false });
		expect(
			controller.evaluate({ pending: 2, ingestionShare: 0.12, ingestionTurnShare: 0.2, currentMode: "digest" }),
		).toMatchObject({ mode: "digest", changed: false });
	});

	it("treats unknown shares as unmeasured rather than crossed", () => {
		const controller = new AgentMessageDigestController();
		expect(
			controller.evaluate({ pending: 3, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" }),
		).toMatchObject({ mode: "push", changed: false });
	});

	it("smooths pending pressure with an EMA before applying the trigger", () => {
		const controller = new AgentMessageDigestController({ emaAlpha: 0.5 });
		expect(
			controller.evaluate({ pending: 4, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" }),
		).toMatchObject({ mode: "push", changed: false, pendingEma: 4 });
		expect(
			controller.evaluate({ pending: 8, ingestionShare: null, ingestionTurnShare: null, currentMode: "push" }),
		).toMatchObject({ mode: "digest", changed: true, pendingEma: 6 });
	});
});
