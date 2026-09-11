import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type TelemetryBatch, TelemetryClient, type TelemetryEvent } from "../src/core/telemetry.js";
import { TELEMETRY_SAFE_ERROR_MESSAGES } from "../src/core/telemetry-error-policy.js";
import { createPostHogException } from "../src/core/telemetry-posthog.js";

const installationId = "00000000-0000-4000-8000-000000000001";
const source: TelemetryEvent = {
	id: "00000000-0000-4000-8000-000000000002",
	name: "agent error",
	timestamp: "2026-09-10T00:00:00.000Z",
	properties: {
		version: "0.9.3",
		os_family: "linux",
		architecture: "x64",
		install_method: "npm",
		execution_mode: "interactive",
		error_id: "00000000-0000-4000-8000-000000000003",
		component: "daemon",
		operation: "connect",
		provider_category: "prime",
		error_type: "network",
		error_subtype: "connection_refused",
		error_event_kind: "occurrence",
		error_code_group: "ECONNREFUSED",
		error_message_id: "prime_request_timeout",
		error_message: TELEMETRY_SAFE_ERROR_MESSAGES.prime_request_timeout,
	},
};
const support = {
	schema_versions: [1, 2],
	schema_revision: 4,
	posthog_exception_events: true,
	original_error_messages: true,
	error_message_policy_revision: 1,
};
function accepted(batch: TelemetryBatch) {
	return Response.json({ accepted_ids: batch.events.map((event) => event.id), dropped_ids: [], retry_ids: [] });
}
function setup(capabilities: object = support, respond = accepted) {
	const batches: TelemetryBatch[] = [];
	let id = 0;
	const client = new TelemetryClient({
		agentDir: mkdtempSync(join(tmpdir(), "telemetry-posthog-")),
		batchSize: 20,
		randomId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
		fetch: async (_url, init) => {
			if (init?.method === "GET") return Response.json(capabilities);
			const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
			batches.push(batch);
			return respond(batch);
		},
	});
	return { client, batches };
}
beforeEach(() => {
	vi.stubEnv("DO_NOT_TRACK", "0");
	vi.stubEnv("PI_OFFLINE", "0");
	vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
});
afterEach(() => vi.unstubAllEnvs());

describe("client-owned PostHog errors", () => {
	it("preserves the previous collector's deterministic identity and code grouping", () => {
		const event = createPostHogException(installationId, source)!;
		expect(event.id).toBe("9ab39895-beb2-5c01-9b54-82ee74c5c48d");
		expect(event.properties.$exception_fingerprint).toBe("prime-agent:v1|daemon|connect|prime|code:ECONNREFUSED");
		expect(event.timestamp).toBe(source.timestamp);
		expect(event.properties.telemetry_source_event_id).toBe(source.id);
		expect(
			createPostHogException(installationId, {
				...source,
				properties: { ...source.properties, error_message: "different" },
			})?.properties.$exception_fingerprint,
		).toBe(event.properties.$exception_fingerprint);
	});
	it.each(["recovery_update", undefined])("does not create an exception for %s", (kind) => {
		const properties = { ...source.properties };
		if (kind) properties.error_event_kind = kind;
		else delete properties.error_event_kind;
		expect(createPostHogException(installationId, { ...source, properties })).toBeUndefined();
	});
	it.each(["uncaught_exception", "unhandled_rejection", "connect"])("preserves handled status for %s", (operation) => {
		const event = createPostHogException(installationId, {
			...source,
			properties: { ...source.properties, operation },
		});
		expect(event?.properties.$exception_list).toMatchObject([
			{ mechanism: { handled: operation === "connect", synthetic: true } },
		]);
	});
	it.each([
		{},
		{ native_error_tracking: true },
		{ posthog_exception_events: false },
		{ posthog_exception_events: "true" },
	])("does not send native events to collectors without explicit support: %j", (capability) => {
		return (async () => {
			const { client, batches } = setup({ schema_versions: [1, 2], ...capability });
			client.capture(source.name, source.properties);
			await client.flush();
			expect(batches[0].events.map((event) => event.name)).toEqual(["agent error"]);
		})();
	});
	it("builds native errors only after sanitization and message-policy negotiation", async () => {
		const { client, batches } = setup({ ...support, original_error_messages: false });
		client.capture(source.name, {
			...source.properties,
			prompt: "private_canary",
			error_message: "token=private_canary",
			$exception_fingerprint: "private_canary",
		});
		await client.flush();
		expect(batches[0].events.map((event) => event.name)).toEqual(["agent error", "$exception"]);
		const properties = batches[0].events[1].properties;
		expect(properties).not.toHaveProperty("error_message");
		expect(properties.$exception_list).toMatchObject([{ value: batches[0].events[0].properties.diagnostic_message }]);
		expect(JSON.stringify(batches)).not.toContain("private_canary");
	});
	it("retries only the unacknowledged member of an error pair with its original ID", async () => {
		let calls = 0;
		const { client, batches } = setup(support, (batch) =>
			++calls === 1
				? Response.json({ accepted_ids: [batch.events[0].id], retry_ids: [batch.events[1].id] })
				: accepted(batch),
		);
		client.capture(source.name, source.properties);
		await client.flush();
		await client.flush();
		await client.flush();
		expect(batches).toHaveLength(2);
		expect(batches[1].events).toEqual([batches[0].events[1]]);
		expect(client.delivery.accepted).toBe(2);
	});
	it("retains the source when only its exception is acknowledged", async () => {
		let calls = 0;
		const { client, batches } = setup(support, (batch) =>
			++calls === 1
				? Response.json({ accepted_ids: [batch.events[1].id], retry_ids: [batch.events[0].id] })
				: accepted(batch),
		);
		client.capture(source.name, source.properties);
		await client.flush();
		await client.flush();
		expect(batches[1].events).toEqual([batches[0].events[0]]);
	});
	it.each([false, true])("retains error pairs during slow discovery (retry: %s)", async (retry) => {
		let now = Date.now();
		let discoveries = 0;
		let finishDiscovery!: (response: Response) => void;
		const delayed = new Promise<Response>((resolve) => {
			finishDiscovery = resolve;
		});
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: mkdtempSync(join(tmpdir(), "telemetry-posthog-discovery-")),
			now: () => now,
			fetch: async (_url, init) => {
				if (init?.method === "GET") return retry && ++discoveries === 1 ? Response.json(support) : delayed;
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return retry && batches.length === 1
					? Response.json({ accepted_ids: [batch.events[0].id], retry_ids: [batch.events[1].id] })
					: accepted(batch);
			},
		});
		client.capture(source.name, source.properties);
		if (retry) {
			await client.flush();
			now += 60_001;
		}
		await client.flush({ timeoutMs: 30 });
		expect(batches).toHaveLength(retry ? 1 : 0);
		finishDiscovery(Response.json(support));
		await client.flush();
		expect(batches).toHaveLength(retry ? 2 : 1);
		if (retry) expect(batches[1].events).toEqual([batches[0].events[1]]);
		else expect(batches[0].events.map((event) => event.name)).toEqual(["agent error", "$exception"]);
		expect(client.delivery.accepted).toBe(2);
		await client.flush();
		expect(batches).toHaveLength(retry ? 2 : 1);
	});
	it.each(["network", "unavailable", "rollback"])("counts transport records on %s failures", async (failure) => {
		let calls = 0;
		const { client, batches } = setup(support, (batch) => {
			if (++calls > 1) return accepted(batch);
			if (failure === "network") throw new Error("network unavailable");
			return new Response(null, { status: failure === "rollback" ? 422 : 503 });
		});
		client.capture(source.name, source.properties);
		await client.flush();
		expect(batches[0].events).toHaveLength(2);
		expect(client.delivery.retries).toBe(2);
		expect(client.delivery.unavailable).toBe(failure === "rollback" ? 0 : 2);
		if (failure !== "rollback") {
			await client.flush();
			expect(client.delivery.accepted).toBe(2);
		}
		client.clearPending();
	});
	it("handles a rollback to an older collector that rejects native events", async () => {
		const { client, batches } = setup(support, (batch) =>
			Response.json({
				accepted_ids: batch.events.filter((event) => event.name !== "$exception").map((event) => event.id),
				dropped_ids: batch.events.filter((event) => event.name === "$exception").map((event) => event.id),
			}),
		);
		client.capture(source.name, source.properties);
		await client.flush();
		await client.flush();
		expect(batches).toHaveLength(1);
		expect(client.delivery.accepted).toBe(1);
		expect(client.delivery.rejected).toBe(1);
	});
	it("stops sending native events if support disappears at rediscovery", async () => {
		let now = Date.now();
		let discoveries = 0;
		const batches: TelemetryBatch[] = [];
		const client = new TelemetryClient({
			agentDir: mkdtempSync(join(tmpdir(), "telemetry-posthog-rollback-")),
			now: () => now,
			fetch: async (_url, init) => {
				if (init?.method === "GET")
					return ++discoveries === 1 ? Response.json(support) : new Response(null, { status: 404 });
				const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
				batches.push(batch);
				return accepted(batch);
			},
		});
		client.capture(source.name, source.properties);
		await client.flush();
		now += 60_001;
		client.capture(source.name, source.properties);
		await client.flush();
		expect(batches[0].events.map((event) => event.name)).toEqual(["agent error", "$exception"]);
		expect(batches[1].events.map((event) => event.name)).toEqual(["agent error"]);
	});
	it("keeps every error pair within batch count and byte limits", async () => {
		const { client, batches } = setup();
		for (let i = 0; i < 21; i++) client.capture(source.name, source.properties);
		await client.flush();
		expect(batches.flatMap((batch) => batch.events)).toHaveLength(42);
		expect(
			batches.every((batch) => batch.events.length <= 20 && Buffer.byteLength(JSON.stringify(batch)) <= 30_000),
		).toBe(true);
		expect(new Set(batches.flatMap((batch) => batch.events.map((event) => event.id))).size).toBe(42);
	});
	it("never creates identity or sends either event when telemetry is disabled", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "0");
		const agentDir = mkdtempSync(join(tmpdir(), "telemetry-posthog-optout-"));
		const fetch = vi.fn();
		const client = new TelemetryClient({ agentDir, fetch });
		client.capture(source.name, source.properties);
		await client.flush();
		expect(fetch).not.toHaveBeenCalled();
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});
});
