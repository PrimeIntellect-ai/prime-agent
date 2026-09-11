import type { TelemetryInputMetadata, TelemetryInputObservation } from "./telemetry-input.js";
import type { TelemetryProperties } from "./telemetry-schema.js";

export interface ObservedTelemetryInput {
	metadata: TelemetryInputMetadata;
	receivedAt: number;
	queueWaitMs: number | null;
	preparationMs: number | null;
	inputToRunMs: number | null;
	runId?: string;
}

interface InputState extends ObservedTelemetryInput {
	phase?: { kind: "queueWaitMs" | "preparationMs"; startedAt: number };
	hasAction: boolean;
	terminal: boolean;
}

interface TrackerOptions {
	capture: (name: "agent input stage" | "agent timing", properties: TelemetryProperties) => void;
	onError: (error: unknown, input: TelemetryInputMetadata, runId?: string) => void;
}

export class TelemetryInputTracker {
	private readonly inputs = new Map<string, InputState>();
	private readonly dispatchingInputs = new Set<string>();

	constructor(private readonly options: TrackerOptions) {}

	clear(): void {
		this.inputs.clear();
		this.dispatchingInputs.clear();
	}

	private context(input: InputState): TelemetryProperties {
		return {
			input_id: input.metadata.inputId,
			...(input.metadata.clientSessionId ? { client_session_id: input.metadata.clientSessionId } : {}),
			...(input.metadata.onboardingId ? { onboarding_id: input.metadata.onboardingId } : {}),
			...(input.runId ? { run_id: input.runId } : {}),
		};
	}

	private stage(input: InputState, stage: string, outcome: string, at: number): void {
		this.options.capture("agent input stage", {
			...this.context(input),
			stage,
			outcome,
			timing_origin: "worker_input",
			duration_ms: Math.max(0, at - input.receivedAt),
		});
	}

	private timing(input: InputState, stage: string, duration: number, outcome = "success"): void {
		this.options.capture("agent timing", {
			...this.context(input),
			stage,
			outcome,
			timing_origin: "worker_action",
			duration_ms: Math.max(0, duration),
		});
	}

	private finishPhase(input: InputState, at: number, outcome = "success"): void {
		if (!input.phase) return;
		const { kind, startedAt } = input.phase;
		const duration = Math.max(0, at - startedAt);
		input[kind] = (input[kind] ?? 0) + duration;
		input.phase = undefined;
		this.timing(input, kind === "queueWaitMs" ? "queue_wait" : "local_preparation", duration, outcome);
	}

	observe(observation: TelemetryInputObservation): void {
		const { input: metadata, at } = observation;
		let input = this.inputs.get(metadata.inputId);
		if (!input) {
			if (this.inputs.size >= 256) {
				const oldest = this.inputs.keys().next().value ?? "";
				this.inputs.delete(oldest);
				this.dispatchingInputs.delete(oldest);
			}
			input = {
				metadata,
				receivedAt: at,
				queueWaitMs: null,
				preparationMs: null,
				inputToRunMs: null,
				hasAction: false,
				terminal: false,
			};
			this.inputs.set(metadata.inputId, input);
			this.stage(input, "received", "started", at);
		}
		if (input.terminal) return;
		if (observation.type === "settled") {
			// A queued prompt's promise settles before its action executes.
			if (observation.error !== undefined) this.finish(input, "error", at, observation.error);
			else if (!input.hasAction) this.finish(input, "no_run", at);
			return;
		}
		const action = observation.action;
		if (!action) return;
		input.hasAction = true;
		switch (action.state) {
			case "queued":
				if (input.phase?.kind !== "queueWaitMs") {
					this.finishPhase(input, at, "unknown");
					input.phase = { kind: "queueWaitMs", startedAt: at };
				}
				this.dispatchingInputs.delete(metadata.inputId);
				this.stage(input, "queued", "started", at);
				break;
			case "selected":
			case "preparing":
				if (input.phase?.kind !== "preparationMs") {
					this.finishPhase(input, at);
					input.phase = { kind: "preparationMs", startedAt: at };
					this.stage(input, "preparation", "started", at);
				}
				break;
			case "committing":
				this.finishPhase(input, at);
				if (action.kind === "turn") this.dispatchingInputs.add(metadata.inputId);
				this.stage(input, "dispatch", "success", at);
				break;
			case "running":
				this.finishPhase(input, at);
				this.stage(input, "admitted", "success", at);
				break;
			case "completed":
				this.finish(input, "success", at);
				break;
			case "failed":
				this.finish(input, "error", at, observation.error);
				break;
			case "cancelled":
				this.finish(input, "cancelled", at);
				break;
		}
	}

	private finish(input: InputState, outcome: string, at: number, error?: unknown): void {
		input.terminal = true;
		this.finishPhase(input, at, outcome);
		this.stage(input, "terminal", outcome, at);
		this.dispatchingInputs.delete(input.metadata.inputId);
		if (outcome === "error") {
			this.timing(input, "time_to_error", at - input.receivedAt, "error");
			if (error !== undefined) this.options.onError(error, input.metadata, input.runId);
		}
	}

	attachRun(runId: string, at: number): ObservedTelemetryInput | undefined {
		let primary: InputState | undefined;
		for (const id of this.dispatchingInputs) {
			const input = this.inputs.get(id);
			if (!input || input.terminal || input.runId) continue;
			primary ??= input;
			input.runId = runId;
			input.inputToRunMs = Math.max(0, at - input.receivedAt);
			this.options.capture("agent timing", {
				...this.context(input),
				stage: "input_to_run",
				outcome: "success",
				timing_origin: "worker_input",
				duration_ms: input.inputToRunMs,
			});
		}
		this.dispatchingInputs.clear();
		return primary;
	}
}
