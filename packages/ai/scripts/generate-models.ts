import { writeFileSync } from "fs";
import { join } from "path";

const providers = {
  chutes: {
    baseUrl: "https://llm.chutes.ai/v1",
    apiKeyEnv: "CHUTES_API_KEY",
    filter: (model: any) => true,
    compat: { supportsDeveloperRole: false },
  },
  aiand: {
    baseUrl: "https://api.aiand.com/v1",
    apiKeyEnv: "AIAAND_API_KEY",
    filter: (model: any) => true,
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
    models: [
      { id: "zai-org/glm-5.2", pricing: { input: 1.0, cachedInput: 0.30, output: 4.0 }, contextWindow: 1000000, supportsTools: true, supportsVision: false },
      { id: "moonshotai/kimi-k2.7-code", pricing: { input: 0.75, cachedInput: 0.20, output: 3.50 }, contextWindow: 262144, supportsTools: true, supportsVision: false },
      { id: "moonshotai/kimi-k3", pricing: { input: 3.0, cachedInput: 0.50, output: 12.50 }, contextWindow: 1000000, supportsTools: true, supportsVision: false },
      { id: "deepseek-ai/deepseek-v4-pro", pricing: { input: 1.0, cachedInput: 0.25, output: 2.50 }, contextWindow: 1000000, supportsTools: true, supportsVision: false },
      { id: "motif-technologies/motif-3", pricing: { input: 0.50, cachedInput: 0.20, output: 2.0 }, contextWindow: 262144, supportsTools: true, supportsVision: false },
      { id: "deepseek-ai/deepseek-v4-flash", pricing: { input: 0.15, cachedInput: 0.08, output: 0.25 }, contextWindow: 1000000, supportsTools: true, supportsVision: false },
      { id: "qwen/qwen3.6-27b", pricing: { input: 0.32, cachedInput: 0.20, output: 3.20 }, contextWindow: 262144, supportsTools: true, supportsVision: false },
      { id: "google/gemma-4-31b-it", pricing: { input: 0.20, cachedInput: 0.05, output: 0.50 }, contextWindow: 262144, supportsTools: true, supportsVision: false },
      { id: "openai/gpt-oss-120b", pricing: { input: 0.15, cachedInput: 0.08, output: 0.60 }, contextWindow: 131072, supportsTools: true, supportsVision: false },
    ],
  },
};

export { providers };