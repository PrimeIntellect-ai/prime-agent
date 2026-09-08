import json
import math
import os
import urllib.request
from synthesizer.mutator import mutate_ast
from synthesizer.recombinator import recombine_ast

LINEAR = """def binary_search(values, target):
    for index in range(len(values)):
        if values[index] == target:
            return index
    return -1
"""
BINARY = """def binary_search(values, target):
    low = 0
    high = len(values)
    while low < high:
        mid = (low + high) // 2
        if values[mid] < target:
            low = mid + 1
        else:
            high = mid
    if low < len(values) and values[low] == target:
        return low
    return -1
"""
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("model endpoint redirects are forbidden")


STRATEGIES = ("direct", "mutation", "crossover", "repair")


def select_strategy(history):
    total = sum(v[0] for v in history.values())
    for strategy in STRATEGIES:
        if not history.get(strategy, (0, 0))[0]:
            return strategy
    return max(STRATEGIES, key=lambda s: history[s][1] / history[s][0] + math.sqrt(2 * math.log(total) / history[s][0]))


class CandidateSynthesizer:
    def __init__(self, provider="demo"):
        self.provider = provider

    def generate(self, strategy, context, seed):
        parents = context.get("sources") or [LINEAR, BINARY]
        if strategy == "mutation":
            return mutate_ast(parents[-1], seed)
        if strategy == "crossover":
            return recombine_ast(parents[0], parents[-1], seed) or parents[-1]
        if self.provider == "demo":
            return BINARY if strategy == "repair" or seed % 2 == 0 else LINEAR
        endpoint = os.environ["LAB_MODEL_URL"]
        if not endpoint.startswith("https://") and not endpoint.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("model endpoint must use HTTPS or loopback HTTP")
        body = {"model": os.environ["LAB_MODEL_NAME"], "messages": [
            {"role": "system", "content": "Return only Python source for the requested pure function."},
            {"role": "user", "content": json.dumps(context)}], "max_tokens": 2048}
        headers = {"Content-Type": "application/json"}
        if os.environ.get("LAB_MODEL_KEY"):
            headers["Authorization"] = "Bearer " + os.environ["LAB_MODEL_KEY"]
        request = urllib.request.Request(endpoint, json.dumps(body).encode(), headers)
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=60) as response:
            raw = response.read(131073)
        if len(raw) > 131072:
            raise ValueError("model response too large")
        source = json.loads(raw)["choices"][0]["message"]["content"].strip()
        if source.startswith("```python\n") and source.endswith("```"):
            source = source[10:-3].strip()
        return source + "\n"
