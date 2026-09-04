import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";

describe("OutputAccumulator temp spill", () => {
	let realTmp: string | undefined;
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-accumulator-"));
		realTmp = process.env.TMPDIR;
	});

	afterEach(() => {
		if (realTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = realTmp;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("degrades to the in-memory tail when the spill stream cannot open", async () => {
		process.env.TMPDIR = join(scratch, "does-not-exist");
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		// Let the failed open surface its (handled) error before reading results.
		await new Promise((resolve) => setTimeout(resolve, 25));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});
});
