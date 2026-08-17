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

/** Base filename for the kernel snapshot within a session's artifact directory. */
const KERNEL_STATE_BASENAME = "kernel-state";

/** Marker the Python helpers print so the host can recover the JSON result line. */
const RESULT_MARKER = "__PRIME_AGENT_KERNEL_STATE__";

export interface SnapshotResult {
	/** Top-level names successfully serialized into the payload. */
	saved: string[];
	/** Names that could not be serialized, with a short reason. */
	skipped: { name: string; reason: string }[];
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
export function buildSnapshotCode(outPath: string, manifestPath: string, maxBytes: number): string {
	// All builtins are sourced via the locally-imported _b alias so the helper keeps
	// working even when the user namespace shadows names like list/open/print/len.
	return `
def _prime_agent_snapshot_state():
    import builtins as _b, json, os, stat, sys, datetime
    if not _b.hasattr(os, "O_NOFOLLOW"):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "O_NOFOLLOW unavailable"}))
        return
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
    # rlm and asyncio are re-created by the kernel bootstrap on every start;
    # never snapshot them.
    always_skip = {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}

    payload = {}
    skipped = []
    total = 0
    for name in _b.list(ns.keys()):
        # Skip internals (dunder/underscore), IPython-injected names, and live
        # handles. A name matching a builtin (e.g. "list") is a user shadow worth
        # keeping — builtins themselves are not enumerated as user_ns keys.
        if name.startswith("_") or name in hidden or name in always_skip:
            continue
        value = ns[name]
        # Modules are pickled by reference and re-imported on restore.
        try:
            blob = dill.dumps(value)
        except _b.Exception as _err:
            skipped.append({"name": name, "reason": _b.type(_err).__name__ + ": " + _b.str(_err)[:200]})
            continue
        if _b.len(blob) > ${maxBytes} or total + _b.len(blob) > ${maxBytes}:
            skipped.append({"name": name, "reason": "exceeds snapshot size cap"})
            continue
        payload[name] = blob
        total += _b.len(blob)

    out_dir = os.path.dirname(${pyStr(outPath)})
    if os.path.lexists(out_dir):
        out_dir_info = os.lstat(out_dir)
        if stat.S_ISLNK(out_dir_info.st_mode) or not stat.S_ISDIR(out_dir_info.st_mode):
            _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"error": "unsafe snapshot directory"}))
            return
    else:
        os.makedirs(out_dir, mode=0o700, exist_ok=False)
    tmp = ${pyStr(outPath)} + ".tmp." + _b.str(os.getpid()) + "." + os.urandom(8).hex()
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(tmp, flags, 0o600)
        with os.fdopen(fd, "wb") as fh:
            dill.dump(payload, fh)
            fh.flush()
            os.fsync(fh.fileno())
            if hasattr(os, "fchmod"):
                os.fchmod(fh.fileno(), 0o600)
        if os.path.lexists(${pyStr(outPath)}):
            out_info = os.lstat(${pyStr(outPath)})
            if stat.S_ISLNK(out_info.st_mode) or not stat.S_ISREG(out_info.st_mode):
                raise OSError("unsafe snapshot destination")
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
    manifest = {
        "version": 1,
        "savedNames": saved,
        "skipped": skipped,
        "bytes": bytes_written,
        "pythonVersion": sys.version.split()[0],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    manifest_tmp = None
    try:
        manifest_tmp = ${pyStr(manifestPath)} + ".tmp." + _b.str(os.getpid()) + "." + os.urandom(8).hex()
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(manifest_tmp, flags, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(manifest, fh)
            fh.flush()
            os.fsync(fh.fileno())
            if hasattr(os, "fchmod"):
                os.fchmod(fh.fileno(), 0o600)
        if os.path.lexists(${pyStr(manifestPath)}):
            manifest_info = os.lstat(${pyStr(manifestPath)})
            if stat.S_ISLNK(manifest_info.st_mode) or not stat.S_ISREG(manifest_info.st_mode):
                raise OSError("unsafe snapshot manifest")
        os.replace(manifest_tmp, ${pyStr(manifestPath)})
    except _b.Exception:
        try:
            if manifest_tmp is not None:
                os.remove(manifest_tmp)
        except _b.Exception:
            pass
    _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"saved": saved, "skipped": skipped, "bytes": bytes_written}))


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
    if not _b.hasattr(os, "O_NOFOLLOW"):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "O_NOFOLLOW unavailable"}))
        return
    if not os.path.lexists(${pyStr(inPath)}):
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": []}))
        return
    try:
        import dill
    except _b.Exception as _err:
        _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "dill unavailable: " + _b.str(_err)}))
        return

    try:
        import stat as _stat
        snapshot_stat = os.lstat(${pyStr(inPath)})
        if not _stat.S_ISREG(snapshot_stat.st_mode):
            _b.print(${pyStr(RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "error": "load failed: snapshot is not a regular file"}))
            return
        flags = os.O_RDONLY | os.O_NOFOLLOW
        fd = os.open(${pyStr(inPath)}, flags)
        with os.fdopen(fd, "rb") as fh:
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
    always_skip = {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open"}
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
	return {
		saved: asStringArray(raw.saved),
		skipped: asReasonArray(raw.skipped),
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
