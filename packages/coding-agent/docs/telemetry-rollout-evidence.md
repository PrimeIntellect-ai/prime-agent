# Telemetry acceptance evidence

This checklist covers ENG-5926–ENG-5933 under ENG-5925. A checked implementation test is not evidence that a collector, client, dashboard, or alert is deployed. Do not close rollout-dependent acceptance criteria until their evidence is attached.

| Issue | Implementation and verification | Remaining operational evidence |
| --- | --- | --- |
| ENG-5926 | Client schema allowlists and reviewed message/code policy, synthetic prompt/credential canaries, global/project/environment opt-outs, synchronous queue/aggregate cleanup | Deployed CDN/access-log/tracing and ingestion-transform audit; retention/deletion decision |
| ENG-5927 | Additive v2 envelope, legacy projection, same-ID retry, partial acknowledgement and rollback tests; basic collector schemas and client-owned event contract; independently negotiated message policy | Collector-first staging rollout and retained-payload reconciliation |
| ENG-5928 | Setup context, input IDs, categorized actual worker auth/provider/team/endpoint context, setup/UI differences, pre-run failure observations; elapsed time never borrowed from another setup attempt; successful model responses distinguished from whole-run success | Staged cold/warm/resume and old/new daemon combinations; real coverage of configured workflows and first successful work |
| ENG-5929 | Bounded in-memory queues, session/run terminals, retry/cancellation distinctions, installation/error/run deduplication | Controlled shutdown and abrupt-exit loss measurements in staging; compare upload counters with retained events |
| ENG-5930 | Stable code groups for HTTP, daemon, filesystem and process failures; reviewed messages; distinct occurrence/recovery records; scoped recovery and fatal monitor; deterministic native PostHog exception mirror | Staging error-to-issue reconciliation, including source/mirror deduplication and recovery updates |
| ENG-5931 | Input queue/preparation/run timing, actual UI frame status where attributable, cancellation-to-idle, stream/tool/retry/compaction timing including manual compaction, and usage/cost coverage | Version/provider/mode coverage and percentile validation on representative deployed workloads; ambiguous UI status remains unavailable |
| ENG-5932 | Fixed feature/feedback categories, explicit internal/test origin, mature repeated-success cohorts and configured-workflow activation | Population coverage and cohort maturity after rollout; unknown origin is retained, not inferred to mean external |
| ENG-5933 | Seven historical corrections, 30 versioned views, per-view revision-aware publication gates and three disabled native alert definitions; publication tests | Execute read-only preflight against deployed revision-2/revision-3 events; review dashboards, denominators and thresholds; publish and explicitly select subscribers before enabling alerts |
| Installation/update follow-up | Revision-3 installation stage contract, package-versus-runtime outcome separation, attempt/stage deduplication, safe version/source/reason fields, collector acceptance/privacy tests, and agents-view readiness/short-exit delivery tests | Staged installer download/verification/package failures, update restart/session-restore/relaunch failures including incomplete queued work, fresh-process runtime readiness, saved opt-out changes during delivery, and missing-readiness coverage |

## Evidence to retain

Record the two deployed commit IDs, client versions, daemon schema/capabilities, verification commands, synthetic upload/export counts, rejection counters and dashboard preflight result. Record opt-out settings with the test result, without including actual keys, accounts, prompts or user error text.

The client tests exercise fake clocks/providers or local synthetic errors. Temporary integration drivers serialize actual client events for collector and retained-export comparison. Local acceptance and mocked delivery are not proof of live forwarding.

The integrated policy-revision-1 check serializes an actual `TelemetryClient` batch through the collector with mocked delivery. All 17 source records across 13 event types retain their allowed properties and produce 21 PostHog records: 17 analytics records and four native exceptions. One mirror retains a reviewed original message, one uses a fixed system description, and two use reviewed diagnostics. The recovery update adds no exception. A simulated upstream failure retries identical payloads and UUIDs; acknowledgements contain only source IDs, and accepted replay sends nothing extra. Synthetic prompt and credential canaries are absent from the final serialized payload.

That recorded revision-2 client fixture remains unchanged as compatibility evidence. Revision-3 synthetic fixtures cover all 14 event types; installation reports preserve attempt identity and safe stage/version metadata, reject private fields, retry unchanged source IDs, and never become native exceptions themselves. Publication tests verify that revision-2 data can still satisfy existing charts while the three installation charts remain pending until revision-3 data is observed. Local validation does not execute these SQL queries against a deployed PostHog project.

## Deployment audit snapshot

The read-only PostHog project review on 2026-09-08 found project timezone GMT, `anonymize_ips=false`, retention set to 84 months with enforcement disabled, and no project-wide exception opt-in value. These are shared project settings, not proof of the final agent payload. The agent collector disables GeoIP/person enrichment per event and strips transport metadata; verify the retained result after all ingestion transforms. Review retention and access with the project owner without silently changing settings for unrelated website telemetry.

Audit deployed proxy/CDN, logging, tracing, exception intake and retained exports separately. Code inspection alone cannot establish those settings.

## Preview verification on 2026-09-10 UTC

The 22 focused telemetry test files passed 539 tests. After finding that shell installer events omitted the internal/test origin category, the installer was corrected and all 46 installer tests passed, including four new origin cases. `npm run check` passed. The implementation fix is commit `3d1cb0843`.

An isolated SDK driver exercised actual sessions, successful/failed/cancelled runs, tool failure and recovery, manual compaction, and application observers for setup, authentication, non-HTTP errors and update outcomes. It serialized 106 source events across all 14 event types. A separate real CLI driver used a local OpenAI-compatible fixture: success and HTTP 401 failure emitted 37 source events; 80 uncached input tokens, 20 cached input tokens and 20 output tokens produced the expected USD 0.00013 estimate. Settings and environment opt-outs made zero telemetry requests. Synthetic prompt and credential canaries were absent from upload bodies. These runs used mocked collector responses.

The shell installer driver used fake download, checksum and package commands while retaining actual installer control flow. Success and four failure stages emitted 48 installation events; the saved opt-out emitted none. Every enabled event retained `workload_origin=test` after the fix. No real package installation or paid model request was performed.

Platform preview image build and Vercel deployment succeeded in [the preview workflow](https://github.com/PrimeIntellect-ai/platform/actions/runs/34420294102). The [backend readiness check](https://github.com/PrimeIntellect-ai/platform/actions/runs/34421716559) then confirmed that `backend-preview-5228.pintel.dev` returned HTTP 503. A real CLI run against that endpoint completed locally with exit zero while telemetry requests received 503. After GCP reauthentication, inspection confirmed that SQL migrations succeeded but demo seeding failed because its job omitted MongoDB connection settings and defaulted to localhost. The available account cannot create/delete preview jobs. No live forwarding through this cloud preview was verified.

## Local HTTP collector to real PostHog on 2026-09-10 UTC

The alternative test used Agent implementation commit `3d1cb0843` and Platform collector code from `06ffe80f44`, followed by the IP-enrichment correction described below. Two local HTTP servers mounted the unchanged telemetry router, validation, forwarding and native-exception modules. They used the production Redis helpers and the unchanged rate-limiter functions loaded from source, backed by a disposable Redis 7.4 instance. Unrelated Platform API imports/startup, cloud routing, TLS and proxy configuration were excluded. Upstream delivery was real HTTPS to PostHog project 22174, with the ingestion credential supplied only in process memory.

The planned SDK, CLI and installer scenarios emitted 191 source events: 106 SDK records across all 14 event types, 37 real CLI records and 48 installation records. All 191 were acknowledged and reconciled by UUID with retained PostHog records. Every client-owned property matched. Eight error occurrences produced eight native exception records; recovery updates produced none. The CLI cost estimate of USD 0.00013 and its token/timing fields were retained. Synthetic prompt/credential canaries were absent from the retained records, GeoIP was disabled, and person processing was false. Settings and environment opt-outs emitted zero requests and created no installation identity.

The first SDK attempt shared one client across helpers that normally own separate clients; installation cleanup cleared unrelated queued fixture events. Correcting fixture ownership restored all 106 records without changing Agent production code. The separate CLI process checks passed with real delivery.

Live inspection found that PostHog replaces `$ip: null` with the collector's network address. Platform now supplies `$ip: "0.0.0.0"` while retaining `$geoip_disable: true`. After restarting the collector with that correction, all 13 retained compatibility/error-check records had the neutral IP value, disabled GeoIP and disabled person processing. The 37 focused collector tests passed with updated source/native IP assertions.

Additional real HTTP/PostHog checks passed:

- All five historical event types retained the original count-only acknowledgement.
- A mixed batch retained its valid event and acknowledged rejection of its invalid neighbor.
- Replaying the same error batch preserved source/native UUIDs; PostHog retained one record per UUID. Two `ECONNREFUSED` occurrences shared one native issue; `ETIMEDOUT` used another. A recovery update created no native exception.
- Empty, malformed, oversized and unsupported-version requests returned 400, 422, 413 and 422 respectively.
- Alternating requests between two collector processes shared one Redis IP bucket: the first 60 reached validation and request 61 returned 429 with `Retry-After: 60`. Varying `X-Forwarded-For` did not bypass the limiter with proxy-header trust disabled.
- Stopping the isolated Redis service produced 503 with `Retry-After: 10`; capability discovery remained available.

This establishes live Agent-to-collector-to-PostHog behavior for the tested scenarios. The cloud preview, deployed proxy trust/access logging, representative UI/daemon version combinations, abrupt-exit loss measurements, dashboard publication preflight and operational rollout criteria above remain separate checks. No shared PostHog settings, dashboards, alerts or production services were changed.

## Boundaries

Original-message forwarding to PostHog is authorized with credentials and prompt content excluded. Prime Agent requires an approved message ID and exact fixed text; the collector forwards bounded flat properties without duplicating that policy. Client credential pattern matching is a second safeguard; arbitrary provider/tool/error text is omitted because it can echo prompts. Fixed system descriptions are labeled separately from retained original wording. Missing or mismatched message-policy capabilities strip all message fields while retaining supported code/timing metadata. Native exceptions mirror explicit occurrences only, use deterministic IDs and code-based fingerprints, and contain no stacks, causes, request bodies or tool results.

Hard kills and abrupt crashes may lose memory-buffered reports. A missing run terminal is unknown, not a confirmed crash. A successful retry or later same-tool success records an observed recovery signal, not proof that the user's task was solved. Category comparisons cannot detect key/team/endpoint changes within one category.
