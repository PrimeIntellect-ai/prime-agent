/**
 * Detects degenerate, non-progressing generation while a stream is still
 * running, so the request can be aborted instead of burning the whole output
 * budget.
 *
 * The failure this exists for (#1029): a thinking stream settled into emitting
 * `"The the the the the the the "` back to back 2,366 times — 79,222 characters
 * — and only stopped when the user aborted by hand. Provider streamers are
 * faithful assemblers and never inspect content, request construction attaches
 * no repetition penalties, and the agent loop treats a completed stream as
 * progress, so nothing owned this.
 *
 * Two shapes are detected, because a loop rarely stays verbatim for long:
 *
 * 1. **Periodic tail.** The tail of the stream is one short unit repeated many
 *    times. Found with the KMP failure function, which yields the smallest
 *    period of a string in O(n) — no scanning of candidate period lengths.
 * 2. **Novelty stall.** The tail keeps restating the same content with drift, so
 *    verbatim periodicity misses it. Measured as distinct word trigrams over
 *    total word trigrams: a loop reuses the same trigrams, legitimate output
 *    does not.
 *
 * The novelty threshold is calibrated, not guessed. Measured over the corpus in
 * `test/repetition-guard.test.ts`:
 *
 *     loops   verbatim 0.001   drifting 0.136
 *     legit   enumerated analysis 0.286   markdown table 0.485   JSON 0.513
 *             source code 0.611   numbered list 0.671   prose 1.000
 *
 * 0.20 sits in the gap with margin on both sides. Word-trigram Jaccard between
 * paragraphs was tried first and rejected: drifting loops scored 0.38-0.58
 * while structurally similar legitimate paragraphs scored in the same band, so
 * it could not separate them at any threshold.
 *
 * False positives are the real risk: legitimate reasoning repeats phrases, and
 * code, tables and lists are structurally repetitive. Every threshold below is
 * deliberately conservative, and the guard only looks at a bounded tail, never
 * the whole transcript.
 */

/** Why the guard fired. */
export type RepetitionKind = "periodic_tail" | "novelty_stall";

export interface RepetitionFinding {
	kind: RepetitionKind;
	/** Characters inspected when the guard fired. */
	inspectedChars: number;
	/** Total characters seen on this channel. */
	totalChars: number;
	/** For `periodic_tail`: length of the repeating unit. */
	periodChars?: number;
	/** For `periodic_tail`: how many times it repeated. */
	repeats?: number;
	/** For `novelty_stall`: distinct trigrams over total, 0..1. */
	novelty?: number;
	/** Short, redacted sample of the repeating unit, for diagnostics. */
	sample: string;
}

export interface RepetitionGuardOptions {
	/** Tail kept for periodicity analysis. Default 4096. */
	windowChars?: number;
	/**
	 * Do not consider a periodic tail degenerate below this many repeats.
	 * Default 16 — high enough that a table of 12 similar rows cannot trip it.
	 */
	minRepeats?: number;
	/**
	 * Longest repeating unit treated as degenerate. Default 512. Above this a
	 * "repeat" is more plausibly a legitimately re-emitted structure.
	 */
	maxPeriodChars?: number;
	/**
	 * Skip detection until this much text has arrived. Default 2048 — short
	 * bursts of repetition are normal at the start of a thought.
	 */
	minCharsBeforeCheck?: number;
	/** Run detection at most once per this many new characters. Default 256. */
	checkEveryChars?: number;
	/**
	 * Distinct-trigram ratio at or below which the tail counts as stalled.
	 * Default 0.2; see the calibration table above.
	 */
	noveltyFloor?: number;
	/**
	 * Minimum trigrams before the novelty ratio means anything. Default 200 —
	 * a short window is trivially low-novelty.
	 */
	minTrigramsForNovelty?: number;
}

const DEFAULTS = {
	windowChars: 4096,
	minRepeats: 16,
	maxPeriodChars: 512,
	minCharsBeforeCheck: 2048,
	checkEveryChars: 256,
	noveltyFloor: 0.2,
	minTrigramsForNovelty: 200,
} as const satisfies Required<RepetitionGuardOptions>;

const SAMPLE_CHARS = 80;

/** Kill switch, matching the convention used for other guards. */
export const REPETITION_GUARD_DISABLED_ENV = "PRIME_AGENT_NO_REPETITION_GUARD";

export function isRepetitionGuardDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env[REPETITION_GUARD_DISABLED_ENV];
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Smallest period of `text` via the KMP failure function.
 *
 * `len - failure[len - 1]` is the shortest string whose repetition produces
 * `text`, when it divides `len` evenly. When it does not, `text` is not fully
 * periodic and the value is meaningless, so callers must check divisibility.
 */
function smallestPeriod(text: string): number {
	const len = text.length;
	if (len === 0) return 0;
	const failure = new Int32Array(len);
	let k = 0;
	for (let i = 1; i < len; i++) {
		while (k > 0 && text[i] !== text[k]) k = failure[k - 1];
		if (text[i] === text[k]) k++;
		failure[i] = k;
	}
	return len - failure[len - 1];
}

/** Collapse runs of whitespace so drifting indentation is not mistaken for novelty. */
function normalizeForCompare(text: string): string {
	return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Distinct word trigrams over total, 0..1. A loop reuses the same trigrams and
 * scores near zero; varied prose approaches 1. Returns `undefined` when there
 * is not enough text for the ratio to mean anything.
 */
export function trigramNovelty(text: string, minTrigrams: number): number | undefined {
	const words = normalizeForCompare(text).split(" ").filter(Boolean);
	if (words.length < 3) return undefined;
	const total = words.length - 2;
	if (total < minTrigrams) return undefined;
	const seen = new Set<string>();
	for (let i = 0; i + 2 < words.length; i++) {
		seen.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
	}
	return seen.size / total;
}

function sampleOf(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > SAMPLE_CHARS ? `${normalized.slice(0, SAMPLE_CHARS)}…` : normalized;
}

/**
 * Incremental detector for one channel of one stream. Feed it deltas; it
 * returns a finding the first time the accumulated output looks degenerate.
 *
 * Not reusable across streams — construct one per channel per request.
 */
export class RepetitionGuard {
	private readonly options: Required<RepetitionGuardOptions>;
	private window = "";
	private totalChars = 0;
	private charsSinceCheck = 0;
	private fired = false;

	constructor(options: RepetitionGuardOptions = {}) {
		this.options = { ...DEFAULTS, ...options };
	}

	/**
	 * Feed one delta. Returns a finding the first time the stream looks
	 * degenerate, and `undefined` on every call after that — the caller aborts
	 * on the first hit, so repeat reporting would be noise.
	 */
	push(delta: string): RepetitionFinding | undefined {
		if (this.fired || delta.length === 0) return undefined;

		this.totalChars += delta.length;
		this.charsSinceCheck += delta.length;
		this.window = (this.window + delta).slice(-this.options.windowChars);

		if (this.totalChars < this.options.minCharsBeforeCheck) return undefined;
		if (this.charsSinceCheck < this.options.checkEveryChars) return undefined;
		this.charsSinceCheck = 0;

		const finding = this.detectPeriodicTail() ?? this.detectNoveltyStall();
		if (finding) this.fired = true;
		return finding;
	}

	/** Characters seen so far on this channel. */
	get seenChars(): number {
		return this.totalChars;
	}

	private detectPeriodicTail(): RepetitionFinding | undefined {
		const window = this.window;
		if (window.length < this.options.minCharsBeforeCheck) return undefined;

		const period = smallestPeriod(window);
		// Not evenly periodic across the whole window: try the largest suffix
		// that is. A loop that started mid-window is the common case.
		const candidates = window.length % period === 0 ? [window] : [window.slice(window.length % period)];
		for (const candidate of candidates) {
			const candidatePeriod = smallestPeriod(candidate);
			if (candidatePeriod === 0 || candidate.length % candidatePeriod !== 0) continue;
			if (candidatePeriod > this.options.maxPeriodChars) continue;
			const repeats = candidate.length / candidatePeriod;
			if (repeats < this.options.minRepeats) continue;
			// A period that is entirely whitespace is padding, not a loop.
			if (candidate.slice(0, candidatePeriod).trim().length === 0) continue;
			return {
				kind: "periodic_tail",
				inspectedChars: candidate.length,
				totalChars: this.totalChars,
				periodChars: candidatePeriod,
				repeats,
				sample: sampleOf(candidate.slice(0, candidatePeriod)),
			};
		}
		return undefined;
	}

	private detectNoveltyStall(): RepetitionFinding | undefined {
		const novelty = trigramNovelty(this.window, this.options.minTrigramsForNovelty);
		if (novelty === undefined || novelty > this.options.noveltyFloor) return undefined;
		return {
			kind: "novelty_stall",
			inspectedChars: this.window.length,
			totalChars: this.totalChars,
			novelty,
			sample: sampleOf(this.window.slice(-SAMPLE_CHARS * 2)),
		};
	}
}

/** One-line description for logs and the user-facing error. */
export function describeRepetition(finding: RepetitionFinding): string {
	if (finding.kind === "periodic_tail") {
		return `repeated a ${finding.periodChars}-character sequence ${finding.repeats} times (${finding.totalChars} chars generated): "${finding.sample}"`;
	}
	const novelty = finding.novelty === undefined ? "?" : finding.novelty.toFixed(3);
	return `stopped producing novel text (distinct-trigram ratio ${novelty} over ${finding.inspectedChars} chars, ${finding.totalChars} chars generated): "${finding.sample}"`;
}
