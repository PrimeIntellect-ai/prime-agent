import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ENV_AGENT_DIR, getAgentDir } from "../../../src/config.js";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import type { ModelRegistry } from "../../../src/core/model-registry.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createDefaultRuntimeFactory } from "../../../src/main.js";
import { ProviderAuthFlows } from "../../../src/modes/interactive/auth-flows.js";
import {
	createInteractiveModeUiServices,
	createInteractiveModeUiServicesFromServices,
} from "../../../src/modes/interactive/interactive-mode-services.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const resourceOptions = {
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
};

function fakeTui(): TUI {
	return {
		terminal: { columns: 80, rows: 24 },
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => ({
			hide: vi.fn(),
			setHidden: vi.fn(),
			isHidden: () => false,
			focus: vi.fn(),
			unfocus: vi.fn(),
			isFocused: () => true,
		})),
	} as unknown as TUI;
}

describe("ENG-6058 startup auth factory wiring", () => {
	let harness: Harness;
	let cliPath: string;
	const dispose: Array<() => void> = [];
	beforeEach(async () => {
		harness = await createHarness();
		vi.stubEnv("HOME", harness.tempDir);
		vi.stubEnv(ENV_AGENT_DIR, "");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_API_BASE_URL", "");
		vi.stubEnv("PRIME_AGENT_INFERENCE_FRONTEND_URL", "");
		vi.stubEnv("PRIME_AGENT_TRACES_BASE_URL", "");
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("DO_NOT_TRACK", "1");
		mkdirSync(join(harness.tempDir, ".prime"), { recursive: true });
		cliPath = join(harness.tempDir, ".prime", "config.json");
		writeFileSync(cliPath, JSON.stringify({ api_key: "fixture-production-key" }));
		initTheme("dark");
	});
	afterEach(() => {
		for (const cleanup of dispose.splice(0)) cleanup();
		harness.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function verifyInteractiveImport(modelRegistry: ModelRegistry): Promise<void> {
		const auth = modelRegistry.authStorage;
		expect(auth.getPrimeCliConfigPath()).toBe(cliPath);
		expect(auth.hasAuth("prime-inference")).toBe(false);
		await expect(auth.getApiKey("prime-inference")).resolves.toBeUndefined();
		const originalCli = readFileSync(cliPath, "utf8");
		const urls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			urls.push(String(url));
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-production-key");
			if (String(url) === "https://api.primeintellect.ai/api/v1/user/whoami") {
				return new Response(JSON.stringify({ data: { scope: { inference: { write: true } } } }));
			}
			expect(String(url)).toBe("https://api.primeintellect.ai/api/v1/user/teams?offset=0&limit=100");
			return new Response(JSON.stringify({ data: [], total_count: 0 }));
		});
		const showError = vi.fn();
		const flow = new ProviderAuthFlows({
			ui: fakeTui(),
			modelRegistry,
			showStatus: vi.fn(),
			showError,
			getAvailableModels: async () => [],
		});
		await expect(flow.runPrimeInferenceLogin()).resolves.toMatchObject({ status: "success" });
		expect(showError).not.toHaveBeenCalled();
		expect(urls).toHaveLength(2);
		expect(readFileSync(cliPath, "utf8")).toBe(originalCli);
		expect(AuthStorage.create().get("prime-inference")).toEqual({
			type: "api_key",
			key: "fixture-production-key",
			primeTeam: null,
		});
		writeFileSync(cliPath, JSON.stringify({ api_key: "fixture-dev-key", base_url: "https://dev.invalid" }));
		await expect(AuthStorage.create().getApiKey("prime-inference")).resolves.toBe("fixture-production-key");
	}

	test("production runtime factory passes import-enabled auth to interactive UI", async () => {
		const factory = createDefaultRuntimeFactory({ ...resourceOptions, noTools: true, telemetryDisabled: true });
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		const created = await factory({
			cwd: harness.tempDir,
			agentDir: getAgentDir(),
			sessionManager,
			sessionOptions: { model: harness.getModel(), noTools: "all" },
		});
		dispose.push(() => created.session.dispose());
		const ui = createInteractiveModeUiServicesFromServices({ services: created.services, sessionManager });
		await verifyInteractiveImport(ui.modelRegistry);
	});

	test("bare SDK default auth supports explicit interactive import", async () => {
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			model: harness.getModel(),
			noTools: "all",
			resourceLoader: harness.session.resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		dispose.push(() => session.dispose());
		await verifyInteractiveImport(createInteractiveModeUiServices(session).modelRegistry);
	});

	test("default public services factory supports explicit interactive import", async () => {
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			resourceLoaderOptions: resourceOptions,
			telemetryDisabled: true,
		});
		const ui = createInteractiveModeUiServicesFromServices({
			services,
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		await verifyInteractiveImport(ui.modelRegistry);
	});

	test("explicit services and SDK agent directories stay isolated", async () => {
		const agentDir = join(harness.tempDir, "custom-agent");
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir,
			resourceLoaderOptions: resourceOptions,
			telemetryDisabled: true,
		});
		expect(services.authStorage.getPrimeCliConfigPath()).toBeUndefined();
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			agentDir,
			model: harness.getModel(),
			noTools: "all",
			resourceLoader: harness.session.resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		dispose.push(() => session.dispose());
		expect(session.modelRegistry.authStorage.getPrimeCliConfigPath()).toBeUndefined();
	});

	test("injected in-memory storage remains isolated in services and SDK", async () => {
		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			authStorage,
			resourceLoaderOptions: resourceOptions,
			telemetryDisabled: true,
		});
		expect(services.authStorage).toBe(authStorage);
		const { session } = await createAgentSession({
			cwd: harness.tempDir,
			authStorage,
			model: harness.getModel(),
			noTools: "all",
			resourceLoader: harness.session.resourceLoader,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(harness.tempDir),
		});
		dispose.push(() => session.dispose());
		expect(session.modelRegistry.authStorage).toBe(authStorage);
		expect(authStorage.getPrimeCliConfigPath()).toBeUndefined();
		await expect(authStorage.getApiKey("prime-inference")).resolves.toBeUndefined();
	});
});
