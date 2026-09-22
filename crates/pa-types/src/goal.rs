//! Thread-goal wire state. The `goal_update` session event and the attach
//! snapshot's `state.goal` field carry this object to every attached
//! surface (TUI, ACP, CLI), so the shared vocabulary lives in pa-types;
//! the goal engine (validation, accounting, continuation prompts) lives in
//! pa-core. Field shape is the TS `GoalState` (camelCase, optional keys
//! omitted).

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
    /// same string the TS `GoalStatus` union uses in status lines.
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
        updated_at: None,
        last_reason: None,
        last_error: None,
    }
}
