import { describe, expect, it } from "vitest";
import type {
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowCloudAvailabilityRequest,
	WorkflowControlCapacityVector,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowResourceEnvelopeDraft,
	WorkflowResourceGrantLedger,
	WorkflowResourceVector,
} from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
} from "../src/core/workflow/contracts.js";
import {
	assertFiniteWorkflowResourceVector,
	bindWorkflowResourceDecision,
	buildWorkflowResourceEnvelope,
	deriveWorkflowResourceAdmission,
	discoverWorkflowCapacity,
	maxWorkflowResourceVectors,
	publishWorkflowResourceEnvelope,
	resolveWorkflowExecutionCeilings,
	sumWorkflowControlCapacity,
	zeroWorkflowResourceVector,
} from "../src/core/workflow/resources.js";

function vector(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 2_000,
		memoryBytes: 4_000,
		diskBytes: 8_000,
		ioWeight: 2,
		accelerators: [],
		providers: [],
		networkEgressBytes: 100,
		wallMilliseconds: 1_000,
		monetaryMicrounits: 20,
		...overrides,
	};
}

function control(overrides: Partial<WorkflowControlCapacityVector> = {}): WorkflowControlCapacityVector {
	return {
		processSlots: 4,
		childSessionSlots: 2,
		modelCallSlots: 3,
		modelInputTokens: 2_000,
		modelOutputTokens: 1_000,
		verificationSlots: 1,
		redTeamSlots: 1,
		recoverySlots: 1,
		...overrides,
	};
}

const ref: WorkflowArtifactRef = {
	artifactId: "ledger",
	relativePath: "ledger.json",
	digest: "ledger-digest",
	sizeBytes: 1,
	sourceEventSequence: 0,
};

function draftForWorkflow(workflowId: string): WorkflowResourceEnvelopeDraft {
	const fields: Omit<WorkflowResourceEnvelopeDraft, "draftDigest"> = {
		envelopeId: `envelope:${workflowId}`,
		resources: vector(),
		controlPlaneReserve: zeroWorkflowResourceVector(),
		controlPlaneReserveCapacity: zeroControl(),
		controlCapacity: zeroControl(),
		workerCapacity: zeroControl(),
		processSlots: 1,
		childSessionSlots: 0,
		candidateSlots: 0,
		executionCeilings: resolveWorkflowExecutionCeilings(undefined),
		providerQuotaSnapshotRef: ref,
		inventoryDigest: "inventory",
		pricingDigest: "pricing",
		terminationPolicyDigest: "termination",
		billingReconciliationPolicyDigest: "billing",
		egressPolicyDigest: "egress",
		validFrom: "2026-08-15T00:00:00.000Z",
		validUntil: "2026-08-15T00:05:00.000Z",
		capacityReceipt: null,
		approvalDecisionRef: null,
		canonicalLedgerRef: ref,
		canonicalLedgerDigest: "ledger-digest",
	};
	return { ...fields, draftDigest: digestObject({ ...fields, workflowId }) };
}

function workflowDecision(workflowId: string): WorkflowDecisionRef {
	return {
		decisionScope: { kind: "workflow", workflowId, rootSessionId: "session-1" },
		decisionId: "resource-decision",
		revision: 1,
		storeEpoch: 1,
		coordinatorEpoch: 1,
		decisionDigest: "decision-digest",
	};
}

function workflowEpoch(): WorkflowEpochRef {
	return { storeEpoch: 1, coordinatorEpoch: 1 };
}

function ledger(overrides: Partial<WorkflowResourceGrantLedger> = {}): WorkflowResourceGrantLedger {
	const poolLedger = {
		artifactRef: ref,
		digest: "ledger-digest",
		workflowId: "wf-1",
		approvedEnvelopeDigest: "envelope",
		approvedPools: { local: vector() },
		canonicalPoolLedger: undefined,
		canonicalLedgerRef: ref,
		canonicalLedgerDigest: "ledger-digest",
	} as unknown as WorkflowResourceGrantLedger["canonicalPoolLedger"];
	return {
		workflowId: "wf-1",
		revision: 1,
		entries: [],
		resourceTotal: vector(),
		spendTotalMicrounits: 0,
		headDigest: "head",
		canonicalLedgerRef: ref,
		canonicalLedgerDigest: "ledger-digest",
		workerTotal: control({ processSlots: 2, childSessionSlots: 1 }),
		controlTotal: control(),
		instantaneousByPool: {},
		cumulativeByPool: {},
		instantaneousSpendByPool: {},
		cumulativeSpendByPool: {},
		instantaneousWorkerCapacity: control({ processSlots: 2, childSessionSlots: 1 }),
		instantaneousControlCapacity: control(),
		cumulativeWorkerCapacity: control({ processSlots: 2, childSessionSlots: 1 }),
		cumulativeControlCapacity: control(),
		canonicalPoolLedger: poolLedger,
		approvedEnvelopeDigest: "envelope",
		envelopeCapacityCasDigest: "capacity-cas",
		...overrides,
	};
}

function request(): WorkflowCloudAvailabilityRequest {
	return {
		requestId: "capacity-1",
		provider: "provider-a",
		accountRef: "account-a",
		region: "region-a",
		credentialRef: "credential-a",
		requestedVector: vector(),
		egressPolicyDigest: "egress",
		quotaPolicyDigest: "quota",
		pricingPolicyDigest: "pricing",
		billingPolicyDigest: "billing",
		terminationPolicyDigest: "termination",
		timeoutMilliseconds: 5_000,
		requestedAt: "2026-08-15T00:00:00.000Z",
	};
}

describe("workflow resources", () => {
	it("rejects a resource draft from one workflow when bound with another workflow decision", () => {
		expect(() =>
			bindWorkflowResourceDecision(draftForWorkflow("wf-2"), workflowDecision("wf-1"), workflowEpoch(), "wf-1"),
		).toThrow(/workflow|identity|bound/i);
		expect(() =>
			bindWorkflowResourceDecision(draftForWorkflow("wf-1"), workflowDecision("wf-2"), workflowEpoch(), "wf-1"),
		).toThrow(/workflow|identity|bound/i);
	});

	it("rejects a non-clock trusted receipt before publishing a resource envelope", async () => {
		const trustedReceipt = createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: "artifact-trusted-clock",
			issuerId: "host",
			workflowId: "wf-1",
			bindingDigest: "not-a-resource-publication-binding",
			payloadDigest: "payload",
			artifactRef: ref,
			issuedAt: "2026-08-15T00:00:00.000Z",
			validUntil: "2026-08-15T00:05:00.000Z",
			keyId: "key",
		});
		await expect(
			publishWorkflowResourceEnvelope({
				workflowId: "wf-1",
				draft: draftForWorkflow("wf-1"),
				decisionRef: workflowDecision("wf-1"),
				expectedEpoch: workflowEpoch(),
				trustedClockReceipt: trustedReceipt,
				store: {
					compareAndSwap: async () => {
						throw new Error("resource envelope should not be published");
					},
					read: async () => null,
				},
				receiptContext: createFixtureHostReceiptConsumerContext(),
				currentStateDigest: "state",
				currentRevision: 1,
			}),
		).rejects.toThrow(/clock/i);
	});

	it("rejects non-finite local capacity and keeps exact provider/accelerator pools when taking maxima", () => {
		expect(() => maxWorkflowResourceVectors(vector({ cpuMilliCores: Number.NaN }), vector())).toThrow(/finite/i);
		expect(() => assertFiniteWorkflowResourceVector(vector({ cpuMilliCores: 0.5 }))).toThrow(/integer|safe/i);
		expect(() =>
			assertFiniteWorkflowResourceVector(
				vector({
					accelerators: [{ poolId: "gpu", deviceType: "A", count: Number.MAX_SAFE_INTEGER + 1, memoryBytes: 1 }],
				}),
			),
		).toThrow(/integer|safe/i);
		expect(() =>
			assertFiniteWorkflowResourceVector(
				vector({
					providers: [
						{
							poolId: "api",
							concurrentRequests: 1,
							requestsPerMinute: 2,
							totalRequests: Number.MAX_SAFE_INTEGER + 1,
							inputTokens: 4,
							outputTokens: 5,
							idempotency: "provider_native",
						},
					],
				}),
			),
		).toThrow(/integer|safe/i);
		const left = vector({
			accelerators: [{ poolId: "gpu", deviceType: "A", count: 1, memoryBytes: 100 }],
			providers: [
				{
					poolId: "api",
					concurrentRequests: 1,
					requestsPerMinute: 2,
					totalRequests: 3,
					inputTokens: 4,
					outputTokens: 5,
					idempotency: "provider_native",
				},
			],
		});
		const right = vector({
			accelerators: [{ poolId: "gpu", deviceType: "B", count: 9, memoryBytes: 900 }],
			providers: [
				{
					poolId: "other-api",
					concurrentRequests: 9,
					requestsPerMinute: 8,
					totalRequests: 7,
					inputTokens: 6,
					outputTokens: 5,
					idempotency: "host_reconciled",
				},
			],
		});
		const result = maxWorkflowResourceVectors(left, right);
		expect(result.accelerators).toHaveLength(2);
		expect(result.providers.map((entry) => entry.poolId)).toEqual(["api", "other-api"]);
	});

	it("treats unknown cloud dimensions as zero while preserving a published typed request", async () => {
		const cloudRequest = request();
		const local = vector();
		const requestRef = {
			artifactId: "cloud-request:capacity-1",
			relativePath: "evidence/cloud-request:capacity-1.json",
			digest: sha256Hex(canonicalJsonBytes(cloudRequest)),
			sizeBytes: canonicalJsonBytes(cloudRequest).byteLength,
			sourceEventSequence: 0,
		};
		const localRef = {
			artifactId: "local-capacity:capacity-1",
			relativePath: "evidence/local-capacity:capacity-1.json",
			digest: sha256Hex(canonicalJsonBytes(local)),
			sizeBytes: canonicalJsonBytes(local).byteLength,
			sourceEventSequence: 0,
		};
		const receiptContext = createFixtureHostReceiptConsumerContext();
		const trustedClockReceipt = createFixtureHostReceipt({
			receiptKind: "clock",
			receiptId: "clock",
			issuerId: "host",
			workflowId: "wf-1",
			bindingDigest: digestObject(cloudRequest),
			payloadDigest: "clock",
			artifactRef: ref,
			issuedAt: cloudRequest.requestedAt,
			validUntil: "2026-08-15T00:05:00.000Z",
			keyId: "key",
			stateDigest: "state",
		});
		const result = await discoverWorkflowCapacity({
			workflowId: "wf-1",
			request: cloudRequest,
			probe: {
				local: async () => local,
				cloud: async (received) => ({
					requestDigest: digestObject(received),
					status: "unknown" as const,
					provider: received.provider,
					accountRef: received.accountRef,
					region: received.region,
					capacityArtifactRef: null,
					pricingArtifactRef: null,
					pricingDigest: null,
					authorityDigest: null,
					credentialArtifactRef: null,
					quotaArtifactRef: null,
					rateLimitArtifactRef: null,
					billingArtifactRef: null,
					egressArtifactRef: null,
					terminationArtifactRef: null,
					responseArtifactRef: null,
					responseReceipt: null,
					responseKeyId: null,
					responseMac: null,
					responseChecksum: null,
					validUntil: null,
					reasonCode: "unknown_quota" as const,
				}),
			},
			artifactPublisher: {
				publish: async (input) => ({
					status: "published" as const,
					envelope: {
						ref: input.idempotencyKey.startsWith("cloud-request") ? requestRef : localRef,
						payloadKind: input.payloadKind,
						codec: input.codec,
						immutable: true,
					},
				}),
			},
			artifactResolver: {
				resolve: async (artifact) => ({
					envelope: { ref: artifact, payloadKind: "evidence", codec: "canonical_json", immutable: true },
					exists: true,
					bytes: new Uint8Array(),
					verifiedDigest: artifact.digest,
					verifiedSizeBytes: artifact.sizeBytes,
				}),
			},
			cloudEvidenceVerifier: { verify: async () => undefined },
			receiptContext,
			trustedClockReceipt,
			currentStateDigest: "state",
			currentRevision: 1,
		});
		expect(result.cloudVector).toEqual({
			cpuMilliCores: 0,
			memoryBytes: 0,
			diskBytes: 0,
			ioWeight: 0,
			accelerators: [],
			providers: [],
			networkEgressBytes: 0,
			wallMilliseconds: 0,
			monetaryMicrounits: 0,
		});
		expect(result.cloudUnknownPoolIds).toEqual([
			"authority",
			"billing",
			"credential",
			"egress",
			"pricing",
			"quota",
			"rate_limit",
			"region",
			"termination",
		]);
		expect(result.cloudRequestRef).toEqual(requestRef);
	});

	it("rejects an expired cloud response receipt at the trusted observation time", async () => {
		const cloudRequest = request();
		const fixtureContext = createFixtureHostReceiptConsumerContext();
		const capacityBytes = canonicalJsonBytes(vector());
		const responseBytes = canonicalJsonBytes({ response: "signed" });
		const evidence = (artifactId: string, bytes: Uint8Array): WorkflowArtifactRef => ({
			artifactId,
			relativePath: `evidence/${artifactId}.json`,
			digest: sha256Hex(bytes),
			sizeBytes: bytes.byteLength,
			sourceEventSequence: 1,
		});
		const capacityRef = evidence("capacity", capacityBytes);
		const responseRef = evidence("response", responseBytes);
		const pricingRef = evidence("pricing", canonicalJsonBytes({ pricing: true }));
		const credentialRef = evidence("credential", canonicalJsonBytes({ credential: true }));
		const quotaRef = evidence("quota", canonicalJsonBytes({ quota: true }));
		const rateLimitRef = evidence("rate-limit", canonicalJsonBytes({ rateLimit: true }));
		const billingRef = evidence("billing", canonicalJsonBytes({ billing: true }));
		const egressRef = evidence("egress", canonicalJsonBytes({ egress: true }));
		const terminationRef = evidence("termination", canonicalJsonBytes({ termination: true }));
		const responseWithoutReceipt = {
			requestDigest: digestObject(cloudRequest),
			status: "available" as const,
			provider: cloudRequest.provider,
			accountRef: cloudRequest.accountRef,
			region: cloudRequest.region,
			capacityArtifactRef: capacityRef,
			pricingArtifactRef: pricingRef,
			pricingDigest: "pricing",
			authorityDigest: "authority",
			credentialArtifactRef: credentialRef,
			quotaArtifactRef: quotaRef,
			rateLimitArtifactRef: rateLimitRef,
			billingArtifactRef: billingRef,
			egressArtifactRef: egressRef,
			terminationArtifactRef: terminationRef,
			responseArtifactRef: responseRef,
			responseReceipt: null,
			responseKeyId: "response-key",
			responseMac: "response-mac",
			responseChecksum: "response-checksum",
			validUntil: "2026-08-15T00:02:00.000Z",
			reasonCode: "reported_available" as const,
		};
		const responseBindingDigest = digestObject({
			requestDigest: digestObject(cloudRequest),
			responseArtifactRef: responseRef,
			capacityArtifactRef: capacityRef,
			pricingArtifactRef: pricingRef,
			credentialArtifactRef: credentialRef,
			quotaArtifactRef: quotaRef,
			rateLimitArtifactRef: rateLimitRef,
			billingArtifactRef: billingRef,
			egressArtifactRef: egressRef,
			terminationArtifactRef: terminationRef,
			capacityDigest: capacityRef.digest,
			pricingDigest: pricingRef.digest,
			credentialDigest: credentialRef.digest,
			quotaDigest: quotaRef.digest,
			rateLimitDigest: rateLimitRef.digest,
			billingDigest: billingRef.digest,
			egressDigest: egressRef.digest,
			terminationDigest: terminationRef.digest,
			responseDigest: sha256Hex(responseBytes),
		});
		const responseReceipt = createFixtureHostReceipt({
			receiptKind: "artifact",
			receiptId: "cloud-response-receipt",
			issuerId: "cloud-host",
			workflowId: "wf-1",
			bindingDigest: responseBindingDigest,
			payloadDigest: responseRef.digest,
			artifactRef: ref,
			issuedAt: "2026-08-15T00:00:00.000Z",
			validUntil: "2026-08-15T00:00:30.000Z",
			keyId: "key",
			stateDigest: "state",
		});
		const response = { ...responseWithoutReceipt, responseReceipt };
		const artifactBytes = new Map<string, Uint8Array>([
			[capacityRef.digest, capacityBytes],
			[responseRef.digest, responseBytes],
			[pricingRef.digest, canonicalJsonBytes({ pricing: true })],
			[credentialRef.digest, canonicalJsonBytes({ credential: true })],
			[quotaRef.digest, canonicalJsonBytes({ quota: true })],
			[rateLimitRef.digest, canonicalJsonBytes({ rateLimit: true })],
			[billingRef.digest, canonicalJsonBytes({ billing: true })],
			[egressRef.digest, canonicalJsonBytes({ egress: true })],
			[terminationRef.digest, canonicalJsonBytes({ termination: true })],
		]);
		const receiptContext = {
			...fixtureContext,
			artifactResolver: {
				resolve: async (artifact: WorkflowArtifactRef): Promise<WorkflowArtifactReadResult> => {
					const bytes = artifactBytes.get(artifact.digest);
					if (bytes !== undefined)
						return {
							envelope: {
								ref: artifact,
								payloadKind: "evidence",
								codec: "canonical_json",
								immutable: true,
							},
							exists: true,
							bytes,
							verifiedDigest: sha256Hex(bytes),
							verifiedSizeBytes: bytes.byteLength,
						};
					return fixtureContext.artifactResolver.resolve(artifact);
				},
			},
		};
		const trustedClockReceipt = createFixtureHostReceipt({
			receiptKind: "clock",
			receiptId: "clock-expired-response",
			issuerId: "host",
			workflowId: "wf-1",
			bindingDigest: digestObject(cloudRequest),
			payloadDigest: "clock",
			artifactRef: ref,
			issuedAt: "2026-08-15T00:01:00.000Z",
			validUntil: "2026-08-15T00:05:00.000Z",
			keyId: "key",
			stateDigest: "state",
		});
		await expect(
			discoverWorkflowCapacity({
				workflowId: "wf-1",
				request: cloudRequest,
				probe: {
					local: async () => vector(),
					cloud: async () => response,
				},
				artifactPublisher: {
					publish: async (input) => ({
						status: "published" as const,
						envelope: {
							ref: {
								artifactId: input.idempotencyKey,
								relativePath: input.idempotencyKey,
								digest: sha256Hex(input.bytes),
								sizeBytes: input.bytes.byteLength,
								sourceEventSequence: 0,
							},
							payloadKind: input.payloadKind,
							codec: input.codec,
							immutable: true,
						},
					}),
				},
				artifactResolver: receiptContext.artifactResolver,
				cloudEvidenceVerifier: { verify: async () => undefined },
				receiptContext,
				trustedClockReceipt,
				currentStateDigest: "state",
				currentRevision: 1,
			}),
		).rejects.toThrow(/receipt|stale|trusted/i);
	});

	it("uses finite ceilings and protects separate control reserves", () => {
		const defaults = resolveWorkflowExecutionCeilings(undefined);
		expect(defaults.maxWorkflowWallMilliseconds).toBe(86_400_000);
		expect(defaults.maxRecoveryAttemptsPerEffectClass).toBe(3);
		expect(() => resolveWorkflowExecutionCeilings({ maxModelCalls: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
		expect(
			sumWorkflowControlCapacity([
				{
					resourceVector: vector(),
					workerCapacity: control({
						processSlots: 0,
						childSessionSlots: 0,
						modelCallSlots: 0,
						modelInputTokens: 0,
						modelOutputTokens: 0,
						verificationSlots: 0,
						redTeamSlots: 0,
						recoverySlots: 0,
					}),
					controlCapacity: control(),
					expectedEnvelopeDigest: "envelope",
					canonicalLedgerRef: ref,
					canonicalLedgerDigest: "ledger-digest",
					grantDigest: "grant",
				},
			]),
		).toEqual(control());
	});

	it("fails closed for unknown pools in resource admission", () => {
		const admission = deriveWorkflowResourceAdmission({
			declaredVector: vector(),
			authenticatedLedger: ledger(),
			declaredControlCapacity: control(),
			hostDerivedControlCapacity: control(),
			unknownPoolIds: ["quota"],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.enforcementClass).toBe("exclusive_unisolated");
		expect(admission.capacityGrant.controlCapacity.processSlots).toBe(4);
	});

	it("matches provider and accelerator identities exactly during admission", () => {
		const admission = deriveWorkflowResourceAdmission({
			declaredVector: vector({
				accelerators: [{ poolId: "gpu", deviceType: "A", count: 1, memoryBytes: 100 }],
				providers: [
					{
						poolId: "api-a",
						concurrentRequests: 1,
						requestsPerMinute: 1,
						totalRequests: 1,
						inputTokens: 1,
						outputTokens: 1,
						idempotency: "provider_native",
					},
				],
			}),
			authenticatedLedger: ledger({
				canonicalPoolLedger: {
					...ledger().canonicalPoolLedger,
					approvedPools: {
						local: vector({
							accelerators: [{ poolId: "gpu", deviceType: "B", count: 9, memoryBytes: 900 }],
							providers: [
								{
									poolId: "api-b",
									concurrentRequests: 9,
									requestsPerMinute: 9,
									totalRequests: 9,
									inputTokens: 9,
									outputTokens: 9,
									idempotency: "provider_native",
								},
							],
						}),
					},
				},
			}),
			declaredControlCapacity: control(),
			hostDerivedControlCapacity: control(),
			unknownPoolIds: [],
		});
		expect(admission.admitted).toBe(false);
		expect(admission.unknownPoolIds).toEqual(["accelerator:gpu:A", "provider:api-a"]);
	});

	it("rejects a reserve that cannot fit measured local capacity", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector({ cpuMilliCores: 1 }),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unavailable", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger({
					canonicalPoolLedger: {
						...ledger().canonicalPoolLedger,
						approvedPools: { local: vector({ cpuMilliCores: 1 }) },
					},
				}),
				controlPlaneReserve: vector({ cpuMilliCores: 3 }),
				controlPlaneReserveCapacity: control({ processSlots: 1 }),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector({ cpuMilliCores: 1 }),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: {
					requestedProfile: undefined,
					maxWorkers: 1,
					recommended: "inline",
					resolved: "unresolved",
					profileDigest: "profile",
					approvalDecisionRef: null,
					approvalReceipt: null,
					requiresUserApproval: true,
				},
			}),
		).toThrow(/reserve|allocatable/i);
	});

	it("does not allow requiredPoolIds to hide unknown cloud dimensions", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector(),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unknown", validUntil: null } as never,
			cloudUnknownPoolIds: ["quota"],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: vector({ cpuMilliCores: 0 }),
				controlPlaneReserveCapacity: zeroControl(),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector(),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: unresolvedProfile(),
			}),
		).toThrow(/unknown|unenforceable/i);
	});

	it("rejects cloud capacity from an unauthenticated unknown snapshot", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: zeroWorkflowResourceVector(),
			localCapacityRef: ref,
			cloudVector: vector({ cpuMilliCores: 2_000 }),
			cloudAvailability: { status: "unknown", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: zeroWorkflowResourceVector(),
				controlPlaneReserveCapacity: zeroControl(),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector(),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: approvedProfile(),
			}),
		).toThrow(/zero|unknown|authenticated/i);
	});

	it("binds capacity workflow identity to the authenticated ledger and profile decision", () => {
		const capacity = {
			workflowId: "wf-other",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: zeroWorkflowResourceVector(),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unavailable", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		const buildInput = (profile: ReturnType<typeof approvedProfile>, capacityOverride = capacity) => ({
			capacity: capacityOverride,
			executionCeilings: undefined,
			authenticatedLedger: ledger(),
			controlPlaneReserve: zeroWorkflowResourceVector(),
			controlPlaneReserveCapacity: zeroControl(),
			declaredControlCapacity: control(),
			hostDerivedControlCapacity: control(),
			declaredVector: vector(),
			requiredPoolIds: [],
			localPricingDigest: "local-pricing",
			profile,
		});
		expect(() => buildWorkflowResourceEnvelope(buildInput(approvedProfile()))).toThrow(/workflow|ledger|identity/i);
		const profile = approvedProfile();
		profile.approvalDecisionRef = {
			...profile.approvalDecisionRef,
			decisionScope: { kind: "workflow", workflowId: "wf-other", rootSessionId: "session-1" },
		};
		expect(() =>
			buildWorkflowResourceEnvelope(buildInput({ ...profile }, { ...capacity, workflowId: "wf-1" })),
		).toThrow(/workflow|decision|identity/i);
	});

	it("rejects a caller-supplied available snapshot without its exact capacity receipt", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector(),
			localCapacityRef: ref,
			cloudVector: vector(),
			cloudAvailability: {
				status: "available",
				provider: "provider-a",
				accountRef: "account-a",
				region: "region-a",
				capacityArtifactRef: ref,
				pricingArtifactRef: ref,
				pricingDigest: "pricing",
				authorityDigest: "authority",
				credentialArtifactRef: ref,
				quotaArtifactRef: ref,
				rateLimitArtifactRef: ref,
				billingArtifactRef: ref,
				egressArtifactRef: ref,
				terminationArtifactRef: ref,
				responseArtifactRef: ref,
				responseReceipt: {} as never,
				responseKeyId: "key",
				responseMac: "mac",
				responseChecksum: "checksum",
				validUntil: "2026-08-15T00:05:00.000Z",
				reasonCode: "reported_available",
			} as never,
			cloudUnknownPoolIds: ["quota"],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: vector({ cpuMilliCores: 0 }),
				controlPlaneReserveCapacity: zeroControl(),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector(),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: approvedProfile(),
			}),
		).toThrow(/receipt|authenticated|available|unknown/i);
		const receiptShapedCapacity = { ...capacity, capacityReceipt: {} as never };
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity: receiptShapedCapacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: vector({ cpuMilliCores: 0 }),
				controlPlaneReserveCapacity: zeroControl(),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector(),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: approvedProfile(),
			}),
		).toThrow(/unknown|authenticated/i);
	});

	it("rejects an unresolved profile before creating an allocatable envelope", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector(),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unavailable", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: vector({ cpuMilliCores: 0 }),
				controlPlaneReserveCapacity: zeroControl(),
				declaredControlCapacity: control(),
				hostDerivedControlCapacity: control(),
				declaredVector: vector(),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: unresolvedProfile(),
			}),
		).toThrow(/approved|profile/i);
	});

	it("turns an approved worker profile into capacity the scheduler can actually dispatch", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector(),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unavailable", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		const envelope = buildWorkflowResourceEnvelope({
			capacity,
			executionCeilings: undefined,
			authenticatedLedger: ledger(),
			controlPlaneReserve: zeroWorkflowResourceVector(),
			controlPlaneReserveCapacity: zeroControl(),
			declaredControlCapacity: control(),
			hostDerivedControlCapacity: control(),
			declaredVector: vector(),
			requiredPoolIds: [],
			localPricingDigest: "local-pricing",
			profile: approvedProfile(),
		});

		expect(envelope.processSlots).toBe(1);
		expect(envelope.childSessionSlots).toBe(1);
		expect(envelope.candidateSlots).toBe(1);
	});

	it("does not expose control-reserved process slots as worker capacity", () => {
		const capacity = {
			workflowId: "wf-1",
			cloudRequest: request(),
			cloudRequestRef: ref,
			cloudRequestDigest: "request",
			cloudResponseDigest: "response",
			localVector: vector(),
			localCapacityRef: ref,
			cloudVector: zeroWorkflowResourceVector(),
			cloudAvailability: { status: "unavailable", validUntil: null } as never,
			cloudUnknownPoolIds: [],
			capacityReceipt: null,
			observedAt: request().requestedAt,
			inventoryDigest: "inventory",
		};
		expect(() =>
			buildWorkflowResourceEnvelope({
				capacity,
				executionCeilings: undefined,
				authenticatedLedger: ledger(),
				controlPlaneReserve: vector({ cpuMilliCores: 4 }),
				controlPlaneReserveCapacity: control({ processSlots: 1 }),
				declaredControlCapacity: control({ processSlots: 1 }),
				hostDerivedControlCapacity: control({ processSlots: 1 }),
				declaredVector: vector({ cpuMilliCores: 4 }),
				requiredPoolIds: [],
				localPricingDigest: "local-pricing",
				profile: approvedProfile(),
			}),
		).toThrow(/reserve|allocatable|worker/i);
	});
});

function zeroControl(): WorkflowControlCapacityVector {
	return {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	};
}

function unresolvedProfile() {
	return {
		requestedProfile: undefined,
		maxWorkers: 1,
		recommended: "inline" as const,
		resolved: "unresolved" as const,
		profileDigest: "profile",
		approvalDecisionRef: null,
		approvalReceipt: null,
		requiresUserApproval: true as const,
	};
}

function approvedProfile() {
	return {
		...unresolvedProfile(),
		resolved: "inline" as const,
		approvalDecisionRef: {
			decisionScope: { kind: "workflow" as const, workflowId: "wf-1", rootSessionId: "session-1" },
			decisionId: "profile-decision",
			revision: 1,
			storeEpoch: 1,
			coordinatorEpoch: 1,
			decisionDigest: "decision-digest",
		},
		approvalReceipt: { workflowId: "wf-1" } as never,
	};
}
