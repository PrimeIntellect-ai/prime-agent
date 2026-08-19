import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertChildOutputRuntimeVersion,
	CHILD_OUTPUT_CONTRACT_VERSION,
	type ChildArtifactOutput,
	type ChildAttemptState,
	type ChildOutputEvent,
	type ChildOutputEventBase,
	type ChildOutputHostContext,
	type ChildTaskDeclaration,
	canonicalFinalResult,
	createChildAttemptState,
	MISSING_FINAL_ASSISTANT_RESULT_REASON,
	parseChildAttemptState,
	parseChildOutputEvent,
	parseChildTaskDeclaration,
	recomputeChildAttemptStateDigest,
	reduceChildOutputEvent,
	sha256Hex,
} from "../src/core/child-output-contract.js";
import {
	canonicalJsonBytes,
	digestObject,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowReceiptVerificationKey,
	type WorkflowVerifiedHostReceipt,
} from "../src/core/workflow/contracts.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 3, coordinatorEpoch: 8 };
const HEAD: WorkflowJournalHead = {
	workflowId: "workflow-1",
	sequence: 41,
	eventDigest: "head-digest",
	epochRef: EPOCH,
};
const PROGRESS_HEAD: WorkflowJournalHead = {
	workflowId: "workflow-1",
	sequence: 42,
	eventDigest: "head-digest-42",
	epochRef: EPOCH,
};
const ARTIFACT_BYTES = new Uint8Array([123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125]);
const ARTIFACT_REF: WorkflowArtifactRef = {
	artifactId: "artifact-1",
	relativePath: "artifacts/report.json",
	digest: sha256Hex(ARTIFACT_BYTES),
	sizeBytes: ARTIFACT_BYTES.byteLength,
	sourceEventSequence: 42,
};
const FINAL_VALUE = { resultId: "assistant-result-1", answer: "ok" };
const FINAL_BYTES = canonicalJsonBytes(FINAL_VALUE);
const FINAL_RESULT = canonicalFinalResult({
	resultId: FINAL_VALUE.resultId,
	bytes: FINAL_BYTES,
	schema: "assistant-final-v1",
	validator: "assistant-final-validator-v1",
});
const ARTIFACT: ChildArtifactOutput = {
	outputId: "report",
	path: ARTIFACT_REF.relativePath,
	ref: ARTIFACT_REF,
	digest: ARTIFACT_REF.digest,
	schema: "report-v1",
	validator: "report-validator-v1",
};
const EVIDENCE_BYTES = canonicalJsonBytes({ evidence: "reviewed" });
const EVIDENCE_REF: WorkflowArtifactRef = {
	artifactId: "evidence-1",
	relativePath: "artifacts/evidence.json",
	digest: sha256Hex(EVIDENCE_BYTES),
	sizeBytes: EVIDENCE_BYTES.byteLength,
	sourceEventSequence: HEAD.sequence,
};
const RECEIPT_BYTES = canonicalJsonBytes({ receipt: "host-issued" });
const RECEIPT_REF: WorkflowArtifactRef = {
	artifactId: "receipt-1",
	relativePath: "receipts/receipt-1.json",
	digest: sha256Hex(RECEIPT_BYTES),
	sizeBytes: RECEIPT_BYTES.byteLength,
	sourceEventSequence: HEAD.sequence,
};
const PRODUCER_EXECUTION_ID = "execution-1";

function makeReceipt(receiptId: string): WorkflowVerifiedHostReceipt {
	return {
		receiptKind: "capability",
		oneUse: true,
		receiptId,
		issuerId: "host-authority",
		workflowId: "workflow-1",
		bindingDigest: "host-issued-binding",
		payloadDigest: RECEIPT_REF.digest,
		artifactRef: RECEIPT_REF,
		issuedAt: "2026-08-17T12:00:00.000Z",
		validUntil: "2026-08-17T13:00:00.000Z",
		keyId: "test-key",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: RECEIPT_REF.digest,
		stateDigest: "host-state",
		revision: HEAD.sequence,
		capabilityBinding: {
			capability: "child_output_delivery_ack",
			resourceDigest: "host-resource",
			operationDigest: "host-operation",
			executionIdentity: null,
			sessionId: null,
		},
		signature: `signature-${receiptId}`,
		verificationDigest: `verification-${receiptId}`,
	};
}

const SEAL_RECEIPT = makeReceipt("seal-receipt");
const ACK_RECEIPT = makeReceipt("ack-receipt");
const COMPACTION_RECEIPT = makeReceipt("compaction-receipt");
const CANCEL_RECEIPT = makeReceipt("cancel-receipt");
const FAILURE_RECEIPT = makeReceipt("failure-receipt");
const SCOPE_RECEIPT = makeReceipt("scope-receipt");
const DRIFT_RECEIPT = makeReceipt("drift-receipt");

function packetDigest(
	finalAssistantResult: unknown,
	toolResults: readonly unknown[],
	artifacts: readonly unknown[],
): string {
	return digestObject({ finalAssistantResult, toolResults, artifacts });
}

function resolverResult(ref: WorkflowArtifactRef = ARTIFACT_REF): WorkflowArtifactReadResult {
	const isEvidence = ref.artifactId === EVIDENCE_REF.artifactId;
	const isReceipt = ref.artifactId === RECEIPT_REF.artifactId;
	const bytes = isEvidence ? EVIDENCE_BYTES : isReceipt ? RECEIPT_BYTES : ARTIFACT_BYTES;
	const payloadKind = isEvidence ? "evidence" : "effect_result";
	return {
		envelope: {
			ref,
			payloadKind,
			codec: "canonical_json",
			immutable: true,
			immutableGeneration: isEvidence
				? "evidence-generation-1"
				: isReceipt
					? "receipt-generation-1"
					: "generation-1",
		} as WorkflowArtifactReadResult["envelope"] & { readonly immutableGeneration: string },
		exists: true,
		bytes: Uint8Array.from(bytes),
		verifiedDigest: ref.digest,
		verifiedSizeBytes: ref.sizeBytes,
	};
}

interface TestHostContextOverrides {
	readonly workflowId?: string;
	readonly runtimeVersion?: string;
	readonly head?: WorkflowJournalHead;
	readonly epochRef?: WorkflowEpochRef;
	readonly artifactResolver?: WorkflowArtifactResolver;
	readonly principalAuthorizer?: WorkflowHostReceiptConsumerContext["principalAuthorizer"];
}

function hostContext(overrides: TestHostContextOverrides = {}): ChildOutputHostContext {
	const workflowId = overrides.workflowId ?? "workflow-1";
	const runtimeVersion = overrides.runtimeVersion ?? "0.147.0-alpha.10";
	const head = overrides.head ?? HEAD;
	const epochRef = overrides.epochRef ?? EPOCH;
	const hostTuple = {
		workflowId,
		head,
		epochRef,
		stateDigest: "host-state",
		revision: head.sequence,
	};
	const artifactResolver = overrides.artifactResolver ?? {
		resolve: async (ref: WorkflowArtifactRef) => resolverResult(ref),
	};
	const witnesses = new Map<string, WorkflowHostReceiptConsumptionWitness>();
	const bindingDetails = new Map<string, { readonly resourceDigest: string; readonly operationDigest: string }>();
	let consumptionSequence = 0;
	const receiptResolver: WorkflowHostReceiptConsumerContext["receiptResolver"] = {
		resolve: async (input) => {
			if (!input.receipt.oneUse || input.receipt.workflowId !== input.workflowId)
				throw new Error("unverified_host_receipt");
			return input.receipt;
		},
		consumeIfOneUse: async (input) => {
			if (!input.receipt.oneUse) throw new Error("receipt_not_one_use");
			const prior = witnesses.get(input.receipt.receiptId);
			if (prior !== undefined) {
				if (prior.bindingDigest !== input.expectedBindingDigest) throw new Error("receipt_binding_conflict");
				throw new Error("receipt_already_consumed");
			}
			consumptionSequence += 1;
			const details = bindingDetails.get(input.expectedBindingDigest) ?? {
				resourceDigest: "test-resource",
				operationDigest: "test-operation",
			};
			witnesses.set(input.receipt.receiptId, {
				receiptId: input.receipt.receiptId,
				workflowId: input.workflowId,
				bindingDigest: input.expectedBindingDigest,
				capability: "child_output_delivery_ack",
				resourceDigest: details.resourceDigest,
				operationDigest: details.operationDigest,
				receiptDigest: digestObject(input.receipt),
				consumedAt: "2026-08-17T12:01:00.000Z",
				consumptionSequence,
			});
		},
		resolveConsumptionWitness: async (input) => {
			const witness = witnesses.get(input.receiptId);
			if (
				witness === undefined ||
				witness.workflowId !== input.workflowId ||
				witness.bindingDigest !== input.expectedBindingDigest
			)
				throw new Error("receipt_witness_missing");
			return witness;
		},
	};
	const key: WorkflowReceiptVerificationKey = {
		algorithm: "ed25519",
		verify: () => true,
		ownerPrincipal: "host-authority",
		allowedCapabilities: new Set(["child_output_delivery_ack"]),
		generationId: "test-generation",
		epochRef,
		fencingDigest: "test-fence",
		revoked: false,
	};
	const defaultPrincipalAuthorizer = {
		authorize: async (
			input: WorkflowHostPrincipalCapabilityAuthorizationInput,
		): Promise<WorkflowHostPrincipalCapabilityAuthorization> => ({
			authenticatedPrincipal: "host-authority",
			keyOwnerPrincipal: "host-authority",
			capability: input.capability,
			workflowId: input.workflowId,
			bindingDigest: input.bindingDigest,
			receipt: input.receipt,
			stateDigest: input.stateDigest,
			revision: input.revision,
			epochRef: input.epochRef,
			validity: { issuedAt: input.receipt.issuedAt, validUntil: input.receipt.validUntil },
			executionIdentity: input.executionIdentity,
			authorizationDigest: digestObject({
				capability: input.capability,
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				resourceDigest: input.resourceDigest,
				operationDigest: input.operationDigest,
				stateDigest: input.stateDigest,
				revision: input.revision,
				epochRef: input.epochRef,
				receiptId: input.receipt.receiptId,
			}),
		}),
	} as WorkflowHostReceiptConsumerContext["principalAuthorizer"];
	const suppliedPrincipalAuthorizer = overrides.principalAuthorizer;
	const principalAuthorizer = suppliedPrincipalAuthorizer
		? {
				authorize: async (input: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
					bindingDetails.set(input.bindingDigest, {
						resourceDigest: input.resourceDigest,
						operationDigest: input.operationDigest,
					});
					return suppliedPrincipalAuthorizer.authorize(input);
				},
			}
		: {
				authorize: async (input: WorkflowHostPrincipalCapabilityAuthorizationInput) => {
					bindingDetails.set(input.bindingDigest, {
						resourceDigest: input.resourceDigest,
						operationDigest: input.operationDigest,
					});
					return defaultPrincipalAuthorizer.authorize(input);
				},
			};
	return {
		hostTuple,
		runtimeVersion,
		receiptContext: {
			receiptResolver,
			keyResolver: { resolve: async () => key },
			revokedReceiptIds: new Set(),
			artifactResolver,
			principalAuthorizer,
		},
		readHostTuple: async () => hostTuple,
		prepareCommitIntent: async (input) => ({ ...input, intentDigest: digestObject(input) }),
		validateFinalResult: async ({ result }) => {
			if (result.schema !== FINAL_RESULT.schema || result.validator !== FINAL_RESULT.validator)
				throw new Error("host_final_schema_rejected");
		},
		validateArtifactOutput: async ({ output, required, resolvedArtifact }) => {
			if (
				output.schema !== required.schema ||
				output.validator !== required.validator ||
				resolvedArtifact.envelope.immutable !== true
			)
				throw new Error("host_artifact_schema_rejected");
		},
	};
}

function declarationInput(): Record<string, unknown> {
	return {
		version: CHILD_OUTPUT_CONTRACT_VERSION,
		taskId: "task-1",
		childId: "child-1",
		runId: "run-1",
		attemptId: "attempt-1",
		workflowId: "workflow-1",
		head: HEAD,
		epochRef: EPOCH,
		maxAttempts: 3,
		maxCompactions: 3,
		requiredFinalResult: { schema: FINAL_RESULT.schema, validator: FINAL_RESULT.validator },
		requiredArtifacts: [ARTIFACT],
	};
}

function declaration(context = hostContext()): ChildTaskDeclaration {
	return parseChildTaskDeclaration(declarationInput(), context);
}

function eventBase(state: ChildAttemptState, eventId: string): ChildOutputEventBase {
	return {
		eventId,
		attemptId: state.attemptId,
		workflowId: state.workflowId,
		head: state.head,
		epochRef: state.epochRef,
		expectedStateDigest: state.stateDigest,
	};
}

function completedEvent(
	state: ChildAttemptState,
	eventId = "complete-1",
): Extract<ChildOutputEvent, { kind: "child_finished" }> {
	return {
		...eventBase(state, eventId),
		kind: "child_finished",
		finalAssistantResult: FINAL_RESULT,
		toolResults: [],
		artifacts: [ARTIFACT],
		packetDigest: packetDigest(FINAL_RESULT, [], [ARTIFACT]),
		producerExecutionId: PRODUCER_EXECUTION_ID,
	} as unknown as Extract<ChildOutputEvent, { kind: "child_finished" }>;
}

function sealEvent(state: ChildAttemptState, eventId = "seal-1"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "artifact_seal_recorded",
		artifacts: [ARTIFACT],
		outputObligationId: state.outputObligation.obligationId,
		packetDigest: packetDigest(FINAL_RESULT, [], [ARTIFACT]),
		producerExecutionId: PRODUCER_EXECUTION_ID,
		sealId: `seal-${eventId}`,
		witness: eventId === "seal-1" ? SEAL_RECEIPT : makeReceipt(`seal-receipt-${eventId}`),
	} as unknown as ChildOutputEvent;
}

function provisionalProgressEvent(state: ChildAttemptState, eventId: string, progressDigest: string): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "provisional_progress",
		producerExecutionId: PRODUCER_EXECUTION_ID,
		progressDigest,
	} as unknown as ChildOutputEvent;
}

async function sealState(state: ChildAttemptState, context: ChildOutputHostContext, eventId = "seal-1") {
	return reduceChildOutputEvent(state, sealEvent(state, eventId), context);
}

function validationEvent(state: ChildAttemptState, eventId = "validate-1"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "outputs_validated",
		outputs: [
			{
				outputId: ARTIFACT.outputId,
				path: ARTIFACT.path,
				ref: ARTIFACT.ref,
				schema: ARTIFACT.schema,
				validator: ARTIFACT.validator,
				validated: true,
			},
		],
	};
}

function acknowledgementEvent(state: ChildAttemptState, eventId = "ack-1"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "parent_delivery_acknowledged",
		deliveryId: "delivery-1",
		receipt: eventId === "ack-1" ? ACK_RECEIPT : makeReceipt(`ack-receipt-${eventId}`),
	};
}

function compactionEvent(
	state: ChildAttemptState,
	eventId: string,
	evidence: WorkflowArtifactRef | string,
	head: WorkflowJournalHead = state.head,
): Extract<ChildOutputEvent, { kind: "compaction_completed" }> {
	const evidenceRef = typeof evidence === "string" ? EVIDENCE_REF : evidence;
	return {
		...eventBase(state, eventId),
		head,
		kind: "compaction_completed",
		compactionId: eventId,
		compactionCount: state.compactionCount + 1,
		evidenceRef,
		queueEmpty: true,
		wakeId: `wake-${eventId}`,
		witness: eventId === "compact-1" ? COMPACTION_RECEIPT : makeReceipt(`compaction-receipt-${eventId}`),
	};
}

function cancellationEvent(state: ChildAttemptState, eventId = "cancel-obligation"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "obligation_cancelled",
		reason: "operator_cancelled",
		witness: eventId === "cancel-obligation" ? CANCEL_RECEIPT : makeReceipt(`cancel-receipt-${eventId}`),
	};
}

function failureEvent(state: ChildAttemptState, eventId = "fail-obligation"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "terminal_failure_recorded",
		reason: "child_protocol_failed",
		witness: eventId === "fail-obligation" ? FAILURE_RECEIPT : makeReceipt(`failure-receipt-${eventId}`),
	};
}

function scopeChangeEvent(state: ChildAttemptState, eventId = "scope-obligation"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "scope_change_approved",
		scopeDigest: "scope-digest-2",
		witness: eventId === "scope-obligation" ? SCOPE_RECEIPT : makeReceipt(`scope-receipt-${eventId}`),
	};
}

function driftEvent(state: ChildAttemptState, eventId = "seal-drift"): ChildOutputEvent {
	return {
		...eventBase(state, eventId),
		kind: "seal_drift_detected",
		producerExecutionId: PRODUCER_EXECUTION_ID,
		witness: eventId === "seal-drift" ? DRIFT_RECEIPT : makeReceipt(`drift-receipt-${eventId}`),
	};
}

async function runningState(
	context = hostContext(),
): Promise<{ state: ChildAttemptState; context: ChildOutputHostContext }> {
	const state = createChildAttemptState(declaration(context), context);
	return { state, context };
}

describe("child output contract red-team", () => {
	it("requires the generic receipt context, a live host tuple reader, and an atomic commit-intent seam", () => {
		const context = { ...hostContext(), receiptContext: undefined } as unknown as ChildOutputHostContext;
		expect(() => parseChildTaskDeclaration(declarationInput(), context)).toThrow(
			/receipt context|generic|host tuple|commit intent/i,
		);
	});

	it("requires closed declaration keys and host-bound workflow, head, epoch, and safe relative paths", () => {
		const context = hostContext();
		expect(parseChildTaskDeclaration(declarationInput(), context).workflowId).toBe("workflow-1");
		for (const mutation of [
			(input: Record<string, unknown>) => ({ ...input, extra: true }),
			(input: Record<string, unknown>) => ({ ...input, workflowId: "foreign" }),
			(input: Record<string, unknown>) => ({ ...input, head: { ...HEAD, eventDigest: "foreign" } }),
			(input: Record<string, unknown>) => ({ ...input, epochRef: { storeEpoch: 4, coordinatorEpoch: 8 } }),
		]) {
			expect(() => parseChildTaskDeclaration(mutation(declarationInput()), context)).toThrow(
				/closed|workflow|head|epoch/i,
			);
		}
		for (const path of [
			"/tmp/report",
			"\\\\server\\share\\report",
			"\\root\\report",
			"C:\\report",
			"C:report",
			"../report",
		]) {
			const artifact = { ...ARTIFACT, path, ref: { ...ARTIFACT_REF, relativePath: path } };
			expect(() =>
				parseChildTaskDeclaration({ ...declarationInput(), requiredArtifacts: [artifact] }, context),
			).toThrow(/relative|escape|path/i);
		}
	});

	it("accepts the workflow's zero epoch sentinel when it is bound through the host tuple", () => {
		const zeroEpoch: WorkflowEpochRef = { storeEpoch: 0, coordinatorEpoch: 0 };
		const zeroHead: WorkflowJournalHead = { ...HEAD, sequence: 0, eventDigest: null, epochRef: zeroEpoch };
		const context = hostContext({ epochRef: zeroEpoch, head: zeroHead });
		const input = { ...declarationInput(), epochRef: zeroEpoch, head: zeroHead };
		expect(parseChildTaskDeclaration(input, context).epochRef).toEqual(zeroEpoch);
	});

	it("requires the generic host principalAuthorizer seam", () => {
		const context = {
			...hostContext(),
			receiptContext: { ...hostContext().receiptContext, principalAuthorizer: undefined },
		} as unknown as ChildOutputHostContext;
		expect(() => parseChildTaskDeclaration(declarationInput(), context)).toThrow(
			/CONTRACT_CHANGE|principalAuthorizer/i,
		);
	});

	it("stops below the minimum durable runtime version with the exact authority error", () => {
		expect(() => assertChildOutputRuntimeVersion("0.147.0-alpha.9")).toThrow("workflow_runtime_version_unsupported");
		expect(() =>
			parseChildTaskDeclaration(declarationInput(), hostContext({ runtimeVersion: "0.147.0-alpha.9" })),
		).toThrow("workflow_runtime_version_unsupported");
	});

	it("validates canonical final-result bytes, digest, schema, and validator before validating outputs", async () => {
		const { state, context } = await runningState();
		const sealed = await sealState(state, context);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), context);
		expect(validating.status).toBe("validating");
		for (const [label, result] of [
			["tampered bytes", { ...FINAL_RESULT, bytes: canonicalJsonBytes({ answer: "tampered" }) }],
			["wrong digest", { ...FINAL_RESULT, digest: "0".repeat(64) }],
			["wrong schema", { ...FINAL_RESULT, schema: "other-schema" }],
			["wrong validator", { ...FINAL_RESULT, validator: "other-validator" }],
			["noncanonical bytes", { ...FINAL_RESULT, bytes: new Uint8Array([123, 32, 34, 97, 34, 58, 49, 125]) }],
		] as const) {
			await expect(
				reduceChildOutputEvent(
					sealed,
					{ ...completedEvent(sealed, `bad-${label}`), finalAssistantResult: result },
					context,
				),
				label,
			).rejects.toThrow(/canonical|digest|schema|validator|result/i);
		}
	});

	it("resolves every artifact through the async host resolver and rejects forged immutable evidence", async () => {
		let resolverCalls = 0;
		const context = hostContext({
			artifactResolver: {
				resolve: async (ref) => {
					resolverCalls += 1;
					return resolverResult(ref);
				},
			},
		});
		const state = createChildAttemptState(declaration(context), context);
		const sealed = await sealState(state, context);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), context);
		const pending = await reduceChildOutputEvent(validating, validationEvent(validating), context);
		expect(pending.status).toBe("delivered_pending_ack");
		expect(resolverCalls).toBe(5);

		for (const [label, result] of [
			["missing", { ...resolverResult(), exists: false }],
			["mutable", { ...resolverResult(), envelope: { ...resolverResult().envelope, immutable: false } }],
			["wrong ref", resolverResult({ ...ARTIFACT_REF, artifactId: "foreign" })],
			["wrong digest", { ...resolverResult(), verifiedDigest: "0".repeat(64) }],
			["wrong size", { ...resolverResult(), verifiedSizeBytes: 1 }],
		] as const) {
			const badContext = hostContext({
				artifactResolver: {
					resolve: async () => result as unknown as WorkflowArtifactReadResult,
				},
			});
			await expect(
				reduceChildOutputEvent(validating, validationEvent(validating, `bad-${label}`), badContext),
				label,
			).rejects.toThrow(/artifact|digest|size|immutable|missing|resolver/i);
		}
	});

	it("requires an opaque host-verified parent delivery receipt and durable acknowledgement, never a boolean", async () => {
		let receiptCalls = 0;
		const authorizationInputs: WorkflowHostPrincipalCapabilityAuthorizationInput[] = [];
		const baseContext = hostContext();
		const context = hostContext({
			principalAuthorizer: {
				authorize: async (input): Promise<WorkflowHostPrincipalCapabilityAuthorization> => {
					receiptCalls += 1;
					authorizationInputs.push(input);
					return baseContext.receiptContext.principalAuthorizer.authorize(input);
				},
			},
		});
		const state = createChildAttemptState(declaration(context), context);
		const sealed = await sealState(state, context);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), context);
		const pending = await reduceChildOutputEvent(validating, validationEvent(validating), context);
		const completed = await reduceChildOutputEvent(pending, acknowledgementEvent(pending), context);
		expect(completed.status).toBe("completed");
		expect(completed.acknowledgementReceiptId).toBe(ACK_RECEIPT.receiptId);
		expect(completed.acknowledgementReceiptDigest).toBe(digestObject(ACK_RECEIPT));
		expect(completed.artifactSeal?.receiptId).toBe(SEAL_RECEIPT.receiptId);
		expect(completed.artifactSeal?.receiptId).not.toBe(completed.acknowledgementReceiptId);
		expect(receiptCalls).toBe(5);
		expect(authorizationInputs.every((input) => input.capability === "child_output_delivery_ack")).toBe(true);
		expect(authorizationInputs.map((input) => input.receipt.receiptId)).toEqual([
			SEAL_RECEIPT.receiptId,
			SEAL_RECEIPT.receiptId,
			SEAL_RECEIPT.receiptId,
			SEAL_RECEIPT.receiptId,
			ACK_RECEIPT.receiptId,
		]);
		expect(authorizationInputs[4]?.executionIdentity).toBeUndefined();

		const withBoolean = { ...acknowledgementEvent(pending, "boolean-ack"), durablyAcknowledged: true };
		await expect(reduceChildOutputEvent(pending, withBoolean, context)).rejects.toThrow(/closed|ack|receipt/i);
		const reusedSealReceipt = { ...acknowledgementEvent(pending, "reused-seal-receipt"), receipt: SEAL_RECEIPT };
		await expect(reduceChildOutputEvent(pending, reusedSealReceipt, context)).rejects.toThrow(/distinct|receipt/i);
		const forged = {
			...acknowledgementEvent(pending, "forged-ack"),
			receipt: { fake: true },
		} as unknown as ChildOutputEvent;
		await expect(reduceChildOutputEvent(pending, forged, context)).rejects.toThrow(/receipt|verif/i);
	});

	it("requires the closed signed generic receipt shape before host resolution", () => {
		const acknowledgement = acknowledgementEvent(createChildAttemptState(declaration(), hostContext())) as Extract<
			ChildOutputEvent,
			{ kind: "parent_delivery_acknowledged" }
		>;
		const withExtraKey = {
			...acknowledgement,
			receipt: { ...acknowledgement.receipt, forged: true },
		};
		const withoutSignature = {
			...acknowledgement,
			receipt: Object.fromEntries(Object.entries(acknowledgement.receipt).filter(([key]) => key !== "signature")),
		};
		const wrongKind = {
			...acknowledgement,
			receipt: Object.fromEntries(
				Object.entries(acknowledgement.receipt).filter(([key]) => key !== "capabilityBinding"),
			),
		};
		(wrongKind.receipt as Record<string, unknown>).receiptKind = "artifact";
		for (const candidate of [withExtraKey, withoutSignature, wrongKind]) {
			expect(() => parseChildOutputEvent(candidate)).toThrow(/closed|receipt|signature/i);
		}
	});

	it("takes immutable generations from the host resolver and verifies the opaque seal fence", async () => {
		const context = hostContext({
			artifactResolver: {
				resolve: async (ref) => {
					const resolved = resolverResult(ref);
					return {
						...resolved,
						envelope: {
							...resolved.envelope,
							immutableGeneration: "resolver-generation-7",
						} as WorkflowArtifactReadResult["envelope"] & { readonly immutableGeneration: string },
					};
				},
			},
		});
		const { state } = await runningState(context);
		const sealed = await sealState(state, context);
		expect(sealed.artifactSeal?.artifacts[0]?.immutableGeneration).toBe("resolver-generation-7");
		const callerGeneration = {
			...sealEvent(state, "caller-generation"),
			artifacts: [{ ...ARTIFACT, immutableGeneration: "caller-generation" }],
		};
		await expect(reduceChildOutputEvent(state, callerGeneration, context)).rejects.toThrow(/closed|seal|artifact/i);
		const tamperedFence = {
			...sealed,
			producerFence: { ...sealed.producerFence!, hostAuthorityDigest: sha256Hex(ARTIFACT_BYTES) },
		} as ChildAttemptState;
		const rehashed = { ...tamperedFence, stateDigest: recomputeChildAttemptStateDigest(tamperedFence) };
		expect(() => parseChildAttemptState(JSON.parse(JSON.stringify(rehashed)), context)).toThrow(
			/seal|fence|integrity/i,
		);
		const forgedAuthority = "forged-host-authority";
		const forgedFence = {
			...sealed.producerFence!,
			hostAuthorityDigest: forgedAuthority,
		};
		const recomputedFence = {
			...forgedFence,
			fenceId: digestObject({
				sealId: forgedFence.sealId,
				sealDigest: forgedFence.sealDigest,
				producerAttemptId: forgedFence.producerAttemptId,
				producerExecutionId: forgedFence.producerExecutionId,
				outputObligationId: forgedFence.outputObligationId,
				hostAuthorityDigest: forgedFence.hostAuthorityDigest,
				revocationIntent: forgedFence.revocationIntent,
				epochRef: forgedFence.epochRef,
				head: forgedFence.head,
			}),
		};
		const recomputedForgery = {
			...sealed,
			producerFence: recomputedFence,
		} as ChildAttemptState;
		const recomputedForgeryWithDigest = {
			...recomputedForgery,
			stateDigest: recomputeChildAttemptStateDigest(recomputedForgery),
		};
		expect(() => parseChildAttemptState(JSON.parse(JSON.stringify(recomputedForgeryWithDigest)), context)).toThrow(
			/seal|fence|authority|integrity/i,
		);
	});

	it("requires host-resolved validators and rejects one-use receipt reuse under a different binding", async () => {
		const base = hostContext();
		const { state } = await runningState(base);
		const sealed = await sealState(state, base);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), base);
		const rejectingValidatorContext = {
			...base,
			validateFinalResult: async () => {
				throw new Error("host_schema_authority_rejected");
			},
		} as ChildOutputHostContext;
		await expect(
			reduceChildOutputEvent(sealed, completedEvent(sealed, "host-validator"), rejectingValidatorContext),
		).rejects.toThrow(/host_schema_authority|validator/i);
		const pending = await reduceChildOutputEvent(validating, validationEvent(validating), base);
		const firstAck = acknowledgementEvent(pending);
		await reduceChildOutputEvent(pending, firstAck, base);
		const conflictingAck = { ...acknowledgementEvent(pending, "conflicting-ack"), receipt: ACK_RECEIPT };
		await expect(reduceChildOutputEvent(pending, conflictingAck, base)).rejects.toThrow(
			/receipt|witness|binding|consum/i,
		);
	});

	it("requires the host commit intent to be recomputable and fences a stale live tuple", async () => {
		const base = hostContext();
		const invalidIntentContext = {
			...base,
			prepareCommitIntent: async (input: Parameters<ChildOutputHostContext["prepareCommitIntent"]>[0]) => ({
				...input,
				intentDigest: "caller-supplied-hash",
			}),
		} as ChildOutputHostContext;
		const invalidState = createChildAttemptState(declaration(invalidIntentContext), invalidIntentContext);
		await expect(sealState(invalidState, invalidIntentContext)).rejects.toThrow(/intent|recomput/i);
		const liveTupleContext = {
			...base,
			readHostTuple: async () => ({
				...base.hostTuple,
				epochRef: { storeEpoch: base.hostTuple.epochRef.storeEpoch, coordinatorEpoch: 99 },
			}),
		} as ChildOutputHostContext;
		const liveState = createChildAttemptState(declaration(base), base);
		await expect(
			reduceChildOutputEvent(
				liveState,
				provisionalProgressEvent(liveState, "stale-live-tuple", "progress"),
				liveTupleContext,
			),
		).rejects.toThrow(/epoch|host|fenc/i);
		const sealed = await sealState(liveState, base);
		const staleRevisionContext = {
			...base,
			readHostTuple: async () => ({ ...base.hostTuple, revision: base.hostTuple.revision + 1 }),
		} as ChildOutputHostContext;
		await expect(
			reduceChildOutputEvent(sealed, completedEvent(sealed, "stale-host-revision"), staleRevisionContext),
		).rejects.toThrow(/revision|stale|host|fenc/i);
	});

	it("rejects raw digest strings as artifact-seal authority", async () => {
		const { state, context } = await runningState();
		const rawHashSeal = {
			...sealEvent(state, "raw-hash-seal"),
			witness: sha256Hex(ARTIFACT_BYTES),
		} as unknown as ChildOutputEvent;
		await expect(reduceChildOutputEvent(state, rawHashSeal, context)).rejects.toThrow(/opaque|receipt|object/i);
	});

	it("recomputes and verifies the prior state digest before replay or reduction", async () => {
		const { state, context } = await runningState();
		const tampered = { ...state, status: "validating" } as ChildAttemptState;
		expect(recomputeChildAttemptStateDigest(tampered)).not.toBe(state.stateDigest);
		await expect(reduceChildOutputEvent(tampered, completedEvent(tampered), context)).rejects.toThrow(
			/state digest|tamper|integrity/i,
		);
	});

	it("validates host epoch before idempotent replay and rejects foreign event bindings", async () => {
		const { state, context } = await runningState();
		const sealed = await sealState(state, context);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), context);
		await expect(
			reduceChildOutputEvent(
				validating,
				completedEvent(sealed),
				hostContext({ epochRef: { storeEpoch: 3, coordinatorEpoch: 9 } }),
			),
		).rejects.toThrow(/epoch|host|stale|fenc/i);
		const foreign = { ...completedEvent(sealed, "foreign"), workflowId: "foreign" };
		await expect(reduceChildOutputEvent(sealed, foreign, context)).rejects.toThrow(/workflow|host|fenc/i);
	});

	it("records immutable retry lineage, forbids attempt and retry-event reuse, and survives JSON reopen", async () => {
		const { state, context } = await runningState();
		const incomplete = await reduceChildOutputEvent(
			state,
			{ ...completedEvent(state, "incomplete"), finalAssistantResult: null },
			context,
		);
		expect(incomplete.status).toBe("retryable_incomplete");
		expect(incomplete.reason).toBe(MISSING_FINAL_ASSISTANT_RESULT_REASON);
		expect(incomplete.coordinator.wake).toMatchObject({ kind: "error", status: "pending" });
		const retryEvent: ChildOutputEvent = {
			...eventBase(incomplete, "retry-1"),
			kind: "attempt_retried",
			priorAttemptId: incomplete.attemptId,
			newAttemptId: "attempt-2",
			lineageDigest: digestObject({
				workflowId: incomplete.workflowId,
				taskId: incomplete.taskId,
				childId: incomplete.childId,
				runId: incomplete.runId,
				priorAttemptId: incomplete.attemptId,
				newAttemptId: "attempt-2",
				priorAttemptNumber: incomplete.attemptNumber,
				priorStateDigest: incomplete.stateDigest,
				declarationDigest: incomplete.bindingDigest,
				head: incomplete.head,
				epochRef: incomplete.epochRef,
			}),
		};
		const retry = await reduceChildOutputEvent(incomplete, retryEvent, context);
		expect(retry.status).toBe("running");
		expect(retry.attemptId).toBe("attempt-2");
		expect(retry.priorAttemptId).toBe("attempt-1");
		expect(retry.attemptLineage.map((entry) => entry.attemptId)).toEqual(["attempt-1", "attempt-2"]);
		expect(retry.appliedEventDigests["retry-1"]).toBeDefined();

		const storeDirectory = await mkdtemp(join(tmpdir(), "child-output-contract-"));
		try {
			const statePath = join(storeDirectory, "attempt-state.json");
			await writeFile(statePath, JSON.stringify(retry), "utf8");
			const reopened = parseChildAttemptState(JSON.parse(await readFile(statePath, "utf8")), context);
			expect(reopened.stateDigest).toBe(retry.stateDigest);
			expect(
				(await reduceChildOutputEvent(reopened, { ...retryEvent, eventId: "retry-1" }, context)).stateDigest,
			).toBe(retry.stateDigest);
		} finally {
			await rm(storeDirectory, { recursive: true, force: true });
		}
		const reusedId: ChildOutputEvent = {
			...eventBase(retry, "retry-reuse-id"),
			kind: "attempt_retried",
			priorAttemptId: retry.attemptId,
			newAttemptId: "attempt-1",
			lineageDigest: "wrong",
		};
		await expect(reduceChildOutputEvent(retry, reusedId, context)).rejects.toThrow(/reuse|lineage|attempt/i);
	});

	it("retains the undischarged obligation and reconstructs one same-attempt wake across compaction restart", async () => {
		const capabilities: string[] = [];
		const baseContext = hostContext();
		const context = hostContext({
			principalAuthorizer: {
				authorize: async (input) => {
					capabilities.push(input.capability);
					return baseContext.receiptContext.principalAuthorizer.authorize(input);
				},
			},
		});
		const { state } = await runningState(context);
		expect(state.coordinator).toMatchObject({
			meaningfulProgressDigest: null,
			deadline: { status: "pending", transitionEventId: null },
			terminal: null,
			wake: null,
		});
		const compacted = await reduceChildOutputEvent(state, compactionEvent(state, "compact-1", "evidence-1"), context);
		expect(compacted.status).toBe("running");
		expect(compacted.outputObligation.status).toBe("undischarged");
		expect(compacted.continuationWake).toMatchObject({
			attemptId: state.attemptId,
			childId: state.childId,
			status: "pending",
		});
		expect(compacted.continuationEscalation).toBeNull();
		expect(compacted.coordinator.wake).toBeNull();
		expect(compacted.coordinator.deadline).toEqual(state.coordinator.deadline);
		expect(compacted.coordinator.meaningfulProgressDigest).toBe(
			digestObject({ evidenceDigest: sha256Hex(EVIDENCE_BYTES), head: compacted.head }),
		);
		expect(capabilities).toEqual(["child_output_delivery_ack"]);

		const storeDirectory = await mkdtemp(join(tmpdir(), "child-output-compaction-"));
		try {
			const statePath = join(storeDirectory, "compacted-state.json");
			await writeFile(statePath, JSON.stringify(compacted), "utf8");
			const reopened = parseChildAttemptState(JSON.parse(await readFile(statePath, "utf8")), context);
			expect(reopened.continuationWake).toMatchObject({ attemptId: state.attemptId, status: "pending" });
			const sealed = await sealState(reopened, context, "seal-final-1");
			const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed, "final-1"), context);
			expect(validating.coordinator.wake).toMatchObject({ kind: "final_output", status: "pending" });
			const finalWakeKey = validating.coordinator.wake?.wakeKey;
			const pending = await reduceChildOutputEvent(
				validating,
				validationEvent(validating, "validate-final-1"),
				context,
			);
			const completed = await reduceChildOutputEvent(pending, acknowledgementEvent(pending, "ack-final-1"), context);
			expect(completed.status).toBe("completed");
			expect(completed.outputObligation.status).toBe("discharged");
			expect(completed.continuationWake).toBeNull();
			expect(completed.coordinator).toMatchObject({
				deadline: { status: "discharged", transitionEventId: "ack-final-1" },
				terminal: { status: "completed", eventId: "ack-final-1" },
				wake: { kind: "final_output", status: "pending" },
			});
			expect(completed.coordinator.wake?.wakeKey).toBe(finalWakeKey);
			expect(capabilities).toEqual([
				"child_output_delivery_ack",
				"child_output_delivery_ack",
				"child_output_delivery_ack",
				"child_output_delivery_ack",
				"child_output_delivery_ack",
				"child_output_delivery_ack",
			]);
			expect(finalWakeKey).toBe(
				digestObject({
					workflowId: state.workflowId,
					taskId: state.taskId,
					childId: state.childId,
					runId: state.runId,
					attemptId: state.attemptId,
					obligation: "required_output",
				}),
			);
			const capabilityCountBeforeAckReplay = capabilities.length;
			await expect(
				reduceChildOutputEvent(completed, acknowledgementEvent(pending, "ack-final-1"), context),
			).resolves.toBe(completed);
			expect(capabilities).toHaveLength(capabilityCountBeforeAckReplay);
		} finally {
			await rm(storeDirectory, { recursive: true, force: true });
		}
	});

	it("persists pending, claimed, processed, and failed coordinator wake states by one stable key", async () => {
		const { state, context } = await runningState();
		const incomplete = await reduceChildOutputEvent(
			state,
			{ ...completedEvent(state, "wake-incomplete"), finalAssistantResult: null },
			context,
		);
		const wakeKey = incomplete.coordinator.wake?.wakeKey;
		expect(wakeKey).toEqual(expect.any(String));
		const claim: ChildOutputEvent = {
			...eventBase(incomplete, "wake-claim"),
			kind: "coordinator_wake_claimed",
			wakeKey: wakeKey as string,
			claimId: "claim-1",
		};
		const claimed = await reduceChildOutputEvent(incomplete, claim, context);
		expect(claimed.coordinator.wake).toMatchObject({ status: "claimed", claimId: "claim-1" });
		const processed: ChildOutputEvent = {
			...eventBase(claimed, "wake-processed"),
			kind: "coordinator_wake_processed",
			wakeKey: wakeKey as string,
			claimId: "claim-1",
		};
		const processedState = await reduceChildOutputEvent(claimed, processed, context);
		expect(processedState.coordinator.wake).toMatchObject({
			status: "processed",
			processedEventId: "wake-processed",
		});
		await expect(reduceChildOutputEvent(processedState, processed, context)).resolves.toBe(processedState);

		const secondIncomplete = await reduceChildOutputEvent(
			createChildAttemptState(declaration(context), context),
			{ ...completedEvent(state, "wake-incomplete-2"), finalAssistantResult: null, attemptId: state.attemptId },
			context,
		);
		const secondKey = secondIncomplete.coordinator.wake?.wakeKey as string;
		const secondClaim: ChildOutputEvent = {
			...eventBase(secondIncomplete, "wake-claim-2"),
			kind: "coordinator_wake_claimed",
			wakeKey: secondKey,
			claimId: "claim-2",
		};
		const secondClaimed = await reduceChildOutputEvent(secondIncomplete, secondClaim, context);
		const failed: ChildOutputEvent = {
			...eventBase(secondClaimed, "wake-failed"),
			kind: "coordinator_wake_failed",
			wakeKey: secondKey,
			claimId: "claim-2",
			reason: "delivery_worker_failed",
		};
		const failedState = await reduceChildOutputEvent(secondClaimed, failed, context);
		expect(failedState.coordinator.wake).toMatchObject({ status: "failed", failureReason: "delivery_worker_failed" });
	});

	it("allows provisional corrections but requires an immutable seal and producer fence before terminal output", async () => {
		let drifted = false;
		const context = hostContext({
			artifactResolver: {
				resolve: async (ref) => {
					const result = resolverResult(ref);
					if (drifted && ref.artifactId === ARTIFACT_REF.artifactId) {
						return {
							...result,
							envelope: {
								...result.envelope,
								immutableGeneration: "generation-2",
							} as WorkflowArtifactReadResult["envelope"] & { readonly immutableGeneration: string },
						};
					}
					return result;
				},
			},
		});
		const { state } = await runningState(context);
		await expect(reduceChildOutputEvent(state, completedEvent(state, "unsealed-terminal"), context)).rejects.toThrow(
			/closed|seal|fence|terminal/i,
		);
		const provisional = await reduceChildOutputEvent(
			state,
			provisionalProgressEvent(state, "provisional-1", "draft-digest-1"),
			context,
		);
		const corrected = await reduceChildOutputEvent(
			provisional,
			provisionalProgressEvent(provisional, "provisional-2", "draft-digest-2"),
			context,
		);
		expect(corrected.status).toBe("running");
		expect(corrected.artifactSeal).toBeNull();
		expect(corrected.provisionalProgressDigest).toBe("draft-digest-2");
		expect(corrected.coordinator.wake).toBeNull();

		const sealed = await reduceChildOutputEvent(corrected, sealEvent(corrected), context);
		expect(sealed.artifactSeal).toMatchObject({
			sealId: "seal-seal-1",
			packetDigest: packetDigest(FINAL_RESULT, [], [ARTIFACT]),
		});
		expect(sealed.producerFence).toMatchObject({
			producerAttemptId: state.attemptId,
			producerExecutionId: PRODUCER_EXECUTION_ID,
			writeAuthority: "revoked",
		});
		expect(sealed.status).toBe("running");
		await expect(
			reduceChildOutputEvent(sealed, provisionalProgressEvent(sealed, "post-seal-write", "draft-digest-3"), context),
		).rejects.toThrow(/seal|write|fence|revoked/i);
		await expect(
			reduceChildOutputEvent(
				sealed,
				{
					...eventBase(sealed, "post-seal-edit"),
					kind: "producer_write_attempted",
					producerExecutionId: PRODUCER_EXECUTION_ID,
					path: ARTIFACT.path,
					writeDigest: "post-seal-edit-digest",
				},
				context,
			),
		).rejects.toThrow(/seal|write|fence|revoked/i);

		const sealedAfterRestart = parseChildAttemptState(JSON.parse(JSON.stringify(sealed)), context);
		expect(sealedAfterRestart.artifactSeal?.sealDigest).toBe(sealed.artifactSeal?.sealDigest);
		const validating = await reduceChildOutputEvent(
			sealedAfterRestart,
			completedEvent(sealedAfterRestart, "sealed-terminal"),
			context,
		);
		expect(validating.status).toBe("validating");
		const validatingAfterRestart = parseChildAttemptState(JSON.parse(JSON.stringify(validating)), context);
		const pending = await reduceChildOutputEvent(
			validatingAfterRestart,
			validationEvent(validatingAfterRestart, "sealed-validate"),
			context,
		);
		const pendingAfterRestart = parseChildAttemptState(JSON.parse(JSON.stringify(pending)), context);
		drifted = true;
		await expect(
			reduceChildOutputEvent(pendingAfterRestart, acknowledgementEvent(pendingAfterRestart, "drifted-ack"), context),
		).rejects.toThrow(/stable|drift|resolver/i);
		drifted = false;
		const completed = await reduceChildOutputEvent(
			pendingAfterRestart,
			acknowledgementEvent(pendingAfterRestart, "sealed-ack"),
			context,
		);
		const terminalWakeKey = completed.coordinator.wake?.wakeKey;
		const replayed = await reduceChildOutputEvent(completed, acknowledgementEvent(pending, "sealed-ack"), context);
		expect(replayed).toBe(completed);
		drifted = true;
		const drift = driftEvent(completed);
		const quarantined = await reduceChildOutputEvent(completed, drift, context);
		expect(quarantined.status).toBe("quarantined");
		expect(quarantined.artifactSeal?.status).toBe("invalidated");
		expect(quarantined.artifactSeal?.invalidationDigest).toEqual(expect.any(String));
		expect(quarantined.deliveryId).toBeNull();
		expect(quarantined.acknowledgementReceiptDigest).toBeNull();
		expect(quarantined.validatedOutputs).toEqual([]);
		expect(quarantined.coordinator).toMatchObject({ wake: { kind: "error", status: "pending" } });
		expect(quarantined.coordinator.wake?.wakeKey).toBe(terminalWakeKey);
		await expect(reduceChildOutputEvent(quarantined, drift, context)).resolves.toBe(quarantined);
	});

	it("rejects clearing the obligation during compaction and escalates only a no-evidence loop", async () => {
		const context = hostContext();
		const { state } = await runningState(context);
		const forgedEvidenceDigest = {
			...compactionEvent(state, "forged-evidence", "evidence-1"),
			evidenceDigest: "caller-swap",
		};
		await expect(reduceChildOutputEvent(state, forgedEvidenceDigest, context)).rejects.toThrow(/closed|evidence/i);
		const forgedEvidenceRef = {
			...compactionEvent(state, "forged-evidence-ref", "evidence-1"),
			evidenceRef: { ...EVIDENCE_REF, digest: "0".repeat(64) },
		};
		await expect(reduceChildOutputEvent(state, forgedEvidenceRef, context)).rejects.toThrow(
			/artifact|digest|evidence/i,
		);
		const first = await reduceChildOutputEvent(
			state,
			compactionEvent(state, "compact-loop-1", "evidence-1"),
			context,
		);
		const stalled = await reduceChildOutputEvent(
			first,
			compactionEvent(first, "compact-loop-2", "evidence-1"),
			context,
		);
		expect(stalled.diagnostic).toBe("stalled_output_obligation");
		expect(stalled.continuationEscalation).toMatchObject({ reason: "stalled_output_obligation" });
		expect(stalled.continuationWake?.attemptId).toBe(state.attemptId);
		expect(stalled.continuationWake?.wakeId).toBe(first.continuationWake?.wakeId);
		expect(stalled.continuationWake?.createdByEventId).toBe(first.continuationWake?.createdByEventId);
		expect(stalled.outputObligation.status).toBe("undischarged");
		expect(stalled.coordinator.wake).toBeNull();
		expect(stalled.coordinator.deadline).toEqual(first.coordinator.deadline);
		const clearedWake = { ...first, continuationWake: null } as ChildAttemptState;
		const clearedWakeWithDigest = {
			...clearedWake,
			stateDigest: recomputeChildAttemptStateDigest(clearedWake),
		};
		expect(() => parseChildAttemptState(JSON.parse(JSON.stringify(clearedWakeWithDigest)), context)).toThrow(
			/wake|obligation|integrity/i,
		);

		const clearedWithoutDigest = {
			...first,
			outputObligation: { ...first.outputObligation, status: "discharged" },
		} as ChildAttemptState;
		const cleared = { ...clearedWithoutDigest, stateDigest: recomputeChildAttemptStateDigest(clearedWithoutDigest) };
		await expect(
			reduceChildOutputEvent(cleared, completedEvent(cleared, "clear-obligation"), context),
		).rejects.toThrow(/obligation|integrity/i);

		const progressContext = hostContext({ head: PROGRESS_HEAD });
		const progressed = await reduceChildOutputEvent(
			stalled,
			compactionEvent(stalled, "compact-loop-3", "evidence-2", PROGRESS_HEAD),
			progressContext,
		);
		expect(progressed.compactionNoProgressCount).toBe(0);
		expect(progressed.diagnostic).toBeNull();
		expect(progressed.continuationEscalation).toBeNull();
		expect(progressed.continuationWake?.attemptId).toBe(state.attemptId);
		expect(progressed.coordinator.wake).toBeNull();
		expect(progressed.coordinator.deadline).toEqual(state.coordinator.deadline);
		expect(progressed.coordinator.meaningfulProgressDigest).toBe(
			digestObject({ evidenceDigest: sha256Hex(EVIDENCE_BYTES), head: PROGRESS_HEAD }),
		);
		await expect(
			reduceChildOutputEvent(progressed, compactionEvent(state, "compact-loop-1", "evidence-1"), progressContext),
		).resolves.toBe(progressed);
	});

	it("clears a pending wake only through explicit cancellation, terminal failure, or authorized scope change", async () => {
		const { state, context } = await runningState();
		const compacted = await reduceChildOutputEvent(
			state,
			compactionEvent(state, "compact-terminal", "evidence-1"),
			context,
		);
		await expect(
			reduceChildOutputEvent(
				compacted,
				{ ...cancellationEvent(compacted), witness: undefined } as unknown as ChildOutputEvent,
				context,
			),
		).rejects.toThrow(/closed|witness|receipt/i);
		const cancelled = await reduceChildOutputEvent(compacted, cancellationEvent(compacted), context);
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.outputObligation.status).toBe("cancelled");
		expect(cancelled.reason).toBe("operator_cancelled");
		expect(cancelled.continuationWake).toBeNull();
		expect(cancelled.coordinator).toMatchObject({
			deadline: { status: "cancelled", transitionEventId: "cancel-obligation" },
			terminal: { status: "cancelled", eventId: "cancel-obligation" },
			wake: { kind: "gating", status: "pending" },
		});
		const incompleteForCancellation = await reduceChildOutputEvent(
			createChildAttemptState(declaration(context), context),
			{ ...completedEvent(state, "incomplete-before-cancel"), finalAssistantResult: null },
			context,
		);
		const cancelledAfterError = await reduceChildOutputEvent(
			incompleteForCancellation,
			cancellationEvent(incompleteForCancellation, "cancel-after-error"),
			context,
		);
		expect(cancelledAfterError.coordinator.wake).toMatchObject({ kind: "gating", status: "pending" });

		const failedState = createChildAttemptState(declaration(context), context);
		const failedCompaction = await reduceChildOutputEvent(
			failedState,
			compactionEvent(failedState, "compact-failure", "evidence-1"),
			context,
		);
		const failed = await reduceChildOutputEvent(failedCompaction, failureEvent(failedCompaction), context);
		expect(failed.status).toBe("terminal_failed");
		expect(failed.outputObligation.status).toBe("terminal_failed");
		expect(failed.continuationWake).toBeNull();
		expect(failed.coordinator).toMatchObject({
			deadline: { status: "terminal_failed", transitionEventId: "fail-obligation" },
			terminal: { status: "terminal_failed", eventId: "fail-obligation" },
			wake: { kind: "error", status: "pending" },
		});

		const scopeState = createChildAttemptState(declaration(context), context);
		const scopeCompaction = await reduceChildOutputEvent(
			scopeState,
			compactionEvent(scopeState, "compact-scope", "evidence-1"),
			context,
		);
		const scopeChanged = await reduceChildOutputEvent(scopeCompaction, scopeChangeEvent(scopeCompaction), context);
		expect(scopeChanged.status).toBe("scope_changed");
		expect(scopeChanged.outputObligation.status).toBe("scope_changed");
		expect(scopeChanged.continuationWake).toBeNull();
		expect(scopeChanged.coordinator).toMatchObject({
			deadline: { status: "scope_changed", transitionEventId: "scope-obligation" },
			terminal: { status: "scope_changed", eventId: "scope-obligation" },
			wake: { kind: "gating", status: "pending" },
		});
	});

	it("rejects a terminal follow-up unless a distinct retry attempt is explicitly recorded", async () => {
		const { state, context } = await runningState();
		const sealed = await sealState(state, context);
		const validating = await reduceChildOutputEvent(sealed, completedEvent(sealed), context);
		const pending = await reduceChildOutputEvent(validating, validationEvent(validating), context);
		const completed = await reduceChildOutputEvent(pending, acknowledgementEvent(pending), context);
		const followUp: ChildOutputEvent = {
			...eventBase(completed, "follow-up"),
			kind: "follow_up_requested",
			requestId: "follow-up",
		};
		await expect(reduceChildOutputEvent(completed, followUp, context)).rejects.toThrow(
			/terminal|new attempt|follow/i,
		);
	});
});
