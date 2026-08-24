import type {
	WorkflowArtifactRef,
	WorkflowChildIdentity,
	WorkflowEpochRef,
	WorkflowGenerationRotationQuarantineReason,
} from "./contracts.js";

export interface WorkflowRecoveryRequest {
	workflowId: string;
	taskId: string;
	attemptId: string;
	executionKey: string;
	epochRef: WorkflowEpochRef;
	persistedChildIdentity: WorkflowChildIdentity | null;
	evidenceRefs: readonly WorkflowArtifactRef[];
}

export type WorkflowQuarantineReason =
	| "invalid_frame"
	| "invalid_mac"
	| "unknown_event_kind"
	| "payload_decode_failed"
	| "foreign_workflow"
	| "stale_epoch"
	| "writer_fenced"
	| "prepared_without_commit"
	| "committed_without_prepared"
	| "duplicate_sequence"
	| "sequence_chain_break"
	| "commit_return_uncertain"
	| WorkflowGenerationRotationQuarantineReason
	| "artifact_missing"
	| "artifact_digest_mismatch"
	| "artifact_size_mismatch";

export interface WorkflowRecoverySource {
	artifactRef: WorkflowArtifactRef | null;
	relativePath: string;
	digest: string | null;
	sizeBytes: number;
}

export interface WorkflowQuarantineRecord {
	workflowId: string;
	status: "quarantined";
	reason: WorkflowQuarantineReason;
	source: WorkflowRecoverySource;
	epochRef: WorkflowEpochRef;
	eventSequence: number | null;
}

export interface WorkflowReconciliationOutcome {
	workflowId: string;
	reconciliationAttemptId: string;
	taskId: string;
	attemptId: string;
	disposition:
		| "reattached"
		| "still_running"
		| "completed"
		| "proven_not_executed"
		| "corrective_work_required"
		| "user_input_required"
		| "failed";
	persistedChildIdentity: WorkflowChildIdentity | null;
	observedChildIdentity: WorkflowChildIdentity | null;
	observedProcessGroupId: string | null;
	observedTranscriptDigest: string | null;
	observedWorkspaceDigest: string;
	epochRef: WorkflowEpochRef;
	evidenceRefs: readonly WorkflowArtifactRef[];
	stateDigest: string;
}

export interface WorkflowRecoveryResult {
	workflowId: string;
	status: "healthy" | "recovered" | "quarantined" | "blocked";
	reason: WorkflowQuarantineReason | null;
	source: WorkflowRecoverySource;
	epochRef: WorkflowEpochRef;
	reconciliation: WorkflowReconciliationOutcome | null;
	quarantine: WorkflowQuarantineRecord | null;
}

export interface WorkflowRecoveryPort {
	reconcile(request: WorkflowRecoveryRequest): Promise<WorkflowReconciliationOutcome>;
}
