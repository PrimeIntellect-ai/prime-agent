#!/usr/bin/env python3
"""Differential frame comparator: TS capture corpus vs a Rust ACP capture.

Both captures come from the same scenario client (same requests, same
order). Frames are compared structurally, field by field, after
normalizing the values that legitimately differ between the two binaries:

  - sessionId, toolCallId, messageId ids (random or provider-issued)
  - agentInfo.version (product version)
  - mcpCapabilities is compared exactly (both binaries advertise
    `{ "http": true }` since MCP admission landed)
  - model-generated content: chunk text, tool rawInput, error detail text
    from the provider, exit/error strings inside tool results
  - eventSequence: the number of chunks differs per model run; the
    sequence is renumbered per capture before comparison
  - timestamps

Everything else — method names, sessionUpdate tags, phases, outcomes,
terminalQuiescenceExpected, quiescence values, stop reasons, error codes
and error messages, capability flags — must match exactly, in order.

Usage:
    compare_differential.py <ts-capture.jsonl> <rust-capture.jsonl>
"""
import json
import re
import sys

VOLATILE_STRING = "<volatile>"
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def scrub(value, path):
    if isinstance(value, dict):
        return {key: scrub(item, path + [key]) for key, item in sorted(value.items())}
    if isinstance(value, list):
        return [scrub(item, path + ["[]"]) for item in value]
    if isinstance(value, str):
        if UUID_RE.match(value):
            return "<uuid>"
        return value
    return value


def normalize_frame(direction, frame, sequence_index):
    """One comparable shape for an observed frame."""
    if "method" in frame:
        shape = {"dir": direction, "method": frame["method"]}
        if frame["method"] == "session/update":
            update = frame.get("params", {}).get("update", {})
            meta = update.get("_meta", {}).get("ai.primeintellect.prime-agent", {})
            shape["sessionUpdate"] = update.get("sessionUpdate")
            kind = update.get("sessionUpdate")
            if kind in ("agent_message_chunk", "agent_thought_chunk"):
                shape["content"] = update.get("content", {}).get("type")
            elif kind == "tool_call":
                shape["kind"] = update.get("kind")
                shape["status"] = update.get("status")
            elif kind == "tool_call_update":
                shape["status"] = update.get("status")
                shape["has_content"] = "content" in update
                shape["has_ipython_meta"] = "ipython" in meta
            elif kind == "session_info_update":
                # Compaction, goal, and refinement payloads: presence and
                # status are structural; usage counts and summary text are
                # run-dependent values.
                if "compaction" in meta:
                    shape["has_compaction"] = True
                if "goal" in meta:
                    shape["has_goal"] = True
                    shape["goal_status"] = meta["goal"].get("status")
                if "refinement" in meta:
                    shape["has_refinement"] = True
                    shape["refinement_status"] = meta["refinement"].get("status")
                if "autonomous" in meta:
                    shape["has_autonomous"] = True
                    shape["autonomous_enabled"] = meta["autonomous"].get("enabled")
                if "heartbeatsChanged" in meta:
                    shape["heartbeatsChanged"] = meta["heartbeatsChanged"]
            shape["phase"] = meta.get("phase")
            shape["outcome"] = meta.get("outcome")
            shape["terminalQuiescenceExpected"] = meta.get("terminalQuiescenceExpected")
            if "quiescence" in meta:
                shape["quiescence"] = meta["quiescence"]
            shape["promptTurnId"] = meta.get("promptTurnId")
            shape["cwd"] = meta.get("cwd", {}).get("requested") if meta.get("cwd") else None
            shape["has_cwd"] = "cwd" in meta
        return shape
    if "result" in frame or "error" in frame:
        if "result" in frame:
            result = frame["result"]
            shape = {"dir": direction, "id": frame.get("id"), "result": "result"}
            if isinstance(result, dict):
                if "sessionId" in result:
                    shape["sessionId"] = "<uuid>"
                if "stopReason" in result:
                    shape["stopReason"] = result["stopReason"]
                if "protocolVersion" in result:
                    shape["protocolVersion"] = result["protocolVersion"]
                    caps = result.get("agentCapabilities", {})
                    shape["loadSession"] = caps.get("loadSession")
                    shape["promptCapabilities"] = caps.get("promptCapabilities")
                    shape["sessionCapabilities"] = caps.get("sessionCapabilities")
                    shape["mcpCapabilities"] = caps.get("mcpCapabilities")
                    shape["agentInfo"] = {
                        "name": result.get("agentInfo", {}).get("name"),
                        "title": result.get("agentInfo", {}).get("title"),
                    }
                if result == {}:
                    shape["result"] = "{}"
            return shape
        error = frame["error"]
        return {
            "dir": direction,
            "id": frame.get("id"),
            "error": {
                "code": error.get("code"),
                # Provider-driven detail text is volatile; the structural
                # message must match.
                "message": error.get("message"),
                "has_details": "details" in error.get("data", {}),
                "details_prefix": (error.get("data", {}).get("details") or "")[:21],
                "method": error.get("data", {}).get("method"),
            },
        }
    return {"dir": direction, "id": frame.get("id"), "unknown": True}


def load_capture(path):
    rows = []
    with open(path) as handle:
        for line in handle:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    frames = [row for row in rows if row.get("direction") in ("in", "out")]
    return frames


def landmark_frame(frame_shape):
    """Whether a frame is a structural landmark.

    `--landmarks` mode drops model-behavior-dependent work frames (tool
    calls, streamed chunks, and mid-turn goal-usage updates) and keeps the
    protocol envelopes: requests, responses, boundaries, completion and
    terminal envelopes, compaction/refinement/autonomous metas, and stop
    reasons.
    """
    if frame_shape.get("method") != "session/update":
        return True
    kind = frame_shape.get("sessionUpdate")
    if kind in ("tool_call", "tool_call_update", "chunk-stream"):
        return False
    if (
        kind == "session_info_update"
        and frame_shape.get("phase") == "event"
        and frame_shape.get("has_goal")
        and not frame_shape.get("has_compaction")
        and not frame_shape.get("has_refinement")
        and not frame_shape.get("has_autonomous")
    ):
        return False
    return True


def normalize_capture(frames, landmarks=False):
    """The shape sequence, with outgoing requests matched by scenario order."""
    shapes = []
    request_index = 0
    for row in frames:
        frame = row["frame"]
        direction = row["direction"]
        if direction == "out":
            shapes.append({"dir": "out", "method": frame.get("method"), "request_index": request_index})
            if "id" in frame:
                request_index += 1
            continue
        shape = normalize_frame(direction, frame, request_index)
        if landmarks and not landmark_frame(shape):
            continue
        shapes.append(shape)
    return shapes


def collapse(shapes):
    """Collapse runs of identical consecutive shapes.

    Model-generated content is nondeterministic: the number of streamed
    chunks (and, for tool turns, which tools the model picks) differs
    between runs of the SAME binary. Parity is the structural sequence:
    which update kinds appear, in which order, with which correlation
    fields. A run of identical shapes is therefore one entry, annotated
    with its length.
    """
    # Streamed reasoning and message chunks are model-nondeterministic in
    # their interleaving; a run of either is one "chunk stream" entry.
    mapped = []
    for shape in shapes:
        if shape.get("sessionUpdate") in ("agent_message_chunk", "agent_thought_chunk"):
            shape = {"method": "session/update", "sessionUpdate": "chunk-stream"}
        mapped.append(shape)
    # Whether the model thinks before or between tool calls is
    # run-dependent: chunk streams adjacent to tool frames merge into the
    # tool's work block instead of standing as separate entries.
    collapsed = []
    for shape in mapped:
        if collapsed and collapsed[-1][0] == shape:
            collapsed[-1] = (shape, collapsed[-1][1] + 1)
        else:
            collapsed.append((shape, 1))
    # A chunk stream next to a tool frame merges into that tool's work
    # block (whether the model thinks before or between tool calls is
    # run-dependent).
    filtered = []
    for index, (shape, count) in enumerate(collapsed):
        if shape.get("sessionUpdate") == "chunk-stream":
            prev_is_tool = index > 0 and collapsed[index - 1][0].get("sessionUpdate") in (
                "tool_call",
                "tool_call_update",
            )
            next_is_tool = (
                index + 1 < len(collapsed)
                and collapsed[index + 1][0].get("sessionUpdate") in ("tool_call", "tool_call_update")
            )
            if prev_is_tool or next_is_tool:
                continue
        filtered.append((shape, count))
    return filtered


def main():
    arguments = sys.argv[1:]
    landmarks = "--landmarks" in arguments
    paths = [argument for argument in arguments if argument != "--landmarks"]
    ts_path, rust_path = paths[0], paths[1]
    ts = collapse(normalize_capture(load_capture(ts_path), landmarks))
    rust = collapse(normalize_capture(load_capture(rust_path), landmarks))
    ts_shapes = [shape for shape, _ in ts]
    rust_shapes = [shape for shape, _ in rust]
    if ts_shapes == rust_shapes:
        mode = "landmarks" if landmarks else "full"
        print(f"MATCH ({mode}): {ts_path} vs {rust_path} ({len(ts)} structural frames)")
        return 0
    print(f"MISMATCH: {ts_path} vs {rust_path}")
    for index in range(max(len(ts_shapes), len(rust_shapes))):
        left = ts_shapes[index] if index < len(ts_shapes) else None
        right = rust_shapes[index] if index < len(rust_shapes) else None
        if left != right:
            print(f"  structural frame {index}:")
            print(f"    TS  : {json.dumps(left, sort_keys=True)}")
            print(f"    RUST: {json.dumps(right, sort_keys=True)}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
