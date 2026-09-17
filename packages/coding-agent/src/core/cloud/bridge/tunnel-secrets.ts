import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Durable secret store for tunnel attachments.
 *
 * The cloud-session record intentionally carries no secrets. The bridge
 * protocol token and the tunnel's one-time edge basic-auth password live here
 * instead: one JSON file per session, written atomically with fsync at mode
 * 0600 inside a 0700 directory, and read back with strict validation. Files
 * are removed when the tunnel is released or the delegation is cleaned up.
 *
 * Like every other store in this package the directory is injected, nothing is
 * read from globals, and the values never appear in error messages.
 */

const SECRET_FILE_VERSION = 1;
const MAX_SECRET_FILE_BYTES = 65_536;
const TOKEN_PATTERN = /^\S{16,256}$/;
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface CloudTunnelSecrets {
	/** Protocol authentication token checked by the guest bridge on hello. */
	bridgeToken: string;
	/** One-time edge basic-auth password from the tunnel create response. */
	httpPassword: string;
}

export type CloudTunnelSecretStoreErrorCode = "invalid" | "corrupt";

export class CloudTunnelSecretStoreError extends Error {
	readonly code: CloudTunnelSecretStoreErrorCode;

	constructor(code: CloudTunnelSecretStoreErrorCode, message: string, properties: { cause?: unknown } = {}) {
		super(message, properties.cause === undefined ? undefined : { cause: properties.cause });
		this.name = "CloudTunnelSecretStoreError";
		this.code = code;
	}
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicWrite(path: string, contents: string): void {
	const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, contents);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	fsyncDirectory(join(path, ".."));
}

export class CloudTunnelSecretStore {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = directory;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}

	save(sessionId: string, secrets: CloudTunnelSecrets): void {
		assertSessionId(sessionId);
		validateSecrets(secrets);
		atomicWrite(
			this.pathFor(sessionId),
			`${JSON.stringify({ version: SECRET_FILE_VERSION, ...secrets })}
`,
		);
	}

	get(sessionId: string): CloudTunnelSecrets | undefined {
		assertSessionId(sessionId);
		const path = this.pathFor(sessionId);
		if (!existsSync(path)) return undefined;
		if (statSync(path).size > MAX_SECRET_FILE_BYTES) {
			throw new CloudTunnelSecretStoreError("corrupt", `tunnel secret file is too large: ${sessionId}`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			throw new CloudTunnelSecretStoreError("corrupt", `tunnel secret file is corrupt: ${sessionId}`, {
				cause: error,
			});
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			(parsed as Record<string, unknown>).version !== SECRET_FILE_VERSION ||
			typeof (parsed as Record<string, unknown>).bridgeToken !== "string" ||
			typeof (parsed as Record<string, unknown>).httpPassword !== "string"
		) {
			throw new CloudTunnelSecretStoreError("corrupt", `tunnel secret file is corrupt: ${sessionId}`);
		}
		const secrets: CloudTunnelSecrets = {
			bridgeToken: (parsed as Record<string, string>).bridgeToken,
			httpPassword: (parsed as Record<string, string>).httpPassword,
		};
		validateSecrets(secrets);
		return secrets;
	}

	delete(sessionId: string): void {
		assertSessionId(sessionId);
		rmSync(this.pathFor(sessionId), { force: true });
	}

	private pathFor(sessionId: string): string {
		return join(this.directory, `${sessionId}.json`);
	}
}

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID_PATTERN.test(sessionId)) {
		throw new CloudTunnelSecretStoreError("invalid", "invalid cloud session id for tunnel secrets");
	}
}

function validateSecrets(secrets: CloudTunnelSecrets): void {
	if (!TOKEN_PATTERN.test(secrets.bridgeToken) || !TOKEN_PATTERN.test(secrets.httpPassword)) {
		throw new CloudTunnelSecretStoreError("invalid", "tunnel secrets must be bounded URL-safe tokens");
	}
}
