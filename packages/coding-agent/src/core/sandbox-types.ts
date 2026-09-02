/**
 * Types for the Prime Sandbox lifecycle adapter (B06).
 */

export type SandboxApiStatus = "PENDING" | "PROVISIONING" | "RUNNING" | "PAUSED" | "ERROR" | "TERMINATED" | "TIMEOUT";

export interface SandboxIdentity {
	id: string;
	name: string;
	status: SandboxApiStatus;
	image: string;
	region: string;
	createdAt: string;
	labels: string[];
	resources: string;
}

/**
 * Options for creating a fresh sandbox.
 *
 * A stable session label is required for idempotency.
 * Label-based dedup is advisory: a race between two concurrent
 * creators could still produce two sandboxes with the same label.
 * In that case the provider returns a typed DuplicateSandboxError
 * containing both ids so the lifecycle owner can reconcile.
 */
export interface SandboxCreateOptions {
	image: string;
	name?: string;
	startCommand?: string;
	cpuCores?: number;
	memoryGb?: number;
	diskSizeGb?: number;
	region?: string;
	timeoutMinutes?: number;
	idleTimeoutMinutes?: number;
	sessionLabel: string;
}

export interface SandboxPreflightResult {
	available: boolean;
	version: string;
	error: string;
}

export interface SandboxRunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface CommandRunner {
	run(
		command: string[],
		options?: { timeout?: number; signal?: AbortSignal; cwd?: string },
	): Promise<SandboxRunResult>;
}
