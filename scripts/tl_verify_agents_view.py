
"""Interactive verifier (tmux): the Rust agents view renders the thinking
level on a TOP-LEVEL row in every universe:
  1. live session row (unregressed):            "mock-1:high"
  2. after a daemon restart (saved-catalog row): "mock-1:high" (was bare "mock-1")
  3. a stopped subagent (ledger-seeded row):     "mock-1:high"
The TS binary runs the same flow for the cross-side record.
"""
import json, os, sys, time, shutil
from pathlib import Path

sys.path.insert(0, "/home/ubuntu/prime-agent-rs/scripts/battery")
import batterylib as B

RUN = Path("/tmp/thinking-level-verify")
BINARY = sys.argv[1] if len(sys.argv) > 1 else "/tmp/prime-agent-tl-musl"
TAG = Path(BINARY).name

def make_side(name, binary):
    root = RUN / name
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    agent = root / "agent"; work = root / "work"
    work.mkdir(parents=True); agent.mkdir(parents=True)
    mock = B.MockProvider(root, [0])
    mock.set_responses([{"text": "verify reply"}])
    mock.start()
    tmpdir = Path("/tmp") / f"tl-verify-{name}"
    if tmpdir.exists(): shutil.rmtree(tmpdir)
    tmpdir.mkdir(parents=True)
    side = B.Side(name=name, binary=binary, root=root, agent_dir=agent,
                  work_dir=work, daemon_socket=root / "daemon.sock", mock=mock)
    side.env = B.scrubbed_env(agent, tmpdir, {})
    models = {"providers": {"prime-inference": {
        "api": "openai-completions", "baseUrl": mock.url(), "apiKey": "sk-battery",
        "models": [{"id": "mock-1", "name": "Mock 1", "api": "openai-completions",
                     "baseUrl": mock.url(), "reasoning": True,
                     "contextWindow": 128000, "maxTokens": 4096}]}}}
    (agent / "models.json").write_text(json.dumps(models, indent=1))
    sp = agent / "settings.json"
    sp.write_text(json.dumps({"onboardingShown": True}))
    return side

def capture_rows(side, tag, expect_text="Model", expand=False):
    sess = f"tlv-{tag}-{side.name}"
    argv = [BINARY, "agents", "--daemon-socket", str(side.daemon_socket)]
    B.tmux_launch(sess, argv, side.env, side.work_dir)
    B.tmux_wait_text(sess, expect_text, timeout=60)
    time.sleep(2.0)
    frame = B.tmux_capture(sess)
    side.evidence(tag, f"{tag}-{side.name}.txt", frame)
    rows = [ln for ln in frame.splitlines() if "mock-1" in ln or "subagent" in ln]
    for ln in rows:
        print(f"[{TAG}] {tag}/{side.name} ROW:", ln)
    if expand:
        # Move to the subagent-summary row and toggle it open.
        for key in ("down", "down", "Right"):
            B.tmux_send(sess, key, enter=False)
            time.sleep(0.6)
        time.sleep(1.0)
        frame = B.tmux_capture(sess)
        side.evidence(tag, f"{tag}-expanded-{side.name}.txt", frame)
        for ln in frame.splitlines():
            if "mock-1" in ln or "subagent" in ln:
                print(f"[{TAG}] {tag}-expanded/{side.name} ROW:", ln)
    B.tmux_kill(sess)
    return frame

side = make_side(Path(BINARY).name, BINARY)
side.mock.set_responses([{"text": "verify reply"}])
side.start_daemon()
wire = B.Wire(side.daemon_socket)
create = wire.request("c1", {"type": "create", "name": "verify-top", "config": {
    "cwd": str(side.work_dir), "sessionDir": str(side.agent_dir / "sessions"),
    "provider": "prime-inference", "model": "mock-1", "thinking": "high",
    "executionMode": "print"}}, timeout=120)
assert create.get("success") is True, create
top = create["data"].get("activeSessionId") or create["data"].get("id")
pw = wire.request("p1", {"type": "prompt_and_wait", "activeSessionId": top,
                         "message": "verify prompt"}, timeout=180)
print(f"[{TAG}] prompt ok:", pw.get("success"))
# A subagent child (spawn task context: model + thinking high), then stop it.
child_dir = side.agent_dir / "subagents"
child_dir.mkdir(parents=True, exist_ok=True)
parent_file = create["data"].get("sessionFile")
parent_session = create["data"].get("sessionId")
cc = wire.request("c2", {"type": "create", "name": "verify-child", "config": {
    "cwd": str(side.work_dir), "sessionDir": str(child_dir),
    "provider": "prime-inference", "model": "mock-1", "thinking": "high",
    "rlmDepth": 1, "parentSessionPath": parent_file, "executionMode": "print"},
    "runtimeMetadata": {"kind": "subagent", "rlmChildId": "child-1", "rlmDepth": 1,
                        "parentSessionFile": parent_file, "parentSessionId": parent_session,
                        "parentActiveSessionId": top}}, timeout=120)
print(f"[{TAG}] child create ok:", cc.get("success"), "thinkingLevel:", (cc.get("data") or {}).get("thinkingLevel"))
child = (cc.get("data") or {}).get("activeSessionId")
# Stop the child worker without deleting it (a plain kill).
if cc.get("success"):
    k = wire.request("k1", {"type": "kill", "activeSessionId": child}, timeout=120)
    print(f"[{TAG}] child kill ok:", k.get("success"))
wire.close()
capture_rows(side, "live")

# Restart the daemon: every live row is gone; the agents view rows come from
# the saved catalog (the post-restart universe).
side.stop_daemon()
time.sleep(1.0)
side.start_daemon()
capture_rows(side, "after-restart", expand=True)
side.stop_daemon()
print("DONE")
