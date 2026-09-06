import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspaceRootLifecycle } from "../src/modes/daemon/sandbox/prime-workspace-authority.js";

const PYTHON = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
const HELPER = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"src",
	"modes",
	"daemon",
	"sandbox",
	"ws-posix-helper.py",
);
const AUTHORITY = join(dirname(HELPER), "prime-workspace-authority.ts");
const AUTHORITY_TYPES = join(dirname(HELPER), "prime-workspace-authority-types.ts");
const AUTHORITY_CORE = join(dirname(HELPER), "prime-workspace-helper-core.ts");

const roots: string[] = [];
const fixtureDirectories: string[] = [];

function freshSessionRoot(): string {
	const root = join(homedir(), ".prime", "agent", "sandbox-sessions", randomBytes(32).toString("hex"));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	roots.push(root);
	return root;
}

function frame(opcode: number, payload: Uint8Array): Uint8Array {
	const result = new Uint8Array(5 + payload.byteLength);
	result[0] = opcode;
	new DataView(result.buffer).setUint32(1, payload.byteLength, false);
	result.set(payload, 5);
	return result;
}

function readFrames(output: Uint8Array): { status: number; payloadLength: number }[] {
	const result: { status: number; payloadLength: number }[] = [];
	let offset = 0;
	while (offset + 5 <= output.byteLength) {
		const view = new DataView(output.buffer, output.byteOffset + offset, output.byteLength - offset);
		const status = view.getUint8(0);
		const payloadLength = view.getUint32(1, false);
		if (offset + 5 + payloadLength > output.byteLength) return [];
		result.push({ status, payloadLength });
		offset += 5 + payloadLength;
	}
	return offset === output.byteLength ? result : [];
}

function fixtureSource(mode: string): string {
	return `#!/usr/bin/env python3
import os
import signal
import struct
import sys
import time

MODE = ${JSON.stringify(mode)}

def read_exact(length):
    result = bytearray()
    while len(result) < length:
        chunk = os.read(0, length - len(result))
        if not chunk:
            return None
        result.extend(chunk)
    return result

def send(status, payload=b""):
    os.write(1, struct.pack(">BI", status, len(payload)) + payload)

def valid_stat():
    result = bytearray(72)
    struct.pack_into(">I", result, 16, 0o40700)
    struct.pack_into(">I", result, 20, 2)
    struct.pack_into(">I", result, 24, os.getuid())
    return result

if MODE == "stdout-flood":
    os.write(1, b"x" * 2000000)
    time.sleep(60)
if MODE == "stderr-flood":
    os.write(2, b"x" * 2000000)
if MODE == "stderr-success":
    os.write(2, b"unexpected stderr")
if MODE == "env-empty" and "WORKSPACE_SENTINEL_SECRET" in os.environ:
    os.write(2, b"inherited secret")
    sys.exit(7)

while True:
    header = read_exact(5)
    if header is None:
        sys.exit(0)
    opcode = header[0]
    size = struct.unpack_from(">I", header, 1)[0]
    payload = read_exact(size)
    if payload is None:
        sys.exit(0)
    if MODE == "partial-read":
        os.write(1, b"\\x00\\x00")
        time.sleep(60)
    if opcode == 1:
        if MODE == "delayed-header-payload":
            stat_payload = valid_stat()
            time.sleep(1.8)
            os.write(1, struct.pack(">BI", 0, len(stat_payload)))
            time.sleep(1.8)
            os.write(1, stat_payload)
            continue
        if MODE == "open-error" or MODE == "open-error-descendant":
            if MODE == "open-error-descendant":
                child = os.fork()
                if child == 0:
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                    while True:
                        time.sleep(60)
            send(1, struct.pack(">i", 13))
            continue
        send(0, valid_stat())
        if MODE == "drain-error":
            os.close(1)
            time.sleep(60)
    elif opcode == 64:
        if MODE == "lock-error-hung":
            send(1, struct.pack(">i", 11))
        else:
            send(0)
    elif opcode == 255:
        if MODE == "quit-malformed":
            send(0, b"x")
            sys.exit(0)
        if MODE == "quit-no-response":
            sys.exit(0)
        if MODE == "quit-hang":
            time.sleep(60)
        if MODE == "term-ignored" or MODE == "lock-error-hung":
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
            while True:
                time.sleep(60)
        if MODE == "descendant-survival":
            child = os.fork()
            if child == 0:
                signal.signal(signal.SIGTERM, signal.SIG_IGN)
                while True:
                    time.sleep(60)
            send(0)
            sys.exit(0)
        if MODE == "quit-close-error":
            send(1, struct.pack(">i", 5))
            sys.exit(1)
        send(0)
        if MODE == "nonzero-exit":
            sys.exit(7)
        sys.exit(0)
    else:
        send(1, struct.pack(">i", 95))
`;
}

function createHarness(mode: string, missingPython: boolean, uncertainProbe: boolean): string {
	const directory = mkdtempSync(join(tmpdir(), "workspace-authority-"));
	fixtureDirectories.push(directory);
	writeFileSync(join(directory, "ws-posix-helper.py"), fixtureSource(mode), { mode: 0o700 });
	writeFileSync(join(directory, "prime-workspace-authority-types.ts"), readFileSync(AUTHORITY_TYPES, "utf8"));
	let coreSource = readFileSync(AUTHORITY_CORE, "utf8");
	if (missingPython) {
		const missingPath = JSON.stringify(join(directory, "missing-python"));
		coreSource = coreSource.replace('"/opt/homebrew/bin/python3"', missingPath);
		coreSource = coreSource.replace('"/usr/local/bin/python3"', missingPath);
	}
	if (uncertainProbe) {
		coreSource = coreSource.replace("CAPTURED_PROCESS_KILL(-pgid, 0);", "CAPTURED_PROCESS_KILL(1, 0);");
	}
	writeFileSync(join(directory, "prime-workspace-helper-core.ts"), coreSource);
	writeFileSync(join(directory, "prime-workspace-authority.ts"), readFileSync(AUTHORITY, "utf8"));
	writeFileSync(
		join(directory, "runner.ts"),
		`import { verifyWorkspaceRootLifecycle } from "./prime-workspace-authority.ts";
const result = await verifyWorkspaceRootLifecycle(process.argv[2]);
process.stdout.write(JSON.stringify(result));
`,
	);
	return join(directory, "runner.ts");
}

function verifyResultWithFixture(mode: string, missingPython = false, uncertainProbe = false): string {
	const root = freshSessionRoot();
	const runner = createHarness(mode, missingPython, uncertainProbe);
	const result = spawnSync(process.execPath, [runner, root], {
		cwd: dirname(runner),
		env: process.env,
		maxBuffer: 2_097_152,
		timeout: 20_000,
	});
	if (result.error !== undefined) return "PROCESS_ERROR";
	return result.stdout.toString("utf8");
}

function verifyWithFixture(mode: string): boolean {
	return verifyResultWithFixture(mode) === '{"ok":true}';
}

afterEach(() => {
	delete process.env.WORKSPACE_SENTINEL_SECRET;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	for (const directory of fixtureDirectories) rmSync(directory, { recursive: true, force: true });
	roots.length = 0;
	fixtureDirectories.length = 0;
});

describe("real helper lifecycle", () => {
	it("enters dispatch, opens the root, locks it, acknowledges QUIT, and exits zero", () => {
		const root = freshSessionRoot();
		const pathPayload = new TextEncoder().encode(root);
		const lockPayload = new Uint8Array(4);
		const input = Buffer.concat([frame(1, pathPayload), frame(64, lockPayload), frame(255, new Uint8Array(0))]);
		const result = spawnSync(PYTHON, [HELPER], {
			input,
			maxBuffer: 2_097_152,
			timeout: 5000,
		});
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.signal).toBeNull();
		const responses = readFrames(result.stdout);
		expect(responses).toEqual([
			{ status: 0, payloadLength: 72 },
			{ status: 0, payloadLength: 0 },
			{ status: 0, payloadLength: 0 },
		]);
	});

	it("rejects an unknown operation after entering dispatch", () => {
		const result = spawnSync(PYTHON, [HELPER], {
			input: frame(0x99, new Uint8Array(0)),
			maxBuffer: 1024,
			timeout: 5000,
		});
		expect(result.status).toBe(0);
		expect(readFrames(result.stdout)).toEqual([{ status: 1, payloadLength: 4 }]);
	});

	it("returns EIO and exits nonzero when a tracked descriptor cannot close", () => {
		const code = [
			"import runpy, sys",
			"namespace = runpy.run_path(sys.argv[1])",
			"closed = namespace['_cmd_quit']({0: -1}, 1)",
			"sys.exit(9 if closed else 1)",
		].join("\n");
		const result = spawnSync(PYTHON, ["-c", code, HELPER], { maxBuffer: 1024, timeout: 5000 });
		expect(result.status).toBe(1);
		expect(readFrames(result.stdout)).toEqual([{ status: 1, payloadLength: 4 }]);
	});
});

describe("workspace root validation", () => {
	it("accepts a fresh generated root", async () => {
		const result = await verifyWorkspaceRootLifecycle(freshSessionRoot());
		expect(result).toEqual({ ok: true });
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("rejects non-string, relative, normalized, and malformed inputs", async () => {
		const hex = "a".repeat(64);
		const values: unknown[] = [
			undefined,
			"",
			"relative/path",
			`//Users/user/.prime/agent/sandbox-sessions/${hex}`,
			`/Users/user/.prime/agent/sandbox-sessions/../${hex}`,
			`/Users/user\name/.prime/agent/sandbox-sessions/${hex}`,
			`/Users/user/.prime/agent/sandbox-sessions/${hex}
`,
		];
		for (const value of values) {
			const result = await verifyWorkspaceRootLifecycle(value);
			expect(result).toEqual({ ok: false, code: "OPEN_ROOT_FAILED" });
		}
	});

	it("rejects extra home path segments", async () => {
		const hex = "b".repeat(64);
		const usersResult = await verifyWorkspaceRootLifecycle(`/Users/a/b/.prime/agent/sandbox-sessions/${hex}`);
		const homeResult = await verifyWorkspaceRootLifecycle(`/home/a/b/.prime/agent/sandbox-sessions/${hex}`);
		expect(usersResult).toEqual({ ok: false, code: "OPEN_ROOT_FAILED" });
		expect(homeResult).toEqual({ ok: false, code: "OPEN_ROOT_FAILED" });
	});

	it("rejects missing roots and roots with the wrong mode", async () => {
		const missing = join(homedir(), ".prime", "agent", "sandbox-sessions", randomBytes(32).toString("hex"));
		const missingResult = await verifyWorkspaceRootLifecycle(missing);
		expect(missingResult).toEqual({ ok: false, code: "OPEN_ROOT_FAILED" });
		const root = freshSessionRoot();
		chmodSync(root, 0o755);
		const modeResult = await verifyWorkspaceRootLifecycle(root);
		expect(modeResult).toEqual({ ok: false, code: "OPEN_ROOT_FAILED" });
	});

	it("releases the lock before returning", async () => {
		const root = freshSessionRoot();
		expect(await verifyWorkspaceRootLifecycle(root)).toEqual({ ok: true });
		expect(await verifyWorkspaceRootLifecycle(root)).toEqual({ ok: true });
	});
});

describe("hostile helper lifecycle", () => {
	it("handles spawn ENOENT and error-before-close", () => {
		expect(verifyResultWithFixture("zero-exit", true)).toBe('{"ok":false,"code":"HELPER_FAILED"}');
	});

	it("rejects a partial response", async () => {
		expect(await verifyWithFixture("partial-read")).toBe(false);
	}, 12_000);

	it("caps a stdout flood", async () => {
		expect(await verifyWithFixture("stdout-flood")).toBe(false);
	}, 12_000);

	it("caps a stderr flood", async () => {
		expect(await verifyWithFixture("stderr-flood")).toBe(false);
	}, 12_000);

	it("rejects a malformed QUIT response", async () => {
		expect(await verifyWithFixture("quit-malformed")).toBe(false);
	});

	it("rejects a missing QUIT response", async () => {
		expect(await verifyWithFixture("quit-no-response")).toBe(false);
	});

	it("escalates when QUIT hangs", async () => {
		expect(await verifyWithFixture("quit-hang")).toBe(false);
	}, 12_000);

	it("uses KILL when TERM is ignored", async () => {
		expect(await verifyWithFixture("term-ignored")).toBe(false);
	}, 15_000);

	it("rejects a drain failure", async () => {
		expect(await verifyWithFixture("drain-error")).toBe(false);
	}, 12_000);

	it("rejects an EPERM-style group probe", () => {
		expect(verifyResultWithFixture("zero-exit", false, true)).toBe('{"ok":false,"code":"HELPER_FAILED"}');
	}, 15_000);

	it("does not inherit a sentinel credential", async () => {
		process.env.WORKSPACE_SENTINEL_SECRET = "must-not-reach-helper";
		try {
			expect(await verifyWithFixture("env-empty")).toBe(true);
		} finally {
			delete process.env.WORKSPACE_SENTINEL_SECRET;
		}
	});

	it("rejects stderr from an otherwise successful helper", async () => {
		expect(await verifyWithFixture("stderr-success")).toBe(false);
	});

	it("uses one deadline across a delayed header and payload", async () => {
		expect(await verifyWithFixture("delayed-header-payload")).toBe(false);
	}, 15_000);

	it("reports helper failure when OPEN error cleanup leaves a descendant", async () => {
		const result = verifyResultWithFixture("open-error-descendant");
		expect(result).toBe('{"ok":false,"code":"HELPER_FAILED"}');
	}, 15_000);

	it("reports helper failure when OPEN error cleanup cannot prove group absence", async () => {
		const result = verifyResultWithFixture("open-error", false, true);
		expect(result).toBe('{"ok":false,"code":"HELPER_FAILED"}');
	}, 15_000);

	it("reports helper failure when LOCK error cleanup hangs", async () => {
		const result = verifyResultWithFixture("lock-error-hung");
		expect(result).toBe('{"ok":false,"code":"HELPER_FAILED"}');
	}, 15_000);

	it("rejects QUIT close uncertainty", async () => {
		expect(await verifyWithFixture("quit-close-error")).toBe(false);
	});

	it("requires a zero exit after the exact QUIT response", async () => {
		expect(await verifyWithFixture("zero-exit")).toBe(true);
		expect(await verifyWithFixture("nonzero-exit")).toBe(false);
	});

	it("removes surviving descendants and rejects the lifecycle", async () => {
		expect(await verifyWithFixture("descendant-survival")).toBe(false);
	}, 15_000);
});

describe("module export and import inventory", () => {
	it("authority and core export exactly the expected public surface", async () => {
		const authMod = await import("../src/modes/daemon/sandbox/prime-workspace-authority.js");
		const coreMod = await import("../src/modes/daemon/sandbox/prime-workspace-helper-core.js");
		expect(Object.keys(authMod).sort()).toEqual(["verifyWorkspaceRootLifecycle"]);
		expect(Object.keys(coreMod).sort()).toEqual(["verifyWorkspaceRootLifecycleInternal"]);
		expect(typeof authMod.verifyWorkspaceRootLifecycle).toBe("function");
		expect(typeof coreMod.verifyWorkspaceRootLifecycleInternal).toBe("function");
	});

	it("no file except authority imports prime-workspace-helper-core at stage 1", () => {
		const sandboxDir = dirname(AUTHORITY);
		const importedBy: string[] = [];
		const tsFiles = readdirSync(sandboxDir, { withFileTypes: true })
			.filter((e) => e.isFile() && e.name.endsWith(".ts") && e.name !== "prime-workspace-helper-core.ts")
			.map((e) => e.name)
			.sort();
		for (const entry of tsFiles) {
			const content = readFileSync(join(sandboxDir, entry), "utf8");
			if (content.includes("./prime-workspace-helper-core")) {
				importedBy.push(entry);
			}
		}
		expect(importedBy).toEqual(["prime-workspace-authority.ts"]);
	});
});
