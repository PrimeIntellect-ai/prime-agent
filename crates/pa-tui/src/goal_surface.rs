//! Thread-goal view state: the `goal_update` surface (TS interactive-mode
//! `handleGoalUpdate`/`shouldAnnounceGoalUpdate`/`formatGoalStatus`) plus
//! the tray goal label (`getTrayGoalLabel`/`formatGoalElapsed`). Pure
//! state and formatting; the session view owns the transcript rows.

use pa_types::goal::{empty_goal_state, GoalState, GoalStatus};

/// The announcement dedupe snapshot (TS `goalAnnouncementSnapshot`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalAnnouncementSnapshot {
    pub goal_id: Option<String>,
    pub status: GoalStatus,
    pub objective: Option<String>,
    pub last_reason: Option<String>,
    pub last_error: Option<String>,
}

impl Default for GoalAnnouncementSnapshot {
    fn default() -> Self {
        announcement_snapshot(&empty_goal_state())
    }
}

/// TS `goalAnnouncementSnapshot`.
pub fn announcement_snapshot(goal: &GoalState) -> GoalAnnouncementSnapshot {
    GoalAnnouncementSnapshot {
        goal_id: goal.goal_id.clone(),
        status: goal.status,
        objective: goal.objective.clone(),
        last_reason: goal.last_reason.clone(),
        last_error: goal.last_error.clone(),
    }
}

/// TS `shouldAnnounceGoalUpdate`: state changes always announce; a goal-id
/// change announces unless the new state is idle; within one goal only
/// reason/error changes re-announce (an active goal never does).
pub fn should_announce(
    previous: &GoalAnnouncementSnapshot,
    next: &GoalAnnouncementSnapshot,
) -> bool {
    if previous.status != next.status {
        return true;
    }
    if previous.goal_id != next.goal_id {
        return next.status != GoalStatus::Idle;
    }
    match next.status {
        GoalStatus::Active | GoalStatus::Idle => false,
        GoalStatus::Paused | GoalStatus::BudgetLimited | GoalStatus::Complete => {
            previous.last_reason != next.last_reason
        }
        GoalStatus::Error => previous.last_error != next.last_error,
    }
}

/// TS `formatGoalUsage`: the token budget usage, or wall-clock seconds.
pub fn format_goal_usage(goal: &GoalState) -> Option<String> {
    if let Some(budget) = goal.token_budget {
        return Some(format!("{} / {} tokens", goal.tokens_used, budget));
    }
    if goal.time_used_seconds == 0 {
        return None;
    }
    Some(format!("{}s", goal.time_used_seconds))
}

/// TS `formatGoalStatus` + `formatGoalDetailSuffix`: the status-row text for
/// one goal state at the given terminal width.
pub fn format_goal_status(goal: &GoalState, columns: usize) -> String {
    let usage_text = format_goal_usage(goal)
        .map(|usage| format!(" ({usage})"))
        .unwrap_or_default();
    match goal.status {
        GoalStatus::Idle => "No active goal".to_string(),
        GoalStatus::Active => match &goal.objective {
            Some(objective) => format!(
                "Goal{}",
                goal_detail_suffix(objective, crate::width::str_width("Goal"), columns)
            ),
            None => "Pursuing goal".to_string(),
        },
        GoalStatus::Paused => match &goal.last_reason {
            Some(reason) => format!(
                "Goal paused{}",
                goal_detail_suffix(reason, crate::width::str_width("Goal paused"), columns)
            ),
            None => "Goal paused (/goal resume)".to_string(),
        },
        GoalStatus::BudgetLimited => {
            let prefix = format!("Goal budget limited{usage_text}");
            match &goal.last_reason {
                Some(reason) => format!(
                    "{prefix}{}",
                    goal_detail_suffix(reason, crate::width::str_width(&prefix), columns)
                ),
                None => prefix,
            }
        }
        GoalStatus::Complete => match &goal.last_reason {
            Some(reason) => format!(
                "Goal complete{}",
                goal_detail_suffix(reason, crate::width::str_width("Goal complete"), columns)
            ),
            None => "Goal complete".to_string(),
        },
        GoalStatus::Error => match &goal.last_error {
            Some(error) => format!(
                "Goal error{}",
                goal_detail_suffix(error, crate::width::str_width("Goal error"), columns)
            ),
            None => "Goal error".to_string(),
        },
    }
}

/// TS `formatGoalDetailSuffix`: `: <collapsed detail>` truncated to the
/// remaining width (capped at 120 columns; dropped under 8).
fn goal_detail_suffix(value: &str, prefix_width: usize, columns: usize) -> String {
    let detail: String = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if detail.is_empty() {
        return String::new();
    }
    let available_width = 120.min(columns.saturating_sub(prefix_width + 2)).max(1);
    if available_width < 8 {
        return String::new();
    }
    format!(": {}", truncate_plain(&detail, available_width))
}

/// `truncateToWidth` over unstyled text with the default `...` ellipsis.
fn truncate_plain(text: &str, width: usize) -> String {
    let line: crate::Line = vec![crate::Span::raw(text.to_string())];
    crate::width::truncate_line(&line, width, "...")
        .iter()
        .map(|span| span.content.as_str())
        .collect::<String>()
}

/// TS `getTrayGoalLabel`: the tray label while the goal is running;
/// terminal states (idle/complete/error) carry no label.
pub fn tray_goal_label(goal: &GoalState) -> Option<String> {
    match goal.status {
        GoalStatus::Active => Some(format!(
            "Pursuing goal ({})",
            format_goal_elapsed(goal.time_used_seconds)
        )),
        GoalStatus::Paused => Some(format!(
            "Goal paused ({})",
            format_goal_elapsed(goal.time_used_seconds)
        )),
        GoalStatus::BudgetLimited => Some(format!(
            "Goal budget limited ({})",
            format_goal_elapsed(goal.time_used_seconds)
        )),
        GoalStatus::Idle | GoalStatus::Complete | GoalStatus::Error => None,
    }
}

/// TS `formatGoalElapsed`: `45s`, `12m 05s`, `1h 07m`.
pub fn format_goal_elapsed(seconds: u64) -> String {
    if seconds < 60 {
        return format!("{seconds}s");
    }
    let minutes = seconds / 60;
    let remaining_seconds = seconds % 60;
    if minutes < 60 {
        return format!("{minutes}m {remaining_seconds:02}s");
    }
    let hours = minutes / 60;
    let remaining_minutes = minutes % 60;
    format!("{hours}h {remaining_minutes:02}m")
}

/// The session view's goal state (the current `goal_update` payload) and
/// its announcement bookkeeping.
#[derive(Debug, Default)]
pub struct GoalView {
    pub goal: GoalState,
    last_announcement: GoalAnnouncementSnapshot,
    /// The transcript index of the status row the last announcement wrote:
    /// a following announcement rewrites it in place while it is still the
    /// last entry (TS `showStatus` keeps its own last row current).
    pub last_status_index: Option<usize>,
}

impl GoalView {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop the tracked status row after a transcript rebuild (the indices
    /// belong to the previous chat).
    pub fn reset_row_tracking(&mut self) {
        self.last_status_index = None;
    }

    /// Seed the state from an attach snapshot (TS
    /// `setGoalAnnouncementBaseline(getGoalState())` on attach): the
    /// baseline absorbs the state so reattachment never announces.
    pub fn seed(&mut self, goal: GoalState) {
        self.goal = goal;
        self.last_announcement = announcement_snapshot(&self.goal);
    }

    /// Apply one `goal_update` (the baseline always advances): `true` when
    /// the update announces as a status row.
    pub fn apply_update(&mut self, goal: GoalState) -> bool {
        let next = announcement_snapshot(&goal);
        let announce = should_announce(&self.last_announcement, &next);
        self.goal = goal;
        self.last_announcement = next;
        announce
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn goal(status: GoalStatus) -> GoalState {
        GoalState {
            status,
            objective: Some("ship it today".to_string()),
            ..empty_goal_state()
        }
    }

    #[test]
    fn announce_rules_match_ts() {
        let mut view = GoalView::new();
        // Baseline seeded empty: an idle update never announces.
        assert!(!view.apply_update(empty_goal_state()));
        // Status change announces.
        assert!(view.apply_update(goal(GoalStatus::Active)));
        // Same state (usage churn) stays silent.
        let mut churn = goal(GoalStatus::Active);
        churn.tokens_used = 500;
        assert!(!view.apply_update(churn));
        // Reason change on a paused goal re-announces.
        let mut paused = goal(GoalStatus::Paused);
        paused.last_reason = Some("Paused by user".to_string());
        assert!(view.apply_update(paused.clone()));
        assert!(!view.apply_update(paused));
        // Completion announces.
        let mut complete = goal(GoalStatus::Complete);
        complete.last_reason = Some("Goal achieved".to_string());
        assert!(view.apply_update(complete));
        // Error re-announces only on a new error.
        let mut error = goal(GoalStatus::Error);
        error.last_error = Some("boom".to_string());
        assert!(view.apply_update(error.clone()));
        assert!(!view.apply_update(error));
    }

    #[test]
    fn attach_seed_never_announces() {
        let mut view = GoalView::new();
        view.seed(goal(GoalStatus::Active));
        // The same state arriving as the first update stays silent.
        assert!(!view.apply_update(goal(GoalStatus::Active)));
    }

    #[test]
    fn status_text_matches_ts_shapes() {
        let mut complete = goal(GoalStatus::Complete);
        complete.last_reason = Some("Goal achieved".to_string());
        assert_eq!(
            format_goal_status(&complete, 120),
            "Goal complete: Goal achieved"
        );
        let paused = goal(GoalStatus::Paused);
        assert_eq!(
            format_goal_status(&paused, 120),
            "Goal paused (/goal resume)"
        );
        let mut paused_reason = goal(GoalStatus::Paused);
        paused_reason.last_reason = Some("Paused by user".to_string());
        assert_eq!(
            format_goal_status(&paused_reason, 120),
            "Goal paused: Paused by user"
        );
        assert_eq!(
            format_goal_status(&goal(GoalStatus::Active), 120),
            "Goal: ship it today"
        );
        assert_eq!(
            format_goal_status(&empty_goal_state(), 120),
            "No active goal"
        );
        // Budget-limited rows carry the usage.
        let mut limited = goal(GoalStatus::BudgetLimited);
        limited.token_budget = Some(100);
        limited.tokens_used = 120;
        assert_eq!(
            format_goal_status(&limited, 120),
            "Goal budget limited (120 / 100 tokens)"
        );
        // Narrow terminals drop the detail suffix.
        assert_eq!(format_goal_status(&complete, 10), "Goal complete");
    }

    #[test]
    fn tray_labels_match_ts() {
        let active = goal(GoalStatus::Active);
        assert_eq!(
            tray_goal_label(&active).as_deref(),
            Some("Pursuing goal (0s)")
        );
        let paused = goal(GoalStatus::Paused);
        assert_eq!(
            tray_goal_label(&paused).as_deref(),
            Some("Goal paused (0s)")
        );
        assert_eq!(tray_goal_label(&goal(GoalStatus::Complete)), None);
        assert_eq!(tray_goal_label(&empty_goal_state()), None);
        let mut elapsed = goal(GoalStatus::Active);
        elapsed.time_used_seconds = 125;
        assert_eq!(
            tray_goal_label(&elapsed).as_deref(),
            Some("Pursuing goal (2m 05s)")
        );
        elapsed.time_used_seconds = 3672;
        assert_eq!(
            tray_goal_label(&elapsed).as_deref(),
            Some("Pursuing goal (1h 01m)")
        );
    }
}
