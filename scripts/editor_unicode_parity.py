#!/usr/bin/env python3
"""Editor Unicode/grapheme wrap parity verifier (the `editor-wrap-unicode`
lane, FEATURE_PARITY.md tier-0): frame-diff the Rust interactive
TUI against the installed TS binary in tmux over a golden Unicode corpus.

Two tmux sessions per binary (each pane its own transcript):

  - CORE (gating): CJK prose past the editor width (the audit's crash
    class), Thai/Lao AM rows in the editor AND in a rendered response with
    a literal tab (the paint-time decomposition + tab cells), wide box
    drawing, a pure-ASCII wrap regression, and editing states over
    cluster-safe text (cursor steps, a whole-cluster backspace, a word
    kill). Every state must frame-match.
  - CLUSTERS (known-gap, non-gating): multi-char clusters — ZWJ families,
    flag pairs, keycaps, skin tones, halfwidth voicing marks, Devanagari
    spacing matras, zero-width chars. KNOWN GAP (root-caused 2026-09-22):
    the Rust paint is a per-cell ratatui diff that assumes
    grapheme-joined cells (family = 2 cells) while the box's tmux 3.2a
    predates cluster joining, so the post-cluster MoveTo lands inside the
    cluster's tmux footprint and overwrites its halves; the TS paint
    writes whole rows so its capture degrades by column shift only. The
    editor buffer, the submitted text, and the wrap/width model are
    byte-exact (unit goldens + a raw-pty byte capture); the paint seam
    needs a row-write backend (a follow-up paint lane). Cluster states
    are compared and reported, but do not gate.

Both binaries run through the scripted faux provider; frames are captured
with escape sequences and compared through the `visual_parity.py` helpers
(`capture`/`normalize`/`diff_lines`). Exit code is non-zero when any CORE
state differs.

tmux rules: default socket only (`env -u TMUX`), euplane-* session names,
no kill-server; sessions are killed individually at the end.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "battery"))
import batterylib  # noqa: E402  (the shared daemon-reap sweep)
import ts_identity  # noqa: E402  (the shared PATH-binary identity guard)
import visual_parity as vp  # noqa: E402  (capture/normalize/diff helpers)

TS_SCRIPT_MODEL = vp.TS_SCRIPT_MODEL
# One narrow and one comfortable size: the narrow pane forces wrap
# opportunities in every corpus row; the comfortable one keeps long CJK runs
# wrapped and the rest whole.
SIZES = [("100", "30"), ("80", "24")]

WORKING_LABEL = re.compile(r"Thinking \u00b7|Waiting")

# The gating corpus: every row renders identically on both binaries.
CORE_PROMPTS = [
    # CJK prose wider than the editor (the audit's panic class).
    ("cjk", "这是一段很长的中文文本，超过了编辑器的宽度，会触发换行逻辑的边界情况，看看两边渲染是否一致。"),
    # Thai/Lao AM (paint-time decomposition) in the editor AND in the
    # response (which also carries a literal tab: three cells at paint).
    ("thai_lao", "ทดสอบภาษาไทยำ สระอำ และພາສາລາວຳ ผ่าน"),
    # Wide box drawing (single-codepoint wide chars).
    ("box", "─━┏━━━━━┓─ box drawing row ┗━━━━━┛ ✅ done"),
    # Pure-ASCII wrap regression (wrap opportunities must not change).
    ("ascii", "the plain ascii wrapping sanity check paragraph spans several word boundaries and must wrap at the same opportunities on both binaries without any unicode involvement at all"),
]

# The known-gap cluster corpus (multi-char clusters; see the module doc).
CLUSTER_PROMPTS = [
    ("emoji", "family 👨‍👩‍👧‍👦 flags 🇯🇵🇺🇸 keycap #️⃣ skin 👍🏽 more 👨‍👩‍👧‍👦 ok"),
    ("clusters", "café café café カﾞキﾞクﾞケﾞ नमस्ते स्वागत है"),
    ("zero_box", "─━┏━━━━━┓─ zero\u200bwidth ┗━━━━━┛ ✅ done"),
    ("mixed", "hello 안녕하세요 world 안녕 你好 👨‍👩‍👧‍👦 mixed content wrapping row"),
]

# The editing-behavior line (typed, never submitted): BMP-safe clusters so
# the editing states gate — wide CJK, a precomposed accented char, and Thai
# (Mn marks cluster with their base and paint cleanly).
EDIT_LINE = "ab你好 café สวัสดี"

# Cluster-editing line (known-gap session): family emoji + combining marks.
EDIT_LINE_CLUSTERS = "ab你好 👨‍👩‍👧‍👦 café क"
LEFT_STEPS = 4
WORD_KILLS = 1

# The responses, one per submitted prompt (consumed in submit order). The
# Thai row's response carries the paint-normalization probes (AM + tab).
def core_responses():
    responses = [
        {"content": [{"type": "text", "text": f"ack {i}: confirmed."}]}
        for i in range(1, len(CORE_PROMPTS) + 1)
    ]
    responses[1] = {
        "content": [{"type": "text", "text": "ack 2: ทำงาน\ttabbed ผ่าน all done."}]
    }
    return responses


def cluster_responses():
    return [
        {"content": [{"type": "text", "text": f"ack {i}: confirmed."}]}
        for i in range(1, len(CLUSTER_PROMPTS) + 1)
    ]


def faux_script(responses):
    return {
        "engine": "faux",
        "modelId": TS_SCRIPT_MODEL,
        "modelName": "Faux Model",
        "reasoning": False,
        "contextWindow": 128000,
        "tokensPerSecond": 400,
        "responses": responses,
    }


def type_text(session, text):
    """Type literal text into the editor pane (UTF-8 keystrokes)."""
    vp.tmux("send-keys", "-t", session, "-l", text)


def wait_for_settled(session, needle, timeout=60):
    """Wait for `needle` and a quiet loader row (the turn finished)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = vp.capture(session, escape=False)
        if needle in pane and not WORKING_LABEL.search(pane):
            return True
        time.sleep(0.3)
    raise TimeoutError(f"session {session} never settled on {needle!r}")


def wait_for_stability(session, timeout=30):
    """Wait until the pane stops changing (known-gap cluster rows never show
    their intact tail on the Rust side, so settle on frame stability)."""
    deadline = time.time() + timeout
    previous = vp.capture(session, escape=False)
    while time.time() < deadline:
        time.sleep(0.4)
        current = vp.capture(session, escape=False)
        if current == previous:
            return True
        previous = current
    return False


def wait_for_typed(session, tail, timeout=30):
    """Wait for the last chars of a typed row (typing lag tolerance).

    The pane shows the paint-normalized form, so a Thai/Lao AM char in the
    tail matches its decomposed rendering too (normalizeTerminalOutput).
    """
    needles = [tail]
    if "\u0e33" in tail or "\u0eb3" in tail:
        normalized = tail.replace("\u0e33", "\u0e4d\u0e32").replace("\u0eb3", "\u0ecd\u0eb2")
        needles.append(normalized)
    deadline = time.time() + timeout
    while time.time() < deadline:
        pane = vp.capture(session, escape=False)
        if any(needle in pane for needle in needles):
            return True
        time.sleep(0.2)
    raise TimeoutError(f"session {session} never showed typed tail {tail!r}")


def run_session(
    binary,
    sandbox,
    shared_cwd,
    script_path,
    size,
    out_dir,
    session_prefix,
    ts_bin,
    prompts,
    edit_line,
    exact_settle=True,
):
    """Drive one binary through the corpus, capturing each frame."""
    width, height = size
    session = f"euplane-{session_prefix}-{binary}-{width}x{height}"
    vp.tmux("kill-session", "-t", session, check=False)
    vp.tmux("new-session", "-d", "-s", session, "-x", width, "-y", height, "-c", shared_cwd)
    env = (
        f"HOME={sandbox['home']} "
        f"TMPDIR={sandbox['tmp']} "
        f"PRIME_AGENT_CODING_AGENT_DIR={sandbox['agent']} "
        f"PRIME_AGENT_FAUX_SCRIPT={script_path} "
        "PRIME_AGENT_DISABLE_ANALYTICS=1"
    )
    if binary == "ts":
        # The ts side defaults to the PATH binary but the box install is a
        # Rust dogfood build — pass the deployed TS release explicitly
        # (`--ts-bin`), like the other harnesses.
        command = (
            f"{ts_bin} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {TS_SCRIPT_MODEL}"
        )
    else:
        rust = os.environ.get(
            "PA_RUST_BINARY",
            os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "..", "target", "debug", "prime-agent"
            ),
        )
        package_dir = os.environ.get("PI_PACKAGE_DIR") or vp.find_runtime_package_dir()
        command = (
            f"PI_PACKAGE_DIR={package_dir} "
            f"{rust} --daemon-socket {sandbox['agent']}/daemon.sock "
            f"--model {TS_SCRIPT_MODEL}"
        )
    vp.tmux("send-keys", "-t", session, f"{env} {command}", "Enter")

    frames = {}
    try:
        # (a) fresh start: splash + empty editor.
        vp.wait_for(session, "Collapsed mode", timeout=40)
        time.sleep(1.0)
        frames["a_fresh_start"] = vp.capture(session)

        # (b) the corpus: type each row, capture the editor wrap mid-edit,
        # then submit and capture the settled post-turn frame (user echo +
        # assistant render).
        for idx, (name, text) in enumerate(prompts):
            type_text(session, text)
            if exact_settle:
                wait_for_typed(session, text[-6:])
            else:
                wait_for_stability(session)
            time.sleep(0.5)
            frames[f"b_{name}_editor"] = vp.capture(session)
            vp.tmux("send-keys", "-t", session, "Enter")
            wait_for_settled(session, f"ack {idx + 1}:")
            time.sleep(1.0)
            frames[f"c_{name}_settled"] = vp.capture(session)

        # (d) editing behavior over clusters: cursor-left steps across
        # cluster boundaries, a backspace over a whole cluster, a word-kill
        # over the run, then deleteToLineStart clears the draft.
        type_text(session, edit_line)
        if exact_settle:
            wait_for_typed(session, edit_line[-6:])
        else:
            wait_for_stability(session)
        time.sleep(0.5)
        frames["d_edit_typed"] = vp.capture(session)
        for _ in range(LEFT_STEPS):
            vp.tmux("send-keys", "-t", session, "Left")
        time.sleep(0.6)
        frames["e_cursor_left"] = vp.capture(session)
        vp.tmux("send-keys", "-t", session, "BSpace")
        time.sleep(0.6)
        frames["f_backspace_cluster"] = vp.capture(session)
        for _ in range(WORD_KILLS):
            vp.tmux("send-keys", "-t", session, "C-w")
        time.sleep(0.6)
        frames["g_word_kill"] = vp.capture(session)
        vp.tmux("send-keys", "-t", session, "C-u")
        time.sleep(0.6)
        frames["h_line_cleared"] = vp.capture(session)

        for state, frame in frames.items():
            with open(
                os.path.join(out_dir, f"{binary}-{width}x{height}-{state}.ansi"), "w"
            ) as f:
                f.write(frame)
    finally:
        # A wait timeout must not leak the detached pane (and the shell and
        # daemon inside it) past the run (Macroscope, PR #2600). The kill is
        # idempotent cleanup: a session that already died (binary crash, or
        # the settle timeout fired after the pane vanished) must not raise
        # and mask the original error.
        vp.tmux("kill-session", "-t", session, check=False)
    return frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keep", action="store_true", help="keep the sandbox dir")
    parser.add_argument(
        "--out", default=None, help="captures directory (default: a fresh temp dir)"
    )
    parser.add_argument("--binary", choices=("ts", "rust"), default=None, help="run one side only")
    parser.add_argument("--sizes", default=",".join(f"{w}x{h}" for w, h in SIZES))
    parser.add_argument(
        "--ts-bin",
        default="prime-agent",
        help="the ts-side binary (default: the PATH prime-agent)",
    )
    parser.add_argument(
        "--session-prefix",
        default="eu",
        help="tmux session-name prefix (euplane-<prefix>-<binary>-WxH)",
    )
    args = parser.parse_args()

    import visual_parity as vpm

    sizes = []
    for entry in args.sizes.split(","):
        width, height = entry.split("x")
        sizes.append((width, height))

    # Fail fast before any launch: a non-TS `prime-agent` (the box PATH
    # install is a Rust dogfood build of this repo) plays a Rust build as
    # the "ts" side and reports false divergences.
    if args.binary in (None, "ts"):
        ts_identity.assert_ts_side_is_the_ts_product(args.ts_bin)

    base = tempfile.mkdtemp(prefix="eu-parity-")
    out_dir = args.out or tempfile.mkdtemp(prefix="editor-unicode-captures-")
    os.makedirs(out_dir, exist_ok=True)

    shared_cwd, _, sandboxes = vpm.prepare_sandbox(base)

    failures = []
    known_gaps = []
    try:
        if args.binary:
            run_session(
                args.binary,
                sandboxes[args.binary],
                shared_cwd,
                core_script_path(base),
                sizes[0],
                out_dir,
                args.session_prefix,
                args.ts_bin,
                CORE_PROMPTS,
                EDIT_LINE,
            )
            print(f"captures for {args.binary} in {out_dir}")
            return 0
        for size in sizes:
            for kind, prompts, edit_line, responses in (
                ("core", CORE_PROMPTS, EDIT_LINE, core_responses()),
                ("clusters", CLUSTER_PROMPTS, EDIT_LINE_CLUSTERS, cluster_responses()),
            ):
                script_path = os.path.join(base, f"faux-{kind}.json")
                with open(script_path, "w") as f:
                    json.dump(faux_script(responses), f, indent=2)
                ts_frames = run_session(
                    "ts",
                    sandboxes["ts"],
                    shared_cwd,
                    script_path,
                    size,
                    out_dir,
                    f"{args.session_prefix}-{kind}",
                    args.ts_bin,
                    prompts,
                    edit_line,
                    exact_settle=(kind == "core"),
                )
                rust_frames = run_session(
                    "rust",
                    sandboxes["rust"],
                    shared_cwd,
                    script_path,
                    size,
                    out_dir,
                    f"{args.session_prefix}-{kind}",
                    args.ts_bin,
                    prompts,
                    edit_line,
                    exact_settle=(kind == "core"),
                )
                for state in ts_frames:
                    name = f"{kind}/{state}-{size[0]}x{size[1]}"
                    if state not in rust_frames:
                        (failures if kind == "core" else known_gaps).append(name)
                        print(f"FAIL {name} (absent on rust)")
                        continue
                    ts_norm = vp.normalize(ts_frames[state], base)
                    rust_norm = vp.normalize(rust_frames[state], base)
                    if ts_norm == rust_norm:
                        print(f"PASS {name}")
                    else:
                        print(f"{'FAIL' if kind == 'core' else 'GAP'} {name}")
                        report = os.path.join(
                            out_dir, f"diff-{kind}-{state}-{size[0]}x{size[1]}.txt"
                        )
                        with open(report, "w") as f:
                            f.write(vp.diff_lines(ts_norm, rust_norm))
                        print(f"  diff: {report}")
                        (failures if kind == "core" else known_gaps).append(name)
    finally:
        batterylib.reap_daemons(needles=[base], cwd_roots=[base])
        if not args.keep:
            shutil.rmtree(base, ignore_errors=True)
    if known_gaps:
        print(
            f"{len(known_gaps)} cluster state(s) differ (KNOWN GAP: tmux 3.2a "
            "predates grapheme joining; see the module doc) — non-gating"
        )
    if failures:
        print(f"{len(failures)} CORE state(s) differ; captures in {out_dir}")
        return 1
    print("all CORE states match; captures in", out_dir)
    return 0


def core_script_path(base):
    path = os.path.join(base, "faux-core.json")
    with open(path, "w") as f:
        json.dump(faux_script(core_responses()), f, indent=2)
    return path


if __name__ == "__main__":
    sys.exit(main())
