import { describe, expect, it } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type TimerHarness = {
	turnStartedAt: number | undefined;
	workingStartedAt: number | undefined;
	connectionState: { isStreaming: boolean };
	updateWorkingLoaderMessage: () => void;
};

const restore = Reflect.get(InteractiveMode.prototype, "restoreTurnStartFromMessages") as (
	this: TimerHarness,
	messages: readonly { role: string; timestamp: number }[],
) => void;

function harness(overrides: Partial<TimerHarness> = {}): TimerHarness {
	return {
		turnStartedAt: undefined,
		workingStartedAt: undefined,
		connectionState: { isStreaming: true },
		updateWorkingLoaderMessage: () => {},
		...overrides,
	};
}

function attach(target: TimerHarness): TimerHarness {
	Object.setPrototypeOf(target, InteractiveMode.prototype);
	return target;
}

describe("working timer turn-start restore", () => {
	it("anchors the elapsed timer to the newest user message when re-attaching mid-stream", () => {
		const mode = attach(harness({ workingStartedAt: 999999 }));
		restore.call(mode, [
			{ role: "user", timestamp: 1000 },
			{ role: "assistant", timestamp: 2000 },
			{ role: "user", timestamp: 5000 },
			{ role: "toolResult", timestamp: 6000 },
		]);
		expect(mode.turnStartedAt).toBe(5000);
		expect(mode.workingStartedAt).toBe(5000);
	});

	it("clears any stale anchor when the session is not streaming", () => {
		const mode = attach(harness({ turnStartedAt: 1234, connectionState: { isStreaming: false } }));
		restore.call(mode, [{ role: "user", timestamp: 1000 }]);
		expect(mode.turnStartedAt).toBeUndefined();
	});

	it("leaves the loader basis alone when no user message exists", () => {
		const mode = attach(harness({ workingStartedAt: 777 }));
		restore.call(mode, [{ role: "assistant", timestamp: 2000 }]);
		expect(mode.turnStartedAt).toBeUndefined();
		expect(mode.workingStartedAt).toBe(777);
	});
});
