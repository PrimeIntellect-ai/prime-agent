import { ensureKernelPython } from "../kernel/bootstrap.js";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

try {
	const python = await ensureKernelPython();
	console.log(`kernel python: ${python}`);
} catch (error) {
	console.error(errorMessage(error));
	process.exit(1);
}
