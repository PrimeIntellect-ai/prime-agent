import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	correctionPatch,
	type DashboardBundle,
	type DashboardDefinition,
	type ExistingInsight,
	publishTelemetryDashboards,
	readDashboardBundle,
	readTelemetryContract,
	type TelemetryContract,
	validateDashboardBundle,
} from "../../../scripts/publish-telemetry-dashboards.mjs";

let bundle: DashboardBundle;
let contract: TelemetryContract;

beforeAll(async () => {
	[bundle, contract] = await Promise.all([readDashboardBundle(), readTelemetryContract()]);
});

function insight(key: string): DashboardDefinition {
	const definition = [...bundle.corrections, ...bundle.insights].find((candidate) => candidate.key === key);
	if (!definition) throw new Error(`Missing test definition ${key}`);
	return definition;
}

function sql(key: string): string {
	const query = insight(key).query?.source.query;
	if (!query) throw new Error(`Missing SQL for ${key}`);
	return query;
}

function existingCorrection(definition: DashboardDefinition): ExistingInsight {
	return {
		id: definition.id!,
		dashboards: [882785, 882794],
		query:
			definition.operation === "distinct_started"
				? {
						kind: "InsightVizNode",
						source: {
							kind: "TrendsQuery",
							series: [{ kind: "EventsNode", event: "agent started", math: "total" }],
							dateRange: { date_from: "-30d" },
							filterTestAccounts: true,
							breakdownFilter: { breakdowns: [{ type: "event", property: definition.property }] },
						},
					}
				: { kind: "DataVisualizationNode", source: { kind: "HogQLQuery", query: "SELECT 1" } },
	};
}

interface Call {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

interface ApiOptions {
	observed?: boolean;
	emptyQueries?: boolean;
	queryError?: boolean;
	next?: string;
	existing?: Array<{ id: number; name: string; tags: string[]; dashboards: number[] }>;
}

function fakeApi(target: DashboardBundle, options: ApiOptions = {}) {
	const calls: Call[] = [];
	const newSql = new Set(target.insights.map((definition) => definition.query?.source.query));
	let createdId = 9000000;
	const fetcher: typeof fetch = vi.fn(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
		calls.push({ method, path: url.pathname, body });
		const respond = (value: unknown) => new Response(JSON.stringify(value));
		if (url.origin !== "https://eu.posthog.com") throw new Error("Unexpected network target");
		if (url.pathname === "/api/projects/22174/") return respond({ id: 22174, timezone: "GMT" });
		if (url.pathname.endsWith("/dashboards/882785/")) return respond({ id: 882785, deleted: false });
		if (url.pathname.endsWith("/query/")) {
			const query = body?.query as { query?: string } | undefined;
			if (query?.query?.includes("AS observed_events")) {
				const required = [...new Set(target.insights.flatMap((definition) => definition.requires ?? []))];
				return respond({ results: options.observed ? required.map((event) => [event, 3]) : [] });
			}
			if (options.queryError && newSql.has(query?.query)) return respond({ error: "Synthetic invalid query" });
			return respond({ results: options.emptyQueries && newSql.has(query?.query) ? [] : [[1]] });
		}
		if (method === "GET" && url.pathname.endsWith("/insights/")) {
			return respond({ results: options.existing ?? [], next: options.next });
		}
		if (method === "GET") {
			const definition = target.corrections.find((item) => url.pathname.endsWith(`/insights/${item.id}/`));
			if (definition) return respond(existingCorrection(definition));
		}
		if (method === "PATCH") return respond({ id: Number(url.pathname.split("/").at(-2)) });
		if (method === "POST" && url.pathname.endsWith("/insights/")) return respond({ id: createdId++ });
		throw new Error(`Unhandled mock API request ${method} ${url.pathname}`);
	});
	return {
		calls,
		fetcher,
		writes: () => calls.filter((call) => call.path.includes("/insights/") && call.method !== "GET"),
		newQueries: () => calls.filter((call) => newSql.has((call.body?.query as { query?: string } | undefined)?.query)),
	};
}

describe("reviewed telemetry dashboard definitions", () => {
	it("uses the deployed contract and exactly the reviewed historical correction IDs", () => {
		expect(validateDashboardBundle(bundle, contract)).toEqual({ corrections: 7, insights: 20 });
		expect(bundle.corrections.map((definition) => definition.id)).toEqual([
			5381784, 5381785, 5381786, 5381787, 5381788, 5381818, 5381833,
		]);
		for (const definition of bundle.insights) {
			expect(definition.requires?.length).toBeGreaterThan(0);
			expect(definition.query?.source.query).toContain("properties.telemetry_schema_version = 2");
		}
	});

	it("rejects contract drift, foreign projects, write queries and unrecognized properties", () => {
		expect(() => validateDashboardBundle({ ...bundle, contract_schema_version: 99 }, contract)).toThrow("versions");
		expect(() => validateDashboardBundle({ ...bundle, project_id: 1 }, contract)).toThrow("target");
		const changed = structuredClone(bundle);
		changed.insights[0].query!.source.query = "SELECT properties.private_prompt FROM events";
		expect(() => validateDashboardBundle(changed, contract)).toThrow("Unknown contract property");
		changed.insights[0].query!.source.query = "DELETE FROM events";
		expect(() => validateDashboardBundle(changed, contract)).toThrow("read-only");
	});

	it("counts installation IDs and preserves historical filters and breakdowns", () => {
		for (const definition of bundle.corrections.filter((item) => item.operation === "distinct_started")) {
			const existing = existingCorrection(definition);
			const patch = correctionPatch(definition, existing, bundle.dashboard_id);
			expect(patch).toMatchObject({
				query: {
					source: {
						series: [{ event: "agent started", math: "dau" }],
						dateRange: { date_from: "-30d" },
						filterTestAccounts: true,
						breakdownFilter: { breakdowns: [{ property: definition.property }] },
					},
				},
			});
			expect(existing.query).toMatchObject({ source: { series: [{ math: "total" }] } });
			expect(patch).not.toHaveProperty("dashboards");
			expect(patch).not.toHaveProperty("tags");
		}
	});

	it("refuses to overwrite a moved or structurally changed historical chart", () => {
		const definition = bundle.corrections[0];
		expect(() => correctionPatch(definition, { ...existingCorrection(definition), dashboards: [] }, 882785)).toThrow(
			"missing or moved",
		);
		expect(() => correctionPatch(definition, { ...existingCorrection(definition), query: {} }, 882785)).toThrow(
			"changed shape",
		);
	});

	it("does not call repeated launches new installs or count cancellations as failures", () => {
		const firstSeen = sql("first-observed");
		expect(firstSeen.split(")\nSELECT")[0]).not.toContain("INTERVAL");
		expect(firstSeen).toContain("count(DISTINCT if(toDate(e.timestamp) = toDate(f.first_seen_at)");
		expect(insight("first-observed").query).toMatchObject({
			display: "ActionsBar",
			chartSettings: { yAxis: [{ column: "first_observed_installations" }, { column: "returning_installations" }] },
		});
		expect(sql("legacy-run-performance")).toContain("countIf(outcome = 'error') AS failed_runs");
		expect(sql("legacy-run-performance")).toContain("'aborted', 'cancelled'");
		expect(sql("legacy-run-performance")).toContain("avg_measured_tokens_per_run");
		expect(sql("run-outcomes")).toContain("starts > 0 AND terminals = 0");
		expect(sql("run-outcomes")).toContain("GROUP BY distinct_id, run_id");
	});

	it("deduplicates recovery updates and favors terminal recovery on equal timestamps", () => {
		for (const key of ["error-causes", "error-recovery"]) {
			expect(sql(key)).toContain("GROUP BY distinct_id, error_id");
			expect(sql(key)).toContain(
				"tuple(timestamp, properties.recovery_outcome IN ('success', 'failed', 'cancelled')",
			);
		}
		expect(sql("error-causes")).toContain("reviewed_message");
	});

	it("uses mature successful-run cohorts and separates missing attribution", () => {
		for (const key of ["onboarding-activation", "first-session-activation", "successful-retention"]) {
			expect(sql(key)).toContain("GROUP BY distinct_id, run_id");
			expect(sql(key)).toContain("terminal_outcome = 'success' AND model_call_count > 0");
		}
		expect(sql("onboarding-activation")).toContain("c.entered_at <= now() - INTERVAL 24 HOUR");
		expect(sql("onboarding-activation")).toContain("no_observed_same_attempt_success_24h");
		expect(sql("first-session-activation")).toContain("cohorts_missing_first_session_association");
		expect(sql("first-session-activation")).toContain("argMin(coalesce(properties.session_id, ''), timestamp)");
		expect(sql("first-session-activation")).toContain("s.first_session_id = x.session_id");
		expect(insight("first-session-activation").requires).toContain("agent run started");
		expect(sql("first-session-activation")).not.toContain("client_session_id");
		expect(sql("successful-retention")).toContain(
			"countIf(first_success_at <= now() - INTERVAL 2 DAY) AS eligible_d1",
		);
		expect(sql("successful-retention")).toContain(
			"countIf(first_success_at <= now() - INTERVAL 8 DAY) AS eligible_d7",
		);
		expect(sql("successful-retention")).toContain("HAVING eligible_d1 > 0");
	});

	it("keeps missing latency, cost and unsupported dimensions honest", () => {
		for (const definition of bundle.insights.filter((item) => item.key.startsWith("latency-"))) {
			expect(definition.query?.source.query).toContain("missing_measurement_runs");
			expect(definition.query?.source.query).toContain("measurement_coverage_pct");
			for (const percentile of ["0.50", "0.95", "0.99"]) {
				expect(definition.query?.source.query).toContain(`= 0, NULL, quantile(${percentile})(value_ms)`);
			}
		}
		expect(insight("latency-first-model-event-ms").name).toContain("first turn start");
		expect(insight("latency-retry-wait-ms").description).toContain("partial waits");
		expect(sql("effective-throughput-cost")).toContain("usage_complete = true AND estimated_cost_usd IS NOT NULL");
		expect(sql("effective-throughput-cost")).toContain("effective_output_tokens_per_model_call_second");
		expect(sql("effective-throughput-cost")).toContain("HAVING reported_runs > 0");
		expect(sql("fixed-feedback")).not.toContain("previous_success");
		expect(sql("tool-reliability")).not.toContain("recovered_count");
		expect(sql("feature-outcomes")).toContain("countIf(starts > 0 AND terminal_outcome = 'completed')");
	});
});

describe("dashboard publication safety", () => {
	it("defaults to a local check without network access, including when a token exists", async () => {
		const fetcher = vi.fn<typeof fetch>();
		const result = await publishTelemetryDashboards({ bundle, contract, fetcher, token: "synthetic-token" });
		expect(result.status).toBe("local_check_only");
		expect(result.writes).toEqual([]);
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("refuses all writes and does not query new charts before deployed v2 data is observed", async () => {
		const api = fakeApi(bundle);
		await expect(
			publishTelemetryDashboards({
				bundle,
				contract,
				mode: "apply",
				token: "synthetic-token",
				fetcher: api.fetcher,
			}),
		).rejects.toThrow("No deployed public v2 events observed");
		expect(api.writes()).toEqual([]);
		expect(api.newQueries()).toEqual([]);
	});

	it("performs read-only preflight and reports absent data without pretending charts are live", async () => {
		const api = fakeApi(bundle);
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "preflight",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(result.status).toBe("pending_data");
		expect(result.pending).toHaveLength(bundle.insights.length);
		expect(result.creates).toEqual([]);
		expect(api.newQueries()).toEqual([]);
		expect(api.writes()).toEqual([]);
	});

	it("does not publish immature or otherwise empty chart cohorts", async () => {
		const api = fakeApi(bundle, { observed: true, emptyQueries: true });
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "apply",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(result.status).toBe("partially_published_pending_data");
		expect(result.pending).toHaveLength(bundle.insights.length);
		expect(result.creates).toEqual([]);
		expect(api.writes()).toHaveLength(bundle.corrections.length);
		expect(api.writes().every((call) => call.method === "PATCH")).toBe(true);
	});

	it("validates every eligible query before any explicitly requested publication write", async () => {
		const api = fakeApi(bundle, { observed: true });
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "apply",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(result.status).toBe("published");
		expect(api.writes()).toHaveLength(bundle.corrections.length + bundle.insights.length);
		const firstWrite = api.calls.findIndex((call) => call.path.includes("/insights/") && call.method !== "GET");
		expect(api.calls.slice(firstWrite).some((call) => call.path.endsWith("/query/"))).toBe(false);
	});

	it("stops before any mutation when query validation fails", async () => {
		const api = fakeApi(bundle, { observed: true, queryError: true });
		await expect(
			publishTelemetryDashboards({
				bundle,
				contract,
				mode: "apply",
				token: "synthetic-token",
				fetcher: api.fetcher,
			}),
		).rejects.toThrow("publication stopped before writes");
		expect(api.writes()).toEqual([]);
	});

	it("keeps legacy corrections available independently without querying or creating v2 charts", async () => {
		const api = fakeApi(bundle);
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "apply",
			legacyOnly: true,
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(result.writes).toHaveLength(7);
		expect(api.newQueries()).toEqual([]);
		expect(api.calls.some((call) => JSON.stringify(call.body ?? {}).includes("observed_events"))).toBe(false);
	});

	it("updates an existing managed chart idempotently without removing other memberships or tags", async () => {
		const target = { ...bundle, insights: [bundle.insights[0]] };
		const definition = target.insights[0];
		const api = fakeApi(target, {
			observed: true,
			existing: [
				{
					id: 999,
					name: definition.name,
					tags: ["other-team", `prime-agent-telemetry-eng-5933:${definition.key}`],
					dashboards: [123],
				},
			],
		});
		const result = await publishTelemetryDashboards({
			bundle: target,
			contract,
			mode: "apply",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(result.creates).toEqual([]);
		expect(api.writes().at(-1)).toMatchObject({
			method: "PATCH",
			path: "/api/projects/22174/insights/999/",
			body: { tags: expect.arrayContaining(["other-team"]), dashboards: [123, 882785] },
		});
	});

	it("refuses ambiguous duplicate charts and pagination outside the reviewed project", async () => {
		const definition = bundle.insights[0];
		const duplicate = fakeApi(bundle, {
			observed: true,
			existing: [{ id: 999, name: definition.name, tags: [], dashboards: [] }],
		});
		await expect(
			publishTelemetryDashboards({
				bundle,
				contract,
				mode: "apply",
				token: "synthetic-token",
				fetcher: duplicate.fetcher,
			}),
		).rejects.toThrow("Ambiguous existing chart");
		expect(duplicate.writes()).toEqual([]);
		const redirected = fakeApi(bundle, { next: "https://example.invalid/api/projects/22174/insights/" });
		await expect(
			publishTelemetryDashboards({
				bundle,
				contract,
				mode: "apply",
				token: "synthetic-token",
				fetcher: redirected.fetcher,
			}),
		).rejects.toThrow("outside the reviewed project");
		expect(redirected.writes()).toEqual([]);
	});
});
