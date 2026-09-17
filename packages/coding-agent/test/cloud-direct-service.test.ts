import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudSessionStore } from "../src/core/cloud/cloud-session-store.js";
import {
	CLOUD_DELEGATION_BOOTSTRAP_SCRIPT,
	CLOUD_GUEST_RESULTS_DIR,
	type CloudDelegationResultsClient,
	type CloudDelegationVmProcessClient,
	type CloudDelegationWorkspaceTransfer,
} from "../src/core/cloud/delegation-orchestrator.js";
import {
	DirectCloudService,
	type DirectCloudServiceOptions,
	isDirectCloudConfigured,
} from "../src/core/cloud/direct-cloud-service.js";
import {
	type PrimeSandbox,
	type PrimeSandboxClient,
	PrimeSandboxError,
} from "../src/core/cloud/prime-sandbox-client.js";
import { CloudResultStore, cloudResultPatchPaths } from "../src/core/cloud/result-import.js";

const roots: string[] = [];
function temp(): string {
	const value = mkdtempSync(join(tmpdir(), "direct-cloud-service-test-"));
	roots.push(value);
	return value;
}
function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DirectCloudService configuration", () => {
	it("requires both a pinned image and a guest-scoped inference credential", () => {
		expect(isDirectCloudConfigured({})).toBe(false);
		expect(isDirectCloudConfigured({ PRIME_AGENT_CLOUD_IMAGE: "image" })).toBe(false);
		expect(
			isDirectCloudConfigured({
				PRIME_AGENT_CLOUD_IMAGE: "image",
				PRIME_AGENT_CLOUD_INFERENCE_API_KEY: "guest-key",
			}),
		).toBe(true);
	});
});

describe("DirectCloudService faux-provider flow", () => {
	it("provisions, survives service reconstruction, retrieves, and applies only explicitly", async () => {
		const root = temp();
		const repo = join(root, "repo");
		execFileSync("mkdir", ["-p", repo]);
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "a.txt"), "old\n");
		git(repo, "add", "a.txt");
		git(repo, "commit", "-qm", "initial");

		const stateDirectory = join(root, "state");
		const store = new CloudSessionStore(join(stateDirectory, "sessions"));
		const resultStore = new CloudResultStore(join(stateDirectory, "results"));
		const now = "2026-01-01T00:00:00.000Z";
		const sandbox: PrimeSandbox = {
			id: "sandbox-1",
			name: "cloud",
			dockerImage: "example/cloud:1",
			cpuCores: 4,
			memoryGb: 16,
			diskSizeGb: 50,
			gpuCount: 0,
			vm: true,
			status: "RUNNING",
			timeoutMinutes: 120,
			labels: [],
			createdAt: now,
			updatedAt: now,
		};
		const uploads: string[] = [];
		let deleteCount = 0;
		let sandboxAvailable = true;
		const platform = {
			createVmSandbox: async () => {
				sandboxAvailable = true;
				return sandbox;
			},
			getSandbox: async () => {
				if (!sandboxAvailable) throw new PrimeSandboxError("sandbox_not_found", "missing sandbox");
				return sandbox;
			},
			deleteSandbox: async () => {
				deleteCount += 1;
				sandboxAvailable = false;
			},
			getSandboxAuth: async () => ({
				sandboxId: sandbox.id,
				gatewayUrl: "https://gateway.example",
				userNamespace: "user",
				jobId: "job",
				token: "gateway-token",
				expiresAt: "2099-01-01T00:00:00.000Z",
			}),
			uploadFile: async (_sandboxId: string, request: { path: string; content: Uint8Array }) => {
				uploads.push(request.path);
				return { path: request.path, size: request.content.byteLength };
			},
		} as unknown as PrimeSandboxClient;
		const workspace: CloudDelegationWorkspaceTransfer = {
			capture: async () => ({
				baseline: {
					repoRoot: repo,
					headCommit: git(repo, "rev-parse", "HEAD"),
					manifestDigest: `sha256:${"a".repeat(64)}`,
				},
				archive: new Uint8Array([1]),
				manifest: new TextEncoder().encode("{}"),
				totalSizeBytes: 3,
				cleanup: () => {},
			}),
			upload: async (request) => {
				uploads.push(request.archivePath, request.manifestPath);
			},
		};
		const runningProcesses = new Set<string>();
		let failNextStart = false;
		const processClient: CloudDelegationVmProcessClient = {
			start: async (request) => {
				if (failNextStart) {
					failNextStart = false;
					throw new Error("simulated worker crash before process start");
				}
				const created = !runningProcesses.has(request.sessionUuid);
				runningProcesses.add(request.sessionUuid);
				return { sessionUuid: request.sessionUuid, created };
			},
			signalStop: async (sessionUuid) => {
				runningProcesses.delete(sessionUuid);
			},
			status: async (sessionUuid) =>
				runningProcesses.has(sessionUuid) ? { state: "running" } : { state: "unknown" },
		};
		let resultReady = false;
		const patch = [
			"diff --git a/a.txt b/a.txt",
			"--- a/a.txt",
			"+++ b/a.txt",
			"@@ -1 +1 @@",
			"-old",
			"+new",
			"",
		].join("\n");
		let resultPatch = patch;
		let resultOutcome: "completed" | "failed" | "stopped" = "completed";
		const results: CloudDelegationResultsClient = {
			fetch: async () =>
				resultReady
					? {
							outcome: resultOutcome,
							stdout: "done",
							stderr: "",
							patch: new TextEncoder().encode(resultPatch),
							retrievedAt: now,
						}
					: undefined,
			save: async ({ sessionId, result }) => {
				if (new TextDecoder().decode(result.patch).trim() === "") return;
				if (resultStore.get(sessionId, "res_output")) return;
				const baseline = store.get(sessionId)?.baseline;
				if (!baseline) throw new Error("missing baseline");
				resultStore.save({
					sessionId,
					resultId: "res_output",
					patch: new TextDecoder().decode(result.patch),
					baselineManifestDigest: baseline.manifestDigest,
				});
			},
		};
		const common: DirectCloudServiceOptions = {
			stateDirectory,
			apiKey: "platform-key",
			inferenceApiKey: "inference-only-key",
			dockerImage: "example/cloud:1",
			platform,
			store,
			resultStore,
			workspace,
			process: processClient,
			results,
			readiness: { isReady: async () => true },
			monitorPollIntervalMs: 1,
		};
		const service = new DirectCloudService(common);
		const started = await service.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-1",
			cwd: repo,
			prompt: "update a.txt",
		});
		expect(started.status).toBe("running");
		expect(uploads).toContain("/opt/prime-agent/workspace.tar");
		const startedRecord = store.get(started.id);
		expect(startedRecord?.eventCursor.sequence).toBeGreaterThan(0);
		expect(startedRecord?.ackCursor).toEqual(startedRecord?.eventCursor);
		expect(readFileSync(join(stateDirectory, "traces", "cloud-events.ndjson"), "utf8")).toContain(started.id);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("old\n");

		resultReady = true;
		while (store.get(started.id)?.resultImportState === "pending") {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const reconstructed = new DirectCloudService(common);
		const [completed] = await reconstructed.list("active-1");
		expect(completed).toMatchObject({
			id: started.id,
			status: "completed",
			resultReady: true,
			resultApplied: false,
			outcome: "completed",
			outputPreview: "done",
			changedPaths: ["a.txt"],
			changedPathCount: 1,
			patchPreview: expect.stringContaining("diff --git a/a.txt b/a.txt"),
			patchTruncated: false,
		});
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("old\n");

		const otherRepo = join(root, "other-repo");
		mkdirSync(otherRepo);
		git(otherRepo, "init", "-q");
		await expect(reconstructed.apply("active-1", started.id, otherRepo)).rejects.toThrow(
			"can only be applied to its captured repository",
		);
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("old\n");

		const applied = await reconstructed.apply("active-1", started.id, repo);
		expect(applied).toMatchObject({ status: "completed", resultApplied: true, outputPreview: "done" });
		expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("new\n");
		expect(deleteCount).toBe(1);
		expect(store.get(started.id)).toMatchObject({ observedLifecycle: "deleted", cleanupState: "released" });
		const appliedAgain = await reconstructed.apply("active-1", started.id, repo);
		expect(appliedAgain.resultApplied).toBe(true);
		expect(deleteCount).toBe(1);

		resultPatch = "";
		const noChange = await reconstructed.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-2",
			cwd: repo,
			prompt: "inspect only",
		});
		const summaries = await reconstructed.list("active-1");
		expect(summaries.find((item) => item.id === noChange.id)).toMatchObject({
			status: "completed",
			resultReady: true,
			outputPreview: "done",
		});
		const noChangeApplied = await reconstructed.apply("active-1", noChange.id, repo);
		expect(noChangeApplied).toMatchObject({ status: "completed", resultApplied: true });
		expect(deleteCount).toBe(2);

		resultOutcome = "failed";
		const failedNoChange = await reconstructed.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-3",
			cwd: repo,
			prompt: "fail without changes",
		});
		const failedSummary = (await reconstructed.list("active-1")).find((item) => item.id === failedNoChange.id);
		expect(failedSummary).toMatchObject({ status: "failed", outcome: "failed", resultReady: true });

		resultReady = false;
		resultOutcome = "completed";
		failNextStart = true;
		await expect(
			reconstructed.delegate({
				activeSessionId: "active-1",
				delegationId: "sess_direct-recovery",
				cwd: repo,
				prompt: "recover after crash",
			}),
		).rejects.toThrow("simulated worker crash");
		expect(store.get("sess_direct-recovery")?.observedLifecycle).toBe("provisioning");
		const recovered = (await new DirectCloudService(common).list("active-1")).find(
			(item) => item.id === "sess_direct-recovery",
		);
		expect(recovered).toMatchObject({ status: "running", promptPreview: "recover after crash" });
		sandboxAvailable = false;
		const lost = (await new DirectCloudService(common).list("active-1")).find(
			(item) => item.id === "sess_direct-recovery",
		);
		expect(lost).toMatchObject({ status: "failed", error: expect.stringContaining("no longer exists") });
	});

	it("keeps exact bytes of a non-UTF-8 patch through import, review, and apply", async () => {
		// git diff emits raw file bytes in text hunks, so a delegation that
		// touches a non-UTF-8 file produces a patch a strict UTF-8 decode
		// rejects; the concrete service must still import and apply it exactly.
		const root = temp();
		const repo = join(root, "repo");
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "latin.txt"), Buffer.from([0x61, 0xe9, 0xff, 0x0a]));
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "latin baseline");

		const scratch = join(root, "scratch");
		git(root, "clone", "-q", repo, scratch);
		const after = Buffer.from([0x62, 0xe9, 0xfe, 0x0a]);
		writeFileSync(join(scratch, "latin.txt"), after);
		const patchBytes = execFileSync("git", ["diff", "HEAD", "--no-color"], {
			cwd: scratch,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(() => new TextDecoder("utf-8", { fatal: true }).decode(patchBytes)).toThrow();

		const stateDirectory = join(root, "state");
		const now = "2026-01-01T00:00:00.000Z";
		const sandbox: PrimeSandbox = {
			id: "sandbox-latin",
			name: "cloud",
			dockerImage: "example/cloud:1",
			cpuCores: 4,
			memoryGb: 16,
			diskSizeGb: 50,
			gpuCount: 0,
			vm: true,
			status: "RUNNING",
			timeoutMinutes: 120,
			labels: [],
			createdAt: now,
			updatedAt: now,
		};
		const platform = {
			createVmSandbox: async () => sandbox,
			getSandbox: async () => sandbox,
			deleteSandbox: async () => {},
			getSandboxAuth: async () => ({
				sandboxId: sandbox.id,
				gatewayUrl: "https://gateway.example",
				userNamespace: "user",
				jobId: "job",
				token: "gateway-token",
				expiresAt: "2099-01-01T00:00:00.000Z",
			}),
			uploadFile: async (_sandboxId: string, request: { path: string; content: Uint8Array }) => ({
				path: request.path,
				size: request.content.byteLength,
			}),
			downloadFile: async (_sandboxId: string, path: string) => {
				if (path === `${CLOUD_GUEST_RESULTS_DIR}/status.txt`) return new TextEncoder().encode("completed\n");
				if (path === `${CLOUD_GUEST_RESULTS_DIR}/stdout.txt`) return new TextEncoder().encode("done\n");
				if (path === `${CLOUD_GUEST_RESULTS_DIR}/stderr.txt`) return new TextEncoder().encode("");
				if (path === `${CLOUD_GUEST_RESULTS_DIR}/changes.patch`) return patchBytes;
				throw new PrimeSandboxError("sandbox_not_found", `missing file: ${path}`);
			},
		} as unknown as PrimeSandboxClient;
		const service = new DirectCloudService({
			stateDirectory,
			apiKey: "platform-key",
			inferenceApiKey: "inference-only-key",
			dockerImage: "example/cloud:1",
			platform,
			workspace: {
				capture: async () => ({
					baseline: {
						repoRoot: repo,
						headCommit: git(repo, "rev-parse", "HEAD"),
						manifestDigest: `sha256:${"b".repeat(64)}`,
					},
					archive: new Uint8Array([1]),
					manifest: new TextEncoder().encode("{}"),
					totalSizeBytes: 3,
					cleanup: () => {},
				}),
				upload: async () => {},
			},
			process: {
				start: async (request) => ({ sessionUuid: request.sessionUuid, created: true }),
				signalStop: async () => {},
				status: async () => ({ state: "running" as const }),
			},
			readiness: { isReady: async () => true },
			monitorPollIntervalMs: 1,
		});

		const started = await service.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-latin",
			cwd: repo,
			prompt: "edit latin.txt",
		});
		expect(started.status).toBe("running");
		for (
			let attempt = 0;
			attempt < 500 && service.store.get(started.id)?.resultImportState === "pending";
			attempt++
		) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		expect(service.store.get(started.id)?.resultImportState).toBe("available");

		const [summary] = await service.list("active-1");
		expect(summary).toMatchObject({
			id: started.id,
			status: "completed",
			resultReady: true,
			resultApplied: false,
			changedPaths: ["latin.txt"],
			patchPreview: expect.stringContaining("diff --git a/latin.txt b/latin.txt"),
		});
		expect(readFileSync(join(repo, "latin.txt")).equals(Buffer.from([0x61, 0xe9, 0xff, 0x0a]))).toBe(true);

		const applied = await service.apply("active-1", started.id, repo);
		expect(applied).toMatchObject({ status: "completed", resultApplied: true });
		expect(readFileSync(join(repo, "latin.txt")).equals(after)).toBe(true);
	});

	it("bootstrap records committed and untracked guest changes before publishing terminal status", () => {
		const root = temp();
		const source = join(root, "source");
		const workspace = join(root, "workspace");
		const results = join(root, "results");
		mkdirSync(source);
		writeFileSync(join(source, "base.txt"), "old\n");
		const archive = join(root, "workspace.tar");
		execFileSync("tar", ["-cf", archive, "-C", source, "."]);
		const manifest = join(root, "manifest.json");
		const prompt = join(root, "prompt.txt");
		const auth = join(root, "auth.token");
		writeFileSync(manifest, "{}\n");
		writeFileSync(prompt, "make changes\n");
		writeFileSync(auth, "secret\n", { mode: 0o644 });
		const fakeAgent = join(root, "fake-agent.sh");
		writeFileSync(
			fakeAgent,
			[
				"#!/usr/bin/env bash",
				'git mv base.txt "renamed é.txt"',
				'printf "changed\\n" > "renamed é.txt"',
				'printf "new\\n" > new.txt',
				"git add -A",
				'git commit -qm "agent commit"',
			].join("\n"),
		);
		chmodSync(fakeAgent, 0o755);
		const bootstrap = join(root, "bootstrap.sh");
		writeFileSync(bootstrap, CLOUD_DELEGATION_BOOTSTRAP_SCRIPT);
		execFileSync("/bin/bash", [bootstrap], {
			env: {
				...process.env,
				PRIME_AGENT_CLOUD_WORKSPACE_DIR: workspace,
				PRIME_AGENT_CLOUD_ARCHIVE_PATH: archive,
				PRIME_AGENT_CLOUD_MANIFEST_PATH: manifest,
				PRIME_AGENT_CLOUD_PROMPT_PATH: prompt,
				PRIME_AGENT_CLOUD_AUTH_PATH: auth,
				PRIME_AGENT_CLOUD_RESULTS_DIR: results,
				PRIME_AGENT_CLOUD_AGENT_BIN: fakeAgent,
				PRIME_AGENT_CLOUD_MODEL: "",
			},
		});
		const patch = readFileSync(join(results, "changes.patch"), "utf8");
		expect(patch).toContain("diff --git a/base.txt b/base.txt");
		expect(patch).toContain("diff --git a/new.txt b/new.txt");
		expect(patch).toContain("diff --git a/renamed é.txt b/renamed é.txt");
		expect(cloudResultPatchPaths(patch)).toEqual(["base.txt", "new.txt", "renamed é.txt"]);
		expect(readFileSync(join(results, "status.txt"), "utf8")).toBe("completed\n");
		expect(existsSync(auth)).toBe(false);
	});

	it("bootstrap fails closed during setup and removes the guest credential", () => {
		const root = temp();
		const workspace = join(root, "workspace");
		const results = join(root, "results");
		const archive = join(root, "invalid.tar");
		const manifest = join(root, "manifest.json");
		const prompt = join(root, "prompt.txt");
		const auth = join(root, "auth.token");
		writeFileSync(archive, "not a tar archive");
		writeFileSync(manifest, "{}\n");
		writeFileSync(prompt, "task\n");
		writeFileSync(auth, "secret\n");
		const bootstrap = join(root, "bootstrap.sh");
		writeFileSync(bootstrap, CLOUD_DELEGATION_BOOTSTRAP_SCRIPT);
		expect(() =>
			execFileSync("/bin/bash", [bootstrap], {
				env: {
					...process.env,
					PRIME_AGENT_CLOUD_WORKSPACE_DIR: workspace,
					PRIME_AGENT_CLOUD_ARCHIVE_PATH: archive,
					PRIME_AGENT_CLOUD_MANIFEST_PATH: manifest,
					PRIME_AGENT_CLOUD_PROMPT_PATH: prompt,
					PRIME_AGENT_CLOUD_AUTH_PATH: auth,
					PRIME_AGENT_CLOUD_RESULTS_DIR: results,
					PRIME_AGENT_CLOUD_AGENT_BIN: "/bin/false",
					PRIME_AGENT_CLOUD_MODEL: "",
				},
			}),
		).toThrow();
		expect(readFileSync(join(results, "status.txt"), "utf8")).toBe("failed\n");
		expect(existsSync(auth)).toBe(false);
	});
});
