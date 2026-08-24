import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type EffortCommandContext = {
	connectionState?: {
		thinkingLevel: ThinkingLevel;
		availableThinkingLevels: ThinkingLevel[];
	};
	agentConnection: { setThinkingLevel: (level: ThinkingLevel) => Promise<void> };
	footer: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	updateEditorBorderColor: () => void;
	getAvailableThinkingLevels: () => ThinkingLevel[];
	applyThinkingLevel: (level: ThinkingLevel) => void;
	showThinkingSelector: (levels?: ThinkingLevel[]) => void;
	showSelector: (create: (done: () => void) => { component: Component; focus: Component }) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	getAvailableThinkingLevels(this: EffortCommandContext): ThinkingLevel[];
	getThinkingLevelCompletions(this: EffortCommandContext, prefix: string): AutocompleteItem[] | null;
	handleEffortCommand(this: EffortCommandContext, arg: string): void;
	showThinkingSelector(this: EffortCommandContext, levels?: ThinkingLevel[]): void;
	applyThinkingLevel(this: EffortCommandContext, level: ThinkingLevel): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

type FastCommandContext = {
	connectionState?: { sessionId: string; serviceTier: ServiceTier; thinkingLevel: ThinkingLevel };
	fastModeToggleQueue: Promise<void>;
	agentConnection: {
		setServiceTier: (serviceTier: ServiceTier) => Promise<void>;
		getState: () => Promise<{ sessionId: string; serviceTier: ServiceTier }>;
	};
	footer: { invalidate: () => void };
	subagentSummaryLine: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	getCurrentModel: () => Model<Api> | undefined;
	currentModelSupportsFastMode: () => boolean;
};

type FastInteractiveModePrototype = {
	currentModelSupportsFastMode(this: FastCommandContext): boolean;
	handleFastCommand(this: FastCommandContext): void;
	getModelTrayLabel(this: FastCommandContext): string;
};

const fastInteractiveModePrototype = InteractiveMode.prototype as unknown as FastInteractiveModePrototype;

function testModel(provider: string, id: string, api: Api): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function makeFastContext(model: Model<Api> = testModel("openai-codex", "gpt-5.5", "openai-codex-responses")) {
	const context: FastCommandContext = {
		connectionState: { sessionId: "session-1", serviceTier: "default", thinkingLevel: "high" },
		fastModeToggleQueue: Promise.resolve(),
		agentConnection: undefined as never,
		footer: { invalidate: vi.fn() },
		subagentSummaryLine: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn((patch: Record<string, unknown>) => {
			context.connectionState = { ...context.connectionState, ...patch } as FastCommandContext["connectionState"];
		}),
		getCurrentModel: () => model,
		currentModelSupportsFastMode: () => fastInteractiveModePrototype.currentModelSupportsFastMode.call(context),
	};
	context.agentConnection = {
		setServiceTier: vi.fn(async (serviceTier) => {
			context.connectionState = { ...context.connectionState!, serviceTier };
		}),
		getState: vi.fn(async () => ({
			sessionId: context.connectionState!.sessionId,
			serviceTier: context.connectionState!.serviceTier,
		})),
	};
	return context;
}

function makeContext(overrides: Partial<EffortCommandContext> = {}): EffortCommandContext {
	const context: EffortCommandContext = {
		connectionState: {
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		},
		agentConnection: { setThinkingLevel: vi.fn(async () => {}) },
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		getAvailableThinkingLevels: () => interactiveModePrototype.getAvailableThinkingLevels.call(context),
		applyThinkingLevel: (level) => interactiveModePrototype.applyThinkingLevel.call(context, level),
		showThinkingSelector: (levels) => interactiveModePrototype.showThinkingSelector.call(context, levels),
		showSelector: vi.fn(),
		ui: { requestRender: vi.fn() },
		...overrides,
	};
	return context;
}

describe("InteractiveMode /effort", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("argument autocomplete", () => {
		it("lists every supported level for an empty prefix and marks the current one", () => {
			const context = makeContext();

			const items = interactiveModePrototype.getThinkingLevelCompletions.call(context, "");

			expect(items?.map((item) => item.value)).toEqual(["off", "low", "medium", "high"]);
			expect(items?.find((item) => item.value === "medium")?.description).toContain("(current)");
		});

		it("filters by the typed prefix", () => {
			const context = makeContext();

			const items = interactiveModePrototype.getThinkingLevelCompletions.call(context, "h");

			expect(items?.map((item) => item.value)).toEqual(["high"]);
		});

		it("offers no completions when the model does not support thinking", () => {
			const context = makeContext({
				connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
			});

			expect(interactiveModePrototype.getThinkingLevelCompletions.call(context, "")).toBeNull();
		});
	});

	describe("command handling", () => {
		it("applies a valid level through the connection and reports it", async () => {
			const setThinkingLevel = vi.fn(async () => {});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "high");
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high"));

			expect(setThinkingLevel).toHaveBeenCalledWith("high");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ thinkingLevel: "high" });
			expect(context.footer.invalidate).toHaveBeenCalledWith();
			expect(context.updateEditorBorderColor).toHaveBeenCalledWith();
			expect(context.showError).not.toHaveBeenCalled();
		});

		it("rejects an unknown level without touching the connection", () => {
			const setThinkingLevel = vi.fn(async () => {});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "bogus");

			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(context.showError).toHaveBeenCalledWith(
				"Unknown thinking level 'bogus'. Available: off, low, medium, high",
			);
		});

		it("opens the thinking-level selector when called without an argument", () => {
			let selector: ThinkingSelectorComponent | undefined;
			const done = vi.fn();
			const context = makeContext({
				showSelector: (create) => {
					selector = create(done).component as ThinkingSelectorComponent;
				},
			});

			interactiveModePrototype.handleEffortCommand.call(context, "");

			expect(context.agentConnection.setThinkingLevel).not.toHaveBeenCalled();
			expect(selector).toBeInstanceOf(ThinkingSelectorComponent);
			expect(selector?.getSelectList().getSelectedItem()?.value).toBe("medium");

			selector?.getSelectList().setSelectedIndex(3);
			selector?.getSelectList().onSelect?.(selector.getSelectList().getSelectedItem()!);

			expect(done).toHaveBeenCalledOnce();
			expect(context.agentConnection.setThinkingLevel).toHaveBeenCalledWith("high");
		});

		it("reports when the model does not support thinking", () => {
			const context = makeContext({
				connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
			});

			interactiveModePrototype.handleEffortCommand.call(context, "high");

			expect(context.agentConnection.setThinkingLevel).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
		});

		it("surfaces an error when applying a level fails", async () => {
			const setThinkingLevel = vi.fn(async () => {
				throw new Error("nope");
			});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "high");
			await vi.waitFor(() => expect(context.showError).toHaveBeenCalledWith("nope"));

			expect(context.patchConnectionState).not.toHaveBeenCalled();
		});
	});

	describe("model switch refresh", () => {
		it("refreshes model-dependent state from the connection", async () => {
			type ModelState = {
				sessionId: string;
				model: unknown;
				serviceTier: ServiceTier;
				availableThinkingLevels: ThinkingLevel[];
			};
			type ModelContext = {
				connectionState: { sessionId: string };
				agentConnection: {
					setModel: (provider: string, id: string) => Promise<void>;
					getState: () => Promise<ModelState>;
				};
				settingsManager: { setDefaultModelAndProvider: (provider: string, id: string) => void };
				patchConnectionState: (patch: Record<string, unknown>) => void;
				footer: { invalidate: () => void };
				subagentSummaryLine: { invalidate: () => void };
				updateEditorBorderColor: () => void;
				setupAutocompleteProvider: () => void;
			};
			const applySelectedModel = (
				InteractiveMode.prototype as unknown as {
					applySelectedModel(this: ModelContext, model: unknown): Promise<void>;
				}
			).applySelectedModel;
			const patchConnectionState = vi.fn();
			const setupAutocompleteProvider = vi.fn();
			const model = { provider: "openai-codex", id: "gpt-5.5", reasoning: true };
			const context: ModelContext = {
				connectionState: { sessionId: "session-1" },
				agentConnection: {
					setModel: vi.fn(async () => {}),
					getState: vi.fn(
						async (): Promise<ModelState> => ({
							sessionId: "session-1",
							model,
							serviceTier: "priority",
							availableThinkingLevels: ["off", "low", "medium", "high"],
						}),
					),
				},
				settingsManager: { setDefaultModelAndProvider: vi.fn() },
				patchConnectionState,
				footer: { invalidate: vi.fn() },
				subagentSummaryLine: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				setupAutocompleteProvider,
			};

			await applySelectedModel.call(context, model);

			const patch = patchConnectionState.mock.calls[0][0];
			expect(patch.model).toBe(model);
			expect(patch.serviceTier).toBe("priority");
			expect(patch.availableThinkingLevels).toContain("high");
			expect(patch.availableThinkingLevels.length).toBeGreaterThan(1);
			expect(setupAutocompleteProvider).toHaveBeenCalledTimes(1);
		});
	});

	describe("Fast mode", () => {
		it("enables Fast mode and refreshes the model tray", async () => {
			const context = makeFastContext();

			fastInteractiveModePrototype.handleFastCommand.call(context);
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Fast mode: on"));

			expect(context.agentConnection.setServiceTier).toHaveBeenCalledWith("priority");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ serviceTier: "priority" });
			expect(context.footer.invalidate).toHaveBeenCalledWith();
			expect(context.subagentSummaryLine.invalidate).toHaveBeenCalledWith();
		});

		it("disables Fast mode when it is already enabled", async () => {
			const context = makeFastContext();
			context.connectionState = { sessionId: "session-1", serviceTier: "priority", thinkingLevel: "high" };

			fastInteractiveModePrototype.handleFastCommand.call(context);
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Fast mode: off"));

			expect(context.agentConnection.setServiceTier).toHaveBeenCalledWith("default");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ serviceTier: "default" });
		});

		it("serializes rapid toggles", async () => {
			const context = makeFastContext();

			fastInteractiveModePrototype.handleFastCommand.call(context);
			fastInteractiveModePrototype.handleFastCommand.call(context);

			await vi.waitFor(() => expect(context.agentConnection.setServiceTier).toHaveBeenCalledTimes(2));
			expect(context.agentConnection.setServiceTier).toHaveBeenNthCalledWith(1, "priority");
			expect(context.agentConnection.setServiceTier).toHaveBeenNthCalledWith(2, "default");
		});

		it("uses the effective service tier returned by the connection", async () => {
			const context = makeFastContext();
			context.agentConnection.getState = vi.fn(
				async (): Promise<{ sessionId: string; serviceTier: ServiceTier }> => ({
					sessionId: "session-1",
					serviceTier: "default",
				}),
			);

			fastInteractiveModePrototype.handleFastCommand.call(context);
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Fast mode: off"));

			expect(context.agentConnection.setServiceTier).toHaveBeenCalledWith("priority");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ serviceTier: "default" });
		});

		it("drops a queued toggle after switching sessions", async () => {
			let releaseQueue!: () => void;
			const context = makeFastContext();
			const originalConnection = context.agentConnection;
			context.fastModeToggleQueue = new Promise<void>((resolve) => {
				releaseQueue = resolve;
			});

			fastInteractiveModePrototype.handleFastCommand.call(context);
			context.agentConnection = {
				setServiceTier: vi.fn(async () => {}),
				getState: vi.fn(
					async (): Promise<{ sessionId: string; serviceTier: ServiceTier }> => ({
						sessionId: "session-2",
						serviceTier: "default",
					}),
				),
			};
			context.connectionState = { sessionId: "session-2", serviceTier: "default", thinkingLevel: "high" };
			releaseQueue();
			await context.fastModeToggleQueue;

			expect(originalConnection.setServiceTier).not.toHaveBeenCalled();
			expect(context.agentConnection.setServiceTier).not.toHaveBeenCalled();
		});

		it("does not apply an in-flight toggle result to a replacement session", async () => {
			let finishToggle!: () => void;
			const context = makeFastContext();
			const originalConnection = context.agentConnection;
			originalConnection.setServiceTier = vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishToggle = resolve;
					}),
			);

			fastInteractiveModePrototype.handleFastCommand.call(context);
			await vi.waitFor(() => expect(originalConnection.setServiceTier).toHaveBeenCalledWith("priority"));

			context.agentConnection = {
				setServiceTier: vi.fn(async () => {}),
				getState: vi.fn(
					async (): Promise<{ sessionId: string; serviceTier: ServiceTier }> => ({
						sessionId: "session-2",
						serviceTier: "default",
					}),
				),
			};
			context.connectionState = { sessionId: "session-2", serviceTier: "default", thinkingLevel: "high" };
			finishToggle();
			await context.fastModeToggleQueue;

			expect(context.patchConnectionState).not.toHaveBeenCalled();
			expect(context.showStatus).not.toHaveBeenCalled();
		});

		it("reports unsupported models without changing the service tier", () => {
			const context = makeFastContext(testModel("anthropic", "claude-opus", "anthropic-messages"));

			fastInteractiveModePrototype.handleFastCommand.call(context);

			expect(context.agentConnection.setServiceTier).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith(
				"Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication",
			);
		});

		it("shows Fast mode beside the model and effort level", () => {
			const context = makeFastContext();
			context.connectionState = { sessionId: "session-1", serviceTier: "priority", thinkingLevel: "high" };

			expect(fastInteractiveModePrototype.getModelTrayLabel.call(context)).toBe("gpt-5.5 • high • fast");
		});
	});
});
