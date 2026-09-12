import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { ProviderAuthFlows, type ProviderAuthFlowsHost } from "../src/modes/interactive/auth-flows.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
		},
	});
}

function createOverlayHandle(): OverlayHandle {
	return {
		hide: vi.fn(),
		setHidden: vi.fn(),
		isHidden: () => false,
		focus: vi.fn(),
		unfocus: vi.fn(),
		isFocused: () => true,
	};
}

function createFakeTui(overlays: Component[] = []): TUI {
	return {
		terminal: { columns: 80, rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn((component: Component) => {
			overlays.push(component);
			return createOverlayHandle();
		}),
	} as unknown as TUI;
}

function createHost(authStorage: AuthStorage): {
	host: ProviderAuthFlowsHost;
	statusMessages: string[];
	errorMessages: string[];
	overlays: Component[];
} {
	const statusMessages: string[] = [];
	const errorMessages: string[] = [];
	const overlays: Component[] = [];
	const modelRegistry = {
		authStorage,
		refresh: vi.fn(),
		getAll: () => [],
		getProviderDisplayName: (providerId: string) => providerId,
		getProviderAuthStatus: (providerId: string) => authStorage.getAuthStatus(providerId),
	} as unknown as ModelRegistry;

	return {
		host: {
			ui: createFakeTui(overlays),
			modelRegistry,
			showStatus: (message) => statusMessages.push(message),
			showError: (message) => errorMessages.push(message),
			getAvailableModels: async () => [],
		},
		statusMessages,
		errorMessages,
		overlays,
	};
}

describe("ProviderAuthFlows", () => {
	let tempDir: string;
	let authJsonPath: string;
	let primeConfigPath: string;
	let originalHome: string | undefined;
	let originalPrimeTeamId: string | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "");
		tempDir = join(tmpdir(), `pi-auth-flows-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
		primeConfigPath = join(tempDir, "prime-config.json");
		writeFileSync(authJsonPath, "{}");
		originalHome = process.env.HOME;
		originalPrimeTeamId = process.env.PRIME_TEAM_ID;
	});

	afterEach(() => {
		if (originalHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = originalHome;
		}
		if (originalPrimeTeamId === undefined) {
			delete process.env.PRIME_TEAM_ID;
		} else {
			process.env.PRIME_TEAM_ID = originalPrimeTeamId;
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it.each(["services", "sdk"])("imports CLI credentials through default %s", async (factory) => {
		process.env.HOME = tempDir;
		vi.stubEnv(ENV_AGENT_DIR, "");
		vi.stubEnv("PI_OFFLINE", "1");
		authJsonPath = join(tempDir, ".prime", "agent", "auth.json");
		primeConfigPath = join(tempDir, ".prime", "config.json");
		mkdirSync(join(tempDir, ".prime", "agent"), { recursive: true });
		process.env.PRIME_TEAM_ID = "env-team";
		writeFileSync(
			primeConfigPath,
			JSON.stringify({
				api_key: "prime-cli-key",
				team_id: "cli-team",
				team_name: "CLI Research",
				team_role: "admin",
			}),
		);
		writeFileSync(
			authJsonPath,
			JSON.stringify({
				[PRIME_INFERENCE_PROVIDER_ID]: {
					type: "api_key",
					key: "legacy-agent-key",
				},
			}),
		);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			resourceLoaderOptions: { noExtensions: true },
		});
		let modelRegistry = services.modelRegistry;
		if (factory === "sdk") {
			const { session } = await createAgentSession({
				cwd: tempDir,
				resourceLoader: services.resourceLoader,
				sessionManager: SessionManager.inMemory(tempDir),
				noTools: "all",
			});
			onTestFinished(() => session.dispose());
			modelRegistry = session.modelRegistry;
		}
		const authStorage = modelRegistry.authStorage;
		expect(authStorage.getPrimeCliConfigPath()).toBe(primeConfigPath);
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse({
				data: { scope: { inference: { write: true } } },
			}),
		);
		const { host, statusMessages, errorMessages } = createHost(authStorage);

		const result = await new ProviderAuthFlows({ ...host, modelRegistry }).runPrimeInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(statusMessages.join("\n")).toContain("Using team from PRIME_TEAM_ID.");

		const config = JSON.parse(readFileSync(primeConfigPath, "utf-8")) as Record<string, unknown>;
		expect(config.api_key).toBe("prime-cli-key");
		expect(config.team_id).toBe("cli-team");
		expect(config.team_name).toBe("CLI Research");
		expect(config.team_role).toBe("admin");
		expect(AuthStorage.create(authJsonPath).get(PRIME_INFERENCE_PROVIDER_ID)).toEqual({
			type: "api_key",
			key: "prime-cli-key",
			primeTeam: { teamId: "cli-team", name: "CLI Research", role: "admin" },
		});
		expect(statusMessages.join("\n")).not.toContain(primeConfigPath);
	});

	it("does not import default CLI credentials when CLI reuse is disabled", async () => {
		process.env.HOME = tempDir;
		const defaultPrimeDir = join(tempDir, ".prime");
		mkdirSync(defaultPrimeDir, { recursive: true });
		writeFileSync(join(defaultPrimeDir, "config.json"), JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
		const { host, overlays } = createHost(authStorage);
		const result = new ProviderAuthFlows(host).runPrimeInferenceLogin();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.primeintellect.ai/api/v1/auth_challenge/generate");
		overlays[0]?.handleInput?.("\x1b");
		await expect(result).resolves.toEqual({ status: "cancelled" });
		expect(authStorage.has(PRIME_INFERENCE_PROVIDER_ID)).toBe(false);
	});

	it("does not offer logout for credentials owned only by the Prime CLI", async () => {
		writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, { primeCliConfigPath: primeConfigPath });
		const { host, overlays } = createHost(authStorage);
		await expect(new ProviderAuthFlows(host).runLogout()).resolves.toBeNull();
		expect(overlays).toHaveLength(0);
		expect(JSON.parse(readFileSync(primeConfigPath, "utf-8"))).toEqual({ api_key: "prime-cli-key" });
	});

	it.each([undefined, "https://agent-api.example/api/v1/"])(
		"uses the Agent auth target for manual validation and teams (%s)",
		async (override) => {
			delete process.env.PRIME_TEAM_ID;
			if (override) vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", override);
			const baseUrl = override ? "https://agent-api.example" : "https://api.primeintellect.ai";
			const original = JSON.stringify({
				api_key: "dev-secret",
				base_url: "https://dev-api.example",
				team_id: "dev-team",
			});
			writeFileSync(primeConfigPath, original);
			const authStorage = AuthStorage.create(authJsonPath, { primeCliConfigPath: primeConfigPath });
			const urls: string[] = [];
			vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
				const url = String(input);
				urls.push(url);
				if (url === `${baseUrl}/api/v1/auth_challenge/generate`) throw new Error("browser unavailable");
				expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer manual-key");
				if (url === `${baseUrl}/api/v1/user/whoami`)
					return jsonResponse({ data: { scope: { inference: { write: true } } } });
				if (url === `${baseUrl}/api/v1/user/teams?offset=0&limit=100`)
					return jsonResponse({ data: [], total_count: 0 });
				throw new Error(`Unexpected URL: ${url}`);
			});
			const { host, overlays, errorMessages } = createHost(authStorage);
			const result = new ProviderAuthFlows(host).runPrimeInferenceLogin();
			await vi.waitFor(() =>
				expect(stripAnsi(overlays[0]?.render(80).join("\n") ?? "")).toContain("Paste a Prime API key below:"),
			);
			overlays[0]?.handleInput?.("manual-key");
			overlays[0]?.handleInput?.("\r");
			await expect(result).resolves.toMatchObject({ status: "success" });
			expect(errorMessages).toEqual([]);
			expect(urls).toEqual([
				`${baseUrl}/api/v1/auth_challenge/generate`,
				`${baseUrl}/api/v1/user/whoami`,
				`${baseUrl}/api/v1/user/teams?offset=0&limit=100`,
			]);
			expect(authStorage.get(PRIME_INFERENCE_PROVIDER_ID)).toEqual({
				type: "api_key",
				key: "manual-key",
				primeTeam: null,
			});
			expect(readFileSync(primeConfigPath, "utf8")).toBe(original);
		},
	);

	it("includes xAI subscription and API-key entries from the provider registry", () => {
		const { host } = createHost(AuthStorage.inMemory());
		const flows = new ProviderAuthFlows({
			...host,
			modelRegistry: ModelRegistry.inMemory(host.modelRegistry.authStorage),
		});

		expect(flows.getLoginProviderOptions().filter((provider) => provider.id === "xai")).toEqual([
			{ id: "xai", name: "xAI (Grok)", authType: "oauth" },
			{ id: "xai", name: "xAI (Grok)", authType: "api_key" },
		]);
	});

	it("opens login on the requested MCP Connections category", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host, overlays } = createHost(authStorage);

		const loginResult = new ProviderAuthFlows(host).runLogin({ initialCategory: "service" });

		expect(overlays).toHaveLength(1);
		const output = stripAnsi(overlays[0]?.render(80).join("\n") ?? "");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
		overlays[0]?.handleInput?.("\x1b");
		await expect(loginResult).resolves.toEqual({ status: "cancelled" });
	});
});
