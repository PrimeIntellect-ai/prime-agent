import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { AgentActivityTracker } from "../src/modes/interactive/agent-activity.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: unknown,
	event: Record<string, unknown>,
) => Promise<void>;

const startCompactionLoader = Reflect.get(InteractiveMode.prototype, "startCompactionLoader") as (
	this: unknown,
	reason: string,
	customInstructions?: string,
) => void;

function createFakeThis(overrides: Record<string, unknown> = {}) {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: new AgentActivityTracker(),
		updateWorkingLoaderMessage: vi.fn(),
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		startCompactionLoader(this: Record<string, unknown>, reason: string, customInstructions?: string) {
			startCompactionLoader.call(this, reason, customInstructions);
		},
		workingVisible: true,
		stopWorkingLoader: vi.fn(),
		syncWorkingLoader: vi.fn(),
		defaultEditor: {},
		statusContainer: { clear: vi.fn() },
		chatContainer: { clear: vi.fn() },
		rebuildChatFromMessages: vi.fn(function (this: { chatContainer: { clear(): void } }) {
			this.chatContainer.clear();
			return Promise.resolve();
		}),
		addMessageToChat: vi.fn(),
		refreshConnectionContextUsage: vi.fn().mockResolvedValue(undefined),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showStatus: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		...overrides,
	};
}

describe("InteractiveMode compaction events", () => {
	beforeAll(() => initTheme("dark"));

	test("shows an automatic compaction loader for the full operation", async () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({ statusContainer });

		await handleEvent.call(fakeThis, { type: "compaction_start", reason: "threshold" });

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Auto-compacting");
		expect(fakeThis.ui.requestRender).toHaveBeenCalled();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "threshold",
			result: undefined,
			aborted: true,
			willRetry: false,
		});
		expect(statusContainer.children).toHaveLength(0);
	});

	test.each([
		{ name: "rebuilds successful compaction from its single persisted summary", refresh: "succeeds" },
		{ name: "keeps stale chat and reports a failed post-compaction refresh", refresh: "fails" },
	] as const)("$name", async ({ refresh }) => {
		const fakeThis = createFakeThis(
			refresh === "fails"
				? { rebuildChatFromMessages: vi.fn().mockRejectedValue(new Error("context unavailable")) }
				: {},
		);

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "requested",
			result: { tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(refresh === "succeeds" ? 1 : 0);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledOnce();
		expect(fakeThis.addMessageToChat).not.toHaveBeenCalled();
		if (refresh === "fails") {
			expect(fakeThis.showError).toHaveBeenCalledWith(
				"Compaction succeeded, but the transcript could not be refreshed: context unavailable",
			);
		} else {
			expect(fakeThis.showError).not.toHaveBeenCalled();
		}
	});

	test("shows manual warning-severity outcomes as warnings, not errors", async () => {
		const fakeThis = createFakeThis();

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: undefined,
			aborted: false,
			willRetry: false,
			errorMessage: "Session is too short to compact",
			errorSeverity: "warning",
		});

		expect(fakeThis.showWarning).toHaveBeenCalledWith("Session is too short to compact");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("restores the compaction loader from state when no start event was seen", () => {
		const statusContainer = new Container();
		const fakeThis = createFakeThis({
			statusContainer,
			connectionState: { isCompacting: true },
			isAgentCompacting() {
				return true;
			},
			loadingAnimation: undefined,
			workingVisible: true,
			isAgentStreaming: () => false,
			stopWorkingLoader: vi.fn(),
			startWorkingLoader: vi.fn(),
		});

		(Reflect.get(InteractiveMode.prototype, "syncWorkingLoader") as (this: unknown) => void).call(fakeThis);

		expect(stripAnsi(statusContainer.render(80).join("\n"))).toContain("Compacting context");
	});
});
