import type { AgentSessionMessageAgentSummary, AgentSessionMessageListResult } from "../../core/agent-messages.js";
import type { AgentSession } from "../../core/agent-session.js";
import { createDefaultRlmSubagentSessionName, type RlmListSubagentsResult } from "../../core/rlm-runtime.js";
import {
	compactRlmText,
	type RetainedRlmChild,
	type RlmChildAgentSnapshot,
	type RlmChildRun,
	readAssistantText,
	rlmChildLabel,
} from "./child-types.js";

interface ChildVisibility {
	isDeleting(id: string): boolean;
	isDeleted(id: string): boolean;
	hasCleanupFailure(id: string): boolean;
}
export function buildChildList(
	activeRuns: Iterable<RlmChildRun>,
	retainedChildren: Iterable<[string, RetainedRlmChild]>,
	visibility: ChildVisibility,
	getSessionDir: (child: AgentSession) => string | undefined,
	listedAgents?: AgentSessionMessageListResult,
): RlmListSubagentsResult {
	const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
	const parentActiveSessionId = listedAgents?.current?.activeSessionId;
	if (parentActiveSessionId) {
		for (const agent of listedAgents.agents) {
			if (
				agent.runtimeKind === "subagent" &&
				agent.parentActiveSessionId === parentActiveSessionId &&
				agent.rlmChildId
			) {
				daemonChildren.set(agent.rlmChildId, agent);
			}
		}
	}

	const subagents: RlmListSubagentsResult["subagents"] = [];
	const recorded = new Set<string>();
	for (const run of activeRuns) {
		if (visibility.isDeleting(run.id) || run.detachedDeletion || run.status === "cancelled") {
			continue;
		}
		const daemonChild = daemonChildren.get(run.id);
		subagents.push({
			rlm_child_id: run.id,
			active_session_id: daemonChild?.activeSessionId ?? null,
			session_id: daemonChild?.sessionId ?? run.session?.sessionId ?? null,
			session_name: daemonChild?.sessionName ?? run.session?.sessionName ?? run.sessionName,
			session_dir: run.sessionDir,
			status: run.status === "done" ? "completed" : run.status === "error" ? "error" : "running",
		});
		recorded.add(run.id);
	}
	for (const [childId, { session: childSession }] of retainedChildren) {
		if (visibility.isDeleting(childId) || recorded.has(childId) || visibility.hasCleanupFailure(childId)) {
			continue;
		}
		const daemonChild = daemonChildren.get(childId);
		const sessionDir = getSessionDir(childSession);
		if (!sessionDir) {
			continue;
		}
		subagents.push({
			rlm_child_id: childId,
			active_session_id: daemonChild?.activeSessionId ?? null,
			session_id: daemonChild?.sessionId ?? childSession.sessionId,
			session_name:
				daemonChild?.sessionName ?? childSession.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
			session_dir: sessionDir,
			status: "completed",
		});
		recorded.add(childId);
	}
	for (const [childId, daemonChild] of daemonChildren) {
		if (
			recorded.has(childId) ||
			visibility.isDeleting(childId) ||
			visibility.isDeleted(childId) ||
			visibility.hasCleanupFailure(childId) ||
			!daemonChild.sessionDir
		) {
			continue;
		}
		subagents.push({
			rlm_child_id: childId,
			active_session_id: daemonChild.activeSessionId,
			session_id: daemonChild.sessionId,
			session_name: daemonChild.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
			session_dir: daemonChild.sessionDir,
			status: daemonChild.rlmChildRegistryStatus === "completed" ? "completed" : "error",
		});
	}
	return { subagents };
}
export function snapshotChildRun(
	run: RlmChildRun,
	child: AgentSession | undefined,
	parentId: string | undefined,
): RlmChildAgentSnapshot {
	const model = child?.model ?? run.model;
	return {
		id: run.id,
		parentId: parentId,
		sessionName: child?.sessionName ?? run.sessionName,
		model: `${model.provider}/${model.id}`,
		label: rlmChildLabel(run.prompt),
		status: run.status,
		durationMs: run.durationMs,
		answerPreview: run.answerPreview,
		toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
		tokenCount: child?._contextTokensForCurrentMessages(),
		recap: child?.getCurrentRecap(),
		sessionDir: run.sessionDir,
		activity: run.activity,
		repliedSinceTask: child?.repliedToParentSinceTask,
		error: run.error,
	};
}
export function snapshotRetainedChild(
	childId: string,
	child: AgentSession,
	parentId: string | undefined,
	sessionDir: string | undefined,
): RlmChildAgentSnapshot {
	let answerPreview: string | undefined;
	let toolUseCount = 0;
	const messages =
		child.state.streamingMessage?.role === "assistant"
			? [...child.messages, child.state.streamingMessage]
			: child.messages;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const text = compactRlmText(readAssistantText(message));
		if (text) answerPreview = text;
		toolUseCount += message.content.filter((block) => block.type === "toolCall").length;
	}
	return {
		id: childId,
		parentId: parentId,
		sessionName: child.sessionName,
		model: child.model ? `${child.model.provider}/${child.model.id}` : undefined,
		label: child.sessionName ?? "child agent",
		status: "done",
		answerPreview,
		toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
		tokenCount: child._contextTokensForCurrentMessages(),
		recap: child.getCurrentRecap(),
		sessionDir: sessionDir ?? child.sessionManager.getSessionDir(),
		// No run exists (e.g. a child rehydrated after daemon recovery), so live
		// session state is the only source for in-flight follow-up work. Mirror
		// the run projection's convention: status stays "done" (the recorded task
		// finished) and current work surfaces through activity.
		activity: child.isSessionActive ? { kind: child.isStreaming ? "writing" : "waiting" } : undefined,
		repliedSinceTask: child.repliedToParentSinceTask,
	};
}
