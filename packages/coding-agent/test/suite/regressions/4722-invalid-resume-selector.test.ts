import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.js";
import {
	findClosestSessionId,
	SessionSelectorAmbiguousError,
	SessionSelectorNotFoundError,
} from "../../../src/cli/session-resolver.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createSessionManager } from "../../../src/main.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4722 invalid resume selectors", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("rejects a mistyped session ID with the closest saved ID", async () => {
		harness = await createHarness({ persistSession: true });
		harness.setResponses([fauxAssistantMessage("saved")]);
		await harness.session.prompt("persist this session");

		const sessionId = harness.session.sessionId;
		const lastCharacter = sessionId.at(-1)!;
		const mistypedId = `${sessionId.slice(0, -1)}${lastCharacter === "0" ? "1" : "0"}`;
		const parsed = parseArgs(["--resume", mistypedId, "do not submit this"]);
		const sessionDir = join(harness.tempDir, "sessions");

		await expect(createSessionManager(parsed, harness.tempDir, sessionDir)).rejects.toMatchObject({
			name: SessionSelectorNotFoundError.name,
			selector: mistypedId,
			suggestion: sessionId,
		});
		expect(parsed.resume).toBe(mistypedId);
		expect(parsed.messages).toEqual(["do not submit this"]);
	});

	it("does not suggest tied or low-confidence session IDs", () => {
		expect(findClosestSessionId("abcx", [{ id: "abca1111" }, { id: "abcb2222" }])).toBeUndefined();
		expect(findClosestSessionId("wxyz1234", [{ id: "abcdef0123456789" }])).toBeUndefined();
		expect(findClosestSessionId("abcd", [])).toBeUndefined();
	});

	it("rejects an ambiguous saved session prefix", async () => {
		harness = await createHarness();
		const sessionDir = join(harness.tempDir, "sessions");
		createSavedSession(harness.tempDir, sessionDir, "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
		createSavedSession(harness.tempDir, sessionDir, "11111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
		const parsed = parseArgs(["--resume", "11111111", "do not submit this"]);

		await expect(createSessionManager(parsed, harness.tempDir, sessionDir)).rejects.toMatchObject({
			name: SessionSelectorAmbiguousError.name,
			selector: "11111111",
		});
		expect(parsed.messages).toEqual(["do not submit this"]);
	});

	it("accepts the normalized suffix displayed by the session list", async () => {
		harness = await createHarness();
		const sessionDir = join(harness.tempDir, "sessions");
		const sessionId = "019e71ec-e08a-75a9-b573-aaaaaaaaaaaa";
		createSavedSession(harness.tempDir, sessionDir, sessionId);
		const parsed = parseArgs(["--resume", "aaaaaaaaaaaa"]);

		const sessionManager = await createSessionManager(parsed, harness.tempDir, sessionDir);

		expect(sessionManager.getSessionId()).toBe(sessionId);
	});

	it("prefers an exact normalized ID over prefix and suffix matches", async () => {
		harness = await createHarness();
		const sessionDir = join(harness.tempDir, "sessions");
		createSavedSession(harness.tempDir, sessionDir, "abcd");
		createSavedSession(harness.tempDir, sessionDir, "abcd1");
		createSavedSession(harness.tempDir, sessionDir, "1abcd");
		const parsed = parseArgs(["--resume", "AB-CD"]);

		const sessionManager = await createSessionManager(parsed, harness.tempDir, sessionDir);

		expect(sessionManager.getSessionId()).toBe("abcd");
	});
});

function createSavedSession(cwd: string, sessionDir: string, sessionId: string): void {
	const session = SessionManager.create(cwd, sessionDir);
	session.newSession({ id: sessionId });
	session.appendSessionState({ status: "archived" });
}
