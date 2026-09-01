import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledAgentObserveSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "agent-observe");
	return {
		name: "agent-observe",
		importName: "agent_observe",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("agent-observe skill over the kernel host bridge", { tags: ["kernel-heavy"] }, () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-observe-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists agents and reads bounded recent messages", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentObserveSkill()],
			hostHandlers: {
				"agent_observe.list": async (payload) => {
					requests.push({ type: "agent_observe.list", payload });
					return {
						current: { activeSessionId: "alpha", sessionId: "session-alpha", isCurrent: true },
						agents: [
							{ activeSessionId: "alpha", sessionId: "session-alpha", sessionName: "Orchestrator" },
							{ activeSessionId: "beta", sessionId: "session-beta", sessionName: "Worker" },
						],
					};
				},
				"agent_observe.get": async (payload) => {
					requests.push({ type: "agent_observe.get", payload });
					return { agent: { activeSessionId: payload.target, sessionId: "session-beta", status: "model" } };
				},
				"agent_observe.recent": async (payload) => {
					requests.push({ type: "agent_observe.recent", payload });
					return {
						agent: { activeSessionId: payload.target, sessionId: "session-beta" },
						messages: [{ index: 1, role: "assistant", text: "working", truncated: false }],
						limit: payload.limit,
						maxChars: payload.max_chars,
						truncated: false,
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
agents = await agent_observe.list_agents()
agent = await agent_observe.get_agent("beta")
recent = await agent_observe.recent_messages("beta", limit=3, max_chars=120)
print(json.dumps({"agents": agents, "agent": agent, "recent": recent}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output.agents.agents).toHaveLength(2);
		expect(output.agent.agent).toMatchObject({ activeSessionId: "beta", status: "model" });
		expect(output.recent.messages).toEqual([{ index: 1, role: "assistant", text: "working", truncated: false }]);
		expect(requests.map((request) => request.type)).toEqual([
			"agent_observe.list",
			"agent_observe.get",
			"agent_observe.recent",
		]);
		expect(requests[2].payload).toMatchObject({
			type: "agent_observe.recent",
			target: "beta",
			limit: 3,
			max_chars: 120,
		});
	});

	it("validates argument types before sending to the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentObserveSkill()],
			hostHandlers: {
				"agent_observe.get": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_observe.get_agent(123)
except TypeError as error:
    print(f"TypeError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe("TypeError: target must be str, got int");
	});
});
