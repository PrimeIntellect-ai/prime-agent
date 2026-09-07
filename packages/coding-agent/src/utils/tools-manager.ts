import chalk from "chalk";
import extractZip from "extract-zip";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "fs";
import { arch, platform } from "os";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { APP_NAME, getBinDir } from "../config.js";
import { spawnSyncHidden } from "./child-process.js";

const TOOLS_DIR = getBinDir();
const NETWORK_TIMEOUT_MS = 10_000;
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
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	systemBinaryNames?: string[]; // Alternative system command names to try before downloading
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		systemBinaryNames: ["fd", "fdfind"],
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return architecture === "x64" ? `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz` : null;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : architecture === "x64" ? "x86_64" : null;
				if (!archStr) return null;
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
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

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
		signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
	});

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	await pipeline(Readable.fromWeb(response.body as any), fileStream);
}

function findBinaryRecursively(rootDir: string, binaryFileName: string): string | null {
	const stack: string[] = [rootDir];

	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;

		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) {
				return fullPath;
			}
			if (entry.isDirectory()) {
				stack.push(fullPath);
			}
		}
	}

	return null;
}

// Download and install a tool
class UnsupportedToolPlatformError extends Error {}

async function downloadTool(tool: ManagedTool): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	if (!config.getAssetName("VERSION", plat, architecture)) {
		throw new UnsupportedToolPlatformError(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Get latest version and the matching platform asset.
	const version = await getLatestVersion(config.repo);
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) throw new UnsupportedToolPlatformError(`Unsupported platform: ${plat}/${architecture}`);

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp directory. fd and rg downloads can run concurrently
	// during startup, so sharing a fixed directory causes races.
	const extractDir = join(
		TOOLS_DIR,
		`extract_tmp_${config.binaryName}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			const extractResult = spawnSyncHidden("tar", ["xzf", archivePath, "-C", extractDir], { stdio: "pipe" });
			if (extractResult.error || extractResult.status !== 0) {
				const errMsg = extractResult.error?.message ?? extractResult.stderr?.toString().trim() ?? "unknown error";
				throw new Error(`Failed to extract ${assetName}: ${errMsg}`);
			}
		} else if (assetName.endsWith(".zip")) {
			await extractZip(archivePath, { dir: extractDir });
		} else {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		// Find the binary in extracted files. Some archives contain files directly
		// at root, others nest under a versioned subdirectory.
		const binaryFileName = config.binaryName + binaryExt;
		const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
		const extractedBinaryCandidates = [join(extractedDir, binaryFileName), join(extractDir, binaryFileName)];
		let extractedBinary = extractedBinaryCandidates.find((candidate) => existsSync(candidate));

		if (!extractedBinary) {
			extractedBinary = findBinaryRecursively(extractDir, binaryFileName) ?? undefined;
		}

		if (extractedBinary) {
			rmSync(binaryPath, { force: true });
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: expected ${binaryFileName} under ${extractDir}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
		if (!commandWorks(binaryPath)) {
			rmSync(binaryPath, { force: true });
			throw new Error(`Installed ${config.name} binary failed its version check`);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
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

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
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
			reason: e instanceof UnsupportedToolPlatformError ? "unsupported_platform" : "download_failed",
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
