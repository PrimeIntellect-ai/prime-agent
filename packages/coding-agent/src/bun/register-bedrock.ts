import { setBedrockProviderModuleLoader } from "@earendil-works/pi-ai";

setBedrockProviderModuleLoader(async () => {
	const { bedrockProviderModule } = await import("@earendil-works/pi-ai/bedrock-provider");
	return bedrockProviderModule;
});
