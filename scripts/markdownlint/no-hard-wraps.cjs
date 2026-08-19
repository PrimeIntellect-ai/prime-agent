// Forbid hard-wrapped prose: a paragraph or list item must be one logical line.
// Wrapping mid-paragraph distorts line counts and makes diffs touch whole
// paragraphs for one-word edits. MD013 is off, so long lines are fine.
// Skipped: code fences, HTML blocks, tables, headings, blockquotes, reference
// definitions, and deliberate hard breaks (trailing two spaces or backslash).

"use strict";

const isListStart = (s) => /^\s*(?:[-*+]|\d+[.)])\s/.test(s);
const isHtml = (s) => /^\s*</.test(s.trim() === "" ? "x" : s);
const isStructural = (s) =>
	s.trim() === "" ||
	/^\s*#/.test(s) ||
	/^\s*>/.test(s) ||
	/^\s*\|/.test(s) ||
	/^\s*(?:---|\*\*\*|___)\s*$/.test(s) ||
	/^\s*\[[^\]]+\]:/.test(s) ||
	isHtml(s) ||
	isListStart(s);
const hasHardBreak = (s) => /(?:\s{2}|\\)$/.test(s);

const test = (params, onError) => {
	const lines = params.lines;
	let inFence = false;
	let fenceMarker = "";
	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		const fence = line.match(/^\s*(`{3,}|~{3,})/);
		if (fence) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fence[1][0];
			} else if (fence[1][0] === fenceMarker) {
				inFence = false;
			}
			continue;
		}
		if (inFence) continue;
		const next = lines[i + 1];
		if (
			line.trim() !== "" &&
			!isHtml(line) &&
			!hasHardBreak(line) &&
			!isStructural(next) &&
			!/^\s*(`{3,}|~{3,})/.test(next) &&
			(!isStructural(line) || isListStart(line))
		) {
			onError({
				lineNumber: i + 2,
				detail: "Continuation of the previous line; keep one logical line per paragraph/bullet.",
			});
		}
	}
};

module.exports = {
	names: ["PA001", "no-hard-wraps"],
	description: "Prose must not be hard-wrapped mid-paragraph",
	tags: ["style"],
	parser: "none",
	function: test,
};
