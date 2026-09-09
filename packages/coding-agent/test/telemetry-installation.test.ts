import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	TelemetryClient,
	type TelemetryEventName,
	type TelemetryProperties,
	type TelemetrySink,
} from "../src/core/telemetry.js";
import {
	beginInstallationTelemetry,
	INSTALLATION_TELEMETRY_CONTEXT_ENV,
	installationTelemetryEnvironment,
	observeInstalledRuntimeReady,
	type TelemetryInstallationAttempt,
} from "../src/core/telemetry-installation.js";
import {
	clearInstallationTelemetryState,
	INSTALLATION_TELEMETRY_DIRECTORY,
	type InstallationTelemetryState,
	installationTelemetryContext,
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

function ready(version = "1.2.3", currentCwd = cwd): void {
	observeInstalledRuntimeReady({
		agentDir,
		cwd: currentCwd,
		settingsManager,
		sink,
		readyKind: "interactive",
		executionMode: "interactive",
		version,
		runtimeStartedAt: Date.now(),
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

	it.each(["not json", "[]", JSON.stringify({ installation_attempt_id: "../../private" })])(
		"ignores invalid optional inherited context: %s",
		(value) => {
			vi.stubEnv(INSTALLATION_TELEMETRY_CONTEXT_ENV, value);
			expect(begin()).toBeDefined();
			expect(sink.events[0].properties).toMatchObject({ stage: "started", installation_source: "cli" });
		},
	);

	it("does not keep arbitrary version labels or command output", () => {
		const attempt = begin();
		attempt?.setTargetVersion("https://private-canary.test/token");
		attempt?.stage("release_lookup", "unavailable", "release_lookup_failed", {
			stderr: "private-canary",
			prompt: "private-canary",
		});
		attempt?.installed();
		expect(JSON.stringify(sink.events)).not.toContain("private-canary");
		expect(readInstallationTelemetryState(agentDir)[0].properties).not.toHaveProperty("target_version");
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

	it("preserves the existing explicit environment override while DNT still wins", () => {
		savedSettings(agentDir, { telemetry: false });
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		expect(begin()).toBeDefined();
		vi.stubEnv("DO_NOT_TRACK", "1");
		expect(begin()).toBeUndefined();
	});

	it("fails closed if saved settings are malformed", () => {
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "settings.json"), "invalid json");
		expect(begin()).toBeUndefined();
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

	it("clears queued observations when a saved opt-out is detected before flush", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const client = new TelemetryClient({ agentDir, fetch });
		const attempt = begin({ sink: client });
		attempt?.installed();
		savedSettings(agentDir, { telemetry: { enabled: false } });
		await attempt?.flush();
		savedSettings(agentDir, { telemetry: { enabled: true } });
		await client.flush();
		expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});

	it("rechecks the original project consent even when startup happens elsewhere", () => {
		writeInstallationTelemetryState(agentDir, marker());
		savedSettings(join(cwd, ".prime", "agent"), { telemetry: false });
		const otherCwd = join(root, "other");
		mkdirSync(otherCwd);
		ready("1.2.3", otherCwd);
		expect(sink.events).toEqual([]);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});

	it("rechecks saved opt-out before automatic delivery during a long update", async () => {
		vi.useFakeTimers();
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			Response.json({ schema_versions: [1, 2], schema_revision: 3 }),
		);
		vi.stubGlobal("fetch", fetch);
		const attempt = beginInstallationTelemetry({ agentDir, cwd, settingsManager, source: "cli" });
		if (attempt) attempts.push(attempt);
		attempt?.stage("package_install", "started");
		savedSettings(agentDir, { telemetry: false });
		await vi.advanceTimersByTimeAsync(10001);
		savedSettings(agentDir, { telemetry: true });
		attempt?.finish("success");
		await attempt?.flush();
		expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
		expect(attempt?.environment().PRIME_AGENT_TELEMETRY).toBe("0");
	});

	it("rechecks current project consent independently of the originating project", () => {
		writeInstallationTelemetryState(agentDir, marker());
		const otherCwd = join(root, "other");
		savedSettings(join(otherCwd, ".prime", "agent"), { telemetry: false });
		ready("1.2.3", otherCwd);
		expect(sink.events).toEqual([]);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});
});

describe("private readiness markers", () => {
	it("delivers readiness when capability discovery takes more than the legacy fallback window", async () => {
		writeInstallationTelemetryState(agentDir, marker());
		const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
			if (init?.method === "GET") {
				await new Promise((resolve) => setTimeout(resolve, 350));
				return Response.json({ schema_versions: [1, 2], schema_revision: 3 });
			}
			const batch = JSON.parse(String(init?.body)) as { events: { id: string }[] };
			return Response.json({ accepted_ids: batch.events.map((event) => event.id) });
		});
		vi.stubGlobal("fetch", fetch);
		await observeInstalledRuntimeReady({
			agentDir,
			cwd,
			settingsManager,
			readyKind: "headless",
			version: "1.2.3",
			runtimeStartedAt: Date.now(),
		});
		expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});

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
		const delivery = observeInstalledRuntimeReady({
			agentDir,
			cwd,
			settingsManager,
			readyKind: "headless",
			runtimeStartedAt: Date.now(),
		});
		await vi.waitFor(() => expect(postSignal).toBeDefined());
		settingsManager.setTelemetryEnabled(false);
		expect(postSignal?.aborted).toBe(true);
		settingsManager.setTelemetryEnabled(true);
		await delivery;
		await observeInstalledRuntimeReady({
			agentDir,
			cwd,
			settingsManager,
			readyKind: "headless",
			runtimeStartedAt: Date.now(),
		});
		expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
	});

	it("clears pending readiness when a runtime explicitly opts out", async () => {
		writeInstallationTelemetryState(agentDir, marker());
		await observeInstalledRuntimeReady({
			agentDir,
			cwd,
			settingsManager,
			sink,
			telemetryDisabled: true,
			readyKind: "interactive",
			runtimeStartedAt: Date.now(),
		});
		expect(sink.events).toEqual([]);
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
	});

	it("keeps new markers for a new runtime instead of letting an older process consume them", () => {
		writeInstallationTelemetryState(agentDir, marker());
		observeInstalledRuntimeReady({
			agentDir,
			cwd,
			settingsManager,
			sink,
			readyKind: "interactive",
			version: "1.2.2",
			runtimeStartedAt: Date.now() - 10000,
		});
		expect(sink.events).toEqual([]);
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(1);
		ready();
		expect(sink.events[0].properties).toMatchObject({ outcome: "success", observed_version: "1.2.3" });
	});

	it("uses private bounded state and never includes the local consent path in an event", () => {
		const state = marker({ prompt: "private-canary" });
		writeInstallationTelemetryState(agentDir, state);
		const directory = join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY);
		const path = join(directory, `${state.properties.installation_attempt_id}.json`);
		expect(statSync(directory).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readFileSync(path, "utf8")).not.toContain("private-canary");
		ready();
		expect(JSON.stringify(sink.events)).not.toContain(cwd);
	});

	it("reports the observed version mismatch separately", () => {
		writeInstallationTelemetryState(agentDir, marker());
		ready("1.2.2");
		expect(sink.events[0].properties).toMatchObject({
			stage: "ready",
			outcome: "failed",
			reason: "version_mismatch",
			target_version: "1.2.3",
			observed_version: "1.2.2",
		});
	});

	it("can observe readiness after a fallback install with an unknown target version", () => {
		const state = marker();
		delete state.properties.target_version;
		writeInstallationTelemetryState(agentDir, state);
		ready();
		expect(sink.events[0].properties).toMatchObject({ outcome: "success", observed_version: "1.2.3" });
		expect(sink.events[0].properties).not.toHaveProperty("target_version");
	});

	it("keeps version comparison unknown for unrecognized running version labels", () => {
		writeInstallationTelemetryState(agentDir, marker());
		ready("1.2.3-private-canary");
		expect(sink.events[0].properties).toMatchObject({ outcome: "success", observed_version: "0.0.0" });
		expect(sink.events[0].properties).not.toHaveProperty("reason");
	});

	it("discards expired and invalid future markers and limits pending attempts", () => {
		writeInstallationTelemetryState(agentDir, { ...marker(), createdAt: Date.now() - 8 * 86400000 });
		writeInstallationTelemetryState(agentDir, { ...marker(), createdAt: Date.now() + 120000 });
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
		for (let i = 0; i < 20; i++) writeInstallationTelemetryState(agentDir, marker());
		expect(readInstallationTelemetryState(agentDir)).toHaveLength(16);
		expect(readdirSync(join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY))).toHaveLength(16);
	});

	it("does not follow state-directory or marker symlinks", () => {
		const outside = join(root, "outside");
		mkdirSync(outside);
		mkdirSync(agentDir);
		const directory = join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY);
		symlinkSync(outside, directory);
		writeInstallationTelemetryState(agentDir, marker());
		clearInstallationTelemetryState(agentDir);
		expect(readdirSync(outside)).toEqual([]);
		rmSync(directory);
		mkdirSync(directory);
		const state = marker();
		const outsidePath = join(outside, "keep.json");
		writeFileSync(outsidePath, JSON.stringify(state));
		symlinkSync(outsidePath, join(directory, `${state.properties.installation_attempt_id}.json`));
		expect(readInstallationTelemetryState(agentDir)).toEqual([]);
		expect(existsSync(outsidePath)).toBe(true);
		expect(readdirSync(directory)).toEqual([]);
	});

	it("drops oversized or corrupted markers without affecting startup", () => {
		writeInstallationTelemetryState(agentDir, marker());
		const directory = join(agentDir, INSTALLATION_TELEMETRY_DIRECTORY);
		writeFileSync(join(directory, readdirSync(directory)[0]), "x".repeat(17000));
		writeFileSync(join(directory, `${randomUUID()}.json`), "{");
		expect(() => ready()).not.toThrow();
		expect(sink.events).toEqual([]);
		expect(readdirSync(directory)).toEqual([]);
	});

	it("rejects invalid required context and strips all non-contract fields", () => {
		const context = marker().properties;
		expect(installationTelemetryContext({ ...context, installation_action: "private-canary" })).toBeUndefined();
		expect(installationTelemetryContext({ ...context, installation_attempt_id: "../../outside" })).toBeUndefined();
		expect(installationTelemetryContext({ ...context, cwd, prompt: "private-canary" })).toEqual(context);
	});
});
