// @earendil-works/pi-coding-agent shim for the extension host (stage 2).
//
// TS ground truth: `packages/coding-agent/src/index.ts` exports `defineTool`
// (extensions/types.ts: the identity helper that preserves the
// ToolDefinition type) and re-exports `Type`. Extensions reach the rest of
// the product through the `pi` object the factory receives, not through this
// import; other value imports resolve to `undefined` through jiti's interop
// and throw at use time (design doc §2.6/R3).

export { Type } from "./typebox.mjs";

// types.ts defineTool: an identity function at runtime.
export function defineTool(tool) {
  return tool;
}
