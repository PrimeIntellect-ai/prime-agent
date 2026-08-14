import { describe, expect, it } from "vitest";
import {
	describeRepetition,
	isRepetitionGuardDisabled,
	REPETITION_GUARD_DISABLED_ENV,
	type RepetitionFinding,
	RepetitionGuard,
} from "../src/utils/repetition-guard.js";

/**
 * Detection tests are cheap; the false-positive tests below are the ones that
 * matter. A guard that aborts legitimate reasoning is worse than the loop it
 * prevents, so every realistic repetitive shape a model actually emits — code,
 * tables, lists, JSON, enumerated analysis — is asserted NOT to fire.
 */

/** Feed text in small chunks, the way deltas actually arrive. */
function stream(guard: RepetitionGuard, text: string, chunkChars = 24): RepetitionFinding | undefined {
	let firstFinding: RepetitionFinding | undefined;
	for (let i = 0; i < text.length; i += chunkChars) {
		const finding = guard.push(text.slice(i, i + chunkChars));
		if (finding && !firstFinding) firstFinding = finding;
	}
	return firstFinding;
}

describe("RepetitionGuard — the reported failure", () => {
	it("catches the #1029 loop", () => {
		// The exact shape from the issue: "The the the the the the the " repeated
		// until the user aborted, 79,222 chars in the wild.
		const unit = "The the the the the the the ";
		const finding = stream(new RepetitionGuard(), unit.repeat(400));

		expect(finding).toBeDefined();
		expect(finding?.kind).toBe("periodic_tail");
		expect(finding?.repeats).toBeGreaterThanOrEqual(16);
		expect(finding?.sample).toContain("The the");
	});

	it("fires far below the 32k-token output cap", () => {
		const guard = new RepetitionGuard();
		const unit = "The the the the the the the ";
		let charsWhenFired = 0;
		let emitted = 0;
		for (let i = 0; i < 4000 && charsWhenFired === 0; i++) {
			emitted += unit.length;
			if (guard.push(unit)) charsWhenFired = emitted;
		}
		expect(charsWhenFired).toBeGreaterThan(0);
		// The incident persisted 79,222 characters. Anything in the low
		// thousands is a decisive improvement; assert well inside that.
		expect(charsWhenFired).toBeLessThan(8000);
	});

	it("reports only once so the caller is not spammed", () => {
		const guard = new RepetitionGuard();
		const unit = "The the the the the the the ";
		let findings = 0;
		for (let i = 0; i < 400; i++) {
			if (guard.push(unit)) findings++;
		}
		expect(findings).toBe(1);
	});

	it("catches a single-word loop with no spaces", () => {
		const finding = stream(new RepetitionGuard(), "loop".repeat(2000));
		expect(finding?.kind).toBe("periodic_tail");
	});

	it("catches a loop that only starts after legitimate reasoning", () => {
		const preamble =
			"I need to weigh the tradeoffs between the two designs before writing any code. " +
			"The first keeps the parser simple but pushes complexity into the caller. ".repeat(6);
		const finding = stream(new RepetitionGuard(), preamble + "wait wait wait wait ".repeat(500));
		// Either detector is a correct answer here; the point is that it stops.
		expect(finding).toBeDefined();
	});

	it("catches a drifting loop that verbatim periodicity cannot see", () => {
		// Same thought re-emitted with small wording changes: verbatim
		// periodicity cannot see this.
		const variants = [
			"Let me reconsider the approach here, because the previous attempt did not account for the retry path.",
			"Let me reconsider the approach here since the previous attempt did not account for the retry path.",
			"Let me reconsider this approach, because that previous attempt did not account for the retry path.",
		];
		let text = "";
		for (let i = 0; i < 40; i++) text += `${variants[i % variants.length]}\n\n`;

		const finding = stream(new RepetitionGuard(), text);
		expect(finding).toBeDefined();
		expect(finding?.kind).toBe("novelty_stall");
		expect(finding?.novelty).toBeLessThanOrEqual(0.2);
	});
});

describe("RepetitionGuard — must not fire on legitimate output", () => {
	const cases: [string, string][] = [
		[
			"prose reasoning",
			"I will start by reading the provider streamer to understand how deltas are assembled. " +
				"The reasoning field is chosen from a list of candidates, which means a provider that returns " +
				"two of them could duplicate content. After that I want to check whether the agent loop has any " +
				"notion of progress, because if it does the guard belongs there instead of in the provider. " +
				"Finally I will look at how errors are classified so a synthetic failure is retryable rather " +
				"than terminal, and confirm the session actually re-samples on that path instead of surfacing it.",
		],
		[
			"a markdown table",
			`| field | type | required | description |\n|---|---|---|---|\n${Array.from(
				{ length: 40 },
				(_, i) => `| field_${i} | string | yes | describes the ${i}th configured property |`,
			).join("\n")}`,
		],
		[
			"a numbered list",
			Array.from({ length: 60 }, (_, i) => `${i + 1}. Check that handler ${i} forwards its abort signal.`).join(
				"\n",
			),
		],
		[
			"repetitive source code",
			Array.from(
				{ length: 40 },
				(_, i) => `export function handler${i}(input: string): string {\n\treturn transform(input, ${i});\n}\n`,
			).join("\n"),
		],
		[
			"a JSON payload",
			`[\n${Array.from(
				{ length: 60 },
				(_, i) => `  { "id": ${i}, "name": "item-${i}", "enabled": true, "weight": 0.5 }`,
			).join(",\n")}\n]`,
		],
		[
			"enumerated analysis paragraphs",
			Array.from(
				{ length: 12 },
				(_, i) =>
					`Step ${i + 1}: inspect subsystem ${i} and record whether it owns the abort signal, ` +
					`what it does on a partial write, and which failure kind it maps to.\n\n`,
			).join(""),
		],
	];

	for (const [name, text] of cases) {
		it(`does not fire on ${name}`, () => {
			expect(stream(new RepetitionGuard(), text)).toBeUndefined();
		});
	}

	it("does not fire on repetition that stops before the threshold", () => {
		// Eight repeats is well under minRepeats; a model recovering from a
		// short stutter must not be aborted. The recovery text has to be
		// genuinely varied — repeating one sentence 40 times is itself
		// degenerate, and an earlier version of this test wrongly asserted
		// that shape was legitimate.
		const recovery = Array.from(
			{ length: 60 },
			(_, i) =>
				`Back to the real problem: step ${i} needs to confirm that the ${i % 2 === 0 ? "reader" : "writer"} ` +
				`releases its handle before subsystem ${i + 3} tears the socket down, otherwise the retry path ` +
				`observes a half-open connection and reports success incorrectly.`,
		).join(" ");
		expect(stream(new RepetitionGuard(), `${"The the the the ".repeat(8)}${recovery}`)).toBeUndefined();
	});

	it("does not fire below the minimum inspection length", () => {
		const guard = new RepetitionGuard();
		// Loop shape, but only ~1 KB — under minCharsBeforeCheck.
		expect(stream(guard, "ab".repeat(500))).toBeUndefined();
		expect(guard.seenChars).toBe(1000);
	});

	it("does not fire on whitespace padding", () => {
		expect(stream(new RepetitionGuard(), " ".repeat(6000))).toBeUndefined();
	});
});

describe("RepetitionGuard — configuration", () => {
	it("honours a lowered repeat threshold", () => {
		const guard = new RepetitionGuard({ minRepeats: 4, minCharsBeforeCheck: 64, checkEveryChars: 16 });
		expect(stream(guard, "spin ".repeat(40))).toBeDefined();
	});

	it("ignores a period longer than maxPeriodChars", () => {
		const unit = `${"x".repeat(600)}\n`;
		expect(stream(new RepetitionGuard({ maxPeriodChars: 64 }), unit.repeat(30))).toBeUndefined();
	});

	it("respects the kill switch env var", () => {
		expect(isRepetitionGuardDisabled({})).toBe(false);
		expect(isRepetitionGuardDisabled({ [REPETITION_GUARD_DISABLED_ENV]: "" })).toBe(false);
		expect(isRepetitionGuardDisabled({ [REPETITION_GUARD_DISABLED_ENV]: "0" })).toBe(false);
		expect(isRepetitionGuardDisabled({ [REPETITION_GUARD_DISABLED_ENV]: "false" })).toBe(false);
		expect(isRepetitionGuardDisabled({ [REPETITION_GUARD_DISABLED_ENV]: "1" })).toBe(true);
		expect(isRepetitionGuardDisabled({ [REPETITION_GUARD_DISABLED_ENV]: "true" })).toBe(true);
	});

	it("is unaffected by how deltas are chunked", () => {
		const unit = "The the the the the the the ";
		const text = unit.repeat(400);
		for (const chunk of [1, 7, 64, 1024]) {
			expect(stream(new RepetitionGuard(), text, chunk)?.kind, `chunk size ${chunk}`).toBe("periodic_tail");
		}
	});
});

describe("describeRepetition", () => {
	it("describes a periodic tail", () => {
		const finding = stream(new RepetitionGuard(), "The the the the the the the ".repeat(400));
		expect(finding).toBeDefined();
		if (!finding) return;
		const text = describeRepetition(finding);
		expect(text).toMatch(/repeated a \d+-character sequence \d+ times/);
	});

	it("describes a novelty stall", () => {
		const finding: RepetitionFinding = {
			kind: "novelty_stall",
			inspectedChars: 4096,
			totalChars: 12000,
			novelty: 0.081,
			sample: "Let me reconsider the approach here",
		};
		const text = describeRepetition(finding);
		expect(text).toContain("stopped producing novel text");
		expect(text).toContain("0.081");
	});
});
