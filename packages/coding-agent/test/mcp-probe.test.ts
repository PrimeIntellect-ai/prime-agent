import { describe, expect, it } from "vitest";
import { executeMcpDeclarationCommand, parseMcpDeclarationCommand } from "../src/core/mcp/mcp-declaration-command.js";
import { previewMcpDeclarationProbe } from "../src/core/mcp/mcp-probe.js";
import { SettingsManager } from "../src/core/settings-manager.js";

const declaration = { name: "catalog", url: "https://catalog.test/mcp", enabled: true };

describe("MCP declaration probe contract", () => {
	it("returns a bounded offline declaration preview", () => {
		expect(previewMcpDeclarationProbe(declaration)).toEqual({
			url: "https://catalog.test/mcp",
			method: "POST",
			redirect: "error",
			requestKind: "mcp-initialize",
		});
	});

	it("never calls a legacy injected transport when the declaration command is probed", async () => {
		const settings = SettingsManager.inMemory();
		settings.setMcpDeclarationDocument("user", { version: 1, servers: { catalog: declaration } });
		let opens = 0;
		const executeWithLegacyExtra = executeMcpDeclarationCommand as unknown as (
			command: ReturnType<typeof parseMcpDeclarationCommand>,
			settings: SettingsManager,
			admission: undefined,
			legacyOptions: { probeTransport: { open(): unknown } },
		) => Promise<unknown>;

		await expect(
			executeWithLegacyExtra(parseMcpDeclarationCommand(["test", "catalog"]), settings, undefined, {
				probeTransport: {
					open() {
						opens++;
						throw new Error("transport must remain unreachable");
					},
				},
			}),
		).resolves.toEqual(previewMcpDeclarationProbe(declaration));
		expect(opens).toBe(0);
	});
});
