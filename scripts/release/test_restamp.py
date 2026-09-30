#!/usr/bin/env python3
"""Test battery for the continuous-artifact restamp (the consume route's
packaging half, release.yml's beta channel).

The beta release consumes the continuous build's artifacts and restamps
them to the beta version (scripts/release/restamp_continuous.py): no
rebuild, the built bytes stay the continuous build's. This battery pins the
restamp's contracts on a SYNTHETIC continuous artifact set built by the
real assembler (`assemble_artifacts.py --sha`, the exact shape continuous.yml
uploads), with the security case first: the restamp must refuse anything
that is not the named commit's continuous build.

The fixture binary mirrors the shipped runtime contract the restamp
relies on (pa-cli config::version): it prints the version from the
exe-adjacent `package.json` at runtime, falling back to a compiled-in
version when the manifest is unreadable — so the livecheck proves the
version restamp through the same mechanism the update flow reads.

Run: python3 scripts/release/test_restamp.py  (or: make restamp-gates)
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from assemble_artifacts import TARGET_ALIASES  # noqa: E402  (same release-scripts directory)

ASSEMBLER = SCRIPTS_DIR / "assemble_artifacts.py"
SPLITTER = SCRIPTS_DIR / "split_debug.py"
BUNDLER = SCRIPTS_DIR / "bundle_catalog.py"
RESTAMPER = SCRIPTS_DIR / "restamp_continuous.py"
DECODER_VERIFIER = SCRIPTS_DIR / "verify_decoders.py"
VERIFIER = SCRIPTS_DIR / "verify_release.py"

HOST_TARGET = "x86_64-unknown-linux-gnu"
HOST_ALIAS = TARGET_ALIASES[HOST_TARGET]
DARWIN_TARGET = "x86_64-apple-darwin"
DARWIN_ALIAS = TARGET_ALIASES[DARWIN_TARGET]

# The runtime version resolver the shipped binary implements
# (pa-cli config::version parity: the exe-adjacent package.json wins at
# runtime; the compiled-in version is the fallback when the manifest is
# missing or malformed).
VERSION_RESOLVER_C = r'''#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        FILE *manifest = fopen("package.json", "r");
        if (manifest) {
            char line[512];
            while (fgets(line, sizeof(line), manifest)) {
                char *key = strstr(line, "\"version\"");
                if (!key) continue;
                char *start = strchr(key + 10, '"');
                if (!start) break;
                char *end = strchr(start + 1, '"');
                if (!end) break;
                fwrite(start + 1, 1, end - start - 1, stdout);
                putchar('\n');
                fclose(manifest);
                return 0;
            }
            fclose(manifest);
        }
        puts("%s");
        return 0;
    }
    puts("prime-agent (test fixture)");
    return 0;
}
'''


def run_cli(script, args, cwd=None):
    return subprocess.run([sys.executable, str(script), *args],
                          capture_output=True, text=True, cwd=cwd or REPO,
                          check=False)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class ContinuousFixture:
    """A synthetic continuous artifact set, the exact shape continuous.yml
    uploads: a real (tiny) ELF with a split-debug decoder, assembled by the
    real assembler with the commit stamp."""

    def __init__(self, root: Path, version: str, sha: str):
        self.root = root
        self.version = version
        self.sha = sha
        (root / "skills").mkdir(parents=True)
        (root / "skills" / "skill.md").write_text("# skill\n")
        (root / "LICENSE").write_text("license\n")
        (root / "README.md").write_text("readme\n")
        runtime = root / "runtime"
        runtime.mkdir()
        (runtime / "pyproject.toml").write_text("[project]\nname='rlm'\n")
        (runtime / "src").mkdir()
        (root / "prime-agent-runtime").mkdir()
        (root / "prime-agent-runtime" / "pyproject.toml").write_text("[project]\nname='rlm'\n")

        source = root / "resolver.c"
        source.write_text(VERSION_RESOLVER_C % version)
        self.raw = root / "bin" / "cargo-prime-agent"
        self.raw.parent.mkdir()
        subprocess.run(["gcc", "-g", "-Wl,--build-id", "-o", str(self.raw),
                        str(source)], check=True)
        self.binary = root / "bin" / "prime-agent"
        self.decoder = root / "bin" / f"prime-agent-{version}-{HOST_ALIAS}.debug.gz"
        split = run_cli(SPLITTER, ["--binary", str(self.raw), "--shipped",
                                   str(self.binary), "--out", str(self.binary.parent),
                                   "--version", version, "--target", HOST_TARGET])
        if split.returncode:
            raise AssertionError(split.stderr)
        self.catalog = root / "catalog-assets"
        bundled = run_cli(BUNDLER, ["generate", "--fixture", "--out", str(self.catalog)])
        if bundled.returncode:
            raise AssertionError(bundled.stderr)
        self.dist = root / "dist"
        self.dist.mkdir()
        self.assemble_into(self.dist, sha=sha)

    def assemble_into(self, out_dir: Path, sha: str | None, target: str = HOST_TARGET):
        args = ["--repo-root", str(self.root), "--version", self.version,
                "--target", target, "--binary", str(self.binary),
                "--runtime-dir", str(self.root / "runtime"),
                "--out-dir", str(out_dir)]
        if target.endswith("-unknown-linux-gnu"):
            args += ["--decoder", str(self.decoder)]
        if sha:
            args += ["--sha", sha]
        args += ["--catalog-assets", str(self.catalog)]
        result = run_cli(ASSEMBLER, args)
        if result.returncode:
            raise AssertionError(result.stderr)
        # The CI build jobs point --decoder at the dist tree (split_debug
        # writes it there), so the decoder rides the assembled set; the
        # fixture mirrors that layout.
        if target.endswith("-unknown-linux-gnu"):
            shutil.copyfile(self.decoder,
                            out_dir / f"prime-agent-{self.version}-{HOST_ALIAS}.debug.gz")
        return out_dir

    def artifact_dir(self, out_dir: Path, target: str = HOST_TARGET) -> Path:
        """The per-target layout continuous.yml uploads (download-artifact
        places one directory per artifact when a run has more than one)."""
        dist = out_dir / f"artifacts-{target}"
        dist.mkdir()
        archive = out_dir / f"prime-agent-{self.version}-{TARGET_ALIASES[target]}.tar.gz"
        shutil.move(str(archive), str(dist / archive.name))
        for name in ("SHA256SUMS", "manifest.json"):
            shutil.move(str(out_dir / name), str(dist / name))
        if target.endswith("-unknown-linux-gnu"):
            decoder = out_dir / f"prime-agent-{self.version}-{HOST_ALIAS}.debug.gz"
            shutil.move(str(decoder), str(dist / decoder.name))
        return dist


class RestampTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.commit = "a" * 40
        self.fixture = ContinuousFixture(self.root / "repo", "9.9.9", self.commit)
        self.incoming = self.root / "incoming"
        shutil.copytree(self.fixture.artifact_dir(self.fixture.dist),
                        self.incoming / f"artifacts-{HOST_TARGET}")

    def tearDown(self):
        self.tmp.cleanup()

    def restamp(self, version="9.9.9-beta.2", commit=None, expect=0):
        out = self.root / "restamped"
        result = run_cli(RESTAMPER, [
            "--incoming", str(self.incoming), "--version", version,
            "--expect-commit", commit or self.commit, "--out-dir", str(out)])
        self.assertEqual(result.returncode, expect,
                         f"restamp rc={result.returncode}: {result.stderr}")
        return result, out


class TheProvenanceCase(RestampTestCase):
    """The restamp consumes ONLY the named commit's continuous build."""

    def test_a_foreign_commit_is_refused(self):
        result, _ = self.restamp(commit="b" * 40, expect=1)
        self.assertIn("not the continuous builds of the commit", result.stderr)

    def test_a_release_build_without_the_continuous_stamp_is_refused(self):
        plain = self.root / "plain-dist"
        plain.mkdir()
        self.fixture.assemble_into(plain, sha=None)  # a release-shaped set, no package.json
        shutil.rmtree(self.incoming / f"artifacts-{HOST_TARGET}")
        shutil.copytree(self.fixture.artifact_dir(plain), self.incoming / f"artifacts-{HOST_TARGET}")
        result, _ = self.restamp(expect=1)
        # The provenance gate fires first (a release-shaped set carries no
        # commit row); either refusal names the missing continuous stamp.
        self.assertTrue(
            "not the continuous builds of the commit" in result.stderr
            or "not a continuous build's artifact" in result.stderr,
            result.stderr)

    def test_a_tampered_archive_is_refused(self):
        archive = self.incoming / f"artifacts-{HOST_TARGET}" / f"prime-agent-9.9.9-{HOST_ALIAS}.tar.gz"
        data = bytearray(archive.read_bytes())
        data[-1] ^= 0xFF
        archive.write_bytes(bytes(data))
        result, _ = self.restamp(expect=1)
        self.assertIn("does not match its SHA256SUMS", result.stderr)


class TheRestampCase(RestampTestCase):
    """The restamped set is the release shape at the beta version, built
    bytes unchanged."""

    def test_the_continuous_artifact_passes_its_native_livecheck(self):
        # The continuous matrix now runs this verifier on every native runner
        # before uploading: exercise its --sha path on the assembled set.
        verified = run_cli(VERIFIER, [
            "--dist-dir", str(self.incoming / f"artifacts-{HOST_TARGET}"),
            "--version", self.fixture.version, "--target", HOST_TARGET,
            "--sha", self.commit])
        self.assertEqual(verified.returncode, 0, verified.stderr)
        self.assertIn("livecheck all OK", verified.stdout)

    def restamped_assertions(self, out: Path, version: str):
        target_dir = out / f"artifacts-{HOST_TARGET}"
        archive = target_dir / f"prime-agent-{version}-{HOST_ALIAS}.tar.gz"
        self.assertTrue(archive.is_file(), "the restamped archive is renamed to the version")
        manifest = json.loads((target_dir / "manifest.json").read_text())
        self.assertEqual(manifest["version"], f"v{version}")
        self.assertEqual(manifest["commit"], self.commit)
        binary = manifest["binaries"][0]
        self.assertEqual(binary["file"], archive.name)
        self.assertEqual(binary["sha256"], digest(archive))
        self.assertEqual(binary["executableSha256"],
                         json.loads((self.incoming / f"artifacts-{HOST_TARGET}" / "manifest.json")
                                    .read_text())["binaries"][0]["executableSha256"])
        sums = {line.split()[1]: line.split()[0]
                for line in (target_dir / "SHA256SUMS").read_text().splitlines() if line.strip()}
        decoder_name = f"prime-agent-{version}-{HOST_ALIAS}.debug.gz"
        self.assertEqual(set(sums), {archive.name, decoder_name})
        # The decoder's bytes are the continuous build's, only renamed.
        old_decoder = self.incoming / f"artifacts-{HOST_TARGET}" / f"prime-agent-9.9.9-{HOST_ALIAS}.debug.gz"
        self.assertEqual(digest(target_dir / decoder_name), digest(old_decoder))
        self.assertEqual(manifest["decoders"][0]["file"], decoder_name)
        # The inner runtime version manifest is what the update flow reads.
        with tarfile.open(archive) as tar:
            package = json.load(tar.extractfile("package.json"))
        self.assertEqual(package["version"], version)
        self.assertEqual(package["commit"], self.commit)
        return target_dir

    def test_the_beta_version_lands_end_to_end(self):
        version = "9.9.9-beta.2"
        result, out = self.restamp(version=version)
        self.restamped_assertions(out, version)
        # The shipped binary reports the beta version through the package.json
        # the restamp rewrote (config::version parity: the exe-adjacent
        # manifest wins at runtime), and the promote-side decoder gate passes
        # on the restamped set — the two integration seams of the consume route.
        self.assertIn(f'"livecheck": "{version}"', result.stdout)
        verify = run_cli(DECODER_VERIFIER, [str(out)])
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertIn("OK", verify.stdout)
        # The release verifier accepts the restamped shape with its exact
        # gate set: payload, checksums, manifest, catalog assets, livecheck.
        target_dir = out / f"artifacts-{HOST_TARGET}"
        verified = run_cli(VERIFIER, [
            "--dist-dir", str(target_dir), "--version", version,
            "--target", HOST_TARGET, "--expect-package-json", version])
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_a_non_gnu_target_restamps_without_a_decoder(self):
        darwin = self.fixture.assemble_into(self.root / "darwin-dist", sha=self.commit,
                                            target=DARWIN_TARGET)
        shutil.copytree(self.fixture.artifact_dir(darwin, target=DARWIN_TARGET),
                        self.incoming / f"artifacts-{DARWIN_TARGET}")
        result, out = self.restamp(version="9.9.9-beta.7")
        target_dir = out / f"artifacts-{DARWIN_TARGET}"
        archive = target_dir / f"prime-agent-9.9.9-beta.7-{DARWIN_ALIAS}.tar.gz"
        self.assertTrue(archive.is_file())
        manifest = json.loads((target_dir / "manifest.json").read_text())
        self.assertEqual(manifest["version"], "v9.9.9-beta.7")
        self.assertNotIn("decoders", manifest)
        sums = (target_dir / "SHA256SUMS").read_text().splitlines()
        self.assertEqual(len(sums), 1)
        # The foreign-arch set cannot execute on this host: restamp skips its
        # livecheck; continuous verified it earlier on its native runner.
        self.assertIn('"livecheck": null', result.stdout)

    def test_an_escaping_tar_member_is_refused_before_any_write(self):
        """The tar-slip class: a member named `..`/absolute must never be
        extracted outside the staging tree (the payload gate runs only
        after the unpack, so the traversal guard is the unpack's own)."""
        import tarfile
        staging = self.root / "sneak"
        staging.mkdir()
        target = self.incoming / f"artifacts-{HOST_TARGET}"
        archive = target / f"prime-agent-9.9.9-{HOST_ALIAS}.tar.gz"
        with tarfile.open(archive) as tar:
            tar.extractall(staging)
        malicious = staging / "prime-agent-9.9.9-evil.tar.gz"
        with tarfile.open(malicious, "w:gz") as tar:
            info = tarfile.TarInfo("../escaped-payload")
            payload = b"outside the staging tree"
            info.size = len(payload)
            tar.addfile(info, __import__("io").BytesIO(payload))
        import hashlib
        new_sha = hashlib.sha256(malicious.read_bytes()).hexdigest()
        shutil.move(str(malicious), str(archive))
        sums = (target / "SHA256SUMS").read_text().splitlines()
        (target / "SHA256SUMS").write_text("\n".join(
            new_sha + line[64:] if line.split()[1] == archive.name else line
            for line in sums) + "\n")
        manifest = json.loads((target / "manifest.json").read_text())
        manifest["binaries"][0]["sha256"] = new_sha
        (target / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        result, _ = self.restamp(expect=1)
        self.assertIn("escaping member", result.stderr)
        self.assertFalse((self.root / "escaped-payload").exists(),
                          "no byte may land outside the staging tree")

    def test_repacking_is_deterministic(self):
        _, first = self.restamp(version="9.9.9-beta.3")
        first_archive = digest(first / f"artifacts-{HOST_TARGET}" /
                               f"prime-agent-9.9.9-beta.3-{HOST_ALIAS}.tar.gz")
        _, second = self.restamp(version="9.9.9-beta.3")
        second_archive = digest(second / f"artifacts-{HOST_TARGET}" /
                                f"prime-agent-9.9.9-beta.3-{HOST_ALIAS}.tar.gz")
        self.assertEqual(first_archive, second_archive)

    def test_a_foreign_payload_is_refused(self):
        # Sneak an unexpected top-level file into the set and rebuild the
        # archive deterministically; the sums stay stale, so this also proves
        # the integrity gate fires before the payload gate ever matters.
        staging = self.root / "sneak"
        staging.mkdir()
        archive = self.incoming / f"artifacts-{HOST_TARGET}" / f"prime-agent-9.9.9-{HOST_ALIAS}.tar.gz"
        with tarfile.open(archive) as tar:
            tar.extractall(staging)
        (staging / "EXTRA").write_text("unexpected\n")
        entries = sorted(p.name for p in staging.iterdir())
        from assemble_artifacts import pack_tarball
        rebuilt = staging / f"prime-agent-9.9.9-{HOST_ALIAS}.tar.gz"
        pack_tarball(staging, rebuilt, entries)
        shutil.move(str(rebuilt), str(archive))
        result, _ = self.restamp(expect=1)
        self.assertTrue("does not match its SHA256SUMS" in result.stderr
                        or "!= the continuous payload" in result.stderr,
                        result.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
