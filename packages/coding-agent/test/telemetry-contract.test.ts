import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	captureAgentCommandUsed,
	captureTelemetryEvent,
	type TelemetryBatch,
	TelemetryClient,
} from "../src/core/telemetry.js";
import { TELEMETRY_CONTRACT } from "../src/core/telemetry-contract.js";
import { TELEMETRY_ERROR_MESSAGES } from "../src/core/telemetry-error-classification.js";
import { TELEMETRY_SAFE_ERROR_MESSAGES } from "../src/core/telemetry-error-policy.js";
import { sanitizeTelemetryProperties, TELEMETRY_ERROR_MESSAGE_PROPERTIES } from "../src/core/telemetry-schema.js";

const base = {
	session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	version: "0.9.3",
	os_family: "darwin",
	architecture: "arm64",
	install_method: "homebrew",
	execution_mode: "interactive",
};
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const errorId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const error = { ...base, session_id: sessionId, run_id: runId, error_id: errorId, error_subtype: "credential_invalid" };
const reviewedError = {
	...error,
	error_message: TELEMETRY_SAFE_ERROR_MESSAGES.prime_request_timeout,
	error_message_id: "prime_request_timeout",
	error_code_group: "ETIMEDOUT",
	error_event_kind: "occurrence",
};
const installationStage = {
	...base,
	installation_attempt_id: runId,
	installation_action: "update",
	installation_source: "interactive",
	stage: "package_install",
	outcome: "success",
	schema_revision: 3,
};
function ids(): () => string {
	let id = 0;
	return () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`;
}
function directory(): string {
	return mkdtempSync(join(tmpdir(), "telemetry-contract-"));
}
function capabilities(): Response {
	return Response.json({ schema_versions: [1, 2], schema_revision: 1 });
}
function accepted(batch: TelemetryBatch): Response {
	return Response.json(
		{
			accepted: batch.events.length,
			accepted_ids: batch.events.map((event) => event.id),
			dropped_ids: [],
			retry_ids: [],
		},
		{ status: 202 },
	);
}

beforeEach(() => vi.stubEnv("DO_NOT_TRACK", "0"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("shared telemetry contract and privacy", () => {
	it("keeps the collector descriptor and reviewed diagnostic templates identical", () => {
		expect(JSON.parse(readFileSync(new URL("../docs/telemetry-contract.json", import.meta.url), "utf8"))).toEqual(
			TELEMETRY_CONTRACT,
		);
		expect(TELEMETRY_CONTRACT.diagnostic_messages).toEqual(TELEMETRY_ERROR_MESSAGES);
	});
	it("strips private canaries before any sink or queue sees them", () => {
		const canary = "private@example.test /Users/private/repo sk-private https://secret.test/?token=private";
		const properties = {
			...error,
			diagnostic_message: canary,
			version: "0.9.3-private",
			provider_category: canary,
			model_category: canary,
			request_id: canary,
			stack: canary,
			prompt: canary,
			output: canary,
			api_key: canary,
			args: { secret: canary },
		};
		const safe = sanitizeTelemetryProperties("agent error", properties);
		expect(safe).toMatchObject({
			version: "0.0.0",
			provider_category: "custom",
			model_category: "custom",
			diagnostic_message: TELEMETRY_ERROR_MESSAGES.credential_invalid,
		});
		expect(JSON.stringify(safe)).not.toContain("private");
		expect(safe).not.toHaveProperty("request_id");
	});
	it("does not evaluate getters and rejects unknown events or required fields", () => {
		const properties = { ...base };
		Object.defineProperty(properties, "version", {
			get: () => {
				throw new Error("private getter");
			},
		});
		expect(sanitizeTelemetryProperties("agent started", properties)).toBeUndefined();
		expect(sanitizeTelemetryProperties("toString", base)).toBeUndefined();
		expect(sanitizeTelemetryProperties("agent run started", base)).toBeUndefined();
		expect(sanitizeTelemetryProperties("agent error", { ...error, http_status: Number.NaN })).not.toHaveProperty(
			"http_status",
		);
	});
	it("binds original messages to reviewed text and reconstructs their provenance independently", () => {
		const safe = sanitizeTelemetryProperties("agent error", {
			...reviewedError,
			error_message_source: "system_template",
			error_message_length: 8_000,
			error_message_truncated: true,
			error_message_redacted: true,
		});
		expect(safe).toMatchObject({
			error_message: reviewedError.error_message,
			error_message_id: "prime_request_timeout",
			error_message_source: "reviewed_literal",
			error_code_group: "ETIMEDOUT",
			error_message_length: reviewedError.error_message.length,
			error_message_truncated: false,
			error_message_redacted: false,
		});
		expect(sanitizeTelemetryProperties("agent error", safe ?? {})).toEqual(safe);
	});
	it.each([
		{ error_message_id: undefined },
		{ error_message_id: "unreviewed_error" },
		{ error_message: "private_prompt_canary", error_message_source: "reviewed_literal" },
		{ error_message: `${reviewedError.error_message}: private_prompt_canary` },
		{ error_message: 'Worker failed: token="synthetic-secret" prompt="private_prompt_canary"' },
		{ error_message: null },
		{ error_message: { message: "private_prompt_canary" } },
	])("omits untrusted text and all related metadata: %j", (override) => {
		const safe = sanitizeTelemetryProperties("agent error", {
			...reviewedError,
			error_message_length: 1_000,
			error_message_truncated: true,
			error_message_redacted: true,
			...override,
		});
		for (const key of TELEMETRY_ERROR_MESSAGE_PROPERTIES) expect(safe).not.toHaveProperty(key);
		expect(safe).toMatchObject({ error_code_group: "ETIMEDOUT", error_subtype: "credential_invalid" });
		expect(JSON.stringify(safe)).not.toContain("private_prompt_canary");
	});
	it("accepts scoped input timings but rejects unrelated prompt and connection data", () => {
		const input = sanitizeTelemetryProperties("agent input stage", {
			...base,
			input_id: errorId,
			stage: "received",
			outcome: "started",
			timing_origin: "worker_input",
			duration_ms: null,
			setup_team_scope_changed: null,
			ui_auth_source_changed: true,
			endpoint_category: "custom",
			context_source: "request",
			prompt: "private prompt",
			headers: { token: "private secret" },
		});
		expect(input).toMatchObject({
			input_id: errorId,
			duration_ms: null,
			setup_team_scope_changed: null,
			ui_auth_source_changed: true,
			timing_origin: "worker_input",
			endpoint_category: "custom",
		});
		expect(JSON.stringify(input)).not.toContain("private");
	});
	it("accepts installation outcomes without allowing command output or private version labels", () => {
		const properties = sanitizeTelemetryProperties("agent installation stage", {
			...installationStage,
			from_version: "0.9.1",
			target_version: "0.9.2-private_canary",
			observed_version: "https://private_canary.test/release",
			reason: "private_canary",
			duration_ms: null,
			exit_code: 1,
			error_message: "private_canary",
			stderr: "private_canary",
			command: "private_canary",
			download_url: "private_canary",
		});
		expect(properties).toMatchObject({
			installation_attempt_id: runId,
			from_version: "0.9.1",
			target_version: "0.0.0",
			observed_version: "0.0.0",
			reason: "unknown",
			duration_ms: null,
			exit_code: 1,
		});
		expect(JSON.stringify(properties)).not.toContain("private_canary");
		for (const field of ["installation_action", "installation_source", "stage", "outcome"]) {
			expect(
				sanitizeTelemetryProperties("agent installation stage", {
					...installationStage,
					[field]: "private_canary",
				}),
			).toBeUndefined();
		}
	});
});

describe("version negotiation, retry and consent", () => {
	it.each([undefined, 1, 2, "3", 3])(
		"sends installation outcomes only after a revision 3 collector is discovered: %j",
		async (revision) => {
			const batches: TelemetryBatch[] = [];
			const client = new TelemetryClient({
				agentDir: directory(),
				randomId: ids(),
				fetch: async (_url, init) => {
					if (init?.method === "GET") return Response.json({ schema_versions: [1, 2], schema_revision: revision });
					const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
					batches.push(batch);
					return accepted(batch);
				},
			});
			client.capture("agent installation stage", installationStage);
			client.capture("agent started", base);
			await client.flush();
			expect(batches).toHaveLength(1);
			expect(batches[0].events.map((event) => event.name)).toEqual(
				revision === 3 ? ["agent installation stage", "agent started"] : ["agent started"],
			);
			expect(batches[0].schema_version).toBe(2);
		},
	);
	it("retains unsupported installation stages until collector revision 3 is discovered", async () => {
		let revision = 2;
		let now = Date.now();
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			randomId: ids(),
			now: () => now,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return Response.json({ schema_versions: [1, 2], schema_revision: revision });
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return accepted(batch);
			},
		});
		client.capture("agent installation stage", installationStage);
		client.capture("agent started", base);
		await client.flush();
		expect(batches.flatMap((batch) => batch.events.map((event) => event.name))).toEqual(["agent started"]);
		revision = 3;
		now += 60_001;
		await client.flush();
		expect(batches[1].events).toHaveLength(1);
		expect(batches[1].events[0]).toMatchObject({
			name: "agent installation stage",
			properties: { installation_attempt_id: runId, installation_source: "interactive", stage: "package_install" },
		});
		await client.flush();
		expect(batches).toHaveLength(2);
	});
	it.each([
		{ original_error_messages: true, error_message_policy_revision: 1, expected: true },
		{ original_error_messages: false, error_message_policy_revision: 1, expected: false },
		{ original_error_messages: true, error_message_policy_revision: 2, expected: false },
		{ original_error_messages: true, expected: false },
		{ expected: false },
	])("negotiates the exact original-message policy: %j", async ({ expected, ...support }) => {
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			randomId: ids(),
			fetch: async (_url, init) => {
				if (init?.method === "GET") return Response.json({ schema_versions: [1, 2], ...support });
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return accepted(batch);
			},
		});
		client.capture("agent error", reviewedError);
		client.capture("agent error", {
			...reviewedError,
			error_message: "private_prompt_canary sk-syntheticsecret",
			error_code_group: "private_prompt_canary",
		});
		await client.flush();
		expect(batches).toHaveLength(1);
		expect(batches[0].schema_version).toBe(2);
		const [first, second] = batches[0].events;
		expect(first.properties).toMatchObject({ error_code_group: "ETIMEDOUT", error_event_kind: "occurrence" });
		if (expected) expect(first.properties.error_message).toBe(reviewedError.error_message);
		else for (const key of TELEMETRY_ERROR_MESSAGE_PROPERTIES) expect(first.properties).not.toHaveProperty(key);
		for (const key of TELEMETRY_ERROR_MESSAGE_PROPERTIES) expect(second.properties).not.toHaveProperty(key);
		expect(second.properties.error_code_group).toBe("unknown");
		expect(JSON.stringify(batches)).not.toContain("private_prompt_canary");
		expect(JSON.stringify(batches)).not.toContain("sk-syntheticsecret");
	});
	it("does not create identity, discover capabilities, or send errors when opted out", async () => {
		const agentDir = directory();
		const fetch = vi.fn();
		const client = new TelemetryClient({ agentDir, isEnabled: () => false, fetch });
		client.capture("agent error", reviewedError);
		await client.flush();
		expect(fetch).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});
	it.each(["unavailable", "malformed", "oversized", "mismatched", "network_error"])(
		"expires a previously accepted message policy when discovery becomes %s",
		async (failure) => {
			let now = Date.now();
			let discoveries = 0;
			const batches: TelemetryBatch[] = [];
			const client = new TelemetryClient({
				agentDir: directory(),
				now: () => now,
				fetch: async (_url, init) => {
					if (init?.method === "GET") {
						if (++discoveries === 1)
							return Response.json({
								schema_versions: [1, 2],
								original_error_messages: true,
								error_message_policy_revision: 1,
							});
						if (failure === "unavailable") return new Response(null, { status: 404 });
						if (failure === "malformed") return new Response("not JSON");
						if (failure === "oversized") return new Response("x".repeat(4_097));
						if (failure === "network_error") throw new Error("Synthetic discovery failure");
						return Response.json({
							schema_versions: [1, 2],
							original_error_messages: true,
							error_message_policy_revision: 2,
						});
					}
					const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
					batches.push(batch);
					return accepted(batch);
				},
			});
			client.capture("agent error", reviewedError);
			await client.flush();
			expect(batches[0].events[0].properties.error_message).toBe(reviewedError.error_message);
			now += 60_001;
			client.capture("agent error", reviewedError);
			await client.flush();
			expect(discoveries).toBe(2);
			expect(batches).toHaveLength(2);
			expect(batches[1].schema_version).toBe(2);
			expect(batches[1].events[0].properties.error_code_group).toBe("ETIMEDOUT");
			for (const key of TELEMETRY_ERROR_MESSAGE_PROPERTIES)
				expect(batches[1].events[0].properties).not.toHaveProperty(key);
		},
	);
	it("isolates malformed direct sink payloads before identity creation", () => {
		const agentDir = directory();
		const client = new TelemetryClient({ agentDir });
		const payload = new Proxy(base, {
			getOwnPropertyDescriptor() {
				throw new Error("private accessor");
			},
		});
		expect(() => client.capture("agent started", payload)).not.toThrow();
		expect(client.delivery.rejected).toBe(1);
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});
	it("sends only legacy fields and names to an old collector", async () => {
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			randomId: ids(),
			fetch: async (_url, init) => {
				if (init?.method === "GET") return new Response(null, { status: 404 });
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return Response.json({ accepted: batch.events.length }, { status: 202 });
			},
		});
		client.capture("agent error", error);
		client.capture("agent started", {
			...base,
			schema_revision: 1,
			session_id: sessionId,
			private_data: "never send",
		});
		await client.flush();
		expect(batches).toHaveLength(1);
		expect(batches[0]).not.toHaveProperty("schema_version");
		expect(batches[0].events.map((event) => event.name)).toEqual(["agent started"]);
		expect(batches[0].events[0].properties).toEqual({ ...base, install_method: "unknown", session_id: sessionId });
	});
	it("delivers short-lived v2 runs and retries only unacknowledged stable IDs", async () => {
		const batches: TelemetryBatch[] = [];
		let partial = true;
		const client = new TelemetryClient({
			agentDir: directory(),
			randomId: ids(),
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				if (partial) {
					partial = false;
					return Response.json(
						{ accepted: 1, accepted_ids: [batch.events[0].id], dropped_ids: [], retry_ids: [batch.events[1].id] },
						{ status: 202 },
					);
				}
				return accepted(batch);
			},
		});
		client.capture("agent run started", { ...base, session_id: sessionId, run_id: runId });
		client.capture("agent error", error);
		await client.flush();
		await client.flush();
		expect(batches.map((batch) => batch.schema_version)).toEqual([2, 2]);
		expect(batches[1].events.map((event) => event.id)).toEqual([batches[0].events[1].id]);
		expect(client.delivery.accepted).toBe(2);
	});
	it("falls back safely when the collector is rolled back after capability discovery", async () => {
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			randomId: ids(),
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return batch.schema_version
					? new Response(null, { status: 422 })
					: Response.json({ accepted: batch.events.length });
			},
		});
		client.capture("agent started", { ...base, schema_revision: 1 });
		await client.flush();
		await client.flush();
		expect(batches[0].schema_version).toBe(2);
		expect(batches[1]).not.toHaveProperty("schema_version");
		expect(batches[1].events[0].id).toBe(batches[0].events[0].id);
		expect(batches[1].events[0].properties).not.toHaveProperty("schema_revision");
	});
	it("never generates identity while opted out and clears queued events before re-enabling", async () => {
		let enabled = false;
		const agentDir = directory();
		const sent: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir,
			isEnabled: () => enabled,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				sent.push(batch);
				return accepted(batch);
			},
		});
		client.capture("agent started", base);
		await client.flush();
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
		enabled = true;
		client.capture("agent started", base);
		enabled = false;
		await client.flush();
		enabled = true;
		client.capture("agent error", error);
		await client.flush();
		expect(sent.flatMap((batch) => batch.events.map((event) => event.name))).toEqual(["agent error"]);
	});
	it("purges cached client queues synchronously on a settings off/on transition", async () => {
		const batches: TelemetryBatch[] = [];
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			if (init?.method === "GET") return capabilities();
			const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
			batches.push(batch);
			return accepted(batch);
		});
		const options = { agentDir: directory(), settingsManager: SettingsManager.inMemory() };
		captureTelemetryEvent({ ...options, name: "agent error", properties: error });
		options.settingsManager.setTelemetryEnabled(false);
		options.settingsManager.setTelemetryEnabled(true);
		await captureAgentCommandUsed({ ...options, commandName: "model" });
		await vi.waitFor(() => expect(batches).toHaveLength(1));
		expect(batches[0].events.map((event) => event.name)).toEqual(["agent command used"]);
	});
	it("invalidates an old flush snapshot when disabling races with an acknowledged request", async () => {
		const batches: TelemetryBatch[] = [];
		let release: (response: Response) => void = () => {};
		const firstResponse = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const client = new TelemetryClient({
			agentDir: directory(),
			batchSize: 1,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return batches.length === 1 ? firstResponse : accepted(batch);
			},
		});
		client.capture("agent started", base);
		client.capture("agent error", error);
		const flushing = client.flush();
		await vi.waitFor(() => expect(batches).toHaveLength(1));
		client.clearPending();
		release(accepted(batches[0]));
		await flushing;
		await client.flush();
		expect(batches).toHaveLength(1);
	});

	it("bounds memory and request bytes for a burst of rich errors", async () => {
		const sizes: number[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			batchSize: 20,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				sizes.push(Buffer.byteLength(String(init?.body)));
				return accepted(JSON.parse(String(init?.body)) as TelemetryBatch);
			},
		});
		for (let i = 0; i < 300; i++) client.capture("agent error", error);
		await client.flush();
		expect(client.delivery.overflow).toBe(44);
		expect(client.delivery.accepted).toBe(256);
		expect(sizes.every((size) => size <= 30_000)).toBe(true);
	});
	it("expires undelivered events and never reports endpoint failures as user errors", async () => {
		let now = Date.now();
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: directory(),
			now: () => now,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return capabilities();
				batches.push(JSON.parse(String(init?.body)) as TelemetryBatch);
				throw new Error("secret proxy connection failed");
			},
		});
		client.capture("agent started", base);
		await client.flush();
		now += 86_400_001;
		await client.flush();
		expect(batches).toHaveLength(1);
		expect(client.delivery.expired).toBe(1);
		expect(batches[0].events[0].name).toBe("agent started");
	});
});
