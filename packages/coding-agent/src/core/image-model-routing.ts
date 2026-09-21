/**
 * Routing for image-attaching turns on session models without image input.
 */

import type { AgentModelOverride, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampThinkingLevel, type Model, type ServiceTier, supportsFastMode } from "@earendil-works/pi-ai";
import { formatImageModelRequiredMessage, formatImageModelUnusableMessage } from "./auth-guidance.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";

/** Session state the routing decision needs when a turn batch commits. */
export interface ImageModelRoutingInputs {
	/** Model selected for the session; the routed turns carry images it cannot see. */
	sessionModel: Model<any>;
	/** Session thinking level; clamped to what the routed model supports. */
	thinkingLevel: ThinkingLevel;
	/** Session service tier; clamped to what the routed model supports. */
	serviceTier: ServiceTier;
	/** settings.imageModel reference ("provider/model-id" or a bare id). */
	imageModelReference: string | undefined;
	/** Registry models the reference may resolve to. */
	availableModels: Model<Api>[];
	/** Whether the registry has working credentials for a model. */
	hasConfiguredAuth: (model: Model<any>) => boolean;
	/** settings.images.blockImages: no image reaches any provider, so no turn routes. */
	blockImages: boolean;
}

/**
 * Resolve the model that serves turns attaching images: the configured image
 * model when the session model has no image input, undefined when the session
 * model serves them natively. Throws an actionable error when the turn cannot
 * be served honestly: a text-only session model would otherwise downgrade the
 * images to an "(image omitted)" placeholder.
 */
export function resolveImageModelOverride(inputs: ImageModelRoutingInputs): AgentModelOverride | undefined {
	const { sessionModel } = inputs;
	if (sessionModel.input.includes("image") || inputs.blockImages) return undefined;
	if (!inputs.imageModelReference) {
		throw new Error(formatImageModelRequiredMessage(`${sessionModel.provider}/${sessionModel.id}`));
	}
	const imageModel = findExactModelReferenceMatch(inputs.imageModelReference, inputs.availableModels);
	if (!imageModel || !imageModel.input.includes("image") || !inputs.hasConfiguredAuth(imageModel)) {
		throw new Error(formatImageModelUnusableMessage(inputs.imageModelReference));
	}
	return {
		model: imageModel,
		thinkingLevel: clampThinkingLevel(imageModel, inputs.thinkingLevel) as ThinkingLevel,
		serviceTier: inputs.serviceTier === "priority" && !supportsFastMode(imageModel) ? "default" : inputs.serviceTier,
	};
}
