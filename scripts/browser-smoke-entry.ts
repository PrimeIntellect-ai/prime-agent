import { complete, getModel } from "@prime-intellect/prime-agent-ai";

const model = getModel("google", "gemini-2.5-flash");
console.log(model.id, typeof complete);
