import { lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "../utils/atomic-file.js";

const STATE_FILE = "telemetry-onboarding.json";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OnboardingTelemetryContext {
	onboardingId: string;
	clientSessionId: string;
	startedAt: number;
}

export function clearOnboardingTelemetryContext(agentDir: string): void {
	try {
		rmSync(join(agentDir, STATE_FILE), { force: true });
	} catch {
		// Analytics state must not affect local work.
	}
}

export function saveOnboardingTelemetryContext(agentDir: string, context: OnboardingTelemetryContext): void {
	try {
		mkdirSync(agentDir, { recursive: true });
		writeFileAtomicSync(join(agentDir, STATE_FILE), JSON.stringify(context), { mode: 0o600 });
	} catch {
		// Cross-process correlation is optional.
	}
}

export function getCurrentOnboardingTelemetryContext(
	agentDir: string,
	now: number = Date.now(),
): OnboardingTelemetryContext | undefined {
	try {
		const path = join(agentDir, STATE_FILE);
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size > 1024) return undefined;
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null) return undefined;
		const state = value as Partial<OnboardingTelemetryContext>;
		if (
			typeof state.onboardingId !== "string" ||
			!UUID.test(state.onboardingId) ||
			typeof state.clientSessionId !== "string" ||
			!UUID.test(state.clientSessionId) ||
			typeof state.startedAt !== "number" ||
			!Number.isFinite(state.startedAt) ||
			state.startedAt > now ||
			now - state.startedAt > MAX_AGE_MS
		) {
			clearOnboardingTelemetryContext(agentDir);
			return undefined;
		}
		return {
			onboardingId: state.onboardingId,
			clientSessionId: state.clientSessionId,
			startedAt: state.startedAt,
		};
	} catch {
		return undefined;
	}
}
