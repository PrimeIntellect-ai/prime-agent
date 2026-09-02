/**
 * Modules made available to extensions via jiti virtualModules in the compiled
 * Bun binary.
 *
 * These imports MUST be static so Bun bundles them into the compiled binary;
 * the module itself is loaded lazily (dynamic import with a literal specifier,
 * which Bun also bundles) so that merely importing the extension loader does
 * not pull in the entire package graph at startup.
 */

import * as _bundledPiAi from "@prime-intellect/prime-agent-ai";
import * as _bundledPiAiOauth from "@prime-intellect/prime-agent-ai/oauth";
import * as _bundledPiAgentCore from "@prime-intellect/prime-agent-core";
import * as _bundledPiTui from "@prime-intellect/prime-agent-tui";
import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from @prime-intellect/prime-agent.
import * as _bundledPiCodingAgent from "../../index.js";

export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"@prime-intellect/prime-agent-core": _bundledPiAgentCore,
	"@prime-intellect/prime-agent-tui": _bundledPiTui,
	"@prime-intellect/prime-agent-ai": _bundledPiAi,
	"@prime-intellect/prime-agent-ai/oauth": _bundledPiAiOauth,
	"@prime-intellect/prime-agent": _bundledPiCodingAgent,
	"@earendil-works/pi-agent-core": _bundledPiAgentCore,
	"@earendil-works/pi-tui": _bundledPiTui,
	"@earendil-works/pi-ai": _bundledPiAi,
	"@earendil-works/pi-ai/oauth": _bundledPiAiOauth,
	"@earendil-works/pi-coding-agent": _bundledPiCodingAgent,
	"@mariozechner/pi-agent-core": _bundledPiAgentCore,
	"@mariozechner/pi-tui": _bundledPiTui,
	"@mariozechner/pi-ai": _bundledPiAi,
	"@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};
