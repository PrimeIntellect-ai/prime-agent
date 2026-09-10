/**
 * Global, environment-scoped startup notices (app update, extension updates, tmux setup).
 *
 * These are not tied to any single conversation, so they are surfaced on the agents
 * view rather than appended to a session's chat stream. The checks and styled
 * formatters live here so both the agents view and the interactive fallback render
 * identical wording.
 */

import { DefaultPackageManager } from "../../core/package-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import { spawnHidden } from "../../utils/child-process.js";
import { checkForNewPiVersion } from "../../utils/version-check.js";
import { theme } from "../interactive/theme/theme.js";

export interface StartupNotices {
	/** Newer Prime Agent version available, if any. */
	newVersion?: string;
	/** Display names of extensions with available updates. */
	packageUpdates: string[];
	/** tmux keyboard setup warning, if the current tmux config is suboptimal. */
	tmuxWarning?: string;
}

export interface StartupNoticeCheckOptions {
	version: string;
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}

/** Run every startup check in parallel and collect the results. */
export async function gatherStartupNotices(options: StartupNoticeCheckOptions): Promise<StartupNotices> {
	const [newVersion, packageUpdates, tmuxWarning] = await Promise.all([
		checkForNewPiVersion(options.version),
		checkForPackageUpdates(options),
		checkTmuxKeyboardSetup(),
	]);
	return { newVersion, packageUpdates, tmuxWarning };
}

export async function checkForPackageUpdates(options: {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
}): Promise<string[]> {
	if (process.env.PI_OFFLINE) {
		return [];
	}

	try {
		const packageManager = new DefaultPackageManager({
			cwd: options.cwd,
			agentDir: options.agentDir,
			settingsManager: options.settingsManager,
		});
		const updates = await packageManager.checkForAvailableUpdates();
		return updates.map((update) => update.displayName);
	} catch {
		return [];
	}
}

export async function checkTmuxKeyboardSetup(): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;

	const runTmuxShow = (option: string): Promise<string | undefined> => {
		return new Promise((resolve) => {
			const proc = spawnHidden("tmux", ["show", "-gv", option], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			let stdout = "";
			const timer = setTimeout(() => {
				proc.kill();
				resolve(undefined);
			}, 2000);

			proc.stdout?.on("data", (data) => {
				stdout += data.toString();
			});
			proc.on("error", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
			proc.on("close", (code) => {
				clearTimeout(timer);
				resolve(code === 0 ? stdout.trim() : undefined);
			});
		});
	};

	const [extendedKeys, extendedKeysFormat] = await Promise.all([
		runTmuxShow("extended-keys"),
		runTmuxShow("extended-keys-format"),
	]);

	// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
	if (extendedKeys === undefined) return undefined;

	if (extendedKeys !== "on" && extendedKeys !== "always") {
		return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
	}

	if (extendedKeysFormat === "xterm") {
		return "tmux extended-keys-format is xterm. Pi works best with csi-u. Add `set -g extended-keys-format csi-u` to ~/.tmux.conf and restart tmux.";
	}

	return undefined;
}

export function formatUpdateAvailableNotice(newVersion: string): string {
	return (
		`${theme.bold(theme.fg("accent", "Update available:"))} ` +
		`${theme.fg("muted", `v${newVersion}. Run `)}${theme.fg("accent", "/update")}`
	);
}

export function formatPackageUpdateNotice(packages: string[]): string {
	const packageList = packages.join(", ");
	return (
		`${theme.bold(theme.fg("warning", "Package updates available:"))} ` +
		`${theme.fg("muted", `${packageList}. Run `)}${theme.fg("accent", "/update --extensions")}`
	);
}

export function formatTmuxWarningNotice(message: string): string {
	return theme.fg("warning", `⚠ ${message}`);
}
