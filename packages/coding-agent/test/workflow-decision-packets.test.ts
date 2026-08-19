import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../src/core/goals.js";
import {
	canonicalJsonBytes,
	createFixtureHostReceipt,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowJournalHead,
	type WorkflowRuntimeStore,
} from "../src/core/workflow/contracts.js";
import {
	admitWorkflowDecisionPacketIngest,
	createWorkflowDecisionPacketTriad,
	createWorkflowEvidenceManifest,
	createWorkflowRemediationPacket,
	createWorkflowTerminalDecisionPacketTriad,
	createWorkflowVerdictPacket,
	deriveWorkflowAmendmentTask,
	estimateWorkflowDecisionPacketTokens,
	issueWorkflowDecisionPacketHostAuthority,
	parseWorkflowDecisionPacketTriad,
	publishWorkflowDecisionPacketTriad,
	readWorkflowDecisionPacketPublication,
	selectivelyExpandWorkflowDecisionEvidence,
	serializeWorkflowDecisionPacketTriad,
	validateWorkflowDecisionPacketDelivery,
	WORKFLOW_DECISION_PACKET_CAPABILITY,
	type WorkflowDecisionEvidenceManifest,
	type WorkflowDecisionPacketHostAuthority,
	type WorkflowDecisionPacketHostRegistry,
	type WorkflowDecisionPacketLifecycle,
	type WorkflowDecisionPacketTriad,
} from "../src/core/workflow/decision-packets.js";
import { createPersistedSessionWorkflowHost } from "../src/core/workflow/session-host-factory.js";

const WORKFLOW_ID = "workflow-decision-packets";
const TASK_ID = "task-design-review";
const ATTEMPT_ID = "attempt-1";
const EPOCH: WorkflowEpochRef = { storeEpoch: 4, coordinatorEpoch: 7 };
const HEAD: WorkflowJournalHead = {
	workflowId: WORKFLOW_ID,
	sequence: 19,
	eventDigest: "a".repeat(64),
	epochRef: EPOCH,
};

function artifactRef(id: string, bytes: string | Uint8Array = `artifact:${id}`): WorkflowArtifactRef {
	const payload = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
	return {
		artifactId: id,
		relativePath: `decision-packets/${id}`,
		digest: sha256Hex(payload),
		sizeBytes: payload.byteLength,
		sourceEventSequence: 20,
	};
}

function reportBytes(): Uint8Array {
	const bytes = new Uint8Array(60_000);
	bytes.fill(97);
	return bytes;
}

function createManifest(
	options: {
		readonly attemptId?: string;
		readonly lifecycle?: WorkflowDecisionPacketLifecycle;
		readonly reportId?: string;
	} = {},
): WorkflowDecisionEvidenceManifest {
	const fullReportRef = artifactRef(options.reportId ?? "report", reportBytes());
	const sectionPayload = "ambiguous finding section";
	const sectionArtifactRef = artifactRef("finding-section", sectionPayload);
	return createWorkflowEvidenceManifest({
		packetId: "manifest-1",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: options.attemptId ?? ATTEMPT_ID,
		lifecycle: options.lifecycle,
		runtimeVersion: "0.147.0-alpha.10",
		head: HEAD,
		epochRef: EPOCH,
		fullReportRef,
		fullReportContentType: "text/markdown",
		sectionRefs: [
			{
				sectionId: "finding-section",
				ordinal: 0,
				title: "Ambiguous finding",
				startOffset: 0,
				endOffset: sectionPayload.length,
				artifactRef: sectionArtifactRef,
				digest: sectionArtifactRef.digest,
				sizeBytes: sectionArtifactRef.sizeBytes,
				sourceEventSequence: sectionArtifactRef.sourceEventSequence,
				contentType: "text/plain",
			},
		],
	});
}

function createVerdict(
	overrides: {
		topBlockers?: ReturnType<typeof createWorkflowVerdictPacket>["topBlockers"];
		expansionRequired?: boolean;
		attemptId?: string;
		lifecycle?: WorkflowDecisionPacketLifecycle;
		summary?: string;
	} = {},
): ReturnType<typeof createWorkflowVerdictPacket> {
	return createWorkflowVerdictPacket({
		packetId: "verdict-1",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: overrides.attemptId ?? ATTEMPT_ID,
		lifecycle: overrides.lifecycle,
		runtimeVersion: "0.147.0-alpha.10",
		head: HEAD,
		epochRef: EPOCH,
		verdict: "rejected",
		topBlockers: overrides.topBlockers ?? [
			{
				blockerId: "blocker-missing-assertion",
				findingIds: ["finding-ambiguous"],
				summary: overrides.summary ?? "The public acceptance assertion is ambiguous.",
				sectionIds: ["finding-section"],
				disposition: "open",
			},
		],
		requirementIds: ["req-public-acceptance"],
		confidence: "high",
		uncertainty: ["The section must be read before amendment."],
		requiredDisposition: "dispatch_amendment",
		expansionRequired: overrides.expansionRequired ?? false,
	});
}

function createRemediation(
	options: {
		readonly attemptId?: string;
		readonly lifecycle?: WorkflowDecisionPacketLifecycle;
		readonly amendments?: ReturnType<typeof createWorkflowRemediationPacket>["amendments"];
		readonly targetFileRefs?: readonly string[];
		readonly targetSectionIds?: readonly string[];
	} = {},
): ReturnType<typeof createWorkflowRemediationPacket> {
	return createWorkflowRemediationPacket({
		packetId: "remediation-1",
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: options.attemptId ?? ATTEMPT_ID,
		lifecycle: options.lifecycle,
		runtimeVersion: "0.147.0-alpha.10",
		head: HEAD,
		epochRef: EPOCH,
		amendments: options.amendments ?? [
			{
				amendmentId: "amendment-assertion",
				text: "Make the public acceptance assertion deterministic.",
				targetSectionIds: options.targetSectionIds ?? ["finding-section"],
				targetFileRefs: options.targetFileRefs ?? ["src/workflow/acceptance.ts"],
			},
		],
		dependencies: ["dependency-public-contract"],
		ownership: { owner: "worker-design-amendment", writeScope: ["src/workflow/acceptance.ts"] },
		requiredNextAction: "Dispatch the amendment task and rerun the public acceptance check.",
		publicAcceptanceChecks: [
			{
				checkId: "check-public-acceptance",
				publicBoundary: "public:workflow-submit",
				description: "A real public-boundary invocation reports the corrected outcome.",
			},
		],
		blockerClosureMapping: [
			{
				blockerId: "blocker-missing-assertion",
				amendmentIds: ["amendment-assertion"],
				requiredEvidenceSectionIds: ["finding-section"],
			},
		],
		requirementClosureMapping: [
			{
				requirementId: "req-public-acceptance",
				amendmentIds: ["amendment-assertion"],
				blockedAction: null,
			},
		],
	});
}

function createTriad(
	options: {
		readonly attemptId?: string;
		readonly lifecycle?: WorkflowDecisionPacketLifecycle;
		readonly reportId?: string;
		readonly targetFileRefs?: readonly string[];
		readonly targetSectionIds?: readonly string[];
	} = {},
): WorkflowDecisionPacketTriad {
	return createWorkflowDecisionPacketTriad({
		verdict: createVerdict(options),
		remediation: createRemediation(options),
		evidenceManifest: createManifest(options),
	});
}

function createTerminalSeal(
	manifest: WorkflowDecisionEvidenceManifest,
	attemptId = ATTEMPT_ID,
): Parameters<typeof createWorkflowTerminalDecisionPacketTriad>[0]["terminalSeal"] {
	const receipt = createFixtureHostReceipt({
		receiptKind: "artifact",
		receiptId: `decision-seal-receipt-${attemptId}`,
		issuerId: "workflow-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: "b".repeat(64),
		payloadDigest: "c".repeat(64),
		artifactRef: artifactRef(`decision-seal-${attemptId}`),
		issuedAt: "2026-08-17T00:00:00.000Z",
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: "fixture-key",
		stateDigest: "d".repeat(64),
	});
	const producerFence = {
		generationId: "generation-decision-seal",
		epochRef: EPOCH,
		fencingDigest: digestObject({ generationId: "generation-decision-seal", epochRef: EPOCH }),
	};
	const unsigned = {
		kind: "verified_artifact_seal" as const,
		sealRef: receipt.artifactRef,
		reportRef: manifest.fullReportRef,
		reportGeneration: 3,
		sectionRefs: manifest.sectionRefs.map((section) => ({
			sectionId: section.sectionId,
			generation: 8,
			artifactRef: section.artifactRef,
			digest: section.digest,
		})),
		producer: {
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId,
			epochRef: EPOCH,
			outputObligationId: "review-result",
			producerFence,
		},
		receipt,
		sealDigest: "",
	};
	return { ...unsigned, sealDigest: digestObject(unsigned) };
}

function createTerminalTriad(attemptId = ATTEMPT_ID): WorkflowDecisionPacketTriad {
	const options = { attemptId, lifecycle: "terminal" as const };
	const manifest = createManifest(options);
	return createWorkflowTerminalDecisionPacketTriad({
		verdict: createVerdict(options),
		remediation: createRemediation(options),
		evidenceManifest: manifest,
		terminalSeal: createTerminalSeal(manifest, attemptId),
	});
}

function resolverForManifest(
	_manifest: WorkflowDecisionEvidenceManifest,
): WorkflowArtifactResolver & { requested: string[] } {
	const payloads = new Map<string, Uint8Array>([
		["report", reportBytes()],
		["finding-section", new TextEncoder().encode("ambiguous finding section")],
	]);
	const requested: string[] = [];
	return {
		requested,
		resolve: async (ref) => {
			requested.push(ref.artifactId);
			const bytes = payloads.get(ref.artifactId);
			if (bytes === undefined) throw new Error(`unexpected artifact ${ref.artifactId}`);
			return {
				envelope: { ref, payloadKind: "evidence", codec: "utf8", immutable: true },
				exists: true,
				bytes,
				verifiedDigest: ref.digest,
				verifiedSizeBytes: ref.sizeBytes,
			};
		},
	};
}

interface FixtureStoreState {
	readonly artifacts: Map<
		string,
		{ readonly ref: WorkflowArtifactRef; readonly bytes: Uint8Array; readonly payloadKind: "evidence" | "handoff" }
	>;
	readonly publications: Map<string, WorkflowArtifactRef>;
	authorityRecord?: Uint8Array;
	publicationRecord?: Uint8Array;
}

interface ReceiptProbe {
	readonly resolveInputs: Record<string, unknown>[];
	readonly consumeInputs: Record<string, unknown>[];
	readonly witnessInputs: Record<string, unknown>[];
	lastReceipt?: unknown;
}

function fixtureReceiptBytes(ref: WorkflowArtifactRef): Uint8Array {
	return canonicalJsonBytes({
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		sourceEventSequence: ref.sourceEventSequence,
		payloadDigest: "fixture",
	});
}

async function createHostAuthorityFixture(
	expectedBlockerIds: readonly string[],
	state: FixtureStoreState = { artifacts: new Map(), publications: new Map() },
	probe?: ReceiptProbe,
): Promise<{
	authority: WorkflowDecisionPacketHostAuthority;
	runtimeStore: WorkflowRuntimeStore;
	state: FixtureStoreState;
}> {
	const sectionBytes = new TextEncoder().encode("ambiguous finding section");
	const resolver: WorkflowArtifactResolver = {
		resolve: async (ref) => {
			const stored = state.artifacts.get(ref.artifactId);
			const bytes =
				stored?.bytes ??
				(ref.artifactId === "report"
					? reportBytes()
					: ref.artifactId.startsWith("decision-seal-")
						? fixtureReceiptBytes(ref)
						: sectionBytes);
			if (sha256Hex(bytes) !== ref.digest || bytes.byteLength !== ref.sizeBytes)
				throw new Error(`fixture artifact mismatch: ${ref.artifactId}`);
			return {
				envelope: { ref, payloadKind: stored?.payloadKind ?? "evidence", codec: "utf8", immutable: true },
				exists: true,
				bytes,
				verifiedDigest: ref.digest,
				verifiedSizeBytes: ref.sizeBytes,
			};
		},
	};
	const lease = {
		...EPOCH,
		leaseId: "fixture-lease",
		acquisitionEventSequence: 1,
		processIdentity: "fixture-process",
		rootDigest: "e".repeat(64),
		writerIdentity: "fixture-writer",
		acquiredAt: "2026-08-17T00:00:00.000Z",
		expiresAt: "2026-08-18T00:00:00.000Z",
	};
	const identity = {
		storeKind: "workflow" as const,
		namespace: "fixture",
		rootDir: "/tmp/fixture-workflow-decision-packets",
		storeId: "fixture-store",
		workflowId: WORKFLOW_ID,
		identityDigest: "f".repeat(64),
	};
	const runtimeStore = {
		identity,
		durableContext: {
			generationId: "generation-decision-seal",
			epochRef: EPOCH,
			currentLeaseRef: () => lease,
			outbox: {},
			auxiliaryStore: {
				read: async (name: string) =>
					name === "workflow-decision-packet-authority.json"
						? (state.authorityRecord ?? null)
						: name === "workflow-decision-packet-publication.json"
							? (state.publicationRecord ?? null)
							: null,
				write: async (name: string, bytes: Uint8Array) => {
					if (name === "workflow-decision-packet-authority.json") state.authorityRecord = Uint8Array.from(bytes);
					if (name === "workflow-decision-packet-publication.json")
						state.publicationRecord = Uint8Array.from(bytes);
				},
			},
			withExclusiveLease: async <T>(_: string, operation: () => Promise<T>): Promise<T> => operation(),
			recoverJournal: async () => ({ quarantined: false, events: [], metadata: {} }),
		},
		commit: async () => {
			throw new Error("fixture commit is not used");
		},
		replay: async () => ({
			workflowId: WORKFLOW_ID,
			executionKey: null,
			events: [],
			head: HEAD,
			quarantined: false,
			quarantineReason: null,
		}),
		publishArtifact: async (input: {
			readonly bytes: Uint8Array;
			readonly idempotencyKey: string;
			readonly sourceEventSequence: number;
		}) => {
			const prior = state.publications.get(input.idempotencyKey);
			if (prior !== undefined)
				return {
					status: "already_published" as const,
					envelope: {
						ref: prior,
						payloadKind: "handoff" as const,
						codec: "utf8" as const,
						immutable: true as const,
					},
				};
			const ref = artifactRef(`publication-${state.publications.size}`, input.bytes);
			state.publications.set(input.idempotencyKey, ref);
			state.artifacts.set(ref.artifactId, { ref, bytes: Uint8Array.from(input.bytes), payloadKind: "handoff" });
			return {
				status: "published" as const,
				envelope: { ref, payloadKind: "handoff" as const, codec: "utf8" as const, immutable: true as const },
			};
		},
	} as unknown as WorkflowRuntimeStore;
	const registry: WorkflowDecisionPacketHostRegistry = {
		recomputeExpectedSet: async () => ({
			blockers: expectedBlockerIds.map((blockerId) => ({
				blockerId,
				findingIds: ["finding-ambiguous"],
				requiredSectionIds: ["finding-section"],
			})),
			requirementIds: ["req-public-acceptance"],
		}),
	};
	const resourceDigest = digestObject({ workflowId: WORKFLOW_ID, capability: WORKFLOW_DECISION_PACKET_CAPABILITY });
	const operationDigest = digestObject({ operation: "decision-packet-delivery" });
	const capabilityReceipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: "decision-capability",
		issuerId: "fixture-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: "b".repeat(64),
		payloadDigest: "c".repeat(64),
		artifactRef: artifactRef("capability-receipt"),
		issuedAt: "2026-08-17T00:00:00.000Z",
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: "fixture-key",
		stateDigest: "d".repeat(64),
		capabilityBinding: {
			capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
			resourceDigest,
			operationDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
	const principalAuthorizer = {
		authorize: async (
			input: Parameters<WorkflowDecisionPacketHostAuthority["principalAuthorizer"]["authorize"]>[0],
		) => ({
			authenticatedPrincipal: "fixture-host",
			keyOwnerPrincipal: "fixture-host",
			capability: input.capability,
			workflowId: input.workflowId,
			bindingDigest: input.bindingDigest,
			receipt: input.receipt,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
			validity: { issuedAt: input.receipt.issuedAt, validUntil: input.receipt.validUntil },
			authorizationDigest: digestObject({
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				resourceDigest: input.resourceDigest,
				operationDigest: input.operationDigest,
				epochRef: input.epochRef,
			}),
		}),
	};
	const receiptContext = {
		receiptResolver: {
			resolve: async (input: Record<string, unknown>) => {
				if (probe !== undefined) {
					probe.resolveInputs.push(input);
					probe.lastReceipt = input.receipt;
				}
				return input.receipt;
			},
			consumeIfOneUse: async (input: Record<string, unknown>) => {
				probe?.consumeInputs.push(input);
			},
			resolveConsumptionWitness: async (input: Record<string, unknown>) => {
				probe?.witnessInputs.push(input);
				return {
					receiptId: input.receiptId,
					workflowId: input.workflowId,
					bindingDigest: input.expectedBindingDigest,
					capability: null,
					resourceDigest: null,
					operationDigest: null,
					receiptDigest: probe?.lastReceipt === undefined ? "0".repeat(64) : digestObject(probe.lastReceipt),
					consumedAt: "2026-08-17T12:00:00.000Z",
					consumptionSequence: 1,
				};
			},
		},
		keyResolver: {
			resolve: async () => {
				throw new Error("fixture key resolver not reached");
			},
		},
		revokedReceiptIds: new Set<string>(),
		artifactResolver: resolver,
		principalAuthorizer,
	} as unknown as WorkflowHostReceiptConsumerContext;
	const authority = await issueWorkflowDecisionPacketHostAuthority({
		runtimeStore,
		artifactResolver: resolver,
		principalAuthorizer,
		registry,
		capabilityReceipt,
		bindingDigest: "b".repeat(64),
		resourceDigest,
		operationDigest,
		stateDigest: "d".repeat(64),
		revision: 3,
		receiptContext,
		expectedReportGeneration: 3,
		expectedSectionGenerations: { "finding-section": 8 },
	});
	return { authority, runtimeStore, state };
}

const binding = () => ({
	workflowId: WORKFLOW_ID,
	taskId: TASK_ID,
	attemptId: ATTEMPT_ID,
	head: HEAD,
	epochRef: EPOCH,
});

async function createRealPacketTriad(
	runtimeStore: WorkflowRuntimeStore,
	head: WorkflowJournalHead,
	epochRef: WorkflowEpochRef,
): Promise<{ triad: WorkflowDecisionPacketTriad; sectionRef: WorkflowArtifactRef }> {
	const sectionBytes = new TextEncoder().encode("real durable decision section");
	const sectionPublication = await runtimeStore.publishArtifact({
		workflowId: WORKFLOW_ID,
		payloadKind: "evidence",
		bytes: sectionBytes,
		codec: "utf8",
		sourceEventSequence: head.sequence,
		idempotencyKey: "decision-packet-real-section",
	});
	const sectionRef = sectionPublication.envelope.ref;
	const fullReportBytes = new Uint8Array(128);
	fullReportBytes.fill(114);
	const fullReportRef = { ...artifactRef("real-report", fullReportBytes), sourceEventSequence: head.sequence };
	const common = {
		workflowId: WORKFLOW_ID,
		taskId: TASK_ID,
		attemptId: ATTEMPT_ID,
		runtimeVersion: "0.147.0-alpha.10",
		head,
		epochRef,
		lifecycle: "provisional" as const,
	};
	const verdict = createWorkflowVerdictPacket({
		packetId: "real-verdict",
		...common,
		verdict: "rejected",
		topBlockers: [
			{
				blockerId: "real-blocker",
				findingIds: ["real-finding"],
				summary: "A durable finding needs an explicit amendment.",
				sectionIds: ["real-section"],
				disposition: "open",
			},
		],
		requirementIds: ["real-requirement"],
		confidence: "medium",
		uncertainty: ["Read the declared durable section."],
		requiredDisposition: "dispatch_amendment",
		expansionRequired: false,
	});
	const remediation = createWorkflowRemediationPacket({
		packetId: "real-remediation",
		...common,
		amendments: [
			{
				amendmentId: "real-amendment",
				text: "Add the durable acceptance assertion.",
				targetSectionIds: ["real-section"],
				targetFileRefs: ["src/workflow/acceptance.ts"],
			},
		],
		dependencies: [],
		ownership: { owner: "real-worker", writeScope: ["src/workflow/acceptance.ts"] },
		requiredNextAction: "Dispatch the durable amendment.",
		publicAcceptanceChecks: [
			{
				checkId: "real-check",
				publicBoundary: "public:workflow-submit",
				description: "The public check reports the corrected result.",
			},
		],
		blockerClosureMapping: [
			{ blockerId: "real-blocker", amendmentIds: ["real-amendment"], requiredEvidenceSectionIds: ["real-section"] },
		],
		requirementClosureMapping: [
			{ requirementId: "real-requirement", amendmentIds: ["real-amendment"], blockedAction: null },
		],
	});
	const evidenceManifest = createWorkflowEvidenceManifest({
		packetId: "real-manifest",
		...common,
		fullReportRef,
		fullReportContentType: "text/plain",
		sectionRefs: [
			{
				sectionId: "real-section",
				ordinal: 0,
				title: "Durable section",
				startOffset: 0,
				endOffset: sectionRef.sizeBytes,
				artifactRef: sectionRef,
				digest: sectionRef.digest,
				sizeBytes: sectionRef.sizeBytes,
				sourceEventSequence: sectionRef.sourceEventSequence,
				contentType: "text/plain",
			},
		],
	});
	return { triad: createWorkflowDecisionPacketTriad({ verdict, remediation, evidenceManifest }), sectionRef };
}

async function createRealHostAuthority(
	runtimeStore: WorkflowRuntimeStore,
	artifactRoot: string,
): Promise<WorkflowDecisionPacketHostAuthority> {
	const resourceDigest = digestObject({ workflowId: WORKFLOW_ID, capability: WORKFLOW_DECISION_PACKET_CAPABILITY });
	const operationDigest = digestObject({ operation: "real-decision-packet-delivery" });
	const capabilityReceipt = createFixtureHostReceipt({
		receiptKind: "capability",
		receiptId: "real-decision-capability",
		issuerId: "real-host",
		workflowId: WORKFLOW_ID,
		bindingDigest: "b".repeat(64),
		payloadDigest: "c".repeat(64),
		artifactRef: artifactRef("real-capability"),
		issuedAt: "2026-08-17T00:00:00.000Z",
		validUntil: "2026-08-18T00:00:00.000Z",
		keyId: "real-key",
		stateDigest: "d".repeat(64),
		capabilityBinding: {
			capability: WORKFLOW_DECISION_PACKET_CAPABILITY,
			resourceDigest,
			operationDigest,
			executionIdentity: null,
			sessionId: null,
		},
	});
	const principalAuthorizer = {
		authorize: async (
			input: Parameters<WorkflowDecisionPacketHostAuthority["principalAuthorizer"]["authorize"]>[0],
		) => ({
			authenticatedPrincipal: "real-host",
			keyOwnerPrincipal: "real-host",
			capability: input.capability,
			workflowId: input.workflowId,
			bindingDigest: input.bindingDigest,
			receipt: input.receipt,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
			validity: { issuedAt: input.receipt.issuedAt, validUntil: input.receipt.validUntil },
			authorizationDigest: digestObject({
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				resourceDigest: input.resourceDigest,
				operationDigest: input.operationDigest,
				epochRef: input.epochRef,
			}),
		}),
	};
	const artifactResolver: WorkflowArtifactResolver = {
		resolve: async (ref) => {
			const bytes = Uint8Array.from(await readFile(join(artifactRoot, "workflows", WORKFLOW_ID, ref.relativePath)));
			return {
				envelope: {
					ref,
					payloadKind: ref.relativePath.includes("/handoff/") ? "handoff" : "evidence",
					codec: "utf8",
					immutable: true,
				},
				exists: true,
				bytes,
				verifiedDigest: sha256Hex(bytes),
				verifiedSizeBytes: bytes.byteLength,
			};
		},
	};
	const registry: WorkflowDecisionPacketHostRegistry = {
		recomputeExpectedSet: async () => ({
			blockers: [{ blockerId: "real-blocker", findingIds: ["real-finding"], requiredSectionIds: ["real-section"] }],
			requirementIds: ["real-requirement"],
		}),
	};
	return issueWorkflowDecisionPacketHostAuthority({
		runtimeStore,
		artifactResolver,
		principalAuthorizer,
		registry,
		capabilityReceipt,
		bindingDigest: "b".repeat(64),
		resourceDigest,
		operationDigest,
		stateDigest: "d".repeat(64),
		revision: 1,
	});
}

function createGoalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let current = emptyGoalState();
	return {
		read: () => structuredClone(current),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			current = structuredClone(next);
			return true;
		},
	};
}

describe("workflow decision packets", () => {
	it("keeps three durable report bodies out of triads while the host decision stays stable", async () => {
		const triads = Array.from({ length: 3 }, (_, index) => createTriad({ reportId: `report-${index}` }));
		for (const triad of triads) {
			expect(triad.packetBytes).toBeLessThan(16_384);
			expect(JSON.stringify(triad)).not.toContain("report body");
		}
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		const decisions = await Promise.all(
			triads.map((packets) =>
				validateWorkflowDecisionPacketDelivery({ packets, currentBinding: binding(), hostAuthority: authority }),
			),
		);
		expect(
			new Set(decisions.map((decision) => `${decision.accepted}:${decision.authoritativeBlockerIds.join(",")}`))
				.size,
		).toBe(1);
		expect(parseWorkflowDecisionPacketTriad(serializeWorkflowDecisionPacketTriad(triads[0]!)).packetDigest).toBe(
			triads[0]!.packetDigest,
		);
	});

	it("dispatches a rejected review from verdict and remediation only", () => {
		const task = deriveWorkflowAmendmentTask({ verdict: createVerdict(), remediation: createRemediation() });
		expect(task.requiredNextAction).toContain("Dispatch");
		expect(task.ownedPaths).toEqual(["src/workflow/acceptance.ts"]);
		expect(task.requirementClosureMapping[0]?.requirementId).toBe("req-public-acceptance");
	});

	it("fetches exactly one declared section for an ambiguous finding", async () => {
		const manifest = createManifest();
		const resolver = resolverForManifest(manifest);
		const correction = {
			kind: "synthesis_remediation_correction" as const,
			sectionIds: ["finding-section"],
			blockerIds: ["blocker-missing-assertion"],
			summary: "Clarify the public acceptance assertion.",
			requiredNextAction: "Amend and rerun the check.",
			correctionDigest: "",
		};
		correction.correctionDigest = digestObject(correction);
		const result = await selectivelyExpandWorkflowDecisionEvidence({
			manifest,
			sectionIds: ["finding-section"],
			resolver,
			reason: "ambiguous_finding",
			synthesize: () => correction,
		});
		expect(resolver.requested).toEqual(["finding-section"]);
		expect(result.sections).toHaveLength(1);
	});

	it("forces expansion for an omitted blocker and ignores worker expansion claims", async () => {
		const triad = createTriad();
		const omitted = createWorkflowDecisionPacketTriad({
			verdict: createVerdict({ topBlockers: [], expansionRequired: false }),
			remediation: triad.remediation,
			evidenceManifest: triad.evidenceManifest,
		});
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		const result = await validateWorkflowDecisionPacketDelivery({
			packets: omitted,
			currentBinding: binding(),
			hostAuthority: authority,
		});
		expect(result.accepted).toBe(false);
		expect(result.expansionRequired).toBe(true);
		expect(result.missingBlockerIds).toEqual(["blocker-missing-assertion"]);
	});

	it("keeps Q25 lens decisions stable and scopes cross-lens contradiction to one section", async () => {
		const triads = Array.from({ length: 25 }, () => createTriad());
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		const decisions = await Promise.all(
			triads.map((packets) =>
				validateWorkflowDecisionPacketDelivery({ packets, currentBinding: binding(), hostAuthority: authority }),
			),
		);
		const manifest = triads[0]!.evidenceManifest;
		const resolver = resolverForManifest(manifest);
		const correction = {
			kind: "synthesis_remediation_correction" as const,
			sectionIds: ["finding-section"],
			blockerIds: ["blocker-missing-assertion"],
			summary: "bounded contradiction",
			requiredNextAction: "Use correction",
			correctionDigest: "",
		};
		correction.correctionDigest = digestObject(correction);
		const conflict = await selectivelyExpandWorkflowDecisionEvidence({
			manifest,
			sectionIds: ["finding-section"],
			disputedSectionIds: ["finding-section"],
			resolver,
			reason: "cross_lens_conflict",
			lensIdentity: { lensId: "lens-1", contradictionId: "contradiction-1" },
			synthesize: () => correction,
		});
		expect(decisions.every((decision) => decision.accepted)).toBe(true);
		expect(new Set(decisions.map((decision) => decision.packetDigest)).size).toBe(1);
		expect(conflict.sections).toHaveLength(1);
	});

	it("rejects conflict expansion without host disputed scope", async () => {
		const manifest = createManifest();
		await expect(
			selectivelyExpandWorkflowDecisionEvidence({
				manifest,
				sectionIds: ["finding-section"],
				resolver: resolverForManifest(manifest),
				reason: "cross_lens_conflict",
				synthesize: () => {
					throw new Error("not reached");
				},
			}),
		).rejects.toThrow(/disputed|scope|host/i);
	});

	it("uses a worst-case ingest bound and forbids full report reads", () => {
		expect(estimateWorkflowDecisionPacketTokens(2_048)).toBe(2_048);
		const admission = admitWorkflowDecisionPacketIngest({
			currentEstimatedContextTokens: 100_000,
			reserveTokens: 2_000,
			headroomTokens: 2_000,
			packetEstimateBytes: 4_000,
			artifactSizeBytes: 19_777,
			sectionSizeBytes: 1_024,
			hardIngestBudgetTokens: 126_000,
			selectiveExpansionOverheadTokens: 500,
			compactionOverheadTokens: 500,
		});
		expect(admission.disposition).toBe("section_required");
		expect(admission.fullReportRead).toBe("forbidden");
	});

	it("rejects report smuggling, traversal paths, and missing requirement actions", () => {
		expect(() => createVerdict({ summary: "report fragment ".repeat(100) })).toThrow(/summary|bound|smuggl/i);
		expect(() => createRemediation({ targetFileRefs: ["../escape.ts"] })).toThrow(/path|traversal|relative/i);
		expect(() =>
			deriveWorkflowAmendmentTask({ verdict: createVerdict(), remediation: createRemediation({ amendments: [] }) }),
		).toThrow(/amendment|requirement|action/i);
	});

	it("verifies terminal seal artifacts and rejects same-attempt updates", async () => {
		const terminal = createTerminalTriad();
		const rawHashOnlySeal = { ...terminal.terminalSeal!, receipt: undefined } as unknown as Parameters<
			typeof createWorkflowTerminalDecisionPacketTriad
		>[0]["terminalSeal"];
		expect(() =>
			createWorkflowTerminalDecisionPacketTriad({
				verdict: createVerdict({ lifecycle: "terminal" }),
				remediation: createRemediation({ lifecycle: "terminal" }),
				evidenceManifest: createManifest({ lifecycle: "terminal" }),
				terminalSeal: rawHashOnlySeal,
			}),
		).toThrow(/receipt/i);
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		const result = await validateWorkflowDecisionPacketDelivery({
			packets: terminal,
			currentBinding: binding(),
			hostAuthority: authority,
		});
		expect(result).toMatchObject({ accepted: true, lifecycle: "terminal", terminalSealVerified: true });
		const staleGenerationSeal = {
			...terminal.terminalSeal!,
			producer: {
				...terminal.terminalSeal!.producer,
				producerFence: {
					...terminal.terminalSeal!.producer.producerFence,
					generationId: "stale-generation",
					fencingDigest: digestObject({ generationId: "stale-generation", epochRef: EPOCH }),
				},
			},
			sealDigest: "",
		};
		const staleGenerationTriad = createWorkflowTerminalDecisionPacketTriad({
			verdict: terminal.verdict,
			remediation: terminal.remediation,
			evidenceManifest: terminal.evidenceManifest,
			terminalSeal: { ...staleGenerationSeal, sealDigest: digestObject(staleGenerationSeal) },
		});
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: staleGenerationTriad,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/generation/i);
		const sameAttempt = createWorkflowTerminalDecisionPacketTriad({
			verdict: createVerdict({ lifecycle: "terminal" }),
			remediation: createRemediation({ lifecycle: "terminal" }),
			evidenceManifest: createManifest({ lifecycle: "terminal" }),
			terminalSeal: createTerminalSeal(createManifest({ lifecycle: "terminal" })),
			supersedesPacketDigest: terminal.packetDigest,
		});
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: sameAttempt,
				priorTerminalPacket: terminal,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/new producer attempt/i);
	});

	it("publishes once through the durable runtime artifact path and reopens from its persisted ref", async () => {
		const state: FixtureStoreState = { artifacts: new Map(), publications: new Map() };
		const first = await createHostAuthorityFixture(["blocker-missing-assertion"], state);
		const triad = createTriad();
		const publication = await publishWorkflowDecisionPacketTriad({
			hostAuthority: first.authority,
			packets: triad,
			currentBinding: binding(),
		});
		expect(publication.status).toBe("published");
		await expect(
			publishWorkflowDecisionPacketTriad({
				hostAuthority: first.authority,
				packets: triad,
				currentBinding: binding(),
			}),
		).rejects.toThrow(/duplicate|already/i);
		const reopenedAuthority = await createHostAuthorityFixture(["blocker-missing-assertion"], state);
		const reopened = await readWorkflowDecisionPacketPublication({
			hostAuthority: reopenedAuthority.authority,
			artifactRef: publication.artifactRef,
		});
		expect(reopened.packetDigest).toBe(triad.packetDigest);
	});

	it("uses a real persisted runtime store across close and reopen", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-decision-packets-real-"));
		let firstHost: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		let secondHost: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
		try {
			firstHost = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "decision-packets-real",
				workflowId: WORKFLOW_ID,
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
				goalProjection: createGoalProjection(),
			});
			const firstReplay = await firstHost.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: 1,
			});
			const firstAuthority = await createRealHostAuthority(firstHost.runtimeStore, artifactRoot);
			const { triad } = await createRealPacketTriad(
				firstHost.runtimeStore,
				firstReplay.head,
				firstReplay.head.epochRef,
			);
			const publication = await publishWorkflowDecisionPacketTriad({
				hostAuthority: firstAuthority,
				packets: triad,
				currentBinding: {
					workflowId: WORKFLOW_ID,
					taskId: TASK_ID,
					attemptId: ATTEMPT_ID,
					head: firstReplay.head,
					epochRef: firstReplay.head.epochRef,
				},
			});
			await firstHost.dispose?.();
			firstHost = undefined;
			secondHost = await createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId: "decision-packets-real",
				workflowId: WORKFLOW_ID,
				genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
				goalProjection: createGoalProjection(),
			});
			const secondReplay = await secondHost.runtimeStore.replay({
				workflowId: WORKFLOW_ID,
				fromSequence: 0,
				expectedStoreEpoch: 1,
			});
			const secondAuthority = await createRealHostAuthority(secondHost.runtimeStore, artifactRoot);
			const reopened = await readWorkflowDecisionPacketPublication({
				hostAuthority: secondAuthority,
				artifactRef: publication.artifactRef,
			});
			expect(reopened.packetDigest).toBe(triad.packetDigest);
			await expect(
				publishWorkflowDecisionPacketTriad({
					hostAuthority: secondAuthority,
					packets: triad,
					currentBinding: {
						workflowId: WORKFLOW_ID,
						taskId: TASK_ID,
						attemptId: ATTEMPT_ID,
						head: secondReplay.head,
						epochRef: secondReplay.head.epochRef,
					},
				}),
			).rejects.toThrow(/duplicate|already/i);
		} finally {
			await firstHost?.dispose?.();
			await secondHost?.dispose?.();
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});

	it("rejects forged stale mutation and raw body at the host boundary", async () => {
		const triad = createTriad();
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: structuredClone(triad),
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).resolves.toMatchObject({ accepted: true });
		const stale = structuredClone(triad);
		(stale.verdict.head as WorkflowJournalHead).sequence += 1;
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: stale,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/head|digest|binding/i);
		const raw = structuredClone(triad) as unknown as Record<string, unknown>;
		raw.rawReportBytes = new Uint8Array(19_777);
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: raw as unknown as WorkflowDecisionPacketTriad,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/closed|raw|packet/i);
	});

	it("detaches caller mutation and rejects accessors, sparse arrays, and oversized manifests", () => {
		const input = {
			packetId: "mutable-verdict",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			runtimeVersion: "0.147.0-alpha.10",
			head: HEAD,
			epochRef: EPOCH,
			verdict: "rejected" as const,
			topBlockers: [
				{
					blockerId: "mutable-blocker",
					findingIds: ["mutable-finding"],
					summary: "Mutable summary",
					sectionIds: ["finding-section"],
					disposition: "open" as const,
				},
			],
			requirementIds: ["req-public-acceptance"],
			confidence: "high" as const,
			uncertainty: [],
			requiredDisposition: "hold" as const,
			expansionRequired: false,
		};
		const packet = createWorkflowVerdictPacket(input);
		input.topBlockers[0]!.summary = "caller mutation";
		expect(packet.topBlockers[0]!.summary).toBe("Mutable summary");
		const accessorInput = structuredClone(input);
		Object.defineProperty(accessorInput.topBlockers[0], "summary", { get: () => "accessor" });
		expect(() => createWorkflowVerdictPacket(accessorInput)).toThrow(/accessor/i);
		const sparseInput = structuredClone(input);
		sparseInput.topBlockers = new Array(1) as typeof sparseInput.topBlockers;
		expect(() => createWorkflowVerdictPacket(sparseInput)).toThrow(/sparse/i);
		const oversizedSections = Array.from({ length: 129 }, (_, index) => ({
			sectionId: `section-${index}`,
			ordinal: index,
			title: "section",
			startOffset: index,
			endOffset: index + 1,
			artifactRef: artifactRef(`section-${index}`, "x"),
			digest: artifactRef(`section-${index}`, "x").digest,
			sizeBytes: 1,
			sourceEventSequence: 20,
			contentType: "text/plain",
		}));
		expect(() =>
			createWorkflowEvidenceManifest({
				packetId: "oversized",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
				runtimeVersion: "0.147.0-alpha.10",
				head: HEAD,
				epochRef: EPOCH,
				fullReportRef: artifactRef("large-report", "x"),
				fullReportContentType: "text/plain",
				sectionRefs: oversizedSections,
			}),
		).toThrow(/count|large|bound/i);
	});

	it("does not expose a caller-mintable closure token", async () => {
		const module = await import("../src/core/workflow/decision-packets.js");
		expect((module as Record<string, unknown>).createWorkflowDecisionPacketHostClosureToken).toBeUndefined();
	});

	it("keeps host callback services behind the persisted authority seal", async () => {
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		expect(Object.keys(authority)).not.toContain("registry");
		expect(Object.keys(authority)).not.toContain("artifactResolver");
		expect(Object.keys(authority)).not.toContain("principalAuthorizer");
	});

	it("binds terminal receipts to independent host time and consumes a one-use witness", async () => {
		const probe: ReceiptProbe = { resolveInputs: [], consumeInputs: [], witnessInputs: [] };
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"], undefined, probe);
		const terminal = createTerminalTriad();
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: terminal,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).resolves.toMatchObject({ terminalSealVerified: true });
		expect(probe.resolveInputs).toHaveLength(1);
		expect(probe.resolveInputs[0]?.trustedNow).not.toBe(terminal.terminalSeal?.receipt.issuedAt);
		expect(probe.consumeInputs).toHaveLength(1);
		expect(probe.witnessInputs).toHaveLength(1);

		const forgedReceipt = { ...terminal.terminalSeal!.receipt, bindingDigest: "e".repeat(64) };
		const forgedUnsigned = { ...terminal.terminalSeal!, receipt: forgedReceipt, sealDigest: "" };
		const forged = createWorkflowTerminalDecisionPacketTriad({
			verdict: terminal.verdict,
			remediation: terminal.remediation,
			evidenceManifest: terminal.evidenceManifest,
			terminalSeal: { ...forgedUnsigned, sealDigest: digestObject(forgedUnsigned) },
		});
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: forged,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/receipt|binding|authority/i);
	});

	it("persists artifact-derived generations in the host authority record", async () => {
		const state: FixtureStoreState = { artifacts: new Map(), publications: new Map() };
		await createHostAuthorityFixture(["blocker-missing-assertion"], state);
		expect(state.authorityRecord).not.toBeUndefined();
		const record = parseCanonicalJsonBytes(state.authorityRecord!);
		expect(record).toMatchObject({ reportGeneration: 3, sectionGenerations: { "finding-section": 8 } });
	});

	it("rejects using the immutable full report as a selective section artifact", () => {
		const fullReportRef = artifactRef("same-report", reportBytes());
		expect(() =>
			createWorkflowEvidenceManifest({
				packetId: "same-report-manifest",
				workflowId: WORKFLOW_ID,
				taskId: TASK_ID,
				attemptId: ATTEMPT_ID,
				runtimeVersion: "0.147.0-alpha.10",
				head: HEAD,
				epochRef: EPOCH,
				fullReportRef,
				fullReportContentType: "text/plain",
				sectionRefs: [
					{
						sectionId: "full-report-as-section",
						ordinal: 0,
						title: "forged section",
						startOffset: 0,
						endOffset: fullReportRef.sizeBytes,
						artifactRef: fullReportRef,
						digest: fullReportRef.digest,
						sizeBytes: fullReportRef.sizeBytes,
						sourceEventSequence: fullReportRef.sourceEventSequence,
						contentType: "text/plain",
					},
				],
			}),
		).toThrow(/full report|section|reference/i);
	});

	it("requires host-declared scope for every selective expansion", async () => {
		const secondBytes = new TextEncoder().encode("second section");
		const secondRef = artifactRef("second-section", secondBytes);
		const firstBytes = new TextEncoder().encode("first section");
		const firstRef = artifactRef("first-section", firstBytes);
		const fullReportRef = artifactRef("scoped-report", reportBytes());
		const manifest = createWorkflowEvidenceManifest({
			packetId: "scoped-manifest",
			workflowId: WORKFLOW_ID,
			taskId: TASK_ID,
			attemptId: ATTEMPT_ID,
			runtimeVersion: "0.147.0-alpha.10",
			head: HEAD,
			epochRef: EPOCH,
			fullReportRef,
			fullReportContentType: "text/plain",
			sectionRefs: [
				{
					sectionId: "first-section",
					ordinal: 0,
					title: "first",
					startOffset: 0,
					endOffset: firstBytes.byteLength,
					artifactRef: firstRef,
					digest: firstRef.digest,
					sizeBytes: firstRef.sizeBytes,
					sourceEventSequence: firstRef.sourceEventSequence,
					contentType: "text/plain",
				},
				{
					sectionId: "second-section",
					ordinal: 1,
					title: "second",
					startOffset: firstBytes.byteLength,
					endOffset: firstBytes.byteLength + secondBytes.byteLength,
					artifactRef: secondRef,
					digest: secondRef.digest,
					sizeBytes: secondRef.sizeBytes,
					sourceEventSequence: secondRef.sourceEventSequence,
					contentType: "text/plain",
				},
			],
		});
		const correction = {
			kind: "synthesis_remediation_correction" as const,
			sectionIds: ["second-section"],
			blockerIds: [],
			summary: "bounded",
			requiredNextAction: "review",
			correctionDigest: "",
		};
		correction.correctionDigest = digestObject(correction);
		await expect(
			selectivelyExpandWorkflowDecisionEvidence({
				manifest,
				sectionIds: ["second-section"],
				hostSectionIds: ["first-section"],
				resolver: {
					resolve: async (ref: WorkflowArtifactRef) => {
						const bytes = ref.artifactId === firstRef.artifactId ? firstBytes : secondBytes;
						return {
							envelope: { ref, payloadKind: "evidence", codec: "utf8", immutable: true },
							exists: true,
							bytes,
							verifiedDigest: ref.digest,
							verifiedSizeBytes: ref.sizeBytes,
						};
					},
				},
				reason: "ambiguous_finding",
				synthesize: () => correction,
			} as unknown as Parameters<typeof selectivelyExpandWorkflowDecisionEvidence>[0]),
		).rejects.toThrow(/scope|host|section/i);
	});

	it("requires and preserves Q25 lens identity and contradiction identity", async () => {
		const manifest = createManifest();
		const correction = {
			kind: "synthesis_remediation_correction" as const,
			sectionIds: ["finding-section"],
			blockerIds: ["blocker-missing-assertion"],
			summary: "bounded contradiction",
			requiredNextAction: "use correction",
			lensIdentity: { lensId: "lens-1", contradictionId: "contradiction-1" },
			correctionDigest: "",
		};
		correction.correctionDigest = digestObject(correction);
		await expect(
			selectivelyExpandWorkflowDecisionEvidence({
				manifest,
				sectionIds: ["finding-section"],
				disputedSectionIds: ["finding-section"],
				resolver: resolverForManifest(manifest),
				reason: "cross_lens_conflict",
				lensIdentity: { lensId: "lens-1", contradictionId: "contradiction-1" },
				synthesize: () => correction,
			} as unknown as Parameters<typeof selectivelyExpandWorkflowDecisionEvidence>[0]),
		).resolves.toMatchObject({ correction: { lensIdentity: correction.lensIdentity } });
		await expect(
			selectivelyExpandWorkflowDecisionEvidence({
				manifest,
				sectionIds: ["finding-section"],
				disputedSectionIds: ["finding-section"],
				resolver: resolverForManifest(manifest),
				reason: "cross_lens_conflict",
				synthesize: () => ({
					...correction,
					lensIdentity: undefined,
					correctionDigest: digestObject({ ...correction, lensIdentity: undefined }),
				}),
			} as unknown as Parameters<typeof selectivelyExpandWorkflowDecisionEvidence>[0]),
		).rejects.toThrow(/lens|identity|contradiction/i);
	});

	it("reads only the active publication at the current head", async () => {
		const state: FixtureStoreState = { artifacts: new Map(), publications: new Map() };
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"], state);
		const triad = createTriad();
		const publication = await publishWorkflowDecisionPacketTriad({
			hostAuthority: authority,
			packets: triad,
			currentBinding: binding(),
		});
		await expect(
			readWorkflowDecisionPacketPublication({
				hostAuthority: authority,
				artifactRef: publication.artifactRef,
				currentBinding: { ...binding(), head: { ...HEAD, sequence: HEAD.sequence + 1 } },
			} as unknown as Parameters<typeof readWorkflowDecisionPacketPublication>[0]),
		).rejects.toThrow(/head|active|current|stale/i);
	});

	it("cross-checks amendment paths and blocker section mappings", async () => {
		const { authority } = await createHostAuthorityFixture(["blocker-missing-assertion"]);
		const pathMismatch = createTriad({ targetFileRefs: ["src/workflow/unowned.ts"] });
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: pathMismatch,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/ownership|write|scope|path/i);
		const sectionMismatch = createTriad({ targetSectionIds: ["unrelated-section"] });
		await expect(
			validateWorkflowDecisionPacketDelivery({
				packets: sectionMismatch,
				currentBinding: binding(),
				hostAuthority: authority,
			}),
		).rejects.toThrow(/section|closure|mapping/i);
	});
});
