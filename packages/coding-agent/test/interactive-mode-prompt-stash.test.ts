import type { ImageContent } from "@earendil-works/pi-ai";
import { describe, expect, it, type Mock, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { ClientPromptStashStore, type PromptStashState } from "../src/modes/interactive/prompt-stash-state.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type FakePasteSnapshot = {
	pastes: readonly (readonly [number, string])[];
	pasteCounter: number;
};

type PromptStash = {
	text: string;
	expandedText?: string;
	pasteSnapshot?: FakePasteSnapshot;
	images?: readonly (readonly [number, ImageContent])[];
	restoreOnOpen?: boolean;
};

type FakeEditor = {
	text: string;
	expandedText: string;
	history: string[];
	pasteSnapshot?: FakePasteSnapshot;
	restoredPasteSnapshot?: FakePasteSnapshot;
	onSubmit?: (text: string) => void | Promise<void>;
	clearHistory?: Mock;
	getText: () => string;
	getExpandedText: () => string;
	getPasteSnapshot: () => FakePasteSnapshot | undefined;
	restorePasteSnapshot?: (snapshot: FakePasteSnapshot) => void;
	setText: (text: string) => void;
	addToHistory: Mock;
	getHistory: () => readonly string[];
};

type PromptStashHarness = {
	promptStash?: PromptStash;
	promptStashState: PromptStashState;
	editor: FakeEditor;
	showStatus: Mock;
	clearShortcutGuide: Mock;
};

type PromptStashLiveMarkerHarness = PromptStashHarness & {
	connectionQueue: { steering: string[]; followUp: string[] };
};

type SharedPromptStashHarness = PromptStashHarness & {
	promptStashStore: ClientPromptStashStore;
	promptStashSessionId: string;
	promptStashState: PromptStashState;
	pendingPromptStashReleases: { sessionId: string; state: unknown }[];
	pastedImages: Map<number, ImageContent>;
	nextImageMarkerId: number;
};

type ResetHarness = PromptStashLiveMarkerHarness & {
	queueSelection: QueueSelection;
	chatContainer: { clear: Mock };
	shortcutGuideContainer: { clear: Mock };
	pendingMessagesContainer: { clear: Mock };
	queuedMessagesContainer: { clear: Mock };
	defaultEditor: FakeEditor;
	pastedImages: Map<number, unknown>;
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	activeBashComponent?: { setComplete: Mock };
	pendingBashComponents: unknown[];
	activityTracker: { reset: Mock };
	contextUsageTokenBaseline: number;
	agentRunFileChanges: Map<string, unknown>;
	recapContainer: { clear: Mock };
	ui: { requestRender: Mock };
	ipythonToolComponents: Map<string, unknown>;
	lateIpythonSentAgentMessages: Map<string, unknown>;
	resetPendingToolState: Mock;
	resetSubagentSummary: Mock;
	setGoalAnnouncementBaseline: Mock;
	getGoalState: Mock<() => unknown>;
	syncGoalTray: Mock;
};

type SubmitHarness = PromptStashHarness & {
	defaultEditor: { onSubmit?: (text: string) => void | Promise<void> };
	uiServices: { settingsManager: { getTelemetryEnabled: Mock<() => boolean> } };
	sideQuestionContainer: { clear: Mock };
	isAgentCompacting: () => boolean;
	isAgentStreaming: () => boolean;
	flushPendingBashComponents: Mock;
	onInputCallback: Mock;
	clearSideQuestion: Mock;
	collectImagesFor: Mock;
	agentConnection: { prompt: Mock };
	updatePendingMessagesDisplay: Mock;
	ui: { requestRender: Mock };
	showError: Mock;
	submittedInputBehavior: "steer" | "followUp";
	inputSubmissionGeneration: number;
	inputSubmissionsPending: number;
	pendingPromptStashReleases: { sessionId: string; state: unknown }[];
	retainedSubmissionGenerations: WeakMap<object, number>;
};

type PromptStashMethods = {
	bindPromptStashSession: (this: SharedPromptStashHarness, sessionId: string) => void;
	handleFollowUp: (this: SubmitHarness) => Promise<void>;
	handlePromptStash: (this: PromptStashHarness) => void;
	hydratePromptStash: (this: SharedPromptStashHarness) => void;
	resetCurrentSessionRenderState: (this: ResetHarness, options?: { clearPromptStash?: boolean }) => void;
	restorePromptStashIfEditorEmpty: (this: PromptStashHarness, stash?: PromptStash) => boolean;
	restorePromptStashOnOpen: (this: PromptStashHarness) => void;
	stashDraftForAgentsView: (this: SharedPromptStashHarness) => void;
	liveImageMarkerIds: (this: PromptStashLiveMarkerHarness) => Set<number>;
	setupEditorSubmitHandler: (this: SubmitHarness) => void;
};

const interactiveModeMethods = InteractiveMode.prototype as unknown as PromptStashMethods;

function createEditor(
	options: { text?: string; expandedText?: string; history?: string[]; pasteSnapshot?: FakePasteSnapshot } = {},
): FakeEditor {
	const editor: FakeEditor = {
		text: options.text ?? "",
		expandedText: options.expandedText ?? options.text ?? "",
		history: options.history ?? [],
		pasteSnapshot: options.pasteSnapshot,
		getText() {
			return this.text;
		},
		getExpandedText() {
			return this.expandedText;
		},
		getPasteSnapshot() {
			return this.pasteSnapshot;
		},
		restorePasteSnapshot(snapshot: FakePasteSnapshot) {
			this.restoredPasteSnapshot = snapshot;
			this.pasteSnapshot = snapshot;
		},
		setText(nextText: string) {
			this.text = nextText;
			this.expandedText = nextText;
		},
		addToHistory: vi.fn(),
		getHistory() {
			return this.history;
		},
		clearHistory: vi.fn(function (this: FakeEditor) {
			this.history = [];
		}),
	};
	return editor;
}

type Deferred = { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };

function createDeferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((nextResolve, nextReject) => {
		resolve = nextResolve;
		reject = nextReject;
	});
	return { promise, resolve, reject };
}

function createPromptStashHarness(
	options: { text?: string; expandedText?: string; stash?: string; pasteSnapshot?: FakePasteSnapshot } = {},
) {
	const harness: PromptStashHarness = {
		// promptStash reads/writes go through the prototype accessor onto this state.
		promptStashState: {
			stash: options.stash ? { text: options.stash, pasteSnapshot: options.pasteSnapshot } : undefined,
		},
		editor: createEditor({
			text: options.text,
			expandedText: options.expandedText,
			pasteSnapshot: options.pasteSnapshot,
		}),
		showStatus: vi.fn(),
		clearShortcutGuide: vi.fn(),
	};
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

function createSubmitHarness(
	options: Parameters<typeof createPromptStashHarness>[0] & { prompt?: Mock } = {},
): SubmitHarness {
	const mode: SubmitHarness = {
		...createPromptStashHarness(options),
		defaultEditor: {},
		uiServices: { settingsManager: { getTelemetryEnabled: vi.fn(() => false) } },
		sideQuestionContainer: { clear: vi.fn() },
		isAgentCompacting: () => false,
		isAgentStreaming: () => false,
		flushPendingBashComponents: vi.fn(),
		onInputCallback: vi.fn(),
		clearSideQuestion: vi.fn(),
		collectImagesFor: vi.fn(() => []),
		agentConnection: { prompt: options.prompt ?? vi.fn(async () => {}) },
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		showError: vi.fn(),
		submittedInputBehavior: "steer",
		inputSubmissionGeneration: 0,
		inputSubmissionsPending: 0,
		pendingPromptStashReleases: [],
		retainedSubmissionGenerations: new WeakMap(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	interactiveModeMethods.setupEditorSubmitHandler.call(mode);
	return mode;
}

function createSharedPromptStashHarness(
	store: ClientPromptStashStore,
	sessionId: string,
	options: {
		text?: string;
		expandedText?: string;
		pasteSnapshot?: FakePasteSnapshot;
		pastedImages?: readonly (readonly [number, ImageContent])[];
	} = {},
): SharedPromptStashHarness {
	const harness = {
		promptStashStore: store,
		promptStashSessionId: sessionId,
		promptStashState: store.forSession(sessionId),
		pendingPromptStashReleases: [],
		editor: createEditor(options),
		showStatus: vi.fn(),
		clearShortcutGuide: vi.fn(),
		pastedImages: new Map(options.pastedImages),
		nextImageMarkerId: 1,
	} as SharedPromptStashHarness;
	Object.setPrototypeOf(harness, InteractiveMode.prototype);
	return harness;
}

describe("InteractiveMode prompt stash", () => {
	it("uses Ctrl+S as the default configurable stash keybinding", () => {
		const keybindings = new KeybindingsManager();

		expect(keybindings.getKeys("app.prompt.stash")).toEqual(["ctrl+s"]);
	});

	it("isolates stashes for separate TUI clients attached to the same session", () => {
		const firstClient = new ClientPromptStashStore();
		const secondClient = new ClientPromptStashStore();
		const firstState = firstClient.forSession("shared-session");
		firstState.stash = { text: "first client draft" };

		expect(firstClient.forSession("shared-session")).toBe(firstState);
		expect(secondClient.forSession("shared-session").stash).toBeUndefined();

		const emptyState = firstClient.forSession("empty-session");
		firstClient.release("empty-session", emptyState);
		expect(firstClient.forSession("empty-session")).not.toBe(emptyState);
	});

	it("restores a session stash after recreating its interactive mode", () => {
		const store = new ClientPromptStashStore();
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		const firstMode = createSharedPromptStashHarness(store, "session-a", {
			text: "draft [image #7] [paste #1 +2 lines]",
			expandedText: "draft [image #7] line one\nline two",
			pasteSnapshot,
			pastedImages: [[7, image]],
		});

		interactiveModeMethods.handlePromptStash.call(firstMode);

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		interactiveModeMethods.hydratePromptStash.call(reopenedMode);

		expect(reopenedMode.promptStash?.text).toBe("draft [image #7] [paste #1 +2 lines]");
		expect(reopenedMode.pastedImages.get(7)).toBe(image);
		expect(reopenedMode.nextImageMarkerId).toBe(8);

		interactiveModeMethods.restorePromptStashIfEditorEmpty.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("draft [image #7] [paste #1 +2 lines]");
		expect(reopenedMode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
		expect(reopenedMode.promptStashState.stash).toBeUndefined();
	});

	it("restores retained startup image drafts in order and resubmits each image exactly once", async () => {
		const store = new ClientPromptStashStore();
		const state = store.forSession("session-a");
		const firstImage: ImageContent = { type: "image", data: "first", mimeType: "image/png" };
		const secondImage: ImageContent = { type: "image", data: "second", mimeType: "image/jpeg" };
		state.stash = { text: "first [image #2]", images: [[2, firstImage]] };
		state.queuedStashes = [{ text: "second [image #3]", images: [[3, secondImage]] }];
		const mode = createSharedPromptStashHarness(store, "session-a", {
			pastedImages: [[1, { type: "image", data: "existing", mimeType: "image/png" }]],
		});
		interactiveModeMethods.hydratePromptStash.call(mode);
		const submitted: Array<{ text: string; images: ImageContent[] }> = [];

		for (let index = 0; index < 2; index++) {
			expect(interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode)).toBe(true);
			const text = mode.editor.getText();
			const ids = [...text.matchAll(/\[image #(\d+)\]/g)].map((match) => Number(match[1]));
			submitted.push({
				text,
				images: ids.flatMap((id) => (mode.pastedImages.get(id) ? [mode.pastedImages.get(id)!] : [])),
			});
			mode.editor.setText("");
		}

		expect(submitted).toEqual([
			{ text: "first [image #2]", images: [firstImage] },
			{ text: "second [image #3]", images: [secondImage] },
		]);
		expect(mode.pastedImages.get(1)?.data).toBe("existing");
		expect(mode.nextImageMarkerId).toBe(4);
		expect(state.stash).toBeUndefined();
		expect(state.queuedStashes).toBeUndefined();
	});

	it("auto-stashes a draft for the agents view and restores it on reopen", () => {
		const store = new ClientPromptStashStore();
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const mode = createSharedPromptStashHarness(store, "session-a", {
			text: "draft [paste #1 +2 lines]",
			expandedText: "draft line one\nline two",
			pasteSnapshot,
		});

		interactiveModeMethods.stashDraftForAgentsView.call(mode);

		expect(mode.promptStashState.stash).toMatchObject({
			text: "draft [paste #1 +2 lines]",
			restoreOnOpen: true,
		});

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		interactiveModeMethods.hydratePromptStash.call(reopenedMode);
		interactiveModeMethods.restorePromptStashOnOpen.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("draft [paste #1 +2 lines]");
		expect(reopenedMode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
		expect(reopenedMode.promptStashState.stash).toBeUndefined();
	});

	it("lands the on-open restore notice in a fresh status block", () => {
		const store = new ClientPromptStashStore();
		const mode = createSharedPromptStashHarness(store, "session-a", { text: "draft" });
		interactiveModeMethods.stashDraftForAgentsView.call(mode);

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		// init() may have just posted a status (e.g. a compaction notice); showStatus
		// replaces the anchored last status, so the restore must drop the anchor first.
		const priorStatus = { setText: vi.fn() };
		(reopenedMode as { lastStatusText?: unknown }).lastStatusText = priorStatus;
		(reopenedMode as { lastStatusSpacer?: unknown }).lastStatusSpacer = { spacer: true };
		interactiveModeMethods.restorePromptStashOnOpen.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("draft");
		expect((reopenedMode as { lastStatusText?: unknown }).lastStatusText).toBeUndefined();
		expect((reopenedMode as { lastStatusSpacer?: unknown }).lastStatusSpacer).toBeUndefined();
		expect(priorStatus.setText).not.toHaveBeenCalled();
	});

	it("queues an existing manual stash behind the agents-view auto-stash", () => {
		const store = new ClientPromptStashStore();
		const state = store.forSession("session-a");
		state.stash = { text: "manual draft" };
		const mode = createSharedPromptStashHarness(store, "session-a", { text: "typed draft" });

		interactiveModeMethods.stashDraftForAgentsView.call(mode);

		expect(state.stash).toMatchObject({ text: "typed draft", restoreOnOpen: true });
		expect(state.queuedStashes).toEqual([{ text: "manual draft" }]);

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		interactiveModeMethods.restorePromptStashOnOpen.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("typed draft");
		expect(state.stash).toEqual({ text: "manual draft" });
		expect(state.queuedStashes).toBeUndefined();
	});

	it("skips the agents-view auto-stash for whitespace-only drafts", () => {
		const store = new ClientPromptStashStore();
		const state = store.forSession("session-a");
		state.stash = { text: "manual draft" };
		const mode = createSharedPromptStashHarness(store, "session-a", { text: "   \n\t" });

		interactiveModeMethods.stashDraftForAgentsView.call(mode);

		expect(state.stash).toEqual({ text: "manual draft" });
		expect(state.queuedStashes).toBeUndefined();
	});

	it("does not auto-restore a manual stash on reopen", () => {
		const store = new ClientPromptStashStore();
		store.forSession("session-a").stash = { text: "manual draft" };

		const reopenedMode = createSharedPromptStashHarness(store, "session-a");
		interactiveModeMethods.restorePromptStashOnOpen.call(reopenedMode);

		expect(reopenedMode.editor.getText()).toBe("");
		expect(store.forSession("session-a").stash).toEqual({ text: "manual draft" });
	});

	it("rebinds prompt stash state when the connected session changes", () => {
		const store = new ClientPromptStashStore();
		const firstState = store.forSession("session-a");
		const secondState = store.forSession("session-b");
		firstState.stash = { text: "session a draft" };
		secondState.stash = { text: "session b draft" };
		const mode = createSharedPromptStashHarness(store, "session-a");

		interactiveModeMethods.bindPromptStashSession.call(mode, "session-b");

		expect(mode.promptStash?.text).toBe("session b draft");
		expect(firstState.stash?.text).toBe("session a draft");
	});

	it("stashes editor text without expanding paste markers", () => {
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const mode = createPromptStashHarness({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toEqual({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).toHaveBeenCalledWith("Stashed prompt");

		interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode);

		expect(mode.editor.getText()).toBe("[paste #1 +12 lines]");
		expect(mode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
	});

	it("restores expanded paste text when paste snapshots are unsupported", () => {
		const pasteSnapshot: FakePasteSnapshot = {
			pastes: [[1, "line one\nline two"]],
			pasteCounter: 1,
		};
		const mode = createPromptStashHarness({
			text: "[paste #1 +12 lines]",
			expandedText: "line one\nline two",
			pasteSnapshot,
		});

		interactiveModeMethods.handlePromptStash.call(mode);
		mode.editor.restorePasteSnapshot = undefined;

		const restored = interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode);

		expect(restored).toBe(true);
		expect(mode.editor.getText()).toBe("line one\nline two");
		expect(mode.editor.restoredPasteSnapshot).toBeUndefined();
	});

	it("restores a stashed prompt when the editor is empty", () => {
		const mode = createPromptStashHarness({ stash: "half-written draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Restored stashed prompt");
	});

	it("does not restore an older captured stash after a newer stash is created", () => {
		const mode = createPromptStashHarness({ stash: "older draft" });
		const olderStash = mode.promptStash;
		const newerStash = { text: "newer draft" };
		mode.promptStash = newerStash;

		const restored = interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode, olderStash);

		expect(restored).toBe(false);
		expect(mode.promptStash).toBe(newerStash);
		expect(mode.editor.getText()).toBe("");
		expect(mode.showStatus).not.toHaveBeenCalledWith("Restored stashed prompt");
	});

	it("restores both rich lifecycle-retained drafts in submission order", () => {
		const store = new ClientPromptStashStore();
		const mode = createSharedPromptStashHarness(store, "session-a");
		const firstPaste: FakePasteSnapshot = { pastes: [[1, "first expanded"]], pasteCounter: 1 };
		const secondPaste: FakePasteSnapshot = { pastes: [[2, "second expanded"]], pasteCounter: 2 };
		mode.promptStashState.stash = {
			text: "first [paste #1] [image #7]",
			expandedText: "first expanded [image #7]",
			pasteSnapshot: firstPaste,
		};
		mode.promptStashState.queuedStashes = [
			{
				text: "second [paste #2] [image #8]",
				expandedText: "second expanded [image #8]",
				pasteSnapshot: secondPaste,
			},
		];

		expect(interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode)).toBe(true);
		expect(mode.editor.getText()).toBe("first [paste #1] [image #7]");
		expect(mode.editor.restoredPasteSnapshot).toBe(firstPaste);

		mode.editor.setText("");
		expect(interactiveModeMethods.restorePromptStashIfEditorEmpty.call(mode)).toBe(true);
		expect(mode.editor.getText()).toBe("second [paste #2] [image #8]");
		expect(mode.editor.restoredPasteSnapshot).toBe(secondPaste);
		expect(mode.promptStashState.stash).toBeUndefined();
		expect(mode.promptStashState.queuedStashes).toBeUndefined();
	});

	it("does not overwrite an existing stash", () => {
		const mode = createPromptStashHarness({ text: "second draft", stash: "first draft" });

		interactiveModeMethods.handlePromptStash.call(mode);

		expect(mode.promptStash?.text).toBe("first draft");
		expect(mode.editor.getText()).toBe("second draft");
		expect(mode.showStatus).toHaveBeenCalledWith("Prompt stash already has a draft");
	});

	it("restores a stashed prompt after normal message submission clears the editor", async () => {
		const mode = createSubmitHarness({ stash: "half-written draft" });

		await mode.defaultEditor.onSubmit?.("temporary prompt");

		expect(mode.agentConnection.prompt).toHaveBeenCalledWith("temporary prompt", {
			streamingBehavior: "steer",
			queueIfBusy: true,
			images: [],
		});
		expect(mode.editor.addToHistory).toHaveBeenCalledWith("temporary prompt");
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("routes session-owned commands through canonical prompt admission", async () => {
		const mode = Object.assign(createSubmitHarness(), { isAgentCompacting: () => true });

		for (const command of ["/compact focus on tools", "/refine --global", "/goal ship it", "/autonomous on"]) {
			await mode.defaultEditor.onSubmit?.(command);
		}

		for (const command of ["/compact focus on tools", "/refine --global", "/goal ship it", "/autonomous on"]) {
			expect(mode.agentConnection.prompt).toHaveBeenCalledWith(command, {
				streamingBehavior: "steer",
				queueIfBusy: true,
				images: [],
			});
		}
	});

	it("restores a stashed prompt after a session reset clears prompt state", async () => {
		const mode = Object.assign(createSubmitHarness({ stash: "half-written draft" }), {
			handleClearCommand: vi.fn(async () => {
				mode.editor.setText("");
			}),
		});

		await mode.defaultEditor.onSubmit?.("/new");

		expect(mode.handleClearCommand).toHaveBeenCalled();
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("waits for async session selectors before restoring a stashed prompt", async () => {
		const selector = createDeferred();
		const mode = Object.assign(createSubmitHarness({ stash: "half-written draft" }), {
			showUserMessageSelector: vi.fn(async () => {
				await selector.promise;
				mode.editor.setText("");
			}),
		});

		const submit = mode.defaultEditor.onSubmit?.("/fork");
		await Promise.resolve();
		selector.resolve();
		await submit;

		expect(mode.showUserMessageSelector).toHaveBeenCalled();
		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("owns Alt+Enter /settings locally while preserving the stashed prompt", async () => {
		const settings = createDeferred();
		const admitPendingStartupPrompts = vi.fn(() => new Promise<void>(() => {}));
		const mode = Object.assign(createSubmitHarness({ text: "/settings", stash: "half-written draft" }), {
			admitPendingStartupPrompts,
			showSettingsSelector: vi.fn(() => settings.promise),
		});
		mode.editor.onSubmit = mode.defaultEditor.onSubmit;

		const followUp = interactiveModeMethods.handleFollowUp.call(mode);
		expect(mode.editor.getText()).toBe("");
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(mode.showSettingsSelector).toHaveBeenCalledOnce();
		await interactiveModeMethods.handleFollowUp.call(mode);
		expect(mode.showSettingsSelector).toHaveBeenCalledOnce();
		expect(admitPendingStartupPrompts).not.toHaveBeenCalled();

		settings.resolve();
		await followUp;

		expect(mode.promptStash).toBeUndefined();
		expect(mode.editor.getText()).toBe("half-written draft");
	});

	it("drops queued image references from old sessions while keeping stashed images", () => {
		const base = createPromptStashHarness({ stash: "keep [image #1]" });
		const mode: ResetHarness = {
			...base,
			defaultEditor: base.editor,
			queueSelection: new QueueSelection(),
			connectionQueue: { steering: ["old [image #2]"], followUp: [] },
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pastedImages: new Map<number, unknown>([
				[1, {}],
				[2, {}],
			]),
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 1,
			agentRunFileChanges: new Map(),
			recapContainer: { clear: vi.fn() },
			ui: { requestRender: vi.fn() },
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			resetPendingToolState: vi.fn(),
			resetSubagentSummary: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => undefined),
			syncGoalTray: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		interactiveModeMethods.resetCurrentSessionRenderState.call(mode);

		expect(mode.connectionQueue).toEqual({ steering: [], followUp: [] });
		expect(mode.promptStash?.text).toBe("keep [image #1]");
		expect(mode.pastedImages.has(1)).toBe(true);
		expect(mode.pastedImages.has(2)).toBe(false);
	});

	it("clears stashed prompt state when explicitly requested", () => {
		const base = createPromptStashHarness({ stash: "drop [image #1]" });
		const mode: ResetHarness = {
			...base,
			defaultEditor: base.editor,
			queueSelection: new QueueSelection(),
			connectionQueue: { steering: [], followUp: [] },
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pastedImages: new Map<number, unknown>([[1, {}]]),
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 1,
			agentRunFileChanges: new Map(),
			recapContainer: { clear: vi.fn() },
			ui: { requestRender: vi.fn() },
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			resetPendingToolState: vi.fn(),
			resetSubagentSummary: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(() => undefined),
			syncGoalTray: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		interactiveModeMethods.resetCurrentSessionRenderState.call(mode, { clearPromptStash: true });

		expect(mode.promptStash).toBeUndefined();
		expect(mode.pastedImages.has(1)).toBe(false);
	});

	it("restores the exact rich draft after admission rejects", async () => {
		const pasteSnapshot: FakePasteSnapshot = { pastes: [[1, "expanded paste"]], pasteCounter: 1 };
		const mode = createSubmitHarness({
			text: "draft [paste #1]",
			expandedText: "draft expanded paste",
			pasteSnapshot,
			prompt: vi.fn(async () => {
				throw new Error("admission failed");
			}),
		});
		(mode as SubmitHarness & { latestEditorPromptStash: PromptStash }).latestEditorPromptStash = {
			text: "draft [paste #1]",
			expandedText: "draft expanded paste",
			pasteSnapshot,
		};
		mode.editor.setText("");

		await mode.defaultEditor.onSubmit?.("draft expanded paste");

		expect(mode.editor.getText()).toBe("draft [paste #1]");
		expect(mode.editor.restoredPasteSnapshot).toBe(pasteSnapshot);
	});

	it.each([
		{ newer: "draft and stash", stash: "older stash", firstError: "late rejection" },
		{ newer: "pending submission", stash: "stashed draft", firstError: undefined },
		{ newer: "accepted submission", stash: undefined, firstError: "late first rejection" },
	])("does not restore stale input over a newer $newer", async ({ newer, stash, firstError }) => {
		const first = createDeferred();
		const second = createDeferred();
		const prompt = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const mode = createSubmitHarness({ stash, prompt });
		const newerStash = { text: "newer stash" };

		const firstSubmission = mode.defaultEditor.onSubmit?.("first prompt");
		await Promise.resolve();
		const secondSubmission = newer === "draft and stash" ? undefined : mode.defaultEditor.onSubmit?.("second prompt");
		if (newer === "draft and stash") {
			mode.editor.setText("newer editor draft");
			mode.promptStash = newerStash;
		} else {
			await Promise.resolve();
		}
		if (newer === "accepted submission") {
			second.resolve();
			await secondSubmission;
		}
		if (firstError) first.reject(new Error(firstError));
		else first.resolve();
		await firstSubmission;

		if (firstError) expect(mode.showError).toHaveBeenCalledWith(firstError);
		if (newer === "draft and stash") {
			expect(mode.editor.getText()).toBe("newer editor draft");
			expect(mode.promptStash).toBe(newerStash);
			return;
		}
		expect(mode.editor.getText()).toBe("");
		if (newer === "pending submission") {
			// The stash restores only once the newest pending submission is accepted.
			expect(mode.promptStash?.text).toBe("stashed draft");
			second.resolve();
			await secondSubmission;
			expect(mode.editor.getText()).toBe("stashed draft");
			expect(mode.promptStash).toBeUndefined();
		} else {
			expect(mode.promptStash).toEqual({ text: "first prompt" });
		}
	});

	it.each(["typing", "submission"] as const)(
		"does not restore an older failed Alt+Enter over newer %s",
		async (newerInput) => {
			const first = createDeferred();
			const prompt = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
			const mode = createSubmitHarness({ text: "stale follow-up", prompt });
			mode.editor.onSubmit = mode.defaultEditor.onSubmit;

			const firstSubmission = interactiveModeMethods.handleFollowUp.call(mode);
			mode.editor.setText("newer input");
			if (newerInput === "submission") await mode.defaultEditor.onSubmit?.("newer input");
			first.reject(new Error("late follow-up rejection"));
			await firstSubmission;

			expect(mode.editor.getText()).toBe(newerInput === "typing" ? "newer input" : "");
			expect(mode.showError).toHaveBeenCalledWith("late follow-up rejection");
		},
	);

	it("restores failed follow-up text without dropping the stashed prompt", async () => {
		const mode = Object.assign(
			createSubmitHarness({
				text: "quick follow-up",
				stash: "half-written draft",
				prompt: vi.fn(async () => {
					throw new Error("send failed");
				}),
			}),
			{ isAgentStreaming: () => true },
		);
		mode.editor.onSubmit = mode.defaultEditor.onSubmit;

		await expect(interactiveModeMethods.handleFollowUp.call(mode)).resolves.toBeUndefined();

		expect(mode.agentConnection.prompt).toHaveBeenCalledWith("quick follow-up", {
			streamingBehavior: "followUp",
			queueIfBusy: true,
			images: [],
		});
		expect(mode.showError).toHaveBeenCalledWith("send failed");
		expect(mode.editor.getText()).toBe("quick follow-up");
		expect(mode.promptStash?.text).toBe("half-written draft");
	});

	it("keeps image markers in a stashed prompt live", () => {
		const mode: PromptStashLiveMarkerHarness = {
			...createPromptStashHarness({ stash: "look at [image #7]" }),
			connectionQueue: { steering: [], followUp: [] },
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		expect(interactiveModeMethods.liveImageMarkerIds.call(mode)).toEqual(new Set([7]));
	});
});
