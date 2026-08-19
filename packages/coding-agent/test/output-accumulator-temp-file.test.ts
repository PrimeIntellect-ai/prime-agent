import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "../src/core/tools/output-accumulator.js";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.js";

const UNWRITABLE_TMPDIR = "/prime-agent-nonexistent-tmpdir-for-tests";

function largeMultiLineOutput(fill: string): string {
	const line = fill.repeat(1024);
	const lineCount = Math.ceil((DEFAULT_MAX_BYTES + 4096) / (line.length + 1));
	return `${Array.from({ length: lineCount }, () => line).join("\n")}\n`;
}

describe("OutputAccumulator temp file failures", () => {
	let originalTmpdir: string | undefined;

	beforeEach(() => {
		originalTmpdir = process.env.TMPDIR;
		process.env.TMPDIR = UNWRITABLE_TMPDIR;
	});

	afterEach(() => {
		if (originalTmpdir === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = originalTmpdir;
		}
	});

	// createWriteStream reports an open failure asynchronously. Without an "error"
	// listener that is an unhandled error event and the process is terminated, so
	// this test only survives if the accumulator handles it.
	it("keeps producing output when the temp file cannot be opened", async () => {
		const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-output-test" });
		accumulator.append(Buffer.from(largeMultiLineOutput("A")));
		accumulator.finish();

		const snapshot = accumulator.snapshot({ persistIfTruncated: true });

		// Let the deferred "error" event fire before asserting.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(snapshot.truncation.truncated).toBe(true);
		expect(snapshot.content.length).toBeGreaterThan(0);
		await expect(accumulator.closeTempFile()).resolves.toBeUndefined();
	});

	it("does not advertise a full-output path once the temp file failed", async () => {
		const accumulator = new OutputAccumulator({ tempFilePrefix: "pi-output-test" });
		accumulator.append(Buffer.from(largeMultiLineOutput("B")));
		accumulator.finish();
		accumulator.snapshot({ persistIfTruncated: true });

		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(accumulator.snapshot({ persistIfTruncated: true }).fullOutputPath).toBeUndefined();
	});
});
