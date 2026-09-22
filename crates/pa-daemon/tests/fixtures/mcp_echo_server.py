#!/usr/bin/env python3
"""Minimal stdio MCP server used by the daemon MCP e2e tests.

Speaks newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio
framing) with the three requests the generic kernel registry needs:
`initialize`, `tools/list`, and `tools/call`. Pure stdlib: the settings
entry points any Python 3 interpreter at this script, no venv required.
"""

import json
import sys

ECHO_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "message": {"type": "string", "description": "Text echoed back."},
    },
    "required": ["message"],
}


def initialize_result(requested_version):
    return {
        "protocolVersion": requested_version or "2024-11-05",
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": "fixture-echo", "version": "1.0.0"},
    }


def echo_result(arguments):
    message = arguments.get("message", "")
    return {
        "content": [{"type": "text", "text": str(message)}],
        "isError": False,
    }


def respond(request_id, result):
    sys.stdout.write(
        json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}) + "\n"
    )
    sys.stdout.flush()


def respond_error(request_id, code, message):
    sys.stdout.write(
        json.dumps(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": code, "message": message},
            }
        )
        + "\n"
    )
    sys.stdout.flush()


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        request_id = message.get("id")
        if request_id is None:
            # Notifications (e.g. `notifications/initialized`) need no reply.
            continue
        method = message.get("method")
        params = message.get("params") or {}
        if method == "initialize":
            respond(request_id, initialize_result(params.get("protocolVersion")))
        elif method == "tools/list":
            respond(
                request_id,
                {
                    "tools": [
                        {
                            "name": "echo",
                            "description": "Echoes the message argument back.",
                            "inputSchema": ECHO_TOOL_SCHEMA,
                        }
                    ]
                },
            )
        elif method == "tools/call":
            respond(request_id, echo_result(params.get("arguments") or {}))
        else:
            respond_error(request_id, -32601, f"Method not found: {method}")


if __name__ == "__main__":
    main()
