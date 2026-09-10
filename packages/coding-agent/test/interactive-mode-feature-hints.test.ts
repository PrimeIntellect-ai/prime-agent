import { type Component, Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
	const loader = new FakeLoader();
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		statusContainer: new Container(),
		queuedMessagesContainer: new Container(),
		sideQuestionContainer: new Container(),
		createWorkingLoader: () => loader,
		startWorkingTimer: vi.fn(),
		ui: { requestRender: vi.fn() },
	});
	return { mode, loader };
}

describe("InteractiveMode without feature-discovery tips", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("keeps sustained and restarted agent runs free of tip rows and tip timers", () => {
		const { mode, loader } = createMode();
		for (let run = 0; run < 3; run++) {
			callPrivate(mode, "startWorkingLoader");
			vi.advanceTimersByTime(60_000);
			expect(mode.statusContainer.children).toEqual([loader]);
			expect(mode.statusContainer.render(80).join("\n").trim()).toBe("loader");
			expect(mode.queuedMessagesContainer.children).toHaveLength(0);
			expect(mode.sideQuestionContainer.children).toHaveLength(0);
			expect(vi.getTimerCount()).toBe(0);
		}
		callPrivate(mode, "stopWorkingLoader");
		expect(mode.statusContainer.children).toHaveLength(0);
		expect(loader.stop).toHaveBeenCalled();
	});

	it("does not leave a delayed tip after a short run finishes", () => {
		const { mode } = createMode();
		callPrivate(mode, "startWorkingLoader");
		vi.advanceTimersByTime(2_000);
		callPrivate(mode, "stopWorkingLoader");
		vi.advanceTimersByTime(60_000);
		expect(mode.statusContainer.children).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
