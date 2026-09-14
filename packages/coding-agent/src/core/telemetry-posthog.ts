import { v5 as uuidv5 } from "uuid";
import type { TelemetryEvent } from "./telemetry.js";
import type { TelemetryPrimitive } from "./telemetry-schema.js";

export interface PostHogExceptionEvent {
	id: string;
	name: "$exception";
	timestamp: string;
	properties: Record<
		string,
		| TelemetryPrimitive
		| Array<{
				type: string;
				value: string;
				mechanism: { handled: boolean; synthetic: boolean };
		  }>
	>;
}

/** Receives only properties that have passed the client policy and collector negotiation. */
export function createPostHogException(
	installationId: string,
	event: TelemetryEvent,
): PostHogExceptionEvent | undefined {
	if (event.name !== "agent error" || event.properties.error_event_kind !== "occurrence") return undefined;
	const properties = event.properties;
	const component = properties.component ?? "unknown";
	const operation = properties.operation ?? "unknown";
	const provider = properties.provider_category ?? "unknown";
	let code = properties.error_code_group ?? "unknown";
	if (code === "unknown") code = properties.error_code ?? "unknown";
	const status = properties.http_status;
	if (code === "unknown" && typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599)
		code = `http_${status}`;
	const errorType = properties.error_type ?? "unknown";
	const subtype = properties.error_subtype ?? "unknown";
	const group = code === "unknown" ? `type:${errorType}|subtype:${subtype}` : `code:${code}`;
	const title = code === "unknown" ? `${errorType}: ${subtype}` : String(code);
	return {
		id: uuidv5(`prime-agent:exception:${installationId}:${event.id}`, uuidv5.URL),
		name: "$exception",
		timestamp: event.timestamp,
		properties: {
			...properties,
			$exception_list: [
				{
					type: errorType === "unknown" || errorType === "custom" ? "Error" : String(errorType),
					value: String(
						properties.error_message ||
							properties.diagnostic_message ||
							"An error occurred; private error details were omitted.",
					),
					mechanism: {
						handled: operation !== "uncaught_exception" && operation !== "unhandled_rejection",
						synthetic: true,
					},
				},
			],
			$exception_fingerprint: `prime-agent:v1|${component}|${operation}|${provider}|${group}`,
			$exception_level: "error",
			$issue_name: `${component}/${operation}: ${title}`,
			telemetry_source_event_id: event.id,
			telemetry_exception_message_source: properties.error_message_source ?? "diagnostic",
		},
	};
}
