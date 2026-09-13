import type { KernelBootstrapProgressHandler, KernelPythonSkill } from "./bootstrap.js";
import type { RestoreResult, SnapshotResult } from "./state-snapshot.js";

/**
 * Handles one typed request from Python code running in the kernel.
 * The returned record is delivered verbatim to the Python caller.
 */
export type HostRequestHandler = (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Host request handlers keyed by request type (e.g. "rlm.run", "goal.complete"). */
export type HostRequestHandlers = Record<string, HostRequestHandler>;

/** Where and how to persist the kernel's user namespace so it survives resume. */
export interface KernelSnapshotConfig {
	/** Absolute path for the dill payload. */
	path: string;
	/** Absolute path for the JSON manifest written alongside the payload. */
	manifestPath: string;
	/** Maximum aggregate snapshot size. Default 256 MiB. */
	maxBytes?: number;
	/** Maximum serialized size of one variable. Default 16 MiB. */
	maxVariableBytes?: number;
	/** Debounce window for the auto-snapshot after a successful execution. Default 1500 ms. */
	debounceMs?: number;
}

export interface KernelManagerOptions {
	/** Python interpreter with the kernel runtime available. Defaults to the auto-bootstrapped kernel. */
	python?: string;
	cwd?: string;
	env?: Record<string, string>;
	sessionId?: string;
	hostHandlers?: HostRequestHandlers;
	pythonSkills?: readonly KernelPythonSkill[];
	/** Persist/revive the user namespace across kernel restarts and session resume. */
	snapshot?: KernelSnapshotConfig;
	/** Runtime bootstrap re-run on a protocol-repaired kernel so live handles (rlm, bash, skills) exist again. */
	bootstrapCode?: string;
	/** File receiving the kernel process's stderr, rotated once at each spawn. */
	stderrLogPath?: string;
}

export interface KernelStartOptions {
	onBootstrapProgress?: KernelBootstrapProgressHandler;
	signal?: AbortSignal;
}

export interface ExecuteOptions {
	/** Aborting interrupts the kernel out-of-band. */
	signal?: AbortSignal;
	onStream?: (chunk: string, name: "stdout" | "stderr") => void;
	onLateSentAgentMessage?: (message: KernelSentAgentMessage) => void;
	/** Cap stdout / stderr / result at this many characters. Default 65536. */
	maxOutputChars?: number;
	/** Synthetic host cell (snapshot/restore/list); excluded from lastCellCode attribution. */
	internal?: boolean;
	/** The protocol repair's own restore; exempt from waiting on the repair it belongs to. */
	protocolRepair?: boolean;
}

/** One file edit, captured from a {@link DIFF_DISPLAY_MIME} display payload. */
export interface KernelDiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	/** 1-based line where `oldStr` begins in the file, for absolute line numbers. */
	startLine?: number;
}

/** One media attachment, captured from an {@link ATTACHMENT_DISPLAY_MIME} display payload. */
export interface KernelAttachment {
	mimeType: string;
	/** base64-encoded bytes. */
	data: string;
	/** Source path, surfaced to the TUI renderer. */
	path?: string;
}

export interface KernelSentAgentMessage {
	id: string;
	message: string;
	deliveryStatus: "delivered" | "queued";
	receiverRole?: "parent" | "sibling" | "child";
	target: {
		activeSessionId: string;
		sessionId: string;
		sessionName?: string;
	};
}

export interface ExecuteResult {
	stdout: string;
	stderr: string;
	/** Text of the cell's trailing expression value, if the cell produced one. */
	result?: string;
	/** Diffs emitted via display events, in order. */
	diffs?: KernelDiffDisplay[];
	/** Media attachments emitted via display events, in order. */
	attachments?: KernelAttachment[];
	/** Agent messages sent from this cell, in order. */
	sentAgentMessages?: KernelSentAgentMessage[];
	/** Output that arrived without this cell's id (user threads, other cells' leftovers, raw fd writes). */
	backgroundOutput?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
}

export interface KernelShutdownOptions {
	snapshot?: boolean;
	drainHostRequests?: boolean;
}

/** Public surface every kernel client exposes to the provisioner and session layer. */
export interface KernelClient {
	readonly ownerSessionId: string | undefined;
	readonly isRunning: boolean;
	readonly hasBackgroundWork: boolean;
	/** Terminal: the kernel died or was torn down; only a fresh manager can serve again. */
	readonly isDefunct: boolean;
	start(options?: KernelStartOptions): Promise<void>;
	execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult>;
	shutdown(opts?: KernelShutdownOptions): Promise<boolean>;
	restart(): Promise<void>;
	kill(): Promise<void>;
	disposeSync(): void;
	snapshotState(): Promise<SnapshotResult | null>;
	pruneOversizedVariables(): Promise<SnapshotResult | null>;
	restoreState(): Promise<RestoreResult | null>;
	listNamespaceNames(signal?: AbortSignal): Promise<string[] | null>;
}
