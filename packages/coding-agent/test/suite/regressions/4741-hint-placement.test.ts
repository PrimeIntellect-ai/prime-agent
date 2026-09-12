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

function createQueuedMessageMode() {
	const loader = new FakeLoader();
	const statusContainer = new Container();
	statusContainer.addChild(loader);
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		statusContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
		queuedMessagesContainer: new Container(),
		compactionQueuedMessages: [],
		loadingAnimation: loader,
		workingVisible: true,
		connectionState: {
			isStreaming: true,
			sessionActions: { queuedCount: 0, steering: [] as string[], followUps: [] as string[] },
		},
		options: { returnToAgentsView: true },
		getAppKeyDisplay: () => "Ctrl+Q",
		ui: { requestRender: vi.fn() },
	});
	return { mode };
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

	it("keeps queued messages and side questions above the prompt without a discovery-tip row", () => {
		const recapContainer = new Container();
		const queuedMessagesContainer = new Container();
		const sideQuestionContainer = new Container();
		const editorContainer = new Container();
		const subagentSummaryLine = new Container();
		const footerSlot = new Container();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			recapContainer,
			queuedMessagesContainer,
			sideQuestionContainer,
			editorContainer,
			subagentSummaryLine,
			footerSlot,
		});

		expect(callPrivate(mode, "getPromptContextContainers")).toEqual([queuedMessagesContainer, sideQuestionContainer]);
		expect(callPrivate(mode, "getPromptDockComponents")).toEqual([
			recapContainer,
			editorContainer,
			subagentSummaryLine,
			footerSlot,
		]);
	});

	it("keeps queued messages in the fullscreen transcript and the prompt dock free of discovery tips", () => {
		const previousIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		try {
			const headerContainer = new Container();
			const mainViewContainer = new Container();
			const widgetContainerAbove = new Container();
			const recapContainer = new Container();
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
					queuedMessagesContainer,
					sideQuestionContainer,
					widgetContainerBelow,
				],
				dock: promptDock,
				mouse: true,
			});
		} finally {
			if (previousIsTTY) {
				Object.defineProperty(process.stdout, "isTTY", previousIsTTY);
			} else {
				Reflect.deleteProperty(process.stdout, "isTTY");
			}
		}
	});

	it("shows queued messages without adding discovery tips when the queue clears", () => {
		const { mode } = createQueuedMessageMode();
		mode.connectionState.sessionActions.followUps = ["Continue after this turn"];
		callPrivate(mode, "updatePendingMessagesDisplay");
		expect(mode.queuedMessagesContainer.render(100).join("\n")).toContain("Continue after this turn");

		mode.connectionState.sessionActions.followUps = [];
		callPrivate(mode, "updatePendingMessagesDisplay");
		vi.advanceTimersByTime(60_000);
		expect(mode.queuedMessagesContainer.children).toHaveLength(0);
		expect(mode.statusContainer.children).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});
});
