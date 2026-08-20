import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import type { KernelContainerIsolationOptions } from "../src/core/kernel/isolation.js";
import { manifestPathIn, snapshotPathIn } from "../src/core/kernel/state-snapshot.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

const execFileAsync = promisify(execFile);
const DOCKER_IMAGE = process.env.PRIME_AGENT_KERNEL_TEST_IMAGE ?? "prime-agent-rl-forex-q25-kernel:v23";

interface DockerMount {
	readonly Destination: string;
	readonly RW: boolean;
	readonly Source: string;
	readonly Type: string;
}

interface DockerInspection {
	readonly Config: {
		readonly Cmd: readonly string[];
		readonly Labels: Readonly<Record<string, string>>;
		readonly User: string;
	};
	readonly Mounts: readonly DockerMount[];
	readonly HostConfig: {
		readonly ReadonlyRootfs: boolean;
		readonly NetworkMode: string;
		readonly CapDrop: readonly string[] | null;
		readonly CapAdd: readonly string[] | null;
		readonly SecurityOpt: readonly string[] | null;
		readonly PortBindings: Readonly<
			Record<string, readonly { readonly HostIp: string; readonly HostPort: string }[]>
		>;
		readonly Tmpfs: Readonly<Record<string, string>>;
	};
	readonly State: { readonly Running: boolean; readonly Status: string };
}

let root = "";
let sharedTempPath = "";

async function dockerAvailable(): Promise<boolean> {
	try {
		await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"]);
		await execFileAsync("docker", ["image", "inspect", DOCKER_IMAGE]);
		return true;
	} catch {
		return false;
	}
}

async function requireDocker(): Promise<void> {
	if (!(await dockerAvailable())) throw new Error("Docker and PRIME_AGENT_KERNEL_TEST_IMAGE are required");
}

async function inspectOwnedContainer(ownerIdentity: string): Promise<{ id: string; inspection: DockerInspection }> {
	const { stdout } = await execFileAsync("docker", [
		"ps",
		"--all",
		"--filter",
		`label=prime-agent.kernel-owner=${ownerIdentity}`,
		"--format",
		"{{.ID}}",
	]);
	const id = stdout.trim().split("\n").filter(Boolean)[0];
	if (!id) throw new Error(`container for ${ownerIdentity} was not found`);
	const inspected = await execFileAsync("docker", ["inspect", id]);
	const inspection = JSON.parse(inspected.stdout) as readonly [DockerInspection];
	return { id, inspection: inspection[0]! };
}

describe("KernelManager physical isolation", () => {
	afterEach(async () => {
		if (sharedTempPath) {
			await rm(sharedTempPath, { force: true });
			sharedTempPath = "";
		}
		if (root) {
			await rm(root, { recursive: true, force: true });
			root = "";
		}
	});

	it("keeps causal input readable while denying host authority, raw network, and stale container publication", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-"));
		const workspace = join(root, "workspace");
		const output = join(root, "output");
		const runRoot = join(root, "run-root");
		const keyring = join(root, "keyring");
		const journal = join(root, "journal");
		const causalInput = join(workspace, "causal-input.txt");
		const authoritySecret = join(runRoot, "authority.json");
		const keyringSecret = join(keyring, "journal.key");
		const sharedTempSecret = join(tmpdir(), `prime-agent-shared-temp-${process.pid}`);
		sharedTempPath = sharedTempSecret;
		await Promise.all([
			mkdir(workspace, { recursive: true }),
			mkdir(output, { recursive: true }),
			mkdir(runRoot, { recursive: true }),
			mkdir(keyring, { recursive: true }),
			mkdir(journal, { recursive: true }),
		]);
		await Promise.all([
			writeFile(causalInput, "causal-input-ok\n"),
			writeFile(authoritySecret, "host-authority-secret\n"),
			writeFile(keyringSecret, "host-keyring-secret\n"),
			writeFile(sharedTempSecret, "shared-temp-secret\n"),
		]);
		const workspaceSource = await realpath(workspace);
		const outputSource = await realpath(output);

		const ownerIdentity = `kernel-isolation-${process.pid}-${Date.now()}`;
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const sessionPathSource = await realpath(sessionPath);
		const provisioner = new IpythonKernelProvisioner(workspace, {
			snapshotDir: output,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [runRoot, keyring, journal, sharedTempSecret, output],
				sessionId: `session-${process.pid}`,
				sessionPath,
				workflowId: "workflow-isolation",
				taskId: "task-isolation",
				attemptId: "attempt-isolation",
				executionKey: "execution-isolation",
			},
		});

		let containerId = "";
		try {
			const manager = await provisioner.ensure();
			const control = await manager.execute(
				"from pathlib import Path; print(Path('causal-input.txt').read_text().strip())",
			);
			expect(control.status).toBe("ok");
			expect(control.stdout.trim()).toBe("causal-input-ok");
			expect(await manager.snapshotState()).not.toBeNull();

			const owned = await inspectOwnedContainer(ownerIdentity);
			containerId = owned.id;
			expect(owned.inspection.State.Running).toBe(true);
			expect(owned.inspection.Config.Labels["prime-agent.kernel-owner"]).toBe(ownerIdentity);
			expect(owned.inspection.Config.Cmd).toEqual([
				"python",
				"-m",
				"ipykernel_launcher",
				"-f",
				"/prime-agent/kernel/connection.container.json",
			]);
			expect(owned.inspection.Config.Labels["prime-agent.kernel-session-id"]).toBe(`session-${process.pid}`);
			expect(owned.inspection.Config.Labels["prime-agent.kernel-session-path"]).toBe(sessionPathSource);
			expect(owned.inspection.Config.Labels["prime-agent.kernel-workflow-id"]).toBe("workflow-isolation");
			expect(owned.inspection.Config.Labels["prime-agent.kernel-task-id"]).toBe("task-isolation");
			expect(owned.inspection.Config.Labels["prime-agent.kernel-attempt-id"]).toBe("attempt-isolation");
			expect(owned.inspection.Config.Labels["prime-agent.kernel-execution-key"]).toBe("execution-isolation");
			expect(owned.inspection.Config.Labels["prime-agent.kernel-mount-policy"]).toBe("isolated-v1");
			expect(owned.inspection.Config.Labels["prime-agent.kernel-network-policy"]).toBe("deny");
			expect(owned.inspection.HostConfig.ReadonlyRootfs).toBe(true);
			expect(owned.inspection.HostConfig.NetworkMode).toBe("bridge");
			expect(owned.inspection.HostConfig.CapDrop).toEqual(["ALL"]);
			expect(owned.inspection.HostConfig.CapAdd).toEqual([
				"CAP_NET_ADMIN",
				"CAP_SETGID",
				"CAP_SETPCAP",
				"CAP_SETUID",
			]);
			expect(owned.inspection.HostConfig.SecurityOpt).toContain("no-new-privileges");
			expect(Object.keys(owned.inspection.HostConfig.PortBindings)).toHaveLength(5);
			for (const bindings of Object.values(owned.inspection.HostConfig.PortBindings)) {
				expect(bindings).toHaveLength(1);
				expect(bindings[0]).toMatchObject({ HostIp: "127.0.0.1" });
			}
			expect(owned.inspection.HostConfig.Tmpfs["/tmp"]).toContain("size=256m");

			const bindMounts = owned.inspection.Mounts.filter((mount) => mount.Type === "bind");
			expect(bindMounts).toHaveLength(3);
			const workspaceMount = bindMounts.find((mount) => mount.Source === workspaceSource);
			expect(workspaceMount).toMatchObject({ Destination: workspaceSource, RW: false });
			const scratchMount = bindMounts.find((mount) => mount.RW);
			expect(scratchMount).toMatchObject({ RW: true });
			expect(scratchMount?.Source).toMatch(/prime-agent-kernel-output-/);
			expect(scratchMount?.Source).not.toBe(outputSource);
			for (const mount of bindMounts) {
				if (mount !== scratchMount) expect(mount.RW).toBe(false);
				expect(mount.Source).not.toBe(runRoot);
				expect(mount.Source).not.toBe(keyring);
				expect(mount.Source).not.toBe(journal);
				expect(mount.Source).not.toBe(sharedTempSecret);
			}

			const probe = await manager.execute(`
import json
import os
import socket
import subprocess
from pathlib import Path

def path_state(path):
    candidate = Path(path)
    try:
        list(candidate.parent.iterdir())
        listable = True
    except OSError:
        listable = False
    return {"exists": candidate.exists(), "listable": listable, "readable": os.access(candidate, os.R_OK), "writable": os.access(candidate, os.W_OK)}

def denied(operation):
    try:
        value = operation()
        return {"denied": False, "bytes": len(value) if isinstance(value, bytes) else 1}
    except Exception as error:
        return {"denied": True, "error": type(error).__name__, "bytes": 0}

network = {
    "httpx": denied(lambda: __import__("httpx").get("https://example.com", timeout=2).content[:1]),
    "socket": denied(lambda: socket.create_connection(("1.1.1.1", 443), timeout=2)),
}
workspace_write = denied(lambda: Path("causal-input.txt").write_text("must-fail"))
curl = subprocess.run(["curl", "--silent", "--show-error", "--max-time", "2", "https://example.com"], capture_output=True, check=False)
network["curl"] = {"denied": curl.returncode != 0, "bytes": len(curl.stdout)}
print(json.dumps({
    "authority": path_state(${JSON.stringify(authoritySecret)}),
    "keyring": path_state(${JSON.stringify(keyringSecret)}),
    "shared_temp": path_state(${JSON.stringify(sharedTempSecret)}),
    "network": network,
    "workspace_write": workspace_write,
    "capabilities": [line.strip() for line in Path("/proc/self/status").read_text().splitlines() if line.startswith("Cap")],
    "uid": os.getuid(),
}, sort_keys=True))
`);
			expect(probe.status).toBe("ok");
			const observed = JSON.parse(probe.stdout.trim()) as {
				readonly authority: {
					readonly exists: boolean;
					readonly listable: boolean;
					readonly readable: boolean;
					readonly writable: boolean;
				};
				readonly keyring: {
					readonly exists: boolean;
					readonly listable: boolean;
					readonly readable: boolean;
					readonly writable: boolean;
				};
				readonly shared_temp: {
					readonly exists: boolean;
					readonly listable: boolean;
					readonly readable: boolean;
					readonly writable: boolean;
				};
				readonly network: Readonly<Record<string, { readonly denied: boolean; readonly bytes: number }>>;
				readonly workspace_write: { readonly denied: boolean; readonly bytes: number };
				readonly capabilities: readonly string[];
				readonly uid: number;
			};
			for (const state of [observed.authority, observed.keyring, observed.shared_temp]) {
				expect(state).toEqual({ exists: false, listable: false, readable: false, writable: false });
			}
			expect(observed.uid).toBe(process.getuid?.() ?? 0);
			expect(observed.capabilities.every((line) => line.endsWith("0000000000000000"))).toBe(true);
			for (const [name, state] of Object.entries(observed.network)) {
				expect(state.denied, `${name} was not denied`).toBe(true);
				expect(state.bytes, `${name} produced network output`).toBe(0);
			}
			expect(observed.workspace_write.denied).toBe(true);

			const streamedOutput: string[] = [];
			const execution = manager.execute(
				"import time; print('cell-reached-before-kill', flush=True); time.sleep(30)",
				{
					onStream: (chunk) => streamedOutput.push(chunk),
				},
			);
			const executionOutcome = execution.then(
				() => undefined,
				(error: unknown) => error,
			);
			await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
			await execFileAsync("docker", ["kill", containerId]);
			await expect(execFileAsync("docker", ["inspect", containerId])).rejects.toThrow();
			const executionError = await executionOutcome;
			expect(executionError).toBeInstanceOf(Error);
			expect((executionError as Error).message).toMatch(/shut down|channel|closed/i);
			expect(streamedOutput.join("")).toContain("cell-reached-before-kill");
		} finally {
			await provisioner.kill();
		}

		await expect(execFileAsync("docker", ["inspect", containerId])).rejects.toThrow();
		await expect(readFile(snapshotPathIn(output))).resolves.toBeTruthy();
		await expect(readFile(manifestPathIn(output))).resolves.toBeTruthy();
		await rm(sharedTempSecret, { force: true });
	});

	it("allocates a unique private writable scratch outside protected session authority", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-scratch-"));
		const workspace = join(root, "workspace");
		const artifactRoot = join(root, "artifacts");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(artifactRoot, { recursive: true, mode: 0o700 })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const ownerIdentity = `kernel-scratch-${process.pid}-${Date.now()}`;
		const provisioner = new IpythonKernelProvisioner(workspace, {
			snapshotDir: artifactRoot,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [artifactRoot],
				sessionId: `session-${process.pid}`,
				sessionPath,
				workflowId: "workflow-scratch",
				taskId: "task-scratch",
				attemptId: "attempt-scratch",
				executionKey: "execution-scratch",
			},
		});

		try {
			const manager = await provisioner.ensure();
			const owned = await inspectOwnedContainer(ownerIdentity);
			const writableMounts = owned.inspection.Mounts.filter((mount) => mount.Type === "bind" && mount.RW);
			expect(writableMounts).toHaveLength(1);
			const scratch = writableMounts[0]!.Source;
			expect(relative(root, scratch)).toMatch(/^\.\./);
			expect(scratch).toMatch(/prime-agent-kernel-output-/);
			expect((await stat(scratch)).mode & 0o777).toBe(0o700);
			expect(await manager.execute("print('scratch-ready')")).toMatchObject({ status: "ok" });
		} finally {
			await provisioner.kill();
		}

		await expect(
			execFileAsync("docker", [
				"ps",
				"--all",
				"--filter",
				`label=prime-agent.kernel-owner=${ownerIdentity}`,
				"--format",
				"{{.ID}}",
			]),
		).resolves.toMatchObject({ stdout: "" });
	});

	it("retains the created container identity when docker create fails before manager assignment", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-create-failure-"));
		const workspace = join(root, "workspace");
		const output = join(root, "output");
		const authority = join(root, "authority");
		await Promise.all([
			mkdir(workspace, { recursive: true }),
			mkdir(output, { recursive: true }),
			mkdir(authority, { recursive: true }),
		]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const dockerBinary = (await execFileAsync("which", ["docker"])).stdout.trim();
		const markerPath = join(root, "created-container-id");
		const wrapperPath = join(root, "docker-wrapper");
		await writeFile(
			wrapperPath,
			`#!/bin/sh
if [ "$1" = "create" ]; then
  id=$("${dockerBinary}" "$@") || exit $?
  printf '%s' "$id" > "${markerPath}"
  printf '%s\n' 'simulated docker create transport failure' >&2
  exit 42
fi
exec "${dockerBinary}" "$@"
`,
			{ mode: 0o755 },
		);
		await chmod(wrapperPath, 0o755);
		const ownerIdentity = `kernel-create-failure-${process.pid}-${Date.now()}`;
		const manager = new KernelManager({
			cwd: workspace,
			snapshot: {
				path: join(output, "snapshot.pkl"),
				manifestPath: join(output, "snapshot.json"),
				artifactRoot: output,
			},
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [authority],
				sessionId: "session-create-failure",
				sessionPath,
				workflowId: "workflow-create-failure",
				taskId: "task-create-failure",
				attemptId: "attempt-create-failure",
				executionKey: "execution-create-failure",
				dockerBinary: wrapperPath,
			},
		});
		let createdId = "";
		try {
			const error = await manager.start().catch((value: unknown) => value);
			createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			if (!createdId)
				throw new Error(
					`docker create wrapper did not record an id: ${error instanceof Error ? error.message : String(error)}`,
				);
			expect(error).toBeInstanceOf(Error);
			expect(error).toMatchObject({ containerId: createdId });
			expect(createdId).toMatch(/^[0-9a-f]{12,64}$/);
		} finally {
			await manager.kill().catch(() => {});
			if (!createdId) createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			if (createdId) await execFileAsync(dockerBinary, ["rm", "--force", createdId]).catch(() => {});
		}
		await expect(execFileAsync(dockerBinary, ["inspect", createdId])).rejects.toThrow();
	});

	it("propagates a typed owner lookup fence failure instead of abandoning an orphan", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-owner-lookup-"));
		const workspace = join(root, "workspace");
		const authority = join(root, "authority");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(authority, { recursive: true })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const dockerBinary = (await execFileAsync("which", ["docker"])).stdout.trim();
		const markerPath = join(root, "created-container-id");
		const wrapperPath = join(root, "docker-owner-lookup-failure");
		await writeFile(
			wrapperPath,
			`#!/bin/sh
if [ "$1" = "create" ]; then
  id=$("${dockerBinary}" "$@") || exit $?
  printf '%s' "$id" > "${markerPath}"
  exit 42
fi
if [ "$1" = "ps" ]; then
  printf '%s\n' 'owner lookup failed' >&2
  exit 43
fi
exec "${dockerBinary}" "$@"
`,
			{ mode: 0o755 },
		);
		await chmod(wrapperPath, 0o755);
		const ownerIdentity = `kernel-owner-lookup-${process.pid}-${Date.now()}`;
		const manager = new KernelManager({
			cwd: workspace,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [authority],
				sessionId: "session-owner-lookup",
				sessionPath,
				workflowId: "workflow-owner-lookup",
				taskId: "task-owner-lookup",
				attemptId: "attempt-owner-lookup",
				executionKey: "execution-owner-lookup",
				dockerBinary: wrapperPath,
			},
		});
		let createdId = "";
		try {
			const error = await manager.start().catch((value: unknown) => value);
			createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			expect(error).toMatchObject({ code: "KERNEL_CONTAINER_CLEANUP_FAILED", ownerIdentity });
		} finally {
			if (!createdId) createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			if (createdId) await execFileAsync(dockerBinary, ["rm", "--force", createdId]).catch(() => {});
		}
	});

	it("reconciles every duplicate owner container before reporting a typed fence failure", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-owner-duplicates-"));
		const workspace = join(root, "workspace");
		const authority = join(root, "authority");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(authority, { recursive: true })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const dockerBinary = (await execFileAsync("which", ["docker"])).stdout.trim();
		const markerPath = join(root, "created-container-ids");
		const wrapperPath = join(root, "docker-owner-duplicates");
		await writeFile(
			wrapperPath,
			`#!/bin/sh
if [ "$1" = "create" ]; then
  first=$("${dockerBinary}" "$@") || exit $?
  second=$("${dockerBinary}" "$@") || exit $?
  printf '%s\n%s\n' "$first" "$second" > "${markerPath}"
  exit 42
fi
if [ "$1" = "ps" ]; then
  cat "${markerPath}"
  exit 0
fi
exec "${dockerBinary}" "$@"
`,
			{ mode: 0o755 },
		);
		await chmod(wrapperPath, 0o755);
		const ownerIdentity = `kernel-owner-duplicates-${process.pid}-${Date.now()}`;
		const manager = new KernelManager({
			cwd: workspace,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [authority],
				sessionId: "session-owner-duplicates",
				sessionPath,
				workflowId: "workflow-owner-duplicates",
				taskId: "task-owner-duplicates",
				attemptId: "attempt-owner-duplicates",
				executionKey: "execution-owner-duplicates",
				dockerBinary: wrapperPath,
			},
		});
		let createdIds: string[] = [];
		try {
			const error = await manager.start().catch((value: unknown) => value);
			createdIds = (await readFile(markerPath, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
			expect(error).toMatchObject({
				code: "KERNEL_CONTAINER_CLEANUP_FAILED",
				ownerIdentity,
				containerIds: createdIds,
			});
			for (const id of createdIds) await expect(execFileAsync(dockerBinary, ["inspect", id])).rejects.toThrow();
		} finally {
			for (const id of createdIds) await execFileAsync(dockerBinary, ["rm", "--force", id]).catch(() => {});
		}
	});

	it("retains owner-reconciled container identity when create cleanup fails before manager assignment", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-owner-cleanup-retry-"));
		const workspace = join(root, "workspace");
		const authority = join(root, "authority");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(authority, { recursive: true })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const dockerBinary = (await execFileAsync("which", ["docker"])).stdout.trim();
		const markerPath = join(root, "created-container-id");
		const wrapperPath = join(root, "docker-owner-cleanup-retry");
		const writeWrapper = async (failRm: boolean): Promise<void> => {
			await writeFile(
				wrapperPath,
				`#!/bin/sh
if [ "$1" = "create" ]; then
  id=$("${dockerBinary}" "$@") || exit $?
  printf '%s' "$id" > "${markerPath}"
  exit 42
fi
${failRm ? `if [ "$1" = "rm" ]; then exit 42; fi` : ""}
exec "${dockerBinary}" "$@"
`,
				{ mode: 0o755 },
			);
			await chmod(wrapperPath, 0o755);
		};
		await writeWrapper(true);
		const ownerIdentity = `kernel-owner-cleanup-retry-${process.pid}-${Date.now()}`;
		const manager = new KernelManager({
			cwd: workspace,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [authority],
				sessionId: "session-owner-cleanup-retry",
				sessionPath,
				workflowId: "workflow-owner-cleanup-retry",
				taskId: "task-owner-cleanup-retry",
				attemptId: "attempt-owner-cleanup-retry",
				executionKey: "execution-owner-cleanup-retry",
				dockerBinary: wrapperPath,
			},
		});
		let createdId = "";
		try {
			const error = await manager.start().catch((value: unknown) => value);
			createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			expect(error).toMatchObject({
				code: "KERNEL_CONTAINER_CLEANUP_FAILED",
				containerIds: [createdId],
			});
			await expect(execFileAsync(dockerBinary, ["inspect", createdId])).resolves.toBeTruthy();
			await writeWrapper(false);
			await manager.kill();
			await expect(execFileAsync(dockerBinary, ["inspect", createdId])).rejects.toThrow();
		} finally {
			if (!createdId) createdId = (await readFile(markerPath, "utf8").catch(() => "")).trim();
			if (createdId) await execFileAsync(dockerBinary, ["rm", "--force", createdId]).catch(() => {});
		}
	});

	it("retains scratch after an unverified container death and commits only after a later fence proof", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-fence-"));
		const workspace = join(root, "workspace");
		const artifactRoot = join(root, "artifacts");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(artifactRoot, { recursive: true, mode: 0o700 })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const dockerBinary = (await execFileAsync("which", ["docker"])).stdout.trim();
		const wrapperPath = join(root, "docker-cleanup-failure");
		const writeWrapper = async (failRm: boolean): Promise<void> => {
			await writeFile(
				wrapperPath,
				`#!/bin/sh
if [ "$1" = "create" ]; then
  args=""
  for arg in "$@"; do
    if [ "$arg" != "--rm" ]; then args="$args '$arg'"; fi
  done
  eval "${dockerBinary} $args"
  exit $?
fi
${failRm ? `if [ "$1" = "rm" ]; then exit 42; fi` : ""}
exec "${dockerBinary}" "$@"
`,
				{ mode: 0o755 },
			);
			await chmod(wrapperPath, 0o755);
		};
		await writeWrapper(true);
		const ownerIdentity = `kernel-fence-${process.pid}-${Date.now()}`;
		const provisioner = new IpythonKernelProvisioner(workspace, {
			snapshotDir: artifactRoot,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [artifactRoot],
				sessionId: "session-fence",
				sessionPath,
				workflowId: "workflow-fence",
				taskId: "task-fence",
				attemptId: "attempt-fence",
				executionKey: "execution-fence",
				dockerBinary: wrapperPath,
			},
		});
		let scratch = "";
		try {
			await provisioner.ensure();
			const owned = await inspectOwnedContainer(ownerIdentity);
			scratch = owned.inspection.Mounts.find((mount) => mount.Type === "bind" && mount.RW)?.Source ?? "";
			expect(scratch).toMatch(/prime-agent-kernel-output-/);
			await expect(provisioner.kill()).rejects.toMatchObject({ code: "KERNEL_CONTAINER_CLEANUP_FAILED" });
			await expect(stat(scratch)).resolves.toBeTruthy();
			await writeWrapper(false);
			await provisioner.kill();
			await expect(stat(scratch)).rejects.toThrow();
		} finally {
			await provisioner.kill().catch(() => {});
		}
	});

	it("stages durable snapshots into scratch and commits them only after isolated death", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-snapshot-continuity-"));
		const workspace = join(root, "workspace");
		const artifactRoot = join(root, "artifacts");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(artifactRoot, { recursive: true, mode: 0o700 })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const makeProvisioner = (ownerIdentity: string): IpythonKernelProvisioner =>
			new IpythonKernelProvisioner(workspace, {
				snapshotDir: artifactRoot,
				isolation: {
					type: "docker",
					image: DOCKER_IMAGE,
					ownerIdentity,
					protectedPaths: [artifactRoot],
					sessionId: "session-snapshot-continuity",
					sessionPath,
					workflowId: "workflow-snapshot-continuity",
					taskId: "task-snapshot-continuity",
					attemptId: "attempt-snapshot-continuity",
					executionKey: `execution-${ownerIdentity}`,
				},
			});
		const first = makeProvisioner(`kernel-snapshot-first-${process.pid}-${Date.now()}`);
		await first.ensure().then((manager) => manager.execute("persisted_value = 'durable-state'"));
		const firstManager = first.manager;
		if (!firstManager) throw new Error("first isolated manager missing");
		await expect(firstManager.snapshotState()).resolves.not.toBeNull();
		await first.kill();
		await expect(readFile(snapshotPathIn(artifactRoot))).resolves.toBeTruthy();
		await expect(readFile(manifestPathIn(artifactRoot))).resolves.toBeTruthy();

		const second = makeProvisioner(`kernel-snapshot-second-${process.pid}-${Date.now()}`);
		try {
			const result = await (await second.ensure()).execute("print(persisted_value)");
			expect(result.stdout.trim()).toBe("durable-state");
		} finally {
			await second.kill();
		}
	});

	it("rejects a workspace overlapping protected host authority before container start", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-preflight-"));
		const runRoot = join(root, "run-root");
		const unsafeWorkspace = join(runRoot, "workspace");
		await mkdir(unsafeWorkspace, { recursive: true });
		const ownerIdentity = `kernel-isolation-preflight-${process.pid}-${Date.now()}`;
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const manager = new KernelManager({
			cwd: unsafeWorkspace,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity,
				protectedPaths: [runRoot],
				sessionId: "session-preflight",
				sessionPath,
				workflowId: "workflow-preflight",
				taskId: "task-preflight",
				attemptId: "attempt-preflight",
				executionKey: "execution-preflight",
			},
		});

		await expect(manager.start()).rejects.toThrow(/protected|workspace/i);
		const { stdout } = await execFileAsync("docker", [
			"ps",
			"--all",
			"--filter",
			`label=prime-agent.kernel-owner=${ownerIdentity}`,
			"--format",
			"{{.ID}}",
		]);
		expect(stdout.trim()).toBe("");
	});

	it("rejects writable output capabilities nested below protected authority", async () => {
		await requireDocker();

		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-output-"));
		const workspace = join(root, "workspace");
		const authority = join(root, "authority");
		const output = join(authority, "output");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(output, { recursive: true })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const manager = new KernelManager({
			cwd: workspace,
			snapshot: {
				path: join(output, "snapshot.pkl"),
				manifestPath: join(output, "snapshot.json"),
				artifactRoot: output,
			},
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity: `kernel-isolation-output-${process.pid}-${Date.now()}`,
				protectedPaths: [authority],
				sessionId: "session-output",
				sessionPath,
				workflowId: "workflow-output",
				taskId: "task-output",
				attemptId: "attempt-output",
				executionKey: "execution-output",
			},
		});

		try {
			await expect(manager.start()).rejects.toThrow(/protected|authority|output/i);
		} finally {
			await manager.kill();
		}
	});

	it("rejects isolated snapshots without an explicit artifact capability root", async () => {
		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-snapshot-"));
		const workspace = join(root, "workspace");
		const output = join(root, "output");
		await Promise.all([mkdir(workspace, { recursive: true }), mkdir(output, { recursive: true })]);
		const sessionPath = join(root, "session.jsonl");
		await writeFile(sessionPath, "session\n");
		const manager = new KernelManager({
			cwd: workspace,
			snapshot: {
				path: join(output, "snapshot.pkl"),
				manifestPath: join(output, "snapshot.json"),
			},
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity: `kernel-isolation-snapshot-${process.pid}-${Date.now()}`,
				protectedPaths: [join(root, "authority")],
				sessionId: "session-snapshot",
				sessionPath,
				workflowId: "workflow-snapshot",
				taskId: "task-snapshot",
				attemptId: "attempt-snapshot",
				executionKey: "execution-snapshot",
			},
		});
		await mkdir(join(root, "authority"), { recursive: true });

		try {
			await expect(manager.start()).rejects.toThrow(/explicit artifact capability root/i);
		} finally {
			await manager.kill();
		}
	});

	it("requires protected authority paths and rejects broad or shared roots before dispatch", async () => {
		await requireDocker();
		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-preflight-"));
		const owner = (label: string) => `kernel-isolation-${label}-${process.pid}-${Date.now()}`;
		const base = {
			type: "docker" as const,
			image: DOCKER_IMAGE,
			protectedPaths: [root],
			workflowId: "workflow-preflight",
			taskId: "task-preflight",
			attemptId: "attempt-preflight",
			executionKey: "execution-preflight",
			sessionId: "session-preflight",
			sessionPath: join(root, "session.jsonl"),
		};
		await writeFile(base.sessionPath, "session\n");
		const missingIdentity = new KernelManager({
			cwd: join(root, "workspace"),
			isolation: {
				...base,
				ownerIdentity: owner("identity"),
				sessionId: "",
			} as unknown as KernelContainerIsolationOptions,
		});
		await mkdir(join(root, "workspace"), { recursive: true });
		await expect(missingIdentity.start()).rejects.toThrow(/sessionId|identity/i);
		await missingIdentity.kill();

		const missingProtection = new KernelManager({
			cwd: join(root, "workspace"),
			isolation: {
				...base,
				ownerIdentity: owner("missing"),
				protectedPaths: [],
			} as unknown as KernelContainerIsolationOptions,
		});
		await expect(missingProtection.start()).rejects.toThrow(/protected.*authority|required/i);
		await missingProtection.kill();

		for (const [label, cwd] of [
			["root", "/"],
			["home", homedir()],
			["shared-temp", tmpdir()],
			["run-root", "/run"],
		] as const) {
			const manager = new KernelManager({
				cwd,
				isolation: { ...base, ownerIdentity: owner(label) } as unknown as KernelContainerIsolationOptions,
			});
			await expect(manager.start()).rejects.toThrow(/root|home|temporary|shared|run|protected/i);
			await manager.kill();
		}
	});

	it("rejects symlink and hardlink authority escapes before container start", async () => {
		await requireDocker();
		root = await mkdtemp(join(tmpdir(), "prime-agent-kernel-isolation-links-"));
		const workspace = join(root, "workspace");
		const authority = join(root, "authority");
		const secret = join(authority, "secret");
		await mkdir(workspace, { recursive: true });
		await mkdir(authority, { recursive: true });
		await writeFile(secret, "host-secret\n");
		await symlink(secret, join(workspace, "symlink-secret"));
		await link(secret, join(workspace, "hardlink-secret"));
		const manager = new KernelManager({
			cwd: workspace,
			isolation: {
				type: "docker",
				image: DOCKER_IMAGE,
				ownerIdentity: `kernel-isolation-links-${process.pid}-${Date.now()}`,
				protectedPaths: [authority],
				workflowId: "workflow-links",
				taskId: "task-links",
				attemptId: "attempt-links",
				executionKey: "execution-links",
				sessionId: "session-links",
				sessionPath: join(root, "session.jsonl"),
			} as unknown as KernelContainerIsolationOptions,
		});
		await writeFile(join(root, "session.jsonl"), "session\n");
		await expect(manager.start()).rejects.toThrow(/symlink|hardlink|link|authority/i);
		await manager.kill();
	});
});
