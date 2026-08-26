import { isAbsolute, relative, resolve } from "node:path";
import type { KernelProcessLauncher } from "./kernel/index.js";

export const AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION = 1 as const;

export interface AgentRunKernelBoundaryPolicy {
	readonly filesystem: "workspace-write";
	readonly workspaceRoot: string;
	readonly workspaceScopeDigest: string;
	readonly network: "enabled";
	readonly reviewerMode: "ask" | "automatic";
}

export interface AgentRunKernelBoundaryContext {
	readonly executionId: string;
	readonly sessionId: string;
	readonly recursionDepth: number;
	readonly cwd: string;
	readonly signal: AbortSignal;
}

export interface AgentRunKernelBoundaryLease {
	readonly launch: KernelProcessLauncher;
	dispose(reason: string): void | Promise<void>;
}

export type AgentRunKernelBoundaryPreparer = (
	context: AgentRunKernelBoundaryContext,
) => AgentRunKernelBoundaryLease | Promise<AgentRunKernelBoundaryLease>;

export type AgentRunKernelBoundaryLifecycleEvent =
	| {
			readonly phase: "initialized";
			readonly context: Omit<AgentRunKernelBoundaryContext, "signal">;
			readonly policy: AgentRunKernelBoundaryPolicy;
	  }
	| {
			readonly phase: "terminal";
			readonly context: Omit<AgentRunKernelBoundaryContext, "signal">;
			readonly policy: AgentRunKernelBoundaryPolicy;
			readonly outcome: "completed" | "failed" | "cancelled";
			readonly cleanup: "completed" | "failed";
	  };

export type AgentRunKernelBoundaryObserver = (event: AgentRunKernelBoundaryLifecycleEvent) => void | Promise<void>;

const agentRunKernelBoundaryScopeBrand = Symbol("AgentRunKernelBoundaryScope");

export interface AgentRunKernelBoundaryScope {
	readonly version: typeof AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION;
	readonly policy: AgentRunKernelBoundaryPolicy;
	readonly [agentRunKernelBoundaryScopeBrand]: true;
}

function immutablePolicy(policy: AgentRunKernelBoundaryPolicy): AgentRunKernelBoundaryPolicy {
	if (policy.filesystem !== "workspace-write") throw new Error("Kernel boundary must use workspace-write confinement");
	if (policy.network !== "enabled") throw new Error("Unsupported kernel boundary network policy");
	if (policy.reviewerMode !== "ask" && policy.reviewerMode !== "automatic") {
		throw new Error("Unsupported kernel boundary reviewer mode");
	}
	if (!isAbsolute(policy.workspaceRoot)) throw new Error("Kernel boundary workspace root must be absolute");
	if (!policy.workspaceScopeDigest.trim()) throw new Error("Kernel boundary workspace digest must be non-empty");
	return Object.freeze({ ...policy, workspaceRoot: resolve(policy.workspaceRoot) });
}

function immutableContext(context: AgentRunKernelBoundaryContext): Readonly<AgentRunKernelBoundaryContext> {
	return Object.freeze({ ...context });
}

function publicContext(context: AgentRunKernelBoundaryContext): Omit<AgentRunKernelBoundaryContext, "signal"> {
	return Object.freeze({
		executionId: context.executionId,
		sessionId: context.sessionId,
		recursionDepth: context.recursionDepth,
		cwd: context.cwd,
	});
}

class AgentRunKernelBoundaryScopeCapability implements AgentRunKernelBoundaryScope {
	readonly version = AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION;
	readonly policy: AgentRunKernelBoundaryPolicy;
	readonly [agentRunKernelBoundaryScopeBrand] = true;
	readonly #prepare: AgentRunKernelBoundaryPreparer;
	readonly #observe?: AgentRunKernelBoundaryObserver;
	readonly #leases = new Map<
		string,
		{
			context: AgentRunKernelBoundaryContext;
			lease: AgentRunKernelBoundaryLease;
			cleanupCompleted: boolean;
			observerDebt?: AgentRunKernelBoundaryLifecycleEvent & { readonly phase: "terminal" };
		}
	>();
	#active = true;

	constructor(
		policy: AgentRunKernelBoundaryPolicy,
		prepare: AgentRunKernelBoundaryPreparer,
		observe?: AgentRunKernelBoundaryObserver,
	) {
		this.policy = immutablePolicy(policy);
		this.#prepare = prepare;
		this.#observe = observe;
		Object.freeze(this);
	}

	assertActive(): void {
		if (!this.#active) throw new Error("Agent run kernel-boundary scope is revoked");
	}

	async prepare(context: AgentRunKernelBoundaryContext): Promise<AgentRunKernelBoundaryLease> {
		this.assertActive();
		context.signal.throwIfAborted();
		if (this.#leases.has(context.executionId)) {
			throw new Error(`Kernel boundary execution ${context.executionId} is already initialized`);
		}
		const relativeCwd = relative(this.policy.workspaceRoot, resolve(context.cwd));
		if (relativeCwd.startsWith("..") || isAbsolute(relativeCwd)) {
			throw new Error("Kernel boundary cwd is outside its workspace root");
		}
		const lease = await this.#prepare(immutableContext(context));
		try {
			if (!lease || typeof lease.launch !== "function" || typeof lease.dispose !== "function") {
				throw new Error("Kernel boundary preparer returned an invalid launch lease");
			}
			// Once prepare returns a disposable lease, retain it before any further
			// validation or observation. Failed rollback remains cleanup debt that
			// revoke() can retry instead of losing the only handle to the boundary.
			this.#leases.set(context.executionId, { context, lease, cleanupCompleted: false });
			this.assertActive();
			context.signal.throwIfAborted();
		} catch (error) {
			if (this.#leases.has(context.executionId)) {
				try {
					await this.release(context.executionId, "cancelled", "boundary initialization was revoked");
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Kernel boundary initialization rollback failed");
				}
			}
			throw error;
		}
		try {
			await this.#observe?.({
				phase: "initialized",
				context: publicContext(context),
				policy: this.policy,
			});
		} catch (error) {
			try {
				await this.release(context.executionId, "failed", "boundary initialization observation failed");
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "Kernel boundary initialization rollback failed");
			}
			throw error;
		}
		return lease;
	}

	async release(executionId: string, outcome: "completed" | "failed" | "cancelled", reason: string): Promise<void> {
		const admitted = this.#leases.get(executionId);
		if (!admitted) return;
		if (admitted.observerDebt) {
			await this.#observe?.(admitted.observerDebt);
			admitted.observerDebt = undefined;
			if (admitted.cleanupCompleted) {
				this.#leases.delete(executionId);
				return;
			}
		}
		let cleanup: "completed" | "failed" = "completed";
		if (!admitted.cleanupCompleted) {
			try {
				await admitted.lease.dispose(reason);
				admitted.cleanupCompleted = true;
			} catch {
				cleanup = "failed";
			}
		}
		const terminalEvent = Object.freeze({
			phase: "terminal",
			context: publicContext(admitted.context),
			policy: this.policy,
			outcome,
			cleanup,
		} satisfies AgentRunKernelBoundaryLifecycleEvent & { readonly phase: "terminal" });
		try {
			await this.#observe?.(terminalEvent);
		} catch (error) {
			admitted.observerDebt = terminalEvent;
			throw error;
		}
		if (admitted.cleanupCompleted) this.#leases.delete(executionId);
		if (cleanup === "failed") throw new Error("Kernel boundary cleanup failed");
	}

	async revoke(reason: string): Promise<void> {
		this.#active = false;
		const results = await Promise.allSettled(
			[...this.#leases.keys()].map((executionId) => this.release(executionId, "cancelled", reason)),
		);
		const failures = results
			.filter((result): result is PromiseRejectedResult => result.status === "rejected")
			.map((result) => result.reason);
		if (failures.length > 0) throw new AggregateError(failures, "Kernel boundary revocation failed");
	}
}

export function createAgentRunKernelBoundaryScope(input: {
	readonly version: typeof AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION;
	readonly policy: AgentRunKernelBoundaryPolicy;
	readonly prepare: AgentRunKernelBoundaryPreparer;
	readonly observe?: AgentRunKernelBoundaryObserver;
}): AgentRunKernelBoundaryScope {
	if (input.version !== AGENT_RUN_KERNEL_BOUNDARY_SCOPE_VERSION) {
		throw new Error("Unsupported agent run kernel-boundary scope version");
	}
	if (typeof input.prepare !== "function") throw new Error("Agent run kernel boundary requires a preparer");
	if (input.observe !== undefined && typeof input.observe !== "function") {
		throw new Error("Agent run kernel boundary observer must be a function");
	}
	return new AgentRunKernelBoundaryScopeCapability(input.policy, input.prepare, input.observe);
}

export function assertAgentRunKernelBoundaryScope(value: unknown): asserts value is AgentRunKernelBoundaryScope {
	if (!(value instanceof AgentRunKernelBoundaryScopeCapability)) {
		throw new Error("Agent run kernel-boundary scope is not a factory-created capability");
	}
	value.assertActive();
}

export async function prepareAgentRunKernelBoundary(
	scope: AgentRunKernelBoundaryScope,
	context: AgentRunKernelBoundaryContext,
): Promise<AgentRunKernelBoundaryLease> {
	assertAgentRunKernelBoundaryScope(scope);
	return (scope as AgentRunKernelBoundaryScopeCapability).prepare(context);
}

export async function releaseAgentRunKernelBoundary(
	scope: AgentRunKernelBoundaryScope,
	executionId: string,
	outcome: "completed" | "failed" | "cancelled",
	reason: string,
): Promise<void> {
	if (scope instanceof AgentRunKernelBoundaryScopeCapability) {
		await scope.release(executionId, outcome, reason);
	}
}

export async function revokeAgentRunKernelBoundaryScope(
	scope: AgentRunKernelBoundaryScope,
	reason: string,
): Promise<void> {
	if (scope instanceof AgentRunKernelBoundaryScopeCapability) await scope.revoke(reason);
}
