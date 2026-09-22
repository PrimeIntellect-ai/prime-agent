// typebox shim for the extension host (stage 2).
//
// TS ground truth: the typebox Type builder the TS product serves under the
// `typebox` / `@sinclair/typebox` aliases (loader.ts getAliases);
// `packages/ai/src/index.ts` re-exports it from `typebox`. Extensions build
// their tool parameter schemas with it, and the result is JSON-Schema
// compatible, so the host passes it through as the tool wire schema exactly
// like the TS agent registry does.
//
// This shim implements the builder subset the extension corpus uses.
// Imports of names this module does not export (Value, Compile, ...) resolve
// to `undefined` through jiti's interop and throw at use time - the v1
// documented degradation (design doc §2.6).

const OPT = Symbol("piOptional");

function stripOptional(schema) {
  const copy = { ...schema };
  delete copy[OPT];
  return copy;
}

function isOptional(schema) {
  return Boolean(schema && schema[OPT]);
}

const factory = (schema) => (options = {}) => ({ ...schema, ...options });

export const Type = {
  Object: (properties, options = {}) => {
    const props = {};
    const required = [];
    for (const [key, schema] of Object.entries(properties)) {
      props[key] = stripOptional(schema);
      if (!isOptional(schema)) required.push(key);
    }
    return {
      type: "object",
      properties: props,
      ...(required.length > 0 ? { required } : {}),
      ...options,
    };
  },
  Array: (items, options = {}) => ({ type: "array", items, ...options }),
  String: factory({ type: "string" }),
  Number: factory({ type: "number" }),
  Integer: factory({ type: "integer" }),
  Boolean: factory({ type: "boolean" }),
  Null: factory({ type: "null" }),
  Any: factory({}),
  Unknown: factory({}),
  Literal: (value) => ({ const: value }),
  Union: (schemas, options = {}) => ({ anyOf: schemas, ...options }),
  Record: (key, values, options = {}) => ({
    type: "object",
    propertyNames: key,
    additionalProperties: values,
    ...options,
  }),
  Optional: (schema) => ({ ...schema, [OPT]: true }),
  Enum: (values, options = {}) => ({ enum: [...values], ...options }),
};

export default { Type, ...Type };
