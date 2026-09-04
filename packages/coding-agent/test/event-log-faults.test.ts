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

	it("fails the append on a short write, leaving a repairable torn tail", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, id: "committed" }]);
		faults.shortWriteOnce = true;

		// Neither completed (could weld into a rival's append) nor reclaimed
		// (could destroy a rival's committed record): the torn tail is the one
		// tolerated shape, and the next append repairs it.
		expect(() => log.appendSync([{ v: 1, id: "short-write" }])).toThrow(/short write/);
		const parse = (line: string) => JSON.parse(line) as { id?: string };
		expect(new EventLog(path).replaySync(parse)).toEqual([{ v: 1, id: "committed" }]);
		log.appendSync([{ v: 1, id: "next" }]);
		expect(new EventLog(path).replaySync(parse)).toEqual([
			{ v: 1, id: "committed" },
			{ v: 1, id: "next" },
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
