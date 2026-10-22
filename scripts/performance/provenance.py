"""Content identities for the confined comparison harness."""
import hashlib
import json
from pathlib import Path


def file_sha256(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def harness_sha256() -> str:
    root = Path(__file__).parent
    files = sorted(root.glob('*.py'))
    inventory = {p.name: file_sha256(p) for p in files}
    return hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
