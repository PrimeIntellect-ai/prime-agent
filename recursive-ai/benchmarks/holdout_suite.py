"""Fresh evaluator-only samples; never sent to synthesis or mounted in sandbox."""
import random
import secrets


def samples(count=1000, seed=None):
    rng = random.Random(secrets.randbits(128) if seed is None else seed)
    result = []
    for _ in range(count):
        values = sorted(rng.randint(-10000, 10000) for _ in range(rng.randrange(256)))
        target = rng.choice(values) if values and rng.random() < 0.6 else rng.randint(-10001, 10001)
        result.append((values, target))
    return result
