import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROBE = fileURLToPath(new URL("./fixtures/exif-webp-scan-probe.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));

function runProbe(sizeBytes: readonly number[]): { status: number | null; stdout: string } {
	const probe = spawnSync(process.execPath, [TSX, PROBE, sizeBytes.join(",")], {
		encoding: "utf8",
		timeout: 20_000,
	});
	return { status: probe.status, stdout: probe.stdout ?? "" };
}

describe("WebP EXIF chunk scanning", () => {
	// RIFF chunk sizes are unsigned, but the scan built them with a signed `<< 24`.
	// 0xFFFFFFF8 decoded as -8, so the next offset landed back on the current chunk
	// header and the scan looped forever on the main thread. The event loop is
	// blocked, so the agent cannot even be interrupted.
	it.each([
		["0xFFFFFFF8 decodes to -8", [0xf8, 0xff, 0xff, 0xff]],
		["0xFFFFFFF9 decodes to -7", [0xf9, 0xff, 0xff, 0xff]],
		["0x80000000 sets the sign bit", [0x00, 0x00, 0x00, 0x80]],
	])("terminates when a chunk size %s", (_label, sizeBytes) => {
		const probe = runProbe(sizeBytes);

		expect(probe.status).toBe(0);
		expect(probe.stdout.trim()).toBe("ORIENTATION_DEFAULTED");
	});

	it("still scans past a well-formed chunk", () => {
		const probe = runProbe([8, 0, 0, 0]);

		expect(probe.status).toBe(0);
		expect(probe.stdout.trim()).toBe("ORIENTATION_DEFAULTED");
	});
});
