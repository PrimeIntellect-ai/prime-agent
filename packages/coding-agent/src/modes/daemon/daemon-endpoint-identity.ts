import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";

/**
 * Peer identity for the public daemon endpoint.
 *
 * Unix sockets inherit ownership from the filesystem (0700 directory, 0600
 * socket), so both sides already know the peer runs as the same user. Named
 * pipes on Windows carry no equivalent guarantee that this code can check, so
 * the client and the daemon prove to each other that they can read the same
 * owner-only secret file in the agent directory before any session data or
 * launch environment crosses the pipe. The proof is an HMAC over per-connection
 * nonces from both sides; the secret itself never travels over the endpoint.
 */

export const DAEMON_ENDPOINT_SECRET_FILE_NAME = "daemon-endpoint-secret";
export const DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV = "PRIME_AGENT_DAEMON_REQUIRE_ENDPOINT_IDENTITY";

const SECRET_BYTES = 32;
const NONCE_BYTES = 32;
const SECRET_PATTERN = /^[0-9a-f]{64}$/;
const PROOF_DOMAIN = "prime-agent.daemon.endpoint-identity.v1";
const SECRET_READ_ATTEMPTS = 20;

export type DaemonEndpointProofRole = "client" | "daemon";

/** True when both sides must verify each other before any command flows: always on Windows, opt-in elsewhere. */
export function daemonEndpointIdentityRequired(
	environment: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform === "win32") {
		return true;
	}
	const flag = (environment[DAEMON_REQUIRE_ENDPOINT_IDENTITY_ENV] ?? "").trim().toLowerCase();
	return flag === "1" || flag === "true" || flag === "yes";
}

export function daemonEndpointSecretPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, DAEMON_ENDPOINT_SECRET_FILE_NAME);
}

/**
 * Read the shared endpoint secret, creating it owner-only on first use.
 * Creation is exclusive (`wx`), so concurrent first users converge on one
 * value; a reader that observes the file before its single write lands retries
 * briefly instead of adopting a truncated secret.
 */
export function loadDaemonEndpointSecret(agentDir: string = getAgentDir()): string {
	const path = daemonEndpointSecretPath(agentDir);
	const existing = readDaemonEndpointSecret(path);
	if (existing) {
		return existing;
	}
	mkdirSync(agentDir, { recursive: true });
	const secret = randomBytes(SECRET_BYTES).toString("hex");
	try {
		writeFileSync(path, `${secret}\n`, { mode: 0o600, flag: "wx" });
		restrictSecretFile(path);
		return secret;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw error;
		}
	}
	for (let attempt = 0; attempt < SECRET_READ_ATTEMPTS; attempt++) {
		const raced = readDaemonEndpointSecret(path);
		if (raced) {
			return raced;
		}
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
	}
	throw new Error(`Daemon endpoint secret at ${path} is not readable or has an invalid format`);
}

function readDaemonEndpointSecret(path: string): string | undefined {
	let content: string;
	try {
		content = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	const secret = content.trim();
	if (!SECRET_PATTERN.test(secret)) {
		return undefined;
	}
	restrictSecretFile(path);
	return secret;
}

function restrictSecretFile(path: string): void {
	if (process.platform === "win32") {
		// NTFS ACLs come from the agent directory (the user's profile); chmod only toggles read-only there.
		return;
	}
	try {
		if ((statSync(path).mode & 0o077) !== 0) {
			chmodSync(path, 0o600);
		}
	} catch {
		// Best effort: the secret is still usable; a wider mode is repaired on the next load.
	}
}

export function createDaemonEndpointNonce(): string {
	return randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Proof that the caller holds the secret, bound to both connection nonces and
 * to the role, so a captured client proof can never be replayed as a daemon
 * proof (or vice versa) and neither side can reflect the other's proof back.
 */
export function createDaemonEndpointProof(
	secret: string,
	role: DaemonEndpointProofRole,
	daemonChallenge: string,
	clientNonce: string,
): string {
	return createHmac("sha256", Buffer.from(secret, "hex"))
		.update(`${PROOF_DOMAIN}\n${role}\n${daemonChallenge}\n${clientNonce}`)
		.digest("hex");
}

export function verifyDaemonEndpointProof(
	secret: string,
	role: DaemonEndpointProofRole,
	daemonChallenge: string,
	clientNonce: string,
	proof: unknown,
): boolean {
	if (
		typeof proof !== "string" ||
		typeof daemonChallenge !== "string" ||
		typeof clientNonce !== "string" ||
		daemonChallenge.length === 0 ||
		clientNonce.length === 0
	) {
		return false;
	}
	const expected = Buffer.from(createDaemonEndpointProof(secret, role, daemonChallenge, clientNonce), "hex");
	let presented: Buffer;
	try {
		presented = Buffer.from(proof, "hex");
	} catch {
		return false;
	}
	return presented.length === expected.length && timingSafeEqual(presented, expected);
}
