import { getModels } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	getTelemetryExecutionContext,
	sanitizeTelemetryExecutionContext,
} from "../src/core/telemetry-execution-context.js";

afterEach(() => vi.unstubAllEnvs());

function registry() {
	return ModelRegistry.inMemory(
		AuthStorage.inMemory(
			{
				"prime-inference": { type: "api_key", key: "synthetic-local-key", primeTeam: null },
			},
			{ usePrimeCliConfig: false },
		),
	);
}

describe("execution telemetry context", () => {
	it("retains only fixed categories and does not invoke user getters", () => {
		const getter = vi.fn(() => "private-team-name");
		const source = {
			providerCategory: "openai",
			modelCategory: "private-model",
			authSource: "environment",
			extra: "private",
		};
		Object.defineProperty(source, "teamScope", { get: getter });
		expect(sanitizeTelemetryExecutionContext(source)).toEqual({
			providerCategory: "openai",
			modelCategory: "unknown",
			authSource: "environment",
			teamScope: "unknown",
			endpointCategory: "unknown",
		});
		expect(getter).not.toHaveBeenCalled();
	});
	it("uses the actual worker request headers and explicit personal override", () => {
		vi.stubEnv("PRIME_TEAM_ID", "synthetic-team");
		const model = getModels("prime-inference")[0];
		const models = registry();
		expect(getTelemetryExecutionContext(models, model, { authSource: "runtime" })).toMatchObject({
			authSource: "runtime_api_key",
			teamScope: "team",
			endpointCategory: "default",
		});
		expect(
			getTelemetryExecutionContext(models, model, { authSource: "runtime", headers: { "X-Prime-Team-ID": "" } }),
		).toMatchObject({ teamScope: "personal" });
		models.authStorage.setPrimeInferenceTeamSelection({ teamId: "different-team", name: "private-team-name" });
		expect(
			getTelemetryExecutionContext(models, model, { authSource: "stored", headers: { "X-Prime-Team-ID": "" } }),
		).toMatchObject({ teamScope: "personal", authSource: "api_key" });
	});
	it("categorizes custom endpoints without emitting URLs, credentials, or team identity", () => {
		const model = { ...getModels("prime-inference")[0], baseUrl: "https://secret.invalid/private-endpoint" };
		const context = getTelemetryExecutionContext(registry(), model, {
			authSource: "stored",
			headers: { "X-Prime-Team-ID": "private-team" },
		});
		expect(context).toMatchObject({ providerCategory: "prime", endpointCategory: "custom", teamScope: "team" });
		expect(JSON.stringify(context)).not.toMatch(/private|secret|synthetic/);
		expect(getTelemetryExecutionContext(registry(), undefined).authSource).toBe("unknown");
	});
});
