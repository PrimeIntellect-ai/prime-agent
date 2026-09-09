import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const HELPER = fileURLToPath(
	new URL("../src/modes/daemon/sandbox/hosted-session-store-posix-helper.py", import.meta.url),
);

const execFileAsync = promisify(execFile);

interface PythonFunction {
	header: string;
	body: string;
	startLine: number;
}

function pythonFunction(source: string, name: string): PythonFunction {
	const lines = source.split("\n");
	const prefix = `def ${name}(`;
	let start = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (lines[index]?.startsWith(prefix) === true) {
			start = index;
			break;
		}
	}
	if (start < 0) return { header: "", body: "", startLine: 0 };
	let headerEnd = start;
	while (headerEnd < lines.length && lines[headerEnd]?.endsWith(":") !== true) headerEnd += 1;
	let end = headerEnd + 1;
	while (end < lines.length) {
		const line = lines[end] ?? "";
		if (/^(def|class) [A-Za-z0-9_]+/.test(line)) break;
		end += 1;
	}
	return {
		header: lines.slice(start, headerEnd + 1).join("\n"),
		body: lines.slice(headerEnd + 1, end).join("\n"),
		startLine: start + 1,
	};
}

function count(text: string, token: string): number {
	let found = 0;
	let offset = 0;
	while (offset <= text.length) {
		const index = text.indexOf(token, offset);
		if (index < 0) break;
		found += 1;
		offset = index + token.length;
	}
	return found;
}

function tokensInOrder(text: string, tokens: readonly string[]): boolean {
	let prior = -1;
	for (const token of tokens) {
		const index = text.indexOf(token, prior + 1);
		if (index <= prior) return false;
		prior = index;
	}
	return true;
}

describe("hosted session Store POSIX helper V7 WS_ABORT_DRAFT", () => {
	const linuxProbeTest = process.platform === "linux" ? test : test.skip;

	test("V5 WS_ABORT_DRAFT decoder, dispatch, and abort-table source stay exact", async () => {
		const source = await readFile(HELPER, "utf8");
		for (const exact of [
			"_WS_ABORT_DRAFT = 0x0C",
			"def _cmd_ws_abort_draft(",
			"_V5_OPCODES = frozenset((_V5_HELLO, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17))",
		])
			expect(source).toContain(exact);

		const decoder = pythonFunction(source, "_v5_validate_request").body;
		expect(decoder).toContain(`if opcode == _WS_ABORT_DRAFT:
        if len(payload) != 137:
            return _E_INPUT
        stream_kind = payload[128]
        if stream_kind not in (1, 3):
            return _E_INPUT
        if _range_zero(payload, 96, 128):
            return _E_INPUT
        return None`);

		const dispatch = pythonFunction(source, "_dispatch_v5").body;
		expect(
			tokensInOrder(dispatch, [
				"if opcode == _V5_HELLO:",
				"err = _v5_validate_request(opcode, payload)",
				"if opcode == _WS_INVENTORY:",
				"if opcode == _WS_INSPECT:",
				"if opcode == _WS_BEGIN:",
				"return _cmd_ws_begin(",
				"if opcode == _WS_WRITE_STREAM:",
				"return _cmd_ws_write_stream(",
				"if opcode == _WS_ABORT_DRAFT:",
				"return _cmd_ws_abort_draft(",
				'return (v5_mode, "error", _E_ABSENT)',
			]),
		).toBe(true);

		const command = pythonFunction(source, "_cmd_ws_abort_draft").body;
		expect(
			tokensInOrder(command, [
				"lifecycle = payload[0:32]",
				"items, unused_outstanding = _v5_collect_inventory(",
				"selector = memoryview(payload)[:128]",
				"selector.release()",
				"if matched is None:",
				'return (v5_mode, "error", _E_STALE)',
				'return (v5_mode, "error", _E_ABSENT)',
				"if stream_kind == 3:",
				"lifecycle_dir_fd, open_error = _open_dir(fds, root_fd, lifecycle_name, uid, device)",
				"allow_v5_evidence=True",
				"current_generation = scan[7]",
				"if not _same_at(payload, 32, current_generation):",
				"_find_generation(scan[6], _hex_name(current_generation))",
				"evidence_fd, evidence_error = _open_dir(fds, generation_fd, _WORKSPACE_EVIDENCE, uid, device)",
				"entries = _list(evidence_fd)",
				"if len(entries) != 3 or _INPUT_MANIFEST not in entries:",
				"_v5_random_suffix(entry, _PLAN_DRAFT_PREFIX)",
				"_v5_random_suffix(entry, _CONTENT_DRAFT_PREFIX)",
				"if plan_name is None or content_name is None or plan_suffix is None or content_suffix is None:",
				"plan_fd, plan_error = _v5_open_rw_file(",
				"content_fd, content_error = _v5_open_rw_file(",
				"manifest_fd, manifest_error = _open_file(",
				"plan_stat = _fstat(plan_fd)",
				"content_stat = _fstat(content_fd)",
				"manifest_stat = _fstat(manifest_fd)",
				"_validate_file_stat(plan_stat, uid, device)",
				"_validate_file_stat(content_stat, uid, device)",
				"_validate_file_stat(manifest_stat, uid, device)",
				"_v5_same_inode(plan_stat, content_stat) or _v5_same_inode(plan_stat, manifest_stat) or _v5_same_inode(content_stat, manifest_stat)",
				"plan_data = _v5_read_open_file(plan_fd, _PLAN_HEADER_SIZE)",
				"content_data = _v5_read_open_file(content_fd, _CONTENT_HEADER_SIZE)",
				"manifest_data = _v5_read_open_file(manifest_fd, _INPUT_MANIFEST_SIZE)",
				"_v5_header_prefix(",
				"progress_tuple = _v5_input_manifest_progress(",
				"if progress_tuple is None:",
				"plan_committed = progress_tuple[1]",
				"content_committed = progress_tuple[2]",
				"if plan_stat.st_size != _PLAN_HEADER_SIZE + plan_committed:",
				"if content_stat.st_size != _CONTENT_HEADER_SIZE + content_committed:",
				"_v5_validate_inventory_name(",
				"if not _same_at(manifest_data, 80, payload[64:128]):",
				"if not _same_at(manifest_data, 8, payload[129:137]):",
				"_unlink(evidence_fd, content_name)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, content_name)",
				"_unlink(evidence_fd, plan_name)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, plan_name)",
				"_unlink(evidence_fd, _INPUT_MANIFEST)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, _INPUT_MANIFEST)",
				"if len(_list(evidence_fd)) != 0:",
				"fds.close(content_fd)",
				"fds.close(plan_fd)",
				"fds.close(manifest_fd)",
				"fds.close(evidence_fd)",
				"_rmdir(generation_fd, _WORKSPACE_EVIDENCE)",
				"_fsync(generation_fd)",
				"_v5_require_absent(generation_fd, _WORKSPACE_EVIDENCE)",
				"_close_scan(fds, scan)",
				"fds.close(lifecycle_dir_fd)",
				"if fds.uncertain:",
				"raise Fatal(_E_UNCERTAIN)",
				"response = bytearray(2)",
				"response[0] = _WS_ABORT_DRAFT",
				"response[1] = stream_kind",
				"_write_frame(1, _OK, response)",
				'return (v5_mode, "emitted", None)',
			]),
		).toBe(true);
		expect(command).toContain(`if stream_kind == 3:
            return (v5_mode, "error", _E_ABSENT)`);
		expect(command).not.toContain("_same_at(matched, 204, payload[129:137])");
		expect(command).toContain(`if not _same_at(manifest_data, 80, payload[64:128]):
            return (v5_mode, "error", _E_STALE)
        if not _same_at(manifest_data, 8, payload[129:137]):
            return (v5_mode, "error", _E_STALE)`);
		expect(command).toContain(`        _unlink(evidence_fd, content_name)
        _fsync(evidence_fd)
        _v5_require_absent(evidence_fd, content_name)
        _unlink(evidence_fd, plan_name)
        _fsync(evidence_fd)
        _v5_require_absent(evidence_fd, plan_name)
        _unlink(evidence_fd, _INPUT_MANIFEST)
        _fsync(evidence_fd)
        _v5_require_absent(evidence_fd, _INPUT_MANIFEST)`);
		expect(command).toContain(`    finally:
        if response is not None:
            _zero(response)
        if manifest_data is not None:
            _zero(manifest_data)
        if content_data is not None:
            _zero(content_data)
        if plan_data is not None:
            _zero(plan_data)
        if content_suffix is not None:
            _zero(content_suffix)
        if plan_suffix is not None:
            _zero(plan_suffix)
        if manifest_fd is not None:
            fds.close(manifest_fd)
        if content_fd is not None:
            fds.close(content_fd)
        if plan_fd is not None:
            fds.close(plan_fd)
        if evidence_fd is not None:
            fds.close(evidence_fd)
        if scan is not None:
            _close_scan(fds, scan)
        if lifecycle_dir_fd is not None:
            fds.close(lifecycle_dir_fd)
        if items is not None:
            _v5_zero_transactions(items)
        if lifecycle is not None:
            _zero(lifecycle)
        fds.close_after(mark)
        if fds.mark() != mark or fds.uncertain:
            raise Fatal(_E_UNCERTAIN)`);
		expect(count(command, "_unlink(")).toBe(3);
		expect(count(command, "_rmdir(")).toBe(1);
		expect(count(command, "_v5_require_absent(")).toBe(4);
		expect(count(command, 'return (v5_mode, "error", _E_STALE)')).toBe(3);
		for (const forbidden of [
			"os.statvfs",
			"_v5_available_bytes",
			"_ok_payload",
			"os.link",
			"os.mkdir",
			"os.rename",
			"_make_dir",
			"_write_temp",
			"_publish_record",
			"_publish_head",
			"_E_QUOTA",
			"_fdatasync",
			"_v5_create_nonce_file",
			"_v5_write_prefix",
			"_v5_write_at",
			"_v5_truncate_suffix",
			"_remove_generation_suffix",
			"_rollback_unpublished",
			"_recover_purge_suffix",
		])
			expect(command).not.toContain(forbidden);

		const recovery = pythonFunction(source, "_v5_recover_input_begin_prefix").body;
		expect(
			tokensInOrder(recovery, [
				"if progress_name is not None and not canonical_present:",
				"if canonical_present and manifest_name is None and progress_name is None and content_name is None:",
				"abort_manifest_fd, abort_manifest_error = _open_file(",
				"abort_manifest_stat = _fstat(abort_manifest_fd)",
				"abort_manifest_data = _v5_read_open_file(abort_manifest_fd, _INPUT_MANIFEST_SIZE)",
				"_v5_prefix_field(abort_manifest_data, 0, _INPUT_MANIFEST_MAGIC)",
				"_v5_prefix_field(abort_manifest_data, 16, lifecycle)",
				"_v5_prefix_field(abort_manifest_data, 48, generation)",
				"_range_zero(abort_manifest_data, 112, 144)",
				"_v5_prefix_field(abort_manifest_data, 268, bytes(4))",
				"abort_plan_nonce = abort_manifest_data[188:220]",
				"abort_content_nonce = abort_manifest_data[220:252]",
				"_all_zero(abort_plan_nonce) or _all_zero(abort_content_nonce)",
				"_same(abort_plan_nonce, abort_content_nonce)",
				'abort_plan_length = struct.unpack_from(">I", abort_manifest_data, 176)[0]',
				'abort_content_length = struct.unpack_from(">Q", abort_manifest_data, 180)[0]',
				"abort_plan_length < 1 or abort_plan_length > _MAX_PLAN_PAYLOAD",
				"abort_content_length > _MAX_CONTENT_PAYLOAD",
				'abort_revision = struct.unpack_from(">Q", abort_manifest_data, 8)[0]',
				'abort_plan_committed = struct.unpack_from(">Q", abort_manifest_data, 252)[0]',
				'abort_content_committed = struct.unpack_from(">Q", abort_manifest_data, 260)[0]',
				"_v5_canonical_end(abort_plan_committed, abort_plan_length)",
				"_v5_canonical_end(abort_content_committed, abort_content_length)",
				"abort_plan_committed < abort_plan_length and abort_content_committed != 0",
				"abort_revision != _v5_chunk_count(abort_plan_committed) + _v5_chunk_count(abort_content_committed)",
				"if plan_name is not None:",
				"_same(plan_suffix, abort_plan_nonce)",
				"abort_plan_fd, abort_plan_error = _open_file(",
				"abort_plan_stat = _fstat(abort_plan_fd)",
				"abort_plan_stat.st_size < _PLAN_HEADER_SIZE",
				"abort_valid, abort_complete, abort_header_length = _v5_header_prefix(",
				"abort_header_length != abort_plan_length",
				"abort_plan_stat.st_size != _PLAN_HEADER_SIZE + abort_plan_committed",
				"_v5_same_inode(abort_plan_stat, abort_manifest_stat)",
				"evidence_fd, plan_name, abort_plan_stat, uid, device, abort_plan_stat.st_size",
				"evidence_fd, _INPUT_MANIFEST, abort_manifest_stat, uid, device, _INPUT_MANIFEST_SIZE",
				"_unlink(evidence_fd, plan_name)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, plan_name)",
				"_unlink(evidence_fd, _INPUT_MANIFEST)",
				"_fsync(evidence_fd)",
				"_v5_require_absent(evidence_fd, _INPUT_MANIFEST)",
				"if len(_list(evidence_fd)) != 0:",
				"fds.close_for_recovery(abort_plan_fd)",
				"fds.close_for_recovery(abort_manifest_fd)",
				"fds.close_for_recovery(evidence_fd)",
				"_rmdir(generation_fd, _WORKSPACE_EVIDENCE)",
				"_fsync(generation_fd)",
				"_v5_require_absent(generation_fd, _WORKSPACE_EVIDENCE)",
				"return True",
				"plan_complete = False",
				"if plan_name is None:",
			]),
		).toBe(true);
		expect(recovery).toContain(
			"if canonical_present and manifest_name is None and progress_name is None and content_name is None:",
		);
		expect(recovery).toContain(`                    if not _same(plan_suffix, abort_plan_nonce):
                        raise Fatal(_E_STATE)`);
		expect(recovery).toContain(`                if abort_plan_fd is not None:
                    fds.close_for_recovery(abort_plan_fd)
                    abort_plan_fd = None
                fds.close_for_recovery(abort_manifest_fd)
                abort_manifest_fd = None
                fds.close_for_recovery(evidence_fd)
                evidence_fd = None
                _rmdir(generation_fd, _WORKSPACE_EVIDENCE)`);
		expect(count(recovery, "_v5_require_absent(")).toBe(9);
		expect(count(recovery, "_unlink(")).toBe(7);
		expect(count(recovery, "_rmdir(")).toBe(2);

		const main = pythonFunction(source, "main").body;
		expect(main).toContain(`if current_opcode != 0 and not (v5_wire and kind in ("emitted", "done")):`);
		expect(main).toContain(`if v5_wire and fixed_code != _E_PROTOCOL:
                    fixed_code = _E_IO`);
	});

	test("V5 abort restart suffixes validate the before-state and out-of-order members stay fatal", async () => {
		const probe = `import importlib.util,os,shutil,stat,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_abort_suffix_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
plan_nonce=bytes((7,))*32;content_nonce=bytes((8,))*32
plan=b"PIWSPLN1"+struct.pack(">I",17)
content=b"PIWSCNT1"+struct.pack(">Q",23)
manifest=b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20)
plan_name=".ws-plan."+plan_nonce.hex()
content_name=".ws-content."+content_nonce.hex()
temp_name=".ws-input-manifest-tmp."+(bytes((9,))*32).hex()
progress_name=".ws-input-progress-tmp."+(bytes((10,))*32).hex()
other_plan_name=".ws-plan."+(bytes((11,))*32).hex()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
count=0
def write_exact(path,data,mode=0o600):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  offset=0
  while offset<len(data):
   written=os.write(fd,data[offset:])
   if written<=0:raise RuntimeError("write")
   offset+=written
 finally:os.close(fd)
def entries_for(members):
 names=[]
 if "plan" in members:names.append(plan_name)
 if "content" in members:names.append(content_name)
 if "manifest" in members:names.append("input.manifest")
 if "manifest-temp" in members:names.append(temp_name)
 return sorted(names)
def build(members):
 root=tempfile.mkdtemp(prefix="store-v5-abort-suffix-",dir=parent)
 generation_path=os.path.join(root,"generation")
 os.mkdir(generation_path,0o700)
 evidence_path=os.path.join(generation_path,"workspace-evidence")
 if members is not None:
  os.mkdir(evidence_path,0o700)
  if "plan" in members:write_exact(os.path.join(evidence_path,plan_name),plan)
  if "content" in members:write_exact(os.path.join(evidence_path,content_name),content)
  if "manifest" in members:write_exact(os.path.join(evidence_path,"input.manifest"),manifest)
  if "manifest-temp" in members:write_exact(os.path.join(evidence_path,temp_name),manifest)
 return root,generation_path,evidence_path
def snapshot(path):
 names=sorted(os.listdir(path))
 result=[]
 for name in names:
  full=os.path.join(path,name)
  info=os.lstat(full)
  if stat.S_ISLNK(info.st_mode):result.append((name,"link",oct(info.st_mode),os.readlink(full)))
  elif stat.S_ISDIR(info.st_mode):result.append((name,"dir",oct(info.st_mode),None))
  else:result.append((name,"file",oct(info.st_mode),open(full,"rb").read()))
 return names,result
def run(label,members,expect,unlink_first=()):
 global count
 root=None;fds=None
 try:
  root,generation_path,evidence_path=build(members)
  for name in unlink_first:os.unlink(os.path.join(evidence_path,name))
  generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  fds=module.Fds();fds.add(generation_fd)
  seen=[]
  result=None
  try:
   result=module._v5_recover_input_begin_prefix(fds,generation_fd,lifecycle,generation,os.getuid(),os.fstat(generation_fd).st_dev)
  except module.Fatal as failure:
   seen.append(failure.code)
  if generation_fd in fds.items:fds.close(generation_fd)
  if fds.uncertain or fds.items!=[]:raise RuntimeError(label+"-fds")
  if expect=="fatal":
   if seen!=[module._E_STATE] or result is not None:raise RuntimeError(label)
   if sorted(os.listdir(evidence_path))!=entries_for(members):raise RuntimeError(label+"-untouched")
  elif expect=="preserve":
   if result is not True or seen!=[]:raise RuntimeError(label)
   if not os.path.isdir(evidence_path) or sorted(os.listdir(evidence_path))!=entries_for(members):raise RuntimeError(label+"-entries")
  elif expect=="complete":
   if result is not True or seen!=[]:raise RuntimeError(label)
   if os.path.exists(evidence_path):raise RuntimeError(label+"-presence")
  else:
   if result is not False or seen!=[] or os.path.exists(evidence_path):raise RuntimeError(label)
  count+=1
 finally:
  if fds is not None:fds.close_all()
  if root is not None:shutil.rmtree(root,ignore_errors=True)
def hostile(label,files,code,post=None):
 global count
 root=None;fds=None
 try:
  root=tempfile.mkdtemp(prefix="store-v5-abort-hostile-",dir=parent)
  generation_path=os.path.join(root,"generation")
  os.mkdir(generation_path,0o700)
  evidence_path=os.path.join(generation_path,"workspace-evidence")
  os.mkdir(evidence_path,0o700)
  for spec in files:
   name=spec[0];kind=spec[1];payload=spec[2]
   full=os.path.join(evidence_path,name)
   if kind=="file":
    write_exact(full,payload,spec[3] if len(spec)>3 else 0o600)
   elif kind=="symlink":
    os.symlink(payload,full)
   else:
    os.mkdir(full,0o700)
  if post is not None:post(evidence_path,generation_path)
  before_names,before=snapshot(evidence_path)
  generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  fds=module.Fds();fds.add(generation_fd)
  seen=[]
  result=None
  try:
   result=module._v5_recover_input_begin_prefix(fds,generation_fd,lifecycle,generation,os.getuid(),os.fstat(generation_fd).st_dev)
  except module.Fatal as failure:
   seen.append(failure.code)
  if generation_fd in fds.items:fds.close(generation_fd)
  if fds.uncertain or fds.items!=[]:raise RuntimeError(label+"-fds")
  if seen!=[code] or result is not None:raise RuntimeError(label+"-code "+repr(seen))
  after_names,after=snapshot(evidence_path)
  if after_names!=before_names or after!=before:raise RuntimeError(label+"-unchanged")
  count+=1
 finally:
  if fds is not None:fds.close_all()
  if root is not None:shutil.rmtree(root,ignore_errors=True)
def mm():
 return bytearray(b"PIWSIMF5"+bytes(8)+bytes(lifecycle)+bytes(generation)+binding+tx+plan_digest+struct.pack(">I",17)+struct.pack(">Q",23)+plan_nonce+content_nonce+bytes(20))
def bad_magic(d):d[0:8]=b"PIWSIMF4"
def bad_lifecycle(d):d[16:48]=bytes(range(200,232))
def bad_generation(d):d[48:80]=bytes(range(200,232))
def bad_tx(d):d[112:144]=bytes(32)
def bad_reserved(d):d[268]=1
def bad_zero_plan_nonce(d):d[188:220]=bytes(32)
def bad_zero_content_nonce(d):d[220:252]=bytes(32)
def bad_equal_nonce(d):d[220:252]=plan_nonce
def bad_plan_length_zero(d):struct.pack_into(">I",d,176,0)
def bad_plan_length_large(d):struct.pack_into(">I",d,176,1048577)
def bad_content_length_large(d):struct.pack_into(">Q",d,180,1073741825)
def bad_plan_committed(d):struct.pack_into(">Q",d,252,5)
def bad_interleave(d):struct.pack_into(">Q",d,260,23)
def bad_revision(d):struct.pack_into(">Q",d,8,2)
def post_outalias(evidence_path,generation_path):
 os.link(os.path.join(evidence_path,"input.manifest"),os.path.join(generation_path,"outside-alias"))
def post_plan_alias(evidence_path,generation_path):
 os.link(os.path.join(evidence_path,"input.manifest"),os.path.join(evidence_path,plan_name))
manifest_corruptions=[
 ("magic",bad_magic),("lifecycle",bad_lifecycle),("generation",bad_generation),("zero-tx",bad_tx),("reserved",bad_reserved),("zero-plan-nonce",bad_zero_plan_nonce),("zero-content-nonce",bad_zero_content_nonce),("equal-nonces",bad_equal_nonce),("plan-length-zero",bad_plan_length_zero),("plan-length-large",bad_plan_length_large),("content-length-large",bad_content_length_large),("plan-committed-noncanonical",bad_plan_committed),("interleave",bad_interleave),("revision",bad_revision),
]
for name,mutator in manifest_corruptions:
 data=mm();mutator(data)
 hostile("ai01-manifest-"+name,[(plan_name,"file",plan),("input.manifest","file",bytes(data))],module._E_STATE)
 data=mm();mutator(data)
 hostile("ai03-manifest-"+name,[("input.manifest","file",bytes(data))],module._E_STATE)
hostile("ai01-manifest-truncated",[(plan_name,"file",plan),("input.manifest","file",bytes(mm()[:100]))],module._E_BOUNDS)
hostile("ai01-manifest-oversized",[(plan_name,"file",plan),("input.manifest","file",bytes(mm()+bytes(1)))],module._E_BOUNDS)
hostile("ai01-manifest-symlink",[(plan_name,"file",plan),("input.manifest","symlink",plan_name)],module._E_SYMLINK)
hostile("ai01-manifest-mode",[(plan_name,"file",plan),("input.manifest","file",bytes(mm()),0o644)],module._E_MODE)
hostile("ai01-manifest-directory",[(plan_name,"file",plan),("input.manifest","dir",None)],module._E_TYPE)
hostile("ai01-manifest-nlink",[(plan_name,"file",plan),("input.manifest","file",bytes(mm()))],module._E_NLINK,post_outalias)
hostile("ai03-manifest-truncated",[("input.manifest","file",bytes(mm()[:100]))],module._E_BOUNDS)
hostile("ai03-manifest-oversized",[("input.manifest","file",bytes(mm()+bytes(1)))],module._E_BOUNDS)
hostile("ai03-manifest-symlink",[("input.manifest","symlink",plan_name)],module._E_SYMLINK)
hostile("ai03-manifest-mode",[("input.manifest","file",bytes(mm()),0o644)],module._E_MODE)
hostile("ai03-manifest-directory",[("input.manifest","dir",None)],module._E_TYPE)
hostile("ai03-manifest-nlink",[("input.manifest","file",bytes(mm()))],module._E_NLINK,post_outalias)
hostile("ai01-plan-name-nonce",[(other_plan_name,"file",plan),("input.manifest","file",bytes(mm()))],module._E_STATE)
hostile("ai01-plan-header-magic",[(plan_name,"file",b"PIWSPLN0"+struct.pack(">I",17)),("input.manifest","file",bytes(mm()))],module._E_STATE)
hostile("ai01-plan-header-length",[(plan_name,"file",b"PIWSPLN1"+struct.pack(">I",18)),("input.manifest","file",bytes(mm()))],module._E_STATE)
hostile("ai01-plan-size-extra",[(plan_name,"file",plan+b"X"),("input.manifest","file",bytes(mm()))],module._E_STATE)
hostile("ai01-plan-truncated",[(plan_name,"file",b"PIWSPLN1"+bytes(3)),("input.manifest","file",bytes(mm()))],module._E_STATE)
hostile("ai01-plan-symlink",[(plan_name,"symlink","input.manifest"),("input.manifest","file",bytes(mm()))],module._E_SYMLINK)
hostile("ai01-plan-mode",[(plan_name,"file",plan,0o644),("input.manifest","file",bytes(mm()))],module._E_MODE)
hostile("ai01-plan-directory",[(plan_name,"dir",None),("input.manifest","file",bytes(mm()))],module._E_TYPE)
hostile("ai01-plan-alias",[("input.manifest","file",bytes(mm()))],module._E_NLINK,post_plan_alias)
short=mm();struct.pack_into(">Q",short,8,1);struct.pack_into(">Q",short,252,17)
hostile("ai01-plan-size-short",[(plan_name,"file",plan),("input.manifest","file",bytes(short))],module._E_STATE)
hostile("r-state-corrupt-temp",[(plan_name,"file",plan),(content_name,"file",content),("input.manifest","file",manifest),(progress_name,"file",manifest)],module._E_STATE)
run("complete-draft",("plan","content","manifest"),"preserve")
run("ai01-ai02-suffix",("plan","manifest"),"complete")
run("ai03-ai04-suffix",("manifest",),"complete")
run("ai05-ai06-suffix",(),"complete")
run("ai07-ai08-suffix",None,"false")
run("out-of-order-content-manifest",("content","manifest"),"fatal")
run("out-of-order-content",("content",),"fatal")
run("begin-prefix-plan",("plan",),"complete")
run("suffix-extra-temp",("plan","manifest","manifest-temp"),"fatal")
run("ai01-cut",("plan","content","manifest"),"complete",(content_name,))
run("ai03-cut",("plan","content","manifest"),"complete",(content_name,plan_name))
run("ai05-cut",("plan","content","manifest"),"complete",(content_name,plan_name,"input.manifest"))
print("V5_ABORT_SUFFIX_MATRIX_OK %d"%count)
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 60_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_ABORT_SUFFIX_MATRIX_OK 63\n");
	});

	linuxProbeTest(
		"V5 WS_ABORT_DRAFT aborts a real draft with exact authority arms and releases the reservation",
		async () => {
			const probe = `import importlib.util,os,shutil,struct,sys,tempfile
spec=importlib.util.spec_from_file_location("store_v5_abort_command_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
abort_frame=struct.pack(">BI",0x80,2)+bytes((0x0C,1))
begin_frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def begin_request():
 payload=bytearray(172);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128:160]=plan_digest;struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
 return payload
def abort_request(kind=1,revision=0):
 payload=bytearray(137);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128]=kind;struct.pack_into(">Q",payload,129,revision)
 return payload
root=tempfile.mkdtemp(prefix="store-v5-abort-command-",dir=parent)
fds=None
try:
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=module.Fds();fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("lock")
 genesis=bytes(range(64));identity_digest=module._digest(genesis)
 record=bytearray(module._WAL_SIZE);record[:11]=module._WAL_MAGIC;record[16]=module._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=module._ZERO32;record[128:160]=identity_digest
 create_payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
 module._zero(identity_digest)
 result,create_error=module._cmd_create(fds,root_fd,create_payload,uid,root_device)
 if create_error is not None:raise RuntimeError("create")
 evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
 lifecycle_dir=os.path.join(root,lifecycle.hex())
 def dispatch(opcode,payload):
  box=[]
  def call():
   box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,opcode,payload,module._MODE_V5_READY))
  emitted=captured(call)
  return box[0],emitted
 def dispatch_abort(payload):
  return dispatch(module._WS_ABORT_DRAFT,payload)
 def draft_intact():
  entries=sorted(os.listdir(evidence))
  if len(entries)!=3 or "input.manifest" not in entries:raise RuntimeError("draft")
  return entries
 outcome,emitted=dispatch_abort(abort_request())
 if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError("pre-begin")
 outcome,emitted=dispatch(module._WS_BEGIN,begin_request())
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=begin_frame:raise RuntimeError("begin")
 draft_intact()
 base=abort_request()
 for label,payload in (("short",base[:136]),("long",base+bytes(1))):
  outcome,emitted=dispatch_abort(payload)
  if outcome!=(module._MODE_V5_READY,"error",module._E_INPUT) or emitted!=b"":raise RuntimeError(label)
  draft_intact()
 for label,kind in (("kind-zero",0),("kind-two",2),("kind-four",4)):
  payload=bytearray(base);payload[128]=kind
  outcome,emitted=dispatch_abort(payload)
  if outcome!=(module._MODE_V5_READY,"error",module._E_INPUT) or emitted!=b"":raise RuntimeError(label)
  draft_intact()
 zero_tx=bytearray(base);zero_tx[96:128]=bytes(32)
 outcome,emitted=dispatch_abort(zero_tx)
 if outcome!=(module._MODE_V5_READY,"error",module._E_INPUT) or emitted!=b"":raise RuntimeError("zero-tx")
 draft_intact()
 vector=bytearray(base);vector[128]=3
 outcome,emitted=dispatch_abort(vector)
 if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError("vector-kind")
 draft_intact()
 stale_revision=bytearray(base);struct.pack_into(">Q",stale_revision,129,1)
 outcome,emitted=dispatch_abort(stale_revision)
 if outcome!=(module._MODE_V5_READY,"error",module._E_STALE) or emitted!=b"":raise RuntimeError("stale-revision")
 draft_intact()
 for label,offset in (("stale-generation",32),("stale-binding",64),("stale-tx",96)):
  payload=bytearray(base);payload[offset:offset+32]=bytes(range(96,128))
  outcome,emitted=dispatch_abort(payload)
  if outcome!=(module._MODE_V5_READY,"error",module._E_STALE) or emitted!=b"":raise RuntimeError(label)
  draft_intact()
 absent=bytearray(base);absent[0:32]=bytearray(range(200,232))
 outcome,emitted=dispatch_abort(absent)
 if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError("absent-lifecycle")
 draft_intact()
 outcome,emitted=dispatch_abort(base)
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=abort_frame or len(emitted)!=7:raise RuntimeError("abort")
 if os.path.exists(evidence):raise RuntimeError("abort-presence")
 if sorted(os.listdir(lifecycle_dir))!=["generations","head","identity.rec","ledger"]:raise RuntimeError("abort-lifecycle")
 items,outstanding=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
 if len(items)!=0 or outstanding!=0:raise RuntimeError("abort-inventory")
 for label,payload in (("retry",bytearray(base)),("retry-vector",vector)):
  outcome,emitted=dispatch_abort(payload)
  if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError(label)
 outcome,emitted=dispatch(module._WS_BEGIN,begin_request())
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=begin_frame:raise RuntimeError("rebegin")
 draft_intact()
 outcome,emitted=dispatch_abort(abort_request())
 if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=abort_frame:raise RuntimeError("reabort")
 if os.path.exists(evidence):raise RuntimeError("reabort-presence")
 items,outstanding=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
 if len(items)!=0:raise RuntimeError("reabort-inventory")
 if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError("fds")
 module._zero(base)
finally:
 if fds is not None:fds.close_all()
 shutil.rmtree(root)
print("V5_ABORT_COMMAND_OK 137 2")
`;
			const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
			const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
				cwd: "/",
				env: {},
				timeout: 30_000,
				maxBuffer: 1024,
			});
			expect(stderr).toBe("");
			expect(stdout).toBe("V5_ABORT_COMMAND_OK 137 2\n");
		},
	);

	linuxProbeTest("V5 WS_ABORT_DRAFT crash cuts restart forward for every abort row", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
source=open(sys.argv[1]).read()
spec=importlib.util.spec_from_file_location("store_v5_abort_cut_real",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
abort_frame=struct.pack(">BI",0x80,2)+bytes((0x0C,1))
begin_frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
guard="        if not _same_at(manifest_data, 80, payload[64:128]):\\n            return (v5_mode, \\"error\\", _E_STALE)\\n        if not _same_at(manifest_data, 8, payload[129:137]):\\n            return (v5_mode, \\"error\\", _E_STALE)"
rows=[
 "        _unlink(evidence_fd, content_name)",
 "        _fsync(evidence_fd)",
 "        _v5_require_absent(evidence_fd, content_name)",
 "        _unlink(evidence_fd, plan_name)",
 "        _fsync(evidence_fd)",
 "        _v5_require_absent(evidence_fd, plan_name)",
 "        _unlink(evidence_fd, _INPUT_MANIFEST)",
 "        _fsync(evidence_fd)",
 "        _v5_require_absent(evidence_fd, _INPUT_MANIFEST)",
 "        if len(_list(evidence_fd)) != 0:",
 "            raise Fatal(_E_STATE)",
 "        fds.close(content_fd)",
 "        content_fd = None",
 "        fds.close(plan_fd)",
 "        plan_fd = None",
 "        fds.close(manifest_fd)",
 "        manifest_fd = None",
 "        fds.close(evidence_fd)",
 "        evidence_fd = None",
 "        _rmdir(generation_fd, _WORKSPACE_EVIDENCE)",
 "        _fsync(generation_fd)",
]
def anchor(row_count):
 text=guard
 index=0
 while index<row_count:
  text+="\\n"+rows[index]
  index+=1
 if source.count(text)!=1:raise RuntimeError("anchor-%d"%row_count)
 return text
counter=[0]
def mutated(anchor_text,replacement):
 counter[0]+=1
 path=os.path.join(parent,"ws-abort-cut-%d.py"%counter[0])
 handle=open(path,"w")
 handle.write(source.replace(anchor_text,replacement,1))
 handle.close()
 try:
  spec2=importlib.util.spec_from_file_location("ws_abort_cut_%d"%counter[0],path)
  loaded=importlib.util.module_from_spec(spec2)
  spec2.loader.exec_module(loaded)
 finally:
  os.unlink(path)
 return loaded
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def begin_payload():
 payload=bytearray(172);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128:160]=plan_digest;struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
 return payload
def abort_payload():
 payload=bytearray(137);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128]=1;struct.pack_into(">Q",payload,129,0)
 return payload
def build(mod):
 root=tempfile.mkdtemp(prefix="store-v5-abort-cut-",dir=parent)
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=mod.Fds();fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=mod._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("lock")
 genesis=bytes(range(64));identity_digest=mod._digest(genesis)
 record=bytearray(mod._WAL_SIZE);record[:11]=mod._WAL_MAGIC;record[16]=mod._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=mod._ZERO32;record[128:160]=identity_digest
 create_payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
 mod._zero(identity_digest)
 result,create_error=mod._cmd_create(fds,root_fd,create_payload,uid,root_device)
 if create_error is not None:raise RuntimeError("create")
 box=[]
 def begin_call():
  box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,begin_payload(),mod._MODE_V5_READY))
 emitted=captured(begin_call)
 if box[0]!=(mod._MODE_V5_READY,"emitted",None) or emitted!=begin_frame:raise RuntimeError("begin")
 return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
cuts=[("AI00",0,"present"),("AI01",1,"forward"),("AI02",2,"forward"),("AI03",4,"forward"),("AI04",5,"forward"),("AI05",7,"forward"),("AI06",8,"forward"),("AI07",20,"no-evidence"),("AI08",21,"no-evidence")]
for label,row_count,expect in cuts:
 root=None;fds=None;request=None
 try:
  mod=mutated(anchor(row_count),anchor(row_count)+"\\n        raise Fatal(_E_IO)")
  root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod)
  request=abort_payload()
  seen=[];box=[]
  def cut_call():
   try:
    box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_ABORT_DRAFT,request,mod._MODE_V5_READY))
   except mod.Fatal as failure:
    seen.append(failure.code)
  emitted=captured(cut_call)
  if seen!=[mod._E_IO] or emitted!=b"":raise RuntimeError(label)
  fds.close_all()
  generation_path=os.path.join(root,lifecycle.hex(),"generations",generation.hex())
  evidence_path=os.path.join(generation_path,"workspace-evidence")
  recover_fds=module.Fds()
  generation_fd=os.open(generation_path,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  recover_fds.add(generation_fd)
  try:
   recovered=module._v5_recover_input_begin_prefix(recover_fds,generation_fd,lifecycle,generation,uid,os.fstat(generation_fd).st_dev)
  finally:
   recover_fds.close(generation_fd)
  if recover_fds.uncertain or recover_fds.items!=[]:raise RuntimeError(label+"-recover-fds")
  if expect=="present":
   if recovered is not True or not os.path.isdir(evidence_path) or len(os.listdir(evidence_path))!=3:raise RuntimeError(label+"-preserve")
  elif expect=="forward":
   if recovered is not True or os.path.exists(evidence_path):raise RuntimeError(label+"-forward")
  else:
   if recovered is not False or os.path.exists(evidence_path):raise RuntimeError(label+"-no-evidence")
  fds=module.Fds()
  root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds.add(root_fd)
  root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
  lock_fd,lock_device,lock_inode,lock_error=module._bind_lock(fds,root_fd,uid,root_device)
  if lock_error is not None:raise RuntimeError(label+"-relock")
  def dispatch_auth(opcode,payload):
   box=[]
   def call():
    box.append(module._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,opcode,payload,module._MODE_V5_READY))
   emitted=captured(call)
   return box[0],emitted
  if expect=="present":
   outcome,emitted=dispatch_auth(module._WS_ABORT_DRAFT,request)
   if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=abort_frame:raise RuntimeError(label+"-abort-after")
   if os.path.exists(evidence_path):raise RuntimeError(label+"-abort-after-presence")
  else:
   outcome,emitted=dispatch_auth(module._WS_ABORT_DRAFT,request)
   if outcome!=(module._MODE_V5_READY,"error",module._E_ABSENT) or emitted!=b"":raise RuntimeError(label+"-retry")
  fresh_begin=begin_payload()
  outcome,emitted=dispatch_auth(module._WS_BEGIN,fresh_begin)
  if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=begin_frame:raise RuntimeError(label+"-rebegin")
  if not os.path.isdir(evidence_path) or len(os.listdir(evidence_path))!=3:raise RuntimeError(label+"-rebegin-entries")
  outcome,emitted=dispatch_auth(module._WS_ABORT_DRAFT,request)
  if outcome!=(module._MODE_V5_READY,"emitted",None) or emitted!=abort_frame:raise RuntimeError(label+"-reabort")
  if os.path.exists(evidence_path):raise RuntimeError(label+"-reabort-presence")
  items,outstanding=module._v5_collect_inventory(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode)
  if len(items)!=0:raise RuntimeError(label+"-inventory")
  module._v5_zero_transactions(items)
  if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError(label+"-fds")
  module._zero(fresh_begin)
 finally:
  if fds is not None:fds.close_all()
  if root is not None:shutil.rmtree(root,ignore_errors=True)
  if request is not None:module._zero(request)
print("V5_ABORT_CUTS_OK 9")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 60_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_ABORT_CUTS_OK 9\n");
	});

	linuxProbeTest("V5 WS_ABORT_DRAFT rejects a mutated draft after inventory under retained-fd authority", async () => {
		const probe = `import importlib.util,os,shutil,struct,sys,tempfile
source=open(sys.argv[1]).read()
spec=importlib.util.spec_from_file_location("store_v5_abort_seam_real",sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
uid=os.getuid()
parent="/private/tmp" if sys.platform=="darwin" else "/tmp"
lifecycle=bytearray(range(32));generation=bytearray(range(32,64));binding=bytes(range(64,96));tx=bytes((1,))+bytes(31);plan_digest=bytes(range(96,128))
abort_frame=struct.pack(">BI",0x80,2)+bytes((0x0C,1))
begin_frame=struct.pack(">BI",0x80,25)+bytes((0x0A,))+bytes(24)
source_lines=source.split("\\n")
def abort_bounds():
 start=-1
 for index in range(len(source_lines)):
  if source_lines[index].startswith("def _cmd_ws_abort_draft("):
   start=index
   break
 if start<0:raise RuntimeError("abort-fn")
 header_end=start
 while header_end<len(source_lines) and not source_lines[header_end].endswith(":"):
  header_end+=1
 end=header_end+1
 while end<len(source_lines):
  if source_lines[end].startswith("def ") or source_lines[end].startswith("class "):
   break
  end+=1
 return start,header_end,end
anchor="        items, unused_outstanding = _v5_collect_inventory(\\n            fds, root_fd, uid, device, root_inode, lock_fd, lock_device, lock_inode\\n        )"
counter=[0]
def mutate_seam(hook_lines):
 start,header_end,end=abort_bounds()
 body="\\n".join(source_lines[header_end+1:end])
 if body.count(anchor)!=1:raise RuntimeError("seam-anchor")
 body=body.replace(anchor,anchor+"\\n        _V5_ABORT_SEAM_HOOK()",1)
 hook="_V5_ABORT_SEAM_STATE = {}\\n\\n\\ndef _V5_ABORT_SEAM_HOOK():\\n"+"".join("    "+line+"\\n" for line in hook_lines)+"\\n\\n"
 counter[0]+=1
 path=os.path.join(parent,"ws-abort-seam-%d.py"%counter[0])
 text=source.replace("\\n".join(source_lines[header_end+1:end]),body,1)
 text=text.replace("def _cmd_ws_abort_draft(",hook+"def _cmd_ws_abort_draft(",1)
 handle=open(path,"w")
 handle.write(text)
 handle.close()
 try:
  spec2=importlib.util.spec_from_file_location("ws_abort_seam_%d"%counter[0],path)
  loaded=importlib.util.module_from_spec(spec2)
  spec2.loader.exec_module(loaded)
 finally:
  os.unlink(path)
 return loaded
def captured(call):
 read_fd,write_fd=os.pipe();saved=os.dup(1);closed=False
 try:
  os.dup2(write_fd,1)
  try:call()
  finally:os.dup2(saved,1)
  os.close(write_fd);closed=True
  chunks=[]
  while True:
   chunk=os.read(read_fd,65536)
   if not chunk:break
   chunks.append(chunk)
  return b"".join(chunks)
 finally:
  if not closed:os.close(write_fd)
  os.close(saved);os.close(read_fd)
def begin_payload():
 payload=bytearray(172);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128:160]=plan_digest;struct.pack_into(">I",payload,160,17);struct.pack_into(">Q",payload,164,23)
 return payload
def abort_payload():
 payload=bytearray(137);payload[0:32]=lifecycle;payload[32:64]=generation;payload[64:96]=binding;payload[96:128]=tx;payload[128]=1;struct.pack_into(">Q",payload,129,0)
 return payload
def build(mod):
 root=tempfile.mkdtemp(prefix="store-v5-abort-seam-",dir=parent)
 root_fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);fds=mod.Fds();fds.add(root_fd)
 root_device=os.fstat(root_fd).st_dev;root_inode=os.fstat(root_fd).st_ino
 lock_fd,lock_device,lock_inode,lock_error=mod._bind_lock(fds,root_fd,uid,root_device)
 if lock_error is not None:raise RuntimeError("lock")
 genesis=bytes(range(64));identity_digest=mod._digest(genesis)
 record=bytearray(mod._WAL_SIZE);record[:11]=mod._WAL_MAGIC;record[16]=mod._W_ALLOCATED;struct.pack_into(">Q",record,24,1);record[32:64]=lifecycle;record[64:96]=generation;record[96:128]=mod._ZERO32;record[128:160]=identity_digest
 create_payload=bytes(lifecycle)+bytes(generation)+struct.pack(">I",len(genesis))+genesis+bytes(record)
 mod._zero(identity_digest)
 result,create_error=mod._cmd_create(fds,root_fd,create_payload,uid,root_device)
 if create_error is not None:raise RuntimeError("create")
 box=[]
 def begin_call():
  box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_BEGIN,begin_payload(),mod._MODE_V5_READY))
 emitted=captured(begin_call)
 if box[0]!=(mod._MODE_V5_READY,"emitted",None) or emitted!=begin_frame:raise RuntimeError("begin")
 return root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode
def check_revision(evidence,names):
 manifest=open(os.path.join(evidence,"input.manifest"),"rb").read()
 if struct.unpack_from(">Q",manifest,8)[0]!=1:raise RuntimeError("seam-revision")
 for name in names:
  if name.startswith(".ws-plan."):
   if os.stat(os.path.join(evidence,name)).st_size!=29:raise RuntimeError("seam-plan-size")
def check_magic(evidence,names):
 if open(os.path.join(evidence,"input.manifest"),"rb").read()[:8]!=b"PIWSIMF4":raise RuntimeError("seam-magic")
def check_nonce(evidence,names):
 if ".ws-plan."+(bytes((11,))*32).hex() not in names:raise RuntimeError("seam-nonce")
def check_symlink(evidence,names):
 content=[name for name in names if name.startswith(".ws-content.")][0]
 if not os.path.islink(os.path.join(evidence,content)):raise RuntimeError("seam-symlink")
def check_hardlink(evidence,names):
 plan=[name for name in names if name.startswith(".ws-plan.")][0]
 if os.stat(os.path.join(evidence,plan)).st_nlink!=2:raise RuntimeError("seam-hardlink")
def check_mode(evidence,names):
 content=[name for name in names if name.startswith(".ws-content.")][0]
 if (os.stat(os.path.join(evidence,content)).st_mode&0o777)!=0o644:raise RuntimeError("seam-mode")
def seam_case(label,hook_lines,kind,code,checker):
 root=None;fds=None;request=None
 try:
  mod=mutate_seam(hook_lines)
  root,fds,root_fd,root_device,root_inode,lock_fd,lock_device,lock_inode=build(mod)
  evidence=os.path.join(root,lifecycle.hex(),"generations",generation.hex(),"workspace-evidence")
  mod._V5_ABORT_SEAM_STATE["evidence"]=evidence
  request=abort_payload()
  seen=[];box=[]
  def seam_call():
   try:
    box.append(mod._dispatch_v5(fds,root_fd,uid,root_device,root_inode,lock_fd,lock_device,lock_inode,mod._WS_ABORT_DRAFT,request,mod._MODE_V5_READY))
   except mod.Fatal as failure:
    seen.append(failure.code)
  emitted=captured(seam_call)
  if kind=="stale":
   if box[0]!=(mod._MODE_V5_READY,"error",mod._E_STALE) or seen or emitted!=b"":raise RuntimeError(label+"-outcome")
  else:
   if seen!=[code] or box or emitted!=b"":raise RuntimeError(label+"-outcome "+repr(seen))
  if fds.uncertain or fds.items!=[root_fd,lock_fd]:raise RuntimeError(label+"-fds")
  names=sorted(os.listdir(evidence))
  if len(names)!=3 or "input.manifest" not in names:raise RuntimeError(label+"-entries")
  checker(evidence,names)
 finally:
  if fds is not None:fds.close_all()
  if root is not None:shutil.rmtree(root,ignore_errors=True)
  if request is not None:mod._zero(request)
seam_case("changed-valid-revision",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "manifest_path=os.path.join(evidence,\\"input.manifest\\")",
 "fd=os.open(manifest_path,os.O_RDWR)",
 "data=bytearray(os.read(fd,272))",
 "struct.pack_into(\\">Q\\",data,8,1)",
 "struct.pack_into(\\">Q\\",data,252,17)",
 "os.lseek(fd,0,os.SEEK_SET)",
 "os.write(fd,bytes(data))",
 "os.close(fd)",
 "plan_path=None",
 "for name in os.listdir(evidence):",
 "    if name.startswith(\\".ws-plan.\\"):",
 "        plan_path=os.path.join(evidence,name)",
 "fd=os.open(plan_path,os.O_WRONLY|os.O_APPEND)",
 "os.write(fd,bytes(range(31,48)))",
 "os.close(fd)",
],"stale",None,check_revision)
seam_case("malformed-manifest",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "manifest_path=os.path.join(evidence,\\"input.manifest\\")",
 "fd=os.open(manifest_path,os.O_RDWR)",
 "data=bytearray(os.read(fd,272))",
 "data[0:8]=b\\"PIWSIMF4\\"",
 "os.lseek(fd,0,os.SEEK_SET)",
 "os.write(fd,bytes(data))",
 "os.close(fd)",
],"fatal",module._E_STATE,check_magic)
seam_case("nonce-substitution",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "old_name=None",
 "for name in os.listdir(evidence):",
 "    if name.startswith(\\".ws-plan.\\"):",
 "        old_name=name",
 "os.rename(os.path.join(evidence,old_name),os.path.join(evidence,\\".ws-plan.\\"+(bytes((11,))*32).hex()))",
],"fatal",module._E_STATE,check_nonce)
seam_case("symlink-swap",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "content_name=None",
 "for name in os.listdir(evidence):",
 "    if name.startswith(\\".ws-content.\\"):",
 "        content_name=name",
 "os.unlink(os.path.join(evidence,content_name))",
 "os.symlink(os.path.join(evidence,\\"input.manifest\\"),os.path.join(evidence,content_name))",
],"fatal",module._E_SYMLINK,check_symlink)
seam_case("hardlink-swap",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "plan_name=None",
 "for name in os.listdir(evidence):",
 "    if name.startswith(\\".ws-plan.\\"):",
 "        plan_name=name",
 "os.unlink(os.path.join(evidence,plan_name))",
 "os.link(os.path.join(evidence,\\"input.manifest\\"),os.path.join(evidence,plan_name))",
],"fatal",module._E_NLINK,check_hardlink)
seam_case("mode-swap",[
 "evidence=_V5_ABORT_SEAM_STATE[\\"evidence\\"]",
 "content_name=None",
 "for name in os.listdir(evidence):",
 "    if name.startswith(\\".ws-content.\\"):",
 "        content_name=name",
 "os.chmod(os.path.join(evidence,content_name),0o644)",
],"fatal",module._E_MODE,check_mode)
print("V5_ABORT_SEAMS_OK 6")
`;
		const hostPython = process.platform === "darwin" ? "/opt/homebrew/bin/python3" : "/usr/local/bin/python3";
		const { stdout, stderr } = await execFileAsync(hostPython, ["-c", probe, HELPER], {
			cwd: "/",
			env: {},
			timeout: 60_000,
			maxBuffer: 1024,
		});
		expect(stderr).toBe("");
		expect(stdout).toBe("V5_ABORT_SEAMS_OK 6\n");
	});
});
