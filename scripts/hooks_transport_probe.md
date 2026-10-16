# Offline lifecycle-hook transport probe

The probe uses existing built `prime-agent` and `pa-daemon` binaries and Python 3's standard library. It creates isolated project, agent, session, and Unix-socket directories under `/tmp`. It does not install packages, fetch models, add credentials, modify host configuration, or invoke a real provider. The host HOME is preserved. PRIME_AGENT_KERNEL_PYTHON points to a nonexistent fixture interpreter; the explicit override fails without automatic bootstrap. Shell commands operate only on probe fixtures. The optional PTY test reads a newly created private terminal and sends no keystrokes.

Run from the repository root after the coordinating agent finishes serialized builds:

```sh
python3 scripts/hooks_transport_probe.py \
  --cli target/debug/prime-agent \
  --daemon target/debug/pa-daemon \
  --baseline-cli /absolute/path/to/baseline-prime-agent \
  --first-paint --samples 3 \
  --output /tmp/hooks-transport.json
```

Omit `--baseline-cli` for a functional smoke run. Omit `--first-paint` when the sandbox cannot allocate a controlling PTY; the report explicitly marks first paint unmeasured. Unix socket creation, process spawning, and local fixture writes are required. Linux and macOS are supported by the harness; executing on one does not establish coverage on the other.

Each functional case uses an exact-approved project hook and the faux provider. Print JSON, stdio RPC, supervisor JSONL, and direct authenticated worker frames use `python_repl`: the first valid call is vetoed; the second returns the explicit disabled-kernel error, preserved in the observer payload and transcript. No Python code executes. Invalid arguments would bypass the hook callback, so these calls use valid arguments. The public binaries expose Python tools in these configurations; native Bash/edit execution is not claimed.

All four transports verify SessionStart, UserPromptSubmit, and Stop payload identity, cwd, and event-specific fields. Print completion, RPC stdin EOF, and explicit daemon session kill must deliver SessionEnd before close completes. Child workers must produce none of these lifecycle markers. PreCompact and decision-continuation edge cases remain covered by Rust unit tests.

Durable session JSONL must retain original model tool-call IDs and denial reasons. The supervisor case also creates a real child worker with the metadata used by `rlm.spawn`; it verifies all hooks remain excluded despite exact trust, the parent veto is absent, and the child transcript preserves its separate identity, depth, and disabled-kernel error. This covers child-worker transport isolation, not Python-kernel execution or the `rlm.spawn` entrypoint.

Timing samples report:

- Headless process launch through completion of a scripted turn.
- Resume through completion of a scripted turn.
- Resume through an RPC `get_state` response, without a model request; a trusted hanging `SessionStart` must remain unstarted.
- Supervisor hello, session create, and loaded `get_messages` response.
- With `--first-paint`, process spawn through the first completed synchronized alternate-screen frame. A trusted hanging `SessionStart` must remain unstarted.

The first sample is process-cold, not OS-cache-cold. Later samples reuse filesystem caches. These are small local diagnostic samples, not statistically strong release benchmarks. Session-load readiness includes process and RPC overhead. `crates/pa-core/examples/session_open_bench.rs` remains the separate reader-only cold/warm-cache and exact-context-parity benchmark.

Cases run serially. The largest functional case has a supervisor, parent worker, and child worker. Every request has a bounded wait; shutdown is attempted before forceful cleanup. No Rust builds are performed by the script.

Hosted CI discovers `scripts/review_hooks_parity.py` in its existing shard-1 lifecycle comparison step. It records pinned TS archive and binary hashes, compares hook-disabled fresh/resumed conversations through a loopback provider, and runs all four Rust hook transports. The receipt preserves raw provider requests, transcripts, stdout/stderr, and hook payloads. TS v0.9.8 supplies the unchanged conversation baseline; this does not claim that TS implements Codex hooks. `tested_github_sha` identifies the Actions checkout (a merge candidate for ordinary PR runs), not necessarily the PR head.
