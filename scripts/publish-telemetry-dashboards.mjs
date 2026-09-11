#!/usr/bin/env -S npx tsx
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TELEMETRY_CONTRACT } from "../packages/coding-agent/src/core/telemetry-contract.ts";

const DEFAULT_BUNDLE = new URL("../packages/coding-agent/docs/telemetry-dashboards.json", import.meta.url);
const MANAGED_TAG = "prime-agent-telemetry-eng-5933";

export async function readDashboardBundle() {
	return JSON.parse(await readFile(DEFAULT_BUNDLE, "utf8"));
}

export async function readTelemetryContract() {
	return TELEMETRY_CONTRACT;
}

export function validateDashboardBundle(bundle, contract) {
	if (bundle.bundle_version !== 1 || bundle.contract_schema_version !== contract.schema_version || !Number.isSafeInteger(bundle.contract_schema_revision) || bundle.contract_schema_revision < 1 || bundle.contract_schema_revision > contract.schema_revision) {
		throw new Error("Dashboard and telemetry contract versions do not match");
	}
	if (bundle.project_id !== 22174 || bundle.dashboard_id !== 882785 || bundle.host !== "https://eu.posthog.com") {
		throw new Error("Unexpected dashboard publication target");
	}
	if (bundle.timezone !== "GMT") throw new Error("Dashboard day definitions require the verified GMT project timezone");
	const properties = new Set(["telemetry_schema_version"]);
	for (const definition of Object.values(contract.events)) {
		for (const property of Object.keys(definition.properties)) properties.add(property);
	}
	const keys = new Set();
	const ids = new Set();
	for (const definition of [...bundle.corrections, ...bundle.insights]) {
		if (!/^[a-z0-9-]+$/.test(definition.key) || keys.has(definition.key)) throw new Error("Invalid or duplicate insight key");
		keys.add(definition.key);
		if (!definition.name || !definition.description) throw new Error(`Missing metric documentation: ${definition.key}`);
		if (bundle.insights.includes(definition) && (!Array.isArray(definition.requires) || definition.requires.length === 0)) {
			throw new Error(`Missing required deployed events: ${definition.key}`);
		}
		if (definition.id !== undefined) {
			if (!Number.isSafeInteger(definition.id) || ids.has(definition.id)) throw new Error("Invalid or duplicate legacy insight ID");
			ids.add(definition.id);
		}
		if (definition.operation === "distinct_started") {
			if (!contract.events["agent started"].properties[definition.property]) throw new Error("Unknown agent-started breakdown");
			continue;
		}
		const sql = definition.query?.source?.query;
		if (definition.query?.source?.kind !== "HogQLQuery" || typeof sql !== "string" || !/^\s*(SELECT|WITH)\b/i.test(sql)) {
			throw new Error(`Expected a read-only HogQL query: ${definition.key}`);
		}
		if (/;|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(sql)) throw new Error(`Unsafe SQL: ${definition.key}`);
		for (const match of sql.matchAll(/\bproperties\.([a-z_][a-z0-9_]*)/gi)) {
			if (!properties.has(match[1])) throw new Error(`Unknown contract property ${match[1]} in ${definition.key}`);
		}
		if (definition.requires) {
			if (!definition.requires.length || !sql.includes("properties.telemetry_schema_version = 2")) {
				throw new Error(`Missing v2 publication gate: ${definition.key}`);
			}
			for (const event of definition.requires) if (!contract.events[event]) throw new Error(`Unknown contract event: ${event}`);
			if (definition.min_schema_revision !== undefined && (!Number.isSafeInteger(definition.min_schema_revision) || definition.min_schema_revision < 1 || definition.min_schema_revision > bundle.contract_schema_revision || !sql.includes(`properties.schema_revision >= ${definition.min_schema_revision}`))) {
				throw new Error(`Missing schema revision publication gate: ${definition.key}`);
			}
		}
		if (definition.alert && (!Number.isFinite(definition.alert.upper) || definition.alert.column !== "alert_value" || definition.alert.calculation_interval !== "hourly" || !sql.includes("HAVING"))) throw new Error(`Invalid alert definition: ${definition.key}`);
	}
	return { corrections: bundle.corrections.length, insights: bundle.insights.length };
}

export function correctionPatch(definition, existing, dashboardId) {
	if (existing.id !== definition.id || existing.deleted || !existing.dashboards?.includes(dashboardId)) {
		throw new Error(`Legacy insight ${definition.id} is missing or moved; review before publishing`);
	}
	let query;
	if (definition.operation === "distinct_started") {
		query = structuredClone(existing.query);
		const source = query?.source;
		if (source?.kind !== "TrendsQuery" || !source.series?.length || source.series.some((series) => series.event !== "agent started" || !["total", "dau"].includes(series.math))) {
			throw new Error(`Legacy insight ${definition.id} changed shape; refusing to overwrite`);
		}
		const breakdown = source.breakdownFilter;
		if (breakdown?.breakdown !== definition.property && !breakdown?.breakdowns?.some((entry) => entry.property === definition.property)) {
			throw new Error(`Legacy insight ${definition.id} changed its breakdown`);
		}
		for (const series of source.series) series.math = "dau";
	} else {
		if (existing.query?.source?.kind !== "HogQLQuery") throw new Error(`Legacy insight ${definition.id} is no longer SQL`);
		query = structuredClone(definition.query);
	}
	return { name: definition.name, description: definition.description, query };
}

function sqlQuery(query) {
	return query.kind === "DataVisualizationNode" ? query.source : query;
}

function requiredRevisions(bundle) {
	return [...new Set(bundle.insights.map((insight) => insight.min_schema_revision).filter((revision) => revision !== undefined))].sort((a, b) => a - b);
}

export function readinessQuery(bundle) {
	const events = [...new Set(bundle.insights.flatMap((insight) => insight.requires))];
	const revisions = requiredRevisions(bundle).map((revision) => `, countIf(properties.schema_revision >= ${revision}) AS revision_${revision}_events`).join("");
	return `SELECT event, count() AS observed_events${revisions} FROM events\nWHERE properties.telemetry_schema_version = 2\nAND coalesce(properties.workload_origin, 'unknown') NOT IN ('internal', 'test')\nAND timestamp >= now() - INTERVAL 7 DAY\nAND event IN (${events.map((event) => `'${event.replaceAll("'", "''")}'`).join(", ")})\nGROUP BY event LIMIT 100`;
}

export function telemetryAlertPayload(definition, insightId) {
	if (!definition.alert || !Number.isSafeInteger(insightId) || insightId <= 0) throw new Error("Alert requires a saved insight");
	return {
		name: definition.alert.name, insight: insightId, subscribed_users: [], enabled: false,
		threshold: { configuration: { type: "absolute", bounds: { upper: definition.alert.upper } } },
		condition: { type: "absolute_value" },
		config: { type: "HogQLAlertConfig", column: definition.alert.column, evaluation: "first_row" },
		calculation_interval: definition.alert.calculation_interval,
	};
}

export async function publishTelemetryDashboards({ bundle, contract, mode = "check", token, fetcher = fetch, legacyOnly = false, includeAlerts = false }) {
	const counts = validateDashboardBundle(bundle, contract);
	if (!["check", "preflight", "apply"].includes(mode)) throw new Error("Unknown publication mode");
	if (mode === "check") return { status: "local_check_only", ...counts, writes: [], pending: bundle.insights.map((insight) => insight.key) };
	if (!token) throw new Error("POSTHOG_PERSONAL_API_KEY is required for read-only preflight or explicit apply");
	const prefix = `/api/projects/${bundle.project_id}/`;
	const request = async (path, method = "GET", body) => {
		const url = new URL(path, bundle.host);
		if (url.origin !== bundle.host || !url.pathname.startsWith(prefix)) throw new Error("Refusing an API request outside the reviewed project");
		const response = await fetcher(url, {
			method, redirect: "error", signal: AbortSignal.timeout(30_000),
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (!response.ok) throw new Error(`PostHog ${method} ${url.pathname} failed with HTTP ${response.status}; no automatic write retry was attempted`);
		return response.json();
	};
	const execute = async (query) => {
		const response = await request(`${prefix}query/`, "POST", { query: sqlQuery(query) });
		if (response.error || response.query_status?.error || !Array.isArray(response.results)) {
			throw new Error("Query validation did not complete successfully; publication stopped before writes");
		}
		return response.results;
	};
	const project = await request(prefix);
	if (project.id !== bundle.project_id || !["GMT", "UTC"].includes(project.timezone)) throw new Error("Project identity or timezone differs from the reviewed dashboard bundle");
	const dashboard = await request(`${prefix}dashboards/${bundle.dashboard_id}/`);
	if (dashboard.id !== bundle.dashboard_id || dashboard.deleted) throw new Error("Target dashboard is unavailable");
	const updates = [];
	for (const definition of bundle.corrections) {
		const existing = await request(`${prefix}insights/${definition.id}/`);
		const patch = correctionPatch(definition, existing, bundle.dashboard_id);
		await execute(patch.query);
		updates.push({ key: definition.key, id: definition.id, patch });
	}
	const pending = [];
	const creates = [];
	const alerts = [];
	const insightIds = new Map();
	let observedV2Events = 0;
	if (!legacyOnly) {
		const rows = await execute({ kind: "HogQLQuery", query: readinessQuery(bundle) });
		const revisions = requiredRevisions(bundle);
		const observed = new Map(rows.map((row) => [row[0], { total: Number(row[1]), revisions: new Map(revisions.map((revision, index) => [revision, Number(row[index + 2] ?? 0)])) }]));
		observedV2Events = [...observed.values()].reduce((total, count) => total + (Number.isFinite(count.total) ? count.total : 0), 0);
		const existingInsights = [];
		let next = `${prefix}insights/?search=${encodeURIComponent("Prime Agent telemetry:")}&limit=100`;
		let pages = 0;
		while (next) {
			if (++pages > 20) throw new Error("Insight search exceeded the bounded pagination limit");
			const page = await request(next);
			if (!Array.isArray(page.results)) throw new Error("Invalid insight search response");
			existingInsights.push(...page.results);
			next = page.next;
		}
		for (const definition of bundle.insights) {
			if (definition.requires.some((event) => !((definition.min_schema_revision ? observed.get(event)?.revisions.get(definition.min_schema_revision) : observed.get(event)?.total) > 0))) {
				pending.push({ key: definition.key, reason: "required_v2_events_not_observed" });
				continue;
			}
			const results = await execute(definition.query);
			if (results.length === 0) {
				pending.push({ key: definition.key, reason: "query_has_no_eligible_rows" });
				continue;
			}
			const keyTag = `${MANAGED_TAG}:${definition.key}`;
			const matches = existingInsights.filter((insight) => !insight.deleted && insight.tags?.includes(keyTag));
			if (matches.length > 1 || (matches.length === 0 && existingInsights.some((insight) => !insight.deleted && insight.name === definition.name))) {
				throw new Error(`Ambiguous existing chart ${definition.key}; review before publishing`);
			}
			const existing = matches[0];
			const patch = {
				name: definition.name, description: definition.description, query: definition.query, saved: true,
				tags: [...new Set([...(existing?.tags ?? []), MANAGED_TAG, keyTag])],
				dashboards: [...new Set([...(existing?.dashboards ?? []), bundle.dashboard_id])],
			};
			if (existing) {
				updates.push({ key: definition.key, id: existing.id, patch });
				insightIds.set(definition.key, existing.id);
			}
			else creates.push({ key: definition.key, patch });
			if (includeAlerts && definition.alert) alerts.push({ key: definition.key, definition });
		}
	}
	const existingAlerts = [];
	if (alerts.length) {
		let next = `${prefix}alerts/?limit=100`;
		let pages = 0;
		while (next) {
			if (++pages > 20) throw new Error("Alert search exceeded the bounded pagination limit");
			const page = await request(next);
			if (!Array.isArray(page.results)) throw new Error("Invalid alert search response");
			existingAlerts.push(...page.results);
			next = page.next;
		}
		for (const alert of alerts) {
			const matches = existingAlerts.filter((item) => item.name === alert.definition.alert.name);
			const existing = matches[0];
			const existingInsightId = typeof existing?.insight === "object" ? existing.insight?.id : existing?.insight;
			if (matches.length > 1 || (existing && existingInsightId !== insightIds.get(alert.key))) throw new Error(`Ambiguous existing alert ${alert.key}`);
			if (existing && (existing.threshold?.configuration?.bounds?.upper !== alert.definition.alert.upper || existing.config?.type !== "HogQLAlertConfig" || existing.config?.column !== alert.definition.alert.column || existing.config?.evaluation !== "first_row" || existing.calculation_interval !== "hourly")) throw new Error(`Existing alert ${alert.key} differs from the reviewed definition`);
			alert.existing = existing?.id;
		}
	}
	const plan = { status: pending.length ? "pending_data" : "validated", updates, creates, pending, observedV2Events, alerts: alerts.map(({ key, existing }) => ({ key, existing, action: existing ? "preserve_existing" : "create_disabled" })), writes: [] };
	if (mode === "preflight") return plan;
	if (!legacyOnly && observedV2Events === 0) throw new Error("No deployed public v2 events observed; nothing was published. Use --legacy-only to apply only reviewed historical corrections");
	for (const update of updates) {
		const result = await request(`${prefix}insights/${update.id}/`, "PATCH", update.patch);
		plan.writes.push({ operation: "updated", key: update.key, id: result.id });
	}
	for (const create of creates) {
		const result = await request(`${prefix}insights/`, "POST", create.patch);
		insightIds.set(create.key, result.id);
		plan.writes.push({ operation: "created", key: create.key, id: result.id });
	}
	for (const alert of alerts) {
		if (alert.existing) continue;
		const result = await request(`${prefix}alerts/`, "POST", telemetryAlertPayload(alert.definition, insightIds.get(alert.key)));
		plan.writes.push({ operation: "created_disabled_alert", key: alert.key, id: result.id });
	}
	plan.status = pending.length ? "partially_published_pending_data" : "published";
	return plan;
}

export async function main(args = process.argv.slice(2)) {
	const supported = new Set(["--check", "--preflight", "--apply", "--legacy-only", "--include-alerts", "--help"]);
	if (args.some((arg) => !supported.has(arg))) throw new Error("Unknown option; use --help");
	if (args.includes("--help")) {
		console.log("Usage: npx tsx scripts/publish-telemetry-dashboards.mjs [--check | --preflight | --apply] [--legacy-only] [--include-alerts]\nDefault --check validates local definitions without network access. --preflight performs read-only API validation. --apply explicitly writes reviewed insights after all preflight checks. POSTHOG_PERSONAL_API_KEY is required for API access. New charts require observed deployed schema revisions and eligible query rows. --include-alerts also creates disabled native alerts without subscribers; review thresholds and choose recipients in PostHog before enabling.");
		return;
	}
	const modes = ["--check", "--preflight", "--apply"].filter((flag) => args.includes(flag));
	if (modes.length > 1) throw new Error("Choose one publication mode");
	const result = await publishTelemetryDashboards({
		bundle: await readDashboardBundle(), contract: await readTelemetryContract(),
		mode: (modes[0] ?? "--check").slice(2), token: process.env.POSTHOG_PERSONAL_API_KEY,
		legacyOnly: args.includes("--legacy-only"),
		includeAlerts: args.includes("--include-alerts"),
	});
	console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "Dashboard publication failed");
		process.exitCode = 1;
	});
}
