import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { getProcessStartId } from "../session-lease.js";
import { digestObject, type WorkflowProcessGroupIdentity } from "./contracts.js";
import type {
	WorkflowPlatformProcessIdentity,
	WorkflowPosixProcessGroupHost,
	WorkflowProcessGroupObservation,
	WorkflowProcessGroupPlatform,
	WorkflowProcessGroupPlatformDependencies,
	WorkflowProcessSpawnDescriptor,
} from "./process-groups.js";
import {
	assertWorkflowProcessContainmentAttestation,
	assertWorkflowProcessGroupIdentity,
	assertWorkflowProcessSpawnDescriptor,
	WorkflowProcessError,
	workflowProcessGroupIdentityMatches,
} from "./process-groups.js";

const execFile = promisify(execFileCallback);

function positiveProcessGroupId(value: string): string {
	const trimmed = value.trim();
	const groupId = Number(trimmed);
	if (!Number.isSafeInteger(groupId) || groupId <= 0)
		throw new WorkflowProcessError("workflow_process_group_unavailable");
	return String(groupId);
}

function positivePid(value: string): number {
	const pid = Number(value.trim());
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new WorkflowProcessError("workflow_process_identity_unavailable");
	return pid;
}

function platformIdentity(
	pid: number,
	processStartId: string,
	processGroupId: string,
): WorkflowPlatformProcessIdentity {
	const identity = { pid, processStartId, processGroupId, platformGroupKind: "posix_process_group" as const };
	return {
		...identity,
		platformInspectionDigest: digestObject(identity),
	};
}

async function readProcessGroupId(pid: number): Promise<string | null> {
	try {
		const result = await execFile("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
		return positiveProcessGroupId(result.stdout);
	} catch {
		return null;
	}
}

async function readParentPid(pid: number): Promise<number | null> {
	try {
		const result = await execFile("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
		return positivePid(result.stdout);
	} catch {
		return null;
	}
}

async function _listProcessIds(processGroupId: string): Promise<number[]> {
	try {
		const result = await execFile("ps", ["-eo", "pid=,pgid="], { encoding: "utf8" });
		const processIds: number[] = [];
		for (const line of result.stdout.split("\n")) {
			const fields = line.trim().split(/\s+/);
			if (fields.length !== 2 || fields[1] !== processGroupId) continue;
			try {
				processIds.push(positivePid(fields[0] ?? ""));
			} catch {
				// Ignore malformed process-list rows; they are not an identity proof.
			}
		}
		return processIds.sort((left, right) => left - right);
	} catch {
		return [];
	}
}

export async function readVerifiedPosixProcessGroupIdentity(
	pid: number,
): Promise<WorkflowPlatformProcessIdentity | null> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return null;
	const processStartId = getProcessStartId(pid);
	if (!processStartId) return null;
	const processGroupId = await readProcessGroupId(pid);
	if (!processGroupId) return null;
	return platformIdentity(pid, processStartId, processGroupId);
}

export async function readVerifiedPosixWorkflowProcessGroupIdentity(
	pid: number,
): Promise<WorkflowProcessGroupIdentity | null> {
	const platformIdentity = await readVerifiedPosixProcessGroupIdentity(pid);
	if (platformIdentity === null) return null;
	const parentPid = await readParentPid(pid);
	if (parentPid === null) return null;
	const unsigned = {
		pid: platformIdentity.pid,
		processStartId: platformIdentity.processStartId,
		processGroupId: platformIdentity.processGroupId,
		parentPid,
	};
	return { ...unsigned, identityDigest: digestObject(unsigned) };
}

export function createPosixProcessGroupPlatform(
	input: WorkflowProcessGroupPlatformDependencies,
): WorkflowProcessGroupPlatform {
	const host: WorkflowPosixProcessGroupHost | undefined = input.posixProcessGroupHost;
	if (host === undefined) throw new WorkflowProcessError("workflow_platform_unsupported");
	const verifiedObservation = async (
		identity: {
			readonly pid: number;
			readonly processStartId: string;
			readonly processGroupId: string;
			readonly expectedGroupIdentityDigest: string;
		},
		observation: WorkflowProcessGroupObservation,
	): Promise<WorkflowProcessGroupObservation> => {
		assertWorkflowProcessContainmentAttestation(observation.containment);
		if (
			!observation.verified ||
			observation.identity.pid !== identity.pid ||
			observation.identity.processStartId !== identity.processStartId ||
			observation.identity.processGroupId !== identity.processGroupId ||
			observation.identity.identityDigest !== identity.expectedGroupIdentityDigest
		)
			return { ...observation, verified: false };
		try {
			assertWorkflowProcessGroupIdentity(observation.identity);
		} catch {
			return { ...observation, verified: false };
		}
		return observation;
	};
	const assertHostAuthenticated = async (identity: WorkflowProcessGroupIdentity): Promise<void> => {
		assertWorkflowProcessGroupIdentity(identity);
		const observation = await verifiedObservation(
			{
				pid: identity.pid,
				processStartId: identity.processStartId,
				processGroupId: identity.processGroupId,
				expectedGroupIdentityDigest: identity.identityDigest,
			},
			await host.inspect(identity.pid, identity.processStartId, identity.processGroupId, identity.identityDigest),
		);
		if (!observation.verified || !workflowProcessGroupIdentityMatches(observation.identity, identity))
			throw new WorkflowProcessError("workflow_process_identity_mismatch");
	};
	return {
		async spawn(
			request: WorkflowProcessSpawnDescriptor,
		): Promise<{ pid: number; identity: WorkflowPlatformProcessIdentity }> {
			assertWorkflowProcessSpawnDescriptor(request);
			const containment = await host.verifyContainment();
			assertWorkflowProcessContainmentAttestation(containment);
			const spawned = await host.spawnAndAssign(request);
			if (
				!Number.isSafeInteger(spawned.pid) ||
				spawned.pid <= 0 ||
				spawned.identity.pid !== spawned.pid ||
				spawned.identity.processStartId.length === 0 ||
				spawned.identity.processGroupId.length === 0 ||
				spawned.identity.platformGroupKind !== "posix_process_group"
			)
				throw new WorkflowProcessError("workflow_process_identity_unavailable");
			return spawned;
		},
		inspect: async (
			pid: number,
			processStartId: string,
			processGroupId: string,
			expectedGroupIdentityDigest: string,
		): Promise<WorkflowProcessGroupObservation> =>
			verifiedObservation(
				{ pid, processStartId, processGroupId, expectedGroupIdentityDigest },
				await host.inspect(pid, processStartId, processGroupId, expectedGroupIdentityDigest),
			),
		signal: async (identity: WorkflowProcessGroupIdentity, signal: NodeJS.Signals): Promise<void> => {
			await assertHostAuthenticated(identity);
			await host.terminate(identity, signal);
		},
		reap: async (
			identity: WorkflowProcessGroupIdentity,
		): Promise<{
			remainingPids: readonly number[];
			reapDigest: string;
		}> => {
			await assertHostAuthenticated(identity);
			return host.reap(identity);
		},
		scanGroups: (): Promise<readonly WorkflowProcessGroupIdentity[]> => host.scanGroups(),
		quarantineSpawn: async (identity: WorkflowProcessGroupIdentity, reason: string): Promise<void> => {
			await assertHostAuthenticated(identity);
			await host.quarantine(identity, input.workflowRoot, reason);
		},
	};
}
