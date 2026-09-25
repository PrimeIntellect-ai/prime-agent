import { describe, expect, it } from "vitest";
import { parseStreamingJson, StreamingJsonAccumulator } from "../src/utils/json-parse.js";

describe("StreamingJsonAccumulator", () => {
	it("keeps an exact live parse while the buffer is small", () => {
		const acc = new StreamingJsonAccumulator();
		expect(acc.flush()).toBeUndefined();
		const text = '{"command":"say \\"hi\\"","note":"bad \\q escape","multi":"line\nbreak"}';
		for (const char of text) {
			const preview = acc.append(char);
			expect(preview).toEqual(parseStreamingJson(acc.text));
		}
	});

	it("throttles large buffers to linear parse work and flushes the tail", () => {
		const acc = new StreamingJsonAccumulator();
		const payload = `{"content":"${"x".repeat(256 * 1024)}"}`;
		let lastParsedLength = 0;
		let parses = 0;
		for (let offset = 0; offset < payload.length; offset += 16) {
			const preview = acc.append(payload.slice(offset, offset + 16));
			if (preview === undefined) {
				expect(acc.text.length - lastParsedLength).toBeLessThan(lastParsedLength / 16 + 1);
				continue;
			}
			parses++;
			lastParsedLength = acc.text.length;
		}
		expect(parses).toBeLessThan(700);
		expect(acc.flush()).toEqual(parseStreamingJson(acc.text));
		expect(acc.flush()).toBeUndefined();
	});
});
