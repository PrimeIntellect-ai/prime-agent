import { chmod, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DurableApprovalSecretProof, WorkflowApprovalRequest } from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";

const WORKFLOW_CLI_APPROVAL_FILE = "workflow-cli-approval.json";

export interface WorkflowCliApprovalDelivery {
	readonly version: 1;
	readonly request: WorkflowApprovalRequest;
	readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	readonly deliveryDigest: string;
}

function approvalPath(artifactRoot: string): string {
	return join(artifactRoot, WORKFLOW_CLI_APPROVAL_FILE);
}

function parseWorkflowCliApprovalDelivery(value: unknown): WorkflowCliApprovalDelivery {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("workflow_cli_approval_delivery_corrupt");
	const record = value as Record<string, unknown>;
	if (
		record.version !== 1 ||
		typeof record.request !== "object" ||
		record.request === null ||
		typeof record.proofs !== "object" ||
		record.proofs === null ||
		typeof record.deliveryDigest !== "string"
	)
		throw new Error("workflow_cli_approval_delivery_corrupt");
	const unsigned = { version: 1 as const, request: record.request, proofs: record.proofs };
	if (record.deliveryDigest !== digestObject(unsigned)) throw new Error("workflow_cli_approval_delivery_corrupt");
	return Object.freeze({
		...unsigned,
		request: structuredClone(record.request as WorkflowApprovalRequest),
		proofs: structuredClone(record.proofs as Record<string, DurableApprovalSecretProof>),
		deliveryDigest: record.deliveryDigest,
	});
}

/** Store the host-delivered one-use approval credential outside model-visible transcript state. */
export async function persistWorkflowCliApprovalDelivery(input: {
	readonly artifactRoot: string;
	readonly request: WorkflowApprovalRequest;
	readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
}): Promise<void> {
	const unsigned = {
		version: 1 as const,
		request: structuredClone(input.request),
		proofs: structuredClone(input.proofs),
	};
	const bytes = canonicalJsonBytes({ ...unsigned, deliveryDigest: digestObject(unsigned) });
	const path = approvalPath(input.artifactRoot);
	const temporaryPath = `${path}.tmp`;
	await writeFile(temporaryPath, bytes, { mode: 0o600 });
	await chmod(temporaryPath, 0o600);
	await rename(temporaryPath, path);
	await chmod(path, 0o600);
}

/** Read and verify the private one-use approval credential for the current pending request. */
export async function readWorkflowCliApprovalDelivery(
	artifactRoot: string,
): Promise<WorkflowCliApprovalDelivery | undefined> {
	const bytes = await readFile(approvalPath(artifactRoot)).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	});
	if (bytes === undefined) return undefined;
	const parsed = parseCanonicalJsonBytes(bytes);
	if (!Buffer.from(canonicalJsonBytes(parsed)).equals(bytes))
		throw new Error("workflow_cli_approval_delivery_corrupt");
	return parseWorkflowCliApprovalDelivery(parsed);
}

/** Delete the exact consumed approval credential after the authoritative response commits. */
export async function removeWorkflowCliApprovalDelivery(artifactRoot: string): Promise<void> {
	await unlink(approvalPath(artifactRoot)).catch((error: unknown) => {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	});
}
