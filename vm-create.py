
from prime_sandboxes import SandboxClient, APIClient, CreateSandboxRequest
from prime_sandboxes.models import StartCommand
c = SandboxClient(APIClient())
s = c.create(CreateSandboxRequest(name="tui-transcript-condense-chk", docker_image="rust:1-bookworm", start_command=StartCommand(executable="sleep", args=["infinity"]), cpu_cores=8, memory_gb=32, disk_size_gb=120, vm=True, network_access=True, timeout_minutes=1440))
print(s.id, flush=True)
c.wait_for_creation(s.id)
print("READY", s.id, flush=True)
