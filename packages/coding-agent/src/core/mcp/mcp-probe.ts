import { type McpDeclaration, previewMcpProbe } from "./mcp-declarations.js";

/**
 * A declaration-only probe contract. It describes the single request a future
 * transport boundary may make, but never opens a session or reaches a network.
 * Transport ownership belongs to the runtime boundary layer.
 */
export type McpDeclarationProbePreview = ReturnType<typeof previewMcpProbe>;

/** Returns a bounded, offline preview for an already-validated declaration. */
export function previewMcpDeclarationProbe(declaration: McpDeclaration): McpDeclarationProbePreview {
	return previewMcpProbe(declaration);
}
