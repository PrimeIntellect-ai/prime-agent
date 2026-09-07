import { afterEach, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const PRIVATE_ROOT = "\x01prime-agent-ws-v1";
const roots: string[] = [];
const fixtures: string[] = [];
type Bytes = Uint8Array<ArrayBuffer>;

function bytesFromArray(values: readonly Uint8Array<ArrayBufferLike>[]): Bytes {
	const size = values.reduce((total, value) => total + value.byteLength, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const value of values) {
		result.set(value, offset);
		offset += value.byteLength;
	}
	return result;
}

function bytes(
	value1: Uint8Array<ArrayBufferLike>,
	value2?: Uint8Array<ArrayBufferLike>,
	value3?: Uint8Array<ArrayBufferLike>,
	value4?: Uint8Array<ArrayBufferLike>,
	value5?: Uint8Array<ArrayBufferLike>,
	value6?: Uint8Array<ArrayBufferLike>,
	value7?: Uint8Array<ArrayBufferLike>,
	value8?: Uint8Array<ArrayBufferLike>,
	value9?: Uint8Array<ArrayBufferLike>,
	value10?: Uint8Array<ArrayBufferLike>,
): Bytes {
	const candidates = [value1, value2, value3, value4, value5, value6, value7, value8, value9, value10];
	const values: Uint8Array<ArrayBufferLike>[] = [];
	for (const candidate of candidates) if (candidate !== undefined) values.push(candidate);
	return bytesFromArray(values);
}

function u16(value: number): Bytes {
	const result = new Uint8Array(2);
	new DataView(result.buffer).setUint16(0, value, false);
	return result;
}

function u32(value: number): Bytes {
	const result = new Uint8Array(4);
	new DataView(result.buffer).setUint32(0, value, false);
	return result;
}

function u64(value: number): Bytes {
	const result = new Uint8Array(8);
	new DataView(result.buffer).setBigUint64(0, BigInt(value), false);
	return result;
}

function random32(): Bytes {
	return new Uint8Array(randomBytes(32));
}

function hash(value: Uint8Array<ArrayBufferLike>): Bytes {
	return new Uint8Array(createHash("sha256").update(value).digest());
}

function domainHashFromArray(prefix: string, parts: readonly Uint8Array<ArrayBufferLike>[]): Bytes {
	const digest = createHash("sha256").update(new TextEncoder().encode(prefix));
	for (const part of parts) digest.update(u64(part.byteLength)).update(part);
	return new Uint8Array(digest.digest());
}

function domainHash(
	prefix: string,
	part1: Uint8Array<ArrayBufferLike>,
	part2?: Uint8Array<ArrayBufferLike>,
	part3?: Uint8Array<ArrayBufferLike>,
	part4?: Uint8Array<ArrayBufferLike>,
	part5?: Uint8Array<ArrayBufferLike>,
	part6?: Uint8Array<ArrayBufferLike>,
	part7?: Uint8Array<ArrayBufferLike>,
	part8?: Uint8Array<ArrayBufferLike>,
	part9?: Uint8Array<ArrayBufferLike>,
): Bytes {
	const candidates = [part1, part2, part3, part4, part5, part6, part7, part8, part9];
	const parts: Uint8Array<ArrayBufferLike>[] = [];
	for (const candidate of candidates) if (candidate !== undefined) parts.push(candidate);
	return domainHashFromArray(prefix, parts);
}

function frame(opcode: number, payload: Uint8Array<ArrayBufferLike> = new Uint8Array(0)): Bytes {
	return bytes(new Uint8Array([opcode]), u32(payload.byteLength), payload);
}

interface Response {
	readonly status: number;
	readonly payload: Bytes;
}

function parseFrames(outputRaw: Uint8Array<ArrayBufferLike>): Response[] {
	const output = new Uint8Array(outputRaw);
	const result: Response[] = [];
	let offset = 0;
	while (offset < output.byteLength) {
		if (output.byteLength - offset < 5) return [];
		const view = new DataView(output.buffer, output.byteOffset + offset, output.byteLength - offset);
		const status = view.getUint8(0);
		const length = view.getUint32(1, false);
		offset += 5;
		if (output.byteLength - offset < length) return [];
		result.push({ status, payload: output.slice(offset, offset + length) });
		offset += length;
	}
	return result;
}

function freshRoot(): string {
	const root = join(homedir(), ".prime", "agent", "sandbox-sessions", randomBytes(32).toString("hex"));
	mkdirSync(root, { recursive: true, mode: 0o700 });
	chmodSync(root, 0o700);
	roots.push(root);
	return root;
}

function run(input: Uint8Array<ArrayBufferLike>, maxBuffer = 4_194_304) {
	return spawnSync(PYTHON, [HELPER], {
		cwd: "/",
		env: {},
		input,
		maxBuffer,
		timeout: 10_000,
	});
}

interface InteractiveResult {
	readonly output: Buffer;
	readonly stderr: Buffer;
	readonly exitCode: number | null;
	readonly reachedBoundary: boolean;
}

async function runWithMutation(
	prefix: Uint8Array<ArrayBufferLike>,
	expectedFrames: number,
	mutate: () => void,
	suffix: Uint8Array<ArrayBufferLike>,
): Promise<InteractiveResult> {
	const child = spawn(PYTHON, [HELPER], { cwd: "/", env: {}, stdio: ["pipe", "pipe", "pipe"] });
	const output: Buffer[] = [];
	const errors: Buffer[] = [];
	let reachedBoundary = false;
	let resolveBoundary: (() => void) | undefined;
	const boundary = new Promise<void>((resolve) => {
		resolveBoundary = resolve;
	});
	child.stdout.on("data", (chunk: Buffer) => {
		output.push(Buffer.from(chunk));
		if (parseFrames(Buffer.concat(output)).length >= expectedFrames) {
			reachedBoundary = true;
			if (resolveBoundary !== undefined) resolveBoundary();
		}
	});
	child.stderr.on("data", (chunk: Buffer) => errors.push(Buffer.from(chunk)));
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	child.stdin.write(prefix);
	await Promise.race([boundary, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
	if (reachedBoundary) mutate();
	child.stdin.end(suffix);
	await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
	if (child.exitCode === null && child.pid !== undefined) child.kill("SIGKILL");
	if (child.exitCode === null) await closed;
	return {
		output: Buffer.concat(output),
		stderr: Buffer.concat(errors),
		exitCode: child.exitCode,
		reachedBoundary,
	};
}

function record(
	tag: number,
	revision: number,
	previous: Uint8Array<ArrayBufferLike>,
	payload: Uint8Array<ArrayBufferLike>,
): Bytes {
	return bytes(new Uint8Array([tag]), u32(revision), previous, hash(payload), u32(payload.byteLength), payload);
}

interface Entry {
	readonly kind: 0 | 1 | 2;
	readonly path: Bytes;
	readonly pre: Bytes;
	readonly post: Bytes;
	readonly payload: Bytes;
	readonly digest: Bytes;
	readonly preDigest: Bytes;
	readonly postDigest: Bytes;
}

function absence(path: Uint8Array<ArrayBufferLike>): Bytes {
	return domainHash("ABS\0", u16(path.byteLength), path);
}

function makeEntry(kind: 0 | 1 | 2, pathText: string, pre: string, post: string): Entry {
	const path = new TextEncoder().encode(pathText);
	const preBytes = new TextEncoder().encode(pre);
	const postBytes = new TextEncoder().encode(post);
	const preDigest = kind === 0 ? absence(path) : hash(preBytes);
	const postDigest = kind === 1 ? absence(path) : hash(postBytes);
	const preSize = kind === 0 ? 0 : preBytes.byteLength;
	const postSize = kind === 1 ? 0 : postBytes.byteLength;
	const preMode = kind === 0 ? 0 : 0o600;
	const postMode = kind === 1 ? 0 : 0o600;
	const payload = bytes(
		new Uint8Array([kind]),
		u16(path.byteLength),
		path,
		preDigest,
		u32(preSize),
		u16(preMode),
		postDigest,
		u32(postSize),
		u16(postMode),
	);
	const digest = domainHash(
		"PEN\0",
		new Uint8Array([kind]),
		u16(path.byteLength),
		path,
		preDigest,
		u32(preSize),
		u16(preMode),
		postDigest,
		u32(postSize),
		u16(postMode),
	);
	return { kind, path, pre: preBytes, post: postBytes, payload, digest, preDigest, postDigest };
}

function buildHappyTransaction(root: string) {
	const entries = [
		makeEntry(0, "new/deep/file", "", "created"),
		makeEntry(1, "old/delete", "delete", ""),
		makeEntry(2, "old/update", "before", "after"),
	];
	mkdirSync(join(root, "old"), { mode: 0o700 });
	writeFileSync(join(root, "old", "delete"), entries[1].pre, { mode: 0o600 });
	writeFileSync(join(root, "old", "update"), entries[2].pre, { mode: 0o600 });
	const aggregate = domainHashFromArray("EAG\0", entries.map((entry) => entry.digest).sort(Buffer.compare));
	const planDigest = domainHash("PLN\0", aggregate);
	const txId = random32();
	const txDigest = random32();
	const header = bytes(u32(entries.length), u32(12), txId, txDigest, aggregate);
	const directories = ["new", "old", "new/deep"].map((value) => new TextEncoder().encode(value));
	const records: Bytes[] = [];
	function addRecord(tag: number, payload: Uint8Array<ArrayBufferLike>): void {
		const previous = records.length === 0 ? new Uint8Array(32) : hash(records[records.length - 1]);
		records.push(record(tag, records.length, previous, payload));
	}
	addRecord(1, header);
	for (const entry of entries) addRecord(2, entry.payload);
	for (const directory of directories) addRecord(3, bytes(u16(directory.byteLength), directory));
	addRecord(4, bytes(u32(3), u32(3), planDigest));
	for (const entry of [entries[0], entries[2]]) {
		addRecord(5, bytes(hash(entry.path), entry.postDigest, u32(entry.post.byteLength)));
	}
	for (const entry of [entries[1], entries[2]]) {
		addRecord(6, bytes(hash(entry.path), entry.preDigest, u32(entry.pre.byteLength)));
	}
	for (const [index, directory] of directories.entries()) {
		addRecord(7, bytes(u16(directory.byteLength), directory, new Uint8Array([index === 1 ? 1 : 0])));
	}
	addRecord(8, planDigest);
	addRecord(9, planDigest);
	for (const [index, directory] of directories.entries()) {
		addRecord(10, bytes(u16(directory.byteLength), directory, new Uint8Array([index === 1 ? 0 : 1])));
	}
	for (const [index, entry] of entries.entries()) {
		addRecord(11, bytes(u16(index), entry.digest, new Uint8Array([entry.kind + 1])));
	}
	addRecord(12, planDigest);
	addRecord(13, planDigest);
	const vector = records.map(hash);
	const commitment = domainHashFromArray("EVV\0", [u32(vector.length)].concat(vector));
	const ticket1 = random32();
	const ticket2 = random32();
	const requestFrames = [frame(0xfe, new TextEncoder().encode(root)), frame(1, header)];
	for (const entry of entries) requestFrames.push(frame(2, entry.payload));
	requestFrames.push(frame(3));
	for (const entry of [entries[0], entries[2]]) {
		requestFrames.push(
			frame(4, bytes(u16(entry.path.byteLength), entry.path, u32(entry.post.byteLength), entry.postDigest)),
			frame(5, bytes(hash(entry.path), u32(0), entry.post)),
		);
	}
	const afterStage = bytesFromArray(requestFrames);
	requestFrames.push(frame(6));
	const afterPreflight = bytesFromArray(requestFrames);
	requestFrames.push(frame(7));
	const afterBackup = bytesFromArray(requestFrames);
	requestFrames.push(frame(8), frame(9));
	const afterCommit = bytesFromArray(requestFrames);
	requestFrames.push(frame(10), frame(11), frame(12));
	const beforeFinalize = bytesFromArray(requestFrames);
	requestFrames.push(frame(13, bytes(txId, planDigest)));
	const need1Parts: Uint8Array<ArrayBufferLike>[] = [new Uint8Array([1]), txId, planDigest, u32(vector.length)];
	for (const item of vector) need1Parts.push(item);
	need1Parts.push(u32(vector.length - 1), new Uint8Array([2]));
	const need1 = bytesFromArray(need1Parts);
	const evidence1Parts: Uint8Array<ArrayBufferLike>[] = [
		new Uint8Array([1]),
		txId,
		planDigest,
		ticket1,
		u32(vector.length),
	];
	for (const item of vector) evidence1Parts.push(item);
	evidence1Parts.push(u32(vector.length - 1), new Uint8Array([2]));
	requestFrames.push(frame(15, bytesFromArray(evidence1Parts)));
	const need3 = bytes(
		new Uint8Array([3]),
		txId,
		planDigest,
		commitment,
		u64(vector.length),
		ticket1,
		new Uint8Array([0]),
	);
	requestFrames.push(
		frame(
			15,
			bytes(
				new Uint8Array([3]),
				txId,
				planDigest,
				ticket2,
				commitment,
				u64(vector.length),
				ticket1,
				new Uint8Array([0]),
			),
		),
		frame(255),
	);
	return {
		entries,
		planDigest,
		records,
		need1,
		need3,
		input: bytesFromArray(requestFrames),
		afterStage,
		afterPreflight,
		afterBackup,
		afterCommit,
		beforeFinalize,
		header,
	};
}

function simpleCreatePrefix(root: string, pathText: string, content: string): Bytes {
	const entry = makeEntry(0, pathText, "", content);
	const aggregate = domainHash("EAG\0", entry.digest);
	const header = bytes(u32(1), u32(entry.post.byteLength), random32(), random32(), aggregate);
	return bytes(
		frame(0xfe, new TextEncoder().encode(root)),
		frame(1, header),
		frame(2, entry.payload),
		frame(3),
		frame(4, bytes(u16(entry.path.byteLength), entry.path, u32(entry.post.byteLength), entry.postDigest)),
		frame(5, bytes(hash(entry.path), u32(0), entry.post)),
	);
}

function simpleCreateStage(root: string, pathText: string, content: string) {
	const entry = makeEntry(0, pathText, "", content);
	const aggregate = domainHash("EAG\0", entry.digest);
	const header = bytes(u32(1), u32(entry.post.byteLength), random32(), random32(), aggregate);
	const begin = bytes(frame(0xfe, new TextEncoder().encode(root)), frame(1, header));
	return {
		entry,
		begin,
		prefix: bytes(
			begin,
			frame(2, entry.payload),
			frame(3),
			frame(4, bytes(u16(entry.path.byteLength), entry.path, u32(entry.post.byteLength), entry.postDigest)),
		),
		content: frame(5, bytes(hash(entry.path), u32(0), entry.post)),
	};
}

function simpleCreateBoundaries(root: string, pathText: string, content: string) {
	const stage = simpleCreateStage(root, pathText, content);
	const afterStage = bytes(stage.prefix, stage.content);
	const afterPreflight = bytes(afterStage, frame(6));
	const afterBackup = bytes(afterPreflight, frame(7));
	const afterPrepare = bytes(afterBackup, frame(8));
	const afterCommit = bytes(afterPrepare, frame(9));
	return { ...stage, afterStage, afterPreflight, afterBackup, afterPrepare, afterCommit };
}

afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true });
	roots.length = 0;
	fixtures.length = 0;
});

describe("Workspace Authority V21 helper protocol", () => {
	it("uses mutable read buffers and clears owned transaction state", () => {
		const source = readFileSync(HELPER, "utf8");
		expect(source).toContain("os.readv");
		expect(source).not.toContain("os.read(");
		expect(source).not.toContain('b"".join');
		expect(source).not.toMatch(/\bbytes\s*\(/);
		expect(source).toContain("def _with_path_buffer");
		expect(source).toContain("def _linkat");
		expect(source.match(/_zero_owned\(state\)/g)?.length).toBeGreaterThanOrEqual(2);
	});
	it("rejects invalid libc components and openat modes before invoking libc", () => {
		const probe = `
import errno
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Trap:
    def __call__(self, *unused):
        raise RuntimeError("libc invoked")
module._OPENAT = Trap()
module._MKDIRAT = Trap()
module._UNLINKAT = Trap()
module._LINKAT = Trap()
module._RENAMEAT = Trap()
def rejected(call):
    try:
        call()
    except OSError as error:
        if error.errno != errno.EINVAL:
            raise
        return
    raise RuntimeError("accepted")
for value in (bytearray((115, 97, 102, 101, 0, 116, 97, 105, 108)), bytearray(b"sub/leaf"), bytearray(b"."), bytearray(b".."), bytearray()):
    rejected(lambda value=value: module._openat(-1, value, module.os.O_RDONLY))
rejected(lambda: module._openat(-1, bytearray(b"leaf"), module.os.O_CREAT, 0o644))
rejected(lambda: module._mkdirat(-1, bytearray(b"sub/leaf"), 0o700))
rejected(lambda: module._unlinkat(-1, bytearray(b".")))
rejected(lambda: module._linkat(-1, bytearray(b"leaf"), -1, bytearray(b"..")))
rejected(lambda: module._renameat(-1, bytearray(b"leaf"), -1, bytearray((120, 0, 121))))
`;
		const result = spawnSync(PYTHON, ["-c", probe, HELPER], { cwd: "/", env: {} });
		expect(result.status).toBe(0);
		expect(result.stdout.byteLength).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
	});

	it("zeros 16 MiB in place with bounded extra allocation and releases aliased views", () => {
		const probe = `
import importlib.util
import sys
import tracemalloc
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
marker = bytearray(b"secret-marker-v24")
buffer = bytearray(16 << 20)
buffer[:len(marker)] = marker
tracemalloc.start()
tracemalloc.reset_peak()
before, unused = tracemalloc.get_traced_memory()
module._zero(buffer)
after, peak = tracemalloc.get_traced_memory()
if peak - before > 262144 or buffer.find(marker) != -1:
    raise RuntimeError("unbounded or uncleared")
owner = bytearray(b"tuple-secret")
view = memoryview(owner)
module._zero_owned((view, owner))
if any(owner):
    raise RuntimeError("tuple owner uncleared")
`;
		const result = spawnSync(PYTHON, ["-c", probe, HELPER], { cwd: "/", env: {} });
		expect(result.status).toBe(0);
		expect(result.stdout.byteLength).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
	});

	it("contains unexpected cleanup failures without traceback or a second dynamic frame", () => {
		const root = freshRoot();
		const probe = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def fail_zero(unused):
    raise MemoryError()
module._zero = fail_zero
raise SystemExit(module.main())
`;
		const marker = new TextEncoder().encode("secret-marker-v24");
		const result = spawnSync(PYTHON, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			input: bytes(frame(0xfe, new TextEncoder().encode(root)), frame(1, marker)),
		});
		expect(result.status).toBe(2);
		expect(result.stderr.byteLength).toBe(0);
		expect(Buffer.from(result.stdout).includes(Buffer.from(marker))).toBe(false);
		expect(parseFrames(result.stdout).length).toBeLessThanOrEqual(1);
	});

	it("allocates STAGED only after durable publication and clears the failed transaction", () => {
		const root = freshRoot();
		const transaction = simpleCreateStage(root, "response-owner", "secret-marker-v4");
		const pathSha = Buffer.from(hash(transaction.entry.path)).toString("hex");
		const digest = Buffer.from(transaction.entry.postDigest).toString("hex");
		const probe = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
path_sha = bytearray.fromhex(sys.argv[2])
digest = bytearray.fromhex(sys.argv[3])
owners = []
original_concat = module._concat
original_publish = module._publish_record
def watched_concat(parts):
    result = original_concat(parts)
    if len(parts) == 2 and parts[0] == path_sha and parts[1] == digest:
        owners.append(result)
    return result
def failed_publish(fds, state, tag, payload):
    if tag == 5:
        raise module.Failure(module.UNCERTAIN, module.REASON_JOURNAL)
    return original_publish(fds, state, tag, payload)
module._concat = watched_concat
module._publish_record = failed_publish
code = module.main()
failed = any(any(owner) for owner in owners)
module._zero_owned(owners)
module._zero(path_sha)
module._zero(digest)
raise SystemExit(91 if failed else code)
`;
		const result = spawnSync(PYTHON, ["-c", probe, HELPER, pathSha, digest], {
			cwd: "/",
			env: {},
			input: bytes(transaction.prefix, transaction.content),
		});
		expect(result.status).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(Buffer.from(result.stdout).includes(Buffer.from("secret-marker-v4"))).toBe(false);
		expect(parseFrames(result.stdout).at(-1)).toEqual({ status: 1, payload: new Uint8Array([9]) });
	});

	it("preflights the exact descriptor reservation before creating plan artifacts", () => {
		const rejectedRoot = freshRoot();
		const rejected = simpleCreateStage(rejectedRoot, "capacity", "value");
		const fixed = 11;
		const tracked = rejectedRoot.split("/").filter((part) => part.length > 0).length + 1;
		const required = tracked + fixed + 1;
		const probe = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
limit = int(sys.argv[2])
module.resource.getrlimit = lambda unused: (limit, limit)
raise SystemExit(module.main())
`;
		const rejectedResult = spawnSync(PYTHON, ["-c", probe, HELPER, String(required - 1)], {
			cwd: "/",
			env: {},
			input: bytes(rejected.begin, frame(255)),
		});
		expect(rejectedResult.status).toBe(0);
		expect(rejectedResult.stderr.byteLength).toBe(0);
		expect(parseFrames(rejectedResult.stdout).at(-2)).toEqual({ status: 2, payload: new Uint8Array([3]) });
		expect(() => lstatSync(join(rejectedRoot, PRIVATE_ROOT))).toThrow();

		const acceptedRoot = freshRoot();
		const accepted = simpleCreateStage(acceptedRoot, "capacity", "value");
		const acceptedResult = spawnSync(PYTHON, ["-c", probe, HELPER, String(required)], {
			cwd: "/",
			env: {},
			input: bytes(accepted.begin, frame(255)),
		});
		expect(acceptedResult.status).toBe(0);
		expect(acceptedResult.stderr.byteLength).toBe(0);
		expect(parseFrames(acceptedResult.stdout).at(-2)).toEqual({ status: 0, payload: new Uint8Array(0) });
	});

	it("closes a large sealed-stage inventory iteratively once and reports uncertainty", () => {
		const probe = `
import importlib.util
import sys
spec = importlib.util.spec_from_file_location("ws_helper", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
count = 4096
fds = {index: index for index in range(count)}
stages = []
references = []
for index in range(count):
    owner = {"fd": index, "path": bytearray(b"secret"), "name": bytearray(b"name"), "digest": bytearray(32)}
    stages.append(owner)
    references.append(owner)
state = {"stage": None, "staged": stages}
closed = []
def tracked_close(table, fd):
    if fd not in table:
        raise RuntimeError("double close")
    del table[fd]
    closed.append(fd)
    if fd == count // 2:
        raise module.Failure(module.UNCERTAIN, module.REASON_IO)
module._close = tracked_close
if module._release_stage_fds(fds, state):
    raise SystemExit(10)
if fds or state["staged"] or state["stage"] is not None:
    raise SystemExit(11)
if len(closed) != count or len(set(closed)) != count:
    raise SystemExit(12)
if any(reference for reference in references):
    raise SystemExit(13)
module.resource.getrlimit = lambda unused: (module.resource.RLIM_INFINITY, module.resource.RLIM_INFINITY)
module._preflight_descriptor_capacity({}, module.MAX_SEALED_STAGES)
try:
    module._preflight_descriptor_capacity({}, module.MAX_SEALED_STAGES + 1)
except module.Failure as failure:
    if failure.status_code != module.ERROR or failure.detail_code != module.ERR_LIMIT:
        raise
else:
    raise SystemExit(14)
`;
		const result = spawnSync(PYTHON, ["-c", probe, HELPER], { cwd: "/", env: {} });
		expect(result.status).toBe(0);
		expect(result.stdout.byteLength).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
	});

	it("executes the approved fresh-transaction opcodes and removes fresh control artifacts", () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const result = run(transaction.input);
		expect(result.error).toBeUndefined();
		expect(result.status).toBe(0);
		expect(result.signal).toBeNull();
		expect(result.stderr.byteLength).toBe(0);
		const responses = parseFrames(result.stdout);
		const expected: Response[] = [
			{ status: 3, payload: new Uint8Array(0) },
			{ status: 0, payload: new Uint8Array(0) },
		];
		for (let index = 0; index < transaction.entries.length; index += 1) {
			expected.push({ status: 0, payload: new Uint8Array(0) });
		}
		expected.push({ status: 5, payload: transaction.planDigest });
		for (const entry of [transaction.entries[0], transaction.entries[2]]) {
			expected.push(
				{ status: 0, payload: new Uint8Array(0) },
				{ status: 4, payload: bytes(hash(entry.path), entry.postDigest) },
			);
		}
		expected.push(
			{ status: 0, payload: new Uint8Array(0) },
			{ status: 0, payload: new Uint8Array(0) },
			{ status: 6, payload: transaction.planDigest },
			{ status: 7, payload: transaction.planDigest },
			{ status: 8, payload: u32(3) },
			{ status: 9, payload: transaction.planDigest },
			{ status: 10, payload: new Uint8Array(0) },
			{ status: 14, payload: transaction.need1 },
			{ status: 14, payload: transaction.need3 },
			{ status: 11, payload: new Uint8Array(0) },
			{ status: 0, payload: new Uint8Array(0) },
		);
		expect(responses).toEqual(expected);
		expect(readFileSync(join(root, "new", "deep", "file"))).toEqual(Buffer.from(transaction.entries[0].post));
		expect(readFileSync(join(root, "old", "update"))).toEqual(Buffer.from(transaction.entries[2].post));
		expect(() => lstatSync(join(root, "old", "delete"))).toThrow();
		expect(readdirSync(root).sort()).toEqual(["new", "old"]);
	});

	it("durably publishes 73-byte-header journal records with no temporary aliases", () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const input = bytes(transaction.beforeFinalize, frame(255));
		const result = run(input);
		expect(result.status).toBe(0);
		const journal = join(root, PRIVATE_ROOT, "journal");
		const names = readdirSync(journal).sort();
		expect(names.every((name) => /^[0-9a-f]{64}$/.test(name))).toBe(true);
		for (const name of names) {
			const raw = readFileSync(join(journal, name));
			expect(raw.byteLength).toBeGreaterThanOrEqual(73);
			expect(hash(raw)).toEqual(Buffer.from(name, "hex"));
		}
	});

	it("rejects REPLAY_PLAN unless evidence has authorized it", () => {
		const root = freshRoot();
		const result = run(bytes(frame(0xfe, new TextEncoder().encode(root)), frame(0x10), frame(255)));
		expect(parseFrames(result.stdout)).toEqual([
			{ status: 3, payload: new Uint8Array(0) },
			{ status: 2, payload: new Uint8Array([1]) },
			{ status: 0, payload: new Uint8Array(0) },
		]);
	});

	it("rejects path, ordering, frame, chunk, and plan bounds with exact codes", () => {
		const root = freshRoot();
		const wrongFirst = run(bytes(frame(1), frame(255)));
		expect(parseFrames(wrongFirst.stdout)[0]).toEqual({ status: 2, payload: new Uint8Array([1]) });
		const oversized = run(bytes(new Uint8Array([0xfe]), u32(1_048_577)));
		expect(oversized.status).toBe(1);
		expect(parseFrames(oversized.stdout)).toEqual([{ status: 2, payload: new Uint8Array([2]) }]);
		const partial = run(new Uint8Array([0xfe, 0]));
		expect(partial.status).toBe(1);
		expect(parseFrames(partial.stdout)).toEqual([{ status: 1, payload: new Uint8Array([7]) }]);
		const partialPayload = run(bytes(new Uint8Array([0xfe]), u32(3), new Uint8Array([47])));
		expect(partialPayload.status).toBe(1);
		expect(parseFrames(partialPayload.stdout)).toEqual([{ status: 1, payload: new Uint8Array([7]) }]);
		const limitHeader = bytes(u32(1025), u32(0), random32(), random32(), random32());
		const limit = run(bytes(frame(0xfe, new TextEncoder().encode(root)), frame(1, limitHeader), frame(255)));
		expect(parseFrames(limit.stdout)[1]).toEqual({ status: 2, payload: new Uint8Array([3]) });
		const badPath = makeEntry(0, "bad`path", "", "x");
		const aggregate = domainHash("EAG\0", badPath.digest);
		const header = bytes(u32(1), u32(1), random32(), random32(), aggregate);
		const invalid = run(
			bytes(
				frame(0xfe, new TextEncoder().encode(freshRoot())),
				frame(1, header),
				frame(2, badPath.payload),
				frame(255),
			),
		);
		expect(parseFrames(invalid.stdout)[2]).toEqual({ status: 1, payload: new Uint8Array([2]) });

		const chunkRoot = freshRoot();
		const largePost = new Uint8Array(262_145).fill(97);
		const largeEntry = makeEntry(0, "large", "", new TextDecoder().decode(largePost));
		const largeAggregate = domainHash("EAG\0", largeEntry.digest);
		const largeHeader = bytes(u32(1), u32(largePost.byteLength), random32(), random32(), largeAggregate);
		const chunkResult = run(
			bytes(
				frame(0xfe, new TextEncoder().encode(chunkRoot)),
				frame(1, largeHeader),
				frame(2, largeEntry.payload),
				frame(3),
				frame(
					4,
					bytes(
						u16(largeEntry.path.byteLength),
						largeEntry.path,
						u32(largePost.byteLength),
						largeEntry.postDigest,
					),
				),
				frame(5, bytes(hash(largeEntry.path), u32(0), largePost)),
				frame(255),
			),
		);
		expect(parseFrames(chunkResult.stdout).at(-2)).toEqual({ status: 2, payload: new Uint8Array([3]) });
	});

	it("preserves PREIMAGE and BACKUP reasons for raced exact ENOENT", async () => {
		const preflightRoot = freshRoot();
		const preflight = buildHappyTransaction(preflightRoot);
		const preflightResult = await runWithMutation(
			preflight.afterStage,
			10,
			() => rmSync(join(preflightRoot, "old", "delete")),
			bytes(frame(6), frame(255)),
		);
		expect(preflightResult.reachedBoundary).toBe(true);
		expect(preflightResult.exitCode).toBe(0);
		expect(preflightResult.stderr.byteLength).toBe(0);
		expect(parseFrames(preflightResult.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([4]) });

		const backupRoot = freshRoot();
		const backup = buildHappyTransaction(backupRoot);
		const backupResult = await runWithMutation(
			backup.afterPreflight,
			11,
			() => rmSync(join(backupRoot, "old", "delete")),
			bytes(frame(7), frame(255)),
		);
		expect(backupResult.reachedBoundary).toBe(true);
		expect(backupResult.exitCode).toBe(0);
		expect(backupResult.stderr.byteLength).toBe(0);
		expect(parseFrames(backupResult.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([6]) });
	});

	it("does not classify a non-ENOENT PREPARE failure as absent", async () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const result = await runWithMutation(
			transaction.afterBackup,
			12,
			() => chmodSync(join(root, "old"), 0o755),
			bytes(frame(8), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([14]) });
	});

	it("rejects fresh DELETE disappearance after COMMIT_DECIDED as quiescence uncertainty", async () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const result = await runWithMutation(
			transaction.afterCommit,
			14,
			() => rmSync(join(root, "old", "delete")),
			bytes(frame(10), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([15]) });
	});

	it("rejects a detached root and a replacement at the original name", async () => {
		const root = freshRoot();
		const detached = `${root}-detached`;
		const result = await runWithMutation(
			frame(0xfe, new TextEncoder().encode(root)),
			1,
			() => {
				renameSync(root, detached);
				roots.push(detached);
				mkdirSync(root, { mode: 0o700 });
				chmodSync(root, 0o700);
			},
			bytes(frame(1), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([2]) });
	});

	it("rejects an ancestor rename and canonical replacement above the retained root parent", async () => {
		const outer = mkdtempSync(join(homedir(), ".ws-v21-ancestor-"));
		const detached = `${outer}-detached`;
		fixtures.push(outer, detached);
		const parent = join(outer, "parent");
		const root = join(parent, "root");
		mkdirSync(root, { recursive: true, mode: 0o700 });
		chmodSync(outer, 0o700);
		chmodSync(parent, 0o700);
		chmodSync(root, 0o700);
		const result = await runWithMutation(
			frame(0xfe, new TextEncoder().encode(root)),
			1,
			() => {
				renameSync(outer, detached);
				mkdirSync(root, { recursive: true, mode: 0o700 });
				chmodSync(outer, 0o700);
				chmodSync(parent, 0o700);
				chmodSync(root, 0o700);
			},
			bytes(frame(1), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(2);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output)).toContainEqual({ status: 1, payload: new Uint8Array([2]) });
	});

	it("rejects a same-uid replacement of the retained stage inode before CONTENT", async () => {
		const root = freshRoot();
		const transaction = simpleCreateStage(root, "stage-file", "secret-marker");
		const stageName = Buffer.from(hash(transaction.entry.path)).toString("hex");
		const stagePath = join(root, PRIVATE_ROOT, "stage", stageName);
		const result = await runWithMutation(
			transaction.prefix,
			5,
			() => {
				rmSync(stagePath);
				writeFileSync(stagePath, transaction.entry.post, { mode: 0o600 });
			},
			bytes(transaction.content, frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([5]) });
	});

	it("rejects an identical-byte stage inode replacement at every boundary through APPLY", async () => {
		const boundaries = [
			{ key: "afterStage", frames: 6, suffix: bytes(frame(6), frame(255)) },
			{ key: "afterPreflight", frames: 7, suffix: bytes(frame(7), frame(255)) },
			{ key: "afterBackup", frames: 8, suffix: bytes(frame(8), frame(255)) },
			{ key: "afterPrepare", frames: 9, suffix: bytes(frame(9), frame(255)) },
			{ key: "afterCommit", frames: 10, suffix: bytes(frame(10), frame(255)) },
		] as const;
		for (const boundary of boundaries) {
			const root = freshRoot();
			const transaction = simpleCreateBoundaries(root, "stage-file", "identical-content");
			const stageName = Buffer.from(hash(transaction.entry.path)).toString("hex");
			const stagePath = join(root, PRIVATE_ROOT, "stage", stageName);
			const result = await runWithMutation(
				transaction[boundary.key],
				boundary.frames,
				() => {
					rmSync(stagePath);
					writeFileSync(stagePath, transaction.entry.post, { mode: 0o600 });
				},
				boundary.suffix,
			);
			expect(result.reachedBoundary).toBe(true);
			expect(result.exitCode).toBe(0);
			expect(result.stderr.byteLength).toBe(0);
			expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([5]) });
			expect(() => lstatSync(join(root, "stage-file"))).toThrow();
		}
	});

	it("retains and validates every fd in a multi-stage transaction", async () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const stageName = Buffer.from(hash(transaction.entries[0].path)).toString("hex");
		const stagePath = join(root, PRIVATE_ROOT, "stage", stageName);
		const result = await runWithMutation(
			transaction.afterStage,
			10,
			() => {
				rmSync(stagePath);
				writeFileSync(stagePath, transaction.entries[0].post, { mode: 0o600 });
			},
			bytes(frame(6), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([5]) });
		expect(() => lstatSync(join(root, "new"))).toThrow();
		expect(readFileSync(join(root, "old", "delete"), "utf8")).toBe("delete");
		expect(readFileSync(join(root, "old", "update"), "utf8")).toBe("before");
	});

	it("rejects a leaf symlink swap while retaining the parent binding", async () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const external = mkdtempSync(join(tmpdir(), "ws-v21-leaf-"));
		fixtures.push(external);
		const outside = join(external, "outside");
		writeFileSync(outside, "before", { mode: 0o600 });
		const result = await runWithMutation(
			transaction.afterStage,
			10,
			() => {
				rmSync(join(root, "old", "update"));
				symlinkSync(outside, join(root, "old", "update"));
			},
			bytes(frame(6), frame(255)),
		);
		expect(result.reachedBoundary).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.byteLength).toBe(0);
		expect(parseFrames(result.output).at(-2)).toEqual({ status: 1, payload: new Uint8Array([4]) });
		expect(readFileSync(outside, "utf8")).toBe("before");
	});

	it("fails closed on intermediate and leaf symlinks", () => {
		const root = freshRoot();
		const external = mkdtempSync(join(tmpdir(), "ws-v21-external-"));
		fixtures.push(external);
		chmodSync(external, 0o700);
		symlinkSync(external, join(root, "pivot"));
		const input = bytes(
			simpleCreatePrefix(root, "pivot/file", "secret"),
			frame(6),
			frame(7),
			frame(8),
			frame(9),
			frame(10),
			frame(255),
		);
		const result = run(input);
		const responses = parseFrames(result.stdout);
		expect(responses).toContainEqual({ status: 1, payload: new Uint8Array([14]) });
		expect(readdirSync(external)).toEqual([]);
	});

	it("rejects hardlinks, wrong modes, and non-regular managed leaves", () => {
		const attacks: ("hardlink" | "mode" | "directory")[] = ["hardlink", "mode", "directory"];
		for (const attack of attacks) {
			const root = freshRoot();
			mkdirSync(join(root, "old"), { mode: 0o700 });
			const target = join(root, "old", "file");
			if (attack === "directory") mkdirSync(target, { mode: 0o700 });
			else writeFileSync(target, "before", { mode: attack === "mode" ? 0o644 : 0o600 });
			if (attack === "hardlink") {
				const external = mkdtempSync(join(homedir(), ".ws-v21-hardlink-"));
				fixtures.push(external);
				linkSync(target, join(external, "alias"));
			}
			const entry = makeEntry(2, "old/file", "before", "after");
			const aggregate = domainHash("EAG\0", entry.digest);
			const header = bytes(u32(1), u32(5), random32(), random32(), aggregate);
			const input = bytes(
				frame(0xfe, new TextEncoder().encode(root)),
				frame(1, header),
				frame(2, entry.payload),
				frame(3),
				frame(4, bytes(u16(entry.path.byteLength), entry.path, u32(5), entry.postDigest)),
				frame(5, bytes(hash(entry.path), u32(0), entry.post)),
				frame(6),
				frame(255),
			);
			const responses = parseFrames(run(input).stdout);
			expect(responses.at(-2)).toEqual({ status: 1, payload: new Uint8Array([4]) });
		}
	});

	it("completes a bound State-B publication and proves canonical nlink one", () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const firstRecord = record(1, 0, new Uint8Array(32), transaction.header);
		const name = Buffer.from(hash(firstRecord)).toString("hex");
		const privateRoot = join(root, PRIVATE_ROOT);
		const journal = join(privateRoot, "journal");
		mkdirSync(journal, { recursive: true, mode: 0o700 });
		for (const child of ["stage", "install", "backup"]) mkdirSync(join(privateRoot, child), { mode: 0o700 });
		const temporary = join(journal, `.tmp-${name}`);
		const canonical = join(journal, name);
		writeFileSync(temporary, firstRecord, { mode: 0o600 });
		linkSync(temporary, canonical);
		const result = run(bytes(frame(0xfe, new TextEncoder().encode(root)), frame(1, transaction.header), frame(255)));
		expect(parseFrames(result.stdout)).toEqual([
			{ status: 3, payload: new Uint8Array(0) },
			{ status: 0, payload: new Uint8Array(0) },
			{ status: 0, payload: new Uint8Array(0) },
		]);
		expect(lstatSync(canonical).nlink).toBe(1);
		expect(() => lstatSync(temporary)).toThrow();
	});

	it("rejects an unknown journal schema tag before final evidence", () => {
		const root = freshRoot();
		const transaction = buildHappyTransaction(root);
		const privateRoot = join(root, PRIVATE_ROOT);
		const journal = join(privateRoot, "journal");
		mkdirSync(journal, { recursive: true, mode: 0o700 });
		for (const child of ["stage", "install", "backup"]) mkdirSync(join(privateRoot, child), { mode: 0o700 });
		const hostile = record(0x7f, 500, random32(), new Uint8Array(0));
		writeFileSync(join(journal, Buffer.from(hash(hostile)).toString("hex")), hostile, { mode: 0o600 });
		const responses = parseFrames(run(transaction.input).stdout);
		expect(responses).toContainEqual({ status: 1, payload: new Uint8Array([9]) });
	});

	it("rejects journal length, payload-hash, and revision mutants before evidence", async () => {
		for (const mutation of ["length", "payload", "revision"] as const) {
			const root = freshRoot();
			const transaction = buildHappyTransaction(root);
			const result = await runWithMutation(
				transaction.beforeFinalize,
				17,
				() => {
					const journal = join(root, PRIVATE_ROOT, "journal");
					const selected = readdirSync(journal)
						.map((name) => ({ name, raw: Buffer.from(readFileSync(join(journal, name))) }))
						.find((item) => item.raw.readUInt32BE(1) === 1);
					if (selected === undefined) throw new Error("missing revision one");
					if (mutation === "length") selected.raw.writeUInt32BE(selected.raw.readUInt32BE(69) + 1, 69);
					if (mutation === "payload") selected.raw[selected.raw.byteLength - 1] ^= 1;
					if (mutation === "revision") selected.raw.writeUInt32BE(99, 1);
					rmSync(join(journal, selected.name));
					writeFileSync(join(journal, Buffer.from(hash(selected.raw)).toString("hex")), selected.raw, {
						mode: 0o600,
					});
				},
				transaction.input.slice(transaction.beforeFinalize.byteLength),
			);
			expect(result.reachedBoundary).toBe(true);
			expect(result.stderr.byteLength).toBe(0);
			expect(parseFrames(result.output)).toContainEqual({ status: 1, payload: new Uint8Array([9]) });
		}
	});

	it("detects a three-link journal publication attack", () => {
		const root = freshRoot();
		const entry = makeEntry(0, "file", "", "x");
		const aggregate = domainHash("EAG\0", entry.digest);
		const header = bytes(u32(1), u32(1), random32(), random32(), aggregate);
		const firstRecord = record(1, 0, new Uint8Array(32), header);
		const name = Buffer.from(hash(firstRecord)).toString("hex");
		const privateRoot = join(root, PRIVATE_ROOT);
		const journal = join(privateRoot, "journal");
		mkdirSync(journal, { recursive: true, mode: 0o700 });
		for (const child of ["stage", "install", "backup"]) mkdirSync(join(privateRoot, child), { mode: 0o700 });
		const temporary = join(journal, `.tmp-${name}`);
		writeFileSync(temporary, firstRecord, { mode: 0o600 });
		linkSync(temporary, join(journal, name));
		linkSync(temporary, join(journal, "third-link"));
		const result = run(bytes(frame(0xfe, new TextEncoder().encode(root)), frame(1, header), frame(255)));
		expect(parseFrames(result.stdout)[1]).toEqual({ status: 1, payload: new Uint8Array([14]) });
	});

	it("holds the root flock for the complete process lifetime and leaves no process group", async () => {
		const root = freshRoot();
		const child = spawn(PYTHON, [HELPER], { cwd: "/", env: {}, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		const pid = child.pid;
		expect(pid).toBeDefined();
		if (pid === undefined) return;
		let stderrBytes = 0;
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.byteLength;
			if (stderrBytes > 65_536) process.kill(-pid, "SIGKILL");
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		try {
			const output = new Promise<Buffer>((resolve, reject) => {
				child.stdout.once("data", resolve);
				child.stdout.once("error", reject);
			});
			child.stdin.write(frame(0xfe, new TextEncoder().encode(root)));
			expect(parseFrames(await output)).toEqual([{ status: 3, payload: new Uint8Array(0) }]);
			const contender = run(bytes(frame(0xfe, new TextEncoder().encode(root)), frame(255)));
			expect(parseFrames(contender.stdout)[0]).toEqual({ status: 1, payload: new Uint8Array([1]) });
			child.stdin.end(frame(255));
			await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2000))]);
		} finally {
			if (child.exitCode === null) {
				process.kill(-pid, "SIGTERM");
				await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);
			}
			if (child.exitCode === null) {
				process.kill(-pid, "SIGKILL");
				await closed;
			}
		}
		expect(child.exitCode).toBe(0);
		expect(stderrBytes).toBe(0);
		expect(() => process.kill(-pid, 0)).toThrow();
	});
});
