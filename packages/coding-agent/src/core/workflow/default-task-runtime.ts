import type {
	WorkflowArtifactRef,
	WorkflowEpochRef,
	WorkflowJournalHead,
	WorkflowTask,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject } from "./contracts.js";
import type { WorkflowWorkerLaunchObservation } from "./dispatch.js";
import type {
	WorkflowTaskRuntimeAudit,
	WorkflowTaskRuntimeAuthority,
	WorkflowTaskRuntimeEvidenceClassification,
	WorkflowTaskRuntimeStatus,
	WorkflowTaskRuntimeWorkerResult,
} from "./task-runtime-authority.js";

export type DefaultPrimeWorkerResultStatus = WorkflowTaskRuntimeWorkerResult["status"];

export interface DefaultPrimeWorkerCompletionBinding {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
}

export interface DefaultPrimeWorkerCompletion {
	readonly kind: "worker";
	readonly binding: DefaultPrimeWorkerCompletionBinding;
	readonly status: "completed" | "error" | "cancelled";
	readonly output: string;
	readonly error: string | null;
	readonly retryable: boolean;
}

export interface DefaultPrimeWorkerOutputContract {
	readonly logicalPath: string;
	readonly schemaKind: "default_prime_task_output_v1";
	readonly jsonSchema: DefaultPrimeWorkerOutputJsonSchema;
	readonly canonicalExample: DefaultPrimeWorkerOutputExample;
	readonly resultChannel: "terminal_assistant_response";
	readonly evidencePolicyId: string;
	readonly evidenceKind?: string;
	readonly maxBytes: number;
	readonly maxItems: number;
	readonly independent: boolean;
}

export interface DefaultPrimeWorkerOutputJsonSchema {
	readonly $schema: "https://json-schema.org/draft/2020-12/schema";
	readonly type: "object";
	readonly additionalProperties: false;
	readonly required: readonly ["findings", "kind", "schemaVersion", "summary", "taskId"];
	readonly properties: Readonly<{
		findings: Readonly<{
			type: "array";
			minItems: 1;
			maxItems: number;
			items: Readonly<{ type: "string"; minLength: 1 }>;
		}>;
		kind: Readonly<{ const: "default_prime_task_output_v1" }>;
		schemaVersion: Readonly<{ const: 1 }>;
		summary: Readonly<{ type: "string"; minLength: 1 }>;
		taskId: Readonly<{ const: string }>;
	}>;
}

export interface DefaultPrimeWorkerOutputExample {
	readonly findings: readonly ["one concise evidence-backed finding"];
	readonly kind: "default_prime_task_output_v1";
	readonly schemaVersion: 1;
	readonly summary: "one concise task outcome";
	readonly taskId: string;
}

export function defaultPrimeWorkerOutputContract(input: {
	readonly taskId: string;
	readonly logicalPath: string;
	readonly evidencePolicyId: string;
	readonly evidenceKind?: string;
	readonly maxBytes: number;
	readonly maxItems: number;
	readonly independent: boolean;
}): DefaultPrimeWorkerOutputContract {
	return {
		logicalPath: input.logicalPath,
		schemaKind: "default_prime_task_output_v1",
		jsonSchema: {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			additionalProperties: false,
			required: ["findings", "kind", "schemaVersion", "summary", "taskId"],
			properties: {
				findings: {
					type: "array",
					minItems: 1,
					maxItems: input.maxItems,
					items: { type: "string", minLength: 1 },
				},
				kind: { const: "default_prime_task_output_v1" },
				schemaVersion: { const: 1 },
				summary: { type: "string", minLength: 1 },
				taskId: { const: input.taskId },
			},
		},
		canonicalExample: {
			findings: ["one concise evidence-backed finding"],
			kind: "default_prime_task_output_v1",
			schemaVersion: 1,
			summary: "one concise task outcome",
			taskId: input.taskId,
		},
		resultChannel: "terminal_assistant_response",
		evidencePolicyId: input.evidencePolicyId,
		...(input.evidenceKind === undefined ? {} : { evidenceKind: input.evidenceKind }),
		maxBytes: input.maxBytes,
		maxItems: input.maxItems,
		independent: input.independent,
	};
}

export interface DefaultPrimeWorkerTaskCapsuleCore {
	readonly schemaVersion: 1;
	readonly kind: "default_prime_worker_task_capsule";
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
	readonly goalRevisionDigest: string;
	readonly goalBindingDigest: string;
	readonly graphDigest: string;
	readonly taskGraphSourceDigest?: string;
	/** Capability gate for the legacy fixed Prime topology; dynamic graphs never carry it. */
	readonly recipeCapability?: "builtin_adaptive_prime" | "dynamic_task_graph";
	readonly recipeDigest: string;
	readonly admissionDigest: string;
	readonly objective: string;
	readonly requirementIds: readonly string[];
	readonly completionCriteria: readonly string[];
	readonly dependencyTaskIds: readonly string[];
	readonly inputRefs?: readonly string[];
	readonly boundaryIds?: readonly string[];
	readonly outputRefs?: readonly string[];
	readonly evidencePolicy?: NonNullable<WorkflowTask["evidencePolicy"]>;
	readonly evidenceKind?: string;
	readonly budget?: NonNullable<WorkflowTask["budget"]>;
	readonly recoveryPolicy?: NonNullable<WorkflowTask["recoveryPolicy"]>;
	readonly authority: WorkflowTask["authority"];
	readonly deadlineAt: string;
	readonly outputContract: DefaultPrimeWorkerOutputContract;
	readonly forbiddenOutcomes: readonly ["prose_only_result", "unbound_or_extra_output", "protected_or_holdout_data"];
	readonly terminalReturnProtocol: "canonical_json_only";
}

export interface DefaultPrimeWorkerTaskCapsule extends DefaultPrimeWorkerTaskCapsuleCore {
	readonly capsuleDigest: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface DefaultPrimeTaskCapsuleFactoryInput {
	readonly task: WorkflowTask;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly epochRef: WorkflowEpochRef;
	readonly journalHead: WorkflowJournalHead;
	readonly deadlineAt: string;
}

export type DefaultPrimeTaskCapsuleFactory = (
	input: DefaultPrimeTaskCapsuleFactoryInput,
) => Promise<DefaultPrimeWorkerTaskCapsule>;

export function defaultPrimeWorkerTaskCapsuleDigest(capsule: DefaultPrimeWorkerTaskCapsuleCore): string {
	return digestObject(capsule);
}

export function defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest: string): string {
	return digestObject({ kind: "default_prime_worker_task_capsule", capsuleDigest });
}

export interface DefaultPrimeWorkerFailureNotice {
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly workerId: string;
	readonly status: Exclude<DefaultPrimeWorkerResultStatus, "completed">;
	readonly error: string;
	readonly retryable: boolean;
	readonly recoveryDecision: "replan_required";
	readonly resultEvidenceRef: WorkflowArtifactRef;
}

export interface DefaultPrimeWorkerLaunch
	extends Omit<
		WorkflowWorkerLaunchObservation,
		"workflowId" | "taskId" | "attemptId" | "executionKey" | "epochRef" | "launchEvidenceRef"
	> {
	readonly completion?: Promise<DefaultPrimeWorkerCompletion>;
	readonly terminate?: (reason: string) => Promise<boolean>;
}

export type DefaultPrimeWorkerAttemptResolver = (
	input: Readonly<{
		workflowId: string;
		taskId: string;
		attemptId: string;
		executionKey: string;
		epochRef: WorkflowEpochRef;
		launch: WorkflowWorkerLaunchObservation;
	}>,
) => Promise<DefaultPrimeWorkerLaunch | null>;

export type DefaultPrimeWorkerLauncher = (
	input: Readonly<{
		workflowId: string;
		taskId: string;
		attemptId: string;
		executionKey: string;
		epochRef: WorkflowEpochRef;
		deadlineAt: string;
		prompt: string;
		taskCapsule?: DefaultPrimeWorkerTaskCapsule;
		sessionName: string;
		reportHeartbeat(input: { readonly observedAt: string; readonly progressDigest: string }): Promise<void>;
	}>,
) => Promise<DefaultPrimeWorkerLaunch>;

export interface DefaultPrimeTaskRuntime {
	readonly authority: WorkflowTaskRuntimeAuthority;
	readonly scheduler: WorkflowTaskRuntimeAuthority["scheduler"];
	readonly prime: WorkflowTaskRuntimeAuthority["prime"];
	start(): Promise<void>;
	dispose(): Promise<void>;
	assertStageAcceptable(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	acceptStage(input: {
		readonly stageId: string;
		readonly classification: WorkflowTaskRuntimeEvidenceClassification;
	}): Promise<void>;
	readStatus(): Promise<WorkflowTaskRuntimeStatus>;
	read(): Promise<Awaited<ReturnType<WorkflowTaskRuntimeAuthority["readState"]>>>;
	readAudit(): Promise<WorkflowTaskRuntimeAudit>;
}

/**
 * Adapt the generic task-runtime authority to the Prime host shape.
 *
 * Args:
 * input: A previously composed generic authority; worker launch and durable state remain authority-owned.
 * Return: A thin Prime adapter with no queue, attempt, launch, result, or outbox state of its own.
 */
export function createDefaultPrimeTaskRuntime(input: {
	readonly authority?: WorkflowTaskRuntimeAuthority;
}): DefaultPrimeTaskRuntime {
	if (input.authority === undefined) throw new Error("default_prime_task_runtime_authority_required");
	const authority = input.authority;
	return Object.freeze({
		authority,
		scheduler: authority.scheduler,
		prime: authority.prime,
		start: async (): Promise<void> => {
			await authority.start();
		},
		dispose: async (): Promise<void> => undefined,
		assertStageAcceptable: authority.assertStageAcceptable,
		acceptStage: authority.acceptStage,
		readStatus: authority.readStatus,
		read: authority.readState,
		readAudit: authority.readAudit,
	});
}
