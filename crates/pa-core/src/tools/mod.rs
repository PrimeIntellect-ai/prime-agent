//! All modules are `pub(crate)` internals of the tools subsystem; the
//! crate facade (crate root) re-exports only the public tool surface.

pub(crate) mod bash;
pub(crate) mod bash_guard;
pub(crate) mod bash_local;
// Rendering preview helpers: unused by the engine's headless core
// (pa-tui owns terminal rendering); lives here for parity tests.
#[allow(dead_code)]
pub(crate) mod code_preview;
pub(crate) mod code_preview_python;
pub(crate) mod edit;
pub(crate) mod edit_diff;
pub(crate) mod file_mutation_queue;
pub(crate) mod golden_replay;
pub(crate) mod ipython;
pub(crate) mod ipython_cell_code;
pub(crate) mod jsdiff;
pub(crate) mod output_accumulator;
#[allow(dead_code)] // util module; every fn exercised by unit + golden tests
pub(crate) mod path_utils;
#[allow(dead_code)] // render helpers; consumed by the TUI-side renderer (parity-ported here)
pub(crate) mod render_utils;
pub(crate) mod rlm_bootstrap;
#[allow(dead_code)] // util module; fully exercised by unit + golden tests
pub(crate) mod shell_utils;
pub(crate) mod tool_definition;
#[allow(dead_code)] // util module; fully exercised by unit + golden tests
pub(crate) mod truncate;
