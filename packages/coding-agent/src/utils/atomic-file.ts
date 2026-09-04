import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const WIN32_RENAME_ATTEMPTS = 5;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows raises transient EPERM/EACCES when the destination is held open (antivirus, indexer).
function renameOntoSync(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (
				process.platform !== "win32" ||
				(code !== "EPERM" && code !== "EACCES") ||
				attempt >= WIN32_RENAME_ATTEMPTS
			) {
				throw error;
			}
			sleepSync(10 * attempt);
		}
	}
}

export interface WriteFileAtomicOptions {
	mode?: number;
	/** fsync the temp file before the rename. */
	fsync?: boolean;
	/** Best-effort directory fsync after the rename. */
	fsyncDir?: boolean;
	/** Runs on the written temp file before it replaces the destination (validation, ownership). */
	beforeRename?: (tempPath: string) => void;
}

/** Durable-write owner: temp file beside the destination, then an atomic rename. */
export function writeFileAtomicSync(path: string, data: string, options: WriteFileAtomicOptions = {}): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const descriptor = options.mode === undefined ? openSync(tempPath, "wx") : openSync(tempPath, "wx", options.mode);
		try {
			// writeSync may return a short count without throwing; a partial temp must never be renamed in.
			const bytes = Buffer.from(data, "utf8");
			let offset = 0;
			while (offset < bytes.length) {
				const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
				if (written <= 0) throw new Error(`Short write persisting ${path}`);
				offset += written;
			}
			if (options.fsync) fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		// openSync's mode is masked by the umask; enforce the requested bits exactly.
		if (options.mode !== undefined) chmodSync(tempPath, options.mode);
		options.beforeRename?.(tempPath);
		renameOntoSync(tempPath, path);
	} finally {
		rmSync(tempPath, { force: true });
	}
	if (options.fsyncDir) {
		try {
			const directoryDescriptor = openSync(dirname(path), "r");
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			// Unavailable on some platforms; the atomic rename still protects readers.
		}
	}
}
