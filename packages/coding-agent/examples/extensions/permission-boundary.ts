/**
 * Permission Boundary Extension — Codex-style workspace sandbox for Prime Agent
 *
 * Enforces that the agent only has WRITE/EXECUTE side effects inside configured
 * workspace folders, with a user-approved escalation path for leaving the
 * sandbox — modeled after Codex's `workspace-write` sandbox mode with the
 * `on-failure` approval policy.
 *
 * How it works:
 * 1. OS-level enforcement (macOS): the IPython kernel — the only tool the
 *    model has, covering both Python code and `%%bash` cells — is launched
 *    under `sandbox-exec` with a Seatbelt profile that mirrors Codex's
 *    workspace-write requirements:
 *    - file writes only inside the configured workspace roots, /tmp, $TMPDIR,
 *      and the agent state dirs the kernel needs (session-artifacts,
 *      kernel-venv, logs, ~/.ipython);
 *    - inside each workspace root, the top-level `.git` (including worktree
 *      gitdir targets) and `.prime` stay READ-ONLY — the agent cannot rewrite
 *      git history or its own permission config/rules (Codex protects `.git`
 *      and `.codex` the same way);
 *    - network denied by default (loopback and unix sockets stay open for the
 *      kernel's ZMQ transport); opt in with `"network": true`;
 *    - reads are unrestricted, matching workspace-write semantics.
 *    This uses the PRIME_AGENT_KERNEL_WRAPPER hook in
 *    src/core/kernel/spawn-wrapper.ts.
 * 2. Escalation (approvalPolicy "on-failure", like Codex): when a `%%bash`
 *    cell fails with a sandbox denial (file write or network), the user is
 *    prompted: deny / run outside the sandbox once / always allow similar
 *    commands (saves a rule). Approved commands are re-run on the host,
 *    unsandboxed, and the tool result is replaced with the host output.
 * 3. Rules: "always allow" answers persist as command-prefix rules in
 *    `<project>/.prime/agent/permission-rules.json`. Commands fully covered by
 *    rules auto-escalate without prompting. The rules files live inside the
 *    protected `.prime` dirs, so only the user (or the host-side extension
 *    after an approval) can change them — the sandboxed agent cannot.
 *
 * Config (merged; project takes precedence):
 * - ~/.prime/agent/permission-boundary.json          (global)
 * - <cwd>/.prime/agent/permission-boundary.json      (project)
 *
 * ```json
 * {
 *   "enabled": true,
 *   "workspaces": ["."],
 *   "extraWritePaths": [],
 *   "network": false,
 *   "protectGit": true,
 *   "approvalPolicy": "on-failure"
 * }
 * ```
 *
 * Disable for one run: PRIME_AGENT_NO_BOUNDARY=1 prime-agent
 * Inspect at runtime: /permissions
 *
 * Codex-model mapping:
 * - sandbox mode: `workspace-write` (fixed; `read-only` and
 *   `danger-full-access` are not implemented — disable the extension for the
 *   latter)
 * - approval policy: `on-failure` or `never` (`untrusted` / `on-request` are
 *   not implementable per-command for a persistent kernel in this MVP)
 * - `network_access`, protected `.git`, protected agent config dir: mirrored
 *
 * Limitations (MVP):
 * - OS enforcement is macOS-only (sandbox-exec). On other platforms the
 *   extension warns and does not enforce. (Codex uses Landlock/seccomp on
 *   Linux; a bubblewrap-based wrapper would be the analog here.)
 * - The Seatbelt base is allow-default with targeted write/network denies,
 *   not Codex's deny-default profile; reads and process-exec are unrestricted
 *   (equivalent to workspace-write for writes/network, weaker against
 *   fingerprinting/IPC than Codex's profile).
 * - Only `%%bash` cells can be escalated. Python cells that hit a denial get a
 *   hint telling the model to retry the operation as a `%%bash` cell.
 * - Escalated commands re-run from the session cwd (not the kernel's cwd if
 *   the model changed it) and outside the kernel, so shell state (env vars,
 *   cd) from earlier cells does not carry over.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * ~/.prime/agent (or the env override). Inlined instead of importing
 * `getAgentDir` from pi-coding-agent so this extension has no runtime imports
 * from the package — required for loading under the dev (tsx) module loader.
 */
function getAgentDir(): string {
	const env = process.env.PRIME_AGENT_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	if (env) return expandUser(env);
	return join(homedir(), ".prime", "agent");
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface BoundaryConfig {
	/** Master switch for the whole extension. */
	enabled: boolean;
	/** Folders the agent may write to / run destructive commands in. Relative paths resolve against the project cwd. */
	workspaces: string[];
	/** Additional write-allowed paths (caches etc.). No .git/.prime protection is applied to these. */
	extraWritePaths: string[];
	/** Allow outbound network from the sandbox (Codex `network_access`). Loopback is always allowed. */
	network: boolean;
	/** Keep each workspace root's top-level .git read-only (Codex protects .git the same way). */
	protectGit: boolean;
	/** "on-failure": prompt to re-run sandbox-blocked %%bash commands on the host. "never": no prompts. */
	approvalPolicy: "on-failure" | "never";
}

const DEFAULT_CONFIG: BoundaryConfig = {
	enabled: true,
	workspaces: ["."],
	extraWritePaths: [],
	network: false,
	protectGit: true,
	approvalPolicy: "on-failure",
};

function projectConfigDir(cwd: string): string {
	return join(cwd, ".prime", "agent");
}

function loadConfig(cwd: string): BoundaryConfig {
	const paths = [
		join(getAgentDir(), "permission-boundary.json"),
		join(projectConfigDir(cwd), "permission-boundary.json"),
	];
	let config = { ...DEFAULT_CONFIG };
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<BoundaryConfig>;
			config = {
				enabled: parsed.enabled ?? config.enabled,
				workspaces: parsed.workspaces ?? config.workspaces,
				extraWritePaths: parsed.extraWritePaths ?? config.extraWritePaths,
				network: parsed.network ?? config.network,
				protectGit: parsed.protectGit ?? config.protectGit,
				approvalPolicy: parsed.approvalPolicy ?? config.approvalPolicy,
			};
		} catch (e) {
			console.error(`permission-boundary: could not parse ${path}: ${e}`);
		}
	}
	return config;
}

// ---------------------------------------------------------------------------
// Rules ("do not ask again")
// ---------------------------------------------------------------------------

interface RulesFile {
	/** Command prefixes allowed to run outside the sandbox without prompting. */
	allowOutsideSandbox: string[];
}

function rulesPath(cwd: string): string {
	return join(projectConfigDir(cwd), "permission-rules.json");
}

function loadRules(cwd: string): string[] {
	const paths = [join(getAgentDir(), "permission-rules.json"), rulesPath(cwd)];
	const rules: string[] = [];
	for (const path of paths) {
		if (!existsSync(path)) continue;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RulesFile>;
			if (Array.isArray(parsed.allowOutsideSandbox)) rules.push(...parsed.allowOutsideSandbox.map(String));
		} catch (e) {
			console.error(`permission-boundary: could not parse ${path}: ${e}`);
		}
	}
	return rules;
}

function saveRules(cwd: string, newRules: string[]): void {
	const path = rulesPath(cwd);
	let existing: string[] = [];
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<RulesFile>;
			if (Array.isArray(parsed.allowOutsideSandbox)) existing = parsed.allowOutsideSandbox.map(String);
		} catch {
			// overwrite unreadable file
		}
	}
	const merged = [...new Set([...existing, ...newRules])];
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ allowOutsideSandbox: merged }, null, "\t")}\n`);
}

/**
 * Split a shell command into segments that must each be covered by a rule.
 * Splitting on newlines, `&&`, `||`, `;`, and `|` is intentionally
 * conservative: every part of a compound command needs an allowing rule.
 */
function splitSegments(command: string): string[] {
	return command
		.split(/\r?\n|&&|\|\||;|\|/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Multi-word commands where the subcommand belongs in the rule prefix. */
const MULTIWORD_COMMANDS = new Set([
	"git",
	"npm",
	"pnpm",
	"yarn",
	"bun",
	"cargo",
	"docker",
	"kubectl",
	"brew",
	"pip",
	"pip3",
	"uv",
	"apt",
	"apt-get",
	"gh",
	"go",
	"poetry",
	"bundle",
	"gem",
	"composer",
	"sudo",
]);

function deriveRulePrefix(segment: string): string {
	const words = segment.trim().split(/\s+/);
	if (words.length >= 2 && MULTIWORD_COMMANDS.has(words[0])) return `${words[0]} ${words[1]}`;
	return words[0] ?? "";
}

function segmentAllowed(segment: string, rules: string[]): boolean {
	return rules.some((rule) => segment === rule || segment.startsWith(`${rule} `));
}

function commandAllowedByRules(command: string, rules: string[]): boolean {
	const segments = splitSegments(command);
	if (segments.length === 0 || rules.length === 0) return false;
	return segments.every((segment) => segmentAllowed(segment, rules));
}

// ---------------------------------------------------------------------------
// Seatbelt profile (macOS)
// ---------------------------------------------------------------------------

function expandUser(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function canonicalize(path: string, cwd: string): string {
	const absolute = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		return realpathSync(absolute);
	} catch {
		return absolute;
	}
}

function sbString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A writable root with subpaths that must stay read-only (Codex WritableRoot). */
interface WritableRoot {
	root: string;
	readOnlySubpaths: string[];
}

/**
 * If `<root>/.git` is a worktree/submodule pointer file ("gitdir: <path>"),
 * return the resolved gitdir so it can be protected too (Codex does the same).
 */
function resolveGitdirPointer(gitPath: string, root: string): string | undefined {
	try {
		const content = readFileSync(gitPath, "utf-8");
		const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
		if (!match) return undefined;
		const target = match[1].trim();
		return canonicalize(isAbsolute(target) ? target : resolve(root, target), root);
	} catch {
		return undefined;
	}
}

/**
 * Workspace roots get Codex-style protected subpaths: top-level `.git`
 * (history) and top-level `.prime` (this extension's own config and rules —
 * the analog of Codex protecting `.codex`).
 */
function resolveWorkspaceRoots(config: BoundaryConfig, cwd: string): WritableRoot[] {
	const roots = [...new Set(config.workspaces.map((w) => canonicalize(expandUser(w), cwd)))];
	return roots.map((root) => {
		const readOnlySubpaths: string[] = [join(root, ".prime")];
		if (config.protectGit) {
			const gitPath = join(root, ".git");
			readOnlySubpaths.push(gitPath);
			if (existsSync(gitPath)) {
				const gitdir = resolveGitdirPointer(gitPath, root);
				if (gitdir) readOnlySubpaths.push(gitdir);
			}
		}
		return { root, readOnlySubpaths };
	});
}

/** Unprotected write-allowed roots: tmp dirs plus the agent state the kernel needs. */
function resolvePlainWriteRoots(config: BoundaryConfig, cwd: string): string[] {
	const agentDir = canonicalize(getAgentDir(), cwd);
	const roots = [
		...config.extraWritePaths.map((p) => canonicalize(expandUser(p), cwd)),
		// Temp dirs: kernel connection files, python tempfile, zmq sockets.
		canonicalize(tmpdir(), cwd),
		"/private/tmp",
		"/private/var/tmp",
		"/private/var/folders",
		// Agent state the kernel writes — deliberately NOT the whole agent dir,
		// so auth.json, settings.json, extensions/, and the permission config
		// stay read-only to the agent.
		join(agentDir, "session-artifacts"),
		join(agentDir, "kernel-venv"),
		join(agentDir, "logs"),
		// IPython history/profile dir used by the kernel.
		join(homedir(), ".ipython"),
		// ttys, /dev/null, pipes.
		"/dev",
	];
	return [...new Set(roots)];
}

function buildSeatbeltProfile(workspaceRoots: WritableRoot[], plainRoots: string[], allowNetwork: boolean): string {
	const lines = [
		"(version 1)",
		"; Generated by the permission-boundary extension, mirroring Codex's",
		"; workspace-write requirements. Reads are unrestricted; file writes are",
		"; denied outside the roots below; top-level .git and .prime inside",
		"; workspace roots stay read-only; network is denied unless enabled.",
		"(allow default)",
		'(deny file-write* (subpath "/"))',
	];
	for (const { root, readOnlySubpaths } of workspaceRoots) {
		lines.push("(allow file-write*", "  (require-all", `    (subpath ${sbString(root)})`);
		for (const subpath of readOnlySubpaths) {
			lines.push(`    (require-not (literal ${sbString(subpath)}))`);
			lines.push(`    (require-not (subpath ${sbString(subpath)}))`);
		}
		lines.push("  )", ")");
	}
	if (plainRoots.length > 0) {
		lines.push("(allow file-write*", ...plainRoots.map((root) => `  (subpath ${sbString(root)})`), ")");
	}
	if (!allowNetwork) {
		lines.push(
			"; Network denied (Codex workspace-write default). Loopback and unix",
			"; sockets stay open for the kernel's ZMQ transport and forkserver.",
			"(deny network*)",
			"(allow network* (local unix-socket) (remote unix-socket))",
			'(allow network-outbound (remote ip "localhost:*"))',
			'(allow network-inbound (local ip "localhost:*"))',
			'(allow network-bind (local ip "localhost:*"))',
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// %%bash cell parsing (mirrors src/core/tools/ipython-cell-code.ts)
// ---------------------------------------------------------------------------

const BASH_CELL_MAGIC_PATTERN = /^(?:[ \t]*\r?\n)*[ \t]*%%bash\b[^\r\n]*(?:\r?\n|$)/;

function parseBashCellBody(code: string): string | undefined {
	const match = BASH_CELL_MAGIC_PATTERN.exec(code);
	if (!match) return undefined;
	return code.slice(match[0].length);
}

// ---------------------------------------------------------------------------
// Sandbox denial detection + host re-run
// ---------------------------------------------------------------------------

const DENIAL_PATTERNS = [
	/operation not permitted/i,
	/permission denied/i,
	/read-only file system/i,
	/PermissionError/,
	/\bEPERM\b/,
	/\bEACCES\b/,
	// Network denials (curl/pip/etc. under the network-deny profile).
	/couldn'?t connect to server/i,
	/failed to connect to .+ port/i,
	/network is unreachable/i,
	/NewConnectionError/,
];

function looksLikeSandboxDenial(text: string): boolean {
	return DENIAL_PATTERNS.some((pattern) => pattern.test(text));
}

function contentText(content: { type: string; text?: string }[]): string {
	return content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

const HOST_OUTPUT_LIMIT = 200 * 1024;

async function runOnHost(
	command: string,
	cwd: string,
	timeoutSeconds: number,
	signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("bash", ["-c", command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: process.env,
		});

		let output = "";
		let timedOut = false;
		const append = (buf: Buffer) => {
			if (output.length < HOST_OUTPUT_LIMIT) output += buf.toString();
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);

		const killTree = () => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		const timeoutHandle = setTimeout(() => {
			timedOut = true;
			killTree();
		}, timeoutSeconds * 1000);

		const onAbort = () => killTree();
		signal?.addEventListener("abort", onAbort, { once: true });

		child.on("error", (err) => {
			clearTimeout(timeoutHandle);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timeoutHandle);
			signal?.removeEventListener("abort", onAbort);
			if (timedOut) output += `\n(killed after ${timeoutSeconds}s timeout)`;
			resolvePromise({ output, exitCode: code });
		});
	});
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const PY_HINT =
	"\n[permission-boundary] This failure looks like a sandbox denial: the agent may only write inside the " +
	"configured workspace folders, and outbound network may be disabled. If this operation is genuinely needed, " +
	"run it as a `%%bash` cell — the user will then be asked to approve running it outside the sandbox.";

const NONINTERACTIVE_HINT =
	"\n[permission-boundary] Sandbox denial: writing outside the configured workspace folders is blocked, and " +
	"escalation prompts are unavailable in non-interactive mode. Work within the workspace instead.";

export default function permissionBoundary(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const config = loadConfig(cwd);
	const disabledByEnv = process.env.PRIME_AGENT_NO_BOUNDARY === "1";

	let sandboxActive = false;
	let profilePath: string | undefined;
	let setupError: string | undefined;

	// Set up the kernel wrapper synchronously at load time, before the kernel
	// can prewarm. Respect a wrapper the user already configured.
	if (config.enabled && !disabledByEnv) {
		if (process.env.PRIME_AGENT_KERNEL_WRAPPER) {
			sandboxActive = true;
		} else if (process.platform === "darwin") {
			try {
				const workspaceRoots = resolveWorkspaceRoots(config, cwd);
				const plainRoots = resolvePlainWriteRoots(config, cwd);
				profilePath = join(tmpdir(), `prime-agent-boundary-${process.pid}.sb`);
				writeFileSync(profilePath, buildSeatbeltProfile(workspaceRoots, plainRoots, config.network));
				process.env.PRIME_AGENT_KERNEL_WRAPPER = JSON.stringify(["/usr/bin/sandbox-exec", "-f", profilePath]);
				sandboxActive = true;
			} catch (e) {
				setupError = e instanceof Error ? e.message : String(e);
			}
		} else {
			setupError = `OS-level sandboxing is not implemented for ${process.platform} (macOS only for now)`;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (disabledByEnv) {
			ctx.ui.notify("permission-boundary: disabled via PRIME_AGENT_NO_BOUNDARY=1", "warning");
			return;
		}
		if (!config.enabled) {
			ctx.ui.notify("permission-boundary: disabled via config", "info");
			return;
		}
		if (!sandboxActive) {
			ctx.ui.notify(`permission-boundary: NOT ENFORCED — ${setupError ?? "unknown setup error"}`, "error");
			return;
		}
		const workspaceCount = config.workspaces.length + config.extraWritePaths.length;
		const netLabel = config.network ? "net:on" : "net:off";
		ctx.ui.setStatus("boundary", ctx.ui.theme.fg("accent", `🔒 boxed: ${workspaceCount} write root(s), ${netLabel}`));
		ctx.ui.notify(
			`permission-boundary: kernel sandboxed to ${config.workspaces.join(", ")} (writes), network ${config.network ? "allowed" : "denied"} — /permissions for details`,
			"info",
		);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!sandboxActive || config.approvalPolicy !== "on-failure") return;
		if (event.toolName !== "ipython") return;
		if (!event.isError) return;

		const code = typeof event.input.code === "string" ? event.input.code : undefined;
		if (!code) return;

		const outputText = contentText(event.content);
		if (!looksLikeSandboxDenial(outputText)) return;

		const bashBody = parseBashCellBody(code);
		const command = bashBody?.trim();
		if (!command) {
			// Python cell: no safe host re-run (kernel state), so just hint.
			return { content: [...event.content, { type: "text" as const, text: PY_HINT }] };
		}

		const rules = loadRules(ctx.cwd);
		const autoApproved = commandAllowedByRules(command, rules);

		if (!autoApproved) {
			if (!ctx.hasUI) {
				return { content: [...event.content, { type: "text" as const, text: NONINTERACTIVE_HINT }] };
			}

			const prefixes = [...new Set(splitSegments(command).map(deriveRulePrefix).filter(Boolean))];
			const prefixLabel = prefixes.join(", ");
			const DENY = "No — keep it blocked";
			const ONCE = "Yes, run outside the sandbox once";
			const ALWAYS = `Yes, and don't ask again for: ${prefixLabel}`;

			const choice = await ctx.ui.select(
				`🔒 The sandbox blocked this command (writes limited to the workspace${config.network ? "" : ", network denied"}):\n\n  ${command.split("\n").join("\n  ")}\n\nRun it OUTSIDE the sandbox with full host permissions?`,
				[DENY, ONCE, ALWAYS],
			);

			if (choice === ALWAYS) {
				saveRules(ctx.cwd, prefixes);
				ctx.ui.notify(`permission-boundary: saved rule(s): ${prefixLabel}`, "info");
			} else if (choice !== ONCE) {
				return {
					content: [
						...event.content,
						{
							type: "text" as const,
							text: "\n[permission-boundary] The user declined to run this command outside the sandbox. Do not retry it; stay within the workspace folders.",
						},
					],
				};
			}
		}

		const timeoutSeconds =
			typeof event.input.timeout === "number" && event.input.timeout > 0 ? event.input.timeout : 120;
		try {
			const result = await runOnHost(command, ctx.cwd, timeoutSeconds, ctx.signal);
			const header = autoApproved
				? `[permission-boundary] Command auto-escalated outside the sandbox (matched saved rule) and re-ran on the host (cwd: ${ctx.cwd}).`
				: `[permission-boundary] Command re-ran OUTSIDE the sandbox with user approval (cwd: ${ctx.cwd}).`;
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\n\n${result.output.trim() || "(no output)"}\n\nexit code: ${result.exitCode ?? "unknown"}`,
					},
				],
				isError: result.exitCode !== 0,
			};
		} catch (e) {
			return {
				content: [
					...event.content,
					{
						type: "text" as const,
						text: `\n[permission-boundary] Escalated host run failed to start: ${e instanceof Error ? e.message : e}`,
					},
				],
			};
		}
	});

	pi.registerCommand("permissions", {
		description: "Show permission-boundary config and saved escalation rules",
		handler: async (args, ctx) => {
			if (args.trim() === "reset-rules") {
				saveRulesReset(ctx.cwd);
				ctx.ui.notify("permission-boundary: project rules cleared", "info");
				return;
			}
			const rules = loadRules(ctx.cwd);
			const lines = [
				"Permission boundary:",
				`  status: ${sandboxActive ? "ENFORCED (kernel runs under sandbox-exec)" : `NOT ENFORCED${setupError ? ` — ${setupError}` : ""}`}`,
				`  write roots (config): ${[...config.workspaces, ...config.extraWritePaths].join(", ")}`,
				`  protected inside workspaces: .prime${config.protectGit ? ", .git" : ""} (read-only to the agent)`,
				`  network: ${config.network ? "allowed" : "denied (loopback open for the kernel)"}`,
				`  approval policy: ${config.approvalPolicy}${config.approvalPolicy === "on-failure" ? " — ask on sandbox denial (%%bash cells)" : " — never prompt"}`,
				profilePath ? `  profile: ${profilePath}` : "",
				"",
				`Saved "don't ask again" rules (run outside sandbox without prompting):`,
				rules.length ? rules.map((r) => `  - ${r}`).join("\n") : "  (none)",
				"",
				`Config: ${join(projectConfigDir(ctx.cwd), "permission-boundary.json")} (project) / ${join(getAgentDir(), "permission-boundary.json")} (global)`,
				`Rules:  ${rulesPath(ctx.cwd)} — "/permissions reset-rules" clears them`,
			].filter((line) => line !== "");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	function saveRulesReset(projectCwd: string): void {
		const path = rulesPath(projectCwd);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify({ allowOutsideSandbox: [] }, null, "\t")}\n`);
	}
}
