import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type CloudTunnelConnection,
	type CloudTunnelTransport,
	CloudTunnelTransportError,
} from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	CLOUD_DELEGATION_BOOTSTRAP_SCRIPT,
	CLOUD_GUEST_RESULTS_DIR,
	type CloudDelegationResultsClient,
	type CloudDelegationWorkspaceTransfer,
} from "../src/core/cloud/delegation-orchestrator.js";
import {
	cloudInferenceKeyFilePath,
	cloudInferenceTeamOverride,
	cloudTeamOverride,
	type DirectCloudDelegateOptions,
	DirectCloudService,
	isDirectCloudConfigured,
	resolveCloudInferenceCredential,
} from "../src/core/cloud/direct-cloud-service.js";
import {
	type PrimeSandboxClient,
	PrimeSandboxError,
	type PrimeSandboxVmCreateRequest,
} from "../src/core/cloud/prime-sandbox-client.js";
import { type CloudEvent, type CloudMessage, cloudRequestDigest } from "../src/core/cloud/protocol.js";
import { cloudTemp, type RecordingDelegationStack, recordingDelegationStack } from "./cloud-support.js";

/**
 * Drains the event loop until the observable settles: every source-side async
 * chain and 1ms monitor tick completes across turns, never a wall clock.
 */
async function until(predicate: () => boolean): Promise<void> {
	for (;;) {
		if (predicate()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Platform downloads for a guest's terminal results files. */
function guestResultsDownload(
	files: Record<string, Uint8Array>,
): (sandboxId: string, path: string) => Promise<Uint8Array> {
	const guestFiles: Record<string, Uint8Array> = {
		[`${CLOUD_GUEST_RESULTS_DIR}/status.txt`]: new TextEncoder().encode("completed\n"),
		[`${CLOUD_GUEST_RESULTS_DIR}/stdout.txt`]: new TextEncoder().encode("done\n"),
		[`${CLOUD_GUEST_RESULTS_DIR}/stderr.txt`]: new TextEncoder().encode(""),
		...files,
	};
	return async (_sandboxId, path) => {
		const content = guestFiles[path];
		if (content === undefined) throw new PrimeSandboxError("sandbox_not_found", `missing file: ${path}`);
		return content;
	};
}
describe("DirectCloudService configuration", () => {
	it("requires both a pinned image and a guest-scoped inference credential", () => {
		const emptyHome = cloudTemp("cloud-config-home-");
		expect(isDirectCloudConfigured({}, emptyHome)).toBe(false);
		expect(isDirectCloudConfigured({ PRIME_AGENT_CLOUD_IMAGE: "image" }, emptyHome)).toBe(false);
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
		const root = cloudTemp("direct-cloud-service-test-");
		const repo = join(root, "repo");
		execFileSync("mkdir", ["-p", repo]);
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "a.txt"), "old\n");
		git(repo, "add", "a.txt");
		git(repo, "commit", "-qm", "initial");

		const stateDirectory = join(root, "state");
		const now = "2026-01-01T00:00:00.000Z";
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-1",
			baseline: { repoRoot: repo, headCommit: git(repo, "rev-parse", "HEAD") },
			startFailureMessage: "simulated worker crash before process start",
		});
		const { calls, uploads, store, resultStore, commonOptions: common } = fakes;
		const deleteCount = () => calls.filter((call) => call.kind === "delete-sandbox").length;
		// The sandbox can also vanish under the service: deleteSandbox flips
		// availability and getSandbox then reports the platform's not-found
		// error exactly like a sandbox deleted out of band.
		let sandboxAvailable = true;
		// Wrap the RECORDING platform (which tracks call kinds) with the
		// availability flip; delegating to the recording wrapper keeps
		// deleteCount()/kinds assertions intact.
		fakes.commonOptions.platform = {
			...fakes.platform,
			createVmSandbox: async (request: PrimeSandboxVmCreateRequest) => {
				sandboxAvailable = true;
				return await fakes.platform.createVmSandbox(request);
			},
			getSandbox: async () => {
				if (!sandboxAvailable) throw new PrimeSandboxError("sandbox_not_found", "missing sandbox");
				return fakes.stack.sandbox;
			},
			deleteSandbox: async (sandboxId: string) => {
				sandboxAvailable = false;
				await fakes.platform.deleteSandbox(sandboxId);
			},
		} as unknown as PrimeSandboxClient;
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
							changedPaths: [],
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
		fakes.commonOptions.results = results;
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
		await until(() => store.get(started.id)?.resultImportState !== "pending");
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
		expect(deleteCount()).toBe(1);
		expect(store.get(started.id)).toMatchObject({ observedLifecycle: "deleted", cleanupState: "released" });
		const appliedAgain = await reconstructed.apply("active-1", started.id, repo);
		expect(appliedAgain.resultApplied).toBe(true);
		expect(deleteCount()).toBe(1);

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
		expect(deleteCount()).toBe(2);

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
		fakes.startFailures.count = 1;
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
		const root = cloudTemp("direct-cloud-service-test-");
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

		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-latin",
			baseline: { repoRoot: repo, headCommit: git(repo, "rev-parse", "HEAD") },
			downloadFile: guestResultsDownload({
				[`${CLOUD_GUEST_RESULTS_DIR}/changes.patch`]: patchBytes,
				[`${CLOUD_GUEST_RESULTS_DIR}/changed-paths.txt`]: new TextEncoder().encode("latin.txt\n"),
			}),
			results: "guest-files",
		});
		const service = new DirectCloudService(fakes.commonOptions);

		const started = await service.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-latin",
			cwd: repo,
			prompt: "edit latin.txt",
		});
		expect(started.status).toBe("running");
		await until(() => service.store.get(started.id)?.resultImportState !== "pending");
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

	it("never reports success when the guest lists changed paths but publishes no patch", async () => {
		// A broken guest contract (changed-paths.txt present and non-empty,
		// changes.patch empty) must fail the import loudly: the session never
		// reaches the review state, and a retried fetch keeps failing.
		const root = cloudTemp("direct-cloud-service-test-");
		const repo = join(root, "repo");
		execFileSync("mkdir", ["-p", repo]);
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "Test");
		writeFileSync(join(repo, "a.txt"), "old\n");
		git(repo, "add", "a.txt");
		git(repo, "commit", "-qm", "initial");

		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-no-patch",
			baseline: { repoRoot: repo, headCommit: git(repo, "rev-parse", "HEAD") },
			downloadFile: guestResultsDownload({
				[`${CLOUD_GUEST_RESULTS_DIR}/changes.patch`]: new TextEncoder().encode(""),
				[`${CLOUD_GUEST_RESULTS_DIR}/changed-paths.txt`]: new TextEncoder().encode("a.txt\n"),
			}),
			results: "guest-files",
		});
		const service = new DirectCloudService(fakes.commonOptions);

		const started = await service.delegate({
			activeSessionId: "active-1",
			delegationId: "sess_direct-no-patch",
			cwd: repo,
			prompt: "change a.txt",
		});
		await until(() => service.store.get(started.id)?.lastError !== undefined);
		const record = service.store.get(started.id);
		expect(record?.resultImportState).toBe("pending");
		expect(record?.lastError).toContain("changed paths");
		const [summary] = await service.list("active-1");
		expect(summary.status).not.toBe("completed");
		expect(summary.resultReady).toBe(false);
		expect(summary.changedPaths).toBeUndefined();
		// The broken result is never imported, so the sandbox is kept for review.
		expect(fakes.calls.filter((call) => call.kind === "delete-sandbox")).toHaveLength(0);
	});

	it("bootstrap hands the workspace to the bridge, which records committed and untracked guest changes", () => {
		const root = cloudTemp("direct-cloud-service-test-");
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
		// A stub bridge standing in for the uploaded one: it makes the guest's
		// changes, then owns the terminal results contract exactly like the
		// real bridge's finalize (patch against the baseline, auth removed,
		// status last).
		const stubBridge = join(root, "stub-bridge.sh");
		writeFileSync(
			stubBridge,
			[
				"#!/usr/bin/env bash",
				"set -eu",
				'cd "$PRIME_AGENT_CLOUD_WORKSPACE_DIR"',
				'git mv base.txt "renamed é.txt"',
				'printf "changed\n" > "renamed é.txt"',
				'printf "new\n" > new.txt',
				"git add -A",
				'git commit -qm "agent commit"',
				'printf "untracked\n" > untracked.txt',
				"git add -N -- untracked.txt || :",
				'git -c core.quotePath=false diff --binary --no-renames "$PRIME_AGENT_CLOUD_GIT_BASELINE" > "$PRIME_AGENT_CLOUD_RESULTS_DIR/changes.patch" 2>> "$PRIME_AGENT_CLOUD_RESULTS_DIR/stderr.txt" || :',
				'rm -f "$PRIME_AGENT_CLOUD_AUTH_PATH"',
				'printf "completed\n" > "$PRIME_AGENT_CLOUD_RESULTS_DIR/status.txt"',
			].join("\n"),
		);
		chmodSync(stubBridge, 0o755);
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
				PRIME_AGENT_CLOUD_AGENT_BIN: "prime-agent",
				PRIME_AGENT_CLOUD_MODEL: "",
				PRIME_AGENT_CLOUD_BRIDGE_ENABLED: "1",
				PRIME_AGENT_CLOUD_BRIDGE_PATH: stubBridge,
				PRIME_AGENT_CLOUD_NODE_BIN: "bash",
			},
		});

		const patch = readFileSync(join(results, "changes.patch"), "utf8");
		expect(patch).toContain("diff --git a/base.txt b/base.txt");
		expect(patch).toContain("diff --git a/new.txt b/new.txt");
		expect(patch).toContain("diff --git a/renamed é.txt b/renamed é.txt");
		expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt");
		expect(readFileSync(join(results, "status.txt"), "utf8")).toBe("completed\n");
		expect(existsSync(auth)).toBe(false);
	});

	it("bootstrap fails closed during setup and removes the guest credential", () => {
		const root = cloudTemp("direct-cloud-service-test-");
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

describe("DirectCloudService Prime Tunnel bridge", () => {
	/**
	 * In-memory bridge: records every client frame, answers hello with a
	 * snapshot and submit with a receipt, and lets the test push scripted
	 * frames or cut the edge.
	 */
	class ScriptedBridgeTransport implements CloudTunnelTransport {
		readonly sentFrames: string[] = [];
		private handler: ((message: string) => void) | undefined;
		private closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;
		private readonly drops: Array<() => void> = [];

		get connectionCount(): number {
			return this.drops.length;
		}

		/** Serve one scripted bridge frame to the live connection. */
		push(message: CloudMessage): void {
			this.handler?.(JSON.stringify(message));
		}

		/** Simulate the edge cutting every connection it has seen. */
		dropAll(): void {
			for (const drop of this.drops.splice(0)) drop();
		}

		async connect(): Promise<CloudTunnelConnection> {
			this.drops.push(() => {
				this.closeHandler?.(new CloudTunnelTransportError("closed", "simulated drop"));
			});
			return {
				send: (message) => {
					this.sentFrames.push(message);
					const parsed = JSON.parse(message) as CloudMessage;
					if (parsed.type === "hello") {
						this.push({
							type: "snapshot",
							sessionId: parsed.sessionId,
							generation: parsed.generation,
							cursor: { generation: parsed.generation, sequence: 0 },
							status: "busy",
							state: { cwd: "/w", modelId: "image-default", queuedCommandIds: [] },
							events: [],
						});
					}
					if (parsed.type === "submit") {
						this.push({
							type: "command",
							sessionId: parsed.sessionId,
							generation: parsed.generation,
							receipt: {
								commandId: parsed.commandId,
								digest: cloudRequestDigest(parsed.request),
								state: "accepted",
								submittedAt: "2026-01-01T00:00:00.000Z",
								updatedAt: "2026-01-01T00:00:00.000Z",
								uncertain: false,
							},
						});
					}
				},
				close: () => {
					this.closeHandler?.();
				},
				onMessage: (handler) => {
					this.handler = handler;
				},
				onClose: (handler) => {
					this.closeHandler = handler;
				},
			};
		}
	}

	/** Frames of one wire type, parsed, with their cursor field when present. */
	function framesOfType(
		frames: readonly string[],
		type: string,
	): Array<{ cursor?: { generation: number; sequence: number } }> {
		const parsed: Array<{ cursor?: { generation: number; sequence: number } }> = [];
		for (const frame of frames) {
			const value = JSON.parse(frame) as {
				type?: string;
				cursor?: { generation: number; sequence: number };
			};
			if (value.type === type) parsed.push(value);
		}
		return parsed;
	}

	function guestEvent(sequence: number): CloudEvent {
		return {
			sequence,
			kind: "output_delta",
			recordedAt: "2026-01-01T00:00:00.000Z",
			taskId: "task_cursor_legacy",
			stream: "stdout",
			text: `evt-${sequence}`,
		};
	}

	/** The local durable trace: every imported output_delta text, in order. */
	function tracedTexts(path: string): string[] {
		if (!existsSync(path)) return [];
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as { event?: { kind?: string; text?: string } })
			.filter((record) => record.event?.kind === "output_delta")
			.map((record) => record.event?.text ?? "");
	}

	/**
	 * The tunnel-suite workhorse: delegate one "work" prompt into the sandbox
	 * repo over the recording stack.
	 */
	async function delegateWork(
		fakes: RecordingDelegationStack,
		service: DirectCloudService,
		sessionId: string,
		options: DirectCloudDelegateOptions = { tunnel: true, timeoutMinutes: 10 },
	) {
		return await service.delegate({
			activeSessionId: "active-1",
			delegationId: sessionId,
			cwd: join(fakes.root, "repo"),
			prompt: "work",
			options,
		});
	}

	it("registers the tunnel before start, keeps secrets out of the record, and never passes the platform key into the guest", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-1",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const { calls, uploads, startEnvs, tunnelRegistration, store } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, "sess_tunnel-1");
		expect(started.status).toBe("running");
		expect(started.tunnel).toMatchObject({
			tunnelId: tunnelRegistration.tunnelId,
			url: tunnelRegistration.url,
		});
		// Ordering: the tunnel is registered after readiness and before the start.
		const kinds = calls.map((call) => call.kind);
		expect(kinds.indexOf("register-tunnel")).toBeLessThan(kinds.indexOf("start"));
		expect(kinds.indexOf("register-tunnel")).toBeGreaterThan(kinds.indexOf("create"));
		// The uploaded bridge script rides the gateway like every other input.
		expect(uploads).toContain("/opt/prime-agent/bridge/bridge-server.mjs");
		// The guest env carries the tunnel grant but never the platform key.
		expect(startEnvs).toHaveLength(1);
		const env = startEnvs[0] as Record<string, string>;
		expect(env.PRIME_AGENT_CLOUD_BRIDGE_ENABLED).toBe("1");
		expect(env.PRIME_AGENT_CLOUD_BRIDGE_TOKEN.length).toBeGreaterThanOrEqual(16);
		expect(env.PRIME_AGENT_CLOUD_TUNNEL_ID).toBe(tunnelRegistration.tunnelId);
		expect(env.PRIME_AGENT_CLOUD_TUNNEL_FRP_TOKEN).toBe(tunnelRegistration.frpToken);
		expect(env.PRIME_AGENT_CLOUD_TUNNEL_BINDING_SECRET).toBe(tunnelRegistration.bindingSecret);
		expect(env.PRIME_API_KEY).toBeUndefined();
		// The record holds only non-secret tunnel facts; secrets live in their own store.
		const record = store.get(started.id);
		expect(record?.tunnel).toMatchObject({ tunnelId: tunnelRegistration.tunnelId, httpUser: "prime-agent" });
		expect(JSON.stringify(record)).not.toContain(tunnelRegistration.httpPassword);
		const secretFile = readFileSync(join(root, "state", "tunnel-secrets", `${started.id}.json`), "utf8");
		expect(secretFile).toContain(tunnelRegistration.httpPassword);
		expect(statSync(join(root, "state", "tunnel-secrets", `${started.id}.json`)).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "state", "tunnel-secrets")).mode & 0o777).toBe(0o700);
		await service.stop("active-1", started.id, true);
	});

	it("releases the tunnel with sandbox cleanup", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-2",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const { deletedTunnels, tunnelRegistration, store } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, "sess_tunnel-2");
		await service.stop("active-1", started.id, true);
		expect(deletedTunnels).toEqual([tunnelRegistration.tunnelId]);
		const record = store.get(started.id);
		expect(record?.tunnelState).toBe("released");
		expect(existsSync(join(root, "state", "tunnel-secrets", `${started.id}.json`))).toBe(false);
	});

	it("forfeit releases the platform tunnel and secrets before the sandbox delete, and stays idempotent on repeats", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, { sandboxId: "sandbox-forfeit-1" });
		const { deletedTunnels, tunnelRegistration, store } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await service.delegate({
			activeSessionId: "",
			parentSessionId: undefined,
			delegationId: "sess_forfeit-1",
			cwd: join(root, "repo"),
			prompt: "",
			options: { resident: true, timeoutMinutes: 10 },
		});
		const forfeited = await service.forfeitResidentSession(started.id);
		// Nothing platform-side outlives the forfeited sandbox: the tunnel
		// registration is deleted, its release is persisted, and the secrets
		// are gone before the forfeit reports success.
		expect(deletedTunnels).toEqual([tunnelRegistration.tunnelId]);
		expect(forfeited).toMatchObject({
			observedLifecycle: "deleted",
			cleanupState: "released",
			tunnelState: "released",
		});
		expect(existsSync(join(root, "state", "tunnel-secrets", `${started.id}.json`))).toBe(false);
		expect(store.get(started.id)?.tunnelState).toBe("released");
		// Idempotent: a repeated forfeit neither throws nor re-deletes.
		await expect(service.forfeitResidentSession(started.id)).resolves.toMatchObject({
			observedLifecycle: "deleted",
			cleanupState: "released",
			tunnelState: "released",
		});
		expect(deletedTunnels).toEqual([tunnelRegistration.tunnelId]);
	});

	it("retries transient 503 workspace uploads on the same sandbox and succeeds (503, 503, success)", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, { sandboxId: "sandbox-upload-1" });
		const original: CloudDelegationWorkspaceTransfer = fakes.commonOptions.workspace!;
		let uploadCalls = 0;
		fakes.commonOptions.workspace = {
			...original,
			upload: async (request) => {
				uploadCalls++;
				if (uploadCalls <= 2) {
					throw new PrimeSandboxError("http", "workspace upload failed with HTTP 503", { status: 503 });
				}
				return original.upload(request);
			},
		};
		fakes.commonOptions.workspaceUploadRetry = { backoffMs: () => 0 };
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await service.delegate({
			activeSessionId: "",
			parentSessionId: undefined,
			delegationId: "sess_upload_retry",
			cwd: join(root, "repo"),
			prompt: "",
			options: { resident: true, timeoutMinutes: 10 },
		});
		expect(started.status).toBe("running");
		// One sandbox allocation covers the whole retried launch, and the
		// registered tunnel stays live for the running session.
		expect(fakes.calls.filter((call) => call.kind === "create")).toHaveLength(1);
		expect(fakes.calls.filter((call) => call.kind === "delete-sandbox")).toHaveLength(0);
		expect(fakes.deletedTunnels).toEqual([]);
		expect(fakes.store.get(started.id)?.tunnelState).toBe("registered");
		expect(fakes.calls.filter((call) => call.kind === "start")).toHaveLength(1);
	});

	it("releases the sandbox, tunnel, and secrets after persistent 503 uploads and marks the record terminal", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, { sandboxId: "sandbox-upload-2" });
		fakes.commonOptions.workspace = {
			...fakes.commonOptions.workspace!,
			upload: async () => {
				throw new PrimeSandboxError("http", "workspace upload failed with HTTP 503", { status: 503 });
			},
		};
		fakes.commonOptions.workspaceUploadRetry = { backoffMs: () => 0 };
		const service = new DirectCloudService(fakes.commonOptions);
		const sessionId = "sess_upload_503";
		await expect(
			service.delegate({
				activeSessionId: "",
				parentSessionId: undefined,
				delegationId: sessionId,
				cwd: join(root, "repo"),
				prompt: "",
				options: { resident: true, timeoutMinutes: 10 },
			}),
		).rejects.toThrow(/503/);
		// The retry is bounded (4 attempts) and never allocates a second sandbox.
		expect(fakes.calls.filter((call) => call.kind === "create")).toHaveLength(1);
		// Nothing leaks: the sandbox and the tunnel registration are released,
		// the tunnel secrets are gone, and the record is terminal.
		expect(fakes.calls.filter((call) => call.kind === "delete-sandbox")).toHaveLength(1);
		expect(fakes.deletedTunnels).toEqual([fakes.tunnelRegistration.tunnelId]);
		expect(existsSync(join(root, "state", "tunnel-secrets", `${sessionId}.json`))).toBe(false);
		const record = fakes.store.get(sessionId)!;
		expect(record).toMatchObject({
			cleanupState: "released",
			observedLifecycle: "deleted",
			desiredLifecycle: "deleted",
			tunnelState: "released",
		});
		expect(record.lastError).toContain("503");
	});

	it("does not retry a 4xx workspace upload failure and releases the provision", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, { sandboxId: "sandbox-upload-3" });
		let uploadCalls = 0;
		fakes.commonOptions.workspace = {
			...fakes.commonOptions.workspace!,
			upload: async () => {
				uploadCalls++;
				throw new PrimeSandboxError("http", "workspace upload rejected with HTTP 403", { status: 403 });
			},
		};
		fakes.commonOptions.workspaceUploadRetry = { backoffMs: () => 0 };
		const service = new DirectCloudService(fakes.commonOptions);
		const sessionId = "sess_upload_403";
		await expect(
			service.delegate({
				activeSessionId: "",
				parentSessionId: undefined,
				delegationId: sessionId,
				cwd: join(root, "repo"),
				prompt: "",
				options: { resident: true, timeoutMinutes: 10 },
			}),
		).rejects.toThrow(/403/);
		// Not transient: exactly one attempt, then the full rollback.
		expect(uploadCalls).toBe(1);
		expect(fakes.calls.filter((call) => call.kind === "create")).toHaveLength(1);
		expect(fakes.calls.filter((call) => call.kind === "delete-sandbox")).toHaveLength(1);
		expect(fakes.deletedTunnels).toEqual([fakes.tunnelRegistration.tunnelId]);
		expect(existsSync(join(root, "state", "tunnel-secrets", `${sessionId}.json`))).toBe(false);
		const record = fakes.store.get(sessionId)!;
		expect(record).toMatchObject({
			cleanupState: "released",
			observedLifecycle: "deleted",
			desiredLifecycle: "deleted",
			tunnelState: "released",
		});
		expect(record.lastError).toContain("403");
	});

	it("steers over a live tunnel and fails clearly without one", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-3",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, "sess_tunnel-3", { timeoutMinutes: 10 });
		await expect(service.steer("active-1", started.id, "more")).rejects.toThrow(/--tunnel/);

		const steered = await delegateWork(fakes, service, "sess_tunnel-4");
		const result = await service.steer("active-1", steered.id, "go deeper");
		expect(result.state).toBe("acknowledged");
		expect(result.delegation.id).toBe(steered.id);
		await service.stop("active-1", steered.id, true);
	});

	it("releases the tunnel registration when the attachment can no longer resolve its target", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const transport = new ScriptedBridgeTransport();
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-6",
			tunnelTransport: transport,
		});
		const { deletedTunnels, store, tunnelRegistration } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, "sess_tunnel-6");
		await until(() => transport.connectionCount === 1);
		expect(transport.connectionCount).toBe(1);
		// The durable secrets vanish while the registration still exists: the
		// attachment goes terminal and must delete the platform registration
		// instead of marking the tunnel released while it stays registered.
		rmSync(join(root, "state", "tunnel-secrets", `${started.id}.json`));
		transport.dropAll();
		await until(() => deletedTunnels.includes(tunnelRegistration.tunnelId));
		expect(deletedTunnels).toEqual([tunnelRegistration.tunnelId]);
		expect(store.get(started.id)?.tunnelState).toBe("released");
		await expect(service.steer("active-1", started.id, "never")).rejects.toThrow(/no live tunnel bridge/);
	});

	it("maps a caller steer identity to stable command and task ids", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-7",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, "sess_tunnel-7");
		// A retried daemon command carries the same identity: the derived
		// command id and request digest must match so the guest journal
		// deduplicates the steer instead of running it twice.
		const first = await service.steer("active-1", started.id, "keep going", "identity-7");
		const retry = await service.steer("active-1", started.id, "keep going", "identity-7");
		expect(retry.commandId).toBe(first.commandId);
		expect(retry.state).toBe(first.state);
		const other = await service.steer("active-1", started.id, "keep going");
		expect(other.commandId).not.toBe(first.commandId);
		await service.stop("active-1", started.id, true);
	});

	it("resumes a crashed tunnel delegation with the persisted tunnel opt-in", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-8",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const { startEnvs, startFailures, deletedTunnels } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		// The resident process dies on the first launch: the delegation call
		// fails, but the record stays in the provisioning state a daemon crash
		// would leave behind.
		startFailures.count = 1;
		await expect(delegateWork(fakes, service, "sess_tunnel-8")).rejects.toThrow(/simulated resident-process crash/);
		expect(deletedTunnels.length).toBeGreaterThan(0);

		// Recovery through list() re-enters the launch with the persisted
		// tunnel opt-in: the bridge must ride the guest env again instead of
		// silently resuming in one-shot mode.
		await service.list("active-1");
		expect(startEnvs).toHaveLength(1);
		const recoveredEnv = startEnvs[0] as Record<string, string>;
		expect(recoveredEnv.PRIME_AGENT_CLOUD_BRIDGE_ENABLED).toBe("1");
		expect(typeof recoveredEnv.PRIME_AGENT_CLOUD_BRIDGE_TOKEN).toBe("string");
		const recovered = await service.steer("active-1", "sess_tunnel-8", "after the crash");
		expect(recovered.state).toBe("acknowledged");
		await service.stop("active-1", "sess_tunnel-8", true);
	});

	it("resumes a legacy v1 guest cursor file and degrades conservatively on malformed or mismatched data", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const transport = new ScriptedBridgeTransport();
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-cursor-v1",
			tunnelTransport: transport,
		});
		const { store } = fakes;
		const sessionId = "sess_cursor_legacy";
		const eventsDirectory = join(root, "state", "events", sessionId);
		const cursorPath = join(eventsDirectory, "tunnel-guest-cursor.json");
		const tracePath = join(eventsDirectory, "outbox-events.ndjson");
		// A durable cursor from before the generation split: the legacy single
		// {generation, sequence} the old attachment persisted, pre-trim.
		mkdirSync(eventsDirectory, { recursive: true });
		writeFileSync(
			cursorPath,
			`${JSON.stringify({ version: 1, generation: 1, sequence: 3 })}
`,
		);

		const service = new DirectCloudService(fakes.commonOptions);
		const started = await delegateWork(fakes, service, sessionId);
		await until(() => transport.connectionCount === 1);
		expect(transport.connectionCount).toBe(1);
		// The legacy position resumed exactly: hello and the subscribe after
		// the snapshot both name sequence 3, not a fresh start.
		await until(() => framesOfType(transport.sentFrames, "hello").length === 1);
		expect(framesOfType(transport.sentFrames, "hello")).toHaveLength(1);
		expect(framesOfType(transport.sentFrames, "hello")[0]?.cursor).toEqual({ generation: 1, sequence: 3 });
		await until(() => framesOfType(transport.sentFrames, "subscribe").length === 1);
		expect(framesOfType(transport.sentFrames, "subscribe")).toHaveLength(1);
		expect(framesOfType(transport.sentFrames, "subscribe")[0]?.cursor).toEqual({
			generation: 1,
			sequence: 3,
		});
		// A bridge that re-serves the whole retained log deduplicates against
		// the resumed position: only events 4 and 5 import; 1-3 never
		// re-import, and the ack names the true import tail.
		transport.push({
			type: "events",
			sessionId,
			generation: 1,
			events: [guestEvent(1), guestEvent(2), guestEvent(3), guestEvent(4), guestEvent(5)],
		});
		await until(() => framesOfType(transport.sentFrames, "ack").length === 1);
		expect(framesOfType(transport.sentFrames, "ack")).toHaveLength(1);
		expect(framesOfType(transport.sentFrames, "ack")[0]?.cursor).toEqual({ generation: 1, sequence: 5 });
		expect(tracedTexts(tracePath)).toEqual(["evt-4", "evt-5"]);
		// The rewrite is durable in the split-generation format.
		expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toEqual({
			version: 2,
			sandboxGeneration: 1,
			eventGeneration: 1,
			sequence: 5,
		});

		// Malformed legacy data degrades conservatively: the reconnect reports
		// the corruption honestly and assumes no position - no hello at all.
		writeFileSync(cursorPath, `${JSON.stringify({ version: 1, generation: 0, sequence: 2 })}\n`);
		const framesBeforeDrop = transport.sentFrames.length;
		transport.dropAll();
		await until(() => store.get(sessionId)?.lastError?.includes("tunnel guest cursor file is corrupt") === true);
		expect(store.get(sessionId)?.lastError).toContain("tunnel guest cursor file is corrupt");
		// The attachment is terminal: a bounded turn drain proves the loop
		// sends nothing further instead of racing a reconnect.
		for (let turn = 0; turn < 5; turn++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(transport.sentFrames.length).toBe(framesBeforeDrop);

		// Mismatched legacy data (an epoch this sandbox never had) is
		// discarded by a fresh supervisor: it resumes from zero instead of
		// trusting the stale position, so the re-served head re-imports.
		writeFileSync(cursorPath, `${JSON.stringify({ version: 1, generation: 7, sequence: 9 })}\n`);
		const restartTransport = new ScriptedBridgeTransport();
		fakes.commonOptions.tunnelTransport = restartTransport;
		const restarted = new DirectCloudService(fakes.commonOptions);
		await restarted.list("active-1");
		await until(() => framesOfType(restartTransport.sentFrames, "hello").length === 1);
		expect(framesOfType(restartTransport.sentFrames, "hello")).toHaveLength(1);
		expect(framesOfType(restartTransport.sentFrames, "hello")[0]?.cursor).toBeUndefined();
		await until(() => framesOfType(restartTransport.sentFrames, "subscribe").length === 1);
		expect(framesOfType(restartTransport.sentFrames, "subscribe")).toHaveLength(1);
		expect(framesOfType(restartTransport.sentFrames, "subscribe")[0]?.cursor).toEqual({
			generation: 1,
			sequence: 0,
		});
		// The discarded legacy position was never adopted or persisted: the
		// file still holds the mismatched legacy content until a real import
		// rewrites it.
		expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toEqual({
			version: 1,
			generation: 7,
			sequence: 9,
		});
		restartTransport.push({
			type: "events",
			sessionId,
			generation: 1,
			events: [guestEvent(1), guestEvent(2)],
		});
		await until(() => framesOfType(restartTransport.sentFrames, "ack").length === 1);
		expect(framesOfType(restartTransport.sentFrames, "ack")).toHaveLength(1);
		expect(framesOfType(restartTransport.sentFrames, "ack")[0]?.cursor).toEqual({
			generation: 1,
			sequence: 2,
		});
		expect(tracedTexts(tracePath)).toEqual(["evt-4", "evt-5", "evt-1", "evt-2"]);
		// The fresh supervisor persisted its own position in the split format.
		expect(JSON.parse(readFileSync(cursorPath, "utf8"))).toEqual({
			version: 2,
			sandboxGeneration: 1,
			eventGeneration: 1,
			sequence: 2,
		});
		await service.stop("active-1", started.id, true).catch(() => undefined);
		await restarted.stop("active-1", started.id, true).catch(() => undefined);
	});

	it("passes the resolved inference billing team to the guest as PRIME_TEAM_ID", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, { sandboxId: "sandbox-team-1", teamId: "team_compute" });
		const { startEnvs } = fakes;
		const service = new DirectCloudService(fakes.commonOptions);
		await delegateWork(fakes, service, "sess_team-guest-1", { timeoutMinutes: 10 });
		// Without a dedicated override the guest bills the delegation team.
		expect(startEnvs[0]?.PRIME_TEAM_ID).toBe("team_compute");

		process.env.PRIME_AGENT_CLOUD_INFERENCE_TEAM_ID = "team_inference_only";
		try {
			const root2 = cloudTemp("direct-cloud-service-test-");
			const fakes2 = recordingDelegationStack(root2, { sandboxId: "sandbox-team-2", teamId: "team_compute" });
			const { startEnvs: envs2 } = fakes2;
			const service2 = new DirectCloudService(fakes2.commonOptions);
			await delegateWork(fakes2, service2, "sess_team-guest-2", { timeoutMinutes: 10 });
			expect(envs2[0]?.PRIME_TEAM_ID).toBe("team_inference_only");
		} finally {
			delete process.env.PRIME_AGENT_CLOUD_INFERENCE_TEAM_ID;
		}
		expect(cloudInferenceTeamOverride({ PRIME_AGENT_CLOUD_INFERENCE_TEAM_ID: " direct-team " })).toBe("direct-team");
		expect(cloudInferenceTeamOverride({})).toBeUndefined();
		await service.stop("active-1", "sess_team-guest-1", true);
	});

	it("resolves the cloud team override without touching the global CLI team", async () => {
		const root = cloudTemp("direct-cloud-service-test-");
		const fakes = recordingDelegationStack(root, {
			sandboxId: "sandbox-tunnel-5",
			teamId: "team_options",
			tunnelTransport: new ScriptedBridgeTransport(),
		});
		const { calls } = fakes;
		process.env.PRIME_AGENT_CLOUD_TEAM_ID = "team_env";
		try {
			const service = new DirectCloudService(fakes.commonOptions);
			await delegateWork(fakes, service, "sess_tunnel-5");
			expect(calls.find((call) => call.kind === "register-tunnel")?.detail).toBe("team_options");
			expect(cloudTeamOverride({ PRIME_AGENT_CLOUD_TEAM_ID: "team_env" })).toBe("team_env");
			expect(cloudTeamOverride({})).toBeUndefined();
		} finally {
			delete process.env.PRIME_AGENT_CLOUD_TEAM_ID;
		}
	});
});

describe("cloud inference credential resolution", () => {
	function keyFileTemp(): string {
		return cloudTemp("cloud-key-file-test-");
	}

	it("prefers the explicit env override and reports precise problems for insecure key files", () => {
		const home = keyFileTemp();
		const keyFile = cloudInferenceKeyFilePath({}, home);
		mkdirSync(dirname(keyFile), { recursive: true });
		writeFileSync(keyFile, "file-key-0123456789abcdef\n", { mode: 0o600 });
		expect(resolveCloudInferenceCredential({ PRIME_AGENT_CLOUD_INFERENCE_API_KEY: " env-key " }, home)).toEqual({
			credential: "env-key",
		});
		expect(resolveCloudInferenceCredential({}, home)).toEqual({ credential: "file-key-0123456789abcdef" });
		expect(resolveCloudInferenceCredential({ PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE: keyFile }, home)).toEqual({
			credential: "file-key-0123456789abcdef",
		});
		chmodSync(keyFile, 0o644);
		expect(resolveCloudInferenceCredential({}, home)?.problem).toContain("readable only by its owner");
		chmodSync(keyFile, 0o600);
		const link = join(home, "link.txt");
		symlinkSync(keyFile, link);
		expect(
			resolveCloudInferenceCredential({ PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE: link }, home)?.problem,
		).toContain("regular file");
		expect(
			resolveCloudInferenceCredential({ PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE: "relative/key" }, home)?.problem,
		).toContain("absolute");
		writeFileSync(keyFile, "multi\nline\n", { mode: 0o600 });
		expect(resolveCloudInferenceCredential({}, home)?.problem).toContain("single-line");
		expect(resolveCloudInferenceCredential({}, keyFileTemp())?.problem).toContain("no cloud inference credential");
	});

	it("gates the cloud capability on the image plus either credential source", () => {
		const home = keyFileTemp();
		const keyFile = join(home, ".config", "prime-agent-cloud", "inference-api-key");
		mkdirSync(dirname(keyFile), { recursive: true });
		expect(isDirectCloudConfigured({ PRIME_AGENT_CLOUD_IMAGE: "image" }, home)).toBe(false);
		writeFileSync(keyFile, "file-key\n", { mode: 0o600 });
		expect(isDirectCloudConfigured({ PRIME_AGENT_CLOUD_IMAGE: "image" }, home)).toBe(true);
		chmodSync(keyFile, 0o666);
		expect(isDirectCloudConfigured({ PRIME_AGENT_CLOUD_IMAGE: "image" }, home)).toBe(false);
		expect(cloudInferenceKeyFilePath({}, home)).toBe(keyFile);
		expect(cloudInferenceKeyFilePath({ PRIME_AGENT_CLOUD_INFERENCE_API_KEY_FILE: "/abs/key" }, home)).toBe(
			"/abs/key",
		);
	});
});
