import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog } from "../src/core/event-log.js";

describe("event log substrate", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-event-log-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("throws for an unserializable event before any byte reaches the log", () => {
		const log = new EventLog(join(dir, "log.jsonl"));
		log.appendSync([{ ok: 1 }]);
		const before = readFileSync(log.path, "utf8");
		expect(() => log.appendSync([{ ok: 2 }, undefined])).toThrow(TypeError);
		expect(readFileSync(log.path, "utf8")).toBe(before);
	});

	it("truncates an unterminated tail even when it parses as JSON, keeping strict replays clean", () => {
		const path = join(dir, "log.jsonl");
		const log = new EventLog(path);
		log.appendSync([{ v: 1, keep: true }]);
		// Tail rule: uncommitted append — see the EventLog module doc.
		writeFileSync(path, `${readFileSync(path, "utf8")}{"not":"a valid record"}`);
		expect(new EventLog(path).replaySync((line) => JSON.parse(line) as { v?: number })).toEqual([
			{ v: 1, keep: true },
		]);
		log.appendSync([{ v: 1, second: true }]);
		const strict = new EventLog(path).replaySync((line, index) => {
			const value = JSON.parse(line) as { v?: number };
			if (value.v !== 1) throw new Error(`invalid record on line ${index + 1}`);
			return value;
		});
		expect(strict).toEqual([
			{ v: 1, keep: true },
			{ v: 1, second: true },
		]);
	});

	it("fails closed on an oversized log through the descriptor without a full allocation", () => {
		const path = join(dir, "log.jsonl");
		writeFileSync(path, `${"x".repeat(64)}\n`.repeat(4));
		const log = new EventLog(path, { maxBytes: 100 });
		expect(() => log.replaySync((line) => line)).toThrow("bytes");
		expect(() => log.appendSync([{ v: 1 }])).toThrow("bytes");
	});
});
