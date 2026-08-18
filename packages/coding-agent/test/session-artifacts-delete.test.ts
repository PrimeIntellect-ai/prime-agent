import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSessionArtifacts, deleteSessionFile } from "../src/core/session-file-actions.js";

let root = "";

describe("deleteSessionFile removes the session artifact directory", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prime-agent-session-delete-"));
	});

	afterEach(() => {
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	it("permanently deletes <root>/session-artifacts/<id> alongside the session file", async () => {
		const sessionId = "session-xyz";
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionPath, '{"type":"session"}\n');

		const artifactDir = join(root, "session-artifacts", sessionId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");
		writeFileSync(join(artifactDir, "kernel-state.json"), "{}");
		writeFileSync(join(artifactDir, "scheduled-jobs.json"), '{"jobs":[],"dispatches":[]}\n');

		const result = await deleteSessionFile(sessionPath);

		expect(result.ok).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
		expect(existsSync(sessionPath)).toBe(false);
	});

	it("runs the file-removed callback before deleting artifacts", async () => {
		const sessionId = "session-with-callback";
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, `${sessionId}.jsonl`);
		writeFileSync(sessionPath, '{"type":"session"}\n');

		const artifactDir = join(root, "session-artifacts", sessionId);
		mkdirSync(artifactDir, { recursive: true });
		writeFileSync(join(artifactDir, "kernel-state.dill"), "payload");
		let wasSessionRemovedBeforeCallback = false;
		let wereArtifactsPresentDuringCallback = false;

		const result = await deleteSessionFile(sessionPath, {
			afterFileRemoved: () => {
				wasSessionRemovedBeforeCallback = !existsSync(sessionPath);
				wereArtifactsPresentDuringCallback = existsSync(artifactDir);
			},
		});

		expect(result.ok).toBe(true);
		expect(wasSessionRemovedBeforeCallback).toBe(true);
		expect(wereArtifactsPresentDuringCallback).toBe(true);
		expect(existsSync(artifactDir)).toBe(false);
	});

	it("never removes the artifacts root for a degenerate session file name", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const artifactsRoot = join(root, "session-artifacts");
		mkdirSync(join(artifactsRoot, "live-session"), { recursive: true });

		// Basename ".jsonl" strips to an empty id, which would resolve to the root.
		await deleteSessionArtifacts(join(sessionsDir, ".jsonl"));

		expect(existsSync(join(artifactsRoot, "live-session"))).toBe(true);
	});

	it("succeeds when the session has no artifact directory", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "no-artifacts.jsonl");
		writeFileSync(sessionPath, "{}\n");

		const result = await deleteSessionFile(sessionPath);
		expect(result.ok).toBe(true);
	});
});
