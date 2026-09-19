import chalk from "chalk";
import { spawnSyncHidden } from "../utils/child-process.js";

/**
 * First-class Tailscale support for prime-agent (the "out of the box" tailnet moment).
 *
 * Three patterns, one command group:
 *   status - is this machine on a tailnet, what is its MagicDNS name, what is served/funneled
 *   serve  - expose a local port on your tailnet (wraps `tailscale serve`, --funnel for public)
 *   doctor - the same detection surfaced in `prime-agent doctor`
 *
 * The TUI itself is local-first (it renders in your terminal over the daemon's
 * unix socket), so "reach your agent from anywhere" is the Tailscale-SSH
 * pattern documented in docs/tailscale.md; `serve` covers exposing any local
 * bridge/API port on the tailnet.
 */

interface TailscaleProbe {
	/** Absolute path of the `tailscale` CLI on PATH, or null when absent. */
	cliPath: string | null;
	/** True when this node is up on a tailnet right now. */
	onTailnet: boolean;
	/** The tailnet's MagicDNS suffix (e.g. "tailnet-name.ts.net."), or null. */
	magicDnsSuffix: string | null;
	/** This node's tailnet hostname (without the suffix), or null. */
	hostname: string | null;
	/** True when the backend is Running but the node is not online right now. */
	offlineButUp?: boolean;
	/** The raw error line when the CLI exists but reports a failure, or null. */
	error: string | null;
}

interface TailscaleStatusJson {
	Self?: { Online?: boolean; HostName?: string; DNSName?: string };
	MagicDNSSuffix?: string;
	CurrentTailnet?: { MagicDNSSuffix?: string };
	BackendState?: string;
}

/** Run the tailscale CLI once, returning stdout or an error descriptor. */
function runTailscale(args: string[]): { code: number; stdout: string; stderr: string } {
	const result = spawnSyncHidden("tailscale", args, { encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
	if (result.error) {
		return { code: -1, stdout: "", stderr: result.error.message };
	}
	return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Detect the CLI and, when present, this node's tailnet state. */
export function probeTailscale(): TailscaleProbe {
	// Node's own ENOENT detection - no `which` binary needed (absent on Windows shells).
	const version = spawnSyncHidden("tailscale", ["version"], {
		encoding: "utf8",
		timeout: 15000,
		killSignal: "SIGKILL",
	});
	if (version.error) {
		// ENOENT = genuinely absent; anything else (EACCES, ETIMEDOUT, hung CLI) is
		// an installed-but-unusable CLI and must say so instead of "not found".
		if ((version.error as NodeJS.ErrnoException).code === "ENOENT") {
			return { cliPath: null, onTailnet: false, magicDnsSuffix: null, hostname: null, error: null };
		}
		return {
			cliPath: "tailscale",
			onTailnet: false,
			magicDnsSuffix: null,
			hostname: null,
			error: `tailscale CLI could not be run (${(version.error as NodeJS.ErrnoException).code ?? "unknown error"})`,
		};
	}
	const cliPath = "tailscale";
	const status = runTailscale(["status", "--json"]);
	if (status.code !== 0) {
		const firstLine = status.stderr.split("\n")[0]?.trim();
		return {
			cliPath,
			onTailnet: false,
			magicDnsSuffix: null,
			hostname: null,
			error: firstLine || "tailscale status failed with no diagnostic",
		};
	}
	try {
		const parsed = JSON.parse(status.stdout) as TailscaleStatusJson;
		// BackendState distinguishes a stopped/logged-out daemon from a node that
		// is up but temporarily unreachable; only Running serves.
		const backend = parsed.BackendState ?? "";
		const onTailnet = parsed.Self?.Online === true || backend === "Running";
		const dnsName = parsed.Self?.DNSName ?? parsed.Self?.HostName ?? null;
		// Top-level MagicDNSSuffix is deprecated upstream; prefer CurrentTailnet's.
		const suffix = parsed.CurrentTailnet?.MagicDNSSuffix ?? parsed.MagicDNSSuffix ?? null;
		let hostname = dnsName ? dnsName.replace(/\.+$/, "") : null;
		if (hostname && suffix) {
			const trimmedSuffix = suffix.replace(/\.+$/, "");
			if (hostname.endsWith(`.${trimmedSuffix}`)) {
				hostname = hostname.slice(0, -(trimmedSuffix.length + 1));
			}
		}
		return {
			cliPath,
			onTailnet,
			magicDnsSuffix: suffix,
			hostname,
			offlineButUp: backend === "Running" && parsed.Self?.Online === false,
			error: null,
		};
	} catch (err) {
		return {
			cliPath,
			onTailnet: false,
			magicDnsSuffix: null,
			hostname: null,
			error: `unparseable status output: ${String(err)}`,
		};
	}
}

export type TailscaleArgs =
	| { kind: "serve"; port: number; funnel: boolean }
	| { kind: "status"; json: boolean }
	| { kind: "error"; message: string };

/** Parse `prime-agent tailscale ...` argv into a mode, port, funnel, and json flag. */
export function parseTailscaleArgs(args: string[]): TailscaleArgs {
	const json = args.includes("--json");
	const rest = args.filter((arg) => arg !== "--json");
	if (rest.length === 0 || (rest.length === 1 && rest[0] === "status")) {
		return { kind: "status", json };
	}
	let port: number | null = null;
	let funnel = false;
	let sawServe = false;
	let sawStatus = false;
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index] as string;
		if (token === "serve") {
			if (sawServe || sawStatus) {
				return { kind: "error", message: `tailscale: ${token} appears more than once` };
			}
			sawServe = true;
			continue;
		}
		if (token === "status") {
			if (sawStatus || sawServe) {
				return { kind: "error", message: `tailscale: ${token} appears more than once` };
			}
			sawStatus = true;
			continue;
		}
		if (token === "--funnel") {
			if (funnel) {
				return { kind: "error", message: "tailscale: --funnel appears more than once" };
			}
			funnel = true;
			continue;
		}
		if (token === "--port" || token.startsWith("--port=")) {
			if (port !== null) {
				return { kind: "error", message: "tailscale: --port appears more than once" };
			}
			const value = token.startsWith("--port=") ? token.slice("--port=".length) : rest[++index];
			const parsed = Number(value);
			if (value === undefined || Number.isNaN(parsed)) {
				return { kind: "error", message: "--port requires a numeric value (1-65535)" };
			}
			port = parsed;
			continue;
		}
		if (token.startsWith("-")) {
			return { kind: "error", message: `tailscale: unrecognized option ${token}` };
		}
		return { kind: "error", message: `tailscale: unexpected argument ${token}` };
	}
	if (sawStatus) {
		if (port !== null || funnel) {
			return { kind: "error", message: "tailscale: status takes no serve flags" };
		}
		return { kind: "status", json };
	}
	if (sawServe || port !== null || funnel) {
		if (port === null) {
			return {
				kind: "error",
				message: "tailscale serve requires --port <n> (the LOCAL port to expose); refusing to guess a default",
			};
		}
		return { kind: "serve", port, funnel };
	}
	return { kind: "error", message: `tailscale: unknown subcommand ${rest[0]}` };
}

/** Print the tailnet overview (human or `--json` form). Exits non-zero when Tailscale is unusable. */
export function runTailscaleStatus(json = false): number {
	const probe = probeTailscale();
	if (json) {
		console.log(tailscaleStatusJson(probe));
		return probe.cliPath === null || !probe.onTailnet || probe.error !== null ? 1 : 0;
	}
	if (probe.error) {
		console.log(chalk.red(`tailscale reported a problem: ${probe.error}`));
		return 1;
	}
	if (probe.cliPath === null) {
		console.log(chalk.yellow("tailscale CLI not found on PATH"));
		console.log("Install Tailscale: https://tailscale.com/download");
		return 1;
	}
	if (!probe.onTailnet) {
		if (probe.offlineButUp) {
			console.log(chalk.yellow("This node is up on a tailnet but currently offline - check connectivity"));
		} else {
			console.log(chalk.yellow("Tailscale is installed but this machine is not up on a tailnet"));
			console.log("Run `tailscale up` first (or log in), then retry.");
		}
		return 1;
	}
	console.log(
		`${chalk.bold("Tailnet")}: ${probe.offlineButUp ? "up (currently offline)" : "on (this machine is online)"}`,
	);
	console.log(`${chalk.bold("MagicDNS suffix")}: ${probe.magicDnsSuffix ?? "unknown"}`);
	console.log(`${chalk.bold("This node")}: ${probe.hostname ?? "unknown"}`);
	const serve = runTailscale(["serve", "status", "--json"]);
	if (serve.code !== 0) {
		console.log(
			chalk.yellow(`tailscale serve status failed (exit ${serve.code}); served-local status is unavailable`),
		);
		return 1;
	}
	try {
		const parsed = JSON.parse(serve.stdout) as {
			TCP?: Record<string, { TCPForward?: string }>;
			Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Path?: string; Text?: string }> }>;
		};
		const rows: string[] = [];
		for (const [listen, entry] of Object.entries(parsed.TCP ?? {})) {
			rows.push(`  ${listen} -> ${entry.TCPForward ?? "tcp"}`);
		}
		for (const [listen, server] of Object.entries(parsed.Web ?? {})) {
			for (const [path, handler] of Object.entries(server.Handlers ?? {})) {
				const target = handler.Proxy ?? handler.Path ?? handler.Text ?? "static";
				rows.push(`  ${listen}${path} -> ${target}`);
			}
		}
		if (rows.length > 0) {
			console.log(`${chalk.bold("Served locally")}:`);
			for (const row of rows) {
				console.log(row);
			}
		} else {
			console.log(`${chalk.bold("Served locally")}: nothing (see docs/tailscale.md)`);
		}
	} catch {
		console.log(`${chalk.bold("Served locally")}: (unparseable status)`);
	}
	return 0;
}

/** Machine-readable status for `--json`. */
function tailscaleStatusJson(probe = probeTailscale()): string {
	return JSON.stringify(
		{
			cli: probe.cliPath,
			onTailnet: probe.onTailnet,
			offlineButUp: probe.offlineButUp ?? false,
			magicDnsSuffix: probe.magicDnsSuffix,
			hostname: probe.hostname,
			error: probe.error,
		},
		null,
		2,
	);
}

/**
 * Expose a local port on the tailnet: `tailscale serve --bg localhost:<port>`
 * (or `tailscale funnel --bg localhost:<port>` with --funnel for public access).
 * Returns the exit code and prints the next steps.
 */
export function runTailscaleServe(port: number, funnel: boolean): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		console.log(chalk.red(`--port must be 1-65535, got ${port}`));
		return 1;
	}
	const probe = probeTailscale();
	if (probe.error) {
		console.log(chalk.red(`tailscale status failed: ${probe.error}`));
		return 1;
	}
	if (probe.cliPath === null) {
		console.log(chalk.yellow("tailscale CLI not found on PATH"));
		console.log("Install Tailscale: https://tailscale.com/download");
		return 1;
	}
	if (!probe.onTailnet) {
		console.log(chalk.yellow("This machine is not up on a tailnet (run `tailscale up` first)"));
		return 1;
	}
	if (probe.offlineButUp) {
		console.log(
			chalk.yellow("This node is up on a tailnet but currently offline - restore connectivity before serving"),
		);
		return 1;
	}
	const target = `localhost:${port}`;
	const args = funnel ? ["funnel", "--bg", target] : ["serve", "--bg", target];
	console.log(`Running tailscale ${args.join(" ")} ...`);
	// stdin inherited: funnel's first enable prompts interactively; timeout bounds a hung tailscaled.
	const result = spawnSyncHidden("tailscale", args, {
		encoding: "utf8" as const,
		stdio: "inherit",
		timeout: 60000,
		killSignal: "SIGKILL",
	});
	if (result.status !== 0) {
		console.log(chalk.red("tailscale did not accept the serve/funnel command (see its output above)"));
		return result.status ?? 1;
	}
	// tailscale can exit 0 after only printing an interactive enable URL (enableFeatureInteractive)
	// without configuring anything; verify the target is really being served, matching the
	// local endpoint EXACTLY (port 80 must not match localhost:8000).
	const verify = runTailscale(["serve", "status", "--json"]);
	if (verify.code !== 0) {
		console.log(chalk.red(`post-serve verification failed: tailscale serve status exited ${verify.code}`));
		return 1;
	}
	let servedExactly = false;
	let funnelEnabled = false;
	try {
		const parsedVerify = JSON.parse(verify.stdout) as {
			TCP?: Record<string, { TCPForward?: string }>;
			Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
			AllowFunnel?: Record<string, boolean>;
		};
		for (const entry of Object.values(parsedVerify.TCP ?? {})) {
			if (entry.TCPForward === `127.0.0.1:${port}` || entry.TCPForward === `localhost:${port}`) {
				servedExactly = true;
			}
		}
		for (const [listen, server] of Object.entries(parsedVerify.Web ?? {})) {
			for (const handler of Object.values(server.Handlers ?? {})) {
				if (!handler.Proxy) {
					continue;
				}
				try {
					const target = new URL(handler.Proxy);
					// URL.port is "" for default ports (80 for http:, 443 for https:).
					const targetPort = target.port === "" ? (target.protocol === "https:" ? 443 : 80) : Number(target.port);
					if (targetPort === port && ["127.0.0.1", "localhost", "::1"].includes(target.hostname)) {
						servedExactly = true;
						if (parsedVerify.AllowFunnel?.[listen] === true) {
							funnelEnabled = true;
						}
					}
				} catch {
					// unparseable proxy target - cannot confirm; keep searching
				}
			}
		}
	} catch {
		servedExactly = false;
	}
	if (!servedExactly) {
		console.log(
			chalk.yellow(
				"tailscale exited 0 but the target does not appear in `tailscale serve status` - an interactive enable flow (URL printed above) may still be pending; re-run this command after enabling.",
			),
		);
		return 1;
	}
	if (funnel && !funnelEnabled) {
		console.log(
			chalk.yellow(
				"the local target is served, but `tailscale serve status` reports the endpoint as NOT funnel-enabled - check your tailnet funnel ACL and the enable URL printed above, then re-run.",
			),
		);
		return 1;
	}
	console.log("");
	if (probe.hostname) {
		const suffix = probe.magicDnsSuffix?.replace(/\.+$/, "") ?? "ts.net";
		// Exact domain-suffix match: the hostname must end with ".<suffix>" (or equal it).
		const host =
			probe.hostname.endsWith(`.${suffix}`) || probe.hostname === suffix
				? probe.hostname
				: `${probe.hostname}.${suffix}`;
		console.log(chalk.green(`Now reachable on your tailnet as ${host}`));
		if (funnel) {
			console.log(`Public URL: https://${host}/`);
		}
	}
	console.log("Stop with: tailscale serve status, then tailscale serve off (or funnel off)");
	return 0;
}

/** One-line doctor facts for `prime-agent doctor` to include in its report. */
export function tailscaleDoctorFacts(): string[] {
	const probe = probeTailscale();
	if (probe.error) return [`tailscale: CLI present but erroring (${probe.error})`];
	if (probe.cliPath === null)
		return ["tailscale: CLI not found (optional; install from https://tailscale.com/download)"];
	if (!probe.onTailnet) return ["tailscale: installed but not up on a tailnet (tailscale up)"];
	const offline = probe.offlineButUp ? " (currently offline)" : "";
	return [
		`tailscale: on tailnet (node ${probe.hostname ?? "unknown"}, MagicDNS ${probe.magicDnsSuffix ?? "unknown"}${offline})`,
	];
}
