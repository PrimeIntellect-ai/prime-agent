/** `/image-model` pins the child model that reads image turns for the session. */

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ImageModelCommandContext = {
	connectionState?: { sessionId: string; imageModel?: string; model?: Model<Api> };
	agentConnection: { setImageModel: (reference: string | null) => Promise<Model<Api> | undefined> };
	settingsManager: { getImageModel: () => string | undefined };
	getCachedModelCandidates: () => Model<Api>[];
	getModelSelectorRefreshPromise: () => Promise<Model<Api>[]> | undefined;
	getCurrentModel: () => Model<Api> | undefined;
	isModelProviderConfigured: (model: Model<Api>) => boolean;
	imageModelChangeQueue: Promise<void>;
	applyImageModelOverride: (reference: string | null) => Promise<void>;
	describeImageModel: () => string;
	resolveImageModelReferenceForCommand: (
		reference: string,
	) => Promise<{ ok: true; model: Model<Api> } | { ok: false; problem: string }>;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

const prototype = InteractiveMode.prototype as unknown as {
	handleImageModelCommand(this: ImageModelCommandContext, arg: string): Promise<void>;
	applyImageModelOverride(this: ImageModelCommandContext, reference: string | null): Promise<void>;
	describeImageModel(this: ImageModelCommandContext): string;
	resolveImageModelReferenceForCommand(
		this: ImageModelCommandContext,
		reference: string,
	): Promise<{ ok: true; model: Model<Api> } | { ok: false; problem: string }>;
};

function model(provider: string, id: string, input: Array<"text" | "image">): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input,
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	} as Model<Api>;
}

const VISION = model("anthropic", "claude-haiku-4-5", ["text", "image"]);
const OTHER_VISION = model("anthropic", "claude-opus-4-7", ["text", "image"]);
const TEXT_ONLY = model("deepseek", "deepseek-v4-pro", ["text"]);
const UNAUTHED = model("openai", "gpt-5.4", ["text", "image"]);

function createContext(options: { sessionModel?: Model<Api>; imageModel?: string; setting?: string } = {}) {
	const context: ImageModelCommandContext = {
		connectionState: {
			sessionId: "session-1",
			imageModel: options.imageModel,
			model: options.sessionModel ?? TEXT_ONLY,
		},
		agentConnection: undefined as never,
		settingsManager: { getImageModel: () => options.setting },
		getCachedModelCandidates: () => [VISION, OTHER_VISION, TEXT_ONLY, UNAUTHED],
		getModelSelectorRefreshPromise: () => undefined,
		getCurrentModel: () => context.connectionState?.model,
		isModelProviderConfigured: (candidate) => candidate.provider !== "openai",
		patchConnectionState: vi.fn((patch: Record<string, unknown>) => {
			context.connectionState = {
				...context.connectionState!,
				...patch,
			} as ImageModelCommandContext["connectionState"];
		}),
		showStatus: vi.fn(),
		showError: vi.fn(),
		imageModelChangeQueue: Promise.resolve(),
		applyImageModelOverride: (reference) => prototype.applyImageModelOverride.call(context, reference),
		describeImageModel: () => prototype.describeImageModel.call(context),
		resolveImageModelReferenceForCommand: (reference) =>
			prototype.resolveImageModelReferenceForCommand.call(context, reference),
	} as ImageModelCommandContext & Record<string, unknown>;
	context.agentConnection = {
		setImageModel: vi.fn(async (reference) =>
			reference === null
				? undefined
				: context
						.getCachedModelCandidates()
						.find((candidate) => `${candidate.provider}/${candidate.id}` === reference),
		),
	};
	return context;
}

describe("/image-model", () => {
	it("reports the session model when nothing is pinned", async () => {
		const context = createContext();
		await prototype.handleImageModelCommand.call(context, "");
		expect(context.showStatus).toHaveBeenCalledWith(
			"Image model: none set, so image turns fail on deepseek/deepseek-v4-pro. Set one with /image-model <model>.",
		);
		expect(context.agentConnection.setImageModel).not.toHaveBeenCalled();
	});

	it("reports the pin, the settings default, and the session model in that order", async () => {
		const pinned = createContext({ imageModel: "anthropic/claude-opus-4-7", setting: "claude-haiku-4-5" });
		await prototype.handleImageModelCommand.call(pinned, "");
		expect(pinned.showStatus).toHaveBeenCalledWith("Image model: anthropic/claude-opus-4-7 (this session)");

		const settings = createContext({ setting: "claude-haiku-4-5" });
		await prototype.handleImageModelCommand.call(settings, "");
		expect(settings.showStatus).toHaveBeenCalledWith("Image model: anthropic/claude-haiku-4-5 (settings.imageModel)");

		const vision = createContext({ sessionModel: OTHER_VISION });
		await prototype.handleImageModelCommand.call(vision, "");
		expect(vision.showStatus).toHaveBeenCalledWith(
			"Image model: same as the session model (anthropic/claude-opus-4-7)",
		);
	});

	it("pins the resolved model and reports it", async () => {
		const context = createContext();
		await prototype.handleImageModelCommand.call(context, "claude-haiku-4-5");
		expect(context.agentConnection.setImageModel).toHaveBeenCalledWith("anthropic/claude-haiku-4-5");
		expect(context.patchConnectionState).toHaveBeenCalledWith({ imageModel: "anthropic/claude-haiku-4-5" });
		expect(context.showStatus).toHaveBeenCalledWith("Image model: anthropic/claude-haiku-4-5 (this session)");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("resolves a reference that only a refreshed catalog knows", async () => {
		const context = createContext();
		context.getCachedModelCandidates = () => [TEXT_ONLY];
		context.getModelSelectorRefreshPromise = () => Promise.resolve([VISION]);
		await prototype.handleImageModelCommand.call(context, "anthropic/claude-haiku-4-5");
		expect(context.agentConnection.setImageModel).toHaveBeenCalledWith("anthropic/claude-haiku-4-5");
	});

	it("clears the pin and reports the settings default", async () => {
		const context = createContext({ imageModel: "anthropic/claude-opus-4-7", setting: "claude-haiku-4-5" });
		await prototype.handleImageModelCommand.call(context, "off");
		expect(context.agentConnection.setImageModel).toHaveBeenCalledWith(null);
		expect(context.patchConnectionState).toHaveBeenCalledWith({ imageModel: undefined });
		expect(context.showStatus).toHaveBeenCalledWith("Image model: anthropic/claude-haiku-4-5 (settings.imageModel)");
	});

	it("does not call the session when nothing is pinned to clear", async () => {
		const context = createContext({ setting: "claude-haiku-4-5" });
		await prototype.handleImageModelCommand.call(context, "default");
		expect(context.agentConnection.setImageModel).not.toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Image model: anthropic/claude-haiku-4-5 (settings.imageModel)");
	});

	// [reference, what the refusal must name]
	it.each([
		["unknown/model", /No model matches/],
		["deepseek-v4-pro", /does not accept image input/],
		["openai/gpt-5.4", /has no configured credentials/],
	] as const)("refuses %s without touching the session", async (reference, refusal) => {
		const context = createContext();
		await prototype.handleImageModelCommand.call(context, reference);
		expect(context.showError).toHaveBeenCalledWith(expect.stringMatching(refusal));
		expect(context.agentConnection.setImageModel).not.toHaveBeenCalled();
		expect(context.patchConnectionState).not.toHaveBeenCalled();
	});
	it("serializes rapid pin changes so the last submission wins", async () => {
		const context = createContext();
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstSettles = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		context.agentConnection.setImageModel = vi.fn(async (reference) => {
			order.push(`start:${reference}`);
			if (order.length === 1) await firstSettles;
			order.push(`end:${reference}`);
			return reference === null ? undefined : VISION;
		});

		const first = prototype.handleImageModelCommand.call(context, "claude-haiku-4-5");
		const second = prototype.handleImageModelCommand.call(context, "claude-opus-4-7");
		releaseFirst();
		await Promise.all([first, second]);
		expect(order).toEqual([
			"start:anthropic/claude-haiku-4-5",
			"end:anthropic/claude-haiku-4-5",
			"start:anthropic/claude-opus-4-7",
			"end:anthropic/claude-opus-4-7",
		]);
		expect(context.connectionState?.imageModel).toBe("anthropic/claude-opus-4-7");
	});

	it("does not apply a resumed pin to a replacement session", async () => {
		const context = createContext();
		const originalConnection = context.agentConnection;
		let releasePin!: () => void;
		const pinSettles = new Promise<void>((resolve) => {
			releasePin = resolve;
		});
		originalConnection.setImageModel = vi.fn(async () => {
			await pinSettles;
			return VISION;
		});

		const applied = prototype.handleImageModelCommand.call(context, "claude-haiku-4-5");
		await Promise.resolve();
		context.connectionState = { sessionId: "session-2", model: TEXT_ONLY };
		context.agentConnection = { setImageModel: vi.fn(async () => undefined) };
		releasePin();
		await applied;

		expect(context.patchConnectionState).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
