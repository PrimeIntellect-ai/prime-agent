//! The A2A v1.0.0 server mode (`--mode a2a`): Prime Agent reachable as
//! an `Agent2Agent` agent over the protocol's JSON-RPC binding — the
//! Agent Card at `/.well-known/agent-card.json`, `SendMessage` /
//! `SendStreamingMessage` / `GetTask` / `ListTasks` / `CancelTask` /
//! `SubscribeToTask` on one HTTP listener, streaming over SSE.
//!
//! The mode is a thin client of the daemon, structurally the sibling
//! of the ACP mode (`crate::acp`): it connects to the supervisor
//! socket, hosts one daemon session per A2A conversation `contextId`,
//! maps every protocol task onto one prompt turn (`PromptAndWait` with
//! a task-scoped admission id, so `CancelTask` rides the daemon's
//! admission cancel), and translates the daemon's ordered session
//! events into the protocol's task lifecycle and SSE streams.
//!
//! v1's honest surface (the card declares it): streaming yes, push
//! notifications no, extended agent card no, text parts in, markdown
//! artifacts out. The reference protocol surface:
//! <https://a2a-protocol.org/latest/specification/>.

mod card;
mod events;
mod http;
mod jsonrpc;
mod server;
mod task;
mod types;

pub use server::{run_daemon_attached_a2a_mode, A2aOptions};
