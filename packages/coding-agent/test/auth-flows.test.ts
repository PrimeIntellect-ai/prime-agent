import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID, PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryProperties } from "../src/core/telemetry.js";
import { reportTelemetryError, withTelemetryErrorContext } from "../src/core/telemetry-errors.js";
import {
	type AuthFlowObservation,
	ProviderAuthFlows,
	type ProviderAuthFlowsHost,
} from "../src/modes/interactive/auth-flows.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
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
	panels: Component[];
} {
	const statusMessages: string[] = [];
	const errorMessages: string[] = [];
	const overlays: Component[] = [];
	const panels: Component[] = [];
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
			showAuthPanel: (component) => {
				panels.push(component);
				return () => {
					const index = panels.lastIndexOf(component);
					if (index !== -1) {
						panels.splice(index, 1);
					}
				};
			},
			getAuthPanelRows: () => 24,
			getAvailableModels: async () => [],
		},
		statusMessages,
		errorMessages,
		overlays,
		panels,
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
		const observations: AuthFlowObservation[] = [];
		host.onAuthObservation = (observation) => observations.push(observation);
		const finish = vi.fn();
		host.onAuthenticationStarted = vi.fn(() => finish);

		const result = await new ProviderAuthFlows({ ...host, modelRegistry }).runPrimeInferenceLogin();

		expect(errorMessages).toEqual([]);
		expect(result.status).toBe("success");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "success" }));
		expect(observations).toContainEqual(
			expect.objectContaining({
				stage: "credential_validation",
				outcome: "completed",
				method: "existing_configuration",
				validationScope: "identity_scope",
				durationMs: expect.any(Number),
				systemWork: true,
			}),
		);
		expect(
			observations.some(
				(observation) =>
					observation.validationScope === "inference" || observation.validationScope === "selected_context",
			),
		).toBe(false);
		expect(JSON.stringify(observations)).not.toContain("prime-cli-key");
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
		const { host, overlays, panels } = createHost(authStorage);
		const result = new ProviderAuthFlows(host).runPrimeInferenceLogin();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.primeintellect.ai/api/v1/auth_challenge/generate");
		panels[0]?.handleInput?.("\x1b");
		await expect(result).resolves.toEqual({ status: "cancelled" });
		expect(authStorage.has(PRIME_INFERENCE_PROVIDER_ID)).toBe(false);
		// The login dialog mounts inline in the host, never as an overlay.
		expect(overlays).toHaveLength(0);
	});

	it("keeps trace login credentials and access checks separate from inference", async () => {
		process.env.HOME = tempDir;
		mkdirSync(join(tempDir, ".prime"));
		const config = JSON.stringify({ api_key: "trace-key", team_id: "existing-team" });
		const configPath = join(tempDir, ".prime", "config.json");
		writeFileSync(configPath, config);
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: true });
		const { host } = createHost(authStorage);
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(jsonResponse({ data: { scope: { agent_traces: { write: true } } } }));

		await expect(new ProviderAuthFlows(host).runPrimeAgentTracesLogin()).resolves.toMatchObject({
			status: "success",
		});
		expect(fetchMock).toHaveBeenCalledOnce();
		await expect(authStorage.getApiKey(PRIME_AGENT_TRACES_PROVIDER_ID)).resolves.toBe("trace-key");
		expect(authStorage.has(PRIME_INFERENCE_PROVIDER_ID)).toBe(false);
		expect(readFileSync(configPath, "utf8")).toBe(config);
	});

	it("does not offer logout for credentials owned only by the Prime CLI", async () => {
		writeFileSync(primeConfigPath, JSON.stringify({ api_key: "prime-cli-key" }));
		const authStorage = AuthStorage.create(authJsonPath, { primeCliConfigPath: primeConfigPath });
		const { host, overlays, panels } = createHost(authStorage);
		await expect(new ProviderAuthFlows(host).runLogout()).resolves.toBeNull();
		expect(overlays).toHaveLength(0);
		expect(panels).toHaveLength(0);
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
			const { host, overlays, panels, errorMessages } = createHost(authStorage);
			const result = new ProviderAuthFlows(host).runPrimeInferenceLogin();
			await vi.waitFor(() =>
				expect(stripAnsi(panels[0]?.render(80).join("\n") ?? "")).toContain("Paste a Prime API key below:"),
			);
			expect(overlays).toHaveLength(0);
			panels[0]?.handleInput?.("manual-key");
			panels[0]?.handleInput?.("\r");
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
		const { host, overlays, panels } = createHost(authStorage);

		const loginResult = new ProviderAuthFlows(host).runLogin({ initialCategory: "service" });

		expect(overlays).toHaveLength(0);
		expect(panels).toHaveLength(1);
		expect(panels[0]).toBeInstanceOf(OAuthSelectorComponent);
		const output = stripAnsi(panels[0]?.render(80).join("\n") ?? "");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
		panels[0]?.handleInput?.("\x1b");
		await expect(loginResult).resolves.toEqual({ status: "cancelled" });
		expect(panels).toHaveLength(0);
	});

	it("mounts the API key login dialog inline and unmounts it after submitting", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host, overlays, panels, statusMessages } = createHost(authStorage);

		const loginPromise = new ProviderAuthFlows(host).loginProvider({
			id: "xai",
			name: "xAI (Grok)",
			authType: "api_key",
		});

		await vi.waitFor(() => expect(stripAnsi(panels[0]?.render(80).join("\n") ?? "")).toContain("Enter API key:"));
		expect(panels[0]).toBeInstanceOf(LoginDialogComponent);
		expect(overlays).toHaveLength(0);
		panels[0]?.handleInput?.("test-key");
		panels[0]?.handleInput?.("\r");

		await expect(loginPromise).resolves.toMatchObject({ status: "success", providerId: "xai" });
		expect(panels).toHaveLength(0);
		expect(authStorage.get("xai")).toEqual({ type: "api_key", key: "test-key" });
		expect(statusMessages.join("\n")).toContain("Saved API key for xAI (Grok)");
	});

	it("restores the login dialog after an in-flow account selection", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host, panels } = createHost(authStorage);
		const loginSpy = vi.spyOn(authStorage, "login").mockImplementation(async (_providerId, handlers) => {
			await handlers?.onSelect?.({
				message: "Choose an account",
				options: [
					{ id: "personal", label: "Personal" },
					{ id: "business", label: "Business" },
				],
			});
		});

		const loginPromise = new ProviderAuthFlows(host).loginProvider({
			id: "anthropic",
			name: "Anthropic",
			authType: "oauth",
		});

		await vi.waitFor(() => expect(panels).toHaveLength(2));
		expect(panels[0]).toBeInstanceOf(LoginDialogComponent);
		expect(panels[1]).toBeInstanceOf(ExtensionSelectorComponent);
		const selectorOutput = stripAnsi(panels[1]?.render(80).join("\n") ?? "");
		expect(selectorOutput).toContain("Choose an account");
		expect(selectorOutput).toContain("Personal");
		expect(selectorOutput).toContain("Business");

		panels[1]?.handleInput?.("\r");

		await expect(loginPromise).resolves.toMatchObject({ status: "success", providerId: "anthropic" });
		// Selecting an option unmounts the selector and restores the login dialog,
		// which is then unmounted when the flow finishes.
		expect(panels).toHaveLength(0);
		expect(loginSpy).toHaveBeenCalledOnce();
	});

	it("reports an API key save as configured without claiming a provider check", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		const observations: AuthFlowObservation[] = [];
		host.onAuthObservation = (observation) => observations.push(observation);
		const finish = vi.fn();
		host.onAuthenticationStarted = () => finish;
		const fetchMock = vi.spyOn(globalThis, "fetch");
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("private-api-key");

		const result = await new ProviderAuthFlows(host).loginProvider({
			id: "openai",
			name: "OpenAI",
			authType: "api_key",
		});

		expect(result.status).toBe("success");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(finish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: "success" }));
		expect(observations).toEqual([
			{
				providerId: "openai",
				stage: "credential_discovery",
				outcome: "configured",
				method: "api_key_entry",
				validationScope: "configuration",
			},
			{
				providerId: "openai",
				stage: "credential_validation",
				outcome: "unavailable",
				method: "api_key_entry",
				validationScope: "unchecked",
			},
		]);
		expect(JSON.stringify(observations)).not.toContain("private-api-key");
	});

	it("reports cancellation without manufacturing a failed authentication check", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		const finish = vi.fn();
		host.onAuthenticationStarted = () => finish;
		host.onAuthObservation = vi.fn();
		host.onAuthError = vi.fn();
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockRejectedValue(new Error("Login cancelled"));

		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toEqual({ status: "cancelled" });
		expect(finish).toHaveBeenCalledExactlyOnceWith({ status: "cancelled" });
		expect(host.onAuthObservation).not.toHaveBeenCalled();
		expect(host.onAuthError).not.toHaveBeenCalled();
	});

	it("reports failed logout separately from cancel and unavailable credentials", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		authStorage.set("openai", { type: "api_key", key: "private-api-key" });
		const { host, panels } = createHost(authStorage);
		const failure = new Error("Permission denied");
		vi.spyOn(authStorage, "logout").mockImplementation(() => {
			throw failure;
		});
		host.onAuthError = vi.fn();
		const finish = vi.fn();

		const result = new ProviderAuthFlows(host).runLogout(finish);
		// The logout selector renders inline under the chat, not as an overlay.
		panels[0]?.handleInput?.("\r");

		await expect(result).resolves.toBeNull();
		expect(finish).toHaveBeenCalledExactlyOnceWith("failed");
		expect(host.onAuthError).toHaveBeenCalledExactlyOnceWith(failure, "openai", "logout");
	});

	it("does not let optional observation callbacks interrupt a login", async () => {
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		host.onAuthenticationStarted = () => {
			throw new Error("observer failed");
		};
		host.onAuthObservation = () => {
			throw new Error("observer failed");
		};
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("private-api-key");

		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toMatchObject({ status: "success" });
	});

	it("reports a failed OAuth login once, from the UI scope only", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
		const reports: TelemetryProperties[] = [];
		const authStorage = AuthStorage.create(authJsonPath, {
			usePrimeCliConfig: false,
			telemetryErrorContext: {
				agentDir: tempDir,
				settingsManager: SettingsManager.inMemory(),
				sink: { capture: (_name, properties) => reports.push(properties), flush: async () => {} },
			},
		});
		const failure = new Error("Provider denied the login");
		registerOAuthProvider({
			id: "faux-oauth",
			name: "Faux",
			login: async () => {
				throw failure;
			},
		} as never);
		onTestFinished(() => unregisterOAuthProvider("faux-oauth"));

		await expect(authStorage.login("faux-oauth" as never, {} as never)).rejects.toThrow(failure);

		// The login UI reports this failure inside the authentication scope, so a
		// storage-level report would upload the same failure under a second scope.
		expect(reports).toEqual([]);
	});

	it("wraps source and host error observations in the same UI authentication scope", async () => {
		vi.stubEnv("DO_NOT_TRACK", "0");
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "");
		const authStorage = AuthStorage.create(authJsonPath, { usePrimeCliConfig: false });
		const { host } = createHost(authStorage);
		const reports: TelemetryProperties[] = [];
		const error = new Error("Provider authentication failed");
		const report = () =>
			reportTelemetryError({ error, component: "authentication", operation: "login", provider: "openai" });
		host.runWithAuthTelemetry = (run) =>
			withTelemetryErrorContext(
				{
					agentDir: tempDir,
					settingsManager: SettingsManager.inMemory(),
					clientSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
					sink: { capture: (_name, properties) => reports.push(properties), flush: async () => {} },
				},
				run,
			);
		host.onAuthError = report;
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("private-api-key");
		vi.spyOn(authStorage, "set").mockImplementation(() => {
			report();
			throw error;
		});
		await expect(
			new ProviderAuthFlows(host).loginProvider({ id: "openai", name: "OpenAI", authType: "api_key" }),
		).resolves.toEqual({ status: "failed" });
		expect(reports).toHaveLength(1);
		expect(reports[0].client_session_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
		expect(JSON.stringify(reports)).not.toContain("private-api-key");
	});
});
