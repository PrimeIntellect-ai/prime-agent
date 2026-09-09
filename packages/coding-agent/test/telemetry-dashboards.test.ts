import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	correctionPatch,
	type DashboardBundle,
	type DashboardDefinition,
	type ExistingInsight,
	publishTelemetryDashboards,
	readDashboardBundle,
	readinessQuery,
	readTelemetryContract,
	type TelemetryContract,
	telemetryAlertPayload,
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
	revision?: number;
	alerts?: Record<string, unknown>[];
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
				const revisions = [...query.query.matchAll(/AS revision_(\d+)_events/g)].map((match) => Number(match[1]));
				return respond({
					results: options.observed
						? required.map((event) => [
								event,
								3,
								...revisions.map((revision) => ((options.revision ?? 3) >= revision ? 3 : 0)),
							])
						: [],
				});
			}
			if (options.queryError && newSql.has(query?.query)) return respond({ error: "Synthetic invalid query" });
			return respond({ results: options.emptyQueries && newSql.has(query?.query) ? [] : [[1]] });
		}
		if (method === "GET" && url.pathname.endsWith("/insights/")) {
			return respond({ results: options.existing ?? [], next: options.next });
		}
		if (method === "GET" && url.pathname.endsWith("/alerts/"))
			return respond({ results: options.alerts ?? [], next: null });
		if (method === "POST" && url.pathname.endsWith("/alerts/")) return respond({ id: "synthetic-alert-id" });
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
		expect(validateDashboardBundle(bundle, contract)).toEqual({ corrections: 7, insights: 30 });
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

	it("deduplicates recovery updates and falls back from unknown codes to HTTP status", () => {
		for (const key of ["error-causes", "error-recovery", "error-concentration"]) {
			expect(sql(key)).toContain("GROUP BY distinct_id, error_id");
			expect(sql(key)).toContain(
				"tuple(timestamp, properties.recovery_outcome IN ('success', 'failed', 'cancelled')",
			);
			expect(sql(key)).toContain("nullIf(properties.error_code_group, 'unknown')");
			expect(sql(key)).toContain("nullIf(properties.error_code, 'unknown')");
			expect(sql(key)).toContain(
				"if(properties.http_status IS NOT NULL, concat('http_', toString(properties.http_status)), 'unknown')",
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
		expect(sql("tool-reliability")).toContain("recovered_count");
		expect(sql("feature-outcomes")).toContain("countIf(starts > 0 AND terminal_outcome = 'completed')");
	});

	it("separates observed inference success from whole-run outcomes and missing older measurements", () => {
		const context = sql("execution-context");
		expect(context).toContain("GROUP BY distinct_id, run_id");
		expect(context).toContain("argMax(toFloat(properties.successful_model_call_count), timestamp)");
		expect(context).toContain("countIf(terminal_outcome = 'success') AS successful_whole_runs");
		expect(context).toContain("countIf(successful_model_call_count > 0) AS runs_with_successful_inference");
		expect(context).toContain(
			"countIf(terminal_outcome = 'error' AND successful_model_call_count > 0) AS failed_runs_after_successful_inference",
		);
		expect(context).toContain("successful_model_call_count IS NULL) AS missing_inference_success_measurement_runs");
		expect(context).not.toContain("coalesce(properties.successful_model_call_count");
	});

	it("separates package completion from observed runtime readiness after installation stage deduplication", () => {
		for (const key of ["installation-outcomes", "installation-stages", "installation-versions"]) {
			expect(insight(key).requires).toEqual(["agent installation stage"]);
			expect(insight(key).min_schema_revision).toBe(3);
			expect(sql(key)).toContain("properties.schema_revision >= 3");
			expect(sql(key)).toContain("GROUP BY distinct_id, installation_attempt_id, stage");
			expect(sql(key)).toContain("tuple(timestamp, properties.outcome != 'started')");
			expect(sql(key)).toContain("installation_action, installation_source, install_method");
		}
		expect(sql("installation-outcomes")).toContain("GROUP BY distinct_id, installation_attempt_id");
		expect(sql("installation-outcomes")).toContain("stage = 'package_install' AND outcome = 'success'");
		expect(sql("installation-outcomes")).toContain("stage = 'ready' AND outcome = 'success'");
		expect(sql("installation-outcomes")).toContain("pending_or_missing_completion");
		expect(sql("installation-outcomes")).toContain("installed_without_observed_readiness");
		expect(sql("installation-stages")).toContain("stage, outcome, reason");
		expect(sql("installation-stages")).toContain("missing_duration_stages");
		expect(sql("installation-stages")).toContain(
			"tupleElement(argMax(tuple(if(properties.outcome = 'started', NULL, toFloat(properties.duration_ms)))",
		);
		expect(sql("installation-stages")).toContain("observed_session_restore_failures");
		expect(sql("installation-versions")).toContain("pending_or_missing_readiness");
		expect(sql("installation-versions")).toContain("requested_version != 'unknown' AND runtime_version != 'unknown'");
		expect(sql("installation-versions")).toContain(
			"countIf(readiness_reports > 0 AND requested_version != 'unknown' AND runtime_version != 'unknown' AND (reported_version_mismatch > 0 OR requested_version != runtime_version)) AS observed_target_version_mismatches",
		);
		expect(sql("installation-versions")).toContain("readiness_without_version_comparison");
	});
});

describe("dashboard publication safety", () => {
	it("preserves an existing alert and its subscribers but rejects changed alert definitions before writing", async () => {
		const definition = insight("alert-error-rate");
		const target = { ...bundle, insights: [definition] };
		const existing = [
			{
				id: 100,
				name: definition.name,
				tags: [`prime-agent-telemetry-eng-5933:${definition.key}`],
				dashboards: [bundle.dashboard_id],
			},
		];
		const alert = {
			...telemetryAlertPayload(definition, 100),
			id: "existing-alert",
			insight: { id: 100 },
			enabled: true,
			subscribed_users: [7],
		};
		const api = fakeApi(target, { observed: true, existing, alerts: [alert] });
		const result = await publishTelemetryDashboards({
			bundle: target,
			contract,
			mode: "apply",
			token: "synthetic-token",
			fetcher: api.fetcher,
			includeAlerts: true,
		});
		expect(result.alerts).toEqual([{ key: definition.key, existing: "existing-alert", action: "preserve_existing" }]);
		expect(api.calls.some((call) => call.path.endsWith("/alerts/") && call.method !== "GET")).toBe(false);
		const changed = fakeApi(target, {
			observed: true,
			existing,
			alerts: [{ ...alert, threshold: { configuration: { bounds: { upper: 99 } } } }],
		});
		await expect(
			publishTelemetryDashboards({
				bundle: target,
				contract,
				mode: "apply",
				token: "synthetic-token",
				fetcher: changed.fetcher,
				includeAlerts: true,
			}),
		).rejects.toThrow("differs from the reviewed definition");
		expect(changed.writes()).toEqual([]);
	});
	it("requires revision 2 data for measurements not present in revision 1", async () => {
		const api = fakeApi(bundle, { observed: true, revision: 1 });
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "preflight",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		const pending = result.pending.map((entry) => (typeof entry === "string" ? entry : entry.key));
		for (const definition of bundle.insights.filter((item) => item.min_schema_revision === 2))
			expect(pending).toContain(definition.key);
		expect(result.creates?.some((entry) => entry.key === "run-outcomes")).toBe(true);
		expect(api.writes()).toEqual([]);
	});
	it("requires revision 3 installation data without delaying existing revision 2 views", async () => {
		const api = fakeApi(bundle, { observed: true, revision: 2 });
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "preflight",
			token: "synthetic-token",
			fetcher: api.fetcher,
		});
		expect(readinessQuery(bundle)).toContain("properties.schema_revision >= 2) AS revision_2_events");
		expect(readinessQuery(bundle)).toContain("properties.schema_revision >= 3) AS revision_3_events");
		expect(result.pending).toEqual(
			bundle.insights
				.filter((definition) => definition.min_schema_revision === 3)
				.map((definition) => ({ key: definition.key, reason: "required_v2_events_not_observed" })),
		);
		expect(result.creates).toHaveLength(27);
		expect(result.creates?.some((entry) => entry.key === "error-causes")).toBe(true);
		expect(api.writes()).toEqual([]);
	});
	it("rejects missing, invalid, and future per-view revision gates", () => {
		for (const revision of [0, -1, 2.5, 4]) {
			const changed = structuredClone(bundle);
			changed.insights.find((definition) => definition.key === "installation-outcomes")!.min_schema_revision =
				revision;
			expect(() => validateDashboardBundle(changed, contract)).toThrow("schema revision publication gate");
		}
		const changed = structuredClone(bundle);
		changed.insights.find((definition) => definition.key === "installation-outcomes")!.query!.source.query = sql(
			"installation-outcomes",
		).replace("properties.schema_revision >= 3", "properties.schema_revision >= 2");
		expect(() => validateDashboardBundle(changed, contract)).toThrow("schema revision publication gate");
	});
	it("prepares disabled native alerts without subscribers and validates their sample queries before writes", async () => {
		const api = fakeApi(bundle, { observed: true });
		const result = await publishTelemetryDashboards({
			bundle,
			contract,
			mode: "apply",
			token: "synthetic-token",
			fetcher: api.fetcher,
			includeAlerts: true,
		});
		const alerts = api.calls.filter((call) => call.path.endsWith("/alerts/") && call.method === "POST");
		expect(alerts).toHaveLength(3);
		for (const alert of alerts)
			expect(alert.body).toMatchObject({
				enabled: false,
				subscribed_users: [],
				config: { type: "HogQLAlertConfig", column: "alert_value", evaluation: "first_row" },
			});
		expect(result.writes.filter((entry) => entry.operation === "created_disabled_alert")).toHaveLength(3);
		const firstWrite = api.calls.findIndex((call) => call.path.includes("/insights/") && call.method !== "GET");
		expect(api.calls.slice(firstWrite).some((call) => call.path.endsWith("/query/"))).toBe(false);
		expect(telemetryAlertPayload(insight("alert-error-rate"), 100)).toMatchObject({
			threshold: { configuration: { bounds: { upper: 10 } } },
		});
		expect(sql("alert-error-rate")).toContain("sample_count >= 100 AND installation_count >= 10");
		expect(sql("alert-terminal-loss")).toContain("started_at <= now() - INTERVAL 1 HOUR");
		expect(sql("alert-ingestion-drop")).toContain("baseline_count >= 100 AND baseline_installations >= 10");
	});
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
