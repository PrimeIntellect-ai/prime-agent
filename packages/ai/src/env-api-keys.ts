export function resolveApiKey(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "amazon-bedrock":
      return undefined;
    case "azure-openai":
      return process.env.AZURE_OPENAI_API_KEY;
    case "chutes":
      return process.env.CHUTES_API_KEY;
    case "aiand":
      return process.env.AIAAND_API_KEY;
    case "cloudflare":
      return process.env.CLOUDFLARE_API_KEY;
    case "google":
      return process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    case "google-vertex":
      return undefined;
    case "mistral":
      return process.env.MISTRAL_API_KEY;
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "openai-codex":
      return process.env.OPENAI_API_KEY;
    case "openrouter":
      return process.env.OPENROUTER_API_KEY;
    case "prime-inference":
      return process.env.PRIME_INFERENCE_API_KEY;
    case "github-copilot":
      return undefined;
    case "vercel-ai-gateway":
      return process.env.VERCEL_AI_GATEWAY_API_KEY;
    case "huggingface":
      return process.env.HUGGING_FACE_API_KEY;
    case "moonshotai":
      return process.env.MOONSHOT_API_KEY;
    case "zen":
      return process.env.ZEN_API_KEY;
    default:
      return undefined;
  }
}

export function findEnvKeys(provider: string): string[] {
  switch (provider) {
    case "anthropic":
      return ["ANTHROPIC_API_KEY"];
    case "amazon-bedrock":
      return [];
    case "azure-openai":
      return ["AZURE_OPENAI_API_KEY"];
    case "chutes":
      return ["CHUTES_API_KEY"];
    case "aiand":
      return ["AIAAND_API_KEY"];
    case "cloudflare":
      return ["CLOUDFLARE_API_KEY"];
    case "google":
      return ["GOOGLE_GENERATIVE_AI_API_KEY"];
    case "google-vertex":
      return [];
    case "mistral":
      return ["MISTRAL_API_KEY"];
    case "openai":
      return ["OPENAI_API_KEY"];
    case "openai-codex":
      return ["OPENAI_API_KEY"];
    case "openrouter":
      return ["OPENROUTER_API_KEY"];
    case "prime-inference":
      return ["PRIME_INFERENCE_API_KEY"];
    case "github-copilot":
      return [];
    case "vercel-ai-gateway":
      return ["VERCEL_AI_GATEWAY_API_KEY"];
    case "huggingface":
      return ["HUGGING_FACE_API_KEY"];
    case "moonshotai":
      return ["MOONSHOT_API_KEY"];
    case "zen":
      return ["ZEN_API_KEY"];
    default:
      return [];
  }
}