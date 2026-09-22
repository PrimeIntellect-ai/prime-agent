import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { BashExecutionComponent } from "../../../src/modes/interactive/components/bash-execution.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness } from "../harness.js";

type Host = Record<string, unknown>;

function interactiveHost(overrides: Host): Host {
	return Object.assign(Object.create(InteractiveMode.prototype), overrides);
}

// Stubs for the parts of handleEvent that run before the bash-routing logic
// under test. Shared so each case only states what it actually varies.
function eventPreamble(chatContainer: Container): Host {
	return {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		updateConnectionStateFromEvent: vi.fn(),
		activityTracker: { handleEvent: vi.fn(), getStatus: () => ({ tokens: 0 }) },
		updateWorkingLoaderMessage: vi.fn(),
		isAgentStreaming: () => false,
		ui: { requestRender: vi.fn() },
		chatContainer,
		pendingMessagesContainer: new Container(),
		pendingBashComponents: [],
	};
}

const clearSideQuestion = (
	InteractiveMode.prototype as unknown as {
		clearSideQuestion(this: Host, options?: { abort?: boolean }): void;
	}
).clearSideQuestion;

const handleEvent = (
	InteractiveMode.prototype as unknown as {
		handleEvent(this: Host, event: unknown): Promise<void>;
	}
).handleEvent;

describe("side questions: abort, bash slot races, foreign-run isolation (ENG-4509)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("cancels independently of the main agent", async () => {
		const harness = await createHarness();
		let sideStarted = () => {};
		const started = new Promise<void>((resolve) => {
			sideStarted = resolve;
		});
		try {
			harness.setResponses([
				async (_context, options) => {
					sideStarted();
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "question-3", "Wait here", (event) => {
				events.push(event);
			});
			await started;
			run.abort();
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	// Closing the pane with a side bash outstanding must always mark the run
	// discarded so its events are swallowed, but it may only send a
	// session-scoped abort once the run has actually claimed the bash slot.
	it.each([
		{ name: "swallows a pending side bash that has not claimed the slot", component: undefined, abortCalls: 0 },
		{ name: "aborts a side bash that already claimed the slot", component: {}, abortCalls: 1 },
	])("$name", ({ component, abortCalls }) => {
		const abortBash = vi.fn(async () => {});
		const host = interactiveHost({
			sideQuestionEvent: { id: "turn-1", question: "First?", answer: "done", status: "complete" },
			sideQuestionTurns: [],
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			sideQuestionBash: { runId: "side-run-1", input: "!sleep 5", seedTranscript: true },
			sideQuestionBashComponent: component,
			sideQuestionBashDiscarded: undefined,
			activeSideQuestionId: undefined,
			agentConnection: { abortBash },
			isInitialized: false,
		});

		clearSideQuestion.call(host, { abort: true });

		expect(host.sideQuestionBash).toBeUndefined();
		expect(host.sideQuestionBashDiscarded).toBe("side-run-1");
		expect(host.sideQuestionBashComponent).toBeUndefined();
		expect(abortBash).toHaveBeenCalledTimes(abortCalls);
	});

	it("re-aborts a discarded side bash when its bash_start arrives late", async () => {
		const abortBash = vi.fn(async () => {});
		const host = interactiveHost({
			sideQuestionBash: undefined,
			sideQuestionBashDiscarded: "side-run-1",
			activeBashComponent: undefined,
			agentConnection: { abortBash },
			...eventPreamble(new Container()),
		});

		await handleEvent.call(host, {
			type: "bash_start",
			command: "sleep 5",
			excludeFromContext: true,
			transient: true,
			runId: "side-run-1",
		});

		expect(abortBash).toHaveBeenCalled();
		expect(host.activeBashComponent).toBeUndefined();

		await handleEvent.call(host, {
			type: "bash_end",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
			transient: true,
			runId: "side-run-1",
		});
		expect(host.sideQuestionBashDiscarded).toBeUndefined();
	});

	it("does not abort or swallow another client's run after a discard", async () => {
		const abortBash = vi.fn(async () => {});
		const chatContainer = new Container();
		const host = interactiveHost({
			// Our side bash was discarded at pane close but never claimed the slot.
			sideQuestionBash: undefined,
			sideQuestionBashDiscarded: "side-run-1",
			activeBashComponent: undefined,
			agentConnection: { abortBash },
			...eventPreamble(chatContainer),
		});

		// Another client won the bash slot; its run must render, not be aborted.
		await handleEvent.call(host, { type: "bash_start", command: "make build", excludeFromContext: false });

		expect(abortBash).not.toHaveBeenCalled();
		expect(host.sideQuestionBashDiscarded).toBeUndefined();
		expect(chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);

		await handleEvent.call(host, { type: "bash_output", chunk: "compiling\n" });
		expect((host.activeBashComponent as BashExecutionComponent).getOutput()).toContain("compiling");
	});

	it("keeps foreign runs out of the pane and suppresses foreign transient runs", async () => {
		const addBash = vi.fn();
		const showError = vi.fn();
		const chatContainer = new Container();
		const host = interactiveHost({
			// Our side bash is pending; its runId has not appeared yet.
			sideQuestionBash: { runId: "side-run-1", input: "!ls", seedTranscript: true },
			sideQuestionBashComponent: undefined,
			sideQuestionBashDiscarded: undefined,
			sideQuestionComponent: { addBash, finishBash: vi.fn() },
			sideQuestionTurns: [],
			activeBashComponent: undefined,
			showError,
			...eventPreamble(chatContainer),
		});

		// A foreign main-chat run — even with the identical command string —
		// renders in the chat, never in the pane.
		await handleEvent.call(host, { type: "bash_start", command: "ls", excludeFromContext: false });
		expect(addBash).not.toHaveBeenCalled();
		expect(chatContainer.children.some((child) => child instanceof BashExecutionComponent)).toBe(true);
		await handleEvent.call(host, { type: "bash_end", exitCode: 0, cancelled: false, truncated: false });
		// The foreign run neither seeds the side transcript nor consumes the
		// still-pending side bash.
		expect(host.sideQuestionTurns).toEqual([]);
		expect(host.sideQuestionBash).toMatchObject({ runId: "side-run-1" });

		// A foreign transient run (another client's side conversation) is
		// suppressed entirely: no chat mount, no output, no failure toast.
		chatContainer.clear();
		await handleEvent.call(host, {
			type: "bash_start",
			command: "ls secret-dir",
			excludeFromContext: true,
			transient: true,
			runId: "other-client-run",
		});
		expect(chatContainer.children).toEqual([]);
		expect(host.activeBashComponent).toBeUndefined();
		await handleEvent.call(host, {
			type: "bash_end",
			exitCode: undefined,
			cancelled: false,
			truncated: false,
			errorMessage: "spawn failed",
			transient: true,
			runId: "other-client-run",
		});
		expect(showError).not.toHaveBeenCalled();
		expect(host.sideQuestionTurns).toEqual([]);
	});
});
