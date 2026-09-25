/**
 * Routing for image-attaching turns on session models without image input.
 */

import type { AgentModelOverride, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, clampServiceTier, clampThinkingLevel, type Model, type ServiceTier } from "@earendil-works/pi-ai";
import {
	formatImageModelRequiredMessage,
	formatImageModelUnusableMessage,
	type ImageModelReferenceProblem,
} from "./auth-guidance.js";
import { findExactModelReferenceMatch } from "./model-resolver.js";

/**
 * How long a pin setter waits for the model catalog's background refresh to
 * settle. refreshAvailableModels() resolves while its fetch keeps running, so a
 * provider authenticated moments ago is otherwise missing from the very list a
 * pin is validated against.
 */
export const IMAGE_MODEL_PIN_READINESS_TIMEOUT_MS = 5_000;

/** Inputs for validating one explicit image-model reference. */
export interface ImageModelReferenceInputs {
	/** Reference to resolve: "provider/model-id" or a bare model id. */
	reference: string;
	/** Registry models the reference may resolve to. */
	availableModels: Model<Api>[];
	/** Whether the registry has working credentials for a model. */
	hasConfiguredAuth: (model: Model<any>) => boolean;
}

/** Session state the routing decision needs when a turn batch commits. */
export interface ImageModelRoutingInputs extends Omit<ImageModelReferenceInputs, "reference"> {
	/** Model selected for the session; the routed turns carry images it cannot see. */
	sessionModel: Model<any>;
	/** Session thinking level; clamped to what the routed model supports. */
	thinkingLevel: ThinkingLevel;
	/** Session service tier; clamped to what the routed model supports. */
	serviceTier: ServiceTier;
	/** Image-model reference; the session override when set, else settings.imageModel. */
	imageModelReference: string | undefined;
	/** settings.images.blockImages: no image reaches any provider, so no turn routes. */
	blockImages: boolean;
}

export type ImageModelReferenceResolution =
	| { ok: true; model: Model<Api> }
	| { ok: false; problem: ImageModelReferenceProblem };

/**
 * Validate one explicit image-model reference: it must resolve to a model in
 * the registry, accept image input, and have working credentials. Callers that
 * face the user report `problem` so the fix is named; routing keeps its own
 * single message.
 */
export function resolveImageModelReference(inputs: ImageModelReferenceInputs): ImageModelReferenceResolution {
	const model = findExactModelReferenceMatch(inputs.reference, inputs.availableModels);
	if (!model) return { ok: false, problem: "unresolved" };
	if (!model.input.includes("image")) return { ok: false, problem: "text-only" };
	if (!inputs.hasConfiguredAuth(model)) return { ok: false, problem: "unauthenticated" };
	return { ok: true, model };
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
	const resolution = resolveImageModelReference({
		reference: inputs.imageModelReference,
		availableModels: inputs.availableModels,
		hasConfiguredAuth: inputs.hasConfiguredAuth,
	});
	if (!resolution.ok) {
		throw new Error(formatImageModelUnusableMessage(inputs.imageModelReference));
	}
	const imageModel = resolution.model;
	return {
		model: imageModel,
		thinkingLevel: clampThinkingLevel(imageModel, inputs.thinkingLevel) as ThinkingLevel,
		serviceTier: clampServiceTier(imageModel, inputs.serviceTier),
	};
}
