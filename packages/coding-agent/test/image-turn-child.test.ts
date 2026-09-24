/**
 * Image turns on a text-only session model: one bounded child pinned to the
 * image model reads the images, and only its text reaches the session.
 */

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent, ImageContent } from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { assistantMsg, createTestResourceLoader } from "./utilities.js";

const IMAGE: ImageContent = { type: "image", mimeType: "image/png", data: "aGk=" };
const READ_CHILD_SESSION_ID = "child-session-1";
const SET = { imageModel: "claude-haiku-4-5" };
const VISION = "anthropic/claude-haiku-4-5";

type ChildSessionStub = { session: { getLastAssistantText: () => string | undefined; dispose: () => void } };

interface ImageTurnHarness {
	session: AgentSession;
	servedModelIds: string[];
	requests: Array<{ model: string; content: unknown[] }[]>;
	spawns: Array<{ prompt: string; kwargs: Record<string, unknown> }>;
	/** Release the turn that was held open to keep a stream live through the read. */
	releaseHeldTurn: () => void;
	spawnChild: (options?: {
		reading?: string;
		settled?: boolean;
		status?: string;
		error?: string;
		/** Deliver the child's own reply to the parent while the read is awaited. */
		replyDuringRead?: string;
		/** Start another agent message turn that keeps streaming through the read. */
		concurrentTurnDuringRead?: boolean;
		/** Leave the read's temp directory unwritable so removing it throws. */
		unremovableTempDir?: boolean;
	}) => void;
	dispose: () => void;
}

/**
 * A session whose model cannot see images, with a spied child runtime so the
 * spawn shape is observable without a real child process.
 */
function createImageTurnHarness(
	settings: Record<string, unknown>,
	options: { vision?: boolean } = {},
): ImageTurnHarness {
	const dir = mkdtempSync(join(tmpdir(), "pi-image-turn-child-"));
	writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
	const base = getCodingAgentFixtureModel("anthropic", "claude-opus-4-7");
	const sessionModel = (
		options.vision ? base : { ...base, id: "claude-opus-4-7-text-only", input: ["text"] }
	) as typeof base;
	const servedModelIds: string[] = [];
	const heldStreams: EventStream<AssistantMessageEvent, AssistantMessage>[] = [];
	const requests: Array<{ model: string; content: unknown[] }[]> = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: sessionModel, systemPrompt: "Test", tools: [] },
		streamFn: (model, context) => {
			servedModelIds.push(model.id);
			requests.push(
				context.messages.map((message) => ({ model: model.id, content: [...(message.content as unknown[])] })),
			);
			const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
				(event) => event.type === "done",
				(event: any) => event.message,
			);
			// "a heartbeat arrived" stands in for a turn that is still streaming while
			// the image read is awaited: it stays open until the test releases it, so
			// the race window is deterministic rather than timing-dependent.
			const lastContent = context.messages.at(-1)?.content;
			const lastText = Array.isArray(lastContent)
				? lastContent.map((block) => (block as { text?: string }).text ?? "").join(" ")
				: String(lastContent ?? "");
			if (lastText.includes("a heartbeat arrived")) {
				heldStreams.push(stream);
				return stream;
			}
			stream.push({ type: "done", reason: "stop", message: assistantMsg("ok") });
			return stream;
		},
	});
	const auth = AuthStorage.create(join(dir, "auth.json"));
	auth.setRuntimeApiKey("anthropic", "test-key");
	auth.setRuntimeApiKey("deepseek", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.create(dir, dir),
		cwd: dir,
		modelRegistry: ModelRegistry.create(auth, dir),
		resourceLoader: createTestResourceLoader(),
	});
	const spawns: ImageTurnHarness["spawns"] = [];
	// Temp directories the test made unwritable, restored so cleanup can remove them.
	const blockedTempDirs: string[] = [];
	const children = session as unknown as {
		runRlmChild: (prompt: string, kwargs: Record<string, unknown>) => Promise<{ rlm_child_id: string }>;
		collectRlmChildren: (targets: string[], timeoutMs: number) => Promise<{ results: unknown[] }>;
		_awaitPendingRlmChildPublication: (selector: string) => Promise<string | undefined>;
		deleteRlmSubagent: (target: string) => Promise<unknown>;
		_rlmChildSessions: Map<string, ChildSessionStub>;
	};
	const harness: ImageTurnHarness = {
		session,
		servedModelIds,
		requests,
		spawns,
		spawnChild: (options = {}) => {
			children.runRlmChild = vi.fn(async (prompt: string, kwargs: Record<string, unknown>) => {
				spawns.push({ prompt, kwargs });
				const id = `child-${spawns.length}`;
				children._rlmChildSessions.set(id, {
					session: {
						getLastAssistantText: () => options.reading ?? "A tall bridge at sunset.",
						dispose: () => {},
					},
				});
				children.collectRlmChildren = vi.fn(async () => {
					if (options.concurrentTurnDuringRead) {
						await session.acceptAgentMessagePrompt("a heartbeat arrived", {
							customMessage: createAgentSessionMessage({
								id: "agentmsg-heartbeat",
								source: "agent_message",
								target: { activeSessionId: "parent", sessionId: session.sessionId },
								from: { activeSessionId: "other", sessionId: "another-session" },
								message: "a heartbeat arrived",
							}),
						});
					}
					if (options.replyDuringRead) {
						// The child replied to the parent the way an RLM child does;
						// that lands while this read is still awaited.
						await session.acceptAgentMessagePrompt(options.replyDuringRead, {
							customMessage: createAgentSessionMessage({
								id: "agentmsg-read-child",
								source: "agent_message",
								target: { activeSessionId: "parent", sessionId: session.sessionId },
								from: { activeSessionId: "child", sessionId: READ_CHILD_SESSION_ID },
								message: options.replyDuringRead,
							}),
						});
					}
					if (options.unremovableTempDir) {
						// The reading is in hand by now, so a directory that still holds
						// files but denies writes makes the cleanup rmSync fail the way a
						// locked temp directory does.
						const readDir = spawns.at(-1)?.prompt.match(/(\S*prime-agent-image-turn-[^/\s]+)\/image-1\./)?.[1];
						if (readDir) {
							chmodSync(readDir, 0o500);
							blockedTempDirs.push(readDir);
						}
					}
					return {
						results: [
							{
								rlm_child_id: id,
								status: options.status ?? "done",
								settled: options.settled ?? true,
								error: options.error,
							},
						],
					};
				});
				children.deleteRlmSubagent = vi.fn(async () => ({}));
				return { rlm_child_id: id };
			});
			// The child session publishes right after spawn; the stub binds it here so
			// the read child's identity is registered before it can reply.
			children._awaitPendingRlmChildPublication = vi.fn(async () => READ_CHILD_SESSION_ID);
		},
		releaseHeldTurn: () => {
			for (const stream of heldStreams.splice(0)) {
				stream.push({ type: "done", reason: "stop", message: assistantMsg("ok") });
			}
		},
		dispose: () => {
			session.dispose();
			for (const blocked of blockedTempDirs.splice(0)) {
				chmodSync(blocked, 0o700);
				rmSync(blocked, { recursive: true, force: true });
			}
			rmSync(dir, { recursive: true, force: true });
		},
	};
	return harness;
}

const harnesses: ImageTurnHarness[] = [];
function harnessFor(settings: Record<string, unknown>, options: { vision?: boolean } = {}): ImageTurnHarness {
	const harness = createImageTurnHarness(settings, options);
	harnesses.push(harness);
	return harness;
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.dispose();
});

describe("image turns on a text-only session model", () => {
	it("spawns one bounded child pinned to the image model and keeps only its text", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A dashboard with a red error banner." });
		const { session } = harness;
		await session.prompt("Earlier unrelated work.", { images: undefined });
		await session.prompt("What does this screenshot show?", { images: [IMAGE] });

		expect(harness.spawns).toHaveLength(1);
		expect(harness.spawns[0]?.kwargs).toEqual({ model: VISION });
		// The child gets the materialized image and the user's question, never the
		// transcript that the in-place routed turn used to re-read.
		expect(harness.spawns[0]?.prompt).toContain("What does this screenshot show?");
		expect(harness.spawns[0]?.prompt).toMatch(/image-1\.png/);
		expect(harness.spawns[0]?.prompt).not.toContain("Earlier unrelated work.");
		// The session model serves the turn, so no model change is recorded.
		expect(harness.servedModelIds).toEqual(["claude-opus-4-7-text-only", "claude-opus-4-7-text-only"]);
		expect(session.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toHaveLength(0);

		const userMessage = session.messages.at(-2) as { content: Array<{ type: string; text?: string }> };
		const content = userMessage.content;
		expect(content.some((block) => block.type === "image")).toBe(false);
		expect(content.map((block) => block.text ?? "").join("\n")).toContain("A dashboard with a red error banner.");
		// The provider request carries the reading, not the image payload.
		const lastRequest = harness.requests.at(-1) ?? [];
		expect(
			lastRequest.some((message) => message.content.some((block) => (block as { type: string }).type === "image")),
		).toBe(false);
		expect(
			lastRequest.some((message) =>
				JSON.stringify(message.content).includes("A dashboard with a red error banner."),
			),
		).toBe(true);
	});

	it("keeps the reading when the temp directory cannot be removed", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A tall bridge at sunset.", unremovableTempDir: true });
		// The read succeeded before the cleanup ran, so the turn must resolve.
		await harness.session.prompt("what does this show?", { images: [IMAGE] });
		const readDir = harness.spawns.at(-1)?.prompt.match(/(\S*prime-agent-image-turn-[^/\s]+)\/image-1\./)?.[1] ?? "";
		// The removal really failed, so the turn survived a cleanup error rather
		// than a cleanup that quietly worked.
		expect(readDir).not.toBe("");
		expect(existsSync(readDir)).toBe(true);
		expect(contentText(userContents(harness.session).at(-1) ?? [])).toContain("A tall bridge at sunset.");
		expect(harness.spawns).toHaveLength(1);
	});

	it("leaves the actionable settings error in place when no image model resolves", async () => {
		const harness = harnessFor({});
		harness.spawnChild();
		await expect(harness.session.prompt("look", { images: [IMAGE] })).rejects.toThrow(/does not accept image input/);
		expect(harness.spawns).toHaveLength(0);
	});

	it("refuses an unusable pinned model before any image leaves the process", async () => {
		const harness = harnessFor({ imageModel: "openai/gpt-5.4" });
		harness.spawnChild();
		await expect(harness.session.prompt("look", { images: [IMAGE] })).rejects.toThrow(/could not be resolved/);
		expect(harness.spawns).toHaveLength(0);
	});

	it("spawns nothing when images are blocked", async () => {
		const harness = harnessFor({ ...SET, images: { blockImages: true } });
		harness.spawnChild();
		await harness.session.prompt("look", { images: [IMAGE] });
		expect(harness.spawns).toHaveLength(0);
		expect(harness.servedModelIds).toEqual(["claude-opus-4-7-text-only"]);
	});

	it("keeps one child for every image in the turn", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "Two panels." });
		await harness.session.prompt("compare these", { images: [IMAGE, { ...IMAGE, mimeType: "image/jpeg" }] });
		expect(harness.spawns).toHaveLength(1);
		expect(harness.spawns[0]?.prompt).toMatch(/image-1\.png/);
		expect(harness.spawns[0]?.prompt).toMatch(/image-2\.jpeg/);
		expect(harness.spawns[0]?.prompt).toContain("2 images");
	});

	it("fails the turn with the setting named when the child never settles", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ settled: false });
		await expect(harness.session.prompt("look", { images: [IMAGE] })).rejects.toThrow(
			/did not finish reading the attached image\(s\).*image-model/s,
		);
		expect(harness.servedModelIds).toEqual([]);
	});
});

/** Content blocks of every user message the session recorded. */
function userContents(session: AgentSession): Array<Array<{ type: string; text?: string }>> {
	return session.messages.flatMap((message) => {
		const entry = message as { role?: string; content?: Array<{ type: string; text?: string }> };
		return entry.role === "user" && Array.isArray(entry.content) ? [entry.content] : [];
	});
}

function contentText(content: Array<{ type: string; text?: string }>): string {
	return content.map((block) => block.text ?? "").join("\n");
}

describe("image steers and follow-ups", () => {
	it("queues a steered image inline on a vision-capable session model", async () => {
		const harness = harnessFor(SET, { vision: true });
		harness.spawnChild();
		await harness.session.steer("look at this", [IMAGE]);
		await harness.session.prompt("continue");
		expect(harness.spawns).toHaveLength(0);
		const steered = userContents(harness.session).find((content) => contentText(content).includes("look at this"));
		expect(steered?.some((block) => block.type === "image")).toBe(true);
	});

	it("reads steered images with the child on a text-only session model", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A red error banner." });
		await harness.session.steer("look at this", [IMAGE]);
		await harness.session.prompt("continue");
		expect(harness.spawns).toHaveLength(1);
		const steered = userContents(harness.session).find((content) => contentText(content).includes("look at this"));
		expect(steered?.some((block) => block.type === "image")).toBe(false);
		expect(contentText(steered ?? [])).toContain("A red error banner.");
	});

	it("reads follow-up images with the child on a text-only session model", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A chart trending up." });
		await harness.session.followUp("look at this", [IMAGE]);
		await harness.session.prompt("continue");
		expect(harness.spawns).toHaveLength(1);
		const queued = userContents(harness.session).find((content) => contentText(content).includes("look at this"));
		expect(queued?.some((block) => block.type === "image")).toBe(false);
		expect(contentText(queued ?? [])).toContain("A chart trending up.");
	});

	it("keeps a follow-up image inline on a vision-capable session model", async () => {
		const harness = harnessFor(SET, { vision: true });
		harness.spawnChild();
		await harness.session.followUp("look at this", [IMAGE]);
		await harness.session.prompt("continue");
		expect(harness.spawns).toHaveLength(0);
		const queued = userContents(harness.session).find((content) => contentText(content).includes("look at this"));
		expect(queued?.some((block) => block.type === "image")).toBe(true);
	});
	it("does not orphan a failing read on an image-carrying steer or follow-up", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ settled: false });
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			await expect(harness.session.steer("look at this", [IMAGE])).rejects.toThrow(/did not finish reading/);
			await expect(harness.session.followUp("look at this", [IMAGE])).rejects.toThrow(/did not finish reading/);
			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("caps oversized and unsupported images before writing them out", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "One small panel." });
		const huge: typeof IMAGE = { type: "image", mimeType: "image/png", data: "A".repeat(12_000_000) };
		const pdf: typeof IMAGE = { type: "image", mimeType: "application/pdf", data: "aGk=" };
		await harness.session.prompt("look at these", { images: [IMAGE, huge, pdf] });
		expect(harness.spawns).toHaveLength(1);
		expect(harness.spawns[0]?.prompt).toMatch(/image-1\.png/);
		expect(harness.spawns[0]?.prompt).not.toMatch(/image-2/);
		const content = userContents(harness.session).at(-1) ?? [];
		expect(contentText(content)).toContain("2 image(s) were skipped:");
	});
	it("admits the turn when the read child replies to the parent mid-read", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A red banner.", replyDuringRead: "Here is my reading." });
		await harness.session.prompt("look at this", { images: [IMAGE] });
		// The reply is suppressed: the parent's own turn is admitted and answered.
		expect(harness.servedModelIds).toEqual(["claude-opus-4-7-text-only"]);
		const text = userContents(harness.session)
			.map((content) => contentText(content))
			.join("\n");
		expect(text).toContain("look at this");
		expect(text).toContain("A red banner.");
		expect(text).not.toContain("Here is my reading.");
	});

	it("still admits a reply from a child that is not a read child", async () => {
		const harness = harnessFor({});
		harness.spawnChild();
		await harness.session.acceptAgentMessagePrompt("hello from a subagent", {
			customMessage: createAgentSessionMessage({
				id: "agentmsg-other-child",
				source: "agent_message",
				target: { activeSessionId: "parent", sessionId: harness.session.sessionId },
				from: { activeSessionId: "child", sessionId: "some-other-child-session" },
				message: "hello from a subagent",
			}),
			streamingBehavior: "followUp",
		});
		await harness.session.waitForIdle();
		expect(harness.servedModelIds.length).toBeGreaterThan(0);
	});
	it("admits the prompt when another turn starts streaming during the read", async () => {
		const harness = harnessFor(SET);
		harness.spawnChild({ reading: "A red banner.", concurrentTurnDuringRead: true });
		await harness.session.prompt("look at this", { images: [IMAGE] });
		// The prompt the user submitted while idle is admitted instead of being
		// rejected because a turn started inside the read's await window.
		const text = userContents(harness.session)
			.map((content) => contentText(content))
			.join("\n");
		expect(text).toContain("look at this");
		expect(text).toContain("A red banner.");
		// Hold the concurrent turn open until now, then release it so the session
		// idles before teardown.
		harness.releaseHeldTurn();
		await harness.session.waitForIdle();
	});
});
