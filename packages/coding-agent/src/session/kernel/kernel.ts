// Compatibility adapter for the former deep-import API; internal callers use kernel-lifecycle.
import type { ToolDefinition } from "../../core/extensions/index.js";
import type { PythonSkillRuntimeInfo } from "../../core/skills.js";
import type { KernelSentAgentMessage } from "../../kernel/contracts.js";
import {
	SessionKernel as KernelLifecycle,
	type SessionKernelHost as KernelLifecycleHost,
} from "../runtime/kernel-lifecycle.js";
import { createSessionBuiltinToolDefinitions } from "../tools/tools.js";

export interface SessionKernelHost extends KernelLifecycleHost {
	recordLateSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void;
}

export class SessionKernel extends KernelLifecycle {
	constructor(
		private readonly toolHost: SessionKernelHost,
		prewarm: boolean,
	) {
		super(toolHost, prewarm);
	}

	build(pythonSkills: PythonSkillRuntimeInfo[]): Record<string, ToolDefinition> {
		return createSessionBuiltinToolDefinitions(this.toolHost.cwd, {
			ipython: {
				provisioner: this.prepare(pythonSkills),
				commandPrefix: this.toolHost.getShellCommandPrefix(),
				shellPath: this.toolHost.getShellPath(),
				onLateSentAgentMessage: (toolCallId, message) =>
					this.toolHost.recordLateSentAgentMessage(toolCallId, message),
			},
		});
	}
}
