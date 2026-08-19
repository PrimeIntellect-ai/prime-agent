import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

describe("createAgentSession host runtime ownership", () => {
	const createdDirectories: string[] = [];

	afterEach(() => {
		for (const directory of createdDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("forwards the host compaction deadline through the public session factory", async () => {
		const root = join(tmpdir(), `prime-sdk-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		createdDirectories.push(root);
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model is unavailable");

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				model,
				noTools: "all",
				includeGoals: false,
				includeCompactSkill: false,
				compactionDeadlineMs: 0,
			}),
		).rejects.toThrow("compactionDeadlineMs must be a positive finite number");
	});

	it("forwards the host compaction deadline through service-backed session creation", async () => {
		const root = join(tmpdir(), `prime-services-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		createdDirectories.push(root);
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model is unavailable");
		const services = await createAgentSessionServices({ cwd, agentDir, telemetryDisabled: true });

		await expect(
			createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				noTools: "all",
				includeGoals: false,
				includeCompactSkill: false,
				compactionDeadlineMs: 0,
			}),
		).rejects.toThrow("compactionDeadlineMs must be a positive finite number");
	});

	it("forwards the host tool deadline through both public session factories", async () => {
		const root = join(tmpdir(), `prime-tool-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		createdDirectories.push(root);
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model is unavailable");

		await expect(
			createAgentSession({
				cwd,
				agentDir,
				model,
				noTools: "all",
				includeGoals: false,
				includeCompactSkill: false,
				toolExecutionDeadlineMs: 0,
			}),
		).rejects.toThrow("toolExecutionDeadlineMs must be a positive finite number");

		const services = await createAgentSessionServices({ cwd, agentDir, telemetryDisabled: true });
		await expect(
			createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				noTools: "all",
				includeGoals: false,
				includeCompactSkill: false,
				toolExecutionDeadlineMs: 0,
			}),
		).rejects.toThrow("toolExecutionDeadlineMs must be a positive finite number");
	});
});
