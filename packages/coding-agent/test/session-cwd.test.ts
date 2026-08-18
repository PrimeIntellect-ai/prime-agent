import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { SessionSelectorNotFoundError } from "../src/cli/session-resolver.js";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "../src/core/session-cwd.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createSessionManager } from "../src/main.js";

function createTempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeSessionFile(path: string, cwd: string): void {
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: new Date().toISOString(),
			cwd,
		})}\n`,
	);
}

describe("session cwd handling", () => {
	const cleanupPaths: string[] = [];

	afterEach(() => {
		for (const path of cleanupPaths.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("detects missing session cwd from persisted sessions", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-fallback");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		const issue = getMissingSessionCwdIssue(sessionManager, fallbackCwd);
		expect(issue).toEqual({
			sessionFile: sessionManager.getSessionFile(),
			sessionCwd: missingCwd,
			fallbackCwd,
		});
	});

	it("reads the header cwd even when the file starts with a blank line", () => {
		// open() reads the first physical line for the header, but the full loader
		// trims and skips leading blank lines. A leading blank line must not make
		// getCwd() fall back to process.cwd() and disagree with the loaded header.
		const sessionDir = createTempDir("pi-session-cwd-blank-line");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(sessionDir);
		const headerCwd = join(sessionDir, "project");
		const header = JSON.stringify({
			type: "session",
			version: 3,
			id: "session-id",
			timestamp: new Date().toISOString(),
			cwd: headerCwd,
		});
		writeFileSync(sessionFile, `\n${header}\n`);

		const sessionManager = SessionManager.open(sessionFile);
		expect(sessionManager.getCwd()).toBe(headerCwd);
	});

	it("supports overriding the effective cwd when opening a session", () => {
		const fallbackCwd = createTempDir("pi-session-cwd-override");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-override-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile, undefined, fallbackCwd);
		expect(sessionManager.getCwd()).toBe(fallbackCwd);
		expect(getMissingSessionCwdIssue(sessionManager, fallbackCwd)).toBeUndefined();
	});

	it("uses explicit --cwd as the cwd override when opening --resume", async () => {
		const storedCwd = createTempDir("pi-session-cwd-stored");
		const explicitCwd = createTempDir("pi-session-cwd-explicit");
		const agentDir = createTempDir("pi-session-cwd-agent-dir");
		const sessionDir = createTempDir("pi-session-cwd-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(storedCwd, explicitCwd, agentDir, sessionDir);
		writeSessionFile(sessionFile, storedCwd);

		const parsed = parseArgs(["--cwd", explicitCwd, "--resume", sessionFile]);
		const sessionManager = await createSessionManager(parsed, explicitCwd, sessionDir);

		expect(sessionManager.getCwd()).toBe(explicitCwd);
	});

	it("rejects an unresolved resume selector without converting it to prompt text", async () => {
		const cwd = createTempDir("pi-session-cwd-resume-fallback");
		const agentDir = createTempDir("pi-session-cwd-resume-fallback-agent-dir");
		const sessionDir = createTempDir("pi-session-cwd-resume-fallback-session-dir");
		cleanupPaths.push(cwd, agentDir, sessionDir);

		const parsed = parseArgs(["--resume", "fix", "the", "bug"]);
		await expect(createSessionManager(parsed, cwd, sessionDir)).rejects.toMatchObject({
			name: SessionSelectorNotFoundError.name,
			selector: "fix",
			suggestion: undefined,
		});

		expect(parsed.resume).toBe("fix");
		expect(parsed.messages).toEqual(["the", "bug"]);
	});

	it("throws a controlled error before runtime creation when the stored cwd is missing", async () => {
		const fallbackCwd = createTempDir("pi-session-cwd-runtime");
		const missingCwd = join(fallbackCwd, "does-not-exist");
		const sessionDir = createTempDir("pi-session-cwd-runtime-session-dir");
		const sessionFile = join(sessionDir, "session.jsonl");
		cleanupPaths.push(fallbackCwd, sessionDir);
		writeSessionFile(sessionFile, missingCwd);

		const sessionManager = SessionManager.open(sessionFile);
		let createRuntimeCalled = false;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			createRuntimeCalled = true;
			throw new Error("should not be called");
		};

		await expect(
			createAgentSessionRuntime(createRuntime, {
				cwd: fallbackCwd,
				agentDir: fallbackCwd,
				sessionManager,
			}),
		).rejects.toBeInstanceOf(MissingSessionCwdError);
		expect(createRuntimeCalled).toBe(false);
	});

	it("preserves an explicit catalog directory for in-memory bootstrap sessions", () => {
		const manager = SessionManager.inMemory("/tmp/project", "/tmp/sessions");
		expect(manager.getSessionDir()).toBe("/tmp/sessions");
	});
});
