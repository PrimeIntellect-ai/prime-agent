import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixturePath = resolve(__dirname, "../fixtures/workflow-brainstorm-process.ts");
const tsxPath = resolve(__dirname, "../../../../node_modules/tsx/dist/cli.mjs");
const tempDirs: string[] = [];
const children = new Set<ChildProcess>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function spawnPhase(mode: "draft" | "propose", rootDir: string): ChildProcess {
	const child = spawn(process.execPath, [tsxPath, fixturePath, mode, rootDir], {
		env: { ...process.env, TSX_TSCONFIG_PATH: resolve(__dirname, "../../../../tsconfig.json") },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	return child;
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null) {
		expect(child.exitCode).toBe(0);
		return;
	}
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	await new Promise<void>((resolveExit, reject) => {
		const deadline = setTimeout(() => reject(new Error("Timed out waiting for workflow brainstorm fixture")), 90_000);
		child.once("exit", (code, signal) => {
			clearTimeout(deadline);
			if (code === 0 && signal === null) resolveExit();
			else reject(new Error(`Workflow brainstorm fixture failed: code=${code} signal=${signal}\n${stderr}`));
		});
	});
}

function readResult(rootDir: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(rootDir, "result.json"), "utf8")) as Record<string, unknown>;
}

describe("workflow brainstorming process boundary", () => {
	it("reconstructs a bare draft and seals one approval-bound proposal after restart", async () => {
		const rootDir = mkdtempSync(join(tmpdir(), "workflow-brainstorm-process-"));
		tempDirs.push(rootDir);
		const draft = spawnPhase("draft", rootDir);
		await waitForExit(draft);
		expect(readResult(rootDir)).toMatchObject({
			mode: "draft",
			// Brainstorming holds a read-only IPython alongside the propose tool so it can inspect the
			// workspace before asking the user anything. It was propose-only when this was written, and a
			// planner that cannot read the repo asks questions the repo already answers.
			activeTools: ["workflow_propose", "ipython"],
			workflowStatus: "idle",
			approvalCredentialPresent: false,
		});

		const propose = spawnPhase("propose", rootDir);
		await waitForExit(propose);
		expect(readResult(rootDir)).toMatchObject({
			mode: "propose",
			activeTools: [],
			status: expect.stringContaining("awaiting_user"),
			approvalRequestId: expect.any(String),
			approvalOptions: expect.arrayContaining(["approve", "approve_cloud"]),
			goalSourceCount: 1,
		});
	}, 120_000);
});
