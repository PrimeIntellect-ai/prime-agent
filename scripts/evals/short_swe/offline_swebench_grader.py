"""Dependency-free SWE-bench Verified log parser for the pinned task slice.

Parser behavior is adapted from SWE-bench 4.0.3. Missing expected statuses fail as
infrastructure; skipped expected tests remain unresolved.

MIT License

Copyright (c) 2023 Carlos E Jimenez, John Yang, Alexander Wettig, Shunyu Yao,
Kexin Pei, Ofir Press, Karthik R Narasimhan

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import json
import re

STATUSES = {"PASSED", "FAILED", "SKIPPED", "ERROR", "XFAIL"}
NONPASSING = {"FAILED", "SKIPPED", "ERROR"}


class StatusMap(dict[str, str]):
    """Keep any observed non-passing status from being overwritten by later output."""

    def __setitem__(self, name: str, value: str) -> None:
        current = self.get(name)
        if current in NONPASSING:
            return
        if current is None or value in NONPASSING:
            super().__setitem__(name, value)


def pytest_log(log: str, _config: dict) -> dict[str, str]:
    status = StatusMap()
    for line in log.splitlines():
        if any(line.startswith(value) for value in STATUSES):
            if line.startswith("FAILED"):
                line = line.replace(" - ", " ")
            fields = line.split()
            if len(fields) > 1:
                status[fields[1]] = fields[0]
    return status


def pytest_options_log(log: str, config: dict) -> dict[str, str]:
    status = StatusMap()
    option_pattern = re.compile(r"(.*?)\[(.*)\]")
    for line in log.splitlines():
        if not any(line.startswith(value) for value in STATUSES):
            continue
        if line.startswith("FAILED"):
            line = line.replace(" - ", " ")
        fields = line.split()
        if len(fields) <= 1:
            continue
        match = option_pattern.search(fields[1])
        if match:
            main, option = match.groups()
            if option.startswith("/") and not option.startswith("//") and "*" not in option:
                option = "/" + option.split("/")[-1]
            name = f"{main}[{option}]"
        else:
            name = fields[1]
        status[name] = fields[0]
    return status


def pytest_v2_log(log: str, _config: dict) -> dict[str, str]:
    status = StatusMap()
    controls = "".join(chr(value) for value in range(1, 32))
    translator = str.maketrans("", "", controls)
    for line in log.splitlines():
        line = re.sub(r"\[(\d+)m", "", line).translate(translator)
        if any(line.startswith(value) for value in STATUSES):
            if line.startswith("FAILED"):
                line = line.replace(" - ", " ")
            fields = line.split()
            if len(fields) >= 2:
                status[fields[1]] = fields[0]
        elif any(line.endswith(value) for value in STATUSES):
            fields = line.split()
            if len(fields) >= 2:
                status[fields[0]] = fields[1]
    return status


def django_log(log: str, _config: dict) -> dict[str, str]:
    status = StatusMap()
    previous = None
    for line in log.splitlines():
        line = line.strip()
        if "--version is equivalent to version" in line:
            status["--version is equivalent to version"] = "PASSED"
        if " ... " in line:
            previous = line.split(" ... ")[0]
        for suffix in (" ... ok", " ... OK", " ...  OK"):
            if line.endswith(suffix):
                if line.startswith("Applying sites.0002_alter_domain_unique...test_no_migrations"):
                    line = line.split("...", 1)[-1].strip()
                status[line.rsplit(suffix, 1)[0]] = "PASSED"
                break
        if " ... skipped" in line:
            status[line.split(" ... skipped")[0]] = "SKIPPED"
        if line.endswith(" ... FAIL"):
            status[line.split(" ... FAIL")[0]] = "FAILED"
        if line.startswith("FAIL:"):
            status[line.split()[1].strip()] = "FAILED"
        if line.endswith(" ... ERROR"):
            status[line.split(" ... ERROR")[0]] = "ERROR"
        if line.startswith("ERROR:"):
            status[line.split()[1].strip()] = "ERROR"
        if line.lstrip().startswith("ok") and previous is not None:
            status[previous] = "PASSED"
    patterns = (
        r"^(.*?)\s\.\.\.\sTesting\ against\ Django\ installed\ in\ ((?s:.*?))\ silenced\)\.\nok$",
        r"^(.*?)\s\.\.\.\sInternal\ Server\ Error:\ \/(.*)\/\nok$",
        r"^(.*?)\s\.\.\.\sSystem check identified no issues \(0 silenced\)\nok$",
    )
    for pattern in patterns:
        for match in re.finditer(pattern, log, re.MULTILINE):
            status[match.group(1)] = "PASSED"
    return status


def seaborn_log(log: str, _config: dict) -> dict[str, str]:
    status = StatusMap()
    for line in log.splitlines():
        if line.startswith("FAILED"):
            status[line.split()[1]] = "FAILED"
        elif " PASSED " in line:
            fields = line.split()
            if len(fields) > 1 and fields[1] == "PASSED":
                status[fields[0]] = "PASSED"
        elif line.startswith("PASSED"):
            status[line.split()[1]] = "PASSED"
    return status


def sympy_log(log: str, _config: dict) -> dict[str, str]:
    status = StatusMap()
    for match in re.findall(r"(_*) (.*)\.py:(.*) (_*)", log):
        status[f"{match[1]}.py:{match[2]}"] = "FAILED"
    for line in log.splitlines():
        line = line.strip()
        if not line.startswith("test_"):
            continue
        if line.endswith(" E"):
            status[line.split()[0]] = "ERROR"
        if line.endswith(" F"):
            status[line.split()[0]] = "FAILED"
        if line.endswith(" ok"):
            status[line.split()[0]] = "PASSED"
    return status


def matplotlib_log(log: str, config: dict) -> dict[str, str]:
    return pytest_log(log.replace("MouseButton.LEFT", "1").replace("MouseButton.RIGHT", "3"), config)


PARSERS = {
    "astropy/astropy": pytest_v2_log,
    "django/django": django_log,
    "matplotlib/matplotlib": matplotlib_log,
    "mwaskom/seaborn": seaborn_log,
    "pallets/flask": pytest_log,
    "psf/requests": pytest_options_log,
    "pydata/xarray": pytest_log,
    "pylint-dev/pylint": pytest_options_log,
    "pytest-dev/pytest": pytest_log,
    "scikit-learn/scikit-learn": pytest_v2_log,
    "sphinx-doc/sphinx": pytest_v2_log,
    "sympy/sympy": sympy_log,
}


def names(config: dict, field: str) -> list[str]:
    value = config.get(field, [])
    value = json.loads(value) if isinstance(value, str) else value
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError(f"invalid {field}")
    return value


def grade(config: dict, log: str) -> dict:
    instance = config.get("instance_id")
    repo = config.get("repo")
    if not isinstance(instance, str) or repo not in PARSERS:
        raise ValueError("unsupported SWE-bench task identity")
    status = PARSERS[repo](log, config)
    expected = {"FAIL_TO_PASS": names(config, "FAIL_TO_PASS"), "PASS_TO_PASS": names(config, "PASS_TO_PASS")}
    expected_names = set(expected["FAIL_TO_PASS"] + expected["PASS_TO_PASS"])
    missing = expected_names.difference(status)
    if missing:
        raise ValueError(f"test log is missing {len(missing)} expected SWE-bench statuses")
    tests_status = {
        "FAIL_TO_FAIL": {"success": [], "failure": []},
        "PASS_TO_FAIL": {"success": [], "failure": []},
    }
    resolved = True
    for group, tests in expected.items():
        passed = [test for test in tests if status.get(test) in {"PASSED", "XFAIL"}]
        failed = [test for test in tests if test not in passed]
        tests_status[group] = {"success": passed, "failure": failed}
        resolved = resolved and not failed
    return {
        instance: {
            "patch_is_None": False,
            "patch_exists": True,
            "patch_successfully_applied": True,
            "resolved": resolved,
            "tests_status": tests_status,
        }
    }
