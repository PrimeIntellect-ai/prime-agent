import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.js";
import {
	captureAgentCommandUsed,
	captureTelemetryEvent,
	type TelemetryBatch,
	TelemetryClient,
} from "../src/core/telemetry.js";
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
const directories: string[] = [];
function directory(): string {
	const path = mkdtempSync(join(tmpdir(), "telemetry-contract-"));
	directories.push(path);
	return path;
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

function setup({
	discover = capabilities,
	receive = accepted,
	...options
}: Partial<ConstructorParameters<typeof TelemetryClient>[0]> & {
	discover?: () => Response | Promise<Response>;
	receive?: (batch: TelemetryBatch) => Response | Promise<Response>;
} = {}) {
	const batches: TelemetryBatch[] = [];
	const fetcher: typeof fetch = async (_url, init) => {
		if (init?.method === "GET") return discover();
		const batch = JSON.parse(String(init?.body)) as TelemetryBatch;
		batches.push(batch);
		return receive(batch);
	};
	const client = new TelemetryClient({ agentDir: directory(), randomId: ids(), fetch: fetcher, ...options });
	return { client, batches, fetch: fetcher };
}

beforeEach(() => vi.stubEnv("DO_NOT_TRACK", "0"));
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("shared telemetry contract and privacy", () => {
	it.each(BUILTIN_SLASH_COMMANDS.map(({ name }) => name))("retains the built-in command %s", (commandName) => {
		expect(sanitizeTelemetryProperties("agent command used", { ...base, command_name: commandName })).toMatchObject({
			command_name: commandName,
		});
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
});

describe("version negotiation, retry and consent", () => {
	it.each([undefined, 1, 2, "3", 3])(
		"sends installation outcomes only after a revision 3 collector is discovered: %j",
		async (revision) => {
			const { client, batches } = setup({
				discover: () => Response.json({ schema_versions: [1, 2], schema_revision: revision }),
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

	it.each([
		{ original_error_messages: true, error_message_policy_revision: 1, expected: true },
		{ original_error_messages: false, error_message_policy_revision: 1, expected: false },
		{ original_error_messages: true, error_message_policy_revision: 2, expected: false },
		{ original_error_messages: true, expected: false },
		{ expected: false },
	])("negotiates the exact original-message policy: %j", async ({ expected, ...support }) => {
		const { client, batches } = setup({
			discover: () => Response.json({ schema_versions: [1, 2], ...support }),
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

	it("sends only legacy fields and names to an old collector", async () => {
		const { client, batches } = setup({
			discover: () => new Response(null, { status: 404 }),
			receive: (batch) => {
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

	it("falls back safely when the collector is rolled back after capability discovery", async () => {
		const { client, batches } = setup({
			receive: (batch) => {
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

	it("purges cached client queues synchronously on a settings off/on transition", async () => {
		const { batches, fetch } = setup();
		vi.stubGlobal("fetch", fetch);
		const options = { agentDir: directory(), settingsManager: SettingsManager.inMemory() };
		captureTelemetryEvent({ ...options, name: "agent error", properties: error });
		options.settingsManager.setTelemetryEnabled(false);
		options.settingsManager.setTelemetryEnabled(true);
		await captureAgentCommandUsed({ ...options, commandName: "model" });
		await vi.waitFor(() => expect(batches).toHaveLength(1));
		expect(batches[0].events.map((event) => event.name)).toEqual(["agent command used"]);
	});
	it("invalidates an old flush snapshot when disabling races with an acknowledged request", async () => {
		let release: (response: Response) => void = () => {};
		const firstResponse = new Promise<Response>((resolve) => {
			release = resolve;
		});
		const { client, batches } = setup({
			batchSize: 1,
			receive: (batch) => {
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
		const { client, batches } = setup({ batchSize: 20 });
		for (let i = 0; i < 300; i++) client.capture("agent error", error);
		await client.flush();
		expect(client.delivery.overflow).toBe(44);
		expect(client.delivery.accepted).toBe(256);
		expect(batches.every((batch) => Buffer.byteLength(JSON.stringify(batch)) <= 30_000)).toBe(true);
	});
});
