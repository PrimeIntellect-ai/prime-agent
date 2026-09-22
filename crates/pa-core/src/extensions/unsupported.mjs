// Shim for pi packages with no sidecar-representable value surface
// (@earendil-works/pi-tui components, pi-agent-core internals,
// typebox/compile, typebox/value, oauth flows). TS parity note: in the
// compiled TS binary these are real virtual modules; over the sidecar
// boundary components and callbacks cannot cross, so v1 exposes no exports:
// imports resolve to `undefined` through jiti's interop and throw at use
// time - degrade with a diagnostic, never fail the load (design doc
// §2.6/R3).

export {};
