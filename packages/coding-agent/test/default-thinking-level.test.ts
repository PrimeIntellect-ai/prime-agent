import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_THINKING_LEVEL,
	defaultThinkingLevelForModel,
	isOpenWeightModel,
	OPEN_WEIGHT_DEFAULT_THINKING_LEVEL,
} from "../src/core/defaults.js";
import { findInitialModel } from "../src/core/model-resolver.js";
import { getPrivatePrimeInferenceModels } from "../src/core/prime-inference-models.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { userMsg } from "./utilities.js";

const glm53 = getModel("prime-inference", "z-ai/glm-5.3");
const claude = getModel("anthropic", "claude-sonnet-4-5");
const internalGlmFast = getPrivatePrimeInferenceModels().find((model) => model.id === "internal/glm-5.2-fast");

describe("open-weight default thinking level", () => {
	it("uses the built-in defaults", () => {
		expect(DEFAULT_THINKING_LEVEL).toBe("medium");
		expect(OPEN_WEIGHT_DEFAULT_THINKING_LEVEL).toBe("max");
	});

	it("recognizes open-weight families across providers and private routes", () => {
		const openWeightIds = [
			"z-ai/glm-5.3",
			"zai/glm-5.1",
			"@cf/zai-org/glm-5.3",
			"accounts/fireworks/models/glm-5p3",
			"internal/glm-5.2-fast",
			"internal/glm-5.3-fast",
			"dev/glm-6-fast",
			"qwen/qwen3-coder",
			"deepseek-v3.2",
			"moonshotai/kimi-k2",
			"minimax/minimax-m2",
			"meta-llama/llama-4-scout",
			"openai/gpt-oss-120b",
		];
		for (const id of openWeightIds) {
			expect(isOpenWeightModel({ id, name: id })).toBe(true);
		}

		const closedIds = [
			"claude-sonnet-4-5",
			"gpt-5.4",
			"gemini-3-pro",
			"grok-4",
			"mistral-large-latest",
			"magistral-medium",
		];
		for (const id of closedIds) {
			expect(isOpenWeightModel({ id, name: id })).toBe(false);
		}
	});

	it("matches by model name when the id carries no family", () => {
		expect(isOpenWeightModel({ id: "k3", name: "Kimi K3" })).toBe(true);
		expect(isOpenWeightModel({ id: "k3", name: "Some Closed Model" })).toBe(false);
	});

	it("gives GLM 5.3 its maximum supported level", () => {
		expect(glm53).toBeTruthy();
		expect(getSupportedThinkingLevels(glm53)).toContain("max");
		expect(defaultThinkingLevelForModel(glm53)).toBe("max");
	});

	it("clamps the internal GLM fast route to its own ceiling", () => {
		expect(internalGlmFast).toBeTruthy();
		if (!internalGlmFast) return;
		expect(getSupportedThinkingLevels(internalGlmFast)).not.toContain("max");
		expect(defaultThinkingLevelForModel(internalGlmFast)).toBe("high");
	});

	it("keeps medium for closed models and for no model", () => {
		expect(claude).toBeTruthy();
		expect(defaultThinkingLevelForModel(claude)).toBe("medium");
		expect(defaultThinkingLevelForModel(undefined)).toBe("medium");
	});
});

describe("findInitialModel default thinking level", () => {
	const registryFor = (models: Model<string>[]) =>
		({
			refreshAvailableModels: async () => models,
		}) as unknown as Parameters<typeof findInitialModel>[0]["modelRegistry"];

	it("returns max for an open-weight preferred default", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registryFor([glm53 as Model<string>]),
		});

		expect(result.model?.id).toBe("z-ai/glm-5.3");
		expect(result.thinkingLevel).toBe("max");
	});

	it("returns medium for a closed preferred default", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			modelRegistry: registryFor([claude as Model<string>]),
		});

		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("medium");
	});

	it("keeps the configured default thinking level", async () => {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultThinkingLevel: "low",
			modelRegistry: registryFor([glm53 as Model<string>]),
		});

		expect(result.thinkingLevel).toBe("low");
	});
});

describe("createAgentSession default thinking level", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-default-thinking-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("starts an open-weight model at its maximum level", async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: glm53,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(session.thinkingLevel).toBe("max");
		session.dispose();
	});

	it("starts a closed model at medium", async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: claude,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(session.thinkingLevel).toBe("medium");
		session.dispose();
	});

	it("keeps an explicit default thinking level setting", async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: glm53,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ defaultThinkingLevel: "low" }),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("keeps a restored session thinking level", async () => {
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage(userMsg("hello"));
		sessionManager.appendThinkingLevelChange("low");

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: glm53,
			sessionManager,
			settingsManager: SettingsManager.inMemory(),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});

	it("keeps an explicit thinking level option", async () => {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: glm53,
			thinkingLevel: "low",
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory(),
		});

		expect(session.thinkingLevel).toBe("low");
		session.dispose();
	});
});
