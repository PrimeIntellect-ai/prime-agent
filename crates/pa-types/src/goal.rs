//! Thread-goal wire state, carried to every attached surface by the `goal_update` session event and
//! the attach snapshot's `state.goal` field; the goal engine lives in pa-core. Field shape is the
//! TS `GoalState` (camelCase, optional keys omitted).

use serde::{Deserialize, Serialize};

/// The lifecycle status of a thread goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Idle,
    Active,
    Paused,
    BudgetLimited,
    Complete,
    Error,
}

impl GoalStatus {
    /// The wire/persisted slug (`"active"`, `"budget_limited"`, ...), the
    /// TS `GoalStatus` union's string.
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            GoalStatus::Idle => "idle",
            GoalStatus::Active => "active",
            GoalStatus::Paused => "paused",
            GoalStatus::BudgetLimited => "budget_limited",
            GoalStatus::Complete => "complete",
            GoalStatus::Error => "error",
        }
    }
}

/// The persisted thread-goal state (custom entry data of the
/// `thread_goal_state` session record, and the `goal_update` event payload).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GoalState {
    pub active: bool,
    pub status: GoalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub goal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub time_used_seconds: u64,
    pub continuations_used: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    /// The consecutive-no-output-turn streak at the continuation mint (the hot-loop killer's cap
    /// counter): durable so a worker restart cannot reset the streak and un-cap a degenerate loop;
    /// a turn that produced output resets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_progress_streak: Option<u32>,
    /// The last turn the streak counted (Unix-ms): the re-consult dedup across a worker restart
    /// (the in-process key is live-only, so the durable row carries it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_progress_turn_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

impl Default for GoalState {
    fn default() -> Self {
        empty_goal_state()
    }
}

/// The state with no goal (TS `emptyGoalState`).
#[must_use]
pub fn empty_goal_state() -> GoalState {
    GoalState {
        active: false,
        status: GoalStatus::Idle,
        goal_id: None,
        objective: None,
        token_budget: None,
        tokens_used: 0,
        time_used_seconds: 0,
        continuations_used: 0,
        created_at: None,
        no_progress_streak: None,
        no_progress_turn_ms: None,
        updated_at: None,
        last_reason: None,
        last_error: None,
    }
}
