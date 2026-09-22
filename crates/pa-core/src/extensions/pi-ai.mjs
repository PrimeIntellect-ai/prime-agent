// @earendil-works/pi-ai shim for the extension host (stage 2).
//
// TS ground truth: `packages/ai/src/index.ts` re-exports `Type` from
// `typebox`; extensions import it for tool schemas. Everything else in the
// package (providers, streaming) is host machinery that cannot cross the
// sidecar boundary; those imports resolve to `undefined` through jiti's
// interop and throw at use time (v1 documented degradation).

export { Type } from "./typebox.mjs";
