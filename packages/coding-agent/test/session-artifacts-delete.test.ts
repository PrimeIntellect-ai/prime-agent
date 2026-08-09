import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteSessionFile, sweepGhostSessionFiles } from "../src/core/session-file-actions.js";

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

	it("succeeds when the session has no artifact directory", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const sessionPath = join(sessionsDir, "no-artifacts.jsonl");
		writeFileSync(sessionPath, "{}\n");

		const result = await deleteSessionFile(sessionPath);
		expect(result.ok).toBe(true);
	});

	it("sweepGhostSessionFiles removes empty draft sessions and preserves real ones", async () => {
		const sessionsDir = join(root, "sessions");
		mkdirSync(sessionsDir, { recursive: true });

		// Ghost: only bootstrap entries + session_state.
		const ghostPath = join(sessionsDir, "ghost.jsonl");
		writeFileSync(
			ghostPath,
			`${[
				'{"type":"session","version":3,"id":"ghost"}',
				'{"type":"model_change","id":"a","parentId":null}',
				'{"type":"thinking_level_change","id":"b","parentId":"a"}',
				'{"type":"service_tier_change","id":"c","parentId":"b"}',
				'{"type":"session_state","id":"d","parentId":"c","state":{"status":"active"}}',
			].join("\n")}\n`,
		);

		// Real session: has a user message.
		const realPath = join(sessionsDir, "real.jsonl");
		writeFileSync(
			realPath,
			`${[
				'{"type":"session","version":3,"id":"real"}',
				'{"type":"model_change","id":"a","parentId":null}',
				'{"type":"message","id":"b","parentId":"a","message":{"role":"user","content":"hi"}}',
			].join("\n")}\n`,
		);

		const swept = await sweepGhostSessionFiles(sessionsDir);
		expect(swept).toBe(1);
		expect(existsSync(ghostPath)).toBe(false);
		expect(existsSync(realPath)).toBe(true);
	});

	it("sweepGhostSessionFiles is a no-op for a missing directory", async () => {
		const swept = await sweepGhostSessionFiles(join(root, "does-not-exist"));
		expect(swept).toBe(0);
	});
});
