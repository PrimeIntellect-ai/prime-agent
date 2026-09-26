#!/usr/bin/env python3
"""Test battery for the bundled-catalog build assets (catalog spec §5 gates).

Offline: the fixture mode must produce assets that pass the FULL validation
gates, the packer must hard-fail on missing/invalid assets (negative tests),
network mode is verified against a local HTTP server (byte parity, auth
header, redirect refusal, size cap), and the assets must land in the package
layout the installer expects (assemble + verify against a synthetic repo
tree, including the commit-stamped continuous flow).

Run: python3 scripts/release/test_catalog_assets.py  (or: make catalog-assets-gates)
"""

from __future__ import annotations

import contextlib
import http.server
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent
REPO = SCRIPTS_DIR.parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import bundle_catalog  # noqa: E402  (same release-scripts directory)
from assemble_artifacts import TARGET_ALIASES  # noqa: E402  (same directory)

BUNDLER = SCRIPTS_DIR / "bundle_catalog.py"
ASSEMBLER = SCRIPTS_DIR / "assemble_artifacts.py"
VERIFIER = SCRIPTS_DIR / "verify_release.py"
PACKER = REPO / "scripts" / "package_release.py"

HOST_TARGET = "x86_64-unknown-linux-gnu"
# Archives carry the TS platform alias (the name the update flow's channel
# manifest requires): prime-agent-<version>-<platform>.tar.gz.
HOST_ARCHIVE_PLATFORM = TARGET_ALIASES[HOST_TARGET]


def run_cli(script, args, env_extra=None, cwd=None):
    env = dict(os.environ)
    env.pop("GITHUB_TOKEN", None)
    env.pop("PRIME_CATALOG_REPO_TOKEN", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, str(script), *args],
        capture_output=True, text=True, env=env, cwd=cwd or REPO, check=False,
    )


class RecordingServer:
    """A local HTTP stand-in for the catalog repo (never touches the network)."""

    def __init__(self, routes):
        self.seen_headers = []
        handler = self._make_handler(routes)
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def _make_handler(self, routes):
        seen = self.seen_headers
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append(dict(self.headers))
                route = routes.get(self.path)
                if route is None:
                    self.send_response(404)
                    self.send_header("content-length", "0")
                    self.end_headers()
                    return
                body, headers, status = route
                self.send_response(status)
                for name, value in headers.items():
                    self.send_header(name, value)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        return Handler

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class DripServer:
    """A response that always has another chunk on the way (the slow-drip
    shape): individual reads never hit the socket timeout, so only a TOTAL
    deadline can stop the fetch."""

    def __init__(self, interval=0.3, chunk=b"x" * 1024):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                # Under the 20 MiB cap so the size pre-check passes and the
                # read loop actually runs: only the deadline can end it (the
                # drip never reaches the advertised length in time).
                self.send_header("content-length", str(4 * 1024 * 1024))
                self.end_headers()
                try:
                    while True:
                        self.wfile.write(chunk)
                        self.wfile.flush()
                        time.sleep(interval)
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def log_message(self, *args):
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class SyntheticRepo:
    """A minimal repo tree the assembler/verifier/packer accept."""

    def __init__(self, root: Path, version: str = "9.9.9", sha: str | None = None):
        self.root = root
        self.version = version
        (root / "skills").mkdir(parents=True)
        (root / "skills" / "skill.md").write_text("# skill\n")
        (root / "docs").mkdir()
        # Every user-facing doc SHIPPED_DOC_ENTRIES requires (fail-closed
        # packaging gate): the synthetic repo stages all three.
        for doc in ("MODEL-SURFACE.md", "RUST_QUICKSTART.md", "keybindings.md"):
            (root / "docs" / doc).write_text("# doc\n")
        (root / "LICENSE").write_text("license\n")
        (root / "README.md").write_text("readme\n")
        runtime = root / "runtime"
        runtime.mkdir()
        (runtime / "pyproject.toml").write_text("[project]\nname='rlm'\n")
        (runtime / "src").mkdir()
        # The exe-adjacent kernel runtime tree package_release.py stages.
        kernel = root / "prime-agent-runtime"
        (kernel / "src" / "rlm").mkdir(parents=True)
        (kernel / "pyproject.toml").write_text("[project]\nname='rlm'\n")
        (kernel / "src" / "rlm" / "repl.py").write_text("# repl\n")
        # The fake binary: prints the version the verifier expects.
        printed = version if sha is None else f"{version}-continuous.{sha}"
        (runtime / "src" / "repl.py").write_text("# repl\n")
        self.binary = root / "bin" / "prime-agent"
        self.binary.parent.mkdir()
        self.binary.write_text(f"#!/bin/sh\necho {printed}\n")
        self.binary.chmod(0o755)

    def assemble(self, out_dir, catalog_assets=None, sha=None, target=HOST_TARGET):
        args = [
            "--repo-root", str(self.root), "--version", self.version,
            "--target", target, "--binary", str(self.binary),
            "--runtime-dir", str(self.root / "runtime"),
            "--out-dir", str(out_dir),
        ]
        if sha:
            args += ["--sha", sha]
        if catalog_assets is not None:
            args += ["--catalog-assets", str(catalog_assets)]
        return run_cli(ASSEMBLER, args)


class ValidationGates(unittest.TestCase):

    def test_fixture_passes_the_full_gates(self):
        """Offline build verifier: --fixture produces a VALIDATED snapshot
        (>= 42 transport tuples, >= 68 services) without any network."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            result = run_cli(BUNDLER, ["generate", "--fixture", "--out", str(out)])
            self.assertEqual(result.returncode, 0, result.stderr)
            facts = json.loads(result.stdout)
            self.assertGreaterEqual(facts["models"]["transportTuples"],
                                    bundle_catalog.MIN_MODEL_TRANSPORT_TUPLES)
            self.assertGreaterEqual(facts["mcpServices"]["services"],
                                    bundle_catalog.MIN_MCP_SERVICES)
            # The verify command (no small-fixture waiver) agrees.
            verify = run_cli(BUNDLER, ["verify", "--out", str(out)])
            self.assertEqual(verify.returncode, 0, verify.stderr)
            self.assertGreaterEqual(
                json.loads(verify.stdout)["mcpServices"]["services"],
                bundle_catalog.MIN_MCP_SERVICES)

    def test_fixture_shapes_match_the_catalog_contract(self):
        bodies = bundle_catalog.fixture_catalog_bodies()
        models = json.loads(bodies["models.bundled.json"])
        self.assertEqual(set(models), {"schemaVersion", "models"})
        self.assertEqual(models["schemaVersion"], 1)
        seen_tuples = set()
        for model in models["models"]:
            # Strict model schema (spec §1.1): no headers, bounded fields.
            self.assertNotIn("headers", model)
            for field in ("id", "name"):
                self.assertTrue(1 <= len(model[field]) <= 1024)
                self.assertFalse(any(ord(ch) < 0x20 for ch in model[field]))
            self.assertLessEqual(len(model["provider"]), 128)
            self.assertLessEqual(len(model["baseUrl"]), 2048)
            self.assertLessEqual(len(model["input"]), 2)
            self.assertTrue(set(model["input"]) <= {"text", "image"})
            self.assertIn(model["api"], ("anthropic-messages", "openai-completions",
                                        "openai-responses", "bedrock-converse-stream",
                                        "google-generative-ai", "google-vertex",
                                        "mistral-conversations", "openai-codex-responses",
                                        "azure-openai-responses"))
            for cost in model["cost"].values():
                self.assertTrue(0 <= cost <= 1_000_000)
            self.assertLessEqual(model["contextWindow"], 100_000_000)
            self.assertLessEqual(model["maxTokens"], 100_000_000)
            seen_tuples.add((model["provider"], model["api"], model["baseUrl"]))
        self.assertGreaterEqual(len(seen_tuples), 42)

        plugins = json.loads(bodies["mcp-services.bundled.json"])
        # Envelope: exactly version, counts, entries, in order.
        self.assertEqual(list(plugins), ["version", "counts", "entries"])
        self.assertEqual(plugins["version"], 2)
        self.assertEqual(set(plugins["counts"]), set(bundle_catalog.COUNTS_KEYS))
        transports = {"http", "http-template", "sse", "stdio"}
        auths = {"oauth", "api_key", "none", "unknown"}
        readiness = {"oauth-ready", "user-setup", "prime-restricted", "unknown"}
        setups, verifications = set(), set()
        for entry in plugins["entries"]:
            self.assertRegex(entry["server"], r"^[a-z0-9][a-z0-9-]{0,63}$")
            self.assertIn(entry["transport"]["type"], transports)
            self.assertIn(entry["auth"]["strategy"], auths)
            self.assertIn(entry["setup"]["readiness"], readiness)
            setups.add(entry["setup"]["status"])
            verifications.add(entry["verification"]["status"])
            self.assertEqual(entry["aliases"],
                             sorted(a.lower() for a in entry["aliases"]))
            self.assertNotIn(entry["server"], entry["aliases"])
            self.assertNotIn("clientId", json.dumps(entry))
            self.assertNotIn("clientSecret", json.dumps(entry))
        # Every shape branch is exercised.
        self.assertEqual(setups, {"ready", "requires-setup"})
        self.assertEqual(verifications, {"metadata-reviewed", "unverified"})
        self.assertEqual(plugins["counts"]["total"], len(plugins["entries"]))
        self.assertGreaterEqual(len(plugins["entries"]), 68)

    def test_validation_rejects_bad_envelopes_and_minimums(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            good = json.loads(bundle_catalog.fixture_catalog_bodies()
                              ["mcp-services.bundled.json"])
            (out / "models.bundled.json").write_text(
                json.dumps({"schemaVersion": 1, "models": []}))
            (out / "mcp-services.bundled.json").write_text(json.dumps(good))
            with self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_model_catalog(
                    out / "models.bundled.json")  # 0 tuples < 42
            small = {"schemaVersion": 1, "models": [json.loads(
                bundle_catalog.fixture_catalog_bodies()["models.bundled.json"]
            )["models"][0]]}
            (out / "models.bundled.json").write_text(json.dumps(small))
            # The small-fixture waiver skips the minimum-count gate only.
            bundle_catalog.validate_bundled_model_catalog(
                out / "models.bundled.json", allow_small_fixture=True)
            bad_version = dict(good, version=3)
            (out / "mcp-services.bundled.json").write_text(json.dumps(bad_version))
            with self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_mcp_catalog(
                    out / "mcp-services.bundled.json", allow_small_fixture=True)
            (out / "mcp-services.bundled.json").write_text("{not json")
            with self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_mcp_catalog(
                    out / "mcp-services.bundled.json", allow_small_fixture=True)
            # A missing asset fails the dir gate with an actionable message.
            with contextlib.redirect_stderr(io.StringIO()) as captured, \
                    self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_catalog_dir(out / "nowhere")
            self.assertIn("Missing bundled catalog asset", captured.getvalue())

    def test_fixture_covers_paste_flow_and_builtin_shapes(self):
        """The special entries the runtime MCP lane consumes: one shared
        credentialSet alias pair (pasteable), two distinct credential sets
        (never pasteable), an api-key setup field, and the legacy builtins."""
        plugins = json.loads(
            bundle_catalog.fixture_catalog_bodies()["mcp-services.bundled.json"])
        by_server = {entry["server"]: entry for entry in plugins["entries"]}
        pasteable = by_server["fixture-paste-single"]
        sets = {field["credentialSet"] for field in pasteable["setup"]["fields"]}
        self.assertEqual(len(pasteable["setup"]["fields"]), 2)
        self.assertEqual(sets, {"fixture-pat"})  # alias names, one credential
        multi = by_server["fixture-paste-multi-cred"]
        sets = {field["credentialSet"] for field in multi["setup"]["fields"]}
        self.assertEqual(len(sets), 2)  # fail-closed: NOT pasteable
        api_key = by_server["fixture-api-key"]
        self.assertEqual(api_key["setup"]["fields"][0]["kind"], "api-key")
        for builtin in ("linear", "notion"):
            self.assertTrue(by_server[builtin]["legacyBuiltin"])
        # Counts stay derived: total counts every entry including specials.
        self.assertEqual(plugins["counts"]["total"], len(plugins["entries"]))
        self.assertEqual(
            plugins["counts"]["total"],
            bundle_catalog.MIN_MCP_SERVICES + 5)

    def test_small_fixture_verify_waiver(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            out.mkdir()
            small_models = {"schemaVersion": 1, "models": [
                {"id": "x", "name": "X", "api": "openai-responses",
                 "provider": "openai", "baseUrl": "https://api.openai.com/v1",
                 "reasoning": False, "input": ["text"],
                 "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
                 "contextWindow": 128000, "maxTokens": 4096}]}
            small_plugins = {"version": 2, "counts": {}, "entries": []}
            (out / "models.bundled.json").write_text(json.dumps(small_models))
            (out / "mcp-services.bundled.json").write_text(json.dumps(small_plugins))
            strict = run_cli(BUNDLER, ["verify", "--out", str(out)])
            self.assertNotEqual(strict.returncode, 0)
            self.assertIn("transport tuples", strict.stderr)
            waived = run_cli(BUNDLER,
                             ["verify", "--out", str(out), "--allow-small-fixture"])
            self.assertEqual(waived.returncode, 0, waived.stderr)

    def test_fixture_http_template_entries_match_the_runtime_schema(self):
        """Regression (Cursor Bugbot): the fixture's http-template entries
        must parse under the runtime's strict catalog_schema — template
        variables are {name, description} objects and the entry url is empty
        (a fail-closed runtime parse drops the whole asset otherwise)."""
        plugins = json.loads(bundle_catalog.fixture_catalog_bodies()
                             ["mcp-services.bundled.json"])
        templates = [entry for entry in plugins["entries"]
                     if entry["transport"]["type"] == "http-template"]
        self.assertTrue(templates, "the fixture must exercise the http-template shape")
        for entry in templates:
            transport = entry["transport"]
            self.assertEqual(set(transport), {"type", "template", "variables"})
            self.assertTrue(transport["template"])
            self.assertTrue(transport["variables"])
            for variable in transport["variables"]:
                self.assertEqual(set(variable), {"name", "description"})
                self.assertTrue(variable["name"])
                self.assertTrue(variable["description"])
            self.assertEqual(entry["url"], "")

    def test_validator_rejects_runtime_invalid_plugin_shapes(self):
        """The packaging gate must reject shapes the runtime rejects (the
        pre-fix fixture bug: string template variables + non-empty url)."""
        with tempfile.TemporaryDirectory() as tmp:
            catalog = json.loads(bundle_catalog.fixture_catalog_bodies()
                                 ["mcp-services.bundled.json"])
            entry = next(item for item in catalog["entries"]
                         if item["transport"]["type"] == "http-template")
            entry["transport"]["variables"] = ["region"]
            path = Path(tmp) / "mcp-services.bundled.json"
            path.write_text(json.dumps(catalog))
            with self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_mcp_catalog(path)

    def test_validator_rejects_models_missing_required_fields(self):
        """The packaging gate must reject model entries the runtime's strict
        parse would drop (missing cost/contextWindow pass the tuple count but
        fail the runtime schema)."""
        with tempfile.TemporaryDirectory() as tmp:
            models = {"schemaVersion": 1, "models": [json.loads(
                bundle_catalog.fixture_catalog_bodies()["models.bundled.json"]
            )["models"][0]]}
            del models["models"][0]["cost"]
            del models["models"][0]["contextWindow"]
            path = Path(tmp) / "models.bundled.json"
            path.write_text(json.dumps(models))
            with self.assertRaises(SystemExit):
                bundle_catalog.validate_bundled_model_catalog(
                    path, allow_small_fixture=True)


class CatalogDirMode(unittest.TestCase):

    def test_catalog_dir_copy_is_byte_identical(self):
        bodies = bundle_catalog.fixture_catalog_bodies()
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            checkout = tmp / "prime-agent-catalog"
            (checkout / "models").mkdir(parents=True)
            (checkout / "plugins").mkdir()
            (checkout / "models" / "catalog.v1.json").write_text(
                bodies["models.bundled.json"])
            (checkout / "plugins" / "catalog.v2.json").write_text(
                bodies["mcp-services.bundled.json"])
            out = tmp / "assets"
            result = run_cli(
                BUNDLER, ["generate", "--catalog-dir", str(checkout),
                          "--out", str(out)])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (out / "models.bundled.json").read_bytes(),
                (checkout / "models" / "catalog.v1.json").read_bytes())
            self.assertEqual(
                (out / "mcp-services.bundled.json").read_bytes(),
                (checkout / "plugins" / "catalog.v2.json").read_bytes())
            # A checkout missing a file fails loudly.
            (checkout / "plugins" / "catalog.v2.json").unlink()
            broken = run_cli(BUNDLER, ["generate", "--catalog-dir", str(checkout),
                                      "--out", str(tmp / "assets2")])
            self.assertNotEqual(broken.returncode, 0)
            self.assertIn("missing", broken.stderr)


class NetworkMode(unittest.TestCase):

    def setUp(self):
        bodies = bundle_catalog.fixture_catalog_bodies()
        no_newline = bodies["models.bundled.json"].rstrip("\n")
        self.server = RecordingServer({
            "/models/catalog.v1.json": (no_newline.encode(), {}, 200),
            "/plugins/catalog.v2.json": (bodies["mcp-services.bundled.json"].encode(), {}, 200),
            "/moved": (b"gone", {"location": "/models/catalog.v1.json"}, 302),
            "/huge": (b"x" * 1024,
                      {"content-length": str(bundle_catalog.MAX_REMOTE_CATALOG_BYTES + 1)},
                      200),
        })

    def tearDown(self):
        self.server.stop()

    def _generate(self, out, env_extra=None, extra=()):
        return run_cli(BUNDLER, [
            "generate", "--network",
            "--models-url", f"{self.server.base}/models/catalog.v1.json",
            "--mcp-services-url", f"{self.server.base}/plugins/catalog.v2.json",
            "--out", str(out), *extra,
        ], env_extra=env_extra)

    def test_network_fetch_is_byte_identical_and_normalizes_newlines(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            result = self._generate(out)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                (out / "models.bundled.json").read_text(),
                bundle_catalog.fixture_catalog_bodies()["models.bundled.json"])
            self.assertEqual(
                (out / "mcp-services.bundled.json").read_text(),
                bundle_catalog.fixture_catalog_bodies()["mcp-services.bundled.json"])

    def test_network_sends_bearer_only_when_configured(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            # Without a token: no Authorization header.
            self.server.seen_headers.clear()
            result = self._generate(out)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(self.server.seen_headers)
            self.assertTrue(all(
                "Authorization" not in headers for headers in self.server.seen_headers))
            # With GITHUB_TOKEN: Bearer rides both fetches.
            self.server.seen_headers.clear()
            result = self._generate(Path(tmp) / "assets2",
                                    env_extra={"GITHUB_TOKEN": "sekrit"})
            self.assertEqual(result.returncode, 0, result.stderr)
            auth_headers = [h.get("Authorization") for h in self.server.seen_headers]
            self.assertEqual(auth_headers, ["Bearer sekrit", "Bearer sekrit"])

    def test_network_failures_are_hard_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            # 404 -> hard fail with the private-repo hint.
            result = run_cli(BUNDLER, ["generate", "--network",
                                       "--models-url", f"{self.server.base}/missing",
                                       "--mcp-services-url",
                                       f"{self.server.base}/plugins/catalog.v2.json",
                                       "--out", str(out)])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("HTTP 404", result.stderr)
            # Redirects are refused (a moved catalog is a client change).
            result = run_cli(BUNDLER, ["generate", "--network",
                                       "--models-url", f"{self.server.base}/moved",
                                       "--mcp-services-url",
                                       f"{self.server.base}/plugins/catalog.v2.json",
                                       "--out", str(out)])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("refused redirect", result.stderr)
            # Oversized content-length is refused up front.
            result = run_cli(BUNDLER, ["generate", "--network",
                                       "--models-url", f"{self.server.base}/huge",
                                       "--mcp-services-url",
                                       f"{self.server.base}/plugins/catalog.v2.json",
                                       "--out", str(out)])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("too large", result.stderr)
            # No partial output may be left behind by a failed fetch.
            self.assertFalse((out / "models.bundled.json").exists())

    def test_conflicting_modes_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = run_cli(BUNDLER, ["generate", "--fixture", "--network",
                                      "--out", str(Path(tmp) / "assets")])
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("mutually exclusive", result.stderr)

    def test_failed_mcp_fetch_leaves_the_previous_snapshot_intact(self):
        """Both bodies are fetched before either target is replaced: a
        failed MCP fetch must not leave a mixed snapshot (fresh models file
        beside the previous services file)."""
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "assets"
            first = self._generate(out)
            self.assertEqual(first.returncode, 0, first.stderr)
            models_before = (out / "models.bundled.json").read_text()
            services_before = (out / "mcp-services.bundled.json").read_text()
            broken = RecordingServer({
                "/models/catalog.v1.json": (models_before.encode(), {}, 200),
                "/plugins/catalog.v2.json": (b"gone", {}, 404),
            })
            try:
                result = run_cli(BUNDLER, [
                    "generate", "--network",
                    "--models-url", f"{broken.base}/models/catalog.v1.json",
                    "--mcp-services-url", f"{broken.base}/plugins/catalog.v2.json",
                    "--out", str(out)])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("HTTP 404", result.stderr)
            finally:
                broken.stop()
            self.assertEqual((out / "models.bundled.json").read_text(),
                             models_before)
            self.assertEqual((out / "mcp-services.bundled.json").read_text(),
                             services_before)

    def test_network_fetch_enforces_a_total_deadline(self):
        """The 5 s timeout is the TOTAL fetch budget, not per blocking op: a
        slow-drip server that always delivers another chunk keeps every
        individual read alive, so only the absolute deadline ends it."""
        drip = DripServer()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "assets"
                started = time.monotonic()
                result = run_cli(BUNDLER, [
                    "generate", "--network",
                    "--models-url", f"{drip.base}/models/catalog.v1.json",
                    "--mcp-services-url", f"{drip.base}/plugins/catalog.v2.json",
                    "--out", str(out)])
                elapsed = time.monotonic() - started
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("hard timeout", result.stderr)
                self.assertLess(elapsed, 60,
                                "the deadline must bound the total fetch time")
        finally:
            drip.stop()


class PackerGates(unittest.TestCase):
    """The release packer must hard-fail without validated assets, and valid
    assets must land in the tarball layout the installer expects."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.assets = self.tmp / "catalog-assets"
        result = run_cli(BUNDLER, ["generate", "--fixture", "--out", str(self.assets)])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.repo = SyntheticRepo(self.tmp / "synrepo")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        self._tmp.cleanup()

    def test_packer_fails_without_catalog_assets(self):
        out = self.tmp / "dist-missing"
        result = self.repo.assemble(out, catalog_assets=None)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing bundled catalog assets", result.stderr)
        # Nothing was packed: no archive, no manifest.
        self.assertFalse(
            (out / f"prime-agent-9.9.9-{HOST_ARCHIVE_PLATFORM}.tar.gz").exists())
        self.assertFalse((out / "manifest.json").exists())

    def test_assembler_fails_on_each_missing_user_doc(self):
        """The user-facing docs are REQUIRED payload content: each curated
        doc missing from the repo must fail the assembly (fail-closed)."""
        for doc in ("RUST_QUICKSTART.md", "keybindings.md", "MODEL-SURFACE.md"):
            with self.subTest(doc=doc):
                repo = SyntheticRepo(self.tmp / f"repo-missing-{doc}")
                (repo.root / "docs" / doc).unlink()
                result = repo.assemble(
                    self.tmp / f"dist-missing-{doc}", catalog_assets=self.assets)
                self.assertNotEqual(result.returncode, 0, doc)
                self.assertIn(f"user-facing doc '{doc}' missing", result.stderr, doc)

    def test_local_packer_fails_on_each_missing_user_doc(self):
        """package_release.py must fail closed on every missing curated doc
        (REQUIRED_FILES gate), never silently ship a diminished docs entry."""
        for doc in ("RUST_QUICKSTART.md", "keybindings.md", "MODEL-SURFACE.md"):
            with self.subTest(doc=doc):
                repo = SyntheticRepo(self.tmp / f"pkrepo-missing-{doc}")
                (repo.root / "docs" / doc).unlink()
                args = ["--root", str(repo.root), "--version", "9.9.9",
                        "--binary", str(repo.binary), "--skip-build",
                        "--catalog-assets", str(self.assets),
                        "--out-dir", str(self.tmp / f"pkout-{doc}")]
                result = run_cli(PACKER, args)
                self.assertNotEqual(result.returncode, 0, doc)
                self.assertIn(f"missing binary asset: docs/{doc}", result.stderr, doc)

    def test_packer_fails_on_invalid_assets(self):
        cases = {
            "corrupt-json": ("{\n", "{\n"),
            "wrong-versions": (
                json.dumps({"schemaVersion": 2, "models": []}),
                json.dumps({"version": 3, "entries": []})),
        }
        for label, (models_body, plugins_body) in cases.items():
            bad = self.tmp / f"assets-{label}"
            bad.mkdir()
            (bad / "models.bundled.json").write_text(models_body)
            (bad / "mcp-services.bundled.json").write_text(plugins_body)
            result = self.repo.assemble(self.tmp / f"dist-{label}", catalog_assets=bad)
            self.assertNotEqual(result.returncode, 0, label)
            self.assertIn("Invalid bundled", result.stderr, label)
        # Under-minimum counts fail even with a well-formed envelope.
        small = self.tmp / "assets-small"
        small.mkdir()
        (small / "models.bundled.json").write_text(
            json.dumps({"schemaVersion": 1, "models": []}))
        good_plugins = json.loads(
            bundle_catalog.fixture_catalog_bodies()["mcp-services.bundled.json"])
        (small / "mcp-services.bundled.json").write_text(json.dumps(good_plugins))
        result = self.repo.assemble(self.tmp / "dist-small", catalog_assets=small)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("transport tuples", result.stderr)
        # Missing one of the two files fails too.
        half = self.tmp / "assets-half"
        half.mkdir()
        shutil.copyfile(self.assets / "models.bundled.json",
                        half / "models.bundled.json")
        result = self.repo.assemble(self.tmp / "dist-half", catalog_assets=half)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing bundled catalog asset", result.stderr)

    def test_assets_land_in_the_tarball_the_installer_expects(self):
        out = self.tmp / "dist"
        result = self.repo.assemble(out, catalog_assets=self.assets)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("bundled catalog assets", result.stdout)
        archive = out / f"prime-agent-9.9.9-{HOST_ARCHIVE_PLATFORM}.tar.gz"
        self.assertTrue(archive.is_file())
        with tarfile.open(archive) as tar:
            names = tar.getnames()
            self.assertIn("models.bundled.json", names)
            self.assertIn("mcp-services.bundled.json", names)
            # The staged assets are byte-identical to the generated ones.
            for name in ("models.bundled.json", "mcp-services.bundled.json"):
                member = tar.extractfile(name)
                self.assertEqual(member.read(),
                                 (self.assets / name).read_bytes(), name)
        # The full end-to-end verifier (payload shape, checksums, manifest,
        # extracted catalog assets, livecheck) passes on the synthetic tree.
        verify = run_cli(VERIFIER, ["--dist-dir", str(out), "--version", "9.9.9",
                                   "--target", HOST_TARGET])
        self.assertEqual(verify.returncode, 0, verify.stderr)
        self.assertIn("catalog assets", verify.stdout)

    def test_continuous_flow_stamps_and_verifies(self):
        # The #274 pipeline: commit-stamped continuous builds carry the assets
        # the same way, and verify enforces the stamp end to end.
        sha = "0123456789abcdef0123456789abcdef01234567"
        repo = SyntheticRepo(self.tmp / "synrepo-continuous",
                             version="9.9.9", sha=sha)
        out = self.tmp / "dist-continuous"
        result = repo.assemble(out, catalog_assets=self.assets, sha=sha)
        self.assertEqual(result.returncode, 0, result.stderr)
        verify = run_cli(VERIFIER, ["--dist-dir", str(out), "--version", "9.9.9",
                                   "--target", HOST_TARGET, "--sha", sha])
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_kernel_packer_gates_the_same_assets(self):
        # package_release.py (the exe-adjacent kernel packaging) fails without
        # assets and ships them beside the binary when they are valid.
        args = ["--root", str(self.repo.root), "--version", "9.9.9",
                "--binary", str(self.repo.binary), "--skip-build",
                "--out-dir", str(self.tmp / "release-package")]
        without = run_cli(PACKER, args)
        self.assertNotEqual(without.returncode, 0)
        self.assertIn("missing bundled catalog assets", without.stderr)
        with_assets = run_cli(PACKER, [*args, "--catalog-assets", str(self.assets)])
        self.assertEqual(with_assets.returncode, 0, with_assets.stderr)
        staged = self.tmp / "release-package" / "prime-agent-9.9.9-linux-x64"
        self.assertTrue((staged / "models.bundled.json").is_file())
        self.assertTrue((staged / "mcp-services.bundled.json").is_file())


if __name__ == "__main__":
    unittest.main(verbosity=2)
