export interface DashboardDefinition {
	key: string;
	id?: number;
	name: string;
	description: string;
	operation?: "distinct_started" | "replace_query";
	property?: string;
	requires?: string[];
	query?: Record<string, unknown> & { source: { kind: string; query: string } };
}
export interface DashboardBundle {
	bundle_version: number;
	contract_schema_version: number;
	project_id: number;
	dashboard_id: number;
	host: string;
	timezone: string;
	corrections: DashboardDefinition[];
	insights: DashboardDefinition[];
}
export interface TelemetryContract {
	schema_version: number;
	events: Record<string, { properties: Record<string, unknown> }>;
}
export interface ExistingInsight {
	id: number;
	deleted?: boolean;
	dashboards?: number[];
	query: Record<string, unknown>;
}
export interface PublicationResult {
	status: string;
	writes: Array<{ operation: string; key: string; id: number }>;
	pending: Array<string | { key: string; reason: string }>;
	updates?: Array<{ key: string; id: number; patch: Record<string, unknown> }>;
	creates?: Array<{ key: string; patch: Record<string, unknown> }>;
	observedV2Events?: number;
}
export function readDashboardBundle(): Promise<DashboardBundle>;
export function readTelemetryContract(): Promise<TelemetryContract>;
export function validateDashboardBundle(bundle: DashboardBundle, contract: TelemetryContract): { corrections: number; insights: number };
export function correctionPatch(definition: DashboardDefinition, existing: ExistingInsight, dashboardId: number): Record<string, unknown>;
export function readinessQuery(bundle: DashboardBundle): string;
export function publishTelemetryDashboards(options: {
	bundle: DashboardBundle;
	contract: TelemetryContract;
	mode?: "check" | "preflight" | "apply";
	token?: string;
	fetcher?: typeof fetch;
	legacyOnly?: boolean;
}): Promise<PublicationResult>;
export function main(args?: string[]): Promise<void>;
