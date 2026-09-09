# Telemetry acceptance evidence

This checklist covers ENG-5926–ENG-5933 under ENG-5925. A checked implementation test is not evidence that a collector, client, dashboard, or alert is deployed. Do not close rollout-dependent acceptance criteria until their evidence is attached.

| Issue | Implementation and verification | Remaining operational evidence |
| --- | --- | --- |
| ENG-5926 | Schema allowlists, shared reviewed message/code policy, synthetic prompt/credential canaries, global/project/environment opt-outs, synchronous queue/aggregate cleanup | Deployed CDN/access-log/tracing and ingestion-transform audit; retention/deletion decision |
| ENG-5927 | Additive v2 envelope, legacy projection, same-ID retry, partial acknowledgement and rollback tests; identical client/collector contract; independently negotiated message policy | Collector-first staging rollout and retained-payload reconciliation |
| ENG-5928 | Setup context, input IDs, categorized actual worker auth/provider/team/endpoint context, setup/UI differences, pre-run failure observations; elapsed time never borrowed from another setup attempt; successful model responses distinguished from whole-run success | Staged cold/warm/resume and old/new daemon combinations; real coverage of configured workflows and first successful work |
| ENG-5929 | Bounded in-memory queues, session/run terminals, retry/cancellation distinctions, installation/error/run deduplication | Controlled shutdown and abrupt-exit loss measurements in staging; compare upload counters with retained events |
| ENG-5930 | Stable code groups for HTTP, daemon, filesystem and process failures; reviewed messages; distinct occurrence/recovery records; scoped recovery and fatal monitor; deterministic native PostHog exception mirror | Staging error-to-issue reconciliation, including source/mirror deduplication and recovery updates |
| ENG-5931 | Input queue/preparation/run timing, actual UI frame status where attributable, cancellation-to-idle, stream/tool/retry/compaction timing including manual compaction, and usage/cost coverage | Version/provider/mode coverage and percentile validation on representative deployed workloads; ambiguous UI status remains unavailable |
| ENG-5932 | Fixed feature/feedback categories, explicit internal/test origin, mature repeated-success cohorts and configured-workflow activation | Population coverage and cohort maturity after rollout; unknown origin is retained, not inferred to mean external |
| ENG-5933 | Seven historical corrections, 30 versioned views, per-view revision-aware publication gates and three disabled native alert definitions; publication tests | Execute read-only preflight against deployed revision-2/revision-3 events; review dashboards, denominators and thresholds; publish and explicitly select subscribers before enabling alerts |
| Installation/update follow-up | Revision-3 installation stage contract, package-versus-runtime outcome separation, attempt/stage deduplication, safe version/source/reason fields, collector acceptance/privacy tests, and agents-view readiness/short-exit delivery tests | Staged installer download/verification/package failures, update restart/session-restore/relaunch failures including incomplete queued work, fresh-process runtime readiness, saved opt-out changes during delivery, and missing-readiness coverage |

## Evidence to retain

Record the two deployed commit IDs, client versions, daemon schema/capabilities, verification commands, synthetic upload/export counts, rejection counters and dashboard preflight result. Record opt-out settings with the test result, without including actual keys, accounts, prompts or user error text.

The client tests exercise fake clocks/providers or local synthetic errors. The Platform verification utility generates synthetic requests and reconciles retained exports offline. Neither is an authorization to upload real user data or a claim of live coverage.

The integrated policy-revision-1 check serializes an actual `TelemetryClient` batch through the collector with mocked delivery. All 17 source records across 13 event types retain their allowed properties and produce 21 PostHog records: 17 analytics records and four native exceptions. One mirror retains a reviewed original message, one uses a fixed system description, and two use reviewed diagnostics. The recovery update adds no exception. A simulated upstream failure retries identical payloads and UUIDs; acknowledgements contain only source IDs, and accepted replay sends nothing extra. Synthetic prompt and credential canaries are absent from the final serialized payload.

That recorded revision-2 client fixture remains unchanged as compatibility evidence. Revision-3 synthetic fixtures cover all 14 event types; installation reports preserve attempt identity and safe stage/version metadata, reject private fields, retry unchanged source IDs, and never become native exceptions themselves. Publication tests verify that revision-2 data can still satisfy existing charts while the three installation charts remain pending until revision-3 data is observed. Local validation does not execute these SQL queries against a deployed PostHog project.

## Deployment audit snapshot

The read-only PostHog project review on 2026-09-08 found project timezone GMT, `anonymize_ips=false`, retention set to 84 months with enforcement disabled, and no project-wide exception opt-in value. These are shared project settings, not proof of the final agent payload. The agent collector disables GeoIP/person enrichment per event and strips transport metadata; verify the retained result after all ingestion transforms. Review retention and access with the project owner without silently changing settings for unrelated website telemetry.

Review the Platform collector's `DEPLOYMENT.md` for the separate proxy/CDN, logging, tracing, exception intake and export evidence. Code inspection alone cannot establish those deployed settings.

## Boundaries

Original-message forwarding to PostHog is authorized with credentials and prompt content excluded. Both sides require an approved message ID and exact fixed text. Credential pattern matching is a second safeguard; arbitrary provider/tool/error text is omitted because it can echo prompts. Fixed system descriptions are labeled separately from retained original wording. Missing or mismatched message-policy capabilities strip all message fields while retaining supported code/timing metadata. Native exceptions mirror explicit occurrences only, use deterministic IDs and code-based fingerprints, and contain no stacks, causes, request bodies or tool results.

Hard kills and abrupt crashes may lose memory-buffered reports. A missing run terminal is unknown, not a confirmed crash. A successful retry or later same-tool success records an observed recovery signal, not proof that the user's task was solved. Category comparisons cannot detect key/team/endpoint changes within one category.
