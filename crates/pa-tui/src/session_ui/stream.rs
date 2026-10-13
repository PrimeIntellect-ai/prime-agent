//! The working loader's activity and token accounting over provider stream
//! events, plus the `/speed` readout and the streaming/running/resume hint
//! helpers.
use super::{AgentView, SessionUi, Value, WorkingState};

/// The loader's token accounting: the live count is completed-message output tokens plus
/// max(reported usage, the chars/4 estimate), derived from the streamed message itself — never from
/// per-delta sums — because the worker coalesces deltas into latest-snapshot frames.
#[derive(Debug, Default)]
pub(super) struct LoaderTokenTracker {
    /// Settled-message output tokens, banked at `message_end`.
    completed_tokens: u64,
    /// The streaming message's reported `usage.output`.
    streaming_usage: u64,
    /// The streaming message's content size in chars.
    streaming_chars: u64,
}

impl LoaderTokenTracker {
    /// A fresh run counts from zero.
    fn reset(&mut self) {
        self.completed_tokens = 0;
        self.start_message();
    }

    /// The new message's live state starts empty.
    pub(super) fn start_message(&mut self) {
        self.streaming_usage = 0;
        self.streaming_chars = 0;
    }

    pub(super) fn apply_streaming(&mut self, usage_output: u64, content_chars: u64) -> u64 {
        self.streaming_usage = usage_output;
        self.streaming_chars = content_chars;
        self.current()
    }

    /// Bank the message's tokens into the completed count (authoritative usage
    /// when reported, else the live estimate).
    pub(super) fn settle(&mut self, usage_output: u64) {
        let estimate = (self.streaming_chars as f64 / 4.0).round() as u64;
        self.completed_tokens += if usage_output > 0 {
            usage_output
        } else {
            estimate
        };
        self.start_message();
    }

    fn current(&self) -> u64 {
        let estimate = (self.streaming_chars as f64 / 4.0).round() as u64;
        self.completed_tokens + self.streaming_usage.max(estimate)
    }
}

/// Per-session output tok/sec accumulation for `/speed`: tokens and spans
/// summed over the session's completed responses.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub(super) struct SpeedStats {
    tokens: u64,
    duration_ms: i64,
    samples: u32,
}

impl SpeedStats {
    /// The session-average rate in tok/s over the accumulated span.
    fn average_rate(&self) -> f64 {
        self.tokens as f64 / (self.duration_ms as f64 / 1000.0)
    }
}

/// TS `formatRate`: whole numbers at 100 tok/s and above, one decimal
/// below.
fn format_rate(tokens_per_second: f64) -> String {
    if tokens_per_second >= 100.0 {
        format!("{tokens_per_second:.0}")
    } else {
        format!("{tokens_per_second:.1}")
    }
}

impl SessionUi {
    pub(crate) fn start_loader(&mut self, view: &mut AgentView) {
        self.start_loader_at(view, std::time::Instant::now());
    }

    /// [`Self::start_loader`] with an explicit anchor: the live paths pass
    /// now; the rebuild path passes the LAST HUMAN PROMPT's instant (the
    /// operator's 2026-09-28 rule: the timer never resets on a view transition).
    pub(crate) fn start_loader_at(&mut self, view: &mut AgentView, since: std::time::Instant) {
        view.working = Some(WorkingState {
            activity: "Waiting",
            message: None,
            download: false,
            tokens: 0,
            elapsed_secs: 0,
        });
        view.working_since = Some(since);
        self.working_tokens.reset();
    }

    /// Update the loader's activity label from one provider stream event (thinking/text/toolcall
    /// events switch the label and direction): the message, not the delta, carries the token truth.
    pub(crate) fn track_stream_activity(event: &Value, view: &mut AgentView) {
        let (activity, download) = match event.get("type").and_then(Value::as_str) {
            Some("thinking_start" | "thinking_delta") => ("Thinking", true),
            Some("text_start" | "text_delta") => ("Writing", true),
            Some("toolcall_start" | "toolcall_delta") => ("Writing code", true),
            _ => return,
        };
        if let Some(working) = &mut view.working {
            working.activity = activity;
            working.download = download;
        }
    }

    /// `/speed on/off`: toggles the footer tok/sec readout; disabling clears the
    /// stats and the row.
    pub(crate) fn set_speed_display(&mut self, enabled: bool, view: &mut AgentView) {
        self.speed_display_enabled = enabled;
        if !enabled {
            self.speed_stats = None;
            view.chrome.speed_text = None;
        }
        let status = if enabled {
            "Speed display on — footer shows output tok/s per model response and a session average"
        } else {
            "Speed display off"
        };
        self.note(status, view);
    }

    /// Update the footer tok/sec readout from a completed assistant message: output tokens over the
    /// span from the message timestamp to this `message_end` (timestamps keep the span true when
    /// buffered events replay back-to-back on attach). Samples without a finite positive span or
    /// token count are skipped.
    pub(crate) fn record_speed_sample(&mut self, message: &Value, view: &mut AgentView) {
        if !self.speed_display_enabled {
            return;
        }
        let stop_reason = message
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if stop_reason == "aborted" || stop_reason == "error" {
            return;
        }
        // A frame without a timestamp is skipped too — a zero-default would span
        // the epoch and poison the average.
        let Some(timestamp) = message.get("timestamp").and_then(Value::as_i64) else {
            return;
        };
        let duration_ms = crate::agents_view_state::now_ms() as i64 - timestamp;
        let output_tokens = message
            .get("usage")
            .and_then(|usage| usage.get("output"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        if duration_ms <= 0 || output_tokens == 0 {
            return;
        }
        let stats = self.speed_stats.get_or_insert_with(SpeedStats::default);
        stats.tokens += output_tokens;
        stats.duration_ms += duration_ms;
        stats.samples += 1;
        let last = format_rate(output_tokens as f64 / (duration_ms as f64 / 1000.0));
        let average = format_rate(stats.average_rate());
        view.chrome.speed_text = Some(if stats.samples > 1 {
            format!("{last} tok/s · avg {average}")
        } else {
            format!("{last} tok/s")
        });
    }
}

/// The streaming follow-up hint: `<followUp> to queue message` — the tray override while the agent
/// streams and a draft sits in the editor (an empty draft or an idle session shows nothing; the
/// exit hint outranks it at the call site).
pub(super) fn streaming_tray_hint(
    keybindings: &crate::keybindings::KeybindingsManager,
    turn_active: bool,
    draft: &str,
) -> Option<String> {
    if !turn_active || draft.trim().is_empty() {
        return None;
    }
    let follow_up = keybindings
        .first_key("app.message.followUp")
        .map(|key| crate::keybindings::format_key_text(&key))
        .unwrap_or_default();
    Some(format!("{follow_up} to queue message"))
}

/// The running-command guard's warning: the clear key cancels it, spelled
/// through the effective keybindings.
pub(super) fn already_running_warning(
    keybindings: &crate::keybindings::KeybindingsManager,
) -> String {
    let key = keybindings.first_key("app.clear").map_or_else(
        || "Ctrl+C".to_string(),
        |key| crate::keybindings::format_key_text(&key),
    );
    // The ⚠ prefix travels with the row text (the StatusKind tier is color
    // only).
    format!("\u{26a0} A bash command is already running. Press {key} to cancel it first.")
}

/// The post-exit hint names how to resume the session just left; ephemeral and unflushed-empty
/// sessions are omitted, and a missing file cannot be resumed either.
pub(crate) fn resume_hint_from_stats(stats: &Value) -> Option<String> {
    let session_id = stats.get("sessionId").and_then(Value::as_str)?;
    let session_file = stats.get("sessionFile").and_then(Value::as_str)?;
    let user_messages = stats
        .get("userMessages")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if session_file.is_empty() || user_messages == 0 || !std::path::Path::new(session_file).exists()
    {
        return None;
    }
    Some(format!(
        "Resume this session with: prime-agent --resume {session_id}"
    ))
}

#[cfg(test)]
mod streaming_tray_hint_tests {
    use super::streaming_tray_hint;
    use crate::keybindings::{KeybindingsConfig, KeybindingsManager};

    #[test]
    fn the_hint_names_the_follow_up_key_over_a_draft() {
        let kb = KeybindingsManager::new();
        assert_eq!(
            streaming_tray_hint(&kb, true, "a draft in the editor"),
            Some("Alt+Enter to queue message".to_string()),
            "the default binding renders the TS sentence"
        );
    }

    #[test]
    fn idle_or_empty_draft_shows_no_hint() {
        let kb = KeybindingsManager::new();
        assert_eq!(streaming_tray_hint(&kb, false, "draft"), None);
        assert_eq!(streaming_tray_hint(&kb, true, ""), None);
        assert_eq!(streaming_tray_hint(&kb, true, "   "), None);
    }

    #[test]
    fn the_hint_spells_a_rebound_follow_up_key() {
        let mut config = KeybindingsConfig::new();
        config.insert(
            "app.message.followUp".to_string(),
            vec!["ctrl+q".to_string()],
        );
        let kb = KeybindingsManager::with_user_bindings(config);
        assert_eq!(
            streaming_tray_hint(&kb, true, "draft"),
            Some("Ctrl+Q to queue message".to_string()),
            "the hint follows the effective binding"
        );
    }
}

#[cfg(test)]
mod loader_token_tests {
    use super::{format_rate, LoaderTokenTracker, SpeedStats};

    #[test]
    fn coalesced_frames_count_from_the_message_not_deltas() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        // A message streams to 400 chars; the coalesced wire frame carries
        // the full snapshot but only the final provider delta.
        assert_eq!(tracker.apply_streaming(0, 400), 100);
        // A provider that reports usage upfront wins over the estimate.
        assert_eq!(tracker.apply_streaming(600, 400), 600);
        // Settle banks the reported usage, then the live state is empty.
        tracker.settle(600);
        assert_eq!(tracker.current(), 600);
    }

    #[test]
    fn settle_without_usage_banks_the_estimate() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        assert_eq!(tracker.apply_streaming(0, 404), 101);
        tracker.settle(0);
        assert_eq!(tracker.current(), 101);
    }

    #[test]
    fn message_start_resets_the_live_state_and_agent_start_the_run() {
        let mut tracker = LoaderTokenTracker::default();
        tracker.reset();
        assert_eq!(tracker.apply_streaming(0, 800), 200);
        tracker.settle(0);
        tracker.start_message();
        // The live count rides on the run's completed count: 200 banked
        // plus the new message's reported 50.
        assert_eq!(tracker.apply_streaming(50, 8), 250);
        tracker.settle(50);
        assert_eq!(tracker.current(), 250);
        tracker.reset();
        assert_eq!(tracker.current(), 0);
    }

    #[test]
    fn format_rate_matches_the_ts_boundaries() {
        assert_eq!(format_rate(150.0), "150");
        assert_eq!(format_rate(100.0), "100");
        assert_eq!(format_rate(99.96), "100.0");
        assert_eq!(format_rate(12.34), "12.3");
        assert_eq!(format_rate(0.5), "0.5");
    }

    #[test]
    fn speed_stats_average_rate_sums_tokens_over_spans() {
        let mut stats = SpeedStats {
            tokens: 300,
            duration_ms: 1500,
            samples: 1,
        };
        assert!((stats.average_rate() - 200.0).abs() < f64::EPSILON);
        stats.tokens += 100;
        stats.duration_ms += 500;
        assert!((stats.average_rate() - 200.0).abs() < f64::EPSILON);
    }
}
