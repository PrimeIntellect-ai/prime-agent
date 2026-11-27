//! `--mode a2a`: Prime Agent as an A2A 1.0 agent over the JSON-RPC
//! binding, served from a daemon client process (the sibling of the ACP
//! mode). See `server.rs` for the session mapping and `http.rs` for the
//! HTTP surface and its gates.

mod http;
mod jsonrpc;
mod server;
mod tasks;
mod types;

pub use server::{run_daemon_attached_a2a_mode, A2aOptions};
