// Serialize the IPython kernel's user namespace so it can be revived when a
// session resumes. Durable metadata is deliberately limited to names, types,
// byte counts, digests, and artifact references; values and reprs never enter
// the manifest or checkpoint telemetry.
import { dirname, join } from "node:path";
import type { WorkflowArtifactRef } from "../workflow/contracts.js";

/** Default ceiling on inline durable snapshot bytes. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024;

/** Maximum number of retained metadata records in one checkpoint. */
export const DEFAULT_SNAPSHOT_MAX_RETAINED_VALUES = 256;

/** Base filename for the kernel snapshot within a session's artifact directory. */
const KERNEL_STATE_BASENAME = "kernel-state";

/** Marker the Python helpers print so the host can recover the JSON result line. */
export const KERNEL_STATE_RESULT_MARKER = "__PRIME_AGENT_KERNEL_STATE__";

/** Closed host classification for one retained kernel value. */
export type KernelSnapshotRetentionClass =
	| "durable_fact"
	| "artifact_ref"
	| "transient_tool_output"
	| "transient_dataframe"
	| "transient_log_tail"
	| "reproducible_cache";

/** Closed representation for one retained kernel value. */
export type KernelSnapshotRepresentation = "durable" | "transient" | "unavailable";

/** Metadata for a content-addressed externalized value. */
export type KernelSnapshotArtifactRef = WorkflowArtifactRef;

/** Host-safe metadata for one value considered during checkpointing. */
export interface KernelSnapshotRetainedValue {
	/** Top-level namespace name, never the value itself. */
	readonly valueId: string;
	/** Python type name, never a repr or serialized value. */
	readonly type: string;
	/** Serialized bytes represented by the value or artifact. */
	readonly bytes: number;
	readonly classification: KernelSnapshotRetentionClass;
	readonly required: boolean;
	readonly representation: KernelSnapshotRepresentation;
	/** SHA-256 of serialized bytes when durable, otherwise null. */
	readonly digest: string | null;
	readonly artifactRef: KernelSnapshotArtifactRef | null;
	/** Bounded reason code; never an exception repr. */
	readonly reason: string | null;
}

/** Largest durable value projection used by checkpoint telemetry. */
export interface KernelSnapshotLargestRetainedValue {
	readonly valueId: string;
	readonly type: string;
	readonly bytes: number;
	readonly classification: "durable_fact" | "artifact_ref";
}

/** Timing and budget metadata attached to a committed snapshot. */
export interface KernelSnapshotMetrics {
	readonly checkpointTurn: number;
	readonly serializationDurationMs: number;
	readonly previousCheckpointTurn: number | null;
	readonly previousDurableBytes: number | null;
	readonly durableBytes: number;
	readonly growthBytesPerTurn: number | null;
	readonly retainedValues: readonly KernelSnapshotRetainedValue[];
	readonly largestRetainedValues: readonly KernelSnapshotLargestRetainedValue[];
	readonly serializeStartedAtMonotonicMs: number;
	readonly serializeEndedAtMonotonicMs: number;
}

/** Configuration passed to the Python snapshot cell. */
export interface KernelSnapshotCodeOptions {
	/** Names omitted before calling dill.dumps. */
	readonly transientNames?: readonly string[];
	/** Host-owned names that never belong in a kernel checkpoint. */
	readonly hostOnlyNames?: readonly string[];
	/** Per-name transient classification for declared omissions. */
	readonly transientClassifications?: Readonly<Record<string, KernelSnapshotRetentionClass>>;
	/** Names whose large serialized values may be written to local CAS. */
	readonly reproducibleNames?: readonly string[];
	/** Names whose omission or serialization failure fails the checkpoint. */
	readonly requiredNames?: readonly string[];
	/** Root under which content-addressed kernel artifacts are stored. */
	readonly artifactRoot?: string;
	/** Monotonic checkpoint number supplied by the host. */
	readonly checkpointTurn?: number;
	/** Prior checkpoint turn used for bounded growth metadata. */
	readonly previousCheckpointTurn?: number | null;
	/** Prior durable byte count used for bounded growth metadata. */
	readonly previousDurableBytes?: number | null;
	/** Maximum retained metadata records. */
	readonly maxRetainedValues?: number;
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

/** Render a JSON-shaped value as Python source. */
function pyJson(value: unknown): string {
	return JSON.stringify(value);
}

/** Python that serializes the user namespace to an atomic payload and manifest. */
export function buildSnapshotCode(
	outPath: string,
	manifestPath: string,
	maxBytes: number,
	options: KernelSnapshotCodeOptions = {},
): string {
	const transientNames = [...new Set(options.transientNames ?? [])];
	const hostOnlyNames = [...new Set(options.hostOnlyNames ?? [])];
	const reproducibleNames = [...new Set(options.reproducibleNames ?? [])];
	const requiredNames = [...new Set(options.requiredNames ?? [])];
	const transientClassifications = options.transientClassifications ?? {};
	const artifactRoot = options.artifactRoot ?? join(dirname(outPath), "kernel-state-artifacts");
	const checkpointTurn = options.checkpointTurn ?? 1;
	const previousCheckpointTurn = options.previousCheckpointTurn ?? null;
	const previousDurableBytes = options.previousDurableBytes ?? null;
	const maxRetainedValues = options.maxRetainedValues ?? DEFAULT_SNAPSHOT_MAX_RETAINED_VALUES;

	// All builtins are sourced via the locally-imported _b alias so the helper keeps
	// working even when the user namespace shadows names like list/open/print/len.
	return `
def _prime_agent_snapshot_state():
    import builtins as _b, datetime, hashlib, json, os, sys, time
    try:
        import dill
    except _b.Exception:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "dill unavailable"}))
        return
    dill.settings["recurse"] = True
    _started = time.perf_counter()
    _checkpoint_turn = ${checkpointTurn}
    _previous_checkpoint_turn = ${previousCheckpointTurn === null ? "None" : previousCheckpointTurn}
    _previous_durable_bytes = ${previousDurableBytes === null ? "None" : previousDurableBytes}
    _max_bytes = ${maxBytes}
    _max_retained = ${maxRetainedValues}
    _transient_names = _b.set(${pyJson(transientNames)})
    _host_only_names = _b.set(${pyJson(hostOnlyNames)})
    _reproducible_names = _b.set(${pyJson(reproducibleNames)})
    _required_names = _b.set(${pyJson(requiredNames)})
    _transient_classifications = ${pyJson(transientClassifications)}
    _artifact_root = ${pyStr(artifactRoot)}
    _artifact_dir_name = "kernel-state-artifacts"
    _always_skip = {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open", "goal", "agent_message", "mempalace", "workflow", "workflow_ledger", "ledger", "lease", "leases", "worker", "message_obligations"}

    _ip = None
    try:
        _ip = get_ipython()  # noqa: F821 (injected by IPython)
    except _b.Exception:
        _ip = None
    _ns = _ip.user_ns if _ip is not None else _b.globals()
    _hidden = _b.set(_b.getattr(_ip, "user_ns_hidden", {}) or {}) if _ip is not None else _b.set()
    _payload = {}
    _retained = []
    _skipped = []
    _fatal = []
    _inline_total = 0
    _artifact_bytes_total = 0

    def _safe_type(_value):
        try:
            return _b.type(_value).__name__[:128]
        except _b.Exception:
            return "unknown"

    def _classification(_name, _value):
        _declared = _transient_classifications.get(_name)
        if _declared in ("transient_tool_output", "transient_dataframe", "transient_log_tail", "reproducible_cache"):
            return _declared
        _lower_type = _safe_type(_value).lower()
        if "dataframe" in _lower_type or _lower_type in ("series", "ndframe"):
            return "transient_dataframe"
        return "transient_tool_output"

    def _record(_name, _value_type, _bytes, _classification_name, _required, _representation, _digest, _ref, _reason):
        if _b.len(_retained) >= _max_retained:
            _fatal.append("retained metadata limit exceeded")
            return
        _retained.append({
            "valueId": _name[:256],
            "type": _value_type[:128],
            "bytes": _b.int(_bytes),
            "classification": _classification_name,
            "required": _b.bool(_required),
            "representation": _representation,
            "digest": _digest,
            "artifactRef": _ref,
            "reason": _reason,
        })

    def _write_artifact(_name, _blob, _checkpoint):
        _digest = hashlib.sha256(_blob).hexdigest()
        _relative = _artifact_dir_name + "/" + _digest + ".dill"
        _target = os.path.join(_artifact_root, _digest + ".dill")
        try:
            os.makedirs(_artifact_root, exist_ok=True)
            if os.path.exists(_target):
                with _b.open(_target, "rb") as _fh:
                    _existing = _fh.read()
                if hashlib.sha256(_existing).hexdigest() != _digest or _b.len(_existing) != _b.len(_blob):
                    return None
            else:
                _tmp_artifact = _target + ".tmp"
                with _b.open(_tmp_artifact, "wb") as _fh:
                    _fh.write(_blob)
                os.replace(_tmp_artifact, _target)
            return {
                "artifactId": _digest,
                "relativePath": _relative,
                "digest": _digest,
                "sizeBytes": _b.len(_blob),
                "sourceEventSequence": _checkpoint,
            }
        except _b.Exception:
            try:
                os.remove(_target + ".tmp")
            except _b.Exception:
                pass
            return None

    for _required_name in _required_names:
        if not _b.isinstance(_required_name, _b.str) or _required_name not in _ns or _required_name in _hidden or _required_name in _always_skip:
            _fatal.append("required state is missing from the kernel namespace")

    for _name in _b.sorted(_ns.keys()):
        if not _b.isinstance(_name, _b.str) or _name.startswith("_") or _name in _hidden or _name in _always_skip:
            continue
        _value = _ns[_name]
        _value_type = _safe_type(_value)
        _required = _name in _required_names
        if _name in _host_only_names:
            _record(_name, _value_type, 0, "transient_tool_output", _required, "transient", None, None, "host-owned")
            if _required:
                _fatal.append("required host-owned state is not kernel durable")
            continue
        if _name in _transient_names or _name in _transient_classifications:
            _transient_class = _classification(_name, _value)
            _record(_name, _value_type, 0, _transient_class, _required, "transient", None, None, "declared transient")
            if _required:
                _fatal.append("required transient state is not kernel durable")
            continue
        try:
            _blob = dill.dumps(_value)
        except _b.Exception:
            _record(_name, _value_type, 0, "durable_fact", _required, "unavailable", None, None, "unpicklable")
            _skipped.append({"name": _name, "reason": "unpicklable"})
            if _required:
                _fatal.append("required state is unpicklable")
            continue
        _size = _b.len(_blob)
        _digest = hashlib.sha256(_blob).hexdigest()
        if _name in _reproducible_names and (_size > _max_bytes or _inline_total + _size > _max_bytes):
            _ref = _write_artifact(_name, _blob, _checkpoint_turn)
            if _ref is None:
                _record(_name, _value_type, _size, "artifact_ref", _required, "unavailable", None, None, "artifact write failed")
                _fatal.append("approved artifact could not be verified")
            else:
                _payload[_name] = {"__prime_agent_artifact_ref__": _ref}
                _artifact_bytes_total += _size
                _record(_name, _value_type, _size, "artifact_ref", _required, "durable", _digest, _ref, None)
            continue
        if _size > _max_bytes or _inline_total + _size > _max_bytes:
            _record(_name, _value_type, _size, "durable_fact", _required, "unavailable", None, None, "over budget")
            _skipped.append({"name": _name, "reason": "over budget"})
            if _required:
                _fatal.append("required state exceeds durable checkpoint budget")
            continue
        _payload[_name] = _blob
        _inline_total += _size
        _record(_name, _value_type, _size, "durable_fact", _required, "durable", _digest, None, None)

    _required_ids = _required_names
    _saved = _b.sorted(_payload.keys())
    _durable_values = [_v for _v in _retained if _v["representation"] == "durable"]
    _durable_bytes = _b.sum(_v["bytes"] for _v in _durable_values)
    _largest = _b.sorted(
        [
            {"valueId": _v["valueId"], "type": _v["type"], "bytes": _v["bytes"], "classification": _v["classification"]}
            for _v in _durable_values
            if _v["classification"] in ("durable_fact", "artifact_ref")
        ],
        key=lambda _v: (-_v["bytes"], _v["valueId"]),
    )
    if _fatal:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "required durable state was not committed", "reasons": _fatal[:8]}))
        return

    _started_ms = _b.int(_started * 1000)
    _tmp = ${pyStr(outPath)} + ".tmp"
    try:
        os.makedirs(os.path.dirname(${pyStr(outPath)}) or ".", exist_ok=True)
        with _b.open(_tmp, "wb") as _fh:
            dill.dump(_payload, _fh)
        _payload_bytes = os.path.getsize(_tmp)
        if _payload_bytes > _max_bytes:
            os.remove(_tmp)
            _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "durable checkpoint payload exceeds budget"}))
            return
        with _b.open(_tmp, "rb") as _fh:
            _payload_digest = hashlib.sha256(_fh.read()).hexdigest()
        os.replace(_tmp, ${pyStr(outPath)})
    except _b.Exception:
        try:
            os.remove(_tmp)
        except _b.Exception:
            pass
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "payload write failed"}))
        return

    _ended_ms = _b.int(time.perf_counter() * 1000)
    _manifest = {
        "schemaVersion": 2,
        "status": "committed",
        "savedNames": _saved,
        "requiredNames": _b.sorted(_required_ids),
        "skipped": _skipped,
        "retainedValues": _retained,
        "largestRetainedValues": _largest,
        "bytes": _payload_bytes + _artifact_bytes_total,
        "payloadBytes": _payload_bytes,
        "payloadDigest": _payload_digest,
        "durableBytes": _durable_bytes,
        "previousCheckpointTurn": _previous_checkpoint_turn,
        "previousDurableBytes": _previous_durable_bytes,
        "checkpointTurn": _checkpoint_turn,
        "serializeStartedAtMonotonicMs": _started_ms,
        "serializeEndedAtMonotonicMs": _ended_ms,
        "pythonVersion": sys.version.split()[0],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    _manifest_tmp = ${pyStr(manifestPath)} + ".tmp"
    try:
        os.makedirs(os.path.dirname(${pyStr(manifestPath)}) or ".", exist_ok=True)
        with _b.open(_manifest_tmp, "w") as _fh:
            json.dump(_manifest, _fh, separators=(",", ":"))
        os.replace(_manifest_tmp, ${pyStr(manifestPath)})
    except _b.Exception:
        try:
            os.remove(_manifest_tmp)
        except _b.Exception:
            pass
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "manifest write failed"}))
        return
    _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({
        "saved": _saved,
        "skipped": _skipped,
        "bytes": _payload_bytes + _artifact_bytes_total,
        "checkpointTurn": _checkpoint_turn,
        "serializationDurationMs": _b.max(0, _ended_ms - _started_ms),
        "serializeStartedAtMonotonicMs": _started_ms,
        "serializeEndedAtMonotonicMs": _ended_ms,
        "durableBytes": _durable_bytes,
        "previousCheckpointTurn": _previous_checkpoint_turn,
        "previousDurableBytes": _previous_durable_bytes,
        "retainedValues": _retained,
        "largestRetainedValues": _largest,
    }))


try:
    _prime_agent_snapshot_state()
finally:
    del _prime_agent_snapshot_state
`.trim();
}

/** Python that verifies and restores a committed namespace payload. */
export function buildRestoreCode(
	inPath: string,
	manifestPath: string = `${inPath}.json`,
	artifactRoot: string = join(dirname(inPath), "kernel-state-artifacts"),
	requiredNames: readonly string[] = [],
	maxBytes: number = DEFAULT_SNAPSHOT_MAX_BYTES,
	maxRetainedValues: number = DEFAULT_SNAPSHOT_MAX_RETAINED_VALUES,
): string {
	// Builtins via the local _b alias so a shadowed name in the user namespace
	// (list/open/print/…) cannot break the restore path.
	return `
def _prime_agent_restore_state():
    import builtins as _b, hashlib, json, os, time
    _restore_started = _b.int(time.perf_counter() * 1000)
    _path = ${pyStr(inPath)}
    _manifest_path = ${pyStr(manifestPath)}
    _artifact_root = ${pyStr(artifactRoot)}
    _current_required_names = _b.set(${pyJson([...new Set(requiredNames)])})
    _max_bytes = ${maxBytes}
    _max_retained_values = ${maxRetainedValues}
    if not os.path.exists(_path) and not os.path.exists(_manifest_path):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"restored": [], "failed": [], "missing": True}))
        return
    if not os.path.exists(_manifest_path):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest missing"}))
        return
    try:
        with _b.open(_manifest_path, "r") as _fh:
            _manifest = json.load(_fh)
    except _b.Exception:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest corrupt"}))
        return
    if not _b.isinstance(_manifest, _b.dict) or _manifest.get("schemaVersion") != 2 or _manifest.get("status") != "committed":
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    _expected_manifest_keys = {
        "schemaVersion", "status", "savedNames", "requiredNames", "skipped", "retainedValues",
        "largestRetainedValues", "bytes", "payloadBytes", "payloadDigest", "durableBytes",
        "previousCheckpointTurn", "previousDurableBytes", "checkpointTurn",
        "serializeStartedAtMonotonicMs", "serializeEndedAtMonotonicMs", "pythonVersion", "timestamp",
    }
    if _b.set(_manifest.keys()) != _expected_manifest_keys:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    _saved_names = _manifest.get("savedNames")
    _required_names = _manifest.get("requiredNames")
    _skipped = _manifest.get("skipped")
    _retained_values = _manifest.get("retainedValues")
    _largest_retained_values = _manifest.get("largestRetainedValues")
    _payload_bytes_expected = _manifest.get("payloadBytes")
    _payload_digest_expected = _manifest.get("payloadDigest")
    _serialize_started = _manifest.get("serializeStartedAtMonotonicMs")
    _serialize_ended = _manifest.get("serializeEndedAtMonotonicMs")
    _durable_bytes_expected = _manifest.get("durableBytes")
    _manifest_bytes_expected = _manifest.get("bytes")
    _checkpoint_turn = _manifest.get("checkpointTurn")
    _previous_checkpoint_turn = _manifest.get("previousCheckpointTurn")
    _previous_durable_bytes = _manifest.get("previousDurableBytes")
    _always_skip = {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open", "goal", "agent_message", "mempalace", "workflow", "workflow_ledger", "ledger", "lease", "leases", "worker", "message_obligations"}
    if (
        not _b.isinstance(_saved_names, _b.list) or
        not _b.isinstance(_required_names, _b.list) or
        not _b.isinstance(_skipped, _b.list) or
        not _b.isinstance(_retained_values, _b.list) or
        not _b.isinstance(_largest_retained_values, _b.list) or
        not _b.isinstance(_checkpoint_turn, _b.int) or _b.isinstance(_checkpoint_turn, _b.bool) or _checkpoint_turn < 0 or
        (_previous_checkpoint_turn is not None and (not _b.isinstance(_previous_checkpoint_turn, _b.int) or _b.isinstance(_previous_checkpoint_turn, _b.bool) or _previous_checkpoint_turn < 0)) or
        (_previous_durable_bytes is not None and (not _b.isinstance(_previous_durable_bytes, _b.int) or _b.isinstance(_previous_durable_bytes, _b.bool) or _previous_durable_bytes < 0)) or
        (_previous_checkpoint_turn is None) != (_previous_durable_bytes is None) or
        (_previous_checkpoint_turn is not None and _previous_checkpoint_turn >= _checkpoint_turn) or
        _b.len(_saved_names) != _b.len(_b.set(_saved_names)) or
        _b.len(_required_names) != _b.len(_b.set(_required_names)) or
        _b.sorted(_saved_names) != _saved_names or
        _b.sorted(_required_names) != _required_names or
        _b.any(
            not _b.isinstance(_name, _b.str) or not _name or _name.startswith("_") or _name in _always_skip or _b.len(_name) > 256
            for _name in _saved_names + _required_names
        ) or
        not _b.isinstance(_payload_bytes_expected, _b.int) or _b.isinstance(_payload_bytes_expected, _b.bool) or _payload_bytes_expected < 0 or _payload_bytes_expected > _max_bytes or
        not _b.isinstance(_payload_digest_expected, _b.str) or
        _b.len(_payload_digest_expected) != 64 or
        _b.any(_c not in "0123456789abcdef" for _c in _payload_digest_expected) or
        not _b.isinstance(_serialize_started, _b.int) or _b.isinstance(_serialize_started, _b.bool) or
        not _b.isinstance(_serialize_ended, _b.int) or _b.isinstance(_serialize_ended, _b.bool) or
        _serialize_started < 0 or _serialize_ended < _serialize_started or
        not _b.isinstance(_durable_bytes_expected, _b.int) or _b.isinstance(_durable_bytes_expected, _b.bool) or _durable_bytes_expected < 0 or
        not _b.isinstance(_manifest_bytes_expected, _b.int) or _b.isinstance(_manifest_bytes_expected, _b.bool) or _manifest_bytes_expected < 0
    ):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    for _skipped_value in _skipped:
        if (
            not _b.isinstance(_skipped_value, _b.dict) or
            _b.set(_skipped_value.keys()) != {"name", "reason"} or
            not _b.isinstance(_skipped_value.get("name"), _b.str) or
            not _b.isinstance(_skipped_value.get("reason"), _b.str) or
            _skipped_value.get("name") in _always_skip or
            _skipped_value.get("name").startswith("_") or
            _skipped_value.get("reason") not in ("unpicklable", "over budget")
        ):
            _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
            return
    if _b.len(_retained_values) > _max_retained_values or _b.len(_largest_retained_values) > _max_retained_values:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    _retained_by_name = {}
    _durable_metadata_bytes = 0
    _artifact_metadata_bytes = 0
    _largest_expected = []
    _retained_keys = {"valueId", "type", "bytes", "classification", "required", "representation", "digest", "artifactRef", "reason"}
    for _retained_value in _retained_values:
        if (
            not _b.isinstance(_retained_value, _b.dict) or
            _b.set(_retained_value.keys()) != _retained_keys or
            not _b.isinstance(_retained_value.get("valueId"), _b.str) or
            not _retained_value.get("valueId") or _retained_value.get("valueId").startswith("_") or
            _retained_value.get("valueId") in _always_skip or _b.len(_retained_value.get("valueId")) > 256 or
            not _b.isinstance(_retained_value.get("type"), _b.str) or
            not _retained_value.get("type") or _b.len(_retained_value.get("type")) > 128 or
            not _b.isinstance(_retained_value.get("bytes"), _b.int) or _b.isinstance(_retained_value.get("bytes"), _b.bool) or _retained_value.get("bytes") < 0 or
            _retained_value.get("classification") not in ("durable_fact", "artifact_ref", "transient_tool_output", "transient_dataframe", "transient_log_tail", "reproducible_cache") or
            _retained_value.get("representation") not in ("durable", "transient", "unavailable") or
            not _b.isinstance(_retained_value.get("required"), _b.bool) or
            _retained_value.get("valueId") in _retained_by_name
        ):
            _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
            return
        _classification = _retained_value.get("classification")
        _representation = _retained_value.get("representation")
        _digest = _retained_value.get("digest")
        _ref = _retained_value.get("artifactRef")
        _reason = _retained_value.get("reason")
        if _representation == "durable":
            if _classification not in ("durable_fact", "artifact_ref") or not _b.isinstance(_digest, _b.str) or _b.len(_digest) != 64 or _b.any(_c not in "0123456789abcdef" for _c in _digest) or _reason is not None:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
                return
            if _classification == "durable_fact" and _ref is not None:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
                return
            if _classification == "artifact_ref":
                if (
                    not _b.isinstance(_ref, _b.dict) or
                    _b.set(_ref.keys()) != {"artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"} or
                    _ref.get("artifactId") != _digest or
                    _ref.get("digest") != _digest or
                    _ref.get("relativePath") != "kernel-state-artifacts/" + _digest + ".dill" or
                    not _b.isinstance(_ref.get("sizeBytes"), _b.int) or _b.isinstance(_ref.get("sizeBytes"), _b.bool) or
                    _ref.get("sizeBytes") != _retained_value.get("bytes") or
                    not _b.isinstance(_ref.get("sourceEventSequence"), _b.int) or _b.isinstance(_ref.get("sourceEventSequence"), _b.bool) or
                    _ref.get("sourceEventSequence") != _checkpoint_turn
                ):
                    _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
                    return
                _artifact_metadata_bytes += _ref.get("sizeBytes")
            _durable_metadata_bytes += _retained_value.get("bytes")
            _largest_expected.append({"valueId": _retained_value.get("valueId"), "type": _retained_value.get("type"), "bytes": _retained_value.get("bytes"), "classification": _classification})
        else:
            if _digest is not None or _ref is not None or _reason not in ("declared transient", "host-owned", "unpicklable", "over budget", "artifact write failed") or (_retained_value.get("required") is True):
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
                return
        _retained_by_name[_retained_value.get("valueId")] = _retained_value
    _largest_expected = _b.sorted(_largest_expected, key=lambda _v: (-_v["bytes"], _v["valueId"]))
    if _largest_retained_values != _largest_expected or _durable_bytes_expected != _durable_metadata_bytes or _manifest_bytes_expected != _payload_bytes_expected + _artifact_metadata_bytes:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    if not _b.set(_required_names).issubset(_b.set(_saved_names)):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest unverifiable"}))
        return
    if _current_required_names != _b.set(_required_names):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "required snapshot registry changed"}))
        return
    if not os.path.exists(_path):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot payload missing"}))
        return
    try:
        with _b.open(_path, "rb") as _fh:
            _payload_bytes = _fh.read()
        if _b.len(_payload_bytes) != _payload_bytes_expected or hashlib.sha256(_payload_bytes).hexdigest() != _payload_digest_expected:
            _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot payload digest mismatch"}))
            return
        import dill
        _payload = dill.loads(_payload_bytes)
    except _b.Exception:
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot payload corrupt"}))
        return
    if not _b.isinstance(_payload, _b.dict):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot payload unverifiable"}))
        return
    if _b.set(_payload.keys()) != _b.set(_saved_names):
        _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot payload does not match manifest"}))
        return

    def _artifact_bytes(_ref):
        if not _b.isinstance(_ref, _b.dict):
            return None
        _keys = {"artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"}
        if _b.set(_ref.keys()) != _keys:
            return None
        _digest = _ref.get("digest")
        _relative = _ref.get("relativePath")
        _size = _ref.get("sizeBytes")
        _artifact_id = _ref.get("artifactId")
        _source_sequence = _ref.get("sourceEventSequence")
        if (
            not _b.isinstance(_digest, _b.str) or _b.len(_digest) != 64 or _b.any(_c not in "0123456789abcdef" for _c in _digest) or
            _artifact_id != _digest or
            not _b.isinstance(_relative, _b.str) or _relative != "kernel-state-artifacts/" + _digest + ".dill" or
            not _b.isinstance(_size, _b.int) or _b.isinstance(_size, _b.bool) or _size < 0 or
            not _b.isinstance(_source_sequence, _b.int) or _b.isinstance(_source_sequence, _b.bool) or _source_sequence != _checkpoint_turn
        ):
            return None
        _filename = os.path.basename(_relative)
        if _filename != _digest + ".dill":
            return None
        _target = os.path.join(_artifact_root, _filename)
        try:
            if os.path.realpath(_target) != os.path.join(os.path.realpath(_artifact_root), _filename):
                return None
            with _b.open(_target, "rb") as _fh:
                _blob = _fh.read()
            if _b.len(_blob) != _size or hashlib.sha256(_blob).hexdigest() != _digest:
                return None
            return _blob
        except _b.Exception:
            return None

    _ip = None
    try:
        _ip = get_ipython()  # noqa: F821
    except _b.Exception:
        _ip = None
    _ns = _ip.user_ns if _ip is not None else _b.globals()
    _restored = []
    _failed = []
    _required = _b.set(_required_names)
    for _name in _saved_names:
        if not _b.isinstance(_name, _b.str) or _name not in _payload:
            if _name in _required:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "required snapshot value missing"}))
                return
            _failed.append({"name": _name, "reason": "value missing"})
            continue
        _blob_or_ref = _payload[_name]
        _metadata = _retained_by_name.get(_name)
        if not _b.isinstance(_metadata, _b.dict) or _metadata.get("representation") != "durable":
            _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot manifest does not verify retained value"}))
            return
        if _b.isinstance(_blob_or_ref, _b.dict) and "__prime_agent_artifact_ref__" in _blob_or_ref:
            if _b.set(_blob_or_ref.keys()) != {"__prime_agent_artifact_ref__"}:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "artifact reference unverifiable"}))
                return
            _blob = _artifact_bytes(_blob_or_ref["__prime_agent_artifact_ref__"])
            if _blob is None:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "artifact reference unverifiable"}))
                return
            if (
                _metadata.get("classification") != "artifact_ref" or
                _metadata.get("digest") != hashlib.sha256(_blob).hexdigest() or
                _metadata.get("bytes") != _b.len(_blob) or
                _metadata.get("artifactRef") != _blob_or_ref["__prime_agent_artifact_ref__"]
            ):
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "artifact metadata unverifiable"}))
                return
        else:
            _blob = _blob_or_ref
            if (
                not _b.isinstance(_blob, _b.bytes) or
                _metadata.get("classification") != "durable_fact" or
                _metadata.get("digest") != hashlib.sha256(_blob).hexdigest() or
                _metadata.get("bytes") != _b.len(_blob) or
                _metadata.get("artifactRef") is not None
            ):
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot value metadata unverifiable"}))
                return
        try:
            _restored_value = dill.loads(_blob)
            if _b.type(_restored_value).__name__ != _metadata.get("type"):
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "snapshot value type unverifiable"}))
                return
            _ns[_name] = _restored_value
            _restored.append(_name)
        except _b.Exception:
            if _name in _required:
                _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"error": "required snapshot value failed to restore"}))
                return
            _failed.append({"name": _name, "reason": "value failed to restore"})

    _restore_ended = _b.int(time.perf_counter() * 1000)
    _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({
        "restored": _b.sorted(_restored),
        "failed": _failed,
        "checkpointTurn": _manifest.get("checkpointTurn", 0),
        "bytes": _manifest.get("bytes", 0),
        "restoreDurationMs": _b.max(0, _restore_ended - _restore_started),
        "restoreStartedAtMonotonicMs": _restore_started,
        "restoreEndedAtMonotonicMs": _restore_ended,
        "serializationDurationMs": _b.max(0, _serialize_ended - _serialize_started),
        "serializeStartedAtMonotonicMs": _serialize_started,
        "serializeEndedAtMonotonicMs": _serialize_ended,
        "durableBytes": _manifest.get("durableBytes", 0),
        "previousCheckpointTurn": _manifest.get("previousCheckpointTurn"),
        "previousDurableBytes": _manifest.get("previousDurableBytes"),
        "retainedValues": _manifest.get("retainedValues", []),
        "largestRetainedValues": _manifest.get("largestRetainedValues", []),
    }))


try:
    _prime_agent_restore_state()
finally:
    del _prime_agent_restore_state
`.trim();
}

/** Marker-line list of live user-defined names, filtered like the snapshot. */
export function buildListNamesCode(): string {
	return `
def _prime_agent_list_state_names():
    import builtins as _b, json
    _ip = None
    try:
        _ip = get_ipython()  # noqa: F821 (injected by IPython)
    except _b.Exception:
        _ip = None
    _ns = _ip.user_ns if _ip is not None else _b.globals()
    _hidden = _b.set(_b.getattr(_ip, "user_ns_hidden", {}) or {}) if _ip is not None else _b.set()
    _always_skip = {"rlm", "asyncio", "In", "Out", "get_ipython", "exit", "quit", "open", "goal", "agent_message", "mempalace", "workflow", "workflow_ledger", "ledger", "lease", "leases", "worker", "message_obligations"}
    _names = []
    for _name in _b.list(_ns.keys()):
        if _name.startswith("_") or _name in _hidden or _name in _always_skip:
            continue
        _names.append(_name)
    _b.print(${pyStr(KERNEL_STATE_RESULT_MARKER)} + json.dumps({"names": _b.sorted(_names)}))


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
	checkpointTurn?: unknown;
	serializationDurationMs?: unknown;
	serializeStartedAtMonotonicMs?: unknown;
	serializeEndedAtMonotonicMs?: unknown;
	previousCheckpointTurn?: unknown;
	previousDurableBytes?: unknown;
	durableBytes?: unknown;
	retainedValues?: unknown;
	largestRetainedValues?: unknown;
}

interface RawRestore {
	restored?: unknown;
	failed?: unknown;
	error?: unknown;
	missing?: unknown;
	checkpointTurn?: unknown;
	bytes?: unknown;
	restoreDurationMs?: unknown;
	restoreStartedAtMonotonicMs?: unknown;
	restoreEndedAtMonotonicMs?: unknown;
	serializationDurationMs?: unknown;
	serializeStartedAtMonotonicMs?: unknown;
	serializeEndedAtMonotonicMs?: unknown;
	durableBytes?: unknown;
	previousCheckpointTurn?: unknown;
	previousDurableBytes?: unknown;
	retainedValues?: unknown;
	largestRetainedValues?: unknown;
}

/** Parse the bounded failure reason emitted by a snapshot/restore helper. */
export function parseKernelStateError(stdout: string): string | null {
	const raw = parseMarkerLine<{ error?: unknown }>(stdout);
	return typeof raw?.error === "string" ? raw.error.slice(0, 128) : null;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 256)
		: [];
}

function asReasonArray(value: unknown): { name: string; reason: string }[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
			const { name, reason } = entry as { name: string; reason?: unknown };
			return [{ name: name.slice(0, 256), reason: typeof reason === "string" ? reason.slice(0, 64) : "" }];
		}
		return [];
	});
}

function asNonNegativeInteger(value: unknown): number | null {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function asDigest(value: unknown): string | null {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : null;
}

function asArtifactRef(value: unknown): KernelSnapshotArtifactRef | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.artifactId !== "string" ||
		typeof candidate.relativePath !== "string" ||
		asDigest(candidate.digest) === null ||
		asNonNegativeInteger(candidate.sizeBytes) === null ||
		asNonNegativeInteger(candidate.sourceEventSequence) === null
	) {
		return null;
	}
	return {
		artifactId: candidate.artifactId.slice(0, 256),
		relativePath: candidate.relativePath.slice(0, 512),
		digest: candidate.digest as string,
		sizeBytes: candidate.sizeBytes as number,
		sourceEventSequence: candidate.sourceEventSequence as number,
	};
}

function asRetainedValues(value: unknown): KernelSnapshotRetainedValue[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const candidate = entry as Record<string, unknown>;
		const bytes = asNonNegativeInteger(candidate.bytes);
		const classification = candidate.classification;
		const representation = candidate.representation;
		if (
			typeof candidate.valueId !== "string" ||
			typeof candidate.type !== "string" ||
			bytes === null ||
			!(
				[
					"durable_fact",
					"artifact_ref",
					"transient_tool_output",
					"transient_dataframe",
					"transient_log_tail",
					"reproducible_cache",
				] as const
			).includes(classification as KernelSnapshotRetentionClass) ||
			!(["durable", "transient", "unavailable"] as const).includes(representation as KernelSnapshotRepresentation) ||
			typeof candidate.required !== "boolean"
		) {
			return [];
		}
		const artifactRef = asArtifactRef(candidate.artifactRef);
		const digest = asDigest(candidate.digest);
		return [
			{
				valueId: candidate.valueId.slice(0, 256),
				type: candidate.type.slice(0, 128),
				bytes,
				classification: classification as KernelSnapshotRetentionClass,
				required: candidate.required,
				representation: representation as KernelSnapshotRepresentation,
				digest,
				artifactRef,
				reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 64) : null,
			},
		];
	});
}

function asLargestRetainedValues(value: unknown): KernelSnapshotLargestRetainedValue[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
		const candidate = entry as Record<string, unknown>;
		const bytes = asNonNegativeInteger(candidate.bytes);
		if (
			typeof candidate.valueId !== "string" ||
			typeof candidate.type !== "string" ||
			bytes === null ||
			(candidate.classification !== "durable_fact" && candidate.classification !== "artifact_ref")
		) {
			return [];
		}
		return [
			{
				valueId: candidate.valueId.slice(0, 256),
				type: candidate.type.slice(0, 128),
				bytes,
				classification: candidate.classification,
			},
		];
	});
}

/** Pull the marker line out of cell stdout and parse it, or null if absent/invalid. */
function parseMarkerLine<T>(stdout: string): T | null {
	const index = stdout.lastIndexOf(KERNEL_STATE_RESULT_MARKER);
	if (index === -1) return null;
	const rest = stdout.slice(index + KERNEL_STATE_RESULT_MARKER.length);
	const line = rest.split("\n", 1)[0]?.trim();
	if (!line) return null;
	try {
		return JSON.parse(line) as T;
	} catch {
		return null;
	}
}

function metricsFromRaw(raw: RawSnapshot | RawRestore): KernelSnapshotMetrics | undefined {
	const checkpointTurn = asNonNegativeInteger(raw.checkpointTurn);
	const serializationDurationMs = asNonNegativeInteger(raw.serializationDurationMs);
	if (checkpointTurn === null || serializationDurationMs === null) {
		return undefined;
	}
	const retainedValues = asRetainedValues(raw.retainedValues);
	const largestRetainedValues = asLargestRetainedValues(raw.largestRetainedValues);
	const serializeStartedAtMonotonicMs = asNonNegativeInteger(raw.serializeStartedAtMonotonicMs) ?? 0;
	const serializeEndedAtMonotonicMs = asNonNegativeInteger(raw.serializeEndedAtMonotonicMs) ?? serializationDurationMs;
	const retainedDurableBytes = retainedValues.reduce(
		(total, value) => (value.representation === "durable" ? total + value.bytes : total),
		0,
	);
	const durableBytes = asNonNegativeInteger(raw.durableBytes) ?? retainedDurableBytes;
	const previousCheckpointTurn = asNonNegativeInteger((raw as RawSnapshot).previousCheckpointTurn) ?? null;
	const previousDurableBytes = asNonNegativeInteger((raw as RawSnapshot).previousDurableBytes) ?? null;
	const growthBytesPerTurn =
		previousCheckpointTurn !== null && previousDurableBytes !== null && checkpointTurn > previousCheckpointTurn
			? (durableBytes - previousDurableBytes) / (checkpointTurn - previousCheckpointTurn)
			: null;
	return {
		checkpointTurn,
		serializationDurationMs,
		previousCheckpointTurn,
		previousDurableBytes,
		durableBytes,
		growthBytesPerTurn: Number.isFinite(growthBytesPerTurn) ? growthBytesPerTurn : null,
		retainedValues,
		largestRetainedValues,
		serializeStartedAtMonotonicMs,
		serializeEndedAtMonotonicMs,
	};
}

/** Parse a committed snapshot marker without exposing raw values. */
export function parseSnapshotResult(stdout: string, path: string): SnapshotResult | null {
	const raw = parseMarkerLine<RawSnapshot>(stdout);
	if (!raw || raw.error) return null;
	const metrics = metricsFromRaw(raw);
	return {
		saved: asStringArray(raw.saved),
		skipped: asReasonArray(raw.skipped),
		bytes: typeof raw.bytes === "number" ? raw.bytes : 0,
		path,
		...(metrics ?? {}),
	};
}

/** Parse a committed restore marker without exposing raw values. */
export function parseRestoreResult(stdout: string, path: string): RestoreResult | null {
	const raw = parseMarkerLine<RawRestore>(stdout);
	if (!raw || raw.error) return null;
	const restoreDurationMs = asNonNegativeInteger(raw.restoreDurationMs);
	const restoreStartedAtMonotonicMs = asNonNegativeInteger(raw.restoreStartedAtMonotonicMs);
	const restoreEndedAtMonotonicMs = asNonNegativeInteger(raw.restoreEndedAtMonotonicMs);
	const metrics = metricsFromRaw(raw);
	return {
		restored: asStringArray(raw.restored),
		failed: asReasonArray(raw.failed),
		path,
		...(typeof raw.missing === "boolean" ? { missing: raw.missing } : {}),
		...(typeof raw.bytes === "number" ? { bytes: raw.bytes } : {}),
		...(restoreDurationMs !== null ? { restoreDurationMs } : {}),
		...(restoreStartedAtMonotonicMs !== null ? { restoreStartedAtMonotonicMs } : {}),
		...(restoreEndedAtMonotonicMs !== null ? { restoreEndedAtMonotonicMs } : {}),
		...(metrics ?? {}),
	};
}

/** Sorted list of live user-defined names, or null if the marker was absent/invalid. */
export function parseListNamesResult(stdout: string): string[] | null {
	const raw = parseMarkerLine<RawListNames>(stdout);
	if (!raw || raw.error) return null;
	return asStringArray(raw.names);
}

/** Snapshot result returned by a committed namespace serialization. */
export interface SnapshotResult extends Partial<KernelSnapshotMetrics> {
	readonly saved: string[];
	readonly skipped: { name: string; reason: string }[];
	readonly bytes: number;
	readonly path: string;
}

/** Restore result returned by a verified namespace reconstruction. */
export interface RestoreResult extends Partial<KernelSnapshotMetrics> {
	readonly restored: string[];
	readonly failed: { name: string; reason: string }[];
	readonly path: string;
	readonly missing?: boolean;
	readonly restoreDurationMs?: number;
	readonly restoreStartedAtMonotonicMs?: number;
	readonly restoreEndedAtMonotonicMs?: number;
	readonly bytes?: number;
}
