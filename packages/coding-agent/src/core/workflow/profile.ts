import type {
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject, resolveAndVerifyWorkflowHostReceipt } from "./contracts.js";

export interface WorkflowProfileApprovalReceipt extends WorkflowVerifiedHostReceipt {
	receiptKind: "decision";
	decisionRef: WorkflowDecisionRef;
	epochRef: WorkflowEpochRef;
}

export interface WorkflowProfileInput {
	workflowId: string;
	requestedProfile: "inline" | "parallel" | undefined;
	maxWorkers: number | undefined;
	readyIndependentTaskCount: number;
	capacity: { processSlots: number; unknownPoolIds: readonly string[] };
	approvalReceipt: WorkflowProfileApprovalReceipt | null;
	expectedEpoch: WorkflowEpochRef;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentStateDigest: string;
	currentRevision: number;
}

export interface WorkflowProfileResolution {
	requestedProfile: "inline" | "parallel" | undefined;
	maxWorkers: number;
	recommended: "inline" | "parallel";
	resolved: "inline" | "parallel" | "unresolved";
	profileDigest: string;
	approvalDecisionRef: WorkflowDecisionRef | null;
	approvalReceipt: WorkflowProfileApprovalReceipt | null;
	requiresUserApproval: true;
}

function assertProfileRequest(input: WorkflowProfileInput): void {
	if (
		input.workflowId.length === 0 ||
		!Number.isSafeInteger(input.readyIndependentTaskCount) ||
		input.readyIndependentTaskCount < 0
	)
		throw new Error("Workflow profile input is not finite.");
	if (
		input.requestedProfile !== undefined &&
		input.requestedProfile !== "inline" &&
		input.requestedProfile !== "parallel"
	)
		throw new Error("Workflow profile request is invalid.");
	if (
		!Number.isSafeInteger(input.capacity.processSlots) ||
		input.capacity.processSlots < 1 ||
		input.capacity.unknownPoolIds.length > 0
	)
		throw new Error("Workflow profile cannot use unknown or unmeasured capacity.");
}

export async function resolveWorkflowProfile(input: WorkflowProfileInput): Promise<WorkflowProfileResolution> {
	assertProfileRequest(input);
	const maxWorkers = input.maxWorkers ?? 1;
	if (!Number.isSafeInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > input.capacity.processSlots)
		throw new Error("Workflow maxWorkers must be finite and fit measured process capacity.");
	const approvalReceipt = input.approvalReceipt;
	const approvalDecisionRef = approvalReceipt?.decisionRef ?? null;
	if (approvalReceipt !== null) {
		if (
			approvalReceipt.workflowId !== input.workflowId ||
			approvalReceipt.receiptKind !== "decision" ||
			approvalReceipt.epochRef === undefined ||
			approvalReceipt.epochRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
			approvalReceipt.epochRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
			approvalDecisionRef === null ||
			approvalDecisionRef.decisionScope === undefined ||
			approvalDecisionRef.decisionScope.kind !== "workflow" ||
			approvalDecisionRef.decisionScope.workflowId !== input.workflowId ||
			approvalDecisionRef.storeEpoch !== input.expectedEpoch.storeEpoch ||
			approvalDecisionRef.coordinatorEpoch !== input.expectedEpoch.coordinatorEpoch ||
			approvalDecisionRef.revision !== input.currentRevision ||
			approvalDecisionRef.decisionDigest.length === 0
		) {
			throw new Error(
				"Approved workflow profile must carry a typed epoch-bound decision reference and host receipt.",
			);
		}
		const { decisionRef: _decisionRef, epochRef: _epochRef, ...signedReceipt } = approvalReceipt;
		await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: digestObject({
				workflowId: input.workflowId,
				requestedProfile: input.requestedProfile ?? null,
				maxWorkers,
				readyIndependentTaskCount: input.readyIndependentTaskCount,
				capacity: input.capacity,
				decisionRef: approvalDecisionRef,
				epochRef: input.expectedEpoch,
				currentRevision: input.currentRevision,
			}),
			receipt: signedReceipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: approvalReceipt.issuedAt,
		});
	}
	const recommended = input.readyIndependentTaskCount >= 2 && input.capacity.processSlots >= 2 ? "parallel" : "inline";
	if (approvalReceipt !== null && input.requestedProfile === "parallel" && recommended !== "parallel")
		throw new Error(
			"Parallel profile approval requires at least two independent ready tasks and two measured process slots.",
		);
	const resolved = approvalReceipt === null ? "unresolved" : (input.requestedProfile ?? recommended);
	return {
		requestedProfile: input.requestedProfile,
		maxWorkers,
		recommended,
		resolved,
		profileDigest: digestObject({
			workflowId: input.workflowId,
			requestedProfile: input.requestedProfile ?? null,
			maxWorkers,
			readyIndependentTaskCount: input.readyIndependentTaskCount,
			capacity: input.capacity,
			recommended,
			resolved,
			approvalDecisionRef,
			approvalReceipt,
		}),
		approvalDecisionRef,
		approvalReceipt,
		requiresUserApproval: true,
	};
}
