import type { SessionSummary } from "./daemon-session-list.js";

export type SessionTreeQuiescenceState = "quiescent" | "working" | "uncertain";

export interface SessionTreeQuiescence {
	state: SessionTreeQuiescenceState;
	quiescent: boolean;
	nonQuiescentDescendantCount: number;
	uncertainDescendantCount: number;
	blockingSessionIds: string[];
}

function summaryKey(summary: SessionSummary, index: number): string {
	return summary.activeSessionId ?? summary.sessionId ?? summary.sessionFile ?? `summary-${index}`;
}

function nodeState(summary: SessionSummary): SessionTreeQuiescenceState {
	if (summary.activity === "working" || (summary.reliability?.openOperationCount ?? 0) > 0) return "working";
	if (!summary.activeSessionId && summary.runtimeKind === "subagent" && summary.passiveRegistryStatus === "running") {
		return "uncertain";
	}
	return "quiescent";
}

export function evaluateSessionTreeQuiescence(
	root: SessionSummary,
	summaries: readonly SessionSummary[],
): SessionTreeQuiescence {
	const keys = new Map<SessionSummary, string>();
	const byActiveId = new Map<string, SessionSummary>();
	const bySessionId = new Map<string, SessionSummary>();
	for (const [index, summary] of summaries.entries()) {
		keys.set(summary, summaryKey(summary, index));
		if (summary.activeSessionId) byActiveId.set(summary.activeSessionId, summary);
		if (summary.sessionId) bySessionId.set(summary.sessionId, summary);
	}
	const children = new Map<SessionSummary, SessionSummary[]>();
	for (const summary of summaries) {
		if (summary === root) continue;
		const parent = summary.parentActiveSessionId
			? byActiveId.get(summary.parentActiveSessionId)
			: summary.parentSessionId
				? bySessionId.get(summary.parentSessionId)
				: undefined;
		if (!parent) continue;
		const list = children.get(parent) ?? [];
		list.push(summary);
		children.set(parent, list);
	}

	const blockingSessionIds: string[] = [];
	let nonQuiescentDescendantCount = 0;
	let uncertainDescendantCount = 0;
	let rootState = nodeState(root);
	const visiting = new Set<SessionSummary>();
	const visited = new Set<SessionSummary>();
	const visit = (summary: SessionSummary, descendant: boolean): void => {
		if (visiting.has(summary)) {
			rootState = "uncertain";
			uncertainDescendantCount++;
			blockingSessionIds.push(keys.get(summary) ?? "cycle");
			return;
		}
		if (visited.has(summary)) return;
		visiting.add(summary);
		const state = nodeState(summary);
		if (state !== "quiescent") {
			if (descendant) nonQuiescentDescendantCount++;
			if (state === "uncertain") uncertainDescendantCount++;
			blockingSessionIds.push(keys.get(summary) ?? "unknown");
		}
		for (const child of children.get(summary) ?? []) visit(child, true);
		visiting.delete(summary);
		visited.add(summary);
	};
	visit(root, false);
	if (rootState === "quiescent") {
		rootState = uncertainDescendantCount > 0 ? "uncertain" : blockingSessionIds.length > 0 ? "working" : "quiescent";
	}
	return {
		state: rootState,
		quiescent: rootState === "quiescent",
		nonQuiescentDescendantCount,
		uncertainDescendantCount,
		blockingSessionIds: [...new Set(blockingSessionIds)],
	};
}

export function annotateSessionTreeQuiescence(summaries: SessionSummary[]): SessionSummary[] {
	return summaries.map((summary) => {
		if (!summary.activeSessionId) return summary;
		const tree = evaluateSessionTreeQuiescence(summary, summaries);
		return {
			...summary,
			treeQuiescence: tree.state,
			treeQuiescent: tree.quiescent,
			completionState:
				tree.state === "uncertain"
					? "uncertain"
					: tree.quiescent && summary.taskState === "completed"
						? "completed"
						: "not_completed",
			nonQuiescentDescendantCount: tree.nonQuiescentDescendantCount,
			uncertainDescendantCount: tree.uncertainDescendantCount,
		};
	});
}
