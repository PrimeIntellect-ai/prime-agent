from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import warnings
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
BACKUP = ROOT / "template" / "harness" / "backup.py"
SPEC = importlib.util.spec_from_file_location("prime_harness_backup", BACKUP)
assert SPEC and SPEC.loader
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


def make_sources(tmp_path: Path):
    project = tmp_path / "project"
    artifacts = project / "artifacts" / "harness"
    session = tmp_path / "session"
    global_harness = tmp_path / "global-harness"
    (artifacts / "results").mkdir(parents=True)
    (artifacts / "empty").mkdir()
    (artifacts / "backups").mkdir()
    session.mkdir()
    global_harness.mkdir()
    (session / "transcript.jsonl").write_bytes(b'{"event":1}\n')
    (session / "nested").mkdir()
    (session / "nested" / "state.json").write_text('{"local":true}\n', encoding="utf-8")
    (artifacts / "results" / "evidence.json").write_bytes(b'{"verified":true}\n')
    (artifacts / "backups" / "excluded.zip").write_bytes(b"recursive backup must be excluded")
    (global_harness / "harness_state.json").write_text('{"global":true}\n', encoding="utf-8")
    connection = sqlite3.connect(artifacts / "evidence.db")
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("CREATE TABLE claims(id INTEGER PRIMARY KEY, claim TEXT NOT NULL)")
    connection.execute("INSERT INTO claims(claim) VALUES (?)", ("committed while WAL connection remains open",))
    connection.commit()
    return project, session, global_harness, connection


def archive_members(path: Path) -> dict[str, bytes]:
    with zipfile.ZipFile(path) as archive:
        return {info.filename: archive.read(info) for info in archive.infolist()}


def rewrite_zip(source: Path, destination: Path, transform):
    members = archive_members(source)
    members = transform(members)
    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, payload in members.items():
            archive.writestr(name, payload)


def test_create_verify_and_restore_exact_roundtrip_with_live_sqlite(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = project / "artifacts" / "harness" / "backups" / "roundtrip.zip"
    try:
        created = backup.create_backup(
            project_root=project,
            session_dir=session,
            global_harness=global_harness,
            output=archive,
        )
    finally:
        connection.close()
    assert created["status"] == "pass" and created["created"] is True
    assert archive.is_file()
    assert not list(archive.parent.glob(".*.tmp"))
    members = archive_members(archive)
    assert "project/artifacts/harness/backups/excluded.zip" not in members
    manifest = json.loads(members[backup.MANIFEST_NAME])
    assert manifest["format_version"] == 1
    assert {item["path"] for item in manifest["files"]} == set(members) - {backup.MANIFEST_NAME}
    assert any(item["path"].endswith("/evidence.db") and item["sqlite_snapshot"] for item in manifest["files"])
    assert not any(item["path"].endswith(("evidence.db-wal", "evidence.db-shm", "evidence.db-journal")) for item in manifest["files"])

    verified = backup.verify_backup(archive)
    assert verified["status"] == "pass" and verified["files"] == len(manifest["files"])
    destination = tmp_path / "restored"
    restored = backup.restore_backup(archive, destination)
    assert restored["status"] == "pass" and restored["restored"] is True
    assert (destination / "session/transcript.jsonl").read_bytes() == (session / "transcript.jsonl").read_bytes()
    assert (destination / "session/nested/state.json").read_bytes() == (session / "nested/state.json").read_bytes()
    assert (destination / "project/artifacts/harness/results/evidence.json").read_bytes() == b'{"verified":true}\n'
    assert (destination / "global/harness/harness_state.json").read_bytes() == (global_harness / "harness_state.json").read_bytes()
    assert (destination / "project/artifacts/harness/empty").is_dir()
    assert not (destination / "project/artifacts/harness/backups").exists()
    for item in manifest["files"]:
        restored_file = destination / Path(*item["path"].split("/"))
        assert hashlib.sha256(restored_file.read_bytes()).hexdigest() == item["sha256"], item["path"]
    database_path = destination / "project/artifacts/harness/evidence.db"
    restored_db = sqlite3.connect(database_path.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        assert restored_db.execute("SELECT claim FROM claims").fetchall() == [("committed while WAL connection remains open",)]
        assert restored_db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    finally:
        restored_db.close()

    cli = subprocess.run([sys.executable, "-S", str(BACKUP), "verify", str(archive)], capture_output=True, text=True, timeout=60)
    assert cli.returncode == 0
    assert json.loads(cli.stdout)["manifest_sha256"] == verified["manifest_sha256"]


def test_restore_sqlite_integrity_uses_percent_encoded_uri(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "percent-path.zip"
    try:
        backup.create_backup(
            project_root=project,
            session_dir=session,
            global_harness=global_harness,
            output=archive,
        )
    finally:
        connection.close()

    destination = tmp_path / "restore-%41"
    restored = backup.restore_backup(archive, destination)
    assert restored["status"] == "pass"
    database = destination / "project/artifacts/harness/evidence.db"
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    finally:
        connection.close()


def test_manifest_mtime_has_portable_upper_bound(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "valid-mtime.zip"
    try:
        backup.create_backup(
            project_root=project,
            session_dir=session,
            global_harness=global_harness,
            output=archive,
        )
    finally:
        connection.close()

    for section in ("directories", "files"):
        crafted = tmp_path / f"mtime-{section}.zip"

        def raise_mtime(members, section=section):
            manifest = json.loads(members[backup.MANIFEST_NAME])
            manifest[section][0]["mtime_ns"] = 10**30
            members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
            return members

        rewrite_zip(archive, crafted, raise_mtime)
        kind = {"directories": "directory", "files": "file"}[section]
        with pytest.raises(backup.BackupError, match=f"invalid {kind} metadata"):
            backup.verify_backup(crafted)

    cli = subprocess.run(
        [sys.executable, "-S", str(BACKUP), "restore", str(crafted), "--destination", str(tmp_path / "overflow-restore")],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert cli.returncode == 2
    assert json.loads(cli.stderr)["status"] == "fail"
    assert "Traceback" not in cli.stderr


def test_restore_rejects_oversized_members_before_decompression(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "baseline.zip"
    try:
        backup.create_backup(
            project_root=project,
            session_dir=session,
            global_harness=global_harness,
            output=archive,
        )
    finally:
        connection.close()

    oversized = tmp_path / "oversized.zip"

    def inflate_declared_size(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        manifest["files"][0]["size"] = backup.MAX_MEMBER_BYTES + 1
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members

    rewrite_zip(archive, oversized, inflate_declared_size)
    destination = tmp_path / "must-not-exist"
    with pytest.raises(backup.BackupError, match="member exceeds uncompressed size limit"):
        backup.restore_backup(oversized, destination)
    assert not destination.exists()


def test_missing_global_root_is_recorded_not_fabricated(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    shutil.rmtree(global_harness)
    archive = tmp_path / "missing-global.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    finally:
        connection.close()
    manifest = json.loads(archive_members(archive)[backup.MANIFEST_NAME])
    assert manifest["roots"]["global"]["present"] is False
    destination = tmp_path / "restore"
    backup.restore_backup(archive, destination)
    assert not (destination / "global").exists()


def test_corruption_traversal_duplicates_symlink_and_sqlite_tampering_fail_closed(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    finally:
        connection.close()
    original = archive_members(archive)
    ordinary = next(name for name in original if name.endswith("evidence.json"))

    corrupt = tmp_path / "corrupt.zip"
    rewrite_zip(archive, corrupt, lambda members: {**members, ordinary: b"changed"})
    with pytest.raises(backup.BackupError, match="size mismatch|content hash mismatch"):
        backup.verify_backup(corrupt)

    traversal = tmp_path / "traversal.zip"
    def add_traversal(members):
        members["../escape.txt"] = b"escape"
        return members
    rewrite_zip(archive, traversal, add_traversal)
    with pytest.raises(backup.BackupError, match="unsafe archive path|unknown root"):
        backup.verify_backup(traversal)
    destination = tmp_path / "traversal-restore"
    with pytest.raises(backup.BackupError):
        backup.restore_backup(traversal, destination)
    assert not (tmp_path / "escape.txt").exists()
    assert not destination.exists()

    duplicate = tmp_path / "duplicate.zip"
    with zipfile.ZipFile(duplicate, "w") as output:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            output.writestr(ordinary, original[ordinary])
            output.writestr(ordinary, original[ordinary])
        output.writestr(backup.MANIFEST_NAME, original[backup.MANIFEST_NAME])
    with pytest.raises(backup.BackupError, match="duplicate member"):
        backup.verify_backup(duplicate)

    symlink = tmp_path / "symlink-member.zip"
    with zipfile.ZipFile(symlink, "w") as output:
        info = zipfile.ZipInfo("session/link")
        info.create_system = 3
        info.external_attr = (0o120777 << 16)
        output.writestr(info, b"target")
        output.writestr(backup.MANIFEST_NAME, original[backup.MANIFEST_NAME])
    with pytest.raises(backup.BackupError, match="symlink"):
        backup.verify_backup(symlink)

    sqlite_tampered = tmp_path / "sqlite-tampered.zip"
    def break_database(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        db_item = next(item for item in manifest["files"] if item["sqlite_snapshot"])
        payload = b"not a sqlite database despite a matching manifest hash"
        members[db_item["path"]] = payload
        db_item["size"] = len(payload)
        db_item["sha256"] = hashlib.sha256(payload).hexdigest()
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members
    rewrite_zip(archive, sqlite_tampered, break_database)
    with pytest.raises(backup.BackupError, match="SQLite database cannot be opened|integrity_check failed"):
        backup.verify_backup(sqlite_tampered)


@pytest.mark.parametrize(
    "archive_path",
    [
        "session/note.txt:hidden",
        "session/NUL",
        "session/con.txt",
        "session/LPT9.log",
        "session/COM¹.data",
        "session/trailing-dot.",
        "session/trailing-space ",
        "session/question?.txt",
        "session/control-\x1f.txt",
    ],
)
def test_windows_unsafe_archive_components_are_rejected_cross_platform(tmp_path, archive_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    valid = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=valid)
    finally:
        connection.close()
    original = archive_members(valid)
    ordinary = next(name for name in original if name.endswith("evidence.json"))

    def rename_to_unsafe_path(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        item = next(item for item in manifest["files"] if item["path"] == ordinary)
        payload = members.pop(ordinary)
        item["path"] = archive_path
        members[archive_path] = payload
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members

    forged = tmp_path / (hashlib.sha256(archive_path.encode("utf-8")).hexdigest() + ".zip")
    rewrite_zip(valid, forged, rename_to_unsafe_path)
    with pytest.raises(backup.BackupError, match="Windows-(?:unsafe|ambiguous)|reserved-device"):
        backup.verify_backup(forged)
    destination = tmp_path / "unsafe-restore"
    with pytest.raises(backup.BackupError):
        backup.restore_backup(forged, destination)
    assert not destination.exists()


@pytest.mark.parametrize("privileged_mode", [0o4755, 0o2755, 0o1755])
def test_privileged_manifest_modes_are_rejected_before_restore(tmp_path, privileged_mode):
    project, session, global_harness, connection = make_sources(tmp_path)
    valid = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=valid)
    finally:
        connection.close()

    def add_privileged_mode(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        ordinary = next(item for item in manifest["files"] if item["path"].endswith("evidence.json"))
        ordinary["mode"] = privileged_mode
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members

    forged = tmp_path / f"privileged-{privileged_mode:o}.zip"
    rewrite_zip(valid, forged, add_privileged_mode)
    with pytest.raises(backup.BackupError, match="privileged or invalid mode bits"):
        backup.verify_backup(forged)
    destination = tmp_path / "privileged-restore"
    with pytest.raises(backup.BackupError):
        backup.restore_backup(forged, destination)
    assert not destination.exists()


@pytest.mark.parametrize("database_name", ["evidence.db", "Evidence.DB"])
def test_closed_uncheckpointed_wal_is_captured_by_sqlite_backup(tmp_path, database_name):
    project = tmp_path / "project"
    artifacts = project / "artifacts" / "harness"
    session = tmp_path / "session"
    global_harness = tmp_path / "global-harness"
    artifacts.mkdir(parents=True)
    session.mkdir()
    global_harness.mkdir()
    (session / "state.json").write_text("{}\n", encoding="utf-8")
    database = artifacts / database_name
    crash_writer = r'''import os
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
assert connection.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
connection.execute("PRAGMA wal_autocheckpoint=0")
connection.execute("CREATE TABLE evidence(id INTEGER PRIMARY KEY, claim TEXT NOT NULL)")
connection.commit()
connection.execute("INSERT INTO evidence(claim) VALUES (?)", ("committed before simulated crash",))
connection.commit()
os._exit(0)
'''
    writer = subprocess.run([sys.executable, "-c", crash_writer, str(database)], capture_output=True, text=True, timeout=60)
    assert writer.returncode == 0, writer.stdout + writer.stderr
    wal = Path(str(database) + "-wal")
    assert wal.is_file() and wal.stat().st_size > 32

    archive = tmp_path / "closed-uncheckpointed-wal.zip"
    created = backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    assert created["status"] == "pass"
    manifest = json.loads(archive_members(archive)[backup.MANIFEST_NAME])
    assert not any(item["path"].casefold().endswith(("evidence.db-wal", "evidence.db-shm", "evidence.db-journal")) for item in manifest["files"])
    database_item = next(item for item in manifest["files"] if item["path"].casefold().endswith("/evidence.db"))
    assert database_item["sqlite_snapshot"] is True
    restored = tmp_path / "restored-wal"
    backup.restore_backup(archive, restored)
    restored_database = restored / "project/artifacts/harness" / database_name
    connection = sqlite3.connect(restored_database.resolve().as_uri() + "?mode=ro", uri=True)
    try:
        assert connection.execute("SELECT claim FROM evidence").fetchall() == [("committed before simulated crash",)]
        assert connection.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    finally:
        connection.close()


def test_case_insensitive_archive_collisions_and_false_sqlite_markers_are_rejected(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    valid = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=valid)
    finally:
        connection.close()

    def add_case_collision(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        original_item = next(item for item in manifest["files"] if item["path"].endswith("evidence.json"))
        duplicate_item = copy.deepcopy(original_item)
        duplicate_item["path"] = original_item["path"][:-4] + "JSON"
        manifest["files"].append(duplicate_item)
        members[duplicate_item["path"]] = members[original_item["path"]]
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members

    collision = tmp_path / "case-collision.zip"
    rewrite_zip(valid, collision, add_case_collision)
    with pytest.raises(backup.BackupError, match="case-insensitive|portable manifest path collision"):
        backup.verify_backup(collision)

    def clear_sqlite_marker(members):
        manifest = json.loads(members[backup.MANIFEST_NAME])
        database_item = next(item for item in manifest["files"] if item["path"].endswith("/evidence.db"))
        database_item["sqlite_snapshot"] = False
        members[backup.MANIFEST_NAME] = backup._canonical_json(manifest)
        return members

    false_marker = tmp_path / "false-sqlite-marker.zip"
    rewrite_zip(valid, false_marker, clear_sqlite_marker)
    with pytest.raises(backup.BackupError, match="SQLite snapshot marker does not match"):
        backup.verify_backup(false_marker)


def test_source_identity_swap_is_rejected_before_read(tmp_path):
    source = tmp_path / "source.txt"
    source.write_bytes(b"trusted")
    expected = backup._regular_source_stat(source)
    source.unlink()
    source.write_bytes(b"replacement outside the scanned identity")
    with pytest.raises(backup.BackupError, match="source identity changed"):
        backup._open_verified_source(source, expected)


def test_intermediate_directory_swap_cannot_change_opened_file_identity(tmp_path):
    parent = tmp_path / "scanned"
    parent.mkdir()
    source = parent / "state.json"
    source.write_bytes(b"scanned identity")
    expected = backup._regular_source_stat(source)
    original_parent = tmp_path / "original-parent"
    parent.rename(original_parent)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "state.json").write_bytes(b"outside replacement")
    try:
        parent.symlink_to(outside, target_is_directory=True)
    except OSError:
        parent.mkdir()
        (parent / "state.json").write_bytes(b"replacement directory")
    with pytest.raises(backup.BackupError, match="source identity changed"):
        backup._open_verified_source(source, expected)


@pytest.mark.skipif(os.name != "nt", reason="Windows junction semantics")
def test_windows_junction_source_is_rejected(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("must not be archived", encoding="utf-8")
    junction = session / "junction"
    created = subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)], capture_output=True, text=True)
    if created.returncode != 0:
        connection.close()
        pytest.skip("junction creation is unavailable")
    try:
        with pytest.raises(backup.BackupError, match="reparse points"):
            backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=tmp_path / "junction.zip")
    finally:
        connection.close()


def test_dangling_destination_link_is_rejected_without_writing_target(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    finally:
        connection.close()
    target = tmp_path / "missing-target"
    destination = tmp_path / "dangling-destination"
    try:
        destination.symlink_to(target, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    with pytest.raises(backup.BackupError, match="not a directory"):
        backup.restore_backup(archive, destination)
    assert destination.is_symlink()
    assert not target.exists()


def test_existing_empty_destination_is_rejected_to_preserve_atomic_rename(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    finally:
        connection.close()
    destination = tmp_path / "already-empty"
    destination.mkdir()
    with pytest.raises(backup.BackupError, match="must not already exist for atomic replacement"):
        backup.restore_backup(archive, destination)
    assert destination.is_dir() and not list(destination.iterdir())


def test_restore_rejects_nonempty_destination_without_mutation(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    archive = tmp_path / "valid.zip"
    try:
        backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=archive)
    finally:
        connection.close()
    destination = tmp_path / "destination"
    destination.mkdir()
    sentinel = destination / "keep.txt"
    sentinel.write_text("untouched", encoding="utf-8")
    with pytest.raises(backup.BackupError, match="must be empty"):
        backup.restore_backup(archive, destination)
    assert sentinel.read_text(encoding="utf-8") == "untouched"
    assert not list(tmp_path.glob(".destination.restore-*"))


def test_source_symlinks_are_rejected_when_platform_supports_them(tmp_path):
    project, session, global_harness, connection = make_sources(tmp_path)
    target = tmp_path / "outside.txt"
    target.write_text("secret", encoding="utf-8")
    link = session / "link.txt"
    try:
        link.symlink_to(target)
    except OSError:
        connection.close()
        pytest.skip("symlink creation is unavailable")
    try:
        with pytest.raises(backup.BackupError, match="symlink sources are forbidden"):
            backup.create_backup(project_root=project, session_dir=session, global_harness=global_harness, output=tmp_path / "bad.zip")
    finally:
        connection.close()
