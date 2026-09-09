import { ensureKernelPython } from "../core/kernel/bootstrap.js";
import { ensureTool } from "../utils/tools-manager.js";

export async function runRuntimeBootstrap(): Promise<void> {
	await Promise.all([ensureTool("fd", true), ensureTool("rg", true)]);
	const python = await ensureKernelPython();
	console.log(`kernel python: ${python}`);
}
