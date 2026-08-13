/**
 * M01's declarative, credential-free MCP record. This module has no transport,
 * authentication, or process-launch dependency.
 */
export const MCP_DECLARATION_VERSION = 1 as const;
export const MCP_DECLARATION_NAME = /^[a-z][a-z0-9-]{0,62}$/;

export interface McpDeclaration {
	name: string;
	url: string;
	enabled: boolean;
}

export interface McpDeclarationDocument {
	version: typeof MCP_DECLARATION_VERSION;
	servers: Record<string, McpDeclaration>;
}

export type McpDeclarationScope = "user" | "project";

function fail(message: string): never {
	// Deliberately never include supplied configuration values in errors: callers
	// may have provided an accidentally credential-bearing URL or field.
	throw new Error(message);
}

/**
 * Configuration crosses a hostile-data boundary. Only ordinary (or null
 * prototype) records with enumerable own data properties are accepted. This
 * intentionally rejects accessors, inherited fields, symbols, and exotic
 * prototype chains before any configured value is read.
 */
function ownDataRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return false;
		if (Object.getOwnPropertySymbols(value).length !== 0) return false;
		for (const key of Object.getOwnPropertyNames(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function ownDataKeys(record: Record<string, unknown>, message: string): string[] {
	if (!ownDataRecord(record)) fail(message);
	try {
		return Object.getOwnPropertyNames(record);
	} catch {
		return fail(message);
	}
}

function ownDataValue(record: Record<string, unknown>, key: string, message: string): unknown {
	try {
		const descriptor = Object.getOwnPropertyDescriptor(record, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail(message);
		return descriptor.value;
	} catch {
		return fail(message);
	}
}

export function normalizeMcpDeclarationName(value: unknown): string {
	if (typeof value !== "string" || !MCP_DECLARATION_NAME.test(value)) {
		fail(
			"MCP declaration names must start with a lowercase letter and contain lowercase letters, digits, or hyphens.",
		);
	}
	return value;
}

/** Canonical, non-credential-bearing Streamable HTTP endpoint identity. */
export function normalizeMcpDeclarationUrl(value: unknown): string {
	if (typeof value !== "string" || /[\s\\]/.test(value)) {
		fail("MCP declaration URLs must be a single HTTP(S) URL.");
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		fail("MCP declaration URLs must be a valid HTTP(S) URL.");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		fail("MCP declaration URLs must use HTTP or HTTPS.");
	}
	if (url.username || url.password || url.search || url.hash) {
		fail("MCP declaration URLs must not contain credentials, query strings, or fragments.");
	}
	return url.toString();
}

function requireExactKeys(record: Record<string, unknown>, keys: readonly string[], message: string): void {
	const actual = ownDataKeys(record, message);
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) fail(message);
}

export function parseMcpDeclaration(value: unknown, expectedName?: string): McpDeclaration {
	if (!ownDataRecord(value)) fail("MCP declaration must be a plain object with own data fields.");
	requireExactKeys(value, ["name", "url", "enabled"], "MCP declarations only permit name, url, and enabled fields.");
	const name = normalizeMcpDeclarationName(
		ownDataValue(value, "name", "MCP declaration name must be an own data field."),
	);
	if (expectedName !== undefined && name !== expectedName) {
		fail("MCP declaration name must match its settings key.");
	}
	const enabled = ownDataValue(value, "enabled", "MCP declaration enabled must be an own data field.");
	if (typeof enabled !== "boolean") fail("MCP declaration enabled must be a boolean.");
	return {
		name,
		url: normalizeMcpDeclarationUrl(ownDataValue(value, "url", "MCP declaration URL must be an own data field.")),
		enabled,
	};
}

export function emptyMcpDeclarationDocument(): McpDeclarationDocument {
	return { version: MCP_DECLARATION_VERSION, servers: {} };
}

export function parseMcpDeclarationDocument(value: unknown): McpDeclarationDocument {
	if (value === undefined) return emptyMcpDeclarationDocument();
	if (!ownDataRecord(value)) fail("MCP declaration settings must be a plain object with own data fields.");
	requireExactKeys(value, ["version", "servers"], "MCP declarations only permit version and servers fields.");
	if (
		ownDataValue(value, "version", "MCP declaration version must be an own data field.") !== MCP_DECLARATION_VERSION
	) {
		fail("MCP declaration settings use an unsupported format.");
	}
	const rawServers = ownDataValue(value, "servers", "MCP declaration servers must be an own data field.");
	if (!ownDataRecord(rawServers)) fail("MCP declaration settings use an unsupported format.");

	const servers: Record<string, McpDeclaration> = {};
	const urls = new Set<string>();
	for (const key of ownDataKeys(rawServers, "MCP declaration servers must be plain own data.")) {
		const name = normalizeMcpDeclarationName(key);
		const parsed = parseMcpDeclaration(
			ownDataValue(rawServers, key, "MCP declaration server must be an own data field."),
			name,
		);
		if (urls.has(parsed.url)) fail("MCP declarations must not repeat an endpoint URL.");
		urls.add(parsed.url);
		Object.defineProperty(servers, name, { value: parsed, enumerable: true, configurable: true, writable: true });
	}
	return { version: MCP_DECLARATION_VERSION, servers };
}

export function addMcpDeclaration(
	document: McpDeclarationDocument,
	name: unknown,
	url: unknown,
): McpDeclarationDocument {
	const parsedName = normalizeMcpDeclarationName(name);
	const parsedUrl = normalizeMcpDeclarationUrl(url);
	if (Object.hasOwn(document.servers, parsedName)) fail("An MCP declaration with that name already exists.");
	if (Object.values(document.servers).some((server) => server.url === parsedUrl)) {
		fail("An MCP declaration with that endpoint URL already exists.");
	}
	return {
		version: MCP_DECLARATION_VERSION,
		servers: { ...document.servers, [parsedName]: { name: parsedName, url: parsedUrl, enabled: true } },
	};
}

export function removeMcpDeclaration(document: McpDeclarationDocument, name: unknown): McpDeclarationDocument {
	const parsedName = normalizeMcpDeclarationName(name);
	if (!Object.hasOwn(document.servers, parsedName)) fail("No MCP declaration has that name.");
	const { [parsedName]: _removed, ...servers } = document.servers;
	return { version: MCP_DECLARATION_VERSION, servers };
}

/** A static probe request description. Creating it never performs I/O. */
export function previewMcpProbe(declaration: McpDeclaration): {
	url: string;
	method: "POST";
	redirect: "error";
	requestKind: "mcp-initialize";
} {
	return { url: declaration.url, method: "POST", redirect: "error", requestKind: "mcp-initialize" };
}
