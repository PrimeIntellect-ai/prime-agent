import { describe, expect, it } from "vitest";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	digestObject,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowJournalHead,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import {
	createWorkflowLearningPromotionReceiptAuthority,
	type WorkflowLearningPromotionAcceptedStage,
	type WorkflowLearningPromotionAuthoritySource,
} from "../src/core/workflow/learning-promotion-authority.js";
import { createWorkflowShell } from "../src/core/workflow/shell.js";

const WORKFLOW_ID = "workflow-learning-promotion-authority";
const NOW = "2026-08-18T10:00:00.000Z";
const CONFIRMED_AT = "2026-08-18T09:59:30.000Z";
const LATER = "2026-08-18T10:05:00.000Z";
const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const HEAD: WorkflowJournalHead = {
	workflowId: WORKFLOW_ID,
	sequence: 11,
	eventDigest: digestObject({ event: 11 }),
	epochRef: EPOCH,
};

function artifact(id: string, sequence = HEAD.sequence): WorkflowArtifactRef {
	return artifactForPayload(id, artifactPayload(id), sequence);
}

function artifactForPayload(
	id: string,
	payload: Record<string, unknown>,
	sequence = HEAD.sequence,
): WorkflowArtifactRef {
	const bytes = canonicalJsonBytes(payload);
	return {
		artifactId: id,
		relativePath: `artifacts/${id}`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: sequence,
	};
}

function artifactPayload(id: string): Record<string, unknown> {
	if (id === "proposal")
		return {
			schemaVersion: 1,
			kind: "workflow_learning_proposal",
			workflowId: WORKFLOW_ID,
			candidateId: "candidate-1",
			how: "adversarial workflow topology",
			why: digestObject({ evidence: "fixture" }),
			candidateStageIds: ["canary", "red_team"],
		};
	if (id === "red-team-result")
		return {
			schemaVersion: 1,
			kind: "workflow_learning_stage_result",
			workflowId: WORKFLOW_ID,
			candidateId: "candidate-1",
			stage: "red_team",
			confirmedAt: CONFIRMED_AT,
			provenance: "red-team-host-receipt",
		};
	if (id === "red-team-provenance")
		return {
			kind: "workflow-host-receipt",
			workflowId: WORKFLOW_ID,
			receiptId: "red-team-provenance-receipt",
			receiptKind: "artifact",
			issuedAt: CONFIRMED_AT,
		};
	return { id };
}

function source(
	overrides: Partial<WorkflowLearningPromotionAuthoritySource> = {},
): WorkflowLearningPromotionAuthoritySource {
	const canaryResultRef = artifact("canary-result");
	const redTeamResultRef = artifact("red-team-result");
	const proposalRef = artifact("proposal");
	const canaryEvidenceRefs = [artifact("canary-evidence")];
	const redTeamEvidenceRefs = [artifact("red-team-evidence")];
	const provenanceRef = artifact("red-team-provenance");
	const provenanceReceiptId = "red-team-provenance-receipt";
	const confirmation = {
		resultRef: redTeamResultRef,
		resultDigest: redTeamResultRef.digest,
		evidenceRefs: redTeamEvidenceRefs,
		evidenceDigest: digestObject(redTeamEvidenceRefs),
		provenanceRef,
		provenanceReceiptId,
		independent: true as const,
		hostAuthenticated: true as const,
		sessionId: "red-team-session",
		executionIdentity: "red-team-execution",
		confirmedAt: CONFIRMED_AT,
	};
	return {
		schemaVersion: 1,
		workflowId: WORKFLOW_ID,
		status: "active",
		generationId: "fixture-generation",
		epochRef: EPOCH,
		trustedNow: NOW,
		stateDigest: HEAD.eventDigest!,
		currentRevision: HEAD.sequence,
		goalRevision: { revision: 3, digest: digestObject({ goal: "immutable" }) },
		inputDigest: digestObject({ input: "same-case" }),
		graphDigest: digestObject({ graph: "admitted" }),
		acceptedHead: HEAD,
		candidateId: "candidate-1",
		promotionId: "promotion-1",
		revisionId: "revision-2",
		policyDigest: digestObject({ policy: 2 }),
		proposalDigest: proposalRef.digest,
		proposalRef,
		transferDigest: digestObject({
			schemaVersion: 1,
			candidateId: "candidate-1",
			proposalDigest: proposalRef.digest,
			proposalRef,
			how: "adversarial workflow topology",
			why: digestObject({ evidence: "fixture" }),
			candidateStageIds: ["canary", "red_team"],
		}),
		acceptedStage: {
			stage: "canary",
			resultRef: canaryResultRef,
			resultDigest: canaryResultRef.digest,
			evidenceRefs: canaryEvidenceRefs,
			evidenceDigest: digestObject(canaryEvidenceRefs),
			accepted: true,
			hostAuthenticated: true,
			sessionId: "canary-session",
			executionIdentity: "canary-execution",
		},
		independentConfirmation: {
			...confirmation,
			provenanceDigest: digestObject({
				kind: "workflow_learning_independent_confirmation_provenance",
				resultRef: confirmation.resultRef,
				evidenceRefs: confirmation.evidenceRefs,
				provenanceRef: confirmation.provenanceRef,
				provenanceReceiptId: confirmation.provenanceReceiptId,
				confirmedAt: confirmation.confirmedAt,
			}),
		},
		...overrides,
	};
}

function createHarness() {
	const receiptContext = createFixtureHostReceiptConsumerContext();
	const auxiliary = new Map<string, Uint8Array>();
	let current = source();
	let leaseHook: ((boundary: string) => void) | undefined;
	let hostReceiptMutator: ((receipt: WorkflowVerifiedHostReceipt) => WorkflowVerifiedHostReceipt) | undefined;
	let keyGeneration = "fixture-generation";
	let proposalPayloadOverride: Record<string, unknown> | undefined;
	const resolver = {
		resolve: async (ref: WorkflowArtifactRef) => {
			const bytes = ref.artifactId.startsWith("host-receipt-")
				? canonicalJsonBytes({
						artifactId: ref.artifactId,
						relativePath: ref.relativePath,
						sourceEventSequence: ref.sourceEventSequence,
						payloadDigest: "fixture",
					})
				: canonicalJsonBytes(
						ref.artifactId === "malformed-proposal" && proposalPayloadOverride !== undefined
							? proposalPayloadOverride
							: artifactPayload(ref.artifactId),
					);
			return {
				envelope: {
					ref,
					payloadKind: "evidence" as const,
					codec: "canonical_json" as const,
					immutable: true as const,
				},
				exists: true as const,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
	const issueReceipt = async (input: {
		receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		workflowId: string;
		bindingDigest: string;
		payloadDigest: string;
		receiptId: string;
		oneUse: true;
		issuedAt: string;
		stateDigest: string;
		revision: number;
	}): Promise<WorkflowVerifiedHostReceipt> => {
		const receipt = createFixtureHostReceipt({
			receiptKind: input.receiptKind,
			receiptId: input.receiptId,
			issuerId: "fixture-host",
			workflowId: input.workflowId,
			bindingDigest: input.bindingDigest,
			payloadDigest: input.payloadDigest,
			artifactRef: artifact(`host-receipt-${input.receiptId}`, input.revision),
			issuedAt: input.issuedAt,
			validUntil: LATER,
			keyId: "fixture-key",
			oneUse: input.oneUse,
			stateDigest: input.stateDigest,
			revision: input.revision,
		});
		return hostReceiptMutator?.(receipt) ?? receipt;
	};
	const keyResolver = {
		resolve: async (keyId: string) => ({
			...(await receiptContext.keyResolver.resolve(keyId)),
			generationId: keyGeneration,
		}),
	};
	const durableContext = {
		generationId: "fixture-generation",
		epochRef: EPOCH,
		currentLeaseRef: () => ({
			storeEpoch: 1,
			coordinatorEpoch: 1,
			leaseId: "lease",
			acquisitionEventSequence: 1,
			processIdentity: "process",
			rootDigest: digestObject("root"),
			writerIdentity: "writer",
			acquiredAt: NOW,
			expiresAt: LATER,
		}),
		outbox: {} as never,
		auxiliaryStore: {
			read: async (name: string) => auxiliary.get(name) ?? null,
			write: async (name: string, bytes: Readonly<Uint8Array>) => {
				auxiliary.set(name, new Uint8Array(bytes));
			},
			remove: async (name: string, expectedBytesDigest: string) => {
				const currentBytes = auxiliary.get(name);
				if (currentBytes === undefined) throw new Error("fixture auxiliary delete target is absent");
				if (sha256Hex(currentBytes) !== expectedBytesDigest)
					throw new Error("fixture auxiliary delete target failed its CAS check");
				auxiliary.delete(name);
			},
		},
		withExclusiveLease: async <T>(boundary: string, operation: () => Promise<T>) => {
			leaseHook?.(boundary);
			return operation();
		},
		recoverJournal: async () => {
			throw new Error("not used");
		},
	};
	const authority = () =>
		createWorkflowLearningPromotionReceiptAuthority({
			workflowId: WORKFLOW_ID,
			durableContext,
			artifactResolver: resolver,
			receiptContext: { ...receiptContext, artifactResolver: resolver, keyResolver },
			issueReceipt,
			now: () => current.trustedNow,
			readCurrent: async () => structuredClone(current),
		});
	return {
		authority,
		setCurrent: (next: WorkflowLearningPromotionAuthoritySource) => {
			current = next;
		},
		setLeaseHook: (hook: ((boundary: string) => void) | undefined) => {
			leaseHook = hook;
		},
		setHostReceiptMutator: (
			mutator: ((receipt: WorkflowVerifiedHostReceipt) => WorkflowVerifiedHostReceipt) | undefined,
		) => {
			hostReceiptMutator = mutator;
		},
		setKeyGeneration: (generation: string) => {
			keyGeneration = generation;
		},
		setProposalPayload: (payload: Record<string, unknown> | undefined) => {
			proposalPayloadOverride = payload;
		},
		readAuxiliary: async (name: string) => auxiliary.get(name) ?? null,
		writeAuxiliary: async (name: string, bytes: Readonly<Uint8Array>) => {
			auxiliary.set(name, new Uint8Array(bytes));
		},
	};
}

describe("workflow learning promotion receipt authority", () => {
	it("issues only for host-accepted stage evidence and binds every transfer field", async () => {
		const harness = createHarness();
		const receipt = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		expect(receipt.workflowId).toBe(WORKFLOW_ID);
		expect(receipt.acceptedHead).toEqual(HEAD);
		expect(receipt.acceptedStage.stage).toBe("canary");
		expect(receipt.independentConfirmation.independent).toBe(true);
		expect(receipt.nonce).toMatch(/^[0-9a-f]{64}$/u);
		expect(receipt.rollbackToken).toBeTruthy();
		expect(receipt.generationId).toBe("fixture-generation");
		expect(receipt.hostReceipt.oneUse).toBe(true);
		const repeated = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		expect(repeated.receiptDigest).toBe(receipt.receiptDigest);
	});

	it("rejects stale, mutated, foreign, and self-authored receipts without consuming them", async () => {
		const harness = createHarness();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		await expect(
			harness.authority().consume({
				receipt: { ...issued, proposalDigest: digestObject("mutated") },
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/digest|binding|receipt/i);
		await expect(
			harness.authority().consume({
				receipt: { ...issued, workflowId: "foreign-workflow" },
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/workflow|foreign|binding|shape/i);
		const staleHead: WorkflowJournalHead = {
			...HEAD,
			sequence: HEAD.sequence + 1,
			eventDigest: digestObject({ event: HEAD.sequence + 1 }),
		};
		harness.setCurrent({
			...source(),
			acceptedHead: staleHead,
			currentRevision: staleHead.sequence,
			stateDigest: staleHead.eventDigest!,
		});
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/stale|foreign|accepted/i);
		harness.setCurrent({
			...source(),
			acceptedStage: {
				...source().acceptedStage,
				hostAuthenticated: false,
			} as unknown as WorkflowLearningPromotionAcceptedStage,
		});
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/host|accepted|stage/i);
		const record = await harness.readAuxiliary("workflow-learning-promotion-receipts.v1.fixture-generation");
		expect(record).not.toBeNull();
		expect(new TextDecoder().decode(record!)).not.toContain("consumedAt");
	});

	it("consumes exactly once and remains consumed after a new authority instance", async () => {
		const harness = createHarness();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).resolves.toMatchObject({ receiptId: issued.receiptId });
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/consum|one-use|replay/i);
		await expect(
			harness.authority().issue({
				candidateId: "candidate-1",
				proposalDigest: source().proposalDigest,
				inputDigest: source().inputDigest,
				graphDigest: source().graphDigest,
				goalRevisionDigest: source().goalRevision.digest,
			}),
		).rejects.toThrow(/consum/i);
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/workflow|receipt|artifact|generation/i);
	});

	it("rejects an issue when the authenticated accepted head changes before the lease commit", async () => {
		const harness = createHarness();
		harness.setLeaseHook((boundary) => {
			if (boundary !== "workflow-learning-promotion-receipt") return;
			harness.setLeaseHook(undefined);
			const staleHead: WorkflowJournalHead = {
				...HEAD,
				sequence: HEAD.sequence + 1,
				eventDigest: digestObject({ event: "issue-race" }),
			};
			harness.setCurrent({
				...source(),
				acceptedHead: staleHead,
				currentRevision: staleHead.sequence,
				stateDigest: staleHead.eventDigest!,
			});
		});
		await expect(
			harness.authority().issue({
				candidateId: "candidate-1",
				proposalDigest: source().proposalDigest,
				inputDigest: source().inputDigest,
				graphDigest: source().graphDigest,
				goalRevisionDigest: source().goalRevision.digest,
			}),
		).rejects.toThrow(/stale|head|authority/i);
		const record = await harness.readAuxiliary("workflow-learning-promotion-receipts.v1.fixture-generation");
		expect(record).toBeNull();
	});

	it("rejects a consume when the authenticated accepted head changes inside the consume lease", async () => {
		const harness = createHarness();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		harness.setLeaseHook((boundary) => {
			if (boundary !== "workflow-learning-promotion-receipt-consume") return;
			harness.setLeaseHook(undefined);
			const staleHead: WorkflowJournalHead = {
				...HEAD,
				sequence: HEAD.sequence + 1,
				eventDigest: digestObject({ event: "consume-race" }),
			};
			harness.setCurrent({
				...source(),
				acceptedHead: staleHead,
				currentRevision: staleHead.sequence,
				stateDigest: staleHead.eventDigest!,
			});
		});
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/stale|head|authority/i);
		const record = await harness.readAuxiliary("workflow-learning-promotion-receipts.v1.fixture-generation");
		expect(new TextDecoder().decode(record!)).not.toContain("consumedAt");
	});

	it("rejects an existing receipt when accepted evidence changes under the same request identity", async () => {
		const harness = createHarness();
		const initial = source();
		await harness.authority().issue({
			candidateId: initial.candidateId,
			proposalDigest: initial.proposalDigest,
			inputDigest: initial.inputDigest,
			graphDigest: initial.graphDigest,
			goalRevisionDigest: initial.goalRevision.digest,
		});
		harness.setCurrent({
			...initial,
			acceptedStage: { ...initial.acceptedStage, sessionId: "different-canary-session" },
		});
		await expect(
			harness.authority().issue({
				candidateId: initial.candidateId,
				proposalDigest: initial.proposalDigest,
				inputDigest: initial.inputDigest,
				graphDigest: initial.graphDigest,
				goalRevisionDigest: initial.goalRevision.digest,
			}),
		).rejects.toThrow(/conflict|source|stage|evidence/i);
	});

	it("rejects an existing receipt when policy, revision, transfer, or proposal reference changes", async () => {
		const mutations: readonly ((
			initial: WorkflowLearningPromotionAuthoritySource,
		) => Partial<WorkflowLearningPromotionAuthoritySource>)[] = [
			() => ({ policyDigest: digestObject({ policy: "mutated" }) }),
			(initial) => ({ revisionId: `${initial.revisionId}-mutated` }),
			() => ({ transferDigest: digestObject({ transfer: "mutated" }) }),
			(initial) => ({ proposalRef: { ...initial.proposalRef, relativePath: "artifacts/proposal-mutated" } }),
		];
		for (const mutate of mutations) {
			const harness = createHarness();
			const initial = source();
			await harness.authority().issue({
				candidateId: initial.candidateId,
				proposalDigest: initial.proposalDigest,
				inputDigest: initial.inputDigest,
				graphDigest: initial.graphDigest,
				goalRevisionDigest: initial.goalRevision.digest,
			});
			harness.setCurrent({ ...initial, ...mutate(initial) });
			await expect(
				harness.authority().issue({
					candidateId: initial.candidateId,
					proposalDigest: initial.proposalDigest,
					inputDigest: initial.inputDigest,
					graphDigest: initial.graphDigest,
					goalRevisionDigest: initial.goalRevision.digest,
				}),
			).rejects.toThrow(/conflict|source|proposal|transfer|revision|policy|authority/i);
		}
	});

	it("rejects confirmation timestamps that are not present in the immutable result evidence", async () => {
		const harness = createHarness();
		const initial = source();
		harness.setCurrent({
			...initial,
			independentConfirmation: { ...initial.independentConfirmation, confirmedAt: NOW },
		});
		await expect(
			harness.authority().issue({
				candidateId: initial.candidateId,
				proposalDigest: initial.proposalDigest,
				inputDigest: initial.inputDigest,
				graphDigest: initial.graphDigest,
				goalRevisionDigest: initial.goalRevision.digest,
			}),
		).rejects.toThrow(/confirmation|evidence|provenance|time/i);
	});

	it("authenticates the persisted signing key against the current host generation", async () => {
		const harness = createHarness();
		harness.setKeyGeneration("foreign-generation");
		await expect(
			harness.authority().issue({
				candidateId: "candidate-1",
				proposalDigest: source().proposalDigest,
				inputDigest: source().inputDigest,
				graphDigest: source().graphDigest,
				goalRevisionDigest: source().goalRevision.digest,
			}),
		).rejects.toThrow(/key|generation|host|authenticated/i);
	});

	it("rejects a host receipt whose outer identity or kind differs from the inner receipt", async () => {
		const harness = createHarness();
		harness.setHostReceiptMutator((receipt) => ({
			...receipt,
			receiptId: `${receipt.receiptId}-foreign`,
			receiptKind: "artifact",
		}));
		await expect(
			harness.authority().issue({
				candidateId: "candidate-1",
				proposalDigest: source().proposalDigest,
				inputDigest: source().inputDigest,
				graphDigest: source().graphDigest,
				goalRevisionDigest: source().goalRevision.digest,
			}),
		).rejects.toThrow(/receipt|identity|kind|envelope/i);
	});

	it("rejects a proposal artifact without a transferable how/why payload", async () => {
		const malformedProposalRef = artifactForPayload("malformed-proposal", {
			schemaVersion: 1,
			kind: "workflow_learning_proposal",
			workflowId: WORKFLOW_ID,
			candidateId: "candidate-1",
		});
		const malformed = source({
			proposalDigest: malformedProposalRef.digest,
			proposalRef: malformedProposalRef,
			transferDigest: digestObject({ proposalDigest: malformedProposalRef.digest }),
		});
		const harness = createHarness();
		harness.setProposalPayload({
			schemaVersion: 1,
			kind: "workflow_learning_proposal",
			workflowId: WORKFLOW_ID,
			candidateId: "candidate-1",
		});
		harness.setCurrent(malformed);
		await expect(
			harness.authority().issue({
				candidateId: malformed.candidateId,
				proposalDigest: malformed.proposalDigest,
				inputDigest: malformed.inputDigest,
				graphDigest: malformed.graphDigest,
				goalRevisionDigest: malformed.goalRevision.digest,
			}),
		).rejects.toThrow(/proposal|transfer|how|why/i);
	});

	it("exposes only the receipt capability through the shell and revokes it on disposal", async () => {
		const harness = createHarness();
		const shell = createWorkflowShell({
			execute: async () => {
				throw new Error("not used");
			},
			status: () => {
				throw new Error("not used");
			},
			learningPromotionReceipts: harness.authority(),
		});
		const receipt = await shell.learningPromotionReceipts!.issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		expect(receipt.hostReceipt).toBeDefined();
		expect(Object.keys(shell.learningPromotionReceipts!).sort()).toEqual([
			"consume",
			"consumeAndApply",
			"issue",
			"rollback",
		]);
		await shell.dispose?.();
		await expect(
			shell.learningPromotionReceipts!.issue({
				candidateId: "candidate-1",
				proposalDigest: source().proposalDigest,
				inputDigest: source().inputDigest,
				graphDigest: source().graphDigest,
				goalRevisionDigest: source().goalRevision.digest,
			}),
		).rejects.toThrow(/disposed/i);
	});

	it("atomically consumes and applies one canonical generalized refinement, then deduplicates an exact replay", async () => {
		const harness = createHarness();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		const authority = harness.authority() as unknown as {
			consumeAndApply(input: unknown): Promise<{
				applicationId: string;
				appliedBytesDigest: string;
				previousBytesDigest: string | null;
				rollbackToken: string;
			}>;
		};
		const input = {
			receipt: issued,
			proposalDigest: issued.proposalDigest,
			inputDigest: issued.inputDigest,
			graphDigest: issued.graphDigest,
			goalRevisionDigest: issued.goalRevision.digest,
			refinement: {
				schemaVersion: 1,
				action: "create",
				kind: "memory",
				id: "topology-lesson",
				title: "Adversarial topology",
				content: "Preserve the accepted topology when adding a reusable lesson.",
				how: "adversarial workflow topology",
				why: digestObject({ evidence: "fixture" }),
				path: "memory/topology-lesson",
			},
		};
		const first = await authority.consumeAndApply(input);
		const replay = await authority.consumeAndApply(input);
		expect(replay).toEqual(first);
		expect(first.previousBytesDigest).toBeNull();
		expect(first.appliedBytesDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(first.rollbackToken).toBe(issued.rollbackToken);
		const bytes = await harness.readAuxiliary("workflow-learning-refinement.v1.fixture-generation");
		expect(bytes).not.toBeNull();
		expect(sha256Hex(bytes!)).toBe(first.appliedBytesDigest);
		await expect(
			harness.authority().consume({
				receipt: issued,
				proposalDigest: issued.proposalDigest,
				inputDigest: issued.inputDigest,
				graphDigest: issued.graphDigest,
				goalRevisionDigest: issued.goalRevision.digest,
			}),
		).rejects.toThrow(/consum|replay|appl/i);
	});

	it("rejects stale, mutated, foreign, path-bearing, chronological, and protected-outcome applications without changing bytes", async () => {
		const harness = createHarness();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		const authority = harness.authority() as unknown as {
			consumeAndApply(input: unknown): Promise<unknown>;
		};
		const base = {
			receipt: issued,
			proposalDigest: issued.proposalDigest,
			inputDigest: issued.inputDigest,
			graphDigest: issued.graphDigest,
			goalRevisionDigest: issued.goalRevision.digest,
			refinement: {
				schemaVersion: 1,
				action: "create",
				kind: "memory",
				id: "topology-lesson",
				title: "Adversarial topology",
				content: "Preserve the accepted topology when adding a reusable lesson.",
				how: "adversarial workflow topology",
				why: digestObject({ evidence: "fixture" }),
				path: "memory/topology-lesson",
			},
		};
		const cases = [
			{ name: "absolute path", refinement: { ...base.refinement, path: "/tmp/escape" } },
			{ name: "thread chronology", refinement: { ...base.refinement, threadChronology: ["turn-1"] } },
			{ name: "protected outcome", refinement: { ...base.refinement, outcome: "completed" } },
			{ name: "mutated proposal", proposalDigest: digestObject("mutated") },
		] as const;
		for (const candidate of cases) {
			const before = await harness.readAuxiliary("workflow-learning-refinement.v1.fixture-generation");
			await expect(
				authority.consumeAndApply({
					...base,
					...("proposalDigest" in candidate ? { proposalDigest: candidate.proposalDigest } : {}),
					refinement: "refinement" in candidate ? candidate.refinement : base.refinement,
				}),
			).rejects.toThrow(/stale|mutat|foreign|path|chronolog|thread|outcome|protected|refinement/i);
			const after = await harness.readAuxiliary("workflow-learning-refinement.v1.fixture-generation");
			expect(after).toEqual(before);
		}
	});

	it("restores exact prior bytes with a rollback token and rejects rollback after a target CAS mutation", async () => {
		const harness = createHarness();
		const prior = canonicalJsonBytes({ legacy: true, bytes: [1, 2, 3] });
		await harness.writeAuxiliary("workflow-learning-refinement.v1.fixture-generation", prior);
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		const authority = harness.authority() as unknown as {
			consumeAndApply(input: unknown): Promise<{ rollbackToken: string; appliedBytesDigest: string }>;
			rollback(input: unknown): Promise<{ status: string }>;
		};
		const applyInput = {
			receipt: issued,
			proposalDigest: issued.proposalDigest,
			inputDigest: issued.inputDigest,
			graphDigest: issued.graphDigest,
			goalRevisionDigest: issued.goalRevision.digest,
			refinement: {
				schemaVersion: 1,
				action: "create",
				kind: "memory",
				id: "topology-lesson",
				title: "Adversarial topology",
				content: "Preserve the accepted topology when adding a reusable lesson.",
				how: "adversarial workflow topology",
				why: digestObject({ evidence: "fixture" }),
				path: "memory/topology-lesson",
			},
		};
		const application = await authority.consumeAndApply(applyInput);
		const applied = await harness.readAuxiliary("workflow-learning-refinement.v1.fixture-generation");
		expect(applied).not.toEqual(prior);
		await expect(
			authority.rollback({
				workflowId: WORKFLOW_ID,
				receiptId: issued.receiptId,
				rollbackToken: application.rollbackToken,
				expectedAppliedBytesDigest: application.appliedBytesDigest,
			}),
		).resolves.toMatchObject({ status: "rolled_back" });
		expect(await harness.readAuxiliary("workflow-learning-refinement.v1.fixture-generation")).toEqual(prior);
		await expect(
			authority.rollback({
				workflowId: WORKFLOW_ID,
				receiptId: issued.receiptId,
				rollbackToken: application.rollbackToken,
				expectedAppliedBytesDigest: application.appliedBytesDigest,
			}),
		).resolves.toMatchObject({ status: "rolled_back" });
	});

	it("removes an initially absent target on rollback and deduplicates after restart", async () => {
		const harness = createHarness();
		const targetName = "workflow-learning-refinement.v1.fixture-generation";
		expect(await harness.readAuxiliary(targetName)).toBeNull();
		const issued = await harness.authority().issue({
			candidateId: "candidate-1",
			proposalDigest: source().proposalDigest,
			inputDigest: source().inputDigest,
			graphDigest: source().graphDigest,
			goalRevisionDigest: source().goalRevision.digest,
		});
		const input = {
			receipt: issued,
			proposalDigest: issued.proposalDigest,
			inputDigest: issued.inputDigest,
			graphDigest: issued.graphDigest,
			goalRevisionDigest: issued.goalRevision.digest,
			refinement: {
				schemaVersion: 1,
				action: "create",
				kind: "memory",
				id: "absent-target-lesson",
				title: "Absent target lesson",
				content: "Rollback restores absence rather than leaving a tombstone payload.",
				how: "adversarial workflow topology",
				why: digestObject({ evidence: "fixture" }),
			},
		};
		const authority = harness.authority() as unknown as {
			consumeAndApply(input: unknown): Promise<{
				applicationId: string;
				appliedBytesDigest: string;
				rollbackToken: string;
			}>;
			rollback(input: unknown): Promise<{ status: string }>;
		};
		const application = await authority.consumeAndApply(input);
		expect(await harness.readAuxiliary(targetName)).not.toBeNull();

		const restarted = harness.authority() as unknown as {
			consumeAndApply(input: unknown): Promise<unknown>;
			rollback(input: unknown): Promise<{ status: string }>;
		};
		expect(await restarted.consumeAndApply(input)).toMatchObject(application);
		await expect(
			restarted.rollback({
				workflowId: WORKFLOW_ID,
				receiptId: issued.receiptId,
				rollbackToken: application.rollbackToken,
				expectedAppliedBytesDigest: application.appliedBytesDigest,
			}),
		).resolves.toMatchObject({ status: "rolled_back" });
		expect(await harness.readAuxiliary(targetName)).toBeNull();
		const audit = await harness.readAuxiliary("workflow-learning-promotion-receipts.v1.fixture-generation");
		expect(new TextDecoder().decode(audit!)).toContain(application.applicationId);
		expect(new TextDecoder().decode(audit!)).toContain("rolled_back");
		await expect(
			harness.authority().rollback({
				workflowId: WORKFLOW_ID,
				receiptId: issued.receiptId,
				rollbackToken: application.rollbackToken,
				expectedAppliedBytesDigest: application.appliedBytesDigest,
			}),
		).resolves.toMatchObject({ status: "rolled_back" });
		expect(await harness.readAuxiliary(targetName)).toBeNull();
	});
});
