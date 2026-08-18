import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	getSessionArtifactPath,
	getSessionArtifactPathForFile,
	getSessionArtifactsRoot,
} from "../../src/core/session-manager.js";

describe("session artifact path helpers", () => {
	const sessionDir = join("/agent", "sessions");

	it("derives the same artifact dir from a sessionDir and from a sessionFile", () => {
		const fromDir = getSessionArtifactPath(sessionDir, "abc-123");
		const fromFile = getSessionArtifactPathForFile(join(sessionDir, "abc-123.jsonl"));
		expect(fromFile).toBe(fromDir);
		expect(fromDir).toBe(join("/agent", "session-artifacts", "abc-123"));
	});

	it("honors an explicit id that differs from the file basename", () => {
		const fromFile = getSessionArtifactPathForFile(join(sessionDir, "renamed.jsonl"), "header-id");
		expect(fromFile).toBe(getSessionArtifactPath(sessionDir, "header-id"));
	});

	it("anchors the artifacts root next to the sessions dir", () => {
		expect(getSessionArtifactsRoot(sessionDir)).toBe(join("/agent", "session-artifacts"));
		expect(getSessionArtifactPath(sessionDir, "x")).toBe(join(getSessionArtifactsRoot(sessionDir), "x"));
	});
});
