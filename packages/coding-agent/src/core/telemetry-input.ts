import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { ActionLifecycle, DeliveryPolicy, SessionAction } from "./session-action-store.js";
import {
	sanitizeTelemetryExecutionContext,
	type TelemetryExecutionContextCategories,
} from "./telemetry-execution-context.js";

export type TelemetryInputRecoveryAction =
	| "credentials_updated"
	| "provider_changed"
	| "model_changed"
	| "manual_retry";

export interface TelemetryInputMetadata {
	inputId: string;
	clientSessionId?: string;
	onboardingId?: string;
	setupContext?: TelemetryExecutionContextCategories;
	uiContext?: TelemetryExecutionContextCategories;
	recoveryAction?: TelemetryInputRecoveryAction;
}

export interface TelemetryInputObservation {
	type: "received" | "action" | "settled";
	input: TelemetryInputMetadata;
	at: number;
	action?: {
		id: string;
		kind: "turn" | "session_command";
		state: ActionLifecycle["state"];
		previousState?: ActionLifecycle["state"];
		delivery: DeliveryPolicy;
		queueVisible: boolean;
	};
	error?: unknown;
}

interface InputObserverOptions {
	isEnabled: () => boolean;
	now?: () => number;
	randomId?: () => string;
}

interface InputObserver {
	listener: (observation: TelemetryInputObservation) => void;
	options: InputObserverOptions;
	generation: number;
}

interface InputScope {
	session: object;
	observer: InputObserver;
	generation: number;
	input: TelemetryInputMetadata;
}

const observers = new WeakMap<object, InputObserver>();
const actionScopes = new WeakMap<SessionAction, InputScope>();
const currentInput = new AsyncLocalStorage<InputScope>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_ACTIONS: readonly string[] = [
	"credentials_updated",
	"provider_changed",
	"model_changed",
	"manual_retry",
];

export function sanitizeTelemetryInputMetadata(value: unknown): TelemetryInputMetadata | undefined {
	try {
		if (!value || typeof value !== "object") return undefined;
		const raw = value as Record<string, unknown>;
		if (typeof raw.inputId !== "string" || !UUID.test(raw.inputId)) return undefined;
		const setupContext = sanitizeTelemetryExecutionContext(raw.setupContext);
		const uiContext = sanitizeTelemetryExecutionContext(raw.uiContext);
		return {
			inputId: raw.inputId,
			...(typeof raw.clientSessionId === "string" && UUID.test(raw.clientSessionId)
				? { clientSessionId: raw.clientSessionId }
				: {}),
			...(typeof raw.onboardingId === "string" && UUID.test(raw.onboardingId)
				? { onboardingId: raw.onboardingId }
				: {}),
			...(setupContext ? { setupContext } : {}),
			...(uiContext ? { uiContext } : {}),
			...(typeof raw.recoveryAction === "string" && RECOVERY_ACTIONS.includes(raw.recoveryAction)
				? { recoveryAction: raw.recoveryAction as TelemetryInputRecoveryAction }
				: {}),
		};
	} catch {
		return undefined;
	}
}

export function subscribeTelemetryInputs(
	session: object,
	listener: InputObserver["listener"],
	options: InputObserverOptions,
): () => void {
	const observer: InputObserver = { listener, options, generation: 0 };
	observers.set(session, observer);
	return () => {
		observer.generation++;
		if (observers.get(session) === observer) observers.delete(session);
	};
}

export function clearTelemetryInputs(session: object): void {
	const observer = observers.get(session);
	if (observer) observer.generation++;
}

function enabled(observer: InputObserver): boolean {
	try {
		if (observer.options.isEnabled()) return true;
	} catch {
		// Unavailable consent suppresses observation.
	}
	observer.generation++;
	return false;
}

function emit(scope: InputScope, observation: Omit<TelemetryInputObservation, "input" | "at">): void {
	if (
		observers.get(scope.session) !== scope.observer ||
		scope.generation !== scope.observer.generation ||
		!enabled(scope.observer)
	)
		return;
	try {
		scope.observer.listener({
			...observation,
			input: scope.input,
			at: (scope.observer.options.now ?? (() => performance.now()))(),
		});
	} catch {
		// Optional observation cannot interfere with prompt execution.
	}
}

export function observeTelemetryInput<T>(
	session: object,
	metadata: TelemetryInputMetadata | undefined,
	run: () => Promise<T>,
): Promise<T> {
	const observer = observers.get(session);
	if (!observer || !enabled(observer)) return run();
	let scope: InputScope;
	try {
		scope = {
			session,
			observer,
			generation: observer.generation,
			input: sanitizeTelemetryInputMetadata(metadata) ?? { inputId: (observer.options.randomId ?? randomUUID)() },
		};
	} catch {
		return run();
	}
	emit(scope, { type: "received" });
	return currentInput.run(scope, async () => {
		try {
			const result = await run();
			emit(scope, { type: "settled" });
			return result;
		} catch (error) {
			emit(scope, { type: "settled", error });
			throw error;
		}
	});
}

export function observeTelemetryAction(
	session: object,
	action: SessionAction,
	previousState?: ActionLifecycle["state"],
): void {
	const observer = observers.get(session);
	if (!observer || !enabled(observer)) return;
	let scope = actionScopes.get(action);
	if (!scope && previousState === undefined) {
		const input = currentInput.getStore();
		scope =
			input?.session === session && input.observer === observer
				? input
				: {
						session,
						observer,
						generation: observer.generation,
						input: { inputId: (observer.options.randomId ?? randomUUID)() },
					};
		actionScopes.set(action, scope);
	}
	if (!scope) return;
	emit(scope, {
		type: "action",
		action: {
			id: action.id,
			kind: action.payload.kind,
			state: action.lifecycle.state,
			previousState,
			delivery: action.delivery,
			queueVisible: "queueVisible" in action.payload && action.payload.queueVisible === true,
		},
		...(action.lifecycle.state === "failed" ? { error: action.lifecycle.error } : {}),
	});
	if (["completed", "failed", "cancelled"].includes(action.lifecycle.state)) actionScopes.delete(action);
}
