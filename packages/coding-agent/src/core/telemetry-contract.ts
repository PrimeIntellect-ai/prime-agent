import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";
import {
	TELEMETRY_AUTH_CATEGORIES,
	TELEMETRY_MODEL_CATEGORIES,
	TELEMETRY_PROVIDER_CATEGORIES,
} from "./telemetry-categories.js";
import {
	TELEMETRY_ERROR_CODES,
	TELEMETRY_ERROR_COMPONENTS,
	TELEMETRY_ERROR_MESSAGES,
	TELEMETRY_ERROR_OPERATIONS,
	TELEMETRY_ERROR_RECOVERY_ACTIONS,
	TELEMETRY_ERROR_RECOVERY_OUTCOMES,
	TELEMETRY_ERROR_STAGES,
} from "./telemetry-error-classification.js";
import { TELEMETRY_ERROR_TYPES } from "./telemetry-error-details.js";
import {
	TELEMETRY_ERROR_MESSAGE_POLICY_REVISION,
	TELEMETRY_SAFE_ERROR_CODES,
	TELEMETRY_SAFE_ERROR_MESSAGES,
	TELEMETRY_SAFE_ERROR_SIGNALS,
} from "./telemetry-error-policy.js";

export const TELEMETRY_ENUMS = {
	feature: ["model", "login", "logout", "effort", "goal", "new", "resume", "fork", "clone", "tree", "feedback"],
	configurationChoice: [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
		"create",
		"status",
		"pause",
		"resume",
		"clear",
		"unknown",
	],
	feedback: ["helpful", "partly_helpful", "not_helpful"],
	acquisitionMethod: [
		"existing_configuration",
		"prime_browser",
		"prime_key_entry",
		"oauth",
		"api_key_entry",
		"external_credentials",
		"unknown",
	],
	validationScope: ["configuration", "identity_scope", "selected_context", "inference", "unchecked"],
	onboardingStage: [
		"entry",
		"provider_selection",
		"credential_discovery",
		"credential_validation",
		"model_access",
		"ready",
		"exit",
	],
	onboardingOutcome: [
		"initiated",
		"completed",
		"failed",
		"canceled",
		"skipped",
		"configured",
		"unavailable",
		"provider_switched",
	],
	onboardingEntryReason: ["first_setup", "existing_configuration", "previously_shown", "reentered"],
	installationStage: [
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
	],
	installationOutcome: ["started", "success", "failed", "cancelled", "skipped", "unavailable"],
	installationReason: [
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
	],
} as const;

export interface TelemetryPropertyRule {
	kind: string;
	values?: readonly string[];
	fallback?: string;
	max?: number;
	maxLength?: number;
	integer?: boolean;
	nullable?: boolean;
}
export interface TelemetryEventRule {
	legacy: boolean;
	required: readonly string[];
	properties: Readonly<Record<string, TelemetryPropertyRule>>;
	legacy_properties?: readonly string[];
}

function enumRule(values: readonly string[], fallback?: string): TelemetryPropertyRule {
	return { kind: "enum", values, ...(fallback === undefined ? {} : { fallback }) };
}

const uuid: TelemetryPropertyRule = { kind: "uuid" };
const version: TelemetryPropertyRule = { kind: "version" };
const count: TelemetryPropertyRule = { kind: "number", max: 1000000, integer: true };
const tokens: TelemetryPropertyRule = { kind: "number", max: 1000000000000, integer: true };
const duration: TelemetryPropertyRule = { kind: "number", max: 31536000000, integer: true, nullable: true };
const revision: TelemetryPropertyRule = { kind: "number", max: 10000, integer: true };
const boolean: TelemetryPropertyRule = { kind: "boolean" };
const nullableBoolean: TelemetryPropertyRule = { kind: "boolean", nullable: true };
const authCategory: TelemetryPropertyRule = enumRule(TELEMETRY_AUTH_CATEGORIES, "none");
const errorCategory: TelemetryPropertyRule = {
	kind: "enum",
	values: ["authentication", "rate_limit", "timeout", "context_limit", "network", "provider_unavailable", "other"],
	fallback: "other",
	nullable: true,
};
const errorSubtype: TelemetryPropertyRule = enumRule(Object.keys(TELEMETRY_ERROR_MESSAGES), "unknown");
const terminalOutcome: TelemetryPropertyRule = enumRule(
	["success", "error", "cancelled", "shutdown_interrupted", "unknown"],
	"unknown",
);
const toolCategory: TelemetryPropertyRule = enumRule(
	["read", "write", "edit", "bash", "grep", "find", "ls", "ipython", "mcp", "extension", "custom", "unknown"],
	"custom",
);
const timingOrigin: TelemetryPropertyRule = enumRule(
	["worker_input", "worker_action", "worker_run", "ui_input", "ui_cancellation", "ui"],
	"unknown",
);

const baseProperties = {
	version,
	os_family: enumRule(
		[
			"aix",
			"android",
			"darwin",
			"freebsd",
			"haiku",
			"linux",
			"netbsd",
			"openbsd",
			"sunos",
			"win32",
			"cygwin",
			"unknown",
		],
		"unknown",
	),
	architecture: enumRule(
		[
			"arm",
			"arm64",
			"ia32",
			"loong64",
			"mips",
			"mipsel",
			"ppc",
			"ppc64",
			"riscv64",
			"s390",
			"s390x",
			"x64",
			"unknown",
		],
		"unknown",
	),
	install_method: enumRule(["bun-binary", "homebrew", "npm", "pnpm", "yarn", "bun", "unknown"], "unknown"),
	execution_mode: enumRule(["interactive", "print", "json", "rpc", "acp", "unknown"], "unknown"),
} satisfies Record<string, TelemetryPropertyRule>;

const commonProperties = {
	schema_revision: revision,
	build_channel: enumRule(["release", "prerelease", "development", "unknown"], "unknown"),
	workload_origin: enumRule(["interactive", "automated", "internal", "test", "unknown"], "unknown"),
} satisfies Record<string, TelemetryPropertyRule>;

const sessionProperties = {
	session_id: uuid,
	run_id: uuid,
	client_session_id: uuid,
	onboarding_id: uuid,
	run_index: count,
	elapsed_since_onboarding_ms: duration,
	provider_category: enumRule([...TELEMETRY_PROVIDER_CATEGORIES, "custom", "unknown"], "custom"),
	model_category: enumRule([...TELEMETRY_MODEL_CATEGORIES, "custom", "unknown"], "custom"),
} satisfies Record<string, TelemetryPropertyRule>;

const executionProperties = {
	input_id: uuid,
	auth_source: enumRule([...TELEMETRY_AUTH_CATEGORIES, "unknown"], "unknown"),
	team_scope: enumRule(["personal", "team", "unknown"], "unknown"),
	endpoint_category: enumRule(["default", "custom", "unknown"], "unknown"),
	context_source: enumRule(["configured", "request", "unknown"], "unknown"),
	setup_auth_source_changed: nullableBoolean,
	setup_provider_changed: nullableBoolean,
	setup_model_changed: nullableBoolean,
	setup_team_scope_changed: nullableBoolean,
	setup_endpoint_changed: nullableBoolean,
	ui_auth_source_changed: nullableBoolean,
	ui_provider_changed: nullableBoolean,
	ui_model_changed: nullableBoolean,
	ui_team_scope_changed: nullableBoolean,
	ui_endpoint_changed: nullableBoolean,
} satisfies Record<string, TelemetryPropertyRule>;

function event(
	required: readonly string[],
	properties: Record<string, TelemetryPropertyRule>,
	legacy = false,
): TelemetryEventRule {
	const requiredProperties = [...Object.keys(baseProperties), ...required];
	return {
		legacy,
		required: requiredProperties,
		properties: { ...baseProperties, ...commonProperties, ...properties },
		...(legacy ? { legacy_properties: requiredProperties } : {}),
	};
}

function legacyEvent(
	required: Record<string, TelemetryPropertyRule>,
	optional: Record<string, TelemetryPropertyRule>,
): TelemetryEventRule {
	return event(Object.keys(required), { ...sessionProperties, ...required, ...optional }, true);
}

export const TELEMETRY_CONTRACT: {
	schema_version: number;
	schema_revision: number;
	error_message_policy_revision: number;
	safe_error_messages: Readonly<Record<string, string>>;
	safe_error_codes: readonly string[];
	safe_error_signals: readonly string[];
	diagnostic_messages: Readonly<Record<string, string>>;
	events: Readonly<Record<string, TelemetryEventRule>>;
} = {
	schema_version: 2,
	schema_revision: 3,
	error_message_policy_revision: TELEMETRY_ERROR_MESSAGE_POLICY_REVISION,
	safe_error_messages: TELEMETRY_SAFE_ERROR_MESSAGES,
	safe_error_codes: TELEMETRY_SAFE_ERROR_CODES,
	safe_error_signals: TELEMETRY_SAFE_ERROR_SIGNALS,
	events: {
		"agent started": event(["session_id"], sessionProperties, true),
		"onboarding completed": event(
			["duration_ms", "outcome", "auth_category", "provider_category"],
			{
				...sessionProperties,
				duration_ms: duration,
				outcome: enumRule(["success", "error", "aborted"]),
				auth_category: authCategory,
			},
			true,
		),
		"agent command used": event(
			["command_name"],
			{
				...sessionProperties,
				command_name: enumRule(BUILTIN_SLASH_COMMANDS.map(({ name }) => name)),
			},
			true,
		),
		"agent run completed": legacyEvent(
			{
				session_id: sessionProperties.session_id,
				outcome: enumRule(["success", "error", "aborted"]),
				duration_ms: duration,
				visible_ttft_ms: duration,
				first_model_event_ms: duration,
				model_latency_ms: duration,
				max_model_latency_ms: duration,
				model_call_count: count,
				turn_count: count,
				tool_call_count: count,
				tool_error_count: count,
				input_tokens: tokens,
				output_tokens: tokens,
				cache_read_tokens: tokens,
				cache_write_tokens: tokens,
				total_tokens: tokens,
				compaction_count: count,
				retry_count: count,
				provider_category: sessionProperties.provider_category,
				model_category: sessionProperties.model_category,
				error_category: errorCategory,
			},
			{
				...executionProperties,
				successful_model_call_count: count,
				terminal_outcome: terminalOutcome,
				first_status_ms: duration,
				first_reasoning_ms: duration,
				run_to_first_text_ms: duration,
				tool_duration_ms: duration,
				retry_wait_ms: duration,
				compaction_duration_ms: duration,
				max_stream_gap_ms: duration,
				error_subtype: errorSubtype,
				usage_complete: boolean,
				estimated_cost_usd: { kind: "number", max: 1000000, nullable: true },
				cost_revision: revision,
				stop_reason: enumRule(["stop", "length", "toolUse", "error", "aborted", "unknown"], "unknown"),
				queue_wait_ms: duration,
				local_preparation_ms: duration,
				input_to_run_ms: duration,
			},
		),
		"agent session ended": legacyEvent(
			{
				session_id: sessionProperties.session_id,
				duration_ms: duration,
				prompt_count: count,
				run_count: count,
				successful_run_count: count,
				failed_run_count: count,
				aborted_run_count: count,
				tool_call_count: count,
				compaction_count: count,
				model_call_count: count,
				input_tokens: tokens,
				output_tokens: tokens,
				cache_read_tokens: tokens,
				cache_write_tokens: tokens,
				total_tokens: tokens,
			},
			{
				terminal_outcome: terminalOutcome,
			},
		),
		"agent run started": event(["session_id", "run_id"], {
			...sessionProperties,
			...executionProperties,
			trigger: enumRule(["prompt", "continuation", "unknown"], "unknown"),
		}),
		"agent error": event(["error_id", "error_subtype"], {
			...sessionProperties,
			error_id: uuid,
			error_category: errorCategory,
			error_subtype: errorSubtype,
			error_code: enumRule(TELEMETRY_ERROR_CODES, "unknown"),
			http_status: { kind: "number", max: 599, integer: true, nullable: true },
			classification_source: enumRule(
				["structured_reason", "http_status", "typed_error", "reviewed_message", "unknown"],
				"unknown",
			),
			classifier_revision: revision,
			diagnostic_message: enumRule(Object.values(TELEMETRY_ERROR_MESSAGES)),
			component: enumRule(TELEMETRY_ERROR_COMPONENTS, "unknown"),
			operation: enumRule(TELEMETRY_ERROR_OPERATIONS, "unknown"),
			stage: enumRule(TELEMETRY_ERROR_STAGES, "unknown"),
			retryable: nullableBoolean,
			retry_attempt: count,
			retry_backoff_ms: duration,
			consecutive_failure_count: count,
			recovery_action: enumRule(TELEMETRY_ERROR_RECOVERY_ACTIONS, "unknown"),
			recovery_outcome: enumRule(TELEMETRY_ERROR_RECOVERY_OUTCOMES, "unknown"),
			error_message: { kind: "error_message", maxLength: 4096 },
			error_message_id: enumRule(Object.keys(TELEMETRY_SAFE_ERROR_MESSAGES)),
			error_message_source: enumRule(["reviewed_literal", "system_template"]),
			error_message_length: count,
			error_message_length_lower_bound: boolean,
			error_message_truncated: boolean,
			error_message_redacted: boolean,
			error_code_group: { kind: "error_code", maxLength: 80 },
			error_type: enumRule(TELEMETRY_ERROR_TYPES, "unknown"),
			error_event_kind: enumRule(["occurrence", "recovery_update"], "unknown"),
			input_id: uuid,
		}),
		"agent timing": event(["stage", "duration_ms"], {
			...sessionProperties,
			stage: enumRule(
				[
					"first_status",
					"first_model_event",
					"first_reasoning",
					"first_text",
					"tool",
					"retry_wait",
					"compaction",
					"stream_gap",
					"terminal",
					"unknown",
					"queue_wait",
					"local_preparation",
					"input_to_run",
					"provider_dispatch",
					"time_to_error",
					"cancellation_to_idle",
				],
				"unknown",
			),
			duration_ms: duration,
			outcome: enumRule(
				["success", "error", "cancelled", "shutdown_interrupted", "unknown", "unavailable"],
				"unknown",
			),
			tool_category: toolCategory,
			input_id: uuid,
			timing_origin: timingOrigin,
		}),
		"agent tool summary": event(["session_id", "run_id", "tool_category", "call_count", "failure_count"], {
			...sessionProperties,
			tool_category: toolCategory,
			call_count: count,
			failure_count: count,
			duration_ms: duration,
			recovered_count: count,
		}),
		"onboarding stage": event(["onboarding_id", "stage", "outcome"], {
			...sessionProperties,
			stage: enumRule(TELEMETRY_ENUMS.onboardingStage),
			outcome: enumRule(TELEMETRY_ENUMS.onboardingOutcome),
			duration_ms: duration,
			auth_category: authCategory,
			acquisition_method: enumRule(TELEMETRY_ENUMS.acquisitionMethod, "unknown"),
			validation_scope: enumRule(TELEMETRY_ENUMS.validationScope, "unchecked"),
			entry_reason: enumRule(TELEMETRY_ENUMS.onboardingEntryReason),
			timing_scope: enumRule(["elapsed_including_user_wait", "system_work"]),
		}),
		"agent feature outcome": event(["feature_id", "feature_name", "outcome"], {
			...sessionProperties,
			feature_id: uuid,
			feature_name: enumRule(TELEMETRY_ENUMS.feature),
			outcome: enumRule(["initiated", "completed", "failed", "canceled", "unavailable"]),
			duration_ms: duration,
			configuration_choice: enumRule(TELEMETRY_ENUMS.configurationChoice, "unknown"),
			feedback: enumRule(TELEMETRY_ENUMS.feedback),
			previous_success: boolean,
		}),
		"agent startup stage": event(["stage", "outcome", "duration_ms"], {
			...sessionProperties,
			stage: enumRule([
				"ui_ready",
				"session_attach",
				"configuration_load",
				"credential_validation",
				"session_ui_rebind",
			]),
			outcome: enumRule(["completed", "failed"]),
			duration_ms: duration,
			startup_kind: enumRule(["cold", "warm_attach", "resumed", "unknown"], "unknown"),
			timing_scope: enumRule(["system_work", "elapsed_including_user_wait"]),
		}),
		"agent input stage": event(["input_id", "stage", "outcome"], {
			...sessionProperties,
			...executionProperties,
			stage: enumRule(
				[
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
				],
				"unknown",
			),
			outcome: enumRule(
				[
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
				],
				"unknown",
			),
			duration_ms: duration,
			timing_origin: timingOrigin,
		}),
		"agent installation stage": event(
			["installation_attempt_id", "installation_action", "installation_source", "stage", "outcome"],
			{
				installation_attempt_id: uuid,
				installation_action: enumRule(["install", "update"]),
				installation_source: enumRule(["shell_installer", "cli", "interactive"]),
				stage: enumRule(TELEMETRY_ENUMS.installationStage),
				outcome: enumRule(TELEMETRY_ENUMS.installationOutcome),
				reason: enumRule(TELEMETRY_ENUMS.installationReason, "unknown"),
				from_version: version,
				target_version: version,
				observed_version: version,
				duration_ms: duration,
				exit_code: { kind: "number", max: 255, integer: true, nullable: true },
				error_id: uuid,
				ready_kind: enumRule(["interactive", "headless"]),
				session_restore_total: count,
				session_restore_failed: count,
			},
		),
	},
	diagnostic_messages: TELEMETRY_ERROR_MESSAGES,
};
