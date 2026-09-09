import { Worker } from "node:worker_threads";

export const MAX_TRACE_BYTES = 20 * 1024 * 1024;

export interface TraceFileSignature {
	size: number;
	mtimeMs: number;
	ino: number;
	dev: number;
}

export interface TracePayload {
	body: ArrayBuffer;
	sessionId: string;
	traceId: string;
	parentSessionId?: string;
	cwd: string;
	gitRepo?: string;
	gitCommit?: string;
	signature: TraceFileSignature;
}

// A data URL keeps the worker available in both the bundled CLI and the source distribution.
// All transcript parsing, copying, and snapshot I/O stays off the agent's event loop.
const PAYLOAD_WORKER = String.raw`
import { parentPort, workerData } from "node:worker_threads";
import { open, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const signature = stats => ({ size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev });
const equal = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
const header = body => {
  let parsed;
  try { parsed = JSON.parse(body.subarray(0, body.indexOf(10) < 0 ? body.length : body.indexOf(10)).toString("utf8")); } catch {
    // Invalid JSON is rejected by the shared header validation below.
  }
  if (!record(parsed) || parsed.type !== "session" || typeof parsed.id !== "string" || typeof parsed.cwd !== "string" || typeof parsed.timestamp !== "string") throw new Error("invalid_session");
  return parsed;
};
const firstHeader = async path => {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return header(buffer.subarray(0, bytesRead));
  } finally { await file.close(); }
};
try {
  const { sessionFile, expected, snapshotPath, snapshotReady, maxBytes } = workerData;
  let body, sourceSignature;
  if (snapshotReady) {
    body = await readFile(snapshotPath);
    if (body.length !== expected.size) throw new Error("snapshot_changed");
    sourceSignature = expected;
  } else {
    const file = await open(sessionFile, "r");
    try {
      const before = signature(await file.stat());
      if (before.size > maxBytes) throw new Error("too_large");
      if (before.size === 0) throw new Error("empty_session");
      if (expected && !equal(expected, before)) throw new Error("snapshot_changed");
      body = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < body.length) {
        const { bytesRead } = await file.read(body, offset, body.length - offset, offset);
        if (!bytesRead) throw new Error("snapshot_changed");
        offset += bytesRead;
      }
      if (!equal(before, signature(await file.stat()))) throw new Error("snapshot_changed");
      sourceSignature = before;
    } finally { await file.close(); }
  }
  if (body.length > maxBytes) throw new Error("too_large");
  const currentHeader = header(body);
  let traceId = currentHeader.id, parentSessionId, currentFile = sessionFile, current = currentHeader;
  for (let depth = 0; depth < 32 && typeof current.parentSession === "string"; depth++) {
    const parentPath = resolve(dirname(currentFile), current.parentSession);
    let parent;
    try { parent = await firstHeader(parentPath); } catch { break; }
    if (depth === 0) parentSessionId = parent.id;
    traceId = parent.id;
    currentFile = parentPath;
    current = parent;
  }
  const byId = new Map();
  let leaf;
  for (const line of body.toString("utf8").split("\n")) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!record(entry) || entry.type === "session" || typeof entry.id !== "string") continue;
    byId.set(entry.id, { parentId: entry.parentId, type: entry.type, git: entry.git });
    leaf = entry.id;
  }
  let git = currentHeader.git;
  current = byId.get(leaf);
  for (let depth = 0; current && depth <= byId.size; depth++) {
    if (current.type === "git_state" && record(current.git)) { git = current.git; break; }
    current = byId.get(current.parentId);
  }
  if (snapshotPath && !snapshotReady) {
    const temp = snapshotPath + ".tmp";
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, snapshotPath);
  }
  const bytes = Uint8Array.from(body);
  parentPort.postMessage({ payload: {
    body: bytes.buffer, sessionId: currentHeader.id, cwd: currentHeader.cwd, traceId, parentSessionId,
    gitRepo: typeof git?.repoUrl === "string" ? git.repoUrl : undefined,
    gitCommit: typeof git?.commit === "string" ? git.commit : undefined,
    signature: sourceSignature,
  } }, [bytes.buffer]);
} catch (error) {
  parentPort.postMessage({ error: error.code === "ENOENT" ? "no_session_file" : error.message });
}
`;

export function prepareTracePayload(options: {
	sessionFile: string;
	expected?: TraceFileSignature;
	snapshotPath?: string;
	snapshotReady?: boolean;
	signal: AbortSignal;
}): Promise<TracePayload> {
	return runTraceWorker<TracePayload>(
		PAYLOAD_WORKER,
		{ ...options, signal: undefined, maxBytes: MAX_TRACE_BYTES },
		options.signal,
	);
}

function runTraceWorker<T>(source: string, data: unknown, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { workerData: data });
		const finish = () => {
			signal.removeEventListener("abort", abort);
			void worker.terminate();
		};
		const abort = () => {
			finish();
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		worker.once("message", (message: { payload?: T; error?: string }) => {
			finish();
			if ("payload" in message) resolve(message.payload as T);
			else reject(new Error(message.error ?? "preparation_failed"));
		});
		worker.once("error", (error) => {
			finish();
			reject(error);
		});
		worker.once("exit", () => reject(new Error("preparation_failed")));
		worker.unref();
	});
}

const KEY_WORKER = String.raw`
import { parentPort, workerData } from "node:worker_threads";
import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
try {
 const command = workerData.slice(1);
 const options = { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true };
 let value;
 if (process.platform === "win32") {
  let shell = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean).map(root => root + "\\Git\\bin\\bash.exe").find(existsSync);
  if (!shell) { try { shell = execFileSync("where", ["bash.exe"], options).trim().split(/\r?\n/).find(existsSync); } catch {
    // Missing Git Bash falls back to the default shell below.
  } }
  if (shell) value = execFileSync(shell, ["-c", command], options);
 }
 if (value === undefined) value = execSync(command, options);
 parentPort.postMessage({ payload: value.trim() || undefined });
} catch { parentPort.postMessage({ payload: undefined }); }
`;

export async function resolveTraceKey(config: string | undefined, signal: AbortSignal): Promise<string | undefined> {
	if (!config) return undefined;
	if (!config.startsWith("!")) return (process.env[config] ?? config) || undefined;
	return runTraceWorker<string | undefined>(KEY_WORKER, config, signal);
}
