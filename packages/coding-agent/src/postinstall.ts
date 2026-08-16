import { getAgentDir } from "./config.js";
import { ensureKernelPython } from "./core/kernel/bootstrap.js";
import { createReliabilityMonitorService } from "./modes/daemon/reliability-monitor-service.js";
import { ensureTool } from "./utils/tools-manager.js";

const bootstrapKernel = process.env.PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL === "1";
const bootstrapTools = process.env.PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL === "1";
const installReliabilityMonitor = process.env.PRIME_AGENT_INSTALL_RELIABILITY_MONITOR === "1";

if (!bootstrapKernel && !bootstrapTools && !installReliabilityMonitor) {
	process.exit(0);
}

if (bootstrapKernel && process.env.PRIME_AGENT_INSTALL_UV === undefined) {
	process.env.PRIME_AGENT_INSTALL_UV = "1";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function oneLine(message: string): string {
	return message.replace(/\s+/g, " ").trim();
}

try {
	if (bootstrapTools) {
		await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	}
	if (bootstrapKernel) {
		await ensureKernelPython();
	}
	if (installReliabilityMonitor) {
		createReliabilityMonitorService({ agentDir: getAgentDir() }).install();
	}
} catch (error) {
	console.error(`prime-agent: postinstall setup skipped: ${oneLine(errorMessage(error))}`);
}
