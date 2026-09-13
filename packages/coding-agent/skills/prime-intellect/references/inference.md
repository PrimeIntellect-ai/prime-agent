# Prime Inference

Prime Inference is an OpenAI-compatible API for frontier and open models, routed across providers and built for large-scale evaluations.

Live docs: `inference/overview.md`, `inference/usage.md`, `inference/adapter-deployments.md`, `inference/troubleshooting.md` under https://docs.primeintellect.ai/

## Setup

1. Create an API key on https://app.primeintellect.ai (account settings → API Keys) with the **Inference** permission enabled — without it, requests fail with authentication errors.
2. Export it:

```bash
export PRIME_API_KEY="your-api-key-here"
```

Note: the Python kernel does not inherit `PRIME_API_KEY` (or other provider keys) from the host environment. The `prime` CLI still authenticates from `~/.prime/config.json`; for direct API calls from kernel code, read the key from `~/.prime/config.json` (`api_key`) or ask the user to add `PRIME_API_KEY` to `kernel.envPassthrough` in settings.

## Via the CLI (recommended for evaluations)

```bash
prime inference models                                   # list available models
prime eval run gsm8k -m meta-llama/llama-3.1-70b-instruct -n 25   # evals route through Prime Inference
```

Eval runs against Prime Inference models report estimated USD cost automatically.

## Direct API (OpenAI-compatible)

Base URL: `https://api.pinference.ai/api/v1`

```python
import openai, os

client = openai.OpenAI(
    api_key=os.environ["PRIME_API_KEY"],
    base_url="https://api.pinference.ai/api/v1",
)
response = client.chat.completions.create(
    model="meta-llama/llama-3.1-70b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
)
```

Anything that speaks the OpenAI API works — just point it at the base URL above. Streaming and advanced parameters are covered in `inference/usage.md`.

## Teams & Adapters

- Team billing: send the `X-Prime-Team-ID` header (find the ID via `prime teams list` or the Team Profile page) to use team credits instead of personal balance.
- LoRA adapters trained with Hosted Training can be deployed and queried through the same OpenAI-compatible API (`inference/adapter-deployments.md`).
