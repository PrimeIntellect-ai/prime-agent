"""Conservative pure-function subset; OS isolation remains mandatory."""
import ast

BUILTINS = {"len", "range", "min", "max", "abs", "sum", "sorted", "enumerate", "zip", "reversed", "all", "any", "int", "bool", "list", "tuple"}
FORBIDDEN = (ast.Import, ast.ImportFrom, ast.Attribute, ast.ClassDef, ast.Lambda,
             ast.Global, ast.Nonlocal, ast.With, ast.AsyncFunctionDef, ast.Await,
             ast.Yield, ast.YieldFrom, ast.Try, ast.Raise, ast.Delete)


def parse(source):
    if len(source.encode()) > 32768:
        raise ValueError("source exceeds 32 KiB")
    tree = ast.parse(source)
    if sum(1 for _ in ast.walk(tree)) > 4096:
        raise ValueError("AST exceeds 4096 nodes")
    return tree


def validate(tree):
    functions = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
    if not functions or any(not isinstance(n, ast.FunctionDef) for n in tree.body):
        raise ValueError("module must contain only function definitions")
    for node in ast.walk(tree):
        if isinstance(node, FORBIDDEN):
            raise ValueError("forbidden syntax: " + type(node).__name__)
        if isinstance(node, (ast.Name, ast.arg, ast.FunctionDef)):
            name = node.id if isinstance(node, ast.Name) else node.arg if isinstance(node, ast.arg) else node.name
            if name.startswith("_"):
                raise ValueError("private identifiers forbidden")
        if isinstance(node, ast.FunctionDef):
            if node.decorator_list or node.returns or node.args.defaults or node.args.kw_defaults:
                raise ValueError("decorators, annotations, defaults forbidden")
        if isinstance(node, ast.arg) and node.annotation:
            raise ValueError("annotations forbidden")
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in BUILTINS | functions:
                raise ValueError("call outside pure function allowlist")
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store) and node.id in BUILTINS | functions:
            raise ValueError("callable rebinding forbidden")
    return True
