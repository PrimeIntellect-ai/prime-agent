import { describe, expect, it } from "vitest";
import { activeGitContext } from "../src/core/agent-traces.js";
import type { SessionHeader } from "../src/core/session-manager.js";

const HEADER: SessionHeader = {
	type: "session",
	version: 3,
	id: "h",
	timestamp: "2026-01-01T00:00:00.000Z",
	cwd: "/repo",
	git: { repoUrl: "https://github.com/acme/widgets.git", commit: "aaa", branch: "main" },
};

function jsonl(...entries: object[]): string {
	return [HEADER, ...entries].map((e) => JSON.stringify(e)).join("\n");
}

describe("activeGitContext", () => {
	it("returns the header git when there are no git_state entries", () => {
		const body = jsonl({ type: "message", id: "m1", parentId: null, timestamp: "t", message: {} });
		expect(activeGitContext(body, HEADER)).toEqual(HEADER.git);
	});

	it("returns the most recent git_state on a linear path", () => {
		const body = jsonl(
			{ type: "message", id: "m1", parentId: null, timestamp: "t", message: {} },
			{ type: "git_state", id: "g1", parentId: "m1", timestamp: "t", git: { commit: "bbb", branch: "main" } },
			{ type: "message", id: "m2", parentId: "g1", timestamp: "t", message: {} },
		);
		expect(activeGitContext(body, HEADER)).toEqual({ commit: "bbb", branch: "main" });
	});

	it("ignores a git_state on a sibling branch and uses the active leaf's path", () => {
		const body = jsonl(
			{ type: "message", id: "m1", parentId: null, timestamp: "t", message: {} },
			{ type: "git_state", id: "g1", parentId: "m1", timestamp: "t", git: { commit: "bbb", branch: "old" } },
			{ type: "message", id: "m2", parentId: "m1", timestamp: "t", message: {} },
			{ type: "git_state", id: "g2", parentId: "m2", timestamp: "t", git: { commit: "ccc", branch: "feat" } },
		);
		expect(activeGitContext(body, HEADER)).toEqual({ commit: "ccc", branch: "feat" });
	});

	it("falls back to the header when the active path has no git_state", () => {
		const body = jsonl(
			{ type: "message", id: "m1", parentId: null, timestamp: "t", message: {} },
			{ type: "git_state", id: "g1", parentId: "m1", timestamp: "t", git: { commit: "bbb", branch: "old" } },
			{ type: "message", id: "m2", parentId: null, timestamp: "t", message: {} },
		);
		expect(activeGitContext(body, HEADER)).toEqual(HEADER.git);
	});
});
