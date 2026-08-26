import { describe, expect, it } from "vitest";
import {
	deriveAutoresearchDashboardPayload,
	parseAutoresearchDashboardArgs,
} from "../src/cli/autoresearch-dashboard.js";
import { AutoresearchStore } from "../src/core/autoresearch.js";

describe("autoresearch dashboard", () => {
	it("parses localhost dashboard options and rejects unsafe session selectors", () => {
		expect(parseAutoresearchDashboardArgs(["dashboard"])).toEqual({
			port: 4317,
			openBrowser: true,
		});
		expect(
			parseAutoresearchDashboardArgs(["dashboard", "--session", "01a03cdc-407d", "--port=4567", "--no-open"]),
		).toEqual({ port: 4567, sessionId: "01a03cdc-407d", openBrowser: false });
		expect(() => parseAutoresearchDashboardArgs(["dashboard", "--session", "../../private"])).toThrow(
			"session id is invalid",
		);
		expect(() => parseAutoresearchDashboardArgs(["dashboard", "--port", "0"])).toThrow("port must be an integer");
	});

	it("derives the candidate phase from durable literature and claim progress", () => {
		const store = new AutoresearchStore(undefined, () => "2026-08-26T00:00:00.000Z");
		store.initialize("Find a defensible research problem", "Autonomous research");
		store.addClaim({
			claimId: "claim-1",
			claimText: "A recurring limitation exists.",
			claimType: "KNOWN_LIMITATION",
			status: "proposed",
			supportingEvidence: [],
			contradictingEvidence: [],
			confidence: "medium",
			unresolvedObjections: [],
			createdAt: "2026-08-26T00:00:00.000Z",
		});
		const state = store.getState();
		const payload = deriveAutoresearchDashboardPayload("session-1", state, store.evaluateStopGate());

		expect(payload.currentPhase.id).toBe("candidate");
		expect(payload.phases.find((phase) => phase.id === "candidate")?.status).toBe("active");
		expect(payload.metrics.claims).toBe(1);
		expect(payload.reviewers).toHaveLength(4);
		expect(payload.stopGate.passed).toBe(false);
	});

	it("shows the final gate as complete when every durable check passes", () => {
		const store = new AutoresearchStore();
		store.initialize("Finish a publication-grade problem definition");
		const state = store.getState();
		const checks = Object.fromEntries(
			[
				"promotedCandidate",
				"clearProblemStatement",
				"multipleRealPublications",
				"latestPreprintCheck",
				"strongClosestPriorWorkComparison",
				"mechanisticExplanation",
				"falsifiableHypothesis",
				"feasibleExperiment",
				"preliminaryEvidence",
				"strongBaselinePlan",
				"broaderRelevance",
				"fourReviewSurvival",
				"supervisorProgressing",
			].map((key) => [key, true]),
		) as ReturnType<AutoresearchStore["evaluateStopGate"]>["checks"];
		const payload = deriveAutoresearchDashboardPayload("session-2", state, {
			passed: true,
			candidateId: "candidate-1",
			checks,
			reasons: [],
		});

		expect(payload.currentPhase).toMatchObject({ id: "final_gate", progressPercent: 100 });
		expect(payload.phases.every((phase) => phase.status === "complete")).toBe(true);
	});
});
