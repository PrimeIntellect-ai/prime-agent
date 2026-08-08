from __future__ import annotations

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
