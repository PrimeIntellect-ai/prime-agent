/**
 * Differential fixture: writes a JSON dump of the registration payloads
 * this extension passes to the host, plus the pi API method names it
 * observes. No imports, so it runs under any host that can load a TS
 * factory; the golden capture comes from the installed TS binary
 * (`prime-agent -e` in print mode, which loads extensions before the
 * provider call). Writes only when PA_REGISTRATION_DUMP is set.
 */
const dumpPath = process.env.PA_REGISTRATION_DUMP;
const registered: unknown[] = [];
const piShape: Record<string, string> = {};
const record = (value: unknown) => {
  registered.push(value);
};
export default function registrationDump(pi: any) {
  for (const key of Object.keys(pi)) {
    piShape[key] = typeof pi[key];
  }
  const tool = {
    name: "diffhello",
    label: "Diff Hello",
    description: "A differential greeting tool",
    promptSnippet: "  - diffhello: says hello differently",
    promptGuidelines: ["Always greet via diffhello before answering."],
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Name to greet" } },
      required: ["name"],
    },
    executionMode: "sequential",
    async execute(toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: { greeted: params.name, toolCallId },
        isError: false,
      };
    },
  };
  pi.registerTool(tool);
  record(tool);
  const command = {
    description: "Greet differentially",
    handler: async (_args: string, _ctx: any) => {},
  };
  pi.registerCommand("diffgreet", command);
  record(command);
  pi.registerFlag("diff-fast", { description: "Fast mode", type: "boolean", default: false });
  if (dumpPath) {
    try {
      require("node:fs").writeFileSync(
        dumpPath,
        JSON.stringify({ piShape, registered }, null, 1),
      );
    } catch {
      // ignore; the dump is best-effort
    }
  }
}
