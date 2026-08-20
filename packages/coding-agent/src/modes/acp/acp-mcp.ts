import { validateHeaderName, validateHeaderValue } from "node:http";
import type { McpServer } from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AcpMcpServerConfig } from "../../core/mcp/acp-mcp-types.js";

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function entries(
	server: string,
	label: "header" | "environment",
	values: readonly { name: string; value: string }[],
): Record<string, string> {
	const result = Object.create(null) as Record<string, string>;
	const seen = new Set<string>();
	for (const entry of values) {
		if (!entry.name) {
			throw RequestError.invalidParams({ reason: `MCP server ${server} has an empty ${label} name` });
		}
		const identity = label === "header" ? entry.name.toLowerCase() : entry.name;
		if (seen.has(identity)) {
			throw RequestError.invalidParams({
				reason: `MCP server ${server} has duplicate ${label} ${entry.name}`,
			});
		}
		if (label === "header") {
			try {
				validateHeaderName(entry.name);
				validateHeaderValue(entry.name, entry.value);
			} catch {
				throw RequestError.invalidParams({ reason: `MCP server ${server} has an invalid HTTP header` });
			}
		} else if (entry.name.includes("=") || entry.name.includes("\0") || entry.value.includes("\0")) {
			throw RequestError.invalidParams({ reason: `MCP server ${server} has an invalid environment entry` });
		}
		seen.add(identity);
		result[entry.name] = entry.value;
	}
	return result;
}

export function resolveAcpMcpServers(servers: readonly McpServer[], cwd: string): AcpMcpServerConfig[] {
	const names = new Set<string>();
	return servers.map((server) => {
		if (!SERVER_NAME_PATTERN.test(server.name)) {
			throw RequestError.invalidParams({
				reason:
					"MCP server names must start with an alphanumeric character and contain at most 64 alphanumeric, underscore, or hyphen characters",
			});
		}
		if (names.has(server.name)) {
			throw RequestError.invalidParams({ reason: `duplicate MCP server name: ${server.name}` });
		}
		names.add(server.name);

		if ("command" in server) {
			if (!server.command) {
				throw RequestError.invalidParams({ reason: `MCP server ${server.name} has no stdio command` });
			}
			if (server.command.includes("\0") || server.args.some((argument) => argument.includes("\0"))) {
				throw RequestError.invalidParams({ reason: `MCP server ${server.name} has an invalid stdio command` });
			}
			return {
				name: server.name,
				type: "stdio",
				command: server.command,
				args: [...server.args],
				cwd,
				env: entries(server.name, "environment", server.env),
			};
		}

		if (server.type !== "http") {
			throw RequestError.invalidParams({
				reason: `MCP server ${server.name} uses unsupported ${server.type} transport`,
			});
		}
		let url: URL;
		try {
			url = new URL(server.url);
		} catch {
			throw RequestError.invalidParams({ reason: `MCP server ${server.name} has an invalid HTTP URL` });
		}
		if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
			throw RequestError.invalidParams({
				reason: `MCP server ${server.name} must use an HTTP(S) URL without embedded credentials`,
			});
		}
		return {
			name: server.name,
			type: "http",
			url: url.toString(),
			headers: entries(server.name, "header", server.headers),
		};
	});
}
