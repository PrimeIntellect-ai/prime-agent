import json
import math
import shutil
import subprocess
import tempfile
import time
import uuid
from core.ast_validator import parse, validate


class SandboxRunner:
    def __init__(self, image="recursive-ai-runner:local", timeout=15):
        self.image = image
        self.timeout = timeout

    def _run(self, payload):
        if not shutil.which("docker"):
            raise RuntimeError("Docker unavailable; host execution is forbidden")
        data = json.dumps(payload).encode()
        if len(data) > 2_000_000:
            raise ValueError("request exceeds 2 MB")
        name = "recursive-ai-" + uuid.uuid4().hex
        cmd = ["docker", "run", "--rm", "--pull=never", "--name", name, "-i",
               "--network=none", "--cpus=1", "--memory=512m", "--memory-swap=512m",
               "--pids-limit=64", "--read-only", "--cap-drop=ALL", "--user=65534:65534",
               "--security-opt=no-new-privileges:true", "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
               "--ulimit", "nofile=64:64", "--log-driver=none", self.image]
        # Files avoid unbounded communicate() buffering. Monitor and kill on output overflow.
        with tempfile.TemporaryFile() as stdin, tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            stdin.write(data)
            stdin.seek(0)
            process = subprocess.Popen(cmd, stdin=stdin, stdout=stdout, stderr=stderr)
            deadline = time.monotonic() + self.timeout
            try:
                while process.poll() is None:
                    if time.monotonic() > deadline:
                        raise RuntimeError("sandbox timeout")
                    if stdout.seek(0, 2) + stderr.seek(0, 2) > 1_000_000:
                        raise RuntimeError("sandbox output limit")
                    time.sleep(0.02)
                if process.returncode:
                    raise RuntimeError("sandbox process failed")
                stdout.seek(0)
                raw = stdout.read(1_000_001)
                if len(raw) > 1_000_000:
                    raise RuntimeError("sandbox output limit")
                result = json.loads(raw)
                if not isinstance(result, dict):
                    raise RuntimeError("invalid sandbox response")
                return result
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                subprocess.run(["docker", "rm", "-f", name], capture_output=True, timeout=10, check=False)

    def boot(self):
        result = self._run({"probe": True})
        required = {"uid": 65534, "readonly": True, "seccomp": 2, "no_new_privs": 1, "caps": 0,
                    "memory_max": "536870912", "swap_max": "0", "pids_max": "64"}
        if any(result.get(key) != value for key, value in required.items()):
            raise RuntimeError("sandbox isolation probe failed")
        quota, period = map(int, result["cpu_max"].split())
        if quota <= 0 or period <= 0 or quota > period:
            raise RuntimeError("sandbox CPU quota probe failed")

    def execute(self, source, cases):
        validate(parse(source))
        result = self._run({"source": source, "cases": cases})
        outputs = result.get("outputs")
        if not isinstance(outputs, list) or len(outputs) != len(cases) or any(type(x) is not int for x in outputs):
            raise RuntimeError("invalid sandbox outputs")
        for key in ("cpu_seconds", "peak_bytes"):
            value = result.get(key)
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise RuntimeError("invalid resource metrics")
        return result
