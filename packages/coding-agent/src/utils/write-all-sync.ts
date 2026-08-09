import { writeSync } from "node:fs";

export type SyncBufferWriter = (
	descriptor: number,
	buffer: Uint8Array,
	offset: number,
	length: number,
	position: number | null,
) => number;

const nodeWriteSync: SyncBufferWriter = (descriptor, buffer, offset, length, position) =>
	writeSync(descriptor, buffer, offset, length, position);

/**
 * Write an entire byte buffer before returning. `fs.writeSync()` may report a
 * short write without throwing, so callers that establish a durable boundary
 * must advance by the reported count until all bytes have been accepted.
 */
export function writeAllSync(
	descriptor: number,
	data: Uint8Array,
	writer: SyncBufferWriter = nodeWriteSync,
): void {
	let offset = 0;
	while (offset < data.byteLength) {
		const remaining = data.byteLength - offset;
		const written = writer(descriptor, data, offset, remaining, null);
		if (!Number.isInteger(written) || written <= 0 || written > remaining) {
			throw new Error(
				`Synchronous write reported an invalid byte count ${String(written)} with ${remaining} bytes remaining`,
			);
		}
		offset += written;
	}
}
