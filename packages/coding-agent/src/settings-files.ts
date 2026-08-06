import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type SettingsFileFormat = "json" | "yaml";

export interface ResolvedSettingsFile {
	path: string;
	format: SettingsFileFormat;
	exists: boolean;
}

const SETTINGS_FILE_NAMES: ReadonlyArray<{ name: string; format: SettingsFileFormat }> = [
	{ name: "settings.json", format: "json" },
	{ name: "settings.yml", format: "yaml" },
	{ name: "settings.yaml", format: "yaml" },
];

/** Resolve the one settings document in a directory, preserving JSON as the creation default. */
export function resolveSettingsFile(directory: string): ResolvedSettingsFile {
	const existing = SETTINGS_FILE_NAMES.map((candidate) => ({
		...candidate,
		path: join(directory, candidate.name),
	})).filter((candidate) => existsSync(candidate.path));
	if (existing.length > 1) {
		throw new Error(
			`Multiple settings files found in ${directory}: ${existing.map((candidate) => candidate.name).join(", ")}`,
		);
	}
	if (existing[0]) return { path: existing[0].path, format: existing[0].format, exists: true };
	return { path: join(directory, "settings.json"), format: "json", exists: false };
}

/** Parse one JSON or YAML settings document and require an object root. */
export function parseSettingsDocument(content: string): Record<string, unknown> {
	const parsed: unknown = parseYaml(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Settings document must contain an object");
	}
	return parsed as Record<string, unknown>;
}

export function stringifySettingsDocument(settings: Record<string, unknown>, format: SettingsFileFormat): string {
	if (format === "yaml") return stringifyYaml(settings, { lineWidth: 0 });
	return JSON.stringify(settings, null, 2);
}
