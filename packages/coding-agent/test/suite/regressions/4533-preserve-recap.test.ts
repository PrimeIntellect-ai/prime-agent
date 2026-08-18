import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";

type RecapRenderMode = {
	recapContainer: Container;
	sessionRecap?: string;
	agentRunFileChanges: Map<string, never>;
	isAgentStreaming: () => boolean;
	ui: { requestRender: () => void };
};

type RenderRecapHost = {
	renderRecap(this: RecapRenderMode): void;
};

type MessageStartMode = {
	isInitialized: boolean;
	footer: { invalidate: () => void };
	updateConnectionStateFromEvent: (event: unknown) => void;
	contextUsageTokenBaseline: number;
	setSessionHasMessages: (hasMessages: boolean) => void;
	clearShortcutGuide: () => void;
	activityTracker: { handleEvent: (event: unknown) => void };
	updateWorkingLoaderMessage: () => void;
	addMessageToChat: (message: AgentMessage) => void;
	ui: { requestRender: () => void };
	sessionRecap?: string;
	agentRunFileChanges: Map<string, never>;
	renderRecap: () => void;
	updatePendingMessagesDisplay: () => void;
};

type HandleEventHost = {
	handleEvent(this: MessageStartMode, event: { type: "message_start"; message: AgentMessage }): Promise<void>;
};

const renderRecap = (InteractiveMode.prototype as unknown as RenderRecapHost).renderRecap;
const handleEvent = (InteractiveMode.prototype as unknown as HandleEventHost).handleEvent;

function createRenderMode(sessionRecap?: string): RecapRenderMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		recapContainer: new Container(),
		sessionRecap,
		agentRunFileChanges: new Map(),
		isAgentStreaming: () => false,
		ui: { requestRender: vi.fn() },
	}) as RecapRenderMode;
}

function createMessageStartMode(): MessageStartMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		contextUsageTokenBaseline: 12,
		setSessionHasMessages: vi.fn(),
		clearShortcutGuide: vi.fn(),
		activityTracker: { handleEvent: vi.fn() },
		updateWorkingLoaderMessage: vi.fn(),
		addMessageToChat: vi.fn(),
		ui: { requestRender: vi.fn() },
		sessionRecap: "previous recap",
		agentRunFileChanges: new Map(),
		renderRecap: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
	}) as MessageStartMode;
}

function render(mode: RecapRenderMode, width = 80): string[] {
	renderRecap.call(mode);
	return mode.recapContainer.render(width);
}

function stripAnsi(text: string): string {
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("ENG-4533 recap layout", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps the previous recap visible when a user prompt starts", async () => {
		const mode = createMessageStartMode();
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "Continue with the implementation" }],
			timestamp: Date.now(),
		};

		await handleEvent.call(mode, { type: "message_start", message });

		expect(mode.addMessageToChat).toHaveBeenCalledWith(message);
		expect(mode.sessionRecap).toBe("previous recap");
		expect(mode.renderRecap).toHaveBeenCalledOnce();
		expect(mode.updatePendingMessagesDisplay).not.toHaveBeenCalled();
	});

	it("replaces an existing recap without changing its height", () => {
		const mode = createRenderMode("Reviewing the current implementation");
		const previous = render(mode);

		mode.sessionRecap = "Preparing the fix plan";
		const updated = render(mode);

		expect(previous).toHaveLength(2);
		expect(updated).toHaveLength(2);
		expect(stripAnsi(updated[0] ?? "")).toContain("Recap: Preparing the fix plan");
	});

	it("does not reserve blank space before the first recap", () => {
		const mode = createRenderMode();

		expect(render(mode)).toEqual([]);
	});

	it("keeps long recaps to one row on narrow terminals", () => {
		const mode = createRenderMode("Reviewing the implementation and preparing a clean regression test");
		const lines = render(mode, 24);

		expect(lines).toHaveLength(2);
		expect(visibleWidth(lines[0] ?? "")).toBe(24);
		expect(stripAnsi(lines[0] ?? "")).toContain("Recap:");
	});
});
