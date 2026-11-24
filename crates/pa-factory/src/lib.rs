//! The factory machine directory format.
//!
//! A machine is a directory: `machine.toml` for the graph, Markdown prompts,
//! TOML rubrics, and Python files for deterministic states. This crate
//! loads one ([`load_machine_dir`]), checks every rule before anything runs,
//! compiles it to the canonical spec the executor runs ([`compile`]), and
//! converts a stored v1 spec into a directory ([`convert_spec`]). It also
//! owns the machine library ([`scan_library`]) and the factory's numeric
//! limits ([`limits`]).
//! It reads files and nothing else: no sessions, no spawning, no network.

mod compile;
mod convert;
mod duration;
mod graph;
mod library;
pub mod limits;
mod load;
mod machine;
pub mod types;

pub use compile::compile;
pub use convert::{convert_spec, DirFile, MachineMeta};
pub use duration::parse_duration_ms;
pub use library::{
    machine_name_errors, parse_machine_md, read_machine_md, scan_library, Level, Library,
    LibraryMachine, MachineKind, MachineMd, MACHINE_MD_FILE,
};
pub use load::{load_machine_dir, CONTEXT_FILE, MACHINE_FILE};
pub use machine::{
    Agent, Diagnostic, FailurePolicy, Foreach, Input, Machine, Output, Param, PythonCall, Route,
    Rubric, RubricRule, RunSettings, State, Work, FORMAT_VERSION,
};
