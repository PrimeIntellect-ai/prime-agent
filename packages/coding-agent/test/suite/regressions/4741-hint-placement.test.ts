import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

class FakeLoader implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return ["loader".padEnd(width)];
	}
}

function callPrivate(mode: object, name: string, ...args: unknown[]): unknown {
	return Reflect.get(InteractiveMode.prototype, name).call(mode, ...args);
}

function createFeatureHintMode() {
	const loader = new FakeLoader();
	const statusContainer = new Container();
	statusContainer.addChild(loader);
	const featureHintContainer = new Container();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		statusContainer,
		featureHintContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		queuedMessagesContainer: new Container(),
		connectionQueue: { steering: [] as string[], followUp: [] as string[] },
		compactionQueuedMessages: [],
		loadingAnimation: loader,
		workingVisible: true,
		connectionState: { isStreaming: true },
		featureHintDeck: { next: vi.fn(() => ({ id: "test", text: "A useful feature hint." })) },
		currentFeatureHint: undefined,
		featureHintEligibleAt: 0,
		featureHintTimer: undefined,
		featureHintAnimationTimer: undefined,
		featureHintComponent: undefined,
		featureHintRunPending: false,
		featureHintSuppressedByQueue: false,
		options: { returnToAgentsView: true },
		getAppKeyDisplay: () => "Ctrl+Q",
		ui: { requestRender: vi.fn() },
	});
	return { mode, featureHintContainer };
}

describe("ENG-4741 hint placement", () => {
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

	it("orders hints below the recap and above queued messages and side questions", () => {
		const recapContainer = new Container();
		const featureHintContainer = new Container();
		const queuedMessagesContainer = new Container();
		const sideQuestionContainer = new Container();
		const editorContainer = new Container();
		const subagentSummaryLine = new Container();
		const footerSlot = new Container();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			recapContainer,
			featureHintContainer,
			queuedMessagesContainer,
			sideQuestionContainer,
			editorContainer,
			subagentSummaryLine,
			footerSlot,
		});

		expect(callPrivate(mode, "getPromptContextContainers")).toEqual([
			recapContainer,
			featureHintContainer,
			queuedMessagesContainer,
			sideQuestionContainer,
		]);
		expect(callPrivate(mode, "getPromptDockComponents")).toEqual([editorContainer, subagentSummaryLine, footerSlot]);
	});

	it("keeps hints in the fullscreen transcript instead of the prompt dock", () => {
		const previousIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		try {
			const headerContainer = new Container();
			const mainViewContainer = new Container();
			const widgetContainerAbove = new Container();
			const recapContainer = new Container();
			const featureHintContainer = new Container();
			const queuedMessagesContainer = new Container();
			const sideQuestionContainer = new Container();
			const widgetContainerBelow = new Container();
			const promptDock = new Container();
			const enterFullscreen = vi.fn();
			const mode = Object.assign(Object.create(InteractiveMode.prototype), {
				headerContainer,
				mainViewContainer,
				widgetContainerAbove,
				recapContainer,
				featureHintContainer,
				queuedMessagesContainer,
				sideQuestionContainer,
				widgetContainerBelow,
				promptDock,
				ui: { enterFullscreen },
				uiServices: { settingsManager: { getFullscreenMouse: () => true } },
			});

			callPrivate(mode, "applyFullscreen", true);

			expect(enterFullscreen).toHaveBeenCalledWith({
				scroll: [
					headerContainer,
					mainViewContainer,
					widgetContainerAbove,
					recapContainer,
					featureHintContainer,
					queuedMessagesContainer,
					sideQuestionContainer,
					widgetContainerBelow,
				],
				dock: promptDock,
				mouse: true,
			});
			expect(promptDock.children).not.toContain(featureHintContainer);
		} finally {
			if (previousIsTTY) {
				Object.defineProperty(process.stdout, "isTTY", previousIsTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("hides a visible hint while messages are queued and restores it when the queue clears", () => {
		const { mode, featureHintContainer } = createFeatureHintMode();

		callPrivate(mode, "startFeatureHintPresentation");
		vi.advanceTimersByTime(5_000);
		expect(featureHintContainer.children).toHaveLength(1);

		mode.connectionQueue.followUp = ["Continue after this turn"];
		callPrivate(mode, "updatePendingMessagesDisplay");
		expect(featureHintContainer.children).toHaveLength(0);

		mode.connectionQueue.followUp = [];
		callPrivate(mode, "updatePendingMessagesDisplay");
		expect(featureHintContainer.children).toHaveLength(1);

		const restoredHint = featureHintContainer.children[0];
		callPrivate(mode, "updatePendingMessagesDisplay");
		expect(featureHintContainer.children).toEqual([restoredHint]);
	});
});
