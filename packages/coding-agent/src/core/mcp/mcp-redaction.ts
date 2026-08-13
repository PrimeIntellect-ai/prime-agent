import type { McpDeclaration, McpDeclarationDocument } from "./mcp-declarations.js";

const SENSITIVE_KEY = /(?:authorization|credential|secret|token|password|api[_-]?key|cookie|header)/i;

/**
 * Redact arbitrary persisted MCP-shaped data before rendering it. This is
 * intentionally defensive even though M01 declarations reject such fields.
 */
export function redactMcpValue(value: unknown, key = ""): unknown {
	if (SENSITIVE_KEY.test(key)) return "<redacted>";
	if (typeof value === "string") {
		if (key === "url") {
			try {
				const url = new URL(value);
				if (url.username || url.password || url.search || url.hash) return "<redacted-url>";
			} catch {
				return "<redacted-url>";
			}
		}
		return value;
	}
	if (Array.isArray(value)) return value.map((entry) => redactMcpValue(entry));
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, child]) => [childKey, redactMcpValue(child, childKey)]),
		);
	}
	return value;
}

export function redactMcpDeclaration(declaration: McpDeclaration): McpDeclaration {
	return structuredClone(redactMcpValue(declaration) as McpDeclaration);
}

export function redactMcpDeclarationDocument(document: McpDeclarationDocument): McpDeclarationDocument {
	return structuredClone(redactMcpValue(document) as McpDeclarationDocument);
}
