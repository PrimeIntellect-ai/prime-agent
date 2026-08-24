import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	createAgentSessionMessage,
	createAgentSessionMessagePrompt,
} from "../../src/core/agent-messages.js";
import { readSessionInfo, SessionManager } from "../../src/core/session-manager.js";
import type {
	WorkflowArtifactResolver,
	WorkflowHostReceiptConsumerContext,
	WorkflowRuntimeStore,
} from "../../src/core/workflow/contracts.js";
import {
	bindWorkflowExecutionEvidenceSourceToHost,
	createWorkflowExecutionEvidenceAuthority,
} from "../../src/core/workflow/execution-evidence.js";
import type { WorkflowShell } from "../../src/core/workflow/shell.js";
import { summaryForInactiveSession } from "../../src/modes/daemon/daemon-session-list.js";
import { createHarness, type Harness } from "./harness.js";

function stalledTool(): AgentTool {
	return {
		name: "stalled_review",
		label: "Stalled review",
		description: "Wait until the host cancels the invocation.",
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

describe("AgentSession tool execution liveness", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("aborts a silent tool lease at its host deadline and reconstructs the blocker after reopen", async () => {
		const harness = await createHarness({
			persistSession: true,
			tools: [stalledTool()],
			toolExecutionDeadlineMs: 50,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stalled_review", {}, { id: "tool-stall-live" }), {
				stopReason: "toolUse",
			}),
		]);

		const running = harness.session.prompt("run the bounded review");
		await vi.waitFor(() => {
			expect(harness.session.getToolExecutionLiveness()).toEqual([
				expect.objectContaining({
					toolCallId: "tool-stall-live",
					toolName: "stalled_review",
					phase: "running",
					progressEventCount: 0,
				}),
			]);
		});
		await running;

		expect(harness.session.getToolExecutionLiveness()).toEqual([]);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.getToolExecutionStallDiagnostic()).toMatchObject({
			type: "tool_execution_stalled",
			toolCallId: "tool-stall-live",
			toolName: "stalled_review",
			reason: "deadline_exceeded",
			phase: "stalled",
		});

		const sessionFile = harness.session.sessionFile;
		if (!sessionFile) throw new Error("Persisted tool-liveness session is missing its session file");
		const sessionInfo = await readSessionInfo(sessionFile);
		if (!sessionInfo) throw new Error("Persisted tool-liveness session is missing from the saved-session catalog");
		expect(summaryForInactiveSession(sessionInfo)).toMatchObject({
			summary: "Tool execution stalled",
			toolExecutionStallDiagnostic: {
				toolCallId: "tool-stall-live",
				toolName: "stalled_review",
				reason: "deadline_exceeded",
			},
		});

		const reopened = SessionManager.open(sessionFile, harness.sessionManager.getSessionDir());
		const restarted = await createHarness({ sessionManager: reopened, tools: [stalledTool()] });
		harnesses.push(restarted);
		expect(restarted.faux.state.callCount).toBe(0);
		expect(restarted.session.getToolExecutionLiveness()).toEqual([]);
		expect(restarted.session.getToolExecutionStallDiagnostic()).toMatchObject({
			toolCallId: "tool-stall-live",
			reason: "deadline_exceeded",
		});
	});

	it("keeps bounded progress observable and does not classify a completed long tool as stalled", async () => {
		const progressiveTool: AgentTool = {
			name: "progressive_review",
			label: "Progressive review",
			description: "Report bounded progress before completing.",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, _signal, onUpdate) => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				onUpdate?.({ content: [{ type: "text", text: "halfway" }], details: { step: 1 } });
				await new Promise((resolve) => setTimeout(resolve, 30));
				return { content: [{ type: "text", text: "complete" }], details: { step: 2 } };
			},
		};
		const harness = await createHarness({ tools: [progressiveTool], toolExecutionDeadlineMs: 50 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("progressive_review", {}, { id: "tool-progress-live" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("review accepted"),
		]);

		const running = harness.session.prompt("run the progressive review");
		await vi.waitFor(() => {
			expect(harness.session.getToolExecutionLiveness()[0]).toMatchObject({
				toolCallId: "tool-progress-live",
				progressEventCount: 1,
				phase: "running",
			});
		});
		await running;

		expect(harness.session.getToolExecutionLiveness()).toEqual([]);
		expect(harness.session.getToolExecutionStallDiagnostic()).toBeUndefined();
	});

	it("persists a completed tool result while workflow evidence waits on its host lease", async () => {
		let releaseEvidenceLease: (() => void) | undefined;
		const evidenceLease = new Promise<void>((resolve) => {
			releaseEvidenceLease = resolve;
		});
		const runtimeStore = {
			durableContext: {},
		} as unknown as WorkflowRuntimeStore;
		const authority = await createWorkflowExecutionEvidenceAuthority({
			runtimeStore,
			artifactResolver: {} as WorkflowArtifactResolver,
			receiptContext: {} as WorkflowHostReceiptConsumerContext,
			workflowId: "workflow-tool-result-publication",
			rootSessionId: "root-tool-result-publication",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			now: () => "2026-08-18T00:00:00.000Z",
			withHostLeaseOperation: async () => {
				await evidenceLease;
				throw new Error("fixture_workflow_evidence_lease_blocked");
			},
			readWorkflowState: () => ({ status: "active", stateDigest: "fixture", decisionRefs: [{ revision: 1 }] }),
			issueReceipt: () => Promise.reject(new Error("fixture_receipt_not_reached")),
		});
		const workflowHost = {
			execute: () => Promise.reject(new Error("fixture_workflow_execute_not_reached")),
			status: () => ({ status: "active" }),
		} as unknown as WorkflowShell;
		bindWorkflowExecutionEvidenceSourceToHost(authority.source, workflowHost);

		const immediateTool: AgentTool = {
			name: "immediate_result",
			label: "Immediate result",
			description: "Return one result immediately.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "finished" }], details: { durationMs: 1 } }),
		};
		const harness = await createHarness({ persistSession: true, tools: [immediateTool] });
		harnesses.push(harness);
		harness.session.setWorkflowHost(workflowHost, authority.source);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("immediate_result", {}, { id: "tool-result-publication" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("tool result observed"),
		]);

		const running = harness.session.prompt("publish the completed result");
		await vi.waitFor(() => {
			expect(
				harness.sessionManager
					.getEntries()
					.some(
						(entry) =>
							entry.type === "message" &&
							entry.message.role === "toolResult" &&
							entry.message.toolCallId === "tool-result-publication",
					),
			).toBe(true);
		});

		releaseEvidenceLease?.();
		await running;
	});

	it("persists a completed tool result while workflow goal accounting waits", async () => {
		let releaseGoalAccounting: (() => void) | undefined;
		const goalAccounting = new Promise<void>((resolve) => {
			releaseGoalAccounting = resolve;
		});
		let markGoalAccountingStarted: (() => void) | undefined;
		const goalAccountingStarted = new Promise<void>((resolve) => {
			markGoalAccountingStarted = resolve;
		});
		const immediateTool: AgentTool = {
			name: "immediate_accounted_result",
			label: "Immediate accounted result",
			description: "Return one result while durable usage accounting is pending.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "finished" }], details: { durationMs: 1 } }),
		};
		const harness = await createHarness({
			persistSession: true,
			initialGoal: { objective: "publish results without waiting for usage accounting" },
			tools: [immediateTool],
		});
		harnesses.push(harness);
		const workflowHost = {
			execute: () => Promise.resolve(workflowHost.status()),
			accountAssistantUsage: async () => {
				markGoalAccountingStarted?.();
				await goalAccounting;
				return harness.session.readGoalStateForWorkflowProjection();
			},
			status: () => ({ workflowId: "workflow-goal-accounting-publication", status: "active" }),
		} as unknown as WorkflowShell;
		harness.session.setWorkflowHost(workflowHost);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("immediate_accounted_result", {}, { id: "accounted-result" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("tool result observed"),
		]);

		const running = harness.session.prompt("publish the accounted result");
		await goalAccountingStarted;
		let resultPersisted = false;
		try {
			await vi.waitFor(
				() => {
					resultPersisted = harness.sessionManager
						.getEntries()
						.some(
							(entry) =>
								entry.type === "message" &&
								entry.message.role === "toolResult" &&
								entry.message.toolCallId === "accounted-result",
						);
					expect(resultPersisted).toBe(true);
				},
				{ timeout: 500 },
			);
		} finally {
			releaseGoalAccounting?.();
			await running;
		}
		expect(resultPersisted).toBe(true);
	});

	it("binds delayed workflow evidence to the turn that emitted each event", async () => {
		let releaseEvidenceLease: (() => void) | undefined;
		const evidenceLease = new Promise<void>((resolve) => {
			releaseEvidenceLease = resolve;
		});
		let firstLease = true;
		const publishedObservations: Uint8Array[] = [];
		const d_auxiliaryRecords = new Map<string, Uint8Array>();
		const workflowId = "workflow-delayed-turn-binding";
		const epochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
		const head = {
			workflowId,
			epochRef,
			sequence: 1,
			eventDigest: "1".repeat(64),
		};
		const runtimeStore = {
			durableContext: {
				auxiliaryStore: {
					read: async (name: string) => d_auxiliaryRecords.get(name) ?? null,
					write: async (name: string, bytes: Uint8Array) => {
						d_auxiliaryRecords.set(name, bytes);
					},
				},
				withExclusiveLease: async (_name: string, operation: () => Promise<unknown>) => operation(),
			},
			replay: async () => ({ quarantined: false, head }),
			publishArtifact: async (input: { bytes: Uint8Array; sourceEventSequence: number }) => {
				publishedObservations.push(input.bytes);
				const digest = publishedObservations.length.toString(16).padStart(64, "0");
				return {
					envelope: {
						ref: {
							artifactId: `evidence:${digest}`,
							digest,
							relativePath: `artifacts/evidence/${digest}`,
							sizeBytes: input.bytes.byteLength,
							sourceEventSequence: input.sourceEventSequence,
						},
					},
				};
			},
		} as unknown as WorkflowRuntimeStore;
		const authority = await createWorkflowExecutionEvidenceAuthority({
			runtimeStore,
			artifactResolver: {} as WorkflowArtifactResolver,
			receiptContext: {} as WorkflowHostReceiptConsumerContext,
			workflowId,
			rootSessionId: "root-delayed-turn-binding",
			epochRef,
			now: () => "2026-08-18T00:00:00.000Z",
			withHostLeaseOperation: async (operation) => {
				if (firstLease) {
					firstLease = false;
					await evidenceLease;
				}
				return operation();
			},
			readWorkflowState: () => ({ status: "active", stateDigest: "fixture", decisionRefs: [{ revision: 1 }] }),
			issueReceipt: async (input) => ({ ...input, signature: "fixture" }) as never,
		});
		const workflowHost = {
			execute: () => Promise.resolve({ status: "active" }),
			status: () => ({ status: "active" }),
		} as unknown as WorkflowShell;
		bindWorkflowExecutionEvidenceSourceToHost(authority.source, workflowHost);

		const immediateTool: AgentTool = {
			name: "turn_binding_result",
			label: "Turn binding result",
			description: "Return one result immediately.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "finished" }], details: {} }),
		};
		const harness = await createHarness({ persistSession: true, tools: [immediateTool] });
		harnesses.push(harness);
		harness.session.setWorkflowHost(workflowHost, authority.source);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("turn_binding_result", {}, { id: "turn-binding-result" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("second turn completed"),
		]);

		await harness.session.prompt("run both turns");
		releaseEvidenceLease?.();
		await vi.waitFor(() => expect(publishedObservations).toHaveLength(2));
		const l_turnIndexes = publishedObservations.map(
			(bytes) => (JSON.parse(new TextDecoder().decode(bytes)) as { turnIndex: number }).turnIndex,
		);
		expect(l_turnIndexes).toEqual([0, 1]);
	});

	it("clears failed workflow evidence before the next turn", async () => {
		let leaseCalls = 0;
		const runtimeStore = {
			durableContext: {},
			replay: async () => ({
				quarantined: false,
				head: {
					workflowId: "workflow-evidence-recovery",
					epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
					sequence: 1,
					eventDigest: "2".repeat(64),
				},
			}),
		} as unknown as WorkflowRuntimeStore;
		const authority = await createWorkflowExecutionEvidenceAuthority({
			runtimeStore,
			artifactResolver: {} as WorkflowArtifactResolver,
			receiptContext: {} as WorkflowHostReceiptConsumerContext,
			workflowId: "workflow-evidence-recovery",
			rootSessionId: "root-evidence-recovery",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			now: () => "2026-08-18T00:00:00.000Z",
			withHostLeaseOperation: async (operation) => {
				leaseCalls++;
				if (leaseCalls === 2) throw new Error("fixture_complete_turn_failed");
				return operation();
			},
			readWorkflowState: () => ({ status: "active", stateDigest: "fixture", decisionRefs: [{ revision: 1 }] }),
			issueReceipt: () => Promise.reject(new Error("fixture_receipt_not_reached")),
		});
		const workflowHost = {
			execute: () => Promise.reject(new Error("fixture_pause_failed")),
			status: () => ({ status: "active" }),
		} as unknown as WorkflowShell;
		bindWorkflowExecutionEvidenceSourceToHost(authority.source, workflowHost);
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.setWorkflowHost(workflowHost, authority.source);
		harness.setResponses([fauxAssistantMessage("first turn"), fauxAssistantMessage("second turn")]);

		await harness.session.prompt("first prompt");
		await vi.waitFor(() => expect(leaseCalls).toBe(2));
		await harness.session.prompt("second prompt");
		await vi.waitFor(() => expect(leaseCalls).toBeGreaterThanOrEqual(3));
	});

	it("does not let blocked workflow evidence hold session disposal", async () => {
		let releaseEvidenceLease: (() => void) | undefined;
		const evidenceLease = new Promise<void>((resolve) => {
			releaseEvidenceLease = resolve;
		});
		const runtimeStore = {
			durableContext: {},
		} as unknown as WorkflowRuntimeStore;
		const authority = await createWorkflowExecutionEvidenceAuthority({
			runtimeStore,
			artifactResolver: {} as WorkflowArtifactResolver,
			receiptContext: {} as WorkflowHostReceiptConsumerContext,
			workflowId: "workflow-evidence-disposal",
			rootSessionId: "root-evidence-disposal",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			now: () => "2026-08-18T00:00:00.000Z",
			withHostLeaseOperation: async () => {
				await evidenceLease;
				throw new Error("fixture_workflow_evidence_lease_blocked");
			},
			readWorkflowState: () => ({ status: "active", stateDigest: "fixture", decisionRefs: [{ revision: 1 }] }),
			issueReceipt: () => Promise.reject(new Error("fixture_receipt_not_reached")),
		});
		const workflowHost = {
			dispose: () => undefined,
			execute: () => Promise.reject(new Error("fixture_pause_not_reached")),
			status: () => ({ status: "active" }),
		} as unknown as WorkflowShell;
		bindWorkflowExecutionEvidenceSourceToHost(authority.source, workflowHost);
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.session.setWorkflowHost(workflowHost, authority.source);
		harness.setResponses([fauxAssistantMessage("turn completed")]);

		await harness.session.prompt("start blocked evidence");
		const disposing = harness.session.disposeAsync();
		const disposedWithinBound = await Promise.race([
			disposing.then(() => true),
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 50)),
		]);
		releaseEvidenceLease?.();
		await disposing;
		expect(disposedWithinBound).toBe(true);
	});

	it("does not let repeated identical updates renew a tool lease indefinitely", async () => {
		const repeatedHeartbeatTool: AgentTool = {
			name: "repeated_heartbeat_review",
			label: "Repeated heartbeat review",
			description: "Emit a repeated update without new evidence.",
			parameters: Type.Object({}),
			execute: async (_toolCallId, _params, signal, onUpdate) => {
				for (;;) {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(resolve, 20);
						signal?.addEventListener(
							"abort",
							() => {
								clearTimeout(timer);
								reject(new Error("aborted"));
							},
							{ once: true },
						);
					});
					onUpdate?.({ content: [{ type: "text", text: "unchanged" }], details: { step: 1 } });
				}
			},
		};
		const harness = await createHarness({ tools: [repeatedHeartbeatTool], toolExecutionDeadlineMs: 50 });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("repeated_heartbeat_review", {}, { id: "tool-repeated-heartbeat" }), {
				stopReason: "toolUse",
			}),
		]);

		await harness.session.prompt("run the repeated-heartbeat review");

		expect(harness.session.getToolExecutionStallDiagnostic()).toMatchObject({
			toolCallId: "tool-repeated-heartbeat",
			progressEventCount: 1,
			reason: "deadline_exceeded",
		});
	});

	it("delivers one queued control after cancelling a silent tool without another user prompt", async () => {
		const harness = await createHarness({
			persistSession: true,
			tools: [stalledTool()],
			toolExecutionDeadlineMs: 50,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("stalled_review", {}, { id: "tool-stall-control" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("queued control processed exactly once"),
		]);

		const running = harness.session.prompt("run the bounded review");
		await vi.waitFor(() => {
			expect(harness.session.getToolExecutionLiveness()).toEqual([
				expect.objectContaining({ toolCallId: "tool-stall-control", phase: "running" }),
			]);
		});
		const payload = {
			id: "agentmsg-tool-stall-control",
			source: AGENT_MESSAGE_SOURCE,
			message: "serviceAccount:operator@example.invalid",
			target: { activeSessionId: "worker-active", sessionId: "worker-session" },
		} as const;
		const message = createAgentSessionMessage(payload);
		await harness.session.queueAgentMessagePrompt(createAgentSessionMessagePrompt(payload), "steer", message);
		await running;
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0));

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("queued control processed exactly once");
		expect(harness.session.messages.filter((candidate) => candidate === message)).toHaveLength(1);
	});

	it.skipIf(process.platform === "win32")(
		"fences the exact IPython process at a tool deadline before a fresh kernel runs",
		async () => {
			const fixtureDir = mkdtempSync(join(tmpdir(), "prime-agent-tool-fence-"));
			const python = join(fixtureDir, "python");
			const pidFile = join(fixtureDir, "kernel-pids");
			const previousPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
			const previousDelegatePython = process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON;
			const previousPidFile = process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE;
			const delegatePython =
				process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
			writeFileSync(
				python,
				[
					"#!/bin/sh",
					'"$PRIME_AGENT_TEST_DELEGATE_PYTHON" "$@" &',
					"child=$!",
					'echo "$$ $child" >> "$PRIME_AGENT_TEST_KERNEL_PID_FILE"',
					'trap \'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0\' TERM INT',
					'wait "$child"',
					"",
				].join("\n"),
			);
			chmodSync(python, 0o755);
			process.env.PRIME_AGENT_KERNEL_PYTHON = python;
			process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON = delegatePython;
			process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE = pidFile;

			try {
				const harness = await createHarness({
					persistSession: true,
					toolExecutionDeadlineMs: 5_000,
				});
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("ipython", { code: "import time; time.sleep(60)" }, { id: "ipython-stall" }),
						{
							stopReason: "toolUse",
						},
					),
				]);

				await harness.session.prompt("run the bounded kernel operation");
				const firstPids = readFileSync(pidFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split(" ").map(Number) as [number, number]);
				const firstPair = firstPids.at(-1);
				if (firstPair === undefined) throw new Error("The public kernel launcher did not record its processes");
				await vi.waitFor(
					() => {
						expect(() => process.kill(firstPair[0], 0)).toThrow();
						expect(() => process.kill(firstPair[1], 0)).toThrow();
					},
					{ timeout: 3_000 },
				);

				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("ipython", { code: "print(1 + 1)" }, { id: "ipython-after-stall" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("fresh kernel completed"),
				]);
				await harness.session.prompt("continue with a fresh kernel");

				const pids = readFileSync(pidFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => line.split(" ").map(Number) as [number, number]);
				expect(pids.length).toBeGreaterThan(firstPids.length);
				expect(pids.at(-1)).not.toEqual(firstPair);
				expect(
					harness.session.messages.some(
						(message) =>
							message.role === "toolResult" &&
							message.toolCallId === "ipython-after-stall" &&
							message.content.some((block) => block.type === "text" && block.text.includes("2")),
					),
				).toBe(true);
			} finally {
				if (previousPython === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
				else process.env.PRIME_AGENT_KERNEL_PYTHON = previousPython;
				if (previousDelegatePython === undefined) delete process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON;
				else process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON = previousDelegatePython;
				if (previousPidFile === undefined) delete process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE;
				else process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE = previousPidFile;
				rmSync(fixtureDir, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(process.platform === "win32")(
		"fences the exact child kernel before projecting normal task completion",
		async () => {
			const fixtureDir = mkdtempSync(join(tmpdir(), "prime-agent-child-terminal-fence-"));
			const python = join(fixtureDir, "python");
			const pidFile = join(fixtureDir, "kernel-pids");
			const previousPython = process.env.PRIME_AGENT_KERNEL_PYTHON;
			const previousDelegatePython = process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON;
			const previousPidFile = process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE;
			const delegatePython = join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
			writeFileSync(
				python,
				[
					"#!/bin/sh",
					'"$PRIME_AGENT_TEST_DELEGATE_PYTHON" "$@" &',
					"child=$!",
					'echo "$$ $child" >> "$PRIME_AGENT_TEST_KERNEL_PID_FILE"',
					'trap \'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0\' TERM INT',
					'wait "$child"',
					"",
				].join("\n"),
			);
			chmodSync(python, 0o755);
			process.env.PRIME_AGENT_KERNEL_PYTHON = python;
			process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON = delegatePython;
			process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE = pidFile;

			try {
				const harness = await createHarness({ persistSession: true });
				harnesses.push(harness);
				harness.setResponses([
					fauxAssistantMessage(
						fauxToolCall("ipython", { code: "import os; print(os.getpid())" }, { id: "child-kernel-owner" }),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage("terminal child result"),
				]);

				const spawned = await harness.session.runRlmChild("finish with a terminal kernel boundary");
				await expect(harness.session.awaitRlmChildCompletion(spawned.rlm_child_id)).resolves.toMatchObject({
					status: "completed",
					output: "terminal child result",
				});
				const processPair = readFileSync(pidFile, "utf8").trim().split(" ").map(Number) as [number, number];
				for (const pid of processPair) expect(() => process.kill(pid, 0)).toThrow();
				expect(await harness.session.listRlmSubagents()).toEqual({
					subagents: [expect.objectContaining({ rlm_child_id: spawned.rlm_child_id, status: "completed" })],
				});
			} finally {
				if (previousPython === undefined) delete process.env.PRIME_AGENT_KERNEL_PYTHON;
				else process.env.PRIME_AGENT_KERNEL_PYTHON = previousPython;
				if (previousDelegatePython === undefined) delete process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON;
				else process.env.PRIME_AGENT_TEST_DELEGATE_PYTHON = previousDelegatePython;
				if (previousPidFile === undefined) delete process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE;
				else process.env.PRIME_AGENT_TEST_KERNEL_PID_FILE = previousPidFile;
				rmSync(fixtureDir, { recursive: true, force: true });
			}
		},
		60_000,
	);
});
