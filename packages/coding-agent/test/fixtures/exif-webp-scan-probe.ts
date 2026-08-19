/**
 * Runs applyExifOrientation against a WebP whose RIFF chunk size decodes negative
 * under a signed shift. Lives in a child process because a regression is an
 * unbreakable synchronous loop, which no in-process timeout can interrupt.
 *
 * Reads the chunk-size bytes as four comma-separated decimals in argv[2].
 */
import { applyExifOrientation } from "../../src/utils/exif-orientation.js";

const sizeBytes = (process.argv[2] ?? "").split(",").map((part) => Number.parseInt(part, 10));
if (sizeBytes.length !== 4 || sizeBytes.some((byte) => !Number.isInteger(byte))) {
	throw new Error("usage: exif-webp-scan-probe.ts <b0,b1,b2,b3>");
}

const bytes = Buffer.alloc(12 + 8 + 16);
bytes.write("RIFF", 0);
bytes.writeUInt32LE(bytes.length - 8, 4);
bytes.write("WEBP", 8);
bytes.write("VP8 ", 12);
Buffer.from(sizeBytes).copy(bytes, 16);

const sentinel = { sentinel: true };
const result = applyExifOrientation(
	undefined as never,
	sentinel as never,
	new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
);

process.stdout.write(result === (sentinel as never) ? "ORIENTATION_DEFAULTED\n" : "UNEXPECTED_RESULT\n");
