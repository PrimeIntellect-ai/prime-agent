import { assertFreshUuid } from "./daemon-lifecycle-identity.js";

/**
 * The registry is a compatibility journal, but only a complete C03 tuple is
 * authority.  Keep this classifier shared by its owning daemon and the
 * read-only catalog so partial disk history cannot acquire a second meaning.
 */
export type RlmRegistryIdentity =
	| { kind: "legacy-display" }
	| { kind: "assignment-display"; assignmentId: string }
	| { kind: "c03"; assignmentId: string; operationId: string; deliveryId: string }
	| { kind: "invalid" };

export interface RlmRegistryIdentityFields {
	assignmentId?: unknown;
	operationId?: unknown;
	deliveryId?: unknown;
}

export function classifyRlmRegistryIdentity(entry: RlmRegistryIdentityFields): RlmRegistryIdentity {
	const { assignmentId, operationId, deliveryId } = entry;
	if (assignmentId === undefined && operationId === undefined && deliveryId === undefined) {
		return { kind: "legacy-display" };
	}
	if (operationId === undefined && deliveryId === undefined && assertFreshUuid(assignmentId)) {
		return { kind: "assignment-display", assignmentId };
	}
	if (assertFreshUuid(assignmentId) && assertFreshUuid(operationId) && assertFreshUuid(deliveryId)) {
		return { kind: "c03", assignmentId, operationId, deliveryId };
	}
	return { kind: "invalid" };
}

/** Fail closed at every C03 registry writer before a partial row reaches disk. */
export function assertRlmRegistryWriteIdentity(entry: RlmRegistryIdentityFields): void {
	if (classifyRlmRegistryIdentity(entry).kind === "invalid") {
		throw new Error("RLM registry identity must be all-absent, assignment-only, or a complete C03 triple");
	}
}
