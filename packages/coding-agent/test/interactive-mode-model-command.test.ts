import { describe, expect, it, vi } from "vitest";
import type { AgentConnectionModel } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ModelSelectionContext = {
	agentConnection: {
		setModel: (provider: string, modelId: string) => Promise<void>;
		getState: () => Promise<{
			sessionId: string;
			model: AgentConnectionModel;
			serviceTier: "default";
			availableThinkingLevels: [];
		}>;
	};
	connectionState: { sessionId: string };
	settingsManager: { setDefaultModelAndProvider: (provider: string, modelId: string) => void };
	patchConnectionState: (patch: Record<string, unknown>) => void;
	footer: { invalidate: () => void };
	subagentSummaryLine: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	setupAutocompleteProvider: () => void;
};

type InteractiveModePrototype = {
	applySelectedModel(
		this: ModelSelectionContext,
		model: AgentConnectionModel,
		persistDefault?: boolean,
	): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;
const model = { provider: "openai", id: "gpt-test" } as AgentConnectionModel;

function makeContext(): ModelSelectionContext {
	return {
		agentConnection: {
			setModel: vi.fn(async () => {}),
			getState: vi.fn(async () => ({
				sessionId: "session-1",
				model,
				serviceTier: "default" as const,
				availableThinkingLevels: [] as [],
			})),
		},
		connectionState: { sessionId: "session-1" },
		settingsManager: { setDefaultModelAndProvider: vi.fn() },
		patchConnectionState: vi.fn(),
		footer: { invalidate: vi.fn() },
		subagentSummaryLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		setupAutocompleteProvider: vi.fn(),
	};
}

describe("interactive model selection", () => {
	it("switches the session model without changing the default", async () => {
		const context = makeContext();

		await prototype.applySelectedModel.call(context, model, false);

		expect(context.agentConnection.setModel).toHaveBeenCalledWith("openai", "gpt-test");
		expect(context.settingsManager.setDefaultModelAndProvider).not.toHaveBeenCalled();
	});

	it("persists selections made by the model command", async () => {
		const context = makeContext();

		await prototype.applySelectedModel.call(context, model);

		expect(context.settingsManager.setDefaultModelAndProvider).toHaveBeenCalledWith("openai", "gpt-test");
	});
});
