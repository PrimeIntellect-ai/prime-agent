//! Agent loop for Prime Agent.
//!
//! Rust port of the TypeScript `packages/agent` package (agent-loop.ts, agent.ts,
//! types.ts, proxy.ts). The loop works with [`types::AgentMessage`] throughout and
//! converts to LLM-bound [`types::Message`] values only at the model call boundary,
//! exactly like the TS reference.
//!
//! Semantics preserved from the TS implementation:
//! - Turn structure and event order (`agent_start`, `turn_start`, message events,
//!   tool execution events, `turn_end`, `agent_end`).
//! - Tool-call dispatch: parallel by default with sequential override per config or
//!   per tool (`execution_mode`); parallel mode emits `tool_execution_end` in
//!   completion order while tool-result messages are emitted in assistant source order.
//! - Partial stream handling: `start`/delta events update the last context message
//!   and emit `message_update`; the terminal `done`/`error` event plus the stream's
//!   `result()` decide the final assistant message.
//! - Error propagation: provider failures arrive as terminal `error` events (or
//!   `StreamFn` errors); the run ends with an `error`/`aborted` assistant message.
//! - Abort/interrupt: every await point is raced with the [`abort::AbortSignal`];
//!   aborts during a stream finalize a synthetic `aborted` assistant message,
//!   aborts during tool execution produce error tool results, and the loop always
//!   emits `agent_end` on the abort paths.
//! - Steering/follow-up/continuation message injection with the same polling
//!   order and stop-hook semantics (`should_stop_after_turn`, `should_stop_before_turn`).
//!   Max-turn limits are host-owned through those hooks, matching the TS product.
//!
//! Model-facing streaming is behind the minimal local [`stream::ModelStream`] trait
//! and [`stream::StreamFn`]. This is intentionally narrow and documented for later
//! unification with the `pa-ai` provider layer; `scripted::ScriptedProvider` is the
//! faux scripted provider used by tests and early integrations.

pub mod abort;
pub mod agent;
pub mod agent_loop;
pub mod proxy;
pub mod scripted;
pub mod stream;
pub mod types;
pub mod validation;

use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};

/// Boxed, sendable future used across the crate's hook and stream traits.
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Unix timestamp in milliseconds, mirroring `Date.now()` in the TS reference.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
