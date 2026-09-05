/**
 * B14a sandbox-side provider proxy client types.
 *
 * Transport-neutral frame protocol for consuming provider proxy frames
 * from inside the sandbox. Mirrors the B05 home-provider-proxy types
 * but defines the sandbox-side transport contract.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ProxyCompletionFrame,
	ProxyErrorFrame,
	ProxyFrame,
	ProxyStreamEventFrame,
} from "./home-provider-proxy-types.js";

export type {
	ProxyCancelFrame,
	ProxyCompletionFrame,
	ProxyErrorFrame,
	ProxyFrame,
	ProxyRequestFrame,
	ProxyStreamEventFrame,
} from "./home-provider-proxy-types.js";

/**
 * Transport abstraction for sending ProxyFrames and receiving them.
 *
 * Must not expose credentials, base URLs, or headers to the client.
 * The transport is established and configured by the sandbox bootstrap;
 * the SandboxProviderClient only calls send/onFrame/close.
 */
export interface FrameTransport {
	send(frame: ProxyFrame): void;
	onFrame(handler: (raw: unknown) => void): () => void;
	close(): void;
}

/**
 * Configuration for the SandboxProviderClient.
 */
export interface SandboxProviderClientConfig {
	/** Transport over which frames are sent and received. */
	transport: FrameTransport;
	/** Model lookup for resolving ProxyModelRef to Model objects. Null disables lookup. */
	modelLookup: ModelLookup | null;
}

export interface ModelLookup {
	findModel(provider: string, modelId: string): Model<Api> | undefined;
}

/**
 * Output frames emitted by the sandbox client's stream generator,
 * identical to the home-proxy output types.
 */
export type SandboxStreamOutput = AsyncGenerator<
	ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame,
	void,
	unknown
>;

export const SANDBOX_ERROR_CODES = {
	TRANSPORT_DISCONNECTED: "TRANSPORT_DISCONNECTED",
	STREAM_FAILED: "STREAM_FAILED",
	DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
	REQUEST_CANCELLED: "REQUEST_CANCELLED",
	INVALID_FRAME: "INVALID_FRAME",
} as const;
