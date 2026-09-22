//! Code-preview extraction for tool-call cards (`ipython` collapsed line).
//!
//! Faithful port of `packages/coding-agent/src/core/tools/code-preview.ts`,
//! `code-preview-python` and `ipython-cell-code.ts`. The pa-tui dependency
//! boundary (pa-types only) keeps the session engine out of the UI, so the
//! display-side preview algorithm lives here; pa-core holds the same
//! algorithm for its golden-replay corpus. Consolidating the two copies into
//! pa-types as pure data helpers is a tracked follow-up.

pub(crate) mod bash;
mod cell;

pub use cell::parse_ipython_bash_cell;
mod python;

pub use bash::{preview_bash_command, CodePreview, CodePreviewLanguage};
pub use python::{preview_ipython_code, python_statement_lines};
