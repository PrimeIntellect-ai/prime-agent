import {
	captureTelemetryEvent,
	isTelemetryEnabled,
	type TelemetryEventName,
	type TelemetryProperties,
} from "./telemetry.js";
import {
	captureTelemetryError,
	type TelemetryErrorContext,
	type TelemetryErrorDetails,
	withTelemetryErrorContext,
} from "./telemetry-errors.js";

/** Optional synchronous instrumentation must preserve the application's result. */
export function tryTelemetry<T>(observe: () => T): T | undefined {
	try {
		return observe();
	} catch {
		return undefined;
	}
}

interface TelemetryScopeOptions extends TelemetryErrorContext {
	now?: () => number;
	properties?: () => TelemetryProperties;
	isEnabled?: () => boolean;
	onDisabled?: () => void;
}

/** Binds consent and context once; operations own their timing and completion. */
export class TelemetryScope {
	private generation = 0;
	private disposed = false;
	private wasEnabled = true;
	private readonly unsubscribe: () => void;
	readonly now: () => number;

	constructor(private readonly context: TelemetryScopeOptions) {
		this.now = context.now ?? (() => performance.now());
		this.unsubscribe = context.settingsManager.subscribeTelemetryEnabled(() => this.enabled());
	}

	enabled(): boolean {
		let enabled = false;
		try {
			enabled =
				!this.disposed &&
				!this.context.telemetryDisabled &&
				isTelemetryEnabled(this.context.settingsManager) &&
				this.context.isEnabled?.() !== false;
		} catch {
			// Unavailable consent suppresses telemetry.
		}
		if (!enabled && this.wasEnabled) {
			this.generation++;
			this.wasEnabled = false;
			tryTelemetry(() => this.context.onDisabled?.());
		}
		this.wasEnabled = enabled;
		return enabled;
	}

	capture(name: TelemetryEventName, properties: TelemetryProperties): boolean {
		return (
			tryTelemetry(() => {
				if (!this.enabled()) return false;
				captureTelemetryEvent({
					...this.context,
					name,
					properties: { ...this.context.properties?.(), ...properties },
				});
				return this.enabled();
			}) ?? false
		);
	}

	error(error: unknown, details: Omit<TelemetryErrorDetails, "error">): string | undefined {
		if (!this.enabled()) return undefined;
		return captureTelemetryError({ ...this.context, ...details, error });
	}

	start(properties: TelemetryProperties = {}, startedAt: number | null = this.now()) {
		const permitted = this.enabled();
		properties = { ...tryTelemetry(() => this.context.properties?.()), ...properties };
		const generation = this.generation;
		let finished = false;
		const current = () => permitted && this.enabled() && generation === this.generation;
		const active = () => !finished && current();
		const elapsed = (at = this.now()) => (startedAt === null ? null : Math.max(0, at - startedAt));
		const record = (name: TelemetryEventName, fields: TelemetryProperties, at = this.now(), terminal = false) => {
			if (!active()) return false;
			finished = terminal;
			this.capture(name, { ...properties, duration_ms: elapsed(at), ...fields });
			return current();
		};
		const context: TelemetryErrorContext = {
			...this.context,
			get telemetryDisabled() {
				return active() ? undefined : true;
			},
		};
		return {
			active,
			elapsed,
			record,
			finish: (name?: TelemetryEventName, fields: TelemetryProperties = {}, at?: number) => {
				if (name) return record(name, fields, at, true);
				const captured = active();
				finished = true;
				return captured;
			},
			run: <T>(callback: () => T): T => withTelemetryErrorContext(context, callback),
			error: (error: unknown, details: Omit<TelemetryErrorDetails, "error">) =>
				active() ? this.error(error, details) : undefined,
		};
	}

	detach(): void {
		this.unsubscribe();
	}

	dispose(): void {
		this.detach();
		this.disposed = true;
		this.generation++;
	}
}

export type TelemetryOperation = ReturnType<TelemetryScope["start"]>;
