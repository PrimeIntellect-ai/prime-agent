//! Agent-engine turn execution (moved with its concern): the turn state
//! machine - the model-turn runner, the turn boundary, the turn loop, the
//! once-runner with its retry/failover and quota-park machinery, the
//! queue-mode mapping, and the session-agent constructor.
use super::{
    aborted_message, drop_trailing_assistant, json, json_round_trip, map_thinking_level,
    retry_event_to_engine_event, AbortController, AgentSessionEngine, AutoCompactionRun,
    BoundaryRun, DaemonAllowlist, EngineEvent, GoalBoundary, Model, OverflowArmRun, ProviderTarget,
    QuotaParkState, StopReason, TurnAdmission, TurnOnce, TurnPrompt, TurnResult, Value,
    QUOTA_WAKE_MAX_RETRIES, QUOTA_WAKE_RETRY_DELAY_MS,
};

// The turn state machine split into its concern children at the same tree
// position (turn::{model,boundary,run_loop,quota,run_once}); the facade
// keeps the imports; the children reach everything through `use super::*`
// (the campaign pattern); the 16 moved members take one visibility bump
// each (8 pub(super)->pub(in crate::agent_engine) for the cross-impl
// callers, 9 private->pub(super) for the cross-child callers).
mod boundary;
mod model;
mod quota;
mod run_loop;
mod run_once;
