import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.js";
import type { ExecuteResult } from "../../../src/core/kernel/index.js";
import { McpManager } from "../../../src/core/mcp/mcp-manager.js";
import { acpMcpToolNames, createAcpMcpToolDefinitions } from "../../../src/core/tools/acp-mcp.js";
import type { IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { createHarness } from "../harness.js";

function provisionerWith(result: ExecuteResult) {
	const execute = vi.fn(async (_code: string) => result);
	const ensure = vi.fn(async () => ({ execute }));
	return {
		execute,
		provisioner: { ensure } as unknown as IpythonKernelProvisioner,
	};
}

function httpServer(name: string) {
	return { name, type: "http" as const, url: `https://${name}.example/mcp`, headers: {} };
}

function requireTool(tool: ToolDefinition | undefined): ToolDefinition {
	if (!tool) throw new Error("Expected ACP MCP tool definition");
	return tool;
}

const context = {} as ExtensionContext;

describe("PR 2002 ACP MCP native tools", () => {
	it("decodes JSON arguments in Python without polluting the persistent namespace", async () => {
		const { execute, provisioner } = provisionerWith({
			stdout: '{"ok": true}\n',
			stderr: "",
			status: "ok",
			durationMs: 1,
		});
		const [, callTool] = createAcpMcpToolDefinitions([httpServer("task")], provisioner);

		const result = await requireTool(callTool).execute(
			"call-1",
			{ tool: "configure", arguments: { enabled: true, value: null } },
			undefined,
			undefined,
			context,
		);

		expect(result.details).toMatchObject({ status: "ok" });
		expect(result.content).toEqual([{ type: "text", text: '{"ok": true}\n' }]);
		const code = execute.mock.calls[0]?.[0] ?? "";
		expect(code).toContain('__import__("json").loads("{\\"enabled\\":true,\\"value\\":null}")');
		expect(code).not.toMatch(/(?:tools|result)\s*=/);
	});

	it("reports failed and thrown kernel executions as tool errors", async () => {
		const failed = provisionerWith({
			stdout: "",
			stderr: "cell failed",
			status: "error",
			error: { ename: "RuntimeError", evalue: "boom", traceback: ["traceback line"] },
			durationMs: 2,
		});
		const [listTool] = createAcpMcpToolDefinitions([httpServer("task")], failed.provisioner);
		await expect(requireTool(listTool).execute("call-2", {}, undefined, undefined, context)).rejects.toThrow(
			"traceback line",
		);

		const ensure = vi.fn(async () => {
			throw new Error("kernel unavailable");
		});
		const [throwingTool] = createAcpMcpToolDefinitions([httpServer("task")], {
			ensure,
		} as unknown as IpythonKernelProvisioner);
		await expect(requireTool(throwingTool).execute("call-3", {}, undefined, undefined, context)).rejects.toThrow(
			"kernel unavailable",
		);
	});

	it("rejects invalid or duplicate server names before generating ambiguous tools", () => {
		expect(() => acpMcpToolNames([httpServer("foo.bar")])).toThrow("Invalid ACP MCP server name");
		expect(() => acpMcpToolNames([httpServer("task"), httpServer("task")])).toThrow("Duplicate ACP MCP server");
	});

	it("rejects ACP MCP servers when the built-in cpython runtime is unavailable", async () => {
		const harness = await createHarness({ tools: [] });
		const manager = new McpManager({ authStorage: harness.authStorage });
		Reflect.set(harness.session, "_mcpManager", manager);
		try {
			expect(() => harness.session.replaceAcpMcpServers([httpServer("task")], "owner-a")).toThrow(
				"require the built-in cpython tool",
			);
			expect(manager.getAcpServers()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("rebinds proxies on reload, removes them on release, and rejects custom-tool collisions", async () => {
		const harness = await createHarness();
		const manager = new McpManager({ authStorage: harness.authStorage });
		Reflect.set(harness.session, "_mcpManager", manager);
		try {
			harness.session.replaceAcpMcpServers([httpServer("task")], "owner-a");
			const toolNames = harness.session.getAllTools().map((tool) => tool.name);
			expect(toolNames).toContain("mcp_list_tools_task");
			expect(toolNames).toContain("mcp_call_task");
			expect(harness.session.getActiveToolNames()).toContain("mcp_call_task");
			expect(harness.session.systemPrompt).not.toContain('await mcp.list_tools("task")');

			const beforeReload = Reflect.get(harness.session, "_toolDefinitions") as Map<string, ToolDefinition>;
			const originalCallTool = beforeReload.get("mcp_call_task");
			await harness.session.reload();
			const afterReload = Reflect.get(harness.session, "_toolDefinitions") as Map<string, ToolDefinition>;
			expect(afterReload.get("mcp_call_task")).not.toBe(originalCallTool);

			await harness.session.releaseAcpMcpServers("owner-a", ["task"]);
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp_call_task");
			expect(harness.session.getActiveToolNames()).not.toContain("mcp_call_task");

			const customTools = Reflect.get(harness.session, "_customTools") as ToolDefinition[];
			customTools.push({
				name: "mcp_call_task",
				label: "existing",
				description: "existing custom tool",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: [{ type: "text", text: "existing" }], details: {} }),
			});
			expect(() => harness.session.replaceAcpMcpServers([httpServer("task")], "owner-b")).toThrow(
				"conflicts with an existing tool",
			);
			expect(manager.getAcpServers()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
});
