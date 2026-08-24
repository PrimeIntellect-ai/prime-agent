import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import { canonicalJsonBytes } from "../../src/core/workflow/contracts.js";
import {
	createPersistedSessionWorkflowHost,
	resolvePersistedSessionWorkflowAuthority,
} from "../../src/core/workflow/session-host-factory.js";

const EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;

function goalProjection(): { read(): GoalState; compareAndSwap(expected: GoalState, next: GoalState): boolean } {
	let goal = emptyGoalState();
	return {
		read: () => structuredClone(goal),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(goal) !== JSON.stringify(expected)) return false;
			goal = structuredClone(next);
			return true;
		},
	};
}

it("ignores ad hoc governance side chains and requires the canonical W0 authority", async () => {
	const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-canonical-entrypoint-"));
	const workflowId = "rl-forex-q25-live";
	const rootSessionId = "rl-forex-q25";
	const governanceRoot = join(artifactRoot, "governance", "rl-forex-q25-live-20260817T192736Z");
	const sideRecords = [
		["ledger", { schema: "rl-forex-live-ledger-event-v1", sequence: 1, event: "W0_complete" }],
		["outbox", { schema: "rl-forex-live-ledger-event-v1", sequence: 2, event: "W1_dispatch" }],
		["state", { schema: "rl-forex-live-reconciliation-state-v1", status: "active" }],
	] as const;
	let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	try {
		for (const [directory, record] of sideRecords) {
			const path = join(governanceRoot, directory);
			await mkdir(path, { recursive: true, mode: 0o700 });
			await writeFile(join(path, "record.json"), canonicalJsonBytes(record), { mode: 0o600 });
		}

		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).resolves.toBeNull();
		await expect(
			createPersistedSessionWorkflowHost({
				artifactRoot,
				rootSessionId,
				workflowId,
				goalProjection: goalProjection(),
			}),
		).rejects.toThrow("workflow_genesis_epoch_unavailable");

		const projection = goalProjection();
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: projection,
			genesisEpoch: EPOCH,
		});
		expect(host.status().status).toBe("idle");
		expect(host.primeWorkflow).toBeUndefined();
		await expect(host.ensurePrimeWorkflow()).rejects.toThrow("default_prime_requires_authenticated_workflow_head");

		const w0 = await host.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "establish canonical W0 before dispatch",
				acceptanceChecks: ["canonical-ledger-reconstructs"],
				protectedInvariants: ["side-chains-never-authorize"],
			},
		});
		expect(w0.status).toBe("awaiting_user");
		expect(host.primeWorkflow).toBeUndefined();
		await host.dispose?.();
		host = undefined;

		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).resolves.toEqual({
			genesisEpoch: EPOCH,
			writerIdentity: `workflow-coordinator:${rootSessionId}:${workflowId}`,
		});
		reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			goalProjection: projection,
			genesisEpoch: EPOCH,
		});
		expect(reopened.status()).toMatchObject({
			status: "awaiting_user",
			workflowId,
			acceptanceCheckIds: ["canonical-ledger-reconstructs"],
			protectedInvariantIds: ["side-chains-never-authorize"],
		});
		for (const [directory, record] of sideRecords) {
			expect(await readFile(join(governanceRoot, directory, "record.json"))).toEqual(
				Buffer.from(canonicalJsonBytes(record)),
			);
		}
		await reopened.dispose?.();
		reopened = undefined;

		const activeGeneration = join(artifactRoot, "workflows", workflowId, "side-records", "active-generation.json");
		await rename(activeGeneration, `${activeGeneration}.removed`);
		await expect(
			resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId }),
		).rejects.toThrow("workflow_persisted_authority_corrupt");
	} finally {
		await reopened?.dispose?.();
		await host?.dispose?.();
		await rm(artifactRoot, { recursive: true, force: true });
	}
});
