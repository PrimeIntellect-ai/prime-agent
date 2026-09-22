//! System-prompt assembly for the RLM harness. The prompt is layered:
//!
//! - the **cached static prefix** is the composition of the human-editable
//!   layer files ([`layers`]): core harness description, mandatory usage,
//!   opinionated guidelines, and the per-model map. It never varies per
//!   session, so providers can cache it.
//! - the **dynamic tail** carries everything session-specific (packages,
//!   project context, skills inventory, MCP servers, environment, role) and
//!   is appended after the static prefix, in that order.
//!
//! `system_prompt_breakdown` exposes the per-layer segments so the CLI can
//! dump exactly what the model sees; the cache-safety and tool-surface guard
//! tests pin the boundary and the documented API surface.

pub mod layers;

pub mod system_prompt;

pub use system_prompt::{
    build_system_prompt, system_prompt_breakdown, BuildSystemPromptOptions, PromptSegment,
    SegmentKind, SystemPromptBreakdown, REFINE_SKILL_NAME,
};
