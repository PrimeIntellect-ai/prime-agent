//! The versioned event catalog: every product event's name and typed property
//! rules, the successor of the deleted `docs/telemetry-events.md`.
//!
//! The catalog is the low-frequency set: per-run facts ride the one
//! `agent run completed` per run (TS parity), per-session facts ride
//! `agent session ended`, the interactive client's adoption counters ride
//! its one `tui exit`; the remaining events are lifecycle moments
//! (startup, onboarding, installation, update, daemon incidents). Schema
//! version 2 is the #2117 vocabulary (the v2 enrichment on the legacy
//! events and the onboarding/startup/installation stages).
//!
//! [`sanitize`] is the platform adjust layer: before a batch reaches any
//! sink, every catalogued event's properties are normalized against its
//! rule - unknown keys are dropped, out-of-vocabulary enums fall back to
//! the documented fallback, numbers are clamped to their caps, strings
//! are capped. Together with the primitive-only [`Properties`] boundary
//! this pins the privacy contract: no prompt, tool, or provider text can
//! ride a property, and no firing site can invent a property name.

use serde_json::Value;

use crate::properties::Properties;

/// The current schema version stamped on every event. Bumped to 2 when the
/// #2117 tracking vocabulary landed; additive property changes do not bump
/// it.
pub const SCHEMA_VERSION: u64 = 2;

// ---------------------------------------------------------------------------
// Rule kinds
// ---------------------------------------------------------------------------

/// One property's validation rule (the #2117 `TelemetryPropertyRule`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PropKind {
    /// Fixed vocabulary; an out-of-vocabulary value falls back to the
    /// fallback, a null stays null when `nullable` (e.g. `error_category`
    /// is null when the run did not error).
    Enum {
        values: &'static [&'static str],
        fallback: &'static str,
        nullable: bool,
    },
    /// Numeric primitive, clamped to `max` (integers stay integers).
    Number {
        max: u64,
        integer: bool,
        nullable: bool,
    },
    /// Float cost in USD, clamped to `max`.
    Cost { max: f64, nullable: bool },
    /// Boolean primitive (null only when `nullable`).
    Boolean { nullable: bool },
    /// A random uuid string (shape-checked).
    Uuid,
    /// A version string (capped at 64 bytes).
    Version,
    /// A free string capped at `max` bytes.
    BoundedString { max: usize },
    /// The documented nested primitive-map exception (`phase_timings`).
    PrimitiveMap,
}

impl PropKind {
    /// Normalize one value against this kind. `None` drops the property.
    fn normalize(&self, value: Value) -> Option<Value> {
        match self {
            PropKind::Enum {
                values,
                fallback,
                nullable,
            } => match value {
                Value::String(text) => (values.contains(&text.as_str()))
                    .then_some(Value::String(text))
                    .or_else(|| Some(Value::String((*fallback).to_string()))),
                Value::Null if *nullable => Some(Value::Null),
                _ => Some(Value::String((*fallback).to_string())),
            },
            PropKind::Number {
                max,
                integer,
                nullable,
            } => match value {
                Value::Null if *nullable => Some(Value::Null),
                Value::Number(number) => {
                    if let Some(n) = number.as_u64() {
                        Some(Value::from(n.min(*max)))
                    } else if let Some(n) = number.as_i64() {
                        if *integer || n < 0 {
                            // Negative or fractional where an integer is
                            // required: not a valid sample.
                            None
                        } else {
                            Some(Value::from((n as u64).min(*max)))
                        }
                    } else if !*integer {
                        number.as_f64().map(|n| {
                            Value::from(if n.is_finite() && n >= 0.0 {
                                n.min(*max as f64)
                            } else {
                                0.0
                            })
                        })
                    } else {
                        None
                    }
                }
                _ if *nullable => None,
                _ => None,
            },
            PropKind::Cost { max, nullable } => match value {
                Value::Null if *nullable => Some(Value::Null),
                Value::Number(number) => number.as_f64().map(|n| {
                    Value::from(if n.is_finite() && n >= 0.0 {
                        n.min(*max)
                    } else {
                        0.0
                    })
                }),
                _ => None,
            },
            PropKind::Boolean { nullable } => match value {
                Value::Bool(_) => Some(value),
                Value::Null if *nullable => Some(value),
                _ => None,
            },
            PropKind::Uuid => match value {
                Value::String(text) => is_uuid(&text).then_some(Value::String(text)),
                _ => None,
            },
            PropKind::Version => match value {
                Value::String(text) => Some(Value::String(cap_string(&text, 64))),
                _ => None,
            },
            PropKind::BoundedString { max } => match value {
                Value::String(text) => Some(Value::String(cap_string(&text, *max))),
                _ => None,
            },
            PropKind::PrimitiveMap => match value {
                Value::Object(map) => (map.values().all(|value| {
                    matches!(
                        value,
                        Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
                    )
                }))
                .then_some(Value::Object(map)),
                _ => None,
            },
        }
    }
}

/// One event property's rule.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PropertyRule {
    /// The value rule.
    pub kind: PropKind,
    /// True when the event is malformed without this property (the
    /// builder-level contract; sanitize never invents required values).
    pub required: bool,
}

/// One catalogued event: its stable name and every property it may carry.
#[derive(Debug)]
pub struct EventRule {
    /// Stable event name, e.g. `agent started`.
    pub name: &'static str,
    /// Every property the event may carry (base properties are separate).
    pub properties: &'static [(&'static str, PropertyRule)],
    /// The schema version the event entered the catalog at.
    pub since: u64,
}

// ---------------------------------------------------------------------------
// Shared vocabularies (#2117 enums + the v1 doc's fixed value sets)
// ---------------------------------------------------------------------------

/// The legacy error categories (v1 `error_category`).
pub const ERROR_CATEGORIES: &[&str] = &[
    "authentication",
    "rate_limit",
    "timeout",
    "context_limit",
    "network",
    "provider_unavailable",
    "other",
];

/// The #2117 error subtypes.
pub const ERROR_SUBTYPES: &[&str] = &[
    "credential_missing",
    "credential_invalid",
    "credential_expired",
    "authentication_rejected",
    "permission_denied",
    "model_access_denied",
    "insufficient_balance",
    "quota_exceeded",
    "rate_limited",
    "network_error",
    "timeout",
    "provider_unavailable",
    "refusal",
    "malformed_response",
    "stream_drop",
    "context_limit",
    "configuration_error",
    "filesystem_error",
    "session_unavailable",
    "cancelled",
    "unknown",
];

/// The #2117 tool categories.
pub const TOOL_CATEGORIES: &[&str] = &[
    "read", "write", "edit", "bash", "grep", "find", "ls", "ipython", "mcp", "custom", "unknown",
];

/// The #2117 terminal outcomes.
pub const TERMINAL_OUTCOMES: &[&str] = &[
    "success",
    "error",
    "cancelled",
    "shutdown_interrupted",
    "unknown",
];

/// The #2117 run triggers.
pub const RUN_TRIGGERS: &[&str] = &["prompt", "continuation", "unknown"];

/// The legacy run outcomes.
pub const RUN_OUTCOMES: &[&str] = &["success", "error", "aborted"];

/// The #2117 stop reasons.
pub const STOP_REASONS: &[&str] = &["stop", "length", "toolUse", "error", "aborted", "unknown"];

/// The provider categories (v1 `telemetryProviderCategory`).
pub const PROVIDER_CATEGORIES: &[&str] = &[
    "anthropic",
    "openai",
    "google",
    "prime",
    "openrouter",
    "bedrock",
    "vertex",
    "mistral",
    "groq",
    "xai",
    "custom",
    "unknown",
];

/// The model categories (v1 `modelCategory`).
pub const MODEL_CATEGORIES: &[&str] = &[
    "claude", "gpt", "o1", "o3", "o4", "gemini", "glm", "kimi", "qwen", "deepseek", "llama",
    "mistral", "custom", "unknown",
];

/// The auth categories (v1 `telemetryAuthCategory`).
pub const AUTH_CATEGORIES: &[&str] = &[
    "oauth",
    "api_key",
    "mcp_static_token",
    "runtime_api_key",
    "environment",
    "prime_cli",
    "models_json",
    "fallback",
    "stale",
    "stored",
    "none",
    "unknown",
];

/// The #2117 feature names.
pub const FEATURE_NAMES: &[&str] = &[
    "model", "login", "logout", "effort", "goal", "new", "resume", "fork", "clone", "tree",
    "feedback",
];

/// The #2117 feature outcomes.
pub const FEATURE_OUTCOMES: &[&str] = &[
    "initiated",
    "completed",
    "failed",
    "canceled",
    "unavailable",
];

/// The #2117 onboarding stages.
pub const ONBOARDING_STAGES: &[&str] = &[
    "entry",
    "provider_selection",
    "credential_discovery",
    "credential_validation",
    "model_access",
    "ready",
    "exit",
];

/// The #2117 onboarding outcomes.
pub const ONBOARDING_OUTCOMES: &[&str] = &[
    "initiated",
    "completed",
    "failed",
    "canceled",
    "skipped",
    "configured",
    "unavailable",
    "provider_switched",
];

/// The #2117 onboarding entry reasons.
pub const ONBOARDING_ENTRY_REASONS: &[&str] = &[
    "first_setup",
    "existing_configuration",
    "previously_shown",
    "reentered",
];

/// The #2117 acquisition methods.
pub const ACQUISITION_METHODS: &[&str] = &[
    "existing_configuration",
    "prime_browser",
    "prime_key_entry",
    "oauth",
    "api_key_entry",
    "external_credentials",
    "unknown",
];

/// The #2117 validation scopes.
pub const VALIDATION_SCOPES: &[&str] = &[
    "configuration",
    "identity_scope",
    "selected_context",
    "inference",
    "unchecked",
];

/// The #2117 timing scopes.
pub const TIMING_SCOPES: &[&str] = &["system_work", "elapsed_including_user_wait"];

/// The #2117 installation stages.
pub const INSTALLATION_STAGES: &[&str] = &[
    "started",
    "requirements",
    "release_lookup",
    "download",
    "verification",
    "package_install",
    "daemon_restart",
    "session_restore",
    "relaunch",
    "ready",
    "completed",
];

/// The #2117 installation outcomes.
pub const INSTALLATION_OUTCOMES: &[&str] = &[
    "started",
    "success",
    "failed",
    "cancelled",
    "skipped",
    "unavailable",
];

/// The #2117 installation reasons.
pub const INSTALLATION_REASONS: &[&str] = &[
    "up_to_date",
    "unsupported_install",
    "declined",
    "requirements_unavailable",
    "release_lookup_failed",
    "download_failed",
    "verification_failed",
    "install_failed",
    "daemon_restart_failed",
    "session_restore_failed",
    "relaunch_failed",
    "version_mismatch",
    "interrupted",
    "unknown",
];

/// The #2117 installation actions.
pub const INSTALLATION_ACTIONS: &[&str] = &["install", "update"];

/// The #2117 installation sources.
pub const INSTALLATION_SOURCES: &[&str] = &["shell_installer", "cli", "interactive"];

/// The #2117 ready kinds.
pub const READY_KINDS: &[&str] = &["interactive", "headless"];

/// The #2117 input stages.
pub const INPUT_STAGES: &[&str] = &[
    "received",
    "queued",
    "preparation",
    "dispatch",
    "admitted",
    "terminal",
    "submitted",
    "rejected",
    "first_visible_status",
    "cancellation_to_idle",
];

/// The #2117 startup stages.
pub const STARTUP_STAGES: &[&str] = &[
    "ui_ready",
    "session_attach",
    "configuration_load",
    "credential_validation",
    "session_ui_rebind",
];

/// The #2117 startup outcomes.
pub const STARTUP_OUTCOMES: &[&str] = &["completed", "failed"];

/// The #2117 startup kinds.
pub const STARTUP_KINDS: &[&str] = &["cold", "warm_attach", "resumed", "unknown"];

/// The #2117 build channels.
pub const BUILD_CHANNELS: &[&str] = &["release", "prerelease", "development", "unknown"];

/// The #2117 workload origins.
pub const WORKLOAD_ORIGINS: &[&str] = &["interactive", "automated", "internal", "test", "unknown"];

// ---------------------------------------------------------------------------
// Rule constructors
// ---------------------------------------------------------------------------

const fn enum_rule(values: &'static [&'static str], fallback: &'static str) -> PropKind {
    PropKind::Enum {
        values,
        fallback,
        nullable: false,
    }
}

const fn nullable_enum_rule(values: &'static [&'static str], fallback: &'static str) -> PropKind {
    PropKind::Enum {
        values,
        fallback,
        nullable: true,
    }
}

const fn required(kind: PropKind) -> PropertyRule {
    PropertyRule {
        kind,
        required: true,
    }
}

const fn optional(kind: PropKind) -> PropertyRule {
    PropertyRule {
        kind,
        required: false,
    }
}

const fn count() -> PropKind {
    PropKind::Number {
        max: 1_000_000,
        integer: true,
        nullable: false,
    }
}

/// The base properties merged under every event (the platform module
/// stamps them): sanitize validates them against these rules instead of
/// dropping them as uncatalogued.
pub const BASE_PROPERTIES: &[(&str, PropertyRule)] = &[
    ("version", optional(PropKind::Version)),
    (
        "schema_version",
        required(PropKind::Number {
            max: 1_000_000,
            integer: true,
            nullable: false,
        }),
    ),
    (
        "schema_revision",
        optional(PropKind::Number {
            max: 10_000,
            integer: true,
            nullable: false,
        }),
    ),
    (
        "build_channel",
        optional(enum_rule(BUILD_CHANNELS, "unknown")),
    ),
    (
        "workload_origin",
        optional(enum_rule(WORKLOAD_ORIGINS, "unknown")),
    ),
    ("os_family", optional(free_string(32))),
    ("architecture", optional(free_string(32))),
    ("install_method", optional(free_string(32))),
    ("execution_mode", optional(free_string(32))),
    (
        "libc",
        optional(enum_rule(&["glibc", "musl", "none", "unknown"], "unknown")),
    ),
    ("libc_version", optional(free_string(32))),
    (
        "cpu_baseline",
        optional(enum_rule(
            &[
                "avx2",
                "no_avx2",
                "avx2_assumed",
                "not_applicable",
                "unknown",
            ],
            "unknown",
        )),
    ),
    ("os_release", optional(free_string(64))),
    ("os_product_version", optional(free_string(32))),
];

const fn tokens() -> PropKind {
    PropKind::Number {
        max: 1_000_000_000_000,
        integer: true,
        nullable: false,
    }
}

const fn duration() -> PropKind {
    PropKind::Number {
        max: 31_536_000_000,
        integer: true,
        nullable: true,
    }
}

const fn uuid() -> PropKind {
    PropKind::Uuid
}

const fn version() -> PropKind {
    PropKind::Version
}

const fn boolean() -> PropKind {
    PropKind::Boolean { nullable: false }
}

const fn cost() -> PropKind {
    PropKind::Cost {
        max: 1_000_000.0,
        nullable: true,
    }
}

const fn free_string(max: usize) -> PropKind {
    PropKind::BoundedString { max }
}

// ---------------------------------------------------------------------------
// The catalog (schema v2): the #2117 events plus the v1 adoption events.
// Every event the product emits has exactly one row here; the seams are the
// complete emission set (privacy contract).
// ---------------------------------------------------------------------------

/// `agent started` (v1, enriched in v2): session creation, depth-0 only.
const AGENT_STARTED: EventRule = EventRule {
    name: "agent started",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("skill_count", optional(count())),
        ("python_skill_count", optional(count())),
    ],
};

/// `agent run completed` (v1, enriched in v2): run finalize.
const AGENT_RUN_COMPLETED: EventRule = EventRule {
    name: "agent run completed",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("outcome", required(enum_rule(RUN_OUTCOMES, "error"))),
        ("duration_ms", required(duration())),
        ("visible_ttft_ms", optional(duration())),
        ("first_model_event_ms", optional(duration())),
        ("model_latency_ms", optional(duration())),
        ("max_model_latency_ms", optional(duration())),
        ("model_call_count", optional(count())),
        ("turn_count", optional(count())),
        ("tool_call_count", optional(count())),
        ("tool_error_count", optional(count())),
        ("input_tokens", optional(tokens())),
        ("output_tokens", optional(tokens())),
        ("cache_read_tokens", optional(tokens())),
        ("cache_write_tokens", optional(tokens())),
        ("total_tokens", optional(tokens())),
        ("compaction_count", optional(count())),
        ("retry_count", optional(count())),
        ("failover_count", optional(count())),
        (
            "provider_category",
            optional(enum_rule(PROVIDER_CATEGORIES, "custom")),
        ),
        (
            "model_category",
            optional(enum_rule(MODEL_CATEGORIES, "custom")),
        ),
        (
            "error_category",
            optional(nullable_enum_rule(ERROR_CATEGORIES, "other")),
        ),
        // v2 enrichment:
        ("run_id", optional(uuid())),
        ("run_index", optional(count())),
        ("trigger", optional(enum_rule(RUN_TRIGGERS, "unknown"))),
        ("stop_reason", optional(enum_rule(STOP_REASONS, "unknown"))),
        (
            "terminal_outcome",
            optional(enum_rule(TERMINAL_OUTCOMES, "unknown")),
        ),
        ("successful_model_call_count", optional(count())),
        ("usage_complete", optional(boolean())),
        ("estimated_cost_usd", optional(cost())),
        (
            "error_subtype",
            optional(enum_rule(ERROR_SUBTYPES, "unknown")),
        ),
        ("first_reasoning_ms", optional(duration())),
        ("run_to_first_text_ms", optional(duration())),
        ("tool_duration_ms", optional(duration())),
        ("retry_wait_ms", optional(duration())),
        ("compaction_duration_ms", optional(duration())),
        ("max_stream_gap_ms", optional(duration())),
        // The folded per-run aggregates (one event per run):
        ("model_latency_p50_ms", optional(duration())),
        ("model_error_count", optional(count())),
        ("error_authentication_count", optional(count())),
        ("error_rate_limit_count", optional(count())),
        ("error_timeout_count", optional(count())),
        ("error_context_limit_count", optional(count())),
        ("error_network_count", optional(count())),
        ("error_provider_unavailable_count", optional(count())),
        ("error_other_count", optional(count())),
        ("tool_read_call_count", optional(count())),
        ("tool_read_error_count", optional(count())),
        ("tool_read_duration_ms", optional(duration())),
        ("tool_read_max_duration_ms", optional(duration())),
        ("tool_write_call_count", optional(count())),
        ("tool_write_error_count", optional(count())),
        ("tool_write_duration_ms", optional(duration())),
        ("tool_write_max_duration_ms", optional(duration())),
        ("tool_edit_call_count", optional(count())),
        ("tool_edit_error_count", optional(count())),
        ("tool_edit_duration_ms", optional(duration())),
        ("tool_edit_max_duration_ms", optional(duration())),
        ("tool_bash_call_count", optional(count())),
        ("tool_bash_error_count", optional(count())),
        ("tool_bash_duration_ms", optional(duration())),
        ("tool_bash_max_duration_ms", optional(duration())),
        ("tool_grep_call_count", optional(count())),
        ("tool_grep_error_count", optional(count())),
        ("tool_grep_duration_ms", optional(duration())),
        ("tool_grep_max_duration_ms", optional(duration())),
        ("tool_find_call_count", optional(count())),
        ("tool_find_error_count", optional(count())),
        ("tool_find_duration_ms", optional(duration())),
        ("tool_find_max_duration_ms", optional(duration())),
        ("tool_ls_call_count", optional(count())),
        ("tool_ls_error_count", optional(count())),
        ("tool_ls_duration_ms", optional(duration())),
        ("tool_ls_max_duration_ms", optional(duration())),
        ("tool_ipython_call_count", optional(count())),
        ("tool_ipython_error_count", optional(count())),
        ("tool_ipython_duration_ms", optional(duration())),
        ("tool_ipython_max_duration_ms", optional(duration())),
        ("mcp_tool_call_count", optional(count())),
        ("mcp_tool_error_count", optional(count())),
        ("mcp_tool_duration_ms", optional(duration())),
        ("mcp_tool_max_duration_ms", optional(duration())),
        ("custom_tool_call_count", optional(count())),
        ("custom_tool_error_count", optional(count())),
        ("custom_tool_duration_ms", optional(duration())),
        ("custom_tool_max_duration_ms", optional(duration())),
    ],
};

/// `agent session ended` (v1, enriched in v2): session dispose.
const AGENT_SESSION_ENDED: EventRule = EventRule {
    name: "agent session ended",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("duration_ms", required(duration())),
        ("prompt_count", optional(count())),
        ("run_count", optional(count())),
        ("successful_run_count", optional(count())),
        ("failed_run_count", optional(count())),
        ("aborted_run_count", optional(count())),
        ("tool_call_count", optional(count())),
        ("compaction_count", optional(count())),
        ("model_call_count", optional(count())),
        ("input_tokens", optional(tokens())),
        ("output_tokens", optional(tokens())),
        ("cache_read_tokens", optional(tokens())),
        ("cache_write_tokens", optional(tokens())),
        ("total_tokens", optional(tokens())),
        // v2 enrichment:
        (
            "terminal_outcome",
            optional(enum_rule(TERMINAL_OUTCOMES, "unknown")),
        ),
        // The folded per-session counters:
        ("retry_count", optional(count())),
        ("failover_count", optional(count())),
        ("model_error_count", optional(count())),
        ("skill_use_count", optional(count())),
        ("mcp_connector_use_count", optional(count())),
        ("kernel_bootstrap_count", optional(count())),
        ("kernel_bootstrap_cold_count", optional(count())),
        ("kernel_bootstrap_failed_count", optional(count())),
        ("kernel_bootstrap_max_ms", optional(duration())),
        ("rlm_child_usage_count", optional(count())),
        ("rlm_child_input_tokens", optional(tokens())),
        ("rlm_child_output_tokens", optional(tokens())),
        ("rlm_child_cache_read_tokens", optional(tokens())),
        ("rlm_child_cache_write_tokens", optional(tokens())),
        ("rlm_child_cost", optional(cost())),
        ("feature_model_initiated_count", optional(count())),
        ("feature_model_completed_count", optional(count())),
        ("feature_model_failed_count", optional(count())),
        ("feature_model_canceled_count", optional(count())),
        ("feature_model_unavailable_count", optional(count())),
        ("feature_login_initiated_count", optional(count())),
        ("feature_login_completed_count", optional(count())),
        ("feature_login_failed_count", optional(count())),
        ("feature_login_canceled_count", optional(count())),
        ("feature_login_unavailable_count", optional(count())),
        ("feature_logout_initiated_count", optional(count())),
        ("feature_logout_completed_count", optional(count())),
        ("feature_logout_failed_count", optional(count())),
        ("feature_logout_canceled_count", optional(count())),
        ("feature_logout_unavailable_count", optional(count())),
        ("feature_effort_initiated_count", optional(count())),
        ("feature_effort_completed_count", optional(count())),
        ("feature_effort_failed_count", optional(count())),
        ("feature_effort_canceled_count", optional(count())),
        ("feature_effort_unavailable_count", optional(count())),
        ("feature_goal_initiated_count", optional(count())),
        ("feature_goal_completed_count", optional(count())),
        ("feature_goal_failed_count", optional(count())),
        ("feature_goal_canceled_count", optional(count())),
        ("feature_goal_unavailable_count", optional(count())),
        ("feature_new_initiated_count", optional(count())),
        ("feature_new_completed_count", optional(count())),
        ("feature_new_failed_count", optional(count())),
        ("feature_new_canceled_count", optional(count())),
        ("feature_new_unavailable_count", optional(count())),
        ("feature_resume_initiated_count", optional(count())),
        ("feature_resume_completed_count", optional(count())),
        ("feature_resume_failed_count", optional(count())),
        ("feature_resume_canceled_count", optional(count())),
        ("feature_resume_unavailable_count", optional(count())),
        ("feature_fork_initiated_count", optional(count())),
        ("feature_fork_completed_count", optional(count())),
        ("feature_fork_failed_count", optional(count())),
        ("feature_fork_canceled_count", optional(count())),
        ("feature_fork_unavailable_count", optional(count())),
        ("feature_clone_initiated_count", optional(count())),
        ("feature_clone_completed_count", optional(count())),
        ("feature_clone_failed_count", optional(count())),
        ("feature_clone_canceled_count", optional(count())),
        ("feature_clone_unavailable_count", optional(count())),
        ("feature_tree_initiated_count", optional(count())),
        ("feature_tree_completed_count", optional(count())),
        ("feature_tree_failed_count", optional(count())),
        ("feature_tree_canceled_count", optional(count())),
        ("feature_tree_unavailable_count", optional(count())),
        ("feature_feedback_initiated_count", optional(count())),
        ("feature_feedback_completed_count", optional(count())),
        ("feature_feedback_failed_count", optional(count())),
        ("feature_feedback_canceled_count", optional(count())),
        ("feature_feedback_unavailable_count", optional(count())),
    ],
};

/// `agent command used` (v1): builtin command names only, never arguments.
/// The TUI client sends it with the base properties and the command name
/// alone (TS `captureAgentCommandUsed`), so it carries no session id.
const AGENT_COMMAND_USED: EventRule = EventRule {
    name: "agent command used",
    since: 1,
    properties: &[("command_name", required(free_string(64)))],
};

/// `onboarding stage` (v2): the onboarding journey's real stages only.
const ONBOARDING_STAGE: EventRule = EventRule {
    name: "onboarding stage",
    since: 2,
    properties: &[
        ("onboarding_id", required(uuid())),
        ("stage", required(enum_rule(ONBOARDING_STAGES, "unknown"))),
        (
            "outcome",
            required(enum_rule(ONBOARDING_OUTCOMES, "unknown")),
        ),
        ("duration_ms", optional(duration())),
        (
            "auth_category",
            optional(enum_rule(AUTH_CATEGORIES, "none")),
        ),
        (
            "acquisition_method",
            optional(enum_rule(ACQUISITION_METHODS, "unknown")),
        ),
        (
            "validation_scope",
            optional(enum_rule(VALIDATION_SCOPES, "unchecked")),
        ),
        (
            "entry_reason",
            optional(enum_rule(ONBOARDING_ENTRY_REASONS, "unknown")),
        ),
        (
            "timing_scope",
            optional(enum_rule(TIMING_SCOPES, "system_work")),
        ),
    ],
};

/// `onboarding completed` (v1): the onboarding flow's terminal outcome.
const ONBOARDING_COMPLETED: EventRule = EventRule {
    name: "onboarding completed",
    since: 1,
    properties: &[
        ("duration_ms", required(duration())),
        ("outcome", required(enum_rule(RUN_OUTCOMES, "error"))),
        (
            "auth_category",
            required(enum_rule(AUTH_CATEGORIES, "none")),
        ),
        (
            "provider_category",
            optional(enum_rule(PROVIDER_CATEGORIES, "unknown")),
        ),
        // v2 enrichment:
        ("onboarding_id", optional(uuid())),
    ],
};

/// `agent startup stage` (v2): startup-phase timing per stage.
const AGENT_STARTUP_STAGE: EventRule = EventRule {
    name: "agent startup stage",
    since: 2,
    properties: &[
        ("stage", required(enum_rule(STARTUP_STAGES, "unknown"))),
        ("outcome", required(enum_rule(STARTUP_OUTCOMES, "failed"))),
        ("duration_ms", required(duration())),
        (
            "startup_kind",
            optional(enum_rule(STARTUP_KINDS, "unknown")),
        ),
        (
            "timing_scope",
            optional(enum_rule(TIMING_SCOPES, "system_work")),
        ),
    ],
};

/// `agent installation stage` (v2): installer/updater stage outcomes.
const AGENT_INSTALLATION_STAGE: EventRule = EventRule {
    name: "agent installation stage",
    since: 2,
    properties: &[
        ("installation_attempt_id", required(uuid())),
        (
            "installation_action",
            required(enum_rule(INSTALLATION_ACTIONS, "update")),
        ),
        (
            "installation_source",
            required(enum_rule(INSTALLATION_SOURCES, "cli")),
        ),
        ("stage", required(enum_rule(INSTALLATION_STAGES, "unknown"))),
        (
            "outcome",
            required(enum_rule(INSTALLATION_OUTCOMES, "unknown")),
        ),
        (
            "reason",
            optional(enum_rule(INSTALLATION_REASONS, "unknown")),
        ),
        ("from_version", optional(version())),
        ("target_version", optional(version())),
        ("observed_version", optional(version())),
        ("duration_ms", optional(duration())),
        (
            "exit_code",
            optional(PropKind::Number {
                max: 255,
                integer: true,
                nullable: true,
            }),
        ),
        ("error_id", optional(uuid())),
        (
            "ready_kind",
            optional(enum_rule(READY_KINDS, "interactive")),
        ),
        ("session_restore_total", optional(count())),
        ("session_restore_failed", optional(count())),
    ],
};

/// `startup` (v1): process entry to ready interactive session environment.
const STARTUP: EventRule = EventRule {
    name: "startup",
    since: 1,
    properties: &[
        ("duration_ms", required(duration())),
        ("phase_timings", required(PropKind::PrimitiveMap)),
        ("execution_mode", required(free_string(32))),
    ],
};

/// `daemon event` (v1): supervision lifecycle, counts only.
const DAEMON_EVENT: EventRule = EventRule {
    name: "daemon event",
    since: 1,
    properties: &[
        ("kind", required(free_string(64))),
        (
            "exit_reason",
            optional(enum_rule(&["normal", "crash"], "crash")),
        ),
        ("count", optional(count())),
        ("source", optional(free_string(32))),
        ("boot", optional(enum_rule(&["plain", "update"], "plain"))),
        ("adopted_live", optional(count())),
        ("revived", optional(count())),
        ("skipped_idle", optional(count())),
        ("stopped", optional(count())),
        ("failed", optional(count())),
        // The `summary` kind: the frequent supervision events, counted
        // over a window of at most an hour.
        ("window_ms", optional(duration())),
        ("worker_exited_normal_count", optional(count())),
        ("worker_exited_crash_count", optional(count())),
        ("worker_restarted_count", optional(count())),
        ("worker_overloaded_count", optional(count())),
        ("attach_count", optional(count())),
        ("reattach_count", optional(count())),
        ("detach_count", optional(count())),
        ("registration_refused_count", optional(count())),
        ("session_rebound_count", optional(count())),
        ("root_identity_persist_failed_count", optional(count())),
        ("saved_sessions_list_count", optional(count())),
        ("saved_sessions_usage_rows_max", optional(count())),
    ],
};

/// `model refused` (v1): the settings allowlist guardrail.
const MODEL_REFUSED: EventRule = EventRule {
    name: "model refused",
    since: 1,
    properties: &[
        (
            "surface",
            required(enum_rule(
                &[
                    "set_model",
                    "cycle_model",
                    "spawn",
                    "create_session",
                    "session_start",
                ],
                "session_start",
            )),
        ),
        (
            "provider_category",
            optional(enum_rule(PROVIDER_CATEGORIES, "custom")),
        ),
        (
            "model_category",
            optional(enum_rule(MODEL_CATEGORIES, "custom")),
        ),
    ],
};

/// `session archived` (v1): the daemon `kill` path.
const SESSION_ARCHIVED: EventRule = EventRule {
    name: "session archived",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("duration_ms", required(duration())),
    ],
};

/// A settled ipython cell that rendered as bash (v2): its executed
/// `bash()` line share and command count, never command text. One of the
/// two standalone TUI events (with `agent command used`), tracked per
/// render by the upstream #3307 addition and kept intact.
const TUI_IPYTHON_BASH_RENDERED: EventRule = EventRule {
    name: "tui ipython bash rendered",
    since: 2,
    properties: &[
        ("bash_lines", required(count())),
        ("cell_lines", required(count())),
        ("count", required(count())),
    ],
};

/// `tui exit` (v1, enriched): one per interactive session run (each agents
/// view handoff ends one), carrying that run's adoption counters (the TUI
/// interactions, the client-side feature outcomes, the input-stage counts
/// and maxima) instead of one event per interaction.
const TUI_EXIT: EventRule = EventRule {
    name: "tui exit",
    since: 1,
    properties: &[
        (
            "exit_reason",
            required(enum_rule(
                &["ctrl_c_twice", "ctrl_d", "session_request", "daemon_closed"],
                "daemon_closed",
            )),
        ),
        ("turn_active", required(boolean())),
        ("tui_scroll_count", optional(count())),
        ("tui_selection_count", optional(count())),
        ("tui_click_count", optional(count())),
        ("tui_menu_open_count", optional(count())),
        ("tui_activity_open_count", optional(count())),
        ("tui_subagents_open_count", optional(count())),
        ("tui_scoped_agent_count", optional(count())),
        ("tui_image_paste_count", optional(count())),
        ("tui_input_queued_count", optional(count())),
        ("tui_queue_edit_count", optional(count())),
        ("tui_prompt_stash_count", optional(count())),
        ("tui_bash_shortcut_count", optional(count())),
        ("tui_bash_bang_count", optional(count())),
        ("tui_external_editor_count", optional(count())),
        ("tui_scoped_models_count", optional(count())),
        ("tui_suspend_count", optional(count())),
        ("tui_agents_action_count", optional(count())),
        ("tui_enhanced_keys_kitty", optional(boolean())),
        ("tui_enhanced_keys_modify_other_keys", optional(boolean())),
        ("tui_hyperlinks_enabled", optional(boolean())),
        ("feature_model_initiated_count", optional(count())),
        ("feature_model_completed_count", optional(count())),
        ("feature_model_failed_count", optional(count())),
        ("feature_model_canceled_count", optional(count())),
        ("feature_model_unavailable_count", optional(count())),
        ("feature_login_initiated_count", optional(count())),
        ("feature_login_completed_count", optional(count())),
        ("feature_login_failed_count", optional(count())),
        ("feature_login_canceled_count", optional(count())),
        ("feature_login_unavailable_count", optional(count())),
        ("feature_logout_initiated_count", optional(count())),
        ("feature_logout_completed_count", optional(count())),
        ("feature_logout_failed_count", optional(count())),
        ("feature_logout_canceled_count", optional(count())),
        ("feature_logout_unavailable_count", optional(count())),
        ("feature_effort_initiated_count", optional(count())),
        ("feature_effort_completed_count", optional(count())),
        ("feature_effort_failed_count", optional(count())),
        ("feature_effort_canceled_count", optional(count())),
        ("feature_effort_unavailable_count", optional(count())),
        ("feature_goal_initiated_count", optional(count())),
        ("feature_goal_completed_count", optional(count())),
        ("feature_goal_failed_count", optional(count())),
        ("feature_goal_canceled_count", optional(count())),
        ("feature_goal_unavailable_count", optional(count())),
        ("feature_new_initiated_count", optional(count())),
        ("feature_new_completed_count", optional(count())),
        ("feature_new_failed_count", optional(count())),
        ("feature_new_canceled_count", optional(count())),
        ("feature_new_unavailable_count", optional(count())),
        ("feature_resume_initiated_count", optional(count())),
        ("feature_resume_completed_count", optional(count())),
        ("feature_resume_failed_count", optional(count())),
        ("feature_resume_canceled_count", optional(count())),
        ("feature_resume_unavailable_count", optional(count())),
        ("feature_fork_initiated_count", optional(count())),
        ("feature_fork_completed_count", optional(count())),
        ("feature_fork_failed_count", optional(count())),
        ("feature_fork_canceled_count", optional(count())),
        ("feature_fork_unavailable_count", optional(count())),
        ("feature_clone_initiated_count", optional(count())),
        ("feature_clone_completed_count", optional(count())),
        ("feature_clone_failed_count", optional(count())),
        ("feature_clone_canceled_count", optional(count())),
        ("feature_clone_unavailable_count", optional(count())),
        ("feature_tree_initiated_count", optional(count())),
        ("feature_tree_completed_count", optional(count())),
        ("feature_tree_failed_count", optional(count())),
        ("feature_tree_canceled_count", optional(count())),
        ("feature_tree_unavailable_count", optional(count())),
        ("feature_feedback_initiated_count", optional(count())),
        ("feature_feedback_completed_count", optional(count())),
        ("feature_feedback_failed_count", optional(count())),
        ("feature_feedback_canceled_count", optional(count())),
        ("feature_feedback_unavailable_count", optional(count())),
        ("input_received_count", optional(count())),
        ("input_queued_count", optional(count())),
        ("input_preparation_count", optional(count())),
        ("input_dispatch_count", optional(count())),
        ("input_admitted_count", optional(count())),
        ("input_terminal_count", optional(count())),
        ("input_submitted_count", optional(count())),
        ("input_rejected_count", optional(count())),
        ("input_first_visible_status_count", optional(count())),
        ("input_cancellation_to_idle_count", optional(count())),
        ("input_received_max_ms", optional(duration())),
        ("input_queued_max_ms", optional(duration())),
        ("input_preparation_max_ms", optional(duration())),
        ("input_dispatch_max_ms", optional(duration())),
        ("input_admitted_max_ms", optional(duration())),
        ("input_terminal_max_ms", optional(duration())),
        ("input_submitted_max_ms", optional(duration())),
        ("input_rejected_max_ms", optional(duration())),
        ("input_first_visible_status_max_ms", optional(duration())),
        ("input_cancellation_to_idle_max_ms", optional(duration())),
    ],
};

/// The update-flow events (v1): `update completed` plus the per-phase
/// events (one per status transition, the same names the `phase` property
/// carries).
const UPDATE_EVENTS: &[EventRule] = &[
    EventRule {
        name: "update completed",
        since: 1,
        properties: &[
            (
                "outcome",
                required(enum_rule(
                    &["complete", "skipped", "aborted", "failed"],
                    "failed",
                )),
            ),
            ("sessions_total", required(count())),
            ("sessions_restored", required(count())),
            ("sessions_failed", required(count())),
        ],
    },
    EventRule {
        name: "update_download_started",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
            ("sessions_total", optional(count())),
            ("sessions_restored", optional(count())),
            ("sessions_failed", optional(count())),
        ],
    },
    EventRule {
        name: "update_staged",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_prepare_started",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_prepared",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_stopping",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_restarting",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_restoring",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_complete",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
            ("sessions_total", optional(count())),
            ("sessions_restored", optional(count())),
            ("sessions_failed", optional(count())),
        ],
    },
    EventRule {
        name: "update_rollback",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
            ("sessions_total", optional(count())),
            ("sessions_restored", optional(count())),
            ("sessions_failed", optional(count())),
        ],
    },
    EventRule {
        name: "update_aborted",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
    EventRule {
        name: "update_failed",
        since: 1,
        properties: &[
            ("phase", required(free_string(64))),
            ("duration_ms", required(duration())),
        ],
    },
];

/// Every catalogued event, flattened.
#[must_use]
pub fn catalog() -> Vec<&'static EventRule> {
    let mut all: Vec<&'static EventRule> = vec![
        &AGENT_STARTED,
        &AGENT_RUN_COMPLETED,
        &AGENT_SESSION_ENDED,
        &AGENT_COMMAND_USED,
        &ONBOARDING_STAGE,
        &ONBOARDING_COMPLETED,
        &AGENT_STARTUP_STAGE,
        &AGENT_INSTALLATION_STAGE,
        &STARTUP,
        &DAEMON_EVENT,
        &MODEL_REFUSED,
        &SESSION_ARCHIVED,
        &TUI_EXIT,
        &TUI_IPYTHON_BASH_RENDERED,
    ];
    all.extend(UPDATE_EVENTS.iter());
    all
}

/// The `feature_<name>_<outcome>_count` counter key for a feature outcome
/// in the fixed vocabulary (`None` outside it).
#[must_use]
pub fn feature_outcome_key(feature_name: &str, outcome: &str) -> Option<String> {
    (FEATURE_NAMES.contains(&feature_name) && FEATURE_OUTCOMES.contains(&outcome))
        .then(|| format!("feature_{feature_name}_{outcome}_count"))
}

/// The `input_<stage>_*` key prefix for an input stage in the fixed
/// vocabulary (`None` outside it).
#[must_use]
pub fn input_stage_key(stage: &str) -> Option<String> {
    INPUT_STAGES
        .contains(&stage)
        .then(|| format!("input_{stage}"))
}

/// Look up one event's rule.
#[must_use]
pub fn lookup(name: &str) -> Option<&'static EventRule> {
    catalog().into_iter().find(|rule| rule.name == name)
}

/// Normalize one event's properties against its catalog rule: unknown
/// keys are dropped, out-of-vocabulary enums fall back, numbers clamp to
/// their caps, strings cap at their byte budget. Events outside the
/// catalog pass through unchanged (forward compatibility).
///
/// Returns the number of properties adjusted or dropped (tests + the
/// worker's debug log).
pub fn sanitize(name: &str, properties: &mut Properties) -> usize {
    let Some(rule) = lookup(name) else {
        // Not catalogued: an existing or future vocabulary entry; the
        // primitive-only boundary still applies.
        return 0;
    };
    let mut adjusted = 0usize;
    let mut normalized = Properties::new();
    for (key, value) in properties.iter() {
        // The base properties ride every event; they validate against
        // their own rules, never the event's table.
        if let Some((_, base_rule)) = BASE_PROPERTIES.iter().find(|(known, _)| known == key) {
            if let Some(value) = base_rule.kind.normalize(value.clone()) {
                normalized.insert_validated(key, value);
            } else {
                adjusted += 1;
            }
            continue;
        }
        let Some((_, property_rule)) = rule.properties.iter().find(|(known, _)| known == key)
        else {
            // Unknown property: the privacy contract keeps the catalog
            // the complete property set.
            tracing::debug!(event = name, key, "dropped uncatalogued telemetry property");
            adjusted += 1;
            continue;
        };
        if let Some(value) = property_rule.kind.normalize(value.clone()) {
            if &value != value_ref(properties, key) {
                adjusted += 1;
            }
            // Already validated against the rule; the primitive-map
            // exception inserts through the internal path (the public
            // `set` boundary stays primitive-only).
            normalized.insert_validated(key, value);
        } else {
            tracing::debug!(event = name, key, "dropped invalid telemetry property");
            adjusted += 1;
        }
    }
    for (key, property_rule) in rule.properties {
        if property_rule.required && normalized.get(key).is_none() {
            tracing::debug!(event = name, key, "missing required telemetry property");
        }
    }
    *properties = normalized;
    adjusted
}

/// Read back one property (sanitize bookkeeping).
fn value_ref<'a>(properties: &'a Properties, key: &str) -> &'a Value {
    properties.get(key).unwrap_or(&Value::Null)
}

/// True for a hex uuid in the canonical dashed shape (the install-id
/// validation vocabulary).
pub(crate) fn is_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    let dashes = [8, 13, 18, 23];
    dashes.iter().all(|&p| bytes[p] == b'-')
        && (0..36)
            .filter(|&i| !dashes.contains(&i))
            .all(|i| bytes[i].is_ascii_hexdigit())
}

/// Cap a string at `max` bytes on a char boundary.
fn cap_string(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_catalog_is_the_low_frequency_set() {
        assert_eq!(SCHEMA_VERSION, 2);
        let names: Vec<&str> = catalog().iter().map(|rule| rule.name).collect();
        for name in [
            "agent started",
            "agent run completed",
            "agent session ended",
            "agent command used",
            "onboarding completed",
            "onboarding stage",
            "agent startup stage",
            "agent installation stage",
            "session archived",
            "startup",
            "daemon event",
            "model refused",
            "update completed",
            "tui exit",
        ] {
            assert!(names.contains(&name), "{name} stays catalogued");
        }
        // The per-occurrence events folded into run/session/client counters.
        for name in [
            "agent run started",
            "agent error",
            "agent timing",
            "agent tool summary",
            "agent feature outcome",
            "agent input stage",
            "tool executed",
            "skill used",
            "mcp connector used",
            "rlm child usage attributed",
            "kernel bootstrap",
            "tui scroll used",
        ] {
            assert!(!names.contains(&name), "{name} is folded, not an event");
        }
    }

    /// Every property key matches the platform backend's key pattern
    /// (`^[a-zA-Z][a-zA-Z0-9_]*$`, at most 64 chars; a bad key drops the
    /// whole event there) and every event stays under its 128-key cap.
    #[test]
    fn every_key_passes_the_backend_pattern() {
        for rule in catalog() {
            assert!(
                rule.properties.len() + BASE_PROPERTIES.len() <= 128,
                "{} exceeds the backend's 128 keys",
                rule.name
            );
            for (key, _) in rule.properties.iter().chain(BASE_PROPERTIES.iter()) {
                let mut chars = key.chars();
                assert!(
                    key.len() <= 64
                        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_'),
                    "{}: {key}",
                    rule.name
                );
            }
            assert!(
                rule.name
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c == ' ' || c == '_'),
                "{}",
                rule.name
            );
        }
    }

    #[test]
    fn counter_keys_cover_the_fixed_vocabularies() {
        assert_eq!(
            feature_outcome_key("goal", "completed").as_deref(),
            Some("feature_goal_completed_count")
        );
        assert_eq!(feature_outcome_key("goal", "exploded"), None);
        assert_eq!(input_stage_key("queued").as_deref(), Some("input_queued"));
        assert_eq!(input_stage_key("nope"), None);
        let ended = lookup("agent session ended").unwrap();
        let exit = lookup("tui exit").unwrap();
        for name in FEATURE_NAMES {
            for outcome in FEATURE_OUTCOMES {
                let key = feature_outcome_key(name, outcome).unwrap();
                assert!(ended.properties.iter().any(|(known, _)| *known == key));
                assert!(exit.properties.iter().any(|(known, _)| *known == key));
            }
        }
        for stage in INPUT_STAGES {
            let prefix = input_stage_key(stage).unwrap();
            for suffix in ["count", "max_ms"] {
                let key = format!("{prefix}_{suffix}");
                assert!(exit.properties.iter().any(|(known, _)| *known == key));
            }
        }
    }

    #[test]
    fn sanitize_drops_unknown_keys_and_falls_back_enums() {
        let mut properties = Properties::new();
        properties.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        properties.set("outcome", json!("success"));
        properties.set("duration_ms", json!(5));
        properties.set("trigger", json!("spontaneous")); // out of vocabulary
        properties.set("tool_bash_call_count", json!(3u64));
        properties.set("tool_name", json!("private_tool")); // not a catalogued property
        let adjusted = sanitize("agent run completed", &mut properties);
        assert_eq!(properties.get("trigger"), Some(&json!("unknown")));
        assert_eq!(properties.get("tool_bash_call_count"), Some(&json!(3u64)));
        assert!(properties.get("tool_name").is_none(), "unknown key dropped");
        assert_eq!(adjusted, 2, "one fallback + one dropped key");
    }

    #[test]
    fn sanitize_clamps_numbers_and_caps_strings() {
        let mut properties = Properties::new();
        properties.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        properties.set("outcome", json!("success"));
        properties.set("duration_ms", json!(5));
        properties.set("turn_count", json!(u64::MAX)); // over the count cap
        properties.set("retry_count", json!(3.5)); // fractional where integer
        let _ = sanitize("agent run completed", &mut properties);
        assert_eq!(properties.get("turn_count"), Some(&json!(1_000_000u64)));
        assert!(properties.get("retry_count").is_none(), "fraction dropped");
    }

    #[test]
    fn sanitize_keeps_null_only_where_nullable() {
        let mut properties = Properties::new();
        properties.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        properties.set("outcome", json!("error"));
        properties.set("duration_ms", json!(120));
        properties.set("error_category", Value::Null); // nullable
        properties.set("compaction_count", Value::Null); // NOT nullable
        let _ = sanitize("agent run completed", &mut properties);
        assert_eq!(properties.get("error_category"), Some(&Value::Null));
        assert!(properties.get("compaction_count").is_none());
    }

    #[test]
    fn sanitize_passes_uncatalogued_events_through() {
        let mut properties = Properties::new();
        properties.set("anything", json!("kept"));
        assert_eq!(sanitize("a future event", &mut properties), 0);
        assert_eq!(properties.get("anything"), Some(&json!("kept")));
    }

    #[test]
    fn uuid_shape_and_string_caps() {
        assert!(is_uuid("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        assert!(!is_uuid("not-a-uuid"));
        assert!(!is_uuid("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1"));
        assert_eq!(cap_string("abcdef", 3), "abc");
        let capped = cap_string("private tool text", 7);
        assert_eq!(capped, "private");
    }

    #[test]
    fn primitive_map_allows_only_primitives() {
        let mut timings = Properties::new();
        timings.set("daemon_ready", json!(120));
        let mut nested = Properties::new();
        nested.set_map("phase_timings", &timings);
        let mut properties = Properties::new();
        properties.set("duration_ms", json!(200));
        properties.merge(&nested);
        properties.set("execution_mode", json!("interactive"));
        let _ = sanitize("startup", &mut properties);
        assert!(properties.get("phase_timings").is_some());
    }
}
