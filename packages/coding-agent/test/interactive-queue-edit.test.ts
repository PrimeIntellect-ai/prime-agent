import { describe, expect, it, vi } from "vitest";
import type { QueuedMessageMutation } from "../src/core/session-action-store.js";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { QueueSelection } from "../src/modes/interactive/queue-selection.js";

type QueueState = { steering: string[]; followUp: string[] };

type Harness = {
	queueSelection: QueueSelection;
	connectionState: {
		sessionActions: {
			queuedCount: number;
			steering: readonly string[];
			followUps: readonly string[];
		};
	};
	editor: { getText: () => string; setText: (text: string) => void; addToHistory?: (text: string) => void };
	isApplyingQueueSelectionText: boolean;
	pastedImages: Map<number, unknown>;
	updatePendingMessagesDisplay: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	agentConnection: {
		mutateQueuedMessage: ReturnType<typeof vi.fn>;
		abort?: ReturnType<typeof vi.fn>;
	};
	sessionEventGeneration: number;
	sessionEventQueue: Promise<void>;
	inputSubmissionGeneration: number;
	pendingQueueEdit: symbol | undefined;
	pendingQueueMove: boolean;
	queueMutationChain: Promise<void>;
	enqueueQueueMutation: <T>(run: () => Promise<T>) => Promise<T>;
	applyQueueSelection: (text: string, targetLane: "steering" | "followUp") => Promise<boolean>;
	browseQueueSelection: (direction: -1 | 1) => void;
	moveQueueSelection: (direction: -1 | 1) => void;
	getConnectionQueue: () => QueueState;
	refreshQueueSelectionAt: (
		queue: QueueState,
		selected: { lane: "steering" | "followUp"; index: number; text: string },
		index: number,
	) => void;
	refreshQueueSelectionFromState: () => void;
	updateConnectionStateFromEvent: (event: AgentConnectionSessionEvent) => void;
	patchConnectionState: (patch: Partial<Harness["connectionState"]>) => void;
	setEditorTextFromQueueSelection: (text: string) => void;
	collectQueueReplaceImages: (text: string) => unknown;
};

const proto = InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;

function createHarness(queue: { steering: string[]; followUp: string[] }, mutateResult = "applied"): Harness {
	let editorText = "";
	const harness = {
		queueSelection: new QueueSelection(),
		connectionState: {
			sessionActions: {
				queuedCount: queue.steering.length + queue.followUp.length,
				steering: queue.steering,
				followUps: queue.followUp,
			},
		},
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
		agentConnection: {
			mutateQueuedMessage: vi.fn(async () => mutateResult),
			abort: vi.fn(async () => {}),
		},
		sessionEventGeneration: 0,
		sessionEventQueue: Promise.resolve(),
		inputSubmissionGeneration: 0,
		pendingQueueEdit: undefined,
		pendingQueueMove: false,
		queueMutationChain: Promise.resolve(),
		enqueueQueueMutation: proto.enqueueQueueMutation,
		applyQueueSelection: proto.applyQueueSelection,
		browseQueueSelection: proto.browseQueueSelection,
		moveQueueSelection: proto.moveQueueSelection,
		getConnectionQueue: proto.getConnectionQueue,
		refreshQueueSelectionAt: proto.refreshQueueSelectionAt,
		refreshQueueSelectionFromState: proto.refreshQueueSelectionFromState,
		updateConnectionStateFromEvent: proto.updateConnectionStateFromEvent,
		patchConnectionState: () => {},
		setEditorTextFromQueueSelection: proto.setEditorTextFromQueueSelection,
		collectQueueReplaceImages: proto.collectQueueReplaceImages,
	} as unknown as Harness;
	harness.patchConnectionState = (patch) => {
		harness.connectionState = { ...harness.connectionState, ...patch };
	};
	return harness;
}

function setQueue(harness: Harness, queue: QueueState): void {
	harness.connectionState.sessionActions = {
		...harness.connectionState.sessionActions,
		queuedCount: queue.steering.length + queue.followUp.length,
		steering: queue.steering,
		followUps: queue.followUp,
	};
}

function emitQueueUpdate(harness: Harness, queue: QueueState): void {
	harness.updateConnectionStateFromEvent({
		type: "session_action_update",
		actions: {
			queuedCount: queue.steering.length + queue.followUp.length,
			steering: queue.steering,
			followUps: queue.followUp,
		},
	});
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

		setQueue(harness, { steering: ["s1"], followUp: [] });
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

	it.each([
		["replace", "queued edited"],
		["delete", "   "],
	])("restores the stashed draft when a %s queue event lands before the response", async (_operation, text) => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection(text, "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		setQueue(harness, {
			steering: text.trim() ? [text.trim()] : [],
			followUp: [],
		});
		resolveMutation("applied");
		await pending;

		expect(harness.editor.getText()).toBe("draft");
	});

	it("routes another submission as new while a queue edit is pending", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("edited", "steering");
		expect(harness.queueSelection.isBrowsing).toBe(true);
		await expect(harness.applyQueueSelection("new prompt", "steering")).resolves.toBe(false);
		harness.inputSubmissionGeneration++;
		harness.editor.setText("");
		resolveMutation("applied");
		await pending;
		expect(harness.editor.getText()).toBe("");
	});

	it.each(["rejected", "invalid", "unsupported"])(
		"keeps the selection and stashed draft when a queue edit is %s",
		async (status) => {
			const harness = createHarness({ steering: ["queued"], followUp: [] }, status);
			harness.editor.setText("draft");
			harness.browseQueueSelection(-1);
			harness.editor.setText("");

			await harness.applyQueueSelection("edited", "steering");

			expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
			expect(harness.queueSelection.hasDraft).toBe(true);
			expect(harness.editor.getText()).toBe("edited");
		},
	);

	it("keeps the selection and stashed draft when a queue edit request fails", async () => {
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockRejectedValue(new Error("connection lost"));
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");

		await expect(harness.applyQueueSelection("edited", "steering")).rejects.toThrow("connection lost");

		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
		expect(harness.queueSelection.hasDraft).toBe(true);
		expect(harness.editor.getText()).toBe("edited");
	});

	it("does not reset queue browsing in a replacement session when an old mutation completes", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["old queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("old draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Enter cleared the old session's editor.
		const pending = harness.applyQueueSelection("old edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalled());

		// A session replacement resets queue state, then the user starts browsing
		// the replacement session before the old daemon response arrives.
		harness.sessionEventGeneration++;
		harness.pendingQueueEdit = undefined;
		harness.queueSelection.reset();
		setQueue(harness, { steering: ["new queued"], followUp: [] });
		harness.editor.setText("new draft");
		harness.browseQueueSelection(-1);

		resolveMutation("applied");
		await pending;
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "new queued" });
		expect(harness.editor.getText()).toBe("new queued");
	});

	it("discards an old queue selection when the session changes before its mutation completes", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["old queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("old edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		// session_replaced advances the generation before its queued render reset.
		harness.sessionEventGeneration++;
		resolveMutation("applied");
		await pending;

		expect(harness.pendingQueueEdit).toBeUndefined();
		expect(harness.queueSelection.isBrowsing).toBe(false);
		await expect(harness.applyQueueSelection("new session prompt", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
	});

	it("exits browsing when an external event removes the selected item", async () => {
		const harness = createHarness({ steering: [], followUp: ["queued"] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);

		emitQueueUpdate(harness, { steering: [], followUp: [] });

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
		await expect(harness.applyQueueSelection("draft", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
	});

	it("refreshes browse navigation from external queue events", () => {
		const harness = createHarness({ steering: ["s1"], followUp: ["f1", "f2"] });
		harness.browseQueueSelection(-1);

		emitQueueUpdate(harness, { steering: ["s1"], followUp: ["f0", "f2", "f3"] });
		harness.browseQueueSelection(-1);

		expect(harness.editor.getText()).toBe("f0");
	});

	it("refreshes selection from event-driven queue state after a move", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s2", "s1"], followUp: [] });
			return "applied";
		});
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.getConnectionQueue()).toEqual({ steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
	});

	it("leaves browse mode when the moved tuple is absent from the event snapshot", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "applied";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("refreshes selection after a failed move suppresses an external event", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] }, "rejected");
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "rejected";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("draft");
	});

	it("keeps a chained edit when the preceding move loses its selection", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
			emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
			return "applied";
		});
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		harness.editor.setText("");
		await harness.applyQueueSelection("s2 edited", "steering");

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
		expect(harness.editor.getText()).toBe("s2 edited");
		expect(harness.showStatus).toHaveBeenCalledWith("Queue changed; edit kept in the editor");
	});

	it("uses canonical post-move positions for consecutive moves and an edit", async () => {
		const queue = ["s1", "s2", "s3"];
		const harness = createHarness({ steering: queue, followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			async (
				_lane: "steering" | "followUp",
				index: number,
				expectedText: string,
				mutation: QueuedMessageMutation,
			) => {
				const item = queue[index];
				if (item !== expectedText) return "rejected";
				if (mutation.type === "move") {
					const target = index + mutation.direction;
					const neighbor = queue[target];
					if (neighbor === undefined) return "rejected";
					queue[index] = neighbor;
					queue[target] = item;
				} else if (mutation.type === "replace") {
					queue[index] = mutation.text;
				}
				emitQueueUpdate(harness, { steering: [...queue], followUp: [] });
				return "applied";
			},
		);
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		harness.moveQueueSelection(-1);
		const edited = harness.applyQueueSelection("s3 edited", "steering");
		await edited;

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(1, "steering", 2, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(2, "steering", 1, "s3", {
			type: "move",
			direction: -1,
		});
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenNthCalledWith(3, "steering", 0, "s3", {
			type: "replace",
			text: "s3 edited",
			images: [],
			lane: "steering",
		});
		expect(harness.getConnectionQueue()).toEqual({ steering: ["s3 edited", "s1", "s2"], followUp: [] });
	});

	it("keeps the selected index when duplicate text shifts before an edit", async () => {
		let releaseMutationChain: () => void = () => {};
		const harness = createHarness({ steering: [], followUp: ["dup", "dup"] }, "rejected");
		harness.queueMutationChain = new Promise<void>((resolve) => {
			releaseMutationChain = resolve;
		});
		harness.browseQueueSelection(-1);
		const pending = harness.applyQueueSelection("edited", "followUp");
		setQueue(harness, { steering: [], followUp: ["dup"] });
		releaseMutationChain();
		await pending;

		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledWith("followUp", 1, "dup", {
			type: "replace",
			text: "edited",
			images: [],
			lane: "followUp",
		});
	});

	it("ignores browse keys while a queue move is pending", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe("s2");

		resolveMutation("applied");
		await harness.queueMutationChain;
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
	});

	it("keeps the moved selection when the queue event lands after the response", async () => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.getConnectionQueue()).toEqual({ steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });

		emitQueueUpdate(harness, { steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
		expect(harness.editor.getText()).toBe("s2");
	});

	it("drops a stale selection after a rejected edit so enter returns to normal submission", async () => {
		let resolveMutation: (status: string) => void = () => {};
		const harness = createHarness({ steering: ["queued"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveMutation = resolve;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText("");
		const pending = harness.applyQueueSelection("edited", "steering");
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		// The item is consumed while the edit is pending; event reconciliation is suppressed.
		emitQueueUpdate(harness, { steering: [], followUp: [] });
		resolveMutation("rejected");
		await pending;

		expect(harness.queueSelection.isBrowsing).toBe(false);
		expect(harness.editor.getText()).toBe("edited");
		await expect(harness.applyQueueSelection("edited", "steering")).resolves.toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce();
	});

	it("drops a stale selection when a move request fails after the item was consumed", async () => {
		let rejectMutation: (error: Error) => void = () => {};
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] });
		harness.agentConnection.mutateQueuedMessage.mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectMutation = reject;
				}),
		);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await vi.waitFor(() => expect(harness.agentConnection.mutateQueuedMessage).toHaveBeenCalledOnce());

		emitQueueUpdate(harness, { steering: ["s1"], followUp: [] });
		rejectMutation(new Error("connection lost"));
		await vi.waitFor(() => expect(harness.showError).toHaveBeenCalledWith("connection lost"));

		expect(harness.queueSelection.isBrowsing).toBe(false);
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
