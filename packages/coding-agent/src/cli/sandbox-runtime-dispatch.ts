/**
 * Static early CLI dispatch for B14 runtime modes.
 *
 * Detects the two reserved flags BEFORE normal config/UI/provider/plugin
 * startup.  Static imports only — no dynamic/inline imports, no `any`,
 * no sync fs, no shell, no resources.
 *
 * Only argv[0] is checked.  A standalone "--" at argv[0] passes through.
 * If argv[0] IS a reserved flag, dispatch ALWAYS hands it — the process
 * never enters normal provider/UI startup.  Extra trailing arguments still
 * hand (INVALID_RUNTIME_ARGUMENTS) rather than passing through.
 * Appearances of a reserved flag at argv[1+] are never intercepted.
 *
 * Without production orchestration (launcher/publisher/relay host) both
 * modes fail closed with ORCHESTRATION_UNAVAILABLE. No sandbox_sessions
 * support is advertised.
 *
 * The dispatch function never calls process.exit() — that is the caller's
 * responsibility.  The CLI may set exitCode 1 without logging secrets.
 *
 * No dynamic/inline imports, no `any`, no sync FS, no shell, no
 * caller-controlled paths or dependencies.
 */

import { parseSandboxBootstrapMode } from "../core/sandbox-fd3-bootstrap-mode.js";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const WRAPPER_FLAG = "--prime-agent-fd3-bootstrap";
const RUNTIME_FLAG = "--prime-agent-runtime-fd3";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type RuntimeDispatchExitCode = 1;

export type RuntimeDispatchCode = "ORCHESTRATION_UNAVAILABLE" | "INVALID_RUNTIME_ARGUMENTS";

export type RuntimeDispatchResult =
	/** Neither reserved flag was present — continue with normal startup. */
	| Readonly<{ ok: false; handed: false }>
	/** Dispatch handled the flag and the process should exit with the given code. */
	| Readonly<{ ok: true; handed: true; code: RuntimeDispatchCode; exitCode: RuntimeDispatchExitCode }>;

// ---------------------------------------------------------------------------
// Detect reserved flag at argv[0]
// ---------------------------------------------------------------------------

/**
 * Check whether argv[0] is a reserved runtime flag.
 *
 * If argv[0] IS a reserved flag the result is ALWAYS handed: the process
 * must never pass through to normal provider/UI startup.  A valid exact
 * 3-element form returns ORCHESTRATION_UNAVAILABLE; any other form returns
 * INVALID_RUNTIME_ARGUMENTS.  Both use exitCode 1.
 *
 * Only argv[0] is checked — the normal argument position that replaces the
 * default CLI command.  A standalone "--" at argv[0] passes through.
 * Reserved flags at argv[1+] pass through (normal arguments).
 *
 * This is synchronous (pure parse) and never calls process.exit().
 */
export function detectReservedArgv(argv: readonly string[]): RuntimeDispatchResult {
	// Empty argv or standalone "--" separator — pass through.
	if (argv.length < 1 || argv[0] === "--") {
		return Object.freeze({ ok: false as const, handed: false as const });
	}

	// Not a recognised reserved flag — pass through.
	if (argv[0] !== WRAPPER_FLAG && argv[0] !== RUNTIME_FLAG) {
		return Object.freeze({ ok: false as const, handed: false as const });
	}

	// argv[0] IS a reserved flag — always hand.
	// Pass the full argv to the accepted mode parser.
	const raw = parseSandboxBootstrapMode(argv);

	if (raw.ok) {
		// Flag, --ready-nonce, and hex are all valid.
		// Without hosted orchestration, fail closed.
		return Object.freeze({
			ok: true as const,
			handed: true as const,
			code: "ORCHESTRATION_UNAVAILABLE" as const,
			exitCode: 1 as const,
		});
	}

	// Flag recognised but malformed (wrong length, wrong nonce, extras, etc.)
	return Object.freeze({
		ok: true as const,
		handed: true as const,
		code: "INVALID_RUNTIME_ARGUMENTS" as const,
		exitCode: 1 as const,
	});
}
