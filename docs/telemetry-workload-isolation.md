# Test and eval telemetry isolation

Production usage counts must describe actual use, including legitimate
headless automation and custom providers/models. A token-count, timing,
platform, version, or execution-mode fingerprint cannot establish that a
run is a test. The emitter behind the October 13–14, 2026 spike is still
unproven; this change neither repairs historical events nor changes live
PostHog data, dashboards, filters, or daily-stat queries.

## Suppression boundaries

- Daemon `AgentSessionEngine::new` makes every configured faux script a
  hard telemetry opt-out before session or model-refusal clients exist.
  A caller's `telemetryDisabled=false` cannot enable a faux run.
- CLI print/RPC faux sessions already omit session telemetry. The
  analytics sink also recognizes `PRIME_AGENT_FAUX_SCRIPT`, covering
  startup and other invocation-level emissions. Their base properties now
  automatically carry `workload_origin=test`, rather than `automated`.
- Harnesses using real providers or HTTP mocks declare
  `PRIME_AGENT_TELEMETRY_ORIGIN=test` or `eval`. The analytics sink consumes
  their batches without HTTP requests or retries, including unmarked
  events; per-event `workload_origin=test|eval` is also filtered from mixed
  batches. This sink policy is independent of debug/release mode and
  cannot be overridden by `PRIME_AGENT_TELEMETRY=1`.
- A marked harness may retain a local JSONL mirror for diagnostics.
  `DO_NOT_TRACK=1`, `PI_OFFLINE=1`, and the existing settings switch keep
  their previous precedence and disable recording/delivery, including
  the mirror. No environment variable is rewritten by this policy.
- `rlm.spawn` already forwards the parent's filtered full launch env.
  `rlm.create_session` now preserves telemetry env controls in its minimal
  env. Both carry the parent invocation's hard create-time opt-out through
  `telemetryDisabled`, including across child worker restarts. Faux child
  scripts also encounter the constructor guard in each real engine.

The shared model-refusal telemetry object already carries the parent's
hard opt-out into the child registry; child creation reads that same
immutable policy instead of introducing a second configuration surface.

## Harness audit

Cargo's `.cargo/config.toml` supplies `DO_NOT_TRACK=1` in all profiles,
including release tests and their subprocesses. Cargo does not override
an existing value, so this is a useful default, not a proof that arbitrary
release-binary harnesses cannot emit. Debug builds separately omit the
production endpoint. Targeted instrumentation tests may inject local
telemetry in debug builds only.

The checked-in `review_*_parity.py` launchers set `DO_NOT_TRACK=1` and
`PI_OFFLINE=1`, directly or through `review_draft_disconnect_parity.env_for`.
These known test boundaries now also set `PRIME_AGENT_TELEMETRY_ORIGIN=test`
automatically; operators do not need to supply it. Release compatibility
launchers stamp the same marker. The marker follows their subprocess
environments into clients, dedicated daemons, workers, and kernels. In particular, `review_goal_backoff_parity.py` has a 10-input,
1-output mock response but explicitly opts out and uses JSON mode; it is
not an established source of the spike. Release compatibility test
launchers also set `DO_NOT_TRACK=1`. Faux integration tests run the real
engine, so they now have a constructor-level guard even if inherited
opt-outs are absent. No runtime inference from CI, model names, tiny
responses, milliseconds, or automated mode is added.

A synthetic session submitted through RPC to an already-running, unmarked
shared supervisor cannot reclassify that whole daemon: its aggregate
`daemon event` operational counters may still include the synthetic
operation. The faux guard suppresses the session's usage/refusal emissions;
it does not filter shared supervisor counters per worker. Dedicated test
and eval daemons must be launched with the marker or opt-out too. Suppressing
an entire shared daemon on its first synthetic session would also discard
legitimate sessions' operational telemetry and is intentionally avoided.

External eval harnesses using real providers must adopt an explicit
`PRIME_AGENT_TELEMETRY_ORIGIN=eval` marker (or `DO_NOT_TRACK=1` to suppress
local diagnostics too). Unmarked real-provider evals remain indistinguishable
from legitimate automation; the fix cannot classify them retroactively.

## Eval integrations and reliable automatic signals

`--autonomous`, `--autonomous-gate`, headless transports, custom providers,
and low token counts are shared by ordinary unattended work. None of these
controls establishes that an invocation is an evaluation. The native CLI
has no separate eval command today; `eval_composition_e2e` exercises the
same general autonomous controls with an explicit faux script.

The [official Verifiers Prime Agent harness](https://github.com/PrimeIntellect-ai/verifiers/blob/8a2aa6fbfc4d47119e0e4e0a3ab51008f6457442/verifiers/v1/harnesses/prime_agent/harness.py)
automatically adds `--offline` and `PRIME_AGENT_TELEMETRY=0` when it launches
Prime Agent. Its `autonomous` option is independent and defaults to false.
This audited integration already opts out without any end-user setup. That
snapshot pins release 0.9.5; it does not establish the emitter behind the
observed 0.10.0 population. Do not detect this harness by its provider name,
interception-key variable, installation path, or temporary directory: the
launcher owns the eval intent and is the reliable place to set it.

Its [ACP runner](https://github.com/PrimeIntellect-ai/verifiers/blob/8a2aa6fbfc4d47119e0e4e0a3ab51008f6457442/verifiers/v1/acp/runner.py)
sends protocol version and generic client capabilities without a client
identity; the Prime Agent harness leaves session metadata empty. There is
no eval-specific handshake field for the agent to detect automatically.

For other harness authors, set the existing origin automatically at the
launcher boundary. The daemon API also supports a top-level
`"telemetryDisabled": true` on `create` (outside `config`), which now follows
child creation; it needs no new environment variable or protocol field.
A dedicated eval daemon should itself be launched opted out. Setting only
a session's flag does not reclassify a shared supervisor's operational
counters. Current daily-stat DAU/WAU/MAU, tokens, and run series all query
`agent run completed`; those shared `daemon event` counters are outside
this PR's usage-event scope and do not enter those series.

A proposed convenience surface for external launchers is
`prime-agent --eval ...`, mapping to the existing `workload_origin=eval`
classification and hard session opt-out, preserved through child creation
and restart. It should keep execution mode as the actual transport and
should leave autonomous behavior independent. This is a proposal, not an
implemented flag; introducing a public CLI surface needs a separate CLI
contract decision. Without an explicit launcher/API signal, an arbitrary
external eval is indistinguishable from ordinary automation.

## Proposed reporting exclusions (not applied)

Keep the existing test-account and `version=0.0.0-benchmark` exclusions.
Add explicit `workload_origin IN ('test', 'eval')` and
`build_channel='development'` exclusions to production adoption reports.
For HogQL, the additional event predicate is:

```sql
coalesce(toString(properties.workload_origin), '') NOT IN ('test', 'eval')
AND coalesce(toString(properties.build_channel), '') != 'development'
```

These markers are producer declarations or build facts, rather than
behavioral guesses. Missing/unknown origin or execution mode stays
included; so do automated usage, custom models, prereleases, and releases.
`internal` is an explicit staff marker but may represent real dogfooding;
report it separately and decide its inclusion as a product metric choice.
Do not infer internal/test/eval status from a user ID's small-run history.
Any historical exclusion using the October fingerprint must be shown as
an estimated diagnostic comparison, separate from a verified production
usage metric.

## Validation

Regression coverage exercises faux opt-in rejection through a real core
engine, parent opt-out on both child depths, minimal child-env preservation,
and actual HTTP sink delivery through loopback stubs. The shared parity
launcher regression checks automatic classification in a real subprocess;
a separate real-binary regression runs a non-faux custom provider with an
autonomous quality gate and verifies that its 10-input/1-output-token run
still produces ordinary automated usage telemetry. Isolated test
subprocesses prove test/eval/faux env markers suppress even unmarked events
with telemetry explicitly enabled. A mixed batch still delivers a custom,
automated, unknown-mode production event. Hosted CI runs the HTTP sink
suite in release mode as well as the normal workspace checks; compilation
and tests are kept off the local Mac.

Ownership: internal changes in pa-daemon's engine/child supervision and
pa-telemetry's event schema and delivery policy; no new public API,
dependency, cross-crate re-export, or user-visible wire schema change.
