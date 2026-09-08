import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../src/config.js";
import * as payloadWorker from "../src/core/agent-trace-payload.js";
import {
	AgentTraceDeliveryQueue,
	type AgentTraceUploadInstallOptions,
	cancelAgentTraceRequest,
	cancelPendingAgentTraceRequests,
	catchUpAgentTraceUploads,
	findAgentTraceFiles,
	formatAgentTraceStatus,
	getPrimeAgentTraceCredential,
	installAgentTraceUpload,
	previewAgentTraceFile,
	readAgentTraceStatus,
	SEMANTIC_EDGES_OUTBOX_KIND,
	stopAgentTraceUploads,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID, PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";

interface Job {
	sessionFile: string;
	state?: string;
	nextAttemptAt?: number;
	attempts?: number;
	lastAttemptAt?: number;
	failure?: { reason: string; at: number };
	manual?: { snapshotReady?: boolean };
	size?: number;
	mtimeMs?: number;
}
let root: string;
let agentDir: string;
let dir: string;
let now: number;
let options: AgentTraceUploadInstallOptions;
let fetchFn: ReturnType<typeof vi.fn<typeof fetch>>;
function file(name = "trace", cwd = root, extra: object[] = []): string {
	const path = join(root, `${name}.jsonl`);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(
		path,
		`${[
			{ type: "session", version: 3, id: name, timestamp: "2026-09-08T00:00:00.000Z", cwd },
			{
				type: "message",
				id: "msg",
				parentId: null,
				message: { role: "assistant", content: [{ type: "text", text: "synthetic response" }] },
			},
			...extra,
		]
			.map((value) => JSON.stringify(value))
			.join("\n")}\n`,
	);
	return path;
}
function autoPath(sessionFile: string): string {
	return join(dir, `${createHash("sha256").update(sessionFile).digest("hex").slice(0, 32)}.json`);
}
function entries(): Array<{ path: string; job: Job }> {
	return readdirSync(dir)
		.filter((name) => name.endsWith(".json") && !name.startsWith("batch-"))
		.map((name) => {
			const path = join(dir, name);
			return { path, job: JSON.parse(readFileSync(path, "utf8")) as Job };
		});
}
function job(sessionFile: string): Job {
	return entries().find((entry) => entry.job.sessionFile === sessionFile)!.job;
}
async function queue(sessionFile: string, manual = false, signal?: AbortSignal) {
	return uploadAgentTraceFile({ ...options, sessionFile, requireEnabled: !manual, signal });
}
async function run(): Promise<void> {
	await new AgentTraceDeliveryQueue(options).runOnce();
}
function globalSettings(enabled: boolean): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ agentTraces: { enabled } }));
}
function projectSettings(cwd: string, enabled: boolean): void {
	mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	writeFileSync(join(cwd, CONFIG_DIR_NAME, "settings.json"), JSON.stringify({ agentTraces: { enabled } }));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "trace-queue-"));
	agentDir = join(root, "agent");
	dir = join(agentDir, "agent-traces-outbox");
	now = Date.now() + 10_000;
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(AgentTraceDeliveryQueue.prototype, "start").mockImplementation(() => {});
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
	vi.stubEnv("PRIME_AGENT_TRACES_API_KEY", "");
	vi.stubEnv("PRIME_API_KEY", "");
	vi.stubEnv("PRIME_AGENT_TRACES_BASE_URL", "");
	fetchFn = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
	options = {
		agentDir,
		configPath: join(root, "missing-prime-config.json"),
		authStorage: AuthStorage.inMemory({
			[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "synthetic-key" },
		}),
		settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
		fetchFn,
	};
});
afterEach(() => {
	stopAgentTraceUploads(agentDir);
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("durable background trace delivery", () => {
	it("acknowledges current, bulk and startup work before any preparation or request", async () => {
		const prepare = vi.spyOn(payloadWorker, "prepareTracePayload");
		expect(await queue(file(), true)).toMatchObject({ status: "queued" });
		expect(await uploadAllAgentTraces({ ...options, sessionDir: root, requireEnabled: false })).toMatchObject({
			status: "queued",
		});
		expect(catchUpAgentTraceUploads(options)).toBeUndefined();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(prepare).not.toHaveBeenCalled();
		expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(2);
	});
	it("sends the unchanged raw JSONL PUT with parent/root and active-branch git headers", async () => {
		const parent = file("parent");
		const child = file("child", root, [
			{
				type: "git_state",
				id: "git-main",
				parentId: null,
				git: { repoUrl: "https://example.invalid/repo", commit: "main" },
			},
			{ type: "message", id: "leaf", parentId: "git-main" },
			{ type: "git_state", id: "sibling", parentId: null, git: { commit: "wrong" } },
			{ type: "message", id: "active", parentId: "leaf" },
		]);
		const lines = readFileSync(child, "utf8").split("\n");
		lines[0] = JSON.stringify({ ...JSON.parse(lines[0]!), parentSession: parent });
		writeFileSync(child, lines.join("\n"));
		await queue(child, true);
		await run();
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://api.primeintellect.ai/api/v1/agent-traces/sessions/child");
		expect(init?.method).toBe("PUT");
		expect(Buffer.from(init!.body as ArrayBuffer).toString()).toBe(readFileSync(child, "utf8"));
		expect(init?.headers).toMatchObject({
			Authorization: "Bearer synthetic-key",
			"Content-Type": "application/x-ndjson",
			"X-Trace-Id": "parent",
			"X-Parent-Session": "parent",
			"X-Cwd": root,
			"X-Git-Commit": "main",
			"X-Git-Repo": "https://example.invalid/repo",
		});
		expect(job(child).state).toBe("delivered");
	});
	it("keeps automatic uploads disabled by default and lets project settings only restrict global consent", async () => {
		globalSettings(false);
		projectSettings(root, true);
		options.settingsManager = SettingsManager.create(root, agentDir);
		expect(await queue(file())).toEqual({ status: "disabled" });
		globalSettings(true);
		projectSettings(root, false);
		expect(await queue(file())).toEqual({ status: "disabled" });
		projectSettings(root, true);
		expect(await queue(file())).toMatchObject({ status: "queued" });
	});
	it("reads each backlog session's own project instead of the queue owner's project", async () => {
		globalSettings(true);
		projectSettings(root, true);
		const other = join(root, "other");
		projectSettings(other, false);
		options.settingsManager = SettingsManager.create(root, agentDir);
		const allowed = file("allowed");
		const blocked = file("blocked", other);
		mkdirSync(dir, { recursive: true });
		writeFileSync(autoPath(allowed), JSON.stringify({ sessionFile: allowed }));
		writeFileSync(autoPath(blocked), JSON.stringify({ sessionFile: blocked }));
		await run();
		now += 61_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(job(blocked).state).toBe("paused");
		projectSettings(other, true);
		now += 61_000;
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it.each(["global", "project"])("rechecks %s consent after queueing and after backoff", async (scope) => {
		globalSettings(true);
		projectSettings(root, true);
		options.settingsManager = SettingsManager.create(root, agentDir);
		const path = file();
		await queue(path);
		const set = (enabled: boolean) => (scope === "global" ? globalSettings(enabled) : projectSettings(root, enabled));
		set(false);
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
		set(true);
		fetchFn.mockResolvedValueOnce(new Response("", { status: 503, headers: { "Retry-After": "180" } }));
		await run();
		set(false);
		now += 181_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		set(true);
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it("aborts an in-flight automatic request when consent is revoked", async () => {
		globalSettings(true);
		options.settingsManager = SettingsManager.create(root, agentDir);
		fetchFn.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				),
		);
		const path = file();
		await queue(path);
		const active = run();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
		globalSettings(false);
		await active;
		expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		expect(job(path).state).toBe("paused");
	});
	it("rechecks consent after delayed credential resolution and preparation", async () => {
		globalSettings(true);
		options.settingsManager = SettingsManager.create(root, agentDir);
		const real = payloadWorker.prepareTracePayload;
		vi.spyOn(payloadWorker, "prepareTracePayload").mockImplementation(async (input) => {
			const payload = await real(input);
			globalSettings(false);
			return payload;
		});
		await queue(file());
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("persists Retry-After across replacement workers and new transcript content", async () => {
		const path = file();
		await queue(path);
		fetchFn.mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
		await run();
		const deadline = job(path).nextAttemptAt!;
		appendFileSync(path, '{"id":"new-content"}\n');
		now += 600_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(job(path).nextAttemptAt).toBe(deadline);
		now = deadline;
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(job(path).state).toBe("delivered");
	});
	it("uses capped exponential jitter for repeated network failures, without sleeping in the queue", async () => {
		const path = file();
		await queue(path, true);
		vi.spyOn(Math, "random").mockReturnValue(0);
		fetchFn.mockRejectedValue(new TypeError("fetch failed: secret synthetic-key"));
		for (let attempt = 1; attempt <= 12; attempt++) {
			await run();
			const saved = job(path);
			expect(saved.attempts).toBe(attempt);
			const delay = saved.nextAttemptAt! - now;
			expect(delay).toBe(Math.min(300_000, Math.min(300_000, 1_000 * 2 ** (attempt - 1)) * 0.8));
			now = Math.max(saved.nextAttemptAt!, now + 12_100);
		}
		expect(readFileSync(join(agentDir, "logs", "agent-traces.log"), "utf8").match(/Trace delivery/g)).toHaveLength(1);
	});
	it("backs off preparation failures exponentially and isolates a corrupt entry", async () => {
		const path = file();
		await queue(path, true);
		writeFileSync(join(dir, "000-corrupt.json"), JSON.stringify({ sessionFile: path, manual: true }));
		vi.spyOn(payloadWorker, "prepareTracePayload").mockRejectedValue(new Error("disk read failed"));
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await run();
			expect(job(path).attempts).toBe(attempt);
			expect(job(path).nextAttemptAt).toBe(now + 1_000 * 2 ** (attempt - 1));
			now = job(path).nextAttemptAt!;
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("times out a stalled request and preserves its retry", async () => {
		options.requestTimeoutMs = 30;
		fetchFn.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				),
		);
		const path = file();
		await queue(path, true);
		await run();
		expect(job(path)).toMatchObject({ state: "retrying", failure: { reason: "timeout" } });
	});
	it("shares ownership and request spacing between queue instances", async () => {
		const one = file("one"),
			two = file("two");
		await queue(one, true);
		await queue(two, true);
		let finish!: (response: Response) => void;
		fetchFn.mockImplementationOnce(
			async () =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const first = run();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		const status = await readAgentTraceStatus({ ...options, sessionFile: one });
		expect(status.inProgress).toBe(1);
		finish(new Response("", { status: 200 }));
		await first;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		now += 12_100;
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it.each(["credential", "response"] as const)(
		"does not commit stale state after ownership is lost during %s",
		async (phase) => {
			const path = file();
			await queue(path, true);
			const realLock = lockfile.lock;
			let loseOwnership: (() => void) | undefined;
			vi.spyOn(lockfile, "lock").mockImplementation(async (path, lockOptions) => {
				loseOwnership = () => lockOptions?.onCompromised?.(new Error("lost"));
				return realLock(path, lockOptions);
			});
			if (phase === "credential")
				vi.spyOn(options.authStorage, "readApiKeyConfig").mockImplementation(async () => {
					loseOwnership?.();
					throw new Error("aborted");
				});
			else
				fetchFn.mockImplementation(async () => {
					loseOwnership?.();
					return new Response("", { status: 200 });
				});
			await run();
			expect(job(path).state).toBe(phase === "credential" ? "queued" : "uploading");
			expect(readdirSync(dir).some((name) => name.startsWith(".delivered-"))).toBe(false);
			if (phase === "credential") expect(fetchFn).not.toHaveBeenCalled();
		},
	);
	it("recovers an abandoned uploading job and a stale process lease", async () => {
		const path = file();
		await queue(path, true);
		const entry = entries()[0]!;
		writeFileSync(entry.path, JSON.stringify({ ...entry.job, state: "uploading" }));
		mkdirSync(join(dir, ".delivery.lock"));
		// Date.now is already ten seconds ahead; advance beyond the lock's stale interval.
		now += 40_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(job(path).state).toBe("delivered");
	});
	it("does not starve manual jobs behind continuously changing automatic sessions", async () => {
		const automatic = Array.from({ length: 5 }, (_, index) => file(`auto-${index}`));
		for (const path of automatic) await queue(path);
		for (let i = 0; i < 5; i++) {
			await run();
			now += 12_100;
		}
		const manual = file("manual-last");
		await queue(manual, true);
		for (let i = 0; i < 6; i++) {
			for (const path of automatic) appendFileSync(path, `{"id":"dirty-${i}"}\n`);
			await run();
			now += 12_100;
		}
		expect(job(manual).state).toBe("delivered");
	});
	it("pauses an invalid credential globally and resumes when it changes", async () => {
		await queue(file("one"), true);
		await queue(file("two"), true);
		fetchFn.mockResolvedValueOnce(new Response("synthetic-key", { status: 401 }));
		await run();
		now += 61_000;
		await run();
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		options.authStorage.set(PRIME_AGENT_TRACES_PROVIDER_ID, { type: "api_key", key: "replacement" });
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it("recovers missing credentials without a restart or explicit upload", async () => {
		options.authStorage.remove(PRIME_AGENT_TRACES_PROVIDER_ID);
		const path = file();
		await queue(path, true);
		await run();
		expect(job(path).state).toBe("paused");
		options.authStorage.set(PRIME_AGENT_TRACES_PROVIDER_ID, { type: "api_key", key: "restored" });
		await run();
		expect(job(path).state).toBe("delivered");
	});
	it("pauses permanent HTTP failures until the automatic file or endpoint changes", async () => {
		const path = file();
		await queue(path);
		fetchFn.mockResolvedValueOnce(new Response("", { status: 404 }));
		await run();
		now += 61_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		options.baseUrl = "https://synthetic.invalid";
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});
	it("retries an oversized automatic file only after its signature changes", async () => {
		const path = file();
		appendFileSync(path, "x".repeat(21 * 1024 * 1024));
		await queue(path);
		await run();
		expect(job(path)).toMatchObject({ state: "failed", failure: { reason: "too_large" } });
		const prepare = vi.spyOn(payloadWorker, "prepareTracePayload");
		now += 61_000;
		await run();
		expect(prepare).not.toHaveBeenCalled();
		file();
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
	});
});

describe("one-shot authorization", () => {
	it.each(["append", "replace"])("expires safely when the file is changed by %s before capture", async (change) => {
		options.settingsManager = SettingsManager.inMemory();
		const path = file();
		await queue(path, true);
		if (change === "append") appendFileSync(path, '{"id":"later"}\n');
		else {
			const replacement = file("replacement");
			renameSync(replacement, path);
		}
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(job(path)).toMatchObject({ state: "failed", failure: { reason: "snapshot_changed" } });
		expect(formatAgentTraceStatus(await readAgentTraceStatus({ ...options, sessionFile: path }))).toContain(
			"authorize its current content",
		);
	});
	it.each(["append", "replace", "delete"])(
		"retries only the captured bytes after %s and owner replacement",
		async (change) => {
			options.settingsManager = SettingsManager.inMemory();
			const path = file();
			const original = readFileSync(path, "utf8");
			await queue(path, true);
			fetchFn.mockRejectedValueOnce(new TypeError("offline"));
			await run();
			if (change === "append") appendFileSync(path, '{"id":"later"}\n');
			else if (change === "replace") renameSync(file("replacement"), path);
			else rmSync(path);
			now += 61_000;
			await run();
			expect(fetchFn).toHaveBeenCalledTimes(2);
			expect(Buffer.from(fetchFn.mock.calls[1]![1]!.body as ArrayBuffer).toString()).toBe(original);
			expect(options.settingsManager.getAgentTracesEnabled()).toBe(false);
			expect(existsSync(autoPath(path))).toBe(false);
		},
	);
	it("does not let an older manual retry overwrite a newer automatic delivery", async () => {
		const path = file();
		await queue(path, true);
		fetchFn.mockRejectedValueOnce(new TypeError("offline"));
		await run();
		const manualEntry = entries()[0]!;
		const deadline = now + 120_000;
		writeFileSync(manualEntry.path, JSON.stringify({ ...job(path), nextAttemptAt: deadline }));
		appendFileSync(path, '{"id":"newer"}\n');
		await queue(path);
		now += 61_000;
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		now = deadline;
		await run();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(JSON.parse(readFileSync(manualEntry.path, "utf8")).state).toBe("superseded");
	});
	it("persists cancellation before owner replacement and does not resume a cancelled retry", async () => {
		const controller = new AbortController();
		const path = file();
		const receipt = await queue(path, true, controller.signal);
		expect(receipt.status).toBe("queued");
		fetchFn.mockRejectedValueOnce(new TypeError("offline"));
		await run();
		controller.abort();
		now += 61_000;
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(job(path).state).toBe("cancelled");
	});
	it("cancels an active owner through a separately persisted request cancellation", async () => {
		const receipt = await queue(file(), true);
		if (receipt.status !== "queued") throw new Error("not queued");
		fetchFn.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				),
		);
		const running = run();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
		await cancelAgentTraceRequest(receipt.requestId, agentDir);
		await running;
		expect(entries()[0]!.job.state).toBe("cancelled");
	});
	it("does bulk discovery in the background and excludes versions created after the request", async () => {
		const existing = file("existing");
		await uploadAllAgentTraces({ ...options, sessionDir: root, requireEnabled: false });
		now += 1;
		const later = file("later");
		// Simulate a file created after the request despite the synthetic clock.
		const batch = readdirSync(dir).find((name) => name.startsWith("batch-"))!;
		const data = JSON.parse(readFileSync(join(dir, batch), "utf8"));
		data.requestedAt = statSync(existing).ctimeMs + 0.1;
		writeFileSync(join(dir, batch), JSON.stringify(data));
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(entries().map((item) => item.job.sessionFile)).toEqual([existing]);
		expect(entries().some((item) => item.job.sessionFile === later)).toBe(false);
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
	});
	it("cancels persisted manual and bulk requests after the client has restarted", async () => {
		await queue(file("one"), true);
		await uploadAllAgentTraces({ ...options, sessionDir: root, requireEnabled: false });
		expect(await cancelPendingAgentTraceRequests(agentDir)).toEqual({ cancelled: 2, failed: 0 });
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("contains cancellation marker failures instead of throwing from an AbortSignal listener", async () => {
		const controller = new AbortController();
		await queue(file(), true, controller.signal);
		rmSync(dir, { recursive: true });
		writeFileSync(dir, "not a directory");
		expect(() => controller.abort()).not.toThrow();
		expect(readFileSync(join(agentDir, "logs", "agent-traces.log"), "utf8")).toContain("could not be recorded");
	});
	it("keeps a cancelled bulk request cancelled after discovery and retries", async () => {
		file("one");
		file("two");
		const controller = new AbortController();
		await uploadAllAgentTraces({ ...options, sessionDir: root, requireEnabled: false, signal: controller.signal });
		await run();
		controller.abort();
		await run();
		expect(fetchFn).not.toHaveBeenCalled();
		expect(entries().every((entry) => entry.job.state === "cancelled")).toBe(true);
	});
});

describe("status and responsiveness", () => {
	it("reads shared progress without credential resolution, network, writes, or secrets", async () => {
		const path = file();
		await queue(path, true);
		fetchFn.mockResolvedValueOnce(new Response("payload secret synthetic-key", { status: 403 }));
		await run();
		const key = vi
			.spyOn(options.authStorage, "getApiKey")
			.mockRejectedValue(new Error("must not resolve credentials"));
		const before = readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs]);
		const status = await readAgentTraceStatus({
			...options,
			sessionFile: path,
			baseUrl: "https://user:synthetic-key@host.invalid/custom?key=synthetic-key",
		});
		const output = formatAgentTraceStatus(status);
		expect(key).not.toHaveBeenCalled();
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(status.paused).toBe(1);
		expect(output).toContain("run /traces login");
		expect(output).toContain("https://host.invalid/custom");
		expect(output).toContain(`Session file: ${path}`);
		expect(output).toContain("Prime Agent Traces credential");
		expect(output).not.toContain("synthetic-key");
		expect(output).not.toContain("payload secret");
		expect(readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mtimeMs])).toEqual(before);
	});
	it("isolates malformed delivery metadata during status reads and queue scans", async () => {
		const path = file();
		await queue(path, true);
		writeFileSync(
			join(dir, "malformed.json"),
			JSON.stringify({ sessionFile: path, failure: { reason: "http", at: 1e99, statusCode: "secret" } }),
		);
		expect(formatAgentTraceStatus(await readAgentTraceStatus(options))).not.toContain("secret");
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
	});
	it("reports queued, retrying, delivered and changed current content without claiming future content was shared", async () => {
		const path = file();
		await queue(path, true);
		expect((await readAgentTraceStatus({ ...options, sessionFile: path })).pending).toBe(1);
		fetchFn.mockRejectedValueOnce(new TypeError("offline"));
		await run();
		expect((await readAgentTraceStatus({ ...options, sessionFile: path })).currentSession).toContain("retrying");
		now += 61_000;
		await run();
		appendFileSync(path, '{"id":"unshared"}\n');
		const status = await readAgentTraceStatus({ ...options, sessionFile: path });
		expect(status.lastSuccessAt).toBe(now);
		expect(status.currentSession).toContain("newer or changed content");
	});
	it("preserves semantic-edge and unknown-kind entries and excludes them from JSONL counts", async () => {
		mkdirSync(dir, { recursive: true });
		const ledger = join(root, "semantic-edges.jsonl");
		writeFileSync(ledger, "edge\n");
		const saved = JSON.stringify({ sessionFile: ledger, kind: SEMANTIC_EDGES_OUTBOX_KIND, uploadedBytes: 1 });
		writeFileSync(join(dir, "edges.json"), saved);
		writeFileSync(join(dir, "future.json"), '{"kind":"future","cursor":7}');
		await run();
		expect(readFileSync(join(dir, "edges.json"), "utf8")).toBe(saved);
		const status = await readAgentTraceStatus(options);
		expect(status.pending + status.inProgress + status.paused + status.failed).toBe(0);
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("registers persisted sessions synchronously without waiting for a stalled network", () => {
		const session = SessionManager.create(root, join(root, "sessions"));
		installAgentTraceUpload(session, options);
		session.appendMessage({ role: "user", content: "synthetic user", timestamp: now });
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "synthetic assistant" }],
			api: "openai-completions",
			provider: "faux",
			model: "faux",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		});
		expect(existsSync(autoPath(session.getSessionFile()!))).toBe(true);
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("observes enablement in another process before the first response without retroactive registration", async () => {
		globalSettings(false);
		options.settingsManager = SettingsManager.create(root, agentDir);
		const session = SessionManager.create(root, join(root, "sessions"));
		installAgentTraceUpload(session, options);
		session.appendMessage({ role: "user", content: "synthetic", timestamp: now });
		expect(existsSync(dir)).toBe(false);
		globalSettings(true);
		session.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "synthetic" }],
			api: "openai-completions",
			provider: "faux",
			model: "faux",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now,
		});
		expect(options.settingsManager.getAgentTracesEnabled()).toBe(false);
		expect(existsSync(autoPath(session.getSessionFile()!))).toBe(true);
		await run();
		expect(fetchFn).toHaveBeenCalledOnce();
	});
	it("monitors the prepared transcript's project after an atomic replacement", async () => {
		globalSettings(true);
		projectSettings(root, true);
		const other = join(root, "other");
		projectSettings(other, true);
		options.settingsManager = SettingsManager.create(root, agentDir);
		const path = file();
		await queue(path);
		const original = payloadWorker.prepareTracePayload;
		vi.spyOn(payloadWorker, "prepareTracePayload").mockImplementation(async (input) => {
			renameSync(file("replacement", other), path);
			return original(input);
		});
		fetchFn.mockImplementation(
			async (_url, init) =>
				new Promise((_resolve, reject) =>
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
				),
		);
		const running = run();
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
		projectSettings(other, false);
		await running;
		expect(job(path).state).toBe("paused");
		expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});
	it("keeps event-loop timers running while preparing a large transcript", async () => {
		const path = file();
		appendFileSync(
			path,
			JSON.stringify({ type: "message", id: "large", parentId: "msg", content: "x".repeat(15 * 1024 * 1024) }) +
				"\n",
		);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 2);
		try {
			const prepared = await payloadWorker.prepareTracePayload({
				sessionFile: path,
				signal: new AbortController().signal,
			});
			expect(prepared.body.byteLength).toBe(statSync(path).size);
			expect(ticks).toBeGreaterThan(5);
		} finally {
			clearInterval(timer);
		}
	});
	it("keeps timers and status responsive during a stalled credential command", async () => {
		options.authStorage.set(PRIME_AGENT_TRACES_PROVIDER_ID, {
			type: "api_key",
			key: `!"${process.execPath}" -e "setTimeout(()=>process.stdout.write('synthetic-command-key'),200)"`,
		});
		const path = file();
		await queue(path, true);
		let ticks = 0;
		const timer = setInterval(() => {
			ticks++;
		}, 5);
		try {
			const running = run();
			const status = await readAgentTraceStatus({ ...options, sessionFile: path });
			expect(status.pending).toBe(1);
			await running;
			expect(ticks).toBeGreaterThan(10);
			expect(fetchFn).toHaveBeenCalledOnce();
		} finally {
			clearInterval(timer);
		}
	});
	it("previews without credentials and recursively discovers valid parent/child traces", async () => {
		const parent = file("parent"),
			child = file("artifacts/child");
		writeFileSync(join(root, "non-session.jsonl"), '{"type":"edge"}\n');
		const preview = await previewAgentTraceFile({ sessionFile: parent });
		expect(preview).toMatchObject({ status: "ready", sessionId: "parent", uploadable: true });
		expect(await findAgentTraceFiles(root)).toEqual([child, parent].sort());
		expect(fetchFn).not.toHaveBeenCalled();
	});
	it("retains trace/environment/inference/CLI credential preference using async reads", async () => {
		options.authStorage.set(PRIME_INFERENCE_PROVIDER_ID, { type: "api_key", key: "inference" });
		writeFileSync(options.configPath!, JSON.stringify({ api_key: "cli" }));
		expect((await getPrimeAgentTraceCredential(options.authStorage, options))?.apiKey).toBe("synthetic-key");
		options.authStorage.remove(PRIME_AGENT_TRACES_PROVIDER_ID);
		expect((await getPrimeAgentTraceCredential(options.authStorage, options))?.apiKey).toBe("inference");
		options.authStorage.remove(PRIME_INFERENCE_PROVIDER_ID);
		expect((await getPrimeAgentTraceCredential(options.authStorage, options))?.apiKey).toBe("cli");
		vi.stubEnv("PRIME_AGENT_TRACES_API_KEY", "environment");
		expect((await getPrimeAgentTraceCredential(options.authStorage, options))?.apiKey).toBe("environment");
	});
});
