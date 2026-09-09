import { copySandboxStrictBytes } from "../../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.js";

const result = copySandboxStrictBytes(new Uint8Array([7]), 1);
if (result.ok) {
	console.error("deliberate mutant expected valid input rejection");
	process.exitCode = 1;
} else {
	process.exitCode = 0;
}
