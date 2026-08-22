/**
 * xAI 400s the whole turn when a tool root is `type: object` plus a typeless
 * exclusive-required `anyOf`/`oneOf` (MCP exclusive-required pairs). Flatten
 * only that root fragment. Nested unions stay intact. Leftover object-root
 * unions are detected so callers can quarantine one tool instead of 400ing.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function declaredTypes(node: Record<string, unknown>): string[] {
	if (typeof node.type === "string") return [node.type];
	if (Array.isArray(node.type)) return node.type.filter((type): type is string => typeof type === "string");
	return [];
}

function isExclusiveRequiredBranch(branch: unknown): boolean {
	if (!isRecord(branch)) return false;
	if (Object.hasOwn(branch, "type")) return false;
	if (!Array.isArray(branch.required) || branch.required.length === 0) return false;
	if (!branch.required.every((name) => typeof name === "string" && name.length > 0)) return false;
	for (const key in branch) {
		if (!Object.hasOwn(branch, key)) continue;
		if (key === "required" || key === "description" || key === "title") continue;
		return false;
	}
	return true;
}

export function cloneJsonSchema(value: unknown): Record<string, unknown> {
	try {
		const cloned = JSON.parse(JSON.stringify(value)) as unknown;
		return isRecord(cloned) ? cloned : { type: "object", properties: {} };
	} catch {
		return { type: "object", properties: {} };
	}
}

/** Delete a root exclusive-required anyOf/oneOf. Nested unions are not walked. */
export function flattenExclusiveRequiredUnion(schema: Record<string, unknown>): void {
	const unionKey = Array.isArray(schema.anyOf) ? "anyOf" : Array.isArray(schema.oneOf) ? "oneOf" : undefined;
	if (!unionKey) return;
	const union = schema[unionKey];
	if (!Array.isArray(union) || union.length === 0) return;
	const typedObject = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object"));
	if (!typedObject && !isRecord(schema.properties)) return;
	if (!union.every(isExclusiveRequiredBranch)) return;
	delete schema[unionKey];
}

/**
 * True when the *root* is an object (or has properties) and still carries an
 * anyOf/oneOf with a typeless or non-object branch. Nested unions are ignored.
 */
export function hasXaiRootObjectUnion(schema: Record<string, unknown>): boolean {
	const types = declaredTypes(schema);
	if (!(types.includes("object") || isRecord(schema.properties))) return false;
	for (const key of ["anyOf", "oneOf"] as const) {
		const arr = schema[key];
		if (!Array.isArray(arr) || arr.length === 0) continue;
		const hasNonObjectBranch = arr.some((branch) => {
			if (!isRecord(branch)) return true;
			return !declaredTypes(branch).includes("object");
		});
		if (hasNonObjectBranch) return true;
	}
	return false;
}

export function prepareCompletionsToolParameters(
	parameters: unknown,
	options: { rejectXaiRootObjectUnion: boolean },
): { parameters: Record<string, unknown> } | { drop: true } {
	const schema = cloneJsonSchema(parameters);
	flattenExclusiveRequiredUnion(schema);
	if (options.rejectXaiRootObjectUnion && hasXaiRootObjectUnion(schema)) {
		return { drop: true };
	}
	return { parameters: schema };
}
