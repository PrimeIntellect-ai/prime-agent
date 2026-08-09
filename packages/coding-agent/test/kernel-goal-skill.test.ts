import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`condition did not become true within ${timeoutMs}ms`);
		await sleep(1);
	}
}

function bundledGoalSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "goal");
	return {
		name: "goal",
		importName: "goal",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("goal skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-goal-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips goal.create and goal.complete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.create": async (payload) => {
					requests.push({ type: "goal.create", payload });
					return {
						goal: { objective: payload.objective, status: "active", tokens_used: 0 },
						remaining_tokens: payload.token_budget ?? null,
						completion_budget_report: null,
					};
				},
				"goal.complete": async (payload) => {
					requests.push({ type: "goal.complete", payload });
					return {
						goal: { objective: "ship it", status: "complete", tokens_used: 7 },
						remaining_tokens: 3,
						completion_budget_report:
							"Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const created = await manager.execute(`
import json
_created = await goal.create("ship it", token_budget=10)
print(json.dumps(_created, sort_keys=True))
`);
		expect(created.status).toBe("ok");
		expect(JSON.parse(created.stdout.trim())).toEqual({
			goal: { objective: "ship it", status: "active", tokens_used: 0 },
			remaining_tokens: 10,
			completion_budget_report: null,
		});

		const completed = await manager.execute(`
_completed = await goal.complete()
print(_completed["goal"]["status"], _completed["completion_budget_report"])
`);
		expect(completed.status).toBe("ok");
		expect(completed.stdout.trim()).toBe(
			"complete Goal achieved. Report final budget usage to the user: tokens used: 7 of 10.",
		);

		expect(requests.map((request) => request.type)).toEqual(["goal.create", "goal.complete"]);
		expect(requests[0].payload).toMatchObject({ type: "goal.create", objective: "ship it", token_budget: 10 });
	});

	it("bounds a stalled goal request and keeps the live kernel reusable", async () => {
		let handlerStarted = false;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: { PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS: "250" },
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.complete": async () => {
					handlerStarted = true;
					return new Promise<Record<string, unknown>>(() => {});
				},
			},
		});

		const manager = await provisioner.ensure();
		const startedAt = Date.now();
		const timedOut = await manager.execute(`
_preserved_after_timeout = 42
try:
    await goal.complete()
except TimeoutError as error:
    print(f"TimeoutError: {error}")
`);
		expect(handlerStarted).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(timedOut.status).toBe("ok");
		expect(timedOut.stdout).toContain('TimeoutError: host request "goal.complete" timed out after 250ms');

		const followUp = await manager.execute("print(_preserved_after_timeout)");
		expect(followUp.status).toBe("ok");
		expect(followUp.stdout.trim()).toBe("42");
	});

	it("does not abort a detached request started by the active cell", async () => {
		let handlerStarted = false;
		let handlerSignal: AbortSignal | undefined;
		let release: () => void = () => {};
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: { PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS: "1000" },
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.complete": async (_payload, context) => {
					handlerStarted = true;
					handlerSignal = context?.signal;
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const controller = new AbortController();
		try {
			const scheduled = await manager.execute(
				`background_completion = asyncio.create_task(goal.complete())
await asyncio.sleep(0.05)
print("scheduled")`,
				{ signal: controller.signal },
			);
			expect(scheduled.status).toBe("ok");
			expect(scheduled.stdout.trim()).toBe("scheduled");
			expect(handlerStarted).toBe(true);

			controller.abort();
			await sleep(20);
			expect(handlerSignal?.aborted).toBe(false);
		} finally {
			release();
		}

		const followUp = await manager.execute("print('detached healthy')");
		expect(followUp.status).toBe("ok");
		expect(followUp.stdout.trim()).toBe("detached healthy");
	});

	it("aborts the matching host request and frees the live kernel", async () => {
		let handlerStarted = false;
		let handlerSignal: AbortSignal | undefined;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			env: { PRIME_AGENT_HOST_REQUEST_TIMEOUT_MS: "1000" },
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.complete": async (_payload, context) => {
					handlerStarted = true;
					handlerSignal = context?.signal;
					return new Promise<Record<string, unknown>>(() => {});
				},
			},
		});

		const manager = await provisioner.ensure();
		const controller = new AbortController();
		const execution = manager.execute("await goal.complete()", { signal: controller.signal });
		execution.catch(() => undefined);
		await waitFor(() => handlerStarted);
		controller.abort();
		await waitFor(() => handlerSignal?.aborted === true, 300);

		const aborted = await execution;
		expect(aborted.status).toBe("aborted");
		const followUp = await manager.execute("print('still healthy')");
		expect(followUp.status).toBe("ok");
		expect(followUp.stdout.trim()).toBe("still healthy");
	});

	it("surfaces host errors and missing handlers as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.complete": async () => {
					throw new Error("cannot complete goal because this thread has no goal");
				},
			},
		});

		const manager = await provisioner.ensure();
		const completeError = await manager.execute(`
try:
    await goal.complete()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(completeError.status).toBe("ok");
		expect(completeError.stdout.trim()).toBe("RuntimeError: cannot complete goal because this thread has no goal");

		const unavailable = await manager.execute(`
try:
    await goal.get()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(unavailable.status).toBe("ok");
		expect(unavailable.stdout.trim()).toBe(
			'RuntimeError: host request type "goal.get" is not available in this session',
		);

		// A "type" key smuggled into the payload must not reroute the request.
		const reroute = await manager.execute(`
import rlm as _rlm
try:
    await _rlm.host_request("goal.get", {"type": "goal.complete"})
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(reroute.status).toBe("ok");
		expect(reroute.stdout.trim()).toBe('RuntimeError: host request type "goal.get" is not available in this session');
	});

	it("rejects replies with an unexpected status instead of hanging", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledGoalSkill()],
			hostHandlers: {
				"goal.get": async () => ({ status: "partial" }),
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await goal.get()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("RuntimeError: host request goal.get returned unexpected status: 'partial'");
	});
});
