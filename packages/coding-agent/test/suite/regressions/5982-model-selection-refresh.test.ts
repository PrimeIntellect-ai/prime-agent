import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.js";
import { InProcessAgentConnection } from "../../../src/modes/agent-connection/in-process-agent-connection.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import { createHarness, type Harness } from "../harness.js";

const provider = "prime-inference";
const knownId = "internal/glm-5.2-fast";
const discoveredId = "internal/new-selection";
const primeUrl = "https://api.pinference.ai/api/v1/models";
const payload = {
	data: [
		{ id: knownId },
		{
			id: discoveredId,
			display_name: "New selection",
			pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
			specs: {
				context_window: 123456,
				max_output_tokens: 12345,
				supports_reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
			},
		},
	],
};
type ConnectionKind = "in-process" | "daemon";

function createSelection(harness: Harness, kind: ConnectionKind) {
	if (kind === "in-process") {
		const runtime = {
			session: harness.session,
			setRebindSession() {},
			setBeforeSessionInvalidate() {},
		} as unknown as AgentSessionRuntime;
		const connection = new InProcessAgentConnection(runtime);
		return (id: string) => connection.setModel(provider, id);
	}
	const daemon = Object.create(AgentDaemon.prototype) as {
		getSessionState(): Pick<ActiveSessionState, "runtime">;
		scheduleRosterFlush(): void;
		handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	};
	daemon.getSessionState = () => ({ runtime: { session: harness.session } as AgentSessionRuntime });
	daemon.scheduleRosterFlush = vi.fn();
	return (id: string) =>
		daemon.handleCommand({} as DaemonSocketClient, {
			id: "select-model",
			type: "set_model",
			activeSessionId: "active-session",
			provider,
			modelId: id,
		});
}

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe("ENG-5982 explicit model selection refresh", () => {
	let harness: Harness;
	const fetchFn = vi.fn<typeof fetch>();

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		fetchFn.mockReset().mockImplementation(async () => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetchFn);
		harness = await createHarness();
	});

	afterEach(async () => {
		await harness.session.modelRegistry.refreshAvailableModels({ background: false });
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	const cases = (["in-process", "daemon"] as const).flatMap((kind) =>
		(["login", "team switch"] as const).flatMap((change) =>
			[knownId, discoveredId].map((id) => ({ kind, change, id })),
		),
	);
	test.each(cases)("$kind waits once for $id after $change", async ({ kind, change, id }) => {
		const auth = harness.authStorage;
		const registry = harness.session.modelRegistry;
		if (change === "team switch") {
			auth.set(provider, { type: "api_key", key: "test-key", primeTeam: { teamId: "old-team", name: "Old" } });
			await registry.refreshAvailableModels({ background: false });
		}
		fetchFn.mockClear();
		const prime = deferredResponse();
		fetchFn.mockImplementation((url) =>
			url === primeUrl ? prime.promise : Promise.resolve(new Response(null, { status: 503 })),
		);
		auth.set(provider, { type: "api_key", key: "test-key", primeTeam: { teamId: "new-team", name: "New" } });
		expect(registry.getAvailable().some((model) => model.id === id)).toBe(false);
		if (id === knownId) expect(registry.find(provider, id)).toBeDefined();
		const refresh = vi.spyOn(registry, "refreshAvailableModels");
		const selected = createSelection(harness, kind)(id);
		let settled = false;
		void selected.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		try {
			await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
			expect(settled).toBe(false);
			prime.resolve(new Response(JSON.stringify(payload)));
			await selected;
			expect(harness.session.model?.id).toBe(id);
			expect(refresh).toHaveBeenCalledTimes(2);
			expect(refresh).toHaveBeenLastCalledWith({ background: false });
			expect(fetchFn.mock.calls.filter(([url]) => url === primeUrl)).toHaveLength(1);
		} finally {
			prime.resolve(new Response(null, { status: 503 }));
			await selected.catch(() => {});
		}
	});

	test.each(["in-process", "daemon"] as const)("%s keeps warm selections nonblocking", async (kind) => {
		const registry = harness.session.modelRegistry;
		harness.authStorage.set(provider, { type: "api_key", key: "test-key" });
		fetchFn.mockImplementation(async (url) =>
			url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
		);
		await registry.refreshAvailableModels({ background: false });
		const response = deferredResponse();
		fetchFn.mockImplementation(() => response.promise);
		const refresh = vi.spyOn(registry, "refreshAvailableModels");
		try {
			await createSelection(harness, kind)(knownId);
			expect(harness.session.model?.id).toBe(knownId);
			expect(refresh).toHaveBeenCalledOnce();
			expect(refresh).toHaveBeenCalledWith();
		} finally {
			response.resolve(new Response(null, { status: 503 }));
		}
	});

	test.each(["in-process", "daemon"] as const)("%s rejects a route denied by the new team", async (kind) => {
		const registry = harness.session.modelRegistry;
		harness.authStorage.set(provider, {
			type: "api_key",
			key: "test-key",
			primeTeam: { teamId: "old-team", name: "Old" },
		});
		fetchFn.mockImplementation(async (url) =>
			url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
		);
		await registry.refreshAvailableModels({ background: false });
		fetchFn.mockImplementation(async (url) =>
			url === primeUrl ? new Response(JSON.stringify({ data: [] })) : new Response(null, { status: 503 }),
		);
		harness.authStorage.setPrimeInferenceTeamSelection({ teamId: "new-team", name: "New" });
		await expect(createSelection(harness, kind)(knownId)).rejects.toThrow("Model not found");
		expect(harness.session.model?.provider).not.toBe(provider);
		expect(registry.getAvailable().some((model) => model.id === knownId)).toBe(false);
	});

	test.each(["in-process", "daemon"] as const)(
		"%s cannot use an old team's private cache to recover stale auth",
		async (kind) => {
			const registry = harness.session.modelRegistry;
			harness.authStorage.set(provider, {
				type: "api_key",
				key: "test-key",
				primeTeam: { teamId: "old-team", name: "Old" },
			});
			fetchFn.mockImplementation(async (url) =>
				url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
			);
			await registry.refreshAvailableModels({ background: false });
			vi.stubEnv("PI_OFFLINE", "1");
			harness.authStorage.setPrimeInferenceTeamSelection({ teamId: "new-team", name: "New" });
			harness.authStorage.markAuthStale(provider);
			await expect(createSelection(harness, kind)(knownId)).rejects.toThrow(
				"not available for the current Prime team",
			);
			expect(harness.session.model?.provider).not.toBe(provider);
			expect(registry.getProviderAuthStatus(provider).source).toBe("stale");
		},
	);

	test.each(["in-process", "daemon"] as const)(
		"%s preserves explicit retry for a cached authorized stale provider",
		async (kind) => {
			const registry = harness.session.modelRegistry;
			harness.authStorage.set(provider, { type: "api_key", key: "test-key" });
			fetchFn.mockImplementation(async (url) =>
				url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
			);
			await registry.refreshAvailableModels({ background: false });
			harness.authStorage.markAuthStale(provider);
			expect(registry.getProviderAuthStatus(provider).source).toBe("stale");
			await createSelection(harness, kind)(knownId);
			expect(harness.session.model?.id).toBe(knownId);
			expect(registry.getProviderAuthStatus(provider).source).not.toBe("stale");
		},
	);
});
