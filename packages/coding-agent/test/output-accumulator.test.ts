import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	// The open error lands while the close is waiting: degraded spill, not a tool failure.
	it.each([
		["a missing TMPDIR (ENOENT)", (dir: string) => join(dir, "does-not-exist")],
		[
			"a TMPDIR that is a file (ENOTDIR, so cleanup fails too)",
			(dir: string) => {
				const blocker = join(dir, "not-a-dir");
				writeFileSync(blocker, "x");
				return blocker;
			},
		],
	])("degrades a failed spill to the in-memory tail with %s", async (_label, makeTmpdir) => {
		process.env.TMPDIR = makeTmpdir(scratch);
		const accumulator = new OutputAccumulator({ maxBytes: 8, maxLines: 100 });
		accumulator.append(Buffer.from("0123456789abcdef\n"));
		accumulator.append(Buffer.from("tail\n"));
		accumulator.finish();

		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
		const snapshot = accumulator.snapshot();
		expect(snapshot.fullOutputPath).toBeUndefined();
		expect(snapshot.content).toContain("tail");
	});
});
