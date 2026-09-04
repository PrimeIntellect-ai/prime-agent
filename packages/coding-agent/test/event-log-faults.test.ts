import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLog } from "../src/core/event-log.js";

/** Armable fs faults; everything passes through to the real fs by default. */
const faults: { shortWriteOnce?: boolean; truncateError?: Error } = {};

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeSync: ((fd: number, data: Uint8Array) => {
			if (faults.shortWriteOnce && data.length > 1) {
				faults.shortWriteOnce = false;
				return actual.writeSync(fd, data.subarray(0, Math.floor(data.length / 2)));
			}
			return actual.writeSync(fd, data);
		}) as typeof actual.writeSync,
		ftruncateSync: ((fd: number, len?: number) => {
			if (faults.truncateError) throw faults.truncateError;
			return actual.ftruncateSync(fd, len);
		}) as typeof actual.ftruncateSync,
	};
});

describe("event log fault injection", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-event-log-faults-"));
	});

	afterEach(() => {
		faults.shortWriteOnce = undefined;
		faults.truncateError = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	it("reclaims its torn prefix and fails the append on a short write", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, id: "committed" }]);
		const before = readFileSync(path, "utf8");
		faults.shortWriteOnce = true;

		// Completing the write could interleave with a rival process's append;
		// failing with a clean file is the only safe terminal state.
		expect(() => log.appendSync([{ v: 1, id: "short-write" }])).toThrow(/short write/);
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(new EventLog(path).replaySync((line) => JSON.parse(line) as { id?: string })).toEqual([
			{ v: 1, id: "committed" },
		]);
	});

	it("refuses to append through a tail it could not repair", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, id: "committed" }]);
		appendFileSync(path, '{"torn');
		const before = readFileSync(path, "utf8");

		faults.truncateError = new Error("EPERM: append-only file");
		// Writing through would weld the torn tail to the new record forever.
		expect(() => log.appendSync([{ v: 1, id: "next" }])).toThrow(/EPERM/);
		expect(readFileSync(path, "utf8")).toBe(before);
	});
});
