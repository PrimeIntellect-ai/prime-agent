import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionMessageController } from "../../src/core/agent-messages.js";
import { AgentSession, extractMarkedPersistedAgentMessage } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { convertToLlm } from "../../src/core/messages.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, type Harness } from "./harness.js";

function messageController(): AgentSessionMessageController {
	return {
		listAgents: () => ({ agents: [] }),
		sendAgentMessage: async (): Promise<never> => {
			throw new Error("this durability test does not send agent messages");
		},
	};
}

describe("AgentSession autoresearch durability", () => {
	let harness: Harness | undefined;
	let restarted: AgentSession | undefined;

	afterEach(() => {
		restarted?.dispose();
		harness?.cleanup();
		restarted = undefined;
		harness = undefined;
	});

	it("preserves canonical memory through model compaction and a process-style session reopen", async () => {
		const controller = messageController();
		harness = await createHarness({
			persistSession: true,
			agentMessageController: controller,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harness.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage("second response"),
			fauxAssistantMessage("durable compaction summary"),
			fauxAssistantMessage("durable turn summary"),
		]);
		await harness.session.prompt("first long-run checkpoint");
		await harness.session.prompt("second long-run checkpoint");

		await harness.session.handleAutoresearchHostRequest("autoresearch.memory.remember", {
			memory: {
				memory_id: "memory-stale-environment",
				type: "FAILED_DIRECTION",
				title: "Stale environment assumptions caused a failed direction",
				content: "Invalidate cached dependency and tool-output assumptions before retrying.",
				importance: 8,
				tags: ["stale-environment", "dependency", "tool-output"],
				source_ids: ["cycle-failed"],
				current_state_references: ["cycle-failed"],
			},
		});
		const artifactDir = harness.sessionManager.getSessionArtifactDir();
		expect(artifactDir).toBeDefined();

		const compaction = await harness.session.compact();
		expect(compaction.summary).toContain("durable compaction summary");
		const afterCompaction = await harness.session.handleAutoresearchHostRequest("autoresearch.get");
		expect(afterCompaction.state).toMatchObject({
			memories: [{ memoryId: "memory-stale-environment" }],
		});

		const sessionFile = harness.sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const reopenedManager = SessionManager.open(sessionFile!);
		expect(reopenedManager.getSessionArtifactDir()).toBe(artifactDir);

		const model = harness.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		const agent = new Agent({
			getApiKey: () => "faux-key",
			initialState: {
				model,
				systemPrompt: "You are a test assistant.",
				tools: [],
			},
			convertToLlm,
		});
		restarted = new AgentSession({
			agent,
			sessionManager: reopenedManager,
			settingsManager: SettingsManager.inMemory(),
			cwd: harness.tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
			agentMessageController: controller,
			rlmDepth: 0,
		});

		const recalled = await restarted.handleAutoresearchHostRequest("autoresearch.memory.recall", {
			query: "stale dependency tool output",
			limit: 3,
		});
		expect(recalled.memories).toMatchObject([
			{
				memoryId: "memory-stale-environment",
				type: "FAILED_DIRECTION",
			},
		]);
	});

	it("waits for a supervisor bootstrap turn to settle before checkpoint delivery", async () => {
		harness = await createHarness({
			persistSession: true,
			agentMessageController: messageController(),
		});
		let settle: () => void = () => undefined;
		const settlement = new Promise<void>((resolve) => {
			settle = resolve;
		});
		const child = {
			sessionId: "supervisor-session",
		};
		const run = {
			id: "sub-supervisor",
			sessionName: "autoresearch-supervisor",
			status: "running",
			error: undefined,
			detachedDeletion: undefined,
			publication: { promise: Promise.resolve() },
			settlement: { promise: settlement },
			session: child,
		};
		const internals = harness.session as unknown as {
			_activeRlmChildRuns: Map<string, typeof run>;
			_awaitPendingRlmChildSettlement(selector: string): Promise<string | undefined>;
		};
		internals._activeRlmChildRuns.set(run.id, run);
		let resolved = false;
		const waiting = internals._awaitPendingRlmChildSettlement(run.sessionName).then((sessionId) => {
			resolved = true;
			return sessionId;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		run.status = "done";
		settle();
		await expect(waiting).resolves.toBe("supervisor-session");
		internals._activeRlmChildRuns.delete(run.id);
	});

	it("bounds a hung supervisor bootstrap settlement by the caller deadline", async () => {
		harness = await createHarness({
			persistSession: true,
			agentMessageController: messageController(),
		});
		const neverSettles = new Promise<void>(() => undefined);
		const run = {
			id: "sub-hung-supervisor",
			sessionName: "autoresearch-supervisor-hung",
			status: "running",
			error: undefined,
			detachedDeletion: undefined,
			publication: { promise: Promise.resolve() },
			settlement: { promise: neverSettles },
			session: { sessionId: "hung-supervisor-session" },
		};
		const internals = harness.session as unknown as {
			_activeRlmChildRuns: Map<string, typeof run>;
			_dispatchAutoresearchCheckpoint(
				supervisor: { rlmChildId: string; name: string },
				cycleId: string,
				packet: Record<string, unknown>,
				timeoutMs: number,
			): Promise<{ error?: string }>;
		};
		internals._activeRlmChildRuns.set(run.id, run);
		await expect(
			internals._dispatchAutoresearchCheckpoint({ rlmChildId: run.id, name: run.sessionName }, "cycle-hung", {}, 5),
		).resolves.toMatchObject({ error: expect.stringContaining("timed out waiting for bootstrap settlement") });
		internals._activeRlmChildRuns.delete(run.id);
	});

	it("reports a retained supervisor as running while its daemon follow-up is active", async () => {
		harness = await createHarness({
			persistSession: true,
			agentMessageController: messageController(),
		});
		const childId = "sub-retained-supervisor";
		const childSession = {
			_rlmSessionDir: "/tmp/sub-retained-supervisor",
			sessionId: "retained-session",
			sessionName: "autoresearch-supervisor-retained",
		};
		const internals = harness.session as unknown as {
			_rlmChildSessions: Map<string, typeof childSession>;
			_buildRlmSubagentList(listed: unknown): { subagents: Array<{ status: string }> };
		};
		internals._rlmChildSessions.set(childId, childSession);
		const listed = {
			current: { activeSessionId: "root-active", sessionId: "root-session", runtimeKind: "top-level" },
			agents: [
				{
					activeSessionId: "child-active",
					sessionId: childSession.sessionId,
					sessionName: childSession.sessionName,
					runtimeKind: "subagent",
					cwd: "/tmp",
					isStreaming: false,
					unfinishedActionCount: 1,
					parentActiveSessionId: "root-active",
					rlmChildId: childId,
					rlmChildRegistryStatus: "completed",
					status: "running",
				},
			],
		};
		expect(internals._buildRlmSubagentList(listed).subagents).toMatchObject([{ status: "running" }]);
		internals._rlmChildSessions.delete(childId);
	});

	it("recovers marked JSON only from a successful durable child-send receipt", () => {
		const marker = "AUTORESEARCH_SUPERVISION_JSON:cycle-1";
		const message = `${marker}\n{"cycle_id":"cycle-1","status":"watch"}`;
		const sent = {
			id: "agentmsg_1",
			message,
			deliveryStatus: "queued",
			receiverRole: "parent",
			target: { activeSessionId: "root-active", sessionId: "root-session" },
		};
		expect(extractMarkedPersistedAgentMessage({ status: "ok", sentAgentMessages: [sent] }, marker)).toBe(message);
		expect(
			extractMarkedPersistedAgentMessage(
				{ status: "ok", sentAgentMessages: [{ ...sent, deliveryStatus: "failed" }] },
				marker,
			),
		).toBeUndefined();
		expect(
			extractMarkedPersistedAgentMessage({ status: "error", sentAgentMessages: [sent] }, marker),
		).toBeUndefined();
		expect(
			extractMarkedPersistedAgentMessage(
				{ status: "ok", sentAgentMessages: [{ ...sent, receiverRole: "sibling" }] },
				marker,
			),
		).toBeUndefined();
		expect(extractMarkedPersistedAgentMessage({ status: "ok" }, marker)).toBeUndefined();
	});

	it("recovers a complete receipt before truncated final text from a validated persisted child", async () => {
		harness = await createHarness({
			persistSession: true,
			agentMessageController: messageController(),
		});
		const artifactDir = harness.sessionManager.getSessionArtifactDir();
		const rootSessionFile = harness.sessionManager.getSessionFile();
		if (!artifactDir || !rootSessionFile) throw new Error("persisted harness paths are missing");
		const childId = "sub-persisted-supervisor";
		const childName = "autoresearch-supervisor-persisted";
		const childDir = join(artifactDir, childId);
		mkdirSync(childDir, { recursive: true });
		const childManager = SessionManager.create(harness.tempDir, childDir);
		childManager.newSession({
			parentSession: rootSessionFile,
			rlmDepth: 1,
		});
		childManager.appendSessionInfo(childName);
		const marker = "AUTORESEARCH_SUPERVISION_JSON:cycle-persisted";
		const complete = `${marker}\n{"cycle_id":"cycle-persisted","status":"watch"}`;
		childManager.appendMessage({
			role: "toolResult",
			toolCallId: "ipython-call",
			toolName: "ipython",
			content: [{ type: "text", text: "Message sent successfully.\n" }],
			details: {
				status: "ok",
				sentAgentMessages: [
					{
						id: "agentmsg_persisted",
						message: complete,
						deliveryStatus: "queued",
						receiverRole: "parent",
						target: { activeSessionId: "root-active", sessionId: "root-session" },
					},
				],
			},
			isError: false,
			timestamp: Date.now(),
		});
		childManager.appendMessage(fauxAssistantMessage(`${marker}\n{"cycle_id":`));
		childManager.flushNow();
		const childSessionFile = childManager.getSessionFile();
		expect(childSessionFile).toBeDefined();
		writeFileSync(
			join(childDir, "rlm-subagent.json"),
			`${JSON.stringify({ childId, sessionName: childName, sessionFile: childSessionFile })}\n`,
			"utf8",
		);

		const internals = harness.session as unknown as {
			_persistedAutoresearchSubagent(
				rlmChildId: string,
				sessionName: string,
			):
				| {
						rlm_child_id: string;
						session_name: string;
						session_dir: string;
				  }
				| undefined;
			_readAutoresearchTerminal(subagent: unknown, marker: string): string | undefined;
		};
		const persisted = internals._persistedAutoresearchSubagent(childId, childName);
		expect(persisted).toMatchObject({
			rlm_child_id: childId,
			session_name: childName,
			session_dir: childDir,
		});
		expect(internals._readAutoresearchTerminal(persisted, marker)).toBe(complete);
		expect(internals._persistedAutoresearchSubagent("../escape", childName)).toBeUndefined();
	});
});
