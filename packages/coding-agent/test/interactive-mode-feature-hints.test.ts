import { type Component, Container, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FEATURE_HINT_ANIMATION_INTERVAL_MS } from "../src/modes/interactive/components/feature-hint.js";
import { FEATURE_HINTS, FeatureHintDeck } from "../src/modes/interactive/feature-hints.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeLoader implements Component {
	readonly stop = vi.fn();

	invalidate(): void {}

	render(width: number): string[] {
		return ["loader".padEnd(width)];
	}
}

function callPrivate(mode: object, name: string): void {
	Reflect.get(InteractiveMode.prototype, name).call(mode);
}

function createMode() {
	const statusContainer = new Container();
	const featureHintContainer = new Container();
	const loader = new FakeLoader();
	statusContainer.addChild(loader);
	const hint = { id: "test", text: "This is a deliberately long feature hint for narrow terminals." };
	const featureHintDeck = { next: vi.fn(() => hint) };
	const requestRender = vi.fn();
	const mode = {
		statusContainer,
		featureHintContainer,
		loadingAnimation: loader,
		workingVisible: true,
		connectionState: {
			isStreaming: true,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		},
		workingTimer: undefined,
		workingStartedAt: 0,
		featureHintDeck,
		currentFeatureHint: undefined,
		featureHintEligibleAt: 0,
		featureHintTimer: undefined,
		featureHintAnimationTimer: undefined,
		featureHintComponent: undefined,
		featureHintRunPending: false,
		compactionQueuedMessages: [],
		options: { returnToAgentsView: true },
		ui: { requestRender },
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, statusContainer, featureHintContainer, loader, featureHintDeck, requestRender };
}

describe("feature hint deck", () => {
	it("shows every available hint before repeating and avoids a boundary repeat", () => {
		const deck = new FeatureHintDeck();
		const context = { getKeybinding: (action: string) => `Custom ${action}`, isResidentSession: true };
		const firstCycle = FEATURE_HINTS.map(() => deck.next(context));

		expect(firstCycle.every((hint) => hint !== undefined)).toBe(true);
		expect(new Set(firstCycle.map((hint) => hint?.id)).size).toBe(FEATURE_HINTS.length);
		expect(deck.next(context)?.id).not.toBe(firstCycle.at(-1)?.id);
	});

	it("uses configured shortcuts in keybinding-based hints", () => {
		const context = {
			getKeybinding: (action: string) => {
				if (action === "app.prompt.stash") return "Meta+S";
				if (action === "app.message.followUp") return "Meta+Enter";
				return "Meta+Left";
			},
			isResidentSession: true,
		};
		const textById = new Map(FEATURE_HINTS.map((hint) => [hint.id, hint.getText(context)]));

		expect(textById.get("prompt-stash")).toContain("Meta+S");
		expect(textById.get("follow-up")).toContain("Meta+Enter");
		expect(textById.get("agents-view")).toContain("Meta+Left");
	});

	it("hides resident-only hints in ephemeral sessions", () => {
		const context = { getKeybinding: () => "Left", isResidentSession: false };
		const textById = new Map(FEATURE_HINTS.map((hint) => [hint.id, hint.getText(context)]));

		expect(textById.get("agents-view")).toBeUndefined();
		expect(textById.get("background-running")).toBeUndefined();
	});
});

describe("InteractiveMode feature hints", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("adds one animated truncated hint above the prompt after a sustained agent run", () => {
		const { mode, statusContainer, featureHintContainer, featureHintDeck, requestRender } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(4_999);
		expect(statusContainer.children).toHaveLength(1);
		expect(featureHintContainer.children).toHaveLength(0);
		expect(featureHintDeck.next).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(statusContainer.children).toHaveLength(1);
		expect(featureHintContainer.children).toHaveLength(1);
		const lines = featureHintContainer.children[0]?.render(24) ?? [];
		expect(lines).toHaveLength(2);
		expect(stripAnsi(lines[0] ?? "")).toContain("Hint:");
		expect(lines[1]?.trim()).toBe("");
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(24);
		expect(featureHintDeck.next).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(FEATURE_HINT_ANIMATION_INTERVAL_MS);
		const animatedLines = featureHintContainer.children[0]?.render(24) ?? [];
		expect(stripAnsi(animatedLines[0] ?? "")).toBe(stripAnsi(lines[0] ?? ""));
		expect(animatedLines[0]).not.toBe(lines[0]);
		expect(requestRender).toHaveBeenCalledTimes(2);
	});

	it("cancels a pending hint when the loader stops", () => {
		const { mode, statusContainer, featureHintContainer, featureHintDeck, requestRender } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(2_000);
		callPrivate(mode, "stopWorkingLoader");
		vi.advanceTimersByTime(5_000);

		expect(statusContainer.children).toHaveLength(0);
		expect(featureHintContainer.children).toHaveLength(0);
		expect(featureHintDeck.next).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("retains the hint and remaining delay when the loader is recreated", () => {
		const { mode, statusContainer, featureHintContainer, featureHintDeck } = createMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(3_000);
		callPrivate(mode, "stopWorkingLoader");

		const replacement = new FakeLoader();
		Reflect.set(mode, "loadingAnimation", replacement);
		statusContainer.addChild(replacement);
		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(1_999);
		expect(statusContainer.children).toHaveLength(1);
		expect(featureHintContainer.children).toHaveLength(0);
		expect(featureHintDeck.next).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(statusContainer.children).toHaveLength(1);
		expect(featureHintContainer.children).toHaveLength(1);
		expect(featureHintDeck.next).toHaveBeenCalledTimes(1);

		callPrivate(mode, "endFeatureHintRun");
		expect(statusContainer.children).toHaveLength(1);
		expect(featureHintContainer.children).toHaveLength(0);
		expect(Reflect.get(mode, "currentFeatureHint")).toBeUndefined();
	});

	it("keeps hints for steering and continuations, then restarts the delay for new runs", () => {
		const { mode } = createMode();
		Reflect.set(mode, "currentFeatureHint", "Existing hint");
		Reflect.set(mode, "featureHintEligibleAt", 5_000);

		Reflect.get(InteractiveMode.prototype, "prepareFeatureHintRun").call(mode, {
			role: "user",
			content: [{ type: "text", text: "steer" }],
			timestamp: 0,
		});
		expect(Reflect.get(mode, "currentFeatureHint")).toBe("Existing hint");

		Reflect.set(mode, "featureHintRunPending", true);
		Reflect.get(InteractiveMode.prototype, "prepareFeatureHintRun").call(mode, {
			role: "assistant",
			content: [],
		});
		expect(Reflect.get(mode, "currentFeatureHint")).toBe("Existing hint");
		expect(Reflect.get(mode, "featureHintRunPending")).toBe(false);

		Reflect.set(mode, "featureHintRunPending", true);
		Reflect.get(InteractiveMode.prototype, "prepareFeatureHintRun").call(mode, {
			role: "user",
			content: [{ type: "text", text: "new run" }],
			timestamp: 0,
		});
		expect(Reflect.get(mode, "currentFeatureHint")).toBeUndefined();
		expect(Reflect.get(mode, "featureHintEligibleAt")).toBe(5_000);
		expect(Reflect.get(mode, "featureHintTimer")).toBeDefined();
	});
});
