import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowRuntimeStore,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import type { WorkflowState } from "./reducer.js";
import {
	createWorkerModelCapabilityGate,
	WORKER_MODEL_CAPABILITY,
	WORKER_MODEL_ID,
	WORKER_MODEL_PROVIDER,
	WORKER_MODEL_REASONING,
	type WorkerModelCapabilityAuthorization,
	type WorkerModelCapabilityInspectionInput,
	type WorkerModelCapabilityLaunchAuthorizer,
} from "./worker-model-capability-gate.js";

const WORKER_MODEL_POLICY_REVISION = digestObject({
	provider: WORKER_MODEL_PROVIDER,
	model: WORKER_MODEL_ID,
	reasoning: WORKER_MODEL_REASONING,
	allowFallback: false,
	version: 1,
});

export interface WorkerModelCapabilityAvailabilityInput extends WorkerModelCapabilityInspectionInput {}

/** Redacted model-catalog and authentication facts supplied by the source runtime. */
export interface WorkerModelCapabilityAvailability {
	readonly authenticated: boolean;
	readonly authRevision: string;
	readonly capabilityRevision: string;
	readonly safeReason: string;
	readonly desiredWorkers?: number;
	readonly activeWorkers?: number;
	readonly idleCapacity?: number;
	readonly idleReason?: string | null;
	readonly retryAt?: string | null;
}

export type WorkerModelCapabilityAvailabilityResolver = (
	input: WorkerModelCapabilityAvailabilityInput,
) => Promise<WorkerModelCapabilityAvailability> | WorkerModelCapabilityAvailability;

export type PersistedWorkerModelReceiptIssuer = (input: {
	readonly receiptKind: "capability";
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly capability: typeof WORKER_MODEL_CAPABILITY;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly oneUse: boolean;
	readonly stateDigest: string;
	readonly revision: number;
}) => Promise<WorkflowVerifiedHostReceipt>;

export interface PersistedWorkerModelAdmissionInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly runtimeVersion: string;
	readonly workflowId: string;
	readonly readState: () => Promise<WorkflowState | null>;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: PersistedWorkerModelReceiptIssuer;
	readonly availability: WorkerModelCapabilityAvailabilityResolver;
	readonly now: () => string;
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function capabilityBindingDigest(input: {
	readonly workflowId: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly stateDigest: string;
	readonly revision: number;
	readonly epochRef: WorkflowEpochRef;
}): string {
	return digestObject({ capability: WORKER_MODEL_CAPABILITY, ...input });
}

interface WorkerModelTaskAttemptBinding {
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
}

function taskAttemptBinding(input: {
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
}): WorkerModelTaskAttemptBinding {
	if (input.taskId.length === 0 || input.attemptId.length === 0 || input.executionKey.length === 0)
		throw new Error("worker_model_task_attempt_binding_invalid");
	return {
		taskId: input.taskId,
		attemptId: input.attemptId,
		executionKey: input.executionKey,
	};
}

function dispatchOperationDigest(input: {
	readonly taskId: string;
	readonly goalId: string;
	readonly preflightDigest: string;
	readonly taskAttemptBinding: WorkerModelTaskAttemptBinding;
}): string {
	return digestObject({
		operation: "worker_model_dispatch",
		taskId: input.taskId,
		goalId: input.goalId,
		preflightDigest: input.preflightDigest,
		taskAttemptBinding: input.taskAttemptBinding,
	});
}

function dispatchResourceDigest(input: {
	readonly workflowId: string;
	readonly taskId: string;
	readonly goalId: string;
	readonly policy: WorkerModelCapabilityInspectionInput["policy"];
	readonly taskAttemptBinding: WorkerModelTaskAttemptBinding;
}): string {
	return digestObject({
		workflowId: input.workflowId,
		taskId: input.taskId,
		goalId: input.goalId,
		policy: input.policy,
		taskAttemptBinding: input.taskAttemptBinding,
	});
}

function availabilityResourceDigest(input: {
	readonly workflowId: string;
	readonly policy: WorkerModelCapabilityInspectionInput["policy"];
	readonly taskAttemptBinding: WorkerModelTaskAttemptBinding;
}): string {
	return digestObject({
		workflowId: input.workflowId,
		policy: input.policy,
		taskAttemptBinding: input.taskAttemptBinding,
	});
}

function availabilityReceiptTuple(input: {
	readonly inspection: WorkerModelCapabilityInspectionInput;
	readonly availability: WorkerModelCapabilityAvailability;
	readonly taskAttemptBinding: WorkerModelTaskAttemptBinding;
}): { readonly bindingDigest: string; readonly resourceDigest: string; readonly operationDigest: string } {
	const resourceDigest = availabilityResourceDigest({
		workflowId: input.inspection.workflowId,
		policy: input.inspection.policy,
		taskAttemptBinding: input.taskAttemptBinding,
	});
	const operationDigest = digestObject({
		operation: "worker_model_capability_inspect",
		authenticated: input.availability.authenticated,
		authRevision: input.availability.authRevision,
		capabilityRevision: input.availability.capabilityRevision,
		policyRevision: input.inspection.policy.policyRevision,
		stateDigest: input.inspection.stateDigest,
		revision: input.inspection.revision,
		epochRef: input.inspection.epochRef,
		taskAttemptBinding: input.taskAttemptBinding,
	});
	return {
		resourceDigest,
		operationDigest,
		bindingDigest: capabilityBindingDigest({
			workflowId: input.inspection.workflowId,
			resourceDigest,
			operationDigest,
			stateDigest: input.inspection.stateDigest,
			revision: input.inspection.revision,
			epochRef: input.inspection.epochRef,
		}),
	};
}

/** Compose the durable gate with the persisted signer and current source-runtime availability. */
export function createPersistedWorkerModelCapabilityAdmission(
	input: PersistedWorkerModelAdmissionInput,
): WorkerModelCapabilityLaunchAuthorizer {
	return async (launch) => {
		if (launch.workflowId !== input.workflowId) throw new Error("worker_model_launch_workflow_mismatch");
		const taskAttemptBindingValue = taskAttemptBinding({
			taskId: launch.taskId,
			attemptId: launch.attemptId,
			executionKey: launch.executionKey,
		});
		const state = await input.readState();
		if (state === null || state.status !== "active" || !state.goalActive)
			throw new Error("blocked_model_capability: workflow authority is not active");
		const stateEpoch = { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch };
		if (!sameEpoch(launch.epochRef, stateEpoch)) throw new Error("blocked_model_capability: workflow epoch is stale");

		let cachedAvailability:
			| {
					readonly digest: string;
					readonly receipt: WorkflowVerifiedHostReceipt;
					readonly value: WorkerModelCapabilityAvailability;
			  }
			| undefined;
		let currentAvailability: WorkerModelCapabilityAvailability | undefined;
		const policy = {
			provider: WORKER_MODEL_PROVIDER,
			model: WORKER_MODEL_ID,
			reasoning: WORKER_MODEL_REASONING,
			allowFallback: false as const,
			policyRevision: WORKER_MODEL_POLICY_REVISION,
		};
		const gate = createWorkerModelCapabilityGate({
			runtimeStore: input.runtimeStore,
			workflowId: input.workflowId,
			runtimeVersion: input.runtimeVersion,
			policy,
			now: input.now,
			host: {
				inspect: async (inspection) => {
					const availability = await input.availability(inspection);
					currentAvailability = availability;
					if (!availability.authenticated) {
						return {
							...availability,
							policyRevision: inspection.policy.policyRevision,
							receipt: null,
						};
					}
					const tuple = availabilityReceiptTuple({
						inspection,
						availability,
						taskAttemptBinding: taskAttemptBindingValue,
					});
					const availabilityDigest = digestObject({ availability, tuple });
					if (cachedAvailability?.digest !== availabilityDigest) {
						const receipt = await input.issueReceipt({
							receiptKind: "capability",
							workflowId: input.workflowId,
							...tuple,
							capability: WORKER_MODEL_CAPABILITY,
							oneUse: false,
							stateDigest: inspection.stateDigest,
							revision: inspection.revision,
						});
						if (receipt.capabilityBinding?.resourceDigest !== tuple.resourceDigest)
							throw new Error("worker_model_capability_receipt_task_binding_invalid");
						cachedAvailability = { digest: availabilityDigest, receipt, value: availability };
					}
					return {
						...availability,
						policyRevision: inspection.policy.policyRevision,
						receipt: cachedAvailability.receipt,
					};
				},
				authorize: async (authorizationInput): Promise<WorkerModelCapabilityAuthorization> => {
					if (currentAvailability === undefined)
						throw new Error("worker_model_capability_authorization_without_inspection");
					const receipt = await input.issueReceipt({
						receiptKind: "capability",
						workflowId: input.workflowId,
						bindingDigest: authorizationInput.bindingDigest,
						capability: WORKER_MODEL_CAPABILITY,
						resourceDigest: authorizationInput.resourceDigest,
						operationDigest: authorizationInput.operationDigest,
						oneUse: false,
						stateDigest: authorizationInput.stateDigest,
						revision: authorizationInput.revision,
					});
					const authorization = await input.receiptContext.principalAuthorizer.authorize({
						...authorizationInput,
						receipt,
					});
					return {
						authenticatedPrincipal: authorization.authenticatedPrincipal,
						capability: WORKER_MODEL_CAPABILITY,
						workflowId: authorization.workflowId,
						bindingDigest: authorization.bindingDigest,
						resourceDigest: authorizationInput.resourceDigest,
						operationDigest: authorizationInput.operationDigest,
						receipt: authorization.receipt,
						authRevision: currentAvailability.authRevision,
						capabilityRevision: currentAvailability.capabilityRevision,
						policyRevision: authorizationInput.policy.policyRevision,
						authorizationDigest: authorization.authorizationDigest,
					};
				},
			},
		});

		const context = {
			stateDigest: state.sourceJournalDigest,
			revision: state.sourceJournalSequence,
			epochRef: stateEpoch,
		};
		const preflight = await gate.preflight(context);
		if (
			preflight.status === "available" &&
			(preflight.receipt === null ||
				preflight.receipt.capabilityBinding?.resourceDigest !==
					availabilityResourceDigest({
						workflowId: input.workflowId,
						policy,
						taskAttemptBinding: taskAttemptBindingValue,
					}))
		)
			throw new Error("worker_model_capability_receipt_task_binding_invalid");
		const dispatch = await gate.dispatch({
			...context,
			taskId: launch.taskId,
			goalId: state.goalId,
			enqueuedAt: input.now(),
			attemptId: launch.attemptId,
			executionKey: launch.executionKey,
			preflight,
		});
		if (dispatch.status === "blocked") {
			if (dispatch.contractChange !== null) throw new Error(dispatch.contractChange);
			throw new Error(`blocked_model_capability: ${dispatch.blocker.safeReason}`);
		}
		const expectedDispatchOperationDigest = dispatchOperationDigest({
			taskId: launch.taskId,
			goalId: state.goalId,
			preflightDigest: preflight.preflightDigest,
			taskAttemptBinding: taskAttemptBindingValue,
		});
		const expectedDispatchBindingDigest = capabilityBindingDigest({
			workflowId: input.workflowId,
			resourceDigest: dispatchResourceDigest({
				workflowId: input.workflowId,
				taskId: launch.taskId,
				goalId: state.goalId,
				policy,
				taskAttemptBinding: taskAttemptBindingValue,
			}),
			operationDigest: expectedDispatchOperationDigest,
			stateDigest: context.stateDigest,
			revision: context.revision,
			epochRef: context.epochRef,
		});
		const quarantineReceiptMismatch = async (): Promise<Awaited<ReturnType<typeof gate.handshake>>> => {
			let receiptDigest = digestObject({
				admissionDigest: dispatch.intent.admissionDigest,
				reason: "receipt_mismatch",
			});
			if (receiptDigest === dispatch.intent.receiptDigest) receiptDigest = "0".repeat(64);
			return gate.handshake({
				admission: dispatch.intent,
				actual: { ...dispatch.intent.childModel, receiptDigest },
			});
		};
		return {
			intent: dispatch.intent,
			handshake: async (actual) => {
				try {
					const currentState = await input.readState();
					if (
						currentState === null ||
						currentState.status !== "active" ||
						!currentState.goalActive ||
						!sameEpoch(
							{ storeEpoch: currentState.storeEpoch, coordinatorEpoch: currentState.coordinatorEpoch },
							context.epochRef,
						)
					)
						throw new Error("worker_model_capability_handshake_state_stale");
					const snapshot = await gate.readState();
					const persisted = snapshot.admissions.find(
						(candidate) => candidate.admissionDigest === dispatch.intent.admissionDigest,
					);
					if (persisted === undefined) return quarantineReceiptMismatch();
					const capabilityBinding = persisted.receipt.capabilityBinding;
					if (
						persisted.receipt.bindingDigest !== expectedDispatchBindingDigest ||
						capabilityBinding?.capability !== WORKER_MODEL_CAPABILITY ||
						capabilityBinding.resourceDigest !==
							dispatchResourceDigest({
								workflowId: input.workflowId,
								taskId: launch.taskId,
								goalId: state.goalId,
								policy,
								taskAttemptBinding: taskAttemptBindingValue,
							}) ||
						capabilityBinding.operationDigest !== expectedDispatchOperationDigest
					)
						return quarantineReceiptMismatch();
					const verifiedReceipt = await resolveAndVerifyWorkflowHostReceipt({
						context: input.receiptContext,
						workflowId: input.workflowId,
						expectedBindingDigest: expectedDispatchBindingDigest,
						receipt: persisted.receipt,
						currentStateDigest: currentState.sourceJournalDigest,
						currentRevision: currentState.sourceJournalSequence,
						trustedNow: input.now(),
					});
					if (digestObject(verifiedReceipt) !== digestObject(persisted.receipt))
						throw new Error("worker_model_capability_receipt_resolution_mismatch");
					const authorization = await input.receiptContext.principalAuthorizer.authorize({
						receipt: persisted.receipt,
						workflowId: input.workflowId,
						bindingDigest: expectedDispatchBindingDigest,
						resourceDigest: dispatchResourceDigest({
							workflowId: input.workflowId,
							taskId: launch.taskId,
							goalId: state.goalId,
							policy,
							taskAttemptBinding: taskAttemptBindingValue,
						}),
						operationDigest: expectedDispatchOperationDigest,
						stateDigest: currentState.sourceJournalDigest,
						revision: currentState.sourceJournalSequence,
						epochRef: context.epochRef,
						capability: WORKER_MODEL_CAPABILITY,
					});
					if (digestObject(authorization.receipt) !== digestObject(persisted.receipt))
						throw new Error("worker_model_capability_receipt_reauthorization_mismatch");
					return gate.handshake({ admission: dispatch.intent, actual });
				} catch {
					return quarantineReceiptMismatch();
				}
			},
		};
	};
}
