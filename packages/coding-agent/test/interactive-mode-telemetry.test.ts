import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryFeatureAttempt, TelemetryTaskFeedback } from "../src/core/telemetry-journeys.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type EffortContext = {
	journeyTelemetry: { beginFeature: (feature: "effort", level?: "high") => TelemetryFeatureAttempt };
	agentConnection: { setThinkingLevel: (level: "high") => Promise<void> };
	patchConnectionState: (state: { thinkingLevel: "high" }) => void;
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type FeedbackContext = {
	settingsManager: SettingsManager;
	journeyTelemetry: { feedback: (value: TelemetryTaskFeedback) => void };
	showStatus: (message: string) => void;
	showExtensionSelector: (title: string, choices: string[]) => Promise<string | undefined>;
};

const prototype = InteractiveMode.prototype as unknown as {
	applyThinkingLevel(this: EffortContext, level: "high", feature?: TelemetryFeatureAttempt): void;
	handleFeedbackCommand(this: FeedbackContext, argument: string): Promise<void>;
};

afterEach(() => vi.unstubAllEnvs());

describe("interactive telemetry outcomes", () => {
	it("waits for the actual connection acknowledgement before reporting an effort change", async () => {
		let acknowledge = () => {};
		const completion = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		const finish = vi.fn();
		const context: EffortContext = {
			journeyTelemetry: { beginFeature: vi.fn(() => ({ finish })) },
			agentConnection: { setThinkingLevel: vi.fn(() => completion) },
			patchConnectionState: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		prototype.applyThinkingLevel.call(context, "high");
		expect(context.journeyTelemetry.beginFeature).toHaveBeenCalledExactlyOnceWith("effort", "high");
		expect(finish).not.toHaveBeenCalled();
		acknowledge();
		await completion;
		expect(finish).toHaveBeenCalledExactlyOnceWith("completed", "high");
	});

	it("reports a failed effort change without updating the UI state", async () => {
		const finish = vi.fn();
		const context: EffortContext = {
			journeyTelemetry: { beginFeature: () => ({ finish }) },
			agentConnection: { setThinkingLevel: vi.fn().mockRejectedValue(new Error("connection closed")) },
			patchConnectionState: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};

		prototype.applyThinkingLevel.call(context, "high");
		await vi.waitFor(() => expect(finish).toHaveBeenCalledExactlyOnceWith("failed", "high"));
		expect(context.patchConnectionState).not.toHaveBeenCalled();
	});
});

describe("optional task feedback", () => {
	function context(): FeedbackContext {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
		vi.stubEnv("PI_OFFLINE", "0");
		return {
			settingsManager: SettingsManager.inMemory(),
			journeyTelemetry: { feedback: vi.fn() },
			showStatus: vi.fn(),
			showExtensionSelector: vi.fn(async () => undefined),
		};
	}

	it("sends only the matching fixed choice", async () => {
		const host = context();
		await prototype.handleFeedbackCommand.call(host, "partly-helpful");
		expect(host.journeyTelemetry.feedback).toHaveBeenCalledExactlyOnceWith("partly_helpful");
		expect(host.showExtensionSelector).not.toHaveBeenCalled();
	});

	it("rejects freeform feedback and prototype-property names", async () => {
		const host = context();
		await prototype.handleFeedbackCommand.call(host, "private task content");
		await prototype.handleFeedbackCommand.call(host, "__proto__");
		expect(host.journeyTelemetry.feedback).not.toHaveBeenCalled();
		expect(host.showExtensionSelector).not.toHaveBeenCalled();
	});

	it("does not send anything when the optional selector is canceled", async () => {
		const host = context();
		await prototype.handleFeedbackCommand.call(host, "");
		expect(host.showExtensionSelector).toHaveBeenCalledOnce();
		expect(host.journeyTelemetry.feedback).not.toHaveBeenCalled();
	});

	it("honors telemetry opt-out before opening the selector", async () => {
		const host = context();
		host.settingsManager.setTelemetryEnabled(false);
		await prototype.handleFeedbackCommand.call(host, "");
		expect(host.showExtensionSelector).not.toHaveBeenCalled();
		expect(host.journeyTelemetry.feedback).not.toHaveBeenCalled();
	});

	it("rechecks opt-out when the optional selector closes", async () => {
		const host = context();
		host.showExtensionSelector = async () => {
			host.settingsManager.setTelemetryEnabled(false);
			return "Helpful";
		};
		await prototype.handleFeedbackCommand.call(host, "");
		expect(host.journeyTelemetry.feedback).not.toHaveBeenCalled();
		expect(host.showStatus).toHaveBeenCalledExactlyOnceWith("Telemetry is disabled; feedback was not sent.");
	});
});
