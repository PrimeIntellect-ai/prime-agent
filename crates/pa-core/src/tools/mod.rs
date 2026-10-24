//! All modules are `pub(crate)` internals of the tools subsystem; the
//! crate facade (crate root) re-exports only the public tool surface.

#[cfg(test)]
pub(crate) mod auto_background_loop_tests;
pub(crate) mod bash;
pub(crate) mod bash_guard;
pub(crate) mod bash_local;
pub(crate) mod edit;
pub(crate) mod edit_diff;
pub(crate) mod file_mutation_queue;
pub(crate) mod golden_replay;
pub(crate) mod ipython;
pub(crate) mod jsdiff;
pub(crate) mod output_accumulator;
#[allow(dead_code)] // util module; every fn exercised by unit + golden tests
pub(crate) mod path_utils;
pub(crate) mod render_utils;
#[allow(dead_code)] // util module; fully exercised by unit + golden tests
pub(crate) mod shell_utils;
pub(crate) mod tool_definition;
pub(crate) mod truncate;
