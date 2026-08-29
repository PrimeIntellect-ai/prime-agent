"""Command interface for the portable CCG router."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from ccg_runtime.core import CcgRouter, ConfigurationError
else:
    from .core import CcgRouter, ConfigurationError


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="ccg")
    commands = command.add_subparsers(dest="command", required=True)
    for name in ("init", "set-enabled", "route"):
        subcommand = commands.add_parser(name)
        subcommand.add_argument("--config", required=True)
        if name == "set-enabled":
            subcommand.add_argument("--enabled", choices=("true", "false"), required=True)
        if name == "route":
            subcommand.add_argument("--selector", default="default")
            subcommand.add_argument("--request", required=True)
    return command


def main(argv: list[str] | None = None) -> int:
    arguments = parser().parse_args(argv)
    try:
        if arguments.command == "init":
            result = CcgRouter.initialise(arguments.config)
            response = {"created": True, "enabled": False, "config": str(result.config_path)}
        elif arguments.command == "set-enabled":
            configuration = CcgRouter(arguments.config).set_enabled(arguments.enabled == "true")
            response = {"enabled": configuration["enabled"]}
        else:
            response = CcgRouter(arguments.config).route(arguments.request, arguments.selector)
    except ConfigurationError as error:
        response = {"accepted": False, "code": "INVALID_CONFIGURATION", "detail": str(error)}
    print(json.dumps(response, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
