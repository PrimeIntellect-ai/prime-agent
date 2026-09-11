import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import {
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { McpConnectionStore } from "../../../src/core/mcp/connection-store.js";
import { McpManager } from "../../../src/core/mcp/mcp-manager.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { isBuiltinSlashCommandName } from "../../../src/core/slash-commands.js";

/**
 * ENG-6108: a /plugins login must become usable in the current (daemon-backed)
 * conversation without a restart: credentials land in the shared auth.json, the
 * connection is verified with a real MCP handshake (token presence alone is
 * never Connected), and the session reload the picker triggers rebuilds the
 * system prompt and serves the catalog service through the generic mcp route.
 */
describe("ENG-6108 service catalog connect-then-activate", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let store: McpConnectionStore;
	let mcpManager: McpManager;
	let services: AgentSessionServices;
	let session: AgentSession;
	let fauxProvider: ReturnType<typeof registerFauxProvider>;

	beforeEach(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "eng6108-activation-"));
		authStorage = AuthStorage.inMemory();
		store = McpConnectionStore.open(join(tempDir, "mcp-connections.json"));
		mcpManager = new McpManager({
			authStorage,
			connectionStore: store,
			noBackgroundVerification: true,
			probeConnection: async () => ({ ok: true, toolCount: 3 }),
		});

		fauxProvider = registerFauxProvider({ provider: "faux-eng6108" });
		const model = fauxProvider.getModel();
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: fauxProvider.api,
			models: fauxProvider.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});

		const settingsManager = SettingsManager.inMemory();
		services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			authStorage,
			settingsManager,
			modelRegistry,
			mcpManager,
			telemetryDisabled: true,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noExtensions: true },
		});

		const sessionManager = SessionManager.inMemory();
		const result = await createAgentSessionFromServices({ services, sessionManager, model });
		session = result.session;
	});

	afterEach(() => {
		session.dispose();
		fauxProvider.unregister();
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	});

	it("activates a verified connection in the live conversation after /plugins login", async () => {
		expect(isBuiltinSlashCommandName("plugins")).toBe(true);

		const promptBefore = session.agent.state.systemPrompt;
		expect(promptBefore).not.toContain("Enabled generic MCP servers");
		expect(services.mcpManager.getDisabledBuiltinSkillOverrides()).toContain("-notion/SKILL.md");

		// The /plugins connect flow, minus the UI: browser OAuth writes the shared
		// credential, then the host verifies with a real MCP handshake.
		authStorage.set("mcp:notion", {
			type: "oauth",
			access: "notion-access",
			refresh: "notion-refresh",
			expires: Date.now() + 3600_000,
		});
		const record = await services.mcpManager.verifyConnection("notion");
		expect(record.status).toBe("connected");
		expect(record.toolCount).toBe(3);

		// The picker triggers the same session reload the interactive client performs.
		await session.reload();

		const promptAfter = session.agent.state.systemPrompt;
		expect(promptAfter).toContain("Enabled generic MCP servers");
		expect(promptAfter).toContain("`notion`");
		expect(promptAfter).toContain('await mcp.list_tools("notion")');
		expect(services.mcpManager.getDisabledBuiltinSkillOverrides()).not.toContain("-notion/SKILL.md");

		// The kernel's generic route can dispatch the catalog service immediately.
		const handlers = services.mcpManager.hostHandlers();
		expect(await handlers["mcp.config"]({ server: "notion" })).toEqual({
			type: "http",
			url: "https://mcp.notion.com/mcp",
			oauth: true,
		});

		const connections = (await handlers["mcp.list_connections"]({})) as {
			connections: Array<{
				connectionId: string;
				serviceId?: string;
				status: string;
				source: string;
			}>;
		};
		const notion = connections.connections.find((connection) => connection.connectionId === "notion");
		expect(notion).toMatchObject({
			connectionId: "notion",
			serviceId: "notion",
			status: "connected",
			source: "catalog",
		});
	});

	it("keeps a stored token at pending — never Connected — until the handshake verifies", async () => {
		authStorage.set("mcp:linear", {
			type: "oauth",
			access: "linear-access",
			refresh: "linear-refresh",
			expires: Date.now() + 3600_000,
		});
		// No verification yet: the manager's probe is stubbed but never invoked.
		const handlers = mcpManager.hostHandlers();
		const plugins = (await handlers["mcp.list_plugins"]({})) as {
			plugins: Array<{ serviceId: string; connectionStatus: string; connectionIds: string[] }>;
		};
		const linear = plugins.plugins.find((plugin) => plugin.serviceId === "linear");
		expect(linear).toMatchObject({ connectionStatus: "pending", connectionIds: ["linear"] });
	});
});
