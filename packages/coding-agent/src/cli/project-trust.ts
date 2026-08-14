import { dirname } from "node:path";
import { type ProjectTrustSelection, parseDefaultProjectTrust, resolveProjectTrusted } from "../core/project-trust.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { ProjectTrustStore } from "../core/trust-manager.js";
import { canonicalizeDirectory } from "../utils/paths.js";

export interface ProjectTrustPromptOption {
	value: ProjectTrustSelection;
	label: string;
}

export interface ResolveCliProjectTrustOptions {
	cwd: string;
	agentDir: string;
	settingsManager: SettingsManager;
	trustOverride?: boolean;
	interactive: boolean;
	select?: (options: readonly ProjectTrustPromptOption[]) => Promise<ProjectTrustSelection | undefined>;
	onDiagnostic?: (message: string) => void;
}

export function createProjectTrustPromptOptions(cwd: string): readonly ProjectTrustPromptOption[] {
	// Matches the key resolveProjectTrusted stores for "trust-parent", so the label names the
	// directory that is actually trusted even when cwd is reached through a symlink.
	const parentCwd = dirname(canonicalizeDirectory(cwd));
	return [
		{ value: "trust", label: "Trust" },
		{ value: "trust-parent", label: `Trust parent folder (${parentCwd})` },
		{ value: "trust-session", label: "Trust (this session only)" },
		{ value: "do-not-trust", label: "Do not trust" },
		{ value: "do-not-trust-session", label: "Do not trust (this session only)" },
	];
}

export async function resolveCliProjectTrust(options: ResolveCliProjectTrustOptions): Promise<boolean> {
	const globalSettings = options.settingsManager.getGlobalSettings();
	return resolveProjectTrusted({
		cwd: options.cwd,
		trustStore: new ProjectTrustStore(options.agentDir),
		trustOverride: options.trustOverride,
		defaultProjectTrust: parseDefaultProjectTrust(globalSettings.defaultProjectTrust),
		interactive: options.interactive,
		selectDecision: options.select
			? async () => options.select?.(createProjectTrustPromptOptions(options.cwd))
			: undefined,
		onDiagnostic: options.onDiagnostic,
	});
}
