import { describe, expect, it } from "vitest";
import {
	digestObject,
	type WorkflowEpochRef,
	type WorkflowGenerationBinding,
	type WorkflowJournalHead,
} from "../src/core/workflow/contracts.js";
import type {
	WorkflowJournalImpl,
	WorkflowJournalKey,
	WorkflowJournalKeyProvider,
	WorkflowJournalKeyRotationInput,
} from "../src/core/workflow/journal.js";
import { deriveWorkflowGenerationId } from "../src/core/workflow/journal.js";
import { type WorkflowState, WorkflowStore } from "../src/core/workflow/reducer.js";

const PREVIOUS_EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const NEXT_EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 2 };
const PREVIOUS_LEASE = {
	...PREVIOUS_EPOCH,
	leaseId: "lease-1",
	acquisitionEventSequence: 1,
	processIdentity: "process-1",
	rootDigest: "root-digest",
	writerIdentity: "writer-1",
	acquiredAt: "2026-08-15T00:00:00.000Z",
	expiresAt: "2026-08-15T01:00:00.000Z",
};
const SUCCESSOR_BINDING: WorkflowGenerationBinding = {
	writerIdentity: "writer-2",
	processGenerationId: "process-2",
	ownerIdentity: "writer-2",
};

describe("workflow epoch rotation", () => {
	it("uses canonical key issuance instead of bootstrapping the successor epoch", async () => {
		const expectedHead: WorkflowJournalHead = {
			workflowId: "workflow-1",
			sequence: 7,
			eventDigest: "head-digest",
			epochRef: PREVIOUS_EPOCH,
		};
		const previousKey: WorkflowJournalKey = {
			keyId: "previous-key",
			secret: new TextEncoder().encode("previous-secret"),
			validStoreEpoch: PREVIOUS_EPOCH.storeEpoch,
			generationId: "generation-previous",
		};
		const successorKey: Omit<WorkflowJournalKey, "generationId"> = {
			keyId: "successor-key",
			secret: new TextEncoder().encode("successor-secret"),
			validStoreEpoch: NEXT_EPOCH.storeEpoch,
		};
		const currentEpochs: WorkflowEpochRef[] = [];
		let canonicalRotationInput: WorkflowJournalKeyRotationInput | undefined;
		const keyProvider: WorkflowJournalKeyProvider = {
			current: async (_workflowId, epoch) => {
				currentEpochs.push(epoch);
				if (epoch.coordinatorEpoch !== PREVIOUS_EPOCH.coordinatorEpoch) {
					throw new Error("successor bootstrap generation is unavailable");
				}
				return previousKey;
			},
			resolve: async () => previousKey,
			rotateGeneration: async (input) => {
				canonicalRotationInput = input;
				return {
					...successorKey,
					generationId: deriveWorkflowGenerationId({
						workflowId: input.workflowId,
						nextEpoch: input.nextEpoch,
						rotationId: input.rotationId,
						priorHeadDigest: input.priorHeadDigest,
					}),
				};
			},
		};
		const committedRotation = {} as WorkflowJournalKeyRotationInput;
		const journal = {
			options: {
				workflowId: expectedHead.workflowId,
				epoch: PREVIOUS_EPOCH,
				writerIdentity: "writer-1",
				leaseRef: PREVIOUS_LEASE,
				keyProvider,
				now: () => "2026-08-15T00:00:00.000Z",
			},
			descriptorContext: {
				generationId: previousKey.generationId,
				rootDigest: "root-digest",
			},
			rotationStore: {
				readActiveGeneration: async () => null,
			},
			rotateGeneration: async (input: WorkflowJournalKeyRotationInput) => {
				Object.assign(committedRotation, input);
				return {};
			},
		} as unknown as WorkflowJournalImpl;
		const state = {
			workflowId: expectedHead.workflowId,
			sourceJournalSequence: expectedHead.sequence,
			sourceJournalDigest: expectedHead.eventDigest,
			storeEpoch: PREVIOUS_EPOCH.storeEpoch,
			coordinatorEpoch: PREVIOUS_EPOCH.coordinatorEpoch,
			generationBinding: {
				writerIdentity: "writer-1",
				processGenerationId: "process-1",
				ownerIdentity: "writer-1",
			},
		} as WorkflowState;
		const store = Object.create(WorkflowStore.prototype) as WorkflowStore;
		Object.assign(store, { journal, rootSessionId: "session-1" });
		store.reload = async () => state;

		await store.replaceCoordinatorEpoch(NEXT_EPOCH, SUCCESSOR_BINDING);

		expect(currentEpochs).toEqual([PREVIOUS_EPOCH]);
		expect(canonicalRotationInput).toEqual({
			workflowId: expectedHead.workflowId,
			previousEpoch: PREVIOUS_EPOCH,
			nextEpoch: NEXT_EPOCH,
			rotationId: "coordinator:workflow-1:2",
			priorHeadDigest: digestObject(expectedHead),
		});
		expect(committedRotation).toMatchObject({
			rotationId: "coordinator:workflow-1:2",
			keyId: successorKey.keyId,
		});
	});
});
