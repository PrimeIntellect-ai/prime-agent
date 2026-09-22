// Fixture sidecar for the extension-host integration tests
// (`crates/pa-core/tests/extension_host.rs`). A scripted protocol-2 peer
// with the modes the tests select through `extensionPaths[0]`:
//
//   "basic" - ping answers with the result of a ctx call to
//            `get_system_prompt` (exercises the reverse RPC direction);
//            hello is answered with an `extension_error` notification
//            first (exercises notification fan-out); shutdown replies
//            and exits.
//   "die"   - on `event`, exit(3) with the request in flight (the host
//            must fail the pending request with the death reason).
//   "hang"  - on `event`, never reply (the test SIGKILLs the process and
//            expects the pending request to fail).
//
// Unlike the bundled stage-1 host script this fixture processes each line
// independently (no reply ordering) so a handler can await a ctx reply
// that arrives as a later line.

import readline from "node:readline";

const PROTOCOL = 2;

function write(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function writeReply(id, result, error, done) {
  const envelope = error !== undefined ? { id, error } : { id, result };
  process.stdout.write(JSON.stringify(envelope) + "\n", done);
}

// ctxToken -> resolve(result, error) for ctx calls awaiting a host reply.
const pendingCtx = new Map();

function callCtx(ctxToken, method, params) {
  return new Promise((resolve, reject) => {
    pendingCtx.set(ctxToken, { resolve, reject });
    write({ ctxToken, method, params });
  });
}

function resolveCtxReply(line) {
  const settled = pendingCtx.get(line.ctxToken);
  if (!settled) return false;
  pendingCtx.delete(line.ctxToken);
  if (line.error !== undefined) {
    settled.reject(Object.assign(new Error(line.error.message), line.error));
  } else {
    settled.resolve(line.result);
  }
  return true;
}

let mode = "basic";

function setMode(msg) {
  const paths = (msg.params && msg.params.extensionPaths) || [];
  if (paths[0] && paths[0].startsWith("mode:")) {
    mode = paths[0].slice("mode:".length);
  }
}

async function handleRequest(msg) {
  switch (msg.method) {
    case "hello":
      setMode(msg);
      write({
        method: "extension_error",
        params: {
          extensionPath: "fixture.ts",
          event: "session_start",
          error: "fixture diagnostic",
        },
      });
      return { result: { protocol: PROTOCOL, extensions: [], errors: [] } };
    case "ping": {
      const prompt = await callCtx("ctx-ping", "get_system_prompt", {});
      return { result: prompt };
    }
    case "event":
      if (mode === "die") {
        process.exit(3);
      }
      if (mode === "hang") {
        return new Promise(() => {}); // never resolves, never replies
      }
      return { result: { handled: true } };
    case "shutdown":
      return { result: { ok: true }, exit: 0 };
    default:
      return { error: { message: "fixture: unknown method '" + msg.method + "'" } };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (err) {
    process.stderr.write("fixture: unparsable line: " + line + " (" + err + ")\n");
    process.exit(1);
  }
  if (msg.ctxToken !== undefined) {
    resolveCtxReply(msg); // a reply to our own ctx call
    return;
  }
  if (!("id" in msg)) {
    return; // host notifications: no-op
  }
  handleRequest(msg)
    .then((outcome) => {
      writeReply(msg.id, outcome.result, outcome.error, () => {
        if (outcome.exit !== undefined) {
          process.exit(outcome.exit);
        }
      });
    })
    .catch((err) => {
      writeReply(msg.id, undefined, { message: String(err && err.message) });
    });
});

rl.on("close", () => process.exit(0));
