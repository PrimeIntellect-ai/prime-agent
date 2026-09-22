import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, test, vi } from "vitest";
import type { AgentStatus } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import {
	type AgentStatusResult,
	buildStatusContext,
	DaemonSessionSummarizer,
	parseAgentStatusResponse,
} from "../src/modes/daemon/daemon-session-summarizer.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 } as unknown as AgentMessage;
}

function assistantMessage(text: string, tools: string[] = []): AgentMessage {
	const content = [{ type: "text", text }, ...tools.map((name) => ({ type: "tool_use", name, id: name, input: {} }))];
	return { role: "assistant", content, timestamp: 0 } as unknown as AgentMessage;
}

function assistantError(errorMessage?: string): AgentMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "error",
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: 0,
	} as unknown as AgentMessage;
}

describe("daemon session summarizer", () => {
	describe("parseAgentStatusResponse", () => {
		// The recap line is model output, so every tag shape the model actually produces is pinned here.
		test.each([
			[
				"parses recap and completion verdict for an idle session",
				"<recap>Added the API reference page</recap>\n<status>COMPLETED</status>",
				false,
				{ summary: "Added the API reference page", taskState: "completed" },
			],
			[
				"maps NEEDS_INPUT for idle sessions",
				"<recap>Asked which database to target</recap>\n<status>NEEDS_INPUT</status>",
				false,
				{ summary: "Asked which database to target", taskState: "needs_input" },
			],
			[
				"omits the verdict while working and ignores any status tag",
				"<recap>Refactoring token validation</recap>\n<status>COMPLETED</status>",
				true,
				{ summary: "Refactoring token validation" },
			],
			[
				"falls back to needs_input on an unrecognized idle verdict",
				"<recap>Doing something</recap>\n<status>MAYBE</status>",
				false,
				{ summary: "Doing something", taskState: "needs_input" },
			],
			[
				"falls back to needs_input on a missing idle verdict",
				"<recap>Doing something</recap>",
				false,
				{ summary: "Doing something", taskState: "needs_input" },
			],
			["ignores narration with no tags at all", "Investigating the failing test.", true, undefined],
			[
				"ignores narration outside the tags",
				"Recap: . So: <recap>Curating a niche list of Muon optimizer papers</recap>",
				true,
				{ summary: "Curating a niche list of Muon optimizer papers" },
			],
			[
				"ignores reasoning prose around the tags",
				"Let me decide. The agent finished editing.\n<recap>Updated the login handler</recap>\n<status>COMPLETED</status>",
				false,
				{ summary: "Updated the login handler", taskState: "completed" },
			],
			[
				"rejects an echoed prompt template",
				"<recap>a present-tense clause, at most 12 words, no trailing period</recap>\n<status>COMPLETED</status>",
				true,
				undefined,
			],
			["returns undefined for empty output", "", false, undefined],
			["returns undefined when no recap tag is present", "<status>COMPLETED</status>", false, undefined],
			[
				"drops chain-of-thought that falls outside the closing recap tag",
				"<recap>Sending SSH auth retry to tcg-autoresearch-rl</recap> That's 5 words? Count: Sending(1) SSH(2) = 6 words.\n<status>NEEDS_INPUT</status>",
				true,
				{ summary: "Sending SSH auth retry to tcg-autoresearch-rl" },
			],
			[
				"rejects a recap body that is nothing but counting artifacts",
				"<recap>(1) word(2) count(3) = 3 words</recap>",
				true,
				undefined,
			],
			[
				"rejects a rambling recap that blows past the word ceiling",
				"<recap>this is a very long rambling sentence that just keeps going and going well past any reasonable recap length</recap>",
				true,
				undefined,
			],
			[
				"strips wrapping quotes the model adds around the recap",
				'<recap>"Wiring the recap line"</recap>\n<status>COMPLETED</status>',
				false,
				{ summary: "Wiring the recap line", taskState: "completed" },
			],
			[
				"ignores an open recap tag with no close",
				"<recap>Editing the parser\n<status>NEEDS_INPUT</status>",
				true,
				undefined,
			],
			[
				"takes the last recap tag when a draft is corrected",
				"<recap>Draft recap</recap>\n<recap>Final corrected recap</recap>",
				true,
				{ summary: "Final corrected recap" },
			],
			[
				"takes the last status tag when a draft is corrected",
				"<recap>Editing the parser</recap>\n<status>NEEDS_INPUT</status>\n<status>COMPLETED</status>",
				false,
				{ summary: "Editing the parser", taskState: "completed" },
			],
			[
				// The model sometimes emits the unicode lookalikes ‹ › instead of < >.
				"normalizes unicode angle-bracket lookalikes around the tags",
				"‹recap›Curating a niche list of Muon optimizer papers‹/recap›",
				true,
				{ summary: "Curating a niche list of Muon optimizer papers" },
			],
		])("%s", (_name, text, isWorking, expected) => {
			expect(parseAgentStatusResponse(text, isWorking)).toEqual(expected);
		});
	});

	describe("buildStatusContext", () => {
		test("includes the agent state and the trailing conversation with tool names", () => {
			const context = buildStatusContext(
				[userMessage("add a login endpoint"), assistantMessage("Editing the router", ["Edit", "Bash"])],
				true,
			);
			expect(context).toContain("<agent-state>working</agent-state>");
			expect(context).toContain("user: add a login endpoint");
			expect(context).toContain("assistant: Editing the router [tools: Edit, Bash]");
		});

		test("marks idle sessions as finished", () => {
			expect(buildStatusContext([userMessage("hi")], false)).toContain("idle (finished its turn)");
		});

		test("only keeps the most recent messages", () => {
			const messages = Array.from({ length: 20 }, (_, i) => userMessage(`message ${i}`));
			const context = buildStatusContext(messages, false);
			expect(context).toContain("message 19");
			expect(context).not.toContain("message 0\n");
		});
	});

	describe("status change notification", () => {
		function makeState(options: {
			messages: AgentMessage[];
			isSessionActive: boolean;
			summaryState?: AgentStatus;
			persistedStatus?: AgentStatus;
			appendAgentStatus?: (status: AgentStatus) => void;
			getLeafId?: () => string | null;
		}): ActiveSessionState {
			return {
				activeSessionId: "active-1",
				summaryState: options.summaryState,
				runtime: {
					session: {
						isSessionActive: options.isSessionActive,
						messages: options.messages,
						modelRegistry: {},
						settingsManager: SettingsManager.inMemory(),
						state: { streamingMessage: undefined },
						sessionManager: {
							appendAgentStatus: options.appendAgentStatus ?? (() => {}),
							getLatestAgentStatus: () => options.persistedStatus,
							getLeafId: options.getLeafId ?? (() => null),
						},
					},
				},
			} as unknown as ActiveSessionState;
		}

		async function settle(state: ActiveSessionState, generated: { summary: string; taskState?: "needs_input" }) {
			const onStatusChanged = vi.fn();
			const summarizer = new DaemonSessionSummarizer(
				() => [state],
				onStatusChanged,
				async () => generated,
			);
			await (summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> }).summarize(state);
			return onStatusChanged;
		}

		test("an idle settle with unchanged verdict text still notifies: its currency drives the roster", async () => {
			const previous: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 1 };
			const state = makeState({
				messages: [userMessage("hi"), userMessage("more")],
				isSessionActive: false,
				summaryState: previous,
			});

			const onStatusChanged = await settle(state, { summary: "Working on it", taskState: "needs_input" });

			expect(state.summaryState?.basedOnMessageCount).toBe(2);
			expect(onStatusChanged).toHaveBeenCalledOnce();
		});

		function failingIdleSetup(
			stateOptions: Parameters<typeof makeState>[0],
			generateFn: () => Promise<undefined> = async () => undefined,
		) {
			const state = makeState(stateOptions);
			const generate = vi.fn(generateFn);
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
			const internal = summarizer as unknown as {
				summarize(state: ActiveSessionState): Promise<void>;
				failedIdleGenerations: Map<string, unknown>;
			};
			return { state, generate, summarizer, internal };
		}

		// Warmup pins the ceiling itself: repeated failing idle sweeps stop paying
		// after three attempts and never persist the fabricated in-memory fallback.
		test.each([
			{
				rearm: "branch navigation moving the leaf at the same length",
				trigger: (leaf: { id: string }) => {
					leaf.id = "leaf-b";
				},
			},
			{
				rearm: "the backoff elapsing so external failures recover",
				trigger: () => vi.setSystemTime(Date.now() + 31 * 60_000),
			},
		])("the exhausted idle retry ceiling re-arms on $rearm", async ({ trigger }) => {
			vi.useFakeTimers();
			try {
				const appendAgentStatus = vi.fn();
				const leaf = { id: "leaf-a" };
				const { state, generate, internal } = failingIdleSetup({
					messages: [userMessage("hi")],
					isSessionActive: false,
					appendAgentStatus,
					getLeafId: () => leaf.id,
				});

				for (let sweep = 0; sweep < 5; sweep++) {
					await internal.summarize(state);
				}
				expect(generate).toHaveBeenCalledTimes(3);
				expect(appendAgentStatus).not.toHaveBeenCalled();
				expect(state.summaryState).toEqual({ summary: "", taskState: "needs_input", basedOnMessageCount: 1 });

				trigger(leaf);
				await internal.summarize(state);
				expect(generate).toHaveBeenCalledTimes(4);
				expect(appendAgentStatus).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		test("a forget() during an in-flight idle generation leaves no failure record behind", async () => {
			let release!: () => void;
			const gate = new Promise<void>((resolveGate) => {
				release = resolveGate;
			});
			const { state, summarizer, internal } = failingIdleSetup(
				{ messages: [userMessage("hi")], isSessionActive: false },
				async () => {
					await gate;
					return undefined;
				},
			);

			const pass = internal.summarize(state);
			summarizer.forget("active-1");
			release();
			await pass;

			expect(internal.failedIdleGenerations.size).toBe(0);
		});

		test("an idle re-settle matching the latest persisted status appends nothing", async () => {
			const appendAgentStatus = vi.fn();
			const persisted: AgentStatus = {
				summary: "Awaiting review",
				taskState: "needs_input",
				basedOnMessageCount: 1,
			};
			const state = makeState({
				messages: [userMessage("hi")],
				isSessionActive: false,
				persistedStatus: persisted,
				appendAgentStatus,
			});

			const onStatusChanged = vi.fn();
			const summarizer = new DaemonSessionSummarizer(
				() => [state],
				onStatusChanged,
				async () => ({ summary: "Awaiting review", taskState: "needs_input" as const }),
			);
			await (summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> }).summarize(state);

			expect(appendAgentStatus).not.toHaveBeenCalled();
			expect(onStatusChanged).toHaveBeenCalledOnce();
			expect(state.summaryState).toEqual(persisted);
		});

		test("a working refresh with unchanged text stays quiet", async () => {
			const previous: AgentStatus = { summary: "Working on it", taskState: "needs_input", basedOnMessageCount: 2 };
			const state = makeState({
				messages: [userMessage("hi"), userMessage("more")],
				isSessionActive: true,
				summaryState: previous,
			});

			const onStatusChanged = await settle(state, { summary: "Working on it" });

			expect(onStatusChanged).not.toHaveBeenCalled();
		});
	});

	describe("errored turn verdicts", () => {
		const providerError = "400 enable_thinking is not supported for this model";

		function erroredTranscript(errorMessage?: string): AgentMessage[] {
			return [userMessage("write a session marker and verify the file content"), assistantError(errorMessage)];
		}

		// A journal-backed state: getLatestAgentStatus returns what appends recorded,
		// falling back to a verdict that predates this run (e.g. written before a
		// daemon restart).
		function erroredState(options: {
			messages: AgentMessage[];
			isSessionActive?: boolean;
			persistedStatus?: AgentStatus;
		}): {
			state: ActiveSessionState;
			appended: AgentStatus[];
		} {
			const appended: AgentStatus[] = [];
			const state = {
				activeSessionId: "active-error",
				summaryState: undefined,
				runtime: {
					session: {
						isSessionActive: options.isSessionActive ?? false,
						messages: options.messages,
						modelRegistry: {},
						settingsManager: SettingsManager.inMemory(),
						state: { streamingMessage: undefined },
						sessionManager: {
							appendAgentStatus: (status: AgentStatus) => {
								appended.push(status);
							},
							getLatestAgentStatus: () => appended.at(-1) ?? options.persistedStatus,
							getLeafId: () => null,
						},
					},
				},
			} as unknown as ActiveSessionState;
			return { state, appended };
		}

		async function runSummarize(
			state: ActiveSessionState,
			generate: () => Promise<AgentStatusResult | undefined>,
		): Promise<ReturnType<typeof vi.fn>> {
			const onStatusChanged = vi.fn();
			const summarizer = new DaemonSessionSummarizer(() => [state], onStatusChanged, generate);
			await (summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> }).summarize(state);
			return onStatusChanged;
		}

		test("an errored session persists the real error as its verdict, never a completed one", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			// The classifier would only see the task text and invent completed work.
			const generate = vi.fn(async () => ({
				summary: "Writing session marker and verifying file content",
				taskState: "completed" as const,
			}));

			const onStatusChanged = await runSummarize(state, generate);

			expect(generate).not.toHaveBeenCalled();
			expect(state.summaryState).toEqual({
				summary: `Model request failed: ${providerError}`,
				taskState: "error",
				basedOnMessageCount: 2,
			});
			expect(appended).toEqual([
				{ summary: `Model request failed: ${providerError}`, taskState: "error", basedOnMessageCount: 2 },
			]);
			expect(onStatusChanged).toHaveBeenCalledOnce();
		});

		test("repeated sweeps over an unchanged errored transcript append nothing more", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, vi.fn());
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state);
			await internal.summarize(state);
			await internal.summarize(state);

			expect(appended).toHaveLength(1);
		});

		test("a restart-seeded completed verdict for an errored transcript is repaired by the sweep", async () => {
			// Pre-fix code fabricated a completed verdict for the errored transcript
			// and the journal kept it; a daemon restart seeds it back before the
			// first sweep. The unchanged-content fast path must not skip the repair.
			const persisted: AgentStatus = {
				summary: "Writing session marker and verifying file content",
				taskState: "completed",
				basedOnMessageCount: 2,
			};
			const { state, appended } = erroredState({
				messages: erroredTranscript(providerError),
				persistedStatus: persisted,
			});
			const generate = vi.fn(async () => ({ summary: "unreached", taskState: "completed" as const }));
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
			// Daemon-mode bind() restores the persisted verdict on restart.
			summarizer.seed(state);
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state);

			expect(generate).not.toHaveBeenCalled();
			expect(state.summaryState).toEqual({
				summary: `Model request failed: ${providerError}`,
				taskState: "error",
				basedOnMessageCount: 2,
			});
			expect(appended).toEqual([
				{ summary: `Model request failed: ${providerError}`, taskState: "error", basedOnMessageCount: 2 },
			]);

			// Repaired once: later sweeps append nothing more.
			await internal.summarize(state);
			await internal.summarize(state);
			expect(appended).toHaveLength(1);
		});

		test("an errored turn without an error message still settles to the error verdict", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(undefined) });

			await runSummarize(state, async () => undefined);

			expect(state.summaryState).toMatchObject({ summary: "Model request failed", taskState: "error" });
			expect(appended).toHaveLength(1);
		});

		test("a successful final answer after an error earns a normal model verdict", async () => {
			const { state, appended } = erroredState({ messages: erroredTranscript(providerError) });
			const generate = vi.fn(async () => ({ summary: "Wrote the marker file", taskState: "completed" as const }));
			const summarizer = new DaemonSessionSummarizer(() => [state], undefined, generate);
			const internal = summarizer as unknown as { summarize(state: ActiveSessionState): Promise<void> };

			await internal.summarize(state); // error verdict settles first
			expect(state.summaryState?.taskState).toBe("error");

			// The user retries and the turn succeeds: the classifier may judge again.
			(state.runtime.session as unknown as { messages: AgentMessage[] }).messages = [
				...erroredTranscript(providerError),
				userMessage("retry the marker task"),
				assistantMessage("Wrote .session-marker and verified its content"),
			];
			await internal.summarize(state);

			expect(generate).toHaveBeenCalledTimes(1);
			expect(state.summaryState).toMatchObject({ summary: "Wrote the marker file", taskState: "completed" });
			expect(appended.at(-1)).toMatchObject({ taskState: "completed" });
		});

		test("a working session is never error-settled, even with an errored trailing assistant message", async () => {
			// While working (e.g. mid-retry) the model refresh keeps recapping;
			// verdicts settle only when the session goes idle.
			const { state, appended } = erroredState({
				messages: erroredTranscript(providerError),
				isSessionActive: true,
			});
			const generate = vi.fn(async () => ({ summary: "Retrying the failed request" }));

			await runSummarize(state, generate);

			expect(generate).toHaveBeenCalledOnce();
			expect(state.summaryState).toEqual({
				summary: "Retrying the failed request",
				taskState: undefined,
				basedOnMessageCount: 2,
			});
			expect(appended).toHaveLength(0);
		});
	});
});
