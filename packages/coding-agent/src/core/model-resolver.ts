const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  "amazon-bedrock": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  chutes: "moonshotai/Kimi-K3-TEE",
  aiand: "deepseek-ai/deepseek-v4-flash",
  cloudflare: "@cf/meta/llama-3.3-7b-instruct",
  google: "gemini-2.5-pro",
  "google-vertex": "gemini-2.5-pro",
  mistral: "mistral-large-latest",
  openai: "gpt-4.1",
  "openai-codex": "codex-mini-latest",
  openrouter: "anthropic/claude-sonnet-4",
  "prime-inference": "meta-llama/Llama-3.3-70B-Instruct",
  "github-copilot": "claude-sonnet-4",
  "vercel-ai-gateway": "@ai/gateway",
  huggingface: "Qwen/Qwen2.5-72B-Instruct",
  moonshotai: "moonshot-v1-32k",
  zen: "zen-medium",
};

export { DEFAULT_MODELS };