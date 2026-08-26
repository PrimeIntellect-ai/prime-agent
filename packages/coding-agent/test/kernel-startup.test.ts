import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

type ConnectionWaiter = {
	waitForResolvedConnection(this: KernelManager, connectionPath: string): Promise<unknown>;
};

const waitForResolvedConnection = (KernelManager.prototype as unknown as ConnectionWaiter).waitForResolvedConnection;

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake kernel died before binding" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it.each([
		["initial zero", [0, 0, 0, 0, 0]],
		["duplicate", [41_001, 41_002, 41_003, 41_004, 41_004]],
		["out-of-range", [41_001, 41_002, 41_003, 41_004, 65_536]],
	] as const)("keeps polling when the connection file contains %s ports", async (_case, ports) => {
		const connectionPath = join(tempDir, "connection.json");
		const [shellPort, iopubPort, stdinPort, controlPort, hbPort] = ports;
		writeFileSync(
			connectionPath,
			JSON.stringify({
				ip: "127.0.0.1",
				transport: "tcp",
				shell_port: shellPort,
				iopub_port: iopubPort,
				stdin_port: stdinPort,
				control_port: controlPort,
				hb_port: hbPort,
				signature_scheme: "hmac-sha256",
				key: "test-key",
				kernel_name: "python3",
			}),
		);

		const manager = Object.create(KernelManager.prototype) as KernelManager;
		Object.assign(manager, { state: "starting", kernelStderr: "" });
		let nowCalls = 0;
		const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (nowCalls++ < 2 ? 0 : 30_001));

		try {
			await expect(waitForResolvedConnection.call(manager, connectionPath)).rejects.toThrow(
				/Kernel did not resolve connection ports/,
			);
		} finally {
			nowSpy.mockRestore();
		}
	});
});
