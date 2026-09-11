import { streamBedrock, streamSimpleBedrock } from "./providers/amazon-bedrock.js";

export { setLogSink } from "./log.js";

export const bedrockProviderModule = {
	streamBedrock,
	streamSimpleBedrock,
};
