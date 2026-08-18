import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface ControlledStream {
	release: () => void;
}

const fsMocks = vi.hoisted(() => ({
	createReadStream: vi.fn(),
	streams: [] as ControlledStream[],
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: fsMocks.createReadStream,
	};
});

const { readSessionInfo } = await import("../src/core/session-manager.js");

describe("session info scanning", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "session-info-scan-"));
		fsMocks.streams.length = 0;
		fsMocks.createReadStream.mockImplementation((path: string, options?: { end?: number }) => {
			const contents = readFileSync(path);
			let release: (() => void) | undefined;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			fsMocks.streams.push({ release: () => release?.() });
			return Readable.from(
				(async function* () {
					await gate;
					yield contents.subarray(0, options?.end === undefined ? contents.length : options.end + 1);
				})(),
			);
		});
	});

	afterEach(() => {
		for (const stream of fsMocks.streams) stream.release();
		fsMocks.createReadStream.mockReset();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("coalesces concurrent scans of the same snapshot and bounds the stream", async () => {
		const file = writeSessionFile(tempDir, "coalesced");
		const snapshotSize = statSync(file).size;
		const scans = Array.from({ length: 20 }, () => readSessionInfo(file));

		await waitForStreamCount(1);
		expect(fsMocks.createReadStream).toHaveBeenCalledOnce();
		expect(fsMocks.createReadStream).toHaveBeenCalledWith(file, { end: snapshotSize - 1 });

		fsMocks.streams[0]?.release();
		const results = await Promise.all(scans);
		expect(results.every((result) => result?.id === "coalesced")).toBe(true);
		expect(fsMocks.createReadStream).toHaveBeenCalledOnce();
	});

	it("queues a follow-up scan when the file changes during an active scan", async () => {
		const file = writeSessionFile(tempDir, "updated");
		const first = readSessionInfo(file);
		await waitForStreamCount(1);

		appendFileSync(
			file,
			`${JSON.stringify({
				type: "session_state",
				id: "state",
				parentId: null,
				timestamp: "2026-01-01T00:00:01.000Z",
				state: { status: "active" },
			})}\n`,
		);
		const second = readSessionInfo(file);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(fsMocks.createReadStream).toHaveBeenCalledOnce();

		fsMocks.streams[0]?.release();
		await waitForStreamCount(2);
		fsMocks.streams[1]?.release();

		expect((await first)?.state).toBeUndefined();
		expect((await second)?.state).toEqual({ status: "active" });
	});
});

function writeSessionFile(directory: string, id: string): string {
	const file = join(directory, `${id}.jsonl`);
	writeFileSync(
		file,
		`${JSON.stringify({
			type: "session",
			id,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: directory,
		})}\n`,
	);
	return file;
}

async function waitForStreamCount(expected: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (fsMocks.streams.length >= expected) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Expected ${expected} controlled streams, got ${fsMocks.streams.length}`);
}
