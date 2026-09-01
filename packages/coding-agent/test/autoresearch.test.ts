import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	AutoresearchStore,
	buildAutoresearchReviewerPrompts,
	buildAutoresearchSupervisorBootstrapPrompt,
	buildAutoresearchSupervisorPrompt,
	hasApplicablePeerReviewEvidence,
	isPublicAutoresearchAddress,
	parseAutoresearchAgentPayload,
	parseAutoresearchCandidateInput,
	parseAutoresearchClaimInput,
	parseAutoresearchClaimUpdateInput,
	parseAutoresearchCycleInput,
	parseAutoresearchExperimentInput,
	parseAutoresearchMemoryInput,
	parseAutoresearchMemoryReuseInput,
	parseAutoresearchPublicationInput,
	parseAutoresearchSearchReceiptInput,
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
		full_text_url: `https://example.test/paper-${index}.pdf`,
	};
}

function verification(index = 1, publicationStatus: "published" | "preprint" = "published") {
	return {
		verificationId: `verification-${index}`,
		paperId: `doi:10.1000/example-${index}`,
		source: publicationStatus === "preprint" ? ("arxiv" as const) : ("crossref" as const),
		publicationStatus,
		verifiedAt: NOW,
		metadataDigest: `${index % 10}`.repeat(64),
		resolvedMetadata: {
			title: `Example paper ${index}`,
			authors: ["A. Researcher"],
			year: 2026,
			venue: publicationStatus === "published" ? "Research Conference" : "arXiv",
			doi: `10.1000/example-${index}`,
			fullTextUrl: `https://example.test/paper-${index}.pdf`,
		},
	};
}

function peerReviewVerification(index = 1) {
	return {
		verificationId: `peer-review-verification-${index}`,
		paperId: `doi:10.1000/example-${index}`,
		source: "publisher" as const,
		evidenceUrl: `https://example.test/journal-${index}/article-${index}`,
		exactQuote: "This article underwent peer review before publication.",
		verifiedAt: NOW,
		evidenceDigest: `${(index + 2) % 10}`.repeat(64),
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

const SEARCH_COVERAGE_KINDS = [
	"mechanism_queries",
	"synonyms_and_adjacent",
	"backward_references",
	"forward_citations",
	"related_recommendations",
	"recent_12_to_24_months",
	"recent_preprints",
	"surveys_or_reviews",
] as const;

function passingReviewers() {
	return ["literature_auditor", "prior_art_killer", "experimental_critic", "top_tier_editor"].map((role) => ({
		role,
		verdict: "pass",
		summary: `${role} passed`,
		queries: [`${role} query`],
		inspected_paper_ids: ["doi:10.1000/example-1"],
		evidence_bindings: [
			{
				paper_id: "doi:10.1000/example-1",
				exact_pointer: "Section 3",
				finding: `${role} checked the candidate against the verified paper`,
			},
		],
		collision_paper_ids: [],
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
		return { root, value: new AutoresearchStore(root, () => NOW, root) };
	}

	function addVerifiedPublication(value: AutoresearchStore, index = 1, peerReviewed = true): void {
		value.addPublication(parseAutoresearchPublicationInput(publication(index), NOW));
		value.recordPublicationVerification(verification(index));
		if (peerReviewed) value.recordPeerReviewVerification(peerReviewVerification(index));
	}

	function recordSearchReceipts(
		value: AutoresearchStore,
		candidateValue: ReturnType<typeof parseAutoresearchCandidateInput>,
		paperId = "doi:10.1000/example-1",
	): void {
		for (const coverageKind of SEARCH_COVERAGE_KINDS) {
			value.recordSearchReceipt(
				parseAutoresearchSearchReceiptInput(
					candidateValue,
					{
						coverage_kind: coverageKind,
						query: `${coverageKind} for ${candidateValue.statement}`,
						source: coverageKind === "recent_preprints" ? "arxiv" : "google_search",
						result_urls: [`https://example.org/search/${coverageKind}`],
						inspected_paper_ids: [paperId],
					},
					NOW,
				),
			);
		}
	}

	function ingestPassingReviews(
		value: AutoresearchStore,
		candidateValue: ReturnType<typeof parseAutoresearchCandidateInput>,
	): void {
		const candidateId = candidateValue.candidateId;
		for (const reviewer of passingReviewers()) {
			const role = reviewer.role as Parameters<AutoresearchStore["registerReviewerAssignment"]>[1];
			const child = { rlmChildId: `child-${role}`, name: `reviewer-${role}` };
			value.registerReviewerAssignment(candidateValue, role, child);
			const message = `AUTORESEARCH_REVIEW_JSON:${candidateId}\n${JSON.stringify({
				candidate_id: candidateId,
				...reviewer,
			})}`;
			value.ingestAgentMessage(`message-${candidateId}-${role}`, message, { sessionName: child.name });
		}
	}

	it("keeps publication identity separate from exact claim evidence and persists canonical lineage", () => {
		const { root, value } = store();
		value.initialize("Find a publication-grade agent-memory problem", "long-horizon agent memory");
		addVerifiedPublication(value);
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
							exact_quote: "Retrieved memory is inserted directly into the generation context.",
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
							exact_quote: "The authority ablation reduces the measured effect.",
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
						evidence_kind: "figure",
						demonstrates: "The same intervention is evaluated.",
						interpretation: "This is a direct novelty collision.",
					},
				],
			},
			NOW,
		);
		expect(() => value.addClaim(claim)).toThrow("not in the publication ledger");
	});

	it("rejects caller-authored publication authority and quote-free textual evidence", () => {
		expect(() =>
			parseAutoresearchPublicationInput({ ...publication(), publication_status: "peer_reviewed_verified" }, NOW),
		).toThrow("publication status is host-verified");
		expect(() =>
			parseAutoresearchPublicationInput({ ...publication(), metadata_verified_by: ["crossref"] }, NOW),
		).toThrow("metadata verification is host-owned");
		expect(() =>
			parseAutoresearchClaimInput(
				{
					claim_text: "A textual claim without a quote.",
					claim_type: "PRIOR_ART",
					supporting_evidence: [
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-1",
							exact_pointer: "Section 2",
							demonstrates: "A claimed result.",
							interpretation: "An interpretation.",
						},
					],
				},
				NOW,
			),
		).toThrow("exact_quote is required");
		expect(
			parseAutoresearchPublicationInput(
				{
					paper_id: "arxiv:2608.12345",
					title: "A preprint",
					authors: ["A. Researcher"],
					full_text_url: "https://arxiv.org/pdf/2608.12345",
				},
				NOW,
			).preprintId,
		).toBe("2608.12345");
		expect(() =>
			parseAutoresearchPublicationInput(
				{
					...publication(),
					doi: "10.1000/a-different-paper",
				},
				NOW,
			),
		).toThrow("must identify the same DOI");
	});

	it("keeps Crossref publication evidence separate from explicit publisher peer-review proof", () => {
		const { value } = store();
		value.initialize("Test conservative publication authority");
		addVerifiedPublication(value, 1, false);
		expect(value.getState().publications[0]?.publicationStatus).toBe("published");
		expect(() =>
			value.recordPublicationVerification({
				...verification(1),
				verificationId: "forged-peer-review-metadata",
				publicationStatus: "peer_reviewed_verified",
			}),
		).toThrow("metadata cannot establish peer review");
		expect(() =>
			value.recordPeerReviewVerification({
				...peerReviewVerification(1),
				exactQuote: "Editorials are not peer reviewed.",
			}),
		).toThrow("positively establish");
		for (const exactQuote of [
			"Peer reviewed articles are distinct from this editorial.",
			"This publisher produces peer reviewed journals, but this item is an editorial.",
			"This article may be peer reviewed.",
		]) {
			expect(() =>
				value.recordPeerReviewVerification({
					...peerReviewVerification(1),
					exactQuote,
				}),
			).toThrow("positively establish");
		}
		value.recordPeerReviewVerification(peerReviewVerification(1));
		expect(value.getState()).toMatchObject({
			publications: [{ publicationStatus: "peer_reviewed_verified" }],
			peerReviewVerifications: [{ source: "publisher" }],
		});
	});

	it("requires peer-review proof in visible, applicable item-page context", () => {
		const quote = "This article was peer reviewed.";
		expect(hasApplicablePeerReviewEvidence(`<main><p>${quote}</p></main>`, quote)).toBe(true);
		expect(
			hasApplicablePeerReviewEvidence(
				`<html><head><title>Example journal</title></head><body><p>${quote}</p></body></html>`,
				quote,
			),
		).toBe(true);
		for (const documentText of [
			`<main><p>The following statement is false: ${quote}</p></main>`,
			`<script>window.status = ${JSON.stringify(quote)}</script>`,
			`<p hidden>${quote}</p>`,
			`<p aria-hidden="true">${quote}</p>`,
			`<p style="display:none">${quote}</p>`,
			`<p class=related-content>${quote}</p>`,
			`<div hidden><div>decoy</div><p>${quote}</p></div>`,
			`<div class=related-content><div>decoy</div><p>${quote}</p></div>`,
			`<div class="related-content-widget"><p>${quote}</p></div>`,
			`<div class="recommended-content"><p>${quote}</p></div>`,
			`<div class="also-read-widget"><p>${quote}</p></div>`,
			`<del>${quote}</del>`,
			`<aside class="related-content"><p>${quote}</p></aside>`,
		]) {
			expect(hasApplicablePeerReviewEvidence(documentText, quote)).toBe(false);
		}
	});

	it("rejects private and special-use addresses before publisher evidence fetches", () => {
		for (const address of [
			"127.0.0.1",
			"169.254.169.254",
			"10.0.0.1",
			"::1",
			"::ffff:127.0.0.1",
			"::ffff:7f00:1",
			"fec0::1",
			"5f00::1",
			"100:0:0:1::1",
			"2001:db8::1",
		]) {
			expect(isPublicAutoresearchAddress(address)).toBe(false);
		}
		expect(isPublicAutoresearchAddress("8.8.8.8")).toBe(true);
		expect(isPublicAutoresearchAddress("::ffff:8.8.8.8")).toBe(true);
		expect(isPublicAutoresearchAddress("2606:4700:4700::1111")).toBe(true);
	});

	it("derives search coverage from receipts and enforces four reviews for every cycle", () => {
		const { value } = store();
		value.initialize("Test host-owned reviewer gates");
		addVerifiedPublication(value);
		addVerifiedPublication(value, 2);
		const parsedCandidate = parseAutoresearchCandidateInput(candidate(1));
		const raw = {
			...rejectedCycle(1),
			outcome: "survived",
			rejection_reason: undefined,
			gates: gates({
				important: false,
				unresolved: false,
				publication_backed: false,
				mechanistically_motivated: false,
				falsifiable: false,
				feasible: false,
				closest_prior_work_analyzed: false,
				broader_relevance: false,
			}),
			motivation_paper_ids: ["doi:10.1000/example-1", "doi:10.1000/example-2"],
			closest_prior_work_paper_ids: ["doi:10.1000/example-1"],
		};
		expect(() => value.recordCycle(parseAutoresearchCycleInput(raw, NOW))).toThrow(
			"requires all four reviewer roles",
		);
		expect(() => parseAutoresearchCycleInput({ ...raw, reviewers: passingReviewers() }, NOW)).toThrow(
			"cycle.reviewers is host-owned",
		);
		expect(() => parseAutoresearchCycleInput({ ...raw, search_coverage: { mechanism_queries: true } }, NOW)).toThrow(
			"cycle.search_coverage is host-owned",
		);
		ingestPassingReviews(value, parsedCandidate);
		expect(() => value.recordCycle(parseAutoresearchCycleInput(raw, NOW))).toThrow(
			"complete literature-search coverage",
		);
		recordSearchReceipts(value, parsedCandidate);
		expect(value.recordCycle(parseAutoresearchCycleInput(raw, NOW)).cycle).toMatchObject({
			gates: {
				important: true,
				unresolved: true,
				publicationBacked: true,
				falsifiable: true,
			},
			searchCoverage: {
				mechanismQueries: true,
				surveysOrReviews: true,
			},
			searchReceiptIds: expect.arrayContaining([expect.stringMatching(/^search-receipt-/)]),
		});

		const rejected = rejectedCycle(2);
		expect(() => value.recordCycle(parseAutoresearchCycleInput(rejected, NOW))).toThrow(
			"requires all four reviewer roles",
		);
	});

	it("checks the supervisor after failed cycles and intervenes after five cycles without canonical progress", () => {
		const { value } = store();
		value.initialize("Find a strong unresolved research problem");
		value.addPublication(parseAutoresearchPublicationInput(publication(), NOW));
		let finalStatus = "";
		for (let index = 1; index <= 6; index++) {
			ingestPassingReviews(value, parseAutoresearchCandidateInput(candidate(index)));
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

	it("rebuilds only the latest unsupervised checkpoint without duplicating its durable cycle", () => {
		const { value } = store();
		value.initialize("Recover supervision after a root-session restart");
		ingestPassingReviews(value, parseAutoresearchCandidateInput(candidate(1)));
		const first = value.recordCycle(parseAutoresearchCycleInput(rejectedCycle(1), NOW));
		expect(value.getSupervisorCheckpoint(first.cycle.cycleId)).toMatchObject({
			cycle: { cycleId: first.cycle.cycleId },
			packet: { cycle_id: first.cycle.cycleId },
		});
		ingestPassingReviews(value, parseAutoresearchCandidateInput(candidate(2)));
		const second = value.recordCycle(parseAutoresearchCycleInput(rejectedCycle(2), NOW));
		expect(() => value.getSupervisorCheckpoint(first.cycle.cycleId)).toThrow(
			"only allowed for the latest durable cycle",
		);
		expect(value.getSupervisorCheckpoint(second.cycle.cycleId).checkpoint).toEqual(second.checkpoint);
		expect(value.getState().cycles).toHaveLength(2);
		value.recordSupervision(
			parseAutoresearchSupervisionInput(
				{
					cycle_id: second.cycle.cycleId,
					status: "progressing",
					reason: "The trajectory changed after the latest rejection.",
					detected_pattern: "none",
					intervention_needed: false,
					alternative_directions: [],
				},
				NOW,
			),
		);
		expect(() => value.getSupervisorCheckpoint(second.cycle.cycleId)).toThrow("already has supervision");
	});

	it("distinguishes supervisor intervention thresholds from healthy trajectory changes", () => {
		function completeRejectedCycle(value: AutoresearchStore, index: number, overrides: Record<string, unknown> = {}) {
			const raw = { ...rejectedCycle(index), ...overrides };
			const candidateValue = parseAutoresearchCandidateInput(raw.candidate);
			ingestPassingReviews(value, candidateValue);
			return value.recordCycle(parseAutoresearchCycleInput(raw, NOW)).checkpoint;
		}

		const repeatedReason = store().value;
		repeatedReason.initialize("Detect repeated rejection causes");
		expect(completeRejectedCycle(repeatedReason, 1, { rejection_reason: "same causal failure" }).status).toBe(
			"progressing",
		);
		expect(completeRejectedCycle(repeatedReason, 2, { rejection_reason: "same causal failure" }).status).toBe(
			"watch",
		);
		expect(
			completeRejectedCycle(repeatedReason, 3, { rejection_reason: "same causal failure" }).triggeredHeuristics,
		).toContain("same_rejection_reason_3_cycles");

		const repeatedPriorArt = store().value;
		repeatedPriorArt.initialize("Detect repeated prior-art collisions");
		for (let index = 1; index <= 2; index++) {
			expect(
				completeRejectedCycle(repeatedPriorArt, index, { prior_art_cluster: "same prior-art family" })
					.interventionNeeded,
			).toBe(false);
		}
		expect(
			completeRejectedCycle(repeatedPriorArt, 3, { prior_art_cluster: "same prior-art family" }).triggeredHeuristics,
		).toContain("same_prior_art_cluster_3_cycles");

		const literatureSaturation = store().value;
		literatureSaturation.initialize("Detect literature growth without map changes");
		completeRejectedCycle(literatureSaturation, 1);
		for (let index = 1; index <= 10; index++) addVerifiedPublication(literatureSaturation, index, false);
		expect(completeRejectedCycle(literatureSaturation, 2).triggeredHeuristics).toContain(
			"literature_expansion_without_map_change",
		);

		const explicitStuck = store().value;
		explicitStuck.initialize("Respect an explicit stuck signal");
		expect(completeRejectedCycle(explicitStuck, 1, { explicit_stuck: true }).triggeredHeuristics).toContain(
			"main_agent_reported_stuck",
		);

		const changingTrajectory = store().value;
		changingTrajectory.initialize("Do not interrupt a changing trajectory");
		let latestStatus = "";
		for (let index = 1; index <= 6; index++) {
			latestStatus = completeRejectedCycle(changingTrajectory, index, {
				field_maps: fieldMaps(`progress-${index}`),
				prior_art_cluster: `prior-art-${index}`,
			}).status;
		}
		expect(latestStatus).toBe("progressing");
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
			"publicationVerifications",
			"reviewerAssignments",
			"collectedReviews",
			"ingestedAgentMessageIds",
		]) {
			delete legacy[key];
		}
		writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, "utf8");

		const restored = new AutoresearchStore(root, () => NOW).getState();
		expect(restored).toMatchObject({
			schemaVersion: 4,
			objective: "Preserve a version-one research run",
			publications: [{ paperId: "doi:10.1000/example-1" }],
			experiments: [],
			memories: [],
			peerReviewVerifications: [],
			searchReceipts: [],
			memoryReflections: [],
		});
	});

	it("downgrades unsupported legacy peer-review claims during version-four migration", () => {
		const { root, value } = store();
		value.initialize("Migrate conservative publication status");
		value.addPublication(parseAutoresearchPublicationInput(publication(), NOW));
		value.recordPublicationVerification(verification());
		const statePath = join(root, "autoresearch", "state.json");
		const legacy = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
		legacy.schemaVersion = 3;
		for (const collection of ["publications", "publicationVerifications"]) {
			const records = legacy[collection] as Array<Record<string, unknown>>;
			records[0]!.publicationStatus = "peer_reviewed";
		}
		for (const key of ["peerReviewVerifications", "memoryReflections", "searchReceipts"]) delete legacy[key];
		writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, "utf8");

		const restored = new AutoresearchStore(root, () => NOW).getState();
		expect(restored.schemaVersion).toBe(4);
		expect(restored.publications[0]?.publicationStatus).toBe("published");
		expect(restored.publicationVerifications[0]?.publicationStatus).toBe("published");
		expect(restored.peerReviewVerifications).toEqual([]);
	});

	it("requires three concrete alternative directions for recorded interventions", () => {
		const { value } = store();
		value.initialize("Test supervisor records");
		ingestPassingReviews(value, parseAutoresearchCandidateInput(candidate(1)));
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
		const { root, value } = store();
		value.initialize("Test experiment evidence and safe memory reuse");
		mkdirSync(join(root, "artifacts"), { recursive: true });
		writeFileSync(join(root, "artifacts", "authority-results.json"), '{"accuracy_delta":0.12}\n', "utf8");
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
		expect(experiment).toMatchObject({ status: "completed", artifactReceipts: [{ sha256: expect.any(String) }] });
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
		writeFileSync(join(root, "artifacts", "authority-results.json"), '{"accuracy_delta":0.99}\n', "utf8");
		expect(() =>
			value.updateClaim(
				claim.claimId,
				parseAutoresearchClaimUpdateInput({
					supporting_evidence: [
						{
							source_type: "experiment",
							source_id: experiment.experimentId,
							exact_pointer: "artifacts/authority-results.json:accuracy_delta",
							demonstrates: "The changed artifact should not be trusted.",
							interpretation: "Receipt mismatch must block this update.",
						},
					],
				}),
			),
		).toThrow("missing or modified artifact receipts");

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
		const reflection = value.recordMemoryReflection({
			trigger: "manual",
			report: { merged: 0, pruned: 1 },
			archivedMemoryIds: [memory.memoryId],
		});
		expect(reflection.archivedMemoryIds).toEqual([memory.memoryId]);
		expect(value.recallMemories("stale memory prior art")).toMatchObject([{ memoryId: memory.memoryId }]);
		expect(value.getState().memories[0]?.invalidatedAt).toBeUndefined();
	});

	it("ingests marked specialist results exactly once", () => {
		const { value } = store();
		value.initialize("Collect hostile reviews");
		const reviewedCandidate = parseAutoresearchCandidateInput(candidate(1));
		const child = { rlmChildId: "child-prior-art", name: "assigned-prior-art-reviewer" };
		value.registerReviewerAssignment(reviewedCandidate, "prior_art_killer", child);
		expect(() =>
			value.registerReviewerAssignment(
				{ ...reviewedCandidate, statement: "A different candidate smuggled under the same ID." },
				"prior_art_killer",
				child,
			),
		).toThrow("changed after reviewer assignment");
		const message = `AUTORESEARCH_REVIEW_JSON:candidate-1\n${JSON.stringify({
			candidate_id: "candidate-1",
			role: "prior_art_killer",
			verdict: "reject",
			summary: "A direct collision exists.",
			queries: ["same mechanism query"],
			inspected_paper_ids: ["doi:10.1000/example-1"],
			evidence_bindings: [
				{
					paper_id: "doi:10.1000/example-1",
					exact_pointer: "Section 4",
					finding: "The same mechanism was evaluated.",
				},
			],
			collision_paper_ids: ["doi:10.1000/example-1"],
			objections: ["Paper X evaluates the same mechanism."],
		})}`;
		expect(parseAutoresearchAgentPayload(message, NOW)).toMatchObject({
			kind: "review",
			candidateId: "candidate-1",
		});
		expect(() => value.ingestAgentMessage("forged-message", message, { sessionName: "root" })).toThrow(
			"assigned reviewer child",
		);
		expect(value.ingestAgentMessage("message-1", message, { sessionName: child.name })).toMatchObject({
			kind: "review",
		});
		expect(value.ingestAgentMessage("message-1", message, { sessionName: child.name })).toBeUndefined();
		expect(value.getCollectedReviews("candidate-1")).toMatchObject([{ role: "prior_art_killer" }]);
		expect(() =>
			value.registerReviewerAssignment(reviewedCandidate, "prior_art_killer", {
				rlmChildId: "child-replacement",
				name: "replacement-prior-art-reviewer",
			}),
		).toThrow("already has a collected prior_art_killer review");
	});

	it("rebinds a reviewer role whose previous child failed before producing a verdict", () => {
		const { value } = store();
		value.initialize("Recover a failed hostile reviewer");
		const reviewedCandidate = parseAutoresearchCandidateInput(candidate(1));
		const first = value.registerReviewerAssignment(reviewedCandidate, "experimental_critic", {
			rlmChildId: "child-failed",
			name: "failed-experimental-reviewer",
		});
		const replacement = value.registerReviewerAssignment(reviewedCandidate, "experimental_critic", {
			rlmChildId: "child-replacement",
			name: "replacement-experimental-reviewer",
		});
		expect(replacement).toMatchObject({
			rlmChildId: "child-replacement",
			name: "replacement-experimental-reviewer",
		});
		expect(replacement.assignmentId).not.toBe(first.assignmentId);
		expect(value.getReviewerAssignments("candidate-1")).toHaveLength(1);
	});

	it("puts each exact machine-readable role identifier in its reviewer prompt", () => {
		const { value } = store();
		value.initialize("Keep weak reviewer models on schema");
		const reviewedCandidate = parseAutoresearchCandidateInput(candidate(1));
		const prompts = buildAutoresearchReviewerPrompts(reviewedCandidate, value.getState());
		for (const [role, prompt] of Object.entries(prompts)) {
			expect(prompt).toContain(`role value MUST be the literal machine identifier "${role}"`);
			expect(prompt).toContain("objections MUST be an array of strings");
			expect(prompt).toContain("inspected_paper_ids");
			expect(prompt).toContain("evidence_bindings");
			expect(prompt).toContain("a final chat response alone does not count");
		}
	});

	it("gives weak supervisor models a direct send-only JSON contract", () => {
		const bootstrap = buildAutoresearchSupervisorBootstrapPrompt();
		expect(bootstrap).toContain("only permitted tool action is one agent_message.send");
		expect(bootstrap).toContain("send exactly AUTORESEARCH_SUPERVISOR_READY");
		const prompt = buildAutoresearchSupervisorPrompt("Detect a stuck trajectory");
		expect(prompt).toContain("first and only Python action");
		expect(prompt).toContain("Do not inspect APIs");
		expect(prompt).toContain('"kill_search":"one search string"');
		expect(prompt).toContain("kill_search MUST be a string");
	});

	it("blocks final export until the complete roadmap stop gate passes", () => {
		const { root, value } = store();
		value.initialize("Find a final publication-grade problem");
		addVerifiedPublication(value, 1);
		addVerifiedPublication(value, 2);
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
							exact_quote: "The evaluation does not control source authority.",
							demonstrates: "Authority is not controlled in the evaluation.",
							interpretation: "This leaves a mechanism-level question open.",
						},
						{
							source_type: "publication",
							source_id: "doi:10.1000/example-2",
							exact_pointer: "Section 5",
							exact_quote: "Authority calibration is outside the scope of this evaluation.",
							demonstrates: "A second method family also omits an authority control.",
							interpretation: "The motivation spans more than one publication.",
						},
					],
				},
				NOW,
			),
		);
		value.promoteClaim(claim.claimId);
		mkdirSync(join(root, "artifacts"), { recursive: true });
		writeFileSync(join(root, "artifacts", "final.json"), '{"delta":0.1}\n', "utf8");
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
		ingestPassingReviews(value, parseAutoresearchCandidateInput(candidate(1)));
		recordSearchReceipts(value, parseAutoresearchCandidateInput(candidate(1)));
		const cycle = value.recordCycle(
			parseAutoresearchCycleInput(
				{
					candidate: candidate(1),
					outcome: "promoted",
					explicit_stuck: false,
					trajectory_fingerprint: "authority mechanism",
					publications: [],
					field_maps: fieldMaps("final"),
					gates: gates(),
					motivation_paper_ids: ["doi:10.1000/example-1", "doi:10.1000/example-2"],
					closest_prior_work_paper_ids: ["doi:10.1000/example-1"],
					preliminary_evidence_experiment_ids: ["experiment-final"],
					canonical_promotion_ids: [claim.claimId],
				},
				NOW,
			),
		).cycle;
		expect(() => value.exportDeliverable(true)).toThrow("retained supervisor has not cleared");
		const manual = parseAutoresearchSupervisionInput(
			{
				cycle_id: cycle.cycleId,
				status: "progressing",
				reason: "Manual recovery believes the trajectory is advancing.",
				detected_pattern: "none",
				intervention_needed: false,
				alternative_directions: [],
			},
			NOW,
		);
		value.recordSupervision(manual);
		expect(value.evaluateStopGate().checks.supervisorProgressing).toBe(false);
		const supervisor = { rlmChildId: "supervisor-child", name: "retained-supervisor" };
		value.setSupervisor(supervisor);
		const message = `AUTORESEARCH_SUPERVISION_JSON:${cycle.cycleId}\n${JSON.stringify({
			cycle_id: cycle.cycleId,
			status: "progressing",
			reason: "The verified trajectory is advancing.",
			detected_pattern: "none",
			intervention_needed: false,
			alternative_directions: [],
		})}`;
		expect(() => value.ingestAgentMessage("forged-supervision", message, { sessionName: "root" })).toThrow(
			"retained supervisor child",
		);
		value.ingestAgentMessage("supervision-message", message, { sessionName: supervisor.name });
		expect(value.evaluateStopGate().passed).toBe(true);
		expect(value.exportDeliverable(true)).toMatchObject({
			final_problem_statement: { candidateId: "candidate-1" },
			stop_gate: { passed: true },
		});
	});

	it("confines artifact paths and receipts strictly to the workspace and rejects escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-autoresearch-containment-"));
		const outsideDir = mkdtempSync(join(tmpdir(), "prime-autoresearch-outside-"));
		writeFileSync(join(outsideDir, "secret.json"), '{"secret":true}\n', "utf8");

		const value = new AutoresearchStore(join(root, "artifacts-state"), () => NOW, root);

		// 1. Rejects absolute paths in input parsing
		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["/etc/passwd"],
			}),
		).toThrow("relative path within the workspace");

		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["C:\\secret.json"],
			}),
		).toThrow("relative path within the workspace");

		// 2. Rejects traversal paths in input parsing (both forward and backslash forms)
		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["artifacts/../secret.json"],
			}),
		).toThrow("must not contain traversal segments");

		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["artifacts\\..\\..\\secret.json"],
			}),
		).toThrow("must not contain traversal segments");

		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["../outside.json"],
			}),
		).toThrow("must not contain traversal segments");

		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["artifacts/../../secret.json"],
			}),
		).toThrow("must not contain traversal segments");

		// 3. Rejects null bytes in input parsing
		expect(() =>
			parseAutoresearchExperimentInput({
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["artifacts/results.json\0/etc/passwd"],
			}),
		).toThrow("must not contain null bytes");

		// 4. Rejects symlink escape to outside files
		mkdirSync(join(root, "artifacts"), { recursive: true });
		symlinkSync(join(outsideDir, "secret.json"), join(root, "artifacts", "symlink-outside.json"));

		expect(() =>
			value.recordExperiment(
				parseAutoresearchExperimentInput({
					experiment_id: "exp-symlink",
					candidate_id: "candidate-1",
					hypothesis: "test",
					design: "test",
					baselines: ["base"],
					artifact_paths: ["artifacts/symlink-outside.json"],
					results: "results",
					interpretation: "interpretation",
					status: "completed",
				}),
			),
		).toThrow("escapes the workspace");

		// 5. Accepts legitimate in-workspace artifacts and canonicalizes paths
		writeFileSync(join(root, "artifacts", "valid.json"), '{"valid":true}\n', "utf8");
		const validExp = value.recordExperiment(
			parseAutoresearchExperimentInput({
				experiment_id: "exp-valid",
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["./artifacts/valid.json"],
				results: "valid results",
				interpretation: "valid interpretation",
				status: "completed",
			}),
		);
		expect(validExp.artifactReceipts).toHaveLength(1);
		expect(validExp.artifactReceipts[0]?.path).toBe("artifacts/valid.json");
		expect(validExp.artifactPaths).toEqual(["artifacts/valid.json"]);

		// 6. Accepts intra-workspace symlinks and canonicalizes correctly
		symlinkSync(join(root, "artifacts", "valid.json"), join(root, "artifacts", "symlink-internal.json"));
		const internalSymExp = value.recordExperiment(
			parseAutoresearchExperimentInput({
				experiment_id: "exp-internal-sym",
				candidate_id: "candidate-1",
				hypothesis: "test",
				design: "test",
				baselines: ["base"],
				artifact_paths: ["artifacts/symlink-internal.json"],
				results: "valid results",
				interpretation: "valid interpretation",
				status: "completed",
			}),
		);
		expect(internalSymExp.artifactReceipts[0]?.path).toBe("artifacts/valid.json");

		// 7. TOCTOU Defense: Revalidates containment immediately before reading during claim promotion
		addVerifiedPublication(value, 1);
		const claim = value.addClaim(
			parseAutoresearchClaimInput({
				claim_id: "claim-toctou",
				claim_text: "Empirical claim needing valid artifacts",
				claim_type: "EMPIRICAL_OBSERVATION",
				supporting_evidence: [
					{
						source_type: "experiment",
						source_id: "exp-valid",
						exact_pointer: "artifacts/valid.json",
						exact_quote: '{"valid":true}',
						demonstrates: "valid experiment output",
						interpretation: "valid interpretation",
					},
				],
			}),
		);
		// Promote claim succeeds initially
		value.promoteClaim(claim.claimId);

		// Now replace valid.json with a symlink to outsideDir/secret.json
		rmSync(join(root, "artifacts", "valid.json"));
		symlinkSync(join(outsideDir, "secret.json"), join(root, "artifacts", "valid.json"));

		// Adding/promoting a claim referencing exp-valid should fail without reading outside secret.json
		expect(() =>
			value.addClaim(
				parseAutoresearchClaimInput({
					claim_id: "claim-toctou-2",
					claim_text: "Second empirical claim",
					claim_type: "EMPIRICAL_OBSERVATION",
					supporting_evidence: [
						{
							source_type: "experiment",
							source_id: "exp-valid",
							exact_pointer: "artifacts/valid.json",
							exact_quote: '{"valid":true}',
							demonstrates: "valid experiment output",
							interpretation: "valid interpretation",
						},
					],
				}),
			),
		).toThrow("missing or modified artifact receipts");
	});
});
