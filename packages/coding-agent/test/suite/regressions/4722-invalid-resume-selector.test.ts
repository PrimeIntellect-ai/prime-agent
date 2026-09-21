import { join } from "node:path";
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

const SAVED_ID = "019e71ec-e08a-75a9-b573-aaaaaaaaaaaa";

function createSavedSession(cwd: string, sessionDir: string, sessionId: string): void {
	const session = SessionManager.create(cwd, sessionDir);
	session.newSession({ id: sessionId });
	session.appendSessionState({ status: "archived" });
}

describe("ENG-4722 resume selector matching", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it.each([
		{
			name: "an exact normalized id beats prefix and suffix matches",
			saved: ["abcd", "abcd1", "1abcd"],
			selector: "AB-CD",
			resolved: "abcd",
		},
		{
			name: "the normalized suffix shown by the session list resolves",
			saved: [SAVED_ID],
			selector: "aaaaaaaaaaaa",
			resolved: SAVED_ID,
		},
		{
			name: "an ambiguous prefix is rejected",
			saved: ["11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "11111111-bbbb-bbbb-bbbb-bbbbbbbbbbbb"],
			selector: "11111111",
			error: { name: SessionSelectorAmbiguousError.name, selector: "11111111" },
		},
		{
			name: "a mistyped id is rejected with the closest saved id",
			saved: [SAVED_ID],
			selector: `${SAVED_ID.slice(0, -1)}b`,
			error: {
				name: SessionSelectorNotFoundError.name,
				selector: `${SAVED_ID.slice(0, -1)}b`,
				suggestion: SAVED_ID,
			},
		},
	])("$name", async ({ saved, selector, resolved, error }) => {
		harness = await createHarness();
		const sessionDir = join(harness.tempDir, "sessions");
		for (const id of saved) createSavedSession(harness.tempDir, sessionDir, id);
		const parsed = parseArgs(["--resume", selector, "do not submit this"]);

		const resolving = createSessionManager(parsed, harness.tempDir, sessionDir);

		if (error) await expect(resolving).rejects.toMatchObject(error);
		else expect((await resolving).getSessionId()).toBe(resolved);
		// A rejected selector must not leak its trailing words into the first prompt.
		expect(parsed.messages).toEqual(["do not submit this"]);
	});

	it("does not suggest tied or low-confidence session ids", () => {
		expect(findClosestSessionId("abcx", [{ id: "abca1111" }, { id: "abcb2222" }])).toBeUndefined();
		expect(findClosestSessionId("wxyz1234", [{ id: "abcdef0123456789" }])).toBeUndefined();
		expect(findClosestSessionId("abcd", [])).toBeUndefined();
	});
});
