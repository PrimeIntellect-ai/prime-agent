import { type Api, getModels, getPrimeTeamId, getProviders, type Model } from "@earendil-works/pi-ai";
import type { AuthStatus } from "./auth-storage.js";
import type { ModelRegistry, ResolvedRequestAuth } from "./model-registry.js";
import {
	TELEMETRY_AUTH_CATEGORIES,
	TELEMETRY_MODEL_CATEGORIES,
	TELEMETRY_PROVIDER_CATEGORIES,
	telemetryAuthCategory,
	telemetryModelCategory,
	telemetryProviderCategory,
} from "./telemetry-categories.js";

export interface TelemetryExecutionContextCategories {
	providerCategory: string;
	modelCategory: string;
	authSource: string;
	teamScope: "personal" | "team" | "unknown";
	endpointCategory: "default" | "custom" | "unknown";
}

const UNKNOWN_CONTEXT: TelemetryExecutionContextCategories = {
	providerCategory: "unknown",
	modelCategory: "unknown",
	authSource: "unknown",
	teamScope: "unknown",
	endpointCategory: "unknown",
};

function property(value: object, name: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, name);
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function category(value: unknown, choices: readonly string[], fallback = "unknown"): string {
	return typeof value === "string" && choices.includes(value) ? value : fallback;
}

export function sanitizeTelemetryExecutionContext(value: unknown): TelemetryExecutionContextCategories | undefined {
	try {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return {
			providerCategory: category(property(value, "providerCategory"), [
				...TELEMETRY_PROVIDER_CATEGORIES,
				"custom",
				"unknown",
			]),
			modelCategory: category(property(value, "modelCategory"), [
				...TELEMETRY_MODEL_CATEGORIES,
				"custom",
				"unknown",
			]),
			authSource: category(property(value, "authSource"), [...TELEMETRY_AUTH_CATEGORIES, "unknown"]),
			teamScope: category(property(value, "teamScope"), [
				"personal",
				"team",
			]) as TelemetryExecutionContextCategories["teamScope"],
			endpointCategory: category(property(value, "endpointCategory"), [
				"default",
				"custom",
			]) as TelemetryExecutionContextCategories["endpointCategory"],
		};
	} catch {
		return undefined;
	}
}

function endpointCategory(model: Model<Api>): TelemetryExecutionContextCategories["endpointCategory"] {
	try {
		const provider = getProviders().find((value) => value === model.provider);
		if (!provider) return "custom";
		const endpoint = new URL(model.baseUrl).toString().replace(/\/+$/, "");
		return getModels(provider).some((builtin) => new URL(builtin.baseUrl).toString().replace(/\/+$/, "") === endpoint)
			? "default"
			: "custom";
	} catch {
		return "unknown";
	}
}

export function getTelemetryExecutionContext(
	modelRegistry: ModelRegistry,
	model: Model<Api> | undefined,
	request?: { authSource?: AuthStatus["source"]; headers?: Record<string, string> },
): TelemetryExecutionContextCategories {
	if (!model) return { ...UNKNOWN_CONTEXT };
	const context: TelemetryExecutionContextCategories = {
		...UNKNOWN_CONTEXT,
		providerCategory: telemetryProviderCategory(model.provider),
		modelCategory: telemetryModelCategory(model.id),
		endpointCategory: endpointCategory(model),
	};
	try {
		const status = request ? { source: request.authSource } : modelRegistry.getProviderAuthStatus(model.provider);
		context.authSource = telemetryAuthCategory(status.source, modelRegistry.authStorage.get(model.provider)?.type);
		if (model.provider === "prime-inference") {
			const headers = request ? request.headers : modelRegistry.authStorage.getProviderHeaders(model.provider);
			const team = headers?.["X-Prime-Team-ID"];
			// The provider adds its own CLI fallback before applying resolved request headers.
			const fallback =
				request && !Object.hasOwn(request.headers ?? {}, "X-Prime-Team-ID") ? getPrimeTeamId() : undefined;
			const selection = modelRegistry.authStorage.getPrimeInferenceTeamSelection();
			context.teamScope = team || fallback ? "team" : request || selection === null ? "personal" : "unknown";
		}
	} catch {
		// Missing configuration is coverage loss, not evidence about account access.
	}
	return context;
}

interface ContextObserver {
	listener: (context: TelemetryExecutionContextCategories) => void;
	isEnabled: () => boolean;
}
const observers = new WeakMap<object, Set<ContextObserver>>();

export function subscribeTelemetryExecutionContexts(
	session: object,
	listener: ContextObserver["listener"],
	isEnabled: () => boolean,
): () => void {
	let entries = observers.get(session);
	if (!entries) {
		entries = new Set();
		observers.set(session, entries);
	}
	const observer = { listener, isEnabled };
	entries.add(observer);
	return () => {
		entries.delete(observer);
		if (!entries.size) observers.delete(session);
	};
}

export function observeTelemetryRequestContext(
	session: object,
	modelRegistry: ModelRegistry,
	model: Model<Api>,
	result: ResolvedRequestAuth,
): void {
	for (const observer of observers.get(session) ?? []) {
		try {
			if (!observer.isEnabled() || !result.ok) continue;
			observer.listener(
				getTelemetryExecutionContext(modelRegistry, model, {
					authSource: result.authSource,
					headers: result.headers,
				}),
			);
		} catch {
			// Optional observers cannot affect request authentication.
		}
	}
}
