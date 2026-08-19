import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

describe("IPython kernel output bounds", () => {
	let tempDir = "";
	let provisioner: IpythonKernelProvisioner | undefined;

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("bounds streamed output, results, and tracebacks at the execute boundary", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-output-bounds-"));
		provisioner = new IpythonKernelProvisioner(tempDir);
		const manager = await provisioner.ensure();
		const streamed = { stdout: "", stderr: "" };

		const output = await manager.execute("import sys; sys.stderr.write('e' * 4096)\nprint('x' * 4096)\n'y' * 4096", {
			maxOutputChars: 64,
			onStream: (chunk, name) => {
				streamed[name] += chunk;
			},
		});
		const failure = await manager.execute("raise RuntimeError('z' * 4096)", { maxOutputChars: 64 });

		expect(output.status).toBe("ok");
		expect(streamed.stdout.length).toBeLessThanOrEqual(64);
		expect(streamed.stderr.length).toBeLessThanOrEqual(64);
		expect(output.stdout.length).toBeLessThanOrEqual(64);
		expect(output.stderr.length).toBeLessThanOrEqual(64);
		expect(output.result?.length ?? 0).toBeLessThanOrEqual(64);
		expect(failure.status).toBe("error");
		expect(failure.error?.traceback.join("\n").length ?? 0).toBeLessThanOrEqual(64);
	});

	it("bounds raw result and traceback payloads before active execution assembly", async () => {
		const manager = new KernelManager({ cwd: process.cwd() });
		const shellSend = vi.fn(async (_frames: Buffer[]) => {});
		Object.assign(
			manager as unknown as {
				state: "running";
				connection: {
					ip: string;
					transport: "tcp";
					shell_port: number;
					iopub_port: number;
					stdin_port: number;
					control_port: number;
					hb_port: number;
					signature_scheme: "hmac-sha256";
					key: string;
					kernel_name: string;
				};
				shell: { send: (frames: Buffer[]) => Promise<void>; close: () => void };
				start: () => Promise<void>;
			},
			{
				state: "running",
				connection: {
					ip: "127.0.0.1",
					transport: "tcp",
					shell_port: 1,
					iopub_port: 2,
					stdin_port: 3,
					control_port: 4,
					hb_port: 5,
					signature_scheme: "hmac-sha256",
					key: "test-key",
					kernel_name: "python3",
				},
				shell: { send: shellSend, close: vi.fn() },
				start: async () => {},
			},
		);

		const executePromise = manager.execute("value", { maxOutputChars: 64 });
		const internals = manager as unknown as {
			activeExecution?: {
				requestMsgId: string;
				result?: string;
				error?: { evalue: string; traceback: string[] };
			};
			handleExecutionMessage: (incoming: {
				header: { msg_type: string };
				parent_header: Record<string, unknown>;
				metadata: Record<string, unknown>;
				content: Record<string, unknown>;
			}) => void;
		};
		await vi.waitFor(() => expect(internals.activeExecution).toBeDefined());
		const activeExecution = internals.activeExecution;
		if (!activeExecution) throw new Error("Expected active execution");
		const parentHeader = { msg_id: activeExecution.requestMsgId };
		internals.handleExecutionMessage({
			header: { msg_type: "execute_result" },
			parent_header: parentHeader,
			metadata: {},
			content: { data: { "text/plain": "r".repeat(4096) } },
		});
		expect(activeExecution.result?.length ?? 0).toBeLessThanOrEqual(64);

		internals.handleExecutionMessage({
			header: { msg_type: "error" },
			parent_header: parentHeader,
			metadata: {},
			content: {
				ename: "RuntimeError",
				evalue: "e".repeat(4096),
				traceback: ["t".repeat(4096)],
			},
		});
		expect(activeExecution.error?.evalue.length ?? 0).toBeLessThanOrEqual(64);
		expect(activeExecution.error?.traceback.join("\n").length ?? 0).toBeLessThanOrEqual(64);
		internals.handleExecutionMessage({
			header: { msg_type: "status" },
			parent_header: parentHeader,
			metadata: {},
			content: { execution_state: "idle" },
		});
		await expect(executePromise).resolves.toMatchObject({ status: "error" });
		manager.disposeSync();
	});

	it("clamps an unbounded caller output request", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-output-clamp-"));
		provisioner = new IpythonKernelProvisioner(tempDir);
		const manager = await provisioner.ensure();
		const output = await manager.execute("'x' * 1_000_001", { maxOutputChars: Number.POSITIVE_INFINITY });

		expect(output.result?.length ?? 0).toBeLessThanOrEqual(1_000_000);
	});

	it("caps accumulated kernel stderr before startup failure assembly", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-stderr-cap-"));
		const python = join(tempDir, "python");
		writeFileSync(
			python,
			"#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\000' x >&2\nexit 42\n",
		);
		chmodSync(python, 0o755);
		const manager = new KernelManager({ python });

		await expect(manager.start()).rejects.toThrow(/stderr/);
		const kernelStderr = (manager as unknown as { kernelStderr: string }).kernelStderr;
		expect(kernelStderr.length).toBeLessThanOrEqual(65_536);
		manager.disposeSync();
	});
});
