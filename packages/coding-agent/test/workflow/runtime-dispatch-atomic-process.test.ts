import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";

import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";

function goalProjection(): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	let current = emptyGoalState();
	return {
		read: () => structuredClone(current),
		compareAndSwap: (expected, next) => {
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			current = structuredClone(next);
			return true;
		},
	};
}

function fileGoalProjection(path: string): {
	read(): GoalState;
	compareAndSwap(expected: GoalState, next: GoalState): boolean;
} {
	return {
		read: () => JSON.parse(readFileSync(path, "utf8")) as GoalState,
		compareAndSwap: (expected, next) => {
			const current = JSON.parse(readFileSync(path, "utf8")) as GoalState;
			if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
			writeFileSync(path, JSON.stringify(next));
			return true;
		},
	};
}

async function runChild(
	artifactRoot: string,
	rootSessionId: string,
	workflowId: string,
	writerIdentity: string,
	processIdentity: string,
): Promise<void> {
	const factoryModule = pathToFileURL(`${process.cwd()}/src/core/workflow/session-host-factory.ts`).href;
	const childSource = `
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
const artifactRoot = process.argv[1];
const rootSessionId = process.argv[2];
const workflowId = process.argv[3];
const writerIdentity = process.argv[4];
const processIdentity = process.argv[5];
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId,
  workflowId,
  writerIdentity,
  processIdentity,
  goalProjection: {
    read: () => ({ version: 1, objective: null, acceptanceChecks: [], protectedInvariants: [], status: "empty", digest: "" }),
    compareAndSwap: () => true,
  },
});
const durable = host.runtimeStore.durableContext;
if (durable === undefined) throw new Error("durable dispatch gate unavailable");
await durable.withExclusiveLease("dispatch-capacity-intent", async () => {
  const bytes = await durable.auxiliaryStore.read("dispatch-counter.json");
  const count = bytes === null ? 0 : Number(new TextDecoder().decode(bytes));
  await new Promise((resolve) => setTimeout(resolve, 25));
  await durable.auxiliaryStore.write("dispatch-counter.json", new TextEncoder().encode(String(count + 1)));
});
console.log("committed");
`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx/esm",
				"--input-type=module",
				"-e",
				childSource,
				artifactRoot,
				rootSessionId,
				workflowId,
				writerIdentity,
				processIdentity,
			],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`dispatch child exited ${code}: ${stderr}`));
				return;
			}
			if (stdout.trim() !== "committed") {
				reject(new Error(`dispatch child produced unexpected output: ${stdout} ${stderr}`));
				return;
			}
			resolve();
		});
	});
}

it("serializes competing real stores and preserves the dispatch gate across reopen", async () => {
	const artifactRoot = await mkdtemp(`${tmpdir()}/workflow-dispatch-atomic-process-`);
	const rootSessionId = "dispatch-atomic-process-session";
	const workflowId = "dispatch-atomic-process-workflow";
	const writerIdentity = "dispatch-atomic-process-writer";
	let host: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	try {
		host = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			goalProjection: goalProjection(),
			genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		});
		const durable = host.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("durable dispatch gate unavailable");
		const processIdentity = durable.currentLeaseRef().processIdentity;

		await Promise.all([
			runChild(artifactRoot, rootSessionId, workflowId, writerIdentity, processIdentity),
			runChild(artifactRoot, rootSessionId, workflowId, writerIdentity, processIdentity),
		]);

		await expect(durable.auxiliaryStore.read("dispatch-counter.json")).resolves.toEqual(
			new TextEncoder().encode("2"),
		);
		await host.dispose?.();
		host = undefined;
		reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			goalProjection: goalProjection(),
			genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
		});
		const reopenedDurable = reopened.runtimeStore.durableContext;
		if (reopenedDurable === undefined) throw new Error("durable dispatch gate unavailable after reopen");
		await expect(reopenedDurable.auxiliaryStore.read("dispatch-counter.json")).resolves.toEqual(
			new TextEncoder().encode("2"),
		);
	} finally {
		await reopened?.dispose?.().catch(() => undefined);
		await host?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
});

it("reconstructs the authenticated workflow epoch after a live host is SIGKILLed", async () => {
	if (process.platform === "win32") return;
	const artifactRoot = await mkdtemp(`${tmpdir()}/workflow-epoch-recovery-process-`);
	const rootSessionId = "workflow-epoch-recovery-session";
	const workflowId = "workflow-epoch-recovery-workflow";
	const factoryModule = pathToFileURL(`${process.cwd()}/src/core/workflow/session-host-factory.ts`).href;
	const childSource = `
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(factoryModule)};
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const goalPath = process.argv[1] + "/epoch-recovery-goal.json";
if (!existsSync(goalPath)) writeFileSync(goalPath, JSON.stringify({ active: false, status: "idle", tokensUsed: 0, timeUsedSeconds: 0, continuationsUsed: 0 }));
const host = await createPersistedSessionWorkflowHost({
  artifactRoot: process.argv[1],
  rootSessionId: process.argv[2],
  workflowId: process.argv[3],
  writerIdentity: "epoch-recovery-child-writer",
  genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
  goalProjection: {
    read: () => JSON.parse(readFileSync(goalPath, "utf8")),
    compareAndSwap: (expected, next) => {
      const current = JSON.parse(readFileSync(goalPath, "utf8"));
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      writeFileSync(goalPath, JSON.stringify(next));
      return true;
    },
  },
});
await host.execute({
  kind: "start",
  request: {
    workflowId: process.argv[3],
    objective: "recover the authenticated workflow epoch",
    acceptanceChecks: ["epoch-recovery"],
    protectedInvariants: ["epoch-fence"],
  },
});
console.log("ready");
setInterval(() => {}, 1000);
`;
	let child: ReturnType<typeof spawn> | undefined;
	let reopened: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	try {
		child = spawn(
			process.execPath,
			["--import", "tsx/esm", "--input-type=module", "-e", childSource, artifactRoot, rootSessionId, workflowId],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		await new Promise<void>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(
				() => reject(new Error(`epoch recovery child did not become ready: ${stderr}`)),
				30_000,
			);
			child?.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				if (stdout.includes("ready")) {
					clearTimeout(timer);
					resolve();
				}
			});
			child?.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
			child?.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child?.once("exit", (code, signal) => {
				if (code !== null || signal !== null) {
					clearTimeout(timer);
					reject(new Error(`epoch recovery child exited before ready: ${code ?? signal}: ${stderr}`));
				}
			});
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child?.once("exit", () => resolve()));
		reopened = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
			goalProjection: fileGoalProjection(join(artifactRoot, "epoch-recovery-goal.json")),
		});
		expect(reopened.runtimeStore.durableContext?.epochRef).toEqual({ storeEpoch: 1, coordinatorEpoch: 2 });
		await expect(reopened.execute({ kind: "status" })).resolves.toMatchObject({
			workflowId,
			status: "awaiting_user",
		});
	} finally {
		if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await reopened?.dispose?.().catch(() => undefined);
		await rm(artifactRoot, { recursive: true, force: true });
	}
});
