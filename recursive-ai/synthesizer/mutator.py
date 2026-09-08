import ast
import random


def mutate_ast(source, seed):
    rng = random.Random(seed)
    tree = ast.parse(source)
    choices = [n for n in ast.walk(tree) if isinstance(n, ast.Constant) and type(n.value) is int]
    if choices:
        node = rng.choice(choices)
        node.value += rng.choice([-1, 1])
    return ast.unparse(ast.fix_missing_locations(tree)) + "\n"
