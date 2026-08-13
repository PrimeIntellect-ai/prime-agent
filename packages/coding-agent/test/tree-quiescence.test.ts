import { describe, expect, it } from "vitest";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { annotateSessionTreeQuiescence, evaluateSessionTreeQuiescence } from "../src/modes/daemon/tree-quiescence.js";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: overrides.id ?? overrides.activeSessionId ?? overrides.sessionId ?? "default",
		sessionId: "session-default",
		isSessionActive: false,
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		modified: "2026-08-10T10:00:00.000Z",
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		lifecycle: "live",
		activity: "idle",
		...overrides,
	};
}

describe("session tree quiescence", () => {
	it("prevents root completion while a recursively nested descendant is working", () => {
		const root = summary({ activeSessionId: "root", sessionId: "root-session", taskState: "completed" });
		const child = summary({
			activeSessionId: "child",
			sessionId: "child-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "root",
		});
		const grandchild = summary({
			activeSessionId: "grandchild",
			sessionId: "grandchild-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "child",
			activity: "working",
		});
		const annotated = annotateSessionTreeQuiescence([root, child, grandchild]);
		expect(annotated[0]).toMatchObject({
			treeQuiescence: "working",
			treeQuiescent: false,
			completionState: "not_completed",
			nonQuiescentDescendantCount: 1,
		});
		expect(annotated[1]).toMatchObject({ treeQuiescence: "working", nonQuiescentDescendantCount: 1 });
	});

	it("treats a saved-only running registry entry as uncertain instead of complete", () => {
		const root = summary({ activeSessionId: "root", sessionId: "root-session", taskState: "completed" });
		const passive = summary({
			sessionId: "passive-session",
			runtimeKind: "subagent",
			parentSessionId: "root-session",
			activity: undefined,
			passiveRegistryStatus: "running",
		});
		expect(annotateSessionTreeQuiescence([root, passive])[0]).toMatchObject({
			treeQuiescence: "uncertain",
			completionState: "uncertain",
			uncertainDescendantCount: 1,
		});
	});

	it("reports completion only when the root verdict and whole tree are quiet", () => {
		const root = summary({ activeSessionId: "root", sessionId: "root-session", taskState: "completed" });
		const child = summary({
			activeSessionId: "child",
			sessionId: "child-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "root",
		});
		expect(annotateSessionTreeQuiescence([root, child])[0]).toMatchObject({
			treeQuiescence: "quiescent",
			treeQuiescent: true,
			completionState: "completed",
		});
	});

	it("treats an open operation as working even when runtime activity says idle", () => {
		const root = summary({
			activeSessionId: "root",
			sessionId: "root-session",
			reliability: { openOperationCount: 1, openOperations: [] },
		});
		expect(evaluateSessionTreeQuiescence(root, [root])).toMatchObject({ state: "working", quiescent: false });
	});
});
