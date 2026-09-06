import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ensureKernelPython } from "../src/core/kernel/bootstrap.js";

const python = process.env.PRIME_AGENT_TEST_KERNEL_PYTHON;
let root = "";
let originalEnv: NodeJS.ProcessEnv;

describe.skipIf(process.platform !== "win32" || !python)("Python batch shim readiness", () => {
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "prime-python-shim-"));
		originalEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = originalEnv;
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	test.each(["cmd", "bat"])("checks a real Python runtime through a .%s shim", async (extension) => {
		const shim = join(root, `Python & tools!.${extension}`);
		writeFileSync(shim, '@echo off\r\nsetlocal DisableDelayedExpansion\r\n"%PRIME_AGENT_TEST_KERNEL_PYTHON%" %*\r\n');
		process.env.PRIME_AGENT_KERNEL_PYTHON = shim;
		await expect(ensureKernelPython()).resolves.toBe(shim);

		const staleRuntime = join(root, "rlm");
		mkdirSync(staleRuntime);
		writeFileSync(join(staleRuntime, "__init__.py"), "# Runtime without the required API\n");
		process.env.PYTHONPATH = root;
		await expect(ensureKernelPython()).rejects.toThrow("current prime-agent-runtime");
	});
});
