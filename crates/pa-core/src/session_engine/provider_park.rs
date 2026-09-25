//! Provider quota park: park quota-blocked sessions until the
//! provider-reported usage reset and auto-resume (the TS #2375 park
//! mechanism, adapted to this port's retry chain).
//!
//! The TS session enters its park from the wait-for-usage loop's
//! `reset-too-far` abort: a quota failure whose provider-reported reset
//! exceeds the bounded wait ends the turn cleanly and wakes at the reset.
//! This port has no ping loop; the bounded wait is the quick-retry
//! server-requested wait cap ([`ProviderRetryPolicy::max_retry_delay_ms`]):
//! a quota failure whose reported reset exceeds that cap ends the chain
//! with [`ProviderRetryDelay::ExceedsCap`], which is the park seam. A
//! quota failure without a reported reset keeps aborting (a blind park
//! would guess a wake time), and resets within the cap keep the
//! quick-retry schedule (the TS wait loop waits those out in-turn; a full
//! wait-for-usage port is its own lane).
//!
//! The park owner is the session engine: it holds the park state, records
//! the park/resume transitions in the session log, and schedules the wake
//! (a durable one-shot cron job whose prompt is
//! [`QUOTA_RESUME_MARKER_TEXT`], fired into the session's follow-up lane
//! by the scheduler). The decision logic here is pure and clock-free so
//! tests stay deterministic; the engine supplies the clock at the seam.

use pa_agent::types::AssistantMessage;

use super::provider_retry::{provider_stream_failure_kind, provider_stream_failure_retry_after_ms};

/// Parks wake slightly after the reported reset so the window has
/// actually rolled over (TS `PROVIDER_RESUME_GRACE_MS`).
pub const PROVIDER_RESUME_GRACE_MS: u64 = 30_000;

/// Upper clamp for the configured park bound: one week per park, so
/// long-horizon resets still get probed (TS `MAX_PROVIDER_PAUSE_MS`).
pub const MAX_PROVIDER_PAUSE_MS: u64 = 7 * 86_400_000;

/// Session-log entry recorded when a quota-blocked session parks until
/// the provider reset (TS `QUOTA_PARK_CUSTOM_ENTRY_TYPE`).
pub const PROVIDER_QUOTA_PARK_ENTRY: &str = "provider_quota_park";

/// Session-log entry recorded when a parked session resumes (or when a
/// wake had to be dropped) (TS `QUOTA_RESUME_CUSTOM_ENTRY_TYPE`).
pub const PROVIDER_QUOTA_RESUME_ENTRY: &str = "provider_quota_resume";

/// Label for the durable one-shot wake that resumes a parked session
/// (TS `QUOTA_RESUME_CRON_LABEL`).
pub const QUOTA_RESUME_CRON_LABEL: &str = "quota-resume";

/// In-context marker delivered on resume (TS `QUOTA_RESUME_MARKER_TEXT`):
/// tells the model the pause happened and that it should continue the
/// interrupted task. The same text is the durable wake job's prompt, so
/// scheduler-delivered resumes read identically.
pub const QUOTA_RESUME_MARKER_TEXT: &str = "<provider_quota_resumed>\nThe provider usage limit that paused this session has been reported as reset; this resume is automatic (retry.provider.waitForUsage.pauseUntilReset). Continue the interrupted task from where it stopped.\n</provider_quota_resumed>";

/// The quota-park policy (TS `ProviderWaitPolicy`'s park keys, settings
/// `retry.provider.waitForUsage`): whether resets beyond the bounded
/// wait park the session, the per-park ceiling, and the per-episode
/// park budget. The wait-loop keys of the TS group (ping delays,
/// attempt/duration bounds) stay unused here until a wait-for-usage
/// port lands; only the park keys have a consumer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderParkPolicy {
    /// Park sessions for provider-reported resets beyond the bounded
    /// wait. Default true; `false` restores the pre-park immediate abort.
    pub pause_until_reset: bool,
    /// Abort bound: maximum single park duration. Default 24h; values
    /// above [`MAX_PROVIDER_PAUSE_MS`] are clamped so long-horizon
    /// resets still get probed.
    pub max_pause_ms: u64,
    /// Abort bound: maximum parks per quota episode (a successful model
    /// call while parked resets the episode). Default 8, the same anchor
    /// as the TS `maxParks`.
    pub max_parks: u32,
}

/// Default policy (TS `DEFAULT_PROVIDER_WAIT_POLICY`'s park keys):
/// park on, 24h per park, 8 parks per episode.
pub const DEFAULT_PROVIDER_PARK_POLICY: ProviderParkPolicy = ProviderParkPolicy {
    pause_until_reset: true,
    max_pause_ms: 86_400_000,
    max_parks: 8,
};

/// Why no park happened (TS `ProviderParkDecision`'s `none` reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoParkReason {
    /// `pauseUntilReset: false`: the pre-park immediate abort.
    Disabled,
    /// The episode's park budget is spent: abort exactly like the
    /// bounded wait the park replaced.
    ParkBudget,
    /// No provider-reported reset: the bounded wait keeps its abort
    /// behavior (a blind park would guess a wake time).
    NoReset,
}

/// Resolution of one park decision (TS `ProviderParkDecision`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderParkDecision {
    /// Park, then wake `resume_after_ms` from now.
    Park { resume_after_ms: u64 },
    /// No park; the give-up it would have replaced stands.
    None { reason: NoParkReason },
}

/// What the park owner (the session engine) reports back to the retry
/// chain when it parks a quota-blocked turn: the status the chain
/// surfaces as its final `auto_retry_end` (the parked sentence, or the
/// already-parked sentence when an existing park owns the resume).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderParkOutcome {
    pub status_message: String,
}

/// The boxed park future: the engine parks async (the session-log append
/// and the wake-job creation take async locks).
pub type ParkFuture =
    std::pin::Pin<Box<dyn std::future::Future<Output = Option<ProviderParkOutcome>> + Send>>;

/// The park seam the retry chains consult at their give-up: called with
/// the failed turn's assistant message and the give-up sentence (the
/// park's abort message); `Some(outcome)` parks the session — the chain
/// surfaces `outcome.status_message` instead of the give-up — and `None`
/// keeps the give-up. The callback owns its state clones (the future is
/// `'static`).
pub type ParkDecisionCallback<'a> = &'a mut dyn FnMut(AssistantMessage, &str) -> ParkFuture;

/// Park decision after a quota failure whose provider-reported reset
/// exceeds the bounded wait (TS `providerParkDecision`): pure and
/// clock-free — the caller owns the clock at the seam.
pub fn provider_park_decision(
    parks_used: u32,
    reset_ms: Option<u64>,
    policy: &ProviderParkPolicy,
) -> ProviderParkDecision {
    if !policy.pause_until_reset {
        return ProviderParkDecision::None {
            reason: NoParkReason::Disabled,
        };
    }
    if parks_used >= policy.max_parks {
        return ProviderParkDecision::None {
            reason: NoParkReason::ParkBudget,
        };
    }
    let Some(reset_ms) = reset_ms else {
        return ProviderParkDecision::None {
            reason: NoParkReason::NoReset,
        };
    };
    let max_pause_ms = policy.max_pause_ms.min(MAX_PROVIDER_PAUSE_MS);
    ProviderParkDecision::Park {
        resume_after_ms: reset_ms
            .saturating_add(PROVIDER_RESUME_GRACE_MS)
            .min(max_pause_ms),
    }
}

/// Whether a failed assistant message is quota-classified (the TS wait
/// class `usage`: 429 / usage-limit rejections). This port's classifier
/// surface is the `provider_stream_failure` diagnostic's `rate_limit` kind.
pub fn is_quota_block_failure(message: &AssistantMessage) -> bool {
    provider_stream_failure_kind(message).as_deref() == Some("rate_limit")
}

/// One persisted park record: the `provider_quota_park` entry's data
/// (TS `PersistedQuotaParkData`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedQuotaPark {
    /// Wall-clock wake time for the park (epoch ms).
    pub resume_at_ms: u64,
    /// Parks consumed in the episode when it parked.
    pub park_count: u32,
    /// Id of the durable one-shot wake job, when the entry carries one.
    pub job_id: Option<String>,
}

/// One park scan's verdict: a newest-first entry walk distinguishes
/// "found the branch's park" from "the episode resumed" (an older park
/// behind a newer resume entry must not restore) and "no park entries
/// here" (a windowed reader keeps scanning the older records).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchParkScan {
    /// The newest relevant entry is a park: restore it.
    Park(PersistedQuotaPark),
    /// The newest relevant entry is a resume: no park.
    Resumed,
    /// No park or resume entries in the scanned range.
    None,
}

/// The park this branch ended on (TS `_restoreQuotaPark`'s scan): the
/// newest `provider_quota_park` entry not followed by a
/// `provider_quota_resume` entry, newest first.
pub fn scan_quota_park_entries(entries: &[pa_types::session::FileEntry]) -> BranchParkScan {
    for entry in entries.iter().rev() {
        let pa_types::session::FileEntry::Custom { payload, .. } = entry else {
            continue;
        };
        if payload.custom_type == PROVIDER_QUOTA_RESUME_ENTRY {
            // The episode resumed: no park.
            return BranchParkScan::Resumed;
        }
        if payload.custom_type != PROVIDER_QUOTA_PARK_ENTRY {
            continue;
        }
        let data = payload.data.clone().unwrap_or(serde_json::Value::Null);
        let Some(resume_at_iso) = data.get("resumeAt").and_then(serde_json::Value::as_str) else {
            return BranchParkScan::None;
        };
        let Some(resume_at_ms) = crate::cron::parse_iso_millis(resume_at_iso) else {
            return BranchParkScan::None;
        };
        let Some(park_count) = data
            .get("parkCount")
            .and_then(serde_json::Value::as_u64)
            .and_then(|count| u32::try_from(count).ok())
        else {
            return BranchParkScan::None;
        };
        let job_id = data
            .get("jobId")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        return BranchParkScan::Park(PersistedQuotaPark {
            resume_at_ms,
            park_count,
            job_id,
        });
    }
    BranchParkScan::None
}

/// The provider-reported reset of a quota failure, in milliseconds
/// (`retryAfterMs` on the stream-failure diagnostic — the codex usage
/// limit parse and the Retry-After header both land there).
pub fn quota_failure_reset_ms(message: &AssistantMessage) -> Option<u64> {
    provider_stream_failure_retry_after_ms(message)
}

/// The parked status text surfaced as the retry chain's `final_error`
/// (TS `_parkForQuotaReset`: `"<abort>. Session parked until <time> and
/// will resume automatically (…): <error>"`): the give-up sentence stays
/// this port's own (the TS abort names the wait loop this port lacks),
/// the parked sentence is the TS wording.
pub fn quota_parked_final_error(abort: &str, resume_at_ms: u64, error: &str) -> String {
    format!(
        "{abort}. Session parked until {} and will resume automatically (retry.provider.waitForUsage.pauseUntilReset): {error}",
        crate::session::manager::format_iso(resume_at_ms as i64)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_engine::provider_retry::provider_stream_failure_details;
    use pa_agent::types::{
        AssistantContent, AssistantMessage, AssistantMessageDiagnostic, StopReason, TextContent,
        Usage,
    };
    use pa_types::session::{CustomEntry, EntryBase, FileEntry};

    fn policy() -> ProviderParkPolicy {
        DEFAULT_PROVIDER_PARK_POLICY
    }

    fn custom_entry(custom_type: &str, data: Option<serde_json::Value>) -> FileEntry {
        FileEntry::Custom {
            payload: CustomEntry {
                custom_type: custom_type.to_string(),
                data,
                rest: pa_types::JsonMap::new(),
            },
            base: EntryBase {
                id: Some("e1".to_string()),
                parent_id: None,
                timestamp: None,
                rest: pa_types::JsonMap::new(),
            },
        }
    }

    #[test]
    fn parks_at_the_reported_reset_plus_grace() {
        let decision = provider_park_decision(0, Some(3_600_000), &policy());
        assert_eq!(
            decision,
            ProviderParkDecision::Park {
                resume_after_ms: 3_600_000 + PROVIDER_RESUME_GRACE_MS
            }
        );
    }

    #[test]
    fn caps_a_distant_reset_at_max_pause_ms() {
        let decision = provider_park_decision(0, Some(30 * 86_400_000), &policy());
        assert_eq!(
            decision,
            ProviderParkDecision::Park {
                resume_after_ms: 86_400_000
            }
        );
    }

    #[test]
    fn clamps_a_configured_bound_above_one_week() {
        let mut configured = policy();
        configured.max_pause_ms = 60 * 86_400_000;
        let decision = provider_park_decision(0, Some(u64::MAX / 2), &configured);
        assert_eq!(
            decision,
            ProviderParkDecision::Park {
                resume_after_ms: MAX_PROVIDER_PAUSE_MS
            }
        );
    }

    #[test]
    fn disabled_keeps_the_immediate_abort() {
        let mut disabled = policy();
        disabled.pause_until_reset = false;
        assert_eq!(
            provider_park_decision(0, Some(3_600_000), &disabled),
            ProviderParkDecision::None {
                reason: NoParkReason::Disabled
            }
        );
    }

    #[test]
    fn spent_park_budget_aborts() {
        assert_eq!(
            provider_park_decision(policy().max_parks, Some(3_600_000), &policy()),
            ProviderParkDecision::None {
                reason: NoParkReason::ParkBudget
            }
        );
    }

    #[test]
    fn no_reported_reset_never_parks() {
        assert_eq!(
            provider_park_decision(0, None, &policy()),
            ProviderParkDecision::None {
                reason: NoParkReason::NoReset
            }
        );
    }

    fn quota_message(kind: Option<&str>, retry_after_ms: Option<u64>) -> AssistantMessage {
        let details = serde_json::json!({
            "kind": kind,
            "retryAfterMs": retry_after_ms,
        });
        AssistantMessage {
            content: vec![AssistantContent::Text(TextContent {
                text: String::new(),
                text_signature: None,
            })],
            api: String::new(),
            provider: "test".to_string(),
            model: "m".to_string(),
            response_model: None,
            response_id: None,
            diagnostics: Some(vec![AssistantMessageDiagnostic {
                kind: "provider_stream_failure".to_string(),
                timestamp: 0,
                error: None,
                details: Some(details),
            }]),
            usage: Usage::zero(),
            stop_reason: StopReason::Error,
            stop_reason_raw: None,
            error_message: Some("You have hit your usage limit".to_string()),
            timestamp: 0,
        }
    }

    #[test]
    fn quota_classification_reads_the_rate_limit_kind() {
        assert!(is_quota_block_failure(&quota_message(
            Some("rate_limit"),
            Some(600_000)
        )));
        assert!(!is_quota_block_failure(&quota_message(
            Some("server_error"),
            Some(600_000)
        )));
        assert_eq!(
            quota_failure_reset_ms(&quota_message(Some("rate_limit"), Some(600_000))),
            Some(600_000)
        );
        // The details accessor stays reachable for the message shape the
        // engine parks on.
        assert!(
            provider_stream_failure_details(&quota_message(Some("rate_limit"), Some(600_000)))
                .is_some()
        );
    }

    #[test]
    fn parked_status_names_the_wake_time() {
        let message = quota_parked_final_error(
            "Provider requested a 4363s wait before retrying (above retry.provider.maxRetryDelayMs=60000ms)",
            1_789_516_800_000,
            "You have hit your usage limit",
        );
        assert!(message.contains(
            "Session parked until 2026-09-16T00:00:00.000Z and will resume automatically (retry.provider.waitForUsage.pauseUntilReset): You have hit your usage limit"
        ));
        assert!(message.starts_with("Provider requested a 4363s wait"));
    }

    #[test]
    fn branch_scan_takes_the_newest_park() {
        let entries = vec![
            custom_entry(
                PROVIDER_QUOTA_PARK_ENTRY,
                Some(serde_json::json!({
                    "resumeAt": "2026-09-16T01:00:00.000Z",
                    "parkCount": 1,
                    "jobId": "job-1",
                })),
            ),
            custom_entry(
                PROVIDER_QUOTA_PARK_ENTRY,
                Some(serde_json::json!({
                    "resumeAt": "2026-09-16T03:00:00.000Z",
                    "parkCount": 2,
                    "jobId": "job-2",
                })),
            ),
        ];
        match scan_quota_park_entries(&entries) {
            BranchParkScan::Park(park) => {
                assert_eq!(park.park_count, 2);
                assert_eq!(park.resume_at_ms, 1_789_516_800_000 + 3 * 3_600_000);
                assert_eq!(park.job_id.as_deref(), Some("job-2"));
            }
            other => panic!("expected a park, got {other:?}"),
        }
    }

    #[test]
    fn branch_scan_stops_at_a_newer_resume() {
        let entries = vec![
            custom_entry(
                PROVIDER_QUOTA_PARK_ENTRY,
                Some(serde_json::json!({
                    "resumeAt": "2026-09-24T01:00:00.000Z",
                    "parkCount": 3,
                })),
            ),
            custom_entry(
                PROVIDER_QUOTA_RESUME_ENTRY,
                Some(serde_json::json!({
                    "outcome": "wake",
                })),
            ),
        ];
        assert_eq!(scan_quota_park_entries(&entries), BranchParkScan::Resumed);
    }

    #[test]
    fn branch_scan_ignores_unrelated_entries_and_bad_data() {
        let entries = vec![
            custom_entry("after-git-state", Some(serde_json::json!({ "keep": true }))),
            custom_entry(
                PROVIDER_QUOTA_PARK_ENTRY,
                Some(serde_json::json!({
                    "parkCount": 1,
                })),
            ),
        ];
        assert_eq!(scan_quota_park_entries(&entries), BranchParkScan::None);
        let empty: Vec<FileEntry> = Vec::new();
        assert_eq!(scan_quota_park_entries(&empty), BranchParkScan::None);
    }
}
