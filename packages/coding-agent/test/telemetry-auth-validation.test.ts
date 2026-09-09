import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loginPrimeAgentTraces, loginPrimeInference } from "../src/core/prime-inference-auth.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetrySink } from "../src/core/telemetry.js";
import { initializeTelemetryErrorReporting } from "../src/core/telemetry-errors.js";

const SECRET = "synthetic-private-auth-canary";

describe("auth validation telemetry", () => {
	let agentDir: string;
	let configPath: string;
	let cleanup: () => void;
	let reports: Record<string, string | number | boolean | null>[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prime-auth-telemetry-"));
		configPath = join(agentDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ api_key: SECRET }));
		reports = [];
		const sink: TelemetrySink = {
			capture(_name, properties) {
				reports.push(properties);
			},
			async flush() {},
		};
		for (const key of ["PI_OFFLINE", "DO_NOT_TRACK", "PRIME_AGENT_TELEMETRY", "PRIME_AGENT_TRACES_BASE_URL"])
			vi.stubEnv(key, "");
		cleanup = initializeTelemetryErrorReporting({ agentDir, settingsManager: SettingsManager.inMemory(), sink });
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllEnvs();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it.each([loginPrimeInference, loginPrimeAgentTraces])(
		"times successful identity and scope validation",
		async (login) => {
			const onValidation = vi.fn();
			const fetchFn = vi.fn(
				async () =>
					new Response(
						JSON.stringify({ data: { scope: { inference: { write: true }, agent_traces: { write: true } } } }),
					),
			);
			await expect(login({ onAuth: vi.fn(), onValidation }, { configPath, fetchFn })).resolves.toMatchObject({
				source: "prime-cli",
			});
			expect(onValidation).toHaveBeenCalledWith({
				outcome: "completed",
				durationMs: expect.any(Number),
				scope: "identity_scope",
			});
			expect(onValidation.mock.calls[0][0].durationMs).toBeGreaterThanOrEqual(0);
			expect(reports).toHaveLength(0);
		},
	);

	it("retains a rejected validation before trying browser recovery", async () => {
		const onValidation = vi.fn();
		let calls = 0;
		const fetchFn = vi.fn(async () => {
			if (calls++ === 0) return new Response(JSON.stringify({ message: SECRET }), { status: 403 });
			throw new Error("Synthetic browser challenge unavailable");
		});
		await expect(loginPrimeInference({ onAuth: vi.fn(), onValidation }, { configPath, fetchFn })).rejects.toThrow();
		expect(calls).toBeGreaterThan(1);
		expect(onValidation).toHaveBeenCalledWith({
			outcome: "failed",
			durationMs: expect.any(Number),
			scope: "identity_scope",
		});
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			component: "authentication",
			operation: "validate",
			http_status: 403,
			error_subtype: "permission_denied",
		});
		expect(reports[0]).not.toHaveProperty("error_message");
		expect(JSON.stringify(reports)).not.toContain(SECRET);
	});

	it("does not count a deliberate login cancellation as a failed validation", async () => {
		const abort = new AbortController();
		const onValidation = vi.fn();
		const fetchFn = vi.fn(async () => {
			abort.abort();
			throw new DOMException("Manual API key takeover", "AbortError");
		});
		await expect(
			loginPrimeInference({ onAuth: vi.fn(), onValidation, signal: abort.signal }, { configPath, fetchFn }),
		).rejects.toThrow();
		expect(onValidation).not.toHaveBeenCalled();
		expect(reports).toHaveLength(0);
	});

	it("keeps login working when an observability callback throws", async () => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ data: { scope: { inference: { write: true } } } })),
		);
		await expect(
			loginPrimeInference(
				{
					onAuth: vi.fn(),
					onValidation() {
						throw new Error(SECRET);
					},
				},
				{ configPath, fetchFn },
			),
		).resolves.toMatchObject({ source: "prime-cli" });
	});
});
