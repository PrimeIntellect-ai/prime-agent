import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.js";
import { createIpythonToolDefinition, IpythonKernelProvisioner } from "../../../src/core/tools/ipython.js";
import { wrapToolDefinition } from "../../../src/core/tools/tool-definition-wrapper.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const fixtures: Array<{ dir: string; provisioner: IpythonKernelProvisioner; harness: Harness }> = [];

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function createFixture(hasUI?: boolean) {
	const dir = mkdtempSync(join(tmpdir(), "prime-headless-cancel-"));
	const python = join(dir, "python");
	const pidPath = join(dir, "pid");
	const startedPath = join(dir, "started");
	// A real child speaking the runtime protocol, with deterministic interrupt handling.
	writeFileSync(
		python,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let active;
let value = 0;
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
emit({ event: "ready", protocol: 3 });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const request = JSON.parse(line);
	if (request.type === "interrupt") {
		if (active?.code === "cooperative") {
			emit({ event: "error", id: active.id, ename: "KeyboardInterrupt", evalue: "", traceback: [] });
			emit({ event: "done", id: active.id, status: "error" });
			active = undefined;
		}
		return;
	}
	if (request.type === "shutdown") process.exit(0);
	if (active) return;
	if (request.code === "wedged" || request.code === "cooperative") {
		value = 42;
		active = request;
		fs.writeFileSync(${JSON.stringify(startedPath)}, "1");
		return;
	}
	if (request.code === "value") emit({ event: "result", id: request.id, text: String(value) });
	emit({ event: "done", id: request.id, status: "ok" });
});
`,
	);
	chmodSync(python, 0o755);
	const provisioner = new IpythonKernelProvisioner(dir, { python, pythonSkills: [] });
	const definition = createIpythonToolDefinition(dir, { provisioner });
	const context = hasUI === undefined ? undefined : ({ hasUI } as ExtensionContext);
	const tool = context ? wrapToolDefinition(definition, () => context) : wrapToolDefinition(definition);
	const calls: ReturnType<typeof tool.execute>[] = [];
	const execute = tool.execute;
	tool.execute = (...args) => {
		const call = execute(...args);
		calls.push(call);
		return call;
	};
	const harness = await createHarness({ tools: [tool] });
	fixtures.push({ dir, provisioner, harness });
	return { provisioner, harness, calls, pid: () => Number(readFileSync(pidPath, "utf8")), startedPath };
}

async function cancelCell(harness: Harness, startedPath: string, code: string): Promise<void> {
	harness.setResponses([fauxAssistantMessage(fauxToolCall("ipython", { code }), { stopReason: "toolUse" })]);
	const prompt = harness.session.prompt("run the cancellation fixture");
	await expect.poll(() => existsSync(startedPath)).toBe(true);
	await harness.session.abort();
	await prompt;
}

async function readValue(harness: Harness): Promise<string> {
	harness.setResponses([
		fauxAssistantMessage(fauxToolCall("ipython", { code: "value" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt("read the value");
	const result = harness.session.messages.filter((message) => message.role === "toolResult").at(-1);
	return getMessageText(result);
}

afterEach(async () => {
	for (const { dir, provisioner, harness } of fixtures.splice(0)) {
		await provisioner.kill();
		harness.cleanup();
		rmSync(dir, { recursive: true, force: true });
	}
});

describe.skipIf(process.platform === "win32")("headless Python cancellation", () => {
	it.each([undefined, false])("kills an unresponsive kernel without a later call (hasUI=%s)", async (hasUI) => {
		const { harness, provisioner, calls, pid, startedPath } = await createFixture(hasUI);
		await cancelCell(harness, startedPath, "wedged");
		const cancelled = await calls[0];
		const oldPid = pid();

		await expect.poll(() => isAlive(oldPid)).toBe(false);
		expect(provisioner.hasRunningKernel).toBe(false);
		expect(cancelled).toMatchObject({ details: { status: "aborted" }, isError: true });
		expect(getMessageText(cancelled)).toContain("kernel was killed");

		const followup = await readValue(harness);
		expect(followup).toContain("<ipython_kernel_reset>");
		expect(followup).toMatch(/\n0$/);
		expect(pid()).not.toBe(oldPid);
	});

	it("preserves the kernel and its state when it acknowledges cancellation", async () => {
		const { harness, provisioner, calls, pid, startedPath } = await createFixture();
		await cancelCell(harness, startedPath, "cooperative");
		await calls[0];
		const oldPid = pid();

		expect(isAlive(oldPid)).toBe(true);
		expect(provisioner.hasRunningKernel).toBe(true);
		expect(await readValue(harness)).toBe("42");
		expect(pid()).toBe(oldPid);
	});

	it("preserves an unresponsive interactive kernel for the user's wait/restart choice", async () => {
		const { harness, provisioner, calls, pid, startedPath } = await createFixture(true);
		await cancelCell(harness, startedPath, "wedged");
		const cancelled = await calls[0];

		expect(isAlive(pid())).toBe(true);
		expect(provisioner.hasRunningKernel).toBe(true);
		expect(cancelled).toMatchObject({ details: { status: "aborted" }, isError: true });
		expect(getMessageText(cancelled)).not.toContain("kernel was killed");
	});

	it("replaces a kernel left busy by an earlier state-preserving cancellation", async () => {
		const { harness, provisioner, pid, startedPath } = await createFixture();
		const manager = await provisioner.ensure();
		const controller = new AbortController();
		const cell = manager.execute("wedged", { signal: controller.signal });
		await expect.poll(() => existsSync(startedPath)).toBe(true);
		controller.abort();
		await cell;
		const oldPid = pid();
		expect(isAlive(oldPid)).toBe(true);

		const followup = await readValue(harness);
		expect(followup).toContain("<ipython_kernel_reset>");
		expect(followup).toMatch(/\n0$/);
		await expect.poll(() => isAlive(oldPid)).toBe(false);
		expect(pid()).not.toBe(oldPid);
	});
});
