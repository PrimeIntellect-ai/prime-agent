"""The discipline screen: the kernel declines banned in-cell shapes before a
cell runs.

The shipped prompt's contract bans waiting and process spawning from cells
("bash() is the shell surface"; "do not keep the turn open by polling with
time.sleep()"), and both classes park the whole turn: nothing can wake a
kernel cell from inside. The screen declines the cell before it runs, with
the allowed alternative in the error itself — a declined wait is a teaching
moment, not a held turn. Detection stays on the charged surface: literal
sleeps of 5s or more, and the subprocess family (import, call, os.system,
os.popen, pty.spawn). Anything else — short backoff sleeps, sleeps computed
from variables, library internals, sleeps and spawns inside string literals
or comments — is invisible to the screen and keeps running untouched.
"""

from __future__ import annotations

import ast
from collections.abc import Iterable

_DECLINE_SLEEP_SECONDS = 5.0
_WATCHED_MODULES = ("time", "asyncio", "subprocess", "os", "pty")
_SUBPROCESS_CALLS = (
    "run",
    "Popen",
    "call",
    "check_call",
    "check_output",
    "getoutput",
    "getstatusoutput",
)

# A name's binding at a point is the set of what the name can hold on the
# paths that reach the point: a watched import (`("module", "time")` for
# `import time as t`, `("member", "os", "system")` for `from os import
# system`), None for any other value (a parameter, an assignment, a loop
# target), or _UNBOUND where a path leaves the name unbound in the scope, so
# the lookup goes on to the enclosing scope. A call declines when any
# binding its callee can hold is a banned call.
_UNBOUND = object()
_FALLTHROUGH = frozenset({_UNBOUND})
_SHADOW = frozenset({None})

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
# The compound statements whose suites run in the enclosing scope: the walk
# binds their suites itself, path by path.
_SUITE_STATEMENTS = (
    ast.If,
    ast.For,
    ast.AsyncFor,
    ast.While,
    ast.With,
    ast.AsyncWith,
    ast.Try,
    ast.TryStar,
    ast.Match,
)


class _BindingCollector(ast.NodeVisitor):
    """Every binding one scope body makes, without descending into nested
    scopes."""

    def __init__(self) -> None:
        self.bindings: dict[str, set[object]] = {}
        # A name declared global or nonlocal, with its declaration's type.
        self.declared: dict[str, type] = {}
        # The names a statement binds when it ends. The walk binds a walrus
        # target where the walrus runs.
        self.direct: set[str] = set()
        # The names annotated without a value: such a name binds nothing, but
        # a function body that annotates it makes it local.
        self.annotated: set[str] = set()

    def made(self) -> dict[str, frozenset]:
        """The bindings in this scope. A declared name binds in another
        scope, so it is not here."""
        return {
            name: frozenset(possible)
            for name, possible in self.bindings.items()
            if name not in self.declared
        }

    def _bind(self, name: str, binding: object, walrus: bool = False) -> None:
        self.bindings.setdefault(name, set()).add(binding)
        if not walrus:
            self.direct.add(name)

    def _import(self, alias: ast.alias, root: str, member: str | None) -> None:
        name = alias.asname or member or root
        if root in _WATCHED_MODULES:
            self._bind(name, ("module", root) if member is None else ("member", root, member))
        else:
            self._bind(name, None)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self._import(alias, alias.name.split(".")[0], None)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        # A relative import names an application sibling, never the standard
        # library module of the same name.
        root = "" if node.level else (node.module or "").split(".")[0]
        for alias in node.names:
            self._import(alias, root, alias.name)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._bind(node.name, None)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self._bind(node.name, None)

    def visit_Global(self, node: ast.Global) -> None:
        self.declared.update(dict.fromkeys(node.names, type(node)))

    visit_Nonlocal = visit_Global

    def visit_Name(self, node: ast.Name) -> None:
        if isinstance(node.ctx, ast.Store):
            self._bind(node.id, None)
        elif isinstance(node.ctx, ast.Del):
            self._bind(node.id, _UNBOUND)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.visit(node.value)
        self._bind(node.target.id, None, walrus=True)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is None and isinstance(node.target, ast.Name):
            self.annotated.add(node.target.id)
            self.visit(node.annotation)
        else:
            self.generic_visit(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        pass

    def visit_ListComp(self, node: ast.ListComp) -> None:
        pass

    visit_SetComp = visit_ListComp
    visit_DictComp = visit_ListComp
    visit_GeneratorExp = visit_ListComp


def _bindings_of(nodes: Iterable[ast.AST]) -> dict[str, frozenset]:
    """Every binding the nodes make in their scope."""
    collector = _BindingCollector()
    for node in nodes:
        collector.visit(node)
    return collector.made()


def _scope_bindings(node: ast.AST) -> dict[str, frozenset]:
    """The bindings a function, lambda, or comprehension introduces: its
    parameters or targets, and every binding its body makes. A name the body
    annotates without a value is local too, with no binding."""
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
        arguments = node.args
        parameters = [
            argument.arg
            for argument in (
                *arguments.posonlyargs,
                *arguments.args,
                *arguments.kwonlyargs,
                arguments.vararg,
                arguments.kwarg,
            )
            if argument is not None
        ]
        collector = _BindingCollector()
        for statement in node.body if isinstance(node.body, list) else [node.body]:
            collector.visit(statement)
        annotated = dict.fromkeys(collector.annotated - collector.declared.keys(), frozenset())
        return {**dict.fromkeys(parameters, _SHADOW), **annotated, **collector.made()}
    # a comprehension binds its own targets
    return _bindings_of(generator.target for generator in node.generators)


def _global_names(statements: Iterable[ast.AST]) -> frozenset[str]:
    """The names the statements declare global in their own scope."""
    collector = _BindingCollector()
    for statement in statements:
        collector.visit(statement)
    return frozenset(name for name, kind in collector.declared.items() if kind is ast.Global)


def _jumps(loop: ast.For | ast.AsyncFor | ast.While, kind: type) -> bool:
    """Whether the loop body has a `kind` statement (break or continue) that
    acts on this loop: one that is not in the body of a nested loop."""
    pending: list[ast.AST] = list(loop.body)
    while pending:
        node = pending.pop()
        if isinstance(node, kind):
            return True
        if isinstance(node, (ast.For, ast.AsyncFor, ast.While)):
            pending.extend(node.orelse)
        elif isinstance(node, (ast.stmt, ast.excepthandler, ast.match_case)):
            pending.extend(ast.iter_child_nodes(node))
    return False


def _has_walrus(nodes: list[ast.AST]) -> bool:
    """Whether a walrus in the expressions can bind a name."""
    return any(isinstance(inner, ast.NamedExpr) for node in nodes for inner in ast.walk(node))


def _escaped_bindings(scope: ast.AST, declaration: type) -> dict[str, frozenset]:
    """The bindings the function and class bodies inside `scope` make in it
    through a `global` or `nonlocal` declaration (`declaration`). A nonlocal
    name binds in the nearest enclosing function that binds the name, so a
    function between them keeps those bindings. The screen does not know
    when such a body runs, so `scope` can hold the bindings at any point."""
    escaped: dict[str, frozenset] = {}

    def visit(node: ast.AST, held: frozenset[str]) -> None:
        for child in ast.iter_child_nodes(node):
            if not isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                visit(child, held)
                continue
            collector = _BindingCollector()
            for statement in child.body:
                collector.visit(statement)
            for name, kind in collector.declared.items():
                if kind is declaration and name not in held:
                    made = frozenset(collector.bindings.get(name, ()))
                    escaped[name] = escaped.get(name, frozenset()) | made
            if declaration is ast.Nonlocal and not isinstance(child, ast.ClassDef):
                visit(child, held | frozenset(_scope_bindings(child)))
            else:
                visit(child, held)

    visit(scope, frozenset())
    return escaped


def _outer_expressions(node: ast.AST) -> list[ast.AST]:
    """The expressions a function node runs in its enclosing scope."""
    expressions: list[ast.AST] = list(getattr(node, "decorator_list", []))
    arguments = node.args
    expressions.extend(arguments.defaults)
    expressions.extend(value for value in arguments.kw_defaults if value is not None)
    for argument in (
        *arguments.posonlyargs,
        *arguments.args,
        *arguments.kwonlyargs,
        arguments.vararg,
        arguments.kwarg,
    ):
        if argument is not None and argument.annotation is not None:
            expressions.append(argument.annotation)
    returns = getattr(node, "returns", None)
    if returns is not None:
        expressions.append(returns)
    return expressions


def _pattern_names(pattern: ast.AST | None) -> set[str]:
    """The names a match pattern binds."""
    names: set[str] = set()
    for node in ast.walk(pattern) if pattern is not None else ():
        if isinstance(node, (ast.MatchAs, ast.MatchStar)) and node.name:
            names.add(node.name)
        elif isinstance(node, ast.MatchMapping) and node.rest:
            names.add(node.rest)
    return names


class _Scope:
    """One lexical scope: its bindings at the walk's point, every binding the
    scope makes, the bindings nested bodies make in it through `global` or
    `nonlocal`, the names it declares global, and the scope that encloses
    it."""

    __slots__ = ("kind", "bindings", "body_bindings", "escaped", "global_names", "parent")

    def __init__(
        self,
        kind: str,
        parent: "_Scope | None" = None,
        body_bindings: dict[str, frozenset] | None = None,
        escaped: dict[str, frozenset] | None = None,
        global_names: frozenset[str] = frozenset(),
    ) -> None:
        self.kind = kind
        self.bindings: dict[str, frozenset] = {}
        self.body_bindings = body_bindings or {}
        self.escaped = escaped or {}
        self.global_names = global_names
        self.parent = parent


def _resolve(scope: _Scope, name: str) -> frozenset:
    """Every binding the name can hold at the walk's point.

    A scope passes the lookup on to its enclosing scope on the paths where
    it leaves the name unbound, or to the module scope when it declares the
    name global. A function body runs later than its definition, so past a
    function boundary a scope can hold any binding it makes, and any binding
    a nested body makes in it. A class namespace is not part of a nested
    scope's lookup chain, so only the immediate scope counts when it is a
    class.
    """
    found: set[object] = set()
    current: _Scope | None = scope
    later = False
    while current is not None:
        parent = current.parent
        if current is scope or current.kind != "class":
            possible = current.bindings.get(name, _FALLTHROUGH)
            if later:
                possible = possible | current.body_bindings.get(name, frozenset())
                possible = possible | current.escaped.get(name, frozenset())
            found |= possible - _FALLTHROUGH
            if _UNBOUND not in possible:
                return frozenset(found)
            if name in current.global_names:
                while parent is not None and parent.parent is not None:
                    parent = parent.parent
        later = later or current.kind == "function"
        current = parent
    return frozenset(found | _FALLTHROUGH)


def _join(*tables: dict[str, frozenset]) -> dict[str, frozenset]:
    """Merge the tables of the paths that meet: a name can hold any binding
    it holds on one of the paths, and a path that does not bind the name
    leaves it unbound. A name with no watched import that a path leaves
    unbound is left out: a missing name resolves the same way, and the
    tables stay small."""
    joined: dict[str, frozenset] = {}
    for name in set().union(*tables):
        possible = frozenset().union(*(table.get(name, _FALLTHROUGH) for table in tables))
        if possible - _SHADOW != _FALLTHROUGH:
            joined[name] = possible
    return joined


def _add(table: dict[str, frozenset], made: dict[str, frozenset]) -> dict[str, frozenset]:
    """The table plus the bindings a suite makes: control that leaves the
    suite early, or a later loop pass, can carry any of them."""
    added = dict(table)
    for name, possible in made.items():
        added[name] = added.get(name, _FALLTHROUGH) | possible
    return added


def _call_bindings(tree: ast.AST) -> dict[int, frozenset]:
    """Each call node's callee bindings, resolved at its source position.

    Scope bodies and compound-statement suites bind in execution order.
    Each suite starts from the bindings of the paths that reach it. The
    paths join after the statement: a binding in a suite that may not run
    (an if or match branch, a loop body, a try handler) does not hide a
    watched import or an unbound name on a path that skips the suite. A
    break, a continue, an exception, or a context manager that swallows one
    can leave a suite at any point, and a later loop pass starts from the
    bindings an earlier pass made, so those paths carry every binding the
    suite makes. A break also skips a loop's else suite. A walrus binds
    where it runs, before the rest of its statement, and only on the paths
    that run it. A call can run a body that binds a name through `global`
    or `nonlocal`. A name a function body binds is local to the whole body,
    as Python resolves it: unbound until its binding runs. A function's
    defaults, decorators, and annotations run in the scope that defines it.
    A call the walk reaches twice keeps the bindings of both visits.
    """
    bindings_by_call: dict[int, frozenset] = {}

    def apply(scope: _Scope, node: ast.AST) -> None:
        collector = _BindingCollector()
        collector.visit(node)
        for name, possible in collector.made().items():
            if name not in collector.direct:
                continue
            if possible == _FALLTHROUGH and scope.kind == "function":
                # A deleted local is unbound, not the enclosing scope's name.
                possible = _SHADOW
            scope.bindings[name] = possible

    def escape(scope: _Scope) -> None:
        # A call can run a body that binds a name through `global` or
        # `nonlocal`. The nearest function or module scope runs the call now.
        while scope.kind not in ("function", "module"):
            scope = scope.parent  # type: ignore[assignment]
        if scope.escaped:
            scope.bindings = _add(scope.bindings, scope.escaped)

    def walk_block(statements: object, scope: _Scope) -> None:
        for statement in statements:  # type: ignore[union-attr]
            walk(statement, scope)
            if not isinstance(statement, _SUITE_STATEMENTS):
                apply(scope, statement)

    def walk_suite(
        start: dict[str, frozenset], statements: object, scope: _Scope
    ) -> dict[str, frozenset]:
        scope.bindings = dict(start)
        walk_block(statements, scope)
        return scope.bindings

    def walk_branches(branches: list[ast.AST], scope: _Scope) -> None:
        # One of the branches runs. Only a walrus binds in an expression.
        if not _has_walrus(branches):
            for branch in branches:
                walk(branch, scope)
            return
        start = scope.bindings
        ends = []
        for branch in branches:
            scope.bindings = dict(start)
            walk(branch, scope)
            ends.append(scope.bindings)
        scope.bindings = _join(*ends)

    def walk_operands(operands: list[ast.AST], scope: _Scope) -> None:
        # The operator can stop before each operand after the first.
        walk(operands[0], scope)
        if not _has_walrus(operands[1:]):
            for operand in operands[1:]:
                walk(operand, scope)
            return
        exits = []
        for operand in operands[1:]:
            exits.append(dict(scope.bindings))
            walk(operand, scope)
        scope.bindings = _join(scope.bindings, *exits)

    def run_out(
        loop: ast.For | ast.AsyncFor | ast.While,
        entry: dict[str, frozenset],
        jumped: dict[str, frozenset],
        scope: _Scope,
    ) -> None:
        # The loop runs out after zero passes, after a full pass, or after a
        # continue, which can come from any point of the body.
        ends = [entry, scope.bindings]
        if _jumps(loop, ast.Continue):
            ends.append(jumped)
        scope.bindings = _join(*ends)

    def finish_loop(
        loop: ast.For | ast.AsyncFor | ast.While, jumped: dict[str, frozenset], scope: _Scope
    ) -> None:
        # The else suite runs when the loop runs out. A break leaves the loop
        # from any point of the body, without the else suite.
        walk_block(loop.orelse, scope)
        if _jumps(loop, ast.Break):
            scope.bindings = _join(scope.bindings, jumped)

    def walk(node: ast.AST, scope: _Scope) -> None:
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                func = func.value
            if isinstance(func, ast.Name):
                # A node the walk reaches twice keeps the bindings of both.
                seen = bindings_by_call.get(id(node), frozenset())
                bindings_by_call[id(node)] = seen | _resolve(scope, func.id)
            for child in ast.iter_child_nodes(node):
                walk(child, scope)
            escape(scope)
            return
        if isinstance(node, ast.NamedExpr):
            walk(node.value, scope)
            # The target binds before the rest of the statement runs.
            scope.bindings[node.target.id] = _SHADOW
            return
        if isinstance(node, ast.BoolOp):
            walk_operands(node.values, scope)
            return
        if isinstance(node, ast.Compare):
            walk(node.left, scope)
            walk_operands(node.comparators, scope)
            return
        if isinstance(node, ast.IfExp):
            walk(node.test, scope)
            walk_branches([node.body, node.orelse], scope)
            return
        if isinstance(node, ast.Assert):
            walk(node.test, scope)
            if node.msg is not None:
                # The message runs only when the assert raises, so its
                # bindings never reach the next statement.
                start = scope.bindings
                scope.bindings = dict(start)
                walk(node.msg, scope)
                scope.bindings = start
            return
        if isinstance(node, (ast.Assign, ast.AnnAssign)):
            # The value runs before the targets.
            if node.value is not None:
                walk(node.value, scope)
            if isinstance(node, ast.Assign):
                targets = node.targets
            else:
                targets = [node.target, node.annotation]
            for target in targets:
                walk(target, scope)
            return
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if key is not None:
                    walk(key, scope)
                walk(value, scope)
            return
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            for expression in _outer_expressions(node):
                walk(expression, scope)
            body = node.body if isinstance(node.body, list) else [node.body]
            inner = _Scope(
                "function",
                scope,
                _scope_bindings(node),
                _escaped_bindings(node, ast.Nonlocal),
                _global_names(body),
            )
            # A parameter is bound on entry; every other local is unbound
            # until its binding runs. Neither is the enclosing scope's name.
            inner.bindings = dict.fromkeys(inner.body_bindings, _SHADOW)
            walk_block(body, inner)
            return
        if isinstance(node, ast.ClassDef):
            for expression in (*node.decorator_list, *node.bases):
                walk(expression, scope)
            for keyword in node.keywords:
                walk(keyword.value, scope)
            walk_block(node.body, _Scope("class", scope, global_names=_global_names(node.body)))
            # The class body runs now and can bind a name through `global`.
            escape(scope)
            return
        if isinstance(node, ast.Module):
            module = _Scope(
                "module",
                body_bindings=_bindings_of(node.body),
                escaped=_escaped_bindings(node, ast.Global),
            )
            walk_block(node.body, module)
            return
        if isinstance(node, _COMPREHENSIONS):
            # The first iterable runs in the enclosing scope, before the
            # comprehension's own targets bind.
            first = node.generators[0]
            walk(first.iter, scope)
            # A generator expression runs as it is consumed, later than its
            # definition.
            kind = "function" if isinstance(node, ast.GeneratorExp) else "comprehension"
            inner = _Scope(kind, scope, _scope_bindings(node))
            inner.bindings = dict(inner.body_bindings)
            for index, generator in enumerate(node.generators):
                if index:
                    walk(generator.iter, inner)
                walk(generator.target, inner)
                for condition in generator.ifs:
                    walk(condition, inner)
            if isinstance(node, ast.DictComp):
                walk(node.key, inner)
                walk(node.value, inner)
            else:
                walk(node.elt, inner)
            return
        if isinstance(node, ast.If):
            walk(node.test, scope)
            start = scope.bindings
            scope.bindings = _join(
                walk_suite(start, node.body, scope), walk_suite(start, node.orelse, scope)
            )
            return
        if isinstance(node, (ast.For, ast.AsyncFor)):
            walk(node.iter, scope)
            entry = scope.bindings
            # A later pass starts from the bindings an earlier pass made, and
            # a break or a continue can leave the body at any point.
            jumped = _add(entry, _bindings_of(node.body))
            scope.bindings = dict(jumped)
            apply(scope, node.target)
            walk_block(node.body, scope)
            run_out(node, entry, jumped, scope)
            finish_loop(node, jumped, scope)
            return
        if isinstance(node, ast.While):
            entry = scope.bindings
            jumped = _add(entry, _bindings_of(node.body))
            scope.bindings = dict(jumped)
            walk(node.test, scope)
            walk_block(node.body, scope)
            run_out(node, entry, jumped, scope)
            # The loop runs out when its test fails, so the test runs once
            # more.
            walk(node.test, scope)
            finish_loop(node, jumped, scope)
            return
        if isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                walk(item.context_expr, scope)
                if item.optional_vars is not None:
                    apply(scope, item.optional_vars)
            start = dict(scope.bindings)
            walk_block(node.body, scope)
            # The context manager can swallow an exception from any point of
            # the body.
            scope.bindings = _add(_join(start, scope.bindings), _bindings_of(node.body))
            return
        if isinstance(node, (ast.Try, ast.TryStar)):
            start = scope.bindings
            completed = walk_suite(start, node.body, scope)
            # An exception can leave the body at any point.
            raised = _add(_join(start, completed), _bindings_of(node.body))
            handled = []
            for index, handler in enumerate(node.handlers):
                entry = raised
                if isinstance(node, ast.TryStar):
                    # One exception group can run several except* handlers
                    # in turn.
                    entry = _add(raised, _bindings_of(node.handlers[:index]))
                scope.bindings = dict(entry)
                walk(handler, scope)
                handled.append(scope.bindings)
            scope.bindings = completed
            walk_block(node.orelse, scope)
            scope.bindings = _join(scope.bindings, *handled)
            if node.finalbody:
                # The finally suite also runs when an exception leaves the
                # body, a handler, or the else suite.
                scope.bindings = _add(
                    _join(scope.bindings, raised), _bindings_of([*node.handlers, *node.orelse])
                )
                walk_block(node.finalbody, scope)
            return
        if isinstance(node, ast.ExceptHandler):
            if node.type is not None:
                walk(node.type, scope)
            if node.name:
                scope.bindings[node.name] = _SHADOW
            walk_block(node.body, scope)
            if node.name:
                # Python deletes the name after the handler. A local is then
                # unbound; a module or class lookup goes on to the enclosing
                # scope.
                if scope.kind == "function":
                    scope.bindings[node.name] = _SHADOW
                else:
                    scope.bindings.pop(node.name, None)
            return
        if isinstance(node, ast.Match):
            walk(node.subject, scope)
            start = scope.bindings
            last = node.cases[-1]
            exhaustive = (
                last.guard is None
                and isinstance(last.pattern, ast.MatchAs)
                and last.pattern.pattern is None
            )
            # Without a final wildcard or capture case, no case may match.
            ends = [] if exhaustive else [start]
            for case in node.cases:
                scope.bindings = dict(start)
                for name in _pattern_names(case.pattern):
                    scope.bindings[name] = _SHADOW
                if case.guard is not None:
                    walk(case.guard, scope)
                walk_block(case.body, scope)
                ends.append(scope.bindings)
            scope.bindings = _join(*ends)
            return
        for child in ast.iter_child_nodes(node):
            walk(child, scope)

    walk(tree, _Scope("module"))
    return bindings_by_call


def _subprocess_import(tree: ast.AST) -> ast.AST | None:
    """The cell's first subprocess import, wherever it sits in the tree."""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            if any(alias.name.split(".")[0] == "subprocess" for alias in node.names):
                return node
        elif (
            isinstance(node, ast.ImportFrom)
            and not node.level
            and (node.module or "").split(".")[0] == "subprocess"
        ):
            return node
    return None


class CellDeclinedError(Exception):
    """The kernel refused to run a cell: a banned shape under the discipline
    contract. The message names the offending call and the allowed alternative."""


def declined_reason(code: str) -> CellDeclinedError | None:
    """The decline for a banned cell shape, or None when the cell may run.

    Import-aware where it can be (aliases bind through `import time as t` and
    `from time import sleep`), name-based where it must be (the contract's
    `time.sleep(...)` shape is charged as written, imports or not). Bindings
    resolve per lexical scope and per path: a call declines when its callee
    can hold a banned binding on any path that reaches it, and a parameter or
    an assignment that shadows an import name on every path is not the
    imported call. A cell that does not parse declines nothing: the compile
    step reports the SyntaxError.
    """
    try:
        tree = ast.parse(code)
    except (SyntaxError, ValueError):
        return None
    call_bindings = _call_bindings(tree)
    subprocess_import = _subprocess_import(tree)

    def head(node: ast.AST) -> str:
        source = ast.get_source_segment(code, node)
        return (source or "").replace("\n", " ")[:60]

    calls = [
        (node, bound)
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        for bound in call_bindings.get(id(node), _FALLTHROUGH)
    ]
    for node, bound in calls:
        func = node.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if bound is _UNBOUND:
                root = func.value.id
            elif bound is not None and bound[0] == "module":
                root = bound[1]
            else:
                continue
            member = func.attr
        elif isinstance(func, ast.Name):
            if bound is _UNBOUND or bound is None or bound[0] != "member":
                continue
            root, member = bound[1], bound[2]
        else:
            continue
        if root in ("time", "asyncio") and member == "sleep":
            seconds = _literal_seconds(node)
            if seconds is not None and seconds >= _DECLINE_SLEEP_SECONDS:
                return CellDeclinedError(
                    f"{head(node)}: the kernel declines in-cell sleeps of "
                    f"{_DECLINE_SLEEP_SECONDS:g}s or longer - a sleeping cell parks "
                    "the whole turn and nothing can wake it. End the turn instead: "
                    "start the work with bash() (it returns immediately), reply with "
                    "a short status text, and the [bash-done] notification wakes the "
                    "session with the result; arm rlm_heartbeat.create for scheduled "
                    "wakes. Remove the sleep and rerun the cell."
                )
        if (
            (root == "subprocess" and member in _SUBPROCESS_CALLS)
            or (root == "os" and member in ("system", "popen"))
            or (root == "pty" and member == "spawn")
        ):
            return CellDeclinedError(
                f"{head(node)}: the kernel declines process spawning from a cell - "
                "bash() is the shell surface, never subprocess/os.system/pty. Run "
                "the command with bash('...') instead: it returns immediately, "
                "await it bounded or read the handle later, and the [bash-done] "
                "notification delivers the result. Remove the subprocess call and "
                "rerun the cell."
            )
    if subprocess_import is not None:
        return CellDeclinedError(
            f"{head(subprocess_import)}: the kernel declines process spawning from "
            "a cell - bash() is the shell surface, never subprocess/os.system/pty. "
            "Run the command with bash('...') instead: it returns immediately, "
            "await it bounded or read the handle later, and the [bash-done] "
            "notification delivers the result. Remove the subprocess import and "
            "rerun the cell."
        )
    return None


def _literal_seconds(call: ast.Call) -> int | float | None:
    """The call's duration as a number literal, else None.

    Positional first, then the documented keyword (`delay` for asyncio.sleep,
    `secs` for time.sleep). The charged surface is literal-only: a sleep
    computed from a variable is invisible to the screen exactly as it is to
    the contract's literal shape."""
    if call.args:
        arg: ast.AST | None = call.args[0]
    else:
        arg = next(
            (keyword.value for keyword in call.keywords if keyword.arg in ("delay", "secs")),
            None,
        )
    if not isinstance(arg, ast.Constant) or not isinstance(arg.value, (int, float)):
        return None
    if isinstance(arg.value, bool):
        return None
    return arg.value
