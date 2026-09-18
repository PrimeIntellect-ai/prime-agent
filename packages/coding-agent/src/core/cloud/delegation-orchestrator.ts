import { createHash, randomUUID } from "node:crypto";
import { CLOUD_GUEST_BRIDGE_SCRIPT } from "./bridge/guest-bridge-script.js";
import type {
	CloudCleanupState,
	CloudDesiredLifecycle,
	CloudObservedLifecycle,
	CloudResultImportState,
	CloudSessionBaseline,
	CloudSessionCreateInput,
	CloudSessionRecord,
	CloudSessionTunnel,
	CloudTunnelState,
} from "./cloud-session-store.js";
import {
	MAX_TRANSFER_BYTES,
	type PrimeSandbox,
	type PrimeSandboxAuth,
	type PrimeSandboxGatewayOptions,
	type PrimeSandboxStartCommand,
	type PrimeSandboxStatus,
	type PrimeSandboxUploadRequest,
	type PrimeSandboxUploadResult,
	type PrimeSandboxVmCreateRequest,
} from "./prime-sandbox-client.js";
import {
	CLOUD_MAX_ERROR_CHARS,
	CLOUD_MAX_ID_CHARS,
	CLOUD_MAX_MODEL_ID_CHARS,
	CLOUD_MAX_PROMPT_CHARS,
	type CloudSessionId,
	isCloudDigest,
	newCloudSessionId,
} from "./protocol.js";

/**
 * Direct-model cloud delegation orchestrator.
 *
 * Drives one delegated Prime Agent session inside a Prime Sandbox VM from the
 * local daemon, with every external effect behind an injected boundary:
 *
 * - {@link CloudDelegationRecordStore}: durable cloud-session records
 *   (`CloudSessionStore`-compatible). The record is created before any
 *   platform call and stays the only durability sink.
 * - {@link CloudDelegationPlatformClient}: the generic Prime Sandbox REST
 *   surface (`PrimeSandboxClient`-compatible): create, fetch, auth, upload,
 *   delete. VM execution never goes through the container exec endpoint.
 * - {@link CloudDelegationVmProcessClient}: the reconnectable VM process API.
 *   The resident cloud-daemon process is started exactly once per execution
 *   incarnation: starts are create-or-attach keyed by the persisted resident
 *   process UUID, so a retry attaches instead of spawning a duplicate.
 * - {@link CloudDelegationWorkspaceTransfer}: local workspace capture (always
 *   the first boundary call of a delegation) and gateway upload of the
 *   captured archive and manifest.
 * - {@link CloudDelegationResultsClient}: retrieval and durable local
 *   recording of the guest's terminal status/stdout/stderr/binary patch.
 * - {@link CloudDelegationReadiness}: guest-level readiness on top of the
 *   platform RUNNING status.
 *
 * Workflow invariants, enforced in code and covered by tests:
 *
 * 1. The workspace is captured before any platform call, and the record is
 *    created durably before the sandbox is.
 * 2. Identities (session id, create idempotency key, resident process UUID)
 *    are preallocated and persisted; an inconclusive create is retried with
 *    the same idempotency key, never with a second sandbox.
 * 3. Recovery checks results and process status before any attach or start;
 *    a logical task is never duplicated.
 * 4. The bootstrap is a fixed uploaded script plus fixed-name env/argv; no
 *    user text is ever interpolated into a command line. It initializes the
 *    git baseline and execs the uploaded bridge, which supervises the resident
 *    guest daemon running the configured Prime Agent package/model in the VM
 *    (inference, tools, Python, children) and always writes a terminal
 *    status, stdout, stderr, and a binary patch.
 * 5. Results (output and patch) are retrieved before any sandbox delete. The
 *    default stop flow leaves the sandbox in a review state; only an explicit
 *    forfeit deletes it.
 * 6. Secrets (the cloud inference credential, gateway tokens) are uploaded
 *    where the guest needs them but never recorded: not in the record, not in
 *    progress events, and not in error messages, which are redacted.
 */

export const CLOUD_DELEGATION_MAX_PACKAGE_CHARS = 256;
export const CLOUD_DELEGATION_MAX_CREDENTIAL_CHARS = 8192;
export const CLOUD_DELEGATION_MIN_TIMEOUT_MINUTES = 10;
export const CLOUD_DELEGATION_MAX_TIMEOUT_MINUTES = 1440;
export const CLOUD_DELEGATION_DEFAULT_POLL_INTERVAL_MS = 2_000;
export const CLOUD_DELEGATION_DEFAULT_STOP_TIMEOUT_MS = 60_000;

/** Fixed guest paths. Uploads and the bootstrap only ever use these. */
export const CLOUD_GUEST_ROOT = "/opt/prime-agent";
export const CLOUD_GUEST_WORKSPACE_DIR = `${CLOUD_GUEST_ROOT}/workspace`;
export const CLOUD_GUEST_ARCHIVE_PATH = `${CLOUD_GUEST_ROOT}/workspace.tar`;
export const CLOUD_GUEST_MANIFEST_PATH = `${CLOUD_GUEST_ROOT}/workspace-manifest.json`;
export const CLOUD_GUEST_BOOTSTRAP_PATH = `${CLOUD_GUEST_ROOT}/bootstrap/bootstrap.sh`;
export const CLOUD_GUEST_PROMPT_PATH = `${CLOUD_GUEST_ROOT}/task/prompt.txt`;
export const CLOUD_GUEST_AUTH_PATH = `${CLOUD_GUEST_ROOT}/auth/inference.token`;
export const CLOUD_GUEST_RESULTS_DIR = `${CLOUD_GUEST_ROOT}/results`;
export const CLOUD_GUEST_BRIDGE_PATH = `${CLOUD_GUEST_ROOT}/bridge/bridge-server.mjs`;
export const CLOUD_GUEST_BRIDGE_STATE_DIR = `${CLOUD_GUEST_ROOT}/bridge/state`;
/** The resident guest daemon's VM-local protocol socket (0700). */
export const CLOUD_GUEST_DAEMON_SOCKET = `${CLOUD_GUEST_ROOT}/daemon-state/cloud.sock`;
/** Guest agent state directory (sessions, settings, artifacts). */
export const CLOUD_GUEST_AGENT_DIR = `${CLOUD_GUEST_ROOT}/agent-state`;
/** Guest daemon durable state (journal, outbox, session manifest). */
export const CLOUD_GUEST_DAEMON_STATE_DIR = `${CLOUD_GUEST_ROOT}/daemon-state`;
/** The guest daemon argv, fixed by the local daemon (never user text). */
export const CLOUD_GUEST_DAEMON_ARGV_JSON = JSON.stringify(["prime-agent", "--mode", "daemon"]);

/** Fixed-name environment variables carried by the resident process. */
export const CLOUD_DELEGATION_ENV_KEYS = {
	sessionId: "PRIME_AGENT_CLOUD_SESSION_ID",
	generation: "PRIME_AGENT_CLOUD_GENERATION",
	workspaceDir: "PRIME_AGENT_CLOUD_WORKSPACE_DIR",
	archivePath: "PRIME_AGENT_CLOUD_ARCHIVE_PATH",
	manifestPath: "PRIME_AGENT_CLOUD_MANIFEST_PATH",
	promptPath: "PRIME_AGENT_CLOUD_PROMPT_PATH",
	authPath: "PRIME_AGENT_CLOUD_AUTH_PATH",
	resultsDir: "PRIME_AGENT_CLOUD_RESULTS_DIR",
	agentBin: "PRIME_AGENT_CLOUD_AGENT_BIN",
	model: "PRIME_AGENT_CLOUD_MODEL",
	pkg: "PRIME_AGENT_CLOUD_PACKAGE",
	/** Guest inference billing team; consumed by the image's prime-agent. */
	inferenceTeamId: "PRIME_TEAM_ID",
	bridgeEnabled: "PRIME_AGENT_CLOUD_BRIDGE_ENABLED",
	bridgePath: "PRIME_AGENT_CLOUD_BRIDGE_PATH",
	bridgePort: "PRIME_AGENT_CLOUD_BRIDGE_PORT",
	bridgeToken: "PRIME_AGENT_CLOUD_BRIDGE_TOKEN",
	bridgeStateDir: "PRIME_AGENT_CLOUD_BRIDGE_STATE_DIR",
	bridgeNodeBin: "PRIME_AGENT_CLOUD_NODE_BIN",
	daemonSocket: "PRIME_AGENT_CLOUD_DAEMON_SOCKET",
	daemonArgv: "PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON",
	daemonAgentDir: "PRIME_AGENT_CLOUD_AGENT_DIR",
	daemonStateDir: "PRIME_AGENT_CLOUD_DAEMON_STATE_DIR",
	daemonStatusFile: "PRIME_AGENT_CLOUD_DAEMON_STATUS_FILE",
	frpcBin: "PRIME_AGENT_CLOUD_FRPC_BIN",
	tunnelId: "PRIME_AGENT_CLOUD_TUNNEL_ID",
	tunnelFrpServerHost: "PRIME_AGENT_CLOUD_TUNNEL_FRP_SERVER_HOST",
	tunnelFrpServerPort: "PRIME_AGENT_CLOUD_TUNNEL_FRP_SERVER_PORT",
	tunnelFrpToken: "PRIME_AGENT_CLOUD_TUNNEL_FRP_TOKEN",
	tunnelBindingSecret: "PRIME_AGENT_CLOUD_TUNNEL_BINDING_SECRET",
} as const;

/** Fixed VM start command: a shell-free argv that runs the uploaded script. */
export const CLOUD_DELEGATION_START_COMMAND: PrimeSandboxStartCommand = {
	executable: "/bin/bash",
	args: [CLOUD_GUEST_BOOTSTRAP_PATH],
};

/**
 * The fixed bootstrap script, uploaded verbatim. Every input reaches it as an
 * uploaded file or a fixed-name environment variable; the orchestrator never
 * interpolates user text into it. It always writes a terminal status, stdout,
 * stderr, and a binary patch under the results directory, through the EXIT
 * trap, whatever the agent's fate.
 */
export const CLOUD_DELEGATION_BOOTSTRAP_SCRIPT = `#!/usr/bin/env bash
# Fixed cloud-delegation bootstrap, uploaded verbatim by the local daemon.
# Inputs arrive only as uploaded files or fixed-name environment variables;
# the orchestrator never interpolates user text into this script. It always
# writes a terminal status, stdout, stderr, and a binary patch of the
# workspace changes under the results directory.
set -eu

WORKSPACE_DIR="\${PRIME_AGENT_CLOUD_WORKSPACE_DIR:?workspace dir is required}"
ARCHIVE_PATH="\${PRIME_AGENT_CLOUD_ARCHIVE_PATH:?archive path is required}"
MANIFEST_PATH="\${PRIME_AGENT_CLOUD_MANIFEST_PATH:?manifest path is required}"
PROMPT_PATH="\${PRIME_AGENT_CLOUD_PROMPT_PATH:?prompt path is required}"
AUTH_PATH="\${PRIME_AGENT_CLOUD_AUTH_PATH:?auth path is required}"
RESULTS_DIR="\${PRIME_AGENT_CLOUD_RESULTS_DIR:?results dir is required}"
AGENT_BIN="\${PRIME_AGENT_CLOUD_AGENT_BIN:-prime-agent}"
MODEL="\${PRIME_AGENT_CLOUD_MODEL:-}"

mkdir -p "$RESULTS_DIR"
: > "$RESULTS_DIR/stdout.txt"
: > "$RESULTS_DIR/stderr.txt"
STATUS_FILE="$RESULTS_DIR/status.txt"
OUTCOME="failed"
BASELINE=""

finish() {
	local code="$?"
	if [ -d "$WORKSPACE_DIR/.git" ] && [ -n "$BASELINE" ]; then
		# Make untracked files visible to git diff without staging their contents.
		while IFS= read -r -d '' path; do
			git -C "$WORKSPACE_DIR" add -N -- "$path" 2>> "$RESULTS_DIR/stderr.txt" || :
		done < <(git -C "$WORKSPACE_DIR" ls-files --others --exclude-standard -z)
		git -C "$WORKSPACE_DIR" -c core.quotePath=false diff --binary --no-renames "$BASELINE" > "$RESULTS_DIR/changes.patch" 2>> "$RESULTS_DIR/stderr.txt" || :
	else
		: > "$RESULTS_DIR/changes.patch"
	fi
	# Remove the guest credential before publishing the terminal result.
	rm -f "$AUTH_PATH"
	# Terminal status is the commit marker and therefore lands last.
	printf "%s\\n" "$OUTCOME" > "$STATUS_FILE.tmp"
	mv "$STATUS_FILE.tmp" "$STATUS_FILE"
	exit "$code"
}
trap finish EXIT
trap 'OUTCOME="stopped"; exit 143' INT TERM

# Unpack the uploaded workspace and reconstruct the git baseline so status,
# diff, and commit work against the submitted state. --no-same-owner: the
# archive may carry the contributor's macOS uid/gid on its "." entry, and a
# root extraction that applied it would leave git refusing the foreign-owned
# repository ("not in a git directory").
mkdir -p "$WORKSPACE_DIR"
tar --no-same-owner -xf "$ARCHIVE_PATH" -C "$WORKSPACE_DIR" 2>> "$RESULTS_DIR/stderr.txt"
if [ ! -d "$WORKSPACE_DIR/.git" ]; then
	git init -q "$WORKSPACE_DIR" 2>> "$RESULTS_DIR/stderr.txt"
	git -C "$WORKSPACE_DIR" config user.name "prime-agent-cloud"
	git -C "$WORKSPACE_DIR" config user.email "cloud@prime-agent.local"
	git -C "$WORKSPACE_DIR" add -A 2>> "$RESULTS_DIR/stderr.txt"
	git -C "$WORKSPACE_DIR" commit -q -m "cloud delegation baseline" 2>> "$RESULTS_DIR/stderr.txt"
fi
BASELINE="$(git -C "$WORKSPACE_DIR" rev-parse HEAD 2>> "$RESULTS_DIR/stderr.txt")"
chmod 600 "$AUTH_PATH" 2>> "$RESULTS_DIR/stderr.txt"
cp "$MANIFEST_PATH" "$RESULTS_DIR/workspace-manifest.json" 2>> "$RESULTS_DIR/stderr.txt"

# The uploaded bridge is always the resident process: it supervises the guest
# daemon (one resident session runtime: inference, tools, the Python kernel,
# and recursive children all execute in it), serves the session protocol on
# loopback when a tunnel forwards it, and owns the terminal results contract.
export PRIME_AGENT_CLOUD_GIT_BASELINE="$BASELINE"
exec "\${PRIME_AGENT_CLOUD_NODE_BIN:-node}" "\${PRIME_AGENT_CLOUD_BRIDGE_PATH:?bridge path is required}"
`;

/** Deterministic progress phases, in workflow order. */
export const CLOUD_DELEGATION_PHASES = [
	"capturing",
	"allocating",
	"provisioning",
	"waiting",
	"uploading",
	"starting",
	"running",
	"retrieving",
	"review",
	"released",
	"lost",
] as const;
export type CloudDelegationPhase = (typeof CLOUD_DELEGATION_PHASES)[number];

/** Derive the current phase from a durable record; pure and deterministic. */
export function cloudDelegationPhaseOf(record: CloudSessionRecord): CloudDelegationPhase {
	if (record.observedLifecycle === "deleted" || record.cleanupState === "released") {
		return "released";
	}
	if (record.observedLifecycle === "lost") {
		return "lost";
	}
	if (
		record.cleanupState === "imported" ||
		record.resultImportState === "available" ||
		record.resultImportState === "reviewed" ||
		record.resultImportState === "imported"
	) {
		return "review";
	}
	if (record.observedLifecycle === "running") {
		return "running";
	}
	if (record.observedLifecycle === "stopped") {
		return "retrieving";
	}
	if (record.sandboxId === undefined) {
		return "allocating";
	}
	return "provisioning";
}

/** Execution status of a delegated task. */
export type CloudDelegationStatus =
	| "provisioning"
	| "running"
	| "completed"
	| "failed"
	| "stopped"
	| "lost"
	| "uncertain"
	| "released";

/** Terminal outcome written by the bootstrap's status file. */
export type CloudDelegationOutcome = "completed" | "failed" | "stopped";

/** Terminal results of a delegated task, retrieved before any delete. */
export interface CloudDelegationTaskResult {
	outcome: CloudDelegationOutcome;
	stdout: string;
	stderr: string;
	/** `git diff --binary` output of the guest tree against the submitted baseline. */
	patch: Uint8Array;
	retrievedAt: string;
}

/** One progress event; emitted phases never regress within a call. */
export interface CloudDelegationProgress {
	sessionId: CloudSessionId;
	phase: CloudDelegationPhase;
	at: string;
	detail?: string;
}

export type CloudDelegationErrorCode =
	| "invalid_request"
	| "conflict"
	| "not_found"
	| "capture_failed"
	| "provision_failed"
	| "deadline_exceeded"
	| "too_large"
	| "upload_failed"
	| "start_failed"
	| "status_failed"
	| "signal_failed"
	| "results_unavailable"
	| "delete_failed"
	| "lost";

/** Typed, secret-safe error: the message never contains a secret. */
export class CloudDelegationError extends Error {
	readonly code: CloudDelegationErrorCode;

	constructor(code: CloudDelegationErrorCode, message: string, options: { cause?: unknown } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "CloudDelegationError";
		this.code = code;
	}
}

/**
 * Durable cloud-session record store. `CloudSessionStore` satisfies this
 * structurally; tests inject an in-memory fake with the same semantics.
 */
export interface CloudDelegationRecordStore {
	create(input: CloudSessionCreateInput): CloudSessionRecord;
	get(sessionId: string): CloudSessionRecord | undefined;
	setCreateIdempotencyKey(sessionId: string, idempotencyKey: string): CloudSessionRecord;
	setSandbox(sessionId: string, sandboxId: string, sandboxStatus?: PrimeSandboxStatus): CloudSessionRecord;
	setBaseline(sessionId: string, baseline: CloudSessionBaseline): CloudSessionRecord;
	setDeadline(sessionId: string, deadlineAt: string): CloudSessionRecord;
	setDesiredLifecycle(sessionId: string, desired: CloudDesiredLifecycle): CloudSessionRecord;
	setObservedLifecycle(sessionId: string, observed: CloudObservedLifecycle): CloudSessionRecord;
	setLastError(sessionId: string, error?: string): CloudSessionRecord;
	setCleanupState(sessionId: string, state: CloudCleanupState): CloudSessionRecord;
	setResultImportState(sessionId: string, state: CloudResultImportState): CloudSessionRecord;
	setTunnel(sessionId: string, tunnel: CloudSessionTunnel): CloudSessionRecord;
	setTunnelState(sessionId: string, state: CloudTunnelState): CloudSessionRecord;
}

/** Generic Prime Sandbox platform surface (`PrimeSandboxClient`-compatible). */
export interface CloudDelegationPlatformClient {
	createVmSandbox(request: PrimeSandboxVmCreateRequest): Promise<PrimeSandbox>;
	getSandbox(sandboxId: string): Promise<PrimeSandbox>;
	deleteSandbox(sandboxId: string): Promise<void>;
	getSandboxAuth(sandboxId: string): Promise<PrimeSandboxAuth>;
	uploadFile(
		sandboxId: string,
		request: PrimeSandboxUploadRequest,
		options?: PrimeSandboxGatewayOptions,
	): Promise<PrimeSandboxUploadResult>;
}

/** Observed state of a resident VM process. */
export type CloudDelegationVmProcessState =
	| { state: "unknown" }
	| { state: "starting" }
	| { state: "running" }
	| { state: "exited"; exitCode: number | null }
	| { state: "lost" };

/** Result of a create-or-attach process start. */
export interface CloudDelegationVmProcessHandle {
	sessionUuid: string;
	/** True when this call created the process; false when it attached to an existing one. */
	created: boolean;
}

/** Resident process start request: fixed argv, fixed-name env, persisted UUID. */
export interface CloudDelegationVmProcessStartRequest {
	sandboxId: string;
	/** Persisted resident process UUID; starts are create-or-attach. */
	sessionUuid: string;
	command: PrimeSandboxStartCommand;
	env: Record<string, string>;
}

/** Reconnectable VM process API. */
export interface CloudDelegationVmProcessClient {
	start(request: CloudDelegationVmProcessStartRequest): Promise<CloudDelegationVmProcessHandle>;
	/** Idempotent stop intent; resolves even when no process exists. */
	signalStop(sessionUuid: string): Promise<void>;
	status(sessionUuid: string): Promise<CloudDelegationVmProcessState>;
}

/** A locally captured workspace, ready for upload. */
export interface CloudDelegationCapturedWorkspace {
	/** Baseline provenance recorded durably before any platform call. */
	baseline: CloudSessionBaseline;
	archive: Uint8Array;
	manifest: Uint8Array;
	/** Aggregate submitted size (archive plus manifest) in bytes. */
	totalSizeBytes: number;
	/** Remove local staging state. */
	cleanup(): void;
}

/** Workspace capture and upload boundary. */
export interface CloudDelegationWorkspaceTransfer {
	/** Capture the workspace locally; runs before any platform call. */
	capture(request: { cwd: string }): Promise<CloudDelegationCapturedWorkspace>;
	/** Upload the captured archive and manifest into the sandbox. */
	upload(request: {
		sandboxId: string;
		archivePath: string;
		manifestPath: string;
		captured: CloudDelegationCapturedWorkspace;
	}): Promise<void>;
}

/** Terminal-result retrieval and durable local recording. */
export interface CloudDelegationResultsClient {
	/** Fetch terminal results; undefined while the guest has not written a terminal status. */
	fetch(sandboxId: string): Promise<CloudDelegationTaskResult | undefined>;
	/** Durably record retrieved results for local review. Idempotent. */
	save(request: { sessionId: string; result: CloudDelegationTaskResult }): Promise<void>;
}

/** Guest-level readiness beyond the platform RUNNING status. */
export interface CloudDelegationReadiness {
	isReady(sandbox: PrimeSandbox): Promise<boolean>;
}

/**
 * Prime Tunnel registration boundary (Direction A). The LOCAL daemon owns
 * tunnel lifecycle with the user's platform credentials; the guest receives
 * only this one tunnel's frp connection details.
 */
export interface CloudDelegationTunnelClient {
	/** Register a tunnel forwarding the edge to a guest loopback port. */
	register(request: {
		sessionId: string;
		guestPort: number;
		name?: string;
		teamId?: string;
		labels?: string[];
		httpUser?: string;
	}): Promise<CloudDelegationTunnelRegistration>;
	/** Delete one tunnel; idempotent. */
	delete(tunnelId: string): Promise<void>;
	/** Tunnel status; undefined when the registration no longer exists. */
	get(tunnelId: string): Promise<CloudDelegationTunnelInfo | undefined>;
}

/** Non-secret tunnel facts, safe to record on the cloud-session record. */
export interface CloudDelegationTunnelInfo {
	tunnelId: string;
	url: string;
	hostname: string;
	httpUser: string;
	expiresAt: string;
}

/** Registration result; every field except the non-secret facts is a secret. */
export interface CloudDelegationTunnelRegistration extends CloudDelegationTunnelInfo {
	/** One-time edge basic-auth password; persist durably, never log it. */
	httpPassword: string;
	frpServerHost: string;
	frpServerPort: number;
	/** frp connection token; valid only for this tunnel's frpc. */
	frpToken: string;
	bindingSecret: string;
}

/** Durable per-session tunnel secrets (bridge protocol token + edge password). */
export interface CloudDelegationTunnelSecrets {
	save(sessionId: string, secrets: { bridgeToken: string; httpPassword: string }): void;
	delete(sessionId: string): void;
}

/** Opt-in tunnel request on a delegation; off unless explicitly requested. */
export interface CloudDelegationTunnelRequest {
	/** Protocol authentication token the guest bridge will require on hello. */
	bridgeToken: string;
	/** Loopback port inside the sandbox frpc forwards the edge to. */
	guestPort: number;
	/** Edge basic-auth username; defaults to a fixed application name. */
	httpUser?: string;
	/** Team scope for the tunnel registration; defaults to the platform client's team. */
	teamId?: string;
}

/** Every external effect of a delegation, injected. */
export interface CloudDelegationBoundaries {
	store: CloudDelegationRecordStore;
	platform: CloudDelegationPlatformClient;
	process: CloudDelegationVmProcessClient;
	workspace: CloudDelegationWorkspaceTransfer;
	results: CloudDelegationResultsClient;
	readiness: CloudDelegationReadiness;
	/** Present only in daemon configurations that can register Prime Tunnels. */
	tunnel?: CloudDelegationTunnelClient;
	tunnelSecrets?: CloudDelegationTunnelSecrets;
}

/** Explicit sandbox resources; defaults differ across platform surfaces. */
export interface CloudDelegationSandboxSpec {
	dockerImage: string;
	cpuCores: number;
	memoryGb: number;
	diskSizeGb: number;
	/** Sandbox lifetime cap in minutes, covering the session plus the save window. */
	timeoutMinutes: number;
	idleTimeoutMinutes?: number;
	networkAllowlist?: string[];
	networkDenylist?: string[];
}

/** One delegated task. The same sessionId is the same logical task, forever. */
export interface CloudDelegationRequest {
	/** Logical task identity; a record under this id resumes instead of re-delegating. */
	sessionId?: string;
	parentSessionId?: string;
	prompt: string;
	cwd: string;
	/** Pre-captured durable input used for crash recovery; capture is skipped when supplied. */
	capturedWorkspace?: CloudDelegationCapturedWorkspace;
	/** Prime Agent model id (Prime Inference); empty means the image default. */
	model?: string;
	/** Prime Agent package spec installed in the image. */
	packageSpec?: string;
	sandbox: CloudDelegationSandboxSpec;
	/** Cloud inference credential; uploaded to the VM, never recorded. */
	inferenceCredential: string;
	/**
	 * Team the guest's inference requests bill to (X-Prime-Team-ID). Omitting
	 * it bills the guest credential's personal balance, which regularly has
	 * no funds and fails every request with 402.
	 */
	inferenceTeamId?: string;
	/** Opt in to a Prime Tunnel bridge for live steering; off by default. */
	tunnel?: CloudDelegationTunnelRequest;
}

export interface CloudDelegationOrchestratorOptions {
	/** Readiness poll interval in milliseconds; default 2000. */
	pollIntervalMs?: number;
	/** Budget for waiting on a signalled process in stop/forfeit; default 60000. */
	stopTimeoutMs?: number;
	/** Workspace capture size cap in bytes; default and maximum MAX_TRANSFER_BYTES. */
	maxWorkspaceBytes?: number;
	/** Minimum sandbox lifetime in minutes; default 10. */
	minTimeoutMinutes?: number;
	/** Maximum sandbox lifetime in minutes; default 1440. */
	maxTimeoutMinutes?: number;
	/** Injectable sleep for tests. */
	sleepFn?: (ms: number) => Promise<void>;
	/** Progress sink; phases are emitted in deterministic workflow order. */
	onProgress?: (progress: CloudDelegationProgress) => void;
}

/** Result of a delegate/stop/forfeit call. */
export interface CloudDelegationHandle {
	sessionId: CloudSessionId;
	sandboxId?: string;
	status: CloudDelegationStatus;
	/** Terminal results once retrieved. */
	results?: CloudDelegationTaskResult;
	/** Durable record snapshot after the call. */
	record: CloudSessionRecord;
}

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TERMINAL_SANDBOX_STATUSES: ReadonlySet<string> = new Set(["ERROR", "TERMINATED", "TIMEOUT"]);

/** A tunnel registered for this launch; carries the guest env to install. */
interface TunnelGrant {
	registration: CloudDelegationTunnelRegistration;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sameBaseline(a: CloudSessionBaseline, b: CloudSessionBaseline): boolean {
	return a.repoRoot === b.repoRoot && a.headCommit === b.headCommit && a.manifestDigest === b.manifestDigest;
}

/** Derive the sandbox create idempotency key from the logical identity. */
export function deriveCreateIdempotencyKey(sessionId: string, generation: number): string {
	const digest = createHash("sha256").update(`${sessionId}:${generation}`).digest("hex");
	return `cloud-${digest.slice(0, 48)}`;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-call progress emitter; refuses phase regressions, which are bugs. */
class CloudDelegationFlow {
	private lastIndex = -1;

	constructor(
		private readonly sessionId: string,
		private readonly onProgress: ((progress: CloudDelegationProgress) => void) | undefined,
	) {}

	progress(phase: CloudDelegationPhase, detail?: string): void {
		const index = CLOUD_DELEGATION_PHASES.indexOf(phase);
		if (index < this.lastIndex) {
			throw new Error(`cloud delegation phase regressed to ${phase} for session ${this.sessionId}`);
		}
		this.lastIndex = index;
		this.onProgress?.({
			sessionId: this.sessionId,
			phase,
			at: new Date().toISOString(),
			...(detail === undefined ? {} : { detail }),
		});
	}
}

/**
 * Orchestrates one delegated session per logical task. All state is durable
 * (the record store) or injected (the boundaries); the orchestrator itself
 * holds no per-session state beyond options.
 */
export class CloudDelegationOrchestrator {
	private readonly boundaries: CloudDelegationBoundaries;
	private readonly pollIntervalMs: number;
	private readonly stopTimeoutMs: number;
	private readonly maxWorkspaceBytes: number;
	private readonly minTimeoutMinutes: number;
	private readonly maxTimeoutMinutes: number;
	private readonly sleepFn: (ms: number) => Promise<void>;
	private readonly onProgress: ((progress: CloudDelegationProgress) => void) | undefined;

	constructor(boundaries: CloudDelegationBoundaries, options: CloudDelegationOrchestratorOptions = {}) {
		this.boundaries = boundaries;
		this.pollIntervalMs = requirePositiveInteger(
			options.pollIntervalMs ?? CLOUD_DELEGATION_DEFAULT_POLL_INTERVAL_MS,
			"pollIntervalMs",
		);
		this.stopTimeoutMs = requirePositiveInteger(
			options.stopTimeoutMs ?? CLOUD_DELEGATION_DEFAULT_STOP_TIMEOUT_MS,
			"stopTimeoutMs",
		);
		const maxWorkspaceBytes = requirePositiveInteger(
			options.maxWorkspaceBytes ?? MAX_TRANSFER_BYTES,
			"maxWorkspaceBytes",
		);
		if (maxWorkspaceBytes > MAX_TRANSFER_BYTES) {
			throw new CloudDelegationError(
				"invalid_request",
				`maxWorkspaceBytes must not exceed the ${MAX_TRANSFER_BYTES} byte gateway transfer limit`,
			);
		}
		this.maxWorkspaceBytes = maxWorkspaceBytes;
		this.minTimeoutMinutes = requirePositiveInteger(
			options.minTimeoutMinutes ?? CLOUD_DELEGATION_MIN_TIMEOUT_MINUTES,
			"minTimeoutMinutes",
		);
		this.maxTimeoutMinutes = requirePositiveInteger(
			options.maxTimeoutMinutes ?? CLOUD_DELEGATION_MAX_TIMEOUT_MINUTES,
			"maxTimeoutMinutes",
		);
		if (this.minTimeoutMinutes > this.maxTimeoutMinutes) {
			throw new CloudDelegationError("invalid_request", "minTimeoutMinutes must not exceed maxTimeoutMinutes");
		}
		this.sleepFn = options.sleepFn ?? defaultSleep;
		this.onProgress = options.onProgress;
	}

	/**
	 * Delegate a task, or resume an existing one when a record already exists
	 * under `request.sessionId`. The workspace is captured before any platform
	 * call; identities are preallocated and the record is created durably
	 * before the sandbox. A resume never duplicates the logical task: results
	 * and process status are checked before any attach or start.
	 */
	async delegate(request: CloudDelegationRequest): Promise<CloudDelegationHandle> {
		const sessionId = this.validateRequest(request);
		const secrets: string[] = [request.inferenceCredential];
		const flow = this.newFlow(sessionId);
		let captured: CloudDelegationCapturedWorkspace | undefined;
		try {
			flow.progress("capturing", "capturing the workspace before any platform call");
			captured = request.capturedWorkspace ?? (await this.captureWorkspace(request, secrets));
			this.validateWorkspaceSize(captured);
			const existing = this.boundaries.store.get(sessionId);
			if (existing !== undefined) {
				return await this.resume(existing, request, captured, secrets, flow);
			}
			return await this.launch(sessionId, request, captured, secrets, flow);
		} finally {
			if (captured !== undefined) {
				try {
					captured.cleanup();
				} catch {
					// Staging cleanup is best-effort; leftover temp directories are
					// owned by the OS temp cleaner, never by the record store.
				}
			}
		}
	}

	/**
	 * Stop intent: send the idempotent stop signal, wait for the resident
	 * process to settle, retrieve the results, and leave the sandbox in a
	 * review state. The sandbox is never deleted here; only an explicit
	 * forfeit releases compute.
	 */
	async stop(sessionId: string): Promise<CloudDelegationHandle> {
		const record = this.requireRecord(sessionId);
		const flow = this.newFlow(sessionId);
		if (record.observedLifecycle === "deleted") {
			return this.handle(record, "released");
		}
		flow.progress("retrieving", "checking for terminal results before signalling");
		const fetched = await this.tryFetchResults(record, []);
		if (fetched !== undefined) {
			return await this.importResults(record, fetched, flow, []);
		}
		if (record.desiredLifecycle === "provisioning" || record.desiredLifecycle === "running") {
			this.boundaries.store.setDesiredLifecycle(sessionId, "stopping");
		}
		await this.guarded("signal_failed", "sending the stop signal", sessionId, [], () =>
			this.boundaries.process.signalStop(record.residentProcessUuid),
		);
		const state = await this.awaitProcessTerminal(record.residentProcessUuid, sessionId);
		if (state.state === "lost") {
			const updated = this.boundaries.store.setObservedLifecycle(sessionId, "lost");
			this.safeSetLastError(sessionId, "the resident process was lost during stop");
			flow.progress("lost", "the resident process was lost during stop");
			return this.handle(updated, "lost");
		}
		if (state.state !== "exited") {
			this.safeSetLastError(sessionId, `the resident process remained ${state.state} after the stop timeout`);
			return this.handle(this.requireRecord(sessionId), "uncertain");
		}
		const settled = await this.tryFetchResults(record, []);
		if (settled !== undefined) {
			return await this.importResults(record, settled, flow, []);
		}
		const updated = this.boundaries.store.setObservedLifecycle(sessionId, "stopped");
		this.safeSetLastError(sessionId, "stop completed without a terminal result record");
		return this.handle(updated, "uncertain");
	}

	/**
	 * Explicit forfeit: give up the review flow and release the compute.
	 * Results are still retrieved first when the sandbox still has them, then
	 * the sandbox is deleted and the record is marked deleted.
	 */
	async forfeit(sessionId: string): Promise<CloudDelegationHandle> {
		const record = this.requireRecord(sessionId);
		const flow = this.newFlow(sessionId);
		if (record.observedLifecycle === "deleted") {
			return this.handle(record, "released");
		}
		try {
			await this.boundaries.process.signalStop(record.residentProcessUuid);
		} catch (error) {
			this.safeSetLastError(sessionId, this.redactMessage(`stop signal failed: ${errorMessage(error)}`, []));
		}
		if (record.desiredLifecycle !== "stopping" && record.desiredLifecycle !== "deleted") {
			this.boundaries.store.setDesiredLifecycle(sessionId, "stopping");
		}
		// Best-effort retrieval before the delete: output and patch first.
		let result: CloudDelegationTaskResult | undefined;
		try {
			result = record.sandboxId === undefined ? undefined : await this.boundaries.results.fetch(record.sandboxId);
			if (result !== undefined) {
				await this.boundaries.results.save({ sessionId, result });
			}
		} catch (error) {
			this.safeSetLastError(sessionId, this.redactMessage(`result retrieval failed: ${errorMessage(error)}`, []));
		}
		this.boundaries.store.setResultImportState(sessionId, "skipped");
		this.boundaries.store.setCleanupState(sessionId, "releasing");
		const sandboxId = record.sandboxId;
		if (sandboxId !== undefined) {
			await this.guarded("delete_failed", "deleting the sandbox", sessionId, [], () =>
				this.boundaries.platform.deleteSandbox(sandboxId),
			);
		}
		this.boundaries.store.setCleanupState(sessionId, "released");
		this.boundaries.store.setDesiredLifecycle(sessionId, "deleted");
		const updated = this.boundaries.store.setObservedLifecycle(sessionId, "deleted");
		flow.progress("released", "the review was forfeited and the sandbox deleted");
		return this.handle(updated, result !== undefined ? result.outcome : "uncertain", result);
	}

	private validateRequest(request: CloudDelegationRequest): CloudSessionId {
		const sessionId = request.sessionId ?? newCloudSessionId();
		if (request.sessionId !== undefined && !SESSION_ID_PATTERN.test(request.sessionId)) {
			throw new CloudDelegationError(
				"invalid_request",
				"sessionId must match sess_[A-Za-z0-9][A-Za-z0-9._-]{0,127}",
			);
		}
		if (request.parentSessionId !== undefined) {
			requireBoundedString(request.parentSessionId, "parentSessionId", CLOUD_MAX_ID_CHARS);
		}
		requireBoundedString(request.prompt, "prompt", CLOUD_MAX_PROMPT_CHARS);
		requireBoundedString(request.cwd, "cwd", 4096);
		if (request.model !== undefined) {
			requireBoundedString(request.model, "model", CLOUD_MAX_MODEL_ID_CHARS);
		}
		if (request.packageSpec !== undefined) {
			requireBoundedString(request.packageSpec, "packageSpec", CLOUD_DELEGATION_MAX_PACKAGE_CHARS);
		}
		requireBoundedString(request.inferenceCredential, "inferenceCredential", CLOUD_DELEGATION_MAX_CREDENTIAL_CHARS);
		const spec = request.sandbox;
		requireBoundedString(spec.dockerImage, "sandbox.dockerImage", 256);
		if (/\s/.test(spec.dockerImage)) {
			throw new CloudDelegationError("invalid_request", "sandbox.dockerImage must be whitespace-free");
		}
		validateResourceRange("sandbox.cpuCores", spec.cpuCores, 0.1, 16);
		validateResourceRange("sandbox.memoryGb", spec.memoryGb, 0.1, 64);
		validateResourceRange("sandbox.diskSizeGb", spec.diskSizeGb, 0.1, 1000);
		if (
			!Number.isInteger(spec.timeoutMinutes) ||
			spec.timeoutMinutes < this.minTimeoutMinutes ||
			spec.timeoutMinutes > this.maxTimeoutMinutes
		) {
			throw new CloudDelegationError(
				"invalid_request",
				`sandbox.timeoutMinutes must be an integer from ${this.minTimeoutMinutes} to ${this.maxTimeoutMinutes}`,
			);
		}
		if (spec.idleTimeoutMinutes !== undefined) {
			if (!Number.isInteger(spec.idleTimeoutMinutes) || spec.idleTimeoutMinutes < 1) {
				throw new CloudDelegationError("invalid_request", "sandbox.idleTimeoutMinutes must be a positive integer");
			}
			if (spec.idleTimeoutMinutes > spec.timeoutMinutes) {
				throw new CloudDelegationError(
					"invalid_request",
					"sandbox.idleTimeoutMinutes must not exceed sandbox.timeoutMinutes",
				);
			}
		}
		if (spec.networkAllowlist !== undefined && spec.networkDenylist !== undefined) {
			throw new CloudDelegationError(
				"invalid_request",
				"sandbox.networkAllowlist and sandbox.networkDenylist are mutually exclusive",
			);
		}
		for (const [field, entries] of [
			["sandbox.networkAllowlist", spec.networkAllowlist],
			["sandbox.networkDenylist", spec.networkDenylist],
		] as const) {
			if (entries !== undefined) {
				for (const entry of entries) {
					requireBoundedString(entry, field, 256);
				}
			}
		}
		return sessionId;
	}

	private captureWorkspace(
		request: CloudDelegationRequest,
		secrets: readonly string[],
	): Promise<CloudDelegationCapturedWorkspace> {
		return this.guarded("capture_failed", "workspace capture", undefined, secrets, () =>
			this.boundaries.workspace.capture({ cwd: request.cwd }),
		);
	}

	private validateWorkspaceSize(captured: CloudDelegationCapturedWorkspace): void {
		if (captured.totalSizeBytes > this.maxWorkspaceBytes) {
			throw new CloudDelegationError(
				"too_large",
				`workspace capture of ${captured.totalSizeBytes} bytes exceeds the ${this.maxWorkspaceBytes} byte delegation limit`,
			);
		}
		if (captured.archive.byteLength > MAX_TRANSFER_BYTES) {
			throw new CloudDelegationError(
				"too_large",
				`workspace archive of ${captured.archive.byteLength} bytes exceeds the ${MAX_TRANSFER_BYTES} byte transfer limit`,
			);
		}
		if (!isCloudDigest(captured.baseline.manifestDigest)) {
			throw new CloudDelegationError("invalid_request", "captured baseline manifestDigest is not a sha256 digest");
		}
	}

	private async launch(
		sessionId: CloudSessionId,
		request: CloudDelegationRequest,
		captured: CloudDelegationCapturedWorkspace,
		secrets: string[],
		flow: CloudDelegationFlow,
	): Promise<CloudDelegationHandle> {
		flow.progress("allocating", "recording the durable cloud-session record");
		const record = this.boundaries.store.create({
			sessionId,
			...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
			residentProcessUuid: randomUUID(),
		});
		this.boundaries.store.setBaseline(sessionId, captured.baseline);
		const deadlineAt = new Date(Date.parse(record.createdAt) + request.sandbox.timeoutMinutes * 60_000).toISOString();
		this.boundaries.store.setDeadline(sessionId, deadlineAt);
		this.boundaries.store.setCreateIdempotencyKey(
			sessionId,
			deriveCreateIdempotencyKey(sessionId, record.generation),
		);
		return this.continueLaunch(this.requireRecord(sessionId), request, captured, secrets, flow);
	}

	/**
	 * Resume an existing delegation. Results are checked first, then the
	 * process status; only an unknown process falls through to the launch
	 * pipeline, whose create-or-attach start cannot duplicate the task.
	 */
	private async resume(
		record: CloudSessionRecord,
		request: CloudDelegationRequest,
		captured: CloudDelegationCapturedWorkspace,
		secrets: string[],
		flow: CloudDelegationFlow,
	): Promise<CloudDelegationHandle> {
		const sessionId = record.sessionId;
		if (record.observedLifecycle === "deleted") {
			return this.handle(record, "released");
		}
		if (record.observedLifecycle === "lost") {
			return this.handle(record, "lost");
		}
		const fetched = await this.tryFetchResults(record, secrets);
		if (fetched !== undefined) {
			return await this.importResults(record, fetched, flow, secrets);
		}
		if (record.desiredLifecycle === "stopping") {
			return this.handle(record, "uncertain");
		}
		if (record.baseline !== undefined && !sameBaseline(record.baseline, captured.baseline)) {
			const message = "the workspace changed since this delegation was recorded; start a new delegation instead";
			this.safeSetLastError(sessionId, message);
			throw new CloudDelegationError("conflict", message);
		}
		if (record.baseline === undefined) {
			this.boundaries.store.setBaseline(sessionId, captured.baseline);
		}
		const state = await this.processStatus(record, secrets);
		if (state.state === "running" || state.state === "starting") {
			this.boundaries.store.setObservedLifecycle(sessionId, "running");
			const updated = this.boundaries.store.setDesiredLifecycle(sessionId, "running");
			flow.progress("running", "the resident process is running; attached without starting");
			return this.handle(updated, "running");
		}
		if (state.state === "exited") {
			const settled = await this.tryFetchResults(record, secrets);
			if (settled !== undefined) {
				return await this.importResults(record, settled, flow, secrets);
			}
			const updated = this.boundaries.store.setObservedLifecycle(sessionId, "stopped");
			this.safeSetLastError(sessionId, "the resident process exited without terminal results");
			return this.handle(updated, "uncertain");
		}
		if (state.state === "lost") {
			const updated = this.boundaries.store.setObservedLifecycle(sessionId, "lost");
			this.safeSetLastError(sessionId, "the resident process was lost without terminal results");
			flow.progress("lost", "the resident process was lost without terminal results");
			return this.handle(updated, "lost");
		}
		return this.continueLaunch(this.requireRecord(sessionId), request, captured, secrets, flow);
	}

	/** Create-or-reconcile the sandbox, wait for readiness, upload, start once. */
	private async continueLaunch(
		record: CloudSessionRecord,
		request: CloudDelegationRequest,
		captured: CloudDelegationCapturedWorkspace,
		secrets: string[],
		flow: CloudDelegationFlow,
	): Promise<CloudDelegationHandle> {
		const sessionId = record.sessionId;
		flow.progress("provisioning", "ensuring the sandbox exists");
		const sandbox = await this.ensureSandbox(record, request.sandbox, secrets);
		flow.progress("waiting", "waiting for sandbox readiness");
		const deadlineAt =
			record.deadlineAt ?? new Date(Date.now() + request.sandbox.timeoutMinutes * 60_000).toISOString();
		const ready = await this.waitForReady(record, sandbox.id, deadlineAt, secrets);
		if (this.requireRecord(sessionId).desiredLifecycle === "stopping") {
			return this.handle(this.requireRecord(sessionId), "uncertain");
		}
		let tunnelGrant: TunnelGrant | undefined;
		if (request.tunnel !== undefined) {
			flow.progress("waiting", "registering the Prime Tunnel for live steering");
			tunnelGrant = await this.ensureTunnel(record, request.tunnel, secrets);
			secrets.push(tunnelGrant.registration.httpPassword, request.tunnel.bridgeToken);
		}
		try {
			flow.progress("uploading", "uploading bootstrap, prompt, credential, and workspace");
			await this.uploadInputs(ready.id, record, request, captured, secrets);
			if (this.requireRecord(sessionId).desiredLifecycle === "stopping") {
				return this.handle(this.requireRecord(sessionId), "uncertain");
			}
			flow.progress("starting", "starting the resident process");
			await this.startResident(record, request, ready.id, secrets, tunnelGrant);
		} catch (error) {
			// A registered tunnel must not outlive a failed launch.
			if (tunnelGrant !== undefined) await this.releaseTunnel(record.sessionId, tunnelGrant.registration, secrets);
			throw error;
		}
		this.boundaries.store.setObservedLifecycle(sessionId, "running");
		try {
			this.boundaries.store.setDesiredLifecycle(sessionId, "running");
		} catch (error) {
			if (this.requireRecord(sessionId).desiredLifecycle !== "stopping") throw error;
			return await this.stop(sessionId);
		}
		const updated = this.requireRecord(sessionId);
		if (updated.desiredLifecycle === "stopping") return await this.stop(sessionId);
		flow.progress("running", "the resident process is running");
		return this.handle(updated, "running");
	}

	private async ensureTunnel(
		record: CloudSessionRecord,
		request: CloudDelegationTunnelRequest,
		secrets: readonly string[],
	): Promise<TunnelGrant> {
		const tunnel = this.boundaries.tunnel;
		const tunnelSecrets = this.boundaries.tunnelSecrets;
		if (tunnel === undefined || tunnelSecrets === undefined) {
			throw new CloudDelegationError(
				"invalid_request",
				"tunnel delegation was requested but this daemon has no Prime Tunnel client configured",
			);
		}
		const guestPortProblem =
			!Number.isInteger(request.guestPort) || request.guestPort < 1 || request.guestPort > 65535
				? "tunnel.guestPort must be an integer from 1 to 65535"
				: request.bridgeToken.length < 16 || request.bridgeToken.length > 256 || request.bridgeToken.includes("\0")
					? "tunnel.bridgeToken must be a NUL-free string of 16-256 characters"
					: undefined;
		if (guestPortProblem !== undefined) {
			throw new CloudDelegationError("invalid_request", guestPortProblem);
		}
		// A new incarnation needs fresh frp connection details in its environment,
		// so a stale tunnel from an earlier incarnation is released first.
		if (record.tunnel !== undefined && record.tunnelState !== "released") {
			await this.releaseTunnel(record.sessionId, record.tunnel, secrets);
		}
		const registration = await this.guarded(
			"provision_failed",
			"registering the Prime Tunnel",
			record.sessionId,
			secrets,
			() =>
				tunnel.register({
					sessionId: record.sessionId,
					guestPort: request.guestPort,
					name: `prime-agent-${record.sessionId}`,
					...(request.teamId === undefined ? {} : { teamId: request.teamId }),
					labels: ["prime-agent-cloud", `session:${record.sessionId}`],
					...(request.httpUser === undefined ? { httpUser: "prime-agent" } : { httpUser: request.httpUser }),
				}),
		);
		secrets = [
			...secrets,
			registration.httpPassword,
			registration.frpToken,
			registration.bindingSecret,
			request.bridgeToken,
		];
		tunnelSecrets.save(record.sessionId, {
			bridgeToken: request.bridgeToken,
			httpPassword: registration.httpPassword,
		});
		this.boundaries.store.setTunnel(record.sessionId, {
			tunnelId: registration.tunnelId,
			url: registration.url,
			hostname: registration.hostname,
			httpUser: registration.httpUser,
			expiresAt: registration.expiresAt,
			registeredAt: new Date().toISOString(),
		});
		return { registration };
	}

	/** Delete the tunnel registration and mark it released; idempotent, best-effort. */
	private async releaseTunnel(
		sessionId: string,
		tunnel: { tunnelId: string },
		secrets: readonly string[],
	): Promise<void> {
		const client = this.boundaries.tunnel;
		try {
			if (client !== undefined) {
				await client.delete(tunnel.tunnelId);
			}
		} catch (error) {
			this.safeSetLastError(sessionId, this.redactMessage(`tunnel release failed: ${errorMessage(error)}`, secrets));
		}
		try {
			this.boundaries.store.setTunnelState(sessionId, "released");
		} catch {
			// Already released is the common case; anything else is a record issue.
		}
		this.boundaries.tunnelSecrets?.delete(sessionId);
	}

	private async ensureSandbox(
		record: CloudSessionRecord,
		spec: CloudDelegationSandboxSpec,
		secrets: readonly string[],
	): Promise<PrimeSandbox> {
		const sessionId = record.sessionId;
		const sandboxId = record.sandboxId;
		if (sandboxId !== undefined) {
			const sandbox = await this.guarded(
				"provision_failed",
				`fetching sandbox ${sandboxId}`,
				sessionId,
				secrets,
				() => this.boundaries.platform.getSandbox(sandboxId),
			);
			if (TERMINAL_SANDBOX_STATUSES.has(sandbox.status)) {
				this.boundaries.store.setObservedLifecycle(sessionId, "lost");
				this.safeSetLastError(sessionId, `sandbox ${sandboxId} reached terminal status ${sandbox.status}`);
				throw new CloudDelegationError("lost", `sandbox ${sandboxId} reached terminal status ${sandbox.status}`);
			}
			this.boundaries.store.setSandbox(sessionId, sandbox.id, sandbox.status);
			return sandbox;
		}
		const idempotencyKey = record.createIdempotencyKey ?? deriveCreateIdempotencyKey(sessionId, record.generation);
		const sandbox = await this.guarded("provision_failed", "creating the VM sandbox", sessionId, secrets, () =>
			this.boundaries.platform.createVmSandbox(this.createSandboxRequest(sessionId, spec, idempotencyKey)),
		);
		this.boundaries.store.setSandbox(sessionId, sandbox.id, sandbox.status);
		return sandbox;
	}

	private createSandboxRequest(
		sessionId: string,
		spec: CloudDelegationSandboxSpec,
		idempotencyKey: string,
	): PrimeSandboxVmCreateRequest {
		return {
			name: `prime-agent-${sessionId}`,
			dockerImage: spec.dockerImage,
			cpuCores: spec.cpuCores,
			memoryGb: spec.memoryGb,
			diskSizeGb: spec.diskSizeGb,
			timeoutMinutes: spec.timeoutMinutes,
			...(spec.idleTimeoutMinutes === undefined ? {} : { idleTimeoutMinutes: spec.idleTimeoutMinutes }),
			...(spec.networkAllowlist === undefined ? {} : { networkAllowlist: spec.networkAllowlist }),
			...(spec.networkDenylist === undefined ? {} : { networkDenylist: spec.networkDenylist }),
			labels: ["prime-agent-cloud", `session:${sessionId}`],
			idempotencyKey,
		};
	}

	/** Platform RUNNING status plus the injected guest readiness check. */
	private async waitForReady(
		record: CloudSessionRecord,
		sandboxId: string,
		deadlineAt: string,
		secrets: readonly string[],
	): Promise<PrimeSandbox> {
		const sessionId = record.sessionId;
		for (;;) {
			const sandbox = await this.guarded(
				"provision_failed",
				`fetching sandbox ${sandboxId}`,
				sessionId,
				secrets,
				() => this.boundaries.platform.getSandbox(sandboxId),
			);
			if (TERMINAL_SANDBOX_STATUSES.has(sandbox.status)) {
				this.boundaries.store.setObservedLifecycle(sessionId, "lost");
				this.safeSetLastError(sessionId, `sandbox ${sandboxId} reached terminal status ${sandbox.status}`);
				throw new CloudDelegationError("lost", `sandbox ${sandboxId} reached terminal status ${sandbox.status}`);
			}
			if (sandbox.status === "RUNNING") {
				this.boundaries.store.setSandbox(sessionId, sandbox.id, sandbox.status);
				const ready = await this.guarded("provision_failed", "sandbox readiness check", sessionId, secrets, () =>
					this.boundaries.readiness.isReady(sandbox),
				);
				if (ready) {
					return sandbox;
				}
			}
			if (Date.now() >= Date.parse(deadlineAt)) {
				throw new CloudDelegationError(
					"deadline_exceeded",
					`sandbox ${sandboxId} was not ready before the session deadline`,
				);
			}
			await this.sleepFn(this.pollIntervalMs);
		}
	}

	private async uploadInputs(
		sandboxId: string,
		record: CloudSessionRecord,
		request: CloudDelegationRequest,
		captured: CloudDelegationCapturedWorkspace,
		secrets: string[],
	): Promise<void> {
		const sessionId = record.sessionId;
		const auth = await this.guarded("upload_failed", "fetching sandbox gateway credentials", sessionId, secrets, () =>
			this.boundaries.platform.getSandboxAuth(sandboxId),
		);
		secrets.push(auth.token);
		await this.guarded("upload_failed", "uploading the workspace archive", sessionId, secrets, () =>
			this.boundaries.workspace.upload({
				sandboxId,
				archivePath: CLOUD_GUEST_ARCHIVE_PATH,
				manifestPath: CLOUD_GUEST_MANIFEST_PATH,
				captured,
			}),
		);
		const uploads: Array<{ path: string; filename: string; content: Uint8Array }> = [
			{
				path: CLOUD_GUEST_BOOTSTRAP_PATH,
				filename: "bootstrap.sh",
				content: new TextEncoder().encode(CLOUD_DELEGATION_BOOTSTRAP_SCRIPT),
			},
			{ path: CLOUD_GUEST_PROMPT_PATH, filename: "prompt.txt", content: new TextEncoder().encode(request.prompt) },
			// The inference credential is uploaded last and never recorded.
			{
				path: CLOUD_GUEST_AUTH_PATH,
				filename: "inference.token",
				content: new TextEncoder().encode(request.inferenceCredential),
			},
		];
		// The bridge is always uploaded: it is the resident process that
		// supervises the guest daemon, with or without a tunnel.
		uploads.push({
			path: CLOUD_GUEST_BRIDGE_PATH,
			filename: "bridge-server.mjs",
			content: new TextEncoder().encode(CLOUD_GUEST_BRIDGE_SCRIPT),
		});
		for (const upload of uploads) {
			await this.guarded("upload_failed", `uploading ${upload.path}`, sessionId, secrets, () =>
				this.boundaries.platform.uploadFile(
					sandboxId,
					{ path: upload.path, filename: upload.filename, content: upload.content },
					{ auth },
				),
			);
		}
	}

	private buildProcessEnv(
		record: CloudSessionRecord,
		request: CloudDelegationRequest,
		tunnelGrant: TunnelGrant | undefined,
	): Record<string, string> {
		const env: Record<string, string> = {
			[CLOUD_DELEGATION_ENV_KEYS.sessionId]: record.sessionId,
			[CLOUD_DELEGATION_ENV_KEYS.generation]: String(record.generation),
			[CLOUD_DELEGATION_ENV_KEYS.workspaceDir]: CLOUD_GUEST_WORKSPACE_DIR,
			[CLOUD_DELEGATION_ENV_KEYS.archivePath]: CLOUD_GUEST_ARCHIVE_PATH,
			[CLOUD_DELEGATION_ENV_KEYS.manifestPath]: CLOUD_GUEST_MANIFEST_PATH,
			[CLOUD_DELEGATION_ENV_KEYS.promptPath]: CLOUD_GUEST_PROMPT_PATH,
			[CLOUD_DELEGATION_ENV_KEYS.authPath]: CLOUD_GUEST_AUTH_PATH,
			[CLOUD_DELEGATION_ENV_KEYS.resultsDir]: CLOUD_GUEST_RESULTS_DIR,
			[CLOUD_DELEGATION_ENV_KEYS.agentBin]: "prime-agent",
			[CLOUD_DELEGATION_ENV_KEYS.model]: request.model ?? "",
			[CLOUD_DELEGATION_ENV_KEYS.pkg]: request.packageSpec ?? "",
			// The bridge is always the resident process and always supervises
			// the guest daemon; a tunnel only decides whether frpc forwards it.
			[CLOUD_DELEGATION_ENV_KEYS.bridgeEnabled]: "1",
			[CLOUD_DELEGATION_ENV_KEYS.bridgePath]: CLOUD_GUEST_BRIDGE_PATH,
			// Without a tunnel the protocol surface is unreachable from outside the VM,
			// but the daemon still requires a token: a fresh per-launch secret.
			[CLOUD_DELEGATION_ENV_KEYS.bridgeToken]: request.tunnel?.bridgeToken ?? `cloud_${randomUUID()}`,
			[CLOUD_DELEGATION_ENV_KEYS.bridgeStateDir]: CLOUD_GUEST_BRIDGE_STATE_DIR,
			[CLOUD_DELEGATION_ENV_KEYS.bridgeNodeBin]: "node",
			[CLOUD_DELEGATION_ENV_KEYS.daemonSocket]: CLOUD_GUEST_DAEMON_SOCKET,
			[CLOUD_DELEGATION_ENV_KEYS.daemonArgv]: CLOUD_GUEST_DAEMON_ARGV_JSON,
			[CLOUD_DELEGATION_ENV_KEYS.daemonAgentDir]: CLOUD_GUEST_AGENT_DIR,
			[CLOUD_DELEGATION_ENV_KEYS.daemonStateDir]: CLOUD_GUEST_DAEMON_STATE_DIR,
			[CLOUD_DELEGATION_ENV_KEYS.daemonStatusFile]: `${CLOUD_GUEST_DAEMON_STATE_DIR}/daemon-status.json`,
		};
		if (request.inferenceTeamId !== undefined) {
			env[CLOUD_DELEGATION_ENV_KEYS.inferenceTeamId] = request.inferenceTeamId;
		}
		if (tunnelGrant !== undefined && request.tunnel !== undefined) {
			const registration = tunnelGrant.registration;
			env[CLOUD_DELEGATION_ENV_KEYS.bridgePort] = String(request.tunnel.guestPort);
			env[CLOUD_DELEGATION_ENV_KEYS.bridgeToken] = request.tunnel.bridgeToken;
			env[CLOUD_DELEGATION_ENV_KEYS.frpcBin] = "frpc";
			env[CLOUD_DELEGATION_ENV_KEYS.tunnelId] = registration.tunnelId;
			env[CLOUD_DELEGATION_ENV_KEYS.tunnelFrpServerHost] = registration.frpServerHost;
			env[CLOUD_DELEGATION_ENV_KEYS.tunnelFrpServerPort] = String(registration.frpServerPort);
			env[CLOUD_DELEGATION_ENV_KEYS.tunnelFrpToken] = registration.frpToken;
			env[CLOUD_DELEGATION_ENV_KEYS.tunnelBindingSecret] = registration.bindingSecret;
		}
		for (const [key, value] of Object.entries(env)) {
			if (value.includes("\0")) {
				throw new CloudDelegationError("invalid_request", `process env ${key} must be NUL-free`);
			}
		}
		return env;
	}

	private async startResident(
		record: CloudSessionRecord,
		request: CloudDelegationRequest,
		sandboxId: string,
		secrets: readonly string[],
		tunnelGrant: TunnelGrant | undefined,
	): Promise<void> {
		const env = this.buildProcessEnv(record, request, tunnelGrant);
		await this.guarded("start_failed", "starting the resident process", record.sessionId, secrets, () =>
			this.boundaries.process.start({
				sandboxId,
				sessionUuid: record.residentProcessUuid,
				command: CLOUD_DELEGATION_START_COMMAND,
				env,
			}),
		);
	}

	private processStatus(
		record: CloudSessionRecord,
		secrets: readonly string[],
	): Promise<CloudDelegationVmProcessState> {
		return this.guarded("status_failed", "resident process status", record.sessionId, secrets, () =>
			this.boundaries.process.status(record.residentProcessUuid),
		);
	}

	private async awaitProcessTerminal(sessionUuid: string, sessionId: string): Promise<CloudDelegationVmProcessState> {
		const deadline = Date.now() + this.stopTimeoutMs;
		for (;;) {
			const state = await this.guarded("status_failed", "resident process status", sessionId, [], () =>
				this.boundaries.process.status(sessionUuid),
			);
			if (state.state === "exited" || state.state === "lost") {
				return state;
			}
			if (Date.now() >= deadline) {
				return state;
			}
			await this.sleepFn(this.pollIntervalMs);
		}
	}

	private async tryFetchResults(
		record: CloudSessionRecord,
		secrets: readonly string[],
	): Promise<CloudDelegationTaskResult | undefined> {
		if (record.sandboxId === undefined) {
			return undefined;
		}
		try {
			return await this.boundaries.results.fetch(record.sandboxId);
		} catch (error) {
			this.safeSetLastError(
				record.sessionId,
				this.redactMessage(`result fetch failed: ${errorMessage(error)}`, secrets),
			);
			return undefined;
		}
	}

	/** Save results locally and leave the sandbox in the review state. */
	private async importResults(
		record: CloudSessionRecord,
		result: CloudDelegationTaskResult,
		flow: CloudDelegationFlow,
		secrets: readonly string[],
	): Promise<CloudDelegationHandle> {
		const sessionId = record.sessionId;
		flow.progress("retrieving", "terminal results are available; importing them for review");
		await this.guarded("results_unavailable", "saving retrieved results", sessionId, secrets, () =>
			this.boundaries.results.save({ sessionId, result }),
		);
		this.boundaries.store.setResultImportState(sessionId, "available");
		this.boundaries.store.setCleanupState(sessionId, "imported");
		if (record.observedLifecycle === "running" || record.observedLifecycle === "provisioning") {
			this.boundaries.store.setObservedLifecycle(sessionId, "stopped");
		}
		let updated = this.requireRecord(sessionId);
		if (updated.desiredLifecycle === "provisioning" || updated.desiredLifecycle === "running") {
			updated = this.boundaries.store.setDesiredLifecycle(sessionId, "stopping");
		}
		flow.progress("review", "results retrieved; the sandbox is retained for review");
		return this.handle(updated, result.outcome, result);
	}

	private requireRecord(sessionId: string): CloudSessionRecord {
		const record = this.boundaries.store.get(sessionId);
		if (record === undefined) {
			throw new CloudDelegationError("not_found", `unknown cloud session: ${sessionId}`);
		}
		return record;
	}

	private handle(
		record: CloudSessionRecord,
		status: CloudDelegationStatus,
		results?: CloudDelegationTaskResult,
	): CloudDelegationHandle {
		return {
			sessionId: record.sessionId,
			...(record.sandboxId === undefined ? {} : { sandboxId: record.sandboxId }),
			status,
			...(results === undefined ? {} : { results }),
			record: JSON.parse(JSON.stringify(record)) as CloudSessionRecord,
		};
	}

	private async guarded<T>(
		code: CloudDelegationErrorCode,
		context: string,
		sessionId: string | undefined,
		secrets: readonly string[],
		call: () => Promise<T>,
	): Promise<T> {
		try {
			return await call();
		} catch (error) {
			if (error instanceof CloudDelegationError) {
				throw error;
			}
			const message = this.redactMessage(`${context} failed: ${errorMessage(error)}`, secrets);
			if (sessionId !== undefined) {
				this.safeSetLastError(sessionId, message);
			}
			throw new CloudDelegationError(code, message, { cause: error });
		}
	}

	/** Redact known secrets and bound the length to the record's error budget. */
	private redactMessage(message: string, secrets: readonly string[]): string {
		let redacted = message;
		for (const secret of secrets) {
			if (secret.length > 0) {
				redacted = redacted.split(secret).join("[redacted]");
			}
		}
		if (redacted.length > CLOUD_MAX_ERROR_CHARS) {
			redacted = `${redacted.slice(0, CLOUD_MAX_ERROR_CHARS - 1)}…`;
		}
		return redacted;
	}

	private safeSetLastError(sessionId: string, message: string): void {
		try {
			this.boundaries.store.setLastError(sessionId, message);
		} catch {
			// A failing record write must not mask the original failure; the
			// durable record stays at its last persisted state.
		}
	}

	private newFlow(sessionId: string): CloudDelegationFlow {
		return new CloudDelegationFlow(sessionId, this.onProgress);
	}
}

function requirePositiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value <= 0) {
		throw new CloudDelegationError("invalid_request", `${name} must be a positive integer`);
	}
	return value;
}

function requireBoundedString(value: unknown, name: string, maxLength: number, minLength = 1): void {
	if (typeof value !== "string" || value.length < minLength || value.length > maxLength || value.includes("\0")) {
		throw new CloudDelegationError(
			"invalid_request",
			`${name} must be a NUL-free string of ${minLength}-${maxLength} characters`,
		);
	}
}

function validateResourceRange(field: string, value: number, min: number, max: number): void {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
		throw new CloudDelegationError("invalid_request", `${field} must be a finite number from ${min} to ${max}`);
	}
}
