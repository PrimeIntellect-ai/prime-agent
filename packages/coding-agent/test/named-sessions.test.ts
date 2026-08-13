import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli/args.js";
import { ENV_SESSION_DIR } from "../src/config.js";
import { AmbiguousSessionNameError, findSessionByName } from "../src/core/named-sessions.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createSessionManager } from "../src/main.js";

describe("named sessions", () => {
	let tempDir: string;
	let sessionDir: string;
	let previousSessionDir: string | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "named-sessions-"));
		sessionDir = join(tempDir, "sessions");
		previousSessionDir = process.env[ENV_SESSION_DIR];
		process.env[ENV_SESSION_DIR] = sessionDir;
	});

	afterEach(() => {
		if (previousSessionDir === undefined) {
			delete process.env[ENV_SESSION_DIR];
		} else {
			process.env[ENV_SESSION_DIR] = previousSessionDir;
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores the name inside the session it creates", async () => {
		const created = await createSessionManager(parseArgs(["--name", "demo"]), tempDir, sessionDir);

		const found = await findSessionByName("demo", tempDir, sessionDir);

		expect(found?.id).toBe(created.getSessionId());
	});

	it("resumes the same session for a repeated name", async () => {
		const first = await createSessionManager(parseArgs(["--name", "demo"]), tempDir, sessionDir);

		const second = await createSessionManager(parseArgs(["--name", "demo"]), tempDir, sessionDir);

		expect(second.getSessionId()).toBe(first.getSessionId());
	});

	it("creates separate sessions for different names", async () => {
		const first = await createSessionManager(parseArgs(["--name", "one"]), tempDir, sessionDir);

		const second = await createSessionManager(parseArgs(["--name", "two"]), tempDir, sessionDir);

		expect(second.getSessionId()).not.toBe(first.getSessionId());
	});

	it("keeps the same name in two directories apart", async () => {
		const otherDir = mkdtempSync(join(tmpdir(), "named-sessions-other-"));
		try {
			const here = await createSessionManager(parseArgs(["--name", "demo"]), tempDir, sessionDir);
			const there = await createSessionManager(parseArgs(["--name", "demo"]), otherDir, sessionDir);

			expect(there.getSessionId()).not.toBe(here.getSessionId());
			expect((await findSessionByName("demo", tempDir, sessionDir))?.id).toBe(here.getSessionId());
			expect((await findSessionByName("demo", otherDir, sessionDir))?.id).toBe(there.getSessionId());
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it("does not resolve a name from another directory", async () => {
		const otherDir = mkdtempSync(join(tmpdir(), "named-sessions-other-"));
		try {
			await createSessionManager(parseArgs(["--name", "demo"]), otherDir, sessionDir);

			expect(await findSessionByName("demo", tempDir, sessionDir)).toBeUndefined();
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it("rejects an ambiguous name instead of picking one", async () => {
		const first = SessionManager.create(tempDir, sessionDir);
		first.appendSessionInfo("demo");
		const second = SessionManager.create(tempDir, sessionDir);
		second.appendSessionInfo("demo");

		await expect(findSessionByName("demo", tempDir, sessionDir)).rejects.toThrow(AmbiguousSessionNameError);
	});

	it("leaves unnamed sessions unnamed", async () => {
		const created = await createSessionManager(parseArgs([]), tempDir, sessionDir);
		const sessions = await SessionManager.list(tempDir, sessionDir);

		expect(sessions.find((s) => s.id === created.getSessionId())?.name).toBeUndefined();
	});
});
