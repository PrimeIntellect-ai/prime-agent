import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentSessionMessagePayload } from "../../src/core/agent-messages.js";
import { createAgentSessionMessage, isAgentSessionMessage } from "../../src/core/agent-messages.js";
import type { AgentSession } from "../../src/core/agent-session.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createSessionMessageObligationBridge } from "../../src/core/session-message-obligation-bridge.js";
import type { SessionMessageObligationOwnerContinuityHandoff } from "../../src/core/session-message-obligation-store.js";
import { createHarness } from "../suite/harness.js";

const mode = process.argv[2];
const rootDir = process.argv[3];
if (
	(mode !== "before" &&
		mode !== "accept" &&
		mode !== "recover" &&
		mode !== "context" &&
		mode !== "context-no-intent" &&
		mode !== "quarantine" &&
		mode !== "quarantine-no-intent" &&
		mode !== "overload" &&
		mode !== "compaction-accept" &&
		mode !== "compaction-recover" &&
		mode !== "tool-accept" &&
		mode !== "tool-recover") ||
	rootDir === undefined
) {
	throw new Error(
		"Usage: session-message-obligation-process.ts <before|accept|recover|context|context-no-intent|quarantine|quarantine-no-intent|overload|compaction-accept|compaction-recover|tool-accept|tool-recover> <root>",
	);
}

mkdirSync(rootDir, { recursive: true });

const payload: AgentSessionMessagePayload = {
	id: "agentmsg_process_boundary",
	observationId: "agentobs_process_boundary",
	source: "agent_message",
	message: "process-boundary durable message",
	from: {
		activeSessionId: "source-active",
		sessionId: "source-session",
		sessionName: "source",
		runtimeKind: "subagent",
		clientId: "process-test",
	},
	fromRelationship: "parent",
	target: {
		activeSessionId: "target-active",
		sessionId: "target-session",
		sessionName: "target",
		runtimeKind: "top-level",
	},
};

function payloadFor(targetSessionId: string): AgentSessionMessagePayload {
	return {
		...payload,
		id: "agentmsg_compaction_process_boundary",
		observationId: "agentobs_compaction_process_boundary",
		message: "recover after process death during compaction",
		target: { ...payload.target, sessionId: targetSessionId },
	};
}

function writeResult(value: Record<string, unknown>): void {
	writeFileSync(join(rootDir, "result.json"), `${JSON.stringify(value)}\n`, "utf8");
}

function holdProcess(): void {
	setInterval(() => {}, 1_000);
}

function stalledTool(): AgentTool {
	return {
		name: "stalled_process_review",
		label: "Stalled process review",
		description: "Wait until the host terminates this attempt.",
		parameters: Type.Object({}),
		execute: async (_toolCallId, _params, signal) => {
			await new Promise<void>((_resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("aborted"));
					return;
				}
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return { content: [{ type: "text", text: "unreachable" }], details: {} };
		},
	};
}

function sessionFor(options: { persisted: boolean; queued: string[]; hasAction?: boolean }): AgentSession {
	return {
		hasPersistedAgentMessage: () => options.persisted,
		hasAgentMessageAction: () => options.hasAction ?? false,
		queueAgentMessagePrompt: async () => {
			options.queued.push(payload.id);
			return true;
		},
	} as unknown as AgentSession;
}

async function main(): Promise<void> {
	if (mode === "tool-accept") {
		const sessionManager = SessionManager.create(rootDir, join(rootDir, "sessions"));
		const harness = await createHarness({
			sessionManager,
			tools: [stalledTool()],
			toolExecutionDeadlineMs: 2_000,
		});
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stalled_process_review", {}, { id: "tool-process-boundary" }), {
				stopReason: "toolUse",
			}),
		]);
		void harness.session.prompt("start the bounded process review");
		while (harness.session.getToolExecutionLiveness().length === 0)
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		const processPayload = payloadFor(harness.session.sessionId);
		const bridge = await createSessionMessageObligationBridge({
			rootDir: join(rootDir, "tool-obligations"),
			targetSessionId: harness.session.sessionId,
			ownerId: `tool-process:${process.pid}`,
		});
		const accepted = await bridge.accept({ payload: processPayload, lane: "steering" });
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("Tool process session was not persisted");
		writeFileSync(join(rootDir, "session-path.txt"), sessionFile, "utf8");
		writeResult({
			status: "tool-with-accepted-control",
			sessionId: harness.session.sessionId,
			queued: accepted.obligations.length,
		});
		holdProcess();
		return;
	}

	if (mode === "tool-recover") {
		const sessionFile = readFileSync(join(rootDir, "session-path.txt"), "utf8");
		const sessionManager = SessionManager.open(sessionFile);
		const harness = await createHarness({ sessionManager, tools: [stalledTool()], toolExecutionDeadlineMs: 2_000 });
		const reconstructedStallDiagnostic = harness.session.getToolExecutionStallDiagnostic();
		harness.setResponses([fauxAssistantMessage("queued tool control processed exactly once")]);
		const bridge = await createSessionMessageObligationBridge({
			rootDir: join(rootDir, "tool-obligations"),
			targetSessionId: harness.session.sessionId,
			ownerId: `tool-recovery:${process.pid}`,
		});
		harness.session.setAgentMessageObligationBridge(bridge);
		await bridge.bindSession(harness.session);
		const deadline = Date.now() + 3_000;
		let journal = "";
		while (Date.now() < deadline) {
			journal = readFileSync(join(rootDir, "tool-obligations", "message-obligations.jsonl"), "utf8");
			if (
				harness.faux.state.callCount === 1 &&
				harness.session.unfinishedActionCount === 0 &&
				journal.includes('"kind":"processed"')
			)
				break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		writeResult({
			status: "tool-recovered",
			providerCalls: harness.faux.state.callCount,
			messageCount: harness.session.messages.filter(
				(candidate) =>
					isAgentSessionMessage(candidate) && candidate.details.id === "agentmsg_compaction_process_boundary",
			).length,
			processedCount: journal.match(/"kind":"processed"/gu)?.length ?? 0,
			stallDiagnostic: reconstructedStallDiagnostic,
		});
		await bridge.close();
		harness.cleanup();
		return;
	}

	if (mode === "compaction-accept") {
		const sessionManager = SessionManager.create(rootDir, join(rootDir, "sessions"));
		const harness = await createHarness({
			sessionManager,
			compactionDeadlineMs: 60_000,
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => {
						await new Promise<void>(() => {});
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await harness.session.prompt("first turn");
		await harness.session.prompt("second turn");
		void harness.session.compact(undefined, { skipAbort: true });
		while (!harness.session.isCompacting) await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		const processPayload = payloadFor(harness.session.sessionId);
		const bridge = await createSessionMessageObligationBridge({
			rootDir: join(rootDir, "compaction-obligations"),
			targetSessionId: harness.session.sessionId,
			ownerId: `compaction-process:${process.pid}`,
		});
		await bridge.accept({ payload: processPayload, lane: "steering" });
		harness.session.setAgentMessageObligationBridge(bridge);
		await bridge.bindSession(harness.session);
		const sessionFile = sessionManager.getSessionFile();
		if (sessionFile === undefined) throw new Error("Compaction process session was not persisted");
		writeFileSync(join(rootDir, "session-path.txt"), sessionFile, "utf8");
		writeResult({
			status: "compacting-with-accepted-message",
			sessionId: harness.session.sessionId,
			queued: harness.session.queuedActionCount,
		});
		holdProcess();
		return;
	}

	if (mode === "compaction-recover") {
		const sessionFile = readFileSync(join(rootDir, "session-path.txt"), "utf8");
		const sessionManager = SessionManager.open(sessionFile);
		const harness = await createHarness({ sessionManager });
		harness.setResponses([fauxAssistantMessage("message handled after process recovery")]);
		const bridge = await createSessionMessageObligationBridge({
			rootDir: join(rootDir, "compaction-obligations"),
			targetSessionId: harness.session.sessionId,
			ownerId: `compaction-recovery:${process.pid}`,
		});
		harness.session.setAgentMessageObligationBridge(bridge);
		await bridge.bindSession(harness.session);
		const deadline = Date.now() + 10_000;
		let journal = "";
		while (Date.now() < deadline) {
			journal = readFileSync(join(rootDir, "compaction-obligations", "message-obligations.jsonl"), "utf8");
			if (
				harness.faux.state.callCount === 1 &&
				harness.session.unfinishedActionCount === 0 &&
				journal.includes('"kind":"processed"')
			) {
				break;
			}
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		await harness.session.agent.waitForIdle();
		writeResult({
			status: "compaction-recovered",
			providerCalls: harness.faux.state.callCount,
			messageCount: harness.session.messages.filter(
				(candidate) =>
					isAgentSessionMessage(candidate) && candidate.details.id === "agentmsg_compaction_process_boundary",
			).length,
			acceptedCount: journal.match(/"kind":"accepted"/gu)?.length ?? 0,
			wakeClaimedCount: journal.match(/"kind":"wake_claimed"/gu)?.length ?? 0,
			contextDeliveredCount: journal.match(/"kind":"context_delivered"/gu)?.length ?? 0,
			processedCount: journal.match(/"kind":"processed"/gu)?.length ?? 0,
		});
		await bridge.close();
		harness.cleanup();
		return;
	}

	if (mode === "before") {
		writeFileSync(join(rootDir, "before-commit.marker"), "before\n", "utf8");
		process.exitCode = 17;
		return;
	}

	if (mode === "overload") {
		const bridge = await createSessionMessageObligationBridge({
			rootDir,
			targetSessionId: payload.target.sessionId,
			ownerId: `process:${process.pid}`,
			store: { capacity: { maxItems: 1 } },
		});
		try {
			await bridge.accept({ payload, lane: "steering" });
			const second = await bridge.accept({
				payload: { ...payload, id: "agentmsg_process_overload", observationId: "agentobs_process_overload" },
				lane: "steering",
			});
			writeResult({ status: "unexpected-accepted", accepted: second.accepted });
			process.exitCode = 19;
		} catch (error) {
			writeResult({
				status: "rejected",
				code: error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined,
				message: error instanceof Error ? error.message : String(error),
			});
		} finally {
			await bridge.close();
		}
		return;
	}

	if (mode === "accept") {
		const bridge = await createSessionMessageObligationBridge({
			rootDir,
			targetSessionId: payload.target.sessionId,
			ownerId: `process:${process.pid}`,
		});
		const accepted = await bridge.accept({ payload, lane: "steering" });
		writeResult({ status: "accepted", ...accepted });
		holdProcess();
		return;
	}

	if (mode === "recover") {
		const queued: string[] = [];
		const bridge = await createSessionMessageObligationBridge({
			rootDir,
			targetSessionId: payload.target.sessionId,
			ownerId: `process:${process.pid}`,
		});
		try {
			await bridge.bindSession(sessionFor({ persisted: false, queued }));
			writeResult({
				status: "recovered",
				queued,
				manifest: existsSync(join(rootDir, "message-obligations.manifest.json")),
			});
		} finally {
			await bridge.close();
		}
		return;
	}

	const continuityHandoff =
		mode === "quarantine"
			? (JSON.parse(
					readFileSync(join(rootDir, "successor-handoff.json"), "utf8"),
				) as SessionMessageObligationOwnerContinuityHandoff)
			: undefined;
	const bridge = await createSessionMessageObligationBridge({
		rootDir,
		targetSessionId: payload.target.sessionId,
		ownerId: continuityHandoff?.successorOwnerId ?? `process:${process.pid}`,
		...(continuityHandoff === undefined ? {} : { ownerContinuityHandoff: continuityHandoff }),
	});
	const message = createAgentSessionMessage(payload);
	if (mode === "context" || mode === "context-no-intent") {
		await bridge.beforeAgentMessageDispatch(message);
		await bridge.afterAgentMessageTranscriptAppend(message);
		if (mode === "context") {
			const handoff = await bridge.issueOwnerContinuityHandoff({
				message,
				successorOwnerId: "process:context-successor",
				successorFence: {
					processGeneration: "process-context-successor-generation",
					fencingEpoch: 3,
				},
			});
			writeFileSync(join(rootDir, "successor-handoff.json"), `${JSON.stringify(handoff)}\n`, "utf8");
		}
		writeResult({ status: "context-delivered", successorIntent: mode === "context" });
		holdProcess();
		return;
	}

	const queued: string[] = [];
	try {
		await bridge.bindSession(sessionFor({ persisted: true, queued, hasAction: mode === "quarantine-no-intent" }));
		const dispatch = await bridge.beforeAgentMessageDispatch(message);
		if (mode === "quarantine-no-intent") {
			try {
				await bridge.settleAgentMessage(message, "failed", "process ended after context append");
				writeResult({ status: "unexpected-settlement", dispatch, queued });
				process.exitCode = 19;
			} catch (error) {
				writeResult({
					status: "rejected",
					dispatch,
					queued,
					code: error instanceof Error && "code" in error ? (error as { code?: unknown }).code : undefined,
				});
			}
			return;
		}
		await bridge.settleAgentMessage(message, "failed", "process ended after context append");
		writeResult({ status: dispatch, queued });
	} finally {
		await bridge.close();
	}
}

await main();
