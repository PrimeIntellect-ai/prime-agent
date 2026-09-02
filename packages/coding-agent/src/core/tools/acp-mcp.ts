import type { ToolDefinition } from "../extensions/types.js";
import type { IpythonKernelProvisioner } from "./ipython.js";
import type { AcpMcpServerConfig } from "../mcp/acp-mcp-types.js";

export function createAcpMcpToolDefinitions(
	servers: readonly AcpMcpServerConfig[],
	provisioner: IpythonKernelProvisioner,
): ToolDefinition[] {
	const definitions: ToolDefinition[] = [];
	for (const server of servers) {
		const safeName = server.name.replace(/[^a-zA-Z0-9_-]/g, "_");
		const serverName = JSON.stringify(server.name);

		definitions.push({
			name: `mcp_list_tools_${safeName}`,
			label: `list tools from ${server.name}`,
			description: `List every tool the "${server.name}" MCP server exposes. ` +
				`Call this first, then use mcp_call_${safeName} to invoke a specific tool.`,
			parameters: { type: "object", properties: {}, required: [], additionalProperties: false } as any,
			execute: async (_toolCallId, _params, signal, _onUpdate, _ctx) => {
				const m = await provisioner.ensure(() => {}, signal);
				const code = `import json; tools = await mcp.list_tools(${serverName}); print(json.dumps(tools, default=str))`;
				const result = await m.execute(code, { signal });
				return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(empty)" }] };
			},
		});

		definitions.push({
			name: `mcp_call_${safeName}`,
			label: `call tool on ${server.name}`,
			description: `Call a tool on the "${server.name}" MCP server. ` +
				`Use mcp_list_tools_${safeName} first to discover available tool names and argument schemas.`,
			parameters: {
				type: "object",
				properties: {
					tool: { type: "string", description: `Tool name on "${server.name}".` },
					arguments: { type: "object", description: "JSON arguments for the tool.", additionalProperties: true },
				},
				required: ["tool", "arguments"],
				additionalProperties: false,
			} as any,
			execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
				const { tool, arguments: args } = params as { tool: string; arguments: Record<string, unknown> };
				const argsJson = JSON.stringify(args ?? {});
				const m = await provisioner.ensure(() => {}, signal);
				const code = `import json; result = await mcp.call_tool(${serverName}, ${JSON.stringify(tool)}, ${argsJson}); print(json.dumps(result, default=str))`;
				try {
					const result = await m.execute(code, { signal });
					return { content: [{ type: "text" as const, text: result.stdout || result.stderr || "(empty)" }] };
				} catch (error) {
					return { content: [{ type: "text" as const, text: `Error: ${String(error)}` }] };
				}
			},
		});
	}
	return definitions;
}
