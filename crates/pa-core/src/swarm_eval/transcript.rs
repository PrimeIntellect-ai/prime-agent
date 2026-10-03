//! Harness-side snapshot builder over the session transcript.
//!
//! The TS harness reads `session.messagingStats()` - the session-level
//! counters of the messaging-instrumentation lane (#2352). This port derives
//! the same [`MessagingStatsSnapshot`](super::MessagingStatsSnapshot) shape
//! from the transcript the daemon already serves (`get_messages` rows plus
//! the `get_session_stats` context token estimate), so the harness can score
//! trials before that producer lands.
//!
//! Derived counters, matching the #2352 definitions where the transcript
//! carries the evidence:
//!
//! - `arrivals`: accepted agent-message rows (`role: "custom"`,
//!   `customType: "agent_message"`).
//! - `model_steps`: completed assistant steps (a usage recorded, no
//!   `aborted`/`error` stop) and their usage tokens.
//! - `ingestion_steps`: the same steps when the turn's primary input was an
//!   agent message (the trigger is sticky across a turn's tool results and
//!   resets on the next plain user message).
//! - `context`: the chars/4 estimate over the agent-message rows over the
//!   working-context tokens.
//!
//! The 5-minute rolling windows and the outbound `sends` counts are live
//! counters with no transcript evidence; they mirror the run totals
//! (`last5m = total`) and stay zero (`sends`) respectively, and are unused by
//! the defense lines.

use serde_json::Value;

use pa_types::usage::{calculate_context_tokens, estimate_tokens, valid_assistant_usage};

use crate::session_engine::agent_messaging::AGENT_MESSAGE_CUSTOM_TYPE;

use super::{ArrivalCounts, ContextShape, MessagingStatsSnapshot, SendCounts, StepCounts};

/// Build a messaging snapshot from the session transcript and the working
/// context token estimate.
#[must_use]
pub fn snapshot_from_transcript(
    messages: &[Value],
    context_tokens: Option<u64>,
) -> MessagingStatsSnapshot {
    let mut arrivals = 0u64;
    let mut estimated_agent_message_tokens = 0u64;
    let mut model_steps = 0u64;
    let mut model_tokens = 0u64;
    let mut ingestion_steps = 0u64;
    let mut ingestion_tokens = 0u64;
    // The turn's primary input: sticky across tool results, reset by the
    // next plain user message.
    let mut trigger_is_agent = false;
    for message in messages {
        match message.get("role").and_then(Value::as_str) {
            Some("custom") if is_agent_message(message) => {
                arrivals += 1;
                estimated_agent_message_tokens += estimate_tokens(message);
                trigger_is_agent = true;
            }
            Some("user") => trigger_is_agent = false,
            Some("assistant") => {
                if let Some(usage) = valid_assistant_usage(message) {
                    let tokens = calculate_context_tokens(&usage);
                    model_steps += 1;
                    model_tokens += tokens;
                    if trigger_is_agent {
                        ingestion_steps += 1;
                        ingestion_tokens += tokens;
                    }
                }
            }
            _ => {}
        }
    }
    let share = context_tokens
        .filter(|tokens| *tokens > 0)
        .map(|tokens| estimated_agent_message_tokens as f64 / tokens as f64);
    MessagingStatsSnapshot {
        arrivals: ArrivalCounts {
            total: arrivals,
            last5m: arrivals,
        },
        model_steps: StepCounts {
            total: model_steps,
            last5m: model_steps,
            tokens: model_tokens,
        },
        ingestion_steps: StepCounts {
            total: ingestion_steps,
            last5m: ingestion_steps,
            tokens: ingestion_tokens,
        },
        context: ContextShape {
            estimated_agent_message_tokens,
            context_tokens,
            share,
        },
        sends: SendCounts::default(),
    }
}

fn is_agent_message(message: &Value) -> bool {
    message.get("customType").and_then(Value::as_str) == Some(AGENT_MESSAGE_CUSTOM_TYPE)
}
