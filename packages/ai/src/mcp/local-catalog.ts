/**
 * Local user-authored MCP service sources (ENG-6108).
 *
 * Loads a single local JSON file of service entries and validates it against
 * the same contract as the bundled catalog. The loader is deliberately narrow:
 * a bounded read of a regular file + JSON parse + structural validation, no
 * execution, no network, and no credential access — credentials live
 * exclusively in the host's credential storage.
 *
 * The loader rejects anything that would let a local file masquerade as
 * trusted: provenance may only claim the `user` source, `legacyBuiltin` and
 * `metadata-reviewed` review status cannot be self-asserted, audit-derived
 * `setup.readiness`, `auth.alternatives` and `auth.metadata` evidence cannot be
 * self-asserted, and ids colliding with bundled catalog entries are refused
 * (no silent override/rebind of built-ins). Errors are visible and bounded: they name the file, entry index
 * and problem category, and never echo raw input values (a malformed URL or
 * JSON may carry secrets). How local entries interact with `mcpServers`
 * settings is host policy; this module only provides the validated entries.
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
	/** Path the entries were loaded from (empty when the file does not exist). */
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
	let stats: fs.Stats;
	try {
		stats = fs.statSync(filePath);
	} catch {
		// Vanished between the existence check and stat: treat as absent.
		return { entries: [], path: "" };
	}
	// Only regular files (symlinks to regular files included). FIFOs, sockets and
	// devices are refused so a special file can never hang the read.
	if (!stats.isFile()) {
		throw new Error(
			`Local service source ${filePath} is not a regular file; directories, FIFOs and devices are refused`,
		);
	}
	// Bounded read: the stale-stat size is never trusted; chunks are read until
	// the running total exceeds MAX_LOCAL_CATALOG_BYTES, so at most
	// MAX_LOCAL_CATALOG_BYTES + one chunk (64 KiB - 1 byte) is ever read before
	// an oversized file is refused from the read itself.
	let fd: number | undefined;
	const chunks: Buffer[] = [];
	try {
		fd = fs.openSync(filePath, "r");
		const chunkSize = 64 * 1024;
		let total = 0;
		for (;;) {
			const chunk = Buffer.alloc(chunkSize);
			const bytesRead = fs.readSync(fd, chunk, 0, chunkSize, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > MAX_LOCAL_CATALOG_BYTES) {
				throw new Error(`Local service source ${filePath} exceeds the maximum of ${MAX_LOCAL_CATALOG_BYTES} bytes`);
			}
			chunks.push(bytesRead === chunkSize ? chunk : chunk.subarray(0, bytesRead));
		}
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
	const raw = Buffer.concat(chunks).toString("utf8");

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch (error) {
		// Never echo the parser message: it can quote raw (possibly secret) source text.
		const position = /position (\d+)/.exec((error as Error).message)?.[1];
		throw new Error(
			`Local service source ${filePath} is not valid JSON${position ? ` (parse error near byte ${position})` : ""}`,
		);
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Error(`Local service source ${filePath} must be an object with a version and an entries array`);
	}
	const record = data as Record<string, unknown>;
	if (record.version !== 1) {
		throw new Error(`Local service source ${filePath} has an unsupported version; expected 1`);
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
		// Review status and legacy-builtin trust cannot be self-asserted by a local file.
		if (entry.legacyBuiltin) {
			throw new Error(
				`${at} (${entry.server}): local entries cannot claim legacyBuiltin; it is reserved for Prime built-ins`,
			);
		}
		if (entry.verification.status !== "unverified") {
			throw new Error(
				`${at} (${entry.server}): local entries cannot claim "${entry.verification.status}"; local sources are always unverified`,
			);
		}
		// Audit-derived readiness, alternatives and metadata evidence are Prime
		// assessments; a local file cannot self-assert them. setup.requirement stays
		// allowed as honest self-description of the user's own service.
		if (entry.setup.readiness !== undefined) {
			throw new Error(
				`${at} (${entry.server}): local entries cannot claim setup.readiness "${entry.setup.readiness}"; readiness is a Prime audit assessment`,
			);
		}
		if (entry.auth.alternatives !== undefined || entry.auth.metadata !== undefined) {
			throw new Error(
				`${at} (${entry.server}): local entries cannot carry auth.alternatives or auth.metadata; they are Prime audit evidence`,
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
