import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** Test/benchmark accounting for actual input supplied to the legacy prefix parser. */
let legacyStreamingJsonInputExamined = 0;

export function resetStreamingJsonParseInstrumentationForTesting(): void {
	legacyStreamingJsonInputExamined = 0;
}

export function getLegacyStreamingJsonInputExaminedForTesting(): number {
	return legacyStreamingJsonInputExamined;
}

function isControlCharacter(char: string): boolean {
	const codePoint = char.codePointAt(0);
	return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
	switch (char) {
		case "\b":
			return "\\b";
		case "\f":
			return "\\f";
		case "\n":
			return "\\n";
		case "\r":
			return "\\r";
		case "\t":
			return "\\t";
		default:
			return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
	}
}

/**
 * Repairs malformed JSON string literals by:
 * - escaping raw control characters inside strings
 * - doubling backslashes before invalid escape characters
 */
export function repairJson(json: string): string {
	let repaired = "";
	let inString = false;

	for (let index = 0; index < json.length; index++) {
		const char = json[index];

		if (!inString) {
			repaired += char;
			if (char === '"') {
				inString = true;
			}
			continue;
		}

		if (char === '"') {
			repaired += char;
			inString = false;
			continue;
		}

		if (char === "\\") {
			const nextChar = json[index + 1];
			if (nextChar === undefined) {
				repaired += "\\\\";
				continue;
			}

			if (nextChar === "u") {
				const unicodeDigits = json.slice(index + 2, index + 6);
				if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
					repaired += `\\u${unicodeDigits}`;
					index += 5;
					continue;
				}
			}

			if (VALID_JSON_ESCAPES.has(nextChar)) {
				repaired += `\\${nextChar}`;
				index += 1;
				continue;
			}

			repaired += "\\\\";
			continue;
		}

		repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
	}

	return repaired;
}

export function parseJsonWithRepair<T>(json: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		const repairedJson = repairJson(json);
		if (repairedJson !== json) {
			return JSON.parse(repairedJson) as T;
		}
		throw error;
	}
}

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 */
export function parseStreamingJson<T = Record<string, unknown>>(partialJson: string | undefined): T {
	legacyStreamingJsonInputExamined += partialJson?.length ?? 0;
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	try {
		return parseJsonWithRepair<T>(partialJson);
	} catch {
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			try {
				const result = partialParse(repairJson(partialJson));
				return (result ?? {}) as T;
			} catch {
				return {} as T;
			}
		}
	}
}

/**
 * Incremental, display-only JSON parser for streamed tool arguments. Unlike
 * `parseStreamingJson`, this never reparses the accumulated prefix. The raw
 * document is retained solely for the one strict terminal validation.
 */
export interface StreamingJsonParseState<T = Record<string, unknown>> {
	append(delta: string): T;
	preview(): T;
	finalize(): T;
}

type Container = Record<string, unknown> | unknown[];
type Frame = {
	value: Container;
	kind: "object" | "array";
	key?: string;
	expecting: "key" | "colon" | "value" | "comma";
};
type StringToken = {
	target: "key" | "value";
	/** The value partial-json can safely expose for the original prefix. */
	value: string;
	/** The value visible once repair makes a closed invalid escape parseable. */
	repairedValue: string;
	escape: boolean;
	unicode: string | undefined;
	invalidEscape: boolean;
	invalidUnicode: boolean;
	rawControl: boolean;
	location?: ValueLocation;
};
type ValueLocation = { frame?: Frame; key?: string; arrayIndex?: number; root: boolean };
type ScalarToken = { value: string; target: "value"; location: ValueLocation };

/**
 * The lexer deliberately advances UTF-16 code units: a surrogate pair split
 * between stream chunks is therefore indistinguishable from the same input in
 * one chunk. Preview is best effort; only finalize is authoritative.
 */
class IncrementalStreamingJsonParseState<T> implements StreamingJsonParseState<T> {
	private readonly rawChunks: string[] = [];
	private terminal = false;
	private root: unknown = {};
	private hasRoot = false;
	private rootComplete = false;
	private previewInvalid = false;
	private readonly frames: Frame[] = [];
	private stringToken: StringToken | undefined;
	private scalarToken: ScalarToken | undefined;
	private strictValidationCount = 0;
	private incrementalInputExamined = 0;
	private finalInputExamined = 0;
	private readonly repairedStringsAtRootClose: Array<{ location: ValueLocation; value: string }> = [];

	append(delta: string): T {
		if (this.terminal) throw new Error("Cannot append after streaming JSON finalization");
		if (typeof delta !== "string") throw new TypeError("Streaming JSON delta must be a string");
		this.rawChunks.push(delta);
		this.incrementalInputExamined += delta.length;
		for (let index = 0; index < delta.length; index++) this.consume(delta[index]);
		return this.preview();
	}

	preview(): T {
		if (this.terminal) throw new Error("Cannot preview after streaming JSON finalization");
		return (this.previewInvalid ? {} : this.hasRoot ? this.root : {}) as T;
	}

	finalize(): T {
		if (this.terminal) throw new Error("Streaming JSON has already been finalized");
		this.terminal = true;
		const raw = this.rawChunks.join("");
		this.rawChunks.length = 0;
		this.finalInputExamined += raw.length;
		this.strictValidationCount++;
		return JSON.parse(raw) as T;
	}

	/** Test-only inspection; intentionally not part of the exported interface. */
	getStrictValidationCountForTesting(): number {
		return this.strictValidationCount;
	}

	getRawForProviderCheck(): string {
		return this.rawChunks.join("");
	}

	getInputExaminedForTesting(): { incremental: number; final: number; total: number } {
		return {
			incremental: this.incrementalInputExamined,
			final: this.finalInputExamined,
			total: this.incrementalInputExamined + this.finalInputExamined,
		};
	}

	discard(): void {
		this.rawChunks.length = 0;
		this.frames.length = 0;
		this.stringToken = undefined;
		this.scalarToken = undefined;
		this.terminal = true;
	}

	private consume(char: string): void {
		if (this.stringToken) {
			this.consumeString(char);
			return;
		}
		if (this.scalarToken) {
			if (char === "," || char === "]" || char === "}" || isWhitespace(char)) {
				this.finishScalar();
				this.consume(char);
			} else {
				this.scalarToken.value += char;
				this.updateScalarPreview();
			}
			return;
		}
		if (isWhitespace(char) || this.rootComplete) return;
		const frame = this.frames.at(-1);
		if (char === "{") {
			const value: Record<string, unknown> = {};
			this.beginValue(value);
			this.frames.push({ value, kind: "object", expecting: "key" });
			return;
		}
		if (char === "[") {
			const value: unknown[] = [];
			this.beginValue(value);
			this.frames.push({ value, kind: "array", expecting: "value" });
			return;
		}
		if (char === '"') {
			if (frame?.kind === "object" && frame.expecting === "key") {
				this.stringToken = {
					target: "key",
					value: "",
					repairedValue: "",
					escape: false,
					unicode: undefined,
					invalidEscape: false,
					invalidUnicode: false,
					rawControl: false,
				};
			} else {
				const location = this.currentValueLocation();
				this.beginValue("");
				this.stringToken = {
					target: "value",
					value: "",
					repairedValue: "",
					escape: false,
					unicode: undefined,
					invalidEscape: false,
					invalidUnicode: false,
					rawControl: false,
					location,
				};
			}
			return;
		}
		if (char === ":") {
			if (frame?.kind === "object") frame.expecting = "value";
			return;
		}
		if (char === ",") {
			if (frame) frame.expecting = frame.kind === "object" ? "key" : "value";
			return;
		}
		if (char === "}" || char === "]") {
			if (frame && ((char === "}" && frame.kind === "object") || (char === "]" && frame.kind === "array"))) {
				this.frames.pop();
				this.valueComplete();
				if (this.frames.length === 0) {
					this.rootComplete = true;
					this.previewInvalid = false;
					for (const repaired of this.repairedStringsAtRootClose) this.setValue(repaired.location, repaired.value);
				}
			}
			return;
		}
		const location = this.currentValueLocation();
		const preview = this.previewScalar(char);
		this.beginValue(preview === undefined ? {} : preview);
		this.scalarToken = { target: "value", value: char, location };
		if (preview === undefined) this.removeValue(location);
	}

	private consumeString(char: string): void {
		const token = this.stringToken!;
		if (token.unicode !== undefined) {
			if (!/[0-9a-fA-F]/.test(char)) {
				// partial-json retains the pre-escape value while this malformed
				// unicode sequence is still open. A closing quote makes the prefix
				// unparseable; handle that quote as the next normal token.
				token.invalidEscape = true;
				token.invalidUnicode = true;
				token.unicode = undefined;
				if (char === '"') this.consumeString(char);
				else token.repairedValue += char;
				return;
			}
			token.unicode += char;
			if (token.unicode.length === 4) {
				const value = String.fromCharCode(Number.parseInt(token.unicode, 16));
				if (!token.invalidEscape) token.value += value;
				token.repairedValue += value;
				token.unicode = undefined;
				this.updateStringPreview(token);
			}
			return;
		}
		if (token.escape) {
			token.escape = false;
			if (char === "u") {
				token.unicode = "";
				return;
			}
			const escaped: Record<string, string> = {
				'"': '"',
				"\\": "\\",
				"/": "/",
				b: "\b",
				f: "\f",
				n: "\n",
				r: "\r",
				t: "\t",
			};
			if (char in escaped) {
				if (!token.invalidEscape) token.value += escaped[char];
				token.repairedValue += escaped[char];
			} else {
				// partial-json exposes the prefix before an invalid escape while it
				// remains open. repairJson exposes a literal backslash once closed.
				token.invalidEscape = true;
				token.repairedValue += `\\${char}`;
			}
			this.updateStringPreview(token);
			return;
		}
		if (char === "\\") {
			token.escape = true;
			return;
		}
		if (char === '"') {
			this.stringToken = undefined;
			if (token.rawControl) {
				// A closed raw-control string is only repairable once the whole
				// enclosing document closes; partial-json rejects this prefix.
				this.previewInvalid = true;
				if (token.location)
					this.repairedStringsAtRootClose.push({ location: token.location, value: token.repairedValue });
			}
			if (token.unicode !== undefined) token.invalidUnicode = true;
			if (token.invalidUnicode) {
				if (token.location) this.removeValue(token.location);
				this.previewInvalid = true;
				return;
			}
			if (token.invalidEscape) {
				// partial-json retains the already-complete surrounding structure but
				// rejects this malformed member. At a fully closed root repairJson
				// would expose it as a literal backslash, so defer that restoration.
				if (token.location) {
					this.removeValue(token.location);
					this.repairedStringsAtRootClose.push({ location: token.location, value: token.repairedValue });
				}
			}
			if (token.target === "key") {
				const frame = this.frames.at(-1);
				if (frame?.kind === "object") {
					frame.key = token.invalidEscape ? token.repairedValue : token.value;
					frame.expecting = "colon";
				}
			} else {
				this.valueComplete();
				if (this.frames.length === 0) this.rootComplete = true;
			}
			return;
		}
		if (char === "\u2028" || char === "\u2029") {
			// partial-json only exposes these separators after the next character.
			token.repairedValue += char;
			token.value += char;
			return;
		}
		if (char.charCodeAt(0) < 0x20) {
			// partial-json retains the prefix for whitespace controls, but rejects
			// other raw controls immediately. Any following character makes the
			// incomplete string invalid until repair can run on a closed root.
			token.rawControl = true;
			token.repairedValue += char;
			if (char.charCodeAt(0) < 0x09 || char.charCodeAt(0) > 0x0d) this.previewInvalid = true;
			else this.updateStringPreview(token);
			return;
		}
		token.repairedValue += char;
		if (!token.invalidEscape) token.value += char;
		if (token.rawControl) this.previewInvalid = true;
		else this.updateStringPreview(token);
	}
	private beginValue(value: unknown): void {
		const frame = this.frames.at(-1);
		if (!frame) {
			this.root = value;
			this.hasRoot = true;
			return;
		}
		if (frame.kind === "array") (frame.value as unknown[]).push(value);
		else if (frame.key !== undefined) (frame.value as Record<string, unknown>)[frame.key] = value;
		frame.expecting = "comma";
	}

	private valueComplete(): void {
		const frame = this.frames.at(-1);
		if (frame) frame.expecting = "comma";
	}

	private updateStringPreview(token: StringToken): void {
		if (token.target === "value") this.replaceCurrentValue(token.value);
	}

	private updateScalarPreview(): void {
		const token = this.scalarToken!;
		const preview = this.previewScalar(token.value);
		if (preview === undefined) this.removeValue(token.location);
		else this.setValue(token.location, preview);
	}

	private replaceCurrentValue(value: unknown): void {
		const frame = this.frames.at(-1);
		if (!frame) this.root = value;
		else if (frame.kind === "array") {
			const values = frame.value as unknown[];
			values[values.length - 1] = value;
		} else if (frame.key !== undefined) {
			(frame.value as Record<string, unknown>)[frame.key] = value;
		}
	}

	private currentValueLocation(): ValueLocation {
		const frame = this.frames.at(-1);
		if (!frame) return { root: true };
		if (frame.kind === "array") return { frame, arrayIndex: (frame.value as unknown[]).length, root: false };
		return { frame, key: frame.key, root: false };
	}

	private setValue(location: ValueLocation, value: unknown): void {
		if (location.root) this.root = value;
		else if (location.frame?.kind === "array" && location.arrayIndex !== undefined)
			(location.frame.value as unknown[])[location.arrayIndex] = value;
		else if (location.frame?.kind === "object" && location.key !== undefined)
			(location.frame.value as Record<string, unknown>)[location.key] = value;
	}

	private removeValue(location: ValueLocation): void {
		if (location.root) this.root = {};
		else if (location.frame?.kind === "array" && location.arrayIndex !== undefined) {
			const values = location.frame.value as unknown[];
			if (values.length === location.arrayIndex + 1) values.pop();
			else values[location.arrayIndex] = undefined;
		} else if (location.frame?.kind === "object" && location.key !== undefined) {
			delete (location.frame.value as Record<string, unknown>)[location.key];
		}
	}

	private finishScalar(): void {
		if (!this.scalarToken) return;
		this.updateScalarPreview();
		this.scalarToken = undefined;
		this.valueComplete();
		if (this.frames.length === 0) this.rootComplete = true;
	}

	private previewScalar(value: string): unknown | undefined {
		if (value === "true" || value === "t" || value === "tr" || value === "tru") return true;
		if (value === "false" || value === "f" || value === "fa" || value === "fal" || value === "fals") return false;
		if (value === "null" || value === "n" || value === "nu" || value === "nul") return null;
		// This accepts only the JSON number grammar. An unfinished exponent is
		// represented by its completed mantissa, matching the legacy preview.
		if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
		const exponent = value.search(/[eE]/);
		if (exponent > 0 && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.slice(0, exponent))) {
			return Number(value.slice(0, exponent));
		}
		return undefined;
	}
}

function isWhitespace(char: string): boolean {
	return char === " " || char === "\n" || char === "\r" || char === "\t";
}

export function createStreamingJsonParseState<T = Record<string, unknown>>(): StreamingJsonParseState<T> {
	return new IncrementalStreamingJsonParseState<T>();
}

/** Internal test seam; production callers should use the public interface. */
export function getStreamingJsonStrictValidationCountForTesting(state: StreamingJsonParseState<unknown>): number {
	return (state as IncrementalStreamingJsonParseState<unknown>).getStrictValidationCountForTesting();
}

/** Internal provider seam; never serialize this raw value. */
export function getStreamingJsonRawForProviderCheck(state: StreamingJsonParseState<unknown>): string {
	return (state as IncrementalStreamingJsonParseState<unknown>).getRawForProviderCheck();
}

/** Internal test seam for linear-work assertions. */
export function getStreamingJsonInputExaminedForTesting(state: StreamingJsonParseState<unknown>): {
	incremental: number;
	final: number;
	total: number;
} {
	return (state as IncrementalStreamingJsonParseState<unknown>).getInputExaminedForTesting();
}

/** Internal lifecycle seam: erase the private final buffer on every abort/error path. */
export function discardStreamingJsonParseState(state: StreamingJsonParseState<unknown>): void {
	(state as IncrementalStreamingJsonParseState<unknown>).discard();
}
