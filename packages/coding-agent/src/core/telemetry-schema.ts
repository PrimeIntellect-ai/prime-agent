import { TELEMETRY_CONTRACT, type TelemetryPropertyRule } from "./telemetry-contract.js";

export type TelemetryPrimitive = string | number | boolean | null;
export type TelemetryProperties = Record<string, TelemetryPrimitive>;

export function isTelemetryUuid(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}

function sanitizeValue(value: unknown, rule: TelemetryPropertyRule): TelemetryPrimitive | undefined {
	if (value === null && rule.nullable) return null;
	switch (rule.kind) {
		case "enum":
			return typeof value === "string" && rule.values?.includes(value) ? value : rule.fallback;
		case "uuid":
			return isTelemetryUuid(value) ? value : undefined;
		case "version":
			return typeof value === "string" &&
				/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:alpha|beta|rc|dev|canary)(?:\.\d{1,5})?)?$/.test(value)
				? value
				: "0.0.0";
		case "boolean":
			return typeof value === "boolean" ? value : undefined;
		case "number":
			if (
				typeof value !== "number" ||
				!Number.isFinite(value) ||
				value < 0 ||
				value > (rule.max ?? Number.MAX_SAFE_INTEGER)
			)
				return undefined;
			return rule.integer ? Math.floor(value) : value;
		default:
			return undefined;
	}
}

export function sanitizeTelemetryProperties(
	name: string,
	properties: Record<string, unknown>,
	legacy = false,
): TelemetryProperties | undefined {
	const event = Object.hasOwn(TELEMETRY_CONTRACT.events, name) ? TELEMETRY_CONTRACT.events[name] : undefined;
	if (!event || (legacy && !event.legacy)) return undefined;
	const allowed = legacy ? (event.legacy_properties ?? []) : Object.keys(event.properties);
	const result: TelemetryProperties = {};
	for (const key of allowed) {
		const descriptor = Object.getOwnPropertyDescriptor(properties, key);
		if (!descriptor || !("value" in descriptor)) continue;
		const value = sanitizeValue(descriptor.value, event.properties[key]);
		if (value !== undefined) result[key] = value;
	}
	if (event.required.some((key) => !(key in result))) return undefined;
	if (name === "agent error" && typeof result.error_subtype === "string") {
		result.diagnostic_message = TELEMETRY_CONTRACT.diagnostic_messages[result.error_subtype];
	}
	if (legacy && result.install_method === "homebrew") result.install_method = "unknown";
	return result;
}

export function isLegacyTelemetryEvent(name: string): boolean {
	return Object.hasOwn(TELEMETRY_CONTRACT.events, name) && TELEMETRY_CONTRACT.events[name].legacy === true;
}
