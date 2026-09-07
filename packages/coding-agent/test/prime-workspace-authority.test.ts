import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
    if opcode == 0xFE:
        if MODE == "delayed-header-payload":
            time.sleep(3.2)
            os.write(1, struct.pack(">BI", 3, 0))
            continue
        if MODE == "open-error" or MODE == "open-error-descendant" or MODE == "lock-error-hung":
            if MODE == "open-error-descendant":
                child = os.fork()
                if child == 0:
                    signal.signal(signal.SIGTERM, signal.SIG_IGN)
                    while True:
                        time.sleep(60)
            send(1, b"\x01")
            continue
        if MODE == "ready-malformed":
            send(3, b"x")
        else:
            send(3)
        if MODE == "drain-error":
            os.close(1)
            time.sleep(60)
    elif opcode == 0x0E:
        if payload:
            send(2, b"\x02")
        elif MODE == "recover-need":
            send(0x0E, b"\x05" + b"x" * 33)
        elif MODE == "recover-max-need":
            send(0x0E, b"x" * 1048566)
        elif MODE == "recover-uncertain":
            send(1, b"\x0c")
        elif MODE == "recover-wrong-reason":
            send(1, b"\x09")
        elif MODE == "recover-finalized":
            send(0x0B)
        elif MODE == "recover-malformed-absent":
            send(0x0D, b"x")
        else:
            send(0x0D)
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
            send(1, b"\x07")
            sys.exit(1)
        send(0)
        if MODE == "nonzero-exit":
            sys.exit(7)
        sys.exit(0)
    else:
        send(1, struct.pack(">i", 95))
`;
}

function createHarness(
	mode: string,
	missingPython: boolean,
	uncertainProbe: boolean,
	layout: "src" | "unbundled" | "bundle" | "invalid" = "src",
	hostileSwap = false,
): string {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "workspace-authority-"));
	fixtureDirectories.push(fixtureRoot);
	const directory =
		layout === "src"
			? join(fixtureRoot, "src", "modes", "daemon", "sandbox")
			: layout === "unbundled"
				? join(fixtureRoot, "dist", "modes", "daemon", "sandbox")
				: layout === "bundle"
					? join(fixtureRoot, "dist", "bundle")
					: join(fixtureRoot, "invalid-layout");
	mkdirSync(directory, { recursive: true });
	const helperSource = fixtureSource(mode);
	writeFileSync(join(directory, "ws-posix-helper.py"), helperSource, { mode: 0o644 });
	writeFileSync(join(directory, "prime-workspace-authority-types.ts"), readFileSync(AUTHORITY_TYPES, "utf8"));
	let coreSource = readFileSync(AUTHORITY_CORE, "utf8");
	coreSource = coreSource.replace(
		"const HELPER_SIZE = 144628;",
		`const HELPER_SIZE = ${Buffer.byteLength(helperSource)};`,
	);
	coreSource = coreSource.replace(
		'const HELPER_DIGEST = "0241c6ddd8de0072bb5b6f7896899767cdde5b4902654f883bb92435fac78fb2";',
		`const HELPER_DIGEST = "${createHash("sha256").update(helperSource).digest("hex")}";`,
	);
	if (hostileSwap) {
		const helperPath = JSON.stringify(join(directory, "ws-posix-helper.py"));
		const displacedPath = JSON.stringify(join(directory, "validated-helper.py"));
		coreSource = `import { renameSync as hostileRenameSync, writeFileSync as hostileWriteFileSync } from "node:fs";\n${coreSource}`;
		coreSource = coreSource.replace(
			"const validated: ValidatedHelper = candidate;",
			`const validated: ValidatedHelper = candidate;\n\thostileRenameSync(${helperPath}, ${displacedPath});\n\thostileWriteFileSync(${helperPath}, "raise SystemExit(91)\\n", { mode: 0o644 });`,
		);
	}
	if (missingPython) {
		const missingPath = JSON.stringify(join(directory, "missing-python"));
		coreSource = coreSource.replace("spawn(resolvedPythonPath(),", `spawn(${missingPath},`);
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

function runFixture(runner: string): string {
	const root = freshSessionRoot();
	const result = spawnSync(process.execPath, [runner, root], {
		cwd: dirname(runner),
		env: process.env,
		maxBuffer: 2_097_152,
		timeout: 20_000,
	});
	if (result.error !== undefined) return "PROCESS_ERROR";
	return result.stdout.toString("utf8");
}

function verifyResultWithFixture(mode: string, missingPython = false, uncertainProbe = false): string {
	return runFixture(createHarness(mode, missingPython, uncertainProbe));
}

function verifyWithFixture(mode: string): boolean {
	return verifyResultWithFixture(mode) === '{"ok":true}';
}

function recoveryResultWithFixture(mode: string): string {
	const root = freshSessionRoot();
	const runner = createHarness(mode, false, false);
	writeFileSync(
		runner,
		`import { recoverWorkspaceTransactionInternal } from "./prime-workspace-helper-core.ts";
const result = await recoverWorkspaceTransactionInternal(process.argv[2]);
process.stdout.write(JSON.stringify({ result, frozen: Object.isFrozen(result) }));
`,
	);
	const result = spawnSync(process.execPath, [runner, root], {
		cwd: dirname(runner),
		env: process.env,
		maxBuffer: 2_097_152,
		timeout: 20_000,
	});
	if (result.error !== undefined) return "PROCESS_ERROR";
	return result.stdout.toString("utf8");
}

async function collectFdSpawn(
	python: string,
	args: string[],
	fd: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
	return await new Promise((resolveResult, reject) => {
		const child = spawn(python, args, { cwd: "/", env: {}, detached: true, stdio: ["ignore", "pipe", "pipe", fd] });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => {
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
				setTimeout(() => {
					try {
						process.kill(-(child.pid ?? 0), "SIGKILL");
					} catch {}
				}, 250);
			}
			reject(new Error("fd spawn timeout"));
		}, 5000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			clearTimeout(timer);
			resolveResult({ code, signal, stdout, stderr });
		});
	});
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
		const input = Buffer.concat([frame(0xfe, pathPayload), frame(255, new Uint8Array(0))]);
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
			{ status: 3, payloadLength: 0 },
			{ status: 0, payloadLength: 0 },
		]);
	});

	it("requires 0xfe as the first and only OPEN_ROOT command", () => {
		const root = freshSessionRoot();
		const pathPayload = new TextEncoder().encode(root);
		const oldOpcode = spawnSync(PYTHON, [HELPER], {
			input: frame(0x01, pathPayload),
			maxBuffer: 1024,
			timeout: 5000,
		});
		expect(oldOpcode.status).toBe(0);
		expect(readFrames(oldOpcode.stdout)).toEqual([{ status: 2, payloadLength: 1 }]);

		const duplicate = spawnSync(PYTHON, [HELPER], {
			input: Buffer.concat([frame(0xfe, pathPayload), frame(0xfe, pathPayload)]),
			maxBuffer: 1024,
			timeout: 5000,
		});
		expect(duplicate.status).toBe(0);
		expect(readFrames(duplicate.stdout)).toEqual([
			{ status: 3, payloadLength: 0 },
			{ status: 2, payloadLength: 1 },
		]);
	});

	it("rejects an unknown operation before entering dispatch", () => {
		const result = spawnSync(PYTHON, [HELPER], {
			input: frame(0x99, new Uint8Array(0)),
			maxBuffer: 1024,
			timeout: 5000,
		});
		expect(result.status).toBe(0);
		expect(readFrames(result.stdout)).toEqual([{ status: 2, payloadLength: 1 }]);
	});

	it("returns EIO and exits nonzero when a tracked descriptor cannot close", () => {
		const code = [
			"import runpy, sys",
			"namespace = runpy.run_path(sys.argv[1])",
			"sys.exit(9 if namespace['_close_all']({-1: -1}) else 1)",
		].join("\n");
		const result = spawnSync(PYTHON, ["-c", code, HELPER], { maxBuffer: 1024, timeout: 5000 });
		expect(result.status).toBe(1);
		expect(result.stdout.byteLength).toBe(0);
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

	it("rejects a non-empty READY response", async () => {
		expect(await verifyWithFixture("ready-malformed")).toBe(false);
	});

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

describe("V25 recovery trigger integration", () => {
	it("does not change the public root-open lifecycle verifier semantics", async () => {
		expect(await verifyWithFixture("recover-need")).toBe(true);
	});

	it("maps an exact clean RECOVER response to a fresh frozen ABSENT result", () => {
		expect(recoveryResultWithFixture("zero-exit")).toBe('{"result":{"outcome":"ABSENT"},"frozen":true}');
	});

	it("fails closed on NEED_EVIDENCE until Store V5 evidence authority is composed", () => {
		const expected = '{"result":{"outcome":"UNCERTAIN","reason":"RECOVERY_UNCERTAIN"},"frozen":true}';
		expect(recoveryResultWithFixture("recover-need")).toBe(expected);
		expect(recoveryResultWithFixture("recover-max-need")).toBe(expected);
	});

	it("accepts only the fixed recovery-uncertain reason and never leaks helper payloads", () => {
		expect(recoveryResultWithFixture("recover-uncertain")).toBe(
			'{"result":{"outcome":"UNCERTAIN","reason":"RECOVERY_UNCERTAIN"},"frozen":true}',
		);
		expect(recoveryResultWithFixture("recover-wrong-reason")).toBe(
			'{"result":{"outcome":"UNCERTAIN","reason":"RECOVERY_UNCERTAIN"},"frozen":true}',
		);
		expect(recoveryResultWithFixture("recover-malformed-absent")).toBe(
			'{"result":{"outcome":"UNCERTAIN","reason":"RECOVERY_UNCERTAIN"},"frozen":true}',
		);
	});

	it("does not accept a premature FINALIZED response before evidence composition", () => {
		expect(recoveryResultWithFixture("recover-finalized")).toBe(
			'{"result":{"outcome":"UNCERTAIN","reason":"RECOVERY_UNCERTAIN"},"frozen":true}',
		);
	});
});

describe("fd-bound packaged helper resolver", () => {
	it("accepts the exact source, unbundled, and bundle layouts", () => {
		for (const layout of ["src", "unbundled", "bundle"] as const) {
			expect(runFixture(createHarness("zero-exit", false, false, layout))).toBe('{"ok":true}');
		}
	});

	it("rejects a module outside every exact noncompiled layout", () => {
		expect(runFixture(createHarness("zero-exit", false, false, "invalid"))).toBe(
			'{"ok":false,"code":"HELPER_FAILED"}',
		);
	});

	it("rejects missing, altered, symlinked, hard-linked, and wrong-mode helpers", () => {
		const mutations: ((helper: string) => void)[] = [
			(helper) => rmSync(helper),
			(helper) => {
				const bytes = readFileSync(helper);
				bytes[0] ^= 1;
				writeFileSync(helper, bytes);
			},
			(helper) => {
				const outside = join(dirname(dirname(dirname(dirname(dirname(helper))))), "outside-helper.py");
				writeFileSync(outside, readFileSync(helper), { mode: 0o644 });
				rmSync(helper);
				symlinkSync(outside, helper);
			},
			(helper) => linkSync(helper, `${helper}.second-link`),
			(helper) => chmodSync(helper, 0o600),
		];
		for (const mutate of mutations) {
			const runner = createHarness("zero-exit", false, false);
			mutate(join(dirname(runner), "ws-posix-helper.py"));
			expect(runFixture(runner)).toBe('{"ok":false,"code":"HELPER_FAILED"}');
		}
	});

	it("executes the validated fd after hostile pathname replacement before spawn", () => {
		const runner = createHarness("zero-exit", false, false, "src", true);
		expect(runFixture(runner)).toBe('{"ok":true}');
		expect(readFileSync(join(dirname(runner), "ws-posix-helper.py"), "utf8")).toContain("SystemExit(91)");
	});

	it("proves positional hashing, unchanged fstat, shared offset zero, and full fd3 execution", async () => {
		const temporary = mkdtempSync(join(tmpdir(), "workspace-fd-gate-"));
		fixtureDirectories.push(temporary);
		const candidate = join(temporary, "gate.py");
		const displaced = join(temporary, "validated.py");
		const original = Buffer.from(
			"import os,sys\nassert os.getpid()>1\nassert sys.version_info.major==3\nprint('BOUND')\n",
		);
		writeFileSync(candidate, original, { mode: 0o644 });
		const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x00080000;
		const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec);
		try {
			const before = fstatSync(fd);
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(17);
			const ranges: [number, number][] = [];
			let position = 0;
			while (position < before.size) {
				const wanted = Math.min(buffer.byteLength, before.size - position);
				const count = readSync(fd, buffer, 0, wanted, position);
				expect(count).toBeGreaterThan(0);
				ranges.push([position, position + count]);
				hash.update(buffer.subarray(0, count));
				position += count;
			}
			expect(ranges[0]?.[0]).toBe(0);
			for (let index = 1; index < ranges.length; index += 1) expect(ranges[index]?.[0]).toBe(ranges[index - 1]?.[1]);
			expect(ranges.at(-1)?.[1]).toBe(before.size);
			expect(hash.digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
			const after = fstatSync(fd);
			for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const)
				expect(after[key]).toBe(before[key]);
			expect(after.isFile()).toBe(before.isFile());
			const python = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
			const offset = await collectFdSpawn(python, ["-c", "import os;print(os.lseek(3,0,1))"], fd);
			expect(offset).toEqual({ code: 0, signal: null, stdout: "0\n", stderr: "" });
			renameSync(candidate, displaced);
			writeFileSync(candidate, "raise SystemExit(91)\n", { mode: 0o644 });
			const descriptorPath = process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3";
			const executed = await collectFdSpawn(python, [descriptorPath], fd);
			expect(executed).toEqual({ code: 0, signal: null, stdout: "BOUND\n", stderr: "" });
		} finally {
			closeSync(fd);
		}
	});

	it("uses compiled executable adjacency rather than its virtual module URL", () => {
		const runner = createHarness("zero-exit", false, false);
		const fixtureRoot = resolve(dirname(runner), "../../../..");
		const compiledDir = join(fixtureRoot, "compiled");
		mkdirSync(compiledDir);
		const binary = join(compiledDir, "workspace-resolver");
		const built = spawnSync(process.execPath, ["build", "--compile", runner, "--outfile", binary], {
			encoding: "utf8",
			timeout: 30_000,
		});
		expect(built.status, built.stderr).toBe(0);
		writeFileSync(
			join(compiledDir, "ws-posix-helper.py"),
			readFileSync(join(dirname(runner), "ws-posix-helper.py")),
			{
				mode: 0o644,
			},
		);
		const root = freshSessionRoot();
		const result = spawnSync(binary, [root], { cwd: "/", env: {}, encoding: "utf8", timeout: 20_000 });
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe('{"ok":true}');
	});

	it("pins both accepted platform Python paths and rejects ambiguous layout counts", () => {
		const source = readFileSync(AUTHORITY_CORE, "utf8");
		expect(source).toContain('platform() === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3"');
		expect(source).toContain("if (layouts !== 1) return undefined;");
		expect(source).toContain('url.includes("$bunfs") || url.includes("~BUN") || url.includes("%7EBUN")');
	});
});

describe("module export and import inventory", () => {
	it("keeps the narrow lifecycle core surface while transaction integration remains blocked", async () => {
		const authMod = await import("../src/modes/daemon/sandbox/prime-workspace-authority.js");
		const coreMod = await import("../src/modes/daemon/sandbox/prime-workspace-helper-core.js");
		expect(Object.keys(authMod).sort()).toEqual(["verifyWorkspaceRootLifecycle"]);
		expect(Object.keys(coreMod).sort()).toEqual([
			"recoverWorkspaceTransactionInternal",
			"verifyWorkspaceRootLifecycleInternal",
		]);
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
