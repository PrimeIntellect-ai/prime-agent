//! System-prompt assembly: a **cached static prefix** of the human-editable
//! layer files ([`layers`]) that never varies per session (providers can
//! cache it), then a **dynamic tail** with everything session-specific, in
//! that order.

pub mod layers;

pub mod system_prompt;

pub use system_prompt::{
    build_system_prompt, system_prompt_breakdown, BuildSystemPromptOptions, PromptSegment,
    SegmentKind, SystemPromptBreakdown, REFINE_SKILL_NAME,
};
