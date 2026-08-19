import { execFile, execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getgid, getuid } from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const KERNEL_CONTAINER_CONNECTION_PATH = "/prime-agent/kernel/connection.container.json";
const KERNEL_CONTAINER_POLICY_PATH = "/prime-agent/kernel/policy-entrypoint";
const KERNEL_CONTAINER_MOUNT_POLICY = "isolated-v1";
const KERNEL_CONTAINER_NETWORK_POLICY = "deny";
const KERNEL_CONTAINER_TMPFS = "/tmp:rw,nosuid,nodev,noexec,size=256m";
const KERNEL_CONTAINER_CONTROL_PORTS = 5;
const KERNEL_OUTPUT_SCRATCH_PREFIX = "prime-agent-kernel-output-";

const NETWORK_POLICY_ENTRYPOINT = `#!/bin/sh
set -eu

iptables --flush OUTPUT
iptables --policy OUTPUT DROP
iptables --append OUTPUT --out-interface lo --jump ACCEPT
iptables --append OUTPUT --match conntrack --ctstate ESTABLISHED,RELATED --jump ACCEPT

ip6tables --flush OUTPUT
ip6tables --policy OUTPUT DROP
ip6tables --append OUTPUT --out-interface lo --jump ACCEPT
ip6tables --append OUTPUT --match conntrack --ctstate ESTABLISHED,RELATED --jump ACCEPT

exec setpriv \\
    --reuid="\${PRIME_AGENT_KERNEL_UID}" \\
    --regid="\${PRIME_AGENT_KERNEL_GID}" \\
    --clear-groups \\
    --no-new-privs \\
    --bounding-set=-all \\
    --inh-caps=-all \\
    --ambient-caps=-all \\
    "$@"
`;

export interface KernelContainerIsolationOptions {
	readonly type: "docker";
	readonly image: string;
	readonly ownerIdentity: string;
	/** Host paths that must never be mounted into the worker container. */
	readonly protectedPaths: readonly string[];
	/** Exact process/session identity bound to the container labels and attestation. */
	readonly sessionId: string;
	readonly sessionPath: string;
	readonly workflowId: string;
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly dockerBinary?: string;
	readonly kernelCommand?: readonly string[];
}

export class KernelContainerCleanupError extends Error {
	readonly code = "KERNEL_CONTAINER_CLEANUP_FAILED" as const;

	constructor(
		readonly containerId: string,
		message: string,
	) {
		super(message);
		this.name = "KernelContainerCleanupError";
	}
}

export class KernelContainerCreationError extends Error {
	readonly code = "KERNEL_CONTAINER_CREATE_FAILED" as const;

	constructor(
		readonly containerId: string | undefined,
		message: string,
		readonly causeError?: unknown,
	) {
		super(message);
		this.name = "KernelContainerCreationError";
	}
}

export type KernelContainerIsolationResolver = () => KernelContainerIsolationOptions | undefined;

export interface KernelContainerCreateOptions {
	readonly isolation: KernelContainerIsolationOptions;
	readonly workspace: string;
	readonly tempDir: string;
	readonly ports: readonly number[];
	readonly outputPaths: readonly string[];
	readonly environment: Readonly<Record<string, string>>;
}

interface SafeIsolationPaths {
	readonly workspace: string;
	readonly tempDir: string;
	readonly sessionPath: string;
	readonly outputPaths: readonly string[];
	readonly protectedPaths: readonly string[];
}

export function canonicalizeKernelWritablePath(path: string): string {
	const absolute = resolve(path);
	try {
		return realpathSync(absolute);
	} catch {
		return join(realpathSync(dirname(absolute)), basename(absolute));
	}
}

export function kernelOutputPathIsProtected(path: string, protectedPaths: readonly string[]): boolean {
	const canonicalOutput = canonicalizeKernelWritablePath(path);
	return protectedPaths.some((protectedPath) => {
		const canonicalProtected = canonicalProtectedPath(protectedPath);
		return pathIsWithin(canonicalOutput, canonicalProtected) || pathIsWithin(canonicalProtected, canonicalOutput);
	});
}

export function createKernelOutputScratch(isolation: KernelContainerIsolationOptions): string {
	assertIsolationOptions(isolation);
	const ownerDigest = createHash("sha256").update(isolation.ownerIdentity).digest("hex").slice(0, 16);
	const scratch = mkdtempSync(join(tmpdir(), `${KERNEL_OUTPUT_SCRATCH_PREFIX}${ownerDigest}-`));
	chmodSync(scratch, 0o700);
	const canonicalScratch = realpathSync(scratch);
	assertNotBroadRoot(canonicalScratch, "kernel output");
	assertPathNotProtected(canonicalScratch, "kernel output", isolation.protectedPaths);
	assertNoUnsafeLinks(canonicalScratch, "kernel output");
	return canonicalScratch;
}

export function removeKernelOutputScratch(path: string): void {
	let canonicalPath: string;
	try {
		canonicalPath = realpathSync(resolve(path));
	} catch (error) {
		if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!basename(canonicalPath).startsWith(KERNEL_OUTPUT_SCRATCH_PREFIX)) {
		throw new Error("kernel output scratch path is not host allocated");
	}
	const tempRoot = realpathSync(tmpdir());
	if (realpathSync(dirname(canonicalPath)) !== tempRoot) {
		throw new Error("kernel output scratch path escaped the private temporary root");
	}
	rmSync(canonicalPath, { recursive: true, force: true });
}

interface DockerMount {
	readonly Type: string;
	readonly Source: string;
	readonly Destination: string;
	readonly RW: boolean;
}

interface DockerInspection {
	readonly Config: {
		readonly Image: string;
		readonly Cmd: readonly string[] | null;
		readonly Entrypoint: readonly string[] | string | null;
		readonly User: string;
		readonly Labels: Readonly<Record<string, string>> | null;
		readonly Env: readonly string[];
	};
	readonly Mounts: readonly DockerMount[];
	readonly HostConfig: {
		readonly ReadonlyRootfs?: boolean;
		readonly NetworkMode?: string;
		readonly CapDrop?: readonly string[] | null;
		readonly CapAdd?: readonly string[] | null;
		readonly SecurityOpt?: readonly string[] | null;
		readonly Privileged?: boolean;
		readonly PortBindings?: Readonly<Record<string, readonly { HostIp: string; HostPort: string }[]>>;
		readonly Tmpfs?: Readonly<Record<string, string>>;
	};
	readonly State: { readonly Running: boolean; readonly Status: string };
}

function pathIsWithin(candidate: string, parent: string): boolean {
	const remainder = relative(parent, candidate);
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${resolve("/")}`));
}

function canonicalPath(path: string, label: string): string {
	if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error("symbolic links are not admitted");
		return realpathSync(path);
	} catch (error) {
		throw new Error(`${label} must exist and be readable: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function canonicalProtectedPath(path: string): string {
	if (!isAbsolute(path)) throw new Error("kernel protected authority paths must be absolute");
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function assertPathNotProtected(path: string, label: string, protectedPaths: readonly string[]): void {
	for (const protectedPath of protectedPaths) {
		if (pathIsWithin(path, protectedPath) || pathIsWithin(protectedPath, path)) {
			throw new Error(`${label} overlaps protected host authority path ${protectedPath}`);
		}
	}
}

function assertNoUnsafeLinks(root: string, label: string): void {
	const pending = [root];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) continue;
		const info = lstatSync(current);
		if (info.isSymbolicLink()) throw new Error(`${label} contains a symlink: ${current}`);
		if (info.isFile() && info.nlink > 1) throw new Error(`${label} contains a hardlink: ${current}`);
		if (!info.isDirectory()) continue;
		for (const entry of readdirSync(current)) pending.push(join(current, entry));
	}
}

function assertNotBroadRoot(path: string, label: string): void {
	const broadRoots = new Map<string, string>([
		[canonicalProtectedPath(resolve("/")), "root"],
		[canonicalProtectedPath(homedir()), "home"],
		[canonicalProtectedPath(tmpdir()), "shared temporary"],
		[canonicalProtectedPath(resolve("/run")), "run"],
		[canonicalProtectedPath(resolve("/var/run")), "run"],
	]);
	const name = broadRoots.get(path);
	if (name !== undefined) throw new Error(`${label} must not be the broad ${name} root`);
}

function assertDedicatedScratch(tempDir: string): void {
	assertNotBroadRoot(tempDir, "kernel connection scratch");
	if (dirname(tempDir) !== canonicalProtectedPath(tmpdir()) || !basename(tempDir).startsWith("prime-agent-kernel-")) {
		throw new Error("kernel connection scratch must be a unique private temporary directory");
	}
}

function assertSafeIsolationPaths(options: KernelContainerCreateOptions): SafeIsolationPaths {
	if (options.isolation.protectedPaths.length === 0) {
		throw new Error("kernel isolation requires protected host authority paths");
	}
	const sessionPath = canonicalPath(options.isolation.sessionPath, "kernel session path");
	const protectedPaths = [
		...new Set(
			[...options.isolation.protectedPaths].map((path) => canonicalPath(path, "kernel protected authority path")),
		),
		sessionPath,
	];
	const workspace = canonicalPath(options.workspace, "kernel workspace");
	const tempDir = canonicalPath(options.tempDir, "kernel connection scratch");
	assertNotBroadRoot(workspace, "kernel workspace");
	assertDedicatedScratch(tempDir);
	if (!statSync(workspace).isDirectory() || !statSync(tempDir).isDirectory()) {
		throw new Error("kernel workspace and connection scratch must be directories");
	}
	assertPathNotProtected(workspace, "kernel workspace", protectedPaths);
	assertPathNotProtected(tempDir, "kernel connection scratch", protectedPaths);
	if (pathIsWithin(tempDir, workspace) || pathIsWithin(workspace, tempDir)) {
		throw new Error("kernel connection scratch must be separate from the workspace");
	}

	const outputPaths = [...new Set(options.outputPaths.map((path) => canonicalPath(path, "kernel output")))];
	for (const outputPath of outputPaths) {
		assertNotBroadRoot(outputPath, "kernel output");
		assertPathNotProtected(outputPath, "kernel output", protectedPaths);
		if (pathIsWithin(outputPath, workspace) || pathIsWithin(workspace, outputPath)) {
			throw new Error("kernel output must be separate from the immutable workspace");
		}
		if (pathIsWithin(outputPath, tempDir) || pathIsWithin(tempDir, outputPath)) {
			throw new Error("kernel output must be separate from connection scratch");
		}
		if (!statSync(outputPath).isDirectory()) throw new Error("kernel output must be a directory");
	}
	for (let index = 0; index < outputPaths.length; index++) {
		for (const otherPath of outputPaths.slice(index + 1)) {
			if (pathIsWithin(outputPaths[index]!, otherPath) || pathIsWithin(otherPath, outputPaths[index]!)) {
				throw new Error("kernel output capabilities must be disjoint");
			}
		}
	}
	assertNoUnsafeLinks(workspace, "kernel workspace");
	assertNoUnsafeLinks(tempDir, "kernel connection scratch");
	for (const outputPath of outputPaths) assertNoUnsafeLinks(outputPath, "kernel output");
	return { workspace, tempDir, sessionPath, outputPaths, protectedPaths };
}

function assertIsolationOptions(options: KernelContainerIsolationOptions): void {
	if (options.type !== "docker") throw new Error(`unsupported kernel isolation type ${options.type}`);
	if (!options.image || /[\r\n]/.test(options.image)) throw new Error("kernel container image must be non-empty");
	if (!options.ownerIdentity || /[\r\n]/.test(options.ownerIdentity)) {
		throw new Error("kernel container owner identity must be non-empty");
	}
	if (!Array.isArray(options.protectedPaths) || options.protectedPaths.length === 0) {
		throw new Error("kernel isolation requires protected host authority paths");
	}
	for (const [name, value] of Object.entries({
		sessionId: options.sessionId,
		sessionPath: options.sessionPath,
		workflowId: options.workflowId,
		taskId: options.taskId,
		attemptId: options.attemptId,
		executionKey: options.executionKey,
	})) {
		if (!value || /[\r\n]/.test(value)) throw new Error(`kernel container ${name} must be non-empty`);
	}
	if (options.kernelCommand && options.kernelCommand.length === 0) {
		throw new Error("kernel container command must be non-empty");
	}
}

function writeNetworkPolicyEntrypoint(tempDir: string): void {
	const path = join(tempDir, "policy-entrypoint");
	writeFileSync(path, NETWORK_POLICY_ENTRYPOINT, { mode: 0o555 });
	chmodSync(path, 0o555);
}

function expectedEnvironment(
	environment: Readonly<Record<string, string>>,
	ownerIdentity: string,
): Readonly<Record<string, string>> {
	for (const name of Object.keys(environment)) {
		if (
			name === "PRIME_AGENT_KERNEL_UID" ||
			name === "PRIME_AGENT_KERNEL_GID" ||
			name === "PRIME_AGENT_KERNEL_OWNER_IDENTITY" ||
			name === "HOME" ||
			name === "TMPDIR"
		) {
			throw new Error(`kernel container environment cannot override ${name}`);
		}
		if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|RUN_ROOT|KEYRING|JOURNAL)/i.test(name)) {
			throw new Error(`kernel container environment cannot carry host authority field ${name}`);
		}
	}
	return {
		HOME: "/tmp",
		TMPDIR: "/tmp",
		PRIME_AGENT_KERNEL_UID: String(getuid?.() ?? 0),
		PRIME_AGENT_KERNEL_GID: String(getgid?.() ?? 0),
		PRIME_AGENT_KERNEL_OWNER_IDENTITY: ownerIdentity,
		...environment,
	};
}

function dockerCreateArgs(options: KernelContainerCreateOptions, safePaths: SafeIsolationPaths): string[] {
	const isolation = options.isolation;
	const environment = expectedEnvironment(options.environment, isolation.ownerIdentity);
	const command = isolation.kernelCommand ?? ["python"];
	const args = [
		"create",
		"--rm",
		"--init",
		"--network",
		"bridge",
		"--label",
		`prime-agent.kernel-owner=${isolation.ownerIdentity}`,
		"--label",
		`prime-agent.kernel-session-id=${isolation.sessionId}`,
		"--label",
		`prime-agent.kernel-session-path=${safePaths.sessionPath}`,
		"--label",
		`prime-agent.kernel-workflow-id=${isolation.workflowId}`,
		"--label",
		`prime-agent.kernel-task-id=${isolation.taskId}`,
		"--label",
		`prime-agent.kernel-attempt-id=${isolation.attemptId}`,
		"--label",
		`prime-agent.kernel-execution-key=${isolation.executionKey}`,
		"--label",
		`prime-agent.kernel-mount-policy=${KERNEL_CONTAINER_MOUNT_POLICY}`,
		"--label",
		`prime-agent.kernel-network-policy=${KERNEL_CONTAINER_NETWORK_POLICY}`,
		"--label",
		`prime-agent.kernel-owner-uid=${String(getuid?.() ?? 0)}`,
		"--label",
		`prime-agent.kernel-owner-gid=${String(getgid?.() ?? 0)}`,
		"--read-only",
		"--tmpfs",
		KERNEL_CONTAINER_TMPFS,
		"--cap-drop",
		"ALL",
		"--cap-add",
		"NET_ADMIN",
		"--cap-add",
		"SETUID",
		"--cap-add",
		"SETGID",
		"--cap-add",
		"SETPCAP",
		"--security-opt",
		"no-new-privileges",
		"--mount",
		`type=bind,src=${safePaths.workspace},dst=${safePaths.workspace},readonly`,
		"--mount",
		`type=bind,src=${safePaths.tempDir},dst=/prime-agent/kernel,readonly`,
	];
	for (const outputPath of safePaths.outputPaths) {
		args.push("--mount", `type=bind,src=${outputPath},dst=${outputPath}`);
	}
	args.push("--workdir", safePaths.workspace, "--entrypoint", KERNEL_CONTAINER_POLICY_PATH);
	for (const [name, value] of Object.entries(environment)) args.push("--env", `${name}=${value}`);
	for (const port of options.ports) args.push("--publish", `127.0.0.1:${port}:${port}`);
	args.push(isolation.image, ...command, "-m", "ipykernel_launcher", "-f", KERNEL_CONTAINER_CONNECTION_PATH);
	return args;
}

function expectedKernelContainerCommand(isolation: KernelContainerIsolationOptions): readonly string[] {
	return [
		...(isolation.kernelCommand ?? ["python"]),
		"-m",
		"ipykernel_launcher",
		"-f",
		KERNEL_CONTAINER_CONNECTION_PATH,
	];
}

function parseInspection(output: string): DockerInspection {
	let records: unknown;
	try {
		records = JSON.parse(output);
	} catch (error) {
		throw new Error(
			`kernel container inspection was not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!Array.isArray(records) || records.length !== 1 || typeof records[0] !== "object" || records[0] === null) {
		throw new Error("kernel container inspection returned an invalid record");
	}
	return records[0] as DockerInspection;
}

function assertContainerAttestation(
	inspection: DockerInspection,
	options: KernelContainerCreateOptions,
	safePaths: SafeIsolationPaths,
): void {
	const labels = inspection.Config.Labels ?? {};
	const ownerIdentity = options.isolation.ownerIdentity;
	if (inspection.State.Running || inspection.State.Status !== "created") {
		throw new Error("kernel container must be attested before it starts");
	}
	if (inspection.Config.Image !== options.isolation.image) {
		throw new Error("kernel container image attestation mismatch");
	}
	const expectedCommand = expectedKernelContainerCommand(options.isolation);
	if (
		!Array.isArray(inspection.Config.Cmd) ||
		inspection.Config.Cmd.length !== expectedCommand.length ||
		inspection.Config.Cmd.some((value, index) => value !== expectedCommand[index])
	) {
		throw new Error("kernel container command attestation mismatch");
	}
	if (labels["prime-agent.kernel-owner"] !== ownerIdentity) {
		throw new Error("kernel container owner identity attestation mismatch");
	}
	const expectedIdentityLabels = {
		"prime-agent.kernel-session-id": options.isolation.sessionId,
		"prime-agent.kernel-session-path": safePaths.sessionPath,
		"prime-agent.kernel-workflow-id": options.isolation.workflowId,
		"prime-agent.kernel-task-id": options.isolation.taskId,
		"prime-agent.kernel-attempt-id": options.isolation.attemptId,
		"prime-agent.kernel-execution-key": options.isolation.executionKey,
	};
	for (const [name, expected] of Object.entries(expectedIdentityLabels)) {
		if (labels[name] !== expected) throw new Error(`kernel container ${name} attestation mismatch`);
	}
	if (labels["prime-agent.kernel-mount-policy"] !== KERNEL_CONTAINER_MOUNT_POLICY) {
		throw new Error("kernel container mount policy attestation mismatch");
	}
	if (labels["prime-agent.kernel-network-policy"] !== KERNEL_CONTAINER_NETWORK_POLICY) {
		throw new Error("kernel container network policy attestation mismatch");
	}
	if (labels["prime-agent.kernel-owner-uid"] !== String(getuid?.() ?? 0)) {
		throw new Error("kernel container owner uid attestation mismatch");
	}
	if (labels["prime-agent.kernel-owner-gid"] !== String(getgid?.() ?? 0)) {
		throw new Error("kernel container owner gid attestation mismatch");
	}
	const entrypoint = inspection.Config.Entrypoint;
	if (!Array.isArray(entrypoint) || entrypoint.length !== 1 || entrypoint[0] !== KERNEL_CONTAINER_POLICY_PATH) {
		throw new Error("kernel container network policy entrypoint attestation mismatch");
	}
	if (inspection.Config.User !== "") throw new Error("kernel container policy must start from the root user");
	if (inspection.HostConfig.Privileged !== false) throw new Error("kernel container must not be privileged");
	const environment = new Set(inspection.Config.Env);
	for (const expected of [
		`PRIME_AGENT_KERNEL_UID=${String(getuid?.() ?? 0)}`,
		`PRIME_AGENT_KERNEL_GID=${String(getgid?.() ?? 0)}`,
		`PRIME_AGENT_KERNEL_OWNER_IDENTITY=${ownerIdentity}`,
	]) {
		if (!environment.has(expected))
			throw new Error(`kernel container environment attestation mismatch for ${expected}`);
	}

	const expectedBindMounts = new Map<string, { readonly destination: string; readonly writable: boolean }>([
		[safePaths.workspace, { destination: safePaths.workspace, writable: false }],
		[safePaths.tempDir, { destination: "/prime-agent/kernel", writable: false }],
		...safePaths.outputPaths.map((path) => [path, { destination: path, writable: true }] as const),
	]);
	const bindMounts = inspection.Mounts.filter((mount) => mount.Type === "bind");
	const extraMounts = inspection.Mounts.filter(
		(mount) => mount.Type !== "bind" && !(mount.Type === "tmpfs" && mount.Destination === "/tmp"),
	);
	if (extraMounts.length > 0) throw new Error("kernel container has an unapproved capability mount");
	if (bindMounts.length !== expectedBindMounts.size) {
		throw new Error("kernel container bind mounts are not minimal");
	}
	for (const mount of bindMounts) {
		const expected = expectedBindMounts.get(mount.Source);
		if (expected === undefined || mount.Destination !== expected.destination || mount.RW !== expected.writable) {
			throw new Error(`kernel container mount attestation mismatch for ${mount.Source}`);
		}
		expectedBindMounts.delete(mount.Source);
	}
	if (expectedBindMounts.size > 0) throw new Error("kernel container is missing an attested capability mount");
	const hostConfig = inspection.HostConfig;
	if (hostConfig.ReadonlyRootfs !== true) throw new Error("kernel container root filesystem must be read-only");
	if (hostConfig.NetworkMode !== "bridge") throw new Error("kernel container network mode attestation mismatch");
	if (hostConfig.CapDrop?.length !== 1 || hostConfig.CapDrop[0] !== "ALL") {
		throw new Error("kernel container must drop all capabilities");
	}
	if (
		!hostConfig.CapAdd ||
		new Set(hostConfig.CapAdd).size !== 4 ||
		!["CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID", "CAP_SETPCAP"].every((capability) =>
			hostConfig.CapAdd?.includes(capability),
		)
	) {
		throw new Error("kernel container capability attestation mismatch");
	}
	if (!hostConfig.SecurityOpt?.includes("no-new-privileges")) {
		throw new Error("kernel container must enable no-new-privileges");
	}
	const expectedPortBindings = new Set(options.ports.map((port) => `${port}/tcp`));
	const actualPortBindings = hostConfig.PortBindings ?? {};
	if (new Set(Object.keys(actualPortBindings)).size !== expectedPortBindings.size) {
		throw new Error("kernel container published port set attestation mismatch");
	}
	for (const port of expectedPortBindings) {
		const bindings = actualPortBindings[port];
		if (
			!bindings ||
			bindings.length !== 1 ||
			bindings[0]?.HostIp !== "127.0.0.1" ||
			bindings[0]?.HostPort !== port.slice(0, -4)
		) {
			throw new Error(`kernel container published port attestation mismatch for ${port}`);
		}
	}
	if (hostConfig.Tmpfs?.["/tmp"] !== KERNEL_CONTAINER_TMPFS.slice("/tmp:".length)) {
		throw new Error("kernel container must use the bounded private tmpfs for scratch");
	}
	for (const mount of bindMounts) {
		assertPathNotProtected(mount.Source, "kernel container mount", safePaths.protectedPaths);
	}
}

async function inspectContainer(dockerBinary: string, containerId: string): Promise<DockerInspection> {
	const { stdout } = await execFileAsync(dockerBinary, ["inspect", containerId], { maxBuffer: 128 * 1024 });
	return parseInspection(stdout);
}

function findContainerByOwner(dockerBinary: string, ownerIdentity: string): string | undefined {
	try {
		const output = execFileSync(
			dockerBinary,
			[
				"ps",
				"--all",
				"--no-trunc",
				"--filter",
				`label=prime-agent.kernel-owner=${ownerIdentity}`,
				"--format",
				"{{.ID}}",
			],
			{ encoding: "utf8", maxBuffer: 128 * 1024, timeout: 5_000 },
		);
		const ids = output.trim().split("\n").filter(Boolean);
		if (ids.length > 1) throw new Error("multiple kernel containers share one owner identity");
		return ids[0];
	} catch {
		return undefined;
	}
}

export async function reserveKernelPorts(): Promise<readonly number[]> {
	const servers = Array.from({ length: KERNEL_CONTAINER_CONTROL_PORTS }, () => createServer());
	try {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolvePromise, reject) => {
						server.once("error", reject);
						server.listen(0, "127.0.0.1", () => resolvePromise());
					}),
			),
		);
		return servers.map((server) => {
			const address = server.address();
			if (address === null || typeof address === "string") throw new Error("kernel control port reservation failed");
			return address.port;
		});
	} finally {
		await Promise.all(
			servers.map(
				(server) =>
					new Promise<void>((resolvePromise) => {
						if (!server.listening) {
							resolvePromise();
							return;
						}
						server.close(() => resolvePromise());
					}),
			),
		);
	}
}

export function writeContainerConnectionFile(tempDir: string, connection: Readonly<Record<string, unknown>>): string {
	const connectionPath = join(tempDir, "connection.container.json");
	writeFileSync(connectionPath, JSON.stringify({ ...connection, ip: "0.0.0.0" }, null, 2), { mode: 0o400 });
	return connectionPath;
}

export async function createKernelContainer(options: KernelContainerCreateOptions): Promise<string> {
	assertIsolationOptions(options.isolation);
	if (
		options.ports.length !== KERNEL_CONTAINER_CONTROL_PORTS ||
		options.ports.some((port) => !Number.isInteger(port) || port < 1)
	) {
		throw new Error("kernel container requires five valid control ports");
	}
	if (options.environment.PYTHONPATH && options.environment.PYTHONPATH.includes("\n")) {
		throw new Error("kernel container PYTHONPATH must not contain newlines");
	}
	const safePaths = assertSafeIsolationPaths(options);
	writeContainerPolicyFiles(safePaths.tempDir);
	const dockerBinary = options.isolation.dockerBinary ?? "docker";
	const args = dockerCreateArgs(options, safePaths);
	let containerId = "";
	try {
		const created = await execFileAsync(dockerBinary, args, { maxBuffer: 128 * 1024 });
		containerId = created.stdout.trim();
		if (!/^[0-9a-f]{12,64}$/.test(containerId)) throw new Error("docker create did not return a container id");
		const inspection = await inspectContainer(dockerBinary, containerId);
		assertContainerAttestation(inspection, options, safePaths);
		return containerId;
	} catch (error) {
		containerId ||= findContainerByOwner(dockerBinary, options.isolation.ownerIdentity) ?? "";
		if (containerId) {
			try {
				removeKernelContainer(dockerBinary, containerId);
			} catch (cleanupError) {
				throw cleanupError;
			}
		}
		throw new KernelContainerCreationError(
			containerId || undefined,
			error instanceof Error ? error.message : String(error),
			error,
		);
	}
}

function writeContainerPolicyFiles(tempDir: string): void {
	mkdirSync(tempDir, { recursive: true });
	writeNetworkPolicyEntrypoint(tempDir);
}

function commandErrorOutput(error: unknown): string {
	if (!error || typeof error !== "object") return "";
	const record = error as { readonly stderr?: unknown; readonly stdout?: unknown; readonly message?: unknown };
	return [record.stderr, record.stdout, record.message]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
}

function containerIsAbsentError(error: unknown): boolean {
	return /no such (?:container|object)|container .* not found|does not exist/i.test(commandErrorOutput(error));
}

function inspectContainerForCleanup(dockerBinary: string, containerId: string): { running: boolean } | "absent" {
	try {
		const output = execFileSync(dockerBinary, ["inspect", containerId], {
			encoding: "utf8",
			maxBuffer: 128 * 1024,
			timeout: 5_000,
		});
		const records = JSON.parse(output) as unknown;
		if (!Array.isArray(records) || records.length !== 1 || typeof records[0] !== "object" || records[0] === null) {
			throw new Error("docker cleanup inspection returned an invalid record");
		}
		const state = (records[0] as { readonly State?: { readonly Running?: unknown } }).State;
		if (typeof state?.Running !== "boolean") throw new Error("docker cleanup inspection omitted container state");
		return { running: state.Running };
	} catch (error) {
		if (containerIsAbsentError(error)) return "absent";
		throw error;
	}
}

export function removeKernelContainer(dockerBinary: string, containerId: string): void {
	if (!containerId) return;
	let removeError: unknown;
	try {
		execFileSync(dockerBinary, ["rm", "--force", containerId], { stdio: "ignore", timeout: 5_000 });
	} catch (error) {
		removeError = error;
	}

	let inspection: { running: boolean } | "absent";
	try {
		inspection = inspectContainerForCleanup(dockerBinary, containerId);
	} catch (error) {
		throw new KernelContainerCleanupError(
			containerId,
			`kernel container ${containerId} cleanup could not be verified: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (inspection === "absent") return;
	if (!inspection.running) {
		if (removeError) {
			throw new KernelContainerCleanupError(
				containerId,
				`kernel container ${containerId} stopped but cleanup failed: ${commandErrorOutput(removeError)}`,
			);
		}
		return;
	}
	throw new KernelContainerCleanupError(
		containerId,
		`kernel container ${containerId} remained running after cleanup${removeError ? `: ${commandErrorOutput(removeError)}` : ""}`,
	);
}
