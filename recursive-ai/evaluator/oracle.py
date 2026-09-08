def reference(values, target):
    for index, value in enumerate(values):
        if value == target:
            return index
    return -1


def expected(cases):
    return [reference(*case) for case in cases]
