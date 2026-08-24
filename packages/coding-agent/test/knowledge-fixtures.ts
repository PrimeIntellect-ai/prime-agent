import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KnowledgeDurableStore } from "../src/core/knowledge/knowledge-durable-adapter.js";
import {
	bindKnowledgeDurableAuthority,
	registerWorkflowKnowledgeRuntimeAuthority,
} from "../src/core/knowledge/knowledge-runtime-authority.js";
import type {
	KnowledgeHostValidation,
	KnowledgeHostValidationContext,
	KnowledgeTombstoneFingerprintContext,
} from "../src/core/knowledge/knowledge-store.js";
import type { KnowledgeEvent, KnowledgeProposal } from "../src/core/knowledge/records.js";
import type { WorkflowRuntimeStoreDurableContext } from "../src/core/workflow/contracts.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	createFixtureHostReceiptConsumerContext,
	type DurableDecisionRef,
	digestObject,
	parseCanonicalJsonBytes,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowEvidenceEnvelopeRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowHostReceiptResolver,
	type WorkflowTrustedPrincipal,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";

export const EPOCH: WorkflowEpochRef = Object.freeze({ storeEpoch: 3, coordinatorEpoch: 7 });
export const TRUSTED_NOW = "2026-08-16T15:30:00.000Z";
export const TRUSTED_PRINCIPAL: WorkflowTrustedPrincipal = Object.freeze({
	kind: "workflow_command",
	principalId: "principal-1",
	credentialDigest: "credential-digest-1",
});
export const RECEIPT_CONTEXT = createFixtureHostReceiptConsumerContext();

export function createPersistedFixtureHostReceiptConsumerContext(root: string): WorkflowHostReceiptConsumerContext {
	const base = createFixtureHostReceiptConsumerContext();
	const witnessPath = join(root, "knowledge-fixture-receipt-witnesses.json");
	const readWitnesses = async (): Promise<Record<string, WorkflowHostReceiptConsumptionWitness>> => {
		let bytes: Uint8Array;
		try {
			bytes = await readFile(witnessPath);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
			throw error;
		}
		const parsed = parseCanonicalJsonBytes(bytes);
		const candidate = parsed as { witnesses?: unknown };
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed) ||
			!Object.hasOwn(parsed, "witnesses") ||
			typeof candidate.witnesses !== "object" ||
			candidate.witnesses === null ||
			Array.isArray(candidate.witnesses)
		)
			throw new Error("Fixture persisted receipt witnesses are corrupt.");
		return candidate.witnesses as Record<string, WorkflowHostReceiptConsumptionWitness>;
	};
	const writeWitnesses = async (witnesses: Record<string, WorkflowHostReceiptConsumptionWitness>): Promise<void> => {
		await writeFile(witnessPath, canonicalJsonBytes({ version: 1, witnesses }));
	};
	const receiptResolver: WorkflowHostReceiptResolver = {
		resolve: (input) => base.receiptResolver.resolve(input),
		consumeIfOneUse: async (input) => {
			if (
				input.receipt.workflowId !== input.workflowId ||
				input.receipt.bindingDigest !== input.expectedBindingDigest ||
				input.receipt.revision !== input.currentRevision
			)
				throw new Error("Fixture persisted receipt consumption tuple is invalid.");
			if (!input.receipt.oneUse) return;
			const witnesses = await readWitnesses();
			const existing = witnesses[input.receipt.receiptId];
			if (existing !== undefined) {
				if (existing.workflowId !== input.workflowId || existing.bindingDigest !== input.expectedBindingDigest)
					throw new Error("Fixture persisted receipt witness conflicts with the consumption tuple.");
				return;
			}
			const witness: WorkflowHostReceiptConsumptionWitness = {
				receiptId: input.receipt.receiptId,
				workflowId: input.workflowId,
				bindingDigest: input.expectedBindingDigest,
				capability: input.receipt.capabilityBinding?.capability ?? null,
				resourceDigest: input.receipt.capabilityBinding?.resourceDigest ?? null,
				operationDigest: input.receipt.capabilityBinding?.operationDigest ?? null,
				receiptDigest: input.receipt.verificationDigest,
				consumedAt: TRUSTED_NOW,
				consumptionSequence: Object.keys(witnesses).length + 1,
			};
			await writeWitnesses({ ...witnesses, [witness.receiptId]: witness });
		},
		resolveConsumptionWitness: async (input) => {
			const witnesses = await readWitnesses();
			const witness = witnesses[input.receiptId];
			if (
				witness === undefined ||
				witness.workflowId !== input.workflowId ||
				witness.bindingDigest !== input.expectedBindingDigest
			)
				throw new Error("Fixture persisted receipt has no matching durable witness.");
			return structuredClone(witness);
		},
	};
	return { ...base, receiptResolver };
}
export const LEASE = Object.freeze({
	...EPOCH,
	leaseId: "lease-1",
	acquisitionEventSequence: 1,
	processIdentity: "process-1",
	rootDigest: "root-digest",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-16T15:00:00.000Z",
	expiresAt: "2026-08-16T16:00:00.000Z",
});

export function bindFixtureKnowledgeAuthority(durable: KnowledgeDurableStore, events: readonly KnowledgeEvent[]): void {
	const runtimeStore = {};
	const context = {
		generationId: "generation-1",
		epochRef: EPOCH,
		currentLeaseRef: () => LEASE,
		outbox: {
			append: async () => ({ status: "appended" as const, sequence: 1, entryDigest: "fixture-outbox" }),
			recover: async () => ({
				quarantined: false as const,
				entries: [],
				head: {
					workflowId: "workflow-1",
					sequence: 0,
					eventDigest: null,
					entryDigest: null,
					epochRef: EPOCH,
				},
				metadata: {
					status: "complete" as const,
					sourcePath: "fixture",
					sourceDigest: "fixture",
					sourceSizeBytes: 0,
					sequence: null,
					reason: "none" as const,
				},
			}),
		},
		auxiliaryStore: { read: async () => null, write: async () => undefined },
		withExclusiveLease: async <T>(_boundary: string, operation: () => Promise<T>) => operation(),
		recoverJournal: async () => ({
			quarantined: false as const,
			events: [],
			metadata: {
				status: "complete" as const,
				sourcePath: "fixture",
				sourceDigest: "fixture",
				sourceSizeBytes: 0,
				sequence: null,
				reason: "none" as const,
			},
		}),
	} as unknown as WorkflowRuntimeStoreDurableContext;
	registerWorkflowKnowledgeRuntimeAuthority(runtimeStore, context, async () => undefined);
	bindKnowledgeDurableAuthority({
		durableStore: durable,
		runtimeStore,
		context,
		workflowId: "workflow-1",
		epochRef: EPOCH,
		generationId: "generation-1",
		replayCanonical: async () => [...events],
	});
}

export function artifact(id: string, sourceEventSequence = 1): WorkflowArtifactRef {
	const relativePath = `evidence/${id}.json`;
	const bytes = canonicalJsonBytes({ artifactId: id, relativePath, sourceEventSequence, payloadDigest: "fixture" });
	return {
		artifactId: id,
		relativePath,
		digest: `${id}-digest`,
		sizeBytes: bytes.byteLength,
		sourceEventSequence,
	};
}

export function hostReceipt(
	id: string,
	input: Partial<
		Pick<
			WorkflowVerifiedHostReceipt,
			"receiptKind" | "workflowId" | "bindingDigest" | "stateDigest" | "revision" | "issuerId" | "oneUse"
		>
	> & { payloadDigest?: string; sourceEventSequence?: number } = {},
): WorkflowVerifiedHostReceipt {
	return createFixtureHostReceipt({
		receiptKind: input.receiptKind ?? "artifact",
		oneUse: input.oneUse ?? false,
		receiptId: id,
		issuerId: input.issuerId ?? "fixture-host",
		workflowId: input.workflowId ?? "workflow-1",
		bindingDigest: input.bindingDigest ?? "unbound",
		payloadDigest: input.payloadDigest ?? digestObject({ receipt: id }),
		artifactRef: artifact(`${id}-receipt`, input.sourceEventSequence ?? input.revision ?? 1),
		issuedAt: "2026-08-16T15:00:00.000Z",
		validUntil: "2026-08-16T16:30:00.000Z",
		keyId: "host-key",
		stateDigest: input.stateDigest ?? "state-digest",
		revision: input.revision ?? 1,
	});
}

export function evidence(id: string, workflowId = "workflow-1"): WorkflowEvidenceEnvelopeRef {
	return {
		workflowId,
		envelopeId: id,
		envelopeDigest: `${id}-envelope`,
		evidenceRevision: 1,
		artifactRefs: [artifact(id)],
		validationReceipt: hostReceipt(`${id}-validation`, { workflowId }),
	};
}

export function decisionRef(): DurableDecisionRef {
	return {
		decisionScope: { kind: "knowledge", namespace: "knowledge" },
		decisionId: "decision-1",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		decisionDigest: "decision-digest",
	};
}

export function proposal(overrides: Partial<KnowledgeProposal> = {}): KnowledgeProposal {
	return {
		proposalId: "proposal-1",
		recordId: "record-1",
		kind: "how",
		title: "Use the fixture",
		statement: "Run the fixture command and inspect its output.",
		provenance: { source: "host", producerId: "host-producer" },
		applicability: { namespace: "knowledge", scope: "workspace", workspaceId: "workspace-1" },
		privacy: { class: "public", secretScan: hostReceipt("secret-scan") },
		retention: { class: "indefinite" },
		confidence: "audited",
		decisionRef: decisionRef(),
		evidenceRefs: [evidence("evidence-1")],
		epochRef: EPOCH,
		action: "create",
		expectedRevision: null,
		rollbackRevision: null,
		...overrides,
	};
}

function receiptForValidation(
	id: string,
	context: KnowledgeHostValidationContext,
	revision: number,
	payloadDigest?: string,
	oneUse = false,
	sourceEventSequence?: number,
): WorkflowVerifiedHostReceipt {
	return hostReceipt(id, {
		workflowId: context.workflowId,
		bindingDigest: context.bindingDigest,
		stateDigest: context.currentStateDigest,
		revision,
		oneUse,
		payloadDigest,
		sourceEventSequence,
	});
}

export function hostValidators(
	options: {
		oneUse?: boolean;
		receiptContext?: WorkflowHostReceiptConsumerContext;
		sourceEventSequence?: number;
	} = {},
): KnowledgeHostValidation {
	const receiptContext = options.receiptContext ?? RECEIPT_CONTEXT;
	return {
		validateDecision: async (reference, _proposal, context) => ({
			receipt: receiptForValidation(
				`decision-${context.bindingDigest}`,
				context,
				reference.revision,
				undefined,
				options.oneUse,
				options.sourceEventSequence,
			),
			context: receiptContext,
		}),
		validateEvidence: async (reference, _proposal, context) => ({
			receipt: receiptForValidation(
				`evidence-${context.bindingDigest}`,
				context,
				reference.evidenceRevision,
				undefined,
				options.oneUse,
				options.sourceEventSequence,
			),
			context: receiptContext,
		}),
		validateSecretScan: async (_receipt, _proposal, context) => ({
			receipt: receiptForValidation(
				`secret-scan-${context.bindingDigest}`,
				context,
				Math.max(context.expectedHead.sequence, 1),
				undefined,
				options.oneUse,
				options.sourceEventSequence,
			),
			context: receiptContext,
		}),
		deriveTombstoneFingerprint: async (context: KnowledgeTombstoneFingerprintContext) => ({
			fingerprint: digestObject({ hostKey: "fixture-host-key", ...context }),
			receipt: receiptForValidation(
				`tombstone-${context.bindingDigest}`,
				{
					workflowId: context.workflowId,
					namespace: context.namespace,
					expectedHead: {
						workflowId: context.workflowId,
						sequence: context.currentRevision,
						eventDigest: null,
						epochRef: context.epochRef,
					},
					epochRef: context.epochRef,
					trustedNow: context.trustedNow,
					currentStateDigest: context.currentStateDigest,
					disposition: "accepted",
					bindingDigest: context.bindingDigest,
				},
				context.currentRevision,
				digestObject({
					kind: "knowledge-tombstone-fingerprint",
					bindingDigest: context.bindingDigest,
					fingerprint: digestObject({ hostKey: "fixture-host-key", ...context }),
				}),
				options.oneUse,
				options.sourceEventSequence,
			),
			context: receiptContext,
		}),
	};
}

export function clockReceipt(input: {
	stateDigest: string;
	query: string;
	workflowId?: string;
	namespace?: string;
	kind?: KnowledgeProposal["kind"];
	scope?: KnowledgeProposal["applicability"]["scope"];
	workspaceId?: string;
	sessionId?: string;
	userId?: string;
	pathPrefix?: string;
	privacyAtMost?: KnowledgeProposal["privacy"]["class"];
	principal?: WorkflowTrustedPrincipal;
	oneUse?: boolean;
	revision: number;
}): WorkflowVerifiedHostReceipt {
	const workflowId = input.workflowId ?? "workflow-1";
	const namespace = input.namespace ?? "knowledge";
	const principal = input.principal ?? TRUSTED_PRINCIPAL;
	const bindingDigest = digestObject({
		kind: "knowledge-recall-clock-admission",
		workflowId,
		namespace,
		query: input.query.trim().toLocaleLowerCase(),
		kindFilter: input.kind ?? null,
		scope: input.scope ?? null,
		workspaceId: input.workspaceId ?? null,
		sessionId: input.sessionId ?? null,
		userId: input.userId ?? null,
		pathPrefix: input.pathPrefix ?? null,
		privacyAtMost: input.privacyAtMost ?? "public",
		principal,
	});
	return hostReceipt("clock-receipt", {
		receiptKind: "clock",
		workflowId,
		bindingDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		oneUse: input.oneUse,
	});
}
