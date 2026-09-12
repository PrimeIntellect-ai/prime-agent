/**
 * Local user-authored MCP service sources (ENG-6108).
 *
 * Loads a single local JSON file of service entries and validates it against
 * the same contract as the bundled catalog. The loader is deliberately narrow:
 * synchronous file read + JSON parse + structural validation, bounded size and
 * entry counts, no execution, no network, and no credential access —
 * credentials live exclusively in the host's credential storage.
 *
 * The loader rejects anything that would let a local file masquerade as
 * trusted: provenance may only claim the `user` source, and ids colliding
 * with bundled catalog entries are refused (no silent override/rebind of
 * built-ins). How local entries interact with `mcpServers` settings is host
 * policy; this module only provides the validated entries.
 */

import * as fs from "node:fs";
import {
	type McpServiceEntry,
	type McpServiceProvenance,
	SERVICE_CATALOG,
	validateMcpServiceEntry,
} from "./catalog.js";

/** Maximum accepted local source file size. */
export const MAX_LOCAL_CATALOG_BYTES = 256 * 1024;
/** Maximum accepted entries per local source file. */
export const MAX_LOCAL_CATALOG_ENTRIES = 50;

export interface LocalCatalogLoadResult {
	/** Validated local entries, frozen, in file order (ids guaranteed unique and non-bundled). */
	entries: readonly McpServiceEntry[];
	/** Absolute path the entries were loaded from (empty when the file does not exist). */
	path: string;
}

const LOCAL_SOURCE_ALLOWED: Record<string, true> = { user: true };

/**
 * Load and validate a local service source file. A missing file is not an
 * error and yields zero entries; every problem with an existing file throws
 * with the file path (and entry index where applicable) in the message.
 *
 * Proposed settings wiring (host-owned): `~/.prime/agent/mcp-services.json`.
 */
export function loadLocalServiceCatalog(filePath: string): LocalCatalogLoadResult {
	if (!fs.existsSync(filePath)) {
		return { entries: [], path: "" };
	}
	const stat = fs.statSync(filePath);
	if (stat.isDirectory()) {
		throw new Error(`Local service source ${filePath} is a directory, expected a JSON file`);
	}
	if (stat.size > MAX_LOCAL_CATALOG_BYTES) {
		throw new Error(
			`Local service source ${filePath} is ${stat.size} bytes; the maximum is ${MAX_LOCAL_CATALOG_BYTES}`,
		);
	}
	const raw = fs.readFileSync(filePath, "utf8");
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Local service source ${filePath} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`Local service source ${filePath} must be an object with a version and an entries array`);
	}
	const record = data as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error(`Local service source ${filePath} has unsupported version ${String(record.version)}; expected 1`);
	}
	if (!Array.isArray(record.entries)) {
		throw new Error(`Local service source ${filePath} must contain an entries array`);
	}
	if (record.entries.length > MAX_LOCAL_CATALOG_ENTRIES) {
		throw new Error(
			`Local service source ${filePath} has ${record.entries.length} entries; the maximum is ${MAX_LOCAL_CATALOG_ENTRIES}`,
		);
	}
	const entries: McpServiceEntry[] = [];
	const seenLocal = new Set<string>();
	for (let index = 0; index < record.entries.length; index++) {
		const at = `Local service source ${filePath}, entry ${index}`;
		let entry: McpServiceEntry;
		try {
			entry = validateMcpServiceEntry(record.entries[index]);
		} catch (error) {
			throw new Error(`${at}: ${(error as Error).message}`);
		}
		const badTrust = entry.provenance.find((prov) => !LOCAL_SOURCE_ALLOWED[prov.source]);
		if (badTrust) {
			throw new Error(
				`${at} (${entry.server}): local entries may only carry provenance source "user"; found "${badTrust.source}"`,
			);
		}
		if (entry.provenance.length === 0) {
			throw new Error(
				`${at} (${entry.server}): local entries need at least one provenance record with source "user"`,
			);
		}
		if (seenLocal.has(entry.server)) {
			throw new Error(`${at}: duplicate local id "${entry.server}"`);
		}
		const bundled = SERVICE_CATALOG.find((candidate) => candidate.server === entry.server);
		if (bundled) {
			throw new Error(
				`${at}: id "${entry.server}" collides with the bundled catalog entry for "${bundled.label}"; local sources cannot shadow or rebind built-ins — pick another id`,
			);
		}
		seenLocal.add(entry.server);
		Object.freeze(entry.transport);
		Object.freeze(entry.auth);
		Object.freeze(entry.setup);
		Object.freeze(entry.verification);
		Object.freeze(entry.provenance);
		Object.freeze(entry.aliases);
		Object.freeze(entry.oauth);
		Object.freeze(entry);
		entries.push(entry);
	}
	return { entries, path: filePath };
}

/** Convenience helper for authoring: a provenance record local entries may use. */
export function userProvenance(note: string): McpServiceProvenance {
	return { source: "user", note };
}
