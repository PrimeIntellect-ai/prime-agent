import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

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

	it("surfaces kernels that exit after publishing ports but before the startup probe", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				'connection="$4"',
				"/usr/bin/python3 - \"$connection\" <<'PY'",
				"import json",
				"import sys",
				"from pathlib import Path",
				"path = Path(sys.argv[1])",
				"payload = json.loads(path.read_text())",
				"for index, key in enumerate(('shell_port', 'iopub_port', 'stdin_port', 'control_port', 'hb_port')):",
				"    payload[key] = 55000 + index",
				"path.write_text(json.dumps(payload))",
				"PY",
				"sleep 0.02",
				'echo "fake kernel exited after publishing ports" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("1 + 1")).rejects.toThrow(
				/Kernel exited during startup[\s\S]*fake kernel exited after publishing ports/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});
});
