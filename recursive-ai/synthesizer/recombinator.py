import ast
import copy
import random


def recombine_ast(first, second, seed):
    a, b = ast.parse(first), ast.parse(second)
    # Whole functions preserve lexical scope; unrestricted loop swaps do not.
    matches = [(i, donor) for i, original in enumerate(a.body) for donor in b.body
               if isinstance(original, ast.FunctionDef) and isinstance(donor, ast.FunctionDef)
               and original.name == donor.name and ast.dump(original.args) == ast.dump(donor.args)]
    if not matches:
        return None
    index, donor = random.Random(seed).choice(matches)
    a.body[index] = copy.deepcopy(donor)
    return ast.unparse(ast.fix_missing_locations(a)) + "\n"
