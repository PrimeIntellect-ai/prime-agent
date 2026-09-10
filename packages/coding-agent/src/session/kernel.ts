import { existsSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../core/extensions/index.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "../core/kernel/index.js";
import { type RestoreResult, snapshotPathIn } from "../core/kernel/state-snapshot.js";
import { type CustomMessage, IPYTHON_STATE_RESTORED_CUSTOM_TYPE } from "../core/messages.js";
import type { SessionManager } from "../core/session-manager.js";
import type { PythonSkillRuntimeInfo } from "../core/skills.js";
import { createAllToolDefinitions } from "../core/tools/index.js";
import { IpythonKernelProvisioner } from "../core/tools/ipython.js";

const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;
export interface SessionKernelHost {
	cwd: string;
	getArtifactDir(): string | undefined;
	getSessionId(): string;
	getEnv(): Record<string, string>;
	getShellCommandPrefix(): string | undefined;
	getShellPath(): string | undefined;
	createHostHandlers(): HostRequestHandlers;
	recordLateSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void;
	getMessages(): AgentMessage[];
	appendCustomMessageEntry: SessionManager["appendCustomMessageEntry"];
	emit(event: { type: "message_start" | "message_end"; message: AgentMessage }): void;
	sendCustomMessage(
		message: Pick<CustomMessage, "customType" | "content" | "display" | "details">,
		options: { deliverAs: "nextTurn" },
	): Promise<void>;
}

export class SessionKernel {
	provisioner?: IpythonKernelProvisioner;
	private snapshotDir?: string;
	private built = false;
	constructor(
		private readonly host: SessionKernelHost,
		private readonly prewarm: boolean,
	) {}
	build(pythonSkills: PythonSkillRuntimeInfo[]): Record<string, ToolDefinition> {
		// Rebuilding (e.g. /reload) replaces the provisioner; drop the previous
		// kernel so the session never holds two live kernels. Gate the new kernel's
		// startup on the old one's dispose (which flushes a final snapshot), so a
		// reload can't restore from a snapshot the old kernel is still writing.
		const previousDispose = this.provisioner?.dispose();
		this.snapshotDir = this.host.getArtifactDir();
		// Only surface the "revived from your previous session" notice on the first
		// build (a genuine resume). A later rebuild (/reload) restores state silently
		// for continuity — the conversation is unchanged, so there's nothing to flag.
		const notifyRestore = !this.built;
		this.provisioner = new IpythonKernelProvisioner(this.host.cwd, {
			env: this.host.getEnv(),
			commandPrefix: this.host.getShellCommandPrefix(),
			shellPath: this.host.getShellPath(),
			sessionId: this.host.getSessionId(),
			hostHandlers: this.host.createHostHandlers(),
			pythonSkills,
			snapshotDir: this.snapshotDir,
			readyGate: previousDispose,
			onRestore: notifyRestore ? (result) => this.onStateRestored(result) : undefined,
		});
		return createAllToolDefinitions(this.host.cwd, {
			ipython: {
				provisioner: this.provisioner,
				commandPrefix: this.host.getShellCommandPrefix(),
				shellPath: this.host.getShellPath(),
				onLateSentAgentMessage: (toolCallId, message) => this.host.recordLateSentAgentMessage(toolCallId, message),
			},
		});
	}
	finishBuild(activeToolNames: string[]): void {
		const hasSnapshot = !!this.snapshotDir && existsSync(snapshotPathIn(this.snapshotDir));
		if ((this.prewarm || hasSnapshot) && activeToolNames.includes("ipython")) this.provisioner?.prewarm();
		this.built = true;
	}
	async dispose(snapshot: boolean): Promise<void> {
		try {
			await this.provisioner?.dispose({ snapshot });
		} catch {
			/* Failed startup already cleaned up. */
		}
	}
	async syncAfterCompaction(): Promise<void> {
		const provisioner = this.provisioner;
		if (!provisioner?.hasRunningKernel) return;
		const pruned = await provisioner.pruneOversizedVariables().catch(() => null);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), KERNEL_STATE_LISTING_TIMEOUT_MS);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		let names: string[] | null;
		try {
			names = await provisioner.listNamespaceNames(abort.signal).catch(() => null);
		} finally {
			clearTimeout(timer);
		}
		if (names === null && !provisioner.hasRunningKernel) return;
		const detail =
			names === null
				? ""
				: names.length > 0
					? ` These names are still defined: ${names.join(", ")}.`
					: " You have not defined any names yet.";
		const prunedDetail =
			pruned && pruned.length > 0
				? ` Variables above the per-variable snapshot limit were removed: ${pruned.join(", ")}.`
				: "";
		const content = [
			"[python-state]",
			"",
			`Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.${prunedDetail}${detail}`,
		].join("\n");
		const message = {
			role: "custom" as const,
			customType: "ipython_state",
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		const messages = this.host.getMessages();
		const last = messages[messages.length - 1];
		const insertBeforeError = last?.role === "assistant" && (last as AssistantMessage).stopReason === "error";
		if (insertBeforeError) {
			messages.splice(messages.length - 1, 0, message);
		} else {
			messages.push(message);
		}
		this.host.appendCustomMessageEntry(message.customType, message.content, message.display, undefined);
		this.host.emit({ type: "message_start", message });
		this.host.emit({ type: "message_end", message });
	}

	onStateRestored(result: RestoreResult): void {
		const lines = ["[python-state-restored]", ""];
		if (result.restored.length > 0) {
			lines.push(
				`Your Python kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
			);
		} else {
			lines.push(
				"Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
			);
		}
		if (result.failed.length > 0) {
			lines.push(
				`These could not be restored and must be recreated if needed: ${result.failed.map((f) => f.name).join(", ")}.`,
			);
		}
		void this.host
			.sendCustomMessage(
				{
					customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
					content: lines.join("\n"),
					display: true,
					details: { restored: result.restored.length > 0 },
				},
				{ deliverAs: "nextTurn" },
			)
			.catch(() => {});
	}
}
