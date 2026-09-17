/**
 * The guest-side cloud bridge, uploaded verbatim into the sandbox by the local
 * daemon (tunnel mode only) and started by the bootstrap's tunnel branch.
 *
 * Direction A: this program is the ONLY network surface inside the sandbox
 * for the delegated session. It binds 127.0.0.1, speaks the cloud session
 * protocol over WebSocket frames, and frpc forwards the tunnel edge to that
 * loopback listener. It never learns the Prime platform API key: the only
 * secrets it holds are this tunnel's frp connection details, the guest's
 * inference credential file, and the bridge protocol token.
 *
 * It is a standalone Node script by necessity: the guest runs it with the
 * image's plain `node` binary before any package code is importable, and the
 * daemon must be able to evolve it in lockstep with the local side. Keep it
 * dependency-free (node: builtins only) and self-contained; it is exercised
 * end-to-end by `test/cloud-guest-bridge.test.ts` against a fake agent
 * process, so its behavior is as covered as the compiled local side.
 *
 * Responsibilities:
 * - Supervise the delegated tasks: the initial prompt task, then queued `steer`
 *   commands as follow-up tasks in the same workspace (live steering), and
 *   `cancel_task` by signalling the active child's whole process group (task
 *   children run detached in their own group, so helper processes an agent
 *   spawns cannot survive a cancel).
 * - Serve the session protocol: hello (protocol authentication), snapshot,
 *   subscribe (cursor replay + live push), submit (idempotent, digest-checked),
 *   get_command, ack (trim through the acknowledged cursor).
 * - Own the terminal results contract: status.txt, stdout.txt, stderr.txt,
 *   changes.patch against the submitted baseline, and removal of the guest
 *   credential, with status.txt last as the commit marker.
 */

export const CLOUD_GUEST_BRIDGE_SCRIPT = String.raw`#!/usr/bin/env node
// Guest cloud bridge. Uploaded verbatim; fixed-name env only; no user text is
// interpolated anywhere. See guest-bridge-script.ts for the contract.
"use strict";
import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { spawn, execFile } from "node:child_process";
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
const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 1048576;
const MAX_QUEUED_COMMANDS = 64;
const MAX_SNAPSHOT_EVENTS = 256;
// A protocol message must stay well under MAX_MESSAGE_BYTES: batches are
// bounded by bytes first, event count second, so a burst of maximum-size
// output deltas can never force-close the connection with 1009.
const MAX_BATCH_BYTES = 524288;
const MAX_RETAINED_EVENTS = 50000;
const MAX_OUTPUT_CHARS = 65536;
const MAX_PROMPT_CHARS = 65536;
const MAX_TOKEN_CHARS = 256;
const REQUEST_DIGEST_DOMAIN = PROTOCOL_NAME + ".request.v1";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const HELLO_TIMEOUT_MS = 15000;
const PING_INTERVAL_MS = 30000;
const DEFAULT_PORT = 8740;
const DEFAULT_FLUSH_MS = 750;
const CANCEL_GRACE_MS = 5000;
const MAX_CLIENTS = 4;

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
const promptPath = requiredEnv("PRIME_AGENT_CLOUD_PROMPT_PATH");
const authPath = requiredEnv("PRIME_AGENT_CLOUD_AUTH_PATH");
const resultsDir = requiredEnv("PRIME_AGENT_CLOUD_RESULTS_DIR");
const bridgeToken = requiredEnv("PRIME_AGENT_CLOUD_BRIDGE_TOKEN");
const agentBin = env("PRIME_AGENT_CLOUD_AGENT_BIN", "prime-agent");
const model = env("PRIME_AGENT_CLOUD_MODEL", "");
const port = Number(env("PRIME_AGENT_CLOUD_BRIDGE_PORT", String(DEFAULT_PORT)));
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid PRIME_AGENT_CLOUD_BRIDGE_PORT");
const stateDir = env("PRIME_AGENT_CLOUD_BRIDGE_STATE_DIR", "/opt/prime-agent/bridge/state");
const flushMs = Number(env("PRIME_AGENT_CLOUD_BRIDGE_OUTPUT_FLUSH_MS", String(DEFAULT_FLUSH_MS)));
if (!Number.isInteger(flushMs) || flushMs < 1) throw new Error("invalid PRIME_AGENT_CLOUD_BRIDGE_OUTPUT_FLUSH_MS");
const stdoutPath = join(resultsDir, "stdout.txt");
const stderrPath = join(resultsDir, "stderr.txt");
const statusPath = join(resultsDir, "status.txt");
const patchPath = join(resultsDir, "changes.patch");
const journalPath = join(stateDir, "journal.ndjson");
const eventsPath = join(stateDir, "events.ndjson");
const bridgeLogPath = join(stateDir, "bridge.log");
const frpcLogPath = join(stateDir, "frpc.log");
const frpcConfigPath = join(stateDir, "frpc.toml");
mkdirSync(stateDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

function log(line) {
	try {
		appendFileSync(bridgeLogPath, new Date().toISOString() + " " + line + "\n");
	} catch {
		// Bridge logging must never crash the bridge itself.
	}
}

// --- strict protocol helpers (mirrors protocol.ts semantics) ----------------

function canonicalJson(value, depth) {
	depth = depth || 0;
	if (depth > 64) throw new Error("canonical JSON depth exceeds 64");
	if (value === null) return "null";
	const kind = typeof value;
	if (kind === "string") return JSON.stringify(value);
	if (kind === "number") {
		if (!Number.isFinite(value)) throw new Error("canonical JSON accepts finite numbers only");
		return Object.is(value, -0) ? "0" : String(value);
	}
	if (kind === "boolean") return value ? "true" : "false";
	if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, depth + 1)).join(",") + "]";
	if (kind !== "object") throw new Error("canonical JSON does not accept " + kind);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw new Error("canonical JSON accepts plain objects only");
	const keys = Object.keys(value).sort();
	const parts = [];
	for (const key of keys) parts.push(JSON.stringify(key) + ":" + canonicalJson(value[key], depth + 1));
	return "{" + parts.join(",") + "}";
}

function requestDigest(request) {
	return (
		"sha256:" +
		createHash("sha256").update(REQUEST_DIGEST_DOMAIN).update("\0").update(canonicalJson(request)).digest("hex")
	);
}

function isId(value) {
	return typeof value === "string" && value.length >= 1 && value.length <= 128;
}

function requestProblem(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return "request must be a JSON object";
	if (value.kind === "start_task") {
		if (!isId(value.taskId)) return "request.taskId must be a bounded id";
		if (typeof value.prompt !== "string" || value.prompt.length > MAX_PROMPT_CHARS) return "request.prompt must be a bounded string";
		return undefined;
	}
	if (value.kind === "steer") {
		if (!isId(value.taskId)) return "request.taskId must be a bounded id";
		if (typeof value.text !== "string" || value.text.length === 0 || value.text.length > MAX_PROMPT_CHARS) return "request.text must be a bounded string";
		return undefined;
	}
	if (value.kind === "cancel_task") {
		if (!isId(value.taskId)) return "request.taskId must be a bounded id";
		return undefined;
	}
	return "request.kind must be start_task, steer, or cancel_task";
}

function fieldsProblem(value, allowed) {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) return "unexpected field: " + key;
	}
	return undefined;
}

// --- ordered event log -------------------------------------------------------

let nextSequence = 1;
let acknowledgedSequence = 0;
const events = [];

function recordEvent(input) {
	if (events.length >= MAX_RETAINED_EVENTS) {
		events.splice(0, events.length - MAX_RETAINED_EVENTS + 1);
	}
	const event = { sequence: nextSequence++, ...input };
	events.push(event);
	try {
		const fd = openSync(eventsPath, "a", 0o600);
		try {
			writeSync(fd, canonicalJson(event) + "\n");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		log("event persistence failed: " + error.message);
	}
	broadcastEvent(event);
	return event;
}

function eventsAfter(sequence, limit) {
	const out = [];
	for (const event of events) {
		if (event.sequence > sequence) {
			out.push(event);
			if (out.length >= limit) break;
		}
	}
	return out;
}

function firstRetainedSequence() {
	return events.length === 0 ? 1 : events[0].sequence;
}

function tailSequence() {
	return events.length === 0 ? 0 : events[events.length - 1].sequence;
}

// --- command journal ---------------------------------------------------------
// Deduplication is in-memory: it lives exactly as long as this bridge process,
// which owns the whole task lifetime. journal.ndjson is an append-only audit
// trail (and the receipt source for get_command replay), never a restart log.

const journal = new Map();

function appendJournal(record) {
	try {
		const fd = openSync(journalPath, "a", 0o600);
		try {
			writeSync(fd, canonicalJson(record) + "\n");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		log("journal persistence failed: " + error.message);
	}
}

function admitCommand(commandId, request) {
	const digest = requestDigest(request);
	const now = new Date().toISOString();
	const existing = journal.get(commandId);
	if (existing !== undefined) {
		if (existing.digest !== digest) return { conflict: true };
		return { receipt: existing };
	}
	const receipt = {
		commandId,
		digest,
		state: "accepted",
		submittedAt: now,
		updatedAt: now,
		uncertain: false,
	};
	journal.set(commandId, receipt);
	appendJournal({ kind: "admit", receipt });
	recordEvent({ kind: "command_accepted", recordedAt: now, receipt: { ...receipt } });
	return { receipt };
}

function updateReceipt(commandId, mutator) {
	const receipt = journal.get(commandId);
	if (receipt === undefined) return;
	mutator(receipt);
	receipt.updatedAt = new Date().toISOString();
	appendJournal({ kind: "update", receipt: { ...receipt } });
	recordEvent({ kind: "command_state", recordedAt: receipt.updatedAt, receipt: { ...receipt } });
}

// --- task supervision -------------------------------------------------------

let status = "starting";
const queue = [];
let activeTask = null;
let lastOutcome = "completed";
let finalizing = false;

function setStatus(next) {
	if (status === next) return;
	status = next;
	recordEvent({ kind: "session_status", recordedAt: new Date().toISOString(), status: next });
}

function readCredential() {
	try {
		return readFileSync(authPath, "utf8").trim();
	} catch {
		return undefined;
	}
}

class OutputBatcher {
	constructor(taskId, stream, fd) {
		this.taskId = taskId;
		this.stream = stream;
		this.fd = fd;
		this.pending = "";
		this.timer = null;
	}
	append(text) {
		try {
			const bytes = Buffer.from(text, "utf8");
			if (bytes.byteLength > 0) writeSync(this.fd, bytes);
		} catch (error) {
			log("stream write failed: " + error.message);
		}
		this.pending += text;
		if (this.pending.length >= MAX_OUTPUT_CHARS) this.flush();
		else if (this.timer === null) this.timer = setTimeout(() => this.flush(), flushMs);
	}
	flush() {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		while (this.pending.length > 0) {
			const text = this.pending.slice(0, MAX_OUTPUT_CHARS);
			this.pending = this.pending.slice(MAX_OUTPUT_CHARS);
			recordEvent({
				kind: "output_delta",
				recordedAt: new Date().toISOString(),
				taskId: this.taskId,
				stream: this.stream,
				text,
			});
		}
	}
	close() {
		this.flush();
	}
}

/**
 * Signal a task child's whole process group. Each task child is spawned
 * detached so it leads its own group: agents spawn helper children (fork
 * servers, kernels) that ignore a lone parent signal, and only a group
 * signal reliably terminates the subtree.
 */
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

function startChild(taskId, promptText, truncate) {
	const args = [];
	if (model !== "") args.push("--model", model);
	args.push("--print", promptText);
	const credential = readCredential();
	const childEnv = { ...process.env };
	if (credential !== undefined) childEnv.PRIME_API_KEY = credential;
	const child = spawn(agentBin, args, {
		cwd: workspaceDir,
		env: childEnv,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	const stdout = new OutputBatcher(taskId, "stdout", openSync(stdoutPath, truncate ? "w" : "a"));
	const stderr = new OutputBatcher(taskId, "stderr", openSync(stderrPath, truncate ? "w" : "a"));
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => stdout.append(chunk));
	child.stderr.on("data", (chunk) => stderr.append(chunk));
	return { child, stdout, stderr };
}

async function runTask(taskId, promptText, commandId, truncate) {
	if (!truncate) {
		for (const path of [stdoutPath, stderrPath]) {
			const fd = openSync(path, "a");
			try {
				writeSync(fd, "\n=== task " + taskId + " ===\n");
			} finally {
				closeSync(fd);
			}
		}
	}
	const run = startChild(taskId, promptText, truncate);
	activeTask = { taskId, commandId, child: run.child, cancelled: false, cancelCommandId: undefined };
	if (commandId !== undefined) {
		updateReceipt(commandId, (receipt) => {
			receipt.state = "running";
		});
	}
	setStatus("busy");
	log("task " + taskId + " started" + (commandId !== undefined ? " (command " + commandId + ")" : ""));
	let exitCode = null;
	try {
		exitCode = await new Promise((resolve, reject) => {
			run.child.once("error", reject);
			run.child.once("close", (code) => resolve(code));
		});
	} catch (error) {
		log("task " + taskId + " failed to spawn: " + error.message);
		exitCode = 127;
	}
	run.stdout.close();
	run.stderr.close();
	const cancelled = activeTask !== null && activeTask.cancelled;
	const cancelCommandId = activeTask !== null ? activeTask.cancelCommandId : undefined;
	activeTask = null;
	const outcome = cancelled ? "stopped" : exitCode === 0 ? "completed" : "failed";
	lastOutcome = outcome;
	if (cancelled && cancelCommandId !== undefined) {
		// The cancellation's own receipt confirms only after the task actually stopped.
		updateReceipt(cancelCommandId, (receipt) => {
			receipt.state = "cancelled";
		});
	}
	if (commandId !== undefined) {
		updateReceipt(commandId, (receipt) => {
			if (cancelled) receipt.state = "cancelled";
			else if (outcome === "completed") receipt.state = "completed";
			else {
				receipt.state = "failed";
				receipt.error = "agent exited with code " + String(exitCode);
			}
		});
	}
	log("task " + taskId + " finished: " + outcome + " (exit " + String(exitCode) + ")");
}

function cancelTask(taskId, commandId) {
	if (activeTask !== null && activeTask.taskId === taskId) {
		activeTask.cancelled = true;
		activeTask.cancelCommandId = commandId;
		signalProcessGroup(activeTask.child, "SIGTERM");
		setTimeout(() => {
			if (activeTask !== null && activeTask.cancelled) {
				signalProcessGroup(activeTask.child, "SIGKILL");
			}
		}, CANCEL_GRACE_MS).unref();
		return true;
	}
	const index = queue.findIndex((item) => item.taskId === taskId);
	if (index >= 0) {
		const removed = queue.splice(index, 1)[0];
		if (removed.commandId !== undefined) {
			updateReceipt(removed.commandId, (receipt) => {
				receipt.state = "cancelled";
			});
		}
		return true;
	}
	return false;
}

function enqueueSteer(commandId, taskId, text) {
	if (queue.length >= MAX_QUEUED_COMMANDS) {
		updateReceipt(commandId, (receipt) => {
			receipt.state = "failed";
			receipt.error = "steer queue is full";
		});
		return;
	}
	queue.push({ taskId, commandId, promptText: text });
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

async function supervise() {
	const initialPrompt = readFileSync(promptPath, "utf8");
	if (initialPrompt.length === 0) throw new Error("empty initial prompt");
	await runTask("task_initial", initialPrompt, undefined, true);
	while (queue.length > 0 && !finalizing) {
		const next = queue.shift();
		await runTask(next.taskId, next.promptText, next.commandId, false);
	}
	await finalize(lastOutcome);
}

let finalized = false;
async function finalize(outcome) {
	if (finalized) return;
	finalized = true;
	setStatus("stopping");
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
	setStatus(outcome === "failed" ? "failed" : "stopped");
	// The terminal status is the commit marker and therefore lands last.
	appendFileSync(statusPath + ".tmp", outcome + "\n");
	rmSync(statusPath, { force: true });
	renameSync(statusPath + ".tmp", statusPath);
	for (const client of clients) client.closeSoon(CLOSE_NORMAL, "session complete");
	server.close();
	setTimeout(() => process.exit(0), 1000).unref();
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
		this.fragments = null;
		this.authenticated = false;
		this.subscribed = false;
		this.closed = false;
		this.destroyed = false;
		this.lastSentSequence = 0;
		this.helloTimer = setTimeout(() => {
			if (!this.authenticated) this.closeSoon(CLOSE_POLICY, "hello timeout");
		}, HELLO_TIMEOUT_MS);
		this.pingTimer = setInterval(() => this.sendFrame(9, Buffer.alloc(0)), PING_INTERVAL_MS);
		clients.add(this);
		socket.on("data", (chunk) => this.onData(chunk));
		socket.on("error", () => this.destroy());
		socket.on("close", () => this.onDestroy());
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

	sendText(text) {
		const bytes = Buffer.from(text, "utf8");
		if (bytes.byteLength > MAX_MESSAGE_BYTES) {
			this.closeSoon(CLOSE_TOO_BIG, "message too large");
			return;
		}
		this.sendFrame(1, bytes);
	}

	sendJson(message) {
		this.sendText(canonicalJson(message));
	}

	onMessage(payload) {
		const text = payload.toString("utf8");
		if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
			this.closeSoon(CLOSE_TOO_BIG, "message too large");
			return;
		}
		let value;
		try {
			value = JSON.parse(text);
		} catch {
			this.closeSoon(CLOSE_PROTOCOL, "invalid JSON");
			return;
		}
		try {
			this.handleMessage(value);
		} catch (error) {
			log("message handling failed: " + error.message);
			this.closeSoon(CLOSE_PROTOCOL, "unhandled message");
		}
	}

	handleMessage(value) {
		if (value === null || typeof value !== "object") throw new Error("not an object");
		switch (value.type) {
			case "hello":
				return this.handleHello(value);
			case "subscribe":
				return this.handleSubscribe(value);
			case "submit":
				return this.handleSubmit(value);
			case "get_command":
				return this.handleGetCommand(value);
			case "ack":
				return this.handleAck(value);
			default:
				throw new Error("unsupported message type " + String(value.type));
		}
	}

	handleHello(value) {
		const problem =
			fieldsProblem(value, ["type", "protocolVersion", "generation", "clientId", "sessionId", "authToken", "cursor", "capabilities"]) ||
			(value.protocolVersion !== PROTOCOL_VERSION ? "hello.protocolVersion must equal " + String(PROTOCOL_VERSION) : undefined) ||
			(Number.isInteger(value.generation) && value.generation >= 1 ? undefined : "hello.generation must be a positive integer") ||
			(isId(value.clientId) ? undefined : "hello.clientId must be a bounded id") ||
			(value.sessionId === sessionId ? undefined : "hello.sessionId does not match this session") ||
			(typeof value.authToken === "string" && value.authToken.length > 0 && value.authToken.length <= MAX_TOKEN_CHARS
				? undefined
				: "hello.authToken is required");
		if (problem !== undefined) {
			log("hello rejected: " + problem);
			this.closeSoon(CLOSE_POLICY, "hello rejected");
			return;
		}
		if (value.generation !== generation) {
			log("hello fenced: generation " + String(value.generation) + " vs " + String(generation));
			this.closeSoon(CLOSE_POLICY, "stale generation");
			return;
		}
		const token = Buffer.from(String(value.authToken), "utf8");
		const expected = Buffer.from(bridgeToken, "utf8");
		if (token.byteLength !== expected.byteLength || !timingSafeEqual(token, expected)) {
			log("hello rejected: invalid auth token");
			this.closeSoon(CLOSE_POLICY, "invalid auth token");
			return;
		}
		clearTimeout(this.helloTimer);
		this.authenticated = true;
		this.sendJson(snapshotMessage(this));
	}

	handleSubscribe(value) {
		if (!this.authenticated) return this.closeSoon(CLOSE_POLICY, "not authenticated");
		const problem =
			fieldsProblem(value, ["type", "sessionId", "cursor"]) ||
			(value.sessionId === sessionId ? undefined : "subscribe.sessionId does not match this session");
		if (problem !== undefined) return this.closeSoon(CLOSE_PROTOCOL, problem);
		const cursor = value.cursor;
		if (
			cursor === null ||
			typeof cursor !== "object" ||
			!Number.isInteger(cursor.sequence) ||
			cursor.sequence < 0 ||
			cursor.generation !== generation
		) {
			return this.closeSoon(CLOSE_PROTOCOL, "invalid subscribe cursor");
		}
		if (cursor.sequence + 1 < firstRetainedSequence()) {
			// The retained window moved past the cursor: the client must resnapshot.
			this.subscribed = true;
			this.lastSentSequence = tailSequence();
			this.sendJson(snapshotMessage(this));
			return;
		}
		if (cursor.sequence > tailSequence()) {
			return this.closeSoon(CLOSE_PROTOCOL, "cursor beyond the event tail");
		}
		this.lastSentSequence = cursor.sequence;
		this.subscribed = true;
		this.sendDue();
	}

	/** Drain all retained events past the client cursor in bounded batches. */
	sendDue() {
		for (;;) {
			const due = eventsAfter(this.lastSentSequence, MAX_SNAPSHOT_EVENTS);
			if (due.length === 0) break;
			const batch = [];
			let bytes = 0;
			for (const event of due) {
				const size = canonicalJson(event).length + 1;
				if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
				batch.push(event);
				bytes += size;
			}
			this.sendJson({ type: "events", sessionId, generation, events: batch });
			this.lastSentSequence = batch[batch.length - 1].sequence;
			if (batch.length < due.length || batch.length >= MAX_SNAPSHOT_EVENTS) continue;
			break;
		}
	}

	handleSubmit(value) {
		if (!this.authenticated) return this.closeSoon(CLOSE_POLICY, "not authenticated");
		const problem =
			fieldsProblem(value, ["type", "sessionId", "generation", "commandId", "request", "digest"]) ||
			(value.sessionId === sessionId ? undefined : "submit.sessionId does not match this session") ||
			(value.generation === generation ? undefined : "submit.generation does not match this session") ||
			(isId(value.commandId) ? undefined : "submit.commandId must be a bounded id") ||
			requestProblem(value.request);
		if (problem !== undefined) return this.closeSoon(CLOSE_PROTOCOL, problem);
		if (requestDigest(value.request) !== value.digest) {
			return this.closeSoon(CLOSE_PROTOCOL, "submit.digest does not match the request");
		}
		const admitted = admitCommand(value.commandId, value.request);
		if (admitted.conflict) return this.closeSoon(CLOSE_PROTOCOL, "command id reused with a different request");
		const request = value.request;
		if (request.kind === "steer") {
			enqueueSteer(value.commandId, request.taskId, request.text);
		} else if (request.kind === "cancel_task") {
			if (!cancelTask(request.taskId, value.commandId)) {
				updateReceipt(value.commandId, (receipt) => {
					receipt.state = "failed";
					receipt.error = "unknown task " + request.taskId;
				});
			}
		} else {
			updateReceipt(value.commandId, (receipt) => {
				receipt.state = "failed";
				receipt.error = "start_task is not accepted over the tunnel bridge";
			});
		}
		this.sendJson({ type: "command", sessionId, generation, receipt: { ...journal.get(value.commandId) } });
	}

	handleGetCommand(value) {
		if (!this.authenticated) return this.closeSoon(CLOSE_POLICY, "not authenticated");
		const problem =
			fieldsProblem(value, ["type", "sessionId", "generation", "commandId", "claim"]) ||
			(value.sessionId === sessionId ? undefined : "get_command.sessionId does not match this session") ||
			(value.generation === generation ? undefined : "get_command.generation does not match this session");
		if (problem !== undefined) return this.closeSoon(CLOSE_PROTOCOL, problem);
		if (value.claim === true) return this.closeSoon(CLOSE_PROTOCOL, "executor claims are not accepted over the tunnel bridge");
		const receipt = journal.get(value.commandId);
		if (receipt === undefined) return this.closeSoon(CLOSE_PROTOCOL, "unknown command");
		this.sendJson({ type: "command", sessionId, generation, receipt: { ...receipt } });
	}

	handleAck(value) {
		if (!this.authenticated) return this.closeSoon(CLOSE_POLICY, "not authenticated");
		const problem =
			fieldsProblem(value, ["type", "sessionId", "cursor"]) ||
			(value.sessionId === sessionId ? undefined : "ack.sessionId does not match this session");
		if (problem !== undefined) return this.closeSoon(CLOSE_PROTOCOL, problem);
		const cursor = value.cursor;
		if (
			cursor === null ||
			typeof cursor !== "object" ||
			!Number.isInteger(cursor.sequence) ||
			cursor.sequence < 0 ||
			cursor.generation !== generation
		) {
			return this.closeSoon(CLOSE_PROTOCOL, "invalid ack cursor");
		}
		if (cursor.sequence > tailSequence()) {
			return this.closeSoon(CLOSE_PROTOCOL, "ack beyond the event tail");
		}
		if (cursor.sequence > acknowledgedSequence) {
			acknowledgedSequence = cursor.sequence;
			// Trim acknowledged history once the retained window grows past cap.
			while (events.length > MAX_RETAINED_EVENTS && events[0].sequence <= acknowledgedSequence) {
				events.shift();
			}
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
		clients.delete(this);
	}
}

function snapshotMessage(client) {
	// The snapshot tail is bounded by both event count and encoded bytes; the
	// client's subscribe drains anything older that did not fit.
	const bounded = [];
	let bytes = 0;
	for (let index = events.length - 1; index >= 0 && bounded.length < MAX_SNAPSHOT_EVENTS; index--) {
		const size = canonicalJson(events[index]).length + 1;
		if (bounded.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
		bounded.unshift(events[index]);
		bytes += size;
	}
	return {
		type: "snapshot",
		sessionId,
		generation,
		cursor: { generation, sequence: tailSequence() },
		status,
		state: {
			cwd: workspaceDir,
			modelId: model === "" ? "image-default" : model,
			...(activeTask !== null && activeTask.commandId !== undefined ? { activeCommandId: activeTask.commandId } : {}),
			queuedCommandIds: queue.filter((item) => item.commandId !== undefined).map((item) => item.commandId),
		},
		events: bounded,
	};
}

function broadcastEvent(_event) {
	for (const client of clients) {
		if (client.subscribed && client.authenticated && !client.closed) client.sendDue();
	}
}

const server = http.createServer((request, response) => {
	if ((request.method || "GET") === "GET" && (request.url || "/") === "/") {
		const body = canonicalJson({
			ok: true,
			protocol: PROTOCOL_NAME,
			protocolVersion: PROTOCOL_VERSION,
			sessionId,
			generation,
			status,
			task: activeTask === null ? null : activeTask.taskId,
			queued: queue.length,
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
	new WsClient(socket);
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
	log("SIGTERM: cancelling the active task and finalizing as stopped");
	if (activeTask !== null) {
		activeTask.cancelled = true;
		signalProcessGroup(activeTask.child, "SIGTERM");
		setTimeout(() => {
			if (activeTask !== null && activeTask.cancelled) {
				signalProcessGroup(activeTask.child, "SIGKILL");
			}
		}, CANCEL_GRACE_MS).unref();
	}
	finalizing = true;
	lastOutcome = "stopped";
});

supervise().catch(async (error) => {
	log("bridge failed: " + error.message);
	try {
		await finalize("failed");
	} catch {
		// finalize already wrote what it could; the exit code still reports failure.
	}
	process.exitCode = 1;
});
`;
