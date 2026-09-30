//! The versioned event catalog: every product event's name and typed property
//! rules, the successor of the deleted `docs/telemetry-events.md`.
//!
//! Schema version 2 adds the tracking vocabulary of the (never-merged) TS
//! PR #2117: `agent run started`, `agent error`, `agent timing`,
//! `agent tool summary`, `onboarding stage`, `agent feature outcome`,
//! `agent startup stage`, `agent input stage`, and
//! `agent installation stage`, each a catalog entry with typed property
//! rules, plus enrichment on the legacy session events. The v1 adoption
//! events stay catalogued (schema rules: additive changes do not bump the
//! schema version; the new-event vocabulary does).
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

/// The property-rule revision of the error-message policy (the reviewed
/// fixed-string set). #2117 `error_message_policy_revision`.
pub const ERROR_MESSAGE_POLICY_REVISION: u64 = 1;

/// The error-classifier revision (`classifier_revision` on `agent error`).
pub const ERROR_CLASSIFIER_REVISION: u64 = 1;

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
    "context_limit",
    "configuration_error",
    "filesystem_error",
    "session_unavailable",
    "cancelled",
    "unknown",
];

/// The #2117 error codes (provider codes, OS error codes, daemon codes).
pub const ERROR_CODES: &[&str] = &[
    "invalid_api_key",
    "invalid_token",
    "invalid_grant",
    "token_expired",
    "expired_token",
    "missing_api_key",
    "authentication_error",
    "unauthorized",
    "permission_error",
    "permission_denied",
    "access_denied",
    "forbidden",
    "model_not_found",
    "model_access_denied",
    "usage_not_included",
    "insufficient_funds",
    "insufficient_balance",
    "insufficient_quota",
    "quota_exceeded",
    "resource_exhausted",
    "rate_limit_error",
    "rate_limit_exceeded",
    "too_many_requests",
    "overloaded_error",
    "server_error",
    "api_error",
    "service_unavailable",
    "refusal",
    "content_filter",
    "safety",
    "malformed_response",
    "context_length_exceeded",
    "context_window_exceeded",
    "ENOENT",
    "EACCES",
    "EPERM",
    "ENOSPC",
    "EMFILE",
    "ENFILE",
    "EROFS",
    "ELOCKED",
    "EEXIST",
    "ENOTEMPTY",
    "EBUSY",
    "ENOTDIR",
    "EISDIR",
    "EIO",
    "EADDRINUSE",
    "EADDRNOTAVAIL",
    "ECONNRESET",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
    "missing_session_cwd",
    "session_import_file_not_found",
    "session_already_active",
    "session_recovering",
    "daemon_supervisor_already_running",
    "supervisor_generation_stale",
    "daemon_shutdown_in_progress",
    "supervisor_recovery_cancelled",
    "command_result_uncertain",
    "unknown",
];

/// The #2117 error components.
pub const ERROR_COMPONENTS: &[&str] = &[
    "startup",
    "configuration",
    "authentication",
    "provider",
    "tools",
    "mcp",
    "daemon",
    "rpc",
    "acp",
    "session",
    "compaction",
    "background",
    "unknown",
];

/// The #2117 error operations.
pub const ERROR_OPERATIONS: &[&str] = &[
    "startup",
    "load",
    "save",
    "refresh",
    "validate",
    "login",
    "logout",
    "discover",
    "request",
    "stream",
    "execute",
    "connect",
    "attach",
    "parse",
    "compact",
    "retry",
    "shutdown",
    "uncaught_exception",
    "unhandled_rejection",
    "unknown",
];

/// The #2117 error stages.
pub const ERROR_STAGES: &[&str] = &[
    "startup",
    "configuration",
    "authentication",
    "model_discovery",
    "model_request",
    "model_stream",
    "tool_execution",
    "session_persistence",
    "compaction",
    "background",
    "shutdown",
    "unknown",
];

/// The #2117 recovery actions.
pub const RECOVERY_ACTIONS: &[&str] = &[
    "automatic_retry",
    "manual_retry",
    "credentials_updated",
    "provider_changed",
    "model_changed",
    "cancelled",
    "none",
    "unknown",
];

/// The #2117 recovery outcomes.
pub const RECOVERY_OUTCOMES: &[&str] = &[
    "pending",
    "success",
    "failed",
    "cancelled",
    "not_observed",
    "unknown",
];

/// The #2117 classification sources.
pub const CLASSIFICATION_SOURCES: &[&str] = &[
    "structured_reason",
    "http_status",
    "typed_error",
    "reviewed_message",
    "unknown",
];

/// The error-message sources (#2117 `error_message_source`).
pub const ERROR_MESSAGE_SOURCES: &[&str] = &["reviewed_literal", "system_template"];

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

/// The #2117 timing origins.
pub const TIMING_ORIGINS: &[&str] = &[
    "worker_input",
    "worker_action",
    "worker_run",
    "ui_input",
    "ui_cancellation",
    "ui",
    "unknown",
];

/// The #2117 timing stages.
pub const TIMING_STAGES: &[&str] = &[
    "first_status",
    "first_model_event",
    "first_reasoning",
    "first_text",
    "tool",
    "retry_wait",
    "compaction",
    "stream_gap",
    "terminal",
    "queue_wait",
    "local_preparation",
    "input_to_run",
    "provider_dispatch",
    "time_to_error",
    "cancellation_to_idle",
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

/// The #2117 configuration choices (effort levels, goal actions).
pub const CONFIGURATION_CHOICES: &[&str] = &[
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "create", "status", "pause",
    "resume", "clear", "unknown",
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

/// The #2117 input outcomes.
pub const INPUT_OUTCOMES: &[&str] = &[
    "started",
    "success",
    "error",
    "cancelled",
    "no_run",
    "unknown",
    "initiated",
    "completed",
    "failed",
    "canceled",
    "unavailable",
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

const fn http_status() -> PropKind {
    PropKind::Number {
        max: 599,
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

const fn nullable_boolean() -> PropKind {
    PropKind::Boolean { nullable: true }
}

const fn error_message() -> PropKind {
    PropKind::BoundedString { max: 4096 }
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

/// `agent run started` (v2): fires at the run's `AgentStart`, pairing every
/// admitted run with its id and trigger before any model call.
const AGENT_RUN_STARTED: EventRule = EventRule {
    name: "agent run started",
    since: 2,
    properties: &[
        ("session_id", required(uuid())),
        ("run_id", required(uuid())),
        ("run_index", required(count())),
        ("trigger", required(enum_rule(RUN_TRIGGERS, "unknown"))),
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
    ],
};

/// `agent command used` (v1): builtin command names only, never arguments.
const AGENT_COMMAND_USED: EventRule = EventRule {
    name: "agent command used",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("command_name", required(free_string(64))),
    ],
};

/// `agent error` (v2): a provider/runtime failure occurrence or a later
/// recovery update. The message policy keeps raw provider text out: only
/// reviewed fixed strings ride `error_message`, everything else reports
/// the fixed `diagnostic_message`.
const AGENT_ERROR: EventRule = EventRule {
    name: "agent error",
    since: 2,
    properties: &[
        ("error_id", required(uuid())),
        (
            "error_event_kind",
            required(enum_rule(&["occurrence", "recovery_update"], "occurrence")),
        ),
        (
            "error_subtype",
            required(enum_rule(ERROR_SUBTYPES, "unknown")),
        ),
        (
            "error_category",
            optional(enum_rule(ERROR_CATEGORIES, "other")),
        ),
        ("error_code", optional(enum_rule(ERROR_CODES, "unknown"))),
        ("http_status", optional(http_status())),
        (
            "classification_source",
            optional(enum_rule(CLASSIFICATION_SOURCES, "unknown")),
        ),
        (
            "classifier_revision",
            optional(PropKind::Number {
                max: 10_000,
                integer: true,
                nullable: false,
            }),
        ),
        ("diagnostic_message", optional(free_string(256))),
        (
            "component",
            optional(enum_rule(ERROR_COMPONENTS, "unknown")),
        ),
        (
            "operation",
            optional(enum_rule(ERROR_OPERATIONS, "unknown")),
        ),
        ("stage", optional(enum_rule(ERROR_STAGES, "unknown"))),
        ("retryable", optional(nullable_boolean())),
        ("retry_attempt", optional(count())),
        ("retry_backoff_ms", optional(duration())),
        ("consecutive_failure_count", optional(count())),
        (
            "recovery_action",
            optional(enum_rule(RECOVERY_ACTIONS, "unknown")),
        ),
        (
            "recovery_outcome",
            optional(enum_rule(RECOVERY_OUTCOMES, "unknown")),
        ),
        ("error_message", optional(error_message())),
        ("error_message_id", optional(free_string(64))),
        (
            "error_message_source",
            optional(enum_rule(ERROR_MESSAGE_SOURCES, "system_template")),
        ),
        ("error_message_length", optional(count())),
        ("error_message_length_lower_bound", optional(boolean())),
        ("error_message_truncated", optional(boolean())),
        ("error_message_redacted", optional(boolean())),
    ],
};

/// `agent timing` (v2): one measurement per stage boundary.
const AGENT_TIMING: EventRule = EventRule {
    name: "agent timing",
    since: 2,
    properties: &[
        ("stage", required(enum_rule(TIMING_STAGES, "unknown"))),
        ("duration_ms", required(duration())),
        (
            "outcome",
            optional(enum_rule(
                &[
                    "success",
                    "error",
                    "cancelled",
                    "shutdown_interrupted",
                    "unavailable",
                    "unknown",
                ],
                "unknown",
            )),
        ),
        (
            "tool_category",
            optional(enum_rule(TOOL_CATEGORIES, "custom")),
        ),
        (
            "timing_origin",
            optional(enum_rule(TIMING_ORIGINS, "unknown")),
        ),
    ],
};

/// `agent tool summary` (v2): per-run, per-tool-category aggregates.
const AGENT_TOOL_SUMMARY: EventRule = EventRule {
    name: "agent tool summary",
    since: 2,
    properties: &[
        ("session_id", required(uuid())),
        ("run_id", required(uuid())),
        (
            "tool_category",
            required(enum_rule(TOOL_CATEGORIES, "custom")),
        ),
        ("call_count", required(count())),
        ("failure_count", required(count())),
        ("duration_ms", optional(duration())),
        ("recovered_count", optional(count())),
    ],
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

/// `agent feature outcome` (v2): user-facing feature attempts and results.
const AGENT_FEATURE_OUTCOME: EventRule = EventRule {
    name: "agent feature outcome",
    since: 2,
    properties: &[
        ("feature_id", required(uuid())),
        (
            "feature_name",
            required(enum_rule(FEATURE_NAMES, "unknown")),
        ),
        ("outcome", required(enum_rule(FEATURE_OUTCOMES, "unknown"))),
        ("duration_ms", optional(duration())),
        (
            "configuration_choice",
            optional(enum_rule(CONFIGURATION_CHOICES, "unknown")),
        ),
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

/// `agent input stage` (v2): one input's lifecycle observations.
const AGENT_INPUT_STAGE: EventRule = EventRule {
    name: "agent input stage",
    since: 2,
    properties: &[
        ("input_id", required(uuid())),
        ("stage", required(enum_rule(INPUT_STAGES, "unknown"))),
        ("outcome", required(enum_rule(INPUT_OUTCOMES, "unknown"))),
        ("duration_ms", optional(duration())),
        (
            "timing_origin",
            optional(enum_rule(TIMING_ORIGINS, "unknown")),
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

/// `skill used` (v1): skill invocation, never skill content.
const SKILL_USED: EventRule = EventRule {
    name: "skill used",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("skill_name", required(free_string(128))),
        (
            "skill_kind",
            required(enum_rule(&["markdown", "python"], "markdown")),
        ),
        (
            "source",
            required(enum_rule(&["prompt", "steer", "follow_up"], "prompt")),
        ),
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

/// `mcp connector used` (v1): server name only.
const MCP_CONNECTOR_USED: EventRule = EventRule {
    name: "mcp connector used",
    since: 1,
    properties: &[
        (
            "action",
            required(enum_rule(&["config", "refresh", "paste-install"], "config")),
        ),
        ("server_name", optional(free_string(128))),
    ],
};

/// `rlm child usage attributed` (v1): a durable usage attribution row.
const RLM_CHILD_USAGE: EventRule = EventRule {
    name: "rlm child usage attributed",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        (
            "origin",
            required(enum_rule(
                &["spawn_task", "agent_message", "direct_user"],
                "direct_user",
            )),
        ),
        ("input_tokens", optional(tokens())),
        ("output_tokens", optional(tokens())),
        ("cache_read_tokens", optional(tokens())),
        ("cache_write_tokens", optional(tokens())),
        ("cost", optional(cost())),
    ],
};

/// `tool executed` (v1): per tool execution, name + duration + outcome.
const TOOL_EXECUTED: EventRule = EventRule {
    name: "tool executed",
    since: 1,
    properties: &[
        ("session_id", required(uuid())),
        ("tool_name", required(free_string(128))),
        ("duration_ms", required(duration())),
        ("is_error", required(boolean())),
    ],
};

/// `kernel bootstrap` (v1): one per actual kernel boot.
const KERNEL_BOOTSTRAP: EventRule = EventRule {
    name: "kernel bootstrap",
    since: 1,
    properties: &[
        ("duration_ms", required(duration())),
        ("cold", required(boolean())),
        (
            "outcome",
            required(enum_rule(&["success", "error"], "error")),
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

/// The `tui *` adoption events (v1).
const TUI_EVENTS: &[EventRule] = &[
    EventRule {
        name: "tui scroll used",
        since: 1,
        properties: &[
            (
                "action",
                required(enum_rule(
                    &["page_up", "page_down", "top", "follow"],
                    "page_up",
                )),
            ),
            ("resumed_following", required(boolean())),
        ],
    },
    EventRule {
        name: "tui selection used",
        since: 1,
        properties: &[("lines", required(count()))],
    },
    EventRule {
        name: "tui click used",
        since: 1,
        properties: &[(
            "surface",
            required(enum_rule(&["transcript", "editor", "picker"], "picker")),
        )],
    },
    EventRule {
        name: "tui enhanced keys",
        since: 1,
        properties: &[
            ("kitty", required(boolean())),
            ("modify_other_keys", required(boolean())),
        ],
    },
    EventRule {
        name: "tui hyperlinks",
        since: 1,
        properties: &[("enabled", required(boolean()))],
    },
    EventRule {
        name: "tui image pasted",
        since: 1,
        properties: &[(
            "mime_type",
            required(enum_rule(
                &["image/png", "image/jpeg", "image/gif", "image/webp"],
                "image/png",
            )),
        )],
    },
    EventRule {
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
        ],
    },
    EventRule {
        name: "tui input queued",
        since: 1,
        properties: &[
            (
                "lane",
                required(enum_rule(&["steering", "follow_up"], "steering")),
            ),
            (
                "steering_mode",
                required(enum_rule(&["all", "one-at-a-time"], "all")),
            ),
        ],
    },
    EventRule {
        name: "tui queue edited",
        since: 1,
        properties: &[(
            "action",
            required(enum_rule(
                &["select", "edit", "delete", "reorder"],
                "select",
            )),
        )],
    },
    EventRule {
        name: "tui suspend used",
        since: 1,
        properties: &[(
            "outcome",
            required(enum_rule(&["resumed", "failed"], "failed")),
        )],
    },
    EventRule {
        name: "tui subagents open",
        since: 1,
        properties: &[("children_total", required(count()))],
    },
    EventRule {
        name: "tui activity opened",
        since: 1,
        properties: &[(
            "kind",
            required(enum_rule(&["subagents", "heartbeats", "bash"], "subagents")),
        )],
    },
    EventRule {
        name: "tui menu opened",
        since: 1,
        properties: &[
            (
                "menu",
                required(enum_rule(
                    &[
                        "model",
                        "mcp",
                        "settings",
                        "context",
                        "session",
                        "system-prompt",
                        "logs",
                        "changelog",
                        "hotkeys",
                        "traces",
                        "list",
                    ],
                    "list",
                )),
            ),
            (
                "source",
                required(enum_rule(&["command", "tab"], "command")),
            ),
        ],
    },
    EventRule {
        name: "tui prompt stash",
        since: 1,
        properties: &[
            (
                "action",
                required(enum_rule(
                    &["agents_view", "session_switch", "restored"],
                    "session_switch",
                )),
            ),
            ("had_images", required(boolean())),
        ],
    },
    EventRule {
        name: "tui bash shortcut used",
        since: 1,
        properties: &[
            ("excluded", required(boolean())),
            ("side_conversation", required(boolean())),
        ],
    },
    EventRule {
        name: "tui bash bang executed",
        since: 1,
        properties: &[
            (
                "duration_bucket",
                required(enum_rule(
                    &["lt_5s", "5_to_30s", "30s_plus", "unknown"],
                    "unknown",
                )),
            ),
            (
                "exit_class",
                required(enum_rule(
                    &["zero", "nonzero", "cancelled", "failed", "unknown"],
                    "unknown",
                )),
            ),
        ],
    },
];

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

/// Every catalogued event, flattened. `AGENT_ERROR` et al. are the #2117 v2
/// events; the v1 adoption events follow.
#[must_use]
pub fn catalog() -> Vec<&'static EventRule> {
    let mut all: Vec<&'static EventRule> = vec![
        &AGENT_STARTED,
        &AGENT_RUN_STARTED,
        &AGENT_RUN_COMPLETED,
        &AGENT_SESSION_ENDED,
        &AGENT_COMMAND_USED,
        &AGENT_ERROR,
        &AGENT_TIMING,
        &AGENT_TOOL_SUMMARY,
        &ONBOARDING_STAGE,
        &ONBOARDING_COMPLETED,
        &AGENT_FEATURE_OUTCOME,
        &AGENT_STARTUP_STAGE,
        &AGENT_INPUT_STAGE,
        &AGENT_INSTALLATION_STAGE,
        &SKILL_USED,
        &STARTUP,
        &DAEMON_EVENT,
        &MODEL_REFUSED,
        &MCP_CONNECTOR_USED,
        &RLM_CHILD_USAGE,
        &TOOL_EXECUTED,
        &KERNEL_BOOTSTRAP,
        &SESSION_ARCHIVED,
    ];
    all.extend(TUI_EVENTS.iter());
    all.extend(UPDATE_EVENTS.iter());
    all
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
    fn schema_version_bumped_for_the_2117_vocabulary() {
        // The #2117 event vocabulary landed at schema version 2; the v1
        // adoption events stay catalogued at their entry version.
        assert_eq!(SCHEMA_VERSION, 2);
        let catalog = catalog();
        for name in [
            "agent run started",
            "agent error",
            "agent timing",
            "agent tool summary",
            "onboarding stage",
            "agent feature outcome",
            "agent startup stage",
            "agent input stage",
            "agent installation stage",
        ] {
            let rule = catalog
                .iter()
                .find(|rule| rule.name == name)
                .unwrap_or_else(|| panic!("{name} must be catalogued"));
            assert_eq!(rule.since, 2, "{name} entered the catalog at v2");
        }
        for name in [
            "agent started",
            "agent run completed",
            "agent session ended",
            "agent command used",
            "onboarding completed",
            "tool executed",
            "skill used",
            "session archived",
            "startup",
            "daemon event",
            "update completed",
            "tui exit",
        ] {
            assert!(
                catalog.iter().any(|rule| rule.name == name),
                "{name} stays catalogued"
            );
        }
    }

    #[test]
    fn every_v2_event_carries_its_required_properties() {
        let run_started = lookup("agent run started").expect("catalogued");
        for key in ["session_id", "run_id", "run_index", "trigger"] {
            assert!(
                run_started
                    .properties
                    .iter()
                    .any(|(name, rule)| name == &key && rule.required),
                "agent run started requires {key}"
            );
        }
        let tool_summary = lookup("agent tool summary").expect("catalogued");
        for key in [
            "session_id",
            "run_id",
            "tool_category",
            "call_count",
            "failure_count",
        ] {
            assert!(
                tool_summary
                    .properties
                    .iter()
                    .any(|(name, rule)| name == &key && rule.required),
                "agent tool summary requires {key}"
            );
        }
        let installation = lookup("agent installation stage").expect("catalogued");
        for key in [
            "installation_attempt_id",
            "installation_action",
            "installation_source",
            "stage",
            "outcome",
        ] {
            assert!(
                installation
                    .properties
                    .iter()
                    .any(|(name, rule)| name == &key && rule.required),
                "agent installation stage requires {key}"
            );
        }
    }

    #[test]
    fn sanitize_drops_unknown_keys_and_falls_back_enums() {
        let mut properties = Properties::new();
        properties.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        properties.set("trigger", json!("spontaneous")); // out of vocabulary
        properties.set("run_index", json!(7u64));
        properties.set("prompt_text", json!("private prompt")); // not a catalogued property
        let adjusted = sanitize("agent run started", &mut properties);
        assert_eq!(properties.get("trigger"), Some(&json!("unknown")));
        assert_eq!(properties.get("run_index"), Some(&json!(7u64)));
        assert!(
            properties.get("prompt_text").is_none(),
            "unknown key dropped"
        );
        assert_eq!(adjusted, 2, "one fallback + one dropped key");
    }

    #[test]
    fn sanitize_clamps_numbers_and_caps_strings() {
        let mut properties = Properties::new();
        properties.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        properties.set("run_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1b"));
        properties.set("run_index", json!(u64::MAX)); // over the count cap
        properties.set("trigger", json!("prompt"));
        let _ = sanitize("agent run started", &mut properties);
        assert_eq!(properties.get("run_index"), Some(&json!(1_000_000u64)));
        let mut summary = Properties::new();
        summary.set("session_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1a"));
        summary.set("run_id", json!("0197d0a0-8f5c-7f2a-b0e3-2d7e0d2b3b1b"));
        summary.set("tool_category", json!("custom"));
        summary.set("call_count", json!(3.5)); // fractional where integer
        let _ = sanitize("agent tool summary", &mut summary);
        assert!(summary.get("call_count").is_none(), "fraction dropped");
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
