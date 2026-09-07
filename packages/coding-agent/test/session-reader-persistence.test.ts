import type * as FsModule from "node:fs";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ target: "", streams: 0 }));
const __fs = createRequire(import.meta.url)("node:fs") as typeof FsModule;
vi.mock("node:fs", () => {
	const actual = __fs;
	return {
		...actual,
		createReadStream: ((...args: Parameters<typeof actual.createReadStream>) => {
			if (String(args[0]) === io.target) io.streams++;
			return actual.createReadStream(...args);
		}) as typeof actual.createReadStream,
	};
});

import { exportFromFile } from "../src/core/export-html/index.js";
import { readSessionInfo } from "../src/core/session-manager.js";

const header = { type: "session", version: 3, id: "export-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp" };
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};
const assistant = {
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "kept" }],
	api: "anthropic-messages" as const,
	provider: "anthropic",
	model: "test",
	stopReason: "stop" as const,
	timestamp: 1,
	usage,
};
const line = (entry: unknown) => `${JSON.stringify(entry)}\n`;
const initial = () =>
	line(header) + line({ type: "message", id: "a1", parentId: null, timestamp: header.timestamp, message: assistant });

describe("session catalog cache and standalone export", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "session-reader-"));
		io.target = "";
		io.streams = 0;
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("evicts an oversized usage map while keeping returned totals correct", async () => {
		const path = join(dir, "oversized.jsonl");
		const count = 100_001;
		const records = [line(header)];
		for (let i = 0; i < count; i++)
			records.push(
				line({
					type: "message",
					id: `m${i}`,
					parentId: i ? `m${i - 1}` : null,
					timestamp: header.timestamp,
					message: assistant,
				}),
			);
		writeFileSync(path, records.join(""));
		io.target = path;
		const first = await readSessionInfo(path);
		expect(first?.messageCount).toBe(count);
		expect(first?.usage).toEqual({ inputTokens: count, outputTokens: count * 2, cost: count * 3 });
		const firstStreams = io.streams;
		expect(firstStreams).toBeGreaterThan(0);
		const second = await readSessionInfo(path);
		expect(second?.usage).toEqual(first?.usage);
		expect(io.streams, "over-limit state should not survive as a warm cache hit").toBeGreaterThan(firstStreams);
		appendFileSync(
			path,
			line({
				type: "message",
				id: "late",
				parentId: `m${count - 1}`,
				timestamp: header.timestamp,
				message: assistant,
			}),
		);
		const appended = await readSessionInfo(path);
		expect(appended?.messageCount).toBe(count + 1);
		expect(appended?.usage).toEqual({ inputTokens: count + 1, outputTokens: (count + 1) * 2, cost: (count + 1) * 3 });
	});

	it.each([2, 3])(
		"exports a damaged version %s transcript through a symlink without changing the input",
		async (version) => {
			const path = join(dir, "damaged.jsonl");
			const original = `${initial().replace('"version":3', `"version":${version}`)}{"type":"message","id":"torn`;
			writeFileSync(path, original);
			const alias = join(dir, "alias.jsonl");
			symlinkSync(path, alias);
			const output = join(dir, "export.html");
			await exportFromFile(alias, { outputPath: output });
			expect(lstatSync(alias).isSymbolicLink()).toBe(true);
			expect(existsSync(output)).toBe(true);
			const html = readFileSync(output, "utf8");
			const encoded = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
			expect(encoded).toBeDefined();
			const data = JSON.parse(Buffer.from(encoded!, "base64").toString("utf8"));
			expect(data.header.id).toBe("export-session");
			expect(data.entries).toHaveLength(1);
			expect(data.entries[0].message.content[0].text).toBe("kept");
			expect(data.leafId).toBe(data.entries[0].id);
			expect(readFileSync(path, "utf8"), "standalone export must not repair its input").toBe(original);
		},
	);
});
