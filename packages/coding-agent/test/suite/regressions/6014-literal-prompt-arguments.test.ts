import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { HARNESS_DIGEST_PREFIX } from "../../../src/core/messages.js";
import {
	expandPromptTemplate,
	loadPromptTemplates,
	type PromptTemplate,
	substituteArgs,
} from "../../../src/core/prompt-templates.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, getMessageText, getUserTexts } from "../harness.js";

describe("ENG-6014 literal prompt arguments", () => {
	test.each(["$$", "$&", "$`", "$'", "$1", "$10", "$ARGUMENTS", "$@", `\${@:2}`, `\${@:1:2}`])(
		"preserves %s in every placeholder form",
		(literal) => {
			const args = [literal, "tail"];
			expect(substituteArgs("Before $1 after", args)).toBe(`Before ${literal} after`);
			expect(substituteArgs("Before $ARGUMENTS after", args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs("Before $@ after", args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs(`Before \${@:1} after`, args)).toBe(`Before ${literal} tail after`);
			expect(substituteArgs(`Before \${@:2:1} after`, ["head", literal, "tail"])).toBe(`Before ${literal} after`);
		},
	);

	test("does not expand placeholders formed across insertion boundaries", () => {
		expect(substituteArgs("$1ARGUMENTS|$1@|$1{@:2}", ["$", "tail"])).toBe(`$ARGUMENTS|$@|\${@:2}`);
	});

	test("expands mixed and repeated template placeholders without expanding inserted arguments", () => {
		expect(substituteArgs(`$1|$2|\${@:2:1}|$@|$ARGUMENTS|$1`, ["$@", `\${@:1}`, "$ARGUMENTS"])).toBe(
			`$@|\${@:1}|\${@:1}|$@ \${@:1} $ARGUMENTS|$@ \${@:1} $ARGUMENTS|$@`,
		);
	});

	test.each([
		{ input: "$$", expected: "Explain: $$" },
		{ input: "$&", expected: "Explain: $&" },
		{ input: "$@ tail", expected: "Explain: $@ tail" },
		{ input: '"$`"', expected: "Explain: $`" },
		{ input: '"$\'"', expected: "Explain: $'" },
		{ input: "ordinary text", expected: "Explain: ordinary text" },
	])("preserves $input through a loaded template and the provider context", async ({ input, expected }) => {
		const prompts: PromptTemplate[] = [];
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getPrompts = () => ({ prompts, diagnostics: [] });
		const harness = await createHarness({ resourceLoader, tools: [] });
		try {
			const filePath = join(harness.tempDir, "explain.md");
			writeFileSync(filePath, "Explain: $ARGUMENTS");
			prompts.push(
				...loadPromptTemplates({
					cwd: harness.tempDir,
					agentDir: harness.tempDir,
					promptPaths: [filePath],
					includeDefaults: false,
				}),
			);
			expect(prompts).toHaveLength(1);
			const command = `/explain ${input}`;
			expect(expandPromptTemplate(command, prompts)).toBe(expected);
			const providerTexts: string[] = [];
			harness.setResponses([
				(context) => {
					providerTexts.push(
						...context.messages
							.filter((message) => message.role === "user")
							.map(getMessageText)
							.filter((text) => !text.startsWith(HARNESS_DIGEST_PREFIX)),
					);
					return fauxAssistantMessage("ok");
				},
			]);

			await harness.session.prompt(command);

			expect(getUserTexts(harness)).toEqual([expected]);
			expect(providerTexts.at(-1)).toBe(expected);
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			harness.cleanup();
		}
	});
});
