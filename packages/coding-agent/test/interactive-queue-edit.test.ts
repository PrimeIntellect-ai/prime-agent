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

	// [mutation status, status message] - a refused edit must never be lost.
	it.each([
		["rejected", "Queue changed; edit kept in the editor"],
		["unsupported", "Queue editing requires a newer daemon"],
	])("keeps the edit in the editor when the mutation is %s", async (status, message) => {
		const harness = createHarness({ steering: ["s1"], followUp: [] }, status);
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.editor.setText(""); // Editor.submitValue clears before onSubmit runs.

		await harness.applyQueueSelection("s1 edited", "steering");

		expect(harness.editor.getText()).toBe("s1 edited");
		expect(harness.showStatus).toHaveBeenCalledWith(message);
	});

	it("does not consume submissions when nothing is selected", async () => {
		const harness = createHarness({ steering: [], followUp: [] });
		expect(await harness.applyQueueSelection("new prompt", "steering")).toBe(false);
		expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
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

	// A refused or failed mutation keeps the selection armed and the draft stashed.
	it.each(["rejected", "invalid", "unsupported", "throws"])(
		"keeps the selection and stashed draft when a queue edit is %s",
		async (status) => {
			const harness = createHarness({ steering: ["queued"], followUp: [] }, status);
			if (status === "throws")
				harness.agentConnection.mutateQueuedMessage.mockRejectedValue(new Error("connection lost"));
			harness.editor.setText("draft");
			harness.browseQueueSelection(-1);
			harness.editor.setText("");

			const applied = harness.applyQueueSelection("edited", "steering");
			if (status === "throws") await expect(applied).rejects.toThrow("connection lost");
			else await applied;

			expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "queued" });
			expect(harness.queueSelection.hasDraft).toBe(true);
			expect(harness.editor.getText()).toBe("edited");
		},
	);

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

	// [name, initial queue, external event queue, still browsing, editor text, browse again]
	it.each([
		[
			"removes the selected item",
			{ steering: [], followUp: ["queued"] },
			{ steering: [], followUp: [] },
			false,
			"draft",
			undefined,
		],
		[
			"shifts the queue under the selection",
			{ steering: ["s1"], followUp: ["f1", "f2"] },
			{ steering: ["s1"], followUp: ["f0", "f2", "f3"] },
			true,
			"f2",
			"f0",
		],
	] as const)("reconciles browsing when an external event %s", async (_name, initial, event, browsing, text, next) => {
		const harness = createHarness({ steering: [...initial.steering], followUp: [...initial.followUp] });
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);

		emitQueueUpdate(harness, { steering: [...event.steering], followUp: [...event.followUp] });

		expect(harness.queueSelection.isBrowsing).toBe(browsing);
		expect(harness.editor.getText()).toBe(text);
		if (next === undefined) {
			// The selection is gone, so enter falls back to a normal submission.
			await expect(harness.applyQueueSelection("draft", "steering")).resolves.toBe(false);
			expect(harness.agentConnection.mutateQueuedMessage).not.toHaveBeenCalled();
			return;
		}
		harness.browseQueueSelection(-1);
		expect(harness.editor.getText()).toBe(next);
	});

	// [name, queue emitted while the move is in flight, move status, still browsing, queue event that lands after the response]
	it.each([
		["an event that lands during the move", { steering: ["s2", "s1"], followUp: [] }, "applied", true, undefined],
		["an event that drops the moved tuple", { steering: ["s1"], followUp: [] }, "applied", false, undefined],
		["a rejected move that suppresses the event", { steering: ["s1"], followUp: [] }, "rejected", false, undefined],
		["an event that lands after the response", undefined, "applied", true, { steering: ["s2", "s1"], followUp: [] }],
	] as const)("refreshes the selection after a move with %s", async (_name, emitted, status, browsing, late) => {
		const harness = createHarness({ steering: ["s1", "s2"], followUp: [] }, status);
		if (emitted) {
			harness.agentConnection.mutateQueuedMessage.mockImplementation(async () => {
				emitQueueUpdate(harness, { steering: [...emitted.steering], followUp: [...emitted.followUp] });
				return status;
			});
		}
		harness.editor.setText("draft");
		harness.browseQueueSelection(-1);
		harness.moveQueueSelection(-1);
		await harness.queueMutationChain;

		expect(harness.queueSelection.isBrowsing).toBe(browsing);
		if (!browsing) {
			// The moved item is gone from the canonical queue, so the draft comes back.
			expect(harness.editor.getText()).toBe("draft");
			return;
		}
		expect(harness.getConnectionQueue()).toEqual({ steering: ["s2", "s1"], followUp: [] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
		if (!late) return;
		emitQueueUpdate(harness, { steering: [...late.steering], followUp: [...late.followUp] });
		expect(harness.queueSelection.selected).toEqual({ lane: "steering", index: 0, text: "s2" });
		expect(harness.editor.getText()).toBe("s2");
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
	type InterruptHarness = {
		agentConnection: Record<string, ReturnType<typeof vi.fn>>;
		editor: { getText: () => string; setText: ReturnType<typeof vi.fn> };
		connectionState: { sessionActions: { queuedCount: number; steering: string[]; followUps: string[] } };
		shutdown: ReturnType<typeof vi.fn>;
	};

	function createInterruptHarness(draft: string): InterruptHarness {
		const harness = {
			traceUploadAllAbortController: undefined,
			sideQuestionEvent: undefined,
			ctrlCExitHintExpiresAt: 0,
			ctrlCExitHintTimer: undefined,
			escapeRepeatAction: undefined,
			escapeRepeatExpiresAt: 0,
			escapeRepeatTimer: undefined,
			isShuttingDown: false,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => true,
			agentConnection: {
				abort: vi.fn(async () => {}),
				abortAndSendQueued: vi.fn(async () => {}),
				abortBash: vi.fn(),
				clearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
				abortAndClearQueue: vi.fn(async () => ({ steering: [], followUp: [] })),
			},
			connectionState: {
				sessionActions: { queuedCount: 2, steering: ["steer"], followUps: ["follow"] },
			},
			showError: vi.fn(),
			editor: { getText: () => draft, setText: vi.fn() },
			subagentSummaryLine: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			shutdown: vi.fn(async () => {}),
		};
		Object.setPrototypeOf(harness, InteractiveMode.prototype);
		return harness as unknown as InterruptHarness;
	}

	it("interrupts streaming by aborting and sending the queued messages without clearing the queue or the draft", () => {
		const harness = createInterruptHarness("draft");

		Reflect.get(InteractiveMode.prototype, "handleCtrlC").call(harness);

		expect(harness.agentConnection.abortAndSendQueued).toHaveBeenCalledOnce();
		expect(harness.agentConnection.abort).not.toHaveBeenCalled();
		expect(harness.agentConnection.abortAndClearQueue).not.toHaveBeenCalled();
		expect(harness.agentConnection.clearQueue).not.toHaveBeenCalled();
		expect(harness.editor.setText).not.toHaveBeenCalled();
		expect(harness.connectionState.sessionActions).toEqual({
			queuedCount: 2,
			steering: ["steer"],
			followUps: ["follow"],
		});
		expect(harness.shutdown).not.toHaveBeenCalled();
	});

	it("exits on the second Ctrl+C while the exit hint is still armed", () => {
		const harness = createInterruptHarness("draft");
		const handleCtrlC = Reflect.get(InteractiveMode.prototype, "handleCtrlC");

		handleCtrlC.call(harness);
		handleCtrlC.call(harness);

		// The interrupt runs once; the repeat exits instead of aborting again.
		expect(harness.agentConnection.abortAndSendQueued).toHaveBeenCalledOnce();
		expect(harness.shutdown).toHaveBeenCalledOnce();
	});
});
