"""repo-map: read-only Git-indexed symbol graphs with a hard text budget.

The callable ``run`` returns only a bounded, declaration-only text map. Target
modules are never imported or executed; source literals, comments, docstrings,
and raw queries are never rendered.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import io
import json
import math
import os
import re
import stat
import subprocess
import tokenize
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Iterable

__all__ = [
    "RepoMapError", "RepositoryLimitError", "estimate_tokens",
    "map_repository", "run",
]

_SOURCE_SUFFIXES = frozenset({".py", ".pyi", ".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"})
_SKIP_COMPONENTS = frozenset({
    ".git", "node_modules", "vendor", "dist", "build", "coverage", "target",
    "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache",
    ".ruff_cache", "artifacts",
})
_SECRET_NAMES = frozenset({
    ".env", ".env.local", ".npmrc", ".pypirc", ".netrc", "id_rsa", "id_dsa",
    "id_ed25519", "credentials", "credentials.json",
})
_SECRET_SUFFIXES = frozenset({".pem", ".key", ".p12", ".pfx", ".keystore"})
_REPARSE_ATTRIBUTE = 0x400
_IDENTIFIER = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_QUERY_PART = re.compile(r"[A-Za-z0-9_$]+")
_KIND_ORDER = {"class": 0, "interface": 1, "function": 2, "method": 3,
               "type": 4, "enum": 5, "namespace": 6, "constant": 7}


class RepoMapError(RuntimeError):
    """Repository cannot be mapped safely."""


class RepositoryLimitError(RepoMapError):
    """A declared hard inventory/graph limit was exceeded."""


@dataclass
class _Source:
    path: str
    raw: bytes
    language: str
    digest: str


@dataclass
class _ImportTarget:
    module: str
    name: str | None
    namespace: bool = False


@dataclass
class _Symbol:
    id: str
    path: str
    language: str
    parser: str
    confidence: str
    name: str
    qualname: str
    kind: str
    line: int
    column: int
    parent_id: str | None = None
    references: set[str] = field(default_factory=set)
    attribute_references: set[tuple[str, str]] = field(default_factory=set)
    bound_names: set[str] = field(default_factory=set)


@dataclass
class _FileAnalysis:
    source: _Source
    symbols: list[_Symbol]
    imports: dict[str, _ImportTarget]
    warnings: list[dict[str, Any]]


def estimate_tokens(text: str) -> int:
    """Provider-independent upper-bound unit: one unit per UTF-8 byte."""
    if not isinstance(text, str):
        raise TypeError("text must be a string")
    return len(text.encode("utf-8"))


def _run_git(root: Path, args: list[str], timeout: int = 120) -> bytes:
    try:
        proc = subprocess.run(["git", *args], cwd=str(root), capture_output=True,
                              timeout=timeout, shell=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RepoMapError(f"read-only git command failed: {type(exc).__name__}: {exc}") from exc
    if proc.returncode != 0:
        message = proc.stderr.decode("utf-8", "replace").strip()[:500]
        raise RepoMapError(f"git {' '.join(args)} failed: {message}")
    return proc.stdout


def _is_reparse(info: os.stat_result) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & _REPARSE_ATTRIBUTE)


def _reject_link_components(path: Path) -> None:
    absolute = path.expanduser().absolute()
    parts = absolute.parts
    current = Path(parts[0])
    for part in parts[1:]:
        current = current / part
        try:
            info = current.lstat()
        except OSError as exc:
            raise RepoMapError(f"cannot inspect repository root component: {current}") from exc
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
            raise RepoMapError(f"repository root contains a link/reparse component: {current}")


def _repo_root(root: str | os.PathLike[str]) -> Path:
    supplied = Path(root).expanduser().absolute()
    _reject_link_components(supplied)
    if not supplied.is_dir():
        raise RepoMapError(f"repository root is not a directory: {supplied}")
    top_raw = _run_git(supplied, ["rev-parse", "--show-toplevel"])
    top = Path(os.fsdecode(top_raw.strip())).absolute()
    _reject_link_components(top)
    if supplied.resolve() != top.resolve():
        raise RepoMapError(f"root must be the Git top level: {top}")
    return top


def _eligible_path(path: str) -> bool:
    pure = PurePosixPath(path)
    components = {part.casefold() for part in pure.parts[:-1]}
    name = pure.name.casefold()
    if components & _SKIP_COMPONENTS:
        return False
    if name in _SECRET_NAMES or any(name.endswith(suffix) for suffix in _SECRET_SUFFIXES):
        return False
    if ".generated." in name or name.endswith((".min.js", ".map")):
        return False
    return pure.suffix.casefold() in _SOURCE_SUFFIXES


def _git_inventory(root: Path, scope: str) -> list[tuple[str, str]]:
    if scope not in {"tracked", "worktree"}:
        raise ValueError("scope must be 'tracked' or 'worktree'")
    entries: dict[str, str] = {}
    staged = _run_git(root, ["ls-files", "--stage", "-z"])
    for record in staged.split(b"\0"):
        if not record:
            continue
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, _object_id, stage = metadata.split(b" ", 2)
        except ValueError:
            raise RepoMapError("malformed NUL-delimited git index entry")
        path = os.fsdecode(raw_path).replace("\\", "/")
        if stage != b"0" or mode not in {b"100644", b"100755"}:
            continue
        if _eligible_path(path):
            entries[path] = "tracked"
    if scope == "worktree":
        others = _run_git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
        for raw_path in others.split(b"\0"):
            if not raw_path:
                continue
            path = os.fsdecode(raw_path).replace("\\", "/")
            if _eligible_path(path):
                entries.setdefault(path, "untracked")
    return sorted(entries.items(), key=lambda item: (item[0].encode("utf-8", "surrogateescape"), item[1]))


def _path_is_confined_regular(root: Path, relative: str) -> os.stat_result | None:
    current = root
    parts = PurePosixPath(relative).parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        return None
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = current.lstat()
        except OSError:
            return None
        if stat.S_ISLNK(info.st_mode) or _is_reparse(info):
            return None
        if index < len(parts) - 1 and not stat.S_ISDIR(info.st_mode):
            return None
    return info if stat.S_ISREG(info.st_mode) else None


def _read_source(root: Path, relative: str, expected: os.stat_result, max_bytes: int) -> bytes | None:
    if expected.st_size > max_bytes:
        return None
    path = root.joinpath(*PurePosixPath(relative).parts)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        opened = os.fstat(descriptor)
        identity = (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
        expected_identity = (expected.st_dev, expected.st_ino, expected.st_size, expected.st_mtime_ns)
        if not stat.S_ISREG(opened.st_mode) or identity != expected_identity:
            return None
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(remaining, 131072))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
    finally:
        os.close(descriptor)
    after = _path_is_confined_regular(root, relative)
    if after is None:
        return None
    after_identity = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if after_identity != expected_identity or len(raw) > max_bytes or b"\x00" in raw:
        return None
    return raw


def _load_sources(
    root: Path,
    inventory: list[tuple[str, str]],
    *,
    max_files: int,
    max_file_bytes: int,
    max_total_source_bytes: int,
) -> tuple[list[_Source], list[dict[str, Any]]]:
    if len(inventory) > max_files:
        raise RepositoryLimitError(f"eligible file count {len(inventory)} exceeds max_files={max_files}")
    inspected: list[tuple[str, os.stat_result]] = []
    total = 0
    warnings: list[dict[str, Any]] = []
    for relative, _origin in inventory:
        info = _path_is_confined_regular(root, relative)
        if info is None:
            warnings.append({"code": "UNSAFE_OR_CHANGED_FILE", "path": relative, "line": None})
            continue
        if info.st_size > max_file_bytes:
            warnings.append({"code": "FILE_TOO_LARGE", "path": relative, "line": None})
            continue
        total += info.st_size
        inspected.append((relative, info))
    if total > max_total_source_bytes:
        raise RepositoryLimitError(
            f"eligible source bytes {total} exceed max_total_source_bytes={max_total_source_bytes}"
        )
    sources: list[_Source] = []
    for relative, info in inspected:
        raw = _read_source(root, relative, info, max_file_bytes)
        if raw is None:
            warnings.append({"code": "READ_IDENTITY_CHANGED", "path": relative, "line": None})
            continue
        suffix = PurePosixPath(relative).suffix.casefold()
        language = "python" if suffix in {".py", ".pyi"} else "typescript-javascript"
        sources.append(_Source(relative, raw, language, hashlib.sha256(raw).hexdigest()))
    return sources, warnings


def _symbol_id(language: str, path: str, qualname: str, line: int, column: int) -> str:
    material = f"{language}\0{path}\0{qualname}\0{line}:{column}".encode("utf-8", "surrogateescape")
    return "rs-" + hashlib.sha256(material).hexdigest()[:20]


class _DefinitionRefs(ast.NodeVisitor):
    def __init__(self, root: ast.AST):
        self.root = root
        self.references: set[str] = set()
        self.attributes: set[tuple[str, str]] = set()
        self.bound: set[str] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if node is not self.root:
            return
        self._visit_function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        if node is not self.root:
            return
        self._visit_function(node)

    def _visit_function(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> None:
        args = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs]
        self.bound.update(arg.arg for arg in args)
        if node.args.vararg:
            self.bound.add(node.args.vararg.arg)
        if node.args.kwarg:
            self.bound.add(node.args.kwarg.arg)
        for statement in node.body:
            self.visit(statement)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        if node is not self.root:
            return
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Load):
            self.references.add(node.id)
        elif isinstance(node.ctx, (ast.Store, ast.Del)):
            self.bound.add(node.id)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        if isinstance(node.value, ast.Name):
            self.attributes.add((node.value.id, node.attr))
        self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        return


def _python_text(source: _Source) -> str:
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(source.raw).readline)
        return source.raw.decode(encoding)
    except (SyntaxError, UnicodeError, LookupError) as exc:
        raise ValueError(str(exc)) from exc


def _python_analysis(source: _Source) -> _FileAnalysis:
    warnings: list[dict[str, Any]] = []
    try:
        text = _python_text(source)
        tree = ast.parse(text, filename=source.path, type_comments=True)
    except (SyntaxError, ValueError) as exc:
        line = getattr(exc, "lineno", None)
        return _FileAnalysis(source, [], {}, [{"code": "PYTHON_PARSE_FAILED", "path": source.path,
                                                "line": line if isinstance(line, int) else None}])
    imports: dict[str, _ImportTarget] = {}
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                local = alias.asname or alias.name.split(".")[0]
                imports[local] = _ImportTarget(alias.name, None, True)
        elif isinstance(node, ast.ImportFrom):
            prefix = "." * node.level + (node.module or "")
            for alias in node.names:
                if alias.name != "*":
                    imports[alias.asname or alias.name] = _ImportTarget(prefix, alias.name, False)
    symbols: list[_Symbol] = []

    def visit(body: Iterable[ast.stmt], parents: tuple[str, ...] = (), parent_id: str | None = None,
              parent_is_class: bool = False) -> None:
        for node in body:
            name: str | None = None
            kind: str | None = None
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                name, kind = node.name, ("method" if parent_is_class else "function")
            elif isinstance(node, ast.ClassDef):
                name, kind = node.name, "class"
            elif not parents and isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                if len(targets) == 1 and isinstance(targets[0], ast.Name) and targets[0].id.isupper():
                    name, kind = targets[0].id, "constant"
            if name and kind:
                qualname = ".".join((*parents, name))
                line = int(getattr(node, "lineno", 1))
                column = int(getattr(node, "col_offset", 0))
                sid = _symbol_id("python", source.path, qualname, line, column)
                refs = _DefinitionRefs(node)
                refs.visit(node)
                symbol = _Symbol(
                    sid, source.path, "python", "python-ast-v1", "exact", name, qualname,
                    kind, line, column, parent_id, refs.references - refs.bound,
                    refs.attributes, refs.bound,
                )
                symbols.append(symbol)
                nested = getattr(node, "body", [])
                if nested:
                    visit(nested, (*parents, name), sid, isinstance(node, ast.ClassDef))
            elif isinstance(node, (ast.If, ast.Try, ast.With, ast.For, ast.While)):
                visit(getattr(node, "body", []), parents, parent_id)
                visit(getattr(node, "orelse", []), parents, parent_id)
                visit(getattr(node, "finalbody", []), parents, parent_id)
    visit(tree.body)
    return _FileAnalysis(source, symbols, imports, warnings)


@dataclass(frozen=True)
class _Token:
    value: str
    kind: str
    line: int
    column: int


def _lex_ts(text: str) -> list[_Token]:
    tokens: list[_Token] = []
    index, line, column = 0, 1, 0
    length = len(text)
    previous_value = ""

    def advance(char: str) -> None:
        nonlocal line, column
        if char == "\n":
            line, column = line + 1, 0
        else:
            column += 1

    while index < length:
        char = text[index]
        if char.isspace():
            advance(char); index += 1; continue
        if text.startswith("//", index):
            while index < length and text[index] != "\n":
                advance(text[index]); index += 1
            continue
        if text.startswith("/*", index):
            while index < length:
                if text.startswith("*/", index):
                    advance("*"); advance("/"); index += 2; break
                advance(text[index]); index += 1
            continue
        if char in {"'", '"'}:
            quote, start_line, start_column = char, line, column
            value: list[str] = []
            advance(char); index += 1
            while index < length:
                current = text[index]
                if current == "\\" and index + 1 < length:
                    value.append(text[index + 1]); advance(current); index += 1
                    advance(text[index]); index += 1; continue
                if current == quote:
                    advance(current); index += 1; break
                value.append(current); advance(current); index += 1
            tokens.append(_Token("".join(value), "string", start_line, start_column))
            previous_value = "<string>"
            continue
        if char == "`":
            advance(char); index += 1
            while index < length:
                current = text[index]
                if current == "\\" and index + 1 < length:
                    advance(current); index += 1; advance(text[index]); index += 1; continue
                advance(current); index += 1
                if current == "`":
                    break
            previous_value = "<template>"
            continue
        if char == "/" and previous_value in {"", "=", "(", "[", "{", ",", ":", ";", "!", "?", "return", "=>"}:
            advance(char); index += 1; in_class = False
            while index < length:
                current = text[index]
                if current == "\\" and index + 1 < length:
                    advance(current); index += 1; advance(text[index]); index += 1; continue
                if current == "[": in_class = True
                if current == "]": in_class = False
                advance(current); index += 1
                if current == "/" and not in_class:
                    while index < length and text[index].isalpha():
                        advance(text[index]); index += 1
                    break
            previous_value = "<regex>"
            continue
        if char.isalpha() or char in "_$":
            start, start_line, start_column = index, line, column
            while index < length and (text[index].isalnum() or text[index] in "_$"):
                advance(text[index]); index += 1
            value = text[start:index]
            tokens.append(_Token(value, "identifier", start_line, start_column)); previous_value = value
            continue
        if char.isdigit():
            while index < length and (text[index].isalnum() or text[index] in "._"):
                advance(text[index]); index += 1
            previous_value = "<number>"; continue
        start_line, start_column = line, column
        punct = "=>" if text.startswith("=>", index) else char
        for consumed in punct:
            advance(consumed)
        index += len(punct)
        tokens.append(_Token(punct, "punct", start_line, start_column)); previous_value = punct
    return tokens


def _matching_brace(tokens: list[_Token], start: int, left: str = "{", right: str = "}") -> int | None:
    depth = 0
    for index in range(start, len(tokens)):
        if tokens[index].kind == "punct" and tokens[index].value == left: depth += 1
        elif tokens[index].kind == "punct" and tokens[index].value == right:
            depth -= 1
            if depth == 0: return index
    return None


def _ts_analysis(source: _Source) -> _FileAnalysis:
    try:
        text = source.raw.decode("utf-8")
    except UnicodeDecodeError:
        return _FileAnalysis(source, [], {}, [{"code": "TSJS_NON_UTF8", "path": source.path, "line": None}])
    tokens = _lex_ts(text)
    imports: dict[str, _ImportTarget] = {}
    symbols: list[_Symbol] = []
    definitions: list[tuple[int, int, _Symbol]] = []
    index = 0
    definition_keywords = {"function", "class", "interface", "enum", "type", "namespace"}
    while index < len(tokens):
        token = tokens[index]
        if token.value == "import":
            end = index + 1
            while end < len(tokens) and tokens[end].value != ";":
                if tokens[end].value == "from" and end + 1 < len(tokens) and tokens[end + 1].kind == "string":
                    end += 2
                    break
                if tokens[end].kind == "string" and end == index + 1:
                    end += 1
                    break
                end += 1
            segment = tokens[index + 1:end]
            from_index = next((i for i, item in enumerate(segment) if item.value == "from"), None)
            module = None
            if from_index is not None and from_index + 1 < len(segment) and segment[from_index + 1].kind == "string":
                module = segment[from_index + 1].value
            elif segment and segment[-1].kind == "string":
                module = segment[-1].value
            if module:
                for pos, item in enumerate(segment[:from_index] if from_index is not None else []):
                    if item.kind != "identifier" or item.value in {"type", "as"}:
                        continue
                    prior = segment[pos - 1].value if pos else ""
                    following = segment[pos + 1].value if pos + 1 < len(segment) else ""
                    if prior == "as":
                        original = segment[pos - 2].value if pos >= 2 else item.value
                        imports[item.value] = _ImportTarget(module, original, False)
                    elif following != "as" and item.value not in {"from"}:
                        imports.setdefault(item.value, _ImportTarget(module, item.value, False))
            index = end + (1 if end < len(tokens) and tokens[end].value == ";" else 0); continue
        if token.value in definition_keywords and index + 1 < len(tokens) and tokens[index + 1].kind == "identifier":
            name_token = tokens[index + 1]
            kind = "function" if token.value == "function" else token.value
            sid = _symbol_id("typescript-javascript", source.path, name_token.value,
                             name_token.line, name_token.column)
            symbol = _Symbol(sid, source.path, "typescript-javascript", "tsjs-lexer-v1",
                             "conservative", name_token.value, name_token.value, kind,
                             name_token.line, name_token.column)
            body_start = next((pos for pos in range(index + 2, min(len(tokens), index + 80))
                               if tokens[pos].value == "{"), None)
            body_end = _matching_brace(tokens, body_start) if body_start is not None else None
            end = body_end if body_end is not None else min(len(tokens) - 1, index + 80)
            definitions.append((index, end, symbol)); symbols.append(symbol)
            index += 2; continue
        if token.value in {"const", "let", "var"} and index + 1 < len(tokens) and tokens[index + 1].kind == "identifier":
            name_token = tokens[index + 1]
            end = index + 2
            while end < min(len(tokens), index + 100) and tokens[end].value not in {";", "}"}: end += 1
            if any(item.value == "=>" for item in tokens[index + 2:end]):
                sid = _symbol_id("typescript-javascript", source.path, name_token.value,
                                 name_token.line, name_token.column)
                symbol = _Symbol(sid, source.path, "typescript-javascript", "tsjs-lexer-v1",
                                 "conservative", name_token.value, name_token.value, "function",
                                 name_token.line, name_token.column)
                definitions.append((index, end, symbol)); symbols.append(symbol)
            index = end; continue
        index += 1
    # Exact call-like identifier references, with local declarations/parameters removed.
    for start, end, symbol in definitions:
        segment = tokens[start:end + 1]
        bound: set[str] = set()
        for pos, item in enumerate(segment[:-1]):
            if item.value in {"const", "let", "var"} and segment[pos + 1].kind == "identifier":
                bound.add(segment[pos + 1].value)
        opening = next((pos for pos, item in enumerate(segment) if item.value == "("), None)
        if opening is not None:
            closing = _matching_brace(segment, opening, "(", ")")
            if closing is not None:
                bound.update(item.value for item in segment[opening + 1:closing]
                             if item.kind == "identifier" and item.value not in {"public", "private", "readonly"})
        for pos, item in enumerate(segment[:-1]):
            if item.kind == "identifier" and segment[pos + 1].value == "(" and item.value not in bound:
                symbol.references.add(item.value)
            if (pos + 3 < len(segment) and item.kind == "identifier" and segment[pos + 1].value == "."
                    and segment[pos + 2].kind == "identifier" and segment[pos + 3].value == "("):
                symbol.attribute_references.add((item.value, segment[pos + 2].value))
        symbol.bound_names = bound
    return _FileAnalysis(source, symbols, imports, [])


def _module_name(path: str) -> str:
    pure = PurePosixPath(path)
    parts = list(pure.with_suffix("").parts)
    if parts and parts[-1] == "__init__": parts.pop()
    return ".".join(parts)


def _resolve_python_module(source_path: str, module: str, known: dict[str, str]) -> str | None:
    current = _module_name(source_path)
    if module.startswith("."):
        level = len(module) - len(module.lstrip("."))
        suffix = module[level:]
        package = current.split(".") if PurePosixPath(source_path).name.startswith("__init__.") else current.split(".")[:-1]
        base = package[:max(0, len(package) - level + 1)]
        candidate = ".".join([*base, *([suffix] if suffix else [])]).strip(".")
    else:
        candidate = module
    return known.get(candidate)


def _resolve_ts_module(source_path: str, module: str, known_paths: set[str]) -> str | None:
    if not module.startswith("."):
        return None
    base = PurePosixPath(source_path).parent.joinpath(module)
    normalized_parts: list[str] = []
    for part in base.parts:
        if part == "..":
            if not normalized_parts: return None
            normalized_parts.pop()
        elif part not in {"", "."}:
            normalized_parts.append(part)
    normalized = PurePosixPath(*normalized_parts)
    stem = normalized.with_suffix("") if normalized.suffix in {".js", ".mjs", ".cjs"} else normalized
    candidates = [str(normalized), *(str(stem) + suffix for suffix in (".ts", ".mts", ".cts", ".js", ".mjs", ".cjs")),
                  *(str(stem / "index") + suffix for suffix in (".ts", ".mts", ".cts", ".js"))]
    matches = [candidate for candidate in candidates if candidate in known_paths]
    return matches[0] if len(set(matches)) == 1 else None


def _add_edge(edges: dict[str, dict[str, int]], source: str, target: str, weight: int) -> None:
    if source == target: return
    edges.setdefault(source, {})[target] = edges.setdefault(source, {}).get(target, 0) + weight


def _build_graph(analyses: list[_FileAnalysis], max_edges: int) -> tuple[list[_Symbol], dict[str, dict[str, int]], dict[str, str]]:
    symbols = [symbol for analysis in analyses for symbol in analysis.symbols]
    by_id = {symbol.id: symbol for symbol in symbols}
    top_candidates: dict[tuple[str, str], list[_Symbol]] = {}
    for symbol in symbols:
        if "." not in symbol.qualname:
            top_candidates.setdefault((symbol.path, symbol.name), []).append(symbol)
    by_file_top = {key: values[0] for key, values in top_candidates.items() if len(values) == 1}
    known_python = {_module_name(analysis.source.path): analysis.source.path for analysis in analyses
                    if analysis.source.language == "python"}
    known_paths = {analysis.source.path for analysis in analyses}
    analysis_by_path = {analysis.source.path: analysis for analysis in analyses}
    edges: dict[str, dict[str, int]] = {symbol.id: {} for symbol in symbols}
    edge_kinds: dict[str, str] = {}

    def connect(source: _Symbol, target: _Symbol, kind: str) -> None:
        _add_edge(edges, source.id, target.id, 4 if kind == "reference" else 1)
        _add_edge(edges, target.id, source.id, 1)
        edge_kinds[f"{source.id}>{target.id}"] = kind

    for symbol in symbols:
        if symbol.parent_id and symbol.parent_id in by_id:
            connect(by_id[symbol.parent_id], symbol, "containment")
        analysis = analysis_by_path[symbol.path]
        for name in sorted(symbol.references):
            if name in symbol.bound_names: continue
            target = by_file_top.get((symbol.path, name))
            if target:
                connect(symbol, target, "reference"); continue
            imported = analysis.imports.get(name)
            if imported and imported.name:
                if symbol.language == "python":
                    target_path = _resolve_python_module(symbol.path, imported.module, known_python)
                else:
                    target_path = _resolve_ts_module(symbol.path, imported.module, known_paths)
                target = by_file_top.get((target_path, imported.name)) if target_path else None
                if target: connect(symbol, target, "reference")
        for base, attribute in sorted(symbol.attribute_references):
            imported = analysis.imports.get(base)
            if imported:
                if symbol.language == "python":
                    target_path = _resolve_python_module(symbol.path, imported.module, known_python)
                else:
                    target_path = _resolve_ts_module(symbol.path, imported.module, known_paths)
                target_name = attribute if imported.namespace or imported.name is None else imported.name
                target = by_file_top.get((target_path, target_name)) if target_path else None
                if target: connect(symbol, target, "reference")
            elif base in {"self", "cls", "this"} and "." in symbol.qualname:
                parent = symbol.qualname.rsplit(".", 1)[0]
                target = next((item for item in symbols if item.path == symbol.path and item.qualname == f"{parent}.{attribute}"), None)
                if target: connect(symbol, target, "reference")
    edge_count = len(edge_kinds)
    if edge_count > max_edges:
        raise RepositoryLimitError(f"graph edge count {edge_count} exceeds max_edges={max_edges}")
    return symbols, edges, edge_kinds


def _query_terms(query: str) -> list[str]:
    expanded = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", query)
    return [term.casefold() for term in _QUERY_PART.findall(expanded)]


def _rank(symbols: list[_Symbol], edges: dict[str, dict[str, int]], query: str) -> tuple[list[tuple[_Symbol, int, int | None, str]], bool]:
    if not symbols: return [], False
    ids = sorted(symbol.id for symbol in symbols)
    by_id = {symbol.id: symbol for symbol in symbols}
    terms = _query_terms(query)
    raw: dict[str, float] = {}
    for sid in ids:
        symbol = by_id[sid]
        name = symbol.name.casefold(); path = symbol.path.casefold(); qual = symbol.qualname.casefold()
        score = 0.0
        for term in terms:
            if term == name: score += 12.0
            elif term in name or term in qual: score += 6.0
            if term in path: score += 2.0
        raw[sid] = score
    matched = any(value > 0 for value in raw.values())
    if terms and matched:
        total = math.fsum(raw.values()); personalization = {sid: raw[sid] / total for sid in ids}
    else:
        personalization = {sid: 1.0 / len(ids) for sid in ids}
    ranks = dict(personalization)
    damping = 0.85
    incoming: dict[str, list[tuple[str, int]]] = {sid: [] for sid in ids}
    out_weights = {sid: sum(edges.get(sid, {}).values()) for sid in ids}
    for source in ids:
        for target, weight in sorted(edges.get(source, {}).items()):
            incoming[target].append((source, weight))
    for _ in range(40):
        dangling = math.fsum(ranks[sid] for sid in ids if not edges.get(sid))
        updated: dict[str, float] = {}
        for target in ids:
            inbound = [ranks[source] * weight / out_weights[source]
                       for source, weight in incoming[target]]
            updated[target] = ((1.0 - damping) * personalization[target]
                               + damping * (math.fsum(inbound) + dangling * personalization[target]))
        ranks = updated
    seeds = {sid for sid, value in raw.items() if value > 0}
    distance: dict[str, int] = {}
    queue: deque[str] = deque()
    for sid in sorted(seeds): distance[sid] = 0; queue.append(sid)
    undirected = {sid: set(edges.get(sid, {})) for sid in ids}
    for source, targets in edges.items():
        for target in targets: undirected.setdefault(target, set()).add(source)
    while queue:
        source = queue.popleft()
        for target in sorted(undirected[source]):
            if target not in distance:
                distance[target] = distance[source] + 1; queue.append(target)
    ranked = []
    for sid in ids:
        reason = "query" if raw[sid] > 0 else ("connected" if sid in distance else "centrality")
        ranked.append((by_id[sid], max(0, round(ranks[sid] * 1_000_000_000_000)), distance.get(sid), reason))
    ranked.sort(key=lambda item: (-item[1], item[2] if item[2] is not None else 2**31,
                                  item[0].path.encode("utf-8", "surrogateescape"), item[0].line,
                                  item[0].column, _KIND_ORDER.get(item[0].kind, 99),
                                  item[0].qualname.encode("utf-8"), item[0].id))
    return ranked, matched


def _safe_json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def _render(ranked: list[tuple[_Symbol, int, int | None, str]], *, status: str,
            query_hash: str, token_budget: int) -> tuple[str, list[dict[str, Any]], int]:
    header_template = f"# repo-map/v1 status={status} estimator=utf8-bytes-upper-bound-v1 query_sha256={query_hash[:12]} truncated={{flag}}\n"
    minimum = estimate_tokens(header_template.format(flag="1"))
    if token_budget < minimum:
        raise ValueError(f"token_budget={token_budget} is below minimum header cost {minimum}")
    parts: list[str] = [header_template.format(flag="1")]
    selected: list[dict[str, Any]] = []
    skipped = 0
    for rank_index, (symbol, score, distance, reason) in enumerate(ranked, 1):
        line = (f"{rank_index:06d} path={_safe_json_string(symbol.path)} line={symbol.line} col={symbol.column} "
                f"kind={symbol.kind} qualname={_safe_json_string(symbol.qualname)} "
                f"score={score} distance={distance if distance is not None else '-'} reason={reason}\n")
        if estimate_tokens("".join(parts)) + estimate_tokens(line) > token_budget:
            skipped += 1; continue
        parts.append(line)
        selected.append({
            "rank": rank_index, "id": symbol.id, "path": symbol.path, "line": symbol.line,
            "column": symbol.column, "language": symbol.language, "parser": symbol.parser,
            "confidence": symbol.confidence, "kind": symbol.kind, "name": symbol.name,
            "qualname": symbol.qualname, "score_picounits": score,
            "seed_distance": distance, "token_cost": estimate_tokens(line), "reason": reason,
        })
    parts[0] = header_template.format(flag="1" if skipped else "0")
    rendered = "".join(parts)
    assert estimate_tokens(rendered) <= token_budget
    return rendered, selected, skipped


def map_repository(
    root: str | os.PathLike[str] = ".",
    *,
    query: str = "",
    token_budget: int = 4096,
    scope: str = "worktree",
    max_files: int = 20_000,
    max_file_bytes: int = 1_048_576,
    max_total_source_bytes: int = 134_217_728,
    max_nodes: int = 200_000,
    max_edges: int = 1_000_000,
) -> dict[str, Any]:
    """Return structured metadata plus a declaration-only budgeted text map."""
    for name, value, low, high in (
        ("token_budget", token_budget, 1, 1_000_000), ("max_files", max_files, 1, 100_000),
        ("max_file_bytes", max_file_bytes, 1024, 100_000_000),
        ("max_total_source_bytes", max_total_source_bytes, 1024, 2_000_000_000),
        ("max_nodes", max_nodes, 1, 2_000_000), ("max_edges", max_edges, 1, 10_000_000),
    ):
        if type(value) is not int or not low <= value <= high:
            raise ValueError(f"{name} must be an integer in [{low}, {high}]")
    if not isinstance(query, str) or len(query) > 2048 or "\x00" in query:
        raise ValueError("query must be a string of at most 2048 characters without NUL")
    repository = _repo_root(root)
    inventory = _git_inventory(repository, scope)
    sources, warnings = _load_sources(
        repository, inventory, max_files=max_files, max_file_bytes=max_file_bytes,
        max_total_source_bytes=max_total_source_bytes,
    )
    analyses: list[_FileAnalysis] = []
    for source in sources:
        analysis = _python_analysis(source) if source.language == "python" else _ts_analysis(source)
        analyses.append(analysis); warnings.extend(analysis.warnings)
    symbol_count = sum(len(analysis.symbols) for analysis in analyses)
    if symbol_count > max_nodes:
        raise RepositoryLimitError(f"symbol count {symbol_count} exceeds max_nodes={max_nodes}")
    symbols, edges, edge_kinds = _build_graph(analyses, max_edges)
    ranked, query_matched = _rank(symbols, edges, query)
    if query and not query_matched:
        warnings.append({"code": "NO_QUERY_MATCH", "path": None, "line": None})
    status = "partial" if warnings else "complete"
    query_hash = hashlib.sha256(query.encode("utf-8")).hexdigest()
    rendered, selected, skipped_budget = _render(
        ranked, status=status, query_hash=query_hash, token_budget=token_budget,
    )
    fingerprint_material = b"".join(
        source.path.encode("utf-8", "surrogateescape") + b"\0" + bytes.fromhex(source.digest)
        for source in sources
    )
    head = _run_git(repository, ["rev-parse", "HEAD^{commit}"]).decode("ascii", "replace").strip()
    kind_counts: dict[str, int] = {}
    for kind in edge_kinds.values(): kind_counts[kind] = kind_counts.get(kind, 0) + 1
    return {
        "schema_version": "repo-map/v1", "status": status, "map": rendered,
        "budget": {"limit": token_budget, "used": estimate_tokens(rendered),
                   "estimator": "utf8-bytes-upper-bound-v1", "map_budget_only": True,
                   "default_run_full_payload": True, "truncated": bool(skipped_budget)},
        "repository": {"root_name": repository.name, "head": head, "scope": scope,
                       "content_fingerprint": hashlib.sha256(fingerprint_material).hexdigest()},
        "request": {"query_sha256": query_hash},
        "selected_symbols": selected,
        "stats": {"files_inventory": len(inventory), "files_parsed": len(analyses),
                  "symbols": len(symbols), "edges": len(edge_kinds),
                  "relationships": len(edge_kinds),
                  "graph_directed_edges": sum(len(targets) for targets in edges.values()),
                  "max_edges_limit": max_edges,
                  "max_edges_unit": "logical_relationships",
                  "edge_kinds": kind_counts,
                  "parse_failures": sum(warning["code"] in {"PYTHON_PARSE_FAILED", "TSJS_NON_UTF8"} for warning in warnings),
                  "candidates_skipped_budget": skipped_budget},
        "warnings": warnings,
    }


def run(query: str = "", root: str = ".", token_budget: int = 4096,
        *, scope: str = "worktree", format: str = "text") -> str | dict[str, Any]:
    """Prime Agent entry point; text format is the hard-budget default."""
    result = map_repository(root, query=query, token_budget=token_budget, scope=scope)
    if format == "text": return result["map"]
    if format == "json": return result
    raise ValueError("format must be 'text' or 'json'")


def _main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only Git-indexed graph-ranked repository map")
    parser.add_argument("root", nargs="?", default=".")
    parser.add_argument("--query", default="")
    parser.add_argument("--token-budget", type=int, required=True)
    parser.add_argument("--tracked-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = map_repository(args.root, query=args.query, token_budget=args.token_budget,
                            scope="tracked" if args.tracked_only else "worktree")
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True))
    else:
        sys_stdout = getattr(__import__("sys"), "stdout")
        sys_stdout.write(result["map"])
    return 0 if result["status"] == "complete" else 2
