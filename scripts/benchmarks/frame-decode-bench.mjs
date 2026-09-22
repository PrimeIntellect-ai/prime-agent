/**
 * Private-frame decode benchmark: one multi-MB frame with a snapshot-chunk
 * routing header, delivered in small socket-size chunks through
 * PrivateFrameDecoder - the wire shape of the multi-MB snapshot and response
 * frames on the daemon-worker and peer transport channels, where chunked
 * delivery made the old per-read concatenation quadratic.
 *
 * Runs against the prepared source build, so the same trusted harness measures
 * main and the PR head. Prints one RESULT line with the decode seconds; the
 * benchmark worker records it as the frame_decode metric.
 *
 * Usage: node frame-decode-bench.mjs --dist <packages/coding-agent dist>
 */
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PAYLOAD_BYTES = 32 * 1024 * 1024;
const WARMUP_BYTES = 256 * 1024;
/** Matches the 8 KiB socket reads observed on the profiled channels. */
const CHUNK_BYTES = 8 * 1024;

function parseArgs(argv) {
	const args = { dist: "" };
	for (let index = 2; index < argv.length; index++) {
		if (argv[index] === "--dist" && argv[index + 1]) {
			args.dist = argv[index + 1];
			index++;
		}
	}
	if (!args.dist) {
		throw new Error("usage: node frame-decode-bench.mjs --dist <coding-agent dist>");
	}
	return args;
}

async function main() {
	const { dist } = parseArgs(process.argv);
	const { encodePrivateFrame, PrivateFrameDecoder } = await import(
		pathToFileURL(join(dist, "modes", "session-worker", "private-framing.js")).href
	);
	const validateHeader = (value) =>
		typeof value === "object" &&
		value !== null &&
		value.kind === "outbound" &&
		typeof value.outboundType === "string" &&
		value.snapshotPurpose === "replacement";
	const header = {
		kind: "outbound",
		outboundType: "session_snapshot_chunk",
		requestId: "bench-frame-decode",
		snapshotId: "bench-frame-decode",
		snapshotPurpose: "replacement",
	};
	const decoder = new PrivateFrameDecoder(validateHeader);

	// Frames are built before the timer: the metric is the chunked decode loop
	// only, not the encoding's allocations and copies.
	const buildFrame = (payloadBytes) => encodePrivateFrame(header, Buffer.alloc(payloadBytes, 7));

	const decode = (frame, payloadBytes) => {
		const decoded = [];
		for (let offset = 0; offset < frame.length; offset += CHUNK_BYTES) {
			decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + CHUNK_BYTES, frame.length))));
		}
		if (decoded.length !== 1) {
			throw new Error(`expected one decoded frame, got ${decoded.length}`);
		}
		const payload = decoded[0].payload;
		if (
			payload.length !== payloadBytes ||
			payload[payload.length - 1] !== 7 ||
			!validateHeader(decoded[0].header) ||
			decoded[0].header.snapshotId !== header.snapshotId ||
			decoder.bufferedBytes !== 0
		) {
			throw new Error("decoded frame does not match the encoded frame");
		}
		return decoded[0];
	};

	decode(buildFrame(WARMUP_BYTES), WARMUP_BYTES);
	const frame = buildFrame(PAYLOAD_BYTES);
	const started = performance.now();
	decode(frame, PAYLOAD_BYTES);
	const seconds = (performance.now() - started) / 1000;
	decoder.finish();
	process.stdout.write(
		`RESULT ${JSON.stringify({ value: seconds, payload_bytes: PAYLOAD_BYTES, chunk_bytes: CHUNK_BYTES })}\n`
	);
}

main().catch((error) => {
	process.stderr.write(`frame-decode-bench failed: ${error?.stack ?? error}\n`);
	process.exit(1);
});
