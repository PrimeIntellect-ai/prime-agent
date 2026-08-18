import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";
import { extractAnsiCode, sliceByColumn, stripAnsi, visibleWidth, wrapTextWithAnsi } from "../src/utils.js";

describe("wrapTextWithAnsi", () => {
	describe("underline styling", () => {
		it("should not apply underline style before the styled text", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const url = "https://example.com/very/long/path/that/will/wrap";
			const text = `read this thread ${underlineOn}${url}${underlineOff}`;

			const wrapped = wrapTextWithAnsi(text, 40);

			// First line should NOT contain underline code - it's just "read this thread"
			assert.strictEqual(wrapped[0], "read this thread");

			// Second line should start with underline, have URL content
			assert.strictEqual(wrapped[1].startsWith(underlineOn), true);
			assert.ok(wrapped[1].includes("https://"));
		});

		it("should not have whitespace before underline reset code", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const textWithUnderlinedTrailingSpace = `${underlineOn}underlined text here ${underlineOff}more`;

			const wrapped = wrapTextWithAnsi(textWithUnderlinedTrailingSpace, 18);

			assert.ok(!wrapped[0].includes(` ${underlineOff}`));
		});

		it("should not bleed underline to padding - each line should end with reset for underline only", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const url = "https://example.com/very/long/path/that/will/definitely/wrap";
			const text = `prefix ${underlineOn}${url}${underlineOff} suffix`;

			const wrapped = wrapTextWithAnsi(text, 30);

			// Middle lines (with underlined content) should end with underline-off, not full reset
			// Line 1 and 2 contain underlined URL parts
			for (let i = 1; i < wrapped.length - 1; i++) {
				const line = wrapped[i];
				if (line.includes(underlineOn)) {
					// Should end with underline off, NOT full reset
					assert.strictEqual(line.endsWith(underlineOff), true);
					assert.strictEqual(line.endsWith("\x1b[0m"), false);
				}
			}
		});
	});

	describe("background color preservation", () => {
		it("should preserve background color across wrapped lines without full reset", () => {
			const bgBlue = "\x1b[44m";
			const reset = "\x1b[0m";
			const text = `${bgBlue}hello world this is blue background text${reset}`;

			const wrapped = wrapTextWithAnsi(text, 15);

			// Each line should have background color
			for (const line of wrapped) {
				assert.ok(line.includes(bgBlue));
			}

			// Middle lines should NOT end with full reset (kills background for padding)
			for (let i = 0; i < wrapped.length - 1; i++) {
				assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
			}
		});

		it("should reset underline but preserve background when wrapping underlined text inside background", () => {
			const underlineOn = "\x1b[4m";
			const underlineOff = "\x1b[24m";
			const reset = "\x1b[0m";

			const text = `\x1b[41mprefix ${underlineOn}UNDERLINED_CONTENT_THAT_WRAPS${underlineOff} suffix${reset}`;

			const wrapped = wrapTextWithAnsi(text, 20);

			// All lines should have background color 41 (either as \x1b[41m or combined like \x1b[4;41m)
			for (const line of wrapped) {
				const hasBgColor = line.includes("[41m") || line.includes(";41m") || line.includes("[41;");
				assert.ok(hasBgColor);
			}

			// Lines with underlined content should use underline-off at end, not full reset
			for (let i = 0; i < wrapped.length - 1; i++) {
				const line = wrapped[i];
				// If this line has underline on, it should end with underline off (not full reset)
				if (
					(line.includes("[4m") || line.includes("[4;") || line.includes(";4m")) &&
					!line.includes(underlineOff)
				) {
					assert.strictEqual(line.endsWith(underlineOff), true);
					assert.strictEqual(line.endsWith("\x1b[0m"), false);
				}
			}
		});
	});

	describe("basic wrapping", () => {
		it("should wrap plain text correctly", () => {
			const text = "hello world this is a test";
			const wrapped = wrapTextWithAnsi(text, 10);

			assert.ok(wrapped.length > 1);
			for (const line of wrapped) {
				assert.ok(visibleWidth(line) <= 10);
			}
		});

		it("should ignore OSC 133 semantic markers in visible width", () => {
			const text = "\x1b]133;A\x07hello\x1b]133;B\x07";
			assert.strictEqual(visibleWidth(text), 5);
		});

		it("should ignore OSC sequences terminated with ST in visible width", () => {
			const text = "\x1b]133;A\x1b\\hello\x1b]133;B\x1b\\";
			assert.strictEqual(visibleWidth(text), 5);
		});

		it("should treat isolated regional indicators as width 2", () => {
			assert.strictEqual(visibleWidth("🇨"), 2);
			assert.strictEqual(visibleWidth("🇨🇳"), 2);
		});

		it("should truncate trailing whitespace that exceeds width", () => {
			const twoSpacesWrappedToWidth1 = wrapTextWithAnsi("  ", 1);
			assert.ok(visibleWidth(twoSpacesWrappedToWidth1[0]) <= 1);
		});

		it("should preserve color codes across wraps", () => {
			const red = "\x1b[31m";
			const reset = "\x1b[0m";
			const text = `${red}hello world this is red${reset}`;

			const wrapped = wrapTextWithAnsi(text, 10);

			// Each continuation line should start with red code
			for (let i = 1; i < wrapped.length; i++) {
				assert.strictEqual(wrapped[i].startsWith(red), true);
			}

			// Middle lines should not end with full reset
			for (let i = 0; i < wrapped.length - 1; i++) {
				assert.strictEqual(wrapped[i].endsWith("\x1b[0m"), false);
			}
		});
	});
});

describe("wrapTextWithAnsi with OSC 8 hyperlinks", () => {
	it("re-emits OSC 8 open at the start of continuation lines", () => {
		// A hyperlink whose text is long enough to wrap
		const url = "https://example.com";
		// OSC 8 open + text that is 10 visible chars + OSC 8 close
		const input = `\x1b]8;;${url}\x1b\\0123456789\x1b]8;;\x1b\\`;
		const lines = wrapTextWithAnsi(input, 6);

		// Every line that contains visible text from inside the hyperlink
		// should start with the OSC 8 open sequence (or be preceded by it).
		for (const line of lines) {
			// If the line has visible content it must begin with the OSC 8 re-open
			// OR it is the line where the close appeared with no following content.
			const stripped = line.replace(/\x1b\]8;;[^\x1b\x07]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, "");
			if (stripped.trim().length > 0) {
				assert.ok(
					line.startsWith(`\x1b]8;;${url}\x1b\\`) || line.includes(`\x1b]8;;${url}\x1b\\`),
					`Line "${line}" has visible text but no OSC 8 re-open`,
				);
			}
		}
	});

	it("closes OSC 8 before each line break", () => {
		const url = "https://example.com";
		const input = `\x1b]8;;${url}\x1b\\0123456789\x1b]8;;\x1b\\`;
		const lines = wrapTextWithAnsi(input, 6);

		for (let i = 0; i < lines.length - 1; i++) {
			const line = lines[i];
			// Every non-final line that is inside a hyperlink should end with the close
			if (line.includes(`\x1b]8;;${url}\x1b\\`)) {
				assert.ok(
					line.endsWith("\x1b]8;;\x1b\\"),
					`Non-final line "${line}" is inside a hyperlink but does not close it`,
				);
			}
		}
	});

	it("preserves BEL terminators when wrapping OAuth-style hyperlinks", () => {
		const url = `https://example.com/oauth/${"a".repeat(32)}`;
		const input = `\x1b]8;;${url}\x07${url}\x1b]8;;\x07`;
		const lines = wrapTextWithAnsi(input, 20);

		assert.ok(lines.length > 1);
		for (const line of lines) {
			assert.ok(line.includes(`\x1b]8;;${url}\x07`), `Line "${line}" does not reopen the hyperlink with BEL`);
			assert.ok(!line.includes(`\x1b]8;;${url}\x1b\\`), `Line "${line}" reopens the hyperlink with ST`);
		}
		for (const line of lines.slice(0, -1)) {
			assert.ok(line.endsWith("\x1b]8;;\x07"), `Line "${line}" does not close the hyperlink with BEL`);
		}
	});

	it("does not emit OSC 8 sequences on lines that are outside the hyperlink", () => {
		const url = "https://example.com";
		const input = `before \x1b]8;;${url}\x1b\\link\x1b]8;;\x1b\\ after`;
		const lines = wrapTextWithAnsi(input, 80);

		// With width 80 everything fits on one line; there should be exactly one
		// OSC 8 open and one OSC 8 close.
		assert.strictEqual(lines.length, 1);
		const openCount = (lines[0].match(/\x1b\]8;;https:[^\x1b]+\x1b\\/g) ?? []).length;
		const closeCount = (lines[0].match(/\x1b\]8;;\x1b\\/g) ?? []).length;
		assert.strictEqual(openCount, 1);
		assert.strictEqual(closeCount, 1);
	});
});

describe("ANSI sequence scanning", () => {
	it("accepts the full CSI final-byte range and valid byte classes", () => {
		const sequences = ["\x1b[@", "\x1b[2A", "\x1b[?25l", "\x1b[1 q", "\x1b[15~"];

		for (const sequence of sequences) {
			assert.deepStrictEqual(extractAnsiCode(sequence, 0), {
				code: sequence,
				length: sequence.length,
			});
		}
	});

	it("rejects incomplete and malformed CSI sequences", () => {
		for (const sequence of ["\x1b[", "\x1b[31", "\x1b[1 ", "\x1b[1 2m", "\x1b[1\x7fm"]) {
			assert.strictEqual(extractAnsiCode(sequence, 0), null);
		}
	});

	it("keeps OSC and DCS payloads distinct from CSI scanning", () => {
		const oscBel = "\x1b]0;title\x07";
		const oscSt = "\x1b]0;title\x1b\\";
		const dcs = "\x1bP1;2|payload[m~\x1b\\";
		const apcBel = "\x1b_private-marker\x07";

		for (const sequence of [oscBel, oscSt, dcs, apcBel]) {
			assert.deepStrictEqual(extractAnsiCode(sequence, 0), {
				code: sequence,
				length: sequence.length,
			});
		}
		assert.strictEqual(extractAnsiCode("\x1b]0;title", 0), null);
		assert.strictEqual(extractAnsiCode("\x1bPpayload", 0), null);
		assert.strictEqual(extractAnsiCode("\x1bPpayload\x07", 0), null);
	});

	it("ignores standard CSI and DCS sequences when measuring width", () => {
		const text = "a\x1b[2Ab\x1b[?25lc\x1b[1 qd\x1bPpayload[m~\x1b\\e";
		assert.strictEqual(visibleWidth(text), 5);
	});

	it("preserves scanned sequences while slicing by visible columns", () => {
		const hideCursor = "\x1b[?25l";
		const dcs = "\x1bPpayload\x1b\\";
		const text = `a${hideCursor}bc${dcs}d`;

		assert.strictEqual(sliceByColumn(text, 1, 3), `${hideCursor}bc${dcs}d`);
	});

	it("wraps by visible width without splitting standard CSI sequences", () => {
		const hideCursor = "\x1b[?25l";
		const showCursor = "\x1b[?25h";

		assert.deepStrictEqual(wrapTextWithAnsi(`${hideCursor}abcdef${showCursor}`, 3), [
			`${hideCursor}abc`,
			`def${showCursor}`,
		]);
	});

	it("strips every scanned sequence from copied text", () => {
		const cursorStyle = "\x1b[1 q";
		const dcs = "\x1bPone\x1bXtwo\x1b\\";
		const dcsWithCsiPayload = "\x1bPbefore\x1b[31mafter\x1b\\";
		const text = `a${cursorStyle}b${dcs}c`;

		assert.strictEqual(stripAnsi(sliceByColumn(text, 0, 3)), "abc");
		assert.strictEqual(stripAnsi(`a${dcsWithCsiPayload}b`), "ab");
		assert.strictEqual(stripAnsi("a\x1bc b"), "a b");
		assert.strictEqual(stripAnsi("a\x1b\nb"), "a\x1b\nb");
	});

	it("strips long ANSI-heavy copied text", () => {
		const styled = "plain-text-1234567890\x1b[31mcolored\x1b[0m".repeat(10_000);

		assert.strictEqual(stripAnsi(styled), "plain-text-1234567890colored".repeat(10_000));
	});

	it("scans repeated incomplete control strings without quadratic slowdown", () => {
		const text = "\x1bP".repeat(50_000);
		const start = performance.now();

		assert.strictEqual(visibleWidth(text), 50_000);
		assert.ok(performance.now() - start < 1_000);
	});

	it("still finds valid control strings after an incomplete prefix", () => {
		const text = "\x1bPunterminated\x1b]0;title\x07x";

		assert.strictEqual(visibleWidth(text), visibleWidth("Punterminatedx"));
	});
});
