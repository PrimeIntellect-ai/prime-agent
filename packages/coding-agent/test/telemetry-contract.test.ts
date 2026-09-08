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
import { sanitizeTelemetryProperties } from "../src/core/telemetry-schema.js";

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
	it("redacts original messages independently and preserves flags through repeated sanitization", () => {
		const safe = sanitizeTelemetryProperties("agent error", {
			...error,
			error_message: 'Worker failed: token="synthetic-secret"',
			error_code_group: "DAEMON_START_FAILED",
			error_message_length: 8_000,
			error_message_truncated: true,
			error_event_kind: "occurrence",
		});
		expect(safe).toMatchObject({
			error_message: 'Worker failed: token="[REDACTED]"',
			error_code_group: "DAEMON_START_FAILED",
			error_message_length: 8_000,
			error_message_truncated: true,
			error_message_redacted: true,
		});
		expect(sanitizeTelemetryProperties("agent error", safe ?? {})).toEqual(safe);
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
});

describe("version negotiation, retry and consent", () => {
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
