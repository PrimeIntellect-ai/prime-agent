import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeEditor = {
	text: string;
	getText: () => string;
	getExpandedText: () => string;
	setText: (text: string) => void;
};

type FakeInteractiveMode = {
	ctrlCExitHintExpiresAt: number;
	ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	escapeRepeatAction: "tree" | "clear" | undefined;
	escapeRepeatExpiresAt: number;
	escapeRepeatTimer: ReturnType<typeof setTimeout> | undefined;
	traceUploadAllAbortController: AbortController | undefined;
	isShuttingDown: boolean;
	editor: FakeEditor;
	connectionState: {
		isStreaming: boolean;
		isCompacting: boolean;
		isBashRunning: boolean;
		retryAttempt: number;
		sessionActions: { queuedCount: number; steering: readonly string[]; followUps: readonly string[] };
	};
	connectionQueue: { steering: string[]; followUp: string[] };
	agentConnection: {
		abort: Mock;
		clearQueue: Mock;
		abortAndClearQueue: Mock;
		abortRetry: Mock;
		abortCompaction: Mock;
		abortBranchSummary: Mock;
		abortBash: Mock;
	};
	subagentSummaryLine: { invalidate: Mock };
	ui: { requestRender: Mock; onDebug?: () => void };
	updatePendingMessagesDisplay: Mock;
	showError: Mock;
	showTreeSelector: Mock;
	shutdown: Mock;
	updateEditorBorderColor: Mock;
	queueSelection: { isBrowsing: boolean; reset: () => string };
	defaultEditor?: {
		onAction: Mock;
		getHeaderLine?: () => string | undefined;
		onEscape?: () => void;
		onCtrlD?: () => void;
		onPasteImage?: () => void;
		onMoveBelowPrompt?: () => boolean;
		onChange?: (text: string) => void;
	};
	keybindings?: KeybindingsManager;
	handleDebugCommand?: Mock;
	showShortcutGuide?: Mock;
};

function createEditor(text = ""): FakeEditor {
	const editor: FakeEditor = {
		text,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.text;
		},
		setText(nextText: string) {
			this.text = nextText;
		},
	};
	return editor;
}

function createInteractiveFake(options: {
	editorText?: string;
	streaming?: boolean;
	compacting?: boolean;
	bashRunning?: boolean;
	retryAttempt?: number;
}): FakeInteractiveMode {
	const editor = createEditor(options.editorText ?? "");
	const fake: FakeInteractiveMode = {
		ctrlCExitHintExpiresAt: 0,
		ctrlCExitHintTimer: undefined,
		escapeRepeatAction: undefined,
		escapeRepeatExpiresAt: 0,
		escapeRepeatTimer: undefined,
		traceUploadAllAbortController: undefined,
		isShuttingDown: false,
		editor,
		connectionState: {
			isStreaming: options.streaming ?? false,
			isCompacting: options.compacting ?? false,
			isBashRunning: options.bashRunning ?? false,
			retryAttempt: options.retryAttempt ?? 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		},
		connectionQueue: { steering: [], followUp: [] },
		agentConnection: {
			abort: vi.fn().mockResolvedValue(undefined),
			clearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			abortAndClearQueue: vi.fn().mockResolvedValue({ steering: [], followUp: [] }),
			abortRetry: vi.fn(),
			abortCompaction: vi.fn(),
			abortBranchSummary: vi.fn(),
			abortBash: vi.fn(),
		},
		subagentSummaryLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		queueSelection: { isBrowsing: false, reset: () => "" },
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		showTreeSelector: vi.fn(),
		shutdown: vi.fn().mockResolvedValue(undefined),
		updateEditorBorderColor: vi.fn(),
		showShortcutGuide: vi.fn(),
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

describe("InteractiveMode interrupt shortcuts", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-08T12:00:00Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("interrupts streaming and shows the exit hint on first Ctrl+C", () => {
		const mode = createInteractiveFake({ streaming: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abort).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).not.toHaveBeenCalled();
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe(
			"Press Ctrl+C again to exit",
		);
	});

	it("interrupts bash and streaming on the same Ctrl+C", () => {
		const mode = createInteractiveFake({ streaming: true, bashRunning: true });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abortBash).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.abort).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it.each([
		["Ctrl+C", "handleCtrlC"],
		["Escape", "handleEscape"],
	] as const)("cancels an upload-all operation on %s", (_label, handlerName) => {
		const mode = createInteractiveFake({});
		const controller = new AbortController();
		mode.traceUploadAllAbortController = controller;

		Reflect.get(InteractiveMode.prototype, handlerName).call(mode);

		expect(controller.signal.aborted).toBe(true);
		expect(controller.signal.reason).toEqual(new Error("Trace upload cancelled"));
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("preserves the queue and the draft when interrupting streaming", () => {
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		mode.connectionQueue = { steering: ["steer"], followUp: ["follow"] };

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.agentConnection.abort).toHaveBeenCalledTimes(1);
		expect(mode.agentConnection.abortAndClearQueue).not.toHaveBeenCalled();
		expect(mode.agentConnection.clearQueue).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("draft");
		expect(mode.connectionQueue).toEqual({ steering: ["steer"], followUp: ["follow"] });
	});

	it("exits on the second Ctrl+C while the hint is visible", () => {
		const mode = createInteractiveFake({ streaming: true });
		const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC");

		handleCtrlC.call(mode);
		handleCtrlC.call(mode);

		expect(mode.agentConnection.abort).toHaveBeenCalledTimes(1);
		expect(mode.shutdown).toHaveBeenCalledTimes(1);
	});

	it("clears the exit hint after two seconds", async () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);
		expect(mode.editor.getText()).toBe("draft");
		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBe(
			"Press Ctrl+C again to exit",
		);

		await vi.advanceTimersByTimeAsync(2000);

		expect(Reflect.get(InteractiveMode.prototype, "getTrayOverrideLabel").call(mode)).toBeUndefined();
		expect(mode.subagentSummaryLine.invalidate).toHaveBeenCalled();
		expect(mode.ui.requestRender).toHaveBeenCalled();
	});

	it("preserves idle draft input on first Ctrl+C", () => {
		const mode = createInteractiveFake({ editorText: "draft" });

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(mode);

		expect(mode.editor.getText()).toBe("draft");
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("cancels the tree repeat when typing after interrupting streaming", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft", streaming: true });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		expect(defaultEditor.onEscape).toBeDefined();
		defaultEditor.onEscape?.();
		expect(mode.agentConnection.abort).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("draft");
		mode.editor.setText("queued draft");
		defaultEditor.onChange?.("queued draft");

		defaultEditor.onEscape?.();

		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.shutdown).not.toHaveBeenCalled();
	});

	it("preserves the tree repeat while browsing into a queued message", () => {
		const mode = createInteractiveFake({});
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn(),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
			isApplyingQueueSelectionText: false,
		});
		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		const setText = mode.editor.setText.bind(mode.editor);
		mode.editor.setText = (text) => {
			setText(text);
			defaultEditor.onChange?.(text);
		};
		mode.escapeRepeatAction = "tree";
		mode.escapeRepeatExpiresAt = Date.now() + 500;

		Reflect.get(InteractiveMode.prototype, "setEditorTextFromQueueSelection").call(mode, "queued item");

		expect(mode.editor.getText()).toBe("queued item");
		expect(mode.escapeRepeatAction).toBe("tree");
	});

	it("clears an idle draft on double Escape", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft" });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		defaultEditor.onEscape?.();
		expect(mode.editor.getText()).toBe("draft");

		defaultEditor.onEscape?.();

		expect(mode.editor.getText()).toBe("");
		expect(mode.agentConnection.abort).not.toHaveBeenCalled();
	});

	it("opens the tree on double Escape with an empty idle prompt", () => {
		const mode = createInteractiveFake({});
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);
		handleEscape.call(mode);

		expect(mode.showTreeSelector).toHaveBeenCalledTimes(1);
		expect(mode.editor.getText()).toBe("");
	});

	it("clears a whitespace draft on double Escape", () => {
		const mode = createInteractiveFake({ editorText: "   " });
		const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

		handleEscape.call(mode);
		handleEscape.call(mode);

		expect(mode.showTreeSelector).not.toHaveBeenCalled();
		expect(mode.editor.getText()).toBe("");
	});

	for (const [label, options] of [
		["a retry", { retryAttempt: 1 }],
		["compaction", { compacting: true }],
		["a bash command", { bashRunning: true }],
	] as const) {
		it(`opens the tree after cancelling ${label} without clearing the draft`, () => {
			const mode = createInteractiveFake({ editorText: "draft", ...options });
			const handleEscape = Reflect.get(InteractiveMode.prototype, "handleEscape");

			handleEscape.call(mode);
			handleEscape.call(mode);

			expect(mode.showTreeSelector).toHaveBeenCalledTimes(1);
			expect(mode.editor.getText()).toBe("draft");
		});
	}

	it("clears the Escape repeat before a separate interrupt", () => {
		const mode = createInteractiveFake({});
		mode.escapeRepeatAction = "tree";
		mode.escapeRepeatExpiresAt = Date.now() + 500;

		Reflect.get(InteractiveMode.prototype, "handleInterruptKey").call(mode);

		expect(mode.escapeRepeatAction).toBeUndefined();
	});

	it("expires the Escape repeat window", async () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({ editorText: "draft" });
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		defaultEditor.onEscape?.();
		await vi.advanceTimersByTimeAsync(500);
		defaultEditor.onEscape?.();

		expect(mode.editor.getText()).toBe("draft");
	});

	it("opens keyboard shortcuts from the configured app action", () => {
		const actionHandlers = new Map<string, () => void>();
		const mode = createInteractiveFake({});
		const defaultEditor: NonNullable<FakeInteractiveMode["defaultEditor"]> = {
			onAction: vi.fn((action: string, handler: () => void) => {
				actionHandlers.set(action, handler);
			}),
		};
		Object.assign(mode, {
			defaultEditor,
			keybindings: new KeybindingsManager(),
			handleDebugCommand: vi.fn(),
		});

		Reflect.get(InteractiveMode.prototype, "setupKeyHandlers").call(mode);
		actionHandlers.get("app.shortcuts")?.();

		expect(mode.showShortcutGuide).toHaveBeenCalledTimes(1);
	});
});
