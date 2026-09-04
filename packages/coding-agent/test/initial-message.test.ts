import { describe, expect, test } from "vitest";
import type { Args } from "../src/cli/args.js";
import { buildInitialMessage } from "../src/cli/initial-message.js";

function createArgs(messages: string[] = []): Args {
	return {
		messages: [...messages],
		fileArgs: [],
		unknownFlags: new Map(),
		diagnostics: [],
	};
}

describe("buildInitialMessage", () => {
	test("merges piped stdin with the first CLI message into one prompt", () => {
		const parsed = createArgs(["Summarize the text given"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		// Unterminated stdin must not glue onto the instruction as one word.
		expect(result.initialMessage).toBe("README contents\n\nSummarize the text given");
		expect(parsed.messages).toEqual([]);
	});

	test("uses stdin as the initial prompt when no CLI message is present", () => {
		const parsed = createArgs();
		const result = buildInitialMessage({
			parsed,
			stdinContent: "README contents",
		});

		expect(result.initialMessage).toBe("README contents");
		expect(parsed.messages).toEqual([]);
	});

	test("combines stdin, file text, and first CLI message in one prompt", () => {
		const parsed = createArgs(["Explain it", "Second message"]);
		const result = buildInitialMessage({
			parsed,
			stdinContent: "stdin",
			fileText: "file",
		});

		expect(result.initialMessage).toBe("stdin\n\nfile\n\nExplain it");
		expect(parsed.messages).toEqual(["Second message"]);
	});
});
