import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { readSessionInfo, SessionManager } from "../../../src/core/session-manager.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describe("issue #1105 session storage security", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "prime-1105-security-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it.each([
		"../escape",
		"../../escape",
		"nested/id",
		"nested\\id",
		".",
		"..",
		"x".repeat(129),
		"safe\n",
		"safe\r",
		"safe\u2028",
	])("rejects unsafe explicit session id %j", (sessionId) => {
		const sessionDir = join(tempRoot, "sessions");
		const manager = SessionManager.create(tempRoot, sessionDir);

		expect(() => manager.newSession({ id: sessionId })).toThrow("Invalid session id");
		expect(() => manager.getSessionArtifactDir()).not.toThrow();
	});

	it("accepts a documented dotted session id", () => {
		const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
		expect(manager.newSession({ id: "run.1" })).toContain("run.1.jsonl");
	});

	it("rejects a traversal id from a persisted session header", () => {
		const sessionDir = join(tempRoot, "sessions");
		mkdirSync(sessionDir);
		const sessionFile = join(sessionDir, "attacker.jsonl");
		writeFileSync(
			sessionFile,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "../../escaped-artifacts",
				timestamp: new Date().toISOString(),
				cwd: tempRoot,
			})}\n`,
		);

		expect(() => SessionManager.open(sessionFile, sessionDir)).toThrow("Invalid session id");
		expect(readFileSync(sessionFile, "utf8")).toContain('"id":"../../escaped-artifacts"');
	});

	describePosix("POSIX containment and permissions", () => {
		it("rejects a symlinked session transcript", () => {
			const sessionDir = join(tempRoot, "sessions");
			mkdirSync(sessionDir);
			const target = join(tempRoot, "outside-session.jsonl");
			writeFileSync(
				target,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "safe-session",
					timestamp: new Date().toISOString(),
					cwd: tempRoot,
				})}\n`,
			);
			const sessionFile = join(sessionDir, "safe-session.jsonl");
			symlinkSync(target, sessionFile);

			expect(() => SessionManager.open(sessionFile, sessionDir)).toThrow("non-regular private file");
		});

		it("omits symlinked transcripts from catalog scans", async () => {
			const target = join(tempRoot, "outside-session.jsonl");
			writeFileSync(
				target,
				`${JSON.stringify({ type: "session", version: 3, id: "outside", timestamp: new Date().toISOString(), cwd: tempRoot })}
`,
			);
			const transcript = join(tempRoot, "linked.jsonl");
			symlinkSync(target, transcript);

			expect(await readSessionInfo(transcript)).toBeNull();
		});

		it("rejects a symlinked per-session artifact directory", () => {
			const sessionDir = join(tempRoot, "sessions");
			const manager = SessionManager.create(tempRoot, sessionDir);
			manager.newSession({ id: "safe-session" });
			const artifactRoot = join(tempRoot, "session-artifacts");
			const outside = join(tempRoot, "outside");
			mkdirSync(artifactRoot);
			mkdirSync(outside);
			symlinkSync(outside, join(artifactRoot, "safe-session"), "dir");

			expect(() => manager.getSessionArtifactDir()).toThrow("Refusing to use non-directory private path");
			expect(lstatSync(join(artifactRoot, "safe-session")).isSymbolicLink()).toBe(true);
		});

		it("creates private session and artifact storage and repairs an existing transcript mode", () => {
			const sessionDir = join(tempRoot, "sessions");
			const manager = SessionManager.create(tempRoot, sessionDir);
			manager.appendSessionState({ status: "active" });
			manager.flushNow();
			const sessionFile = manager.getSessionFile()!;
			chmodSync(sessionFile, 0o644);
			manager.appendSessionInfo("private");
			const artifactDir = manager.getSessionArtifactDir()!;

			expect(statSync(sessionDir).mode & 0o777).toBe(0o700);
			expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
			expect(statSync(join(tempRoot, "session-artifacts")).mode & 0o777).toBe(0o700);
			expect(statSync(artifactDir).mode & 0o777).toBe(0o700);
		});

		it("rejects a symlinked auth file without modifying its target", () => {
			const authDir = join(tempRoot, "auth");
			mkdirSync(authDir);
			const target = join(tempRoot, "target.json");
			writeFileSync(target, '{"sentinel":true}');
			const authPath = join(authDir, "auth.json");
			symlinkSync(target, authPath);

			const storage = AuthStorage.create(authPath, { usePrimeCliConfig: false });
			storage.set("anthropic", { type: "api_key", key: "not-written" });

			expect(storage.drainErrors().some((error) => error.message.includes("non-regular private file"))).toBe(true);
			expect(readFileSync(target, "utf8")).toBe('{"sentinel":true}');
		});
		it("does not chmod an inferred parent when opening a user-selected transcript", () => {
			const sharedDir = join(tempRoot, "shared");
			mkdirSync(sharedDir, { mode: 0o755 });
			const sessionFile = join(sharedDir, "external.jsonl");
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", version: 3, id: "external", timestamp: new Date().toISOString(), cwd: tempRoot })}
`,
			);

			const manager = SessionManager.open(sessionFile);
			manager.appendSessionInfo("external");
			manager.flushNow();
			expect(statSync(sharedDir).mode & 0o777).toBe(0o755);
			expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
		});
	});
});
