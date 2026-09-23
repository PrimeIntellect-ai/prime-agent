#!/usr/bin/env python3
"""ACP-mode auto-compaction parity verifier: frame-diff the Rust in-process
ACP transport against the installed TS prime-agent binary for the automatic
compaction arms on the ACP turn path.

TS ruling under test (agent-session.ts): the arms live in the AgentSession
turn loop itself (`_runPreTurnCompaction` / `_checkCompaction` /
`_runAutoCompaction`), so the TS ACP mode hosts them through its
AgentConnection and its event adapter maps every `compaction_end` to the
namespaced `compaction` meta (`acp-events.ts`). The Rust in-process ACP
transport gained the same arms (`crates/pa-daemon/src/acp/compaction_arms.rs`);
this harness proves the observable wire parity.

Scenario (one shared faux provider script, per-binary isolated
HOME/agent-dir sandboxes; the TS side reads the script through the shared
faux extension, the Rust side through PRIME_AGENT_FAUX_SCRIPT — which also
forces the Rust in-process transport, bypassing the daemon-attached one):

  - threshold: turn one (8k chars, ~2k tokens over the 500-token headroom
    on the 128k window): the threshold arm fires at the settled boundary
    and the single-turn compaction skips — the skip is observable as the
    empty `compaction: {}` meta,
  - threshold turn two: the pre-turn arm skips again (still nothing
    before turn one to summarize), then the settled boundary compaction
    runs, summarizing turn one and publishing `tokensBefore` + the
    scripted summary.
  - goal: `/goal --budget 5 ...` (compaction disabled) drives the direct
    ACP goal continuation surface the TS session hosts inside the one
    `session/prompt` run: the goal-start continuation segment streams,
    the crossing turn's usage flips the goal to `budget_limited`, and the
    budget-limit wrap-up steer runs as the prompt's second model segment
    before the end_turn response. Byte-compared against the TS binary
    (the #244 direct-ACP ruling).

Every frame after `session/new` (notifications and responses alike) is
captured per side, normalized for volatile content (session ids, request
ids echo is deterministic by construction, timestamps, the tokensBefore
count), and diffed; the exit code is non-zero when any frame differs.
"""

import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)

FAUX_SCRIPT = {
    "engine": "faux",
    "modelId": "faux-1",
    "modelName": "Faux Model",
    "reasoning": False,
    "contextWindow": 128000,
    "responses": [
        {"text": "turn one reply"},
        {"text": "turn two reply"},
        {"text": "the auto summary"},
    ],
}

# The threshold-crossing shape on the 128k window: turn one crosses on
# both products — TS at window - reserve = 4596, Rust at the combined
# input+output ceiling 128000 - 4096 output budget - 123404 reserve = 500
# — and a tiny keep-recent budget keeps the seeded turns summarizable.
SETTINGS = {
    "compaction": {
        "enabled": True,
        "reserveTokens": 123404,
        "keepRecentTokens": 10,
    }
}

TS_FAUX_EXTENSION = open(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ts_faux_extension.js"),
    encoding="utf-8",
).read()

TURN_ONE = "turn one " + "x" * 8000
TURN_TWO = "turn two"

# The overflow scenario: a seed turn, then a provider context-overflow
# error on the probe turn (the compact-and-retry recovers it).
OVERFLOW_ERROR = {
    "text": "",
    "stopReason": "error",
    "errorMessage": "prompt is too long: 213462 tokens > 200000 maximum",
}

# The ACP meta namespace (the goal frames' home).
NAMESPACE = "ai.primeintellect.prime-agent"

TIMEOUT = 180


def find_runtime_package_dir():
    releases = os.path.expanduser("~/.local/share/prime-agent/releases")
    if not os.path.isdir(releases):
        raise SystemExit("cannot find the prime-agent-runtime sidecar; set PI_PACKAGE_DIR")
    candidates = [
        entry
        for entry in sorted(os.listdir(releases))
        if os.path.isdir(os.path.join(releases, entry, "prime-agent-runtime"))
    ]
    if not candidates:
        raise SystemExit("no release with prime-agent-runtime/ under " + releases)
    return os.path.join(releases, candidates[-1])


class AcpProcess:
    """One ACP-mode child over stdio: requests out, frames in.

    The TS side reads the script through the faux extension from its
    path; the Rust print/ACP path expects the JSON content inline.
    """

    def __init__(self, command, env, faux_script_value):
        self.env = dict(os.environ)
        self.env.update(env)
        self.env["PRIME_AGENT_FAUX_SCRIPT"] = faux_script_value
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=self.env,
            text=True,
            bufsize=1,
        )
        self.frames = []
        self.lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                continue
            with self.lock:
                self.frames.append(frame)
        self.process.stdout.close()

    def send(self, frame):
        self.process.stdin.write(json.dumps(frame) + "\n")
        self.process.stdin.flush()

    def request(self, request_id, method, params):
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})

    def wait_response(self, request_id, since):
        """Read frames until the request answers; returns (response, frames)."""
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            with self.lock:
                frames = self.frames[since:]
            for frame in frames:
                if frame.get("id") == request_id and (
                    "result" in frame or "error" in frame
                ):
                    return frame, frames
            time.sleep(0.05)
        raise TimeoutError(f"request {request_id} never answered; frames: {frames!r}")

    def close(self):
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
        stderr = self.process.stderr.read() if self.process.stderr else ""
        if stderr.strip():
            print(f"  child stderr: {stderr.strip()[:2000]}", file=sys.stderr)


def normalize(frames):
    """Erase volatile content from the captured frames: session ids, the
    tokensBefore count, and the faux stream's chunk granularity (the TS
    faux provider paces a response into several deltas where the Rust one
    emits fewer — the joined text per message is the observable contract,
    so consecutive chunks of one message coalesce into one frame, and
    eventSequence renumbers over the coalesced list)."""
    entries = []  # ("chunk", update-dict) or ("frame", response)
    for frame in frames:
        update = frame.get("params", {}).get("update")
        if isinstance(update, dict) and update.get("sessionUpdate") in (
            "agent_message_chunk",
            "agent_thought_chunk",
        ):
            kind = update.get("sessionUpdate")
            message_id = update.get("messageId")
            if (
                entries
                and entries[-1][0] == "chunk"
                and entries[-1][1].get("sessionUpdate") == kind
                and entries[-1][1].get("messageId") == message_id
            ):
                entry = entries[-1][1]
                entry["content"]["text"] += update.get("content", {}).get("text", "")
                continue
            entry = {
                "sessionUpdate": kind,
                "messageId": message_id,
                "content": {"text": update.get("content", {}).get("text", "")},
            }
            entries.append(("chunk", entry))
            continue
        entries.append(("frame", frame))

    normalized = []
    sequence = 0
    for kind, payload in entries:
        sequence += 1
        if kind == "chunk":
            normalized.append(
                {
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {
                        "sessionId": "<sid>",
                        "update": {
                            **payload,
                            "_meta": {
                                "ai.primeintellect.prime-agent": {
                                    "eventSequence": sequence,
                                    "phase": "event",
                                }
                            },
                        },
                    },
                }
            )
            continue
        text = json.dumps(payload, sort_keys=True)
        text = re.sub(r'"sessionId": "[0-9a-f-]{36}"', '"sessionId": "<sid>"', text)
        text = re.sub(r'"tokensBefore": \d+', '"tokensBefore": "<n>"', text)
        # Goal usage is a per-side token estimate (the #182 normalization
        # class): the goal metas and the goal-context texts carry the
        # same scrub as the f7 goal-continue battery.
        text = re.sub(r'"tokensUsed": \d+', '"tokensUsed": "<n>"', text)
        text = re.sub(r"- tokens used: -?\d+", "- tokens used: <n>", text)
        text = re.sub(r"- remaining tokens: -?\d+", "- remaining tokens: <n>", text)
        text = re.sub(r"- time used seconds: \d+", "- time used seconds: <n>", text)
        frame = json.loads(text)
        params = frame.get("params")
        if isinstance(params, dict):
            meta = (
                params.get("update", {}).get("_meta", {}).get(
                    "ai.primeintellect.prime-agent", {}
                )
            )
            if "eventSequence" in meta:
                meta["eventSequence"] = sequence
        normalized.append(frame)
    return normalized


def scenario(name):
    """One scenario's script, settings, and prompts."""
    if name == "threshold":
        return {
            "script": FAUX_SCRIPT,
            "settings": SETTINGS,
            "prompts": [TURN_ONE, TURN_TWO],
        }
    if name == "goal":
        # The budget-bounded goal loop: the start segment streams, the
        # crossing flips the goal to budget_limited, the wrap-up steer
        # runs as the second segment, and the prompt settles end_turn.
        # Compaction stays out of the picture (the goal frames are the
        # diff target).
        return {
            "script": {
                "engine": "faux",
                "modelId": "faux-1",
                "modelName": "Faux Model",
                "reasoning": False,
                "contextWindow": 128000,
                "responses": [
                    {"text": "goal turn reply"},
                    {"text": "wrap-up reply"},
                ],
            },
            "settings": {"compaction": {"enabled": False}},
            "prompts": ["/goal --budget 5 finish the work"],
        }
    return {
        "script": {
            "engine": "faux",
            "modelId": "faux-1",
            "modelName": "Faux Model",
            "reasoning": False,
            "contextWindow": 128000,
            "responses": [
                {"text": "seed reply"},
                OVERFLOW_ERROR,
                {"text": "the summary"},
                {"text": "recovered reply"},
            ],
        },
        "settings": {
            "compaction": {"enabled": True, "reserveTokens": 1, "keepRecentTokens": 10}
        },
        "prompts": [
            "seed turn " + "x" * 48000,
            "overflow probe " + "x" * 2000,
        ],
    }


def drive(binary, base, script_path, settings, prompts, out_dir):
    home = os.path.join(base, binary, "home")
    agent = os.path.join(base, binary, "agent")
    tmp = os.path.join(base, binary, "tmp")
    for path in (home, tmp, agent):
        os.makedirs(path, exist_ok=True)
    with open(os.path.join(agent, "settings.json"), "w") as f:
        json.dump(settings, f, indent=2)
    if binary == "ts":
        os.makedirs(os.path.join(agent, "extensions"), exist_ok=True)
        with open(os.path.join(agent, "extensions", "acp-faux.js"), "w") as f:
            f.write(TS_FAUX_EXTENSION)
        command = ["prime-agent", "--mode", "acp", "--no-session", "--model", "faux-1"]
        env = {"HOME": home, "TMPDIR": tmp, "PRIME_AGENT_CODING_AGENT_DIR": agent}
    else:
        rust = ts_identity.default_rust_binary()
        package_dir = os.environ.get("PI_PACKAGE_DIR") or find_runtime_package_dir()
        command = [
            rust,
            "--mode",
            "acp",
            "--no-session",
            "--model",
            "faux-1",
        ]
        env = {
            "HOME": home,
            "TMPDIR": tmp,
            "PRIME_AGENT_CODING_AGENT_DIR": agent,
            "PI_PACKAGE_DIR": package_dir,
        }
    if binary == "ts":
        faux_value = script_path
    else:
        with open(script_path) as f:
            faux_value = f.read()
    acp = AcpProcess(command, env, faux_value)
    try:
        acp.request(1, "initialize", {"protocolVersion": 1, "clientCapabilities": {}})
        response, _ = acp.wait_response(1, 0)
        assert "result" in response, f"initialize failed: {response}"

        acp.request(2, "session/new", {"cwd": os.getcwd(), "mcpServers": []})
        response, frames = acp.wait_response(2, len(acp.frames))
        assert "result" in response, f"session/new failed: {response}"

        # The scenario capture starts after admission: every frame of both
        # prompt turns, notifications and responses alike.
        session_id = response["result"]["sessionId"]
        captured = []
        request_id = 2
        for prompt in prompts:
            request_id += 1
            since = len(acp.frames)
            acp.request(
                request_id,
                "session/prompt",
                {"sessionId": session_id, "prompt": [{"type": "text", "text": prompt}]},
            )
            reply, frames = acp.wait_response(request_id, since)
            captured.extend(frames)
    finally:
        acp.close()

    normalized = normalize(captured)
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "frames.json"), "w") as f:
        json.dump(normalized, f, indent=2)
    return normalized


def main():
    ts_identity.assert_ts_side_is_the_ts_product()
    failures = 0
    for name in ("threshold", "overflow", "goal"):
        if run_scenario(name):
            print(f"ACP auto-compaction parity ({name}): PASS")
        else:
            failures += 1
    return 1 if failures else 0


def run_scenario(name):
    base = tempfile.mkdtemp(prefix=f"acp-compaction-parity-{name}-")
    try:
        return _run_scenario(name, base)
    finally:
        shutil.rmtree(base, ignore_errors=True)


def _run_scenario(name, base):
    config = scenario(name)
    script_path = os.path.join(base, "faux-script.json")
    with open(script_path, "w") as f:
        json.dump(config["script"], f, indent=2)
    out_dir = os.path.join(base, "out")
    ts_frames = drive(
        "ts", base, script_path, config["settings"], config["prompts"],
        os.path.join(out_dir, "ts"),
    )
    rust_frames = drive(
        "rust", base, script_path, config["settings"], config["prompts"],
        os.path.join(out_dir, "rust"),
    )

    def render(frames):
        return [json.dumps(frame, sort_keys=True, indent=1) for frame in frames]

    def compaction_metas(frames):
        metas = []
        for frame in frames:
            update = frame.get("params", {}).get("update", {})
            meta = update.get("_meta", {}).get("ai.primeintellect.prime-agent", {})
            if "compaction" in meta:
                metas.append(meta["compaction"])
        return metas

    # The scenario must exercise the arms on both sides; the expected
    # metas differ per scenario.
    expectations = {
        # The goal scenario asserts on goal frames below, not compaction
        # metas (its compaction is disabled).
        "goal": [],
        "threshold": [
            ("a skipped-compaction frame (the single-turn skip)", lambda m: m == {}),
            (
                "the ran-compaction frame (the scripted summary)",
                lambda m: "the auto summary" in (m.get("summary") or ""),
            ),
        ],
        "overflow": [
            (
                "the ran-compaction frame (the compact-and-retry summary)",
                lambda m: "the summary" in (m.get("summary") or ""),
            ),
            (
                "the recovered turn settled with end_turn",
                None,  # response-level check below
            ),
        ],
    }
    for side, frames in (("ts", ts_frames), ("rust", rust_frames)):
        metas = compaction_metas(frames)
        for description, predicate in expectations[name]:
            if predicate is None:
                continue
            assert any(predicate(meta) for meta in metas), (
                f"the {side} side never published {description} "
                f"(metas: {metas!r})"
            )

    def responses(frames):
        return [
            frame for frame in frames
            if "result" in frame or "error" in frame
        ]

    # The goal scenario must drive the continuation surface on both
    # sides: the goal flips to budget_limited, the wrap-up steer streams
    # its scripted answer, and the prompt settles end_turn.
    if name == "goal":
        for side, frames in (("ts", ts_frames), ("rust", rust_frames)):
            goals = [
                frame["params"]["update"]["_meta"][NAMESPACE]["goal"]
                for frame in frames
                if frame.get("params", {})
                .get("update", {})
                .get("_meta", {})
                .get(NAMESPACE, {})
                .get("goal")
            ]
            assert any(goal.get("status") == "budget_limited" for goal in goals), (
                f"the {side} side never published the budget_limited goal: {goals!r}"
            )
            replies = responses(frames)
            assert len(replies) == 1, f"{side}: expected one prompt reply, got {replies!r}"
            assert replies[0]["result"]["stopReason"] == "end_turn", (
                f"the {side} side's goal prompt did not settle end_turn: {replies[0]!r}"
            )
            streamed = "".join(
                frame["params"]["update"].get("content", {}).get("text", "")
                for frame in frames
                if "content" in frame.get("params", {}).get("update", {})
            )
            assert "wrap-up reply" in streamed, (
                f"the {side} side's wrap-up steer never streamed: {streamed!r}"
            )

    # The overflow scenario's probe turn must recover on both sides.
    if name == "overflow":
        for side, frames in (("ts", ts_frames), ("rust", rust_frames)):
            replies = responses(frames)
            assert len(replies) == 2, f"{side}: expected two prompt replies, got {replies!r}"
            assert replies[1]["result"]["stopReason"] == "end_turn", (
                f"the {side} side's overflow recovery did not settle end_turn: {replies[1]!r}"
            )

    ts_lines, rust_lines = render(ts_frames), render(rust_frames)
    if ts_lines == rust_lines:
        print(f"({len(ts_lines)} frames identical)")
        return True
    diff = list(
        difflib.unified_diff(ts_lines, rust_lines, "ts", "rust", lineterm="", n=2)
    )
    print(f"ACP auto-compaction parity ({name}): FAIL — frame diff:")
    for line in diff[:80]:
        print(line)
    return False


if __name__ == "__main__":
    sys.exit(main())
