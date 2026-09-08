def generalization_cases():
    bases = [([], 0), ([0] * 100, 0), ([-9, -9, 0, 7, 7], 7), ([-10**100, 0, 10**100], 10**100)]
    cases = []
    for values, target in bases:
        cases.extend([(values, target), ([x + 137 for x in values], target + 137),
                      ([x * 3 for x in values], target * 3),
                      (sorted(-x for x in values), -target)])
    return cases
