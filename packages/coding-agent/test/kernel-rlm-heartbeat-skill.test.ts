import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { type HostRequestHandlers, installHostRequestCapabilityResolver } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledRlmHeartbeatSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "rlm-heartbeat");
	return {
		name: "rlm-heartbeat",
		importName: "rlm_heartbeat",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

function authorizedHostHandlers(handlers: HostRequestHandlers): HostRequestHandlers {
	let nonce = 0;
	return installHostRequestCapabilityResolver(handlers, (requestType) => ({
		workflowId: "workflow-1",
		decisionId: "decision-1",
		decisionRevision: 1,
		capabilities: [requestType],
		expiresAt: Date.now() + 60_000,
		nonce: `nonce-${++nonce}`,
	}));
}

describe("RLM heartbeat skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-heartbeat-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("round-trips create, list, update, and delete through a live kernel", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledRlmHeartbeatSkill()],
			hostHandlers: authorizedHostHandlers({
				"rlm_heartbeat.create": async (payload) => {
					requests.push({ type: "rlm_heartbeat.create", payload });
					return {
						heartbeat: {
							id: "job-1",
							status: "active",
							label: payload.label ?? null,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: payload.interval ?? "every 5m" },
							next_run_at: "2026-01-01T12:39:00.000Z",
							run_count: 0,
						},
					};
				},
				"rlm_heartbeat.list": async (payload) => {
					requests.push({ type: "rlm_heartbeat.list", payload });
					return {
						heartbeats: [
							{
								id: "job-1",
								status: "active",
								label: "tests",
								instruction: "check tests",
							},
						],
					};
				},
				"rlm_heartbeat.update": async (payload) => {
					requests.push({ type: "rlm_heartbeat.update", payload });
					return {
						heartbeat: {
							id: payload.id,
							status: "paused",
							label: "tests",
							instruction: "check tests",
						},
					};
				},
				"rlm_heartbeat.delete": async (payload) => {
					requests.push({ type: "rlm_heartbeat.delete", payload });
					return {
						heartbeat: {
							id: payload.id,
							status: "cancelled",
							label: "tests",
							instruction: "check tests",
						},
					};
				},
			}),
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
created = await rlm_heartbeat.create("check tests", interval="5m", label="tests", delivery_mode="follow_up")
listed = await rlm_heartbeat.list(include_inactive=True)
updated = await rlm_heartbeat.update(created["heartbeat"]["id"], status="pause")
deleted = await rlm_heartbeat.delete(created["heartbeat"]["id"])
print(json.dumps({
    "created": created["heartbeat"],
    "listed": listed["heartbeats"],
    "updated": updated["heartbeat"],
    "deleted": deleted["heartbeat"],
}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		expect(JSON.parse(result.stdout.trim())).toMatchObject({
			created: { id: "job-1", status: "active", label: "tests", instruction: "check tests" },
			listed: [{ id: "job-1", status: "active", label: "tests", instruction: "check tests" }],
			updated: { id: "job-1", status: "paused" },
			deleted: { id: "job-1", status: "cancelled" },
		});
		expect(requests.map((request) => request.type)).toEqual([
			"rlm_heartbeat.create",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
		]);
		expect(requests[0].payload).toMatchObject({
			type: "rlm_heartbeat.create",
			instruction: "check tests",
			interval: "5m",
			label: "tests",
			delivery_mode: "follow_up",
		});
		expect(requests[1].payload).toMatchObject({ type: "rlm_heartbeat.list", include_inactive: true });
		expect(requests[2].payload).toMatchObject({ type: "rlm_heartbeat.update", id: "job-1", status: "pause" });
		expect(requests[3].payload).toMatchObject({ type: "rlm_heartbeat.delete", id: "job-1" });
	});

	it("surfaces missing host handlers as Python exceptions", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledRlmHeartbeatSkill()],
			hostHandlers: {},
		});

		const manager = await provisioner.ensure();
		const unavailable = await manager.execute(`
try:
    await rlm_heartbeat.list()
except RuntimeError as error:
    print(f"RuntimeError: {error}")
`);
		expect(unavailable.status).toBe("ok");
		expect(unavailable.stdout.trim()).toBe(
			'RuntimeError: host request type "rlm_heartbeat.list" is not available in this session',
		);
	});

	it("rejects non-string delivery modes before calling the host", async () => {
		let hostRequestCount = 0;
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledRlmHeartbeatSkill()],
			hostHandlers: {
				"rlm_heartbeat.create": async () => {
					hostRequestCount++;
					return {};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
for value in ([], {}):
    try:
        await rlm_heartbeat.create("check tests", delivery_mode=value)
    except TypeError as error:
        print(f"TypeError: {error}")
`);

		expect(result.status).toBe("ok");
		expect(result.stdout.trim().split("\n")).toEqual([
			"TypeError: delivery_mode must be str or None, got list",
			"TypeError: delivery_mode must be str or None, got dict",
		]);
		expect(hostRequestCount).toBe(0);
	});
});
