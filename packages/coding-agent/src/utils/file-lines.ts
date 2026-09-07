import { closeSync, createReadStream, openSync, readSync } from "node:fs";

export function readFirstLineSync(filePath: string, maxBytes = 64 * 1024): string | undefined {
	const fd = openSync(filePath, "r");
	const chunks: Buffer[] = [];
	let position = 0;

	try {
		const buffer = Buffer.alloc(1024);
		while (position < maxBytes) {
			const bytesToRead = Math.min(buffer.length, maxBytes - position);
			const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
			if (bytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, bytesRead);
			const newlineIndex = chunk.indexOf(0x0a);
			if (newlineIndex !== -1) {
				chunks.push(Buffer.from(chunk.subarray(0, newlineIndex)));
				return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
			}

			chunks.push(Buffer.from(chunk));
			position += bytesRead;
		}
	} finally {
		closeSync(fd);
	}

	if (chunks.length === 0) {
		return undefined;
	}
	return Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
}

/** Read the bytes in [start, endExclusive), stopping early at EOF. */
export function readBytesSync(filePath: string, start: number, endExclusive: number): Buffer {
	const length = Math.max(0, endExclusive - start);
	const buffer = Buffer.alloc(length);
	const fd = openSync(filePath, "r");
	try {
		let offset = 0;
		while (offset < length) {
			const bytesRead = readSync(fd, buffer, offset, length - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		return buffer.subarray(0, offset);
	} finally {
		closeSync(fd);
	}
}

export interface ReadLinesRange {
	start?: number;
	/** Inclusive, as in createReadStream: bounds the read to a stat() snapshot so a growing file cannot extend the scan. */
	end?: number;
}

export async function* readLinesAsBuffers(filePath: string, range?: ReadLinesRange): AsyncGenerator<Buffer> {
	const pendingParts: Buffer[] = [];
	let pendingBytes = 0;
	for await (const chunk of createReadStream(filePath, range)) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		let start = 0;
		while (start < buffer.length) {
			const end = buffer.indexOf(0x0a, start);
			if (end === -1) {
				const part = buffer.subarray(start);
				pendingParts.push(part);
				pendingBytes += part.length;
				break;
			}
			if (pendingParts.length > 0) {
				const part = buffer.subarray(start, end);
				pendingParts.push(part);
				const line = Buffer.concat(pendingParts, pendingBytes + part.length);
				pendingParts.length = 0;
				pendingBytes = 0;
				yield line;
			} else {
				yield buffer.subarray(start, end);
			}
			start = end + 1;
		}
	}
	if (pendingParts.length > 0) {
		const line = Buffer.concat(pendingParts, pendingBytes);
		pendingParts.length = 0;
		pendingBytes = 0;
		yield line;
	}
}
