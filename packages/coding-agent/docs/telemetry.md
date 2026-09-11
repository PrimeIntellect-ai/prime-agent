# Telemetry

Telemetry is enabled by default and records usage, delays, and failures. The event definitions live in [telemetry-contract.ts](../src/core/telemetry-contract.ts); Platform validates the transport envelope and forwards events to PostHog.

## Opt-out and privacy

`telemetry.enabled=false`, `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1`, and offline mode disable reporting. Do Not Track and offline mode take precedence over the existing `PRIME_AGENT_TELEMETRY=1` settings override. Otherwise a project cannot re-enable a global opt-out. Consent is checked at capture and delivery. Settings changes clear queued events, abort pending requests, and discard unfinished measurements. Activity while disabled is never replayed; already accepted requests cannot be recalled.

The installation ID is the existing random UUID in private `telemetry.json` state. It is not derived from an account, IP, machine, or repository. Sessions, runs, inputs, errors, and setup/feature/install attempts receive independent random IDs. Provider, model, tool, credential source, team scope, and endpoint fields contain fixed categories, never names of custom providers, credentials, team IDs, or URLs. Set `PRIME_AGENT_TELEMETRY_ORIGIN=internal` or `test` for those populations; execution mode alone does not identify them.

Error reports include a code, type, narrower category, and a fixed diagnostic. Group errors by component and `error_code_group`, with type/category fallback. Exact original messages are included only when they match a reviewed fixed string in [telemetry-error-policy.ts](../src/core/telemetry-error-policy.ts). Recognized system errors use fixed descriptions without paths or addresses. Other message text is omitted: credential patterns cannot reliably remove prompts echoed by a provider or tool. The credential filter is an additional check on approved strings. Message length/source flags are reconstructed from accepted text.

Prompts, model responses, reasoning, arguments, tool output, request bodies, stacks, causes, and logs are excluded. Daemon/background reporting requires the affected session's consent context; another project's settings cannot authorize it. Disabling telemetry clears local setup/install correlation. To reset identity, close all processes using the agent directory and remove `telemetry.json`, `telemetry-onboarding.json`, and `telemetry-installations/`. This does not delete server data.

## Events and compatibility

| Event | Observation |
| --- | --- |
| `agent started` | Existing session start with build and origin categories |
| `onboarding completed` | Existing configured-credentials outcome |
| `agent command used` | Built-in command usage, excluding arguments |
| `agent run started` | Run ID, input association, session run index, executing context |
| `agent run completed` | Outcome, successful model calls, timing, token usage, estimated cost |
| `agent session ended` | Session totals and shutdown outcome |
| `agent error` | Error occurrence or later recovery, code group, safe message |
| `agent timing` | Input, model, tool, retry, compaction, and cancellation durations |
| `agent tool summary` | Per-run tool-category counts, failures, recoveries, duration |
| `agent input stage` | Submission, receipt, queue, preparation, admission, and completion |
| `onboarding stage` | Setup entry, provider selection, credential discovery/checks, readiness, exit |
| `agent feature outcome` | Model/auth/effort/goal/session action outcomes and fixed-choice feedback |
| `agent startup stage` | Configuration, connection, UI rebind, and readiness timing |
| `agent installation stage` | Installer/update stages, version changes, restart/restore, runtime readiness |

The original five events keep their names, required fields, outcomes, and installation identity. Optional `/api/v1/agent-analytics/capabilities` discovery enables the version-2 envelope. Old collectors receive only original fields (`homebrew` becomes `unknown`); rollback retries use the same event ID. Installation events require revision 3. Unsupported events remain queued within the normal delivery limits.

Original messages require matching `error_message_policy_revision` and `original_error_messages=true`. With `posthog_exception_events=true`, the client adds a native PostHog `$exception` for each occurrence, using a deterministic ID and code-based grouping. Analytics and exception records are acknowledged independently. Recovery updates do not create another exception. Older collectors keep their existing analytics/server-generated exception behavior.

Optional `telemetryInput` metadata on `prompt` and `prompt_and_wait` requires the daemon's `telemetry_input` capability and schema revision 28. Clients omit it for older supervisors/workers, including replay and fallback. No new startup command or protocol version is required. Root sessions own run counts so attached UIs/subagents do not duplicate them.

## Interpreting the data

- Count distinct installation IDs, not launches. First observed activity is not a proven install date; daily unique counts cannot be summed into monthly uniques.
- Deduplicate runs by installation/session/run ID. Missing terminals are unknown coverage, not confirmed crashes. A successful run means the loop completed, not that the user's objective was achieved. `successful_model_call_count` separately measures completed model responses, even if a later tool fails.
- Deduplicate errors by `error_id` and use the latest recovery observation. An error remains recorded when retry succeeds. Recovery is scoped to its session/provider/tool; it does not prove task success. Billing, quota, permissions, unavailable providers, and credentials have separate categories. A generic HTTP 401 does not prove expiry.
- Setup readiness means credentials are configured. Only checks that actually ran are recorded as validated; model access remains unchecked until observed inference. No extra provider requests are made for telemetry. Activation pairs successful runs with the same onboarding attempt within 24 hours; missing or ambiguous associations stay unknown. D1/D7 retention requires mature cohorts and repeated successful use.
- Feature attempts pair initiation with an observed result. Opening the agents view is not a completed resume. `previous_success` covers only the current UI lifetime. `/feedback` accepts fixed helpful/partly-helpful/not-helpful choices; cancellation sends nothing.
- Setup, UI, and executing-worker context are separate category snapshots. Equal categories do not establish identical keys, teams, or endpoints. UI metadata improves association; shared local setup state can be ambiguous with concurrent UIs. Correlation expires after seven days.

## Timing and cost

Durations use each process's monotonic clock; timestamps from different processes are never subtracted. `run_to_first_text_ms` starts at `agent_start`, while legacy visible TTFT starts at the first turn. Input timing separately measures worker receipt, queue wait, and local preparation. `provider_dispatch` ends immediately before the SDK stream call, after credentials/headers are resolved; it does not measure a network write.

UI first-status timing ends at a terminal frame containing working status, only for one attributable idle-origin input. Queued/overlapping inputs, overlays, missing frames, or view replacement report unavailable coverage. Cancellation-to-idle ends when running work stops after successful cancellation; preserved queued inputs do not prevent idle. Lost observation produces null.

Startup connection timing begins at socket connection, excluding earlier daemon startup. UI readiness ends at UI initialization before onboarding; rebinding is measured separately. Onboarding and feature durations can include user/browser wait, identified by `timing_scope`; cumulative setup stages must not be summed. Credential checks measure system work only.

Stream gaps cover model events within a call, including its terminal edge, and exclude tool execution. Tool durations may overlap. Missing starts/unfinished operations have null duration. Manual/pre-run compaction remains session-scoped rather than attributed to a later run. Pending or failed model calls make usage incomplete. Estimated USD cost requires known pricing and usage for every call; otherwise it is null. It is not a billing ledger. Output tokens divided by model latency includes initial waiting time.

## Installation and updates

Installation events cover the shell installer and built-in CLI/interactive updater; independent package-manager commands are outside this coverage. Reinstalling is still an install attempt. Deduplicate by installation ID, attempt ID, and stage. A child updater shares its parent's attempt ID but cannot inherit its monotonic clock.

Requirements, release lookup, download, verification, package completion, daemon restart, session restoration, relaunch, and fresh-runtime readiness are separate outcomes. Restoration failures include incomplete queued work; older coordinator results may be unavailable. `--version` alone is not runtime readiness. Missing completion/readiness is unknown, not an inferred failure. Version comparisons exclude custom labels. Shell stages and later readiness omit precise timing.

After package success, at most 16 private markers remain for seven days so a newer runtime can report readiness. Their local working-directory field is used only to recheck the originating project's opt-out and is never uploaded. Current-project consent is checked independently. Readiness consumes its marker even if delivery fails; this is not a durable event queue. Telemetry never waits before presenting the UI or starting headless work.

## Delivery and dashboards

Capture is asynchronous. Each client holds at most 256 sanitized reports in memory, sends batches of at most 20 events/30 KB, and expires reports after five attempts or 24 hours. Retries retain IDs and back off up to 60 seconds. Background flush has a seven-second budget; controlled shutdown waits at most 1.5 seconds. Delivery failures never recursively report themselves. Hard kills, offline operation, overflow, and endpoint failures can lose reports. The exception monitor preserves normal process exit behavior.

The [dashboard definitions](telemetry-dashboards.json) contain seven historical count corrections and 30 views, including three proposed alerts. From the repository root:

```sh
npx tsx scripts/publish-telemetry-dashboards.mjs --check
npx tsx scripts/publish-telemetry-dashboards.mjs --preflight
```

`--check` is local; `--preflight` uses `POSTHOG_PERSONAL_API_KEY` to validate the project, saved charts, queries, and observed schema revisions without writes. `--apply` explicitly publishes after those checks. Views without eligible data remain pending; installation views require revision 3. `--legacy-only` limits work to historical corrections. `--include-alerts` creates disabled alerts without subscribers; thresholds and recipients need separate review. Percentiles must show sample counts and missing-value coverage.

Deploy the compatible collector before the client. Verify retained synthetic events, opt-out, and old/new daemon combinations, then run dashboard preflight. Proxy/access logs, shared PostHog retention settings, representative workload coverage, and abrupt-exit loss require deployment-level checks. Unit tests do not establish production coverage or dashboard publication.
