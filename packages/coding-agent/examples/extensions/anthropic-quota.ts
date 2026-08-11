import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface AnthropicQuotaWindow {
	name: "5h" | "7d";
	utilization: number;
	resetAt?: Date;
}

export interface AnthropicQuotaSnapshot {
	status?: string;
	windows: AnthropicQuotaWindow[];
}

const PREFIX = "anthropic-ratelimit-unified-";

function parseUtilization(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseFloat(value);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed <= 1 ? parsed : parsed / 100;
}

function parseReset(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const epochSeconds = Number(value);
	const timestamp = Number.isFinite(epochSeconds) ? epochSeconds * 1000 : Date.parse(value);
	if (!Number.isFinite(timestamp)) return undefined;
	return new Date(timestamp);
}

export function parseAnthropicQuota(headers: Record<string, string>): AnthropicQuotaSnapshot | undefined {
	const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
	const windows: AnthropicQuotaWindow[] = [];

	for (const [name, aliases] of [
		["5h", ["5h"]],
		["7d", ["7d", "weekly"]],
	] as const) {
		for (const alias of aliases) {
			const utilization = parseUtilization(normalized[`${PREFIX}${alias}-utilization`]);
			if (utilization === undefined) continue;
			windows.push({
				name,
				utilization,
				resetAt: parseReset(normalized[`${PREFIX}${alias}-reset`]),
			});
			break;
		}
	}

	if (windows.length === 0) return undefined;
	return { status: normalized[`${PREFIX}status`], windows };
}

export function formatAnthropicQuota(snapshot: AnthropicQuotaSnapshot): string {
	const windows = snapshot.windows.map(({ name, utilization }) => `${name} ${Math.round(utilization * 100)}%`);
	return `Claude quota ${windows.join(" · ")}`;
}

function warningBand(snapshot: AnthropicQuotaSnapshot): number {
	const utilization = Math.max(...snapshot.windows.map((window) => window.utilization));
	if (utilization >= 1) return 100;
	if (utilization >= 0.9) return 90;
	if (utilization >= 0.8) return 80;
	return 0;
}

function formatReset(window: AnthropicQuotaWindow | undefined): string {
	if (!window?.resetAt) return "reset time unavailable";
	return `resets ${window.resetAt.toLocaleString()}`;
}

export default function anthropicQuotaExtension(pi: ExtensionAPI): void {
	let previousBand = 0;

	pi.on("after_provider_response", (event, ctx) => {
		const snapshot = parseAnthropicQuota(event.headers);
		if (!snapshot) {
			ctx.ui.setStatus("anthropic-quota", undefined);
			previousBand = 0;
			return;
		}

		ctx.ui.setStatus("anthropic-quota", formatAnthropicQuota(snapshot));
		const band = warningBand(snapshot);
		if (band <= previousBand) return;
		previousBand = band;

		const limitingWindow = snapshot.windows.reduce((current, candidate) =>
			candidate.utilization > current.utilization ? candidate : current,
		);
		if (band === 100) {
			ctx.ui.notify(`Claude quota exhausted; ${formatReset(limitingWindow)}`, "error");
		} else if (band >= 90) {
			ctx.ui.notify(
				`Claude quota at ${Math.round(limitingWindow.utilization * 100)}%; ${formatReset(limitingWindow)}`,
				"warning",
			);
		}
	});
}
