import { ProcessTerminal, Text } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryUiInputAttempt } from "../src/core/telemetry-journeys.js";
import { AgentConnectionPromptAdmissionError } from "../src/modes/agent-connection/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { TelemetryStatusContainer, TelemetryTerminal } from "../src/modes/interactive/telemetry-render-observer.js";

beforeEach(() => {
	for (const key of ["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY"]) vi.stubEnv(key, "");
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

type InputHost = {
	beginInputTelemetry(): TelemetryUiInputAttempt;
	observeInputStatusFrame(): void;
	promptWithTelemetry(text: string, options: object, attempt?: TelemetryUiInputAttempt): Promise<void>;
	pendingInputStatus?: TelemetryUiInputAttempt;
	inputStatusRendered: boolean;
	inputStatusAdmitted: boolean;
	inputStatusFrameAt?: number;
	loadingAnimation?: object;
	statusContainer: { children: object[] };
	ui: { hasOverlay(): boolean };
	hasInterruptibleWork(): boolean;
	getQueuedActionCount(): number;
};

function inputHost() {
	const attempt = {
		metadata: { inputId: "10000000-0000-4000-8000-000000000001" },
		admission: vi.fn(),
		firstStatus: vi.fn(),
	};
	const settingsManager = SettingsManager.inMemory();
	const prompt = vi.fn(async () => {});
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		uiServices: { settingsManager, modelRegistry: {} },
		journeyTelemetry: { beginInput: () => attempt },
		agentConnection: { prompt },
		getCurrentModel: () => undefined,
		hasInterruptibleWork: () => false,
		getQueuedActionCount: () => 0,
		ui: { hasOverlay: () => false },
		statusContainer: { children: [] },
		inputStatusRendered: false,
		inputStatusAdmitted: false,
	}) as InputHost;
	return { host, attempt, settingsManager, prompt };
}

describe("observed UI status timing", () => {
	it("records a synchronized terminal frame only after the output write succeeds", () => {
		const calls: string[] = [];
		const write = vi.spyOn(ProcessTerminal.prototype, "write").mockImplementation(() => {
			calls.push("write");
		});
		const terminal = new TelemetryTerminal(() => calls.push("frame"));
		terminal.write("cursor-only");
		terminal.write("\x1b[?2026hstatus\x1b[?2026l");
		expect(calls).toEqual(["write", "write", "frame"]);
		write.mockImplementation(() => {
			throw new Error("output closed");
		});
		expect(() => terminal.write("\x1b[?2026hstatus\x1b[?2026l")).toThrow("output closed");
		expect(calls).toHaveLength(3);
	});

	it("does not mark an empty status container as rendered", () => {
		const rendered = vi.fn();
		const container = new TelemetryStatusContainer(rendered);
		container.render(80);
		expect(rendered).not.toHaveBeenCalled();
		container.addChild(new Text("Working"));
		container.render(80);
		expect(rendered).toHaveBeenCalledOnce();
	});

	it("requires a rendered status and admitted own input, preserving the earlier frame time", async () => {
		const { host, attempt } = inputHost();
		host.beginInputTelemetry();
		host.loadingAnimation = {};
		host.observeInputStatusFrame();
		expect(attempt.firstStatus).not.toHaveBeenCalled();
		host.inputStatusRendered = true;
		host.observeInputStatusFrame();
		expect(host.inputStatusFrameAt).toBeUndefined();
		host.statusContainer.children = [host.loadingAnimation];
		host.inputStatusRendered = true;
		host.observeInputStatusFrame();
		const renderedAt = host.inputStatusFrameAt;
		expect(renderedAt).toEqual(expect.any(Number));
		expect(attempt.firstStatus).not.toHaveBeenCalled();
		await host.promptWithTelemetry("hello", {}, attempt);
		expect(attempt.admission).toHaveBeenCalledExactlyOnceWith("completed");
		expect(attempt.firstStatus).toHaveBeenCalledExactlyOnceWith(true, renderedAt);
	});

	it.each(["busy", "queued", "overlay", "overlapping"])("marks %s input status timing unavailable", (kind) => {
		const { host, attempt } = inputHost();
		if (kind === "busy") host.hasInterruptibleWork = () => true;
		if (kind === "queued") host.getQueuedActionCount = () => 1;
		if (kind === "overlay") host.ui.hasOverlay = () => true;
		if (kind === "overlapping") host.pendingInputStatus = { admission: vi.fn(), firstStatus: vi.fn() };
		host.beginInputTelemetry();
		expect(attempt.firstStatus).toHaveBeenCalledExactlyOnceWith(false);
		expect(host.pendingInputStatus).toBeUndefined();
	});

	it("does not send metadata when UI consent changes before dispatch", async () => {
		const { host, attempt, settingsManager, prompt } = inputHost();
		settingsManager.setTelemetryEnabled(false);
		await host.promptWithTelemetry("hello", {}, attempt);
		expect(prompt).toHaveBeenCalledExactlyOnceWith("hello", {});
	});

	it("does not attribute an earlier status frame after the input becomes queued", async () => {
		const { host, attempt } = inputHost();
		host.beginInputTelemetry();
		host.loadingAnimation = {};
		host.statusContainer.children = [host.loadingAnimation];
		host.inputStatusRendered = true;
		host.observeInputStatusFrame();
		host.getQueuedActionCount = () => 1;
		await host.promptWithTelemetry("hello", {}, attempt);
		expect(attempt.firstStatus).toHaveBeenCalledExactlyOnceWith(false);
	});

	it.each(["owned", "unknown"] as const)(
		"does not claim cancellation or rejection when admission is %s",
		async (status) => {
			const { host, attempt, settingsManager, prompt } = inputHost();
			settingsManager.setTelemetryEnabled(false);
			const error = new AgentConnectionPromptAdmissionError("Admission unconfirmed", status);
			prompt.mockRejectedValueOnce(error);
			const signal = AbortSignal.abort();
			await expect(host.promptWithTelemetry("hello", { signal }, attempt)).rejects.toBe(error);
			expect(attempt.admission).toHaveBeenCalledExactlyOnceWith("unavailable");
		},
	);
});

describe("cancellation to observed idle", () => {
	it("waits for idle evidence and cancellation acknowledgement without draining the preserved queue", async () => {
		let acknowledge = () => {};
		const response = new Promise<void>((resolve) => {
			acknowledge = resolve;
		});
		let streaming = true;
		const finish = vi.fn();
		const waitForIdle = vi.fn();
		const host = Object.assign(Object.create(InteractiveMode.prototype), {
			uiServices: { settingsManager: SettingsManager.inMemory() },
			journeyTelemetry: { beginCancellation: () => finish },
			agentConnection: { abort: () => response, waitForIdle },
			isAgentStreaming: () => streaming,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			getRetryAttempt: () => 0,
			connectionState: { sessionActions: { queuedCount: 2 } },
		}) as {
			interruptOrClearInput(): void;
			observeCancellationIdle(): void;
			pendingCancellation?: { idleAt?: number };
		};
		host.interruptOrClearInput();
		expect(finish).not.toHaveBeenCalled();
		streaming = false;
		host.observeCancellationIdle();
		const idleAt = host.pendingCancellation?.idleAt;
		expect(finish).not.toHaveBeenCalled();
		acknowledge();
		await vi.waitFor(() => expect(finish).toHaveBeenCalledExactlyOnceWith("completed", idleAt));
		expect(waitForIdle).not.toHaveBeenCalled();
	});

	it("does not start cancellation observation while opted out", async () => {
		const beginCancellation = vi.fn();
		const settingsManager = SettingsManager.inMemory({ telemetry: { enabled: false } });
		const host = Object.assign(Object.create(InteractiveMode.prototype), {
			uiServices: { settingsManager },
			journeyTelemetry: { beginCancellation },
			agentConnection: { abort: async () => {} },
			isAgentStreaming: () => true,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			getRetryAttempt: () => 0,
		}) as { interruptOrClearInput(): void; pendingCancellation?: object };
		host.interruptOrClearInput();
		settingsManager.setTelemetryEnabled(true);
		await Promise.resolve();
		expect(beginCancellation).not.toHaveBeenCalled();
		expect(host.pendingCancellation).toBeUndefined();
	});
});
