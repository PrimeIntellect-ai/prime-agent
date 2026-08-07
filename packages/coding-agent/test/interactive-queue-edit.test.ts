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
