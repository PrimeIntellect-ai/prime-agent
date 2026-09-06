import { spawn } from "node:child_process";

if (process.env.RPC_FIXTURE_HOLD_STDIO === "1") {
	// A grandchild inheriting the stdio pipes keeps them open after this process exits,
	// so the parent RpcClient never sees a "close" event for this child.
	// The ghost variant writes an event into the inherited stdout shortly after this
	// process dies, emulating child output that lands after a replacement started.
	const script =
		process.env.RPC_FIXTURE_GHOST_EVENT === "1"
			? `process.stdin.on("end", () => setTimeout(() => { process.stdout.write('{"type":"agent_end"}\\n'); process.stderr.write("ghost-event-written\\n"); }, 250)); process.stdin.resume(); setTimeout(() => {}, 30000);`
			: "setTimeout(() => {}, 30000)";
	const grandchild = spawn(process.execPath, ["-e", script], {
		stdio: "inherit",
		detached: true,
	});
	grandchild.unref();
	process.stdout.write(`${JSON.stringify({ type: "fixture_grandchild", pid: grandchild.pid })}\n`);
}

if (process.env.RPC_FIXTURE_REPLY_EXIT === "1") {
	// Answer the first command, then die immediately: the response is still in the
	// pipe (or draining) when "exit" reaches the parent.
	process.stdin.once("data", (chunk) => {
		const { id, type } = JSON.parse(chunk.toString());
		process.stdout.write(`${JSON.stringify({ id, type: "response", command: type, success: true, data: {} })}\n`);
		process.exit(0);
	});
}

process.stdin.resume();
