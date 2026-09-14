import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isTelemetryUuid, sanitizeTelemetryProperties, type TelemetryProperties } from "./telemetry-schema.js";

export const INSTALLATION_TELEMETRY_DIRECTORY = "telemetry-installations";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PENDING = 16;
const CONTEXT_KEYS = [
	"installation_attempt_id",
	"installation_action",
	"installation_source",
	"from_version",
	"target_version",
] as const;

export interface InstallationTelemetryState {
	version: 1;
	createdAt: number;
	cwd: string;
	properties: TelemetryProperties;
	completeOnReady: boolean;
}

export function installationTelemetryContext(value: unknown): TelemetryProperties | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const input = value as Record<string, unknown>;
	const properties = Object.fromEntries(CONTEXT_KEYS.map((key) => [key, input[key]]));
	const safe = sanitizeTelemetryProperties("agent installation stage", {
		...properties,
		version: "0.0.0",
		os_family: "unknown",
		architecture: "unknown",
		install_method: "unknown",
		execution_mode: "unknown",
		stage: "ready",
		outcome: "success",
	});
	if (!safe) return undefined;
	return Object.fromEntries(
		CONTEXT_KEYS.flatMap((key) => (safe[key] !== undefined && safe[key] === input[key] ? [[key, safe[key]]] : [])),
	);
}

function stateDirectory(agentDir: string): string {
	const directory = join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY);
	if (!lstatSync(directory).isDirectory()) throw new Error("Invalid installation telemetry directory");
	return directory;
}

export function removeInstallationTelemetryState(agentDir: string, attemptId: unknown): boolean {
	if (!isTelemetryUuid(attemptId)) return false;
	try {
		unlinkSync(join(stateDirectory(agentDir), `${attemptId}.json`));
		return true;
	} catch {
		// Missing or unreadable analytics state never changes installation behavior.
		return false;
	}
}

export function clearInstallationTelemetryState(agentDir: string): void {
	try {
		for (const name of readdirSync(stateDirectory(agentDir))) {
			if (name.endsWith(".json")) removeInstallationTelemetryState(agentDir, name.slice(0, -5));
		}
	} catch {
		// Opt-out does not require an analytics directory to exist.
	}
}

export function readInstallationTelemetryState(agentDir: string, now = Date.now()): InstallationTelemetryState[] {
	const result: InstallationTelemetryState[] = [];
	try {
		const directory = stateDirectory(agentDir);
		for (const name of readdirSync(directory)) {
			const id = name.endsWith(".json") ? name.slice(0, -5) : undefined;
			if (!isTelemetryUuid(id)) continue;
			try {
				const path = join(directory, name);
				const info = lstatSync(path);
				if (!info.isFile() || info.size > 16_384) throw new Error("Invalid installation telemetry state");
				const state = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallationTelemetryState>;
				const properties = installationTelemetryContext(state.properties);
				if (
					state.version !== 1 ||
					!properties ||
					properties.installation_attempt_id !== id ||
					typeof state.createdAt !== "number" ||
					!Number.isFinite(state.createdAt) ||
					state.createdAt > now + 60_000 ||
					now - state.createdAt > MAX_AGE_MS ||
					typeof state.cwd !== "string" ||
					state.cwd.length > 4_096 ||
					!isAbsolute(state.cwd) ||
					typeof state.completeOnReady !== "boolean" ||
					result.length >= MAX_PENDING
				)
					throw new Error("Invalid installation telemetry state");
				result.push({
					version: 1,
					createdAt: state.createdAt,
					cwd: state.cwd,
					properties,
					completeOnReady: state.completeOnReady,
				});
			} catch {
				removeInstallationTelemetryState(agentDir, id);
			}
		}
	} catch {
		// This observation is optional and cannot prevent startup.
	}
	return result;
}

export function writeInstallationTelemetryState(agentDir: string, state: InstallationTelemetryState): void {
	try {
		const properties = installationTelemetryContext(state.properties);
		if (!properties) return;
		const directory = join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		stateDirectory(agentDir);
		const pending = readInstallationTelemetryState(agentDir);
		if (
			pending.length >= MAX_PENDING &&
			!pending.some((item) => item.properties.installation_attempt_id === properties.installation_attempt_id)
		) {
			const oldest = pending.sort((a, b) => a.createdAt - b.createdAt)[0];
			removeInstallationTelemetryState(agentDir, oldest.properties.installation_attempt_id);
		}
		const path = join(directory, `${properties.installation_attempt_id}.json`);
		removeInstallationTelemetryState(agentDir, properties.installation_attempt_id);
		writeFileSync(path, JSON.stringify({ ...state, properties }), { flag: "wx", mode: 0o600 });
	} catch {
		// A failed marker write only reduces first-launch observation coverage.
	}
}
