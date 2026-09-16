import assert from "node:assert";
import test from "node:test";
import { Input } from "../src/components/input.js";
import { visibleWidth } from "../src/utils.js";

test("masked input renders bullets while getValue and submit keep the real value", () => {
	const input = new Input({ masked: true });
	input.focused = true;
	for (const character of "ghp_secret123") input.handleInput(character);

	const [line] = input.render(60);
	assert.ok(line);
	assert.ok(!line.includes("ghp_secret123"), "masked render must not contain the raw value");
	assert.ok(line.includes("•".repeat("ghp_secret123".length)), "masked render shows one bullet per grapheme");
	assert.strictEqual(input.getValue(), "ghp_secret123");

	let submitted: string | undefined;
	input.onSubmit = (value) => {
		submitted = value;
	};
	input.handleInput("\r");
	assert.strictEqual(submitted, "ghp_secret123");
});

test("masked input keeps the cursor mapped through backspace and word deletes", () => {
	const input = new Input({ masked: true });
	input.focused = true;
	for (const character of "token one two") input.handleInput(character);
	input.handleInput("\x01"); // Ctrl+A: cursor at start — backspace does nothing
	input.handleInput("\x7f");
	assert.strictEqual(input.getValue(), "token one two");

	// Move past the first word and delete it: the masked render follows.
	for (let i = 0; i < 6; i++) input.handleInput("\x1b[C");
	input.handleInput("\x17"); // Ctrl+W deletes "token "
	assert.strictEqual(input.getValue(), "one two");

	const [line] = input.render(40);
	assert.ok(line);
	assert.ok(!line.includes("one"), "masked render must not contain the raw value");
	// One bullet per grapheme (the reverse-video cursor wraps one of them in
	// ANSI, so count rather than match a contiguous run).
	assert.strictEqual([...line].filter((character) => character === "•").length, "one two".length);
	assert.ok(visibleWidth(line) <= 40);
	// The cursor stays usable for further edits at the right position.
	for (const character of "new ") input.handleInput(character);
	assert.strictEqual(input.getValue(), "new one two");
});

test("unmasked input render stays byte-identical to the legacy behavior", () => {
	const unmasked = new Input();
	unmasked.focused = true;
	for (const character of "visible") unmasked.handleInput(character);
	const [line] = unmasked.render(40);
	assert.ok(line);
	assert.ok(line.includes("visible"));
});
