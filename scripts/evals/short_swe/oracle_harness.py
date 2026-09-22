"""Deterministic gold-patch harness for the SWE-bench scorer preflight.

The embedded Astropy source excerpt is licensed under the BSD 3-Clause License:

Copyright (c) 2011-2026, Astropy Developers. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.
* Neither the name of the Astropy Team nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
"""

from verifiers.v1.clients import ModelContext
from verifiers.v1.configs.harness import HarnessConfig
from verifiers.v1.harness import Harness
from verifiers.v1.runtimes import ProgramResult, Runtime
from verifiers.v1.task import TaskData
from verifiers.v1.trace import Trace

ORIGINAL = """        # Fail
        raise AttributeError(
            f"'{self.__class__.__name__}' object has no attribute '{attr}'"
        )"""
REPLACEMENT = """        # Call __getattribute__; this will give correct exception.
        return self.__getattribute__(attr)"""
SCRIPT = f"""from pathlib import Path
path = Path("/testbed/astropy/coordinates/sky_coordinate.py")
source = path.read_text()
old = {ORIGINAL!r}
new = {REPLACEMENT!r}
assert source.count(old) == 1
path.write_text(source.replace(old, new))
"""


class OracleHarnessConfig(HarnessConfig):
    pass


class OracleHarness(Harness[OracleHarnessConfig]):
    async def launch(
        self,
        ctx: ModelContext,
        trace: Trace,
        runtime: Runtime,
        endpoint: str,
        secret: str,
        mcp_urls: dict[str, str],
        data: TaskData,
    ) -> ProgramResult:
        path = "/tmp/prime-agent-swebench-oracle.py"
        await runtime.write(path, SCRIPT.encode())
        return await runtime.run(["python", path], {})


__all__ = ["OracleHarness"]
