"""Focused deterministic and offline tests for sandbox runtime V26."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import tempfile
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
NATIVE = REPO / "prime-agent-runtime/native/sandbox-runtime-v26"
FIXTURES = REPO / "prime-agent-runtime/test/fixtures/sandbox-runtime-v26"
BUILDER = REPO / "scripts/build-sandbox-runtime-v26.py"
DEFAULT_INPUT = Path("/Users/milkkarten/.prime/agent/session-artifacts/01a05fe9-d2a4-71a9-9556-da16f3cdef55/bun-linux-x64-1.4.0-input/extracted/bun")
INPUT = Path(os.environ.get("PRIME_AGENT_V26_BUN_INPUT", DEFAULT_INPUT))
IMAGE = "python@sha256:cec9aa7aa96eea4fa036e9b82be1e6b325f2e3707f462d885868df51ec0a4b47"
FIXTURE_DIGEST = hashlib.sha256((FIXTURES / "identity_probe.js").read_bytes()).hexdigest()
EXPECTED_FIXTURE_OUTPUT_SHA256 = "d2242832ba4ce16b69b463e4b5c5032462ba39fa8c9e7244b78d18faffc9c00c"
EXPECTED_FIXTURE_MANIFEST_SHA256 = "26a1509449695992535a3987980501ba62fc757513273ecf1ae357767a0fa212"

spec = importlib.util.spec_from_file_location("v26_patcher", NATIVE / "patch_bun_elf.py")
assert spec and spec.loader
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

builder_spec = importlib.util.spec_from_file_location("v26_builder", BUILDER)
assert builder_spec and builder_spec.loader
builder_module = importlib.util.module_from_spec(builder_spec)
builder_spec.loader.exec_module(builder_module)


def builder_command(coding_script: Path, output: Path, manifest: Path,
                    authorized_digest: str | None = None) -> list[str]:
    return [str(BUILDER), "--input", str(INPUT), "--coding-script", str(coding_script),
            "--coding-script-sha256", authorized_digest or digest(coding_script.read_bytes()),
            "--output", str(output), "--manifest", str(manifest)]


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def extract_text(elf: bytes) -> tuple[bytes, list[int]]:
    eh = struct.unpack_from("<16sHHIQQQIHHHHHH", elf)
    shoff, shentsize, shnum, shstrndx = eh[6], eh[11], eh[12], eh[13]
    sections = [struct.unpack_from("<IIQQQQIIQQ", elf, shoff + i * shentsize)
                for i in range(shnum)]
    strings_header = sections[shstrndx]
    strings = elf[strings_header[4]:strings_header[4] + strings_header[5]]
    text = None
    types = []
    for section in sections:
        end = strings.find(b"\0", section[0])
        name = strings[section[0]:end]
        types.append(section[1])
        if name == b".text":
            text = elf[section[4]:section[4] + section[5]]
    if text is None:
        raise AssertionError("compiled object has no .text")
    return text, types

class TestV26Patcher(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not INPUT.is_file():
            raise unittest.SkipTest(f"official Bun input is absent: {INPUT}")
        cls.source = INPUT.read_bytes()
        template = (NATIVE / "prelude.bin").read_bytes()
        cls.prelude = builder_module.bind_prelude(template, bytes.fromhex(FIXTURE_DIGEST))

    def test_exact_parser_and_safe_geometry(self):
        ehdr, phdrs = patcher.parse_and_validate(self.source)
        self.assertEqual(ehdr, patcher.EXPECTED_EHDR)
        self.assertEqual(phdrs, patcher.EXPECTED_PHDRS)
        _, facts = patcher.patch(self.source, self.prelude)
        new = facts["program_header"]
        self.assertEqual(new["file_offset"] % 4096, new["virtual_address"] % 4096)
        self.assertEqual(new["flags"], 5)
        self.assertEqual(new["index"], 8)
        new_start = new["virtual_address"]
        new_end = new_start + new["memory_size"]
        for ph in phdrs:
            if ph[0] == 1:
                self.assertTrue(new_end <= ph[3] or new_start >= ph[3] + ph[6])

    def test_only_entry_note_and_append_change(self):
        patched, _ = patcher.patch(self.source, self.prelude)
        prefix_changes = {i for i, pair in enumerate(zip(self.source, patched)) if pair[0] != pair[1]}
        ph = 64 + 8 * 56
        self.assertTrue(prefix_changes)
        self.assertLessEqual(prefix_changes, set(range(24, 32)) | set(range(ph, ph + 56)))
        self.assertEqual(self.source, INPUT.read_bytes())

    def test_fail_closed_source_and_prelude_mutants(self):
        for offset in (0, 4, 16, 18, 24, 32, 54, 56, 64 + 8 * 56, 596):
            mutant = bytearray(self.source)
            mutant[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises(patcher.ValidationError):
                patcher.parse_and_validate(mutant)
        with self.assertRaises(patcher.ValidationError):
            patcher.patch(self.source, b"")
        with self.assertRaises(patcher.ValidationError):
            patcher.patch(self.source, b"X" * 4097)

    def test_geometry_and_interpreter_checks_follow_digest_gate(self):
        for offset, message in ((24, "ELF header"), (64 + 8 * 56, "program header"),
                                (568, "PT_INTERP"), (596, "PT_NOTE")):
            mutant = bytearray(self.source)
            mutant[offset] ^= 1
            with mock.patch.object(patcher, "SOURCE_SHA256", digest(mutant)):
                with self.subTest(offset=offset), self.assertRaisesRegex(patcher.ValidationError, message):
                    patcher.parse_and_validate(mutant)

    def test_two_builds_are_byte_identical_and_canonical(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = []
            for suffix in ("a", "b"):
                output, manifest = root / f"bun-{suffix}", root / f"manifest-{suffix}.json"
                subprocess.run(builder_command(FIXTURES / "identity_probe.js", output, manifest),
                               cwd=REPO, check=True)
                results.append((output.read_bytes(), manifest.read_bytes()))
            self.assertEqual(results[0], results[1])
            self.assertEqual(digest(results[0][0]), EXPECTED_FIXTURE_OUTPUT_SHA256)
            self.assertEqual(digest(results[0][1]), EXPECTED_FIXTURE_MANIFEST_SHA256)
            decoded = json.loads(results[0][1])
            canonical = (json.dumps(decoded, sort_keys=True, separators=(",", ":")) + "\n").encode()
            self.assertEqual(results[0][1], canonical)
            self.assertEqual(decoded["elf"]["output"]["sha256"], digest(results[0][0]))
            self.assertEqual(decoded["install"], {"gid": 65533, "mode": "2755", "nlink": 1, "uid": 0})
            coding = decoded["protocol"]["coding_script"]
            self.assertEqual(coding, {
                "actual_sha256": FIXTURE_DIGEST,
                "expected_sha256": FIXTURE_DIGEST,
                "path": "/opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js",
                "size": (FIXTURES / "identity_probe.js").stat().st_size,
            })
            self.assertEqual(decoded["prelude"]["template_sha256"],
                             digest((NATIVE / "prelude.bin").read_bytes()))
            self.assertEqual(decoded["prelude"]["source_sha256"],
                             digest((NATIVE / "prelude.S").read_bytes()))
            self.assertEqual(decoded["build"]["builder_sha256"], digest(BUILDER.read_bytes()))
            self.assertEqual(decoded["build"]["patcher_sha256"],
                             digest((NATIVE / "patch_bun_elf.py").read_bytes()))

    def test_different_authorized_scripts_produce_correspondingly_bound_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            alternate = root / "alternate.js"
            alternate.write_bytes(b"console.log(JSON.stringify({alternate:true}));\n")
            built = []
            for index, script in enumerate((FIXTURES / "identity_probe.js", alternate)):
                output, manifest = root / f"bun-{index}", root / f"manifest-{index}.json"
                subprocess.run(builder_command(script, output, manifest), cwd=REPO, check=True)
                built.append((output.read_bytes(), json.loads(manifest.read_bytes()), digest(script.read_bytes())))
            self.assertNotEqual(built[0][0], built[1][0])
            for output, manifest, expected in built:
                coding = manifest["protocol"]["coding_script"]
                self.assertEqual(coding["expected_sha256"], expected)
                self.assertEqual(coding["actual_sha256"], expected)
                append_at = manifest["elf"]["program_header"]["file_offset"]
                bound_size = manifest["prelude"]["bound_binary_size"]
                bound = output[append_at:append_at + bound_size]
                self.assertIn(bytes.fromhex(expected), bound)
                self.assertNotIn(builder_module.CODING_DIGEST_SENTINEL, bound)

    def test_output_mode_and_input_immutability(self):
        before = INPUT.stat()
        with tempfile.TemporaryDirectory() as directory:
            output, manifest = Path(directory) / "bun", Path(directory) / "manifest.json"
            subprocess.run(builder_command(FIXTURES / "identity_probe.js", output, manifest),
                           cwd=REPO, check=True)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o755)
            self.assertEqual(output.stat().st_nlink, 1)
            self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o644)
            self.assertEqual(manifest.stat().st_nlink, 1)
            self.assertEqual(digest(INPUT.read_bytes()), patcher.SOURCE_SHA256)
        after = INPUT.stat()
        self.assertEqual((before.st_mode, before.st_nlink, before.st_size, before.st_mtime_ns),
                         (after.st_mode, after.st_nlink, after.st_size, after.st_mtime_ns))


class TestV26BuilderContract(unittest.TestCase):
    def test_malformed_mismatch_and_placeholder_collisions_fail(self):
        template = builder_module.CODING_DIGEST_SENTINEL + b"tail"
        with self.assertRaisesRegex(ValueError, "exactly once"):
            builder_module.bind_prelude(template + builder_module.CODING_DIGEST_SENTINEL, b"x" * 32)
        with self.assertRaisesRegex(ValueError, "collides"):
            builder_module.bind_prelude(template, builder_module.CODING_DIGEST_SENTINEL)
        with self.assertRaisesRegex(ValueError, "another prelude"):
            builder_module.bind_prelude(template + b"x" * 32, b"x" * 32)
        with self.assertRaisesRegex(ValueError, "exactly 32"):
            builder_module.bind_prelude(template, b"short")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "script.js"
            script.write_bytes(b"test script\n")
            for malformed in ("0" * 63, "A" * 64, "g" * 64):
                output, manifest = root / f"out-{malformed[:1]}", root / f"manifest-{malformed[:1]}"
                proc = subprocess.run(builder_command(script, output, manifest, malformed), cwd=REPO,
                                      text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertNotEqual(proc.returncode, 0)
                self.assertFalse(output.exists())
                self.assertFalse(manifest.exists())
            output, manifest = root / "mismatch-out", root / "mismatch-manifest"
            proc = subprocess.run(builder_command(script, output, manifest, "0" * 64), cwd=REPO,
                                  text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            self.assertNotEqual(proc.returncode, 0)
            self.assertFalse(output.exists())
            self.assertFalse(manifest.exists())

    def test_fixtures_are_outside_production_and_no_probe_pin_remains(self):
        self.assertEqual({path.name for path in NATIVE.iterdir() if path.is_file()},
                         {"README.md", "patch_bun_elf.py", "prelude.S", "prelude.bin"})
        self.assertEqual({path.name for path in FIXTURES.iterdir()},
                         {"identity_probe.js", "supervisor.py"})
        production_text = BUILDER.read_bytes() + (NATIVE / "README.md").read_bytes()
        production_text += (NATIVE / "patch_bun_elf.py").read_bytes() + (NATIVE / "prelude.S").read_bytes()
        self.assertNotIn(FIXTURE_DIGEST.encode(), production_text)
        self.assertNotIn((FIXTURES / "identity_probe.js").read_bytes(), production_text)


class TestV26Publication(unittest.TestCase):
    def assert_no_temps(self, root: Path):
        self.assertEqual([path for path in root.iterdir() if ".tmp-" in path.name], [])

    def test_rejects_alias_symlink_hardlink_and_existing_destinations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            existing = root / "existing"
            existing.write_bytes(b"unrelated")
            hardlink = root / "hardlink"
            os.link(existing, hardlink)
            symlink = root / "symlink"
            symlink.symlink_to(existing)
            for output, manifest in ((root / "same", root / "same"),
                                     (existing, root / "manifest-a"),
                                     (hardlink, root / "manifest-b"),
                                     (symlink, root / "manifest-c"),
                                     (root / "output-d", existing)):
                with self.subTest(output=output, manifest=manifest), self.assertRaises(patcher.ValidationError):
                    patcher.write_outputs(output, manifest, b"output", b"manifest")
            self.assertEqual(existing.read_bytes(), b"unrelated")
            self.assertEqual(hardlink.read_bytes(), b"unrelated")
            self.assertTrue(symlink.is_symlink())
            self.assert_no_temps(root)

    def test_injected_temp_link_and_directory_sync_failures_leave_no_pair_member(self):
        injectors = ("second-temp", "second-link", "directory-sync")
        for injector in injectors:
            with self.subTest(injector=injector), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output, manifest = root / "output", root / "manifest"
                if injector == "second-temp":
                    original = patcher._create_temp
                    calls = 0
                    def create(destination, payload, mode):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            raise OSError("injected second temp failure")
                        return original(destination, payload, mode)
                    context = mock.patch.object(patcher, "_create_temp", side_effect=create)
                elif injector == "second-link":
                    original = os.link
                    calls = 0
                    def link(source, destination, **kwargs):
                        nonlocal calls
                        calls += 1
                        if calls == 2:
                            raise OSError("injected second publication failure")
                        return original(source, destination, **kwargs)
                    context = mock.patch.object(patcher.os, "link", side_effect=link)
                else:
                    context = mock.patch.object(patcher, "_fsync_directory",
                                                side_effect=OSError("injected directory fsync failure"))
                with context, self.assertRaises(OSError):
                    patcher.write_outputs(output, manifest, b"output", b"manifest")
                self.assertFalse(os.path.lexists(output))
                self.assertFalse(os.path.lexists(manifest))
                self.assert_no_temps(root)


class TestV26Prelude(unittest.TestCase):
    def test_checked_in_binary_rebuilds_without_relocations(self):
        clang = shutil.which("clang")
        if not clang:
            self.skipTest("clang is absent")
        with tempfile.TemporaryDirectory() as directory:
            obj = Path(directory) / "prelude.o"
            subprocess.run([clang, "-target", "x86_64-linux-gnu", "-c", "-o", str(obj),
                            str(NATIVE / "prelude.S")], check=True)
            text, section_types = extract_text(obj.read_bytes())
            self.assertNotIn(4, section_types)  # SHT_RELA
            self.assertNotIn(9, section_types)  # SHT_REL
            self.assertEqual(text, (NATIVE / "prelude.bin").read_bytes())

    def test_source_has_raw_start_failure_and_abi_restore(self):
        source = (NATIVE / "prelude.S").read_text()
        self.assertIn(".globl _start", source)
        self.assertNotIn("call printf", source)
        self.assertNotIn("call malloc", source)
        for register in ("%rax", "%rbx", "%rcx", "%rdx", "%rsi", "%rdi", "%rbp",
                         "%r8", "%r9", "%r10", "%r11", "%r12", "%r13", "%r14", "%r15"):
            self.assertIn(f"push {register}", source)
            self.assertIn(f"pop {register}", source)
        self.assertIn("mov $3,%eax\n  mov $3,%edi\n  syscall\n  mov $231,%eax", source)
        self.assertIn("mov $126,%edi", source)
        self.assertIn("jmp *original_entry(%rip)", source)
        self.assertIn(".quad 0x17bf400", source)
        self.assertIn("stdio_identity_loop:", source)
        self.assertIn("mov $5,%eax\n  mov $3,%edi\n  lea 32(%rbp),%rsi", source)
        self.assertIn("cmp 1056(%rbp),%rax", source)
        self.assertIn("cmp 1064(%rbp),%rax\n  je fail", source)
        self.assertIn('.ascii "PA_V26_CODING_DIGEST_PLACEHOLDER"', source)
        self.assertNotIn(FIXTURE_DIGEST, source)

    def test_disassembly_has_no_external_control_flow(self):
        tool = shutil.which("llvm-objdump") or Path("/Library/Developer/CommandLineTools/usr/bin/llvm-objdump")
        if not Path(tool).is_file():
            self.skipTest("llvm-objdump is absent")
        clang = shutil.which("clang")
        if not clang:
            self.skipTest("clang is absent")
        with tempfile.TemporaryDirectory() as directory:
            obj = Path(directory) / "prelude.o"
            subprocess.run([clang, "-target", "x86_64-linux-gnu", "-c", "-o", str(obj),
                            str(NATIVE / "prelude.S")], check=True)
            proc = subprocess.run([str(tool), "--disassemble", str(obj)], text=True,
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=True)
        self.assertGreater(proc.stdout.count("syscall"), 30)
        self.assertIn("stdio_identity_loop", proc.stdout)
        self.assertIn("stdio_identity_next", proc.stdout)
        self.assertNotIn("@PLT", proc.stdout)
        self.assertRegex(proc.stdout, r"jmpq?\s+\*")

@unittest.skipUnless(shutil.which("docker") and INPUT.is_file(), "Docker or official Bun input is absent")
class TestV26ExactImage(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.output = cls.root / "prime-agent"
        cls.manifest = cls.root / "manifest.json"
        subprocess.run(builder_command(FIXTURES / "identity_probe.js", cls.output, cls.manifest), cwd=REPO, check=True)
        probe = subprocess.run([
            "docker", "run", "--rm", "--pull=never", "--platform", "linux/amd64", IMAGE, "python3", "-c",
            "import ctypes,errno,json; l=ctypes.CDLL(None,use_errno=True); "
            "c=l.syscall(436,1000000,4294967295,0); ce=ctypes.get_errno(); "
            "p=l.prctl(0x59616d61,0,0,0,0); pe=ctypes.get_errno(); "
            "print(json.dumps([c,ce,p,pe]))"
        ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        cls.gate = json.loads(probe.stdout) if probe.returncode == 0 else None

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def run_image(self, mode="success", *, script_mode="0444", script_owner="0", binary_mode="2755"):
        name = f"prime-agent-v26-test-{os.getpid()}-{mode.replace('_', '-')}"
        shell = ("set -eu; mkdir -p /opt/prime-agent-sandbox-v26; "
                 f"install -o 0 -g 65533 -m {binary_mode} /input/prime-agent /opt/prime-agent-sandbox-v26/prime-agent; "
                 f"install -o {script_owner} -g 0 -m {script_mode} /src/identity_probe.js /opt/prime-agent-sandbox-v26/prime-agent-coding-v26.js; "
                 f"python3 /src/supervisor.py {mode}")
        try:
            proc = subprocess.run([
                "docker", "run", "--rm", "--pull=never", "--name", name, "--platform", "linux/amd64",
                "-v", f"{self.root}:/input:ro", "-v", f"{FIXTURES}:/src:ro", IMAGE,
                "sh", "-c", shell,
            ], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        finally:
            subprocess.run(["docker", "rm", "-f", name], text=True, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=10)
        absent = subprocess.run(["docker", "ps", "-a", "--filter", f"name=^{name}$", "--format", "{{.ID}}"],
                                text=True, stdout=subprocess.PIPE, check=True, timeout=10)
        self.assertEqual(absent.stdout, "")
        return proc

    def require_target_syscalls(self):
        if self.gate != [0, 0, 0, 0]:
            self.skipTest(f"exact local amd64 execution lacks production close_range/PR_SET_PTRACER gate: {self.gate}")

    def test_installed_inode_facts_without_execution(self):
        program = ("import json,os,stat; p='/opt/prime-agent-sandbox-v26/prime-agent'; s=os.stat(p); "
                   "print(json.dumps([s.st_uid,s.st_gid,oct(stat.S_IMODE(s.st_mode)),s.st_nlink,"
                   "os.listxattr(p)]))")
        shell = ("set -eu; mkdir -p /opt/prime-agent-sandbox-v26; "
                 "install -o 0 -g 65533 -m 2755 /input/prime-agent /opt/prime-agent-sandbox-v26/prime-agent; "
                 f"python3 -c \"{program}\"")
        proc = subprocess.run(["docker", "run", "--rm", "--pull=never", "--platform", "linux/amd64",
                               "-v", f"{self.root}:/input:ro", IMAGE, "sh", "-c", shell],
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(json.loads(proc.stdout), [0, 65533, "0o2755", 1, []])

    def test_secureexec_success_and_install_facts(self):
        self.require_target_syscalls()
        proc = self.run_image()
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertEqual(result["bun"], "1.4.0")
        self.assertEqual(result["uid"], [65534, 65534])
        self.assertEqual(result["gid"], [65534, 65534])
        self.assertEqual(result["groups"], [])
        self.assertEqual(result["dumpable"], 0)
        self.assertEqual(result["pdeathGet"], 0)
        self.assertEqual(result["pdeathSignal"], 9)
        self.assertEqual(result["noNewPrivileges"], 1)
        self.assertTrue(result["fd3Socket"])
        self.assertEqual(result["cwd"], "/")
        self.assertTrue(result["fd3Flags"].endswith("2000002"))
        joined = "\n".join(result["status"])
        self.assertIn("Uid:\t65534\t65534\t65534\t65534", joined)
        self.assertIn("Gid:\t65534\t65534\t65534\t65534", joined)
        self.assertIn("CapBnd:\t0000000000000000", joined)
        self.assertIn("NoNewPrivs:\t1", joined)

    def test_hostile_inputs_exit_126_without_output(self):
        self.require_target_syscalls()
        cases = [
            ("uid", {}), ("gid", {}), ("env", {}), ("argv", {}), ("fd", {}),
            ("stdio-alias", {}),
            ("socket", {}), ("credentials", {}), ("rights", {}), ("parent", {}),
            ("caps", {}), ("challenge", {}), ("ready", {}), ("wrong-session", {}),
            ("success", {"script_mode": "0644"}),
            ("success", {"script_owner": "65534"}),
            ("success", {"binary_mode": "0755"}),
        ]
        for mode, kwargs in cases:
            with self.subTest(mode=mode, kwargs=kwargs):
                proc = self.run_image(mode, **kwargs)
                self.assertEqual(proc.returncode, 126, proc.stderr)
                self.assertEqual(proc.stdout, "")
                self.assertEqual(proc.stderr, "")

    def test_local_gate_is_explicit_not_bypassed(self):
        proc = self.run_image()
        if self.gate == [0, 0, 0, 0]:
            self.assertEqual(proc.returncode, 0, proc.stderr)
        else:
            self.assertEqual(proc.returncode, 126)
            self.assertEqual(proc.stdout, "")
            self.assertEqual(proc.stderr, "")

if __name__ == "__main__":
    unittest.main()
