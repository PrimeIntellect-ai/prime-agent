import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type Harness = {
	queueSelection: QueueSelection;
	connectionQueue: { steering: string[]; followUp: string[] };
	editor: { getText: () => string; setText: (text: string) => void; addToHistory?: (text: string) => void };
	isApplyingQueueSelectionText: boolean;
	pastedImages: Map<number, unknown>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	agentConnection: { mutateQueuedMessage: ReturnType<typeof vi.fn>; abort?: ReturnType<typeof vi.fn> };
	queueMutationChain: Promise<void>;
	enqueueQueueMutation: <T>(run: () => Promise<T>) => Promise<T>;
	applyQueueSelection: (text: string, targetLane: "steering" | "followUp") => Promise<boolean>;
	browseQueueSelection: (direction: -1 | 1) => void;
	moveQueueSelection: (direction: -1 | 1) => void;
	setEditorTextFromQueueSelection: (text: string) => void;
	collectQueueReplaceImages: (text: string) => unknown;
};

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function createHarness(queue: { steering: string[]; followUp: string[] }, mutateResult = "applied"): Harness {
	let editorText = "";
	const harness = {
		queueSelection: new QueueSelection(),
		connectionQueue: queue,
		editor: {
			getText: () => editorText,
			setText: (text: string) => {
				editorText = text;
			},
			addToHistory: vi.fn(),
		},
		isApplyingQueueSelectionText: false,
		pastedImages: new Map(),
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		agentConnection: { mutateQueuedMessage: vi.fn(async () => mutateResult), abort: vi.fn(async () => {}) },
		queueMutationChain: Promise.resolve(),
		enqueueQueueMutation: proto.enqueueQueueMutation,
		applyQueueSelection: proto.applyQueueSelection,
		browseQueueSelection: proto.browseQueueSelection,
		moveQueueSelection: proto.moveQueueSelection,
		setEditorTextFromQueueSelection: proto.setEditorTextFromQueueSelection,
		collectQueueReplaceImages: proto.collectQueueReplaceImages,
	} as unknown as Harness;
	return harness;
}

describe("interactive queued-message editing", () => {
	it("browses into the queue and applies an enter edit as steering", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: ["f1"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("f1");

		const consumed = await harness.applyQueueSelection("f1 edited", "steering");
		expect(consumed).toBe(true);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "f1", {
			type: "replace",
			text: "f1 edited",
			images: [],
			lane: "steering",
		});
		expect(harness.editor.getText()).toBe("draft"); // draft restored after apply
		expect(harness.editor.addToHistory).toHaveBeenCalledWith("f1 edited");
	});

	it("applies an alt+enter edit to the follow-up lane and deletes on empty text", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("kept follow-up", "followUp");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("steering", 0, "s1", {
			type: "replace",
			text: "kept follow-up",
			images: [],
			lane: "followUp",
		});

		harness.connectionQueue = { steering: ["s1"], followUp: [] };
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("   ", "steering");
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenLastCalledWith("steering", 0, "s1", {
			type: "delete",
		});
	});

	it("restores the edited text when the mutation is rejected after enter cleared the editor", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] }, "rejected");
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Editor.submitValue clears before onSubmit runs.
		await harness.applyQueueSelection("s1 edited", "steering");
		expect(harness.editor.getText()).toBe("s1 edited");
		expect(harness.showStatus).toHaveBeenCalledWith("Queue changed; edit kept in the editor");
	});

	it("reports when the daemon does not support queue editing", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] }, "unsupported");
		harness.browseQueueSelection(-1);
		await harness.applyQueueSelection("s1 edited", "steering");
		expect(harness.showStatus).toHaveBeenCalledWith("Queue editing requires a newer daemon");
	});

	it("does not consume submissions when nothing is selected", async () => {
		const harness = createHarness({ steering: [], followUp: [] });
		expect(await harness.applyQueueSelection("new prompt", "steering")).toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("moves the selected item within its lane", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() =>
			expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("steering", 1, "s2", {
				type: "move",
				direction: -1,
			}),
		);
	});

	it("does not clobber typing that happened while the mutation was in flight", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Enter cleared the editor
		const pending = harness.applyQueueSelection("s1 edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());
		harness.editor.setText("newer typing");
		resolveMutation("rejected");
		await pending;
		expect(harness.editor.getText()).toBe("newer typing");
	});

	it("serializes rapid moves and addresses the second with the post-move index before any queue event", async () => {
		// The daemon's session_action_update can arrive after the mutation response,
		// so the local mirror must be updated optimistically between chained moves.
		const harness = createHarness({ steering: ["s1", "s2", "s3"], followUp: [] });
		harness.browseQueueSelection(-1); // s3 at index 2
		harness.moveQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(1, "steering", 2, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(2, "steering", 1, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.connectionQueue.steering).toEqual(["s3", "s1", "s2"]);
	});

	it("optimistically updates the local queue mirror on replace and delete", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: ["f1"] });
		harness.browseQueueSelection(-1); // f1
		await harness.applyQueueSelection("f1 edited", "followUp");
		// An immediate browse must see the new text before the queue event arrives.
		expect(harness.connectionQueue).toEqual({ steering: ["s1", "s2"], followUp: ["f1 edited"] });

		harness.browseQueueSelection(-1); // f1 edited
		await harness.applyQueueSelection("   ", "followUp");
		expect(harness.connectionQueue).toEqual({ steering: ["s1", "s2"], followUp: [] });
	});

	it("moves the item across lanes in the local mirror on a lane-changing replace", async () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.browseQueueSelection(-1); // s1
		await harness.applyQueueSelection("now follow-up", "followUp");
		expect(harness.connectionQueue).toEqual({ steering: [], followUp: ["now follow-up"] });
	});

	it("restores the stashed draft when the browsed item is consumed externally", () => {
		const harness = createHarness({ steering: [], followUp: ["f1"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("f1");
		// The item is delivered: the queue update drops the selection.
		harness.connectionQueue = { steering: [], followUp: [] };
		const dropped = harness.queueSelection.sync(harness.connectionQueue);
		expect(dropped).toBe("f1");
		if (dropped !== undefined && harness.editor.getText() === dropped) {
			harness.setEditorTextFromQueueSelection(harness.queueSelection.reset());
		}
		expect(harness.editor.getText()).toBe("draft");
	});

	it("deduplicates repeated image markers in a replace", () => {
		const harness = createHarness({ steering: [], followUp: [] });
		harness.pastedImages.set(1, { type: "image", data: "a", mimeType: "image/png" });
		expect(harness.collectQueueReplaceImages("[image #1] and again [image #1]")).toEqual([
			{ type: "image", data: "a", mimeType: "image/png" },
		]);
	});
});

describe("session switches reset queue browsing", () => {
	it("clears the selection and stashed draft when session render state resets", () => {
		const harness = createHarness({ steering: ["s1"], followUp: [] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		expect(harness.queueSelection.isBrowsing).toBe(true);

		const editorStub = { clearHistory: vi.fn(), setText: vi.fn(), getText: () => "" };
		const fakeThis = {
			queueSelection: harness.queueSelection,
			connectionQueue: harness.connectionQueue,
			endFeatureHintRun: vi.fn(),
			chatContainer: { clear: vi.fn() },
			shortcutGuideContainer: { clear: vi.fn() },
			pendingMessagesContainer: { clear: vi.fn() },
			queuedMessagesContainer: { clear: vi.fn() },
			pastedImages: new Map(),
			liveImageMarkerIds: () => new Set(),
			defaultEditor: editorStub,
			editor: editorStub,
			streamingComponent: undefined,
			streamingMessage: undefined,
			activeBashComponent: undefined,
			pendingBashComponents: [],
			activityTracker: { reset: vi.fn() },
			contextUsageTokenBaseline: 0,
			resetPendingToolState: vi.fn(),
			agentRunFileChanges: new Map(),
			renderRecap: vi.fn(),
			ipythonToolComponents: new Map(),
			lateIpythonSentAgentMessages: new Map(),
			resetSubagentSummary: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			syncGoalTray: vi.fn(),
			getGoalState: () => undefined,
		};
		(proto.resetCurrentSessionRenderState as (this: unknown) => void).call(fakeThis);

		// The next Enter in the new session must be a fresh prompt, never a
		// mutation addressed at the previous session's queue.
		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.queueSelection.reset()).toBe("");
	});
});

describe("interactive interrupt preserves the queue", () => {
	it("aborts without clearing or restoring queued messages", () => {
		const abort = vi.fn(async () => {});
		const harness = {
			traceUploadAllAbortController: undefined,
			sideQuestionEvent: undefined,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => true,
			agentConnection: { abort },
			showError: vi.fn(),
			editor: { getText: () => "", setText: vi.fn() },
		};
		(proto.interruptOrClearInput as (this: unknown) => void).call(harness);
		expect(abort).toHaveBeenCalledOnce();
		expect(harness.editor.setText).not.toHaveBeenCalled();
	});
});
