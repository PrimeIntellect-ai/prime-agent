import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ChildAttemptState,
	type ChildFinalAssistantResult,
	type ChildOutputEvent,
	type ChildOutputEventBase,
	type ChildOutputHostContext,
	type ChildTaskDeclaration,
	canonicalFinalResult,
	createChildAttemptState,
	parseChildAttemptState,
	parseChildOutputEvent,
	parseChildTaskDeclaration,
	reduceChildOutputEvent,
	sha256Hex,
} from "../../src/core/child-output-contract.js";
import {
	canonicalJsonBytes,
	digestObject,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowJournalHead,
	type WorkflowReceiptVerificationKey,
	type WorkflowVerifiedHostReceipt,
} from "../../src/core/workflow/contracts.js";

const mode = process.argv[2];
const rootDir = process.argv[3];
const modes = new Set(["produce", "recover", "replay", "invalid"]);
if (rootDir === undefined || typeof mode !== "string" || !modes.has(mode))
	throw new Error("Usage: child-output-contract-process.ts <produce|recover|replay|invalid> <root>");

mkdirSync(rootDir, { recursive: true });
mkdirSync(join(rootDir, "events"), { recursive: true });

const EPOCH: WorkflowEpochRef = { storeEpoch: 4, coordinatorEpoch: 2 };
const HEAD: WorkflowJournalHead = {
	workflowId: "workflow-child-output-process",
	sequence: 21,
	eventDigest: "head-event-process",
	epochRef: EPOCH,
};
const HOST_STATE_DIGEST = "host-state-child-output-process";
const ARTIFACT_BYTES = canonicalJsonBytes({ report: "immutable process artifact" });
const ARTIFACT_REF: WorkflowArtifactRef = {
	artifactId: "artifact-child-output-process",
	relativePath: "artifacts/report.json",
	digest: sha256Hex(ARTIFACT_BYTES),
	sizeBytes: ARTIFACT_BYTES.byteLength,
	sourceEventSequence: HEAD.sequence,
};
const RECEIPT_BYTES = canonicalJsonBytes({ receipt: "host-issued child-output receipt" });
const RECEIPT_REF: WorkflowArtifactRef = {
	artifactId: "receipt-child-output-process",
	relativePath: "receipts/host-receipt.json",
	digest: sha256Hex(RECEIPT_BYTES),
	sizeBytes: RECEIPT_BYTES.byteLength,
	sourceEventSequence: HEAD.sequence,
};
const FINAL_VALUE = { resultId: "assistant-result-process", answer: "exactly-once" };
const FINAL_RESULT = canonicalFinalResult({
	resultId: FINAL_VALUE.resultId,
	bytes: canonicalJsonBytes(FINAL_VALUE),
	schema: "assistant-final-v1",
	validator: "assistant-final-validator-v1",
});
const ARTIFACT = {
	outputId: "report",
	path: ARTIFACT_REF.relativePath,
	ref: ARTIFACT_REF,
	digest: ARTIFACT_REF.digest,
	schema: "report-v1",
	validator: "report-validator-v1",
} as const;
const SEAL_RECEIPT = makeReceipt("seal-receipt-process");
const PARENT_RECEIPT = makeReceipt("parent-receipt-process");
const RECEIPTS = new Map<string, WorkflowVerifiedHostReceipt>([
	[SEAL_RECEIPT.receiptId, SEAL_RECEIPT],
	[PARENT_RECEIPT.receiptId, PARENT_RECEIPT],
]);

interface FinalResultPacketRecord {
	readonly eventId: string;
	readonly packetDigest: string;
	readonly resultId: string;
	readonly schema: string;
	readonly validator: string;
}

interface ParentReceiptRecord {
	readonly deliveryId: string;
	readonly eventId: string;
	readonly packetDigest: string | null;
	readonly receiptId: string;
}

interface ParentContextRecord {
	readonly bindingDigest: string;
	readonly operationDigest: string;
	readonly receiptId: string;
}

interface BindingDetails {
	readonly operationDigest: string;
	readonly resourceDigest: string;
}

interface HostStore {
	readonly finalResultPackets: FinalResultPacketRecord[];
	readonly parentReceiptRecords: ParentReceiptRecord[];
	readonly parentContextRecords: ParentContextRecord[];
	readonly bindingDetails: Record<string, BindingDetails>;
	readonly consumedReceipts: Record<string, WorkflowHostReceiptConsumptionWitness>;
}

function makeReceipt(receiptId: string): WorkflowVerifiedHostReceipt {
	return {
		receiptKind: "capability",
		oneUse: true,
		receiptId,
		issuerId: "host-authority-process",
		workflowId: HEAD.workflowId,
		bindingDigest: "1".repeat(64),
		payloadDigest: RECEIPT_REF.digest,
		artifactRef: RECEIPT_REF,
		issuedAt: "2026-08-18T12:00:00.000Z",
		validUntil: "2026-08-18T13:00:00.000Z",
		keyId: "child-output-process-key",
		signatureAlgorithm: "ed25519",
		artifactBytesDigest: RECEIPT_REF.digest,
		stateDigest: HOST_STATE_DIGEST,
		revision: HEAD.sequence,
		capabilityBinding: {
			capability: "child_output_delivery_ack",
			resourceDigest: "child-output-resource",
			operationDigest: "child-output-operation",
			executionIdentity: null,
			sessionId: null,
		},
		signature: `signature-${receiptId}`,
		verificationDigest: `verification-${receiptId}`,
	};
}

function jsonPath(name: string): string {
	return join(rootDir as string, name);
}

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function emptyHostStore(): HostStore {
	return {
		finalResultPackets: [],
		parentReceiptRecords: [],
		parentContextRecords: [],
		bindingDetails: {},
		consumedReceipts: {},
	};
}

function readHostStore(): HostStore {
	const path = jsonPath("host-store.json");
	return existsSync(path) ? readJson<HostStore>(path) : emptyHostStore();
}

function writeHostStore(store: HostStore): void {
	writeJson(jsonPath("host-store.json"), store);
}

function hostContext(): ChildOutputHostContext {
	const hostTuple = {
		workflowId: HEAD.workflowId,
		head: HEAD,
		epochRef: EPOCH,
		stateDigest: HOST_STATE_DIGEST,
		revision: HEAD.sequence,
	};
	const artifactResolver: WorkflowHostReceiptConsumerContext["artifactResolver"] = {
		resolve: async (ref) => {
			const receiptArtifact = ref.artifactId === RECEIPT_REF.artifactId;
			const bytes = receiptArtifact ? RECEIPT_BYTES : ARTIFACT_BYTES;
			const expectedRef = receiptArtifact ? RECEIPT_REF : ARTIFACT_REF;
			if (digestObject(ref) !== digestObject(expectedRef)) throw new Error("fixture_artifact_ref_unknown");
			return {
				envelope: {
					ref: expectedRef,
					payloadKind: receiptArtifact ? "effect_result" : "effect_result",
					codec: "canonical_json",
					immutable: true,
					immutableGeneration: "child-output-process-generation",
				} as WorkflowArtifactReadResult["envelope"] & { readonly immutableGeneration: string },
				exists: true,
				bytes: Uint8Array.from(bytes),
				verifiedDigest: expectedRef.digest,
				verifiedSizeBytes: expectedRef.sizeBytes,
			};
		},
	};
	const key: WorkflowReceiptVerificationKey = {
		algorithm: "ed25519",
		verify: () => true,
		ownerPrincipal: "host-authority-process",
		allowedCapabilities: new Set(["child_output_delivery_ack"]),
		generationId: "child-output-process-generation",
		epochRef: EPOCH,
		fencingDigest: "child-output-process-fence",
		revoked: false,
	};
	const receiptResolver: WorkflowHostReceiptConsumerContext["receiptResolver"] = {
		resolve: async (input) => {
			const expected = RECEIPTS.get(input.receipt.receiptId);
			if (expected === undefined || digestObject(expected) !== digestObject(input.receipt))
				throw new Error("fixture_receipt_unknown_or_forged");
			return input.receipt;
		},
		consumeIfOneUse: async (input) => {
			if (!input.receipt.oneUse) throw new Error("fixture_receipt_not_one_use");
			const store = readHostStore();
			const prior = store.consumedReceipts[input.receipt.receiptId];
			if (prior !== undefined) {
				if (prior.bindingDigest !== input.expectedBindingDigest)
					throw new Error("fixture_receipt_binding_conflict");
				throw new Error("fixture_receipt_already_consumed");
			}
			const consumptionSequence = Object.keys(store.consumedReceipts).length + 1;
			const details = store.bindingDetails[input.expectedBindingDigest];
			if (details === undefined) throw new Error("fixture_receipt_binding_details_missing");
			const witness: WorkflowHostReceiptConsumptionWitness = {
				receiptId: input.receipt.receiptId,
				workflowId: input.workflowId,
				bindingDigest: input.expectedBindingDigest,
				capability: "child_output_delivery_ack",
				resourceDigest: details.resourceDigest,
				operationDigest: details.operationDigest,
				receiptDigest: digestObject(input.receipt),
				consumedAt: "2026-08-18T12:01:00.000Z",
				consumptionSequence,
			};
			writeHostStore({
				...store,
				consumedReceipts: { ...store.consumedReceipts, [input.receipt.receiptId]: witness },
			});
		},
		resolveConsumptionWitness: async (input) => {
			const witness = readHostStore().consumedReceipts[input.receiptId];
			if (witness === undefined || witness.workflowId !== input.workflowId)
				throw new Error("fixture_receipt_witness_missing");
			if (witness.bindingDigest !== input.expectedBindingDigest)
				throw new Error("fixture_receipt_witness_binding_conflict");
			return witness;
		},
	};
	const principalAuthorizer: WorkflowHostReceiptConsumerContext["principalAuthorizer"] = {
		authorize: async (
			input: WorkflowHostPrincipalCapabilityAuthorizationInput,
		): Promise<WorkflowHostPrincipalCapabilityAuthorization> => {
			if (input.capability !== "child_output_delivery_ack") throw new Error("fixture_capability_rejected");
			const store = readHostStore();
			const parentContextAlreadyRecorded = store.parentContextRecords.some(
				(record) => record.receiptId === input.receipt.receiptId && record.bindingDigest === input.bindingDigest,
			);
			const bindingDetailsAlreadyRecorded = store.bindingDetails[input.bindingDigest] !== undefined;
			const nextParentContextRecords =
				input.receipt.receiptId === PARENT_RECEIPT.receiptId && !parentContextAlreadyRecorded
					? [
							...store.parentContextRecords,
							{
								receiptId: input.receipt.receiptId,
								bindingDigest: input.bindingDigest,
								operationDigest: input.operationDigest,
							},
						]
					: store.parentContextRecords;
			if (!bindingDetailsAlreadyRecorded || nextParentContextRecords.length !== store.parentContextRecords.length) {
				writeHostStore({
					...store,
					bindingDetails: {
						...store.bindingDetails,
						[input.bindingDigest]: {
							resourceDigest: input.resourceDigest,
							operationDigest: input.operationDigest,
						},
					},
					parentContextRecords: nextParentContextRecords,
				});
			}
			return {
				authenticatedPrincipal: "host-authority-process",
				keyOwnerPrincipal: "host-authority-process",
				capability: input.capability,
				workflowId: input.workflowId,
				bindingDigest: input.bindingDigest,
				receipt: input.receipt,
				stateDigest: input.stateDigest,
				revision: input.revision,
				epochRef: input.epochRef,
				validity: { issuedAt: input.receipt.issuedAt, validUntil: input.receipt.validUntil },
				executionIdentity: input.executionIdentity,
				sessionId: input.sessionId,
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
			};
		},
	};
	return {
		hostTuple,
		runtimeVersion: "0.147.0-alpha.10",
		receiptContext: {
			receiptResolver,
			keyResolver: { resolve: async () => key },
			revokedReceiptIds: new Set(),
			artifactResolver,
			principalAuthorizer,
		},
		readHostTuple: async () => hostTuple,
		prepareCommitIntent: async (input) => {
			const store = readHostStore();
			if (input.operation === "terminal_send") {
				if (input.packetDigest === null) throw new Error("fixture_terminal_packet_missing");
				const existing = store.finalResultPackets.find((packet) => packet.packetDigest === input.packetDigest);
				if (existing === undefined) {
					writeHostStore({
						...store,
						finalResultPackets: [
							...store.finalResultPackets,
							{
								eventId: input.eventId,
								packetDigest: input.packetDigest,
								resultId: FINAL_RESULT.resultId,
								schema: FINAL_RESULT.schema,
								validator: FINAL_RESULT.validator,
							},
						],
					});
				}
			}
			if (input.operation === "parent_delivery_ack") {
				if (input.deliveryId === null) throw new Error("fixture_parent_delivery_id_missing");
				const existing = store.parentReceiptRecords.find((record) => record.deliveryId === input.deliveryId);
				if (existing === undefined) {
					const receipt = PARENT_RECEIPT;
					writeHostStore({
						...store,
						parentReceiptRecords: [
							...store.parentReceiptRecords,
							{
								deliveryId: input.deliveryId,
								eventId: input.eventId,
								packetDigest: input.packetDigest,
								receiptId: receipt.receiptId,
							},
						],
					});
				}
			}
			return { ...input, intentDigest: digestObject(input) };
		},
		validateFinalResult: async ({ result, parsed }) => {
			if (
				result.schema !== FINAL_RESULT.schema ||
				result.validator !== FINAL_RESULT.validator ||
				!isRecord(parsed) ||
				parsed.resultId !== FINAL_RESULT.resultId
			)
				throw new Error("fixture_final_result_schema_rejected");
		},
		validateArtifactOutput: async ({ output, required, resolvedArtifact }) => {
			if (
				output.schema !== required.schema ||
				output.validator !== required.validator ||
				resolvedArtifact.envelope.immutable !== true
			)
				throw new Error("fixture_artifact_schema_rejected");
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declarationInput(): Record<string, unknown> {
	return {
		version: 1,
		taskId: "task-child-output-process",
		childId: "child-output-process",
		runId: "run-child-output-process",
		attemptId: "attempt-child-output-process",
		workflowId: HEAD.workflowId,
		head: HEAD,
		epochRef: EPOCH,
		maxAttempts: 3,
		maxCompactions: 3,
		requiredFinalResult: { schema: FINAL_RESULT.schema, validator: FINAL_RESULT.validator },
		requiredArtifacts: [ARTIFACT],
	};
}

function declaration(context: ChildOutputHostContext): ChildTaskDeclaration {
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

function packetDigest(finalAssistantResult: ChildFinalAssistantResult | null): string {
	return digestObject({ finalAssistantResult, toolResults: [], artifacts: [ARTIFACT] });
}

function sealEvent(
	state: ChildAttemptState,
	eventId: string,
): Extract<ChildOutputEvent, { kind: "artifact_seal_recorded" }> {
	return {
		...eventBase(state, eventId),
		kind: "artifact_seal_recorded",
		artifacts: [ARTIFACT],
		outputObligationId: state.outputObligation.obligationId,
		packetDigest: packetDigest(FINAL_RESULT),
		producerExecutionId: "producer-execution-process",
		sealId: `seal-${eventId}`,
		witness: SEAL_RECEIPT,
	};
}

function terminalEvent(
	state: ChildAttemptState,
	finalAssistantResult: ChildFinalAssistantResult | null,
	eventId: string,
): Extract<ChildOutputEvent, { kind: "child_finished" }> {
	return {
		...eventBase(state, eventId),
		kind: "child_finished",
		finalAssistantResult,
		toolResults: [],
		artifacts: finalAssistantResult === null ? [] : [ARTIFACT],
		packetDigest: packetDigest(finalAssistantResult),
		producerExecutionId: "producer-execution-process",
	};
}

function validationEvent(
	state: ChildAttemptState,
	eventId: string,
): Extract<ChildOutputEvent, { kind: "outputs_validated" }> {
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

function acknowledgementEvent(
	state: ChildAttemptState,
	eventId: string,
): Extract<ChildOutputEvent, { kind: "parent_delivery_acknowledged" }> {
	return {
		...eventBase(state, eventId),
		kind: "parent_delivery_acknowledged",
		deliveryId: "delivery-child-output-process",
		receipt: PARENT_RECEIPT,
	};
}

function writeState(state: ChildAttemptState): void {
	writeJson(jsonPath("state.json"), state);
}

function readState(context: ChildOutputHostContext): ChildAttemptState {
	return parseChildAttemptState(readJson<unknown>(jsonPath("state.json")), context);
}

function summary(): Record<string, unknown> {
	const store = readHostStore();
	return {
		finalResultPackets: store.finalResultPackets.length,
		parentReceiptRecords: store.parentReceiptRecords.length,
		parentContextRecords: store.parentContextRecords.length,
		parentReceiptConsumptionCount: store.consumedReceipts[PARENT_RECEIPT.receiptId] === undefined ? 0 : 1,
		oneUseConsumptionCount: Object.keys(store.consumedReceipts).length,
	};
}

function holdProcess(): void {
	setInterval(() => {}, 1_000);
}

async function runProduce(): Promise<void> {
	const context = hostContext();
	const running = createChildAttemptState(declaration(context), context);
	const seal = sealEvent(running, "seal-process");
	const sealed = await reduceChildOutputEvent(running, seal, context);
	writeState(sealed);
	writeJson(jsonPath("events/seal.json"), seal);
	const terminal = terminalEvent(sealed, FINAL_RESULT, "terminal-process");
	writeJson(jsonPath("events/terminal.json"), terminal);
	const terminalProjection = await reduceChildOutputEvent(sealed, terminal, context);
	if (terminalProjection.status !== "validating") throw new Error("fixture_terminal_output_not_accepted");
	const output = {
		status: "post-output-pre-parent-receipt",
		stateStatus: sealed.status,
		terminalProjectionStatus: terminalProjection.status,
		...summary(),
		finalResult: {
			resultId: FINAL_RESULT.resultId,
			schema: FINAL_RESULT.schema,
			validator: FINAL_RESULT.validator,
		},
	};
	writeJson(jsonPath("result.json"), output);
	writeJson(jsonPath("post-output-pre-parent-receipt.json"), output);
	holdProcess();
}

async function runRecover(): Promise<void> {
	const context = hostContext();
	const reopened = readState(context);
	const terminal = parseChildOutputEvent(readJson<unknown>(jsonPath("events/terminal.json")));
	const validating = await reduceChildOutputEvent(reopened, terminal, context);
	writeState(validating);
	writeJson(jsonPath("events/terminal.json"), terminal);
	const validation = validationEvent(validating, "validate-process");
	const pending = await reduceChildOutputEvent(validating, validation, context);
	writeState(pending);
	writeJson(jsonPath("events/validation.json"), validation);
	const acknowledgement = acknowledgementEvent(pending, "ack-process");
	const completed = await reduceChildOutputEvent(pending, acknowledgement, context);
	writeState(completed);
	writeJson(jsonPath("events/acknowledgement.json"), acknowledgement);
	writeJson(jsonPath("result.json"), {
		status: "completed-after-restart",
		reopenedStatus: reopened.status,
		reopenedAppliedEventIds: Object.keys(reopened.appliedEventDigests),
		finalResult: {
			resultId: completed.finalAssistantResult?.resultId,
			schema: completed.finalAssistantResult?.schema,
			validator: completed.finalAssistantResult?.validator,
		},
		...summary(),
	});
}

async function runReplay(): Promise<void> {
	const context = hostContext();
	const completed = readState(context);
	const acknowledgement = parseChildOutputEvent(readJson<unknown>(jsonPath("events/acknowledgement.json"))) as Extract<
		ChildOutputEvent,
		{ kind: "parent_delivery_acknowledged" }
	>;
	const exact = await reduceChildOutputEvent(completed, acknowledgement, context);
	if (exact.stateDigest !== completed.stateDigest) throw new Error("fixture_exact_replay_changed_state");
	let conflictingDuplicate = "accepted";
	try {
		await reduceChildOutputEvent(completed, { ...acknowledgement, deliveryId: "forged-delivery" }, context);
	} catch {
		conflictingDuplicate = "rejected";
	}
	const terminal = parseChildOutputEvent(readJson<unknown>(jsonPath("events/terminal.json"))) as Extract<
		ChildOutputEvent,
		{ kind: "child_finished" }
	>;
	let staleReplay = "accepted";
	try {
		await reduceChildOutputEvent(completed, { ...terminal, eventId: "stale-terminal-replay" }, context);
	} catch {
		staleReplay = "rejected";
	}
	writeJson(jsonPath("result.json"), {
		status: "replay-checked",
		exactDuplicate: "idempotent-no-effect",
		conflictingDuplicate,
		staleReplay,
		...summary(),
	});
}

async function runInvalid(): Promise<void> {
	const context = hostContext();
	const running = createChildAttemptState(declaration(context), context);
	const emptyOutput = terminalEvent(running, null, "empty-output");
	const retryable = await reduceChildOutputEvent(running, emptyOutput, context);
	const invalidRunning = createChildAttemptState(declaration(context), context);
	const seal = sealEvent(invalidRunning, "seal-invalid");
	const sealed = await reduceChildOutputEvent(invalidRunning, seal, context);
	const invalidResult = { ...FINAL_RESULT, schema: "unsupported-schema" };
	const invalidOutput = terminalEvent(sealed, invalidResult, "invalid-output");
	let rejection = "accepted";
	try {
		await reduceChildOutputEvent(sealed, invalidOutput, context);
	} catch {
		rejection = "rejected";
	}
	writeJson(jsonPath("result.json"), {
		status: "invalid-output-checked",
		emptyOutput: {
			status: retryable.status,
			reason: retryable.reason,
			wakeKind: retryable.coordinator.wake?.kind,
		},
		invalidOutput: {
			status: sealed.status,
			lastEventId: sealed.lastEventId,
			rejected: rejection === "rejected",
		},
		...summary(),
	});
}

if (mode === "produce") await runProduce();
else if (mode === "recover") await runRecover();
else if (mode === "replay") await runReplay();
else await runInvalid();
