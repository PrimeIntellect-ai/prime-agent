# Telemetry contract and rollout

Telemetry is enabled by default. It records observed use, delays, and failures so Prime Agent can be improved. It does not establish how many people installed the product, whether a task was solved, or what happened on opted-out installations.

## Consent and content

`telemetry.enabled=false`, `PRIME_AGENT_TELEMETRY=0`, `DO_NOT_TRACK=1`, and offline mode disable reporting. Offline mode and Do Not Track take precedence over the environment enable override. `PRIME_AGENT_TELEMETRY=1` retains its existing explicit override of settings; a project setting otherwise cannot re-enable a global opt-out. Settings changes synchronously clear queued reports, abort requests still in flight, and discard in-progress journey/run aggregates. A request already accepted by the server cannot be recalled. Environment flags are checked before capture and delivery. No opted-out history is replayed on re-enable.

The existing random installation UUID remains in `telemetry.json` with private file permissions. It is not derived from a machine, account, email, IP address, repository, or credentials. Independent analytics UUIDs identify sessions, runs, error occurrences, onboarding attempts, and feature attempts. There are no new daemon protocol fields. Root sessions own run telemetry so attached UIs and subagents do not duplicate root run counts.

Only contract-listed properties reach the transport. Strings are fixed categories, reviewed messages, UUIDs, or a bounded public version format. Unknown custom provider/model/tool names become categories such as `custom`. Unknown properties are removed on the client and collector. Error messages are **reviewed templates selected from structured error evidence**, not copies of provider or application text. For example, a rejected key becomes “Provider rejected the supplied credentials.” Arbitrary messages become an unknown-error template. Reports exclude prompts, responses, reasoning, tool arguments/results, shell commands, raw errors/logs/stacks, request IDs, URLs, paths, repository data, names, credentials, and hardware identifiers.

To reset the local analytics identity, first close all Prime Agent processes using the agent directory, then remove its `telemetry.json` and `telemetry-onboarding.json` files. The next enabled launch creates a new unrelated installation ID. This does not delete previously accepted server data. Opting out does not rotate the existing installation ID.

`PRIME_AGENT_TELEMETRY_ORIGIN=internal` or `test` explicitly marks internal/test activity. Other origin values are not uploaded. Interactive and noninteractive execution remain separate; an execution mode does not prove whether a human or automation initiated the work.

## Event compatibility

The machine-readable [contract](telemetry-contract.json) is mirrored by `src/core/telemetry-contract.ts`; a test enforces equality. The Platform collector carries the same JSON contract. Schema version 2 is an additive envelope negotiated through the optional `/api/v1/agent-analytics/capabilities` endpoint.

| Event | New detail |
| --- | --- |
| `agent started` | Existing session start plus explicit schema/build/origin categories |
| `onboarding completed` | Existing configured-credentials observation, with its original meaning preserved |
| `agent command used` | Existing fixed command usage categories, with arguments excluded |
| `agent run started` | Independent run ID and per-session run index |
| `agent run completed` | Paired terminal outcome, timing coverage, tool/retry/compaction duration, usage completeness, optional estimated cost |
| `agent error` | Narrow subtype, reviewed code/status/message, component/operation, retry and observed recovery |
| `agent timing` | Measured first model/reasoning/text, tool, retry, compaction, and terminal durations |
| `agent tool summary` | Per-run tool category counts, failures, and known duration |
| `onboarding stage` | Actual setup/check/exit observations with explicit unchecked and canceled states |
| `agent feature outcome` | Attempt and result for a fixed feature, plus optional fixed-choice feedback |
| `agent startup stage` | Measured configuration, connection, UI rebind, and readiness stages |
| `agent session ended` | Existing totals plus observed shutdown outcome |

The original five event names, required properties, broad error categories, outcome values, and stable installation identity are preserved. Legacy collectors receive only the original property sets; `homebrew` is mapped to their existing `unknown` value. New event types stay queued until support is advertised. A collector rollback causes a safe legacy retry with the same event ID. New fields are never backfilled or inferred for old events. See [journey definitions](telemetry-journeys.md) for onboarding, feature, and startup boundaries.

## Counting and timing

Count **distinct installation IDs**, not `agent started` events, for observed installations. Launch/session events measure frequency. Daily unique totals cannot be summed into a monthly unique count. One ID can appear in multiple version/mode breakdowns. First observed telemetry means first seen in available data, not a proven installation date. Installer requests remain a separate aggregate and are not joined to client identities.

Run reliability uses distinct `(installation_id, session_id, run_id)` pairs. `terminal_outcome` distinguishes success, error, cancellation, interrupted shutdown, and unknown. A start without a terminal observation is missing coverage; it is not evidence of a crash or abandonment. A successful run means the agent loop completed, not that the user's objective was achieved.

Each provider failure is recorded even if a retry later succeeds. Recovery observations reuse its `error_id` with a new transport event ID. Count distinct error IDs and select the latest recovery observation; counting every `agent error` event would overcount failures. Wrapped exceptions are locally deduplicated for a bounded interval. Billing, quota, permissions, unavailable providers, and rejected credentials are separate. Generic HTTP 401 remains ambiguous; it does not prove a key expired. Structured 402/403/503 failures no longer trigger incorrect credential-stale handling.

Local durations use a monotonic clock. `run_to_first_text_ms` starts at `agent_start`; legacy visible TTFT starts at the first turn. Neither measures user submission or queue delay. First-reasoning latency can be absent for models that do not expose reasoning. Maximum stream gaps cover observed model events within a call, including the terminal edge, and exclude time spent running tools. Tool times can overlap, so their sum is work duration rather than elapsed run time. Missing tool start or unfinished tools produce null duration. Pending or failed model calls make `usage_complete=false`. Cost is an estimate from known pricing for every observed call and is null when any price/usage is unknown; it is not a billing ledger. Output tokens divided by model latency is an effective request rate including initial wait, not pure generation throughput.

Dashboard percentiles must show sample counts and missing-value coverage. Mature 24-hour/D1/D7 cohorts exclude installations whose observation window has not elapsed. Successful runs are required for activation and repeat-success metrics. Missing association is reported separately from observed failure.

## Delivery and deployment

Capture does not wait for network delivery. A process holds at most 256 sanitized reports in memory, sends at most 20 events and 30 KB per batch, and expires reports after five attempts or 24 hours. Retries keep transport IDs and back off to at most 60 seconds. Background delivery has a seven-second budget; session shutdown waits at most 1.5 seconds. Partial acknowledgements remove only accepted or rejected IDs. Discovery is optional and bounded; it never prevents startup. Collector delivery acknowledges the upstream batch and deduplicates retries. Delivery errors never recursively create analytics errors.

Telemetry is best effort. Opt-outs, offline operation, endpoint failure, rate limits, queue overflow, abrupt process exit, and missing observations reduce coverage. There is no disk event spool: a hard crash, forced kill, or restart can lose queued events. Controlled startup failures flush within the same 1.5-second shutdown budget. The fatal exception monitor preserves normal Node exit behavior; it cannot guarantee a final network report. Background log and exception reporting require a known operation-specific consent context. Shared daemon/catalog request failures remain in caller-side reporting paths; one project's settings cannot authorize reports for another project. Catalog bootstrap failures use the catalog's effective settings and inherited environment without enabling global request reporting. Local delivery counters expose accepted, rejected, expired, overflow, retry, and unavailable counts for diagnostics; collector operational counters measure its own accepted/dropped/retried traffic. These are not a census of lost client events.

1. Deploy the backward-compatible Platform collector first ([Platform PR #5228](https://github.com/PrimeIntellect-ai/platform/pull/5228)). Confirm legacy acceptance, v2 capability discovery, partial acknowledgement, duplicate IDs, and rollback behavior in staging.
2. Inspect proxy/CDN/access logs, tracing, and PostHog ingestion transforms for metadata enrichment. The collector strips sensitive payload/transport metadata and disables person/GeoIP enrichment; infrastructure outside the application needs a deployment-level check.
3. Release the client. Use synthetic, content-free canaries to verify both enabled delivery and complete opt-out. Compare healthy and failed runs, retry recovery, canceled setup, warm attach, and old/new client combinations.
4. Validate v2 property coverage in PostHog before publishing the new dashboard bundle. Its publication script defaults to preview and refuses to publish new charts without observed v2 data. Existing count corrections and new definitions are versioned for review; the implementation PR does not deploy or alter live dashboards.

The reviewed [dashboard bundle](telemetry-dashboards.json) includes seven historical chart corrections and new error, activation, retention, feature, timing, and coverage definitions. From the repository root, `node scripts/publish-telemetry-dashboards.mjs --check` validates the local bundle without network access. `--preflight` uses `POSTHOG_PERSONAL_API_KEY` to verify the target project, existing chart shapes, query results, and observed v2 events without changing dashboards. `--apply` performs those checks before writing; charts without required observations remain pending. `--legacy-only` limits preflight or publication to the historical corrections. Run preflight and review its result after deployment before choosing apply.

PostHog aggregation reference: [supported SQL aggregations](https://posthog.com/docs/sql/aggregations).

## Issue coverage

ENG-5925 coordinates this change. ENG-5926 covers consent and content safety; ENG-5927 the versioned collector/client contract; ENG-5928 onboarding and observed activation; ENG-5929 run lifecycle and bounded delivery; ENG-5930 broad safe error reporting and narrower classification; ENG-5931 measured timing/usage/cost coverage; ENG-5932 explicit population/feature/feedback context; and ENG-5933 versioned dashboard definitions and rollout validation.

Local compatibility validation additionally passed real client serialization through the new collector for all 12 event types (22 reports, zero rejected, all allowed properties preserved). The five projected legacy types passed both the original strict collector schema and the new collector; the historical old-client fixture also passed. These are offline synthetic checks, not evidence of production deployment.
