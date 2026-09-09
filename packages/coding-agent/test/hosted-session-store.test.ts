import { describe, expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	createHostedSessionStore,
	createStartupV5HostedSessionStore,
} from "../src/modes/daemon/sandbox/hosted-session-store.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const sourcePath = resolve(testDirectory, "../src/modes/daemon/sandbox/hosted-session-store.ts");
const helperPath = resolve(testDirectory, "../src/modes/daemon/sandbox/hosted-session-store-posix-helper.py");

function expectExactFailure(value: unknown): void {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	if (typeof value !== "object" || value === null) return;
	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.getOwnPropertyNames(value)).toEqual(["code"]);
	expect(Object.getOwnPropertySymbols(value)).toEqual([]);
	expect(Object.isFrozen(value)).toBe(true);
	expect(Object.getOwnPropertyDescriptor(value, "code")).toEqual({
		value: "FAILED",
		writable: false,
		enumerable: true,
		configurable: false,
	});
}

function issueLoaded(): object {
	return Object.freeze({ code: "INVALID" });
}

function read(): object {
	return Object.freeze({ code: "UNKNOWN" });
}

function replace(): object {
	return Object.freeze({ code: "INVALID" });
}

async function finiteWait<T>(
	promise: Promise<T>,
	milliseconds: number,
): Promise<{ done: true; value: T } | { done: false }> {
	return await new Promise((resolveWait) => {
		const timer = setTimeout(() => resolveWait({ done: false }), milliseconds);
		promise.then((value) => {
			clearTimeout(timer);
			resolveWait({ done: true, value });
		});
	});
}

function signalDetachedGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch (failure) {
		if (!(failure instanceof Error) || !("code" in failure) || failure.code !== "ESRCH") throw failure;
	}
}

function requireDetachedGroupAbsent(pid: number): void {
	let absent = false;
	try {
		process.kill(-pid, 0);
	} catch (failure) {
		absent = failure instanceof Error && "code" in failure && failure.code === "ESRCH";
	}
	if (!absent) throw new Error(`process group ${pid} survived cleanup`);
}

async function collectSpawn(
	executable: string,
	args: string[],
	stdio: ["ignore", "pipe", "pipe", number],
	deadlines: { complete: number; term: number; kill: number } = { complete: 5_000, term: 2_000, kill: 2_000 },
): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	cleanupSignals: NodeJS.Signals[];
}> {
	const child = spawn(executable, args, { cwd: "/", env: {}, detached: true, stdio });
	if (child.pid === undefined || child.stdout === null || child.stderr === null) throw new Error("spawn contract");
	const pid = child.pid;
	let stdout = "";
	let stderr = "";
	let code: number | null = null;
	let signal: NodeJS.Signals | null = null;
	const cleanupSignals: NodeJS.Signals[] = [];
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<void>((resolveExit) => {
		child.once("error", () => resolveExit());
		child.once("exit", (exitCode, exitSignal) => {
			code = exitCode;
			signal = exitSignal;
			resolveExit();
		});
	});
	const stdoutClosed = new Promise<void>((resolveClose) => child.stdout?.once("close", resolveClose));
	const stderrClosed = new Promise<void>((resolveClose) => child.stderr?.once("close", resolveClose));
	const settled = Promise.all([exited, stdoutClosed, stderrClosed]);
	let outcome = await finiteWait(settled, deadlines.complete);
	if (!outcome.done) {
		cleanupSignals.push("SIGTERM");
		signalDetachedGroup(pid, "SIGTERM");
		outcome = await finiteWait(settled, deadlines.term);
		if (!outcome.done) {
			cleanupSignals.push("SIGKILL");
			signalDetachedGroup(pid, "SIGKILL");
			outcome = await finiteWait(settled, deadlines.kill);
			if (!outcome.done) {
				requireDetachedGroupAbsent(pid);
				throw new Error("KILL drain timeout");
			}
		}
	}
	requireDetachedGroupAbsent(pid);
	return { code, signal, stdout, stderr, cleanupSignals };
}

async function descriptorExecutionGate(python: string, descriptorPath: string): Promise<void> {
	const temporary = mkdtempSync(resolve(tmpdir(), "hosted-store-v22-fd-"));
	const candidate = resolve(temporary, "descriptor-gate.py");
	const validated = resolve(temporary, "descriptor-gate.validated.py");
	const original = Buffer.from(
		"import os,sys\n" + "assert os.getpid() > 1\n" + "assert sys.version_info.major == 3\n" + "print('BOUND')\n",
	);
	try {
		writeFileSync(candidate, original, { mode: 0o644 });
		const closeOnExec = process.platform === "darwin" ? 0x01000000 : 0x00080000;
		const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | closeOnExec);
		try {
			const before = fstatSync(fd);
			const hash = createHash("sha256");
			const buffer = Buffer.alloc(257);
			const ranges: Array<readonly [number, number]> = [];
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
			expect(position).toBe(before.size);
			expect(hash.digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
			const after = fstatSync(fd);
			for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const)
				expect(after[key]).toBe(before[key]);
			expect(after.isFile()).toBe(before.isFile());

			// This probe shares the open file description with fd 3. lseek reads but does not change its offset.
			const offsetProbe = await collectSpawn(
				python,
				["-c", "import os;print(os.lseek(3,0,1))"],
				["ignore", "pipe", "pipe", fd],
			);
			expect(offsetProbe).toEqual({
				code: 0,
				signal: null,
				stdout: "0\n",
				stderr: "",
				cleanupSignals: [],
			});
			const escalated = await collectSpawn(
				python,
				[
					"-c",
					"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('READY',flush=True);time.sleep(30)",
				],
				["ignore", "pipe", "pipe", fd],
				{ complete: 500, term: 200, kill: 2_000 },
			);
			expect(escalated).toEqual({
				code: null,
				signal: "SIGKILL",
				stdout: "READY\n",
				stderr: "",
				cleanupSignals: ["SIGTERM", "SIGKILL"],
			});

			// Synchronization is complete. Replace the hostile pathname only now, before asynchronous spawn.
			renameSync(candidate, validated);
			writeFileSync(candidate, "raise SystemExit(99)\n", { mode: 0o644 });
			const executed = await collectSpawn(python, [descriptorPath], ["ignore", "pipe", "pipe", fd]);
			expect(executed.code, executed.stderr).toBe(0);
			expect(executed.signal).toBeNull();
			expect(executed.stderr).toBe("");
			expect(executed.stdout).toBe("BOUND\n");
			expect(executed.cleanupSignals).toEqual([]);
		} finally {
			closeSync(fd);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

async function expectRejectedRegistry(value: unknown): Promise<object> {
	const result = await createHostedSessionStore(value);
	expectExactFailure(result);
	return result;
}

const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";

const boundedSupervisorSource = `
import errno,json,os,selectors,signal,subprocess,sys,time
CAP=1048576
def bounded(command,limit):
 deadline=time.monotonic()+limit
 q=None;sel=None;out=bytearray();err=bytearray()
 timed=False;out_overflow=False;err_overflow=False;signal_failure=False;drain_failure=False
 exited=False;out_eof=False;err_eof=False;absent=False;term_sent=False;kill_sent=False
 out_pipe=None;err_pipe=None;out_fd=-1;err_fd=-1
 try:
  q=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
 except BaseException:
  return None,b'',b'',False,False,False,True,True,False,False,False,False,False,False
 pgid=q.pid
 def signal_group(value):
  nonlocal signal_failure
  try:
   os.killpg(pgid,value)
   return True
  except OSError as failure:
   if failure.errno==errno.ESRCH:
    return False
   signal_failure=True
   return False
 def group_absent():
  nonlocal signal_failure
  try:
   os.killpg(pgid,0)
   return False
  except OSError as failure:
   if failure.errno==errno.ESRCH:
    return True
   signal_failure=True
   return False
 def poll_exit():
  nonlocal drain_failure
  try:
   return q.poll() is not None
  except BaseException:
   drain_failure=True
   return False
 def close_ready(fd):
  nonlocal drain_failure,out_eof,err_eof
  pipe=out_pipe if fd==out_fd else err_pipe
  try:
   sel.unregister(fd)
  except BaseException:
   drain_failure=True
  try:
   pipe.close()
  except BaseException:
   drain_failure=True
  if fd==out_fd:
   out_eof=True
  else:
   err_eof=True
 def drain_ready(end):
  nonlocal drain_failure,out_overflow,err_overflow
  remaining=end-time.monotonic()
  if remaining<=0:
   return
  timeout=remaining
  if timeout>0.05:
   timeout=0.05
  try:
   events=sel.select(timeout)
  except BaseException:
   drain_failure=True
   return
  for key,unused_mask in events:
   fd=key.fileobj
   try:
    data=os.read(fd,65536)
   except BlockingIOError:
    continue
   except InterruptedError:
    continue
   except OSError:
    drain_failure=True
    continue
   if len(data)==0:
    close_ready(fd)
    continue
   if fd==out_fd:
    available=CAP-len(out)
    if len(data)>available:
     if available>0:
      out.extend(data[:available])
     out_overflow=True
    else:
     out.extend(data)
   elif fd==err_fd:
    available=CAP-len(err)
    if len(data)>available:
     if available>0:
      err.extend(data[:available])
     err_overflow=True
    else:
     err.extend(data)
   else:
    drain_failure=True
 def settled():
  nonlocal exited,absent
  exited=poll_exit()
  if not exited or not out_eof or not err_eof:
   return False
  absent=group_absent()
  return absent
 try:
  out_pipe=q.stdout;err_pipe=q.stderr
  if out_pipe is None or err_pipe is None:
   drain_failure=True
  else:
   try:
    out_fd=out_pipe.fileno();err_fd=err_pipe.fileno()
    os.set_blocking(out_fd,False);os.set_blocking(err_fd,False)
    sel=selectors.DefaultSelector()
    sel.register(out_fd,selectors.EVENT_READ)
    sel.register(err_fd,selectors.EVENT_READ)
   except BaseException:
    drain_failure=True
  if sel is not None and not drain_failure:
   while not settled():
    if out_overflow or err_overflow or drain_failure:
     break
    now=time.monotonic()
    if now>=deadline:
     timed=True
     break
    drain_ready(deadline)
  if not settled():
   term_sent=signal_group(signal.SIGTERM)
   term_end=time.monotonic()+2
   while not settled() and time.monotonic()<term_end:
    if sel is not None:
     drain_ready(term_end)
    else:
     try:
      q.wait(timeout=0.05)
     except subprocess.TimeoutExpired:
      continue
     except BaseException:
      drain_failure=True
   if not settled():
    kill_sent=signal_group(signal.SIGKILL)
    kill_end=time.monotonic()+2
    while not settled() and time.monotonic()<kill_end:
     if sel is not None:
      drain_ready(kill_end)
     else:
      try:
       q.wait(timeout=0.05)
      except subprocess.TimeoutExpired:
       continue
      except BaseException:
       drain_failure=True
  exited=poll_exit()
  if exited:
   try:
    q.wait(timeout=0)
   except BaseException:
    drain_failure=True
  absent=group_absent()
  if not exited or not out_eof or not err_eof or not absent:
   drain_failure=True
 finally:
  if not absent:
   kill_sent=signal_group(signal.SIGKILL) or kill_sent
   final_end=time.monotonic()+0.25
   while time.monotonic()<final_end and not settled():
    if sel is not None:
     drain_ready(final_end)
    else:
     try:
      q.wait(timeout=0.05)
     except subprocess.TimeoutExpired:
      continue
     except BaseException:
      drain_failure=True
   absent=group_absent()
  if sel is not None:
   try:
    sel.close()
   except BaseException:
    drain_failure=True
  if out_pipe is not None and not out_eof:
   try:
    out_pipe.close()
   except BaseException:
    drain_failure=True
  if err_pipe is not None and not err_eof:
   try:
    err_pipe.close()
   except BaseException:
    drain_failure=True
  exited=poll_exit()
  if exited:
   try:
    q.wait(timeout=0)
   except BaseException:
    drain_failure=True
  absent=group_absent()
  if not exited or not out_eof or not err_eof or not absent:
   drain_failure=True
 return q.returncode,bytes(out),bytes(err),timed,out_overflow,err_overflow,signal_failure,drain_failure,exited,out_eof,err_eof,absent,term_sent,kill_sent
`.trim();

const boundedSelfTestRunner =
	boundedSupervisorSource +
	`
r=bounded(json.loads(sys.argv[1]),float(sys.argv[2]))
print(json.dumps({"outLength":len(r[1]),"errLength":len(r[2]),"outSmall":r[1].decode("ascii") if len(r[1])<=100 else "","errSmall":r[2].decode("ascii") if len(r[2])<=100 else "","timed":r[3],"stdoutOverflow":r[4],"stderrOverflow":r[5],"signalFailure":r[6],"drainFailure":r[7],"exited":r[8],"stdoutEof":r[9],"stderrEof":r[10],"groupAbsent":r[11],"termSent":r[12],"killSent":r[13]},sort_keys=True))`;

const dockerSupervisorRunner =
	boundedSupervisorSource +
	String.raw`
def complete(r):
 return r[0] is not None and not r[3] and not r[4] and not r[5] and not r[6] and not r[7] and r[8] and r[9] and r[10] and r[11]
def summary(r):
 return {"returncode":r[0],"timed":r[3],"stdoutOverflow":r[4],"stderrOverflow":r[5],"signalFailure":r[6],"drainFailure":r[7],"exited":r[8],"stdoutEof":r[9],"stderrEof":r[10],"groupAbsent":r[11],"termSent":r[12],"killSent":r[13]}
args=json.loads(sys.argv[1]);name=sys.argv[2];limit=float(sys.argv[3])
main=bounded(args,limit)
removed=bounded(["docker","rm","-f",name],10)
listed=bounded(["docker","ps","-a","--filter","name=^/"+name+"$","--format","{{.Names}}"],10)
ok=complete(main) and complete(removed) and complete(listed) and listed[0]==0 and listed[1].strip()==b""
sys.stdout.buffer.write(main[1]);sys.stderr.buffer.write(main[2])
if not ok:
 sys.stderr.write("\nSUPERVISOR "+json.dumps({"main":summary(main),"removed":summary(removed),"listed":summary(listed),"listedOutput":listed[1].decode("utf-8","replace")},sort_keys=True)+"\n")
sys.exit(main[0] if ok else 124)
`;

async function runBoundedSelfTest(command: string[], limit: number): Promise<unknown> {
	const { stdout, stderr } = await execFileAsync(hostPython, [
		"-c",
		boundedSelfTestRunner,
		JSON.stringify(command),
		String(limit),
	]);
	return Object.freeze({ exitCode: 0, stderr, value: JSON.parse(stdout) });
}

const settledSupervisorShape = Object.freeze({
	signalFailure: false,
	drainFailure: false,
	exited: true,
	stdoutEof: true,
	stderrEof: true,
	groupAbsent: true,
});

test("bounds stdout overflow and removes the live descendant group", async () => {
	const value = await runBoundedSelfTest(
		[
			hostPython,
			"-c",
			"import os,sys,time;pid=os.fork();(time.sleep(30),os._exit(0)) if pid==0 else None;sys.stdout.buffer.write(b'x'*1100000);sys.stdout.flush();os._exit(0)",
		],
		3,
	);
	expect(value).toEqual({
		exitCode: 0,
		stderr: "",
		value: {
			outLength: 1_048_576,
			errLength: 0,
			outSmall: "",
			errSmall: "",
			timed: false,
			stdoutOverflow: true,
			stderrOverflow: false,
			...settledSupervisorShape,
			termSent: true,
			killSent: false,
		},
	});
}, 15_000);

test("bounds stderr overflow and removes the live descendant group", async () => {
	const value = await runBoundedSelfTest(
		[
			hostPython,
			"-c",
			"import os,sys,time;pid=os.fork();(time.sleep(30),os._exit(0)) if pid==0 else None;sys.stderr.buffer.write(b'x'*1100000);sys.stderr.flush();os._exit(0)",
		],
		3,
	);
	expect(value).toEqual({
		exitCode: 0,
		stderr: "",
		value: {
			outLength: 0,
			errLength: 1_048_576,
			outSmall: "",
			errSmall: "",
			timed: false,
			stdoutOverflow: false,
			stderrOverflow: true,
			...settledSupervisorShape,
			termSent: true,
			killSent: false,
		},
	});
}, 15_000);

test("drains both full pipes before removing a live descendant group", async () => {
	const value = await runBoundedSelfTest(
		[
			hostPython,
			"-c",
			"import os,sys,threading,time;t1=threading.Thread(target=lambda:sys.stdout.buffer.write(b'x'*700000));t2=threading.Thread(target=lambda:sys.stderr.buffer.write(b'y'*700000));t1.start();t2.start();t1.join();t2.join();sys.stdout.flush();sys.stderr.flush();pid=os.fork();(time.sleep(30),os._exit(0)) if pid==0 else os._exit(0)",
		],
		0.5,
	);
	expect(value).toEqual({
		exitCode: 0,
		stderr: "",
		value: {
			outLength: 700_000,
			errLength: 700_000,
			outSmall: "",
			errSmall: "",
			timed: true,
			stdoutOverflow: false,
			stderrOverflow: false,
			...settledSupervisorShape,
			termSent: true,
			killSent: false,
		},
	});
}, 15_000);

test("escalates a SIGTERM-ignoring group to SIGKILL", async () => {
	const value = await runBoundedSelfTest(
		[
			hostPython,
			"-c",
			"import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('ready',flush=True);time.sleep(30)",
		],
		0.3,
	);
	expect(value).toEqual({
		exitCode: 0,
		stderr: "",
		value: {
			outLength: 6,
			errLength: 0,
			outSmall: "ready\n",
			errSmall: "",
			timed: true,
			stdoutOverflow: false,
			stderrOverflow: false,
			...settledSupervisorShape,
			termSent: true,
			killSent: true,
		},
	});
}, 15_000);

test("retains exact small output from a normal process", async () => {
	const value = await runBoundedSelfTest(
		[
			hostPython,
			"-c",
			"import sys;sys.stdout.write('hello\\n');sys.stdout.flush();sys.stderr.write('world\\n');sys.stderr.flush()",
		],
		2,
	);
	expect(value).toEqual({
		exitCode: 0,
		stderr: "",
		value: {
			outLength: 6,
			errLength: 6,
			outSmall: "hello\n",
			errSmall: "world\n",
			timed: false,
			stdoutOverflow: false,
			stderrOverflow: false,
			...settledSupervisorShape,
			termSent: false,
			killSent: false,
		},
	});
}, 15_000);

describe("hosted session store V22 boundary", () => {
	test("has the two exact runtime exports", async () => {
		const module = await import("../src/modes/daemon/sandbox/hosted-session-store.js");
		expect(Object.keys(module).sort()).toEqual(["createHostedSessionStore", "createStartupV5HostedSessionStore"]);
		expect(module.createHostedSessionStore).toBe(createHostedSessionStore);
		expect(module.createStartupV5HostedSessionStore).toBe(createStartupV5HostedSessionStore);
	});

	test("rejects primitive registry values without starting the helper", async () => {
		const values: unknown[] = [undefined, null, false, 0, "", Symbol("registry"), issueLoaded];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("rejects registry prototype, order, key, and freeze deviations", async () => {
		const nullPrototype = Object.create(null);
		Object.defineProperties(nullPrototype, {
			issueLoaded: { value: issueLoaded, enumerable: true },
			read: { value: read, enumerable: true },
			replace: { value: replace, enumerable: true },
		});
		Object.freeze(nullPrototype);
		const inherited = Object.create(Object.freeze({ issueLoaded, read, replace }));
		Object.freeze(inherited);
		const wrongOrder = Object.freeze({ read, issueLoaded, replace });
		const missing = Object.freeze({ issueLoaded, read });
		const extra = Object.freeze({ issueLoaded, read, replace, extra: true });
		const unfrozen = { issueLoaded, read, replace };
		const values: unknown[] = [nullPrototype, inherited, wrongOrder, missing, extra, unfrozen];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("rejects symbols, accessors, proxies, and non-method fields", async () => {
		const withSymbol = { issueLoaded, read, replace };
		Object.defineProperty(withSymbol, Symbol("extra"), { value: true });
		Object.freeze(withSymbol);
		const accessor = {};
		Object.defineProperties(accessor, {
			issueLoaded: { get: issueLoaded, enumerable: true, configurable: false },
			read: { value: read, enumerable: true, writable: false, configurable: false },
			replace: { value: replace, enumerable: true, writable: false, configurable: false },
		});
		Object.freeze(accessor);
		const proxy = new Proxy(Object.freeze({ issueLoaded, read, replace }), {});
		const wrongMethod = Object.freeze({ issueLoaded, read, replace: 1 });
		const values: unknown[] = [withSymbol, accessor, proxy, wrongMethod];
		for (let index = 0; index < values.length; index += 1) await expectRejectedRegistry(values[index]);
	});

	test("returns a fresh exact failure for each invalid construction", async () => {
		const first = await createHostedSessionStore(null);
		const second = await createHostedSessionStore(null);
		expectExactFailure(first);
		expectExactFailure(second);
		expect(first).not.toBe(second);
	});
});

describe("hosted session store source constraints", () => {
	test("binds the accepted helper bytes and file invariant", () => {
		const bytes = readFileSync(helperPath);
		const stat = lstatSync(helperPath);
		expect(bytes.byteLength).toBe(257100);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			"931628ad6a93d3d971393580fb5d48df15cdf307f34b47d772c41e93dc559e6d",
		);
		expect(stat.isFile()).toBe(true);
		expect(stat.nlink).toBe(1);
		expect(stat.mode & 0o7777).toBe(0o644);
	});

	test("uses the fd-bound positional asynchronous spawn path", () => {
		const source = readFileSync(sourcePath, "utf8");
		const positionalRead = source.indexOf("_readSync(fd, buffer, 0, wanted, position)");
		const completedRange = source.indexOf("position !== before.size", positionalRead);
		const secondStat = source.indexOf("const after = _fstatSync(fd", completedRange);
		const equalSecondStat = source.indexOf("sameStat(before, after)", secondStat);
		const asynchronousSpawn = source.indexOf("child = _spawn(", equalSecondStat);
		expect(positionalRead).toBeGreaterThan(0);
		expect(completedRange).toBeGreaterThan(positionalRead);
		expect(secondStat).toBeGreaterThan(completedRange);
		expect(equalSecondStat).toBeGreaterThan(secondStat);
		expect(asynchronousSpawn).toBeGreaterThan(equalSecondStat);
		expect(source).toContain('process.platform === "darwin" ? "/dev/fd/3"');
		expect(source).toContain('process.platform === "linux" ? "/proc/self/fd/3"');
		expect(source).toContain('cwd: "/"');
		expect(source).toContain("env: {}");
		expect(source).toContain("detached: true");
		expect(source).toContain('stdio: ["pipe", "pipe", "pipe", validated.fd]');
		expect(source).not.toContain("spawn" + "Sync");
		expect(source).not.toContain("lseek");
	});

	test("runs the combined Darwin descriptor gate on the authoritative Bun and Python", async () => {
		expect(process.platform).toBe("darwin");
		expect(process.versions.bun).toBe("1.4.0");
		await descriptorExecutionGate("/opt/homebrew/bin/python3", "/dev/fd/3");
	});

	test("keeps caller validation ahead of every allocation effect", () => {
		const source = readFileSync(sourcePath, "utf8");
		const start = source.indexOf("async allocateOperation(");
		const end = source.indexOf("async simpleTransitionOperation(", start);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(end).toBeGreaterThan(start);
		const operation = source.slice(start, end);
		const identity = operation.indexOf("if (!validIdentityInput(identityRaw)) return failedResult()");
		const digests = operation.indexOf("if (digests === undefined) return failedResult()");
		expect(identity).toBeGreaterThanOrEqual(0);
		expect(digests).toBeGreaterThan(identity);
		for (const effect of [
			"this.poisoned",
			"appendGenesis(",
			"sha256(",
			"this.lifecycle.get(",
			"this.drawGeneration(",
			"makeWal(",
			"await this.helper(",
			"this.issueRegistry(",
			"this.rows.set(",
		])
			expect(operation.indexOf(effect), effect).toBeGreaterThan(digests);
	});

	test("binds the complete owner fault, recovery, and cleanup matrix", () => {
		const source = readFileSync(sourcePath, "utf8");
		for (const exact of [
			"const MAX_PAYLOAD = 1_048_576;",
			"const MAX_UNPARSED = 1_048_581;",
			"const MAX_STDERR = 65_536;",
			"this.command(OPEN, new Uint8Array(0), 30_000, false)",
			"this.helper(INVENTORY, new Uint8Array(0), 120_000, true)",
			"this.command(QUIT, new Uint8Array(0), 30_000, false)",
			'this.signal("SIGTERM")',
			'this.signal("SIGKILL")',
			'errorCode(failure) === "ESRCH"',
			"this.exited && this.stdoutClosed && this.stderrClosed && this.stdinClosed",
			"const fullWait = this.waitSettledFully()",
			"const settled = await this.waitSettled(30_000)",
			"if (pending === undefined || pending.response !== undefined)",
			"if (opcode !== DONE || payload.byteLength !== 0",
			"if (pending.inspect && pending.payloads.length !== 0)",
			"this.stdout.byteLength + chunk.byteLength > MAX_UNPARSED",
			"if (this.stderrBytes > MAX_STDERR) this.fatal()",
			"if (parsed.rolloverCase === 2)",
			"} else if (parsed.rolloverCase === 3)",
			"const removed = await this.helper(REMOVE_RETIRED",
			'if (ledger.status === "running")',
			'if (ledger.status === "cleanup-uncertain"',
		])
			expect(source, exact).toContain(exact);
		expect(source.match(/this\.signal\("SIGTERM"\)/g)?.length).toBe(1);
		expect(source.match(/this\.signal\("SIGKILL"\)/g)?.length).toBe(1);
		expect(source).not.toMatch(/process\.env|process\.argv/);
	});

	test("keeps V5 response parsing, startup gating, and close authority exact", () => {
		const source = readFileSync(sourcePath, "utf8");
		const parserStart = source.indexOf("private acceptFrame(opcode: number, payload: Uint8Array): void {");
		const parserEnd = source.indexOf("\n\tcommand(", parserStart);
		const parser = source.slice(parserStart, parserEnd);
		const errorBranch = parser.indexOf("if (opcode === ERROR)");
		const readyBranch = parser.indexOf("if (pending.responseMode === V5_READY_MODE)");
		const inventoryBranch = parser.indexOf("if (pending.responseMode === V5_BOUNDED_INVENTORY_MODE)", readyBranch);
		const v4Branch = parser.indexOf("if (pending.inventory || pending.inspect)");
		expect(parserStart).toBeGreaterThanOrEqual(0);
		expect(parserEnd).toBeGreaterThan(parserStart);
		expect(errorBranch).toBeGreaterThanOrEqual(0);
		expect(readyBranch).toBeGreaterThan(errorBranch);
		expect(inventoryBranch).toBeGreaterThan(readyBranch);
		expect(v4Branch).toBeGreaterThan(inventoryBranch);
		for (const exact of [
			"if (pending.responseMode === V5_BOUNDED_INVENTORY_MODE)",
			"opcode === V5_READY_RESPONSE",
			"payload.byteLength === 9",
			"payload[0] === V5_HELLO_OPCODE",
			"payload[8] === 0x35",
			"if (opcode === WS_TRANSACTION_RESPONSE)",
			"pending.payloads.length >= V5_MAX_ITEMS",
			"!isValidInputDraftTransaction(payload)",
			"(!isValidInputDraftTransaction(payload) && !isValidCanonicalSealedTransaction(payload))",
			"compareLifecyclePrefix(previous, payload) >= 0",
			"pending.payloads[pending.payloads.length] = payload",
			"if (opcode !== DONE || payload.byteLength !== 0)",
			"zeroBytes(payload)",
			"this.fatal()",
		])
			expect(parser).toContain(exact);
		expect(source).toContain(
			"const result = this.command(V5_HELLO_OPCODE, payload, 30_000, false, false, V5_READY_MODE);",
		);
		expect(source).toContain(
			"return this.command(WS_INVENTORY_OPCODE, new Uint8Array(0), 30_000, false, false, V5_BOUNDED_INVENTORY_MODE);",
		);
		for (const exact of [
			"const WS_TRANSACTION_RESPONSE = 0x83;",
			"const V5_TRANSACTION_SIZE = 401;",
			"const V5_MAX_ITEMS = 8;",
			"const V5_MAX_PLAN_PAYLOAD = 1_048_576;",
			"const V5_MAX_CONTENT = 1_073_741_824n;",
			"const V5_RESERVATION = 1_100_000_000n;",
			"rangeIsZero(payload, 96, 128)",
			"rangeIsZero(payload, 172, 180)",
			"rangeIsZero(payload, 196, 204)",
			"rangeIsZero(payload, 212, 216)",
			"view.getBigUint64(216, false) !== U64_NONE",
			"rangeIsZero(payload, 224, 384)",
			"view.getUint32(384, false) !== U32_NONE",
			"view.getUint32(388, false) !== U32_NONE",
			"view.getBigUint64(392, false) !== V5_RESERVATION",
			"payload[400] !== 1",
			"function isValidCanonicalSealedTransaction(payload: Uint8Array): boolean {",
			"rangeIsZero(payload, 172, 176)",
			"payload[176] !== 1",
			"rangeIsZero(payload, 177, 180)",
			"view.getBigUint64(204, false) !== U64_NONE",
			"view.getBigUint64(216, false) !== 0n",
			"rangeIsZero(payload, 320, 384)",
			"payload[400] !== 0",
			"zeroReadonlyList(invResult.payloads)",
			"this.failClean(resolveStart, true)",
		])
			expect(source).toContain(exact);
		expect(source).toContain('this.gateState = "RECOVERY_CLOSED";');
		expect(source).toContain('this.gateState = "ADMISSION_OPEN";');
		expect(source).toContain('this.gateState = "GLOBAL_REVOKED";');
		expect(source).toContain("if (this.closePromise !== undefined) return this.closePromise;");
		expect(source).toContain("const store: StartupV5HostedSessionStore = _freeze({");
		expect(source).toContain("close: () => {");
	});

	test("keeps the hardened TypeScript source forms", () => {
		const source = readFileSync(sourcePath, "utf8");
		expect(source.match(/export function /g)).toEqual(["export function ", "export function "]);
		expect(source).not.toMatch(/\bany\b/);
		expect(source).not.toMatch(/\bthrow\b/);
		expect(source).not.toContain("...");
		expect(source).not.toMatch(/\sas\s/);
		expect(source).not.toMatch(/TODO|placeholder/i);
	});
});

const externalTest = process.env.PRIME_HOSTED_STORE_EXTERNAL_TEST === "1" ? test : test.skip;

externalTest(
	"runs the exact cached Linux x64 Store against a chroot-local tmpfs root",
	async () => {
		const temporary = mkdtempSync(resolve(tmpdir(), "hosted-store-v22-"));
		const harnessPath = resolve(temporary, "integration.ts");
		writeFileSync(
			harnessPath,
			`import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, closeSync, constants, cpSync, fdatasyncSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHostedSessionStore, createStartupV5HostedSessionStore } from "./src/modes/daemon/sandbox/hosted-session-store.js";
import { types as utilTypes } from "node:util";

interface State {
	identity: object;
	providerState: string;
	generationKey: string;
	releaseDigest: string;
	manifestDigest: string;
	bootstrapDigest: string;
	trustDigest: string;
	runtimeConfigDigest: string;
}

class Capability {
	constructor() {
		Object.freeze(this);
	}
}
const states = new WeakMap<object, State>();
let replaceCalls = 0;
let forceInvalidReplace = false;
const registryEffects = { issueLoaded: 0, read: 0, replace: 0 };
function copyIdentity(raw: object): object {
	const value = raw;
	return Object.freeze({
		schema: value.schema,
		lifecycleKeyDigest: value.lifecycleKeyDigest,
		sessionId: value.sessionId,
		activeSessionId: value.activeSessionId,
		childId: value.childId,
		name: value.name,
		modelSelector: value.modelSelector,
		durableParentSessionId: value.durableParentSessionId,
		rlmParentNodeId: value.rlmParentNodeId,
		spawnedByRequestId: value.spawnedByRequestId,
		thinkingLevel: value.thinkingLevel,
		serviceTier: value.serviceTier,
		spawnContextDigest: value.spawnContextDigest,
		depth: value.depth,
	});
}
function copyState(raw: State): State {
	return Object.freeze({
		identity: copyIdentity(raw.identity),
		providerState: raw.providerState,
		generationKey: raw.generationKey,
		releaseDigest: raw.releaseDigest,
		manifestDigest: raw.manifestDigest,
		bootstrapDigest: raw.bootstrapDigest,
		trustDigest: raw.trustDigest,
		runtimeConfigDigest: raw.runtimeConfigDigest,
	});
}
function equal(left: State, right: State): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}
const registry = Object.freeze({
	issueLoaded(identityRaw: object, stateRaw: State): object {
		registryEffects.issueLoaded += 1;
		if (JSON.stringify(identityRaw) !== JSON.stringify(stateRaw.identity)) return Object.freeze({ code: "INVALID" });
		const cap = new Capability();
		states.set(cap, copyState(stateRaw));
		return Object.freeze({ code: "ISSUED", session: cap });
	},
	read(sessionRaw: object): object {
		registryEffects.read += 1;
		const state = states.get(sessionRaw);
		return state === undefined ? Object.freeze({ code: "UNKNOWN" }) : Object.freeze({ code: "KNOWN", state: copyState(state) });
	},
	replace(sessionRaw: object, expectedRaw: State, nextRaw: State): object {
		registryEffects.replace += 1;
		const state = states.get(sessionRaw);
		if (state === undefined) return Object.freeze({ code: "INVALID" });
		if (!equal(state, expectedRaw)) return Object.freeze({ code: "STALE" });
		if (forceInvalidReplace) {
			forceInvalidReplace = false;
			return Object.freeze({ code: "INVALID" });
		}
		if (replaceCalls === 0) {
			replaceCalls += 1;
			return Object.freeze({ code: "STALE" });
		}
		if (replaceCalls === 2) {
			replaceCalls += 1;
			states.set(sessionRaw, copyState(nextRaw));
			return Object.freeze({ code: "STALE" });
		}
		replaceCalls += 1;
		states.set(sessionRaw, copyState(nextRaw));
		return Object.freeze({ code: "REPLACED" });
	},
});
function check(condition: boolean, label: string): void {
	if (!condition) throw new Error(label);
}
async function fdGate(): Promise<void> {
	const candidate = "/tmp/descriptor-gate.py";
	const validated = "/tmp/descriptor-gate.validated.py";
	const original = Buffer.from("import os,sys\\nassert os.getpid()>1\\nassert sys.version_info.major==3\\nprint('BOUND')\\n");
	writeFileSync(candidate, original, { mode: 0o644 });
	const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW | 0x00080000);
	try {
		const before = fstatSync(fd);
		const hash = createHash("sha256");
		const buffer = Buffer.alloc(17);
		let position = 0;
		let priorEnd = 0;
		while (position < before.size) {
			const wanted = Math.min(buffer.byteLength, before.size - position);
			const count = readSync(fd, buffer, 0, wanted, position);
			check(count > 0 && position === priorEnd, "linux positional range");
			hash.update(buffer.subarray(0, count));
			position += count;
			priorEnd = position;
		}
		check(position === before.size, "linux full positional range");
		check(hash.digest("hex") === createHash("sha256").update(original).digest("hex"), "linux positional digest");
		const after = fstatSync(fd);
		for (const key of ["dev", "ino", "uid", "gid", "mode", "nlink", "size"] as const)
			check(after[key] === before[key], "linux second fstat " + key);
		check(after.isFile() === before.isFile(), "linux second fstat type");
		const finite = <T>(promise: Promise<T>, milliseconds: number): Promise<{done:true;value:T}|{done:false}> => new Promise((resolveWait) => {
			const timer = setTimeout(() => resolveWait({ done: false }), milliseconds);
			promise.then((value) => { clearTimeout(timer); resolveWait({ done: true, value }); });
		});
		const run = async (args: string[], deadlines = { complete: 5_000, term: 2_000, kill: 2_000 }): Promise<{code:number|null;out:string;err:string;cleanupSignals:string[]}> => {
			const child = spawn("/usr/local/bin/python3", args, { cwd: "/", env: {}, detached: true, stdio: ["ignore", "pipe", "pipe", fd] });
			check(child.pid !== undefined && child.stdout !== null && child.stderr !== null, "linux spawn contract");
			const pid = child.pid;
			let out = "";
			let err = "";
			let code: number | null = null;
			const cleanupSignals: string[] = [];
			child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => { out += chunk; });
			child.stderr.on("data", (chunk: string) => { err += chunk; });
			const exited = new Promise<void>((resolveExit) => {
				child.once("error", () => resolveExit());
				child.once("exit", (exitCode) => { code = exitCode; resolveExit(); });
			});
			const stdoutClosed = new Promise<void>((resolveClose) => child.stdout.once("close", resolveClose));
			const stderrClosed = new Promise<void>((resolveClose) => child.stderr.once("close", resolveClose));
			const settled = Promise.all([exited, stdoutClosed, stderrClosed]);
			let outcome = await finite(settled, deadlines.complete);
			if (!outcome.done) {
				cleanupSignals.push("SIGTERM");
				try { process.kill(-pid, "SIGTERM"); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
				outcome = await finite(settled, deadlines.term);
				if (!outcome.done) {
					cleanupSignals.push("SIGKILL");
					try { process.kill(-pid, "SIGKILL"); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
					outcome = await finite(settled, deadlines.kill);
				}
			}
			let absent = false;
			try { process.kill(-pid, 0); } catch (failure) { absent = failure.code === "ESRCH"; }
			check(absent, "linux spawned group ESRCH");
			check(outcome.done, "linux KILL drain deadline");
			return { code, out, err, cleanupSignals };
		};
		const probe = await run(["-c", "import os;print(os.lseek(3,0,1))"]);
		check(probe.code === 0 && probe.out === "0\\n" && probe.err === "" && probe.cleanupSignals.length === 0, "linux shared offset zero");
		const escalated = await run(
			["-c", "import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);print('READY',flush=True);time.sleep(30)"],
			{ complete: 500, term: 200, kill: 2_000 },
		);
		check(escalated.code === null && escalated.out === "READY\\n" && escalated.err === "", "linux escalated result");
		check(JSON.stringify(escalated.cleanupSignals) === '["SIGTERM","SIGKILL"]', "linux TERM KILL exercise");
		renameSync(candidate, validated);
		writeFileSync(candidate, "raise SystemExit(99)\\n", { mode: 0o644 });
		const executed = await run(["/proc/self/fd/3"]);
		check(executed.code === 0 && executed.out === "BOUND\\n" && executed.err === "" && executed.cleanupSignals.length === 0, "linux bound full execution");
	} finally {
		closeSync(fd);
		rmSync(candidate, { force: true });
		rmSync(validated, { force: true });
	}
}
if (process.argv[2] === undefined || process.argv[2] === "timeout") await fdGate();
if (process.argv[2]?.startsWith("rollover-verify")) {
	const verifyFactory = await createHostedSessionStore(registry);
	check(verifyFactory.code === "READY", "rollover verify factory");
	if (verifyFactory.code !== "READY") process.exit(90);
	const verifyInventory1 = await verifyFactory.store.inventory();
	const verifyInventory2 = await verifyFactory.store.inventory();
	check(verifyInventory1.code === "INVENTORIED" && verifyInventory2.code === "INVENTORIED", "rollover verify inventory");
	if (verifyInventory1.code !== "INVENTORIED" || verifyInventory2.code !== "INVENTORIED") process.exit(91);
	check(verifyInventory1.sessions.length === 1 && verifyInventory2.sessions.length === 1 && verifyInventory1.sessions[0] === verifyInventory2.sessions[0], "rollover verify one retained cap");
	const verifyState = await verifyFactory.store.state(verifyInventory1.sessions[0]);
	check(verifyState.code === "STATE" && verifyState.state === "ALLOCATED", "rollover verify state");
	check((await verifyFactory.store.close()).code === "CLOSED", "rollover verify close");
	console.log("ROLLOVER_VERIFY_OK " + process.argv[2]);
	process.exit(0);
}
if (process.argv[2]?.startsWith("rollover-cut")) {
	const cutFactory = await createHostedSessionStore(registry);
	check(cutFactory.code === "READY", "rollover cut factory");
	if (cutFactory.code !== "READY") process.exit(92);
	check((await cutFactory.store.inventory()).code === "INVENTORIED", "rollover cut inventory");
	const cutIdentity = Object.freeze({ sessionId: "cut-s", activeSessionId: "cut-a", childId: "cut-c", name: "cut", modelSelector: "model", durableParentSessionId: "cut-p", rlmParentNodeId: "cut-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "44".repeat(32), depth: 1 });
	const cutDigests = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
	const cutAllocation = await cutFactory.store.allocate(cutIdentity, cutDigests);
	check(cutAllocation.code === "ALLOCATED", "rollover cut allocate");
	if (cutAllocation.code !== "ALLOCATED") process.exit(93);
	check((await cutFactory.store.createDispatched(cutAllocation.session)).code === "COMMITTED", "rollover cut create");
	check((await cutFactory.store.retireAndAdvance(cutAllocation.session)).code === "FAILED", "rollover publication cut failed current Store");
	check((await cutFactory.store.inventory()).code === "FAILED", "rollover cut poison reuse");
	check((await cutFactory.store.close()).code === "FAILED", "rollover cut close");
	console.log("ROLLOVER_CUT_OK " + process.argv[2]);
	process.exit(0);
}
if (process.argv[2]?.startsWith("v5fault-")) {
	const scenario = process.argv[2].slice("v5fault-".length);
	const startupFailure = await createStartupV5HostedSessionStore(registry);
	exactFailed(startupFailure, "V5 fault exact FAILED " + scenario);
	console.log("V5_FAULT_OK " + scenario);
	process.exit(0);
}
if (process.argv[2]?.startsWith("fault-")) {
	const scenario = process.argv[2].slice("fault-".length);
	const faultFactory = await createHostedSessionStore(registry);
	check(faultFactory.code === "READY", "fault factory " + scenario);
	if (faultFactory.code !== "READY") process.exit(80);
	const first = await faultFactory.store.inventory();
	let failure = first;
	if (first.code === "INVENTORIED") {
		await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 100));
		failure = await faultFactory.store.inventory();
	}
	function exactFaultFailed(value: object, label: string): void {
		const descriptor = Object.getOwnPropertyDescriptor(value, "code");
		check(Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertyNames(value).join(",") === "code" && Object.getOwnPropertySymbols(value).length === 0 && Object.isFrozen(value), label + " ordinary");
		check(descriptor?.value === "FAILED" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor");
	}
	exactFaultFailed(failure, "fault exact FAILED " + scenario);
	exactFaultFailed(await faultFactory.store.inventory(), "fault reuse " + scenario);
	exactFaultFailed(await faultFactory.store.close(), "fault close " + scenario);
	console.log("FAULT_OK " + scenario);
	process.exit(0);
}
if (process.argv[2] === "timeout") {
	const timeoutFactory = await createHostedSessionStore(registry);
	check(timeoutFactory.code === "READY", "timeout factory");
	if (timeoutFactory.code !== "READY") process.exit(70);
	check((await timeoutFactory.store.inventory()).code === "INVENTORIED", "timeout inventory");
	const timeoutIdentity = Object.freeze({ sessionId: "timeout-s", activeSessionId: "timeout-a", childId: "timeout-c", name: "timeout", modelSelector: "model", durableParentSessionId: "timeout-p", rlmParentNodeId: "timeout-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "33".repeat(32), depth: 1 });
	const timeoutDigests = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
	const timeoutAllocation = await timeoutFactory.store.allocate(timeoutIdentity, timeoutDigests);
	check(timeoutAllocation.code === "ALLOCATED", "timeout allocate");
	if (timeoutAllocation.code !== "ALLOCATED") process.exit(71);
	const children = readFileSync("/proc/" + process.pid + "/task/" + process.pid + "/children", "utf8").trim().split(/\\s+/);
	check(children.length === 1, "timeout helper child");
	const helperPid = Number(children[0]);
	check(Number.isSafeInteger(helperPid) && helperPid > 1, "timeout helper pid");
	if (!Number.isSafeInteger(helperPid) || helperPid <= 1) process.exit(72);
	process.kill(helperPid, "SIGSTOP");
	const timedPromise = timeoutFactory.store.createDispatched(timeoutAllocation.session);
	await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 30_750));
	const status = readFileSync("/proc/" + helperPid + "/status", "utf8").split("\\n");
	let pending = 0n;
	for (const line of status) {
		if (line.startsWith("SigPnd:") || line.startsWith("ShdPnd:")) {
			const fields = line.trim().split(/\\s+/);
			if (fields.length === 2) pending |= BigInt("0x" + fields[1]);
		}
	}
	check((pending & (1n << 14n)) !== 0n, "real SIGTERM pending during grace");
	const timed = await timedPromise;
	check(timed.code === "FAILED", "Store-owned command timeout");
	check((await timeoutFactory.store.inventory()).code === "FAILED", "timeout poison reuse");
	check((await timeoutFactory.store.close()).code === "FAILED", "timeout failed close");
	let helperGroupAbsent = false;
	try {
		process.kill(-helperPid, 0);
	} catch (failure) {
		helperGroupAbsent = failure instanceof Error && "code" in failure && failure.code === "ESRCH";
	}
	check(helperGroupAbsent, "timeout helper group ESRCH");
	console.log("TIMEOUT_OK");
	console.log("STORE_TIMEOUT_TERM_KILL_ESRCH_OK");
	process.exit(0);
}
const blockedRoot = "/root/.prime/agent/sandbox-session-state-v1";
rmSync(blockedRoot, { recursive: true, force: true });
const v4BeforeBlocked = await createHostedSessionStore(registry);
check(v4BeforeBlocked.code === "READY", "V5 blocked V4 factory");
if (v4BeforeBlocked.code !== "READY") process.exit(48);
const blockedIdentity = Object.freeze({ sessionId: "blocked-s", activeSessionId: "blocked-a", childId: "blocked-c", name: "blocked", modelSelector: "model", durableParentSessionId: "blocked-p", rlmParentNodeId: "blocked-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "55".repeat(32), depth: 1 });
const blockedDigests = Object.freeze({ releaseDigest: new Uint8Array(32).fill(6), manifestDigest: new Uint8Array(32).fill(7), bootstrapDigest: new Uint8Array(32).fill(8), trustDigest: new Uint8Array(32).fill(9), runtimeConfigDigest: new Uint8Array(32).fill(10) });
const blockedInventory = await v4BeforeBlocked.store.inventory();
const blockedAllocation = await v4BeforeBlocked.store.allocate(blockedIdentity, blockedDigests);
const blockedClose = await v4BeforeBlocked.store.close();
check(blockedInventory.code === "INVENTORIED", "V5 blocked V4 inventory");
check(blockedAllocation.code === "ALLOCATED", "V5 blocked real V4 allocation " + blockedAllocation.code);
check(blockedClose.code === "CLOSED", "V5 blocked first helper closed");

const bLifecycleNames = readdirSync(blockedRoot).filter((name) => /^[0-9a-f]{64}$/.test(name));
check(bLifecycleNames.length === 1, "B13 lifecycle");
const bLifecycleName = bLifecycleNames[0];
if (bLifecycleName === undefined) process.exit(60);
const bLifecyclePath = blockedRoot + "/" + bLifecycleName;
const bGenerationNames = readdirSync(bLifecyclePath + "/generations").filter((name) => /^[0-9a-f]{64}$/.test(name));
check(bGenerationNames.length === 1, "B13 generation");
const bGenerationName = bGenerationNames[0];
if (bGenerationName === undefined) process.exit(61);
const bGenerationPath = bLifecyclePath + "/generations/" + bGenerationName;
const bEvidencePath = bGenerationPath + "/workspace-evidence";
mkdirSync(bEvidencePath, { mode: 0o700 });
const bGenerationFd = openSync(bGenerationPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | 0x00080000);
fsyncSync(bGenerationFd);
closeSync(bGenerationFd);
const bPlanNonce = Buffer.alloc(32, 7);
const bContentNonce = Buffer.alloc(32, 8);
const bManifestNonce = Buffer.alloc(32, 9);
const bPlan = Buffer.alloc(12);
bPlan.write("PIWSPLN1", 0, "ascii");
bPlan.writeUInt32BE(17, 8);
const bContent = Buffer.alloc(16);
bContent.write("PIWSCNT1", 0, "ascii");
bContent.writeBigUInt64BE(23n, 8);
const bManifest = Buffer.alloc(272);
bManifest.write("PIWSIMF5", 0, "ascii");
Buffer.from(bLifecycleName, "hex").copy(bManifest, 16);
Buffer.from(bGenerationName, "hex").copy(bManifest, 48);
bManifest.fill(4, 80, 112);
bManifest[112] = 1;
bManifest.fill(6, 144, 176);
bManifest.writeUInt32BE(17, 176);
bManifest.writeBigUInt64BE(23n, 180);
bPlanNonce.copy(bManifest, 188);
bContentNonce.copy(bManifest, 220);
function bWriteDurable(path: string, bytes: Uint8Array): void {
	const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | 0x00080000, 0o600);
	writeFileSync(fd, bytes);
	fdatasyncSync(fd);
	closeSync(fd);
}
function bSyncEvidence(): void {
	const fd = openSync(bEvidencePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY | 0x00080000);
	fsyncSync(fd);
	closeSync(fd);
}
bWriteDurable(bEvidencePath + "/.ws-plan." + bPlanNonce.toString("hex"), bPlan);
bSyncEvidence();
bWriteDurable(bEvidencePath + "/.ws-content." + bContentNonce.toString("hex"), bContent);
bSyncEvidence();
const bManifestTempPath = bEvidencePath + "/.ws-input-manifest-tmp." + bManifestNonce.toString("hex");
bWriteDurable(bManifestTempPath, bManifest);
const bManifestCanonicalPath = bEvidencePath + "/input.manifest";
linkSync(bManifestTempPath, bManifestCanonicalPath);
bSyncEvidence();
const v5NonemptyReady = await createStartupV5HostedSessionStore(registry);
check(v5NonemptyReady.code === "FAILED", "V5 nonempty fails closed before inventory settlement");
check(Object.getPrototypeOf(v5NonemptyReady) === Object.prototype && Object.isFrozen(v5NonemptyReady), "V5 nonempty failure exact ordinary");
check(Object.getOwnPropertyNames(v5NonemptyReady).join(",") === "code" && Object.getOwnPropertySymbols(v5NonemptyReady).length === 0, "V5 nonempty failure keys");
const bPublishedNames = [
	".ws-content." + bContentNonce.toString("hex"),
	".ws-plan." + bPlanNonce.toString("hex"),
	"input.manifest",
];
check(readdirSync(bEvidencePath).sort().join(",") === bPublishedNames.join(","), "B17 exact published names");
check(lstatSync(bManifestCanonicalPath).nlink === 1, "B17 canonical one link");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_NONEMPTY_READY_OK");
// T3: One running lifecycle (with head)
const t3v4 = await createHostedSessionStore(registry);
check(t3v4.code === "READY", "T3 V4 factory");
if (t3v4.code !== "READY") process.exit(50);
const t3inv = await t3v4.store.inventory();
check(t3inv.code === "INVENTORIED", "T3 inventory");
const t3id = Object.freeze({ sessionId: "t3-s", activeSessionId: "t3-a", childId: "t3-c", name: "t3", modelSelector: "model", durableParentSessionId: "t3-p", rlmParentNodeId: "t3-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "33".repeat(32), depth: 1 });
const t3dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t3alloc = await t3v4.store.allocate(t3id, t3dg);
check(t3alloc.code === "ALLOCATED", "T3 allocate");
check((await t3v4.store.createDispatched(t3alloc.session)).code === "COMMITTED", "T3 create dispatched");
check((await t3v4.store.close()).code === "CLOSED", "T3 close");
const t3v5 = await createStartupV5HostedSessionStore(registry);
check(t3v5.code === "READY", "T3 V5 ready running lifecycle");
if (t3v5.code !== "READY") process.exit(51);
check((await t3v5.store.close()).code === "CLOSED", "T3 closed");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_RUNNING_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T4: One terminal lifecycle (deleteDispatched)
const t4v4 = await createHostedSessionStore(registry);
check(t4v4.code === "READY", "T4 V4 factory");
if (t4v4.code !== "READY") process.exit(52);
const t4inv = await t4v4.store.inventory();
check(t4inv.code === "INVENTORIED", "T4 inventory");
const t4id = Object.freeze({ sessionId: "t4-s", activeSessionId: "t4-a", childId: "t4-c", name: "t4", modelSelector: "model", durableParentSessionId: "t4-p", rlmParentNodeId: "t4-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "44".repeat(32), depth: 1 });
const t4dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t4alloc = await t4v4.store.allocate(t4id, t4dg);
check(t4alloc.code === "ALLOCATED", "T4 allocate");
check((await t4v4.store.createDispatched(t4alloc.session)).code === "COMMITTED", "T4 create");
check((await t4v4.store.present(t4alloc.session)).code === "COMMITTED", "T4 present");
check((await t4v4.store.runtimeDispatched(t4alloc.session)).code === "COMMITTED", "T4 runtime");
check((await t4v4.store.running(t4alloc.session)).code === "COMMITTED", "T4 running");
check((await t4v4.store.deleteDispatched(t4alloc.session, Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }))).code === "COMMITTED", "T4 delete");
check((await t4v4.store.close()).code === "CLOSED", "T4 close");
const t4v5 = await createStartupV5HostedSessionStore(registry);
check(t4v5.code === "READY", "T4 V5 ready terminal lifecycle");
if (t4v5.code !== "READY") process.exit(53);
check((await t4v5.store.close()).code === "CLOSED", "T4 closed");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_TERMINAL_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T5: parameterized N=2 (different states) and N=8
const t5dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t5Counts = Object.freeze([2, 8]);
for (let t5ci = 0; t5ci < t5Counts.length; t5ci++) {
	const t5n = t5Counts[t5ci];
	rmSync(blockedRoot, { recursive: true, force: true });
	const t5v4 = await createHostedSessionStore(registry);
	check(t5v4.code === "READY", "T5 V4 N" + t5n);
	if (t5v4.code !== "READY") process.exit(54);
	check((await t5v4.store.inventory()).code === "INVENTORIED", "T5 N" + t5n + " inventory");
	for (let t5i = 0; t5i < t5n; t5i++) {
		const t5sid = Object.freeze({ sessionId: "t5-" + t5i, activeSessionId: "t5a-" + t5i, childId: "t5c-" + t5i, name: "t5", modelSelector: "model", durableParentSessionId: "t5p-" + t5i, rlmParentNodeId: "t5n-" + t5i, spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: ("0" + (t5i + 1)).repeat(32).slice(0, 64), depth: 1 });
		const t5alloc = await t5v4.store.allocate(t5sid, t5dg);
		check(t5alloc.code === "ALLOCATED", "T5 N" + t5n + " allocate " + t5i);
		if (t5alloc.code !== "ALLOCATED") process.exit(55);
		if (t5n === 2 && t5i === 0) {
			check((await t5v4.store.createDispatched(t5alloc.session)).code === "COMMITTED", "T5 N" + t5n + " create first");
			check((await t5v4.store.present(t5alloc.session)).code === "COMMITTED", "T5 N" + t5n + " present first");
			check((await t5v4.store.runtimeDispatched(t5alloc.session)).code === "COMMITTED", "T5 N" + t5n + " runtime first");
			check((await t5v4.store.running(t5alloc.session)).code === "COMMITTED", "T5 N" + t5n + " running first");
			check((await t5v4.store.deleteDispatched(t5alloc.session, Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }))).code === "COMMITTED", "T5 N" + t5n + " delete first");
		} else {
			check((await t5v4.store.createDispatched(t5alloc.session)).code === "COMMITTED", "T5 N" + t5n + " create " + t5i);
		}
	}
	check((await t5v4.store.close()).code === "CLOSED", "T5 N" + t5n + " close");
	const t5v5 = await createStartupV5HostedSessionStore(registry);
	check(t5v5.code === "READY", "T5 V5 ready N=" + t5n);
	if (t5v5.code !== "READY") process.exit(56);
	check((await t5v5.store.close()).code === "CLOSED", "T5 N" + t5n + " closed");
}
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_N2_N8_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T6: V5 residue at generation dir
const t6v4 = await createHostedSessionStore(registry);
check(t6v4.code === "READY", "T6 V4 factory");
if (t6v4.code !== "READY") process.exit(57);
const t6inv = await t6v4.store.inventory();
check(t6inv.code === "INVENTORIED", "T6 inventory");
const t6id = Object.freeze({ sessionId: "t6-s", activeSessionId: "t6-a", childId: "t6-c", name: "t6", modelSelector: "model", durableParentSessionId: "t6-p", rlmParentNodeId: "t6-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "66".repeat(32), depth: 1 });
const t6dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t6alloc = await t6v4.store.allocate(t6id, t6dg);
check(t6alloc.code === "ALLOCATED", "T6 allocate");
check((await t6v4.store.createDispatched(t6alloc.session)).code === "COMMITTED", "T6 create");
check((await t6v4.store.close()).code === "CLOSED", "T6 close");
// Inject workspace-evidence/ in the generation dir (parallel to wal/)
const t6Root = blockedRoot;
const t6LifecycleDirs = readdirSync(t6Root).filter(n => n !== ".lock" && n.length === 64);
check(t6LifecycleDirs.length >= 1, "T6 lifecycle exists");
const t6GenDir = t6Root + "/" + t6LifecycleDirs[0] + "/generations";
const t6GenChildren = readdirSync(t6GenDir).filter(n => n.length === 64);
check(t6GenChildren.length >= 1, "T6 generation exists");
mkdirSync(t6GenDir + "/" + t6GenChildren[0] + "/workspace-evidence", { recursive: true });
const t6v5 = await createStartupV5HostedSessionStore(registry);
exactFailed(t6v5, "T6 V5 residue at generation dir fatal");
check(Object.getOwnPropertyNames(t6v5).join(",") === "code", "T6 exact");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_RESIDUE_GENERATION_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T7: V5 residue at lifecycle dir
const t7v4 = await createHostedSessionStore(registry);
check(t7v4.code === "READY", "T7 V4 factory");
if (t7v4.code !== "READY") process.exit(58);
const t7inv = await t7v4.store.inventory();
check(t7inv.code === "INVENTORIED", "T7 inventory");
const t7id = Object.freeze({ sessionId: "t7-s", activeSessionId: "t7-a", childId: "t7-c", name: "t7", modelSelector: "model", durableParentSessionId: "t7-p", rlmParentNodeId: "t7-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "77".repeat(32), depth: 1 });
const t7dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t7alloc = await t7v4.store.allocate(t7id, t7dg);
check(t7alloc.code === "ALLOCATED", "T7 allocate");
check((await t7v4.store.createDispatched(t7alloc.session)).code === "COMMITTED", "T7 create");
check((await t7v4.store.close()).code === "CLOSED", "T7 close");
// Inject .ws-identity-tmp.xxxx in lifecycle dir
const t7LifecycleDirs = readdirSync(blockedRoot).filter(n => n !== ".lock" && n.length === 64);
check(t7LifecycleDirs.length >= 1, "T7 lifecycle exists");
writeFileSync(blockedRoot + "/" + t7LifecycleDirs[0] + "/.ws-identity-tmp.11112222333344445555666677778888", "", "utf8");
const t7v5 = await createStartupV5HostedSessionStore(registry);
exactFailed(t7v5, "T7 V5 residue at lifecycle dir fatal");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_RESIDUE_LIFECYCLE_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T8: V5 residue at WAL dir
const t8v4 = await createHostedSessionStore(registry);
check(t8v4.code === "READY", "T8 V4 factory");
if (t8v4.code !== "READY") process.exit(59);
const t8inv = await t8v4.store.inventory();
check(t8inv.code === "INVENTORIED", "T8 inventory");
const t8id = Object.freeze({ sessionId: "t8-s", activeSessionId: "t8-a", childId: "t8-c", name: "t8", modelSelector: "model", durableParentSessionId: "t8-p", rlmParentNodeId: "t8-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "88".repeat(32), depth: 1 });
const t8dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t8alloc = await t8v4.store.allocate(t8id, t8dg);
check(t8alloc.code === "ALLOCATED", "T8 allocate");
check((await t8v4.store.createDispatched(t8alloc.session)).code === "COMMITTED", "T8 create");
check((await t8v4.store.close()).code === "CLOSED", "T8 close");
// Inject .ws-checkpoint-tmp.xxxx in wal dir
const t8LifecycleDirs = readdirSync(blockedRoot).filter(n => n !== ".lock" && n.length === 64);
check(t8LifecycleDirs.length >= 1, "T8 lifecycle exists");
const t8GenDirs = readdirSync(blockedRoot + "/" + t8LifecycleDirs[0] + "/generations").filter(n => n.length === 64);
check(t8GenDirs.length >= 1, "T8 generation exists");
writeFileSync(blockedRoot + "/" + t8LifecycleDirs[0] + "/generations/" + t8GenDirs[0] + "/wal/.ws-checkpoint-tmp.11112222333344445555666677778888", "", "utf8");
const t8v5 = await createStartupV5HostedSessionStore(registry);
exactFailed(t8v5, "T8 V5 residue at WAL dir fatal");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_RESIDUE_WAL_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T9: Unknown file at root
const t9v4 = await createHostedSessionStore(registry);
check(t9v4.code === "READY", "T9 V4 factory");
if (t9v4.code !== "READY") process.exit(60);
const t9inv = await t9v4.store.inventory();
check(t9inv.code === "INVENTORIED", "T9 inventory");
const t9id = Object.freeze({ sessionId: "t9-s", activeSessionId: "t9-a", childId: "t9-c", name: "t9", modelSelector: "model", durableParentSessionId: "t9-p", rlmParentNodeId: "t9-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "99".repeat(32), depth: 1 });
const t9dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t9alloc = await t9v4.store.allocate(t9id, t9dg);
check(t9alloc.code === "ALLOCATED", "T9 allocate");
check((await t9v4.store.createDispatched(t9alloc.session)).code === "COMMITTED", "T9 create");
check((await t9v4.store.close()).code === "CLOSED", "T9 close");
// Inject unknown file at root
writeFileSync(blockedRoot + "/unknown-file", "", "utf8");
const t9v5 = await createStartupV5HostedSessionStore(registry);
exactFailed(t9v5, "T9 V5 unknown file at root fatal");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_RESIDUE_ROOT_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T10: Helper crash/restart durability
const t10v4 = await createHostedSessionStore(registry);
check(t10v4.code === "READY", "T10 V4 factory");
if (t10v4.code !== "READY") process.exit(61);
const t10inv = await t10v4.store.inventory();
check(t10inv.code === "INVENTORIED", "T10 inventory");
const t10id = Object.freeze({ sessionId: "t10-s", activeSessionId: "t10-a", childId: "t10-c", name: "t10", modelSelector: "model", durableParentSessionId: "t10-p", rlmParentNodeId: "t10-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "1010".repeat(16), depth: 1 });
const t10dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t10alloc = await t10v4.store.allocate(t10id, t10dg);
check(t10alloc.code === "ALLOCATED", "T10 allocate");
check((await t10v4.store.createDispatched(t10alloc.session)).code === "COMMITTED", "T10 create");
check((await t10v4.store.close()).code === "CLOSED", "T10 close");
// First V5 startup - should be READY
const t10first = await createStartupV5HostedSessionStore(registry);
check(t10first.code === "READY", "T10 first V5 READY");
if (t10first.code !== "READY") process.exit(62);
// SIGKILL the V5 helper via negative PGID using /proc children pattern
const t10Children = readFileSync("/proc/" + process.pid + "/task/" + process.pid + "/children", "utf8").trim().split(/\\s+/);
check(t10Children.length === 1, "T10 helper child");
const t10HelperPid = Number(t10Children[0]);
check(Number.isSafeInteger(t10HelperPid) && t10HelperPid > 1, "T10 helper pid");
if (!Number.isSafeInteger(t10HelperPid) || t10HelperPid <= 1) process.exit(63);
process.kill(-t10HelperPid, "SIGKILL");
const t10KilledClose = await t10first.store.close();
check(t10KilledClose.code === "FAILED", "T10 killed close FAILED");
let t10GroupAbsent = false;
try {
	process.kill(-t10HelperPid, 0);
} catch (failure) {
	t10GroupAbsent = typeof failure === "object" && failure !== null && "code" in failure && failure.code === "ESRCH";
}
check(t10GroupAbsent, "T10 helper group ESRCH");
// Second V5 startup on same root - should be READY (durability)
const t10second = await createStartupV5HostedSessionStore(registry);
check(t10second.code === "READY", "T10 second V5 READY durable");
if (t10second.code !== "READY") process.exit(64);
check((await t10second.store.close()).code === "CLOSED", "T10 second close");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_DURABILITY_OK");

rmSync(blockedRoot, { recursive: true, force: true });
// T11: V4 -> V5 -> V4 allocate a second session -> V5 cross-version cycle
const t11v4a = await createHostedSessionStore(registry);
check(t11v4a.code === "READY", "T11 V4a factory " + t11v4a.code);
if (t11v4a.code !== "READY") process.exit(64);
check((await t11v4a.store.inventory()).code === "INVENTORIED", "T11 V4a inventory");
const t11ida = Object.freeze({ sessionId: "t11a-s", activeSessionId: "t11a-a", childId: "t11a-c", name: "t11a", modelSelector: "model", durableParentSessionId: "t11a-p", rlmParentNodeId: "t11a-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "1111".repeat(16), depth: 1 });
const t11dg = Object.freeze({ releaseDigest: new Uint8Array(32).fill(1), manifestDigest: new Uint8Array(32).fill(2), bootstrapDigest: new Uint8Array(32).fill(3), trustDigest: new Uint8Array(32).fill(4), runtimeConfigDigest: new Uint8Array(32).fill(5) });
const t11alloca = await t11v4a.store.allocate(t11ida, t11dg);
check(t11alloca.code === "ALLOCATED", "T11 V4 allocate");
check((await t11v4a.store.createDispatched(t11alloca.session)).code === "COMMITTED", "T11 V4 create first");
check((await t11v4a.store.close()).code === "CLOSED", "T11 V4 close");
// V5
const t11v5a = await createStartupV5HostedSessionStore(registry);
check(t11v5a.code === "READY", "T11 first V5 READY");
if (t11v5a.code !== "READY") process.exit(65);
check((await t11v5a.store.close()).code === "CLOSED", "T11 first V5 close");
// V4 again - allocate a second session
const t11v4b = await createHostedSessionStore(registry);
check(t11v4b.code === "READY", "T11 V4b factory");
if (t11v4b.code !== "READY") process.exit(66);
check((await t11v4b.store.inventory()).code === "INVENTORIED", "T11 V4b inventory");
const t11idb = Object.freeze({ sessionId: "t11b-s", activeSessionId: "t11b-a", childId: "t11b-c", name: "t11b", modelSelector: "model", durableParentSessionId: "t11b-p", rlmParentNodeId: "t11b-n", spawnedByRequestId: null, thinkingLevel: "medium", serviceTier: null, spawnContextDigest: "2222".repeat(16), depth: 1 });
const t11allocb = await t11v4b.store.allocate(t11idb, t11dg);
check(t11allocb.code === "ALLOCATED", "T11 V4 allocate second");
check((await t11v4b.store.createDispatched(t11allocb.session)).code === "COMMITTED", "T11 V4 create second");
check((await t11v4b.store.close()).code === "CLOSED", "T11 V4b close");
// V5 again
const t11v5b = await createStartupV5HostedSessionStore(registry);
check(t11v5b.code === "READY", "T11 second V5 READY cross-version");
if (t11v5b.code !== "READY") process.exit(67);
check((await t11v5b.store.close()).code === "CLOSED", "T11 second V5 close");
rmSync(blockedRoot, { recursive: true, force: true });
console.log("V5_MATRIX_CROSSVERSION_OK");


const integrationStarted = Date.now();
function milestone(label: string): void { console.log("MILESTONE " + label + " " + (Date.now() - integrationStarted)); }
const ready = await createHostedSessionStore(registry);
check(ready.code === "READY", "ready");
if (ready.code !== "READY") process.exit(2);
const store = ready.store;
const methodNames = ["inventory", "allocate", "state", "createDispatched", "present", "runtimeDispatched", "running", "deleteDispatched", "cleanupUncertain", "absent", "retireAndAdvance", "purge", "close"];
check(Object.getPrototypeOf(ready) === Object.prototype && Object.isFrozen(ready) && Object.getOwnPropertyNames(ready).join(",") === "code,store", "factory result exact");
check(Object.getPrototypeOf(store) === Object.prototype && Object.isFrozen(store), "Store exact ordinary");
check(Object.getOwnPropertyNames(store).join(",") === methodNames.join(",") && Object.getOwnPropertySymbols(store).length === 0, "Store keys");
for (const name of methodNames) {
	const descriptor = Object.getOwnPropertyDescriptor(store, name);
	check(typeof descriptor?.value === "function" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false, "Store method descriptor " + name);
}
function exactInventoryResult(value: object, expectedLength: number, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " outer");
	check(Object.getOwnPropertyNames(value).join(",") === "code,sessions" && Object.getOwnPropertySymbols(value).length === 0, label + " outer names");
	for (const name of ["code", "sessions"]) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		check(descriptor?.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " outer descriptor " + name);
	}
	check(value.code === "INVENTORIED" && Array.isArray(value.sessions) && !utilTypes.isProxy(value.sessions), label + " array brand");
	check(Object.getPrototypeOf(value.sessions) === Array.prototype && Object.isFrozen(value.sessions), label + " array prototype/frozen");
	const expectedNames = Array.from({ length: expectedLength }, (_, index) => String(index)).concat("length");
	check(Object.getOwnPropertyNames(value.sessions).join(",") === expectedNames.join(",") && Object.getOwnPropertySymbols(value.sessions).length === 0, label + " dense names");
	for (let index = 0; index < expectedLength; index += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(value.sessions, String(index));
		check(descriptor?.value === value.sessions[index] && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false, label + " element " + index);
		check(Object.isFrozen(value.sessions[index]) && Object.getOwnPropertyNames(value.sessions[index]).length === 0 && Object.getOwnPropertySymbols(value.sessions[index]).length === 0, label + " opaque " + index);
	}
	const length = Object.getOwnPropertyDescriptor(value.sessions, "length");
	check(length?.value === expectedLength && length.enumerable === false && length.writable === false && length.configurable === false, label + " length descriptor");
}
const inventoryPromise = store.inventory();
check(inventoryPromise instanceof Promise && Object.getPrototypeOf(inventoryPromise) === Promise.prototype, "inventory owned native Promise");
const inv1 = await inventoryPromise;
const inv2 = await store.inventory();
check(inv1.code === "INVENTORIED" && inv2.code === "INVENTORIED", "inventory");
if (inv1.code !== "INVENTORIED" || inv2.code !== "INVENTORIED") process.exit(3);
exactInventoryResult(inv1, 0, "empty inventory one");
exactInventoryResult(inv2, 0, "empty inventory two");
check(inv1.sessions !== inv2.sessions && inv1 !== inv2, "inventory fresh");
const identity = Object.freeze({
	sessionId: "s1",
	activeSessionId: "a1",
	childId: "c1",
	name: "child",
	modelSelector: "model",
	durableParentSessionId: "p1",
	rlmParentNodeId: "n1",
	spawnedByRequestId: null,
	thinkingLevel: "medium",
	serviceTier: null,
	spawnContextDigest: "11".repeat(32),
	depth: 1,
});
const digests = Object.freeze({
	releaseDigest: new Uint8Array(32).fill(1),
	manifestDigest: new Uint8Array(32).fill(2),
	bootstrapDigest: new Uint8Array(32).fill(3),
	trustDigest: new Uint8Array(32).fill(4),
	runtimeConfigDigest: new Uint8Array(32).fill(5),
});
function changedIdentity(key: string, value: unknown): object {
	const candidate = Object.assign({}, identity);
	Reflect.set(candidate, key, value);
	return Object.freeze(candidate);
}
function omitIdentity(key: string): object {
	const candidate: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(identity)) if (name !== key) candidate[name] = identity[name];
	return Object.freeze(candidate);
}
function changedDigests(key: string, value: unknown): object {
	const candidate = Object.assign({}, digests);
	Reflect.set(candidate, key, value);
	return Object.freeze(candidate);
}
function omitDigests(key: string): object {
	const candidate: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(digests)) if (name !== key) candidate[name] = digests[name];
	return Object.freeze(candidate);
}
function exactFailed(value: object, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype, label + " prototype");
	check(Object.getOwnPropertyNames(value).join(",") === "code", label + " names");
	check(Object.getOwnPropertySymbols(value).length === 0, label + " symbols");
	check(Object.isFrozen(value), label + " frozen");
	const descriptor = Object.getOwnPropertyDescriptor(value, "code");
	check(descriptor?.value === "FAILED" && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor");
}
function exactOne(value: object, code: string, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " exact ordinary");
	check(Object.getOwnPropertyNames(value).join(",") === "code" && Object.getOwnPropertySymbols(value).length === 0, label + " names");
	const descriptor = Object.getOwnPropertyDescriptor(value, "code");
	check(descriptor?.value === code && descriptor.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " code descriptor");
}
function exactTwo(value: object, names: string, label: string): void {
	check(Object.getPrototypeOf(value) === Object.prototype && !utilTypes.isProxy(value) && Object.isFrozen(value), label + " exact ordinary");
	check(Object.getOwnPropertyNames(value).join(",") === names && Object.getOwnPropertySymbols(value).length === 0, label + " names");
	for (const name of names.split(",")) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		check(descriptor?.enumerable === true && descriptor.writable === false && descriptor.configurable === false && descriptor.get === undefined && descriptor.set === undefined, label + " descriptor " + name);
	}
}
function tree(path: string): string {
	const rows: string[] = [];
	function visit(current: string, relative: string): void {
		for (const name of readdirSync(current).sort()) {
			const full = current + "/" + name;
			const child = relative + "/" + name;
			const stat = lstatSync(full);
			if (stat.isDirectory()) {
				rows.push("d:" + child + ":" + stat.mode + ":" + stat.uid + ":" + stat.gid + ":" + stat.nlink);
				visit(full, child);
			} else if (stat.isFile()) {
				rows.push("f:" + child + ":" + stat.mode + ":" + stat.uid + ":" + stat.gid + ":" + stat.nlink + ":" + createHash("sha256").update(readFileSync(full)).digest("hex"));
			} else rows.push("x:" + child + ":" + stat.mode);
		}
	}
	visit(path, "");
	return rows.join("\\n");
}
const identityNames = Object.getOwnPropertyNames(identity);
const wrongIdentityOrder = Object.freeze({ activeSessionId: identity.activeSessionId, sessionId: identity.sessionId, childId: identity.childId, name: identity.name, modelSelector: identity.modelSelector, durableParentSessionId: identity.durableParentSessionId, rlmParentNodeId: identity.rlmParentNodeId, spawnedByRequestId: identity.spawnedByRequestId, thinkingLevel: identity.thinkingLevel, serviceTier: identity.serviceTier, spawnContextDigest: identity.spawnContextDigest, depth: identity.depth });
const nullIdentity = Object.create(null);
for (const name of identityNames) Object.defineProperty(nullIdentity, name, { value: identity[name], enumerable: true, writable: false, configurable: false });
Object.freeze(nullIdentity);
const inheritedIdentity = Object.create(identity);
Object.freeze(inheritedIdentity);
const identityWithExtra = Object.assign({}, identity, { extra: true });
const identityWithSymbol = Object.assign({}, identity);
Reflect.set(identityWithSymbol, Symbol("extra"), true);
const identityWithAccessor = Object.assign({}, identity);
Object.defineProperty(identityWithAccessor, "sessionId", { get: () => "s1", enumerable: true });
const invalidIdentities: unknown[] = [
	undefined, null, false, 0, "", Symbol("identity"), Object.freeze({}), Object.assign({}, identity), wrongIdentityOrder,
	...identityNames.map(omitIdentity), Object.freeze(identityWithExtra), Object.freeze(identityWithSymbol), Object.freeze(identityWithAccessor),
	nullIdentity, inheritedIdentity, new Proxy(identity, {}), new Proxy(identity, { ownKeys() { throw new Error("trap"); } }),
];
for (const key of ["sessionId", "activeSessionId", "childId", "durableParentSessionId", "rlmParentNodeId"])
	for (const value of ["", "x".repeat(1_025), "x\\n", "é", 1, null]) invalidIdentities.push(changedIdentity(key, value));
for (const value of ["", "x".repeat(2_049), "x\\u0001", "\\ud800", 1, null]) invalidIdentities.push(changedIdentity("name", value));
for (const value of ["", "x".repeat(4_097), "x\\u0001", "\\ud800", 1, null]) invalidIdentities.push(changedIdentity("modelSelector", value));
for (const value of ["", "x".repeat(1_025), "x\\n", "é", 1, false]) invalidIdentities.push(changedIdentity("spawnedByRequestId", value));
for (const value of ["", "extreme", null, 1, false]) invalidIdentities.push(changedIdentity("thinkingLevel", value));
for (const value of ["", "invalid", 1, false, undefined]) invalidIdentities.push(changedIdentity("serviceTier", value));
for (const value of ["", "0".repeat(63), "0".repeat(65), "AA".repeat(32), "g".repeat(64), 1, null]) invalidIdentities.push(changedIdentity("spawnContextDigest", value));
for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY, "1", null]) invalidIdentities.push(changedIdentity("depth", value));

const digestNames = Object.getOwnPropertyNames(digests);
const wrongDigestOrder = Object.freeze({ manifestDigest: digests.manifestDigest, releaseDigest: digests.releaseDigest, bootstrapDigest: digests.bootstrapDigest, trustDigest: digests.trustDigest, runtimeConfigDigest: digests.runtimeConfigDigest });
const nullDigests = Object.create(null);
for (const name of digestNames) Object.defineProperty(nullDigests, name, { value: digests[name], enumerable: true, writable: false, configurable: false });
Object.freeze(nullDigests);
const inheritedDigests = Object.create(digests);
Object.freeze(inheritedDigests);
const digestsWithExtra = Object.assign({}, digests, { extra: new Uint8Array(32) });
const digestsWithSymbol = Object.assign({}, digests);
Reflect.set(digestsWithSymbol, Symbol("extra"), true);
const digestsWithAccessor = Object.assign({}, digests);
Object.defineProperty(digestsWithAccessor, "releaseDigest", { get: () => new Uint8Array(32), enumerable: true });
class DigestSubclass extends Uint8Array {}
const offsetBuffer = new ArrayBuffer(33);
const resizableBuffer = new ArrayBuffer(32, { maxByteLength: 64 });
check(resizableBuffer.resizable, "authoritative resizable buffer support");
const detachedBuffer = new ArrayBuffer(32);
const detachedView = new Uint8Array(detachedBuffer);
structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
const extraView = new Uint8Array(32);
Reflect.set(extraView, "extra", true);
const invalidDigests: unknown[] = [
	undefined, null, false, 0, "", Object.assign({}, digests), wrongDigestOrder, ...digestNames.map(omitDigests),
	Object.freeze(digestsWithExtra), Object.freeze(digestsWithSymbol), Object.freeze(digestsWithAccessor), nullDigests,
	inheritedDigests, new Proxy(digests, {}), new Proxy(digests, { ownKeys() { throw new Error("trap"); } }),
];
for (const key of digestNames) {
	invalidDigests.push(changedDigests(key, new Uint8Array(31)));
	invalidDigests.push(changedDigests(key, new Uint8Array(33)));
	invalidDigests.push(changedDigests(key, "not-bytes"));
}
for (const value of [
	new DigestSubclass(32), new Proxy(new Uint8Array(32), {}), new Uint8Array(resizableBuffer), detachedView,
	new Uint8Array(offsetBuffer, 1, 32), Buffer.alloc(32), new Uint8Array(new SharedArrayBuffer(32)), extraView,
	new DataView(new ArrayBuffer(32)), {}, null,
]) invalidDigests.push(changedDigests("releaseDigest", value));

const validationIdentity = Object.freeze(Object.assign({}, identity, { sessionId: "validation-s", activeSessionId: "validation-a", childId: "validation-c" }));
let validationSession: object | undefined;
async function invalidThenValid(identityRaw: unknown, digestsRaw: unknown, label: string): Promise<void> {
	const root = "/root/.prime/agent/sandbox-session-state-v1";
	const beforeTree = tree(root);
	const beforeEffects = JSON.stringify(registryEffects);
	const beforeInventory = await store.inventory();
	check(beforeInventory.code === "INVENTORIED", label + " inventory before");
	const failure = await store.allocate(identityRaw, digestsRaw);
	exactFailed(failure, label);
	const afterInventory = await store.inventory();
	check(afterInventory.code === "INVENTORIED", label + " inventory after");
	if (beforeInventory.code !== "INVENTORIED" || afterInventory.code !== "INVENTORIED") process.exit(30);
	check(afterInventory.sessions.length === beforeInventory.sessions.length, label + " map length");
	for (let index = 0; index < beforeInventory.sessions.length; index += 1)
		check(afterInventory.sessions[index] === beforeInventory.sessions[index], label + " map refs " + index);
	check(tree(root) === beforeTree, label + " helper/filesystem zero effect");
	check(JSON.stringify(registryEffects) === beforeEffects, label + " registry zero effect");
	const accepted = await store.allocate(validationIdentity, digests);
	check(accepted.code === (validationSession === undefined ? "ALLOCATED" : "EXISTS"), label + " same Store reusable valid allocation");
	if (accepted.code === "ALLOCATED" || accepted.code === "EXISTS") {
		if (validationSession === undefined) validationSession = accepted.session;
		else check(accepted.session === validationSession, label + " valid retained capability");
	}
}
for (let index = 0; index < invalidIdentities.length; index += 1)
	await invalidThenValid(invalidIdentities[index], digests, "invalid identity " + index);
for (let index = 0; index < invalidDigests.length; index += 1)
	await invalidThenValid(identity, invalidDigests[index], "invalid digests " + index);
milestone("invalid-matrix");
const afterInvalid = await store.inventory();
check(afterInvalid.code === "INVENTORIED" && afterInvalid.sessions.length === 1, "invalid allocation exact map effects");
if (afterInvalid.code !== "INVENTORIED") process.exit(31);
exactInventoryResult(afterInvalid, 1, "populated inventory");
const copiedInventory = await store.inventory();
check(copiedInventory.code === "INVENTORIED", "populated copied inventory");
if (copiedInventory.code !== "INVENTORIED") process.exit(32);
check(copiedInventory !== afterInvalid && copiedInventory.sessions !== afterInvalid.sessions, "populated fresh copies");
for (let index = 0; index < afterInvalid.sessions.length; index += 1)
	check(copiedInventory.sessions[index] === afterInvalid.sessions[index], "populated retained opaque reference " + index);
check(validationSession !== undefined, "validation capability retained");
if (validationSession === undefined) process.exit(33);
check((await store.createDispatched(validationSession)).code === "COMMITTED", "validation cleanup create");
check((await store.present(validationSession)).code === "COMMITTED", "validation cleanup present");
check((await store.runtimeDispatched(validationSession)).code === "COMMITTED", "validation cleanup runtime");
check((await store.running(validationSession)).code === "COMMITTED", "validation cleanup running");
const validationTerminal = Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" });
check((await store.deleteDispatched(validationSession, validationTerminal)).code === "COMMITTED", "validation cleanup delete");
check((await store.absent(validationSession)).code === "COMMITTED", "validation cleanup absent");
check((await store.purge(validationSession)).code === "COMMITTED", "validation cleanup purge");
const allocationPromise = store.allocate(identity, digests);
check(allocationPromise instanceof Promise && Object.getPrototypeOf(allocationPromise) === Promise.prototype, "allocate owned native Promise");
const allocated = await allocationPromise;
check(allocated.code === "ALLOCATED", "allocate");
if (allocated.code !== "ALLOCATED") process.exit(4);
exactTwo(allocated, "code,session", "allocate result");
const session = allocated.session;
const exists = await store.allocate(identity, digests);
check(exists.code === "EXISTS" && exists.session === session, "exists");
exactTwo(exists, "code,session", "exists result");
const unknown = Object.freeze({});
for (const [label, result] of [
	["state", await store.state(unknown)],
	["create", await store.createDispatched(unknown)],
	["present", await store.present(unknown)],
	["runtime", await store.runtimeDispatched(unknown)],
	["running", await store.running(unknown)],
	["delete", await store.deleteDispatched(unknown, Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }))],
	["uncertain", await store.cleanupUncertain(unknown)],
	["absent", await store.absent(unknown)],
	["retire", await store.retireAndAdvance(unknown)],
	["purge", await store.purge(unknown)],
] as const) exactOne(result, "INVALID", "unknown " + label);
exactOne(await store.present(session), "STALE", "present before create");
exactOne(await store.runtimeDispatched(session), "STALE", "runtime before present");
exactOne(await store.running(session), "STALE", "running before runtime");
exactOne(await store.cleanupUncertain(session), "STALE", "uncertain before delete");
exactOne(await store.absent(session), "STALE", "absent before delete");
exactOne(await store.retireAndAdvance(session), "STALE", "retire before create");
exactOne(await store.purge(session), "STALE", "purge before absent");
const stateAllocated = await store.state(session);
exactTwo(stateAllocated, "code,state", "state allocated");
check(stateAllocated.code === "STATE" && stateAllocated.state === "ALLOCATED", "state allocated value");
const createResult = await store.createDispatched(session);
exactOne(createResult, "COMMITTED", "create");
exactOne(await store.createDispatched(session), "STALE", "create repeated");
exactOne(await store.present(session), "COMMITTED", "present");
exactOne(await store.present(session), "STALE", "present repeated");
exactOne(await store.runtimeDispatched(session), "COMMITTED", "runtime");
exactOne(await store.runtimeDispatched(session), "STALE", "runtime repeated");
exactOne(await store.running(session), "COMMITTED", "running");
exactOne(await store.running(session), "STALE", "running repeated");
const terminalInvalids: unknown[] = [
	undefined, null, {}, Object.freeze({ terminalStatus: "completed" }), Object.freeze({ terminalCode: "SUCCESS" }),
	Object.freeze({ terminalCode: "SUCCESS", terminalStatus: "completed" }),
	Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS", extra: true }),
	Object.freeze({ terminalStatus: "done", terminalCode: "SUCCESS" }),
	Object.freeze({ terminalStatus: "completed", terminalCode: "OK" }),
	new Proxy(Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" }), {}),
];
for (let index = 0; index < terminalInvalids.length; index += 1)
	exactOne(await store.deleteDispatched(session, terminalInvalids[index]), "INVALID", "terminal invalid " + index);
const terminal = Object.freeze({ terminalStatus: "completed", terminalCode: "SUCCESS" });
exactOne(await store.deleteDispatched(session, terminal), "COMMITTED", "delete");
exactOne(await store.deleteDispatched(session, terminal), "STALE", "delete repeated");
exactOne(await store.cleanupUncertain(session), "COMMITTED", "uncertain");
exactOne(await store.cleanupUncertain(session), "STALE", "uncertain repeated");
exactOne(await store.absent(session), "COMMITTED", "absent");
exactOne(await store.absent(session), "STALE", "absent repeated");
const finalState = await store.state(session);
exactTwo(finalState, "code,state", "state absent");
check(finalState.code === "STATE" && finalState.state === "ABSENT", "state absent value");
exactOne(await store.purge(session), "COMMITTED", "purge");
exactOne(await store.state(session), "INVALID", "purged invalid");
exactOne(await store.purge(session), "INVALID", "purge repeated");
const inv3 = await store.inventory();
check(inv3.code === "INVENTORIED" && inv3.sessions.length === 0, "inventory purged");
milestone("method-matrix");
const identity2 = Object.freeze({
	sessionId: "s2",
	activeSessionId: "a2",
	childId: "c2",
	name: "child-two",
	modelSelector: "model",
	durableParentSessionId: "p1",
	rlmParentNodeId: "n1",
	spawnedByRequestId: "request-2",
	thinkingLevel: "high",
	serviceTier: "priority",
	spawnContextDigest: "22".repeat(32),
	depth: 2,
});
const allocated2 = await store.allocate(identity2, digests);
check(allocated2.code === "ALLOCATED", "allocate rollover");
if (allocated2.code !== "ALLOCATED") process.exit(5);
const session2 = allocated2.session;
check((await store.createDispatched(session2)).code === "COMMITTED", "rollover create");
exactOne(await store.retireAndAdvance(session2), "COMMITTED", "rollover retire");
const afterRollover = await store.state(session2);
check(afterRollover.code === "STATE" && afterRollover.state === "ALLOCATED", "rollover state");
exactTwo(afterRollover, "code,state", "rollover state result");
exactOne(await store.retireAndAdvance(session2), "STALE", "rollover repeated");
const closing1 = store.close();
const closing2 = store.close();
check(closing1 instanceof Promise && Object.getPrototypeOf(closing1) === Promise.prototype, "close owned native Promise");
check(closing1 === closing2, "close cached");
const afterCloseAdmission = [
	store.inventory(), store.allocate(identity, digests), store.state(session2), store.createDispatched(session2), store.present(session2),
	store.runtimeDispatched(session2), store.running(session2), store.deleteDispatched(session2, terminal), store.cleanupUncertain(session2),
	store.absent(session2), store.retireAndAdvance(session2), store.purge(session2),
];
for (let index = 0; index < afterCloseAdmission.length; index += 1)
	exactOne(await afterCloseAdmission[index], "FAILED", "post-close admission " + index);
const closed = await closing1;
exactOne(closed, "CLOSED", "closed");
check(await store.close() === closed, "close cached result identity");
const ready2 = await createHostedSessionStore(registry);
check(ready2.code === "READY", "restart ready");
if (ready2.code !== "READY") process.exit(6);
const store2 = ready2.store;
const restarted = await store2.inventory();
check(restarted.code === "INVENTORIED" && restarted.sessions.length === 1, "restart inventory");
if (restarted.code !== "INVENTORIED") process.exit(7);
const restartedSession = restarted.sessions[0];
const restartState = await store2.state(restartedSession);
check(restartState.code === "STATE" && restartState.state === "ALLOCATED", "restart state");
check((await store2.createDispatched(restartedSession)).code === "COMMITTED", "restart create");
check((await store2.present(restartedSession)).code === "COMMITTED", "restart present");
check((await store2.runtimeDispatched(restartedSession)).code === "COMMITTED", "restart runtime");
check((await store2.running(restartedSession)).code === "COMMITTED", "restart running");
check((await store2.deleteDispatched(restartedSession, terminal)).code === "COMMITTED", "restart delete");
check((await store2.absent(restartedSession)).code === "COMMITTED", "restart absent");
check((await store2.purge(restartedSession)).code === "COMMITTED", "restart purge");
check((await store2.close()).code === "CLOSED", "restart close");
const ready3 = await createHostedSessionStore(registry);
check(ready3.code === "READY", "poison factory");
if (ready3.code !== "READY") process.exit(8);
const store3 = ready3.store;
check((await store3.inventory()).code === "INVENTORIED", "poison inventory");
const poisonAllocation = await store3.allocate(identity2, digests);
check(poisonAllocation.code === "ALLOCATED", "poison allocate");
if (poisonAllocation.code !== "ALLOCATED") process.exit(9);
forceInvalidReplace = true;
exactOne(await store3.createDispatched(poisonAllocation.session), "FAILED", "post-durable CAS poison");
for (const [label, poisoned] of [
	["inventory", store3.inventory()], ["allocate", store3.allocate(identity, digests)], ["state", store3.state(poisonAllocation.session)],
	["create", store3.createDispatched(poisonAllocation.session)], ["present", store3.present(poisonAllocation.session)],
	["runtime", store3.runtimeDispatched(poisonAllocation.session)], ["running", store3.running(poisonAllocation.session)],
	["delete", store3.deleteDispatched(poisonAllocation.session, terminal)], ["uncertain", store3.cleanupUncertain(poisonAllocation.session)],
	["absent", store3.absent(poisonAllocation.session)], ["retire", store3.retireAndAdvance(poisonAllocation.session)],
	["purge", store3.purge(poisonAllocation.session)],
] as const) exactOne(await poisoned, "FAILED", "poisoned reuse " + label);
const poisonClose1 = store3.close();
const poisonClose2 = store3.close();
check(poisonClose1 === poisonClose2, "poison close cached");
const poisonClosed = await poisonClose1;
exactOne(poisonClosed, "FAILED", "poison close result");
check(await store3.close() === poisonClosed, "poison close result cached identity");
const ready4 = await createHostedSessionStore(registry);
check(ready4.code === "READY", "poison recovery factory");
if (ready4.code !== "READY") process.exit(10);
const store4 = ready4.store;
const recovered = await store4.inventory();
check(recovered.code === "INVENTORIED" && recovered.sessions.length === 1, "post-CAS recovery inventory");
if (recovered.code !== "INVENTORIED") process.exit(11);
const recoveredSession = recovered.sessions[0];
const recoveredState = await store4.state(recoveredSession);
check(recoveredState.code === "STATE" && recoveredState.state === "CREATE_DISPATCHED", "post-CAS recovery state");
check((await store4.present(recoveredSession)).code === "COMMITTED", "recovery present");
check((await store4.runtimeDispatched(recoveredSession)).code === "COMMITTED", "recovery runtime");
check((await store4.running(recoveredSession)).code === "COMMITTED", "recovery running");
check((await store4.deleteDispatched(recoveredSession, terminal)).code === "COMMITTED", "recovery delete");
check((await store4.absent(recoveredSession)).code === "COMMITTED", "recovery absent");
check((await store4.purge(recoveredSession)).code === "COMMITTED", "recovery purge");
check((await store4.close()).code === "CLOSED", "recovery close");
const ready5 = await createHostedSessionStore(registry);
check(ready5.code === "READY", "rollover lag factory");
if (ready5.code !== "READY") process.exit(12);
const store5 = ready5.store;
check((await store5.inventory()).code === "INVENTORIED", "rollover lag inventory");
const lagAllocation = await store5.allocate(identity, digests);
check(lagAllocation.code === "ALLOCATED", "rollover lag allocate");
if (lagAllocation.code !== "ALLOCATED") process.exit(13);
const lagSession = lagAllocation.session;
check((await store5.createDispatched(lagSession)).code === "COMMITTED", "rollover lag create");
forceInvalidReplace = true;
check((await store5.retireAndAdvance(lagSession)).code === "FAILED", "retired-head CAS poison");
check((await store5.close()).code === "FAILED", "retired-head poisoned close");
const ready6 = await createHostedSessionStore(registry);
check(ready6.code === "READY", "retired-head recovery factory");
if (ready6.code !== "READY") process.exit(14);
const store6 = ready6.store;
const rolloverRecovered = await store6.inventory();
check(rolloverRecovered.code === "INVENTORIED" && rolloverRecovered.sessions.length === 1, "retired-head recovery inventory");
if (rolloverRecovered.code !== "INVENTORIED") process.exit(15);
const rolloverSession = rolloverRecovered.sessions[0];
const rolloverRecoveredState = await store6.state(rolloverSession);
check(rolloverRecoveredState.code === "STATE" && rolloverRecoveredState.state === "ALLOCATED", "retired-head recovery state");
check((await store6.createDispatched(rolloverSession)).code === "COMMITTED", "retired-head recovery create");
check((await store6.present(rolloverSession)).code === "COMMITTED", "retired-head recovery present");
check((await store6.runtimeDispatched(rolloverSession)).code === "COMMITTED", "retired-head recovery runtime");
check((await store6.running(rolloverSession)).code === "COMMITTED", "retired-head recovery running");
check((await store6.deleteDispatched(rolloverSession, terminal)).code === "COMMITTED", "retired-head recovery delete");
check((await store6.absent(rolloverSession)).code === "COMMITTED", "retired-head recovery absent");
check((await store6.purge(rolloverSession)).code === "COMMITTED", "retired-head recovery purge");
check((await store6.close()).code === "CLOSED", "retired-head recovery close");
milestone("existing-recovery");
const roguePath = "/root/.prime/agent/sandbox-session-state-v1/rogue";
writeFileSync(roguePath, "hostile");
check((await createHostedSessionStore(registry)).code === "FAILED", "hostile filesystem rejected");
unlinkSync(roguePath);
const ready7 = await createHostedSessionStore(registry);
check(ready7.code === "READY", "post-hostile factory");
if (ready7.code !== "READY") process.exit(16);
const store7 = ready7.store;
check((await store7.inventory()).code === "INVENTORIED", "post-hostile inventory");
const fixedRoot = "/root/.prime/agent/sandbox-session-state-v1";
const snapshotRoot = "/tmp/store-v22-snapshots";
rmSync(snapshotRoot, { recursive: true, force: true });
mkdirSync(snapshotRoot, { mode: 0o700 });
function snapshot(name: string): void {
	const destination = snapshotRoot + "/" + name;
	rmSync(destination, { recursive: true, force: true });
	cpSync(fixedRoot, destination, { recursive: true, preserveTimestamps: true });
}
function restore(name: string): void {
	rmSync(fixedRoot, { recursive: true, force: true });
	cpSync(snapshotRoot + "/" + name, fixedRoot, { recursive: true, preserveTimestamps: true });
}
function lifecycleDirectory(base: string): string {
	const names = readdirSync(base).filter((name) => /^[0-9a-f]{64}$/.test(name));
	check(names.length === 1, "one lifecycle in " + base);
	return base + "/" + names[0];
}
function ledgerDirectory(base: string): string {
	return lifecycleDirectory(base) + "/ledger";
}
function walDirectory(base: string): string {
	const lifecycle = lifecycleDirectory(base);
	const generations = readdirSync(lifecycle + "/generations").filter((name) => /^[0-9a-f]{64}$/.test(name));
	check(generations.length === 1, "one generation in " + base);
	return lifecycle + "/generations/" + generations[0] + "/wal";
}
function mix(name: string, durableName: string, ledgerName: string): void {
	const destination = snapshotRoot + "/" + name;
	rmSync(destination, { recursive: true, force: true });
	cpSync(snapshotRoot + "/" + durableName, destination, { recursive: true, preserveTimestamps: true });
	const ledger = ledgerDirectory(destination);
	rmSync(ledger, { recursive: true, force: true });
	cpSync(ledgerDirectory(snapshotRoot + "/" + ledgerName), ledger, { recursive: true, preserveTimestamps: true });
}
function truncateLastLedger(name: string): void {
	const ledger = ledgerDirectory(snapshotRoot + "/" + name);
	const records = readdirSync(ledger).filter((entry) => entry.endsWith(".rec")).sort();
	check(records.length >= 2, "truncate ledger input");
	unlinkSync(ledger + "/" + records.pop());
	const last = records[records.length - 1];
	const head = Buffer.alloc(48);
	head.write("PILEDHD1", 0, "ascii");
	head.writeBigUInt64BE(BigInt("0x" + last.slice(0, 16)), 8);
	Buffer.from(last.slice(17, 81), "hex").copy(head, 16);
	writeFileSync(ledger + "/head", head, { mode: 0o600 });
}
const recoveryIdentity = Object.freeze(Object.assign({}, identity, { sessionId: "recovery-s", activeSessionId: "recovery-a", childId: "recovery-c" }));
const recoveryAllocation = await store7.allocate(recoveryIdentity, digests);
check(recoveryAllocation.code === "ALLOCATED", "recovery seed allocate");
if (recoveryAllocation.code !== "ALLOCATED") process.exit(40);
const recoverySession = recoveryAllocation.session;
snapshot("allocated");
exactOne(await store7.createDispatched(recoverySession), "COMMITTED", "recovery seed create"); snapshot("create");
exactOne(await store7.present(recoverySession), "COMMITTED", "recovery seed present"); snapshot("present");
exactOne(await store7.runtimeDispatched(recoverySession), "COMMITTED", "recovery seed runtime"); snapshot("runtime");
exactOne(await store7.running(recoverySession), "COMMITTED", "recovery seed running"); snapshot("running");
exactOne(await store7.deleteDispatched(recoverySession, terminal), "COMMITTED", "recovery seed delete"); snapshot("delete");
exactOne(await store7.cleanupUncertain(recoverySession), "COMMITTED", "recovery seed cleanup"); snapshot("cleanup");
exactOne(await store7.absent(recoverySession), "COMMITTED", "recovery seed absent cleanup"); snapshot("absent-cleanup");
exactOne(await store7.close(), "CLOSED", "recovery seed close");

restore("delete");
const directFactory = await createHostedSessionStore(registry);
check(directFactory.code === "READY", "direct absent factory");
if (directFactory.code !== "READY") process.exit(41);
const directInventory = await directFactory.store.inventory();
check(directInventory.code === "INVENTORIED" && directInventory.sessions.length === 1, "direct absent inventory");
if (directInventory.code !== "INVENTORIED") process.exit(42);
exactOne(await directFactory.store.absent(directInventory.sessions[0]), "COMMITTED", "direct absent");
snapshot("absent-direct");
exactOne(await directFactory.store.close(), "CLOSED", "direct absent close");

cpSync(snapshotRoot + "/delete", snapshotRoot + "/delete-terminal", { recursive: true, preserveTimestamps: true });
truncateLastLedger("delete-terminal");
milestone("recovery-seed");
mix("create-lag-1", "create", "allocated");
mix("present-lag-1", "present", "create");
mix("runtime-lag-1", "runtime", "present");
mix("running-lag-1", "running", "runtime");
mix("delete-lag-2", "delete", "running");
mix("delete-lag-1", "delete", "delete-terminal");
mix("absent-normal-lag-1", "absent-direct", "delete");
mix("absent-cleanup-lag-2", "absent-cleanup", "cleanup");
mix("absent-cleanup-lag-1", "absent-cleanup", "delete");
async function verifySnapshot(name: string, expectedState: string): Promise<void> {
	restore(name);
	const factory = await createHostedSessionStore(registry);
	check(factory.code === "READY", name + " factory");
	if (factory.code !== "READY") process.exit(43);
	const inventory = await factory.store.inventory();
	check(inventory.code === "INVENTORIED" && inventory.sessions.length === 1, name + " inventory");
	if (inventory.code !== "INVENTORIED") process.exit(44);
	const recoveredState = await factory.store.state(inventory.sessions[0]);
	check(recoveredState.code === "STATE" && recoveredState.state === expectedState, name + " repaired state");
	exactOne(await factory.store.close(), "CLOSED", name + " close");
}
for (const [name, state] of [
	["create-lag-1", "CREATE_DISPATCHED"], ["present-lag-1", "PRESENT"], ["runtime-lag-1", "RUNTIME_DISPATCHED"],
	["running-lag-1", "RUNNING"], ["delete-lag-2", "DELETE_DISPATCHED"], ["delete-lag-1", "DELETE_DISPATCHED"],
	["absent-normal-lag-1", "ABSENT"], ["absent-cleanup-lag-2", "ABSENT"], ["absent-cleanup-lag-1", "ABSENT"],
] as const) await verifySnapshot(name, state);
milestone("lag-matrix");

restore("running");
const otherTerminalFactory = await createHostedSessionStore(registry);
check(otherTerminalFactory.code === "READY", "other terminal factory");
if (otherTerminalFactory.code !== "READY") process.exit(45);
const otherTerminalInventory = await otherTerminalFactory.store.inventory();
check(otherTerminalInventory.code === "INVENTORIED", "other terminal inventory");
if (otherTerminalInventory.code !== "INVENTORIED") process.exit(46);
exactOne(await otherTerminalFactory.store.deleteDispatched(otherTerminalInventory.sessions[0], Object.freeze({ terminalStatus: "error", terminalCode: "FAILURE" })), "COMMITTED", "other terminal delete");
snapshot("delete-other-terminal");
exactOne(await otherTerminalFactory.store.close(), "CLOSED", "other terminal close");

mix("forbidden-ledger-lead", "create", "present");
mix("forbidden-excess-lag", "running", "allocated");
mix("forbidden-terminal-disagreement", "delete", "delete-other-terminal");
cpSync(snapshotRoot + "/running", snapshotRoot + "/forbidden-head-contradiction", { recursive: true, preserveTimestamps: true });
const contradictionHead = lifecycleDirectory(snapshotRoot + "/forbidden-head-contradiction") + "/head";
const contradictionBytes = readFileSync(contradictionHead);
contradictionBytes[8] ^= 0xff;
writeFileSync(contradictionHead, contradictionBytes, { mode: 0o600 });
async function expectInventoryFailure(name: string): Promise<void> {
	restore(name);
	const factory = await createHostedSessionStore(registry);
	if (factory.code === "FAILED") {
		exactOne(factory, "FAILED", name + " factory failure");
		return;
	}
	exactOne(await factory.store.inventory(), "FAILED", name + " inventory failure");
	exactOne(await factory.store.close(), "FAILED", name + " failed close");
}
for (const name of ["forbidden-ledger-lead", "forbidden-excess-lag", "forbidden-terminal-disagreement", "forbidden-head-contradiction"])
	await expectInventoryFailure(name);
milestone("forbidden-matrix");

cpSync(snapshotRoot + "/absent-direct", snapshotRoot + "/interrupted-purge", { recursive: true, preserveTimestamps: true });
for (const directory of [ledgerDirectory(snapshotRoot + "/interrupted-purge"), walDirectory(snapshotRoot + "/interrupted-purge")]) {
	const suffix = directory.endsWith("/ledger") ? ".rec" : ".wal";
	const records = readdirSync(directory).filter((entry) => entry.endsWith(suffix)).sort();
	for (let index = 0; index + 1 < records.length; index += 1) unlinkSync(directory + "/" + records[index]);
}
restore("interrupted-purge");
const purgeRecoveryFactory = await createHostedSessionStore(registry);
check(purgeRecoveryFactory.code === "READY", "interrupted purge factory");
if (purgeRecoveryFactory.code !== "READY") process.exit(47);
const purgeRecoveryInventory = await purgeRecoveryFactory.store.inventory();
check(purgeRecoveryInventory.code === "INVENTORIED" && purgeRecoveryInventory.sessions.length === 0, "interrupted purge completed");
exactOne(await purgeRecoveryFactory.store.close(), "CLOSED", "interrupted purge close");

async function expectHostileLock(label: string, mutate: (lock: string) => void): Promise<void> {
	restore("allocated");
	const lock = fixedRoot + "/.lock";
	mutate(lock);
	const result = await createHostedSessionStore(registry);
	exactOne(result, "FAILED", "hostile lock " + label);
}
await expectHostileLock("mode", (lock) => chmodSync(lock, 0o644));
await expectHostileLock("owner", (lock) => chownSync(lock, 65534, 65534));
await expectHostileLock("link", (lock) => { const other = "/tmp/hostile-lock-link"; rmSync(other, { force: true }); linkSync(lock, other); });
await expectHostileLock("type", (lock) => { unlinkSync(lock); mkdirSync(lock, { mode: 0o600 }); });
rmSync(fixedRoot, { recursive: true, force: true });
const invalidStartupRegistries: unknown[] = [undefined, null, false, 0, "", Object.freeze({}), Object.freeze([]), new Proxy(registry, {})];
for (let index = 0; index < invalidStartupRegistries.length; index += 1)
	exactFailed(await createStartupV5HostedSessionStore(invalidStartupRegistries[index]), "V5 invalid registry " + index);

const startupReady = await createStartupV5HostedSessionStore(registry);
check(startupReady.code === "READY", "V5 startup ready");
if (startupReady.code !== "READY") process.exit(49);
check(Object.getPrototypeOf(startupReady) === Object.prototype && Object.isFrozen(startupReady), "V5 ready exact ordinary");
check(Object.getOwnPropertyNames(startupReady).join(",") === "code,store" && Object.getOwnPropertySymbols(startupReady).length === 0, "V5 ready keys");
const startupStore = startupReady.store;
check(Object.getPrototypeOf(startupStore) === Object.prototype && Object.isFrozen(startupStore), "V5 store exact ordinary");
check(Object.getOwnPropertyNames(startupStore).join(",") === "close" && Object.getOwnPropertySymbols(startupStore).length === 0, "V5 close-only authority");
const startupCloseDescriptor = Object.getOwnPropertyDescriptor(startupStore, "close");
check(typeof startupCloseDescriptor?.value === "function" && startupCloseDescriptor.enumerable === true && startupCloseDescriptor.writable === false && startupCloseDescriptor.configurable === false, "V5 close descriptor");
check(readdirSync(fixedRoot).join(",") === ".lock", "V5 startup creates no V5 names");
const startupCloseOne = startupStore.close();
const startupCloseTwo = startupStore.close();
check(startupCloseOne === startupCloseTwo && startupCloseOne instanceof Promise && Object.getPrototypeOf(startupCloseOne) === Promise.prototype, "V5 memoized native close Promise");
const startupClosedOne = await startupCloseOne;
const startupClosedTwo = await startupCloseTwo;
check(startupClosedOne === startupClosedTwo, "V5 memoized close result");
exactOne(startupClosedOne, "CLOSED", "V5 closed");
check(readdirSync(fixedRoot).join(",") === ".lock", "V5 close leaves exact lock-only root");
console.log("V5_STARTUP_FACTORY_OK");
rmSync(fixedRoot, { recursive: true, force: true });
milestone("hostile-and-purge");
console.log("INTEGRATION_OK");
`,
		);
		const v5MainWireProbePath = resolve(temporary, "v5-main-fatal-wire-probe.py");
		writeFileSync(
			v5MainWireProbePath,
			String.raw`import errno,hashlib,os,selectors,shutil,signal,struct,subprocess,time
HELPER="/app/src/modes/daemon/sandbox/hosted-session-store-posix-helper.py"
ROOT="/root/.prime/agent/sandbox-session-state-v1"
FAULT_PY="/tmp/v5wire-fault-python3"
FAULT_SCENARIO="/tmp/v5wire-fault-scenario"
CAP=1048576

def frame(opcode,payload=b""):
 return bytes((opcode,))+struct.pack(">I",len(payload))+payload

def parse(data):
 rows=[];offset=0
 while offset+5<=len(data):
  opcode=data[offset];size=struct.unpack_from(">I",data,offset+1)[0];end=offset+5+size
  if end>len(data):break
  rows.append((opcode,data[offset+5:end]));offset=end
 return rows

def frames_bytes(rows):
 return b"".join(bytes((opcode,))+struct.pack(">I",len(payload))+payload for opcode,payload in rows)

def absent(pgid):
 try:os.killpg(pgid,0)
 except OSError as failure:
  if failure.errno==errno.ESRCH:return True
  raise
 return False

OPEN=frame(0xFE);QUIT=frame(0xFF);HELLO=frame(0xF0,b"PISTOV05")
OK_OPEN=(0x80,b"\xfe");OK_QUIT=(0x80,b"\xff");READY=(0x84,b"\xf0PISTOV05");DONE=(0x82,b"")
def error(opcode,code):return (0xE0,bytes((opcode,code)))
def u64(value):return struct.pack(">Q",value)

lifecycle=bytes(range(32));generation=bytes(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
selector=bytes(lifecycle)+bytes(generation)+bytes(binding)+bytes(tx)
PLAN_LENGTH=17;CONTENT_LENGTH=23
plan_chunk=bytes(range(31,48));content_chunk=bytes(range(51,74));content_alt=bytes((7,))*23
evidence=ROOT+"/"+lifecycle.hex()+"/generations/"+generation.hex()+"/workspace-evidence"
genesis=bytes(range(64));identity_digest=hashlib.sha256(genesis).digest()
record=bytearray(320);record[:11]=b"PIHOSTWALV1";record[16]=1;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=bytes(32);record[128:160]=identity_digest
create_request=frame(0x02,bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record))
OK_CREATE=(0x80,bytes((0x02,))+hashlib.sha256(bytes(record)).digest())
begin=selector+plan_digest+struct.pack(">I",PLAN_LENGTH)+u64(CONTENT_LENGTH)
def write_request(kind,offset,data,digest=None):
 payload=bytearray(169+len(data));payload[:128]=selector;payload[128]=kind;struct.pack_into(">Q",payload,129,offset);payload[137:169]=hashlib.sha256(data).digest() if digest is None else digest;payload[169:]=data
 return frame(0x0B,bytes(payload))
def ok_write(kind,revision,end):return (0x80,bytes((0x0B,kind))+u64(revision)+u64(end))
OK_BEGIN=(0x80,bytes((0x0A,))+u64(0)+u64(0)+u64(0))
row=bytearray(401)
row[0:32]=lifecycle;row[32:64]=generation;row[64:96]=binding;row[96:128]=tx;row[128:160]=plan_digest
struct.pack_into(">I",row,160,PLAN_LENGTH);struct.pack_into(">Q",row,164,CONTENT_LENGTH)
struct.pack_into(">Q",row,180,PLAN_LENGTH);struct.pack_into(">Q",row,188,CONTENT_LENGTH)
struct.pack_into(">Q",row,204,2);row[216:224]=bytes((255,))*8;row[384:392]=bytes((255,))*8
struct.pack_into(">Q",row,392,1100000000);row[400]=1
INVENTORY_ROW=(0x83,bytes(row))
row0=bytearray(row)
struct.pack_into(">Q",row0,180,0);struct.pack_into(">Q",row0,188,0);struct.pack_into(">Q",row0,204,0)
INVENTORY_ROW0=(0x83,bytes(row0))
V4_INSPECT_BARRIER=error(0x09,0x01)
OVERSIZE_HEADER=bytes((0x0B,))+struct.pack(">I",0xFFFFFFFF)

def draft_path(prefix):
 names=[name for name in os.listdir(evidence) if name.startswith(prefix)]
 if len(names)!=1:raise RuntimeError("draft-name")
 return evidence+"/"+names[0]
def corrupt_manifest_field():
 data=bytearray(open(evidence+"/input.manifest","rb").read())
 struct.pack_into(">Q",data,260,99)
 handle=open(evidence+"/input.manifest","wb");handle.write(bytes(data));handle.close()
def append_manifest():
 handle=open(evidence+"/input.manifest","ab");handle.write(b"\x00");handle.close()
def chmod_draft():
 os.chmod(draft_path(".ws-plan."),0o644)
def duplicate_plan():
 shutil.copyfile(draft_path(".ws-plan."),evidence+"/.ws-plan."+("f"*64))
def unlink_lock():
 os.unlink(ROOT+"/.lock")
def chmod_lock():
 os.chmod(ROOT+"/.lock",0o644)
abort_mode_snapshot={}
def chmod_manifest():
 for name in os.listdir(evidence):
  with open(evidence+"/"+name,"rb") as handle:abort_mode_snapshot[name]=handle.read(1048576)
 os.chmod(evidence+"/input.manifest",0o644)
def chmod_manifest_restore():
 if sorted(os.listdir(evidence))!=sorted(abort_mode_snapshot):raise RuntimeError("abort mode names changed")
 for name,data in abort_mode_snapshot.items():
  with open(evidence+"/"+name,"rb") as handle:
   if handle.read(1048576)!=data:raise RuntimeError("abort mode bytes changed")
 os.chmod(evidence+"/input.manifest",0o600)
OK_ABORT=(0x80,bytes((0x0C,1)))
def abort_request(kind,revision):
 return frame(0x0C,selector+bytes((kind,))+u64(revision))

FAULT_SOURCE='''#!/usr/local/bin/python3
import errno,os,struct,sys
scenario=open("/tmp/v5wire-fault-scenario").read().strip()
state={"arm_stat":False,"arm_fsync":False,"arm_close":False}
frame_write_ok=struct.pack(">BI",0x80,18)+bytes((0x0B,1))+struct.pack(">Q",1)+struct.pack(">Q",17)
frame_begin_ok=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
frame_quit_ok=struct.pack(">BI",0x80,1)+bytes((0xFF,))
frame_abort_ok=struct.pack(">BI",0x80,2)+bytes((0x0C,1))
frame_done_empty=struct.pack(">BI",0x82,0)
real_write=os.write;real_stat=os.stat;real_fsync=os.fsync;real_close=os.close
real_unlink=os.unlink
def write(fd,data,*args,**kwargs):
 count=real_write(fd,data,*args,**kwargs)
 if fd==1 and count==len(data):
  if scenario=="post-emission-root" and bytes(data)==frame_write_ok:state["arm_stat"]=True
  elif scenario=="quit-fsync" and bytes(data)==frame_begin_ok:state["arm_fsync"]=True
  elif scenario=="quit-close" and bytes(data)==frame_quit_ok:state["arm_close"]=True
  elif scenario=="v4-post-emission" and bytes(data)==frame_done_empty:state["arm_stat"]=True
  elif scenario=="abort-post-emission" and bytes(data)==frame_abort_ok:state["arm_stat"]=True
 return count
def stat(path,*args,**kwargs):
 if state["arm_stat"] and path in (".lock",b".lock"):
  state["arm_stat"]=False
  raise OSError(errno.ENOENT,"injected")
 return real_stat(path,*args,**kwargs)
def fsync(fd,*args,**kwargs):
 if state["arm_fsync"]:
  state["arm_fsync"]=False
  raise OSError(errno.EIO,"injected")
 return real_fsync(fd,*args,**kwargs)
def close(fd,*args,**kwargs):
 if state["arm_close"]:
  state["arm_close"]=False
  raise OSError(errno.EIO,"injected")
 return real_close(fd,*args,**kwargs)
def unlink(*args,**kwargs):
 result=real_unlink(*args,**kwargs)
 if scenario=="abort-fsync":
  name=args[0] if args else kwargs.get("path")
  if isinstance(name,bytes) and name.startswith(b".ws-content."):state["arm_fsync"]=True
  elif isinstance(name,str) and name.startswith(".ws-content."):state["arm_fsync"]=True
 return result
os.write=write;os.stat=stat;os.fsync=fsync;os.close=close;os.unlink=unlink
source=open(sys.argv[1]).read()
exec(compile(source,sys.argv[1],"exec"))
'''

def install_fault_wrapper():
 handle=open(FAULT_PY,"w");handle.write(FAULT_SOURCE);handle.close()
 os.chmod(FAULT_PY,0o755)

def drain_round(sel,out,err):
 out_eof=False;err_eof=False
 for key,unused_mask in sel.select(0.05):
  try:chunk=os.read(key.fileobj.fileno(),65536)
  except BlockingIOError:continue
  if not chunk:
   sel.unregister(key.fileobj);key.fileobj.close()
   if key.data=="out":out_eof=True
   else:err_eof=True
   continue
  target=out if key.data=="out" else err
  if len(target)+len(chunk)>CAP:raise RuntimeError("output cap")
  target.extend(chunk)
 return out_eof,err_eof

def reap_bounded(p,sel,out,err,label,seconds):
 end=time.monotonic()+seconds
 while time.monotonic()<end:
  got_out_eof,got_err_eof=drain_round(sel,out,err)
  if p.poll() is not None and absent(p.pid):return True
 return p.poll() is not None and absent(p.pid)

def run(label,phases,returncode,root_names=None,fresh=True,fault=None):
 if fresh and os.path.exists(ROOT):shutil.rmtree(ROOT)
 if fault is not None:
  handle=open(FAULT_SCENARIO,"w");handle.write(fault);handle.close()
 fd=os.open(HELPER,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 if fd!=3:
  os.dup2(fd,3,inheritable=True);os.close(fd);fd=3
 if os.lseek(fd,0,os.SEEK_CUR)!=0:raise RuntimeError(label+" helper offset")
 p=None;sel=None;out=bytearray();err=bytearray();stdin_closed=False;out_eof=False;err_eof=False
 expected_all=[]
 for phase in phases:expected_all.extend(phase[2])
 deadline=time.monotonic()+10
 try:
  interpreter=[FAULT_PY,"/proc/self/fd/3"] if fault is not None else ["/usr/local/bin/python3","/proc/self/fd/3"]
  p=subprocess.Popen(interpreter,cwd="/",env={},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,pass_fds=(fd,))
  os.close(fd);fd=-1
  if p.stdin is None or p.stdout is None or p.stderr is None:raise RuntimeError(label+" pipes")
  os.set_blocking(p.stdout.fileno(),False);os.set_blocking(p.stderr.fileno(),False)
  sel=selectors.DefaultSelector();sel.register(p.stdout,selectors.EVENT_READ,"out");sel.register(p.stderr,selectors.EVENT_READ,"err")
  cumulative=0
  for mutate,requests,expected in phases:
   if mutate is not None:mutate()
   request_data=b"".join(requests);sent=0
   while sent<len(request_data):
    try:count=os.write(p.stdin.fileno(),request_data[sent:])
    except BrokenPipeError:
     stdin_closed=True;break
    if count<=0:raise RuntimeError(label+" stdin write")
    sent+=count
   if stdin_closed and sent<len(request_data):raise RuntimeError(label+" stdin broken")
   cumulative+=len(expected)
   while True:
    exited=p.poll() is not None
    rows=parse(bytes(out))
    if len(rows)>=cumulative:break
    if exited and out_eof:break
    if time.monotonic()>=deadline:raise RuntimeError(label+" deadline rows="+repr(rows))
    got_out_eof,got_err_eof=drain_round(sel,out,err)
    out_eof=out_eof or got_out_eof;err_eof=err_eof or got_err_eof
   rows=parse(bytes(out))
   if rows[:cumulative]!=expected_all[:cumulative]:raise RuntimeError(label+" phase rows "+repr(rows)+" expected "+repr(expected_all[:cumulative])+" returncode="+str(p.poll()))
  try:
   p.stdin.close();stdin_closed=True
  except OSError:
   pass
  while True:
   exited=p.poll() is not None
   if exited and out_eof and err_eof:break
   if time.monotonic()>=deadline:raise RuntimeError(label+" drain deadline")
   got_out_eof,got_err_eof=drain_round(sel,out,err)
   out_eof=out_eof or got_out_eof;err_eof=err_eof or got_err_eof
  if p.returncode!=returncode:raise RuntimeError(label+" returncode "+str(p.returncode))
  if len(err)!=0:raise RuntimeError(label+" stderr "+repr(bytes(err)))
  if not absent(p.pid):raise RuntimeError(label+" group present")
  if bytes(out)!=frames_bytes(expected_all):raise RuntimeError(label+" frames "+repr(parse(bytes(out)))+" expected "+repr(expected_all))
  if root_names is not None and sorted(os.listdir(ROOT))!=sorted(root_names):raise RuntimeError(label+" names "+repr(sorted(os.listdir(ROOT))))
  print("WIRE_OK %s exit=%d frames=%s group_absent=1"%(label,p.returncode,bytes(out).hex()))
  runs[0]+=1
 finally:
  if fd>=0:os.close(fd)
  if p is not None and not absent(p.pid):
   try:os.killpg(p.pid,signal.SIGTERM)
   except OSError as failure:
    if failure.errno!=errno.ESRCH:raise
   if not reap_bounded(p,sel,out,err,label,2):
    try:os.killpg(p.pid,signal.SIGKILL)
    except OSError as failure:
     if failure.errno!=errno.ESRCH:raise
    if not reap_bounded(p,sel,out,err,label,2):raise RuntimeError(label+" cleanup absence")
  if p is not None:
   for stream in (p.stdin,p.stdout,p.stderr):
    if stream is None:continue
    try:
     stream.close()
    except OSError:
     pass
  if sel is not None:sel.close()

runs=[0]
EXPECTED_RUNS=46
def create_setup():
 run("create-setup",[(None,[OPEN,create_request,QUIT],[OK_OPEN,OK_CREATE,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()])

try:
 install_fault_wrapper()
 run("fresh-begin-busy",[(None,[OPEN,HELLO,frame(0x0A,begin),QUIT],[OK_OPEN,READY,error(0x0A,0x06),OK_QUIT])],0,root_names=[".lock"])
 create_setup()
 run("usable-recoverables",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (None,[write_request(1,0,bytes(17),digest=bytes(32)),write_request(1,0,plan_chunk[:5]),write_request(2,0,content_chunk),write_request(1,0,plan_chunk),write_request(1,0,plan_chunk),write_request(1,PLAN_LENGTH,b"Q"),write_request(2,0,content_chunk),write_request(3,0,b"V"),write_request(2,0,content_alt),frame(0x17),QUIT],
   [error(0x0B,0x01),error(0x0B,0x03),error(0x0B,0x06),ok_write(1,1,PLAN_LENGTH),ok_write(1,1,PLAN_LENGTH),error(0x0B,0x03),ok_write(2,2,CONTENT_LENGTH),error(0x0B,0x04),error(0x0B,0x12),INVENTORY_ROW,DONE,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 run("quit-clean-empty",[(None,[OPEN,HELLO,QUIT],[OK_OPEN,READY,OK_QUIT])],0,root_names=[".lock"])
 create_setup()
 run("write-state-integrity-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (None,[write_request(1,0,plan_chunk)],[ok_write(1,1,PLAN_LENGTH)]),
  (corrupt_manifest_field,[write_request(1,0,plan_chunk)],[error(0x0B,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("write-oversize-retained-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (None,[write_request(1,0,plan_chunk)],[ok_write(1,1,PLAN_LENGTH)]),
  (append_manifest,[write_request(1,0,plan_chunk)],[error(0x0B,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("write-mode-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (chmod_draft,[write_request(1,0,plan_chunk)],[error(0x0B,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("hello-recovery-fatal-setup",[(None,[OPEN,HELLO,frame(0x0A,begin),QUIT],[OK_OPEN,READY,OK_BEGIN,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 duplicate_plan()
 run("hello-recovery-fatal",[(None,[OPEN,HELLO],[OK_OPEN,error(0xF0,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("hello-recovery-manifest-setup",[(None,[OPEN,HELLO,frame(0x0A,begin),QUIT],[OK_OPEN,READY,OK_BEGIN,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 corrupt_manifest_field()
 run("hello-recovery-manifest-fatal",[(None,[OPEN,HELLO],[OK_OPEN,error(0xF0,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("pre-command-root-uncertain-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (None,[frame(0x17)],[INVENTORY_ROW0,DONE]),
  (unlink_lock,[write_request(1,0,plan_chunk)],[error(0x0B,0x10)])],2,root_names=[lifecycle.hex()],fresh=False)
 create_setup()
 run("pre-command-root-mode-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (None,[frame(0x17)],[INVENTORY_ROW0,DONE]),
  (chmod_lock,[write_request(1,0,plan_chunk)],[error(0x0B,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 run("pre-command-root-unselected-hello-fatal",[
  (None,[OPEN],[OK_OPEN]),
  (unlink_lock,[HELLO],[error(0xF0,0x10)])],2,root_names=[])
 create_setup()
 run("post-emission-eof-no-second-error",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("fault-post-emission-root-suppressed",[
  (None,[OPEN,HELLO,frame(0x0A,begin),write_request(1,0,plan_chunk)],[OK_OPEN,READY,OK_BEGIN,ok_write(1,1,PLAN_LENGTH)])],2,root_names=[".lock",lifecycle.hex()],fresh=False,fault="post-emission-root")
 create_setup()
 run("fault-quit-fsync-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin),QUIT],[OK_OPEN,READY,OK_BEGIN,error(0xFF,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False,fault="quit-fsync")
 create_setup()
 run("fault-quit-close-suppressed",[
  (None,[OPEN,HELLO,frame(0x0A,begin),write_request(1,0,plan_chunk),QUIT],[OK_OPEN,READY,OK_BEGIN,ok_write(1,1,PLAN_LENGTH),OK_QUIT])],2,root_names=[".lock",lifecycle.hex()],fresh=False,fault="quit-close")
 run("v4-fatal-parity-raw-uncertain",[
  (None,[OPEN,frame(0x01)],[OK_OPEN,DONE]),
  (None,[frame(0x09)],[V4_INSPECT_BARRIER]),
  (unlink_lock,[QUIT],[error(0xFF,0x11)])],2,root_names=[])
 run("fault-v4-post-emission-parity",[
  (None,[OPEN,frame(0x01)],[OK_OPEN,DONE,error(0x01,0x11)])],2,root_names=[".lock"],fault="v4-post-emission")
 run("unselected-v5",[(None,[OPEN,frame(0x17)],[OK_OPEN,error(0x17,0x02)])],2,root_names=[".lock"])
 run("v4-to-v5",[(None,[OPEN,frame(0x01),HELLO],[OK_OPEN,DONE,error(0xF0,0x02)])],2,root_names=[".lock"])
 run("v5-to-v4",[(None,[OPEN,HELLO,frame(0x01)],[OK_OPEN,READY,error(0x01,0x02)])],2,root_names=[".lock"])
 run("malformed-hello-recovery",[(None,[OPEN,frame(0xF0,b"XXXXXXXX"),HELLO,QUIT],[OK_OPEN,error(0xF0,0x02),READY,OK_QUIT])],0,root_names=[".lock"])
 run("framing-oversize-payload",[(None,[OPEN,HELLO,OVERSIZE_HEADER],[OK_OPEN,READY,error(0x0B,0x03)])],2,root_names=[".lock"])
 create_setup()
 run("abort-authority-arms",[
  (None,[OPEN,HELLO,frame(0x0A,begin),write_request(1,0,plan_chunk)],[OK_OPEN,READY,OK_BEGIN,ok_write(1,1,PLAN_LENGTH)]),
  (None,[abort_request(1,0),abort_request(3,0),abort_request(1,1)],[error(0x0C,0x12),error(0x0C,0x04),OK_ABORT]),
  (None,[frame(0x17)],[DONE]),
  (None,[abort_request(1,0)],[error(0x0C,0x04)]),
  (None,[frame(0x0A,begin),abort_request(1,0)],[OK_BEGIN,OK_ABORT]),
  (None,[QUIT],[OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("abort-mode-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin)],[OK_OPEN,READY,OK_BEGIN]),
  (chmod_manifest,[abort_request(1,0)],[error(0x0C,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False)
 run("abort-mode-no-deletion",[
  (chmod_manifest_restore,[OPEN,HELLO,abort_request(1,0)],[OK_OPEN,READY,OK_ABORT]),
  (None,[frame(0x17),QUIT],[DONE,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("fault-abort-fsync-fatal",[
  (None,[OPEN,HELLO,frame(0x0A,begin),write_request(1,0,plan_chunk),abort_request(1,1)],[OK_OPEN,READY,OK_BEGIN,ok_write(1,1,PLAN_LENGTH),error(0x0C,0x10)])],2,root_names=[".lock",lifecycle.hex()],fresh=False,fault="abort-fsync")
 run("abort-fsync-restart-forward",[
  (None,[OPEN,HELLO,frame(0x17),QUIT],[OK_OPEN,READY,DONE,OK_QUIT])],0,root_names=[".lock",lifecycle.hex()],fresh=False)
 create_setup()
 run("fault-abort-post-emission-suppressed",[
  (None,[OPEN,HELLO,frame(0x0A,begin),write_request(1,0,plan_chunk),abort_request(1,1)],[OK_OPEN,READY,OK_BEGIN,ok_write(1,1,PLAN_LENGTH),OK_ABORT])],2,root_names=[".lock",lifecycle.hex()],fresh=False,fault="abort-post-emission")
 if runs[0]!=EXPECTED_RUNS:raise RuntimeError("verified count %d != expected %d"%(runs[0],EXPECTED_RUNS))
 print("V5_MAIN_ABORT_WIRE_OK %d/%d"%(runs[0],EXPECTED_RUNS))
finally:
 if os.path.exists(ROOT):shutil.rmtree(ROOT)
 for path in (FAULT_SCENARIO,FAULT_PY):
  if os.path.exists(path):os.unlink(path)
`,
		);
		const v5ProbePath = resolve(temporary, "v5-protocol-probe.py");
		writeFileSync(
			v5ProbePath,
			String.raw`import errno,hashlib,os,selectors,shutil,signal,struct,subprocess,time
HELPER="/app/src/modes/daemon/sandbox/hosted-session-store-posix-helper.py"
ROOT="/root/.prime/agent/sandbox-session-state-v1"
CAP=1048576

def frame(opcode,payload=b""):
 return bytes((opcode,))+struct.pack(">I",len(payload))+payload

def parse(data):
 rows=[];offset=0
 while offset<len(data):
  if len(data)-offset<5:raise RuntimeError("partial response header")
  opcode=data[offset];size=struct.unpack_from(">I",data,offset+1)[0];end=offset+5+size
  if end>len(data):raise RuntimeError("partial response payload")
  rows.append((opcode,data[offset+5:end]));offset=end
 return rows

def absent(pgid):
 try:os.killpg(pgid,0)
 except OSError as failure:
  if failure.errno==errno.ESRCH:return True
  raise
 return False

def run(label,requests,expected,returncode,lock_only=True):
 if os.path.exists(ROOT):shutil.rmtree(ROOT)
 fd=os.open(HELPER,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 if fd!=3:
  os.dup2(fd,3,inheritable=True);os.close(fd);fd=3
 if os.lseek(fd,0,os.SEEK_CUR)!=0:raise RuntimeError(label+" helper offset")
 p=None;sel=None;out=bytearray();err=bytearray();stdin_closed=False;out_eof=False;err_eof=False;sent=0
 data=b"".join(requests);deadline=time.monotonic()+8
 try:
  p=subprocess.Popen(["/usr/local/bin/python3","/proc/self/fd/3"],cwd="/",env={},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,pass_fds=(fd,))
  os.close(fd);fd=-1
  if p.stdin is None or p.stdout is None or p.stderr is None:raise RuntimeError(label+" pipes")
  for stream in (p.stdin,p.stdout,p.stderr):os.set_blocking(stream.fileno(),False)
  sel=selectors.DefaultSelector();sel.register(p.stdin,selectors.EVENT_WRITE,"in");sel.register(p.stdout,selectors.EVENT_READ,"out");sel.register(p.stderr,selectors.EVENT_READ,"err")
  while True:
   exited=p.poll() is not None
   if exited and out_eof and err_eof:break
   if time.monotonic()>=deadline:raise RuntimeError(label+" deadline")
   for key,unused_mask in sel.select(0.05):
    kind=key.data;stream=key.fileobj
    if kind=="in":
     try:count=os.write(stream.fileno(),data[sent:sent+65536])
     except BlockingIOError:continue
     except BrokenPipeError:
      sel.unregister(stream);stream.close();stdin_closed=True;continue
     if count<=0:raise RuntimeError(label+" stdin write")
     sent+=count
     if sent==len(data):sel.unregister(stream);stream.close();stdin_closed=True
    else:
     try:chunk=os.read(stream.fileno(),65536)
     except BlockingIOError:continue
     if not chunk:
      sel.unregister(stream);stream.close()
      if kind=="out":out_eof=True
      else:err_eof=True
      continue
     target=out if kind=="out" else err
     if len(target)+len(chunk)>CAP:raise RuntimeError(label+" output cap")
     target.extend(chunk)
  p.wait(timeout=0)
  if not stdin_closed or sent!=len(data):raise RuntimeError(label+" input incomplete")
  if p.returncode!=returncode:raise RuntimeError(label+" returncode "+str(p.returncode))
  if len(err)!=0:raise RuntimeError(label+" stderr "+repr(bytes(err)))
  if not absent(p.pid):raise RuntimeError(label+" group present")
  rows=parse(bytes(out))
  if rows!=expected:raise RuntimeError(label+" frames "+repr(rows))
  if lock_only and os.listdir(ROOT)!=[".lock"]:raise RuntimeError(label+" names "+repr(os.listdir(ROOT)))
 finally:
  if fd>=0:os.close(fd)
  if p is not None and not absent(p.pid):
   try:os.killpg(p.pid,signal.SIGTERM)
   except OSError as failure:
    if failure.errno!=errno.ESRCH:raise
   for cleanup_signal in (signal.SIGKILL,):
    end=time.monotonic()+2
    while time.monotonic()<end:
     if sel is not None:
      for key,unused_mask in sel.select(0.05):
       stream=key.fileobj
       if key.data=="in":
        sel.unregister(stream);stream.close();stdin_closed=True
       else:
        try:chunk=os.read(stream.fileno(),65536)
        except BlockingIOError:continue
        if not chunk:
         sel.unregister(stream);stream.close()
         if key.data=="out":out_eof=True
         else:err_eof=True
     p.poll()
     if p.returncode is not None and out_eof and err_eof and absent(p.pid):break
    if p.returncode is not None and out_eof and err_eof and absent(p.pid):break
    try:os.killpg(p.pid,cleanup_signal)
    except OSError as failure:
     if failure.errno!=errno.ESRCH:raise
   if p.poll() is None or not out_eof or not err_eof or not absent(p.pid):raise RuntimeError(label+" cleanup absence")
  if sel is not None:sel.close()

OPEN=frame(0xFE);QUIT=frame(0xFF);HELLO=frame(0xF0,b"PISTOV05");INVENTORY=frame(0x17)
OK_OPEN=(0x80,b"\xfe");OK_QUIT=(0x80,b"\xff");READY=(0x84,b"\xf0PISTOV05");DONE=(0x82,b"")
def error(opcode,code):return (0xE0,bytes((opcode,code)))
B=bytearray(128);B[96]=1
begin=bytes(B)+bytes(32)+struct.pack(">I",1)+struct.pack(">Q",0)
data=b"abc";write_base=bytes(B)+bytes((1,))+struct.pack(">Q",0)
write_match=write_base+hashlib.sha256(data).digest()+data
write_mismatch=write_base+bytes(32)+data
seal=bytes(B)+bytes(64)
run("happy",[OPEN,HELLO,INVENTORY,frame(0x0A,begin),frame(0x0B,write_match),frame(0x0B,write_mismatch),frame(0x0D,seal),HELLO,INVENTORY,QUIT],[OK_OPEN,READY,DONE,error(0x0A,0x06),error(0x0B,0x04),error(0x0B,0x01),error(0x0D,0x04),error(0xF0,0x02),DONE,OK_QUIT],0)
run("malformed hello recovery",[OPEN,frame(0xF0,b"XXXXXXXX"),HELLO,QUIT],[OK_OPEN,error(0xF0,0x02),READY,OK_QUIT],0)
recoverable=(0x0A,0x0B,0x0C,0x0D,0x0F,0x10,0x11,0x12,0x13,0x14,0x15,0x16)
run("recoverable lengths",[OPEN,HELLO]+[frame(opcode) for opcode in recoverable]+[INVENTORY,QUIT],[OK_OPEN,READY]+[error(opcode,0x01) for opcode in recoverable]+[DONE,OK_QUIT],0)
begin_plan_bounds=bytes(B)+bytes(32)+struct.pack(">I",0)+struct.pack(">Q",0)
begin_content_bounds=bytes(B)+bytes(32)+struct.pack(">I",1)+struct.pack(">Q",1073741825)
write_empty=write_base+bytes(32)
vector_bounds=bytes(B)+bytes((2,))+struct.pack(">I",32764)+struct.pack(">I",32763)+bytes(64)
consume_bounds=bytearray(307);consume_bounds[:128]=B;consume_bounds[176]=1;consume_bounds[208]=1;consume_bounds[209]=2
read_bounds=bytes(B)+bytes((1,))+struct.pack(">Q",0)+struct.pack(">I",0)+bytes(32)
bounds_requests=[frame(0x0A,begin_plan_bounds),frame(0x0A,begin_content_bounds),frame(0x0B,write_empty),frame(0x0F,vector_bounds),frame(0x11,consume_bounds),frame(0x16,read_bounds)]
run("bounds",[OPEN,HELLO]+bounds_requests+[INVENTORY,QUIT],[OK_OPEN,READY,error(0x0A,0x03),error(0x0A,0x03),error(0x0B,0x03),error(0x0F,0x03),error(0x11,0x03),error(0x16,0x03),DONE,OK_QUIT],0)
zero_b=bytes(128)
abort_bad=bytes(B)+bytes((2,))+bytes(8)
vector_bad_kind=bytes(B)+bytes((1,))+bytes(4)+bytes(4)+bytes(64)
vector_bad_terminal=bytes(B)+bytes((2,))+struct.pack(">I",2)+struct.pack(">I",0)+bytes(64)
consume_bad=bytearray(307);consume_bad[:128]=B
record_bad=bytes(B)+bytes(40)+struct.pack(">I",0)+bytes((1,))
ack_bad=bytes(B)+bytes(40)+bytes((0,))
read_bad=bytes(B)+bytes((0,))+bytes(8)+struct.pack(">I",1)+bytes(32)
input_requests=[frame(0x0A,zero_b+bytes(32)+struct.pack(">I",1)+bytes(8)),frame(0x0B,bytes(B)+bytes((0,))+bytes(8)+hashlib.sha256(data).digest()+data),frame(0x0C,abort_bad),frame(0x0F,vector_bad_kind),frame(0x0F,vector_bad_terminal),frame(0x11,consume_bad),frame(0x12,record_bad),frame(0x14,ack_bad),frame(0x16,read_bad)]
run("input fields",[OPEN,HELLO]+input_requests+[INVENTORY,QUIT],[OK_OPEN,READY]+[error(opcode,0x01) for opcode in (0x0A,0x0B,0x0C,0x0F,0x0F,0x11,0x12,0x14,0x16)]+[DONE,OK_QUIT],0)
valid_abort=bytes(B)+bytes((1,))+bytes(8)
valid_mark=bytes(B)+bytes(40)
valid_vector=bytes(B)+bytes((2,))+bytes(4)+bytes(4)+bytes(64)
valid_seal_vector=bytes(B)+bytes(72)
valid_consume=bytearray(307);valid_consume[:128]=B;valid_consume[168:176]=struct.pack(">Q",1);valid_consume[176]=1;valid_consume[208]=1;valid_consume[209]=2
valid_record=bytes(B)+bytes(40)+struct.pack(">I",1)+bytes((1,))
valid_ack=bytes(B)+bytes(40)+bytes((1,))
valid_ack_purge=bytes(B)+bytes(40)
valid_read=bytes(B)+bytes((1,))+bytes(8)+struct.pack(">I",1)+bytes(32)
valids=[(0x0C,valid_abort),(0x0E,valid_mark),(0x0F,valid_vector),(0x10,valid_seal_vector),(0x11,valid_consume),(0x12,valid_record),(0x13,bytes(B)),(0x14,valid_ack),(0x15,valid_ack_purge),(0x16,valid_read)]
run("valid absent",[OPEN,HELLO]+[frame(opcode,payload) for opcode,payload in valids]+[QUIT],[OK_OPEN,READY]+[error(opcode,0x04) for opcode,payload in valids]+[OK_QUIT],0)
run("fatal mark",[OPEN,HELLO,frame(0x0E,bytes(168))],[OK_OPEN,READY,error(0x0E,0x02)],2)
run("fatal inventory",[OPEN,HELLO,frame(0x17,b"x")],[OK_OPEN,READY,error(0x17,0x02)],2)
run("unselected V5",[OPEN,INVENTORY],[OK_OPEN,error(0x17,0x02)],2)
run("V4 to V5",[OPEN,frame(0x01),HELLO],[OK_OPEN,DONE,error(0xF0,0x02)],2)
run("V5 to V4",[OPEN,HELLO,frame(0x01)],[OK_OPEN,READY,error(0x01,0x02)],2)
print("V5_RAW_PROTOCOL_OK")
shutil.rmtree(ROOT)
`,
			{ mode: 0o600 },
		);
		const faultInterpreterPath = resolve(temporary, "fault-python3");
		writeFileSync(
			faultInterpreterPath,
			`#!/usr/local/bin/python3.real
import os,signal,struct,threading
scenario=open("/tmp/fault-scenario",encoding="ascii").read().strip()
with open("/tmp/fault-pid-"+scenario,"w",encoding="ascii") as stream: stream.write(str(os.getpid()))
term_count=0
def term(unused_signal,unused_frame):
 global term_count
 term_count+=1
 with open("/tmp/fault-term-"+scenario,"w",encoding="ascii") as stream: stream.write(str(term_count))
signal.signal(signal.SIGTERM,term)
def read_exact(size):
 data=bytearray()
 while len(data)<size:
  chunk=os.read(0,size-len(data))
  if not chunk: raise SystemExit(2)
  data.extend(chunk)
 return bytes(data)
def request():
 header=read_exact(5); length=struct.unpack(">I",header[1:])[0]; return header[0],read_exact(length)
def emit(data,fd=1):
 view=memoryview(data)
 while len(view):
  try: count=os.write(fd,view)
  except BrokenPipeError: return
  view=view[count:]
def frame(opcode,payload=b""): return bytes([opcode])+struct.pack(">I",len(payload))+payload
opcode,payload=request()
if opcode!=0xFE or payload: raise SystemExit(3)
emit(frame(0x80,b"\\xfe"))
opcode,payload=request()
if scenario.startswith("v5-"):
 if opcode!=0xF0 or payload!=b"PISTOV05": raise SystemExit(4)
 if scenario=="v5-hello-protocol" or scenario=="v5-hello-state":
  emit(frame(0xE0,bytes([0xF0,0x02 if scenario.endswith("protocol") else 0x0E])))
  opcode,payload=request()
  if opcode!=0xFF or payload: raise SystemExit(6)
  emit(frame(0x80,bytes((0xFF,))));raise SystemExit(0)
 if scenario=="v5-hello-busy": emit(frame(0xE0,bytes((0xF0,0x06))))
 elif scenario=="v5-ready-wrong-opcode": emit(frame(0x80,bytes((0xF0,))))
 elif scenario=="v5-ready-short": emit(frame(0x84,bytes((0xF0,))+b"PISTOV0"))
 elif scenario=="v5-ready-wrong-magic": emit(frame(0x84,bytes((0xF0,))+b"XXXXXXXX"))
 else:
  emit(frame(0x84,bytes((0xF0,))+b"PISTOV05"))
  opcode,payload=request()
  if opcode!=0x17 or payload: raise SystemExit(7)
  transaction=bytearray(401)
  transaction[:32]=bytes((1,))*32
  transaction[32:64]=bytes((2,))*32
  transaction[64:96]=bytes((3,))*32
  transaction[96:128]=bytes((4,))*32
  transaction[128:160]=bytes((5,))*32
  transaction[160:164]=struct.pack(">I",1)
  transaction[216:224]=bytes((0xff,))*8
  transaction[384:392]=bytes((0xff,))*8
  transaction[392:400]=struct.pack(">Q",1100000000)
  transaction[400]=1
  progress_rows={
   'v5-inventory-valid-progress-single':(1, 0, 1, 0, 1),
   'v5-inventory-valid-progress-boundary':(1048407, 0, 1048407, 0, 1),
   'v5-inventory-valid-progress-plan':(1048408, 0, 1048407, 0, 1),
   'v5-inventory-valid-progress-plan-final-one':(1048408, 0, 1048408, 0, 2),
   'v5-inventory-valid-progress-content':(1, 1048408, 1, 1048407, 2),
   'v5-inventory-valid-progress-content-final-one':(1, 1048408, 1, 1048408, 3),
   'v5-inventory-valid-progress-maximum':(1048576, 1073741824, 1048576, 1073741824, 1027),
   'v5-inventory-invalid-progress-plan-partial':(1048408, 0, 1, 0, 1),
   'v5-inventory-invalid-progress-content-partial':(1, 1048408, 1, 1, 2),
   'v5-inventory-invalid-progress-content-order':(1, 1, 0, 1, 1),
   'v5-inventory-invalid-progress-plan-overrun':(1, 0, 2, 0, 1),
   'v5-inventory-invalid-progress-content-overrun':(1, 1, 1, 2, 2),
   'v5-inventory-invalid-progress-revision-high':(1, 0, 1, 0, 2),
   'v5-inventory-invalid-progress-revision-overflow':(1, 1, 1, 1, 18446744073709551615),
  }
  if scenario in progress_rows:
   plan_length,content_length,plan_end,content_end,revision=progress_rows[scenario]
   struct.pack_into(">I",transaction,160,plan_length)
   struct.pack_into(">Q",transaction,164,content_length)
   struct.pack_into(">Q",transaction,180,plan_end)
   struct.pack_into(">Q",transaction,188,content_end)
   struct.pack_into(">Q",transaction,204,revision)
  valid_transaction=bytes(transaction)
  if scenario=="v5-inventory-valid-draft" or scenario.startswith("v5-inventory-valid-progress-"):
   emit(frame(0x83,valid_transaction)+frame(0x82))
   opcode,payload=request()
   if opcode!=0xFF or payload: raise SystemExit(9)
   emit(frame(0x80,bytes((0xFF,))));raise SystemExit(0)
  sealed=bytearray(valid_transaction)
  sealed[176]=1
  struct.pack_into(">I",sealed,160,17)
  struct.pack_into(">Q",sealed,164,23)
  struct.pack_into(">Q",sealed,180,17)
  struct.pack_into(">Q",sealed,188,23)
  sealed[204:212]=bytes((0xff,))*8
  sealed[216:224]=bytes(8)
  sealed[224:256]=bytes((6,))*32
  sealed[256:288]=bytes((7,))*32
  sealed[288:320]=bytes((8,))*32
  sealed[400]=0
  valid_sealed=bytes(sealed)
  if scenario.startswith("v5-inventory-valid-sealed"):
   rows=[frame(0x83,valid_sealed)]
   if scenario=="v5-inventory-valid-sealed-mixed":
    draft=bytearray(valid_transaction);draft[:32]=bytes((1,))*32
    item=bytearray(valid_sealed);item[:32]=bytes((2,))*32
    rows=[frame(0x83,bytes(draft)),frame(0x83,bytes(item))]
   elif scenario=="v5-inventory-valid-sealed-opaque-zero":
    item=bytearray(valid_sealed);item[:96]=bytes(96);item[96:128]=bytes((4,))*32;item[128:160]=bytes(32);item[224:320]=bytes(96)
    struct.pack_into(">Q",item,164,0);struct.pack_into(">Q",item,188,0)
    rows=[frame(0x83,bytes(item))]
   emit(b"".join(rows)+frame(0x82))
   opcode,payload=request()
   if opcode!=0xFF or payload: raise SystemExit(9)
   emit(frame(0x80,bytes((0xFF,))));raise SystemExit(0)
  if scenario=="v5-inventory-eight-transactions":
   transactions=[]
   for index in range(1,9):
    item=bytearray(valid_transaction);item[:32]=bytes((index,))*32;transactions.append(frame(0x83,bytes(item)))
   emit(b"".join(transactions)+frame(0x82))
   opcode,payload=request()
   if opcode!=0xFF or payload: raise SystemExit(9)
   emit(frame(0x80,bytes((0xFF,))));raise SystemExit(0)
  if scenario=="v5-inventory-short-transaction": emit(frame(0x83,valid_transaction[:-1]))
  elif scenario=="v5-inventory-long-transaction": emit(frame(0x83,valid_transaction+b"x"))
  elif scenario=="v5-inventory-zero-transaction": emit(frame(0x83,bytes(401)))
  elif scenario in progress_rows: emit(frame(0x83,valid_transaction))
  elif scenario.startswith("v5-inventory-invalid-sealed-"):
   invalid=bytearray(valid_sealed)
   mutation=scenario[len("v5-inventory-invalid-sealed-"):]
   if mutation=="tx": invalid[96:128]=bytes(32)
   elif mutation=="plan": struct.pack_into(">I",invalid,160,0);struct.pack_into(">Q",invalid,180,0)
   elif mutation=="content": struct.pack_into(">Q",invalid,164,1073741825);struct.pack_into(">Q",invalid,188,1073741825)
   elif mutation=="state": invalid[176]=2
   elif mutation=="kind": invalid[400]=3
   elif mutation=="decision": invalid[177]=2
   elif mutation=="terminal": invalid[178]=1
   elif mutation=="ack": invalid[179]=1
   elif mutation=="plan-committed": struct.pack_into(">Q",invalid,180,16)
   elif mutation=="content-committed": struct.pack_into(">Q",invalid,188,22)
   elif mutation=="vector-len": struct.pack_into(">I",invalid,172,1)
   elif mutation=="vector-committed": struct.pack_into(">Q",invalid,196,1)
   elif mutation=="manifest": invalid[204:212]=bytes(8)
   elif mutation=="attempt": struct.pack_into(">I",invalid,212,1)
   elif mutation=="revision": struct.pack_into(">Q",invalid,216,1)
   elif mutation=="vector-record": invalid[320]=1
   elif mutation=="provenance": invalid[352]=1
   elif mutation=="ordinal-zero": invalid[384:388]=bytes(4)
   elif mutation=="ordinal-present": struct.pack_into(">I",invalid,384,1)
   elif mutation=="reservation": invalid[392:400]=bytes(8)
   else: raise SystemExit(11)
   emit(frame(0x83,bytes(invalid)))
  elif scenario.startswith("v5-inventory-invalid-"):
   invalid=bytearray(valid_transaction)
   mutation=scenario[len("v5-inventory-invalid-"):]
   if mutation=="tx": invalid[96:128]=bytes(32)
   elif mutation=="plan": invalid[160:164]=bytes(4)
   elif mutation=="content": invalid[164:172]=struct.pack(">Q",1073741825)
   elif mutation=="state": invalid[176]=1
   elif mutation=="committed": invalid[180:188]=struct.pack(">Q",1)
   elif mutation=="vector-committed": invalid[196:204]=struct.pack(">Q",1)
   elif mutation=="attempt": invalid[212:216]=struct.pack(">I",1)
   elif mutation=="checkpoint": invalid[216:224]=bytes(8)
   elif mutation=="record": invalid[224]=1
   elif mutation=="ordinal": invalid[384:388]=bytes(4)
   elif mutation=="reservation": invalid[392:400]=bytes(8)
   elif mutation=="kind": invalid[400]=0
   else: raise SystemExit(10)
   emit(frame(0x83,bytes(invalid)))
  elif scenario=="v5-inventory-nine-transactions":
   transactions=[]
   for index in range(1,10):
    item=bytearray(valid_transaction);item[:32]=bytes((index,))*32;transactions.append(frame(0x83,bytes(item)))
   emit(b"".join(transactions))
  elif scenario=="v5-inventory-unsorted":
   earlier=bytearray(valid_transaction);earlier[:32]=bytes(32)
   emit(frame(0x83,valid_transaction)+frame(0x83,bytes(earlier)))
  elif scenario=="v5-inventory-duplicate-prefix": emit(frame(0x83,valid_transaction)+frame(0x83,valid_transaction))
  elif scenario=="v5-inventory-wrong-opcode": emit(frame(0x80,bytes((0x17,))))
  elif scenario=="v5-inventory-session": emit(frame(0x81,b"x"))
  elif scenario=="v5-inventory-error": emit(frame(0xE0,bytes((0x17,0x02))))
  else: raise SystemExit(8)
else:
 if opcode!=0x01 or payload: raise SystemExit(4)
 if scenario=="malformed-length": emit(bytes([0x82])+struct.pack(">I",1048577))
 elif scenario=="malformed-payload": emit(frame(0xE0,b"\\x01"))
 elif scenario=="trailing": emit(frame(0x82)+bytes([0x82])+struct.pack(">I",1048577))
 elif scenario=="duplicate": emit(frame(0x82)+frame(0x82))
 elif scenario=="reordered": emit(frame(0x82)+frame(0x81))
 elif scenario=="late":
  emit(frame(0x82)); threading.Event().wait(0.05); emit(frame(0x82))
 elif scenario=="wrong-opcode": emit(frame(0x80,b"\\x01"))
 elif scenario=="stdout-overflow": emit(frame(0x81,b"x"*1048576)+b"x")
 elif scenario=="stderr-overflow": emit(b"x"*65537,2)
 else: raise SystemExit(5)
while True:
 try: request()
 except (EOFError,SystemExit): threading.Event().wait(4)
`,
			{ mode: 0o755 },
		);
		const faultControllerPath = resolve(temporary, "fault-controller.py");
		writeFileSync(
			faultControllerPath,
			boundedSupervisorSource +
				`
def complete(r):
 return r[0] is not None and not r[3] and not r[4] and not r[5] and not r[6] and not r[7] and r[8] and r[9] and r[10] and r[11] and not r[12] and not r[13]
cases=("malformed-length","malformed-payload","trailing","duplicate","reordered","late","wrong-opcode","stdout-overflow","stderr-overflow","v5-hello-protocol","v5-hello-state","v5-hello-busy","v5-ready-wrong-opcode","v5-ready-short","v5-ready-wrong-magic","v5-inventory-valid-draft","v5-inventory-eight-transactions","v5-inventory-short-transaction","v5-inventory-long-transaction","v5-inventory-zero-transaction","v5-inventory-invalid-tx","v5-inventory-invalid-plan","v5-inventory-invalid-content","v5-inventory-invalid-state","v5-inventory-invalid-committed","v5-inventory-invalid-checkpoint","v5-inventory-invalid-record","v5-inventory-invalid-ordinal","v5-inventory-invalid-reservation","v5-inventory-invalid-kind","v5-inventory-nine-transactions","v5-inventory-unsorted","v5-inventory-duplicate-prefix","v5-inventory-wrong-opcode","v5-inventory-session","v5-inventory-error","v5-inventory-valid-progress-single","v5-inventory-valid-progress-boundary","v5-inventory-valid-progress-plan","v5-inventory-valid-progress-plan-final-one","v5-inventory-valid-progress-content","v5-inventory-valid-progress-content-final-one","v5-inventory-valid-progress-maximum","v5-inventory-invalid-progress-plan-partial","v5-inventory-invalid-progress-content-partial","v5-inventory-invalid-progress-content-order","v5-inventory-invalid-progress-plan-overrun","v5-inventory-invalid-progress-content-overrun","v5-inventory-invalid-progress-revision-high","v5-inventory-invalid-progress-revision-overflow","v5-inventory-invalid-vector-committed","v5-inventory-invalid-attempt","v5-inventory-valid-sealed","v5-inventory-valid-sealed-opaque-zero","v5-inventory-valid-sealed-mixed","v5-inventory-invalid-sealed-tx","v5-inventory-invalid-sealed-plan","v5-inventory-invalid-sealed-content","v5-inventory-invalid-sealed-state","v5-inventory-invalid-sealed-kind","v5-inventory-invalid-sealed-decision","v5-inventory-invalid-sealed-terminal","v5-inventory-invalid-sealed-ack","v5-inventory-invalid-sealed-plan-committed","v5-inventory-invalid-sealed-content-committed","v5-inventory-invalid-sealed-vector-len","v5-inventory-invalid-sealed-vector-committed","v5-inventory-invalid-sealed-manifest","v5-inventory-invalid-sealed-attempt","v5-inventory-invalid-sealed-revision","v5-inventory-invalid-sealed-vector-record","v5-inventory-invalid-sealed-provenance","v5-inventory-invalid-sealed-ordinal-zero","v5-inventory-invalid-sealed-ordinal-present","v5-inventory-invalid-sealed-reservation")
for scenario in cases:
 open("/chroot/tmp/fault-scenario","w",encoding="ascii").write(scenario)
 term_path="/chroot/tmp/fault-term-"+scenario
 pid_path="/chroot/tmp/fault-pid-"+scenario
 for path in (term_path,pid_path):
  try: os.unlink(path)
  except FileNotFoundError: pass
 started=time.monotonic()
 argument=("v5fault-" if scenario.startswith("v5-") else "fault-")+scenario
 r=bounded(["chroot","/chroot","/bun","/app/integration.ts",argument],7)
 out=r[1];err=r[2]
 term=open(term_path,encoding="ascii").read() if os.path.exists(term_path) else ""
 helper=int(open(pid_path,encoding="ascii").read()) if os.path.exists(pid_path) else 0
 helper_absent=False
 try: os.killpg(helper,0)
 except OSError as failure: helper_absent=failure.errno==errno.ESRCH
 elapsed=time.monotonic()-started
 marker=(("V5_FAULT_OK " if scenario.startswith("v5-") else "FAULT_OK ")+scenario).encode()
 expected_term="" if scenario in ("v5-hello-protocol","v5-hello-state","v5-inventory-valid-draft","v5-inventory-eight-transactions") or scenario.startswith("v5-inventory-valid-progress-") or scenario.startswith("v5-inventory-valid-sealed") else "1"
 if not complete(r) or r[0]!=0 or marker not in out or term!=expected_term or not helper_absent or elapsed>5:
  raise RuntimeError(f"fault {scenario} result={r[0:1]+r[3:]} term={term!r} helper_absent={helper_absent} elapsed={elapsed} out={out!r} err={err!r}")
 print("FAULT_CASE_OK "+scenario)
`,
		);
		const rolloverInterpreterPath = resolve(temporary, "rollover-python3");
		writeFileSync(
			rolloverInterpreterPath,
			`#!/usr/local/bin/python3.real
import os,signal,struct,subprocess,sys,threading
scenario=open("/tmp/rollover-scenario",encoding="ascii").read().strip()
signal.signal(signal.SIGTERM,signal.SIG_IGN)
child=subprocess.Popen(["/usr/local/bin/python3.real",sys.argv[1]],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(3,))
def drain_stderr():
 while True:
  chunk=child.stderr.read(65536)
  if not chunk:return
  try:os.write(2,chunk)
  except BrokenPipeError:return
threading.Thread(target=drain_stderr,daemon=True).start()
def read_exact(stream,size):
 data=bytearray()
 while len(data)<size:
  chunk=stream.read(size-len(data))
  if not chunk:raise EOFError
  data.extend(chunk)
 return bytes(data)
def frame_from(stream):
 header=read_exact(stream,5);length=struct.unpack(">I",header[1:])[0];return header+read_exact(stream,length)
def emit(data):
 view=memoryview(data)
 while len(view):
  count=os.write(1,view);view=view[count:]
while True:
 request=frame_from(sys.stdin.buffer);opcode=request[0]
 child.stdin.write(request);child.stdin.flush()
 while True:
  response=frame_from(child.stdout)
  if (scenario=="case3" and opcode==0x05) or (scenario=="case4" and opcode==0x06): os._exit(97)
  emit(response)
  if opcode!=0x01 or response[0] in (0x82,0xE0):break
`,
			{ mode: 0o755 },
		);
		const rolloverControllerPath = resolve(temporary, "rollover-controller.py");
		writeFileSync(
			rolloverControllerPath,
			boundedSupervisorSource +
				`
import shutil,struct
def complete(r):
 return r[0] is not None and not r[3] and not r[4] and not r[5] and not r[6] and not r[7] and r[8] and r[9] and r[10] and r[11] and not r[12] and not r[13]
root="/chroot/root/.prime/agent/sandbox-session-state-v1"
def run(args,label):
 r=bounded(args,8)
 if not complete(r) or r[0]!=0:raise RuntimeError(f"{label} result={r[0:1]+r[3:]} out={r[1]!r} err={r[2]!r}")
 return r[1]
for scenario in ("case3","case4"):
 open("/chroot/tmp/rollover-scenario","w",encoding="ascii").write(scenario)
 out=run(["chroot","/chroot","/bun","/app/integration.ts","rollover-cut"+scenario[-1]],"cut "+scenario)
 if b"ROLLOVER_CUT_OK" not in out:raise RuntimeError("missing cut marker "+scenario)
 lifecycle_names=[name for name in os.listdir(root) if len(name)==64 and all(c in "0123456789abcdef" for c in name)]
 if len(lifecycle_names)!=1:raise RuntimeError("cut lifecycle count")
 lifecycle=root+"/"+lifecycle_names[0]
 head=open(lifecycle+"/head","rb").read();selected=head[8:40].hex();revision=struct.unpack(">Q",head[40:48])[0]
 generations=sorted(os.listdir(lifecycle+"/generations"))
 if len(generations)!=2:raise RuntimeError(f"{scenario} generations {generations}")
 wal_counts={name:len([entry for entry in os.listdir(lifecycle+"/generations/"+name+"/wal") if entry.endswith(".wal")]) for name in generations}
 fresh=[name for name,count in wal_counts.items() if count==1]
 retired=[name for name,count in wal_counts.items() if count==3]
 if len(fresh)!=1 or len(retired)!=1:raise RuntimeError(f"{scenario} wal counts {wal_counts}")
 if scenario=="case3" and (selected!=retired[0] or revision!=3):raise RuntimeError("case3 publication boundary")
 if scenario=="case4" and (selected!=fresh[0] or revision!=1):raise RuntimeError("case4 publication boundary")
 ledger_before=sorted(entry for entry in os.listdir(lifecycle+"/ledger") if entry.endswith(".rec"))
 if len(ledger_before)!=2:raise RuntimeError("rollover ledger before")
 os.unlink("/chroot/usr/local/bin/python3");os.rename("/chroot/usr/local/bin/python3.real","/chroot/usr/local/bin/python3")
 out=run(["chroot","/chroot","/bun","/app/integration.ts","rollover-verify"+scenario[-1]],"verify "+scenario)
 if b"ROLLOVER_VERIFY_OK" not in out:raise RuntimeError("missing verify marker "+scenario)
 lifecycle_names=[name for name in os.listdir(root) if len(name)==64 and all(c in "0123456789abcdef" for c in name)]
 lifecycle=root+"/"+lifecycle_names[0];head=open(lifecycle+"/head","rb").read()
 generations=sorted(os.listdir(lifecycle+"/generations"));ledger_after=sorted(entry for entry in os.listdir(lifecycle+"/ledger") if entry.endswith(".rec"))
 if generations!=fresh or head[8:40].hex()!=fresh[0] or struct.unpack(">Q",head[40:48])[0]!=1 or ledger_after!=ledger_before:raise RuntimeError("repair continuity/duplicate effect "+scenario)
 print("ROLLOVER_PUBLICATION_CUT_OK "+scenario)
 if scenario=="case3":
  shutil.rmtree(root)
  os.rename("/chroot/usr/local/bin/python3","/chroot/usr/local/bin/python3.real")
  shutil.copyfile("/input-rollover-python3","/chroot/usr/local/bin/python3");os.chmod("/chroot/usr/local/bin/python3",0o755)
`,
		);
		const sandboxDirectory = resolve(testDirectory, "../src/modes/daemon/sandbox");
		const bunPath =
			"/Users/milkkarten/.prime/agent/session-artifacts/01a05fe9-d2a4-71a9-9556-da16f3cdef55/bun-linux-x64-1.4.0-input/extracted/bun";
		expect(createHash("sha256").update(readFileSync(bunPath)).digest("hex")).toBe(
			"33d56b070be6a9e3da0ab013038b43d1645d0534ca811ecdba4472599117eb4b",
		);
		expect(createHash("sha256").update(readFileSync(sourcePath)).digest("hex")).toBe(
			"993429588a4d64b05558ac64743bf82ee9b60e2c7ebb9cbbece389c9edae2293",
		);
		expect(createHash("sha256").update(readFileSync(harnessPath)).digest("hex")).toBe(
			"8f55f26572015b6cfcae8edc9a85d6f1b1ae38206f54a5e5b0572872280720ea",
		);
		expect(createHash("sha256").update(readFileSync(v5MainWireProbePath)).digest("hex")).toBe(
			"386a53507269e1a365f18b57cb6eff096685405be6cf5db406ee605275cad91d",
		);
		expect(createHash("sha256").update(readFileSync(v5ProbePath)).digest("hex")).toBe(
			"e05bf518f6b9be329c76aa361fca0af3bcc6bc3407b71107dc49ae9db5a752d8",
		);
		expect(createHash("sha256").update(readFileSync(faultInterpreterPath)).digest("hex")).toBe(
			"0f50f663a14ea24cc44bbe49da206ba873c0b88b9557ca491d2c81c2f88f2e14",
		);
		expect(createHash("sha256").update(readFileSync(faultControllerPath)).digest("hex")).toBe(
			"632df930511fc84a0f559fce381290ba5472092d1779d6be7da06c3570e8390c",
		);
		expect(createHash("sha256").update(readFileSync(rolloverInterpreterPath)).digest("hex")).toBe(
			"0f791c80ecea328500be5ddf4baa12ad1cdb15685c85b2b1eadb36f207918464",
		);
		expect(createHash("sha256").update(readFileSync(rolloverControllerPath)).digest("hex")).toBe(
			"5b03d227941753f7c7c34564381bdf208f8b7e75a0aeb5eb2cd740588ea7cdb7",
		);
		const image = "sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47";
		const runId = `${process.pid}-${Date.now()}`;
		const containerName = `hosted-store-v22-${runId}`;
		const timeoutContainerName = `hosted-store-v22-timeout-${runId}`;
		const faultContainerName = `hosted-store-v22-fault-${runId}`;
		const rolloverContainerName = `hosted-store-v22-rollover-${runId}`;
		const setup =
			"mkdir -p /chroot/tmp /chroot/usr /chroot/lib /chroot/lib64 /chroot/etc /chroot/proc /chroot/dev /chroot/app/src/modes/daemon/sandbox /chroot/root/.prime/agent /chroot/home; " +
			"cp -a /usr/local /chroot/usr/; cp -a /usr/lib /chroot/usr/; cp -a /lib/x86_64-linux-gnu /chroot/lib/; cp -a /lib64/ld-linux-x86-64.so.2 /chroot/lib64/; " +
			"cp /etc/passwd /etc/group /etc/nsswitch.conf /chroot/etc/; cp /input-bun /chroot/bun; chmod 755 /chroot/bun; " +
			"install -m0644 /input/hosted-session-store.ts /chroot/app/src/modes/daemon/sandbox/hosted-session-store.ts; " +
			"install -m0644 /input/hosted-child-ledger.ts /chroot/app/src/modes/daemon/sandbox/hosted-child-ledger.ts; " +
			"install -m0644 /input/hosted-session-wal.ts /chroot/app/src/modes/daemon/sandbox/hosted-session-wal.ts; " +
			"install -m0644 /input/prime-sandbox-strict-bytes.ts /chroot/app/src/modes/daemon/sandbox/prime-sandbox-strict-bytes.ts; " +
			"install -m0644 /input/hosted-session-store-posix-helper.py /chroot/app/src/modes/daemon/sandbox/hosted-session-store-posix-helper.py; " +
			"install -m0644 /input-harness.ts /chroot/app/integration.ts; install -m0600 /input-v5-probe.py /chroot/app/v5-protocol-probe.py; chmod 700 /chroot/root /chroot/root/.prime /chroot/root/.prime/agent; chmod 755 /chroot/home; chmod 1777 /chroot/tmp; " +
			'mount -t proc proc /chroot/proc; mount --rbind /dev /chroot/dev; test "$(chroot /chroot /bun --revision)" = "1.4.0+34cbb9a40"; chroot /chroot /usr/local/bin/python3 /app/v5-protocol-probe.py; chroot /chroot /bun /app/integration.ts';
		const dockerArguments = [
			"docker",
			"run",
			"--rm",
			"--name",
			containerName,
			"--pull",
			"never",
			"--network",
			"none",
			"--platform",
			"linux/amd64",
			"--privileged",
			"--tmpfs",
			"/chroot:rw,nosuid,nodev,exec,mode=0755,size=768m",
			"-v",
			`${sandboxDirectory}:/input:ro`,
			"-v",
			`${bunPath}:/input-bun:ro`,
			"-v",
			`${harnessPath}:/input-harness.ts:ro`,
			"-v",
			`${v5ProbePath}:/input-v5-probe.py:ro`,
			"-v",
			`${faultInterpreterPath}:/input-fault-python3:ro`,
			"-v",
			`${faultControllerPath}:/input-fault-controller.py:ro`,
			"-v",
			`${rolloverInterpreterPath}:/input-rollover-python3:ro`,
			"-v",
			`${rolloverControllerPath}:/input-rollover-controller.py:ro`,
			image,
			"/bin/sh",
			"-c",
			setup,
		];
		const wireSetup = setup.replace(
			"chroot /chroot /bun /app/integration.ts",
			"install -m0600 /input-v5-main-wire-probe.py /chroot/app/v5-main-fatal-wire-probe.py; chroot /chroot /usr/local/bin/python3 /app/v5-main-fatal-wire-probe.py; chroot /chroot /bun /app/integration.ts",
		);
		const wireArguments = dockerArguments.map((value) => {
			if (value === setup) return wireSetup;
			if (value === "/chroot:rw,nosuid,nodev,exec,mode=0755,size=768m")
				return "/chroot:rw,nosuid,nodev,exec,mode=0755,size=16g";
			if (value === "-c") return "-ec";
			return value;
		});
		wireArguments.splice(
			wireArguments.indexOf(image),
			0,
			"--read-only",
			"--cpus",
			"1",
			"--memory",
			"1g",
			"-v",
			`${v5MainWireProbePath}:/input-v5-main-wire-probe.py:ro`,
		);
		try {
			const { stdout, stderr } = await execFileAsync(
				hostPython,
				["-c", dockerSupervisorRunner, JSON.stringify(wireArguments), containerName, "90"],
				{ maxBuffer: 4 * 1024 * 1024 },
			);
			console.log(stdout);
			expect(stderr).toBe("");
			expect(stdout.split("\n").filter((line) => line.startsWith("WIRE_OK ")).length).toBe(46);
			expect(stdout).toContain("V5_MAIN_ABORT_WIRE_OK 46/46");
			expect(stdout).toContain("V5_RAW_PROTOCOL_OK");
			expect(stdout).toContain("V5_NONEMPTY_READY_OK");
			expect(stdout).toContain("V5_MATRIX_RUNNING_OK");
			expect(stdout).toContain("V5_MATRIX_TERMINAL_OK");
			expect(stdout).toContain("V5_MATRIX_N2_N8_OK");
			expect(stdout).toContain("V5_MATRIX_RESIDUE_GENERATION_OK");
			expect(stdout).toContain("V5_MATRIX_RESIDUE_LIFECYCLE_OK");
			expect(stdout).toContain("V5_MATRIX_RESIDUE_WAL_OK");
			expect(stdout).toContain("V5_MATRIX_RESIDUE_ROOT_OK");
			expect(stdout).toContain("V5_MATRIX_DURABILITY_OK");
			expect(stdout).toContain("V5_MATRIX_CROSSVERSION_OK");
			expect(stdout).toContain("V5_STARTUP_FACTORY_OK");
			expect(stdout).toContain("INTEGRATION_OK");

			const faultSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"mv /chroot/usr/local/bin/python3 /chroot/usr/local/bin/python3.real; install -m0755 /input-fault-python3 /chroot/usr/local/bin/python3; /usr/local/bin/python3 -u /input-fault-controller.py",
			);
			const faultArguments = dockerArguments.map((value) => {
				if (value === containerName) return faultContainerName;
				if (value === setup) return faultSetup;
				return value;
			});
			const { stdout: faultStdout } = await execFileAsync(
				hostPython,
				["-c", dockerSupervisorRunner, JSON.stringify(faultArguments), faultContainerName, "220"],
				{ maxBuffer: 4 * 1024 * 1024 },
			);
			for (const scenario of [
				"malformed-length",
				"malformed-payload",
				"trailing",
				"duplicate",
				"reordered",
				"late",
				"wrong-opcode",
				"stdout-overflow",
				"stderr-overflow",
				"v5-hello-protocol",
				"v5-hello-state",
				"v5-hello-busy",
				"v5-ready-wrong-opcode",
				"v5-ready-short",
				"v5-ready-wrong-magic",
				"v5-inventory-wrong-opcode",
				"v5-inventory-session",
				"v5-inventory-error",
				"v5-inventory-valid-progress-single",
				"v5-inventory-valid-progress-boundary",
				"v5-inventory-valid-progress-plan",
				"v5-inventory-valid-progress-plan-final-one",
				"v5-inventory-valid-progress-content",
				"v5-inventory-valid-progress-content-final-one",
				"v5-inventory-valid-progress-maximum",
				"v5-inventory-invalid-progress-plan-partial",
				"v5-inventory-invalid-progress-content-partial",
				"v5-inventory-invalid-progress-content-order",
				"v5-inventory-invalid-progress-plan-overrun",
				"v5-inventory-invalid-progress-content-overrun",
				"v5-inventory-invalid-progress-revision-high",
				"v5-inventory-invalid-progress-revision-overflow",
				"v5-inventory-invalid-vector-committed",
				"v5-inventory-invalid-attempt",
				"v5-inventory-valid-sealed",
				"v5-inventory-valid-sealed-opaque-zero",
				"v5-inventory-valid-sealed-mixed",
				"v5-inventory-invalid-sealed-tx",
				"v5-inventory-invalid-sealed-plan",
				"v5-inventory-invalid-sealed-content",
				"v5-inventory-invalid-sealed-state",
				"v5-inventory-invalid-sealed-kind",
				"v5-inventory-invalid-sealed-decision",
				"v5-inventory-invalid-sealed-terminal",
				"v5-inventory-invalid-sealed-ack",
				"v5-inventory-invalid-sealed-plan-committed",
				"v5-inventory-invalid-sealed-content-committed",
				"v5-inventory-invalid-sealed-vector-len",
				"v5-inventory-invalid-sealed-vector-committed",
				"v5-inventory-invalid-sealed-manifest",
				"v5-inventory-invalid-sealed-attempt",
				"v5-inventory-invalid-sealed-revision",
				"v5-inventory-invalid-sealed-vector-record",
				"v5-inventory-invalid-sealed-provenance",
				"v5-inventory-invalid-sealed-ordinal-zero",
				"v5-inventory-invalid-sealed-ordinal-present",
				"v5-inventory-invalid-sealed-reservation",
			])
				expect(faultStdout).toContain(`FAULT_CASE_OK ${scenario}`);

			const rolloverSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"mv /chroot/usr/local/bin/python3 /chroot/usr/local/bin/python3.real; install -m0755 /input-rollover-python3 /chroot/usr/local/bin/python3; /usr/local/bin/python3 /input-rollover-controller.py",
			);
			const rolloverArguments = dockerArguments.map((value) => {
				if (value === containerName) return rolloverContainerName;
				if (value === setup) return rolloverSetup;
				return value;
			});
			const { stdout: rolloverStdout } = await execFileAsync(
				hostPython,
				["-c", dockerSupervisorRunner, JSON.stringify(rolloverArguments), rolloverContainerName, "30"],
				{ maxBuffer: 4 * 1024 * 1024 },
			);
			expect(rolloverStdout).toContain("ROLLOVER_PUBLICATION_CUT_OK case3");
			expect(rolloverStdout).toContain("ROLLOVER_PUBLICATION_CUT_OK case4");

			const timeoutSetup = setup.replace(
				"chroot /chroot /bun /app/integration.ts",
				"chroot /chroot /bun /app/integration.ts timeout",
			);
			const timeoutArguments = dockerArguments.map((value) => {
				if (value === containerName) return timeoutContainerName;
				if (value === setup) return timeoutSetup;
				return value;
			});
			const { stdout: timeoutStdout } = await execFileAsync(
				hostPython,
				["-c", dockerSupervisorRunner, JSON.stringify(timeoutArguments), timeoutContainerName, "45"],
				{ maxBuffer: 4 * 1024 * 1024 },
			);
			expect(timeoutStdout).toContain("STORE_TIMEOUT_TERM_KILL_ESRCH_OK");
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	},
	415_000,
);
