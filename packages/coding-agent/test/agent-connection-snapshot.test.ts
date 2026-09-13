import { describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { createAgentConnectionResourceSnapshot } from "../src/modes/agent-connection/snapshot.js";

describe("agent connection snapshots", () => {
	it("adds remote-friendly artifact references to resource snapshots", () => {
		const session = {
			sessionId: "session-1",
			sessionManager: {
				getCwd: () => "/workspace/project",
			},
			resourceLoader: {
				getAgentsFiles: () => ({
					agentsFiles: [{ path: "/workspace/project/AGENTS.md" }],
				}),
				getSkills: () => ({
					skills: [
						{
							name: "commit",
							description: "Commit changes",
							filePath: "/workspace/project/.prime/skills/commit/SKILL.md",
						},
					],
					diagnostics: [],
				}),
				getPrompts: () => ({
					prompts: [],
					diagnostics: [],
				}),
				getThemes: () => ({
					themes: [],
					diagnostics: [],
				}),
				getExtensions: () => ({
					extensions: [{ path: "/opt/prime/extensions/review/index.ts" }],
					errors: [],
				}),
				getHarness: () => ({
					diagnostics: [
						{
							type: "warning",
							message: "package harness entry content must be a nonempty string",
							path: "/opt/prime/harness/memory/invalid.json",
						},
					],
				}),
			},
		} as unknown as AgentSession;

		const snapshot = createAgentConnectionResourceSnapshot(session);

		expect(snapshot.contextFiles[0]).toMatchObject({
			path: "/workspace/project/AGENTS.md",
			artifact: {
				id: expect.stringMatching(/^artifact_[a-f0-9]{16}$/),
				sessionId: "session-1",
				type: "context_file",
				logicalPath: "AGENTS.md",
				relativePath: "AGENTS.md",
			},
		});
		expect(snapshot.skills[0]?.artifact).toMatchObject({
			type: "skill",
			logicalPath: ".prime/skills/commit/SKILL.md",
			relativePath: ".prime/skills/commit/SKILL.md",
		});
		expect(snapshot.extensions[0]).toMatchObject({
			path: "/opt/prime/extensions/review/index.ts",
			artifact: {
				type: "extension",
				logicalPath: "index.ts",
			},
		});
		expect(snapshot.extensions[0]?.artifact).not.toHaveProperty("relativePath");
		expect(snapshot.diagnostics.harness).toEqual([
			{
				type: "warning",
				message: "package harness entry content must be a nonempty string",
				path: "/opt/prime/harness/memory/invalid.json",
			},
		]);
	});
});
