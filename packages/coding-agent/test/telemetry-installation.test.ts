import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { TelemetryEventName, TelemetryProperties, TelemetrySink } from "../src/core/telemetry.js";
import {
	beginInstallationTelemetry,
	INSTALLATION_TELEMETRY_CONTEXT_ENV,
	installationTelemetryEnvironment,
	observeInstalledRuntimeReady,
	type TelemetryInstallationAttempt,
} from "../src/core/telemetry-installation.js";
import {
	type InstallationTelemetryState,
	readInstallationTelemetryState,
	writeInstallationTelemetryState,
} from "../src/core/telemetry-installation-state.js";

class Sink implements TelemetrySink {
	readonly events: { name: TelemetryEventName; properties: TelemetryProperties }[] = [];
	capture(name: TelemetryEventName, properties: TelemetryProperties): void {
		this.events.push({ name, properties });
	}
	async flush(): Promise<void> {}
}

let root: string;
let agentDir: string;
let cwd: string;
let sink: Sink;
let settingsManager: SettingsManager;
const attempts: TelemetryInstallationAttempt[] = [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prime-installation-test-"));
	agentDir = join(root, "agent");
	cwd = join(root, "project");
	mkdirSync(cwd);
	sink = new Sink();
	settingsManager = SettingsManager.inMemory();
	vi.stubEnv("DO_NOT_TRACK", "0");
	vi.stubEnv("PI_OFFLINE", "0");
	vi.stubEnv("PRIME_AGENT_TELEMETRY", undefined);
	vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, undefined);
});

afterEach(() => {
	for (const attempt of attempts.splice(0)) attempt.dispose();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.useRealTimers();
	rmSync(root, { recursive: true, force: true });
});

function begin(
	options: { now?: () => number; source?: "cli" | "interactive"; sink?: TelemetrySink } = {},
): TelemetryInstallationAttempt | undefined {
	const attempt = beginInstallationTelemetry({ agentDir, cwd, settingsManager, sink, source: "cli", ...options });
	if (attempt) attempts.push(attempt);
	return attempt;
}

function marker(properties: TelemetryProperties = {}): InstallationTelemetryState {
	return {
		version: 1,
		createdAt: Date.now(),
		cwd,
		completeOnReady: false,
		properties: {
			installation_attempt_id: randomUUID(),
			installation_action: "update",
			installation_source: "interactive",
			target_version: "1.2.3",
			...properties,
		},
	};
}

function savedSettings(directory: string, value: unknown): void {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "settings.json"), JSON.stringify(value));
}

function ready(overrides: Partial<Parameters<typeof observeInstalledRuntimeReady>[0]> = {}): Promise<void> {
	return observeInstalledRuntimeReady({
		agentDir,
		cwd,
		settingsManager,
		sink,
		readyKind: "interactive",
		executionMode: "interactive",
		version: "1.2.3",
		runtimeStartedAt: Date.now(),
		...overrides,
	});
}

describe("installation attempt observations", () => {
	it("measures stage durations, completes once, and keeps runtime readiness separate", () => {
		let now = 100;
		const attempt = begin({ now: () => now });
		expect(attempt).toBeDefined();
		attempt?.setTargetVersion("1.2.3");
		now = 110;
		attempt?.stage("package_install", "started");
		now = 180.9;
		attempt?.installed();
		attempt?.finish("success");
		attempt?.finish("failed", "unknown");
		expect(
			sink.events.map(({ properties }) => [properties.stage, properties.outcome, properties.duration_ms]),
		).toEqual([
			["started", "started", 0],
			["package_install", "started", 0],
			["package_install", "success", 70],
			["completed", "success", 80],
		]);
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(1);
		ready();
		ready();
		expect(sink.events.at(-1)?.properties).toMatchObject({
			stage: "ready",
			outcome: "success",
			target_version: "1.2.3",
			observed_version: "1.2.3",
			duration_ms: null,
		});
		expect(sink.events.filter(({ properties }) => properties.stage === "ready")).toHaveLength(1);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});

	it("shares an interactive attempt with its child without duplicating starts or inventing cross-process timing", () => {
		const parent = begin({ source: "interactive" });
		vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, parent?.environment()[INSTALLATION_TELEMETRY_CONTEXT_ENV]);
		const child = begin();
		child?.finish("success");
		expect(child?.properties.installation_attempt_id).toBe(parent?.properties.installation_attempt_id);
		expect(sink.events).toHaveLength(2);
		expect(sink.events.at(-1)?.properties).toMatchObject({ installation_source: "interactive", duration_ms: null });
	});

	it("preserves package success when daemon restart or session restoration fails", () => {
		const attempt = begin();
		attempt?.installed();
		attempt?.finish("success");
		attempt?.restartResult({ phase: "complete", counts: { total: 3, failed: 1 } });
		expect(sink.events.map(({ properties }) => [properties.stage, properties.outcome])).toContainEqual([
			"completed",
			"success",
		]);
		expect(sink.events.at(-1)?.properties).toMatchObject({
			stage: "session_restore",
			outcome: "failed",
			reason: "session_restore_failed",
			session_restore_total: 3,
			session_restore_failed: 1,
			duration_ms: null,
		});
	});
	it("keeps relaunch context and reports fallback errors after releasing the listener", () => {
		const attempt = begin({ source: "interactive" });
		attempt?.finish("success");
		const environment = attempt?.environment();
		attempt?.dispose();
		expect(attempt?.environment()).toEqual(environment);
		attempt?.fail("relaunch", new Error("Permission denied"), "relaunch_failed");
		expect(sink.events.at(-1)?.properties).toMatchObject({ stage: "relaunch", outcome: "failed" });
		settingsManager.setTelemetryEnabled(false);
		expect(attempt?.environment().PRIME_AGENT_TELEMETRY).toBe("0");
	});
});

describe("installation consent", () => {
	it.each([false, { enabled: false }])("honors legacy and current saved opt-outs: %j", (telemetry) => {
		for (const directory of [agentDir, join(cwd, ".prime", "agent")]) {
			savedSettings(directory, { telemetry });
			expect(begin()).toBeUndefined();
			rmSync(join(directory, "settings.json"));
		}
		expect(sink.events).toEqual([]);
		expect(existsSync(join(agentDir, "telemetry.json"))).toBe(false);
	});

	it.each([
		["PRIME_AGENT_TELEMETRY", "0"],
		["DO_NOT_TRACK", "1"],
		["PI_OFFLINE", "1"],
	])("honors %s=%s", (key, value) => {
		vi.stubEnv(key, value);
		expect(begin()).toBeUndefined();
		expect(installationTelemetryEnvironment(undefined)).toEqual({
			PRIME_AGENT_TELEMETRY: "0",
			[INSTALLATION_TELEMETRY_CONTEXT_ENV]: undefined,
		});
		expect(sink.events).toEqual([]);
	});

	it("permanently disables an attempt and deletes readiness state after an in-memory opt-out", () => {
		const attempt = begin();
		attempt?.installed();
		const before = sink.events.length;
		settingsManager.setTelemetryEnabled(false);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
		settingsManager.setTelemetryEnabled(true);
		attempt?.finish("success");
		expect(sink.events).toHaveLength(before);
		expect(attempt?.environment().PRIME_AGENT_TELEMETRY).toBe("0");
	});

	it.each(["original", "current"])("rechecks the %s project's saved consent", (project) => {
		writeInstallationTelemetryState(agentDir, marker());
		const otherCwd = join(root, "other");
		mkdirSync(otherCwd);
		savedSettings(join(project === "original" ? cwd : otherCwd, ".prime", "agent"), { telemetry: false });
		ready({ cwd: otherCwd });
		expect(sink.events).toEqual([]);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});
});

describe("private readiness markers", () => {
	it("aborts readiness delivery on opt-out and does not replay it after re-enabling", async () => {
		writeInstallationTelemetryState(agentDir, marker());
		let postSignal: AbortSignal | null | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			if (init?.method === "GET") return Response.json({ schema_versions: [1, 2], schema_revision: 3 });
			postSignal = init?.signal;
			return new Promise<Response>((_resolve, reject) => {
				postSignal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		vi.stubGlobal("fetch", fetch);
		const delivery = ready({ sink: undefined, readyKind: "headless" });
		await vi.waitFor(() => expect(postSignal).toBeDefined());
		settingsManager.setTelemetryEnabled(false);
		expect(postSignal?.aborted).toBe(true);
		settingsManager.setTelemetryEnabled(true);
		await delivery;
		await ready({ sink: undefined, readyKind: "headless" });
		expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it("reports the observed version mismatch separately", () => {
		writeInstallationTelemetryState(agentDir, marker());
		ready({ version: "1.2.2" });
		expect(sink.events[0].properties).toMatchObject({
			stage: "ready",
			outcome: "failed",
			reason: "version_mismatch",
			target_version: "1.2.3",
			observed_version: "1.2.2",
		});
	});
});
