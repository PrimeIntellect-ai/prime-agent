import { type ChildProcess, fork } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { expect, it, vi } from "vitest";
import { AgentTraceDeliveryQueue, stopAgentTraceUploads, uploadAgentTraceFile } from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SettingsManager } from "../src/core/settings-manager.js";

it("runs bundled workers and shares ownership, pacing, crash recovery and rejected-key recovery across processes", async () => {
	const root = await mkdtemp(join(tmpdir(), "trace-process-"));
	const agentDir = join(root, "agent"),
		sends = join(root, "sends.jsonl");
	const children: ChildProcess[] = [];
	const noStart = vi.spyOn(AgentTraceDeliveryQueue.prototype, "start").mockImplementation(() => {});
	try {
		mkdirSync(agentDir);
		writeFileSync(join(root, "package.json"), readFileSync(resolve("package.json")));
		const bundle = join(root, "worker.mjs"),
			entry = join(root, "worker.ts");
		writeFileSync(
			entry,
			`
import { appendFileSync } from "node:fs";
import { AgentTraceDeliveryQueue } from ${JSON.stringify(resolve("src/core/agent-traces.ts"))};
import { AuthStorage } from ${JSON.stringify(resolve("src/core/auth-storage.ts"))};
import { SettingsManager } from ${JSON.stringify(resolve("src/core/settings-manager.ts"))};
Date.now = () => Number(process.env.TRACE_TEST_NOW);
process.on("message", () => {});
const queue = new AgentTraceDeliveryQueue({
 agentDir: ${JSON.stringify(agentDir)}, configPath: ${JSON.stringify(join(root, "absent-config.json"))},
 authStorage: AuthStorage.inMemory({ "prime-agent-traces": { type: "api_key", key: process.env.TRACE_TEST_KEY } }),
 settingsManager: SettingsManager.inMemory(),
 fetchFn: async (url, init) => {
  appendFileSync(${JSON.stringify(sends)}, JSON.stringify({ url, bytes: init.body.byteLength, at: Date.now(), pid: process.pid }) + "\\n");
  process.send("request");
  return new Promise(resolve => process.once("message", () => resolve(new Response("", { status: Number(process.env.TRACE_TEST_STATUS) }))));
 },
});
await queue.runOnce();
process.send("done", () => process.disconnect());
`,
		);
		await build({
			entryPoints: [entry],
			outfile: bundle,
			bundle: true,
			platform: "node",
			format: "esm",
			target: "node22",
			tsconfig: resolve("../../tsconfig.json"),
			logLevel: "silent",
			banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
		});
		const enqueue = async (name: string) => {
			const sessionFile = join(root, `${name}.jsonl`);
			writeFileSync(
				sessionFile,
				`${JSON.stringify({ type: "session", id: name, cwd: root, timestamp: "2026-09-08T00:00:00Z" })}\n`,
			);
			expect(
				await uploadAgentTraceFile({
					sessionFile,
					agentDir,
					authStorage: AuthStorage.inMemory(),
					settingsManager: SettingsManager.inMemory(),
					requireEnabled: false,
				}),
			).toMatchObject({ status: "queued" });
		};
		for (const name of ["one", "two"]) await enqueue(name);
		const launch = (when: number, key = "synthetic-process-key", status = 200) => {
			const child = fork(bundle, [], {
				execArgv: [],
				cwd: root,
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env: {
					...process.env,
					TRACE_TEST_NOW: String(when),
					TRACE_TEST_KEY: key,
					TRACE_TEST_STATUS: String(status),
					PRIME_AGENT_TRACES_API_KEY: "",
					PRIME_API_KEY: "",
					PRIME_AGENT_TRACES_BASE_URL: "https://synthetic.invalid",
				},
			});
			children.push(child);
			const messages: unknown[] = [];
			let errors = "";
			child.on("message", (message) => messages.push(message));
			child.stderr?.on("data", (chunk) => {
				errors += String(chunk);
			});
			const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
				child.once("exit", (code, signal) => resolveExit({ code, signal })),
			);
			return { child, messages, exited, errors: () => errors };
		};
		const now = Date.now(),
			owner = launch(now);
		await vi.waitFor(() => expect(owner.messages, owner.errors()).toContain("request"), { timeout: 5000 });
		const competitor = launch(now);
		expect(await competitor.exited, competitor.errors()).toEqual({ code: 0, signal: null });
		expect(competitor.messages).not.toContain("request");
		owner.child.send("release");
		expect(await owner.exited, owner.errors()).toEqual({ code: 0, signal: null });
		const limited = launch(now);
		expect(await limited.exited, limited.errors()).toEqual({ code: 0, signal: null });
		expect(limited.messages).not.toContain("request");
		const crashed = launch(now + 12_100);
		await vi.waitFor(() => expect(crashed.messages, crashed.errors()).toContain("request"), { timeout: 5000 });
		crashed.child.kill("SIGKILL");
		expect((await crashed.exited).signal).toBe("SIGKILL");
		expect(existsSync(join(agentDir, "agent-traces-outbox", ".delivery.lock"))).toBe(true);
		const replacement = launch(now + 60_000);
		await vi.waitFor(() => expect(replacement.messages, replacement.errors()).toContain("request"), {
			timeout: 5000,
		});
		replacement.child.send("release");
		expect(await replacement.exited, replacement.errors()).toEqual({ code: 0, signal: null });
		await enqueue("three");
		const rejected = launch(now + 120_000, "synthetic-process-key", 401);
		await vi.waitFor(() => expect(rejected.messages, rejected.errors()).toContain("request"), { timeout: 5000 });
		rejected.child.send("release");
		expect(await rejected.exited, rejected.errors()).toEqual({ code: 0, signal: null });
		const paused = launch(now + 180_000);
		expect(await paused.exited, paused.errors()).toEqual({ code: 0, signal: null });
		expect(paused.messages).not.toContain("request");
		const rotated = launch(now + 180_000, "replacement-process-key");
		await vi.waitFor(() => expect(rotated.messages, rotated.errors()).toContain("request"), { timeout: 5000 });
		rotated.child.send("release");
		expect(await rotated.exited, rotated.errors()).toEqual({ code: 0, signal: null });
		const requests = readFileSync(sends, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { at: number; url: string; bytes: number });
		expect(requests).toHaveLength(5);
		expect(requests.map((request) => request.at)).toEqual([
			now,
			now + 12_100,
			now + 60_000,
			now + 120_000,
			now + 180_000,
		]);
		expect(requests[1]!.url).toBe(requests[2]!.url);
		expect(requests[3]!.url).toBe(requests[4]!.url);
		expect(requests.every((request) => request.bytes > 0)).toBe(true);
	} finally {
		for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		noStart.mockRestore();
		stopAgentTraceUploads(agentDir);
		rmSync(root, { recursive: true, force: true });
	}
}, 20_000);
