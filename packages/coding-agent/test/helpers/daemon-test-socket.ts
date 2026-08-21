import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a unique IPC endpoint that Node can listen on for the current platform. */
export function daemonTestSocketPath(prefix: string): string {
	const name = `${prefix}-${process.pid}-${randomUUID().slice(0, 8)}`;
	return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}
