import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudGuestDaemon, parseCloudDaemonEnv } from "../src/modes/cloud/cloud-daemon.js";
import { cloudTemp } from "./cloud-support.js";
import { createFauxRuntimeFactory, createFauxRuntimeFactoryWithModels } from "./fixtures/cloud-guest-daemon-fixture.js";

/**
 * Guest model-resolution regressions: a private Prime Inference route that
 * only the authenticated entitlement catalog supplies must open the cloud
 * session (the bundled registry alone cannot resolve it), a route the refresh
 * cannot authorize must fail honestly, and bundled models must resolve
 * without any network refresh.
 */

afterEach(async () => {
	vi.unstubAllGlobals();
	// Let a queued mirror pass settle before the temp state disappears.
	await new Promise((resolve) => setImmediate(resolve));
});

const SESSION_ID = "sess_model_resolution_test";
const BRIDGE_TOKEN = "t".repeat(64);
const PRIVATE_MODEL = "prime-inference/internal/glm-5.3-fast";

function guestEnv(root: string, options: { model?: string } = {}) {
	return parseCloudDaemonEnv(
		{
			PRIME_AGENT_CLOUD_DAEMON_SOCKET: join(root, "cloud.sock"),
			PRIME_AGENT_CLOUD_SESSION_ID: SESSION_ID,
			PRIME_AGENT_CLOUD_GENERATION: "1",
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: join(root, "workspace"),
			PRIME_AGENT_CLOUD_AGENT_DIR: join(root, "agent"),
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: BRIDGE_TOKEN,
			PRIME_AGENT_CLOUD_MODEL: options.model ?? "",
			PRIME_AGENT_CLOUD_DAEMON_STATE_DIR: join(root, "daemon-state"),
		},
		{ stateDir: join(root, "daemon-state") },
	);
}

/** The stored Prime Inference credential the guest resolves team entitlements with. */
function writePrimeInferenceAuth(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "auth.json"),
		`${JSON.stringify(
			{
				"prime-inference": {
					type: "api_key",
					key: "prime-key",
					primeTeam: { teamId: "engineering-team", name: "Prime Engineering" },
				},
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600 },
	);
}

/** Case-tolerant header lookup for the stubbed fetch's RequestInit headers. */
function headerValue(init: RequestInit | undefined, name: string): string | undefined {
	const headers = init?.headers;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	if (Array.isArray(headers)) return headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	return headers ? (headers as Record<string, string>)[name] : undefined;
}

/** A private route with full specs: buildable without any bundled template. */
const PRIVATE_MODEL_CATALOG = {
	data: [
		{
			id: "internal/glm-5.3-fast",
			display_name: "GLM 5.3 Fast",
			pricing: {
				input_usd_per_mtok: 0,
				output_usd_per_mtok: 0,
				cache_read_usd_per_mtok: 0,
				cache_write_usd_per_mtok: 0,
			},
			specs: {
				context_window: 400_000,
				max_output_tokens: 131_072,
				modalities: { input: ["text"], output: ["text"] },
				supports_reasoning: true,
			},
		},
	],
};

describe("resident guest daemon model resolution", () => {
	it("opens with a private model supplied only by the refreshed Prime Inference catalog", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		writePrimeInferenceAuth(join(root, "agent"));
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify(PRIVATE_MODEL_CATALOG), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: PRIVATE_MODEL });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await daemon.openSession({});
			// The session runs the exact selected route, built from the
			// refreshed entitlement catalog, never a silent image default.
			expect(daemon.rootSession?.model).toMatchObject({
				provider: "prime-inference",
				id: "internal/glm-5.3-fast",
				api: "openai-completions",
				baseUrl: "https://api.pinference.ai/api/v1",
				reasoning: true,
				contextWindow: 400_000,
				maxTokens: 131_072,
			});
			const entitlementFetch = fetchMock.mock.calls.find(
				([, init]) => headerValue(init, "X-Prime-Team-ID") === "engineering-team",
			);
			expect(entitlementFetch).toBeDefined();
			expect(headerValue(entitlementFetch?.[1], "Authorization")).toBe("Bearer prime-key");

			// A resident session inherits the duplicate open's exact selected
			// model/thinking: the boot open only knows the model env.
			const applied = await daemon.dispatch(
				{
					kind: "open_session",
					cwd: env.workspaceDir,
					model: PRIVATE_MODEL,
					thinking: "high",
				},
				`cmd_open_${SESSION_ID}`,
			);
			expect(applied.state).toBe("completed");
			expect(daemon.rootSession?.model?.provider).toBe("prime-inference");
			expect(daemon.rootSession?.model?.id).toBe("internal/glm-5.3-fast");
			expect(daemon.rootSession?.thinkingLevel).toBe("high");
		} finally {
			await daemon.stop();
		}
	});

	it("fails an open whose private model the refreshed catalog does not authorize", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		writePrimeInferenceAuth(join(root, "agent"));
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: PRIVATE_MODEL });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await expect(daemon.openSession({})).rejects.toThrow("unknown model prime-inference/internal/glm-5.3-fast");
			// The refresh ran before the model was declared unknown, and the
			// honest failure leaves no session manifest behind.
			expect(fetchMock).toHaveBeenCalled();
			expect(existsSync(join(env.stateDir, "session-file.json"))).toBe(false);
		} finally {
			await daemon.stop();
		}
	});

	it("recovers a private model after a transient first entitlement outcome", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		writePrimeInferenceAuth(join(root, "agent"));
		// The live incident shape: the first authenticated entitlement fetch
		// transiently reports no private routes; the identical request
		// succeeds moments later. The bounded retry must recover the model
		// instead of failing the open into a guest restart loop.
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
			.mockImplementation(async () => new Response(JSON.stringify(PRIVATE_MODEL_CATALOG), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: PRIVATE_MODEL });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await daemon.openSession({});
			expect(daemon.rootSession?.model).toMatchObject({
				provider: "prime-inference",
				id: "internal/glm-5.3-fast",
			});
			// One initial refresh plus one bounded retry; never a silent fallback.
			const entitlementFetches = fetchMock.mock.calls.filter(
				([, init]) => headerValue(init, "X-Prime-Team-ID") === "engineering-team",
			);
			expect(entitlementFetches).toHaveLength(2);
		} finally {
			await daemon.stop();
		}
	});

	it("bounds entitlement refresh attempts before the honest unknown-model failure", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		writePrimeInferenceAuth(join(root, "agent"));
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: PRIVATE_MODEL });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await expect(daemon.openSession({})).rejects.toThrow("unknown model prime-inference/internal/glm-5.3-fast");
			// A team with genuinely no private models fails after the small
			// bounded refresh set — never a loop — and leaves no session manifest.
			const entitlementFetches = fetchMock.mock.calls.filter(
				([, init]) => headerValue(init, "X-Prime-Team-ID") === "engineering-team",
			);
			expect(entitlementFetches).toHaveLength(3);
			expect(existsSync(join(env.stateDir, "session-file.json"))).toBe(false);
		} finally {
			await daemon.stop();
		}
	});

	it("does not retry a non-private model miss", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		writePrimeInferenceAuth(join(root, "agent"));
		const fetchMock = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				new Response(JSON.stringify({ data: [] }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: "faux/faux-unknown" });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await expect(daemon.openSession({})).rejects.toThrow("unknown model faux/faux-unknown");
			// Only the initial refresh runs: an unknown non-private route never
			// enters the private-entitlement retry loop.
			const entitlementFetches = fetchMock.mock.calls.filter(
				([, init]) => headerValue(init, "X-Prime-Team-ID") === "engineering-team",
			);
			expect(entitlementFetches).toHaveLength(1);
		} finally {
			await daemon.stop();
		}
	});

	it("resolves a bundled model without any catalog refresh", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		const fetchMock = vi.fn(async () => {
			throw new Error("bundled model resolution must not fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root, { model: "faux/faux-1" });
		const daemon = await CloudGuestDaemon.start(env, { createRuntime: createFauxRuntimeFactory });
		try {
			await daemon.openSession({});
			expect(daemon.rootSession?.model).toMatchObject({ provider: "faux", id: "faux-1" });
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await daemon.stop();
		}
	});

	it("applies canonical selectors with slash-bearing and slash-free model ids exactly", async () => {
		const root = cloudTemp("cloud-guest-model-resolution-");
		const fetchMock = vi.fn(async () => {
			throw new Error("registered model resolution must not fetch");
		});
		vi.stubGlobal("fetch", fetchMock);
		const env = guestEnv(root);
		const daemon = await CloudGuestDaemon.start(env, {
			createRuntime: createFauxRuntimeFactoryWithModels([
				{ provider: "openrouter", models: [{ id: "z-ai/glm-4.5", name: "Z.ai: GLM 4.5" }] },
				{ provider: "mistral", models: [{ id: "zai-glm-5-2", name: "GLM-5.2" }] },
			]),
		});
		try {
			await daemon.openSession({});
			// A bundled-style `z-ai/glm` id survives the first-slash split as the
			// full model id under its provider.
			const zai = await daemon.dispatch(
				{ kind: "open_session", cwd: env.workspaceDir, model: "openrouter/z-ai/glm-4.5" },
				`cmd_open_zai_${SESSION_ID}`,
			);
			expect(zai.state).toBe("completed");
			expect(daemon.rootSession?.model?.provider).toBe("openrouter");
			expect(daemon.rootSession?.model?.id).toBe("z-ai/glm-4.5");
			// A provider and model id without slashes stay intact.
			const simple = await daemon.dispatch(
				{ kind: "open_session", cwd: env.workspaceDir, model: "mistral/zai-glm-5-2" },
				`cmd_open_simple_${SESSION_ID}`,
			);
			expect(simple.state).toBe("completed");
			expect(daemon.rootSession?.model?.provider).toBe("mistral");
			expect(daemon.rootSession?.model?.id).toBe("zai-glm-5-2");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			await daemon.stop();
		}
	});
});
