# Verifying which model a session actually uses

Two rules, learned the hard way while checking whether a session really ran
`deepseek-flash`. They apply to any "is this model pinned?" acceptance, on any
machine.

## Rule 1 — only the upstream request body proves the model id

The proof is the `model` field of the request the product sends to the provider.
Nothing else counts:

- A session's JSONL `model` / `modelId` fields are the **client's** record of what
  it resolved; they are written before the request and can reflect a fallback.
- `responseModel` is the **provider's** label, not the requested id. DeepSeek, for
  example, answers a `deepseek-v4-flash` request with `responseModel:
  "deepseek-flash"` — reading that field as proof of the request id is exactly
  how a session that never sent `deepseek-flash` looks pinned.
- `model list`, `model_change` events and a green reply prove configuration, not
  the wire id.

How to capture it: point the provider's `baseUrl` at a local logging pass-through
(an agent-dir `models.json` provider override is enough), run one real prompt,
and read the request body's `model` field. Record the body verbatim.

## Rule 2 — a reproduction that disagrees with another is usually a control variable

Before concluding that two machines (or two paths) behave differently, fix these
four controls, in this order:

1. **CLI pin** — `--provider` / `--model` on the command line. `find_initial_model`
   (`crates/pa-core/src/models/resolver.rs`) takes CLI flags as step 1 and never
   consults the saved default, so a harness that passes them is not testing
   `defaultModel` at all. This was the actual cause of one false "the daemon
   sends a different model" conclusion.
2. **Agent directory** — `PRIME_AGENT_CODING_AGENT_DIR` (or the default
   `~/.prime/agent`). Settings and `models.json` are read from the instance's own
   dir (`SettingsManager::create(cwd, agent_dir)`); two instances with different
   dirs legitimately see different defaults. Also check that a stale daemon on a
   reused socket is not serving an older directory — a persistent TUI daemon
   survives its client, so kill it between experiments.
3. **Continued vs new session** — `is_continuing` skips the scoped-model step and
   a resumed session keeps its recorded model; only a new session exercises the
   saved default.
4. **Registry contents** — the custom `models.json` entry must actually be in the
   catalog the process loads (and, for the exact-match step, in the
   auth-configured `available` list). Verify with `model list` on the same agent
   dir and binary, not on another machine.

Only when all four are identical and the wire still disagrees is there a real
behavioral difference worth reporting.

## Where the decisions live

- Request body: `crates/pa-ai/src/providers/openai_completions/params.rs` — the
  `model` field is `model.id`.
- Startup chain: `find_initial_model` in `crates/pa-core/src/models/resolver.rs`
  (saved default → exact catalog match → `build_fallback_model`, which keeps the
  saved id on a provider template → featured/provider default → first available).
- Print mode's saved default is a separate, stricter lookup in
  `crates/pa-cli/src/print_runtime.rs`.
- Daemon startup: `crates/pa-daemon/src/agent_engine/model.rs`.

## Case study (2026-11-17)

Checking `defaultModel: deepseek-flash` on Windows: a first probe reported the
daemon sending `deepseek-v4-flash`. The harness had pinned
`--provider deepseek --model deepseek-v4-flash` in its argument list (control 1),
so the probe never exercised the default. With the pin removed and a fresh agent
dir whose `models.json` carries a `deepseek-flash` entry, the wire showed
`model="deepseek-flash"`, matching a separate production-path capture on the
same product build.
