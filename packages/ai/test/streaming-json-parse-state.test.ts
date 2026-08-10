import { describe, expect, it } from "vitest";
import {
	createStreamingJsonParseState,
	getStreamingJsonInputExaminedForTesting,
	getStreamingJsonStrictValidationCountForTesting,
	parseStreamingJson,
} from "../src/utils/json-parse.js";

function chunks(input: string, sizes: number[]): string[] {
	const result: string[] = [];
	let offset = 0;
	let step = 0;
	while (offset < input.length) {
		const size = sizes[step++ % sizes.length];
		result.push(input.slice(offset, offset + size));
		offset += size;
	}
	return result;
}

function expectLegacyParityAtEveryPrefix(document: string, finalValue?: unknown): void {
	const state = createStreamingJsonParseState<Record<string, unknown>>();
	for (let end = 1; end <= document.length; end++) {
		const prefix = document.slice(0, end);
		expect(state.append(document.slice(end - 1, end))).toEqual(parseStreamingJson(prefix));
		expect(state.preview()).toEqual(parseStreamingJson(prefix));
	}
	if (finalValue === undefined) expect(() => state.finalize()).toThrow();
	else expect(state.finalize()).toEqual(finalValue);
	expect(getStreamingJsonStrictValidationCountForTesting(state)).toBe(1);
}

describe("incremental streaming JSON parse state", () => {
	it("matches legacy previews and strictly validates exactly once", () => {
		const document = JSON.stringify({ empty: {}, array: [true, null, { nested: [1, 2, "ok"] }], number: -12.5e2 });
		const state = createStreamingJsonParseState<Record<string, unknown>>();
		let prefix = "";
		for (const chunk of chunks(document, [1, 7, 31])) {
			prefix += chunk;
			expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
			expect(state.preview()).toEqual(parseStreamingJson(prefix));
		}
		expect(state.finalize()).toEqual(JSON.parse(document));
		expect(getStreamingJsonStrictValidationCountForTesting(state)).toBe(1);
		expect(() => state.finalize()).toThrow();
		expect(() => state.append(" ")).toThrow();
	});

	it("matches every prefix of a deterministic representative valid nested corpus", () => {
		const document =
			'{"outer":[{"empty":{},"array":[true,false,null,{"number":-12.5e2}],"escaped":"\\"\\\\\\/\\b\\f\\n\\r\\t","unicode":"\\uD83D\\uDE00","literal":"é😀é"}],"tail":{"ok":true}}';
		const emoji = document.indexOf("😀");
		expect(document.charCodeAt(emoji)).toBeGreaterThanOrEqual(0xd800);
		expect(document.charCodeAt(emoji + 1)).toBeLessThanOrEqual(0xdfff);
		expectLegacyParityAtEveryPrefix(document, JSON.parse(document));
	});

	it("preserves literal unicode, surrogate, and escape chunk boundaries", () => {
		const document = '{"literal":"é😀\\u2028\\u2029","decomposed":"é","escaped":"\\uD83D\\uDE00"}';
		const split = document.indexOf("😀") + 1;
		const pieces = [
			document.slice(0, split),
			document.slice(split, split + 1),
			...chunks(document.slice(split + 1), [1, 2, 7]),
		];
		const state = createStreamingJsonParseState<Record<string, unknown>>();
		let prefix = "";
		for (const chunk of pieces) {
			prefix += chunk;
			expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
		}
		expect(state.finalize()).toEqual(JSON.parse(document));
	});

	it("keeps malformed, nesting, and truncation input non-authoritative", () => {
		for (const document of ['{"a":"\\u12', '{"a":[1,2}', '{"a":1} junk', '{"a":"raw\ncontrol"}', '{"a":1e}']) {
			const state = createStreamingJsonParseState<Record<string, unknown>>();
			let prefix = "";
			for (const chunk of chunks(document, [1, 7])) {
				prefix += chunk;
				expect(state.append(chunk)).toEqual(parseStreamingJson(prefix));
			}
			expect(() => state.finalize()).toThrow();
			expect(getStreamingJsonStrictValidationCountForTesting(state)).toBe(1);
		}
	});

	it("keeps unknown escapes and split Unicode boundaries legacy-compatible but rejects invalid finals", () => {
		const document = '{"literal":"😀","escaped":"\\uD83D\\uDE00","unknown":"\\q"}';
		const emoji = document.indexOf("😀");
		expect(document.slice(emoji, emoji + 2)).toBe("😀");
		expectLegacyParityAtEveryPrefix(document);
	});

	it("differentially matches legacy for every prefix of malformed structures", () => {
		const documents = [
			'{"unicode":"\\u12x"}',
			'{"raw-control":"x\ny"}',
			'{"nested":[{"x":1},]}',
			'{"number":1e+}',
			'{"junk":true} trailing',
			'{"unterminated": [1, {"x": "value',
		];
		for (const document of documents) expectLegacyParityAtEveryPrefix(document);
		expectLegacyParityAtEveryPrefix('{"line-separator":"x y"}', { "line-separator": "x y" });
	});

	it("accounts for only new input until its one strict terminal parse", () => {
		const document = JSON.stringify({ payload: "x".repeat(128 * 1024), nested: [{ ok: true }] });
		const state = createStreamingJsonParseState();
		for (const chunk of chunks(document, [1, 7, 31, 257])) state.append(chunk);
		expect(getStreamingJsonInputExaminedForTesting(state)).toEqual({
			incremental: document.length,
			final: 0,
			total: document.length,
		});
		state.finalize();
		expect(getStreamingJsonInputExaminedForTesting(state)).toEqual({
			incremental: document.length,
			final: document.length,
			total: document.length * 2,
		});
	});

	it("handles depth 64 incrementally", () => {
		let value: unknown = { leaf: "value" };
		for (let index = 0; index < 64; index++) value = { index, value };
		const document = JSON.stringify(value);
		const state = createStreamingJsonParseState();
		for (const chunk of chunks(document, [257])) state.append(chunk);
		expect(state.finalize()).toEqual(JSON.parse(document));
	});
});
