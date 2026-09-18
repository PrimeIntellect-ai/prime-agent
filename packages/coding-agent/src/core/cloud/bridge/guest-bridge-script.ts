/**
 * The guest-side cloud bridge, uploaded verbatim into the sandbox by the local
 * daemon and started by the bootstrap. Since the resident guest daemon landed,
 * the bridge is a supervisor and byte pump, never a task runner:
 *
 * Direction A: this program is the ONLY network surface inside the sandbox for
 * the cloud session. It binds 127.0.0.1, serves the cloud session protocol's
 * WebSocket transport, and frpc forwards the tunnel edge to that loopback
 * listener. It never learns the Prime platform API key. It holds three
 * session-scoped secrets: this tunnel's frp connection details, the bridge
 * protocol token (which only the guest daemon validates), and the guest
 * inference credential, which it passes to the guest daemon as PRIME_API_KEY
 * without logging it and which finalize removes before publishing results.
 *
 * It is a standalone Node script by necessity: the guest runs it with the
 * image's plain node binary before any package code is importable, and the
 * daemon must be able to evolve it in lockstep with the local side. Keep it
 * dependency-free (node: builtins only) and self-contained; it is exercised
 * end-to-end by test/cloud-guest-bridge.test.ts against the real protocol
 * server, so its behavior is as covered as the compiled local side.
 *
 * Responsibilities:
 * - Supervise the resident guest daemon process: start it, restart it after a
 *   crash (bounded), and stop it on release. Session state, the command
 *   journal, and the durable event outbox all live in the daemon and survive
 *   its restarts.
 * - Relay frames verbatim: WebSocket text frames become newline-delimited JSON
 *   on the daemon's unix socket, and daemon lines become WebSocket text
 *   frames. The daemon owns hello/version/token/generation validation and
 *   every receipt.
 * - Own the terminal results contract: status.txt, stdout.txt (the assistant
 *   answer stream), stderr.txt (daemon diagnostics), and changes.patch against
 *   the submitted baseline, plus removal of the guest credential, with
 *   status.txt last as the commit marker.
 */

export const CLOUD_GUEST_BRIDGE_SCRIPT = String.raw`#!/usr/bin/env node
// Guest cloud bridge. Uploaded verbatim; fixed-name env only; no user text is
// interpolated anywhere. See guest-bridge-script.ts for the contract.
"use strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import net from "node:net";
import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";

const PROTOCOL_NAME = "prime-agent.cloud";
const MAX_MESSAGE_BYTES = 1048576;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const HELLO_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 30000;
const DEFAULT_PORT = 8740;
const MAX_CLIENTS = 4;
const DAEMON_START_TIMEOUT_MS = 60000;
const DAEMON_RESTART_LIMIT = 5;
const DAEMON_RESTART_DELAY_MS = 1000;

function env(name, fallback) {
	const value = process.env[name];
	return value === undefined || value === "" ? fallback : value;
}
function requiredEnv(name) {
	const value = process.env[name];
	if (value === undefined || value === "") {
		throw new Error("missing required environment variable " + name);
	}
	return value;
}

const sessionId = requiredEnv("PRIME_AGENT_CLOUD_SESSION_ID");
const generation = Number(requiredEnv("PRIME_AGENT_CLOUD_GENERATION"));
if (!Number.isInteger(generation) || generation < 1) throw new Error("invalid PRIME_AGENT_CLOUD_GENERATION");
const workspaceDir = requiredEnv("PRIME_AGENT_CLOUD_WORKSPACE_DIR");
const authPath = requiredEnv("PRIME_AGENT_CLOUD_AUTH_PATH");
const resultsDir = requiredEnv("PRIME_AGENT_CLOUD_RESULTS_DIR");
const daemonSocketPath = env("PRIME_AGENT_CLOUD_DAEMON_SOCKET", "/opt/prime-agent/daemon-state/cloud.sock");
const daemonArgv = parseDaemonArgv(env("PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON", '["prime-agent","--mode","daemon"]'));
const port = Number(env("PRIME_AGENT_CLOUD_BRIDGE_PORT", String(DEFAULT_PORT)));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid PRIME_AGENT_CLOUD_BRIDGE_PORT");
const stateDir = env("PRIME_AGENT_CLOUD_BRIDGE_STATE_DIR", "/opt/prime-agent/bridge/state");
const stdoutPath = join(resultsDir, "stdout.txt");
const stderrPath = join(resultsDir, "stderr.txt");
const statusPath = join(resultsDir, "status.txt");
const patchPath = join(resultsDir, "changes.patch");
const bridgeLogPath = join(stateDir, "bridge.log");
const frpcLogPath = join(stateDir, "frpc.log");
const frpcConfigPath = join(stateDir, "frpc.toml");
const daemonLogPath = join(stateDir, "daemon.log");
const daemonStateDir = env("PRIME_AGENT_CLOUD_DAEMON_STATE_DIR", "/opt/prime-agent/daemon-state");
const daemonStatusPath = env("PRIME_AGENT_CLOUD_DAEMON_STATUS_FILE", join(daemonStateDir, "daemon-status.json"));
mkdirSync(stateDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

function parseDaemonArgv(encoded) {
	let value;
	try {
		value = JSON.parse(encoded);
	} catch {
		throw new Error("invalid PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON");
	}
	if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
		throw new Error("invalid PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON");
	}
	for (const item of value) {
		if (typeof item !== "string" || item.length === 0 || item.length > 512 || item.includes("\0")) {
			throw new Error("invalid PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON");
		}
	}
	return value;
}

function log(line) {
	try {
		appendFileSync(bridgeLogPath, new Date().toISOString() + " " + line + "\n");
	} catch {
		// Bridge logging must never crash the bridge itself.
	}
}

// --- daemon supervision -------------------------------------------------------
//
// The guest daemon owns the session, the durable command journal, and the
// event outbox; this bridge supervises its process and never interprets
// protocol semantics beyond what the terminal results contract needs (the
// session's status transitions and the stdout answer stream).

let daemonChild = null;
let daemonRestarts = 0;
let sessionStatus = "starting";
let sawBusy = false;
let sawIdleAfterBusy = false;
let lastOutcome = "completed";
let finalizing = false;
let finalized = false;

function readCredential() {
	try {
		return readFileSync(authPath, "utf8").trim();
	} catch {
		return undefined;
	}
}

function daemonEnv() {
	const childEnv = { ...process.env };
	childEnv.PRIME_AGENT_INTERNAL_CLOUD_DAEMON = "1";
	childEnv.PRIME_AGENT_CLOUD_DAEMON_SOCKET = daemonSocketPath;
	// The scoped inference credential reaches the resident daemon exactly the
	// way v1 reached the one-shot agent: as PRIME_API_KEY for the session
	// process only. It is never logged, never written to the results, and the
	// finalize path still removes the credential file.
	const credential = readCredential();
	if (credential !== undefined && credential.length > 0) {
		childEnv.PRIME_API_KEY = credential;
	}
	return childEnv;
}

function startDaemon() {
	const child = spawn(daemonArgv[0], daemonArgv.slice(1), {
		cwd: workspaceDir,
		env: daemonEnv(),
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	daemonChild = child;
	const stderrFd = openSync(stderrPath, "a");
	const daemonLogFd = openSync(daemonLogPath, "a");
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		try {
			writeSync(daemonLogFd, chunk);
		} catch {
			// Best-effort diagnostic capture.
		}
	});
	child.stderr.on("data", (chunk) => {
		try {
			writeSync(stderrFd, chunk);
		} catch {
			// Best-effort diagnostic capture.
		}
	});
	// 'exit', not 'close': a daemon may have children that inherited its stdio
	// pipes (kernels, helper servers); those can outlive it briefly and would
	// hold the 'close' event hostage long after the process is gone.
	child.once("exit", (code, signal) => {
		const wasDaemon = daemonChild === child;
		daemonChild = null;
		try {
			closeSync(stderrFd);
			closeSync(daemonLogFd);
		} catch {
			// fds already closed
		}
		if (finalizing || finalized) return;
		for (const client of clients) client.closeSoon(CLOSE_NORMAL, "guest daemon restarted");
		if (code === 0) {
			// A clean daemon exit is the one-shot flow completing: the session
			// status stream already recorded the outcome.
			void finalize(sawIdleAfterBusy || sessionStatus === "stopped" ? lastOutcome : "completed");
			return;
		}
		daemonRestarts += 1;
		if (daemonRestarts > DAEMON_RESTART_LIMIT) {
			log("daemon exited with code " + String(code) + " signal " + String(signal) + "; restart limit reached");
			void finalize("failed");
			return;
		}
		log(
			"daemon exited with code " +
				String(code) +
				" signal " +
				String(signal) +
				"; restarting (" +
				String(daemonRestarts) +
				"/" +
				String(DAEMON_RESTART_LIMIT) +
				")",
		);
		sawBusy = false;
		sawIdleAfterBusy = false;
		sessionStatus = "starting";
		setTimeout(() => {
			if (!finalizing && !wasDaemon) return;
			if (!finalizing) startDaemon();
		}, DAEMON_RESTART_DELAY_MS).unref();
	});
	log("guest daemon started: " + daemonArgv.join(" "));
	try {
		// Atomic: tests and diagnostics read the supervised daemon's pid.
		const pidFile = join(stateDir, "daemon.pid");
		writeFileSync(pidFile + ".tmp", String(child.pid) + "\n", { mode: 0o600 });
		renameSync(pidFile + ".tmp", pidFile);
	} catch {
		// The pid file is a local probe only.
	}
}

function signalDaemon(signal) {
	if (daemonChild === null || daemonChild.pid === undefined) return;
	try {
		process.kill(-daemonChild.pid, signal);
		return;
	} catch {
		// No group to signal (already reaped, or never became a leader).
	}
	try {
		daemonChild.kill(signal);
	} catch {
		// The child is already gone.
	}
}

async function awaitDaemonSocket(deadlineMs) {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		if (existsSync(daemonSocketPath)) return;
		if (Date.now() > deadline) throw new Error("guest daemon socket did not appear");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// --- daemon status polling ------------------------------------------------------
//
// The tunnel relay only sees frames while a client is attached; the one-shot
// flow has no client at all. The daemon publishes its status to one bounded
// file, and this poll drives the same observeStatus logic either way.

function readDaemonStatusRecord() {
	try {
		const parsed = JSON.parse(readFileSync(daemonStatusPath, "utf8"));
		if (parsed !== null && typeof parsed === "object" && typeof parsed.status === "string") {
			return parsed;
		}
	} catch {
		// Not written yet (or mid-restart); the poller retries.
	}
	return undefined;
}

setInterval(() => {
	const parsed = readDaemonStatusRecord();
	if (parsed === undefined) return;
	observeStatus(parsed.status);
	// The one-shot flow has no tunnel client: the daemon's own status record
	// says when admitted work has settled, and that drives the release.
	if (parsed.idleAfterWork === true && oneShotMode() && !finalizing && !finalized) {
		maybeCompleteOneShot();
	}
}, 250).unref();

// --- relayed-frame observation -------------------------------------------------
//
// The bridge is a byte pump for the protocol, but the results contract needs
// two facts from the stream: the session's status transitions (when has the
// one-shot initial prompt completed) and the stdout text (the final answer).

const stdoutFd = openSync(stdoutPath, "w");
function appendStdout(text) {
	try {
		const bytes = Buffer.from(text, "utf8");
		if (bytes.byteLength > 0) writeSync(stdoutFd, bytes);
	} catch (error) {
		log("stdout write failed: " + error.message);
	}
}

function observeServerFrame(text) {
	let value;
	try {
		value = JSON.parse(text);
	} catch {
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (value.type === "snapshot" && typeof value.status === "string") {
		observeStatus(value.status);
	}
	if (value.type !== "events" || !Array.isArray(value.events)) return;
	for (const event of value.events) {
		if (event === null || typeof event !== "object") continue;
		if (event.kind === "session_status" && typeof event.status === "string") {
			observeStatus(event.status);
		}
		if (event.kind === "output_delta" && event.stream === "stdout" && typeof event.text === "string") {
			appendStdout(event.text);
		}
	}
}

function observeStatus(next) {
	if (next === sessionStatus && next !== "busy" && next !== "idle") return;
	const previous = sessionStatus;
	sessionStatus = next;
	if (next === "busy") {
		sawBusy = true;
		sawIdleAfterBusy = false;
		return;
	}
	if (next === "idle" && sawBusy && previous === "busy") {
		sawIdleAfterBusy = true;
		lastOutcome = "completed";
		maybeCompleteOneShot();
		return;
	}
	if (next === "failed") {
		lastOutcome = "failed";
	}
	if (next === "stopped") {
		lastOutcome = "stopped";
	}
}

/** No tunnel forwards this sandbox: the one-shot flow ends when work settles. */
function oneShotMode() {
	return !frpcConfigured;
}

function maybeCompleteOneShot() {
	if (finalizing || finalized || !oneShotMode()) return;
	if (!sawIdleAfterBusy && readDaemonStatusRecord()?.idleAfterWork !== true) return;
	// Give queued follow-ups a beat: the next busy transition cancels this.
	const settleTimer = setTimeout(() => {
		const record = readDaemonStatusRecord();
		const settled = sawIdleAfterBusy || record?.idleAfterWork === true;
		if (!finalizing && !finalized && settled && (record === undefined || record.status === "idle") && oneShotMode()) {
			void requestRelease("completed");
		}
	}, 3000);
	settleTimer.unref();
}

// --- release and finalize -------------------------------------------------------

async function requestRelease(outcome) {
	if (finalizing || finalized) return;
	finalizing = true;
	lastOutcome = outcome;
	// Ask the daemon to drain; SIGTERM is its release signal, and a hard
	// fallback covers a wedged process.
	signalDaemon("SIGTERM");
	const deadline = Date.now() + 15000;
	try {
		await awaitDaemonGone(deadline);
	} catch {
		signalDaemon("SIGKILL");
	}
	await finalize(outcome);
}

function awaitDaemonGone(deadline) {
	return new Promise((resolve, reject) => {
		const check = () => {
			if (daemonChild === null) return resolve();
			if (Date.now() > deadline) return reject(new Error("daemon did not stop"));
			setTimeout(check, 100);
		};
		check();
	});
}

async function finalize(outcome) {
	if (finalized) return;
	finalized = true;
	finalizing = true;
	try {
		closeSync(stdoutFd);
	} catch {
		// already closed
	}
	// The daemon's answer stream is authoritative: the one-shot flow has no
	// relay client, so the live relay copy may be partial.
	try {
		const guestStdout = join(daemonStateDir, "guest-stdout.txt");
		if (existsSync(guestStdout)) {
			const fd = openSync(stdoutPath, "w", 0o600);
			try {
				writeSync(fd, readFileSync(guestStdout));
			} finally {
				closeSync(fd);
			}
		}
	} catch (error) {
		log("guest stdout copy failed: " + error.message);
	}
	if (frpcChild !== null) {
		// The tunnel edge must stop forwarding to a bridge that is going away.
		signalProcessGroup(frpcChild, "SIGTERM");
		frpcChild = null;
	}
	try {
		const baseline = env("PRIME_AGENT_CLOUD_GIT_BASELINE", "");
		if (baseline !== "" && existsSync(join(workspaceDir, ".git"))) {
			const patch = await gitPatch(baseline);
			const fd = openSync(patchPath, "w", 0o600);
			try {
				writeSync(fd, patch);
			} finally {
				closeSync(fd);
			}
		} else {
			const fd = openSync(patchPath, "w", 0o600);
			closeSync(fd);
		}
	} catch (error) {
		log("patch generation failed: " + error.message);
	}
	try {
		rmSync(authPath, { force: true });
	} catch {
		// Best effort: the sandbox is destroyed with the delegation anyway.
	}
	// The terminal status is the commit marker and therefore lands last.
	appendFileSync(statusPath + ".tmp", outcome + "\n");
	rmSync(statusPath, { force: true });
	renameSync(statusPath + ".tmp", statusPath);
	for (const client of clients) client.closeSoon(CLOSE_NORMAL, "session complete");
	server.close();
	if (daemonChild !== null) {
		signalDaemon("SIGKILL");
	}
	setTimeout(() => process.exit(outcome === "failed" ? 1 : 0), 1000).unref();
}

function signalProcessGroup(child, signal) {
	if (child === null || child.pid === undefined) return;
	try {
		process.kill(-child.pid, signal);
		return;
	} catch {
		// No group to signal (already reaped, or never became a leader).
	}
	try {
		child.kill(signal);
	} catch {
		// The child is already gone.
	}
}

function gitAddUntracked() {
	return new Promise((resolve) => {
		execFile("git", ["-C", workspaceDir, "ls-files", "--others", "--exclude-standard", "-z"], (error, stdout) => {
			if (error !== null) return resolve();
			const paths = stdout.split("\0").filter((path) => path !== "");
			if (paths.length === 0) return resolve();
			execFile("git", ["-C", workspaceDir, "add", "-N", "--", ...paths], () => resolve());
		});
	});
}

function gitPatch(baseline) {
	return gitAddUntracked().then(
		() =>
			new Promise((resolve) => {
				execFile(
					"git",
					["-C", workspaceDir, "-c", "core.quotePath=false", "diff", "--binary", "--no-renames", baseline],
					(error, patch) => resolve(error === null ? patch : ""),
				);
			}),
	);
}

// --- WebSocket server --------------------------------------------------------

const clients = new Set();

function acceptKey(key) {
	return createHash("sha1").update(key + WS_GUID).digest("base64");
}

class WsClient {
	constructor(socket) {
		this.socket = socket;
		this.buffer = Buffer.alloc(0);
		this.daemonBuffer = Buffer.alloc(0);
		this.fragments = null;
		this.authenticated = false;
		this.closed = false;
		this.destroyed = false;
		this.daemonSocket = null;
		this.daemonConnected = false;
		this.daemonAttempt = 0;
		this.daemonDeadline = Date.now() + DAEMON_START_TIMEOUT_MS;
		this.pendingFrames = [];
		this.helloTimer = setTimeout(() => {
			if (!this.authenticated) this.closeSoon(CLOSE_POLICY, "hello timeout");
		}, HELLO_TIMEOUT_MS);
		this.pingTimer = setInterval(() => this.sendFrame(9, Buffer.alloc(0)), PING_INTERVAL_MS);
		clients.add(this);
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("error", () => this.destroy());
		socket.on("close", () => this.onDestroy());
	}

	connectDaemon(attempt) {
		// One daemon socket connection per tunnel client; the daemon owns all
		// protocol validation (hello, version, token, generation, digests).
		const daemonSocket = net.createConnection(daemonSocketPath);
		this.daemonSocket = daemonSocket;
		this.daemonConnected = false;
		this.daemonAttempt = attempt;
		daemonSocket.setNoDelay(true);
		daemonSocket.on("connect", () => {
			this.daemonConnected = true;
			// Flush frames that arrived while the daemon socket was still
			// connecting (the daemon boots after the bridge starts listening).
			for (const frame of this.pendingFrames) daemonSocket.write(frame);
			this.pendingFrames.length = 0;
		});
		daemonSocket.on("data", (chunk) => this.onDaemonData(chunk));
		daemonSocket.on("error", (error) => {
			daemonSocket.destroy();
			if (finalizing || finalized) {
				this.closeSoon(CLOSE_NORMAL, "bridge is finalizing");
				return;
			}
			// The daemon boots behind the bridge: retry the socket while the
			// client's frames stay buffered, and only fail past the deadline.
			if (Date.now() > this.daemonDeadline || this.daemonAttempt > 400) {
				this.closeSoon(CLOSE_NORMAL, "guest daemon unavailable: " + String(error?.code ?? error?.message ?? error));
				return;
			}
			setTimeout(() => {
				if (!this.closed && !finalizing && !finalized) this.connectDaemon(this.daemonAttempt + 1);
			}, 100);
		});
		daemonSocket.on("close", () => {
			if (this.daemonConnected && !this.closed) this.closeSoon(CLOSE_NORMAL, "guest daemon connection closed");
		});
	}

	onData(chunk) {
		if (this.closed) return;
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const frame = this.readFrame();
			if (frame === null) return;
			if (frame === false) {
				this.closeSoon(CLOSE_PROTOCOL, "protocol error");
				return;
			}
			if (frame.opcode === 8) {
				this.sendFrame(8, frame.payload);
				this.destroy();
				return;
			}
			if (frame.opcode === 9) {
				this.sendFrame(10, frame.payload);
				continue;
			}
			if (frame.opcode === 10) continue;
			if (frame.opcode === 1) {
				if (frame.fin) {
					this.onMessage(frame.payload);
					continue;
				}
				this.fragments = [frame.payload];
				continue;
			}
			if (frame.opcode === 0) {
				if (this.fragments === null) {
					this.closeSoon(CLOSE_PROTOCOL, "unexpected continuation");
					return;
				}
				this.fragments.push(frame.payload);
				if (frame.fin) {
					const payload = Buffer.concat(this.fragments);
					this.fragments = null;
					this.onMessage(payload);
				}
				continue;
			}
			this.closeSoon(CLOSE_PROTOCOL, "unsupported opcode");
			return;
		}
	}

	readFrame() {
		const buffer = this.buffer;
		if (buffer.byteLength < 2) return null;
		const first = buffer[0];
		const second = buffer[1];
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		if (!masked) return false;
		const isControl = (opcode & 0x8) !== 0;
		if (isControl && !fin) return false;
		const lengthKind = second & 0x7f;
		let offset = 2;
		let length = 0;
		if (lengthKind === 126) {
			if (buffer.byteLength < offset + 2) return null;
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (lengthKind === 127) {
			if (buffer.byteLength < offset + 8) return null;
			const high = buffer.readUInt32BE(offset);
			const low = buffer.readUInt32BE(offset + 4);
			if (high !== 0 || low > MAX_MESSAGE_BYTES) return false;
			length = low;
			offset += 8;
		} else {
			length = lengthKind;
		}
		if (isControl && length > 125) return false;
		if (length > MAX_MESSAGE_BYTES) return false;
		if (buffer.byteLength < offset + 4 + length) return null;
		const mask = buffer.subarray(offset, offset + 4);
		const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
		for (let index = 0; index < payload.byteLength; index++) payload[index] ^= mask[index & 3];
		this.buffer = buffer.subarray(offset + 4 + length);
		return { fin, opcode, payload };
	}

	sendFrame(opcode, payload) {
		if (this.closed) return;
		const length = payload.byteLength;
		let header;
		if (length < 126) {
			header = Buffer.from([0x80 | opcode, length]);
		} else if (length <= 0xffff) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeUInt32BE(0, 2);
			header.writeUInt32BE(length, 6);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	onMessage(payload) {
		const text = payload.toString("utf8");
		if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
			this.closeSoon(CLOSE_TOO_BIG, "message too large");
			return;
		}
		if (!this.daemonConnected) {
			// The daemon is still starting (or restarting): hold the frame
			// until its socket connects instead of failing the client.
			this.pendingFrames.push(text + "\n");
			return;
		}
		// The daemon validates the first frame (hello) and every receipt; this
		// side only tracks that the client introduced itself for the timeout.
		if (!this.authenticated) this.authenticated = true;
		this.daemonSocket.write(text + "\n");
	}

	onDaemonData(chunk) {
		if (this.closed || this.daemonSocket === null) return;
		this.daemonBuffer = Buffer.concat([this.daemonBuffer, chunk]);
		for (;;) {
			const newline = this.daemonBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = this.daemonBuffer.subarray(0, newline).toString("utf8");
			this.daemonBuffer = this.daemonBuffer.subarray(newline + 1);
			if (line.length === 0) continue;
			observeServerFrame(line);
			this.sendFrame(1, Buffer.from(line, "utf8"));
		}
	}

	closeSoon(code, reason) {
		if (this.closed) return;
		const reasonText = reason === undefined ? "" : reason;
		const payload = Buffer.alloc(2 + Buffer.byteLength(reasonText, "utf8"));
		payload.writeUInt16BE(code, 0);
		payload.write(reasonText, 2, "utf8");
		this.sendFrame(8, payload);
		this.destroy();
	}

	destroy() {
		if (this.closed) return;
		this.closed = true;
		try {
			if (this.daemonSocket !== null) this.daemonSocket.destroy();
		} catch {
			// already gone
		}
		try {
			this.socket.destroy();
		} catch {
			// The socket is already gone; onDestroy handles the cleanup.
		}
	}

	onDestroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		clearTimeout(this.helloTimer);
		clearInterval(this.pingTimer);
		try {
			if (this.daemonSocket !== null) this.daemonSocket.destroy();
		} catch {
			// already gone
		}
		clients.delete(this);
	}
}

const server = http.createServer((request, response) => {
	if ((request.method || "GET") === "GET" && (request.url || "/") === "/") {
		const body = JSON.stringify({
			ok: true,
			protocol: PROTOCOL_NAME,
			protocolVersion: 2,
			sessionId,
			generation,
			status: sessionStatus,
			daemon: daemonChild === null ? "restarting" : "running",
		});
		response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
		response.end(body);
		return;
	}
	response.writeHead(404, { "Content-Type": "text/plain" });
	response.end("not found");
});

server.on("upgrade", (request, socket) => {
	const key = request.headers["sec-websocket-key"];
	const upgrade = String(request.headers.upgrade || "").toLowerCase();
	if (upgrade !== "websocket" || typeof key !== "string" || key === "") {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	if (clients.size >= MAX_CLIENTS) {
		socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
		socket.destroy();
		return;
	}
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
			acceptKey(key) +
			"\r\n\r\n",
	);
	socket.setNoDelay(true);
	const client = new WsClient(socket);
	client.connectDaemon();
});

server.listen(port, "127.0.0.1", () => {
	const address = server.address();
	const bound = address === null || typeof address === "string" ? port : address.port;
	log("bridge listening on 127.0.0.1:" + String(bound));
	try {
		// Atomic: a reader never observes a partially written port.
		const portFile = join(stateDir, "port");
		writeFileSync(portFile + ".tmp", String(bound) + "\n", { mode: 0o600 });
		renameSync(portFile + ".tmp", portFile);
	} catch {
		// The port file is an optional local probe; the tunnel works without it.
	}
});

// --- frpc --------------------------------------------------------------------

let frpcChild = null;
let frpcConfigured = false;

function startFrpc() {
	const frpcBin = env("PRIME_AGENT_CLOUD_FRPC_BIN", "");
	const tunnelId = env("PRIME_AGENT_CLOUD_TUNNEL_ID", "");
	const serverHost = env("PRIME_AGENT_CLOUD_TUNNEL_FRP_SERVER_HOST", "");
	const serverPort = env("PRIME_AGENT_CLOUD_TUNNEL_FRP_SERVER_PORT", "");
	const frpToken = env("PRIME_AGENT_CLOUD_TUNNEL_FRP_TOKEN", "");
	const bindingSecret = env("PRIME_AGENT_CLOUD_TUNNEL_BINDING_SECRET", "");
	if (frpcBin === "" || tunnelId === "" || serverHost === "" || serverPort === "" || frpToken === "" || bindingSecret === "") {
		log("frpc environment incomplete; the tunnel edge will not reach this sandbox");
		return;
	}
	frpcConfigured = true;
	const config = [
		"# generated by the guest cloud bridge",
		"serverAddr = " + JSON.stringify(serverHost),
		"serverPort = " + serverPort,
		"user = " + JSON.stringify(tunnelId),
		'auth.method = "token"',
		"auth.token = " + JSON.stringify(frpToken),
		"metadatas.binding_secret = " + JSON.stringify(bindingSecret),
		"transport.tcpMux = true",
		"transport.tcpMuxKeepaliveInterval = 30",
		"transport.poolCount = 4",
		"transport.dialServerKeepalive = 60",
		"log.to = " + JSON.stringify(frpcLogPath),
		'log.level = "info"',
		"",
		"[[proxies]]",
		"name = " + JSON.stringify(tunnelId),
		'type = "http"',
		'localIP = "127.0.0.1"',
		"localPort = " + String(port),
		"subdomain = " + JSON.stringify(tunnelId),
		"",
	].join("\n");
	const fd = openSync(frpcConfigPath, "w", 0o600);
	try {
		writeSync(fd, config);
	} finally {
		closeSync(fd);
	}
	try {
		const child = spawn(frpcBin, ["-c", frpcConfigPath], { stdio: ["ignore", "ignore", "pipe"], detached: true });
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			try {
				appendFileSync(frpcLogPath, chunk);
			} catch {
				// frpc logs are best-effort diagnostics, never control flow.
			}
		});
		child.once("error", (error) => {
			log("frpc failed to start: " + error.message);
		});
		frpcChild = child;
		child.once("close", (code) => {
			log("frpc exited with code " + String(code));
		});
		log("frpc started for tunnel " + tunnelId);
	} catch (error) {
		log("frpc spawn failed: " + error.message);
	}
}

startFrpc();

// --- lifecycle ---------------------------------------------------------------

process.on("SIGTERM", () => {
	log("SIGTERM: releasing the guest daemon and finalizing as stopped");
	void requestRelease("stopped");
});

// The daemon owns the session; the bridge owns its process. Serve forever
// until released (SIGTERM or one-shot completion).
startDaemon();
awaitDaemonSocket(DAEMON_START_TIMEOUT_MS).catch(async (error) => {
	log("guest daemon failed to start: " + error.message);
	await finalize("failed");
	process.exitCode = 1;
});
`;
