import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatMcpServer, parseMcpAddArgs, runMcpManagementCommand } from "../src/core/mcp/mcp-command.js";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("MCP management commands", () => {
	const testDir = join(process.cwd(), "test-mcp-command-tmp");
	afterEach(() => rmSync(testDir, { recursive: true, force: true }));
	it("preserves exact stdio argv and environment references after --", () => {
		expect(
			parseMcpAddArgs([
				"local",
				"--cwd",
				"/tmp/work tree",
				"--env",
				"TOKEN=SOURCE_TOKEN",
				"--",
				"node",
				"server file.js",
				"--flag=value with spaces",
			]),
		).toEqual({
			name: "local",
			force: false,
			config: {
				type: "stdio",
				command: "node",
				args: ["server file.js", "--flag=value with spaces"],
				cwd: "/tmp/work tree",
				env: { TOKEN: { env: "SOURCE_TOKEN" } },
			},
		});
	});

	it("validates transport, URL, names, auth, and stdio environment syntax", () => {
		for (const args of [
			["bad name", "--url", "https://example.com/mcp"],
			["remote", "--url", "file:///tmp/server"],
			["remote", "--url", "https://user:secret@example.com/mcp"],
			["remote", "--url", "https://example.com", "--oauth", "--bearer-token-env-var", "TOKEN"],
			["local", "--env", "TOKEN=literal-value", "--", "node"],
			["local", "--"],
		] as string[][]) {
			expect(() => parseMcpAddArgs(args)).toThrow();
		}
	});

	it("redacts header values and shows only environment identities", () => {
		const output = formatMcpServer("remote", {
			type: "http",
			url: "https://example.com/mcp",
			headers: { Authorization: "Bearer secret", "X-Api-Key": "also-secret" },
		});
		expect(output).toContain("Authorization, X-Api-Key (values redacted)");
		expect(output).not.toContain("Bearer secret");
		expect(output).not.toContain("also-secret");
	});

	it("persists global-only entries and replaces them wholesale with --force", async () => {
		const manager = SettingsManager.inMemory({});
		await runMcpManagementCommand(["add", "remote", "--url", "https://one.example/mcp", "--oauth"], manager);
		await expect(
			runMcpManagementCommand(["add", "remote", "--url", "https://two.example/mcp"], manager),
		).rejects.toThrow("already exists");
		await runMcpManagementCommand(
			["add", "remote", "--url", "https://two.example/mcp", "--bearer-token-env-var", "TOKEN", "--force"],
			manager,
		);
		expect(manager.getGlobalMcpServers()).toEqual({
			remote: { type: "http", url: "https://two.example/mcp", bearerTokenEnvVar: "TOKEN" },
		});
		expect(manager.getProjectSettings().mcpServers).toBeUndefined();
	});

	it("atomically persists only user settings while preserving concurrent fields", async () => {
		const agentDir = join(testDir, "agent");
		const projectDir = join(testDir, "project");
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(projectDir, ".prime", "agent", "settings.json"),
			JSON.stringify({ mcpServers: { project: {} } }),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
		const manager = SettingsManager.create(projectDir, agentDir);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light", quietStartup: true }));

		await runMcpManagementCommand(["add", "remote", "--url", "https://example.com/mcp"], manager);

		const globalSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(globalSettings).toMatchObject({
			theme: "light",
			quietStartup: true,
			mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } },
		});
		expect(readFileSync(join(projectDir, ".prime", "agent", "settings.json"), "utf8")).toContain("project");
		expect(() => readFileSync(`${join(agentDir, "settings.json")}.tmp`, "utf8")).toThrow();
	});

	it("reports get/remove not found and removes live entries", async () => {
		const manager = SettingsManager.inMemory({});
		await expect(runMcpManagementCommand(["get", "missing"], manager)).rejects.toThrow("not found");
		await expect(runMcpManagementCommand(["remove", "missing"], manager)).rejects.toThrow("not found");
		await runMcpManagementCommand(["add", "local", "--", "node", "server.js"], manager);
		await expect(runMcpManagementCommand(["get", "local"], manager)).resolves.toMatchObject({
			message: expect.stringContaining("args: 1 argument (values hidden)"),
		});
		await runMcpManagementCommand(["remove", "local"], manager);
		expect(manager.getGlobalMcpServers()).toEqual({});
	});
});
