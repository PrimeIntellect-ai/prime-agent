// Serialize the IPython kernel's user namespace so it can be revived when a
// session resumes. The kernel is otherwise spawned fresh on resume, leaving the
// model believing it still has access to variables/imports it defined earlier.
//
// Snapshotting is best-effort and per-variable: each top-level name is pickled
// with `dill` independently, so a single unpicklable object (open file, socket,
// GPU tensor, …) is skipped and reported rather than aborting the whole snapshot.
import { join } from "node:path";

/** Default ceiling on a snapshot payload. Over-cap variables are skipped + reported. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;
/** Default ceiling for one serialized variable. */
export const DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES = 16 * 1024 * 1024;

/** Base filename for the kernel snapshot within a session's artifact directory. */
const KERNEL_STATE_BASENAME = "kernel-state";

/** Marker the Python helpers print so the host can recover the JSON result line. */
const RESULT_MARKER = "__PRIME_AGENT_KERNEL_STATE__";

export interface SnapshotResult {
	/** Top-level names successfully serialized into the payload. */
	saved: string[];
	/** Names that could not be serialized, with a short reason. */
	skipped: { name: string; reason: string }[];
	/** Oversized live variables removed by an explicit compaction snapshot. */
	pruned?: string[];
	/** Payload size on disk, in bytes. */
	bytes: number;
	path: string;
}

export interface RestoreResult {
	/** Names successfully revived into the kernel namespace. */
	restored: string[];
	/** Names present in the snapshot that failed to revive, with a short reason. */
	failed: { name: string; reason: string }[];
	path: string;
}

/** Absolute path to the dill payload within a session's artifact directory. */
export function snapshotPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.dill`);
}

/** Absolute path to the JSON manifest within a session's artifact directory. */
export function manifestPathIn(artifactDir: string): string {
	return join(artifactDir, `${KERNEL_STATE_BASENAME}.json`);
}

/** Render a JS string as a Python string literal (JSON's escaping is a valid subset). */
function pyStr(value: string): string {
	return JSON.stringify(value);
}

/**
 * Python that serializes the user namespace to `outPath` (atomic write) and a
 * sibling `.json` manifest, then prints a single marker line with the result.
 */
export function buildSnapshotCode(
	outPath: string,
	manifestPath: string,
	maxBytes: number,
	maxVariableBytes = DEFAULT_SNAPSHOT_MAX_VARIABLE_BYTES,
	pruneOversized = false,
): string {
	// All builtins are sourced via the locally-imported _b alias so the helper keeps
	// working even when the user namespace shadows names like list/open/print/len.
	return `
def _prime_agent_snapshot_state():
    import builtins as _b, io, json, os, sys, datetime
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "dill unavailable: " + _b.str(_err)}))
        return
    dill.settings["recurse"] = True

    ip = None
    try:
        ip = get_ipython()  # noqa: F821 (injected by IPython)
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {}) or {}) if ip is not None else _b.set()
    # rlm, mcp, and asyncio are re-created by the kernel bootstrap on every
    # start; never snapshot them.
    always_skip = {"rlm", "mcp", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}

    class SnapshotSizeLimitExceeded(_b.Exception):
        pass

    class SnapshotBuffer(io.BytesIO):
        def __init__(self, limit):
            io.BytesIO.__init__(self)
            self.limit = limit

        def write(self, chunk):
            if self.tell() + _b.len(chunk) > self.limit:
                raise SnapshotSizeLimitExceeded()
            return io.BytesIO.write(self, chunk)

    payload = {}
    skipped = []
    oversized = []
    total = 0
    identify_oversized = ${pruneOversized ? "True" : "False"}
    for name in _b.list(ns.keys()):
        # Skip internals (dunder/underscore), IPython-injected names, and live
        # handles. A name matching a builtin (e.g. "list") is a user shadow worth
        # keeping — builtins themselves are not enumerated as user_ns keys.
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        value = ns[name]
        remaining = ${maxBytes} - total
        buffer_limit = ${maxVariableBytes} if identify_oversized else _b.min(${maxVariableBytes}, remaining)
        buffer = SnapshotBuffer(buffer_limit)
        # Modules are pickled by reference and re-imported on restore.
        try:
            dill.dump(value, buffer)
            blob = buffer.getvalue()
        except SnapshotSizeLimitExceeded:
            if not identify_oversized and remaining < ${maxVariableBytes}:
                skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            else:
                skipped.append({"name": name, "reason": "exceeds per-variable snapshot size cap"})
                oversized.append(name)
            continue
        except _b.Exception as _err:
            skipped.append({"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
            continue
        if total + _b.len(blob) > ${maxBytes}:
            skipped.append({"name": name, "reason": "exceeds aggregate snapshot size cap"})
            continue
        payload[name] = blob
        total += _b.len(blob)

    os.makedirs(os.path.dirname(${pyStr(outPath)}), exist_ok=True)
    tmp = ${pyStr(outPath)} + ".tmp"
    try:
        with _b.open(tmp, "wb") as fh:
            dill.dump(payload, fh)
        os.replace(tmp, ${pyStr(outPath)})
    except _b.Exception as _err:
        try:
            os.remove(tmp)
        except _b.Exception:
            pass
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "write failed: " + _b.str(_err)}))
        return

    bytes_written = os.path.getsize(${pyStr(outPath)})
    saved = _b.sorted(payload.keys())
    pruned = _b.sorted(name for name in oversized if name in ns) if ${pruneOversized ? "True" : "False"} else []
    manifest = {
        "version": 1,
        "savedNames": saved,
        "skipped": skipped,
        "pruned": pruned,
        "bytes": bytes_written,
        "pythonVersion": sys.version.split()[0],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    try:
        with _b.open(${pyStr(manifestPath)}, "w") as fh:
            json.dump(manifest, fh)
    except _b.Exception:
        pass
    pruned_ids = {_b.id(ns[name]) for name in pruned}
    while True:
        try:
            for name in pruned:
                if name in ns:
                    del ns[name]
            output_cache = ns.get("Out")
            if _b.isinstance(output_cache, _b.dict):
                for key in _b.list(output_cache.keys()):
                    if _b.id(output_cache[key]) in pruned_ids:
                        del output_cache[key]
            for name in hidden:
                if name in ns and _b.id(ns[name]) in pruned_ids:
                    del ns[name]
            break
        except _b.KeyboardInterrupt:
            # Deletion is idempotent. Finish the short critical section so a
            # snapshot timeout cannot leave only some purge candidates live.
            continue
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"saved": saved, "skipped": skipped, "pruned": pruned, "bytes": bytes_written}))


try:
    _prime_agent_snapshot_state()
finally:
    del _prime_agent_snapshot_state
`.trim();
}

/**
 * Python that loads the payload at `inPath` (if present) into the user namespace,
 * reviving each name independently, then prints a single marker line with the result.
 * Tolerant of a missing or corrupt file: reports an empty restore, never raises.
 */
export function buildRestoreCode(inPath: string): string {
	// Builtins via the local _b alias so a shadowed name in the user namespace
	// (list/open/print/…) can't break the restore path.
	return `
def _prime_agent_restore_state():
    import builtins as _b, json, os, sys
    if not os.path.exists(${pyStr(inPath)}):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": []}))
        return
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "dill unavailable: " + _b.str(_err)}))
        return

    try:
        with _b.open(${pyStr(inPath)}, "rb") as fh:
            payload = dill.load(fh)
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "load failed: " + _b.str(_err)}))
        return
    if not _b.isinstance(payload, _b.dict):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "corrupt snapshot: not a dict"}))
        return

    ip = None
    try:
        ip = get_ipython()  # noqa: F821
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()

    restored = []
    failed = []
    for name, blob in payload.items():
        try:
            ns[name] = dill.loads(blob)
            restored.append(name)
        except _b.Exception as _err:
            failed.append({"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": _b.sorted(restored), "failed": failed}))


try:
    _prime_agent_restore_state()
finally:
    del _prime_agent_restore_state
`.trim();
}

/** Marker-line list of live user-defined names, filtered like the snapshot. Never raises. */
export function buildListNamesCode(): string {
	return `
def _prime_agent_list_state_names():
    import builtins as _b, json
    ip = None
    try:
        ip = get_ipython()  # noqa: F821 (injected by IPython)
    except _b.Exception:
        ip = None
    ns = ip.user_ns if ip is not None else _b.globals()
    hidden = _b.set(_b.getattr(ip, "user_ns_hidden", {}) or {}) if ip is not None else _b.set()
    always_skip = {"rlm", "mcp", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
    names = []
    for name in _b.list(ns.keys()):
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        names.append(name)
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"names": _b.sorted(names)}))


try:
    _prime_agent_list_state_names()
finally:
    del _prime_agent_list_state_names
`.trim();
}

interface RawListNames {
	names?: unknown;
	error?: unknown;
}

interface RawSnapshot {
	saved?: unknown;
	skipped?: unknown;
	pruned?: unknown;
	bytes?: unknown;
	error?: unknown;
}

interface RawRestore {
	restored?: unknown;
	failed?: unknown;
	error?: unknown;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
			const { name, reason } = entry as { name: string; reason?: unknown };
			return [{ name, reason: typeof reason === "string" ? reason : "" }];
		}
		return [];
	});
}

/** Pull the marker line out of cell stdout and parse it, or null if absent/invalid. */
function parseMarkerLine<T>(stdout: string): T | null {
	const index = stdout.lastIndexOf(RESULT_MARKER);
	if (index === -1) return null;
	const rest = stdout.slice(index + RESULT_MARKER.length);
	const line = rest.split("\n", 1)[0]?.trim();
	if (!line) return null;
	try {
		return JSON.parse(line) as T;
	} catch {
		return null;
	}
}

export function parseSnapshotResult(stdout: string, path: string): SnapshotResult | null {
	const raw = parseMarkerLine<RawSnapshot>(stdout);
	if (!raw || raw.error) return null;
	const pruned = asStringArray(raw.pruned);
	return {
		saved: asStringArray(raw.saved),
		skipped: asReasonArray(raw.skipped),
		pruned: pruned.length > 0 ? pruned : undefined,
		bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
		path,
	};
}

export function parseRestoreResult(stdout: string, path: string): RestoreResult | null {
	const raw = parseMarkerLine<RawRestore>(stdout);
	if (!raw || raw.error) return null;
	return {
		restored: asStringArray(raw.restored),
		failed: asReasonArray(raw.failed),
		path,
	};
}

/** Sorted list of live user-defined names, or null if the marker was absent/invalid. */
export function parseListNamesResult(stdout: string): string[] | null {
	const raw = parseMarkerLine<RawListNames>(stdout);
	if (!raw || raw.error) return null;
	return asStringArray(raw.names);
}
