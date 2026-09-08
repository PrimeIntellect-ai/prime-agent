# Telemetry acceptance evidence

This checklist covers ENG-5926–ENG-5933 under ENG-5925. A checked implementation test is not evidence that a collector, client, dashboard, or alert is deployed. Do not close rollout-dependent acceptance criteria until their evidence is attached.

| Issue | Implementation and verification | Remaining operational evidence |
| --- | --- | --- |
| ENG-5926 | Schema allowlists, synthetic credential-redaction fixtures, bounded IDs/messages, global/project/environment opt-outs, synchronous queue/aggregate cleanup | Approval of original-message forwarding to PostHog; deployed CDN/access-log/tracing and ingestion-transform audit; retention/deletion decision |
| ENG-5927 | Additive v2 envelope, legacy projection, same-ID retry, partial acknowledgement and rollback tests; revision-2 client contract and restricted collector projection with explicit message stripping | Collector-first staging rollout; original-message contract integration and payload reconciliation after approval |
| ENG-5928 | Setup context, input IDs, categorized actual worker auth/provider/team/endpoint context, setup/UI differences, pre-run failure observations | Staged cold/warm/resume and old/new daemon combinations; real coverage of configured workflows and first successful work |
| ENG-5929 | Bounded in-memory queues, session/run terminals, retry/cancellation distinctions, installation/error/run deduplication | Controlled shutdown and abrupt-exit loss measurements in staging; compare upload counters with retained events |
| ENG-5930 | Stable code groups for HTTP, daemon, filesystem and process failures; distinct occurrence/recovery records; session-scoped recovery and fatal monitor | Original-message forwarding and native PostHog exception mirror pending explicit destination approval; staging error-to-issue reconciliation |
| ENG-5931 | Input queue/preparation/run timing, actual UI frame status where attributable, cancellation-to-idle, stream/tool/retry/compaction timing and usage/cost coverage | Version/provider/mode coverage and percentile validation on representative deployed workloads; ambiguous UI status remains unavailable |
| ENG-5932 | Fixed feature/feedback categories, explicit internal/test origin, mature repeated-success cohorts and configured-workflow activation | Population coverage and cohort maturity after rollout; unknown origin is retained, not inferred to mean external |
| ENG-5933 | Seven historical corrections, 27 versioned views, revision-aware publication gates and three disabled native alert definitions; publication tests | Execute read-only preflight against deployed revision-2 events; review dashboards, denominators and thresholds; publish and explicitly select subscribers before enabling alerts |

## Evidence to retain

Record the two deployed commit IDs, client versions, daemon schema/capabilities, verification commands, synthetic upload/export counts, rejection counters and dashboard preflight result. Record opt-out settings with the test result, without including actual keys, accounts, prompts or user error text.

The client tests exercise fake clocks/providers or local synthetic errors. The Platform verification utility generates synthetic requests and reconciles retained exports offline. Neither is an authorization to upload real user data or a claim of live coverage.

## Deployment audit snapshot

The read-only PostHog project review on 2026-09-08 found project timezone GMT, `anonymize_ips=false`, retention set to 84 months with enforcement disabled, and no project-wide exception opt-in value. These are shared project settings, not proof of the final agent payload. The agent collector disables GeoIP/person enrichment per event and strips transport metadata; verify the retained result after all ingestion transforms. Review retention and access with the project owner without silently changing settings for unrelated website telemetry.

Review the Platform collector's `DEPLOYMENT.md` for the separate proxy/CDN, logging, tracing, exception intake and export evidence. Code inspection alone cannot establish those deployed settings.

## Boundaries

Original error wording may contain contextual details even after credential redaction. The proposed field retains up to 4,096 Unicode code points, has truncation/redaction metadata, and is separate from stable error-code grouping. It does not serialize entire exceptions, request bodies, tool results or stack traces. The collector forwarding policy is pending explicit confirmation in this task. Revision-2 input/timing/context and error-code metadata can be accepted independently: the collector explicitly strips all original-message properties and advertises message forwarding and native Error Tracking as disabled.

Hard kills and abrupt crashes may lose memory-buffered reports. A missing run terminal is unknown, not a confirmed crash. A successful retry or later same-tool success records an observed recovery signal, not proof that the user's task was solved. Category comparisons cannot detect key/team/endpoint changes within one category.
