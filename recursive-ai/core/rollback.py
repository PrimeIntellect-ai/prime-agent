"""Git objects store checkpoints; SQLite selects the active immutable commit."""
import json
import os
import subprocess
from pathlib import Path


class VersionController:
    def __init__(self, root):
        self.repo = Path(root) / "checkpoints.git"
        if not self.repo.exists():
            subprocess.run(["git", "init", "--bare", str(self.repo)], capture_output=True, check=True)

    def run(self, *args, data=None):
        env = dict(os.environ, GIT_AUTHOR_NAME="Recursive AI Lab", GIT_AUTHOR_EMAIL="lab@recursive.local",
                   GIT_COMMITTER_NAME="Recursive AI Lab", GIT_COMMITTER_EMAIL="lab@recursive.local")
        result = subprocess.run(["git", "--git-dir", str(self.repo), *args], input=data,
                                text=True, capture_output=True, timeout=15, check=True, env=env)
        return result.stdout.strip()

    def snapshot(self, skills, parent=None):
        blob = self.run("hash-object", "-w", "--stdin", data=json.dumps(skills, sort_keys=True, allow_nan=False))
        tree = self.run("mktree", data=f"100644 blob {blob}\tmanifest.json\n")
        args = ["commit-tree", tree, "-m", "Verified capability checkpoint"]
        if parent:
            args.extend(["-p", parent])
        commit = self.run(*args)
        # Permanent unique reference protects checkpoints from Git garbage collection.
        self.run("update-ref", "refs/checkpoints/" + commit, commit)
        return commit

    def read(self, commit):
        if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
            raise ValueError("invalid checkpoint SHA")
        return json.loads(self.run("show", commit + ":manifest.json"))
