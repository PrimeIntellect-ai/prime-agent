/** Image-turn routing: `settings.imageModel` serves image turns on text-only session models. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { EventStream, getModel, type ImageContent } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "aGk=" };
const SET = { imageModel: "claude-haiku-4-5" };
const SET_BLOCKED = { imageModel: "claude-haiku-4-5", images: { blockImages: true } };
const SET_UNUSABLE = { imageModel: "openai/gpt-5.4" };
const SET_TEXTONLY = { imageModel: "deepseek/deepseek-v4-pro" };

// [name, settings, vision session model, attaches images, served model id, rejection]
it.each([
	["routes image turns to imageModel", SET, false, true, "claude-haiku-4-5", undefined],
	["vision session model serves image turns", SET, true, true, "claude-opus-4-7", undefined],
	["session model serves image-free turns", SET, false, false, "claude-opus-4-7-text-only", undefined],
	["session model serves blocked-image turns", SET_BLOCKED, false, true, "claude-opus-4-7-text-only", undefined],
	["refuses image turns without imageModel", {}, false, true, undefined, /does not accept image input/],
	["refuses an unusable imageModel", SET_UNUSABLE, false, true, undefined, /could not be resolved/],
	["refuses a text-only imageModel", SET_TEXTONLY, false, true, undefined, /could not be resolved/],
	["cycling clears the routed override", SET, false, true, "claude-haiku-4-5", undefined, true],
])("%s", async (_name, settings, vision, images, served, reject, cycleAfter?: boolean) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-image-model-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	const base = getModel("anthropic", "claude-opus-4-7")!;
	const sessionModel = (vision ? base : { ...base, id: "claude-opus-4-7-text-only", input: ["text"] }) as typeof base;
	const servedIds: string[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: sessionModel, systemPrompt: "Test", tools: [] },
		streamFn: (model) => {
			servedIds.push(model.id);
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(e) => e.type === "done",
				(e: any) => e.message,
			);
			stream.push({ type: "done", reason: "stop", message: assistantMsg("ok") });
			return stream;
		},
	});
	const auth = AuthStorage.create(join(dir, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	auth.setRuntimeApiKey("deepseek", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(dir, dir),
		cwd: dir,
		modelRegistry: ModelRegistry.create(auth, dir),
		resourceLoader: createTestResourceLoader(),
	});
	try {
		const prompt = session.prompt("describe", images ? { images: [IMAGE] } : undefined);
		if (reject) return await expect(prompt).rejects.toThrow(reject);
		await prompt;
		expect(servedIds).toEqual([served]);
		expect(session.model?.id).toBe(sessionModel.id);
		if (!cycleAfter) return;
		// The routed turn leaves its override behind; cycling must clear it so
		// the selection wins over later continues, retries, and compaction.
		expect(session.agent.modelOverride?.model.id).toBe(served);
		await session.cycleModel("forward", { waitForExtensions: false });
		expect(session.agent.modelOverride).toBeUndefined();
		expect(session.model?.id).not.toBe(sessionModel.id);
	} finally {
		session.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
