import { expect, it } from "vitest";
import type { WorkflowProcessGroupIdentity } from "../../src/core/workflow/contracts.js";
import { canonicalWorkflowProcessGroupDigest } from "../../src/core/workflow/process-groups.js";
import {
	createWindowsJobObjectPlatform,
	type WorkflowPlatformProcessIdentity,
	type WorkflowProcessGroupObservation,
	type WorkflowWindowsJobObjectHost,
} from "../../src/core/workflow/process-groups-windows.js";

const identity: WorkflowPlatformProcessIdentity = {
	pid: 42,
	processStartId: "win:42",
	processGroupId: "job:1",
	platformGroupKind: "windows_job_object",
	platformInspectionDigest: "platform-job-digest",
};

const group: WorkflowProcessGroupIdentity = {
	pid: identity.pid,
	processStartId: identity.processStartId,
	processGroupId: identity.processGroupId,
	parentPid: 1,
	identityDigest: canonicalWorkflowProcessGroupDigest({
		pid: identity.pid,
		processStartId: identity.processStartId,
		processGroupId: identity.processGroupId,
		parentPid: 1,
	}),
};

it("uses the typed Windows Job Object host and never falls back to a PID", async () => {
	const calls: string[] = [];
	const observation: WorkflowProcessGroupObservation = {
		identity: group,
		verified: true,
		remainingPids: [42],
		evidenceDigest: "evidence",
		containment: {
			membershipVerified: true,
			descendantsContained: true,
			killOnClose: true,
			attestationDigest: "containment",
		},
	};
	const host: WorkflowWindowsJobObjectHost = {
		verifyContainment: async () => observation.containment!,
		spawnAndAssign: async () => {
			calls.push("spawn");
			return { pid: identity.pid, identity };
		},
		inspect: async () => {
			calls.push("inspect");
			return observation;
		},
		terminate: async () => {
			calls.push("terminate");
		},
		reap: async () => {
			calls.push("reap");
			return { remainingPids: [], reapDigest: "reap" };
		},
		scanGroups: async () => {
			calls.push("scan");
			return [group];
		},
		quarantine: async () => {
			calls.push("quarantine");
		},
	};
	const platform = createWindowsJobObjectPlatform({ workflowRoot: process.cwd(), windowsJobObjectHost: host });

	await platform.spawn({
		executable: "node",
		arguments: [],
		cwd: process.cwd(),
		detached: true,
		requireProcessStartId: true,
		shell: false,
		env: { PATH: process.env.PATH ?? "" },
		networkPolicy: { mode: "deny", allowedHosts: [], egressBytes: 0, enforcement: "host_verified" },
	});
	await platform.inspect(42, identity.processStartId, identity.processGroupId, group.identityDigest);
	await platform.signal(group, "SIGTERM");
	await platform.reap(group);
	await platform.scanGroups();
	await platform.quarantineSpawn(group, "test");

	expect(calls).toEqual([
		"spawn",
		"inspect",
		"inspect",
		"terminate",
		"inspect",
		"reap",
		"scan",
		"inspect",
		"quarantine",
	]);
});

it("fails closed when the native Job Object bridge is unavailable", () => {
	expect(() => createWindowsJobObjectPlatform({ workflowRoot: process.cwd() })).toThrow(
		"workflow_platform_unsupported",
	);
});

it("rejects a descriptor without explicit shell, environment, and network policy", async () => {
	const attestation = {
		membershipVerified: true as const,
		descendantsContained: true as const,
		killOnClose: true as const,
		attestationDigest: "containment",
	};
	const host: WorkflowWindowsJobObjectHost = {
		verifyContainment: async () => attestation,
		spawnAndAssign: async () => ({ pid: identity.pid, identity }),
		inspect: async () => ({
			identity: group,
			verified: true,
			remainingPids: [],
			evidenceDigest: "e",
			containment: attestation,
		}),
		terminate: async () => undefined,
		reap: async () => ({ remainingPids: [], reapDigest: "r" }),
		scanGroups: async () => [],
		quarantine: async () => undefined,
	};
	const platform = createWindowsJobObjectPlatform({ workflowRoot: process.cwd(), windowsJobObjectHost: host });
	await expect(
		platform.spawn({
			executable: "node",
			arguments: [],
			cwd: process.cwd(),
			detached: true,
			requireProcessStartId: true,
		} as never),
	).rejects.toThrow("workflow_spawn_descriptor_invalid");
});

it("rejects a fake Job Object host without verifiable containment", async () => {
	const host: WorkflowWindowsJobObjectHost = {
		verifyContainment: async () => ({
			membershipVerified: false as never,
			descendantsContained: true,
			killOnClose: true,
			attestationDigest: "containment",
		}),
		spawnAndAssign: async () => ({ pid: identity.pid, identity }),
		inspect: async () => ({ identity: group, verified: false, remainingPids: [], evidenceDigest: "e" }),
		terminate: async () => undefined,
		reap: async () => ({ remainingPids: [], reapDigest: "r" }),
		scanGroups: async () => [],
		quarantine: async () => undefined,
	};
	const platform = createWindowsJobObjectPlatform({ workflowRoot: process.cwd(), windowsJobObjectHost: host });
	await expect(
		platform.spawn({
			executable: "node",
			arguments: [],
			cwd: process.cwd(),
			detached: true,
			requireProcessStartId: true,
			shell: false,
			env: { PATH: process.env.PATH ?? "" },
			networkPolicy: { mode: "deny", allowedHosts: [], egressBytes: 0, enforcement: "host_verified" },
		}),
	).rejects.toThrow("workflow_process_containment_unavailable");
});
