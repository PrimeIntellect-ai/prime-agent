import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRlmProgressNoteHostHandler, RLM_PROGRESS_NOTE_MAX_LENGTH } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

interface InspectableRlmRun {
	progressNotes: string[];
	lastActivityAt?: number;
	lastActivityMonotonicAt?: number;
	status: string;
	activity?: { kind: string };
	session?: AgentSession;
}

interface InspectableRlmSession {
	_activeRlmChildRuns: Map<string, InspectableRlmRun>;
}

interface InspectableNoteThrottle {
	_lastRlmProgressNoteAt?: number;
}

function userText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/**
 * A stream that stays open until the test completes it, keeping the child
 * running. Completion requested before the stream opens is applied when it
 * opens, so `complete` is race-proof against the child's turn admission.
 */
function heldAnswerStream(): {
	streamFn: (model: unknown, context: Context) => ReturnType<typeof createAssistantMessageEventStream>;
	complete: (text: string) => void;
} {
	let complete: ((text: string) => void) | undefined;
	let requestedBeforeOpen: string | undefined;
	const streamFn = (_model: unknown, context: Context) => {
		const stream = createAssistantMessageEventStream();
		complete = (text: string) => {
			stream.push({ type: "done", reason: "stop", message: assistantMessage(`${text}: ${userText(context)}`) });
		};
		if (requestedBeforeOpen !== undefined) complete(requestedBeforeOpen);
		return stream;
	};
	return {
		streamFn,
		complete: (text) => {
			if (complete) complete(text);
			else requestedBeforeOpen = text;
		},
	};
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("rlm.progress.note child progress channel", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeSession(
		streamFn?: (model: unknown, context: Context) => ReturnType<typeof createAssistantMessageEventStream>,
		sessionsDir = join(tempDir, "sessions"),
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn:
				streamFn ??
				((_model: unknown, context: Context) => {
					const stream = createAssistantMessageEventStream();
					queueMicrotask(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(userText(context)) });
					});
					return stream;
				}),
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, sessionsDir),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("validates host payload shape", async () => {
		const handler = createRlmProgressNoteHostHandler(() => ({ accepted: true, retry_after_ms: undefined }));
		await expect(handler({ message: 42 })).rejects.toThrow("non-empty string");
		await expect(handler({ message: "   " })).rejects.toThrow("non-empty string");
		await expect(handler({ message: "x".repeat(RLM_PROGRESS_NOTE_MAX_LENGTH + 1) })).rejects.toThrow(
			`at most ${RLM_PROGRESS_NOTE_MAX_LENGTH}`,
		);
		// The bound counts UTF-16 code units, so 512 astral characters (1024
		// units) cross it; the Python-side cap measures the same way.
		await expect(handler({ message: "🎉".repeat(RLM_PROGRESS_NOTE_MAX_LENGTH) })).rejects.toThrow(
			`at most ${RLM_PROGRESS_NOTE_MAX_LENGTH}`,
		);
		await expect(handler({ message: "  working on it  " })).resolves.toEqual({ accepted: true });

		let received = "";
		const observing = createRlmProgressNoteHostHandler((message) => {
			received = message;
			return { accepted: true, retry_after_ms: undefined };
		});
		await observing({ message: "  building tests  " });
		expect(received).toBe("building tests");

		const throttled = createRlmProgressNoteHostHandler(() => ({ accepted: false, retry_after_ms: 1234 }));
		await expect(throttled({ message: "note" })).resolves.toEqual({ accepted: false, retry_after_ms: 1234 });
	});

	it("throttles repeated notes per session and emits one event each", () => {
		session = makeSession();
		const events: { message: string; timestamp: number }[] = [];
		session.subscribe((event) => {
			if (event.type === "rlm_progress_note") events.push({ message: event.message, timestamp: event.timestamp });
		});

		const first = session.noteRlmProgress("first note");
		expect(first.accepted).toBe(true);
		expect(first.retry_after_ms).toBeUndefined();

		const second = session.noteRlmProgress("second note");
		expect(second.accepted).toBe(false);
		expect(second.retry_after_ms).toBeGreaterThan(0);
		expect(second.retry_after_ms).toBeLessThanOrEqual(10_000);

		expect(events).toHaveLength(1);
		expect(events[0].message).toBe("first note");
		expect(events[0].timestamp).toBeGreaterThan(0);

		// Notes past the throttle window are accepted again.
		(session as unknown as InspectableNoteThrottle)._lastRlmProgressNoteAt = Date.now() - 10_001;
		const third = session.noteRlmProgress("third note");
		expect(third.accepted).toBe(true);
		expect(events).toHaveLength(2);
		expect(events[1].message).toBe("third note");
	});

	it("captures child notes into the run snapshot and roster entries", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const childUpdates: (string | undefined)[] = [];
		session.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.progressNote !== undefined) {
				childUpdates.push(event.child.progressNote);
			}
		});

		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined);
		const run = runs.get(handle.rlm_child_id)!;
		const child = run.session!;

		try {
			// The agent turn starts asynchronously after admission; wait for its
			// activity signal, then push a note mid-run.
			await waitFor(() => run.activity !== undefined);
			child.noteRlmProgress("halfway done");
			expect(run.progressNotes).toEqual(["halfway done"]);

			const snapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(snapshot?.progressNote).toBe("halfway done");
			expect(snapshot?.lastActivityAt).toBeGreaterThan(0);
			expect(snapshot?.activityStaleMs).toBeUndefined();
			expect(childUpdates).toContain("halfway done");

			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(entry?.progress_note).toBe("halfway done");
			expect(entry?.label).toBe("slow task");
			expect(["waiting", "writing"]).toContain(entry?.activity?.kind);
			expect(entry?.tool_use_count).toBeUndefined();
			expect(entry?.last_activity_at).toBeGreaterThan(0);
			expect(entry?.activity_stale_ms).toBeUndefined();

			// A tool execution must reach the roster in the registry's snake_case
			// activity shape (regression: toolName previously never reached the kernel).
			(child as unknown as { _emit: (event: unknown) => void })._emit({
				type: "tool_execution_start",
				toolCallId: "tool-1",
				toolName: "ipython",
				args: {},
			});
			const toolRoster = await session.listRlmSubagents();
			const toolEntry = toolRoster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(toolEntry?.activity).toEqual({ kind: "executing", tool_name: "ipython" });
			expect(toolEntry?.tool_use_count).toBe(1);
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}

		const settled = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
		expect(settled?.status).toBe("done");
		expect(settled?.progressNote).toBe("halfway done");
		expect(settled?.answerPreview).toContain("child answer");
		expect(settled?.lastActivityAt).toBeGreaterThan(0);
		// Staleness is a running-only signal; a finished child never reports it.
		expect(settled?.activityStaleMs).toBeUndefined();
	});

	it("bounds the note ring and always exposes the newest note", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined);
		const run = runs.get(handle.rlm_child_id)!;
		const child = run.session!;

		try {
			// Notes flow while the child works; wait for the agent turn first.
			await waitFor(() => run.activity !== undefined);
			for (let index = 1; index <= 7; index += 1) {
				// Reset the per-session throttle so every note is admitted deterministically.
				(child as unknown as InspectableNoteThrottle)._lastRlmProgressNoteAt = 0;
				child.noteRlmProgress(`note ${index}`);
			}
			expect(run.progressNotes).toEqual(["note 3", "note 4", "note 5", "note 6", "note 7"]);
			expect(run.lastActivityAt).toBeGreaterThan(0);

			const snapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(snapshot?.progressNote).toBe("note 7");

			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(entry?.progress_note).toBe("note 7");
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}
	});

	it("reports staleness only while the child is running", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined);
		const run = runs.get(handle.rlm_child_id)!;

		try {
			// The agent turn starts asynchronously; wait for its activity signal
			// so no tracked event can overwrite the simulated staleness below.
			await waitFor(() => run.activity !== undefined);
			// Simulate a child silent for the threshold of active time: age
			// both clocks together, as real elapsed time would.
			run.lastActivityAt = Date.now() - 11 * 60_000;
			run.lastActivityMonotonicAt = performance.now() - 11 * 60_000;
			const staleSnapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(staleSnapshot?.status).toBe("running");
			expect(staleSnapshot?.activityStaleMs).toBeGreaterThanOrEqual(10 * 60_000);

			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(entry?.activity_stale_ms).toBeGreaterThanOrEqual(10 * 60_000);

			// Fresh activity clears staleness at the next snapshot build.
			run.lastActivityAt = Date.now();
			const freshSnapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(freshSnapshot?.activityStaleMs).toBeUndefined();
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}
	});

	it("never marks a tool call in flight stale, even past the threshold", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined, 20_000);
		const run = runs.get(handle.rlm_child_id)!;
		const child = run.session!;

		try {
			// The agent turn starts asynchronously; wait for its activity signal
			// so no tracked event can overwrite the injected tool execution.
			await waitFor(() => run.activity !== undefined, 20_000);
			const emitChild = (event: unknown) => (child as unknown as { _emit: (event: unknown) => void })._emit(event);
			emitChild({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: {} });

			// A long bash() call streams no child events for its whole
			// duration; age both clocks 11 minutes into that silence. The
			// child is busy executing, not stale (regression: staleness used
			// to ignore activity and flag exactly this case).
			run.lastActivityAt = Date.now() - 11 * 60_000;
			run.lastActivityMonotonicAt = performance.now() - 11 * 60_000;
			const executingSnapshot = session
				.getRlmChildSnapshots()
				.find((candidate) => candidate.id === handle.rlm_child_id);
			expect(executingSnapshot?.status).toBe("running");
			expect(executingSnapshot?.activity).toEqual({ kind: "executing", toolName: "bash" });
			expect(executingSnapshot?.activityStaleMs).toBeUndefined();

			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(entry?.activity).toEqual({ kind: "executing", tool_name: "bash" });
			expect(entry?.activity_stale_ms).toBeUndefined();

			// The suppression is executing-only: once the tool ends and the
			// child goes quiet again for the threshold, staleness returns.
			emitChild({ type: "tool_execution_end", toolCallId: "tool-1", args: {}, output: "" });
			run.lastActivityAt = Date.now() - 11 * 60_000;
			run.lastActivityMonotonicAt = performance.now() - 11 * 60_000;
			const waitingSnapshot = session
				.getRlmChildSnapshots()
				.find((candidate) => candidate.id === handle.rlm_child_id);
			expect(waitingSnapshot?.activity?.kind).toBe("waiting");
			expect(waitingSnapshot?.activityStaleMs).toBeGreaterThanOrEqual(10 * 60_000);
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}
	});

	it("does not flag a running child stale after a host-sleep wall-clock jump", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined, 20_000);
		const run = runs.get(handle.rlm_child_id)!;

		try {
			// The agent turn starts asynchronously; wait for its activity signal
			// so no tracked event can overwrite the simulated wake below.
			await waitFor(() => run.activity !== undefined, 20_000);
			// Simulate waking from a six-hour laptop sleep: the wall clock
			// jumped, but the monotonic clock only advanced while the host
			// was awake (regression: wall-clock staleness marked every
			// running child stale on wake).
			run.lastActivityAt = Date.now() - 6 * 60 * 60_000;
			run.lastActivityMonotonicAt = performance.now() - 30_000;
			const wokeSnapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(wokeSnapshot?.status).toBe("running");
			expect(wokeSnapshot?.activityStaleMs).toBeUndefined();

			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(entry?.activity_stale_ms).toBeUndefined();

			// Staleness still measures genuinely idle active time: a child
			// silent for the threshold while the host is awake stays stale
			// even with the stale wall-clock reading still in place.
			run.lastActivityMonotonicAt = performance.now() - 11 * 60_000;
			const idleSnapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(idleSnapshot?.activityStaleMs).toBeGreaterThanOrEqual(10 * 60_000);
			// The monotonic delta is fractional, but staleness stays integer ms:
			// the kernel roster parser rejects non-int activity_stale_ms
			// (regression: performance.now() deltas used to leak floats onto
			// the wire and break rlm.list_subagents() for a stale child).
			expect(Number.isInteger(idleSnapshot?.activityStaleMs)).toBe(true);

			const idleRoster = await session.listRlmSubagents();
			const idleEntry = idleRoster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			expect(Number.isInteger(idleEntry?.activity_stale_ms)).toBe(true);
			expect(idleEntry?.activity_stale_ms).toBeGreaterThanOrEqual(10 * 60_000);
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}
	});

	it("seeds the staleness clock at admission for never-active children", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		const run = runs.get(handle.rlm_child_id)!;

		try {
			// Admission seeds the clock before any tracked event: a child hung
			// before its first activity still crosses the staleness threshold
			// once running. Previously the timestamp only appeared with the
			// first child event, so a never-active child was never stale.
			expect(run.lastActivityAt).toBeGreaterThan(0);
			expect(run.lastActivityMonotonicAt).toBeGreaterThan(0);
		} finally {
			held.complete("child answer");
			await waitFor(() => {
				const snapshot = session!.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
				return snapshot?.status !== "running" && snapshot?.status !== "queued";
			}, 20_000);
		}
	});

	it("caps the kernel roster label while snapshots keep the full prompt", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		// rlmChildLabel collapses whitespace only; the collapsed label still
		// far exceeds the roster's hard cap.
		const longPrompt = "refactor the frobnicator ".repeat(40);
		const handle = await session.runRlmChild(longPrompt, { name: "worker-a" });

		try {
			const snapshot = session.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
			expect(snapshot?.label.length).toBeGreaterThan(200);
			const roster = await session.listRlmSubagents();
			const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === handle.rlm_child_id);
			// The kernel roster entry is bounded like the other wire extras; the
			// snapshot keeps the full label for the TUI.
			expect(entry?.label).toHaveLength(200);
			expect(entry?.label).toBe(snapshot?.label.slice(0, 200));
		} finally {
			held.complete("child answer");
			await waitFor(() => {
				const snapshot = session!.getRlmChildSnapshots().find((candidate) => candidate.id === handle.rlm_child_id);
				return snapshot?.status !== "running" && snapshot?.status !== "queued";
			}, 20_000);
		}
	});

	it("does not churn child updates on streaming deltas once the preview saturates", async () => {
		const held = heldAnswerStream();
		session = makeSession(held.streamFn);
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		const runs = (session as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => runs.get(handle.rlm_child_id)?.session !== undefined);
		const run = runs.get(handle.rlm_child_id)!;
		const child = run.session!;
		const childUpdates: { preview?: string; activityKind?: string; activityToolName?: string }[] = [];
		session.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.id === handle.rlm_child_id) {
				childUpdates.push({
					preview: event.child.answerPreview,
					activityKind: event.child.activity?.kind,
					activityToolName: event.child.activity?.toolName,
				});
			}
		});
		const emitChild = (event: unknown) => (child as unknown as { _emit: (event: unknown) => void })._emit(event);

		try {
			// The agent turn starts asynchronously; wait for its activity signal so
			// no tracked event can race the injected streaming deltas.
			await waitFor(() => run.activity !== undefined);
			// Streaming past the 160-character preview cap: like real token
			// deltas, appending text past the cap leaves the capped preview
			// unchanged, so only lastActivityAt still moves.
			const saturatedText = "saturation".repeat(40);
			const baseline = childUpdates.length;
			emitChild({ type: "message_update", message: assistantMessage(saturatedText) });
			await waitFor(() => childUpdates.length > baseline);
			expect(childUpdates.at(-1)?.preview).toHaveLength(160);

			// Saturated deltas must not re-emit (regression: the advancing
			// lastActivityAt used to defeat the snapshot dedup on every delta).
			const saturated = childUpdates.length;
			const lastActivityBefore = run.lastActivityAt;
			for (let index = 0; index < 3; index += 1) {
				await new Promise((resolve) => setTimeout(resolve, 2));
				emitChild({
					type: "message_update",
					message: assistantMessage(`${saturatedText}${"x".repeat(index + 1)}`),
				});
			}
			expect(childUpdates.length).toBe(saturated);

			// Staleness semantics survive: streaming still counts as activity.
			expect(run.lastActivityAt).toBeGreaterThan(lastActivityBefore ?? 0);
			const streamedSnapshot = session
				.getRlmChildSnapshots()
				.find((candidate) => candidate.id === handle.rlm_child_id);
			expect(streamedSnapshot?.activityStaleMs).toBeUndefined();

			// Real activity still emits: a changed preview, then a tool call.
			const changed = childUpdates.length;
			emitChild({ type: "message_update", message: assistantMessage(`changed ${saturatedText}`) });
			await waitFor(() => childUpdates.length > changed);
			expect(childUpdates.at(-1)?.preview).toContain("changed");

			const beforeTool = childUpdates.length;
			emitChild({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "ipython", args: {} });
			await waitFor(() => childUpdates.length > beforeTool);
			expect(childUpdates.at(-1)?.activityKind).toBe("executing");
			expect(childUpdates.at(-1)?.activityToolName).toBe("ipython");
		} finally {
			held.complete("child answer");
			await waitFor(
				() => session!.getRlmChildSnapshots().every((candidate) => candidate.status !== "running"),
				20_000,
			);
		}
	});

	it("carries live extras for externally restored retained children", async () => {
		session = makeSession();
		const childId = "restored-child";
		const child = makeSession(undefined, join(tempDir, "restored-child-sessions"));
		child.setSessionName("restored-worker");
		const restoredAnswer = assistantMessage("restored answer");
		restoredAnswer.content.push({ type: "toolCall", id: "tool-1", name: "ipython", arguments: {} });
		child.agent.state.messages.push(restoredAnswer);

		expect(session.registerRlmChildSession(childId, child)).toBe(true);
		const roster = await session.listRlmSubagents();
		const entry = roster.subagents.find((candidate) => candidate.rlm_child_id === childId);
		expect(entry?.answer_preview).toBe("restored answer");
		expect(entry?.tool_use_count).toBe(1);
		expect(entry?.label).toBe("restored-worker");
		expect(entry?.progress_note).toBeUndefined();
		expect(entry?.activity_stale_ms).toBeUndefined();
		child.dispose();
	});
});
