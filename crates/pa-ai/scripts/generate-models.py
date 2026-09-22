#!/usr/bin/env python3
"""Generate crates/pa-ai/src/models.generated.json from the TS catalog.

Parses the `MODELS` object literal in
`packages/ai/src/models.generated.ts` and emits the same data as JSON in the
serde wire shape of `pa_types::ai::Model` (camelCase), which the Rust
`models_generated` loader deserializes with `serde_json`.

Usage:
    python3 crates/pa-ai/scripts/generate-models.py \
        ~/prime-agent/packages/ai/src/models.generated.ts \
        crates/pa-ai/src/models.generated.json
"""

import json
import re
import sys


def strip_satisfies(text: str) -> str:
    # Remove `satisfies Model<"...">` / `satisfies Model` annotations, and
    # TypeScript `as unknown as X` casts if any appear.
    text = re.sub(r"satisfies\s+Model(?:<[^>]*>)?", "", text)
    text = re.sub(r"\s+as\s+unknown\s+as\s+\w+", "", text)
    return text


class Parser:
    def __init__(self, text: str):
        self.text = text
        self.pos = 0

    def skip_ws(self):
        while self.pos < len(self.text) and self.text[self.pos] in " \t\r\n,":
            self.pos += 1

    def peek(self) -> str:
        self.skip_ws()
        return self.text[self.pos] if self.pos < len(self.text) else ""

    def parse_value(self):
        char = self.peek()
        if char == "{":
            return self.parse_object()
        if char == "[":
            return self.parse_array()
        if char == '"':
            return self.parse_string()
        if char == "'":
            return self.parse_string(quote="'")
        return self.parse_literal()

    def parse_object(self):
        assert self.peek() == "{"
        self.pos += 1
        result = {}
        while True:
            char = self.peek()
            if char == "}":
                self.pos += 1
                return result
            key = self.parse_key()
            char = self.peek()
            assert char == ":", f"expected ':' at {self.pos}"
            self.pos += 1
            result[key] = self.parse_value()

    def parse_array(self):
        assert self.peek() == "["
        self.pos += 1
        result = []
        while True:
            char = self.peek()
            if char == "]":
                self.pos += 1
                return result
            result.append(self.parse_value())

    def parse_key(self) -> str:
        char = self.peek()
        if char == '"':
            return self.parse_string()
        start = self.pos
        while self.pos < len(self.text) and self.text[self.pos] not in " \t\r\n:":
            self.pos += 1
        return self.text[start : self.pos]

    def parse_string(self, quote: str = '"') -> str:
        assert self.peek() == quote
        self.pos += 1
        out = []
        while self.pos < len(self.text):
            char = self.text[self.pos]
            if char == "\\":
                nxt = self.text[self.pos + 1]
                if nxt == "n":
                    out.append("\n")
                elif nxt == "t":
                    out.append("\t")
                elif nxt == "r":
                    out.append("\r")
                elif nxt == "u":
                    out.append(chr(int(self.text[self.pos + 2 : self.pos + 6], 16)))
                    self.pos += 4
                else:
                    out.append(nxt)
                self.pos += 2
                continue
            if char == quote:
                self.pos += 1
                return "".join(out)
            out.append(char)
            self.pos += 1
        raise ValueError("unterminated string")

    def parse_literal(self):
        start = self.pos
        while self.pos < len(self.text) and self.text[self.pos] not in ",}\] \t\r\n":
            self.pos += 1
        token = self.text[start : self.pos]
        if token == "true":
            return True
        if token == "false":
            return False
        if token == "null":
            return None
        if token == "undefined":
            return None
        if token.startswith("'") or token.startswith('"'):
            return token[1:-1]
        try:
            if re.fullmatch(r"-?\d+", token):
                return int(token)
            return float(token)
        except ValueError:
            raise AssertionError(f"unexpected literal {token!r} at {start}")


def main() -> None:
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    ts_path, out_path = sys.argv[1], sys.argv[2]
    text = open(ts_path, encoding="utf-8").read()
    start = text.index("export const MODELS = {") + len("export const MODELS =")
    end = text.rindex("} as const;") + 1  # include the closing brace
    body = strip_satisfies(text[start:end].strip())
    parser = Parser(body)
    models = parser.parse_value()
    assert parser.peek() == "", "trailing content after MODELS literal"

    providers = len(models)
    entries = sum(len(entries) for entries in models.values())
    with open(out_path, "w", encoding="utf-8") as out:
        json.dump(models, out, indent=1, ensure_ascii=False)
        out.write("\n")
    print(f"wrote {out_path}: {providers} providers, {entries} models")


if __name__ == "__main__":
    main()
