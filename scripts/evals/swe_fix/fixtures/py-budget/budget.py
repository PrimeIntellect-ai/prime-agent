"""Budget allocation: split an income across weighted recipients."""


def allocate(income, weights):
    """Split *income* (cents, int) across named weights.

    Each share is a whole cent; the shares must sum back to exactly
    *income*.
    """
    if not weights:
        raise ValueError("weights must not be empty")
    if any(w < 0 for w in weights.values()) or sum(weights.values()) == 0:
        raise ValueError("weights must be positive")
    total_w = sum(weights.values())
    shares = {name: round(income * w / total_w) for name, w in weights.items()}
    return shares
