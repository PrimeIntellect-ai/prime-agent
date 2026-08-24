import { createHmac, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowHostReceiptResolver,
	type WorkflowImprovementCaseManifest,
	type WorkflowRuntimeStoreDurableContext,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowLearningCanaryResult,
	WorkflowLearningCandidate,
	WorkflowLearningCasExpectation,
	WorkflowLearningDecision,
	WorkflowLearningExperienceInput,
	WorkflowLearningHost,
	WorkflowLearningHostProjection,
	WorkflowLearningHostSnapshot,
	WorkflowLearningHostWitness,
	WorkflowLearningPorts,
	WorkflowLearningPromotion,
	WorkflowLearningPromotionReconciliation,
	WorkflowLearningRedTeamResult,
	WorkflowLearningRollbackApplication,
	WorkflowLearningRollbackProposal,
	WorkflowLearningShadowResult,
	WorkflowLearningTrigger,
	WorkflowLearningWitnessKind,
} from "../src/core/workflow/learning-controller.js";
import {
	createWorkflowLearningRuntimeAdapterForSessionHost,
	createWorkflowLearningRuntimeAdapterWithDurableEffects,
	issueWorkflowLearningSessionHostIdentity,
	type WorkflowLearningApprovedAuthority,
	type WorkflowLearningDurableEffectAuthority,
	type WorkflowLearningRuntimeBinding,
	workflowLearningAuthorityBindingDigest,
} from "../src/core/workflow/learning-runtime-adapter.js";
import { createLocalAppendLeaseProcessIdentity } from "../src/core/workflow/local-append-lease.js";
import { createLocalWorkflowJournalKeyProvider } from "../src/core/workflow/local-journal-keyring.js";
import type { WorkflowDeferredEventOwnerValidators } from "../src/core/workflow/reducer.js";
import {
	createPersistedSessionWorkflowHost,
	type PersistedSessionWorkflowHost,
} from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "learning-runtime-process-intent";
const ROOT_SESSION_ID = "learning-runtime-process-session";
const EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;
const NOW = "2026-08-16T00:00:00.000Z";
const LATER = "2026-08-16T01:00:00.000Z";
const DIGEST = "d".repeat(64);
const RECEIPT_PRIVATE_DER_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const RECEIPT_PRIVATE_KEY = createPrivateKey({
	key: Buffer.concat([
		RECEIPT_PRIVATE_DER_PREFIX,
		Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex"),
	]),
	format: "der",
	type: "pkcs8",
});
const RECEIPT_PUBLIC_KEY = createPublicKey(RECEIPT_PRIVATE_KEY);

function validators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: () => undefined,
		runtime: () => undefined,
		effect: () => undefined,
		recovery: () => undefined,
	};
}

function goalProjection(path: string): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let state = emptyGoalState();
	if (existsSync(path)) state = JSON.parse(readFileSync(path, "utf8")) as GoalState;
	return {
		read: () => structuredClone(state),
		compareAndSwap: (expected, next) => {
			if (digestObject(state) !== digestObject(expected)) return false;
			state = structuredClone(next);
			writeFileSync(path, canonicalJsonBytes(state), { mode: 0o600 });
			return true;
		},
	};
}

function receiptArtifactBytes(ref: WorkflowArtifactRef): Uint8Array {
	return canonicalJsonBytes({
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		sourceEventSequence: ref.sourceEventSequence,
		payloadDigest: "process-worker",
	});
}

function receipt(
	id: string,
	bindingDigest = `${id}-binding`,
	revision = 1,
	stateDigest = "worker-state",
): WorkflowVerifiedHostReceipt {
	const normalizedBindingDigest = /^[0-9a-f]{64}$/u.test(bindingDigest)
		? bindingDigest
		: digestObject({ kind: "learning-worker-fixture-binding", bindingDigest });
	const baseRef: WorkflowArtifactRef = {
		artifactId: `receipt-${id}`,
		relativePath: `artifacts/evidence/${"0".repeat(64)}`,
		digest: "0".repeat(64),
		sizeBytes: 0,
		sourceEventSequence: 0,
	};
	const bytes = receiptArtifactBytes(baseRef);
	const artifactRef = { ...baseRef, digest: sha256Hex(bytes), sizeBytes: bytes.byteLength };
	const signed = {
		receiptKind: "artifact" as const,
		oneUse: true,
		receiptId: id,
		issuerId: "process-worker-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: normalizedBindingDigest,
		payloadDigest: `${id}-payload`,
		artifactRef,
		issuedAt: NOW,
		validUntil: LATER,
		keyId: "process-worker-key",
		signatureAlgorithm: "ed25519" as const,
		artifactBytesDigest: artifactRef.digest,
		stateDigest,
		revision,
	};
	const signature = sign(null, Buffer.from(canonicalJsonBytes(signed)), RECEIPT_PRIVATE_KEY).toString("base64");
	const withoutVerification = { ...signed, signature, verificationDigest: "" };
	return { ...withoutVerification, verificationDigest: digestObject(withoutVerification) };
}

function stripReceipt(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripReceipt(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
			.map(([key, item]) => [key, stripReceipt(item)]),
	);
}

function boundReceipt(
	id: string,
	kind: string,
	payload: unknown,
	revision = 1,
	stateDigest = "worker-state",
): WorkflowVerifiedHostReceipt {
	const base = receipt(id, `${id}-binding`, revision, stateDigest);
	const bindingDigest = digestObject({
		kind,
		payloadDigest: digestObject(stripReceipt(payload)),
		receiptId: base.receiptId,
		receiptPayloadDigest: base.payloadDigest,
	});
	return receipt(id, bindingDigest, revision, stateDigest);
}

function createReceiptContext(
	root: string,
	durable: WorkflowRuntimeStoreDurableContext,
): WorkflowHostReceiptConsumerContext {
	const receiptRecordPath = join(
		root,
		"workflows",
		WORKFLOW_ID,
		"side-records",
		"learning-worker-receipt-consumption.json",
	);
	const readConsumed = async (): Promise<Record<string, WorkflowHostReceiptConsumptionWitness>> => {
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(receiptRecordPath));
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return {};
			throw error;
		}
		const parsed = parseCanonicalJsonBytes(bytes);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
			throw new Error("process worker receipt consumption record is invalid");
		const witnesses = (parsed as { witnesses?: unknown }).witnesses;
		if (typeof witnesses !== "object" || witnesses === null || Array.isArray(witnesses))
			throw new Error("process worker receipt consumption witnesses are invalid");
		return witnesses as Record<string, WorkflowHostReceiptConsumptionWitness>;
	};
	const resolver: WorkflowHostReceiptResolver = {
		resolve: async (input) => {
			const { signature: _signature, verificationDigest: _verificationDigest, ...signed } = input.receipt;
			const issued = Date.parse(input.receipt.issuedAt);
			const expires = Date.parse(input.receipt.validUntil);
			if (
				input.receipt.workflowId !== input.workflowId ||
				input.receipt.bindingDigest !== input.expectedBindingDigest ||
				input.receipt.artifactBytesDigest !== sha256Hex(input.artifactBytes) ||
				input.receipt.stateDigest !== input.currentStateDigest ||
				input.receipt.revision !== input.currentRevision ||
				!Number.isFinite(issued) ||
				!Number.isFinite(expires) ||
				Date.parse(input.trustedNow) < issued ||
				Date.parse(input.trustedNow) >= expires ||
				input.receipt.verificationDigest !== digestObject({ ...input.receipt, verificationDigest: "" }) ||
				!verify(
					null,
					Buffer.from(canonicalJsonBytes(signed)),
					RECEIPT_PUBLIC_KEY,
					Buffer.from(input.receipt.signature, "base64"),
				)
			)
				throw new Error("process worker receipt failed canonical signature verification");
			return structuredClone(input.receipt);
		},
		consumeIfOneUse: async (input) => {
			if (!input.receipt.oneUse) return;
			await durable.withExclusiveLease("learning-worker-receipt-consume", async () => {
				const witnesses = await readConsumed();
				if (witnesses[input.receipt.receiptId] !== undefined)
					throw new Error("process worker receipt already consumed");
				witnesses[input.receipt.receiptId] = {
					receiptId: input.receipt.receiptId,
					workflowId: input.workflowId,
					bindingDigest: input.expectedBindingDigest,
					capability: input.receipt.capabilityBinding?.capability ?? null,
					resourceDigest: input.receipt.capabilityBinding?.resourceDigest ?? null,
					operationDigest: input.receipt.capabilityBinding?.operationDigest ?? null,
					receiptDigest: digestObject(input.receipt),
					consumedAt: NOW,
					consumptionSequence: Object.keys(witnesses).length + 1,
				};
				await writeFile(receiptRecordPath, canonicalJsonBytes({ version: 1, witnesses }), { mode: 0o600 });
			});
		},
		resolveConsumptionWitness: async (input) => {
			const witness = (await readConsumed())[input.receiptId];
			if (
				witness === undefined ||
				witness.workflowId !== input.workflowId ||
				witness.bindingDigest !== input.expectedBindingDigest
			)
				throw new Error("process worker receipt consumption witness is missing");
			return witness;
		},
	};
	return {
		receiptResolver: resolver,
		keyResolver: {
			resolve: async () => ({
				algorithm: "ed25519" as const,
				ownerPrincipal: "process-worker-host",
				allowedCapabilities: new Set(),
				generationId: "process-worker-generation",
				epochRef: EPOCH,
				fencingDigest: digestObject({ generationId: "process-worker-generation", epochRef: EPOCH }),
				revoked: false,
				verify: ({ bytes, signature }) =>
					verify(null, Buffer.from(bytes), RECEIPT_PUBLIC_KEY, Buffer.from(signature, "base64")),
			}),
		},
		revokedReceiptIds: new Set<string>(),
		artifactResolver: {
			resolve: async (ref) => ({
				envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
				exists: true,
				bytes: receiptArtifactBytes(ref),
				verifiedDigest: sha256Hex(receiptArtifactBytes(ref)),
				verifiedSizeBytes: receiptArtifactBytes(ref).byteLength,
			}),
		},
		principalAuthorizer: {
			authorize: async () => {
				throw new Error("Process worker fixture has no capability receipt authority.");
			},
		},
	};
}

async function fsResolver(
	root: string,
	context: WorkflowHostReceiptConsumerContext,
): Promise<WorkflowArtifactResolver> {
	return {
		resolve: async (ref) => {
			if (ref.artifactId.startsWith("receipt-")) return context.artifactResolver.resolve(ref);
			const bytes = new Uint8Array(await readFile(join(root, ref.relativePath)));
			return {
				envelope: { ref, payloadKind: "evidence", codec: "canonical_json", immutable: true },
				exists: true,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
}

function witness(
	stage: string,
	candidateId: string | null,
	ref: WorkflowArtifactRef,
	current: WorkflowLearningHostSnapshot,
	payloadDigest: string,
	kind: WorkflowLearningWitnessKind = "evidence",
): WorkflowLearningHostWitness {
	return {
		witnessId: `${stage}-${ref.artifactId}`,
		witnessKind: kind,
		workflowId: current.workflowId,
		stage,
		candidateId,
		evidenceRef: ref,
		payloadDigest,
		bytesDigest: ref.digest,
		bytesSize: ref.sizeBytes,
		revision: current.currentRevision,
		storeEpoch: current.storeEpoch ?? 1,
		coordinatorEpoch: current.coordinatorEpoch ?? 1,
		stateHeadDigest: current.stateHeadDigest ?? DIGEST,
		trustedNow: current.trustedNow,
		oneUse: true,
	};
}

function ports(current: WorkflowLearningHostSnapshot): WorkflowLearningPorts {
	const host: WorkflowLearningHost = {
		current: async () => current,
		createCandidate: async () => {
			throw new Error("process worker candidate stage unused");
		},
		runShadow: async () => {
			throw new Error("process worker shadow stage unused");
		},
		runCanary: async () => {
			throw new Error("process worker canary stage unused");
		},
		runIndependentRedTeam: async () => {
			throw new Error("process worker red-team stage unused");
		},
		resolveDecision: async () => {
			throw new Error("process worker decision stage unused");
		},
		classifyCandidate: async () => {
			throw new Error("process worker classifier unused");
		},
		resolveEvidence: async ({
			stage,
			candidateId,
			evidenceRefs,
			payloadDigest,
			witnessKind,
			current: inputCurrent,
		}) => {
			const resolved = evidenceRefs.map((ref) =>
				witness(stage, candidateId, ref, inputCurrent, payloadDigest, witnessKind),
			);
			return resolved;
		},
		promote: async () => {
			throw new Error("process worker promotion unused");
		},
		reconcilePromotion: async () => {
			throw new Error("process worker promotion reconciliation unused");
		},
		proposeRollback: async () => {
			throw new Error("process worker rollback unused");
		},
		applyRollback: async () => {
			throw new Error("process worker rollback application unused");
		},
	};
	return {
		evidenceValidator: {
			validate: async () => ({ accepted: true, code: "accepted", evidenceDigest: "worker-evidence", findings: [] }),
		},
		decisionGate: { validateVerdicts: async () => undefined, authorize: async () => "authorized" },
		receiptPort: {
			verify: async ({ receipt, bindingDigest, stage, candidateId, current: inputCurrent }) =>
				witness(stage, candidateId, receipt.artifactRef, inputCurrent, bindingDigest, "receipt"),
			consume: async ({ receipt, bindingDigest, stage, candidateId, current: inputCurrent }) =>
				witness(stage, candidateId, receipt.artifactRef, inputCurrent, bindingDigest, "receipt"),
		},
		host,
	};
}

async function publish(host: PersistedSessionWorkflowHost, id: string): Promise<WorkflowArtifactRef> {
	return (
		await host.runtimeStore.publishArtifact({
			workflowId: WORKFLOW_ID,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes({ id }),
			codec: "canonical_json",
			sourceEventSequence: 0,
			idempotencyKey: `process-worker:${id}`,
		})
	).envelope.ref;
}

async function binding(
	host: PersistedSessionWorkflowHost,
	root: string,
	current: WorkflowLearningHostSnapshot,
	refs: { scorecardRef: WorkflowArtifactRef; evaluatorRef: WorkflowArtifactRef; metricRef: WorkflowArtifactRef },
	operationId?: string,
): Promise<WorkflowLearningRuntimeBinding> {
	const replay = await host.runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: current.storeEpoch ?? 1,
	});
	const active = JSON.parse(
		await readFile(join(root, "workflows", WORKFLOW_ID, "side-records", "active-generation.json"), "utf8"),
	) as { leaseRef: WorkflowLearningRuntimeBinding["leaseRef"] };
	const authorityWithoutReceipt: Omit<WorkflowLearningApprovedAuthority, "receipt"> = {
		...refs,
		decisionRef: {
			decisionId: "process-worker-decision",
			decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
			revision: 1,
			storeEpoch: replay.head.epochRef.storeEpoch,
			coordinatorEpoch: replay.head.epochRef.coordinatorEpoch,
			decisionDigest: DIGEST,
		},
		owner: "autoresearch",
		producer: "autoresearch",
		kind: "methodology",
		sampleSize: 1,
		effectThreshold: 0.01,
		tolerance: 0.01,
		maxCostMicrounits: 100,
		maxLatencyMilliseconds: 100,
		evaluatorDigest: refs.evaluatorRef.digest,
		metricDigest: refs.metricRef.digest,
	};
	const authority: WorkflowLearningApprovedAuthority = {
		...authorityWithoutReceipt,
		receipt: receipt(
			"process-worker-authority",
			workflowLearningAuthorityBindingDigest({
				workflowId: WORKFLOW_ID,
				expectedHead: replay.head,
				epochRef: replay.head.epochRef,
				stateHeadDigest: current.stateHeadDigest ?? DIGEST,
				authority: authorityWithoutReceipt,
				operationId,
			}),
			current.currentRevision,
			current.stateDigest,
		),
	};
	return {
		workflowId: WORKFLOW_ID,
		expectedHead: replay.head,
		epochRef: replay.head.epochRef,
		leaseRef: active.leaseRef,
		writerIdentity: active.leaseRef.writerIdentity,
		executionKey: "process-worker-execution",
		ownerId: "process-worker",
		phase: "refining",
		semanticStateDigest: current.stateHeadDigest ?? DIGEST,
		expectedGenerations: { workflow: replay.head.epochRef.storeEpoch },
		approvedAuthority: authority,
	};
}

function experience(
	sourceEventRef: WorkflowArtifactRef,
	progressRef: WorkflowArtifactRef,
): WorkflowLearningExperienceInput {
	const evidence = {
		evidenceId: "process-worker-evidence",
		evidenceRevision: 1,
		requirementId: "process-worker-requirement",
		claim: "The process worker observed durable progress.",
		result: "exit-zero",
		method: "process-worker",
		command: null,
		artifactObservations: [
			{
				artifactRef: progressRef,
				exists: true as const,
				verifiedDigest: progressRef.digest,
				verifiedSizeBytes: progressRef.sizeBytes,
			},
		],
		scanner: {
			scannerDigest: "process-worker-scanner",
			scanStatus: "passed" as const,
			redactionStatus: "not_required" as const,
			findingCodes: [],
			findingDigest: "process-worker-findings",
		},
		confidence: "high" as const,
		limitations: [],
		workspaceDigest: "worker-workspace",
		configDigest: "worker-config",
		revisions: { contractRevision: 1, scorecardRevision: 1, planRevision: 1, configRevision: 1, evidenceRevision: 1 },
		evaluatorDigest: "worker-evaluator",
		parserDigest: "worker-parser",
		guardDigest: "worker-guard",
		updatedDigest: "worker-updated",
		invalidatedByDecisionRef: null,
		regressed: false,
		auditorDecisionRef: null,
		observedAt: NOW,
		freshUntil: LATER,
		freshnessWindowMilliseconds: 3_600_000,
	};
	const value: WorkflowLearningExperienceInput = {
		experienceId: "process-worker-experience",
		workflowId: WORKFLOW_ID,
		source: "host",
		outcome: "positive",
		progressKind: "verified",
		progressEvidenceRefs: [progressRef],
		evidence: [evidence],
		committedAt: NOW,
		sourceEventRef,
		hostReceipt: receipt("process-worker-experience"),
	};
	value.hostReceipt = boundReceipt(value.hostReceipt.receiptId, "committed_experience", {
		experienceId: value.experienceId,
		workflowId: value.workflowId,
		outcome: value.outcome,
		progressKind: value.progressKind,
		progressEvidenceRefs: value.progressEvidenceRefs,
		evidenceDigest: digestObject(value.evidence),
		sourceEventRef: value.sourceEventRef,
	});
	return value;
}

async function bootstrap(host: PersistedSessionWorkflowHost): Promise<void> {
	const replay = await host.runtimeStore.replay({ workflowId: WORKFLOW_ID, fromSequence: 0, expectedStoreEpoch: 1 });
	if (replay.events.some((event) => event.payload.kind === "workflow_started")) return;
	await host.execute({
		kind: "start",
		request: {
			workflowId: WORKFLOW_ID,
			objective: "process restart learning",
			acceptanceChecks: ["process-learning-runtime"],
			protectedInvariants: ["durable-learning-cas"],
		},
	});
}

async function acceptance(root: string, host: PersistedSessionWorkflowHost): Promise<void> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("process worker durable context unavailable");
	const replay = await host.runtimeStore.replay({
		workflowId: WORKFLOW_ID,
		fromSequence: 0,
		expectedStoreEpoch: durable.epochRef.storeEpoch,
	});
	const provider = createLocalWorkflowJournalKeyProvider({
		sessionArtifactRoot: root,
		rootSessionId: ROOT_SESSION_ID,
	});
	const key = await provider.current(WORKFLOW_ID, durable.epochRef);
	const unsigned = {
		version: 1,
		workflowId: WORKFLOW_ID,
		rootSessionId: ROOT_SESSION_ID,
		head: replay.head,
		acceptance: { acceptanceCheckIds: ["process-replays"], protectedInvariantIds: ["durable-cas"] },
		keyId: key.keyId,
		generationId: key.generationId,
	};
	const mac = createHmac("sha256", key.secret).update(canonicalJsonBytes(unsigned)).digest("hex");
	await writeFile(
		join(root, "workflows", WORKFLOW_ID, "side-records", "acceptance.json"),
		canonicalJsonBytes({ ...unsigned, mac }),
		{ mode: 0o600 },
	);
}

interface DurablePromotionEffect {
	kind: "workflow_learning_promotion_effect";
	reconciliation: WorkflowLearningPromotionReconciliation;
}

interface DurableRollbackEffect {
	kind: "workflow_learning_rollback_effect";
	application: WorkflowLearningRollbackApplication;
}

interface DurableLearningEffectRefs {
	candidateRef: WorkflowArtifactRef;
	proposalRef: WorkflowArtifactRef;
	scorecardRef: WorkflowArtifactRef;
	evaluatorRef: WorkflowArtifactRef;
	metricRef: WorkflowArtifactRef;
	parserRef: WorkflowArtifactRef;
	baselineArtifactRef: WorkflowArtifactRef;
	sourceEventRef: WorkflowArtifactRef;
	evidenceRef: WorkflowArtifactRef;
}

function contentAddressedRef(bytes: Uint8Array, sourceEventSequence = 0): WorkflowArtifactRef {
	const digest = sha256Hex(bytes);
	return {
		artifactId: `evidence:${digest}`,
		relativePath: `artifacts/evidence/${digest}`,
		digest,
		sizeBytes: bytes.byteLength,
		sourceEventSequence,
	};
}

async function publishDurableEffect(
	host: PersistedSessionWorkflowHost,
	resolver: WorkflowArtifactResolver,
	key: "promotion" | "rollback",
	operationId: string,
	bytes: Uint8Array,
	crashAfterPublish: boolean,
): Promise<WorkflowArtifactRef> {
	const durable = host.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("effect harness durable context unavailable");
	const ref = contentAddressedRef(bytes);
	if (await artifactPresent(resolver, ref)) return ref;
	await durable.withExclusiveLease(`learning-effect:${key}`, async () => {
		if (await artifactPresent(resolver, ref)) return;
		await host.runtimeStore.publishArtifact({
			workflowId: WORKFLOW_ID,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: 0,
			idempotencyKey: `learning-effect:${key}:${operationId}`,
		});
	});
	if (crashAfterPublish) throw new Error("simulated crash after durable effect publication");
	return ref;
}

async function artifactPresent(resolver: WorkflowArtifactResolver, ref: WorkflowArtifactRef): Promise<boolean> {
	try {
		await resolver.resolve(ref);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return false;
		throw error;
	}
}

async function resolveEffect<T>(resolver: WorkflowArtifactResolver, ref: WorkflowArtifactRef): Promise<T> {
	const resolved = await resolver.resolve(ref);
	if (!resolved.exists || resolved.verifiedDigest !== ref.digest || resolved.verifiedSizeBytes !== ref.sizeBytes)
		throw new Error("effect harness artifact failed resolver verification");
	return parseCanonicalJsonBytes(new Uint8Array(resolved.bytes)) as unknown as T;
}

function effectTriggerIdentity(trigger: WorkflowLearningTrigger): string {
	return digestObject({
		kind: trigger.kind,
		candidateId: trigger.candidateId,
		sourceEventRef: trigger.sourceEventRef,
		workflowId: trigger.workflowId,
		storeEpoch: trigger.storeEpoch,
		coordinatorEpoch: trigger.coordinatorEpoch,
		stateHeadDigest: trigger.stateHeadDigest,
		evidenceDigest: trigger.evidenceDigest,
		evidenceRefs: trigger.evidenceRefs,
		hostReceipt: trigger.hostReceipt,
	});
}

function effectRegistryCasDigest(
	candidate: WorkflowLearningCandidate,
	proposal: WorkflowLearningRollbackProposal,
	trigger: WorkflowLearningTrigger,
	decisionRef: WorkflowLearningRollbackApplication["decisionRef"],
	expected: WorkflowLearningCasExpectation,
): string {
	return digestObject({
		kind: "workflow_learning_rollback_registry_cas",
		workflowId: candidate.workflowId,
		candidateId: candidate.candidateId,
		rollbackOf: proposal.rollbackOf,
		proposalId: proposal.proposalId,
		proposalDigest: proposal.proposalDigest,
		triggerIdentity: effectTriggerIdentity(trigger),
		decisionRef,
		expected,
	});
}

function makeEffectInputs(
	runtimeHost: PersistedSessionWorkflowHost,
	root: string,
	resolver: WorkflowArtifactResolver,
	crashPromotion: boolean,
): Promise<{
	ports: WorkflowLearningPorts;
	host: WorkflowLearningHost;
	effectAuthority: WorkflowLearningDurableEffectAuthority;
	current: WorkflowLearningHostSnapshot;
	refs: Pick<DurableLearningEffectRefs, "scorecardRef" | "evaluatorRef" | "metricRef">;
	promotionInput: Parameters<WorkflowLearningHost["reconcilePromotion"]>[0];
	rollbackInput: Parameters<WorkflowLearningHost["applyRollback"]>[0];
}> {
	return (async () => {
		const fixtureRef = (id: string): WorkflowArtifactRef => contentAddressedRef(canonicalJsonBytes({ id }));
		const refs: DurableLearningEffectRefs = {
			candidateRef: fixtureRef("effect-candidate"),
			proposalRef: fixtureRef("effect-proposal"),
			scorecardRef: fixtureRef("effect-scorecard"),
			evaluatorRef: fixtureRef("effect-evaluator"),
			metricRef: fixtureRef("effect-metric"),
			parserRef: fixtureRef("effect-parser"),
			baselineArtifactRef: fixtureRef("effect-baseline"),
			sourceEventRef: fixtureRef("effect-source"),
			evidenceRef: fixtureRef("effect-evidence"),
		};
		if (crashPromotion) {
			for (const id of [
				"effect-candidate",
				"effect-proposal",
				"effect-scorecard",
				"effect-evaluator",
				"effect-metric",
				"effect-parser",
				"effect-baseline",
				"effect-source",
				"effect-evidence",
			]) {
				const published = await publish(runtimeHost, id);
				if (published.digest !== fixtureRef(id).digest)
					throw new Error("effect fixture digest changed across processes");
			}
		}
		const candidate: WorkflowLearningCandidate = {
			candidateId: "effect-candidate-1",
			experienceId: "effect-experience-1",
			workflowId: WORKFLOW_ID,
			owner: "autoresearch",
			producer: "autoresearch",
			kind: "methodology",
			mutationClass: "workflow",
			proposalRef: refs.proposalRef,
			candidateRef: refs.candidateRef,
			candidateDigest: refs.candidateRef.digest,
			baselineRevision: 1,
			baselineDigest: "effect-baseline-digest",
			baselineArtifactRef: refs.baselineArtifactRef,
			scorecardRef: refs.scorecardRef,
			scorecardDigest: refs.scorecardRef.digest,
			evaluatorRef: refs.evaluatorRef,
			evaluatorDigest: refs.evaluatorRef.digest,
			parserRef: refs.parserRef,
			caseManifest: {
				manifestId: "effect-manifest",
				kind: "held_out",
				sourceArtifactRefs: [refs.sourceEventRef],
				inputDigest: "effect-input",
				hidden: true,
				requiredSampleSize: 1,
				effectThreshold: 0.01,
				tolerance: 0.01,
				nonRegressionPredicateRefs: [refs.evidenceRef],
				maxCostMicrounits: 100,
				maxLatencyMilliseconds: 100,
				manifestDigest: "effect-manifest-digest",
				heldOutInputDigest: "effect-held-out",
			},
			hiddenHoldoutManifestRef: refs.evidenceRef,
			proposal: null,
			hostReceipt: receipt("effect-candidate"),
		};
		const decisionRef = {
			decisionId: "effect-decision",
			decisionScope: { kind: "workflow" as const, workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
			decisionDigest: DIGEST,
		};
		const decision = {
			decision: {} as WorkflowLearningDecision["decision"],
			operation: {} as WorkflowLearningDecision["operation"],
			decisionRef,
		} satisfies WorkflowLearningDecision;
		const trigger: WorkflowLearningTrigger = {
			kind: "regression",
			candidateId: candidate.candidateId,
			sourceEventRef: refs.sourceEventRef,
			evidenceRefs: [refs.evidenceRef],
			workflowId: WORKFLOW_ID,
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
			stateHeadDigest: DIGEST,
			evidenceDigest: digestObject([refs.evidenceRef]),
			hostReceipt: receipt("effect-trigger"),
		};
		const expected: WorkflowLearningCasExpectation = {
			currentRevision: 1,
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
			stateHeadDigest: DIGEST,
		};
		const shadow = {
			candidateId: candidate.candidateId,
			sameCaseInputDigest: candidate.caseManifest.inputDigest,
			heldOutInputDigest: candidate.caseManifest.heldOutInputDigest ?? "",
			heldOutSampleCount: 1,
			heldOutPassed: true,
			overfittingDetected: false,
			nonRegressionPassed: true,
			safetyPassed: true,
			evidenceRefs: [refs.evidenceRef],
			receipts: [],
			resultRef: refs.evidenceRef,
		} satisfies WorkflowLearningShadowResult;
		const canary = {
			candidateId: candidate.candidateId,
			inputDigest: candidate.caseManifest.inputDigest,
			passed: true,
			sessionId: "effect-canary-session",
			executionIdentity: "effect-canary-execution",
			evidenceRefs: [refs.evidenceRef],
			receipts: [],
			resultRef: refs.evidenceRef,
		} satisfies WorkflowLearningCanaryResult;
		const redTeam = {
			candidateId: candidate.candidateId,
			independent: true,
			passed: true,
			sessionId: "effect-red-team-session",
			executionIdentity: "effect-red-team-execution",
			evidenceRefs: [refs.evidenceRef],
			receipts: [],
			resultRef: refs.evidenceRef,
		} satisfies WorkflowLearningRedTeamResult;
		const promotion: WorkflowLearningPromotion = {
			promotionId: "effect-promotion-1",
			candidateId: candidate.candidateId,
			revisionId: "effect-revision-2",
			revision: 2,
			policyDigest: "effect-policy-2",
			stateHeadDigest: "effect-head-2",
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "effect-promotion-cas",
			receipt: receipt("effect-promotion"),
		};
		const proposal: WorkflowLearningRollbackProposal = {
			proposalId: "effect-rollback-1",
			candidateId: candidate.candidateId,
			rollbackOf: promotion.revisionId,
			proposalRef: refs.proposalRef,
			proposalDigest: refs.proposalRef.digest,
			stateHeadDigest: expected.stateHeadDigest,
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			casExecutionKey: "effect-rollback-cas",
			receipt: receipt("effect-rollback-proposal"),
		};
		const effectCurrent: WorkflowLearningHostSnapshot = {
			workflowId: WORKFLOW_ID,
			stateDigest: "worker-state",
			workspaceDigest: "effect-workspace",
			configDigest: "effect-config",
			parserDigest: refs.parserRef.digest,
			evaluatorDigest: refs.evaluatorRef.digest,
			guardDigest: "effect-guard",
			revisions: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			currentRevision: 1,
			trustedNow: NOW,
			trustedClockReceipt: receipt("effect-clock"),
			requiredFreshnessMilliseconds: 1,
			baselineRevision: 1,
			baselineDigest: candidate.baselineDigest,
			evaluatorBaselineDigest: refs.evaluatorRef.digest,
			metricBaselineDigest: refs.metricRef.digest,
			revisionRegistryDigest: "effect-registry",
			artifactResolver: resolver,
			receiptContext: createReceiptContext(root, runtimeHost.runtimeStore.durableContext!),
			storeEpoch: runtimeHost.runtimeStore.durableContext!.epochRef.storeEpoch,
			coordinatorEpoch: runtimeHost.runtimeStore.durableContext!.epochRef.coordinatorEpoch,
			stateHeadDigest: expected.stateHeadDigest,
		};
		const effectPorts = ports(effectCurrent);
		const learningHost = effectPorts.host;
		const projection: WorkflowLearningHostProjection = {
			workflowId: WORKFLOW_ID,
			stateDigest: "effect-state",
			workspaceDigest: "effect-workspace",
			configDigest: "effect-config",
			parserDigest: refs.parserRef.digest,
			evaluatorDigest: refs.evaluatorRef.digest,
			guardDigest: "effect-guard",
			revisions: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			currentRevision: 1,
			trustedNow: NOW,
			requiredFreshnessMilliseconds: 1,
			baselineRevision: 1,
			baselineDigest: candidate.baselineDigest,
			evaluatorBaselineDigest: refs.evaluatorRef.digest,
			metricBaselineDigest: refs.metricRef.digest,
			revisionRegistryDigest: "effect-registry",
			storeEpoch: expected.storeEpoch,
			coordinatorEpoch: expected.coordinatorEpoch,
			stateHeadDigest: expected.stateHeadDigest,
		};
		const promotionInput: Parameters<WorkflowLearningHost["reconcilePromotion"]>[0] = {
			operationId: "effect-promotion-operation",
			candidate,
			shadow,
			canary,
			redTeam,
			decision,
			current: projection,
			expected,
		};
		const rollbackInput: Parameters<WorkflowLearningHost["applyRollback"]>[0] = {
			operationId: "effect-rollback-operation",
			candidate,
			trigger,
			proposal,
			decisionRef,
			current: projection,
			expected,
		};
		const promotionRecord = (input: Parameters<WorkflowLearningHost["promote"]>[0]): DurablePromotionEffect => ({
			kind: "workflow_learning_promotion_effect",
			reconciliation: {
				operationId: input.operationId,
				workflowId: input.candidate.workflowId,
				candidateId: input.candidate.candidateId,
				decisionRef: input.decision.decisionRef!,
				expected: input.expected,
				promotion,
			},
		});
		learningHost.reconcilePromotion = async (input) => {
			const effectRef = contentAddressedRef(canonicalJsonBytes(promotionRecord(input)));
			if (!(await artifactPresent(resolver, effectRef))) return null;
			const record = await resolveEffect<DurablePromotionEffect>(resolver, effectRef);
			if (
				record.kind !== "workflow_learning_promotion_effect" ||
				record.reconciliation.operationId !== input.operationId ||
				record.reconciliation.workflowId !== input.candidate.workflowId ||
				record.reconciliation.candidateId !== input.candidate.candidateId ||
				digestObject(record.reconciliation.expected) !== digestObject(input.expected) ||
				digestObject(record.reconciliation.decisionRef) !== digestObject(input.decision.decisionRef)
			)
				throw new Error("effect promotion reconciliation binding mismatch");
			return record.reconciliation;
		};
		learningHost.promote = async (input) => {
			const existing = await learningHost.reconcilePromotion(input);
			if (existing !== null) return existing.promotion;
			const effectRef = await publishDurableEffect(
				runtimeHost,
				resolver,
				"promotion",
				input.operationId,
				canonicalJsonBytes(promotionRecord(input)),
				crashPromotion,
			);
			if (effectRef.digest.length !== 64) throw new Error("effect promotion artifact ref is invalid");
			return promotion;
		};
		learningHost.applyRollback = async (input) => {
			const applicationBase = {
				operationId: input.operationId,
				workflowId: input.candidate.workflowId,
				candidateId: input.candidate.candidateId,
				rollbackOf: input.proposal.rollbackOf,
				proposalId: input.proposal.proposalId,
				proposalRef: input.proposal.proposalRef,
				proposalDigest: input.proposal.proposalDigest,
				triggerIdentity: effectTriggerIdentity(input.trigger),
				decisionRef: input.decisionRef,
				expected: input.expected,
				receipt: receipt("effect-rollback-application"),
				registryCasDigest: effectRegistryCasDigest(
					input.candidate,
					input.proposal,
					input.trigger,
					input.decisionRef,
					input.expected,
				),
				appliedRevision: 1,
				reloadedRevision: 1,
				futureLoadRevision: 1,
				stateHeadDigest: input.expected.stateHeadDigest,
				storeEpoch: input.expected.storeEpoch,
				coordinatorEpoch: input.expected.coordinatorEpoch,
				casExecutionKey: "effect-rollback-apply-cas",
			};
			const appliedRegistryDigest = digestObject({
				kind: "workflow_learning_rollback_registry_applied",
				registryCasDigest: applicationBase.registryCasDigest,
				proposalDigest: applicationBase.proposalDigest,
				revision: applicationBase.appliedRevision,
			});
			const reloadedRegistryDigest = digestObject({
				kind: "workflow_learning_rollback_registry_reloaded",
				appliedRegistryDigest,
				revision: applicationBase.reloadedRevision,
			});
			const futureLoadDigest = digestObject({
				kind: "workflow_learning_rollback_future_load",
				reloadedRegistryDigest,
				revision: applicationBase.futureLoadRevision,
			});
			const application: WorkflowLearningRollbackApplication = {
				...applicationBase,
				appliedRegistryDigest,
				reloadedRegistryDigest,
				futureLoadDigest,
			};
			const effectBytes = canonicalJsonBytes({ kind: "workflow_learning_rollback_effect", application });
			const effectRef = contentAddressedRef(effectBytes);
			if (await artifactPresent(resolver, effectRef))
				return (await resolveEffect<DurableRollbackEffect>(resolver, effectRef)).application;
			await publishDurableEffect(runtimeHost, resolver, "rollback", input.operationId, effectBytes, false);
			return application;
		};
		const effectAuthority: WorkflowLearningDurableEffectAuthority = {
			runtimeStore: runtimeHost.runtimeStore,
			durableContext: runtimeHost.runtimeStore.durableContext!,
			reconcilePromotion: (input: Parameters<WorkflowLearningHost["reconcilePromotion"]>[0]) =>
				learningHost.reconcilePromotion(input),
			promote: (input: Parameters<WorkflowLearningHost["promote"]>[0]) => learningHost.promote(input),
			proposeRollback: (input: Parameters<WorkflowLearningHost["proposeRollback"]>[0]) =>
				learningHost.proposeRollback(input),
			applyRollback: (input: Parameters<WorkflowLearningHost["applyRollback"]>[0]) =>
				learningHost.applyRollback(input),
		};
		const result = {
			ports: effectPorts,
			host: learningHost,
			current: effectCurrent,
			refs: {
				scorecardRef: refs.scorecardRef,
				evaluatorRef: refs.evaluatorRef,
				metricRef: refs.metricRef,
			},
			effectAuthority,
			promotionInput,
			rollbackInput,
		};
		return result;
	})();
}

interface AdapterRuleRegistry {
	version: 1;
	workflowId: string;
	candidateId: string;
	behavior: "baseline" | "promoted";
	revision: number;
	stateHeadDigest: string;
	policyDigest: string;
	artifactRef: WorkflowArtifactRef;
	registryDigest: string;
}

interface AdapterEffectInputs {
	ports: WorkflowLearningPorts;
	current: WorkflowLearningHostSnapshot;
	refs: Pick<
		DurableLearningEffectRefs,
		"scorecardRef" | "evaluatorRef" | "metricRef" | "proposalRef" | "sourceEventRef" | "evidenceRef"
	>;
	experience: WorkflowLearningExperienceInput;
	trigger: WorkflowLearningTrigger;
	readBehavior(): Promise<AdapterRuleRegistry["behavior"]>;
}

async function makeAdapterEffectInputs(
	runtimeHost: PersistedSessionWorkflowHost,
	root: string,
	resolver: WorkflowArtifactResolver,
): Promise<AdapterEffectInputs> {
	const durable = runtimeHost.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("adapter effect harness requires durable context");
	const candidateId = "adapter-candidate-1";
	const publishJson = async (id: string, payload: unknown): Promise<WorkflowArtifactRef> => {
		const bytes = canonicalJsonBytes(payload);
		const ref = contentAddressedRef(bytes);
		if (await artifactPresent(resolver, ref)) return ref;
		const published = await runtimeHost.runtimeStore.publishArtifact({
			workflowId: WORKFLOW_ID,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: 0,
			idempotencyKey: `adapter-learning:${id}:${durable.epochRef.storeEpoch}:${durable.epochRef.coordinatorEpoch}`,
		});
		if (published.envelope.ref.digest !== ref.digest || published.envelope.ref.sizeBytes !== ref.sizeBytes)
			throw new Error(`adapter artifact ${id} changed its canonical digest`);
		return ref;
	};
	const registryPath = join(root, "workflows", WORKFLOW_ID, "side-records", "adapter-rule-registry.json");
	const readRegistry = async (): Promise<AdapterRuleRegistry | null> => {
		try {
			const bytes = new Uint8Array(await readFile(registryPath));
			const parsed = parseCanonicalJsonBytes(bytes) as unknown as AdapterRuleRegistry;
			const { registryDigest: _registryDigest, ...withoutDigest } = parsed;
			if (
				parsed.version !== 1 ||
				parsed.workflowId !== WORKFLOW_ID ||
				parsed.candidateId !== candidateId ||
				digestObject(withoutDigest) !== parsed.registryDigest
			)
				throw new Error("adapter rule registry is not canonical or content-bound");
			return parsed;
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "ENOENT") return null;
			throw error;
		}
	};
	const writeRegistry = async (
		base: Omit<AdapterRuleRegistry, "registryDigest">,
		expectedDigest: string | null,
	): Promise<AdapterRuleRegistry> => {
		const next = { ...base, registryDigest: digestObject(base) } satisfies AdapterRuleRegistry;
		await durable.withExclusiveLease("adapter-learning-rule-registry", async () => {
			const existing = await readRegistry();
			if ((existing?.registryDigest ?? null) !== expectedDigest)
				throw new Error("adapter learning rule registry CAS lost");
			await writeFile(registryPath, canonicalJsonBytes(next), { mode: 0o600 });
		});
		return next;
	};
	const scorecardRef = await publishJson("scorecard", { kind: "adapter-scorecard", workflowId: WORKFLOW_ID });
	const evaluatorRef = await publishJson("evaluator", { kind: "adapter-evaluator", workflowId: WORKFLOW_ID });
	const metricRef = await publishJson("metric", { kind: "adapter-metric", workflowId: WORKFLOW_ID });
	const parserRef = await publishJson("parser", { kind: "adapter-parser", workflowId: WORKFLOW_ID });
	const sourceEventRef = await publishJson("source-event", { kind: "adapter-source-event", workflowId: WORKFLOW_ID });
	const evidenceRef = await publishJson("evidence", { kind: "adapter-evidence", workflowId: WORKFLOW_ID });
	const progressRef = await publishJson("progress", { kind: "adapter-progress", workflowId: WORKFLOW_ID });
	const baselineArtifactRef = await publishJson("baseline", {
		kind: "adapter-baseline",
		workflowId: WORKFLOW_ID,
		behavior: "baseline",
	});
	const proposalRef = await publishJson("proposal", {
		kind: "adapter-proposal",
		workflowId: WORKFLOW_ID,
		candidateId,
		behavior: "promoted",
	});
	const baseManifest = {
		manifestId: "adapter-holdout-manifest",
		kind: "held_out",
		sourceArtifactRefs: [sourceEventRef],
		inputDigest: "adapter-same-case-input",
		hidden: true,
		requiredSampleSize: 1,
		effectThreshold: 0.01,
		tolerance: 0.01,
		nonRegressionPredicateRefs: [evidenceRef],
		maxCostMicrounits: 100,
		maxLatencyMilliseconds: 100,
		heldOutInputDigest: "adapter-held-out-input",
		manifestDigest: "",
	} as const;
	const caseManifest = {
		...baseManifest,
		manifestDigest: digestObject(baseManifest),
	} as WorkflowImprovementCaseManifest;
	const hiddenHoldoutManifestRef = await publishJson("holdout-manifest", {
		schemaVersion: 1,
		kind: "workflow_learning_holdout_manifest",
		workflowId: WORKFLOW_ID,
		candidateId,
		manifestDigest: caseManifest.manifestDigest,
		manifest: caseManifest,
	});
	const candidateRef = await publishJson("candidate", {
		kind: "adapter-candidate",
		workflowId: WORKFLOW_ID,
		candidateId,
		proposalRef,
	});
	const baselineStateHead = DIGEST;
	let registry = await readRegistry();
	if (registry === null) {
		registry = await writeRegistry(
			{
				version: 1,
				workflowId: WORKFLOW_ID,
				candidateId,
				behavior: "baseline",
				revision: 1,
				stateHeadDigest: baselineStateHead,
				policyDigest: "adapter-policy-baseline",
				artifactRef: baselineArtifactRef,
			},
			null,
		);
	}
	if (registry === null) throw new Error("adapter rule registry bootstrap failed");
	let activeRegistry: AdapterRuleRegistry = registry;
	const current: WorkflowLearningHostSnapshot = {
		workflowId: WORKFLOW_ID,
		stateDigest: "worker-state",
		workspaceDigest: "adapter-workspace",
		configDigest: "adapter-config",
		parserDigest: parserRef.digest,
		evaluatorDigest: evaluatorRef.digest,
		guardDigest: "adapter-guard",
		revisions: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		currentRevision: registry.revision,
		trustedNow: NOW,
		trustedClockReceipt: receipt(`adapter-clock-${registry.revision}`, "adapter-clock-binding", registry.revision),
		requiredFreshnessMilliseconds: 1,
		baselineRevision: 1,
		baselineDigest: "adapter-baseline-digest",
		evaluatorBaselineDigest: evaluatorRef.digest,
		metricBaselineDigest: metricRef.digest,
		revisionRegistryDigest: registry.registryDigest,
		artifactResolver: resolver,
		receiptContext: createReceiptContext(root, durable),
		storeEpoch: durable.epochRef.storeEpoch,
		coordinatorEpoch: durable.epochRef.coordinatorEpoch,
		stateHeadDigest: registry.stateHeadDigest,
	};
	const initialExperience = experience(sourceEventRef, progressRef);
	const experiencePayload = {
		experienceId: "adapter-experience-1",
		workflowId: initialExperience.workflowId,
		outcome: initialExperience.outcome,
		progressKind: initialExperience.progressKind,
		progressEvidenceRefs: initialExperience.progressEvidenceRefs,
		evidenceDigest: digestObject(initialExperience.evidence),
		sourceEventRef: initialExperience.sourceEventRef,
	};
	const adapterExperience: WorkflowLearningExperienceInput = {
		...initialExperience,
		experienceId: "adapter-experience-1",
		hostReceipt: boundReceipt("adapter-experience", "committed_experience", experiencePayload),
	};
	const trigger: WorkflowLearningTrigger = {
		kind: "milestone",
		candidateId: null,
		sourceEventRef,
		evidenceRefs: [progressRef],
		workflowId: WORKFLOW_ID,
		storeEpoch: current.storeEpoch,
		coordinatorEpoch: current.coordinatorEpoch,
		stateHeadDigest: current.stateHeadDigest,
		evidenceDigest: digestObject([progressRef]),
		hostReceipt: receipt("adapter-trigger"),
	};
	trigger.hostReceipt = boundReceipt("adapter-trigger", "trigger", trigger);
	const candidate: WorkflowLearningCandidate = {
		candidateId,
		experienceId: adapterExperience.experienceId,
		workflowId: WORKFLOW_ID,
		owner: "autoresearch",
		producer: "autoresearch",
		kind: "methodology",
		mutationClass: "workflow",
		proposalRef,
		candidateRef,
		candidateDigest: candidateRef.digest,
		baselineRevision: current.baselineRevision,
		baselineDigest: current.baselineDigest,
		baselineArtifactRef,
		scorecardRef,
		scorecardDigest: scorecardRef.digest,
		evaluatorRef,
		evaluatorDigest: evaluatorRef.digest,
		parserRef,
		caseManifest,
		hiddenHoldoutManifestRef,
		proposal: null,
		hostReceipt: receipt("adapter-candidate"),
	};
	candidate.hostReceipt = boundReceipt("adapter-candidate", "typed_candidate", { candidate, trigger });
	const metrics = (): {
		sampleCount: number;
		effectSize: number;
		variance: number;
		costMicrounits: number;
		latencyMilliseconds: number;
		evaluatorDigest: string;
		metricDigest: string;
		evidenceDigest: string;
	} => ({
		sampleCount: 1,
		effectSize: 0.1,
		variance: 0.01,
		costMicrounits: 1,
		latencyMilliseconds: 1,
		evaluatorDigest: evaluatorRef.digest,
		metricDigest: metricRef.digest,
		evidenceDigest: digestObject([evidenceRef]),
	});
	const stageArtifact = async (stage: "shadow" | "canary" | "red_team", result: Record<string, unknown>) =>
		publishJson(`${stage}-result`, {
			schemaVersion: 1,
			kind: "workflow_learning_stage_result",
			workflowId: WORKFLOW_ID,
			candidateId,
			stage,
			...result,
		});
	const shadowBase = {
		candidateId,
		sameCaseInputDigest: caseManifest.inputDigest,
		heldOutInputDigest: baseManifest.heldOutInputDigest,
		heldOutSampleCount: 1,
		heldOutPassed: true,
		overfittingDetected: false,
		nonRegressionPassed: true,
		safetyPassed: true,
		evidenceRefs: [evidenceRef],
		receipts: [receipt("adapter-shadow")],
		resultRef: evidenceRef,
		metrics: metrics(),
	};
	const shadowResult = {
		...shadowBase,
		resultRef: await stageArtifact("shadow", shadowBase),
	};
	const canaryBase = {
		candidateId,
		inputDigest: caseManifest.inputDigest,
		passed: true,
		sessionId: "adapter-canary-session",
		executionIdentity: "adapter-canary-execution",
		evidenceRefs: [evidenceRef],
		receipts: [receipt("adapter-canary")],
		resultRef: evidenceRef,
		metrics: metrics(),
	};
	const canaryResult = { ...canaryBase, resultRef: await stageArtifact("canary", canaryBase) };
	const redTeamBase = {
		candidateId,
		independent: true,
		passed: true,
		sessionId: "adapter-red-team-session",
		executionIdentity: "adapter-red-team-execution",
		evidenceRefs: [evidenceRef],
		receipts: [receipt("adapter-red-team")],
		resultRef: evidenceRef,
		metrics: metrics(),
	};
	const redTeamResult = { ...redTeamBase, resultRef: await stageArtifact("red_team", redTeamBase) };
	const decisionRecord = {
		decisionId: "adapter-decision",
		decisionScope: { kind: "workflow" as const, workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
	};
	const makeDecision = (): WorkflowLearningDecision => {
		return {
			decision: decisionRecord as WorkflowLearningDecision["decision"],
			operation: {} as WorkflowLearningDecision["operation"],
			decisionRef: {
				decisionId: "process-worker-decision",
				decisionScope: { kind: "workflow", workflowId: WORKFLOW_ID, rootSessionId: ROOT_SESSION_ID },
				revision: 1,
				storeEpoch: current.storeEpoch!,
				coordinatorEpoch: current.coordinatorEpoch!,
				decisionDigest: DIGEST,
			},
			decisionWitness: witness(
				"decision",
				candidateId,
				evidenceRef,
				current,
				digestObject(decisionRecord),
				"decision",
			),
		};
	};
	const originalPorts = ports(current);
	const learningHost = originalPorts.host;
	const writeBehavior = async (
		behavior: AdapterRuleRegistry["behavior"],
		revision: number,
		stateHeadDigest: string,
		policyDigest: string,
		artifactRef: WorkflowArtifactRef,
	): Promise<void> => {
		activeRegistry = await writeRegistry(
			{
				version: 1,
				workflowId: WORKFLOW_ID,
				candidateId,
				behavior,
				revision,
				stateHeadDigest,
				policyDigest,
				artifactRef,
			},
			activeRegistry.registryDigest,
		);
		current.currentRevision = activeRegistry.revision;
		current.stateHeadDigest = activeRegistry.stateHeadDigest;
		current.revisionRegistryDigest = activeRegistry.registryDigest;
		current.trustedClockReceipt = receipt(
			`adapter-clock-${activeRegistry.revision}`,
			"adapter-clock-binding",
			activeRegistry.revision,
		);
	};
	const promotionRecord = (input: Parameters<WorkflowLearningHost["promote"]>[0]): DurablePromotionEffect => ({
		kind: "workflow_learning_promotion_effect",
		reconciliation: {
			operationId: input.operationId,
			workflowId: WORKFLOW_ID,
			candidateId,
			decisionRef: input.decision.decisionRef!,
			expected: input.expected,
			promotion: {
				promotionId: "adapter-promotion-1",
				candidateId,
				revisionId: "adapter-revision-2",
				revision: 2,
				policyDigest: "adapter-policy-promoted",
				stateHeadDigest: "e".repeat(64),
				storeEpoch: input.expected.storeEpoch,
				coordinatorEpoch: input.expected.coordinatorEpoch,
				casExecutionKey: "adapter-promotion-cas",
				receipt: receipt("adapter-promotion", "adapter-promotion-binding"),
			},
		},
	});
	learningHost.createCandidate = async ({ trigger: recordedTrigger }) => {
		const typedCandidate = { ...candidate, hostReceipt: receipt("adapter-candidate") };
		return {
			...typedCandidate,
			hostReceipt: boundReceipt("adapter-candidate", "typed_candidate", {
				candidate: typedCandidate,
				trigger: recordedTrigger,
			}),
		};
	};
	learningHost.classifyCandidate = async ({ candidate: classified }) => ({
		mutationClass: classified.mutationClass,
		payloadDigest: classified.candidateDigest,
		classifierDigest: "adapter-classifier",
		protectedPaths: [],
		proposalDigest: null,
	});
	learningHost.runShadow = async ({ candidate: reviewedCandidate }) => ({
		...shadowResult,
		receipts: [
			boundReceipt("adapter-shadow", "shadow_review", {
				candidate: reviewedCandidate,
				shadow: shadowResult,
			}),
		],
	});
	learningHost.runCanary = async ({ candidate: reviewedCandidate, shadow }) => ({
		...canaryResult,
		receipts: [
			boundReceipt("adapter-canary", "canary_review", {
				candidate: reviewedCandidate,
				shadow,
				canary: canaryResult,
			}),
		],
	});
	learningHost.runIndependentRedTeam = async ({ candidate: reviewedCandidate, shadow, canary }) => ({
		...redTeamResult,
		receipts: [
			boundReceipt("adapter-red-team", "independent_red_team", {
				candidate: reviewedCandidate,
				shadow,
				canary,
				redTeam: redTeamResult,
			}),
		],
	});
	learningHost.resolveDecision = async () => makeDecision();
	learningHost.reconcilePromotion = async (input) => {
		const effect = promotionRecord(input);
		if (!(await artifactPresent(resolver, contentAddressedRef(canonicalJsonBytes(effect))))) return null;
		const resolved = await resolveEffect<DurablePromotionEffect>(
			resolver,
			contentAddressedRef(canonicalJsonBytes(effect)),
		);
		return resolved.reconciliation;
	};
	learningHost.promote = async (input) => {
		const existing = await learningHost.reconcilePromotion(input);
		if (existing !== null) return existing.promotion;
		const effect = promotionRecord(input);
		const effectBytes = canonicalJsonBytes(effect);
		const effectRef = await publishJson("promotion-effect", effect);
		const promotion = effect.reconciliation.promotion;
		const boundPromotion = {
			...promotion,
			receipt: boundReceipt("adapter-promotion", "host_fenced_promotion", {
				candidate: input.candidate,
				shadow: input.shadow,
				canary: input.canary,
				redTeam: input.redTeam,
				decision: input.decision,
				promotion,
			}),
		};
		await writeBehavior("promoted", 2, boundPromotion.stateHeadDigest!, boundPromotion.policyDigest, effectRef);
		void effectBytes;
		return boundPromotion;
	};
	learningHost.proposeRollback = async (input) => {
		const proposal = {
			proposalId: "adapter-rollback-1",
			candidateId,
			rollbackOf: "adapter-revision-2",
			proposalRef,
			proposalDigest: proposalRef.digest,
			stateHeadDigest: input.expected.stateHeadDigest,
			storeEpoch: input.expected.storeEpoch,
			coordinatorEpoch: input.expected.coordinatorEpoch,
			casExecutionKey: "adapter-rollback-cas",
			receipt: receipt("adapter-rollback-proposal", "adapter-rollback-binding", current.currentRevision),
		};
		return {
			...proposal,
			receipt: boundReceipt(
				"adapter-rollback-proposal",
				"rollback_proposal",
				{
					candidate: input.candidate,
					trigger: input.trigger,
					proposal,
					decisionRef: input.decisionRef,
				},
				input.expected.currentRevision,
				current.stateDigest,
			),
		};
	};
	learningHost.applyRollback = async (input) => {
		const applicationBase = {
			operationId: input.operationId,
			workflowId: WORKFLOW_ID,
			candidateId,
			rollbackOf: input.proposal.rollbackOf,
			proposalId: input.proposal.proposalId,
			proposalRef: input.proposal.proposalRef,
			proposalDigest: input.proposal.proposalDigest,
			triggerIdentity: digestObject({
				kind: input.trigger.kind,
				candidateId: input.trigger.candidateId,
				sourceEventRef: input.trigger.sourceEventRef,
				workflowId: input.trigger.workflowId,
				storeEpoch: input.trigger.storeEpoch,
				coordinatorEpoch: input.trigger.coordinatorEpoch,
				stateHeadDigest: input.trigger.stateHeadDigest,
				evidenceDigest: input.trigger.evidenceDigest,
				evidenceRefs: input.trigger.evidenceRefs,
				hostReceipt: input.trigger.hostReceipt,
			}),
			decisionRef: input.decisionRef,
			expected: input.expected,
			registryCasDigest: digestObject({
				kind: "workflow_learning_rollback_registry_cas",
				workflowId: WORKFLOW_ID,
				candidateId,
				rollbackOf: input.proposal.rollbackOf,
				proposalId: input.proposal.proposalId,
				proposalDigest: input.proposal.proposalDigest,
				triggerIdentity: digestObject({
					kind: input.trigger.kind,
					candidateId: input.trigger.candidateId,
					sourceEventRef: input.trigger.sourceEventRef,
					workflowId: input.trigger.workflowId,
					storeEpoch: input.trigger.storeEpoch,
					coordinatorEpoch: input.trigger.coordinatorEpoch,
					stateHeadDigest: input.trigger.stateHeadDigest,
					evidenceDigest: input.trigger.evidenceDigest,
					evidenceRefs: input.trigger.evidenceRefs,
					hostReceipt: input.trigger.hostReceipt,
				}),
				decisionRef: input.decisionRef,
				expected: input.expected,
			}),
			appliedRevision: 1,
			reloadedRevision: 1,
			futureLoadRevision: 1,
			stateHeadDigest: input.expected.stateHeadDigest,
			storeEpoch: input.expected.storeEpoch,
			coordinatorEpoch: input.expected.coordinatorEpoch,
			casExecutionKey: "adapter-rollback-apply-cas",
		};
		const appliedRegistryDigest = digestObject({
			kind: "workflow_learning_rollback_registry_applied",
			registryCasDigest: applicationBase.registryCasDigest,
			proposalDigest: applicationBase.proposalDigest,
			revision: applicationBase.appliedRevision,
		});
		const reloadedRegistryDigest = digestObject({
			kind: "workflow_learning_rollback_registry_reloaded",
			appliedRegistryDigest,
			revision: applicationBase.reloadedRevision,
		});
		const futureLoadDigest = digestObject({
			kind: "workflow_learning_rollback_future_load",
			reloadedRegistryDigest,
			revision: applicationBase.futureLoadRevision,
		});
		const application = {
			...applicationBase,
			appliedRegistryDigest,
			reloadedRegistryDigest,
			futureLoadDigest,
			receipt: receipt(
				"adapter-rollback-application",
				"adapter-rollback-application-binding",
				current.currentRevision,
			),
		};
		const effectRef = await publishJson("rollback-effect", {
			kind: "workflow_learning_rollback_effect",
			application,
		});
		await writeBehavior("baseline", 1, DIGEST, "adapter-policy-baseline", effectRef);
		return {
			...application,
			receipt: boundReceipt(
				"adapter-rollback-application",
				"rollback_applied",
				{
					candidate: input.candidate,
					trigger: input.trigger,
					proposal: input.proposal,
					application,
				},
				input.expected.currentRevision,
				current.stateDigest,
			),
		};
	};
	return {
		ports: originalPorts,
		current,
		refs: { scorecardRef, evaluatorRef, metricRef, proposalRef, sourceEventRef, evidenceRef },
		experience: adapterExperience,
		trigger,
		readBehavior: async () => activeRegistry.behavior,
	};
}

export async function runLearningRuntimeWorker(
	mode:
		| "commit"
		| "duplicate"
		| "replay"
		| "effects-crash"
		| "effects-reconcile"
		| "effects-reopen"
		| "adapter-promote"
		| "adapter-rollback"
		| "adapter-reopen",
	root: string,
	handoffPath: string,
): Promise<void> {
	let host: PersistedSessionWorkflowHost | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot: root,
			rootSessionId: ROOT_SESSION_ID,
			workflowId: WORKFLOW_ID,
			goalProjection: goalProjection(join(root, "goal-projection.json")),
			genesisEpoch: EPOCH,
			deferredOwnerValidators: validators(),
			writerIdentity: "process-worker-writer",
			processIdentity: createLocalAppendLeaseProcessIdentity(),
		});
		const durable = host.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("process worker runtime is not durable");
		const context = createReceiptContext(root, durable);
		if (mode === "commit" || mode === "effects-crash") {
			await bootstrap(host);
			await acceptance(root, host);
		}
		const resolver = await fsResolver(join(root, "workflows", WORKFLOW_ID), context);
		if (mode === "adapter-promote" || mode === "adapter-rollback" || mode === "adapter-reopen") {
			if (mode === "adapter-promote") await bootstrap(host);
			const effects = await makeAdapterEffectInputs(host, root, resolver);
			const adapter = await createWorkflowLearningRuntimeAdapterWithDurableEffects({
				host: issueWorkflowLearningSessionHostIdentity(host),
				ports: effects.ports,
				artifactResolver: resolver,
				readBinding: (operationId) => binding(host!, root, effects.current, effects.refs, operationId),
				effectAuthority: {
					runtimeStore: host.runtimeStore,
					durableContext: host.runtimeStore.durableContext!,
					reconcilePromotion: effects.ports.host.reconcilePromotion,
					promote: effects.ports.host.promote,
					proposeRollback: effects.ports.host.proposeRollback,
					applyRollback: effects.ports.host.applyRollback,
				},
			});
			if (mode === "adapter-promote") {
				const committed = await adapter.commitExperience(effects.experience);
				const candidate = await adapter.typeCandidate({
					experienceId: committed.experienceId,
					trigger: effects.trigger,
				});
				const reviewed = await adapter.reviewCandidate(candidate.candidateId);
				if (reviewed.status !== "promoted" || (await effects.readBehavior()) !== "promoted")
					throw new Error("adapter-mediated promotion did not change the durable future rule");
				await writeFile(
					handoffPath,
					canonicalJsonBytes({ experienceId: committed.experienceId, candidateId: candidate.candidateId }),
				);
			} else if (mode === "adapter-rollback") {
				const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as {
					candidateId: string;
					experienceId: string;
				};
				await adapter.getState();
				const rollbackTrigger = {
					...effects.trigger,
					kind: "regression" as const,
					candidateId: handoff.candidateId,
					storeEpoch: effects.current.storeEpoch,
					coordinatorEpoch: effects.current.coordinatorEpoch,
					stateHeadDigest: effects.current.stateHeadDigest,
					hostReceipt: receipt(
						"adapter-regression",
						"adapter-regression-binding",
						effects.current.currentRevision,
						effects.current.stateDigest,
					),
				};
				rollbackTrigger.hostReceipt = boundReceipt(
					"adapter-regression",
					"trigger",
					rollbackTrigger,
					effects.current.currentRevision,
					effects.current.stateDigest,
				);
				const result = await adapter.handleTrigger(rollbackTrigger);
				if (result.status !== "rollback_proposed" || (await effects.readBehavior()) !== "baseline")
					throw new Error("adapter-mediated rollback did not restore the durable future rule");
			} else {
				await adapter.getState();
				if ((await effects.readBehavior()) !== "baseline")
					throw new Error("reopened adapter did not observe the rolled-back future rule");
			}
			console.log(`process-worker:${mode}:ok`);
			return;
		}
		if (mode === "effects-crash" || mode === "effects-reconcile" || mode === "effects-reopen") {
			const effects = await makeEffectInputs(host, root, resolver, mode === "effects-crash");
			const durableAdapter = await createWorkflowLearningRuntimeAdapterWithDurableEffects({
				host: issueWorkflowLearningSessionHostIdentity(host),
				ports: effects.ports,
				artifactResolver: resolver,
				readBinding: (operationId) => binding(host!, root, effects.current, effects.refs, operationId),
				effectAuthority: effects.effectAuthority,
			});
			if ((await durableAdapter.getState()).schemaVersion !== 1)
				throw new Error("durable learning factory did not replay a valid state");
			if (mode === "effects-crash") {
				await expectEffectCrash(effects.host, effects.promotionInput);
			} else {
				const first = await effects.host.reconcilePromotion(effects.promotionInput);
				if (first === null) throw new Error("promotion effect was not discoverable after restart");
				const promotion = await effects.host.promote(effects.promotionInput);
				const reconciled = await effects.host.reconcilePromotion(effects.promotionInput);
				if (reconciled === null || digestObject(reconciled.promotion) !== digestObject(promotion))
					throw new Error("promotion effect did not reconcile after restart");
				const applied = await effects.host.applyRollback(effects.rollbackInput);
				const retried = await effects.host.applyRollback(effects.rollbackInput);
				if (digestObject(retried) !== digestObject(applied))
					throw new Error("rollback effect was not idempotent across retries");
			}
			console.log(`process-worker:${mode}:ok`);
			return;
		}
		const current: WorkflowLearningHostSnapshot = {
			workflowId: WORKFLOW_ID,
			stateDigest: "worker-state",
			workspaceDigest: "worker-workspace",
			configDigest: "worker-config",
			parserDigest: "worker-parser",
			evaluatorDigest: "worker-evaluator",
			guardDigest: "worker-guard",
			revisions: {
				contractRevision: 1,
				scorecardRevision: 1,
				planRevision: 1,
				configRevision: 1,
				evidenceRevision: 1,
			},
			currentRevision: 1,
			trustedNow: NOW,
			trustedClockReceipt: receipt("process-worker-clock"),
			requiredFreshnessMilliseconds: 1,
			baselineRevision: 1,
			baselineDigest: "worker-baseline",
			evaluatorBaselineDigest: "worker-evaluator-baseline",
			metricBaselineDigest: "worker-metric-baseline",
			revisionRegistryDigest: "worker-registry",
			artifactResolver: resolver,
			receiptContext: context,
			storeEpoch: 1,
			coordinatorEpoch: 1,
			stateHeadDigest: DIGEST,
		};
		let refs: {
			scorecardRef: WorkflowArtifactRef;
			evaluatorRef: WorkflowArtifactRef;
			metricRef: WorkflowArtifactRef;
		};
		let input: WorkflowLearningExperienceInput;
		if (mode === "commit") {
			refs = {
				scorecardRef: await publish(host, "approved-scorecard"),
				evaluatorRef: await publish(host, "approved-evaluator"),
				metricRef: await publish(host, "approved-metric"),
			};
			input = experience(await publish(host, "source-event"), await publish(host, "progress"));
			await writeFile(handoffPath, canonicalJsonBytes({ input, refs }));
		} else {
			const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as {
				input: WorkflowLearningExperienceInput;
				refs: typeof refs;
			};
			refs = handoff.refs;
			input = handoff.input;
		}
		const currentHead = await host.runtimeStore.replay({
			workflowId: WORKFLOW_ID,
			fromSequence: 0,
			expectedStoreEpoch: 1,
		});
		current.storeEpoch = currentHead.head.epochRef.storeEpoch;
		current.coordinatorEpoch = currentHead.head.epochRef.coordinatorEpoch;
		const adapter = await createWorkflowLearningRuntimeAdapterForSessionHost({
			host: issueWorkflowLearningSessionHostIdentity(host),
			ports: ports(current),
			artifactResolver: resolver,
			readBinding: (operationId) => binding(host!, root, current, refs, operationId),
		});
		if (mode === "commit") await adapter.commitExperience(input);
		else if (mode === "duplicate") {
			const duplicate = await adapter.commitExperience(input);
			if (duplicate.experienceId !== input.experienceId)
				throw new Error("process B did not return the durable duplicate experience");
		} else if ((await adapter.getState()).experiences.length !== 1)
			throw new Error("process B did not replay exactly one learning experience");
		console.log(`process-worker:${mode}:ok`);
	} finally {
		await host?.dispose?.();
	}
}

async function expectEffectCrash(
	host: WorkflowLearningHost,
	input: Parameters<WorkflowLearningHost["promote"]>[0],
): Promise<void> {
	try {
		await host.promote(input);
	} catch (error) {
		if (error instanceof Error && error.message.includes("simulated crash")) return;
		throw error;
	}
	throw new Error("effect crash harness did not cross the durable effect boundary");
}
