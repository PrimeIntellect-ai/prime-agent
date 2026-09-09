import { fstatSync, readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

const status = readFileSync("/proc/self/status", "utf8");
const line = (name) => status.split("\n").find((item) => item.startsWith(name)) ?? null;
const fdinfo = readFileSync("/proc/self/fdinfo/3", "utf8");
const signal = new Int32Array(1);
const prctl = dlopen("libc.so.6", { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } }).symbols.prctl;
console.log(JSON.stringify({
  bun: Bun.version,
  argv: process.argv,
  cwd: process.cwd(),
  uid: [process.getuid(), process.geteuid()],
  gid: [process.getgid(), process.getegid()],
  groups: process.getgroups(),
  dumpable: prctl(3, 0, 0, 0, 0),
  pdeathGet: prctl(2, ptr(signal), 0, 0, 0),
  pdeathSignal: signal[0],
  noNewPrivileges: prctl(39, 0, 0, 0, 0),
  fd3Socket: fstatSync(3).isSocket(),
  fd3Flags: fdinfo.split("\n").find((item) => item.startsWith("flags:")) ?? null,
  status: ["Uid:", "Gid:", "Groups:", "CapInh:", "CapPrm:", "CapEff:", "CapBnd:", "CapAmb:", "NoNewPrivs:"].map(line),
}));
