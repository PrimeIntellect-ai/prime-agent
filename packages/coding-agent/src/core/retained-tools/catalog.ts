import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import {
	getProjectToolsDir,
	loadToolIndex,
	type ToolIndex,
	type ToolIndexEntry,
	type ToolScope,
	type ToolStatus,
} from "./index.js";

export interface ToolCatalogRow {
	name: string;
	scope: ToolScope;
	path: string;
	status: ToolStatus;
	used: number;
	explicit_ok: number;
	explicit_fail: number;
	last_used: string | null;
}

export type ToolCatalog = ToolCatalogRow[];

const COLUMNS = ["name", "scope", "path", "status", "used", "explicit_ok", "explicit_fail", "last_used"] as const;

function toRow(name: string, entry: ToolIndexEntry): ToolCatalogRow {
	return {
		name,
		scope: entry.scope,
		path: entry.path,
		status: entry.status,
		used: entry.usage.used,
		explicit_ok: entry.usage.explicit_ok,
		explicit_fail: entry.usage.explicit_fail,
		last_used: entry.usage.last_used,
	};
}

/**
 * Merge the two per-scope indexes into a flat catalog: project entries shadow
 * same-named global entries (mirroring skill-load precedence), rows sorted by
 * name ascending.
 */
export function buildToolsCatalog(globalIndex: ToolIndex, projectIndex: ToolIndex): ToolCatalog {
	const rows: ToolCatalog = [];
	for (const name of Object.keys(globalIndex.skills).sort()) {
		rows.push(toRow(name, globalIndex.skills[name]));
	}
	for (const name of Object.keys(projectIndex.skills).sort()) {
		const entry = projectIndex.skills[name];
		const shadowed = rows.findIndex((row) => row.name === name);
		if (shadowed === -1) rows.push(toRow(name, entry));
		else rows[shadowed] = toRow(name, entry);
	}
	return rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Render the catalog as a plain aligned text table (the session-command result
 * component renders plain Text, not markdown). An empty catalog renders a
 * single status line.
 */
export function formatToolsCatalogTable(catalog: ToolCatalog): string {
	if (catalog.length === 0) return "No retained tools found.";
	const rows = catalog.map((row) => [
		row.name,
		row.scope,
		row.path,
		row.status,
		String(row.used),
		String(row.explicit_ok),
		String(row.explicit_fail),
		row.last_used ?? "-",
	]);
	const widths = COLUMNS.map((column, i) => Math.max(column.length, ...rows.map((row) => row[i].length)));
	const line = (cells: readonly string[]): string =>
		cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i]))).join("  ");
	return [line([...COLUMNS]), ...rows.map((row) => line(row))].join("\n");
}

export interface LoadToolsCatalogOptions {
	/** Project working directory; the project index lives under `<cwd>/.prime/agent/tools`. */
	cwd: string;
	/** Global agent dir override; defaults to `getAgentDir()`. */
	agentDir?: string;
}

/** Read both per-scope indexes from disk and build the merged catalog. */
export function loadToolsCatalog(options: LoadToolsCatalogOptions): ToolCatalog {
	const agentDir = options.agentDir ?? getAgentDir();
	const globalIndex = loadToolIndex(join(agentDir, "tools"));
	const projectIndex = loadToolIndex(getProjectToolsDir(options.cwd));
	return buildToolsCatalog(globalIndex, projectIndex);
}
