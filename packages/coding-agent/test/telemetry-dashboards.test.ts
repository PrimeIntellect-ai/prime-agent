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
		target,
		calls,
		fetcher,
		writes: () => calls.filter((call) => call.path.includes("/insights/") && call.method !== "GET"),
		newQueries: () => calls.filter((call) => newSql.has((call.body?.query as { query?: string } | undefined)?.query)),
	};
}

function publish(
	api: ReturnType<typeof fakeApi>,
	options: Pick<Parameters<typeof publishTelemetryDashboards>[0], "mode" | "includeAlerts" | "legacyOnly">,
) {
	return publishTelemetryDashboards({
		bundle: api.target,
		contract,
		fetcher: api.fetcher,
		token: "synthetic-token",
		...options,
	});
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
		const result = await publish(api, { mode: "apply", includeAlerts: true });
		expect(result.alerts).toEqual([{ key: definition.key, existing: "existing-alert", action: "preserve_existing" }]);
		expect(api.calls.some((call) => call.path.endsWith("/alerts/") && call.method !== "GET")).toBe(false);
		const changed = fakeApi(target, {
			observed: true,
			existing,
			alerts: [{ ...alert, threshold: { configuration: { bounds: { upper: 99 } } } }],
		});
		await expect(publish(changed, { mode: "apply", includeAlerts: true })).rejects.toThrow(
			"differs from the reviewed definition",
		);
		expect(changed.writes()).toEqual([]);
	});
	it("requires revision 2 data for measurements not present in revision 1", async () => {
		const api = fakeApi(bundle, { observed: true, revision: 1 });
		const result = await publish(api, { mode: "preflight" });
		const pending = result.pending.map((entry) => (typeof entry === "string" ? entry : entry.key));
		for (const definition of bundle.insights.filter((item) => item.min_schema_revision === 2))
			expect(pending).toContain(definition.key);
		expect(result.creates?.some((entry) => entry.key === "run-outcomes")).toBe(true);
		expect(api.writes()).toEqual([]);
	});
	it("requires revision 3 installation data without delaying existing revision 2 views", async () => {
		const api = fakeApi(bundle, { observed: true, revision: 2 });
		const result = await publish(api, { mode: "preflight" });
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
		const result = await publish(api, { mode: "apply", includeAlerts: true });
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
		await expect(publish(api, { mode: "apply" })).rejects.toThrow("No deployed public v2 events observed");
		expect(api.writes()).toEqual([]);
		expect(api.newQueries()).toEqual([]);
	});

	it("performs read-only preflight and reports absent data without pretending charts are live", async () => {
		const api = fakeApi(bundle);
		const result = await publish(api, { mode: "preflight" });
		expect(result.status).toBe("pending_data");
		expect(result.pending).toHaveLength(bundle.insights.length);
		expect(result.creates).toEqual([]);
		expect(api.newQueries()).toEqual([]);
		expect(api.writes()).toEqual([]);
	});

	it("does not publish immature or otherwise empty chart cohorts", async () => {
		const api = fakeApi(bundle, { observed: true, emptyQueries: true });
		const result = await publish(api, { mode: "apply" });
		expect(result.status).toBe("partially_published_pending_data");
		expect(result.pending).toHaveLength(bundle.insights.length);
		expect(result.creates).toEqual([]);
		expect(api.writes()).toHaveLength(bundle.corrections.length);
		expect(api.writes().every((call) => call.method === "PATCH")).toBe(true);
	});

	it("validates every eligible query before any explicitly requested publication write", async () => {
		const api = fakeApi(bundle, { observed: true });
		const result = await publish(api, { mode: "apply" });
		expect(result.status).toBe("published");
		expect(api.writes()).toHaveLength(bundle.corrections.length + bundle.insights.length);
		const firstWrite = api.calls.findIndex((call) => call.path.includes("/insights/") && call.method !== "GET");
		expect(api.calls.slice(firstWrite).some((call) => call.path.endsWith("/query/"))).toBe(false);
	});

	it("stops before any mutation when query validation fails", async () => {
		const api = fakeApi(bundle, { observed: true, queryError: true });
		await expect(publish(api, { mode: "apply" })).rejects.toThrow("publication stopped before writes");
		expect(api.writes()).toEqual([]);
	});

	it("keeps legacy corrections available independently without querying or creating v2 charts", async () => {
		const api = fakeApi(bundle);
		const result = await publish(api, { mode: "apply", legacyOnly: true });
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
		const result = await publish(api, { mode: "apply" });
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
		await expect(publish(duplicate, { mode: "apply" })).rejects.toThrow("Ambiguous existing chart");
		expect(duplicate.writes()).toEqual([]);
		const redirected = fakeApi(bundle, { next: "https://example.invalid/api/projects/22174/insights/" });
		await expect(publish(redirected, { mode: "apply" })).rejects.toThrow("outside the reviewed project");
		expect(redirected.writes()).toEqual([]);
	});
});
