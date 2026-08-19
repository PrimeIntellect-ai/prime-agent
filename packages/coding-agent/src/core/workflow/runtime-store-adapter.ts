import { lstat } from "node:fs/promises";
import type {
	WorkflowJournalHead,
	WorkflowProjectionAdapter,
	WorkflowRuntimeStore,
	WorkflowRuntimeStoreOpenInput,
} from "./contracts.js";
import type { WorkflowGenerationContextOpener, WorkflowJournal, WorkflowSessionPublicationFactory } from "./journal.js";
import { createWorkflowOwnerValidators, createWorkflowSessionPublicationFactory } from "./journal.js";
import { WorkflowStore } from "./reducer.js";
import { WorkflowRuntimeStoreBridge } from "./runtime-store-bridge.js";

export const MIN_WORKFLOW_RUNTIME_VERSION = "0.147.0-alpha.10" as const;

interface WorkflowSemver {
	readonly major: number;
	readonly minor: number;
	readonly patch: number;
	readonly prerelease: readonly (number | string)[];
}

export interface WorkflowRuntimeStoreAdapterDependencies {
	readonly projectionAdapter: WorkflowProjectionAdapter;
	readonly readHead: (journal: WorkflowJournal) => Promise<WorkflowJournalHead>;
	readonly runtimeVersion: string;
	readonly successorContextOpener: WorkflowGenerationContextOpener;
}

function invalidRuntimeVersion(): never {
	throw new Error("workflow_runtime_version_invalid");
}

function parseWorkflowSemver(version: string): WorkflowSemver {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
			version,
		);
	if (match === null) return invalidRuntimeVersion();
	const components = [Number(match[1]), Number(match[2]), Number(match[3])];
	if (!components.every((component) => Number.isSafeInteger(component))) return invalidRuntimeVersion();
	const [major, minor, patch] = components;
	if (major === undefined || minor === undefined || patch === undefined) return invalidRuntimeVersion();
	const prerelease = (match[4] ?? "")
		.split(".")
		.filter((identifier) => identifier.length > 0)
		.map((identifier): number | string => {
			if (!/^\d+$/.test(identifier)) return identifier;
			if (identifier.length > 1 && identifier.startsWith("0")) return invalidRuntimeVersion();
			const numeric = Number(identifier);
			if (!Number.isSafeInteger(numeric)) return invalidRuntimeVersion();
			return numeric;
		});
	return { major, minor, patch, prerelease };
}

function compareWorkflowSemver(left: WorkflowSemver, right: WorkflowSemver): number {
	for (const field of ["major", "minor", "patch"] as const) {
		if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
	if (left.prerelease.length === 0) return 1;
	if (right.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
		const leftIdentifier = left.prerelease[index];
		const rightIdentifier = right.prerelease[index];
		if (leftIdentifier === undefined) return -1;
		if (rightIdentifier === undefined) return 1;
		if (leftIdentifier === rightIdentifier) continue;
		if (typeof leftIdentifier === "number" && typeof rightIdentifier === "number")
			return leftIdentifier < rightIdentifier ? -1 : 1;
		if (typeof leftIdentifier === "number") return -1;
		if (typeof rightIdentifier === "number") return 1;
		return leftIdentifier < rightIdentifier ? -1 : 1;
	}
	return 0;
}

export function assertWorkflowRuntimeVersion(version: string | undefined): void {
	if (version === undefined) {
		invalidRuntimeVersion();
	}
	if (compareWorkflowSemver(parseWorkflowSemver(version), parseWorkflowSemver(MIN_WORKFLOW_RUNTIME_VERSION)) < 0)
		throw new Error("workflow_runtime_version_unsupported");
}

async function assertPersistedSessionArtifactRoot<TInput extends WorkflowRuntimeStoreOpenInput>(
	input: TInput | undefined,
): Promise<TInput> {
	if (input === undefined || input.artifactRoot.length === 0) {
		throw new Error("workflow_session_artifact_root_unavailable");
	}
	try {
		const stats = await lstat(input.artifactRoot);
		if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("workflow_session_artifact_root_unavailable");
	} catch (error) {
		if (error instanceof Error && error.message === "workflow_session_artifact_root_unavailable") throw error;
		throw new Error("workflow_session_artifact_root_unavailable");
	}
	return input;
}

function assertDescriptorRootBindings(input: WorkflowRuntimeStoreOpenInput): {
	readonly sessionArtifactRoot: string;
	readonly workflowDir: string;
} {
	const sessionRoot = input.descriptorRoots.sessionRoot;
	const workflowRoot = input.descriptorRoots.workflowRoot;
	const expectedWorkflowDir = `${input.artifactRoot}/workflows/${input.workflowId}`;
	if (
		input.artifactRoot !== sessionRoot.descriptorRoot ||
		input.workflowRoot !== workflowRoot.descriptorRoot ||
		sessionRoot.rootSessionId !== input.rootSessionId ||
		workflowRoot.workflowId !== input.workflowId ||
		input.workflowRoot !== expectedWorkflowDir
	)
		throw new Error("workflow_descriptor_root_binding_invalid");
	return { sessionArtifactRoot: input.artifactRoot, workflowDir: input.workflowRoot };
}

interface OpenedWorkflowAuthority {
	runtimeStore: WorkflowRuntimeStore;
	publication: WorkflowSessionPublicationFactory;
}

async function openWorkflowAuthority(
	validatedInput: WorkflowRuntimeStoreOpenInput,
	adapters: WorkflowRuntimeStoreAdapterDependencies,
	allowQuarantined = false,
): Promise<OpenedWorkflowAuthority> {
	const { sessionArtifactRoot, workflowDir } = assertDescriptorRootBindings(validatedInput);
	const publication = await createWorkflowSessionPublicationFactory({
		artifactRoot: validatedInput.artifactRoot,
		sessionArtifactRoot,
		workflowDir,
		descriptorRoots: validatedInput.descriptorRoots,
		storeKind: "workflow",
		namespace: "fixture",
		storeId: `fixture-store:${validatedInput.workflowId}`,
		workflowId: validatedInput.workflowId,
		rootSessionId: validatedInput.rootSessionId,
		epoch: {
			storeEpoch: validatedInput.storeEpoch,
			coordinatorEpoch: validatedInput.coordinatorEpoch,
		},
		writerIdentity: validatedInput.writerIdentity,
		keyProvider: validatedInput.keyProvider,
		appendLease: validatedInput.appendLease,
		leaseRef: validatedInput.leaseRef,
		descriptorFs: validatedInput.descriptorFs,
		ownerValidators: createWorkflowOwnerValidators(),
		now: validatedInput.now,
		successorContextOpener: adapters.successorContextOpener,
	});
	const store = await WorkflowStore.open(
		publication.journal,
		validatedInput.rootSessionId,
		validatedInput.deferredOwnerValidators,
		allowQuarantined,
	);
	const runtimeStore = WorkflowRuntimeStoreBridge.compose({
		store,
		journal: publication.journal,
		artifactPublisher: publication.artifacts,
		snapshotPublisher: publication.snapshots,
		outboxAppender: publication.outbox,
		projectionAdapter: adapters.projectionAdapter,
		readHead: () => adapters.readHead(publication.journal),
	});
	return { runtimeStore, publication };
}

/**
 * Open one authenticated workflow authority rooted at an existing session artifact directory.
 * Args:
 * input: K's validated durable-store opening tuple; undefined is rejected for in-memory sessions.
 * adapters: Host successor, projection, head, and runtime-version adapters bound to the opened journal.
 * Return: The single K runtime-store bridge for the opened journal and reducer.
 */
export async function openWorkflowRuntimeStore(
	input: WorkflowRuntimeStoreOpenInput | undefined,
	adapters: WorkflowRuntimeStoreAdapterDependencies,
): Promise<WorkflowRuntimeStore> {
	assertWorkflowRuntimeVersion(adapters.runtimeVersion);
	const validatedInput = await assertPersistedSessionArtifactRoot(input);
	return (await openWorkflowAuthority(validatedInput, adapters)).runtimeStore;
}
