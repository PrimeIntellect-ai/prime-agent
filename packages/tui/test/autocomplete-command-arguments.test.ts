import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CombinedAutocompleteProvider, type SlashCommand } from "../src/autocomplete.js";

describe("slash command argument completion", () => {
	it("enters the argument position for a custom completer without takesArgument metadata", async () => {
		const prefixes: string[] = [];
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "deploy",
					getArgumentCompletions: (prefix) => {
						prefixes.push(prefix);
						return [{ value: "production", label: "production" }];
					},
				},
			],
			process.cwd(),
		);
		const options = { signal: new AbortController().signal };
		const suggestions = await provider.getSuggestions(["/dep"], 0, 4, options);
		assert.ok(suggestions);
		assert.equal(suggestions.items[0]?.takesArgument, true);
		const completed = provider.applyCompletion(["/dep"], 0, 4, suggestions.items[0]!, suggestions.prefix);
		assert.deepEqual(completed, { lines: ["/deploy "], cursorLine: 0, cursorCol: 8 });
		const argumentsList = await provider.getSuggestions(["/deploy pro"], 0, 11, options);
		assert.deepEqual(prefixes, ["pro"]);
		assert.equal(argumentsList?.items[0]?.value, "production");
	});

	it("keeps an existing argument separator and places the cursor after it", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "deploy", getArgumentCompletions: () => null }],
			process.cwd(),
		);
		assert.deepEqual(provider.applyCompletion(["/dep staging"], 0, 4, { value: "deploy", label: "deploy" }, "/dep"), {
			lines: ["/deploy staging"],
			cursorLine: 0,
			cursorCol: 8,
		});
	});

	it("preserves explicit argument declarations and bare no-argument commands", () => {
		for (const [command, expected] of [
			[{ name: "deploy", takesArgument: true }, "/deploy "],
			[{ name: "deploy" }, "/deploy"],
			[{ name: "deploy", takesArgument: false, getArgumentCompletions: () => null }, "/deploy"],
		] satisfies Array<[SlashCommand, string]>) {
			const provider = new CombinedAutocompleteProvider([command], process.cwd());
			const completed = provider.applyCompletion(["/dep"], 0, 4, { value: "deploy", label: "deploy" }, "/dep");
			assert.deepEqual(completed, { lines: [expected], cursorLine: 0, cursorCol: expected.length });
		}
	});
});
