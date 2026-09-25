import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { spawnSyncHidden } from "../../utils/child-process.js";

/** Environment variable checked for the daemon TCP port (after the CLI flag, before settings). */
const DAEMON_TCP_PORT_ENV = "PRIME_AGENT_DAEMON_PORT";
/** Environment variable checked for the daemon TCP bind host (after the CLI flag, before settings). */
const DAEMON_TCP_BIND_HOST_ENV = "PRIME_AGENT_DAEMON_BIND_HOST";
/** Budget for the one `tailscale status` call that resolves the default bind host. */
const DAEMON_TCP_TAILSCALE_TIMEOUT_MS = 15_000;

/** Upper bound for one TCP command line; an oversized line closes the connection. */
export const DAEMON_TCP_MAX_LINE_CHARS = 1024 * 1024;
/** Refuses TCP connections once this many concurrent sockets are admitted. */
export const DAEMON_TCP_MAX_CONNECTIONS = 256;
/** Closes a TCP socket that sends no authenticated line within this window. */
export const DAEMON_TCP_AUTH_TIMEOUT_MS = 30_000;
/** Idle window for an authenticated TCP socket; any traffic resets it. */
export const DAEMON_TCP_IDLE_TIMEOUT_MS = 10 * 60_000;
/**
 * Absolute admission budget for a TCP socket accepted before daemon_hello can
 * be written: the listener binds before worker adoption, which can spend the
 * whole worker connect budget (90s on slow Windows starts) before hello goes
 * out, and mesh clients wait for hello before sending their first token. The
 * short auth deadline re-arms from the moment hello is written.
 */
export const DAEMON_TCP_PRE_READY_TIMEOUT_MS = 120_000;

/** Auth verdict for one TCP command line. */
export interface DaemonTcpAuthVerdict {
	ok: boolean;
	/** Correlatable response id when the line was JSON. */
	id: string;
	/** Best-effort command name for the failure response. */
	command: string | undefined;
	reason: string;
}

export interface DaemonTcpTokenRecord {
	token: string;
	tokenPath: string;
	/** True when this load call created the token (first time). */
	created?: boolean;
}

/** Token file path inside the agent dir. */
function daemonTcpTokenPath(agentDir: string): string {
	return join(agentDir, "daemon-tcp-token");
}

/**
 * Parse the port from an environment map. Throws a named error when the
 * variable is present but not a valid port (never silently ignored).
 */
function daemonTcpPortFromEnv(env: Record<string, string | undefined>): number | undefined {
	const raw = env[DAEMON_TCP_PORT_ENV];
	if (raw === undefined || raw === "") {
		return undefined;
	}
	const port = Number(raw);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid ${DAEMON_TCP_PORT_ENV}: "${raw}" (expected an integer between 1 and 65535)`);
	}
	return port;
}

/**
 * Resolve the daemon TCP port. Precedence: explicit CLI flag > env var >
 * settings `daemonPort`. Returns undefined when no source provides a valid port.
 */
export function resolveDaemonTcpPort(
	explicit: number | undefined,
	settingsPort: number | undefined,
	env: Record<string, string | undefined> = process.env,
): number | undefined {
	if (typeof explicit === "number" && Number.isInteger(explicit) && explicit >= 1 && explicit <= 65535) {
		return explicit;
	}
	return daemonTcpPortFromEnv(env) ?? settingsPort;
}

/** The subset of `tailscale status --json` output this module reads. */
interface TailscaleStatusJson {
	BackendState?: string;
	Self?: { Online?: boolean; TailscaleIPs?: unknown };
}

/**
 * Resolve this machine's own Tailscale address for the default listener bind.
 * Returns null when the CLI is missing, the node is not up on a tailnet, or the
 * status carries no usable address, so the caller can refuse to bind instead of
 * widening to a wildcard interface. Mirrors the detection core of the Tailscale
 * mesh helpers (`tailscale status --json`, `Self.Online`/`BackendState`).
 */
function detectTailscaleBindAddress(): string | null {
	const status = spawnSyncHidden("tailscale", ["status", "--json"], {
		encoding: "utf8",
		timeout: DAEMON_TCP_TAILSCALE_TIMEOUT_MS,
		killSignal: "SIGKILL",
	});
	if (status.error || status.status !== 0) {
		return null;
	}
	let parsed: TailscaleStatusJson;
	try {
		parsed = JSON.parse(status.stdout ?? "") as TailscaleStatusJson;
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object") {
		return null;
	}
	// BackendState covers a daemon that is Running but currently offline (its
	// address stays assigned); anything else has no tailnet address to bind.
	if (parsed.Self?.Online !== true && parsed.BackendState !== "Running") {
		return null;
	}
	const addresses = Array.isArray(parsed.Self?.TailscaleIPs)
		? parsed.Self.TailscaleIPs.filter((address): address is string => typeof address === "string")
		: [];
	// Tailscale assigns both a CGNAT IPv4 and an IPv6 address; IPv4 is the one
	// every peer on the tailnet can reach without extra configuration.
	return addresses.find((address) => isIP(address) === 4) ?? addresses.find((address) => isIP(address) !== 0) ?? null;
}

/**
 * True for a bind host that listens on every interface. The IPv6 side accepts
 * every spelling of the unspecified address: `::`, `::0`, and the fully expanded
 * `0:0:0:0:0:0:0:0` all bind the wildcard interface, so a classifier that only
 * knows `::` would skip the plaintext-token exposure warning for the others.
 */
export function isWildcardBindHost(host: string): boolean {
	if (host === "0.0.0.0") {
		return true;
	}
	// Every group is zero or compressed away; any non-zero group is a real address.
	return isIP(host) === 6 && host.split(":").every((group) => group === "" || group === "0");
}

/** Validate one configured bind host, naming the source that supplied it. */
function daemonTcpBindHostFromSource(raw: string, source: string): string {
	const host = raw.trim();
	if (isIP(host) === 0) {
		throw new Error(`Invalid ${source}: "${raw}" (expected an IP address, e.g. the tailnet address of this machine)`);
	}
	return host;
}

/**
 * Resolve the host the daemon TCP listener binds. Precedence mirrors the port:
 * explicit CLI flag > env var > settings `daemonTcpBindHost`, and the machine's
 * Tailscale address when none of them is set. The token and every authenticated
 * command travel in plaintext, so the listener only widens past the tailnet when
 * a source above asks for it explicitly; a wildcard default is never returned.
 * Throws when no source provides a host and this machine has no tailnet address,
 * so the caller fails closed instead of exposing the port on every interface.
 */
export function resolveDaemonTcpListenerHost(
	explicit: string | undefined,
	settingsHost: string | undefined,
	env: Record<string, string | undefined> = process.env,
): string {
	const candidates: [string | undefined, string][] = [
		[explicit, "--daemon-bind"],
		[env[DAEMON_TCP_BIND_HOST_ENV], DAEMON_TCP_BIND_HOST_ENV],
		[settingsHost, "settings daemonTcpBindHost"],
	];
	for (const [value, source] of candidates) {
		if (value !== undefined && value !== "") {
			return daemonTcpBindHostFromSource(value, source);
		}
	}
	const tailscaleAddress = detectTailscaleBindAddress();
	if (tailscaleAddress === null) {
		throw new Error(
			"Refusing to start the daemon TCP listener: this machine has no Tailscale address to bind and no bind host was configured. " +
				"The per-machine token travels in plaintext over TCP, so the listener binds the tailnet only. " +
				`Set ${DAEMON_TCP_BIND_HOST_ENV}, the --daemon-bind flag, or settings daemonTcpBindHost to the local address to listen on ` +
				"(only when that network is trusted), or unset the daemon port to disable the listener.",
		);
	}
	return tailscaleAddress;
}

/** Timing-safe token comparison that does not leak length differences. */
function daemonTcpTokensMatch(actual: string, expected: string): boolean {
	if (actual.length !== expected.length) {
		return false;
	}
	let mismatch = 0;
	for (let i = 0; i < actual.length; i++) {
		mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
	}
	return mismatch === 0;
}

/** Read the existing token without creating one. Returns undefined when unset. */
function readDaemonTcpToken(agentDir: string): string | undefined {
	const tokenPath = daemonTcpTokenPath(agentDir);
	if (!existsSync(tokenPath)) {
		return undefined;
	}
	const raw = readFileSync(tokenPath, "utf8").trim();
	if (!raw) {
		throw new Error(`daemon TCP token file ${tokenPath} is empty`);
	}
	try {
		const parsed = JSON.parse(raw) as { token?: unknown };
		if (typeof parsed.token !== "string" || parsed.token.length === 0) {
			throw new Error(`daemon TCP token file ${tokenPath} is missing its token`);
		}
		return parsed.token;
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`daemon TCP token file ${tokenPath} is not valid JSON`);
		}
		throw error;
	}
}

/**
 * Load or create the per-machine token used to authenticate TCP lines.
 * The token is stored as JSON in `<agentDir>/daemon-tcp-token`.
 */
export function loadOrCreateDaemonTcpToken(agentDir: string): DaemonTcpTokenRecord {
	const tokenPath = daemonTcpTokenPath(agentDir);
	try {
		const token = readDaemonTcpToken(agentDir);
		if (token !== undefined) {
			return { token, tokenPath, created: false };
		}
	} catch (error) {
		// Refuse to overwrite a corrupt token file
		throw error;
	}
	mkdirSync(agentDir, { recursive: true });
	const token = randomBytes(32).toString("base64url");
	try {
		// Exclusive create: a concurrent daemon must not overwrite a token its peer
		// may already be authenticating with; the race loser reuses the winner's.
		writeFileSync(tokenPath, `${JSON.stringify({ token })}\n`, { mode: 0o600, flag: "wx" });
		return { token, tokenPath, created: true };
	} catch (error) {
		if (!isExclusiveCreateConflict(error)) {
			throw error;
		}
		const existingToken = readDaemonTcpToken(agentDir);
		if (existingToken === undefined) {
			throw error;
		}
		return { token: existingToken, tokenPath, created: false };
	}
}

function isExclusiveCreateConflict(error: unknown): boolean {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

/**
 * Check that a TCP command line carries the expected per-machine token. Only
 * the daemon envelope ({"type":"command","command":{...},"auth":{"token"}}) is
 * dispatchable: the supervisor requires the envelope protocol for every client,
 * unix included, so a raw {"id","type","auth":{...}} record authenticates here
 * and is then refused by the dispatcher with the protocol-version error.
 */
export function checkDaemonTcpLineAuth(line: string, expectedToken: string): DaemonTcpAuthVerdict {
	let parsed: {
		id?: string;
		type?: string;
		auth?: { token?: unknown };
		command?: { type?: string };
	};
	try {
		parsed = JSON.parse(line) as typeof parsed;
	} catch {
		return { ok: false, id: "unknown", command: undefined, reason: "invalid_json" };
	}
	// A JSON primitive such as `null` would otherwise throw on the field reads
	// below and take the socket's data handler down with it.
	if (parsed === null || typeof parsed !== "object") {
		return { ok: false, id: "unknown", command: undefined, reason: "invalid_json" };
	}
	const id = typeof parsed.id === "string" ? parsed.id : "unknown";
	// An envelope carries `type: "command"` and names the real command in
	// `command.type`, so the inner name wins; `type` stays the fallback for a
	// line that never reaches the dispatcher.
	const envelopeCommand = parsed.command?.type;
	const command = typeof envelopeCommand === "string" ? envelopeCommand : parsed.type;
	const token = parsed.auth?.token;
	if (typeof token === "string" && token.length > 0 && daemonTcpTokensMatch(token, expectedToken)) {
		return { ok: true, id, command, reason: "" };
	}
	const reason = token === undefined || token === "" ? "missing_token" : "wrong_token";
	return { ok: false, id, command, reason };
}
