from __future__ import annotations

import hashlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import worker
from schema import Side


class ReleasePreparationTests(unittest.TestCase):
    def test_packages_the_selected_release_format_and_complete_checksums(self):
        for native in (False, True):
            with self.subTest(native=native), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = root / "source"
                agent = source / "packages/coding-agent"
                artifacts = agent / "release/benchmark/artifacts"
                artifacts.mkdir(parents=True)
                if native:
                    for script in (
                        agent / "scripts/build-binary.mjs",
                        source / "scripts/assemble-release-archives.mjs",
                    ):
                        script.parent.mkdir(parents=True, exist_ok=True)
                        script.touch()
                calls = []

                def run_as(user, command, cwd, calls=calls, artifacts=artifacts, **options):
                    calls.append((user, command, cwd, options))
                    if command == ["git", "rev-parse", "HEAD"]:
                        return "a" * 40
                    if "scripts/pack-prime-agent-release.mjs" in command:
                        for name in ("agent", "ai", "core", "tui"):
                            (artifacts / f"{name}.tgz").write_bytes(name.encode())
                    if any(arg.endswith("assemble-release-archives.mjs") for arg in command):
                        (artifacts / f"prime-agent-{worker.VERSION}-linux-x64.tar.gz").write_bytes(b"native")
                        (artifacts / "SHA256SUMS").write_text("native-only inventory\n")
                    return "fixture"

                read_text = Path.read_text

                def read(path, *args, original=read_text, **kwargs):
                    return (
                        "model name: fixture\n"
                        if str(path) == "/proc/cpuinfo"
                        else original(path, *args, **kwargs)
                    )

                side = Side(sha="a" * 40)
                with (
                    patch.object(worker, "SOURCE", source),
                    patch.object(worker, "ROOT", root),
                    patch.object(worker, "RESULTS", root),
                    patch.object(worker, "run_as", side_effect=run_as),
                    patch("worker.pwd.getpwnam", return_value=SimpleNamespace(pw_uid=1, pw_gid=1)),
                    patch("worker.os.chown"),
                    patch(
                        "worker.os.uname", return_value=SimpleNamespace(release="fixture", machine="x86_64")
                    ),
                    patch.object(Path, "read_text", read),
                ):
                    worker.prepare(SimpleNamespace(source_repository="owner/repo", sha="a" * 40), side)
                archives = sorted([*artifacts.glob("*.tgz"), *artifacts.glob("*.tar.gz")])
                self.assertEqual(len(archives), 5 if native else 4)
                self.assertEqual(
                    side.metrics["bundle"][0].value, sum(path.stat().st_size for path in archives)
                )
                self.assertEqual(
                    (artifacts / "SHA256SUMS").read_text(),
                    "".join(
                        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in archives
                    ),
                )
                self.assertEqual(
                    (root / "www/releases" / f"v{worker.VERSION}").resolve(), artifacts.resolve()
                )
                builds = [call for call in calls if "--platform" in call[1]]
                self.assertEqual(len(builds), int(native))
                if native:
                    self.assertEqual(builds[0][1][-2:], ["--platform", "linux-x64"])
                    self.assertEqual(
                        builds[0][3]["extra_env"]["BUN_BINARY"],
                        str(source / ".benchmark-bun/node_modules/.bin/bun"),
                    )
                    self.assertEqual(side.runtime["artifact_format"], "npm-tarballs+linux-x64-native")
                else:
                    self.assertEqual(side.runtime["artifact_format"], "npm-tarballs")
                    self.assertFalse(any(any("bun@" in arg for arg in call[1]) for call in calls))

    def test_incomplete_native_build_does_not_silently_benchmark_node(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            agent = source / "packages/coding-agent"
            script = agent / "scripts/build-binary.mjs"
            script.parent.mkdir(parents=True)
            script.touch()
            with patch.object(worker, "SOURCE", source), self.assertRaisesRegex(RuntimeError, "incomplete"):
                worker.prepare_native_artifact(agent, source, source / "log")

    def test_install_enables_only_the_loopback_test_exception(self):
        with (
            patch("worker.subprocess.run"),
            patch("worker.disk_bytes", return_value=0),
            patch("worker.stop_processes"),
            patch(
                "worker.run_as", side_effect=RuntimeError("stop after inspecting installer arguments")
            ) as run,
        ):
            worker.install(SimpleNamespace(), Side(sha="a" * 40), 0)
        env = run.call_args.kwargs["extra_env"]
        self.assertEqual(env["PRIME_AGENT_ALLOW_INSECURE_HTTP_FOR_TESTS"], "1")
        self.assertEqual(env["PRIME_AGENT_DOWNLOAD_BASE_URL"], worker.ORIGIN)
        self.assertNotIn("PRIME_AGENT_INSTALL_METHOD", env)


if __name__ == "__main__":
    unittest.main()
