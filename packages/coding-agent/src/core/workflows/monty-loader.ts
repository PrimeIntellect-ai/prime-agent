import { createRequire } from "node:module";
import type { Monty as MontyClass } from "@pydantic/monty/node";

const require = createRequire(import.meta.url);
let cachedMonty: typeof MontyClass | undefined;

export function getNativeMonty(): typeof MontyClass {
	const forceWasi = process.env.NAPI_RS_FORCE_WASI;
	if (forceWasi === "true" || forceWasi === "error") {
		throw new Error("Prime Agent workflows require Monty's native backend; WASI is not allowed");
	}
	if (cachedMonty) return cachedMonty;
	const loaded = require("@pydantic/monty/node") as { Monty?: typeof MontyClass };
	if (!loaded.Monty) throw new Error("Prime Agent workflows could not load Monty's native backend");
	cachedMonty = loaded.Monty;
	return cachedMonty;
}
