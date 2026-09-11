import { bedrockProviderModule, setLogSink } from "@earendil-works/pi-ai/bedrock-provider";
import { writeFileLogEntry } from "../core/logging.js";

// The external provider has its own logger instance; keep the CLI's sink and context.
setLogSink(writeFileLogEntry);

export const { streamBedrock, streamSimpleBedrock } = bedrockProviderModule;
