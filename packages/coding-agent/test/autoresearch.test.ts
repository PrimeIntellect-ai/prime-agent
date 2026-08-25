import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AutoresearchStore,
	parseAutoresearchAgentPayload,
	parseAutoresearchClaimInput,
	parseAutoresearchClaimUpdateInput,
	parseAutoresearchCycleInput,
	parseAutoresearchExperimentInput,
	parseAutoresearchMemoryInput,
	parseAutoresearchMemoryReuseInput,
	parseAutoresearchPublicationInput,
	parseAutoresearchSupervisionInput,
} from "../src/core/autoresearch.js";

const NOW = "2026-08-25T00:00:00.000Z";

function publication(index = 1) {
	return {
		paper_id: `doi:10.1000/example-${index}`,
		title: `Example paper ${index}`,
		authors: ["A. Researcher"],
		year: 2026,
		venue: "Research Conference",
		doi: `10.1000/example-${index}`,
		publication_status: "peer_reviewed",
		full_text_url: `https://example.test/paper-${index}.pdf`,
		metadata_verified_by: ["crossref", "publisher"],
	};
}

function candidate(index = 1) {
	return {
		candidate_id: `candidate-${index}`,
		statement: `Candidate problem ${index}`,
		motivation: "Published results expose an important unresolved failure.",
		mechanistic_motivation: "The failure may arise from evidence authority rather than retrieval.",
		closest_prior_art: "Paper X changes retrieval but not authority.",
		unresolved_questions: ["Does authority calibration explain the failure?"],
		falsifier: "No difference under an authority-controlled intervention.",
		experiment_design: "Randomize authority while holding retrieval fixed.",
		baseline_plan: "Compare against retrieval-only and no-memory baselines.",
		broader_relevance: "The mechanism applies to long-horizon agents across domains.",
		requirements: ["public benchmark"],
	};
}

function gates(overrides: Record<string, boolean> = {}) {
	return {
		important: true,
		unresolved: true,
		publication_backed: true,
		mechanistically_motivated: true,
		falsifiable: true,
		feasible: true,
		closest_prior_work_analyzed: true,
		broader_relevance: true,
		...overrides,
	};
}

function fieldMaps(suffix = "base") {
	return {
		assumptions: [`assumption-${suffix}`],
		limitations: [`limitation-${suffix}`],
		contradictions: [`contradiction-${suffix}`],
		methods_and_evaluations: [`method-${suffix}`],
		closest_prior_work: [`prior-${suffix}`],
	};
}

function searchCoverage() {
	return {
		mechanism_queries: true,
		synonyms_and_adjacent: true,
		backward_references: true,
		forward_citations: true,
		related_recommendations: true,
		recent_12_to_24_months: true,
		recent_preprints: true,
		surveys_or_reviews: true,
	};
}

function passingReviewers() {
	return ["literature_auditor", "prior_art_killer", "experimental_critic", "top_tier_editor"].map((role) => ({
		role,
		verdict: "pass",
		summary: `${role} passed`,
		objections: [],
	}));
}

function rejectedCycle(index: number) {
	return {
		candidate: candidate(index),
		outcome: "rejected",
		rejection_reason: `distinct reason ${index}`,
		explicit_stuck: false,
		trajectory_fingerprint: `trajectory ${index}`,
		publications: [],
		field_maps: fieldMaps(),
		reviewers: [
			{
				role: "prior_art_killer",
				verdict: "reject",
				summary: "The candidate does not survive the prior-art search.",
				objections: [`objection ${index}`],
			},
		],
		gates: gates({ unresolved: false }),
		canonical_promotion_ids: [],
	};
}

describe("autoresearch control plane", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	function store(): { root: string; value: AutoresearchStore } {
		const root = mkdtempSync(join(tmpdir(), "prime-autoresearch-"));
		tempDirs.push(root);
		return { root, value: new AutoresearchStore(root, () => NOW) };
	}

	it("keeps publication identity separate from exact claim evidence and persists canonical lineage", () => {
		const { root, value } = store();
		value.initialize("Find a publication-grade agent-memory problem", "long-horizon agent memory");
		value.addPublication(parseAutoresearchPublicationInput(publication(), NOW));
		const claim = value.addClaim(
			parseAutoresearchClaimInput(
				{
					claim_id: "claim-assumption-a",
					claim_text: "The evaluated method assumes retrieved evidence remains authoritative.",
					claim_type: "SHARED_ASSUMPTION",
					confidence: "medium",
					supporting_evidence: [
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-1",
							exact_pointer: "Section 3, p. 5",
							demonstrates: "Retrieved memory is injected without an authority check.",
							interpretation: "This supports the assumption for this method family only.",
						},
					],
					contradicting_evidence: [],
					unresolved_objections: ["More method families must be checked."],
				},
				NOW,
			),
		);
		expect(claim.status).toBe("proposed");
		expect(value.promoteClaim(claim.claimId).status).toBe("canonical");
		expect(
			value.updateClaim(
				claim.claimId,
				parseAutoresearchClaimUpdateInput({
					contradicting_evidence: [
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-1",
							exact_pointer: "Appendix B, p. 14",
							demonstrates: "One ablation reduces the apparent authority effect.",
							interpretation: "The canonical interpretation is now contested, not disproved.",
						},
					],
					unresolved_objections: ["The ablation may be underpowered."],
				}),
			),
		).toMatchObject({ status: "contested", confidence: "medium" });

		const restored = new AutoresearchStore(root, () => NOW).getState();
		expect(restored.publications).toHaveLength(1);
		expect(restored.claims[0]).toMatchObject({ claimId: "claim-assumption-a", status: "contested" });
		expect(restored.lineage.map((entry) => entry.kind)).toEqual(["initialized", "claim_promoted", "claim_revised"]);
	});

	it("rejects literature promotion when its paper binding is absent from the publication ledger", () => {
		const { value } = store();
		value.initialize("Test provenance gates");
		const claim = parseAutoresearchClaimInput(
			{
				claim_text: "Prior work already solves the mechanism.",
				claim_type: "PRIOR_ART",
				supporting_evidence: [
					{
						source_type: "publication",
						source_id: "missing-paper",
						exact_pointer: "Figure 2",
						demonstrates: "The same intervention is evaluated.",
						interpretation: "This is a direct novelty collision.",
					},
				],
			},
			NOW,
		);
		expect(() => value.addClaim(claim)).toThrow("not in the publication ledger");
	});

	it("enforces the four-review and strong-problem gates for surviving candidates", () => {
		const raw = {
			...rejectedCycle(1),
			outcome: "survived",
			rejection_reason: undefined,
			reviewers: [
				{
					role: "literature_auditor",
					verdict: "pass",
					summary: "Supported",
					objections: [],
				},
			],
			gates: gates(),
		};
		expect(() => parseAutoresearchCycleInput(raw, NOW)).toThrow("require all four reviewer roles");
	});

	it("checks the supervisor after failed cycles and intervenes after five cycles without canonical progress", () => {
		const { value } = store();
		value.initialize("Find a strong unresolved research problem");
		value.addPublication(parseAutoresearchPublicationInput(publication(), NOW));
		let finalStatus = "";
		for (let index = 1; index <= 6; index++) {
			const result = value.recordCycle(parseAutoresearchCycleInput(rejectedCycle(index), NOW));
			finalStatus = result.checkpoint.status;
			expect(result.packet).toMatchObject({ cycle_id: result.cycle.cycleId });
			if (index === 1) expect(result.cycle).toMatchObject({ papersAdded: 1, paperIds: ["doi:10.1000/example-1"] });
		}
		expect(finalStatus).toBe("intervene");
		const state = value.getState();
		expect(state.cycles).toHaveLength(6);
		expect(state.lineage.filter((entry) => entry.kind === "cycle_completed")).toHaveLength(6);
	});

	it("preserves an unreadable canonical state file instead of silently replacing it", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-autoresearch-corrupt-"));
		tempDirs.push(root);
		const statePath = join(root, "autoresearch", "state.json");
		mkdirSync(join(root, "autoresearch"), { recursive: true });
		writeFileSync(statePath, "{not-json\n", "utf8");

		const value = new AutoresearchStore(root, () => NOW);
		expect(() => value.getState()).toThrow("existing file was preserved");
		expect(readFileSync(statePath, "utf8")).toBe("{not-json\n");
	});

	it("migrates the original autoresearch state without discarding canonical data", () => {
		const { root, value } = store();
		value.initialize("Preserve a version-one research run");
		value.addPublication(parseAutoresearchPublicationInput(publication(), NOW));
		const statePath = join(root, "autoresearch", "state.json");
		const legacy = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		legacy.schemaVersion = 1;
		for (const key of [
			"experiments",
			"memories",
			"memoryReusePlans",
			"collectedReviews",
			"ingestedAgentMessageIds",
		]) {
			delete legacy[key];
		}
		writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, "utf8");

		const restored = new AutoresearchStore(root, () => NOW).getState();
		expect(restored).toMatchObject({
			schemaVersion: 2,
			objective: "Preserve a version-one research run",
			publications: [{ paperId: "doi:10.1000/example-1" }],
			experiments: [],
			memories: [],
		});
	});

	it("requires three concrete alternative directions for recorded interventions", () => {
		const { value } = store();
		value.initialize("Test supervisor records");
		const cycle = value.recordCycle(parseAutoresearchCycleInput(rejectedCycle(1), NOW)).cycle;
		expect(() =>
			parseAutoresearchSupervisionInput(
				{
					cycle_id: cycle.cycleId,
					status: "intervene",
					reason: "Search collapsed.",
					detected_pattern: "retrieval-only variants",
					intervention_needed: true,
					alternative_directions: [],
				},
				NOW,
			),
		).toThrow("exactly three alternative_directions");
		const supervision = parseAutoresearchSupervisionInput(
			{
				cycle_id: cycle.cycleId,
				status: "intervene",
				reason: "Search collapsed.",
				detected_pattern: "retrieval-only variants",
				intervention_needed: true,
				diagnosis: "All recent candidates perturb the same mechanism.",
				failed_search_pattern: "Renaming retrieval-policy variants.",
				assumption_to_question: "Retrieval is the source of the failure.",
				alternative_directions: [1, 2, 3].map((priority) => ({
					direction: `Direction ${priority}`,
					why_different: "It changes a different causal variable.",
					kill_search: "Search the adjacent mechanism and its synonyms.",
					falsifier: "Run a controlled intervention.",
					priority,
				})),
			},
			NOW,
		);
		expect(value.recordSupervision(supervision)).toMatchObject({
			cycleId: cycle.cycleId,
			status: "intervene",
			alternativeDirections: [{ priority: 1 }, { priority: 2 }, { priority: 3 }],
		});
		expect(value.getState().lineage.at(-1)?.kind).toBe("supervisor_intervention");
	});

	it("tracks experiments and requires verified current-state-conditioned memory reuse", () => {
		const { value } = store();
		value.initialize("Test experiment evidence and safe memory reuse");
		const experiment = value.recordExperiment(
			parseAutoresearchExperimentInput(
				{
					experiment_id: "experiment-authority",
					candidate_id: "candidate-authority",
					hypothesis: "Authority changes the failure independently of retrieval.",
					design: "Hold retrieval fixed and randomize source authority.",
					baselines: ["retrieval-only", "no-memory"],
					artifact_paths: ["artifacts/authority-results.json"],
					metrics: { accuracy_delta: 0.12 },
					results: "The authority intervention changed accuracy by 12 points.",
					interpretation: "Preliminary support for an authority mechanism.",
					confounds: ["small sample"],
					status: "completed",
				},
				NOW,
			),
		);
		expect(experiment.status).toBe("completed");
		const claim = value.addClaim(
			parseAutoresearchClaimInput(
				{
					claim_text: "The preliminary intervention changes accuracy.",
					claim_type: "EMPIRICAL_OBSERVATION",
					supporting_evidence: [
						{
							source_type: "experiment",
							source_id: experiment.experimentId,
							exact_pointer: "artifacts/authority-results.json:accuracy_delta",
							demonstrates: "The measured delta is 0.12.",
							interpretation: "This is preliminary evidence, not a field-wide result.",
						},
					],
				},
				NOW,
			),
		);
		expect(value.promoteClaim(claim.claimId).status).toBe("canonical");

		const memory = value.remember(
			parseAutoresearchMemoryInput(
				{
					type: "FAILED_DIRECTION",
					title: "Generic stale-memory novelty failed",
					content: "Direct prior art already covers stale-memory detection.",
					tags: ["stale memory", "prior art"],
					importance: 8,
					source_ids: ["cycle-old"],
					current_state_references: ["field_map:closest_prior_work"],
				},
				NOW,
			),
		);
		expect(value.recallMemories("stale memory prior art")).toMatchObject([{ memoryId: memory.memoryId }]);
		const reuse = value.createMemoryReusePlan(
			parseAutoresearchMemoryReuseInput(
				{
					query: "Can the old novelty collision eliminate this candidate?",
					memory_ids: [memory.memoryId],
					current_state_bindings: ["Current candidate targets authority, not stale detection."],
					applicability_conditions: ["The mechanism must still be stale detection."],
					reusable_procedure: "Run the prior-art kill search with current synonyms.",
					verification_requirements: ["Re-open the cited paper and compare mechanisms."],
				},
				NOW,
			),
		);
		expect(reuse.status).toBe("proposed");
		expect(value.verifyMemoryReuse(reuse.reuseId, true, ["Paper rechecked against current mechanism."]).status).toBe(
			"verified",
		);
	});

	it("ingests marked specialist results exactly once", () => {
		const { value } = store();
		value.initialize("Collect hostile reviews");
		const message = `AUTORESEARCH_REVIEW_JSON:candidate-1\n${JSON.stringify({
			candidate_id: "candidate-1",
			role: "prior_art_killer",
			verdict: "reject",
			summary: "A direct collision exists.",
			objections: ["Paper X evaluates the same mechanism."],
		})}`;
		expect(parseAutoresearchAgentPayload(message, NOW)).toMatchObject({
			kind: "review",
			candidateId: "candidate-1",
		});
		expect(value.ingestAgentMessage("message-1", message)).toMatchObject({ kind: "review" });
		expect(value.ingestAgentMessage("message-1", message)).toBeUndefined();
		expect(value.getCollectedReviews("candidate-1")).toMatchObject([{ role: "prior_art_killer" }]);
	});

	it("blocks final export until the complete roadmap stop gate passes", () => {
		const { value } = store();
		value.initialize("Find a final publication-grade problem");
		value.addPublication(parseAutoresearchPublicationInput(publication(1), NOW));
		value.addPublication(parseAutoresearchPublicationInput(publication(2), NOW));
		const claim = value.addClaim(
			parseAutoresearchClaimInput(
				{
					claim_id: "claim-final",
					claim_text: "Authority is an unresolved mechanism.",
					claim_type: "MECHANISTIC_HYPOTHESIS",
					supporting_evidence: [
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-1",
							exact_pointer: "Section 4",
							demonstrates: "Authority is not controlled in the evaluation.",
							interpretation: "This leaves a mechanism-level question open.",
						},
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-2",
							exact_pointer: "Section 5",
							demonstrates: "A second method family also omits an authority control.",
							interpretation: "The motivation spans more than one publication.",
						},
					],
				},
				NOW,
			),
		);
		value.promoteClaim(claim.claimId);
		value.recordExperiment(
			parseAutoresearchExperimentInput(
				{
					experiment_id: "experiment-final",
					candidate_id: "candidate-1",
					hypothesis: "Authority affects outcomes.",
					design: "Controlled authority intervention.",
					baselines: ["retrieval-only", "no-memory"],
					artifact_paths: ["artifacts/final.json"],
					metrics: { delta: 0.1 },
					results: "A measurable delta was observed.",
					interpretation: "The mechanism merits deeper study.",
					confounds: ["pilot scale"],
					status: "completed",
				},
				NOW,
			),
		);
		const cycle = value.recordCycle(
			parseAutoresearchCycleInput(
				{
					candidate: candidate(1),
					outcome: "promoted",
					explicit_stuck: false,
					trajectory_fingerprint: "authority mechanism",
					publications: [],
					field_maps: fieldMaps("final"),
					reviewers: passingReviewers(),
					gates: gates(),
					search_coverage: searchCoverage(),
					motivation_paper_ids: ["doi:10.1000/example-1", "doi:10.1000/example-2"],
					closest_prior_work_paper_ids: ["doi:10.1000/example-1"],
					preliminary_evidence_experiment_ids: ["experiment-final"],
					canonical_promotion_ids: [claim.claimId],
				},
				NOW,
			),
		).cycle;
		expect(() => value.exportDeliverable(true)).toThrow("retained supervisor has not cleared");
		value.recordSupervision(
			parseAutoresearchSupervisionInput(
				{
					cycle_id: cycle.cycleId,
					status: "progressing",
					reason: "The verified trajectory is advancing.",
					detected_pattern: "none",
					intervention_needed: false,
					alternative_directions: [],
				},
				NOW,
			),
		);
		expect(value.evaluateStopGate().passed).toBe(true);
		expect(value.exportDeliverable(true)).toMatchObject({
			final_problem_statement: { candidateId: "candidate-1" },
			stop_gate: { passed: true },
		});
	});
});
