- Kernel startup no longer fails on a raw EACCES when the kernel venv's directory is not writable by the current user: a venv that still runs the runtime yields its python with the missing Python skills disabled behind the unavailable-skill notice, and a venv that cannot run the runtime errors naming the venv and the `PRIME_AGENT_KERNEL_VENV` / `PRIME_AGENT_KERNEL_PYTHON` overrides.

