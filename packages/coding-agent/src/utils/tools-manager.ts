import chalk from "chalk";
import { existsSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { getBinDir } from "../config.js";
import { spawnSyncHidden } from "./child-process.js";
import { installPinnedHelperTool, UnsupportedHelperPlatformError } from "./helper-tool-install.js";
import { HELPER_TOOL_RELEASES } from "./helper-tool-releases.js";

const TOOLS_DIR = getBinDir();
const DOWNLOAD_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 5_000;
const RIPGREP_INSTALL_URL = "https://github.com/BurntSushi/ripgrep#installation";

export type ManagedTool = "fd" | "rg";

export type ToolUnavailableReason = "offline" | "manual_install_required" | "unsupported_platform" | "download_failed";

export interface ToolAvailableResult {
	status: "available";
	path: string;
}

export interface ToolUnavailableResult {
	status: "unavailable";
	reason: ToolUnavailableReason;
	platform: string;
	architecture: string;
	detail?: string;
}

export type ToolEnsureResult = ToolAvailableResult | ToolUnavailableResult;

function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

interface ToolConfig {
	name: string;
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
}

const TOOLS: Record<ManagedTool, ToolConfig> = {
	fd: {
		name: "fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
	},
	rg: {
		name: "ripgrep",
		binaryName: "rg",
	},
};

// Check that a command both launches and reports a successful version.
function commandWorks(cmd: string): boolean {
	try {
		const result = spawnSyncHidden(cmd, ["--version"], { stdio: "pipe", timeout: COMMAND_TIMEOUT_MS });
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ManagedTool): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath) && commandWorks(localPath)) {
		return localPath;
	}

	// Check system PATH - if found, just return the command name (it's in PATH)
	const systemBinaryNames = config.systemBinaryNames ?? [config.binaryName];
	for (const systemBinaryName of systemBinaryNames) {
		if (commandWorks(systemBinaryName)) {
			return systemBinaryName;
		}
	}

	return null;
}

// Download the pinned release, verify its digest, and install it into TOOLS_DIR.
async function downloadTool(tool: ManagedTool): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const binaryFileName = config.binaryName + (plat === "win32" ? ".exe" : "");
	return installPinnedHelperTool({
		tool,
		platform: plat,
		architecture: arch(),
		destDir: TOOLS_DIR,
		binaryFileName,
		verifyBinary: commandWorks,
		timeoutMs: DOWNLOAD_TIMEOUT_MS,
	});
}

// Termux package names for tools
const TERMUX_PACKAGES: Record<string, string> = {
	fd: "fd",
	rg: "ripgrep",
};

function getRipgrepInstallHint(platformName: string): string {
	switch (platformName) {
		case "darwin":
			return "Install it with: brew install ripgrep";
		case "linux":
			return `Install it with your package manager (for example, sudo apt install ripgrep or sudo dnf install ripgrep). See ${RIPGREP_INSTALL_URL}`;
		case "win32":
			return "Install it with: winget install BurntSushi.ripgrep.MSVC";
		case "android":
			return "Install it with: pkg install ripgrep";
		default:
			return `Install ripgrep manually: ${RIPGREP_INSTALL_URL}`;
	}
}

export function formatMissingRipgrepMessage(result: ToolUnavailableResult): string {
	let reason: string;
	switch (result.reason) {
		case "offline":
			reason = "Automatic installation was skipped because PI_OFFLINE is enabled.";
			break;
		case "manual_install_required":
			reason = "Prime Agent cannot install this helper automatically in Termux.";
			break;
		case "unsupported_platform":
			reason = `Automatic installation is unavailable for ${result.platform}/${result.architecture}.`;
			break;
		case "download_failed": {
			const detail = result.detail?.replace(/\s+/g, " ").trim();
			reason = detail
				? `Prime Agent could not install it automatically: ${detail}`
				: "Prime Agent could not install it automatically.";
			break;
		}
	}

	return [
		"ripgrep (rg) is an optional search helper. Without it, model-run file searches may be slower or fail; Prime Agent and subagents remain available.",
		reason,
		getRipgrepInstallHint(result.platform),
	].join("\n");
}

// Ensure a tool is available, downloading if necessary, and retain why provisioning failed.
export async function ensureToolWithStatus(tool: ManagedTool, silent: boolean = true): Promise<ToolEnsureResult> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return { status: "available", path: existingPath };
	}

	const config = TOOLS[tool];
	const platformName = platform();
	const architecture = arch();

	if (isOfflineModeEnabled()) {
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Offline mode enabled, skipping download.`));
		}
		return { status: "unavailable", reason: "offline", platform: platformName, architecture };
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (platformName === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			console.log(chalk.yellow(`${config.name} not found. Install with: pkg install ${pkgName}`));
		}
		return {
			status: "unavailable",
			reason: "manual_install_required",
			platform: platformName,
			architecture,
		};
	}

	// Tool not found - download the pinned release
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading ${HELPER_TOOL_RELEASES[tool].version}...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return { status: "available", path };
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return {
			status: "unavailable",
			reason: e instanceof UnsupportedHelperPlatformError ? "unsupported_platform" : "download_failed",
			platform: platformName,
			architecture,
			detail: e instanceof Error ? e.message : String(e),
		};
	}
}

// Compatibility wrapper for callers that only need the resolved executable path.
export async function ensureTool(tool: ManagedTool, silent: boolean = true): Promise<string | undefined> {
	const result = await ensureToolWithStatus(tool, silent);
	return result.status === "available" ? result.path : undefined;
}
