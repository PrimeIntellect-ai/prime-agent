import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
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

	it.each([2, 3])(
		"reads version %s resume files without repairing, migrating, or changing symlinks",
		async (version) => {
			const dir = createTempDir("pi-readonly-resume");
			cleanupPaths.push(dir);
			const storedCwd = join(dir, "missing-project");
			const path = join(dir, "session.jsonl");
			const alias = join(dir, "alias.jsonl");
			const original = `not-json\n${JSON.stringify({ type: "session", version, id: "readonly", timestamp: "2026-01-01T00:00:00Z", cwd: storedCwd })}\n${JSON.stringify({ type: "session_info", id: "name", parentId: null, timestamp: "2026-01-01T00:00:00Z", name: "Reader name" })}\n{"type":"message","id":"torn`;
			writeFileSync(path, original);
			symlinkSync(path, alias);
			const manager = await createSessionManager(parseArgs(["--resume", alias]), dir, dir, true);
			expect(manager.isPersisted()).toBe(false);
			expect(manager.getCwd()).toBe(storedCwd);
			expect(manager.getSessionName()).toBe("Reader name");
			expect(manager.getSessionFile()).toBe(alias);
			expect(manager.getSessionDir()).toBe(dir);
			expect(manager.getEntries()).toHaveLength(1);
			expect(manager.getLeafId()).toBe(manager.getEntries()[0].id);
			expect(getMissingSessionCwdIssue(manager, dir)?.sessionCwd).toBe(storedCwd);
			const overridden = await createSessionManager(parseArgs(["--cwd", dir, "--resume", alias]), dir, dir, true);
			expect(overridden.getCwd()).toBe(dir);
			expect(getMissingSessionCwdIssue(overridden, dir)).toBeUndefined();
			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
			expect(readFileSync(path, "utf8")).toBe(original);
		},
	);

	it("continues the latest matching cwd without mutating its transcript", async () => {
		const dir = createTempDir("pi-readonly-continue");
		cleanupPaths.push(dir);
		const older = join(dir, "older.jsonl");
		const latest = join(dir, "latest.jsonl");
		const other = join(dir, "other.jsonl");
		writeSessionFile(older, dir);
		writeSessionFile(latest, dir);
		writeSessionFile(other, join(dir, "other-project"));
		const original = `${readFileSync(latest, "utf8")}{"type":"message","id":"torn`;
		writeFileSync(latest, original);
		utimesSync(older, 100, 100);
		utimesSync(latest, 200, 200);
		utimesSync(other, 300, 300);
		const manager = await createSessionManager(parseArgs(["--continue"]), dir, dir, true);
		expect(manager.getSessionFile()).toBe(latest);
		expect(manager.getCwd()).toBe(dir);
		expect(manager.isPersisted()).toBe(false);
		expect(readFileSync(latest, "utf8")).toBe(original);
	});

	it("keeps a no-match readonly continue as an in-memory draft", async () => {
		const dir = createTempDir("pi-readonly-continue-empty");
		cleanupPaths.push(dir);
		writeSessionFile(join(dir, "other.jsonl"), join(dir, "other-project"));
		const manager = await createSessionManager(parseArgs(["--continue"]), dir, dir, true);
		expect(manager.isPersisted()).toBe(false);
		expect(manager.getSessionFile()).toBeUndefined();
		expect(manager.getSessionDir()).toBe(dir);
		expect(manager.getCwd()).toBe(dir);
	});

	it("keeps fork output writable when startup reads are readonly", async () => {
		const dir = createTempDir("pi-readonly-fork");
		cleanupPaths.push(dir);
		const source = join(dir, "source.jsonl");
		writeSessionFile(source, dir);
		const manager = await createSessionManager(parseArgs(["--fork", source]), dir, dir, true);
		expect(manager.isPersisted()).toBe(true);
		expect(manager.getSessionFile()).not.toBe(source);
		expect(existsSync(manager.getSessionFile()!)).toBe(true);
		manager.appendSessionInfo("Writable fork");
		expect(SessionManager.open(manager.getSessionFile()!).getSessionName()).toBe("Writable fork");
	});

	it("preserves writer-owned crash repair for default startup", async () => {
		const dir = createTempDir("pi-writer-resume");
		cleanupPaths.push(dir);
		const path = join(dir, "session.jsonl");
		writeSessionFile(path, dir);
		const kept = readFileSync(path, "utf8");
		writeFileSync(path, `${kept}{"type":"message","id":"torn`);
		const manager = await createSessionManager(parseArgs(["--resume", path]), dir, dir);
		expect(manager.isPersisted()).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(kept);
		manager.appendSessionInfo("After repair");
		expect(SessionManager.open(path).getSessionName()).toBe("After repair");
	});

	it("preserves an explicit catalog directory for in-memory bootstrap sessions", () => {
		const manager = SessionManager.inMemory("/tmp/project", "/tmp/sessions");
		expect(manager.getSessionDir()).toBe("/tmp/sessions");
	});
});
