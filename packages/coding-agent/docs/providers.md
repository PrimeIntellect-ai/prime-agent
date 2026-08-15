## ai&

**Provider ID:** `aiand`

**API Key:** Set `AIAAND_API_KEY` environment variable or add `aiand` key to `auth.json`

**Get API Key:** Sign up at https://console.aiand.com/ and create an API key

**Base URL:** `https://api.aiand.com/v1` (auto-configured)

**Default Model:** `deepseek-ai/deepseek-v4-flash` (best price-performance at $0.15/$0.25 per 1M tokens)

**Available Models:**

| Model | Input | Cached | Output | Context |
|-------|-------|--------|--------|---------|
| `zai-org/glm-5.2` | $1.00 | $0.30 | $4.00 | 1M |
| `moonshotai/kimi-k2.7-code` | $0.75 | $0.20 | $3.50 | 262K |
| `moonshotai/kimi-k3` | $3.00 | $0.50 | $12.50 | 1M |
| `deepseek-ai/deepseek-v4-pro` | $1.00 | $0.25 | $2.50 | 1M |
| `motif-technologies/motif-3` | $0.50 | $0.20 | $2.00 | 262K |
| `deepseek-ai/deepseek-v4-flash` | $0.15 | $0.08 | $0.25 | 1M |
| `qwen/qwen3.6-27b` | $0.32 | $0.20 | $3.20 | 262K |
| `google/gemma-4-31b-it` | $0.20 | $0.05 | $0.50 | 262K |
| `openai/gpt-oss-120b` | $0.15 | $0.08 | $0.60 | 131K |

**Example:**

```bash
export AIAAND_API_KEY=your-api-key
prime-agent --provider aiand --model deepseek-ai/deepseek-v4-flash
```

Or add to `auth.json`:

```json
{
  "aiand": "your-api-key"
}
```

**Notes:**
- ai& is a Japan-based sovereign AI provider
- OpenAI-compatible API (works with OpenAI SDK)
- Data residency in Japan (no cross-border egress)
- Supports `reasoning_effort` parameter for enhanced reasoning
- Up to 80% lower cost than proprietary providers
- All models support tool/function calling