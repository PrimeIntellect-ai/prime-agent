#!/usr/bin/env python3
"""Binary-level, offline observation of goal continuation in TS and Rust.

Requires PA_TS_BINARY and PA_RUST_BINARY. The TS binary is the official 0.9.8
Linux release extracted by CI. All model traffic goes to this process's
loopback HTTP server; each invocation gets a disposable home and session tree.
Behavioral differences are evidence in --receipt, not silently normalized.
"""

import argparse
import hashlib
import http.server
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import threading
import time


TS_ARCHIVE_SHA256 = "83fb09129bf78e3e60268212cd70932166591b15188caa70c1b0efbcc76235e2"
TIMEOUT_SECONDS = 35
MAX_REQUESTS = 6


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class MockServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, scenario):
        super().__init__(("127.0.0.1", 0), MockHandler)
        self.scenario = scenario
        self.requests = []
        self.changed = threading.Condition()
        self.process = None
        self.limit_hit = False


class MockHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length))
        except (ValueError, json.JSONDecodeError):
            self.send_error(400)
            return
        server = self.server
        with server.changed:
            number = len(server.requests) + 1
            server.requests.append({
                "number": number,
                "elapsed_ms": round((time.monotonic() - server.started) * 1000),
                "path": self.path,
                "model": body.get("model"),
                "stream": body.get("stream"),
                "roles": [m.get("role") for m in body.get("messages", [])],
                "wake_marker": "<goal_backoff_wake>" in json.dumps(body),
                "goal_context": "goal_context" in json.dumps(body),
            })
            if number >= MAX_REQUESTS:
                server.limit_hit = True
                if server.process is not None:
                    os.killpg(server.process.pid, signal.SIGTERM)
            server.changed.notify_all()

        if server.scenario == "recover" and number == 2:
            delta = {"tool_calls": [{"index": 0, "id": "call_complete", "type": "function",
                                     "function": {"name": "ipython", "arguments": json.dumps({"code": "await goal.complete()"})}}]}
            finish = "tool_calls"
        elif server.scenario == "recover" and number >= 3:
            delta = {"content": "Goal completed."}
            finish = "stop"
        else:
            delta = {}
            finish = "stop"

        def chunk(value, reason=None):
            return {"id": "mock-goal", "object": "chat.completion.chunk", "created": 1,
                    "model": "goal-fixture", "choices": [{"index": 0, "delta": value, "finish_reason": reason}]}

        usage = {"id": "mock-goal", "object": "chat.completion.chunk", "created": 1,
                 "model": "goal-fixture", "choices": [],
                 "usage": {"prompt_tokens": 10, "completion_tokens": 1,
                           "total_tokens": 11, "prompt_tokens_details": {"cached_tokens": 0}}}
        payload = "".join("data: " + json.dumps(item, separators=(",", ":")) + "\n\n"
                          for item in (chunk({"role": "assistant", **delta}),
                                       chunk({}, finish), usage))
        payload += "data: [DONE]\n\n"
        wire = payload.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(wire)))
        self.end_headers()
        try:
            self.wfile.write(wire)
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def run_case(binary, label, scenario, base_dir):
    home = base_dir / (label + "-" + scenario)
    home.mkdir()
    agent = home / "agent"
    sessions = home / "sessions"
    cwd = home / "work"
    for path in (agent, sessions, cwd):
        path.mkdir()
    server = MockServer(scenario)
    server.started = time.monotonic()
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = "http://127.0.0.1:%d/v1" % server.server_address[1]
    models = {"providers": {"fixture": {"api": "openai-completions", "baseUrl": base_url,
                                      "apiKey": "offline-fixture-token", "models": [{
                                          "id": "goal-fixture", "name": "Goal Fixture",
                                          "reasoning": False, "contextWindow": 128000,
                                          "maxTokens": 4096}]}}}
    (agent / "models.json").write_text(json.dumps(models))
    (agent / "settings.json").write_text(json.dumps({"defaultProvider": "fixture",
                                                    "defaultModel": "goal-fixture"}))
    # An explicit environment prevents inherited tokens, proxies, or a user's
    # package/session paths from reaching either binary or a spawned kernel.
    env = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "TZ", "PYTHONPATH",
                                             "PRIME_AGENT_KERNEL_PYTHON", "PA_E2E_KERNEL_PYTHON")
           if key in os.environ}
    env.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home / "config"),
                "XDG_CACHE_HOME": str(home / "cache"), "XDG_DATA_HOME": str(home / "data"),
                "TMPDIR": str(home / "tmp"), "DO_NOT_TRACK": "1", "PI_OFFLINE": "1",
                "PI_CODING_AGENT_DIR": str(agent), "PI_SESSION_DIR": str(sessions),
                "PRIME_AGENT_CODING_AGENT_DIR": str(agent),
                "PRIME_AGENT_SESSION_DIR": str(sessions)})
    (home / "tmp").mkdir()
    goal_module = next((pathlib.Path(part) / "goal" / "__init__.py"
                        for part in env.get("PYTHONPATH", "").split(os.pathsep)
                        if part and (pathlib.Path(part) / "goal" / "__init__.py").is_file()), None)
    kernel_provenance = {
        "kernel_python": env.get("PRIME_AGENT_KERNEL_PYTHON"),
        "e2e_kernel_python": env.get("PA_E2E_KERNEL_PYTHON"),
        "pythonpath": env.get("PYTHONPATH"),
        "goal_module_path": str(goal_module) if goal_module else None,
        "goal_module_sha256": sha256(goal_module) if goal_module else None,
    }
    version = None
    if scenario == "control":
        probe = subprocess.run([str(binary), "--version"], cwd=cwd, env=env,
                               text=True, capture_output=True, timeout=10, check=False)
        version = {"exit_code": probe.returncode, "stdout": probe.stdout.strip(),
                   "stderr": probe.stderr.strip()}
        if probe.returncode != 0 or not probe.stdout.strip():
            raise RuntimeError("--version failed: " + json.dumps(version))
    command = [str(binary), "--mode", "json", "--provider", "fixture", "--model",
               "goal-fixture", "--no-session"]
    if scenario != "control":
        command += ["--goal", "Finish the offline fixture objective"]
    if scenario == "budget":
        command += ["--goal-token-budget", "1"]
    command += ["Complete the fixture task."]
    stdout_path = home / "stdout.jsonl"
    stderr_path = home / "stderr.txt"
    started = time.monotonic()
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr,
                                   start_new_session=True)
        server.process = process
        stopped = None
        try:
            while True:
                try:
                    exit_code = process.wait(timeout=0.15)
                    if server.limit_hit:
                        stopped = "request_observation_limit"
                    break
                except subprocess.TimeoutExpired:
                    pass
                with server.changed:
                    count = len(server.requests)
                if time.monotonic() - started > TIMEOUT_SECONDS:
                    stopped = "timeout"
                elif count >= MAX_REQUESTS:
                    stopped = "request_observation_limit"
                if stopped:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        exit_code = process.wait(timeout=2)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        exit_code = process.wait(timeout=2)
                    break
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    raw = stdout_path.read_text(errors="replace")
    errors = stderr_path.read_text(errors="replace")
    events = []
    for line in raw.splitlines():
        try:
            event = json.loads(line)
            if isinstance(event, dict):
                events.append(event)
        except json.JSONDecodeError:
            pass
    combined = raw + "\n" + errors
    goal_updates = [event["goal"] for event in events
                    if event.get("type") == "goal_update"
                    and isinstance(event.get("goal"), dict)]
    goal_statuses = [goal.get("status") for goal in goal_updates]
    final_goal_status = goal_statuses[-1] if goal_statuses else None
    tool_events = []
    for event in events:
        if event.get("type") == "tool_execution_end":
            tool_events.append({key: event.get(key) for key in
                                ("toolName", "toolCallId", "isError", "result") if key in event})
    turn_tool_results = [event.get("toolResults") for event in events
                         if event.get("type") == "turn_end" and event.get("toolResults")]
    model_completion_text = False
    for event in events:
        message = event.get("message")
        if event.get("type") != "message_end" or not isinstance(message, dict):
            continue
        if message.get("role") != "assistant":
            continue
        content = message.get("content")
        if isinstance(content, list):
            model_completion_text |= any(
                isinstance(block, dict) and block.get("type") == "text"
                and "Goal completed." in block.get("text", "") for block in content
            )
    return {
        "version_probe": version,
        "kernel_provenance": kernel_provenance if scenario == "control" else None,
        "exit_code": exit_code,
        "stopped": stopped,
        "elapsed_ms": round((time.monotonic() - started) * 1000),
        "requests": server.requests,
        "wake_request_numbers": [row["number"] for row in server.requests if row["wake_marker"]],
        "goal_context_request_numbers": [row["number"] for row in server.requests if row["goal_context"]],
        "request_count": len(server.requests),
        "event_types": [event.get("type") for event in events],
        "tool_execution_end": tool_events,
        "turn_end_tool_results": turn_tool_results,
        "goal_statuses": goal_statuses,
        "final_goal_status": final_goal_status,
        "confirmed_goal_complete": final_goal_status == "complete",
        "model_completion_text_seen": model_completion_text,
        "goal_context_count": combined.count("goal_context"),
        "wake_marker_count": combined.count("<goal_backoff_wake>"),
        "cap_reason_seen": "Goal continuation cap reached: consecutive turns made no progress" in combined,
        "stderr_tail": errors[-2500:],
        "stdout_tail": raw[-3500:],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--receipt", type=pathlib.Path, required=True)
    args = parser.parse_args()
    paths = {}
    for label in ("TS", "RUST"):
        value = os.environ.get("PA_" + label + "_BINARY")
        if not value or not pathlib.Path(value).is_file() or not os.access(value, os.X_OK):
            parser.error("PA_" + label + "_BINARY must name an executable file")
        paths[label.lower()] = pathlib.Path(value).resolve()
    if sys.platform != "linux":
        parser.error("this fixture runs only in Linux CI")
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    if args.receipt.resolve().is_relative_to(pathlib.Path.cwd().resolve()):
        parser.error("--receipt must be outside the repository")
    archive = os.environ.get("PA_TS_ARCHIVE")
    if not archive or not pathlib.Path(archive).is_file():
        parser.error("PA_TS_ARCHIVE must name the downloaded official TS 0.9.8 archive")
    archive_hash = sha256(archive)
    if archive_hash != TS_ARCHIVE_SHA256:
        parser.error("PA_TS_ARCHIVE SHA-256 mismatch: " + archive_hash)
    result = {"ts_release_archive_sha256": archive_hash,
              "binaries": {key: {"path": str(path), "sha256": sha256(path)}
                           for key, path in paths.items()},
              "scenarios": {}, "differences": {}, "fixture_error": None}
    with tempfile.TemporaryDirectory(prefix="goal-backoff-parity-") as temp:
        base_dir = pathlib.Path(temp)
        for scenario in ("control", "empty", "recover", "budget"):
            result["scenarios"][scenario] = {}
            for label, binary in paths.items():
                try:
                    result["scenarios"][scenario][label] = run_case(binary, label, scenario, base_dir)
                except Exception as exc:
                    result["fixture_error"] = "%s/%s: %s" % (scenario, label, exc)
                    break
            if result["fixture_error"]:
                break
            ts = result["scenarios"][scenario]["ts"]
            rust = result["scenarios"][scenario]["rust"]
            if scenario == "control":
                for label in paths:
                    result["binaries"][label]["version_probe"] = result["scenarios"][scenario][label]["version_probe"]
                    result["binaries"][label]["kernel_provenance"] = result["scenarios"][scenario][label]["kernel_provenance"]
            result["differences"][scenario] = {
                field: {"ts": ts[field], "rust": rust[field]}
                for field in ("request_count", "wake_marker_count", "wake_request_numbers",
                              "goal_context_request_numbers", "cap_reason_seen",
                              "final_goal_status", "confirmed_goal_complete",
                              "model_completion_text_seen", "exit_code", "stopped")
                if ts[field] != rust[field]
            }
    all_runs = [run for versions in result["scenarios"].values() for run in versions.values()]
    result["observed_fields_equal"] = not any(result["differences"].values())
    result["validation_complete"] = (not result["fixture_error"] and len(all_runs) == 8
                                     and all(run["request_count"] > 0 and run["stopped"] is None
                                             for run in all_runs))
    recovery = result["scenarios"].get("recover", {})
    result["recovery_confirmed"] = (len(recovery) == 2 and
                                    all(run["confirmed_goal_complete"] for run in recovery.values()))
    result["parity"] = (result["observed_fields_equal"] and result["validation_complete"]
                        and result["recovery_confirmed"])
    result["requires_behavior_decision"] = not result["parity"]
    args.receipt.write_text(json.dumps(result, indent=2) + "\n")
    print("goal parity receipt: %s" % args.receipt)
    for scenario, versions in result["scenarios"].items():
        print(scenario + ": " + ", ".join("%s requests=%s exit=%s stopped=%s" %
                                           (label, run["request_count"], run["exit_code"], run["stopped"])
                                           for label, run in versions.items()))
    if result["requires_behavior_decision"]:
        print("PARITY NOT CONFIRMED: inspect differences and incomplete observations in receipt")
    if result["binaries"].get("ts", {}).get("kernel_provenance"):
        print("kernel/goal provenance: " + json.dumps(result["binaries"]["ts"]["kernel_provenance"]))
    if result["fixture_error"]:
        print(result["fixture_error"], file=sys.stderr)
        return 1
    if any(run["request_count"] == 0 for versions in result["scenarios"].values()
           for run in versions.values()):
        print("a binary made no mock-provider request; inspect receipt", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
