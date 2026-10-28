//! All modules are `pub(crate)` internals of the tools subsystem; the
//! crate facade (crate root) re-exports only the public tool surface.

pub(crate) mod golden_replay;
pub(crate) mod ipython;
#[allow(dead_code)] // util module; every fn exercised by unit tests
pub(crate) mod path_utils;
pub(crate) mod render_utils;
pub(crate) mod tool_definition;
