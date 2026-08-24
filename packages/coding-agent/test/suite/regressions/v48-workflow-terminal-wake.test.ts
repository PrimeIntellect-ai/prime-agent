import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage, createAgentSessionMessageReceipt } from "../../../src/core/agent-messages.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createSessionMessageObligationBridge } from "../../../src/core/session-message-obligation-bridge.js";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { createHarness, type Harness } from "../harness.js";

describe("workflow task terminal wake", () => {
	it("blocks a parent message after the task deadline before model admission", async () => {
		const harness: Harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		try {
			harness.setResponses([fauxAssistantMessage("stale continuation")]);
			const internals = harness.session as unknown as {
				_workflowTaskDeadlineMonotonicAtMs?: number;
			};
			internals._workflowTaskDeadlineMonotonicAtMs = performance.now() - 1;
			const message = createAgentSessionMessage({
				id: "agentmsg-v48-terminal-wake",
				source: "agent_message",
				message: "continue the archived task",
				from: { activeSessionId: "parent-active", sessionId: "parent-session" },
				fromRelationship: "parent",
				target: { activeSessionId: "child-active", sessionId: harness.session.sessionId, runtimeKind: "subagent" },
			});

			await expect(harness.session.queueAgentMessagePrompt(message.content, "steer", message)).rejects.toThrow(
				"workflow_task_deadline_expired",
			);
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	});

	it("restores a terminal workflow child and quarantines its recovery obligation", async () => {
		const harness: Harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		let restoredHarness: Harness | undefined;
		let bridgeRoot: string | undefined;
		let bridge: Awaited<ReturnType<typeof createSessionMessageObligationBridge>> | undefined;
		try {
			const binding = {
				schemaVersion: 1 as const,
				kind: "workflow_task_binding" as const,
				workflowId: "workflow-v48",
				taskId: "task-sub-7b5a9d74",
				attemptId: "attempt-v48",
				executionKey: "execution-v48",
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				capsuleDigest: "capsule-v48",
			};
			const internals = harness.session as unknown as {
				_bindWorkflowTask: (data: typeof binding, isActive: () => boolean) => void;
				_workflowTaskDeadlineMonotonicAtMs?: number;
			};
			internals._bindWorkflowTask(binding, () => true);
			internals._workflowTaskDeadlineMonotonicAtMs = performance.now() - 1;
			const payload = {
				id: "agentmsg-v48-restart",
				source: "agent_message" as const,
				message: "replay the archived workflow task",
				from: { activeSessionId: "parent-active", sessionId: "parent-session" },
				fromRelationship: "parent" as const,
				target: {
					activeSessionId: "child-active",
					sessionId: harness.session.sessionId,
					runtimeKind: "subagent" as const,
				},
			};
			const message = createAgentSessionMessage(payload);
			const blocked = await harness.session.queueAgentMessagePrompt(message.content, "steer", message).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(blocked).toMatchObject({
				code: "AGENT_MESSAGE_BLOCKED",
				status: "blocked",
				auditOnly: true,
				reason: "workflow_task_deadline_expired",
			});
			const blockedReceipt = (
				createAgentSessionMessageReceipt as unknown as (...args: unknown[]) => Record<string, unknown>
			)(payload, "blocked", "workflow_task_deadline_expired");
			expect(blockedReceipt).toMatchObject({
				deliveryStatus: "blocked",
				auditOnly: true,
				blockedReason: "workflow_task_deadline_expired",
			});
			expect(
				harness.sessionManager
					.getBranch()
					.some((entry) => entry.type === "custom" && entry.customType === "workflow_task_terminal"),
			).toBe(true);
			expect(harness.faux.state.callCount).toBe(0);

			const sessionFile = harness.sessionManager.getSessionFile();
			expect(sessionFile).toBeDefined();
			harness.session.dispose();
			restoredHarness = await createHarness({
				sessionManager: SessionManager.open(sessionFile!),
				rlmDepth: 1,
			});
			const restoredInternals = restoredHarness.session as unknown as {
				_workflowTaskTerminal?: { status: string };
				_ipythonKernelProvisioner?: { hasRunningKernel?: boolean };
			};
			expect(restoredInternals._workflowTaskTerminal?.status).toBe("deadline");
			const restoredMessage = createAgentSessionMessage({
				...payload,
				target: { ...payload.target, sessionId: restoredHarness.session.sessionId },
			});
			const restoredBlocked = await restoredHarness.session
				.queueAgentMessagePrompt(restoredMessage.content, "steer", restoredMessage)
				.then(
					() => undefined,
					(error: unknown) => error,
				);
			expect(restoredBlocked).toMatchObject({ code: "AGENT_MESSAGE_BLOCKED", status: "blocked", auditOnly: true });
			expect(restoredHarness.faux.state.callCount).toBe(0);
			expect(restoredInternals._ipythonKernelProvisioner?.hasRunningKernel ?? false).toBe(false);

			bridgeRoot = await mkdtemp(join(tmpdir(), "v48-workflow-obligation-"));
			bridge = await createSessionMessageObligationBridge({
				rootDir: bridgeRoot,
				targetSessionId: restoredHarness.session.sessionId,
				ownerId: "restored-child-v48",
			});
			const obligationPayload = {
				...payload,
				id: "agentmsg-v48-recovery-obligation",
				target: { ...payload.target, sessionId: restoredHarness.session.sessionId },
			};
			await bridge.accept({ payload: obligationPayload, lane: "steering" });
			restoredHarness.session.setAgentMessageObligationBridge(bridge);
			await bridge.bindSession(restoredHarness.session);
			await bridge.bindSession(restoredHarness.session);
			const journal = await readFile(join(bridgeRoot, "message-obligations.jsonl"), "utf8");
			expect(journal.match(/"kind":"failed"/g)).toHaveLength(1);
			expect(journal).toContain("quarantine:workflow_task_deadline_expired");
		} finally {
			await bridge?.close();
			if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
			restoredHarness?.cleanup();
			harness.cleanup();
		}
	});

	it("fences a hung workflow child before publishing its deadline cancellation", async () => {
		const harness: Harness = await createHarness({ rlmDepth: 0 });
		try {
			const order: string[] = [];
			const fence = vi.fn(async () => {
				order.push("fence");
			});
			const emitUpdate = vi.fn(() => {
				order.push("publish");
			});
			const run = {
				status: "running" as const,
				error: undefined,
				session: {
					_workflowTaskBinding: {},
					_recordWorkflowTaskTerminal: vi.fn(),
					_fenceTerminalTaskKernel: fence,
				},
				publication: { reject: vi.fn() },
				abort: vi.fn(() => {
					order.push("abort");
				}),
				emitUpdate,
			};
			const internals = harness.session as unknown as {
				_cancelRlmChildRun: (childRun: typeof run, reason: string) => boolean;
			};

			expect(internals._cancelRlmChildRun(run, "task_deadline_expired")).toBe(true);
			expect(run.abort).toHaveBeenCalledOnce();
			await vi.waitFor(() => expect(fence).toHaveBeenCalledOnce());
			await vi.waitFor(() => expect(emitUpdate).toHaveBeenCalledOnce());
			expect(order).toEqual(["fence", "abort", "publish"]);
		} finally {
			harness.cleanup();
		}
	});

	it("restores a blocked IPython send receipt for the public session/UI path", async () => {
		const harness: Harness = await createHarness({ persistSession: true });
		try {
			harness.sessionManager.appendCustomEntry("ipython_sent_agent_message", {
				toolCallId: "tool-v48-blocked",
				message: {
					id: "agentmsg-v48-blocked-receipt",
					message: "stale workflow send",
					deliveryStatus: "blocked",
					target: {
						activeSessionId: "target-active",
						sessionId: "target-session",
					},
				},
			} as unknown as Record<string, unknown>);
			harness.sessionManager.flushNow();
			const internals = harness.session as unknown as {
				_restoreLateIpythonSentAgentMessages: () => void;
				_lateIpythonSentAgentMessages: Map<string, unknown[]>;
			};
			internals._restoreLateIpythonSentAgentMessages();
			expect(internals._lateIpythonSentAgentMessages.get("tool-v48-blocked")).toHaveLength(1);
		} finally {
			harness.cleanup();
		}
	});

	it("returns a typed blocked receipt through the daemon send path", async () => {
		const harness: Harness = await createHarness({ persistSession: true, rlmDepth: 1 });
		let bridgeRoot: string | undefined;
		let bridge: Awaited<ReturnType<typeof createSessionMessageObligationBridge>> | undefined;
		try {
			const binding = {
				schemaVersion: 1 as const,
				kind: "workflow_task_binding" as const,
				workflowId: "workflow-v48-daemon",
				taskId: "task-v48-daemon",
				attemptId: "attempt-v48-daemon",
				executionKey: "execution-v48-daemon",
				epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
				deadlineAt: new Date(Date.now() + 60_000).toISOString(),
				capsuleDigest: "capsule-v48-daemon",
			};
			const sessionInternals = harness.session as unknown as {
				_bindWorkflowTask: (data: typeof binding, isActive: () => boolean) => void;
				_workflowTaskDeadlineMonotonicAtMs?: number;
			};
			sessionInternals._bindWorkflowTask(binding, () => true);
			sessionInternals._workflowTaskDeadlineMonotonicAtMs = performance.now() - 1;

			bridgeRoot = await mkdtemp(join(tmpdir(), "v48-daemon-obligation-"));
			bridge = await createSessionMessageObligationBridge({
				rootDir: bridgeRoot,
				targetSessionId: harness.session.sessionId,
				ownerId: "daemon-v48-target",
				session: harness.session,
			});
			harness.session.setAgentMessageObligationBridge(bridge);

			const daemon = new AgentDaemon("/tmp/v48-daemon-blocked.sock", {
				defaultSessionConfig: { agentDir: "/tmp/v48-daemon-agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const targetState = {
				activeSessionId: "target-v48-daemon",
				clients: new Set(),
				pendingAttaches: 0,
				lastEventSequence: 0,
				runtime: {
					cwd: "/tmp",
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent-v48-daemon",
						parentSessionId: "parent-session-v48-daemon",
					},
					session: harness.session,
				},
			} as unknown as ActiveSessionState;
			const parentState = {
				activeSessionId: "parent-v48-daemon",
				clients: new Set(),
				pendingAttaches: 0,
				lastEventSequence: 0,
				runtime: {
					metadata: { kind: "top-level", createdAt: 1 },
					session: { sessionId: "parent-session-v48-daemon", sessionName: "parent-v48-daemon", rlmDepth: 0 },
				},
			} as unknown as ActiveSessionState;
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				agentMessageObligationBridges: Map<
					string,
					Awaited<ReturnType<typeof createSessionMessageObligationBridge>>
				>;
				createAgentMessageController(getCurrentState: () => ActiveSessionState | undefined): {
					sendAgentMessage(input: { target: string; message: string }): Promise<unknown>;
				};
			};
			internals.sessions.set(parentState.activeSessionId, parentState);
			internals.sessions.set(targetState.activeSessionId, targetState);
			internals.agentMessageObligationBridges.set(targetState.activeSessionId, bridge);

			const receipt = await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({
					target: targetState.activeSessionId,
					message: "stale workflow continuation",
				});
			expect(receipt).toMatchObject({
				deliveryStatus: "blocked",
				auditOnly: true,
				blockedReason: "workflow_task_deadline_expired",
				target: { activeSessionId: targetState.activeSessionId },
			});
			expect(harness.faux.state.callCount).toBe(0);
			const journal = await readFile(join(bridgeRoot, "message-obligations.jsonl"), "utf8");
			expect(journal).toContain("quarantine:workflow_task_deadline_expired");
		} finally {
			await bridge?.close();
			if (bridgeRoot !== undefined) await rm(bridgeRoot, { recursive: true, force: true });
			harness.cleanup();
		}
	});
});
