// The REPL kernel runs model-generated code, so it must not inherit the host's
// whole environment: provider credentials (PRIME_API_KEY, OPENAI_API_KEY, ...)
// would be readable from any cell and, once assigned to a name, pickled into
// the session's kernel-state snapshot. The kernel gets an allowlisted subset
// instead; everything the session itself injects (RLM_*, PRIME_AGENT_BASH_*,
// the websearch key) is passed explicitly by the caller.
import { createHash } from "node:crypto";

/** Exact host variable names the kernel (and its bash() children) may inherit. */
const KERNEL_ENV_ALLOWLIST = new Set([
	// Process identity and filesystem roots.
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PWD",
	"TMPDIR",
	"TMP",
	"TEMP",
	// Locale and terminal.
	"LANG",
	"LANGUAGE",
	"TZ",
	"TERM",
	"COLORTERM",
	"NO_COLOR",
	"FORCE_COLOR",
	"CLICOLOR",
	"CLICOLOR_FORCE",
	// Editors and pagers project commands (git, man) may invoke.
	"EDITOR",
	"VISUAL",
	"PAGER",
	"LESS",
	"LESSCHARSET",
	// Agent and display sockets (paths, not secrets).
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"DBUS_SESSION_BUS_ADDRESS",
	// TLS trust and proxies.
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ALL_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"all_proxy",
	// Toolchain homes project commands resolve binaries and caches through.
	"VIRTUAL_ENV",
	"CONDA_PREFIX",
	"CONDA_DEFAULT_ENV",
	"PYENV_ROOT",
	"NVM_DIR",
	"NODE_PATH",
	"NPM_CONFIG_PREFIX",
	"PNPM_HOME",
	"BUN_INSTALL",
	"VOLTA_HOME",
	"DENO_DIR",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"GOPATH",
	"GOROOT",
	"GOMODCACHE",
	"JAVA_HOME",
	"SDKMAN_DIR",
	"ANDROID_HOME",
	"ANDROID_SDK_ROOT",
	"DOTNET_ROOT",
	"CI",
	// Legacy agent dir read by the runtime.
	"PI_CODING_AGENT_DIR",
	// Prime team selection (an identifier, not a credential).
	"PRIME_TEAM_ID",
	// Windows process environment.
	"SYSTEMROOT",
	"SYSTEMDRIVE",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"USERNAME",
	"USERDOMAIN",
	"HOMEDRIVE",
	"HOMEPATH",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMW6432",
	"COMMONPROGRAMFILES",
	"COMMONPROGRAMFILES(X86)",
	"ALLUSERSPROFILE",
	"PUBLIC",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE",
	"OS",
]);

/** Name prefixes the kernel may inherit (still subject to the credential-name filter). */
const KERNEL_ENV_ALLOWLIST_PREFIXES = [
	"RLM_",
	"PRIME_AGENT_",
	"PYTHON",
	"UV_",
	"PIP_",
	"LC_",
	"XDG_",
	"TERM_",
	"GIT_",
	"TMUX",
];

/**
 * Provider credential variables (packages/ai/src/env-api-keys.ts, prime-agent.sh
 * --no-env) plus ambient cloud credential sources. Never inherited, and their
 * host values are recorded so the snapshot can skip names holding them.
 */
export const KERNEL_ENV_CREDENTIAL_NAMES: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"PRIME_API_KEY",
	"PRIME_AGENT_TRACES_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"SERPER_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
];

/** Name shapes that denote a credential regardless of the allowlist above. */
const CREDENTIAL_NAME_PATTERN = /(API_KEY|APIKEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)/i;

/** Values shorter than this are too generic to treat as a credential match. */
const MIN_CREDENTIAL_VALUE_LENGTH = 8;

const credentialNameSet = new Set(KERNEL_ENV_CREDENTIAL_NAMES);

/** True when the variable name denotes a credential and must never reach the kernel by inheritance. */
export function isCredentialEnvName(name: string): boolean {
	return credentialNameSet.has(name) || CREDENTIAL_NAME_PATTERN.test(name);
}

export interface KernelEnvOptions {
	/** Extra host names (exact) or `PREFIX*` globs the kernel may inherit; bypasses the credential filter. */
	passthrough?: readonly string[];
	/** Platform whose env-name semantics apply (Windows names are case-insensitive). Default: process.platform. */
	platform?: NodeJS.Platform;
}

function normalizeName(name: string, caseInsensitive: boolean): string {
	return caseInsensitive ? name.toUpperCase() : name;
}

function matchesPassthrough(name: string, passthrough: readonly string[], caseInsensitive: boolean): boolean {
	const normalized = normalizeName(name, caseInsensitive);
	for (const rule of passthrough) {
		const trimmed = rule.trim();
		if (!trimmed) continue;
		const normalizedRule = normalizeName(trimmed, caseInsensitive);
		if (normalizedRule.endsWith("*")) {
			const prefix = normalizedRule.slice(0, -1);
			if (prefix && normalized.startsWith(prefix)) return true;
		} else if (normalized === normalizedRule) {
			return true;
		}
	}
	return false;
}

function inheritedByAllowlist(name: string, caseInsensitive: boolean): boolean {
	// The Windows set is stored upper-case; on POSIX names are matched exactly.
	const upper = name.toUpperCase();
	if (KERNEL_ENV_ALLOWLIST.has(name) || (caseInsensitive && KERNEL_ENV_ALLOWLIST.has(upper))) return true;
	const candidate = caseInsensitive ? upper : name;
	return KERNEL_ENV_ALLOWLIST_PREFIXES.some((prefix) => candidate.startsWith(prefix));
}

/**
 * Build the environment for a kernel process: the allowlisted subset of `hostEnv`
 * with `extra` layered on top. `extra` is always kept verbatim — it is what the
 * session deliberately hands the kernel (RLM_*, PRIME_AGENT_BASH_*, skill keys).
 */
export function buildKernelEnv(
	hostEnv: NodeJS.ProcessEnv,
	extra: Record<string, string> = {},
	options: KernelEnvOptions = {},
): Record<string, string> {
	const platform = options.platform ?? process.platform;
	const caseInsensitive = platform === "win32";
	const passthrough = options.passthrough ?? [];
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(hostEnv)) {
		if (value === undefined) continue;
		if (matchesPassthrough(name, passthrough, caseInsensitive)) {
			env[name] = value;
			continue;
		}
		if (!inheritedByAllowlist(name, caseInsensitive)) continue;
		if (isCredentialEnvName(name)) continue;
		env[name] = value;
	}
	return { ...env, ...extra };
}

/** Host variable names dropped by {@link buildKernelEnv} because they name a credential. */
export function droppedCredentialEnvNames(hostEnv: NodeJS.ProcessEnv, options: KernelEnvOptions = {}): string[] {
	const platform = options.platform ?? process.platform;
	const caseInsensitive = platform === "win32";
	const passthrough = options.passthrough ?? [];
	return Object.keys(hostEnv)
		.filter((name) => hostEnv[name] !== undefined && hostEnv[name] !== "")
		.filter((name) => isCredentialEnvName(name) && !matchesPassthrough(name, passthrough, caseInsensitive))
		.sort();
}

/** SHA-256 hex digest of a credential value, as the runtime computes it for snapshot redaction. */
export function credentialDigest(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Digests of every credential-looking value in `env` (host env plus the session's
 * injected variables). The kernel receives digests only, never the values, and
 * skips top-level names whose value hashes to one of them when snapshotting.
 */
export function collectCredentialDigests(env: NodeJS.ProcessEnv): string[] {
	const digests = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (typeof value !== "string" || !isCredentialEnvName(name)) continue;
		const trimmed = value.trim();
		if (trimmed.length < MIN_CREDENTIAL_VALUE_LENGTH) continue;
		digests.add(credentialDigest(value));
		if (trimmed !== value) digests.add(credentialDigest(trimmed));
	}
	return [...digests].sort();
}
