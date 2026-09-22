import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createAllToolDefinitions } from "../../../src/core/tools/index.js";
import { getCodingAgentFixtureModel } from "../../fixture-models.js";

const legacyBashExtension = (pi: ExtensionAPI) => {
	pi.on("session_start", () => {
		pi.registerTool({
			name: "bash",
			label: "Custom Bash",
			description: "Tool registered from session_start",
			promptSnippet: "Run custom shell behavior",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
	});
};

describe("regression #4428: remove legacy pi-mono built-in tools", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-remove-legacy-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("registers only ipython as a built-in tool and keeps legacy names parseable", () => {
		expect(Object.keys(createAllToolDefinitions(process.cwd()))).toEqual(["ipython"]);
		expect(parseArgs(["--tools", "bash,edit,ipython"])).toMatchObject({
			tools: ["bash", "edit", "ipython"],
			diagnostics: [],
		});
	});

	it.each([
		{ name: "removed built-in names resolve to nothing", tools: ["bash", "edit"], factories: [], expected: [] },
		{
			name: "an extension tool may reuse a legacy built-in name",
			tools: ["bash"],
			factories: [legacyBashExtension],
			expected: ["bash"],
		},
		{ name: "ipython stays built in", tools: ["ipython"], factories: [], expected: ["ipython"] },
	])("$name", async ({ tools, factories, expected }) => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: factories,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getCodingAgentFixtureModel("anthropic", "claude-sonnet-5"),
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			tools,
		});
		await session.bindExtensions({});

		try {
			expect(session.getAllTools().map((tool) => tool.name)).toEqual(expected);
			expect(session.getActiveToolNames()).toEqual(expected);
		} finally {
			session.dispose();
		}
	});
});
