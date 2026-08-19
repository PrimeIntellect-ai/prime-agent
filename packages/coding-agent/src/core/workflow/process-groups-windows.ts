import type {
	WorkflowPlatformProcessIdentity,
	WorkflowProcessGroupIdentity,
	WorkflowProcessGroupObservation,
	WorkflowProcessGroupPlatform,
	WorkflowProcessGroupPlatformDependencies,
	WorkflowProcessSpawnDescriptor,
	WorkflowWindowsJobObjectHost,
} from "./process-groups.js";
import {
	assertWorkflowProcessContainmentAttestation,
	assertWorkflowProcessGroupIdentity,
	assertWorkflowProcessSpawnDescriptor,
	WorkflowProcessError,
	workflowProcessGroupIdentityMatches,
} from "./process-groups.js";

export type {
	WorkflowPlatformProcessIdentity,
	WorkflowProcessGroupObservation,
	WorkflowProcessSpawnDescriptor,
	WorkflowWindowsJobObjectHost,
} from "./process-groups.js";

export function createWindowsJobObjectPlatform(
	input: WorkflowProcessGroupPlatformDependencies,
): WorkflowProcessGroupPlatform {
	const host: WorkflowWindowsJobObjectHost | undefined = input.windowsJobObjectHost;
	if (host === undefined) throw new WorkflowProcessError("workflow_platform_unsupported");
	const assertHostAuthenticated = async (identity: WorkflowProcessGroupIdentity): Promise<void> => {
		assertWorkflowProcessGroupIdentity(identity);
		const observation = await host.inspect(
			identity.pid,
			identity.processStartId,
			identity.processGroupId,
			identity.identityDigest,
		);
		assertWorkflowProcessContainmentAttestation(observation.containment);
		try {
			assertWorkflowProcessGroupIdentity(observation.identity);
		} catch {
			throw new WorkflowProcessError("workflow_process_identity_mismatch");
		}
		if (!observation.verified || !workflowProcessGroupIdentityMatches(observation.identity, identity))
			throw new WorkflowProcessError("workflow_process_identity_mismatch");
	};
	return {
		spawn: async (
			request: WorkflowProcessSpawnDescriptor,
		): Promise<{ pid: number; identity: WorkflowPlatformProcessIdentity }> => {
			assertWorkflowProcessSpawnDescriptor(request);
			assertWorkflowProcessContainmentAttestation(await host.verifyContainment());
			const spawned = await host.spawnAndAssign(request);
			if (
				!Number.isSafeInteger(spawned.pid) ||
				spawned.pid <= 0 ||
				spawned.identity.pid !== spawned.pid ||
				spawned.identity.processStartId.length === 0 ||
				spawned.identity.processGroupId.length === 0 ||
				spawned.identity.platformGroupKind !== "windows_job_object"
			)
				throw new WorkflowProcessError("workflow_process_identity_unavailable");
			return { pid: spawned.pid, identity: spawned.identity };
		},
		inspect: (
			pid: number,
			processStartId: string,
			processGroupId: string,
			expectedGroupIdentityDigest: string,
		): Promise<WorkflowProcessGroupObservation> =>
			host.inspect(pid, processStartId, processGroupId, expectedGroupIdentityDigest).then((observation) => {
				assertWorkflowProcessContainmentAttestation(observation.containment);
				if (
					!observation.verified ||
					observation.identity.pid !== pid ||
					observation.identity.processStartId !== processStartId ||
					observation.identity.processGroupId !== processGroupId ||
					observation.identity.identityDigest !== expectedGroupIdentityDigest
				)
					return { ...observation, verified: false };
				try {
					assertWorkflowProcessGroupIdentity(observation.identity);
				} catch {
					return { ...observation, verified: false };
				}
				return observation;
			}),
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
