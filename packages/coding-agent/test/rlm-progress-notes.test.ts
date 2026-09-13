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
			// Simulate a child silent past the threshold.
			run.lastActivityAt = Date.now() - 11 * 60_000;
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
