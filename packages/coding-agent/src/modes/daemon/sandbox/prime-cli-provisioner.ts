import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { types } from "node:util";
import { gunzipSync } from "node:zlib";
import {
	acquirePrimeCliProvisioningLock,
	type PrimeCliProcessResult,
	type PrimeCliProvisioningLock,
	primeCliProvisioningLockAlive,
	releasePrimeCliProvisioningLock,
	runPrimeCliProcess,
	runPrimeCliReplacingExecutable,
} from "./prime-cli-process-group.js";
import {
	PRIME_CLI_GITIGNORE_WHEEL_BASE64,
	PRIME_CLI_GITIGNORE_WHEEL_NAME,
	PRIME_CLI_GITIGNORE_WHEEL_SHA256,
	PRIME_CLI_REQUIREMENTS_GZIP_BASE64,
	PRIME_CLI_REQUIREMENTS_GZIP_SHA256,
	PRIME_CLI_REQUIREMENTS_SHA256,
} from "./prime-cli-requirements-v1.js";
import { isSandboxProviderBinder, type RunCommand } from "./prime-sandbox-lifecycle.js";
import type {
	SandboxFetchPort,
	SandboxProviderFactoryResult,
	SandboxRuntimeConnectPort,
} from "./prime-sandbox-provider.js";

export const MANAGED_PRIME_CLI_LIFECYCLE_EXECUTABLE = "/prime-agent-managed/prime-cli-0.6.21";
const PRIME_VERSION = "0.6.21";
const SANDBOXES_VERSION = "0.2.40";
const PRIVATE_TOOLS_DIRECTORY = "private-tools-v1";
const MANAGED_DIRECTORY = "prime-cli-v1";
const LOCK_FILE = "prime-cli-v1.lock";
const REQUIREMENTS_FILE = "requirements.lock";
const WHEELS_DIRECTORY = "wheels";
const TEMP_DIRECTORY = "tmp";
const MARKER_FILE = ".prime-cli-v1.json";
const MAX_PATH_BYTES = 4_096;
const MAX_REQUIREMENTS_BYTES = 131_072;
const MAX_WHEEL_BYTES = 65_536;
const EXPECTED_LOCKED_PACKAGES = 121;
const LOCK_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 600_000;
const VERIFY_TIMEOUT_MS = 60_000;
const MODE_PRIVATE_DIRECTORY = 0o700;
const MODE_PRIVATE_FILE = 0o600;
const ISSUE = Object.freeze({});

const MARKER = `{"schema":1,"pythonVersion":"3.11","primeVersion":"${PRIME_VERSION}","sandboxesVersion":"${SANDBOXES_VERSION}","requirementsSha256":"${PRIME_CLI_REQUIREMENTS_SHA256}","wheelSha256":"${PRIME_CLI_GITIGNORE_WHEEL_SHA256}","verified":true}
`;

const CLEANUP_SCRIPT = [
	"import os, stat, sys",
	"parent_path, expected = sys.argv[1:3]",
	"if expected != 'prime-cli-v1': raise SystemExit(91)",
	"flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)",
	"pfd = os.open(parent_path, flags)",
	"count = 0",
	"def checked_dir(parent, name, before):",
	"    fd = os.open(name, flags, dir_fd=parent)",
	"    after = os.fstat(fd)",
	"    if not stat.S_ISDIR(after.st_mode) or after.st_uid != os.getuid() or (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino): raise SystemExit(91)",
	"    return fd",
	"def clear(fd):",
	"    global count",
	"    before = os.fstat(fd)",
	"    if not stat.S_ISDIR(before.st_mode) or before.st_uid != os.getuid(): raise SystemExit(91)",
	"    names = os.listdir(fd)",
	"    if len(names) > 200000: raise SystemExit(91)",
	"    for name in names:",
	"        count += 1",
	"        if count > 200000 or not name or '/' in name or name in ('.', '..'): raise SystemExit(91)",
	"        item = os.stat(name, dir_fd=fd, follow_symlinks=False)",
	"        if stat.S_ISDIR(item.st_mode):",
	"            child = checked_dir(fd, name, item)",
	"            try: clear(child)",
	"            finally: os.close(child)",
	"            current = os.stat(name, dir_fd=fd, follow_symlinks=False)",
	"            if (current.st_dev, current.st_ino) != (item.st_dev, item.st_ino): raise SystemExit(91)",
	"            os.rmdir(name, dir_fd=fd)",
	"        elif stat.S_ISREG(item.st_mode) or stat.S_ISLNK(item.st_mode):",
	"            os.unlink(name, dir_fd=fd)",
	"        else: raise SystemExit(91)",
	"    after = os.fstat(fd)",
	"    if (after.st_dev, after.st_ino) != (before.st_dev, before.st_ino): raise SystemExit(91)",
	"try:",
	"    ps = os.fstat(pfd)",
	"    if not stat.S_ISDIR(ps.st_mode) or ps.st_uid != os.getuid() or stat.S_IMODE(ps.st_mode) != 0o700: raise SystemExit(91)",
	"    try: root_stat = os.stat(expected, dir_fd=pfd, follow_symlinks=False)",
	"    except FileNotFoundError: raise SystemExit(0)",
	"    if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != os.getuid() or stat.S_IMODE(root_stat.st_mode) != 0o700: raise SystemExit(91)",
	"    rfd = checked_dir(pfd, expected, root_stat)",
	"    try: clear(rfd)",
	"    finally: os.close(rfd)",
	"    current = os.stat(expected, dir_fd=pfd, follow_symlinks=False)",
	"    if (current.st_dev, current.st_ino) != (root_stat.st_dev, root_stat.st_ino): raise SystemExit(91)",
	"    os.rmdir(expected, dir_fd=pfd)",
	"    os.fsync(pfd)",
	"finally: os.close(pfd)",
].join("\n");

const VERIFY_SCRIPT = [
	"import importlib.metadata as md, os, pathlib, sys",
	"from packaging.requirements import Requirement",
	"from packaging.utils import canonicalize_name",
	"root = pathlib.Path(sys.argv[1]).resolve(strict=True)",
	"req_path = pathlib.Path(sys.argv[2]).resolve(strict=True)",
	"if os.path.commonpath([str(root), str(req_path)]) != str(root): raise SystemExit(91)",
	"expected = {}",
	"for line in req_path.read_text(encoding='utf-8').splitlines():",
	"    if not line or line[0].isspace() or line.startswith('#'): continue",
	"    raw = line[:-2] if line.endswith(chr(32) + chr(92)) else line",
	"    req = Requirement(raw)",
	"    if req.marker is None or req.marker.evaluate():",
	"        versions = list(req.specifier)",
	"        if len(versions) != 1 or versions[0].operator != '==': raise SystemExit(91)",
	"        name = canonicalize_name(req.name)",
	"        if name in expected: raise SystemExit(91)",
	"        expected[name] = versions[0].version",
	"actual = {}",
	"for dist in md.distributions():",
	"    name = canonicalize_name(dist.metadata['Name'])",
	"    if name == 'pip': continue",
	"    if name in actual: raise SystemExit(91)",
	"    actual[name] = dist.version",
	"    origin = pathlib.Path(dist.locate_file('')).resolve(strict=True)",
	"    if os.path.commonpath([str(root), str(origin)]) != str(root): raise SystemExit(91)",
	"if actual != expected: raise SystemExit(91)",
	"pip_origin = pathlib.Path(md.distribution('pip').locate_file('')).resolve(strict=True)",
	"if os.path.commonpath([str(root), str(pip_origin)]) != str(root): raise SystemExit(91)",
	"import prime_cli, prime_sandboxes",
	"for module in (prime_cli, prime_sandboxes):",
	"    origin = pathlib.Path(module.__file__).resolve(strict=True)",
	"    if os.path.commonpath([str(root), str(origin)]) != str(root): raise SystemExit(91)",
	"executable = pathlib.Path(sys.executable).resolve(strict=True)",
	"if os.path.commonpath([str(root), str(executable)]) != str(root): raise SystemExit(91)",
	"if md.version('prime') != '0.6.21' or md.version('prime-sandboxes') != '0.2.40': raise SystemExit(91)",
	"sys.stdout.write('VERIFIED ' + str(len(actual)) + ' 0.6.21 0.2.40\\n')",
].join("\n");

function pythonCommand(script: string): string {
	return `import base64;exec(base64.b64decode('${Buffer.from(script).toString("base64")}'))`;
}

const CLEANUP_COMMAND = pythonCommand(CLEANUP_SCRIPT);
const VERIFY_COMMAND = pythonCommand(VERIFY_SCRIPT);
const BASE_VERSION_COMMAND = pythonCommand(
	"import sys;sys.stdout.write('PYTHON 3.11\\n') if sys.version_info[:2] == (3, 11) else sys.exit(91)",
);
const MINIMAL_ENVIRONMENT = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });

interface AuthorityState {
	readonly primePath: string;
	readonly managedRoot: string;
	readonly environment: Readonly<Record<string, string>>;
}

export class PrimeCliAuthority {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(PrimeCliAuthority.prototype);
Object.freeze(PrimeCliAuthority);
const authorities = new WeakMap<object, AuthorityState>();

export class PrimeCliCredentialAuthority {
	constructor(token: object) {
		if (token !== ISSUE) throw new Error();
		Object.freeze(this);
	}
}

Object.freeze(PrimeCliCredentialAuthority.prototype);
Object.freeze(PrimeCliCredentialAuthority);
const credentials = new WeakMap<object, Uint8Array<ArrayBuffer>>();

type PrimeCliCredentialResult =
	| Readonly<{ ok: true; value: PrimeCliCredentialAuthority }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" }>;

function copyCredentialBytes(value: unknown): Uint8Array<ArrayBuffer> | undefined {
	try {
		if (
			typeof value !== "object" ||
			value === null ||
			types.isProxy(value) ||
			!types.isUint8Array(value) ||
			Object.getPrototypeOf(value) !== Uint8Array.prototype ||
			Object.hasOwn(value, "buffer") ||
			Object.hasOwn(value, "byteLength") ||
			Object.hasOwn(value, "byteOffset") ||
			Object.hasOwn(value, "length")
		) {
			return undefined;
		}
		const buffer = value.buffer;
		if (
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
			Object.hasOwn(buffer, "resizable") ||
			value.byteOffset !== 0 ||
			value.byteLength !== buffer.byteLength ||
			value.byteLength < 1 ||
			value.byteLength > 4_096
		) {
			return undefined;
		}
		const resizableGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")?.get;
		if (resizableGetter !== undefined && resizableGetter.call(buffer) === true) return undefined;
		const result = new Uint8Array(new ArrayBuffer(value.byteLength));
		for (let index = 0; index < value.byteLength; index += 1) {
			const byte = value[index];
			if (byte < 0x21 || byte > 0x7e) {
				result.fill(0);
				return undefined;
			}
			result[index] = byte;
		}
		if (value.byteLength !== buffer.byteLength || value.byteOffset !== 0) {
			result.fill(0);
			return undefined;
		}
		return result;
	} catch {
		return undefined;
	}
}

export function createPrimeCliCredentialAuthority(value: unknown): PrimeCliCredentialResult {
	const copied = copyCredentialBytes(value);
	if (copied === undefined) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	const authority = new PrimeCliCredentialAuthority(ISSUE);
	credentials.set(authority, copied);
	return Object.freeze({ ok: true, value: authority });
}

export function closePrimeCliCredentialAuthority(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const bytes = credentials.get(value);
	if (bytes === undefined) return false;
	bytes.fill(0);
	return credentials.delete(value);
}

type PrimeCliProvisionResult =
	| Readonly<{ ok: true; value: PrimeCliAuthority }>
	| Readonly<{
			ok: false;
			code:
				| "INPUT_INVALID"
				| "ABORTED"
				| "FILESYSTEM_UNSAFE"
				| "LOCK_FAILED"
				| "ASSET_INVALID"
				| "INSTALL_FAILED"
				| "VERIFY_FAILED"
				| "CLEANUP_UNCERTAIN";
	  }>;

function failed(
	code:
		| "INPUT_INVALID"
		| "ABORTED"
		| "FILESYSTEM_UNSAFE"
		| "LOCK_FAILED"
		| "ASSET_INVALID"
		| "INSTALL_FAILED"
		| "VERIFY_FAILED"
		| "CLEANUP_UNCERTAIN",
): PrimeCliProvisionResult {
	return Object.freeze({ ok: false, code });
}

function exactPath(value: unknown): value is string {
	if (typeof value !== "string" || value.length < 1 || value.charCodeAt(0) !== 0x2f) return false;
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit <= 0x7f) bytes += 1;
		else if (unit <= 0x7ff) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
		else bytes += 3;
		if (bytes > MAX_PATH_BYTES) return false;
	}
	try {
		return resolve(value) === value;
	} catch {
		return false;
	}
}

function uid(): number | undefined {
	try {
		const getUid = process.getuid;
		if (getUid === undefined) return undefined;
		const value = getUid();
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

function validAgentHome(path: string, expectedUid: number): boolean {
	try {
		const stat = lstatSync(path);
		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.uid === expectedUid &&
			stat.nlink >= 1 &&
			(stat.mode & 0o022) === 0 &&
			realpathSync(path) === path
		);
	} catch {
		return false;
	}
}

function validDirectory(path: string, expectedUid: number, exactMode: number): boolean {
	try {
		const stat = lstatSync(path);
		return (
			stat.isDirectory() &&
			!stat.isSymbolicLink() &&
			stat.uid === expectedUid &&
			stat.nlink >= 1 &&
			(stat.mode & 0o777) === exactMode &&
			realpathSync(path) === path
		);
	} catch {
		return false;
	}
}

function validFile(path: string, expectedUid: number, exactMode: number): boolean {
	try {
		const stat = lstatSync(path);
		return (
			stat.isFile() &&
			!stat.isSymbolicLink() &&
			stat.uid === expectedUid &&
			stat.nlink === 1 &&
			(stat.mode & 0o777) === exactMode
		);
	} catch {
		return false;
	}
}

function digestHex(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function canonicalBase64(value: string, maximum: number): Uint8Array<ArrayBuffer> | undefined {
	try {
		const decoded = Buffer.from(value, "base64");
		if (decoded.byteLength < 1 || decoded.byteLength > maximum || decoded.toString("base64") !== value)
			return undefined;
		const result = new Uint8Array(new ArrayBuffer(decoded.byteLength));
		result.set(decoded);
		decoded.fill(0);
		return result;
	} catch {
		return undefined;
	}
}

interface Assets {
	readonly requirements: Uint8Array<ArrayBuffer>;
	readonly wheel: Uint8Array<ArrayBuffer>;
}

function loadAssets(): Assets | undefined {
	const compressed = canonicalBase64(PRIME_CLI_REQUIREMENTS_GZIP_BASE64, MAX_REQUIREMENTS_BYTES);
	const wheel = canonicalBase64(PRIME_CLI_GITIGNORE_WHEEL_BASE64, MAX_WHEEL_BYTES);
	if (compressed === undefined || wheel === undefined) {
		compressed?.fill(0);
		wheel?.fill(0);
		return undefined;
	}
	if (
		digestHex(compressed) !== PRIME_CLI_REQUIREMENTS_GZIP_SHA256 ||
		digestHex(wheel) !== PRIME_CLI_GITIGNORE_WHEEL_SHA256
	) {
		compressed.fill(0);
		wheel.fill(0);
		return undefined;
	}
	let unzipped: Buffer;
	try {
		unzipped = gunzipSync(compressed, { maxOutputLength: MAX_REQUIREMENTS_BYTES });
	} catch {
		compressed.fill(0);
		wheel.fill(0);
		return undefined;
	}
	compressed.fill(0);
	const requirements = new Uint8Array(new ArrayBuffer(unzipped.byteLength));
	requirements.set(unzipped);
	unzipped.fill(0);
	if (digestHex(requirements) !== PRIME_CLI_REQUIREMENTS_SHA256) {
		requirements.fill(0);
		wheel.fill(0);
		return undefined;
	}
	let requirementsText: string;
	try {
		requirementsText = new TextDecoder("utf-8", { fatal: true }).decode(requirements);
	} catch {
		requirements.fill(0);
		wheel.fill(0);
		return undefined;
	}
	const packages = requirementsText
		.split("\n")
		.filter(
			(line) => line.length > 0 && line.charCodeAt(0) !== 0x23 && line.charCodeAt(0) !== 0x20 && line.includes("=="),
		);
	if (
		packages.length !== EXPECTED_LOCKED_PACKAGES ||
		!packages.includes(`prime==${PRIME_VERSION} \\`) ||
		!packages.includes(`prime-sandboxes==${SANDBOXES_VERSION} \\`)
	) {
		requirements.fill(0);
		wheel.fill(0);
		return undefined;
	}
	return Object.freeze({ requirements, wheel });
}

function sameMetadata(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function readProtectedFile(path: string, expectedUid: number, maximum: number): Uint8Array<ArrayBuffer> | undefined {
	let descriptor: number | undefined;
	let result: Uint8Array<ArrayBuffer> | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = fstatSync(descriptor);
		if (
			!before.isFile() ||
			before.uid !== expectedUid ||
			before.nlink !== 1 ||
			(before.mode & 0o777) !== MODE_PRIVATE_FILE ||
			!Number.isSafeInteger(before.size) ||
			before.size < 1 ||
			before.size > maximum
		) {
			return undefined;
		}
		const bytes = new Uint8Array(new ArrayBuffer(before.size));
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
			if (count < 1) {
				bytes.fill(0);
				return undefined;
			}
			offset += count;
		}
		const after = fstatSync(descriptor);
		if (!sameMetadata(before, after)) {
			bytes.fill(0);
			return undefined;
		}
		result = bytes;
	} catch {
		result = undefined;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				result?.fill(0);
				result = undefined;
			}
		}
	}
	return result;
}

function writeProtectedFile(path: string, bytes: Uint8Array, expectedUid: number): boolean {
	let descriptor: number | undefined;
	let valid = false;
	try {
		descriptor = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			MODE_PRIVATE_FILE,
		);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const count = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
			if (count < 1) return false;
			offset += count;
		}
		fsyncSync(descriptor);
		const stat = fstatSync(descriptor);
		valid =
			stat.isFile() &&
			stat.uid === expectedUid &&
			stat.nlink === 1 &&
			(stat.mode & 0o777) === MODE_PRIVATE_FILE &&
			stat.size === bytes.byteLength;
	} catch {
		valid = false;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				valid = false;
			}
		}
	}
	return valid;
}

function syncDirectory(path: string, expectedUid: number): boolean {
	let descriptor: number | undefined;
	let valid = false;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const stat = fstatSync(descriptor);
		if (!stat.isDirectory() || stat.uid !== expectedUid || (stat.mode & 0o777) !== MODE_PRIVATE_DIRECTORY) {
			return false;
		}
		fsyncSync(descriptor);
		valid = true;
	} catch {
		valid = false;
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				valid = false;
			}
		}
	}
	return valid;
}

function markerValid(path: string, expectedUid: number): boolean {
	const bytes = readProtectedFile(path, expectedUid, 1_024);
	if (bytes === undefined) return false;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === MARKER;
	} catch {
		return false;
	} finally {
		bytes.fill(0);
	}
}

function assetsOnDiskValid(requirementsPath: string, wheelPath: string, expectedUid: number): boolean {
	const requirements = readProtectedFile(requirementsPath, expectedUid, MAX_REQUIREMENTS_BYTES);
	const wheel = readProtectedFile(wheelPath, expectedUid, MAX_WHEEL_BYTES);
	try {
		return (
			requirements !== undefined &&
			wheel !== undefined &&
			digestHex(requirements) === PRIME_CLI_REQUIREMENTS_SHA256 &&
			digestHex(wheel) === PRIME_CLI_GITIGNORE_WHEEL_SHA256
		);
	} finally {
		requirements?.fill(0);
		wheel?.fill(0);
	}
}

function commandEnvironment(managedRoot: string, temporary: string): Readonly<Record<string, string>> {
	return Object.freeze({
		HOME: managedRoot,
		TMPDIR: temporary,
		PATH: "/usr/bin:/bin",
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		PYTHONNOUSERSITE: "1",
		PIP_CONFIG_FILE: "/dev/null",
		PIP_DISABLE_PIP_VERSION_CHECK: "1",
		PIP_NO_INPUT: "1",
	});
}

async function cleanupRoot(
	basePython: string,
	privateTools: string,
	environment: Readonly<Record<string, string>>,
	signal?: AbortSignal,
): Promise<boolean> {
	const result = await runPrimeCliProcess(
		[basePython, "-I", "-S", "-c", CLEANUP_COMMAND, privateTools, MANAGED_DIRECTORY],
		environment,
		"/",
		VERIFY_TIMEOUT_MS,
		signal,
	);
	return result.ok && result.value.exitCode === 0 && result.value.stdout === "" && result.value.stderr === "";
}

async function verifyBasePython(basePython: string, signal?: AbortSignal): Promise<PrimeCliProcessResult> {
	return await runPrimeCliProcess(
		[basePython, "-I", "-S", "-c", BASE_VERSION_COMMAND],
		MINIMAL_ENVIRONMENT,
		"/",
		VERIFY_TIMEOUT_MS,
		signal,
	);
}

function verifyProcessFailure(result: PrimeCliProcessResult): "ABORTED" | "INSTALL_FAILED" {
	return !result.ok && result.code === "ABORTED" ? "ABORTED" : "INSTALL_FAILED";
}

async function verifyInstallation(
	pythonPath: string,
	primePath: string,
	managedRoot: string,
	requirementsPath: string,
	environment: Readonly<Record<string, string>>,
	expectedUid: number,
	lock: PrimeCliProvisioningLock,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!validFile(pythonPath, expectedUid, 0o755) && !validFile(pythonPath, expectedUid, 0o700)) return false;
	if (!validFile(primePath, expectedUid, 0o755) && !validFile(primePath, expectedUid, 0o700)) return false;
	try {
		for (const candidate of [realpathSync(pythonPath), realpathSync(primePath)]) {
			const relation = relative(managedRoot, resolve(candidate));
			if (relation.length < 1 || relation === ".." || relation.split("/")[0] === ".." || isAbsolute(relation))
				return false;
		}
	} catch {
		return false;
	}
	const verified = await runPrimeCliProcess(
		[pythonPath, "-I", "-c", VERIFY_COMMAND, managedRoot, requirementsPath],
		environment,
		managedRoot,
		VERIFY_TIMEOUT_MS,
		signal,
	);
	if (
		!verified.ok ||
		verified.value.exitCode !== 0 ||
		verified.value.stderr !== "" ||
		!/^VERIFIED [1-9][0-9]{2,3} 0\.6\.21 0\.2\.40\n$/.test(verified.value.stdout)
	) {
		return false;
	}
	if (!primeCliProvisioningLockAlive(lock)) return false;
	const version = await runPrimeCliProcess(
		[primePath, "--version"],
		environment,
		managedRoot,
		VERIFY_TIMEOUT_MS,
		signal,
	);
	return (
		version.ok &&
		version.value.exitCode === 0 &&
		version.value.stdout === "Prime CLI version: 0.6.21\n" &&
		version.value.stderr === "" &&
		primeCliProvisioningLockAlive(lock)
	);
}

function ensurePrivateTools(agentHome: string, expectedUid: number): Promise<string | undefined> {
	return (async () => {
		if (!validAgentHome(agentHome, expectedUid)) return undefined;
		const path = join(agentHome, PRIVATE_TOOLS_DIRECTORY);
		try {
			await mkdir(path, { mode: MODE_PRIVATE_DIRECTORY });
		} catch {
			// Existing directory is validated below.
		}
		return validDirectory(path, expectedUid, MODE_PRIVATE_DIRECTORY) && syncDirectory(path, expectedUid)
			? path
			: undefined;
	})();
}

async function releaseLock(lock: PrimeCliProvisioningLock): Promise<boolean> {
	const released = await releasePrimeCliProvisioningLock(lock);
	return released.ok;
}

export async function provisionPrimeCliV1(
	agentHomeValue: unknown,
	basePythonValue: unknown,
	signal?: AbortSignal,
): Promise<PrimeCliProvisionResult> {
	if (!exactPath(agentHomeValue) || !exactPath(basePythonValue)) return failed("INPUT_INVALID");
	if (process.platform !== "darwin" && process.platform !== "linux") return failed("INPUT_INVALID");
	const expectedUid = uid();
	if (expectedUid === undefined) return failed("FILESYSTEM_UNSAFE");
	const privateTools = await ensurePrivateTools(agentHomeValue, expectedUid);
	if (privateTools === undefined) return failed("FILESYSTEM_UNSAFE");
	const managedRoot = join(privateTools, MANAGED_DIRECTORY);
	const lockPath = join(privateTools, LOCK_FILE);
	const requirementsPath = join(managedRoot, REQUIREMENTS_FILE);
	const wheelDirectory = join(managedRoot, WHEELS_DIRECTORY);
	const wheelPath = join(wheelDirectory, PRIME_CLI_GITIGNORE_WHEEL_NAME);
	const temporary = join(managedRoot, TEMP_DIRECTORY);
	const markerPath = join(managedRoot, MARKER_FILE);
	const pythonPath = join(managedRoot, "bin", "python3.11");
	const primePath = join(managedRoot, "bin", "prime");
	const environment = commandEnvironment(managedRoot, temporary);
	const lockResult = await acquirePrimeCliProvisioningLock(
		basePythonValue,
		lockPath,
		MINIMAL_ENVIRONMENT,
		LOCK_TIMEOUT_MS,
		signal,
	);
	if (!lockResult.ok) {
		return failed(lockResult.code === "ABORTED" ? "ABORTED" : "LOCK_FAILED");
	}
	const lock = lockResult.value;
	let result: PrimeCliProvisionResult = failed("VERIFY_FAILED");
	let needsCleanup = false;
	try {
		const baseCheck = await verifyBasePython(basePythonValue, signal);
		if (
			!baseCheck.ok ||
			baseCheck.value.exitCode !== 0 ||
			baseCheck.value.stdout !== "PYTHON 3.11\n" ||
			baseCheck.value.stderr !== ""
		) {
			result = failed(verifyProcessFailure(baseCheck));
		} else if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
		else {
			const cached =
				validDirectory(managedRoot, expectedUid, MODE_PRIVATE_DIRECTORY) &&
				validDirectory(wheelDirectory, expectedUid, MODE_PRIVATE_DIRECTORY) &&
				validDirectory(temporary, expectedUid, MODE_PRIVATE_DIRECTORY) &&
				markerValid(markerPath, expectedUid) &&
				assetsOnDiskValid(requirementsPath, wheelPath, expectedUid) &&
				(await verifyInstallation(
					pythonPath,
					primePath,
					managedRoot,
					requirementsPath,
					environment,
					expectedUid,
					lock,
					signal,
				));
			if (cached && !primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
			else if (cached) {
				const authority = new PrimeCliAuthority(ISSUE);
				authorities.set(authority, Object.freeze({ primePath, managedRoot, environment }));
				result = Object.freeze({ ok: true, value: authority });
			} else {
				needsCleanup = true;
				if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
				else {
					const cleaned = await cleanupRoot(basePythonValue, privateTools, environment);
					if (!cleaned) result = failed("CLEANUP_UNCERTAIN");
					else if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
					else {
						try {
							await mkdir(managedRoot, { mode: MODE_PRIVATE_DIRECTORY });
							await mkdir(wheelDirectory, { mode: MODE_PRIVATE_DIRECTORY });
							await mkdir(temporary, { mode: MODE_PRIVATE_DIRECTORY });
						} catch {
							result = failed("FILESYSTEM_UNSAFE");
						}
						if (
							!validDirectory(managedRoot, expectedUid, MODE_PRIVATE_DIRECTORY) ||
							!validDirectory(wheelDirectory, expectedUid, MODE_PRIVATE_DIRECTORY) ||
							!validDirectory(temporary, expectedUid, MODE_PRIVATE_DIRECTORY) ||
							!primeCliProvisioningLockAlive(lock)
						) {
							result = failed("FILESYSTEM_UNSAFE");
						} else {
							const assets = loadAssets();
							if (assets === undefined) result = failed("ASSET_INVALID");
							else {
								try {
									const wroteRequirements = writeProtectedFile(
										requirementsPath,
										assets.requirements,
										expectedUid,
									);
									const wroteWheel = writeProtectedFile(wheelPath, assets.wheel, expectedUid);
									if (
										!wroteRequirements ||
										!primeCliProvisioningLockAlive(lock) ||
										!wroteWheel ||
										!assetsOnDiskValid(requirementsPath, wheelPath, expectedUid) ||
										!syncDirectory(wheelDirectory, expectedUid) ||
										!syncDirectory(managedRoot, expectedUid)
									) {
										result = failed("FILESYSTEM_UNSAFE");
									} else {
										const venv = await runPrimeCliProcess(
											[basePythonValue, "-I", "-m", "venv", "--copies", managedRoot],
											environment,
											"/",
											VERIFY_TIMEOUT_MS,
											signal,
										);
										if (!venv.ok || venv.value.exitCode !== 0) result = failed(verifyProcessFailure(venv));
										else if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
										else {
											const install = await runPrimeCliProcess(
												[
													pythonPath,
													"-I",
													"-m",
													"pip",
													"install",
													"--isolated",
													"--disable-pip-version-check",
													"--no-input",
													"--require-hashes",
													"--only-binary=:all:",
													"--no-compile",
													"--no-cache-dir",
													"--quiet",
													"--progress-bar",
													"off",
													"--index-url",
													"https://pypi.org/simple",
													"--find-links",
													wheelDirectory,
													"-r",
													requirementsPath,
												],
												environment,
												managedRoot,
												COMMAND_TIMEOUT_MS,
												signal,
											);
											if (!install.ok || install.value.exitCode !== 0)
												result = failed(verifyProcessFailure(install));
											else if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
											else {
												const uninstall = await runPrimeCliProcess(
													[pythonPath, "-I", "-m", "pip", "uninstall", "-y", "setuptools"],
													environment,
													managedRoot,
													VERIFY_TIMEOUT_MS,
													signal,
												);
												if (!uninstall.ok || uninstall.value.exitCode !== 0) {
													result = failed(verifyProcessFailure(uninstall));
												} else if (!primeCliProvisioningLockAlive(lock)) result = failed("LOCK_FAILED");
												else if (
													!(await verifyInstallation(
														pythonPath,
														primePath,
														managedRoot,
														requirementsPath,
														environment,
														expectedUid,
														lock,
														signal,
													))
												) {
													result = failed(
														primeCliProvisioningLockAlive(lock) ? "VERIFY_FAILED" : "LOCK_FAILED",
													);
												} else {
													const markerBytes = new TextEncoder().encode(MARKER);
													if (
														!primeCliProvisioningLockAlive(lock) ||
														!writeProtectedFile(markerPath, markerBytes, expectedUid) ||
														!markerValid(markerPath, expectedUid) ||
														!assetsOnDiskValid(requirementsPath, wheelPath, expectedUid) ||
														!syncDirectory(managedRoot, expectedUid) ||
														!primeCliProvisioningLockAlive(lock)
													) {
														result = failed("FILESYSTEM_UNSAFE");
													} else {
														const authority = new PrimeCliAuthority(ISSUE);
														authorities.set(
															authority,
															Object.freeze({ primePath, managedRoot, environment }),
														);
														result = Object.freeze({ ok: true, value: authority });
														needsCleanup = false;
													}
												}
											}
										}
									}
								} finally {
									assets.requirements.fill(0);
									assets.wheel.fill(0);
								}
							}
						}
					}
				}
			}
		}
	} catch {
		result = failed("FILESYSTEM_UNSAFE");
		needsCleanup = true;
	}
	if (needsCleanup && primeCliProvisioningLockAlive(lock)) {
		if (!(await cleanupRoot(basePythonValue, privateTools, environment))) result = failed("CLEANUP_UNCERTAIN");
	}
	if (!(await releaseLock(lock))) return failed("CLEANUP_UNCERTAIN");
	return result;
}

export function bindPrimeSandboxProviderWithCredential(
	binderValue: unknown,
	handle: unknown,
	credentialValue: unknown,
	dispatch?: SandboxFetchPort,
	connectRuntime?: SandboxRuntimeConnectPort,
): SandboxProviderFactoryResult {
	if (!isSandboxProviderBinder(binderValue) || typeof credentialValue !== "object" || credentialValue === null) {
		return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	}
	const credential = credentials.get(credentialValue);
	if (credential === undefined) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	try {
		const apiKey = new TextDecoder("utf-8", { fatal: true }).decode(credential);
		return binderValue.bind(handle, apiKey, dispatch, connectRuntime);
	} catch {
		return Object.freeze({ ok: false, code: "INPUT_INVALID" });
	}
}

export function createPrimeCliRunCommand(value: unknown, credentialValue: unknown): RunCommand | undefined {
	if (
		typeof value !== "object" ||
		value === null ||
		!authorities.has(value) ||
		typeof credentialValue !== "object" ||
		credentialValue === null ||
		!credentials.has(credentialValue)
	) {
		return undefined;
	}
	return async (argv, timeoutMs, signal) => {
		const state = authorities.get(value);
		const credential = credentials.get(credentialValue);
		if (state === undefined || credential === undefined) {
			return Object.freeze({ ok: false, code: "INPUT_INVALID" });
		}
		const environment = Object.freeze({
			...state.environment,
			PRIME_API_KEY: new TextDecoder("utf-8", { fatal: true }).decode(credential),
		});
		return await runPrimeCliReplacingExecutable(
			state.primePath,
			MANAGED_PRIME_CLI_LIFECYCLE_EXECUTABLE,
			argv,
			environment,
			state.managedRoot,
			timeoutMs,
			signal,
		);
	};
}

export function closePrimeCliAuthority(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	return authorities.delete(value);
}
