import { setBedrockProviderModuleLoader } from "@prime-intellect/prime-agent-ai";

setBedrockProviderModuleLoader(async () => {
	const { bedrockProviderModule } = await import("@prime-intellect/prime-agent-ai/bedrock-provider");
	return bedrockProviderModule;
});
