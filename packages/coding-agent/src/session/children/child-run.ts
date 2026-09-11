import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AGENT_MESSAGE_CUSTOM_TYPE, type AgentSessionMessage } from "../../core/agent-messages.js";
import type { AgentSession } from "../agent-session.js";
import {
	type CustomMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
} from "../context/messages.js";
import {
	compactRlmText,
	createChildDeferred,
	noopRlmChildAbort,
	type RlmChildAgentSnapshot,
	type RlmChildRun,
	readAssistantText,
} from "./child-types.js";
import type { ChildRuntimeRequest, SessionChildrenHost } from "./children.js";
import type {
	CreateRlmSubagentRuntimeOptions,
	RlmSpawnHandle,
	RlmSubagentRegistryEntry,
	RlmSubagentRuntime,
	SubagentRuntimeHost,
} from "./runtime-contracts.js";

interface ChildTaskLifecycle {
	admitRun(run: RlmChildRun): void;
	isCurrentRun(run: RlmChildRun): boolean;
	snapshotForRun(run: RlmChildRun): RlmChildAgentSnapshot;
	registerSession(id: string, session: AgentSession): boolean;
	currentActiveSessionId(): Promise<string | undefined>;
	getRuntimeHost(): SubagentRuntimeHost | undefined;
	recordDeleted(id: string): void;
	removeTracking(id: string, run?: RlmChildRun): void;
	ensureDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void>;
	observeDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean>;
	finishDeletion(run: RlmChildRun): Promise<void>;
	finishRun(run: RlmChildRun): void;
}
type ChildTaskHost = Pick<
	SessionChildrenHost,
	| "createUsageTracker"
	| "emit"
	| "createRuntimeOptions"
	| "deliverTerminalNotice"
	| "isDisposed"
	| "createRuntime"
	| "getSessionId"
	| "getSessionName"
	| "getParentReplyCount"
	| "getSemanticEdges"
>;

/** Owns the admitted task through publication, result delivery and final cleanup. */
export function launchChildTask(
	host: ChildTaskHost,
	lifecycle: ChildTaskLifecycle,
	request: ChildRuntimeRequest,
): RlmSpawnHandle {
	const {
		id: childNodeId,
		prompt,
		sessionName,
		spawnCode,
		sessionDir: childSessionDir,
		thinkingLevel: requestedThinkingLevel,
		spawnedByRequestId,
	} = request;
	const modelSelection = { model: request.model };
	const startedAt = Date.now();
	const usage = host.createUsageTracker();
	let runningToolCount = 0;
	let childSession: AgentSession | undefined;
	const run: RlmChildRun = {
		id: childNodeId,
		prompt,
		sessionName,
		sessionDir: childSessionDir,
		model: modelSelection.model,
		status: "queued",
		toolUseCount: 0,
		settled: false,
		abort: noopRlmChildAbort,
		publication: createChildDeferred(),
		settlement: createChildDeferred(),
		deletionReservation: createChildDeferred(),
	};
	const throwIfCancelled = () => {
		if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
	};
	lifecycle.admitRun(run);
	const emitChildUpdate = () => {
		const child = lifecycle.snapshotForRun(run);
		const serialized = JSON.stringify(child);
		if (serialized === run.lastEmittedUpdate) return;
		run.lastEmittedUpdate = serialized;
		host.emit({ type: "rlm_child_update", child });
	};
	run.emitUpdate = emitChildUpdate;
	emitChildUpdate();

	const publishChildSession = (child: AgentSession) => {
		childSession = child;
		if (!lifecycle.isCurrentRun(run)) return;
		run.session = child;
		run.abort = () => void child.abort();
		run.publication.resolve();
		// Cancellation may have been admitted while runtime construction was
		// blocked and run.abort was still a no-op.
		if (run.status === "cancelled") run.abort();
	};
	const subagentOptions: CreateRlmSubagentRuntimeOptions = {
		...host.createRuntimeOptions({
			id: childNodeId,
			prompt,
			sessionName,
			spawnCode,
			sessionDir: childSessionDir,
			model: modelSelection.model,
			thinkingLevel: requestedThinkingLevel,
			spawnedByRequestId,
		}),
		onSessionPublished: publishChildSession,
	};

	const deliverTerminalMessageToParent = async (message: CustomMessage): Promise<void> => {
		// Synthesized lifecycle notices always use the parent's private durable
		// path. Explicit child replies continue through agent_message separately.
		await host.deliverTerminalNotice(message);
	};

	run.completeDeletion = () => {
		if (!run.deletionNeedsCompletionNotice || run.suppressTerminalNotice || host.isDisposed()) {
			return Promise.resolve();
		}
		if (run.deletionNotice) return run.deletionNotice;
		const notice = deliverTerminalMessageToParent(
			createRlmChildTerminalNoticeMessage({
				kind: "cancelled",
				childId: run.id,
				sessionName,
				reason: run.error ?? "Deleted by parent orchestrator",
			}),
		);
		run.deletionNotice = notice;
		return notice;
	};

	run.reportDeletionCleanupFailure = (error) => {
		if (run.suppressTerminalNotice || host.isDisposed()) return Promise.resolve();
		if (run.deletionFailureNotice) return run.deletionFailureNotice;
		const cleanupError = error instanceof Error ? error.message : String(error);
		const notice = deliverTerminalMessageToParent(
			createRlmChildFailureMessage({
				childId: run.id,
				sessionName,
				error: `Deletion cleanup failed; retry rlm.delete_subagent("${run.id}") before completion: ${cleanupError}`,
			}),
		);
		run.deletionFailureNotice = notice;
		return notice;
	};

	// Runtime startup and the task run are deliberately detached. The public
	// spawn resolves at admission, while this task owns live tracking, usage,
	// retention, cancellation, and late-startup cleanup.
	void (async () => {
		let childRuntime: RlmSubagentRuntime | undefined;
		try {
			childRuntime = await host.createRuntime(subagentOptions);
			const child = childRuntime.session;
			if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
			if (child.sessionName !== sessionName) child.setSessionName(sessionName);
			publishChildSession(child);
			throwIfCancelled();
			run.status = "running";
			emitChildUpdate();
			const unsubscribeChildEvents = child.subscribe((event) => {
				if (event.type === "rlm_child_update") {
					host.emit(event);
					return;
				}
				if (event.type === "agent_start") {
					run.activity = { kind: "waiting" };
					emitChildUpdate();
				} else if (event.type === "agent_end") {
					usage.flush();
					run.activity = undefined;
					emitChildUpdate();
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					const assistant = event.message as AssistantMessage;
					if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
						usage.record(child.messages, assistant);
					}
					const text = compactRlmText(readAssistantText(assistant));
					if (text) run.answerPreview = text;
					emitChildUpdate();
				} else if (event.type === "message_start" || event.type === "message_update") {
					if (event.message.role === "assistant") {
						const text = compactRlmText(readAssistantText(event.message as AssistantMessage));
						if (text) run.answerPreview = text;
						run.activity = { kind: "writing" };
						emitChildUpdate();
					}
				} else if (event.type === "tool_execution_start") {
					usage.flushIfStale();
					run.toolUseCount += 1;
					runningToolCount += 1;
					run.activity = { kind: "executing", toolName: event.toolName };
					emitChildUpdate();
				} else if (event.type === "tool_execution_end") {
					runningToolCount = Math.max(0, runningToolCount - 1);
					if (runningToolCount === 0) run.activity = { kind: "waiting" };
					emitChildUpdate();
				} else if (event.type === "session_info_changed" || event.type === "recap_update") {
					emitChildUpdate();
				}
			});
			run.unsubscribe = unsubscribeChildEvents;
			const content = `[task from parent]\n\n${prompt}`;
			const spawnMessage: AgentSessionMessage = {
				role: "custom",
				customType: AGENT_MESSAGE_CUSTOM_TYPE,
				content,
				display: true,
				details: {
					id: `spawn:${run.id}`,
					message: prompt,
					from: {
						sessionId: host.getSessionId(),
						sessionName: host.getSessionName(),
						activeSessionId: await lifecycle.currentActiveSessionId(),
					},
					fromRelationship: "parent",
				},
				timestamp: Date.now(),
			};
			throwIfCancelled();
			const parentReplyCountBeforeRun = host.getParentReplyCount(child);
			await child.promptAndWait(content, {
				expandPromptTemplates: false,
				source: "extension",
				customMessage: spawnMessage,
			});
			await child.waitForRlmQuiescence();
			if (run.error) throw new Error(run.error);
			run.status = "done";
			// Only successful completions return; the edge lands on the parent's next commit.
			const childLastCommitted = child.semanticEdges.lastCommittedRequestId;
			if (childLastCommitted !== undefined) {
				host.getSemanticEdges().recordChildReturned(child.sessionId, childLastCommitted);
			}
			run.durationMs = Date.now() - startedAt;
			run.activity = undefined;
			emitChildUpdate();
			if (
				!run.detachedDeletion &&
				!run.suppressTerminalNotice &&
				host.getParentReplyCount(child) === parentReplyCountBeforeRun
			) {
				const lastAssistantText = child.getLastAssistantText();
				await deliverTerminalMessageToParent(
					createRlmChildTerminalNoticeMessage({
						kind: "completed_without_reply",
						childId: run.id,
						sessionName,
						lastAssistantTextPreview: lastAssistantText ? compactRlmText(lastAssistantText) : undefined,
					}),
				);
			}
			if (!lifecycle.registerSession(run.id, child) && !run.detachedDeletion) {
				if (childRuntime && lifecycle.getRuntimeHost()?.releaseRlmSubagentRuntime) {
					await lifecycle.getRuntimeHost()!.releaseRlmSubagentRuntime!(
						childRuntime,
						subagentOptions,
						"error",
					).catch(() => void child.disposeAsync().catch(() => undefined));
				} else {
					await child.disposeAsync().catch(() => undefined);
				}
			}
		} catch (error) {
			const runError = error instanceof Error ? error : new Error(String(error));
			run.publication.reject(runError);
			if (run.status !== "cancelled") {
				run.status = "error";
				run.error = runError.message;
			}
			// A failed child still returns an error outcome the parent consumes;
			// cancelled runs and zero-commit children return nothing.
			const failedChild = childSession ?? childRuntime?.session;
			const failedLastCommitted = failedChild?.semanticEdges.lastCommittedRequestId;
			if (run.status === "error" && failedChild && failedLastCommitted !== undefined) {
				host.getSemanticEdges().recordChildReturned(failedChild.sessionId, failedLastCommitted);
			}
			run.durationMs = Date.now() - startedAt;
			run.activity = undefined;
			if (run.status === "error" && childSession === undefined) {
				// A pre-bind failure leaves no row: "cancelled" is the wire's removal signal.
				host.emit({
					type: "rlm_child_update",
					child: { ...lifecycle.snapshotForRun(run), status: "cancelled" },
				});
			} else {
				emitChildUpdate();
			}
			if (!run.detachedDeletion && !run.suppressTerminalNotice) {
				if (run.status === "error") {
					await deliverTerminalMessageToParent(
						createRlmChildFailureMessage({
							childId: run.id,
							sessionName,
							error: run.error ?? "unknown error",
						}),
					);
				} else if (run.status === "cancelled") {
					await deliverTerminalMessageToParent(
						createRlmChildTerminalNoticeMessage({
							kind: "cancelled",
							childId: run.id,
							sessionName,
							reason: run.error,
						}),
					);
				}
			}
			if (!run.detachedDeletion && childSession && lifecycle.getRuntimeHost()?.releaseRlmSubagentRuntime) {
				try {
					await lifecycle.getRuntimeHost()!.releaseRlmSubagentRuntime!(
						childRuntime ?? { session: childSession },
						subagentOptions,
						run.status === "cancelled" ? "cancelled" : "error",
					);
					if (run.status === "cancelled" && !host.isDisposed()) {
						lifecycle.recordDeleted(run.id);
						lifecycle.removeTracking(run.id);
					}
				} catch {
					await childSession?.disposeAsync().catch(() => undefined);
				}
			} else if (!run.detachedDeletion) {
				try {
					if (childRuntime && lifecycle.getRuntimeHost()) {
						await lifecycle.getRuntimeHost()!.deleteRlmSubagentRuntime(run.id, childRuntime.session);
					} else if (childSession) {
						await childSession.disposeAsync();
					}
					if (run.status === "cancelled" && !host.isDisposed()) {
						lifecycle.recordDeleted(run.id);
						lifecycle.removeTracking(run.id);
					}
				} catch {
					// A failed best-effort retry remains available through the retained cleanup maps.
				}
			}
		} finally {
			usage.flush();
			if (run.detachedDeletion) {
				run.deletionRunFinished = true;
				if (!run.settled) {
					let cleanupSucceeded = !run.deletionCleanupFailed;
					if (childRuntime && cleanupSucceeded) {
						const cleanup = run.deletionCleanup ?? lifecycle.ensureDeletionCleanup(run, childRuntime.session);
						cleanupSucceeded = await lifecycle.observeDeletionCleanup(
							run,
							run.detachedDeletion,
							childRuntime.session,
							cleanup,
						);
					}
					if (cleanupSucceeded) await lifecycle.finishDeletion(run);
				}
			} else {
				lifecycle.finishRun(run);
			}
		}
	})().catch(() => undefined);

	return {
		rlm_child_id: childNodeId,
		name: sessionName,
		session_dir: childSessionDir,
		model: `${modelSelection.model.provider}/${modelSelection.model.id}`,
	};
}
