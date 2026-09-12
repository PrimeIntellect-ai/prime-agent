#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	linkSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readNativeInstallation } from "../utils/native-installation.js";
import { comparePackageVersions } from "../utils/version-check.js";

const entrypoint = fileURLToPath(import.meta.url);
const packageDir = resolve(dirname(entrypoint), "../..");
const args = process.argv.slice(2);
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const retryDelayMs = 86400000;
const informationalFlags = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);

function isForegroundMigration(): boolean {
	if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return false;
	if (args[0] === "help" || args.some((arg) => informationalFlags.has(arg))) return false;
	if (args.includes("--print") || args.includes("-p") || args.includes("--json")) return false;
	if (args.includes("--mode")) return false;
	if (
		args.includes("--internal-update-restart-coordinator") ||
		process.env.PRIME_AGENT_INTERNAL_DAEMON_WORKER ||
		process.env.PRIME_AGENT_INTERNAL_DAEMON_CATALOG ||
		process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER ||
		process.env.PRIME_AGENT_INTERACTIVE_SELF_UPDATE ||
		process.env.PI_STARTUP_BENCHMARK
	)
		return false;
	return true;
}

function wasRecordedRecently(path: string): boolean {
	try {
		return Date.now() - Number(readFileSync(path, "utf8")) < retryDelayMs;
	} catch {
		return false;
	}
}

function recordNow(path: string): void {
	try {
		writeFileSync(path, String(Date.now()));
	} catch {
		// Read-only package prefixes can still use the bundled Node application.
	}
}

function reportProbeFailure(message: string): void {
	const diagnosticFile = join(packageDir, "dist/.native-migration-diagnostic");
	if (process.env.PRIME_AGENT_MIGRATE_RETRY !== "1" && wasRecordedRecently(diagnosticFile)) return;
	recordNow(diagnosticFile);
	console.error(
		`prime-agent: ${message} Reinstall prime-agent, or set PRIME_AGENT_INSTALL_METHOD=node to keep using Node without migration.`,
	);
}

interface InstallerResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	parentSignal?: (typeof signals)[number];
	error?: Error;
}

function runInstaller(command: string, version: string, environment: NodeJS.ProcessEnv): Promise<InstallerResult> {
	return new Promise((resolveResult) => {
		const child = spawn("sh", [command, version], {
			env: environment,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		child.stdout.pipe(process.stderr, { end: false });
		child.stderr.pipe(process.stderr, { end: false });
		let parentSignal: (typeof signals)[number] | undefined;
		let forceTimer: NodeJS.Timeout | undefined;
		let settled = false;
		const terminate = (signal: NodeJS.Signals) => {
			try {
				process.kill(-child.pid!, signal);
			} catch {
				child.kill(signal);
			}
		};
		const handlers = signals.map((signal) => {
			const handler = () => {
				parentSignal ??= signal;
				terminate(signal);
				forceTimer ??= setTimeout(() => terminate("SIGKILL"), 1000);
				forceTimer.unref();
			};
			process.on(signal, handler);
			return handler;
		});
		const timeout = setTimeout(() => {
			terminate("SIGTERM");
			forceTimer = setTimeout(() => terminate("SIGKILL"), 1000);
			forceTimer.unref();
		}, 450000);
		const finish = (result: InstallerResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceTimer) clearTimeout(forceTimer);
			for (const [index, signal] of signals.entries()) process.removeListener(signal, handlers[index]);
			resolveResult({ ...result, parentSignal });
		};
		child.once("error", (error) => finish({ status: null, signal: null, error }));
		child.once("close", (status, signal) => finish({ status, signal }));
	});
}

async function migrationTarget(): Promise<string | undefined> {
	if (process.platform !== "darwin" && process.platform !== "linux") return undefined;
	if (process.env.PRIME_AGENT_INSTALL_METHOD === "node") return undefined;
	// Only the public release package in a conventional global npm prefix owns this command.
	const packageParent = dirname(packageDir);
	const modules = basename(packageParent).startsWith("@") ? dirname(packageParent) : packageParent;
	if (
		basename(modules) !== "node_modules" ||
		basename(dirname(modules)) !== "lib" ||
		/[/\\]Cellar[/\\]/.test(packageDir)
	)
		return undefined;
	const metadata = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
		version: string;
		bin: Record<string, string>;
	};
	const commandName = Object.keys(metadata.bin)[0];
	if (!commandName || basename(commandName) !== commandName) return undefined;
	const publicCommand = join(dirname(dirname(modules)), "bin", commandName);
	const commandIdentity = lstatSync(publicCommand);
	const commandTarget = commandIdentity.isSymbolicLink() ? readlinkSync(publicCommand) : undefined;
	const entryIdentity = statSync(entrypoint);
	const root =
		process.env.PRIME_AGENT_INSTALL_DIR ||
		join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "prime-agent");
	let native = readNativeInstallation(root);
	const ownsPackageLink = realpathSync(publicCommand) === realpathSync(entrypoint);
	if (!ownsPackageLink && (!native || realpathSync(publicCommand) !== native.executable)) return undefined;
	if (ownsPackageLink && !isForegroundMigration()) return undefined;
	const needsInstall = !native || (comparePackageVersions(native.version, metadata.version) ?? -1) < 0;
	if (needsInstall && (!isForegroundMigration() || process.env.PI_OFFLINE || args.includes("--offline")))
		return undefined;
	const platform = spawnSync("sh", [join(packageDir, "dist/install.sh"), "--native-platform"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 3000,
	});
	if (platform.status !== 0) {
		// Exit 1 is the installer's expected signal for an unsupported host.
		if (platform.status !== 1 || platform.error || platform.signal)
			reportProbeFailure("the native platform check failed unexpectedly.");
		return undefined;
	}
	if (needsInstall) {
		const retryFile = join(packageDir, "dist/.native-migration-attempt");
		if (process.env.PRIME_AGENT_MIGRATE_RETRY !== "1" && wasRecordedRecently(retryFile)) return undefined;
		// Confirm the npm package is writable before downloading; read-only prefixes stay on Node.
		writeFileSync(retryFile, String(Date.now()));
		const release = JSON.parse(readFileSync(join(packageDir, "dist/native-release.json"), "utf8")) as {
			baseUrl: string;
		};
		console.error(`prime-agent: migrating ${metadata.version} from npm to the compiled application...`);
		const result = await runInstaller(join(packageDir, "dist/install.sh"), metadata.version, {
			...process.env,
			PRIME_AGENT_INSTALL_METHOD: "binary",
			PRIME_AGENT_INSTALL_DIR: root,
			PRIME_AGENT_EXPECTED_CURRENT: native ? relative(join(native.root, "bin"), native.executable) : "",
			PRIME_AGENT_DOWNLOAD_BASE_URL: release.baseUrl,
			PRIME_AGENT_INSTALL_LINK: "0",
			PRIME_AGENT_INSTALLER_NONINTERACTIVE: "1",
			PRIME_AGENT_INSTALLER_PLAIN: "1",
			PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL: "0",
		});
		if (result.parentSignal) {
			rmSync(retryFile, { force: true });
			process.kill(process.pid, result.parentSignal);
			return undefined;
		}
		if (result.status !== 0) {
			recordNow(retryFile);
			const detail = result.error ? ` (${result.error.message})` : "";
			console.error(
				`prime-agent: compiled migration deferred${detail}; continuing with the installed Node application. Retry with PRIME_AGENT_MIGRATE_RETRY=1.`,
			);
			return undefined;
		}
		rmSync(retryFile, { force: true });
		native = readNativeInstallation(root);
		if (!native || native.version !== metadata.version) {
			recordNow(retryFile);
			reportProbeFailure("the compiled installer completed without activating the requested version.");
			return undefined;
		}
	}
	if (!native) return undefined;
	if (platform.stdout.trim() !== native.platform) {
		reportProbeFailure(
			`the native platform check returned ${JSON.stringify(platform.stdout.trim())}, but the installed release requires ${JSON.stringify(native.platform)}.`,
		);
		return undefined;
	}
	const probe = spawnSync(native.executable, ["--version"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: 3000,
	});
	if (probe.status !== 0) {
		reportProbeFailure("the compiled executable failed its version check.");
		return undefined;
	}
	if (probe.stdout.trim() !== native.version) {
		reportProbeFailure(
			`the compiled executable reports ${JSON.stringify(probe.stdout.trim())}, but its release metadata requires ${JSON.stringify(native.version)}.`,
		);
		return undefined;
	}
	if (!ownsPackageLink) return native.launcher;
	// Capture the link, then create exclusively so a concurrent npm install cannot be overwritten.
	const staging = mkdtempSync(join(dirname(publicCommand), ".prime-agent-link-"));
	const captured = join(staging, "command");
	let needsRestore = false;
	let capturedOwned = false;
	try {
		renameSync(publicCommand, captured);
		needsRestore = true;
		const capturedIdentity = lstatSync(captured);
		capturedOwned =
			capturedIdentity.dev === commandIdentity.dev &&
			capturedIdentity.ino === commandIdentity.ino &&
			capturedIdentity.mtimeMs === commandIdentity.mtimeMs &&
			commandTarget !== undefined &&
			capturedIdentity.isSymbolicLink() &&
			readlinkSync(captured) === commandTarget;
		const currentEntry = statSync(entrypoint);
		if (
			!capturedOwned ||
			currentEntry.dev !== entryIdentity.dev ||
			currentEntry.ino !== entryIdentity.ino ||
			currentEntry.mtimeMs !== entryIdentity.mtimeMs ||
			currentEntry.size !== entryIdentity.size
		)
			return undefined;
		symlinkSync(native.launcher, publicCommand);
		needsRestore = false;
		return native.launcher;
	} finally {
		if (needsRestore) {
			try {
				if (lstatSync(captured).isSymbolicLink()) symlinkSync(readlinkSync(captured), publicCommand);
				else linkSync(captured, publicCommand);
				needsRestore = false;
			} catch (error) {
				if (capturedOwned && error instanceof Error && "code" in error && error.code === "EEXIST")
					needsRestore = false;
			}
		}
		if (needsRestore)
			console.error(`prime-agent: command handoff deferred; the displaced command is preserved at ${captured}`);
		else rmSync(staging, { recursive: true, force: true });
	}
}

let target: string | undefined;
try {
	target = await migrationTarget();
} catch {
	// Read-only prefixes and package-manager wrappers keep the bundled Node route.
}
const fallback = join(dirname(entrypoint), "cli-node.js");
if (!target && !existsSync(fallback)) throw new Error("Missing Node fallback entrypoint");
const child = spawn(target ?? process.execPath, target ? args : [...process.execArgv, fallback, ...args], {
	stdio: "inherit",
});
const handlers = signals.map((signal) => {
	const handler = () => {
		child.kill(signal);
	};
	process.on(signal, handler);
	return handler;
});
child.on("error", (error) => {
	console.error(error.message);
	process.exitCode = 1;
});
child.on("exit", (code, signal) => {
	for (const [index, name] of signals.entries()) process.removeListener(name, handlers[index]);
	if (signal) process.kill(process.pid, signal);
	else process.exitCode = code ?? 1;
});
