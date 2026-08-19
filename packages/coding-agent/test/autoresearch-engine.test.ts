import { describe, expect, it } from "vitest";
import {
	type AutoResearchCommittedEvent,
	type AutoResearchExperimentRegistration,
	type AutoResearchHostPorts,
	type AutoResearchObservation,
	type AutoResearchRuntimeRecord,
	type AutoResearchTaskSubmission,
	createNativeExperimentEngine,
} from "../src/core/autoresearch/engine.js";
import type {
	WorkflowArtifactRef,
	WorkflowImprovementProposal,
	WorkflowResourceVector,
	WorkflowRevisionResolution,
} from "../src/core/workflow/contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";

function ref(id: string): WorkflowArtifactRef {
	return {
		artifactId: id,
		relativePath: `evidence/${id}`,
		digest: `${id}-digest`,
		sizeBytes: 1,
		sourceEventSequence: 1,
	};
}

function revisionResolution(): WorkflowRevisionResolution {
	return {
		registryEntryRef: ref("registry-entry"),
		registryEntryId: "registry-entry",
		registryEpoch: 1,
		revisionKind: "methodology",
		scope: "workflow",
		scopeBinding: { scope: "workflow", workflowId: "workflow-1" },
		registryStatus: "approved",
		compatibilityClosureDigest: "closure",
		expectedRegistryEpoch: 1,
		observedRegistryEpoch: 1,
		revocationEpoch: null,
		revocationEventSequence: null,
		rollbackOfRevisionId: null,
		rollbackEventSequence: null,
		casExecutionKey: "cas",
		hostReceipt: {} as WorkflowRevisionResolution["hostReceipt"],
		resolutionDigest: "resolution",
	};
}

function resource(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
		...overrides,
	};
}

function commandInputBinding(overrides: Partial<{ commandDigest: string; inputDigests: readonly string[] }> = {}) {
	const commandDigest = overrides.commandDigest ?? "command";
	const inputDigests = overrides.inputDigests ?? ["eval-input", "train-input"];
	return {
		commandDigest,
		inputDigests,
		bindingDigest: digestObject({ commandDigest, inputDigests }),
	};
}

const legacyMeasurementOverrides = new Map<string, AutoResearchObservation>();

function registration(overrides: Partial<AutoResearchExperimentRegistration> = {}): AutoResearchExperimentRegistration {
	return {
		runId: "run-1",
		workflowId: "workflow-1",
		revisionResolution: revisionResolution(),
		metric: { metricId: "metric-1", name: "score", direction: "lower", target: 0, tolerance: 0 },
		evaluator: { evaluatorDigest: "evaluator", parserDigest: "parser", commandDigest: "command" },
		commandInputBinding: commandInputBinding(),
		seed: { seedId: "seed-1", seedDigest: "seed" },
		fixtures: [
			{
				fixtureId: "train",
				partition: "train",
				inputDigest: "train-input",
				manifestDigest: "train-manifest",
				hidden: false,
			},
			{
				fixtureId: "eval",
				partition: "eval",
				inputDigest: "eval-input",
				manifestDigest: "eval-manifest",
				hidden: false,
			},
			{
				fixtureId: "holdout",
				partition: "holdout",
				inputDigest: "holdout-input",
				manifestDigest: "holdout-manifest",
				hidden: true,
			},
			{
				fixtureId: "adversarial",
				partition: "adversarial",
				inputDigest: "adversarial-input",
				manifestDigest: "adversarial-manifest",
				hidden: true,
			},
		],
		guard: { guardDigest: "guard" },
		requiredSampleSize: 2,
		maxCandidates: 2,
		maxVariance: 1,
		maxCostMicrounits: 10,
		maxLatencyMilliseconds: 10,
		resourceCeiling: resource({ cpuMilliCores: 2, monetaryMicrounits: 10, wallMilliseconds: 10 }),
		hiddenHoldout: {
			handleId: "holdout-handle",
			manifestDigest: "holdout-manifest",
			caseCount: 2,
			owner: "host",
			hidden: true,
			opaque: true,
			hostResolverOnly: true,
			bytesAccessibleToProposer: false,
			bytesAccessibleToWorker: false,
		},
		...overrides,
	};
}

function observation(overrides: Partial<AutoResearchObservation> = {}): AutoResearchObservation {
	const value: Omit<AutoResearchObservation, "measurementDigest"> = {
		source: "host" as const,
		observationId: "observation-1",
		candidateId: "candidate-1",
		attemptId: "attempt-1",
		phase: "exploration",
		status: "complete",
		commandInputBinding: commandInputBinding(),
		metricDirection: "lower",
		metricTarget: 0,
		metricTolerance: 0,
		sampleCount: 2,
		metricValue: 5,
		baselineMetricValue: 7,
		variance: 0,
		costMicrounits: 1,
		latencyMilliseconds: 1,
		resourceUsage: resource(),
		evaluatorDigest: "evaluator",
		parserDigest: "parser",
		guardDigest: "guard",
		seedDigest: "seed",
		fixtureManifestDigest: "eval-manifest|train-manifest",
		trainInputDigest: "train-input",
		evalInputDigest: "eval-input",
		heldOutInputDigest: null,
		proxySignals: [],
		hiddenMetricValue: null,
		adversarialMetricValue: null,
		candidateClaimedCompletion: false,
		candidateClaimedPromotion: false,
		rawResultRefsDigest: digestObject([]),
		...overrides,
	};
	const { source: _source, ...preimage } = value;
	const resolved = { ...value, measurementDigest: digestObject({ source: "host", ...preimage }) };
	legacyMeasurementOverrides.set(resolved.observationId, resolved);
	return resolved;
}

function proposal(): WorkflowImprovementProposal {
	return {
		proposalId: "proposal-1",
		workflowId: "workflow-1",
		owner: "autoresearch",
		scope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "root-1" },
		sourcePhaseOrIncident: "experiment",
		baselineRevision: 1,
		baselineDigest: "baseline",
		candidateDigest: "candidate",
		caseManifestDigest: "cases",
		baselineArtifactRef: ref("baseline"),
		candidateArtifactRef: ref("candidate"),
		trialMode: "replay",
		sampleSize: 2,
		minimumEffectSize: 1,
		tolerance: 0,
		hostAcceptedEvidenceRefs: [ref("accepted-evidence")],
		fixedEvaluatorDigest: "evaluator",
		preregisteredManifestDigest: "manifest",
		hiddenHoldoutDigest: "holdout",
		safetyInvariantDigest: "safety",
		costCeilingMicrounits: 10,
		antiGoodhartReceipt: {} as WorkflowImprovementProposal["antiGoodhartReceipt"],
		queuedAt: "2026-08-16T00:00:00Z",
		proposalEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		hiddenHoldoutManifestRef: ref("holdout"),
		registryEpoch: 1,
		registryResolutionReceipt: {} as WorkflowImprovementProposal["registryResolutionReceipt"],
		revisionResolution: revisionResolution(),
		baselineBytesDigest: "baseline-bytes",
		candidateBytesDigest: "candidate-bytes",
		proposalDigest: "proposal",
		producer: "autoresearch",
		kind: "methodology",
		baselineRevisionId: "revision-1",
		baselineRevisionDigest: "baseline-revision",
		candidateRef: ref("candidate-ref"),
		scorecardRef: ref("scorecard"),
		scorecardDigest: "scorecard",
		evaluatorRef: ref("evaluator-ref"),
		parserRef: ref("parser-ref"),
		baselineEvidenceRefs: [ref("baseline-evidence")],
		candidateEvidenceRefs: [ref("candidate-evidence")],
		queueState: "pending",
		queueRevision: 1,
		attemptId: "attempt-1",
		reviewLeaseRef: null,
		ownershipLeaseRef: null,
		epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		executionKey: "execution",
		status: "proposed",
		caseManifest: {} as WorkflowImprovementProposal["caseManifest"],
		scorecard: {} as WorkflowImprovementProposal["scorecard"],
		evaluatorContract: {} as WorkflowImprovementProposal["evaluatorContract"],
		reviewBudget: {} as WorkflowImprovementProposal["reviewBudget"],
	};
}

function ports(
	events: AutoResearchCommittedEvent[] = [],
	includeAdversarial = true,
): AutoResearchHostPorts & {
	taskSubmissions: AutoResearchTaskSubmission[];
	evidenceSubmissions: number;
	decisionSubmissions: number;
	holdoutSubmissions: number;
} {
	const taskSubmissions: AutoResearchTaskSubmission[] = [];
	let evidenceSubmissions = 0;
	let decisionSubmissions = 0;
	let holdoutSubmissions = 0;
	return {
		taskSubmissions,
		get evidenceSubmissions() {
			return evidenceSubmissions;
		},
		get decisionSubmissions() {
			return decisionSubmissions;
		},
		get holdoutSubmissions() {
			return holdoutSubmissions;
		},
		submitTask: async (input) => {
			if (taskSubmissions.some((existing) => existing.candidateId === input.candidateId))
				throw new Error("candidate task CAS conflict");
			taskSubmissions.push(input);
			return {
				taskId: input.candidateId,
				candidateId: input.candidateId,
				attemptId: input.attemptId,
				changeDigest: input.changeDigest,
				taskDigest: input.changeDigest,
			};
		},
		submitEvidence: async () => {
			evidenceSubmissions += 1;
			return ref(`evidence-${evidenceSubmissions}`);
		},
		submitDecision: async () => {
			decisionSubmissions += 1;
			return {
				decisionScope: { kind: "workflow", workflowId: "workflow-1", rootSessionId: "root-1" },
				decisionId: "decision-1",
				revision: 1,
				storeEpoch: 1,
				coordinatorEpoch: 1,
				decisionDigest: "decision-digest",
			};
		},
		resolveDecision: async (input) => {
			const resolved = {
				ref: input.ref,
				workflowId: input.workflowId,
				registrationDigest: input.registrationDigest,
				stateDigest: "state",
				headDigest: "head",
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				disposition: "authorized" as const,
				authority: ["observe_workflow"],
				fresh: true as const,
				revoked: false as const,
				receipt: {
					receiptKind: "decision" as const,
					workflowId: "workflow-1",
					oneUse: false,
					receiptId: "decision-receipt",
					issuerId: "host",
					bindingDigest: "",
					payloadDigest: input.ref.decisionDigest,
					artifactRef: ref("decision-artifact"),
					issuedAt: "2026-08-16T00:00:00Z",
					validUntil: "2099-08-16T00:00:00Z",
					keyId: "key",
					signatureAlgorithm: "ed25519" as const,
					artifactBytesDigest: "bytes",
					stateDigest: "state",
					revision: 1,
					signature: "signature",
					verificationDigest: "verification",
				},
				resolutionDigest: "",
			};
			resolved.receipt.bindingDigest = digestObject({
				workflowId: resolved.workflowId,
				registrationDigest: resolved.registrationDigest,
				decisionRef: resolved.ref,
				stateDigest: resolved.stateDigest,
				headDigest: resolved.headDigest,
				epochRef: resolved.epochRef,
			});
			resolved.receipt.verificationDigest = digestObject({ ...resolved.receipt, verificationDigest: "" });
			const { resolutionDigest: _ignored, ...preimage } = resolved;
			return { ...resolved, resolutionDigest: digestObject(preimage) };
		},
		submitProposal: async () => proposal(),
		submitAcceptedProposal: async ({ transactionDigest, proposal: proposalInput }) => {
			const evidenceRef = ref("accepted-evidence");
			const evidenceProof = {
				ref: evidenceRef,
				workflowId: "workflow-1",
				registrationDigest: proposalInput.registrationDigest,
				kind: "observation" as const,
				authenticated: true as const,
				fresh: true as const,
				revoked: false as const,
				proofDigest: "",
			};
			const { proofDigest: _ignored, ...preimage } = evidenceProof;
			return {
				transactionDigest,
				evidenceRef,
				evidenceProof: { ...evidenceProof, proofDigest: digestObject(preimage) },
				proposal: proposal(),
			};
		},
		submitHoldout: async (input) => {
			holdoutSubmissions += 1;
			return {
				handleId: input.handle.handleId,
				manifestDigest: input.handle.manifestDigest,
				resolverContext: {
					contextId: "holdout-context",
					workflowId: "workflow-1",
					registrationDigest: input.registrationDigest,
					handleId: input.handle.handleId,
					manifestDigest: input.handle.manifestDigest,
					stateDigest: "state",
					epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
					authenticated: true,
					returnsEvidenceOnly: true,
					returnsBytes: false,
					resolverDigest: "resolver",
				},
				evidenceRefs: [ref("holdout-evidence")],
				adversarialEvidenceRefs: includeAdversarial ? [ref("adversarial-evidence")] : [],
				evidenceProofs: [
					{
						ref: ref("holdout-evidence"),
						workflowId: "workflow-1",
						registrationDigest: input.registrationDigest,
						kind: "holdout" as const,
						authenticated: true as const,
						fresh: true as const,
						revoked: false as const,
						proofDigest: "",
					},
				].map((proof) => {
					const { proofDigest: _ignored, ...preimage } = proof;
					return { ...proof, proofDigest: digestObject(preimage) };
				}),
				adversarialEvidenceProofs: includeAdversarial
					? [
							{
								ref: ref("adversarial-evidence"),
								workflowId: "workflow-1",
								registrationDigest: input.registrationDigest,
								kind: "adversarial" as const,
								authenticated: true as const,
								fresh: true as const,
								revoked: false as const,
								proofDigest: "",
							},
						].map((proof) => {
							const { proofDigest: _ignored, ...preimage } = proof;
							return { ...proof, proofDigest: digestObject(preimage) };
						})
					: [],
				bytesReturned: false,
			};
		},
		measureObservation: async (input) => {
			const legacy = legacyMeasurementOverrides.get(input.observationId);
			if (legacy === undefined) throw new Error("test host has no resolved measurement");
			const measurement = {
				source: "host" as const,
				measurementDigest: "",
				rawResultRefsDigest: digestObject(input.rawResultRefs),
				phase: legacy.phase,
				status: legacy.status,
				commandInputBinding: legacy.commandInputBinding,
				metricDirection: legacy.metricDirection,
				metricTarget: legacy.metricTarget,
				metricTolerance: legacy.metricTolerance,
				sampleCount: legacy.sampleCount,
				metricValue: legacy.metricValue,
				baselineMetricValue: legacy.baselineMetricValue,
				variance: legacy.variance,
				fixtureManifestDigest: legacy.fixtureManifestDigest,
				trainInputDigest: legacy.trainInputDigest,
				evalInputDigest: legacy.evalInputDigest,
				heldOutInputDigest: legacy.heldOutInputDigest,
				evaluatorDigest: legacy.evaluatorDigest,
				parserDigest: legacy.parserDigest,
				guardDigest: legacy.guardDigest,
				seedDigest: legacy.seedDigest,
				proxySignals: legacy.proxySignals,
				costMicrounits: legacy.costMicrounits,
				latencyMilliseconds: legacy.latencyMilliseconds,
				resourceUsage: legacy.resourceUsage,
				hiddenMetricValue: legacy.hiddenMetricValue,
				adversarialMetricValue: legacy.adversarialMetricValue,
				candidateClaimedCompletion: false as const,
				candidateClaimedPromotion: false as const,
			};
			const { measurementDigest: _ignored, ...preimage } = measurement;
			return { ...measurement, measurementDigest: digestObject(preimage) };
		},
		runtime: {
			replay: async () => events.map((event) => ({ event }) as unknown as AutoResearchRuntimeRecord),
			commit: async ({ event }) => {
				if (
					event.kind === "candidate_submitted" &&
					events.some(
						(existing) =>
							existing.kind === "candidate_submitted" &&
							existing.request.candidateId === event.request.candidateId,
					)
				)
					throw new Error("candidate CAS conflict");
				events.push(event);
				return { event } as unknown as AutoResearchRuntimeRecord;
			},
		},
	};
}

async function initialized(overrides: Partial<AutoResearchExperimentRegistration> = {}) {
	const host = ports();
	const engine = await createNativeExperimentEngine(host);
	await engine.preRegister(registration(overrides));
	await engine.lock();
	await engine.submitCandidate({
		candidateId: "candidate-1",
		attemptId: "attempt-1",
		changeDigest: "candidate",
		baseRevisionDigest: "baseline",
		resourceRequest: resource(),
		claimedCompletion: false,
		claimedPromotion: false,
	});
	return { engine, host };
}

describe("native AutoResearch engine", () => {
	it("locks metric, evaluator, seed, fixtures, and host revision before submission", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await expect(
			engine.preRegister(
				registration({
					evaluator: { evaluatorDigest: "changed", parserDigest: "parser", commandDigest: "command" },
				}),
			),
		).rejects.toThrow(/lock|digest/i);
	});

	it("rejects an inadequate sample while retaining rejected evidence", async () => {
		const { engine, host } = await initialized();
		const result = await engine.recordObservation(observation({ sampleCount: 1 }));
		expect(result.accepted).toBe(false);
		expect(host.evidenceSubmissions).toBe(1);
		expect(result.proposal).toBeNull();
		expect((await engine.snapshot()).observationIds).toEqual(["observation-1"]);
	});

	it.each([
		["train/eval leakage", { trainInputDigest: "eval-input" }],
		["proxy exploitation", { proxySignals: ["proxy-only-win"] }],
		["unstable variance", { variance: 2 }],
		["hidden degradation", { hiddenMetricValue: 9 }],
		["adversarial degradation", { adversarialMetricValue: 9 }],
		["modified evaluator", { evaluatorDigest: "modified" }],
		["modified guard", { guardDigest: "modified-guard" }],
	] as const)("rejects %s without a proposal", async (_name, overrides) => {
		const { engine } = await initialized();
		const result = await engine.recordObservation(observation(overrides));
		expect(result.accepted).toBe(false);
		expect(result.proposal).toBeNull();
	});

	it("rejects repeated holdout peeking and does not reuse partial or crashed observations", async () => {
		const { engine } = await initialized();
		const first = await engine.recordObservation(
			observation({ phase: "holdout", heldOutInputDigest: "holdout-input" }),
		);
		expect(first.accepted).toBe(true);
		await expect(
			engine.recordObservation(
				observation({ observationId: "observation-2", phase: "holdout", heldOutInputDigest: "holdout-input" }),
			),
		).resolves.toMatchObject({ accepted: false });
		await expect(
			engine.recordObservation(observation({ observationId: "observation-3", status: "partial" })),
		).resolves.toMatchObject({ accepted: false });
		await expect(
			engine.recordObservation(observation({ observationId: "observation-3", status: "complete" })),
		).rejects.toThrow(/reuse|partial|crash|observation/i);
	});

	it("rejects self-promotion and completion claims at task submission", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await expect(
			engine.submitCandidate({
				candidateId: "candidate-1",
				attemptId: "attempt-1",
				changeDigest: "candidate",
				baseRevisionDigest: "baseline",
				resourceRequest: resource(),
				claimedCompletion: true,
				claimedPromotion: false,
			}),
		).rejects.toThrow(/promot|complet|authority/i);
	});

	it("enforces candidate budgets and resource ceilings", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration({ maxCostMicrounits: 1, resourceCeiling: resource({ cpuMilliCores: 1 }) }));
		await engine.lock();
		await expect(
			engine.submitCandidate({
				candidateId: "candidate-1",
				attemptId: "attempt-1",
				changeDigest: "candidate",
				baseRevisionDigest: "baseline",
				resourceRequest: resource({ cpuMilliCores: 2 }),
				claimedCompletion: false,
				claimedPromotion: false,
			}),
		).rejects.toThrow(/resource|ceiling/i);
	});

	it("submits exactly one opaque host holdout and never receives bytes", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await engine.lock();
		expect(host.holdoutSubmissions).toBe(1);
	});

	it("reconstructs state from committed events after restart", async () => {
		const host = ports();
		const first = await createNativeExperimentEngine(host);
		await first.preRegister(registration());
		await first.lock();
		await first.submitCandidate({
			candidateId: "candidate-1",
			attemptId: "attempt-1",
			changeDigest: "candidate",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		await first.recordObservation(observation());
		const before = await first.snapshot();
		const restarted = await createNativeExperimentEngine(host);
		const after = await restarted.snapshot();
		expect(after.registrationDigest).toBe(before.registrationDigest);
		expect(after.candidateIds).toEqual(before.candidateIds);
		expect(after.observationIds).toEqual(before.observationIds);
		expect(after.proposalIds).toEqual(before.proposalIds);
		await expect(
			restarted.submitCandidate({
				candidateId: "candidate-1",
				attemptId: "attempt-1b",
				changeDigest: "candidate-2",
				baseRevisionDigest: "baseline",
				resourceRequest: resource(),
				claimedCompletion: false,
				claimedPromotion: false,
			}),
		).rejects.toThrow(/duplicate|candidate/i);
	});

	it("serializes candidate claims against one host runtime", async () => {
		const host = ports();
		const first = await createNativeExperimentEngine(host);
		const second = await createNativeExperimentEngine(host);
		await first.preRegister(registration());
		await first.lock();
		const request = {
			candidateId: "candidate-race",
			attemptId: "attempt-race",
			changeDigest: "candidate-race",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		};
		const results = await Promise.allSettled([second.submitCandidate(request), first.submitCandidate(request)]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		expect(host.taskSubmissions).toHaveLength(1);
	});

	it("rejects fixture input leakage across every partition", async () => {
		const engine = await createNativeExperimentEngine(ports());
		await expect(
			engine.preRegister(
				registration({
					fixtures: registration().fixtures.map((fixture) =>
						fixture.partition === "adversarial" ? { ...fixture, inputDigest: "train-input" } : fixture,
					),
				}),
			),
		).rejects.toThrow(/leak|duplicate/i);
	});

	it("requires a host holdout handle when a holdout partition is registered", async () => {
		const engine = await createNativeExperimentEngine(ports());
		await expect(engine.preRegister(registration({ hiddenHoldout: null }))).rejects.toThrow(/holdout|mandatory/i);
	});

	it("requires distinct opaque holdout and adversarial evidence at promotion", async () => {
		const host = ports([], false);
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(
			registration({
				metric: { metricId: "metric-1", name: "score", direction: "lower", target: 6, tolerance: 0 },
			}),
		);
		await engine.lock();
		await engine.submitCandidate({
			candidateId: "candidate-1",
			attemptId: "attempt-1",
			changeDigest: "candidate",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		const result = await engine.recordObservation(
			observation({ phase: "promotion", metricTarget: 6, metricDirection: "lower", metricTolerance: 0 }),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toMatch(/holdout|adversarial/i);
	});

	it("uses direction, target, and tolerance for host promotion decisions", async () => {
		const { engine } = await initialized({
			metric: { metricId: "metric-1", name: "score", direction: "higher", target: 10, tolerance: 0.25 },
		});
		const result = await engine.recordObservation(
			observation({
				phase: "promotion",
				metricValue: 8,
				baselineMetricValue: 7,
				metricDirection: "higher",
				metricTarget: 10,
				metricTolerance: 0.25,
			}),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toMatch(/target|metric|hidden|adversarial/i);
	});

	it("requires finite hidden and adversarial host measurements before emitting a promotion proposal", async () => {
		const { engine } = await initialized({
			metric: { metricId: "metric-1", name: "score", direction: "lower", target: 6, tolerance: 0 },
		});
		const result = await engine.recordObservation(
			observation({
				phase: "promotion",
				metricDirection: "lower",
				metricTarget: 6,
				metricTolerance: 0,
				metricValue: 5,
				baselineMetricValue: 7,
				hiddenMetricValue: 5,
				adversarialMetricValue: 5,
			}),
		);
		expect(result.accepted).toBe(true);
		expect(result.proposal).not.toBeNull();
	});

	it("publishes accepted evidence only through the host transaction that validates its proposal", async () => {
		const { engine, host } = await initialized();
		host.submitEvidence = async () => {
			throw new Error("accepted evidence escaped the host transaction");
		};
		const result = await engine.recordObservation(observation());
		expect(result.accepted).toBe(true);
		expect(result.proposal).not.toBeNull();
	});

	it("rejects worker completion and promotion claims", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await expect(
			engine.submitCandidate({
				candidateId: "candidate-claim",
				attemptId: "attempt-claim",
				changeDigest: "candidate",
				baseRevisionDigest: "baseline",
				resourceRequest: resource(),
				claimedCompletion: false,
				claimedPromotion: true,
			}),
		).rejects.toThrow(/promot|complet|authority/i);
	});

	it("rejects completion claims embedded in worker observations", async () => {
		const { engine } = await initialized();
		const result = await engine.recordObservation(observation({ claimedCompletion: true }));
		expect(result.accepted).toBe(true);
		expect(result.proposal).not.toBeNull();
	});

	it("does not treat a tolerance tie as a strict improvement", async () => {
		const { engine } = await initialized({
			metric: { metricId: "metric-1", name: "score", direction: "lower", target: 8, tolerance: 1 },
		});
		const result = await engine.recordObservation(
			observation({ metricValue: 7, baselineMetricValue: 7, metricTarget: 8, metricTolerance: 1 }),
		);
		expect(result.accepted).toBe(false);
		expect(result.reason).toMatch(/improve/i);
	});

	it("rejects malformed replay lifecycle and duplicate events", async () => {
		const host = ports([
			{
				kind: "candidate_submitted",
				registrationDigest: "registration",
				commandInputBinding: commandInputBinding(),
				request: {
					candidateId: "candidate-1",
					attemptId: "attempt-1",
					changeDigest: "candidate",
					baseRevisionDigest: "baseline",
					resourceRequest: resource(),
					claimedCompletion: false,
					claimedPromotion: false,
				},
				task: {
					taskId: "candidate-1",
					candidateId: "candidate-1",
					attemptId: "attempt-1",
					changeDigest: "candidate",
					taskDigest: "candidate",
				},
				candidateBindingDigest: "invalid",
			},
		]);
		await expect(createNativeExperimentEngine(host)).rejects.toThrow(/replay|lifecycle|registration/i);
	});

	it("keeps the pre-registered configuration immutable before and after lock", async () => {
		const host = ports();
		const engine = await createNativeExperimentEngine(host);
		const config = registration();
		const digest = await engine.preRegister(config);
		config.metric.target = 999;
		config.fixtures[0]!.inputDigest = "mutated-input";
		await engine.lock();
		expect((await engine.snapshot()).registrationDigest).toBe(digest);
		await engine.submitCandidate({
			candidateId: "immutable-candidate",
			attemptId: "immutable-attempt",
			changeDigest: "immutable-change",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		expect(host.taskSubmissions[0]?.commandInputBinding.inputDigests).toEqual(["eval-input", "train-input"]);
	});

	it("uses host-derived sample and variance instead of worker-reported values", async () => {
		const { engine, host } = await initialized();
		const measure = host.measureObservation!;
		host.measureObservation = async (input) => {
			const measured = await measure(input);
			const altered = { ...measured, sampleCount: 1, variance: 0 };
			const { measurementDigest: _ignored, ...preimage } = altered;
			return { ...altered, measurementDigest: digestObject(preimage) };
		};
		const result = await engine.recordObservation(observation({ sampleCount: 999, variance: 0 }));
		expect(result.accepted).toBe(false);
		expect(result.reason).toMatch(/sample/i);
	});

	it("rejects a host measurement whose command binding changes", async () => {
		const { engine, host } = await initialized();
		const measure = host.measureObservation!;
		host.measureObservation = async (input) => {
			const measured = await measure(input);
			const changedBinding = commandInputBinding({ commandDigest: "changed-command" });
			const altered = { ...measured, commandInputBinding: changedBinding };
			const { measurementDigest: _ignored, ...preimage } = altered;
			return { ...altered, measurementDigest: digestObject(preimage) };
		};
		await expect(engine.recordObservation(observation())).rejects.toThrow(/binding/i);
	});

	it("rejects a duplicated registration event during replay", async () => {
		const events: AutoResearchCommittedEvent[] = [];
		const host = ports(events);
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		events.push(events[0]!);
		await expect(createNativeExperimentEngine(host)).rejects.toThrow(/replay|lock|lifecycle/i);
	});

	it("rejects replayed observation bytes whose host measurement digest no longer matches", async () => {
		const events: AutoResearchCommittedEvent[] = [];
		const host = ports(events);
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await engine.submitCandidate({
			candidateId: "candidate-1",
			attemptId: "attempt-1",
			changeDigest: "candidate",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		await engine.recordObservation(observation());
		const index = events.findIndex((event) => event.kind === "accepted_proposal_committed");
		const event = events[index] as Extract<AutoResearchCommittedEvent, { kind: "accepted_proposal_committed" }>;
		events[index] = { ...event, observation: { ...event.observation, sampleCount: 999 } };
		await expect(createNativeExperimentEngine(host)).rejects.toThrow(/measurement|replay|integrity/i);
	});

	it("requires a resolver-verified decision bound to the workflow and current authority", async () => {
		const host = ports();
		host.resolveDecision = async (input) => ({
			ref: input.ref,
			workflowId: input.workflowId,
			registrationDigest: input.registrationDigest,
			stateDigest: "",
			headDigest: "",
			epochRef: { storeEpoch: 0, coordinatorEpoch: 0 },
			disposition: "authorized",
			authority: [],
			fresh: true,
			revoked: false,
			receipt: {} as never,
			resolutionDigest: "forged",
		});
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await expect(engine.lock()).rejects.toThrow(/decision|resolver|authority|epoch/i);
	});

	it("rejects target and tolerance arithmetic that overflows before locking", async () => {
		const engine = await createNativeExperimentEngine(ports());
		await expect(
			engine.preRegister(
				registration({
					metric: {
						metricId: "metric-1",
						name: "score",
						direction: "lower",
						target: Number.MAX_VALUE,
						tolerance: Number.MAX_VALUE,
					},
				}),
			),
		).rejects.toThrow(/finite|overflow|target|tolerance/i);
	});

	it("validates rejected replay measurements before any accounting accumulation", async () => {
		const events: AutoResearchCommittedEvent[] = [];
		const host = ports(events);
		const engine = await createNativeExperimentEngine(host);
		await engine.preRegister(registration());
		await engine.lock();
		await engine.submitCandidate({
			candidateId: "candidate-1",
			attemptId: "attempt-1",
			changeDigest: "candidate",
			baseRevisionDigest: "baseline",
			resourceRequest: resource(),
			claimedCompletion: false,
			claimedPromotion: false,
		});
		const rejected = await engine.recordObservation(observation({ sampleCount: 1 }));
		expect(rejected.accepted).toBe(false);
		const index = events.findIndex((event) => event.kind === "observation_recorded");
		const event = events[index] as Extract<AutoResearchCommittedEvent, { kind: "observation_recorded" }>;
		events[index] = {
			...event,
			observation: { ...event.observation, costMicrounits: Number.NaN },
		};
		await expect(createNativeExperimentEngine(host)).rejects.toThrow(/finite|numeric|replay|account/i);
	});

	it("does not trust worker phase, status, evaluator, proxy, accounting, or resource fields", async () => {
		const { engine } = await initialized();
		const trusted = observation({ observationId: "raw-observation" });
		const forgedWorkerObservation = observation({
			observationId: trusted.observationId,
			phase: "completion",
			status: "crashed",
			evaluatorDigest: "worker-evaluator",
			proxySignals: ["worker-proxy"],
			costMicrounits: Number.MAX_SAFE_INTEGER,
			resourceUsage: resource({ cpuMilliCores: Number.MAX_SAFE_INTEGER }),
			claimedCompletion: true,
			claimedPromotion: true,
		});
		legacyMeasurementOverrides.set(trusted.observationId, trusted);
		const result = await engine.recordObservation(forgedWorkerObservation);
		expect(result.accepted).toBe(true);
		expect(result.proposal).not.toBeNull();
	});
});
