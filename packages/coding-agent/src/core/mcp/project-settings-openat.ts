import { spawnSync } from "node:child_process";
import { constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { ensureKernelPython } from "../kernel/bootstrap.js";
import { type McpDeclarationDocument, parseMcpDeclarationDocument } from "./mcp-declarations.js";
import {
	type ProjectMcpDeclarationAdmission,
	withValidatedProjectMcpDeclarationAdmission,
} from "./mcp-project-trust.js";

const MAX_BYTES = 128 * 1024;
const TIMEOUT_MS = 5_000;

/** stdlib-only; receives a bounded action/document JSON on stdin and trusted root on fd 3. */
const OPENAT_HELPER = String.raw`import json, os, secrets, signal, stat, sys, time
MAX=131072
interrupted=False
cleaning=False
class Interrupted(Exception): pass
def interrupt(_signum,_frame):
 global interrupted
 interrupted=True
 # Raise outside cleanup so blocking Python operations unwind immediately.
 # Once authoritative cleanup starts, only record the signal and finish it.
 if not cleaning: raise Interrupted()
signal.signal(signal.SIGTERM,interrupt)
signal.signal(signal.SIGINT,interrupt)
# SIGKILL cannot run cleanup. Its lock deliberately remains fail-closed until
# manual removal, rather than permitting unsafe stale-lock reclamation.
def reject(_=None): raise ValueError("invalid")
def unique(pairs):
 d={}
 for k,v in pairs:
  if k in d: reject()
  d[k]=v
 return d
def load(raw): return json.loads(raw,parse_constant=reject,object_pairs_hook=unique)
def dflags(): return os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
def directory(parent,name,create):
 try: return os.open(name,dflags(),dir_fd=parent)
 except FileNotFoundError:
  if not create: raise
  os.mkdir(name,0o700,dir_fd=parent)
  return os.open(name,dflags(),dir_fd=parent)
def regular(parent,name,create=False):
 flags=os.O_RDONLY|os.O_NOFOLLOW
 if create: flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW
 fd=os.open(name,flags,0o600,dir_fd=parent)
 if not stat.S_ISREG(os.fstat(fd).st_mode): os.close(fd); reject()
 return fd
def read(agent):
 try: fd=regular(agent,"settings.json")
 except FileNotFoundError: return {}
 try:
  data=bytearray()
  while True:
   part=os.read(fd,65536)
   if not part: break
   data.extend(part)
   if len(data)>MAX: reject()
  doc=load(bytes(data).decode("utf-8"))
  if not isinstance(doc,dict): reject()
  return doc
 finally: os.close(fd)
def acquire(agent):
 deadline=time.monotonic()+0.25
 while True:
  try:
   os.mkdir("settings.json.lock",0o700,dir_fd=agent)
   try: return directory(agent,"settings.json.lock",False)
   except Exception:
    try: os.rmdir("settings.json.lock",dir_fd=agent)
    finally: raise
  except FileExistsError:
   # Retry only a genuine no-follow directory owned by another participant.
   # Regular files and symlinks are hostile/legacy poison and fail closed.
   try: existing=directory(agent,"settings.json.lock",False)
   except FileNotFoundError:
    if time.monotonic()>=deadline: reject()
    continue
   os.close(existing)
   if time.monotonic()>=deadline: reject()
   time.sleep(0.02)
def write(agent,declarations):
 owned=False; lockdir=None; temp=None; tempname=None
 try:
  blocked={signal.SIGTERM,signal.SIGINT}
  previous=signal.pthread_sigmask(signal.SIG_BLOCK,blocked)
  try: lockdir=acquire(agent); owned=True
  finally: signal.pthread_sigmask(signal.SIG_SETMASK,previous)
  doc=read(agent); doc["mcpDeclarations"]=declarations
  raw=(json.dumps(doc,ensure_ascii=False,allow_nan=False,indent=2,separators=(",", ":"))+"\n").encode("utf-8")
  if len(raw)>MAX: reject()
  for _ in range(16):
   candidate=".settings.json."+secrets.token_hex(16)+".tmp"
   try: temp=regular(agent,candidate,True); tempname=candidate; break
   except FileExistsError: pass
  if temp is None: reject()
  try:
   offset=0
   while offset<len(raw):
    count=os.write(temp,raw[offset:])
    if count<=0: reject()
    offset+=count
   os.fsync(temp)
  finally: os.close(temp); temp=None
  os.replace(tempname,"settings.json",src_dir_fd=agent,dst_dir_fd=agent); tempname=None; os.fsync(agent)
 finally:
  global cleaning
  cleaning=True
  if temp is not None: os.close(temp)
  if tempname is not None:
   try: os.unlink(tempname,dir_fd=agent)
   except FileNotFoundError: pass
  if lockdir is not None:
   # Match proper-lockfile's cooperative same-user protocol. POSIX has no
   # portable identity-bound rmdir-by-fd; a project owner can already replace
   # either participant's lock path. We never follow it and fail closed when
   # this immediate no-follow identity check detects a mismatch.
   opened=os.fstat(lockdir)
   try: named=os.stat("settings.json.lock",dir_fd=agent,follow_symlinks=False)
   except FileNotFoundError: named=None
   if named is None or not stat.S_ISDIR(named.st_mode) or opened.st_dev!=named.st_dev or opened.st_ino!=named.st_ino:
    os.close(lockdir); lockdir=None; reject()
  if owned: os.rmdir("settings.json.lock",dir_fd=agent)
  if lockdir is not None: os.close(lockdir)
 cleaning=False
 if interrupted: raise Interrupted()
def main():
 raw=sys.stdin.buffer.read(MAX+1)
 if len(raw)>MAX: reject()
 request=load(raw.decode("utf-8"))
 if not isinstance(request,dict) or set(request)-{"action","document"}: reject()
 action=request.get("action")
 if not stat.S_ISDIR(os.fstat(3).st_mode): reject()
 prime=agent=None
 try:
  try: prime=directory(3,".prime",action=="write"); agent=directory(prime,"agent",action=="write")
  except FileNotFoundError:
   if action=="read": print("{}"); return
   raise
  if action=="read":
   doc=read(agent)
   # Omission is the sole encoding for an absent declaration setting. This
   # preserves an explicitly stored JSON null for the TypeScript parser to
   # reject rather than conflating it with a fresh project.
   if "mcpDeclarations" in doc:
    print(json.dumps({"mcpDeclarations":doc["mcpDeclarations"]},ensure_ascii=False,allow_nan=False,separators=(",", ":")))
   else: print("{}")
  elif action=="write" and "document" in request: write(agent,request["document"]); print("{}")
  else: reject()
 finally:
  if agent is not None: os.close(agent)
  if prime is not None: os.close(prime)
try: main()
except Exception: sys.stderr.write("project settings helper failed\n"); sys.exit(1)
`;

function unavailable(): never {
	// Never expose request, child stderr, settings, paths, or bootstrap diagnostics.
	throw new Error("Project MCP declarations are unavailable.");
}

/** The managed kernel resolver is host authority and is never called pre-admission. */
export async function resolveTrustedProjectSettingsPython(): Promise<string> {
	try {
		const python = await ensureKernelPython();
		if (typeof python !== "string" || !isAbsolute(python)) unavailable();
		const resolved = realpathSync.native(python);
		const target = statSync(resolved);
		if (!target.isFile() || (target.mode & constants.S_IXUSR) === 0) unavailable();
		return resolved;
	} catch {
		unavailable();
	}
}

/** POSIX descriptor-relative project settings storage; it has no project path API. */
export class ProjectSettingsOpenat {
	private constructor(
		private readonly admission: ProjectMcpDeclarationAdmission,
		private readonly python: string,
	) {}

	static async create(admission: ProjectMcpDeclarationAdmission): Promise<ProjectSettingsOpenat> {
		// This genuine capability check intentionally occurs before interpreter discovery.
		if (withValidatedProjectMcpDeclarationAdmission(admission, () => true) !== true) unavailable();
		return new ProjectSettingsOpenat(admission, await resolveTrustedProjectSettingsPython());
	}

	private invoke(request: { action: "read" } | { action: "write"; document: McpDeclarationDocument }): unknown {
		let input: string;
		try {
			input = JSON.stringify(request);
		} catch {
			unavailable();
		}
		if (Buffer.byteLength(input) > MAX_BYTES) unavailable();
		try {
			const result = withValidatedProjectMcpDeclarationAdmission(this.admission, (rootFd) =>
				spawnSync(this.python, ["-I", "-c", OPENAT_HELPER], {
					input,
					encoding: "utf8",
					timeout: TIMEOUT_MS,
					// A signal racing after os.replace may report failure even though the
					// atomic commit landed; SIGKILL leaves the lock for manual cleanup.
					maxBuffer: MAX_BYTES,
					stdio: ["pipe", "pipe", "pipe", rootFd],
					shell: false,
				}),
			);
			if (
				!result ||
				result.error ||
				result.status !== 0 ||
				typeof result.stdout !== "string" ||
				Buffer.byteLength(result.stdout) > MAX_BYTES
			)
				unavailable();
			try {
				return JSON.parse(result.stdout);
			} catch {
				unavailable();
			}
		} catch {
			unavailable();
		}
	}

	getDocument(): McpDeclarationDocument {
		const response = this.invoke({ action: "read" });
		if (typeof response !== "object" || response === null || Array.isArray(response)) unavailable();
		const keys = Object.keys(response);
		if (keys.length > 1 || (keys.length === 1 && keys[0] !== "mcpDeclarations")) unavailable();
		try {
			// The helper omits this member only when the directory or setting is
			// genuinely absent. An explicit stored null remains data and is rejected
			// by the declaration parser below.
			return parseMcpDeclarationDocument(
				Object.hasOwn(response, "mcpDeclarations")
					? (response as { mcpDeclarations: unknown }).mcpDeclarations
					: undefined,
			);
		} catch {
			unavailable();
		}
	}

	setDocument(document: McpDeclarationDocument): void {
		let parsed: McpDeclarationDocument;
		try {
			parsed = parseMcpDeclarationDocument(document);
		} catch {
			unavailable();
		}
		this.invoke({ action: "write", document: parsed! });
	}
}
